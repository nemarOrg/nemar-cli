/**
 * The dataset pull-request review, Worker side (ADR 0092).
 *
 * A pull request opened or updated against `main` of a dataset repository reaches the Worker as a
 * `pull_request` delivery from the NEMAR GitHub App (once the App is subscribed to those events).
 * The Worker decides whether to review it, records the attempt in `pr_reviews`, and dispatches a
 * workflow to `nemarDatasets/.github`. The workflow CLAIMS the review (the Worker accepts the
 * one-shot token and records the time) before it spends anything, reads the change as git
 * data, and asks a model three questions. It posts a report back; the Worker validates it against
 * the closed vocabulary in `shared/pr-review.ts`, derives the verdict, and publishes a check-run
 * and one pull-request comment.
 *
 * **Why the Worker is the gate.** Every pull request reaches it, a fork's included, from a
 * delivery GitHub signs; no workflow in a dataset repository takes part, so no collaborator can
 * edit the review or reach the credentials it uses by editing a branch. It is also the only place
 * that can count: who opened which pull request, how many were rejected, how many reviews were
 * started this hour. Those counts decide whether a review is spent at all. A `repository_dispatch`
 * can be sent by anyone holding a dataset repository's workflow credentials, so the caps bind
 * only reviews the Worker started; the claim step is what makes a forged dispatch buy nothing.
 *
 * **Nothing here trusts the pull request.** The event is read by {@link readPullRequestEvent},
 * which accepts only the shapes it expects; the dispatch carries the review's coordinates and not
 * the pull request's text; the report that comes back goes through `parsePrReviewReport` before a
 * byte is stored; and the check and comment are rendered from the parsed report, never from the
 * request body.
 *
 * **Unknown is never green.** A review that was declined, errored, or never reported is published
 * as `action_required`, which GitHub does not count as passing for a required check. A result that
 * could not be published is recorded as unpublished (`published_at` NULL) and the watchdog
 * publishes it again, so a GitHub outage delays a check and never leaves it "in progress".
 *
 * Database failures inside {@link handlePullRequestEvent} throw: the webhook route answers 500 so
 * the delivery shows as failed in the App's delivery log, where it can be redelivered. Redelivery
 * is safe because (dataset, pull request, commit) is unique.
 */

import {
  type AuthorOverride,
  type AuthorTally,
  type CallbackOutcome,
  DAILY_REVIEW_CAP,
  type DeclineReason,
  PrReviewReportError,
  type ReviewOutcome,
  type ReviewState,
  conclusionOf,
  dailyAuthorCapFor,
  hourlyCapFor,
  isDeclineReason,
  isOverrideMode,
  isRunError,
  parsePrReviewReport,
  renderCheck,
  renderComment,
  standingOf,
  verdictOf,
} from "../../../shared/pr-review.js";
import type { Bindings } from "../types/bindings.js";
import { isValidDatasetId } from "./datasetId.js";
import { isNonProductionEnv } from "./environment.js";
import { getDatasetsToken, getDatasetsTokenWithRefresher } from "./github-auth.js";
import { signPrReviewCallbackToken } from "./github/callback-tokens.js";
import { approvalDispatchEnvironment, triggerPrReviewRun } from "./github/dispatch.js";
import { upsertReviewCheckRun, upsertReviewComment } from "./github/pr-review-api.js";
import { ORG_NAME } from "./github/shared.js";

/** `pull_request` actions that put new content in front of a reviewer. */
export const PR_REVIEW_ACTIONS: ReadonlySet<string> = new Set([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
]);

/** The branch whose pull requests are reviewed. */
export const PR_REVIEW_BASE_BRANCH = "main";

/** How long a dispatched review may take before the watchdog gives up on it. The workflow's own limit is 20. */
export const PR_REVIEW_DEADLINE_MINUTES = 30;

/**
 * A result that did not reach GitHub is eligible to be tried again this long after it was decided,
 * up to {@link PUBLISH_MAX_ATTEMPTS} times. The watchdog runs on a 30-minute tick, so the real gap
 * between attempts is that tick, and five attempts take about two and a half hours.
 */
const PUBLISH_RETRY_AFTER_MINUTES = 2;
export const PUBLISH_MAX_ATTEMPTS = 5;

/** Rows the watchdog handles per query (it runs two: overdue reviews, and unpublished results). */
const SWEEP_LIMIT = 20;

/** How long the dispatch may wait for GitHub before the Worker answers the webhook. */
const DISPATCH_TIMEOUT_MS = 10_000;

type Db = D1Database;

// ---------------------------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------------------------

export interface PrIntake {
  datasetId: string;
  prNumber: number;
  headSha: string;
  authorId: number;
  authorLogin: string;
  authorAssociation: string | null;
  fromFork: boolean;
}

/** Why a delivery was not taken up. Fixed words, safe to return and log. */
export type IntakeSkip =
  | "malformed"
  | "action_ignored"
  | "wrong_owner"
  | "not_a_dataset"
  | "not_main"
  | "not_open"
  | "draft"
  | "bot_author";

export type IntakeResult = { ok: true; pr: PrIntake } | { ok: false; reason: IntakeSkip };

const SHA40 = /^[0-9a-f]{40}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function rec(x: unknown): Record<string, unknown> | null {
  return typeof x === "object" && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}

function posInt(x: unknown): number | null {
  return typeof x === "number" && Number.isSafeInteger(x) && x > 0 ? x : null;
}

/**
 * Read a `pull_request` delivery. Everything in it is attacker-influenced (the title, the branch
 * names, the fork's name), and none of that text is used: only ids, the head commit, the base
 * branch and fixed-shape logins are read, each checked against the shape it must have.
 */
export function readPullRequestEvent(payload: unknown): IntakeResult {
  const p = rec(payload);
  const pr = rec(p?.pull_request);
  const repo = rec(p?.repository);
  if (!p || !pr || !repo) return { ok: false, reason: "malformed" };
  if (typeof p.action !== "string" || !PR_REVIEW_ACTIONS.has(p.action)) {
    return { ok: false, reason: "action_ignored" };
  }
  const owner = rec(repo.owner);
  if (
    typeof owner?.login !== "string" ||
    owner.login.toLowerCase() !== ORG_NAME.toLowerCase() ||
    typeof repo.full_name !== "string"
  ) {
    return { ok: false, reason: "wrong_owner" };
  }
  if (typeof repo.name !== "string" || !isValidDatasetId(repo.name)) {
    return { ok: false, reason: "not_a_dataset" };
  }
  const base = rec(pr.base);
  if (typeof base?.ref !== "string" || base.ref !== PR_REVIEW_BASE_BRANCH) {
    return { ok: false, reason: "not_main" };
  }
  if (pr.state !== "open" || pr.merged === true) return { ok: false, reason: "not_open" };
  if (pr.draft === true) return { ok: false, reason: "draft" };

  const head = rec(pr.head);
  const user = rec(pr.user);
  const prNumber = posInt(pr.number);
  const authorId = posInt(user?.id);
  if (
    prNumber === null ||
    authorId === null ||
    typeof head?.sha !== "string" ||
    !SHA40.test(head.sha) ||
    typeof user?.login !== "string"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (user.type === "Bot" || user.login.endsWith("[bot]")) {
    return { ok: false, reason: "bot_author" };
  }
  if (!LOGIN.test(user.login)) return { ok: false, reason: "malformed" };

  // A deleted fork leaves `head.repo` null; that is a fork. Same-repo branches name the base repo.
  const headRepo = rec(head.repo);
  const fromFork =
    typeof headRepo?.full_name !== "string" ||
    headRepo.full_name.toLowerCase() !== repo.full_name.toLowerCase();

  return {
    ok: true,
    pr: {
      datasetId: repo.name,
      prNumber,
      headSha: head.sha,
      authorId,
      authorLogin: user.login,
      authorAssociation: typeof pr.author_association === "string" ? pr.author_association : null,
      fromFork,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The gate: who is reviewed, and how often
// ---------------------------------------------------------------------------------------------

/**
 * Rows that cost a model call, or may yet: everything except a decline (never sent) and a run
 * that errored before the model was reached (the commit was superseded, or the dispatch failed).
 */
const COUNTS_TOWARD_CAPS = `state != 'declined' AND NOT (state = 'errored' AND detail IN ('stale_head', 'dispatch_failed'))`;

/**
 * The tally for one contributor, counted from the reviews themselves.
 *
 * `decided` is the number of distinct pull requests with at least one decided (pass or fail)
 * review; `rejected` is how many of those were most recently decided as a fail. Counting the
 * LATEST decided review of each pull request means a contributor who fixes a rejected pull
 * request is not punished for iterating, and five pushes to one bad pull request are one
 * rejection, not five. "Latest" is the last commit SEEN (`seen_at`), not the highest row id, so
 * force-pushing back to an earlier reviewed commit makes that commit's result the current one.
 */
export const AUTHOR_TALLY_SQL = `
  WITH latest AS (
    SELECT verdict,
           ROW_NUMBER() OVER (PARTITION BY dataset_id, pr_number ORDER BY seen_at DESC, id DESC) AS rn
      FROM pr_reviews
     WHERE author_id = ? AND state = 'reported' AND verdict IN ('pass', 'fail')
  )
  SELECT COUNT(*) AS decided,
         COALESCE(SUM(CASE WHEN verdict = 'fail' THEN 1 ELSE 0 END), 0) AS rejected
    FROM latest
   WHERE rn = 1`;

/**
 * A row's place in its allowance: how many rows that count against it, up to and including this
 * one, were created inside the window. Counted AFTER the row is inserted, so two deliveries that
 * race each see the other and at most the cap survive; checking before inserting let a burst of
 * pull requests all pass the same check.
 */
const AUTHOR_HOURLY_RANK_SQL = `SELECT COUNT(*) AS n FROM pr_reviews
  WHERE author_id = ? AND ${COUNTS_TOWARD_CAPS} AND created_at >= datetime('now', '-1 hour') AND id <= ?`;
const AUTHOR_DAILY_RANK_SQL = `SELECT COUNT(*) AS n FROM pr_reviews
  WHERE author_id = ? AND ${COUNTS_TOWARD_CAPS} AND created_at >= datetime('now', '-1 day') AND id <= ?`;
const PLATFORM_DAILY_RANK_SQL = `SELECT COUNT(*) AS n FROM pr_reviews
  WHERE ${COUNTS_TOWARD_CAPS} AND created_at >= datetime('now', '-1 day') AND id <= ?`;

export async function readAuthorTally(db: Db, authorId: number): Promise<AuthorTally> {
  const row = await db
    .prepare(AUTHOR_TALLY_SQL)
    .bind(authorId)
    .first<{ decided: number; rejected: number }>();
  return { decided: row?.decided ?? 0, rejected: row?.rejected ?? 0 };
}

export async function readAuthorOverride(db: Db, authorId: number): Promise<AuthorOverride> {
  const row = await db
    .prepare("SELECT mode FROM pr_review_overrides WHERE author_id = ?")
    .bind(authorId)
    .first<{ mode: string }>();
  return isOverrideMode(row?.mode) ? row.mode : null;
}

/** Which allowance, if any, the row just inserted is over. */
async function capDecision(
  db: Db,
  pr: PrIntake,
  rowId: number,
): Promise<Extract<DeclineReason, "rate_limited" | "daily_limit"> | null> {
  const hourly = await db
    .prepare(AUTHOR_HOURLY_RANK_SQL)
    .bind(pr.authorId, rowId)
    .first<{ n: number }>();
  if ((hourly?.n ?? 0) > hourlyCapFor(pr.authorAssociation)) return "rate_limited";
  const daily = await db
    .prepare(AUTHOR_DAILY_RANK_SQL)
    .bind(pr.authorId, rowId)
    .first<{ n: number }>();
  if ((daily?.n ?? 0) > dailyAuthorCapFor(pr.authorAssociation)) return "rate_limited";
  const platform = await db.prepare(PLATFORM_DAILY_RANK_SQL).bind(rowId).first<{ n: number }>();
  if ((platform?.n ?? 0) > DAILY_REVIEW_CAP) return "daily_limit";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

interface ReviewRow {
  id: number;
  datasetId: string;
  prNumber: number;
  headSha: string;
  state: ReviewState;
  detail: string | null;
  report: string | null;
  checkRunId: number | null;
  commentId: number | null;
}

interface RawRow {
  id: number;
  dataset_id: string;
  pr_number: number;
  head_sha: string;
  state: ReviewState;
  detail: string | null;
  report: string | null;
  check_run_id: number | null;
  comment_id: number | null;
}

const ROW_COLUMNS =
  "id, dataset_id, pr_number, head_sha, state, detail, report, check_run_id, comment_id";

function toRow(r: RawRow): ReviewRow {
  return {
    id: r.id,
    datasetId: r.dataset_id,
    prNumber: r.pr_number,
    headSha: r.head_sha,
    state: r.state,
    detail: r.detail,
    report: r.report,
    checkRunId: r.check_run_id,
    commentId: r.comment_id,
  };
}

async function readRow(db: Db, id: number): Promise<ReviewRow | null> {
  const r = await db
    .prepare(`SELECT ${ROW_COLUMNS} FROM pr_reviews WHERE id = ?`)
    .bind(id)
    .first<RawRow>();
  return r ? toRow(r) : null;
}

async function readRowByKey(
  db: Db,
  datasetId: string,
  prNumber: number,
  headSha: string,
): Promise<ReviewRow | null> {
  const r = await db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM pr_reviews WHERE dataset_id = ? AND pr_number = ? AND head_sha = ?`,
    )
    .bind(datasetId, prNumber, headSha)
    .first<RawRow>();
  return r ? toRow(r) : null;
}

/** The outcome a stored row stands for, or null for a review still waiting for its report. */
export function outcomeOfRow(row: ReviewRow): ReviewOutcome | null {
  if (row.state === "reported") {
    try {
      return { kind: "reported", report: parsePrReviewReport(JSON.parse(row.report ?? "null")) };
    } catch (err) {
      // A stored report that no longer parses (the contract moved under it, or the column was
      // edited by hand) is shown as "could not decide". Anything else is a bug and surfaces.
      if (!(err instanceof PrReviewReportError || err instanceof SyntaxError)) throw err;
      console.error(
        `[pr-review] review ${row.id} (${row.datasetId}#${row.prNumber}): stored report refused (${errName(err)}${
          err instanceof PrReviewReportError ? `: ${err.code}` : ""
        })`,
      );
      return { kind: "error", error: "report_invalid" };
    }
  }
  if (row.state === "errored") {
    return { kind: "error", error: isRunError(row.detail) ? row.detail : "workflow_failed" };
  }
  if (row.state === "declined") {
    // The migration's CHECK keeps `detail` to the declined words; "paused" is only the fail-safe.
    return {
      kind: "declined",
      reason: isDeclineReason(row.detail) ? row.detail : "contributor_paused",
    };
  }
  if (row.state === "unreported") return { kind: "unreported" };
  return null;
}

/** The comment this pull request already carries, from any earlier review of it. */
async function existingCommentId(
  db: Db,
  datasetId: string,
  prNumber: number,
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT comment_id FROM pr_reviews
        WHERE dataset_id = ? AND pr_number = ? AND comment_id IS NOT NULL
        ORDER BY seen_at DESC, id DESC LIMIT 1`,
    )
    .bind(datasetId, prNumber)
    .first<{ comment_id: number }>();
  return row?.comment_id ?? null;
}

/** True when this row is the last commit of its pull request that was seen. */
async function isLatestReview(db: Db, row: ReviewRow): Promise<boolean> {
  const latest = await db
    .prepare(
      `SELECT id FROM pr_reviews WHERE dataset_id = ? AND pr_number = ?
        ORDER BY seen_at DESC, id DESC LIMIT 1`,
    )
    .bind(row.datasetId, row.prNumber)
    .first<{ id: number }>();
  return latest?.id === row.id;
}

const NOW_MS = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

function errName(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 120) : "unknown";
}

// ---------------------------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------------------------

/**
 * Publish an outcome to GitHub: the check-run on the reviewed commit, and (for any outcome but
 * `running`, and only while this is still the last commit of the pull request seen) the
 * pull-request comment. Each surface fails on its own and is logged by status; neither can lose
 * the stored verdict. Returns whether the check-run reached GitHub: a decided outcome whose check
 * did is marked published; one that did not stays unpublished and the watchdog tries again.
 * `running` is bounded (it runs inside the webhook request) and publishes the in-progress check
 * only. `commentOnly` re-states a stored result on the pull request without touching the check.
 */
export async function publishOutcome(
  env: Bindings,
  row: ReviewRow,
  outcome: ReviewOutcome | "running",
  opts: { commentOnly?: boolean } = {},
): Promise<boolean> {
  let checked = false;
  let token: string;
  let refresh: () => Promise<string>;
  try {
    ({ token, refresh } = await getDatasetsTokenWithRefresher(env));
  } catch (err) {
    console.error(`[pr-review] review ${row.id}: no GitHub token (${errName(err)})`);
    return false;
  }
  const db = env.DB;

  if (!opts.commentOnly) {
    const rendered =
      outcome === "running"
        ? {
            title: "Review in progress",
            summary: "The changes are being reviewed. This check will update when it finishes.",
            text: "",
          }
        : renderCheck(outcome);
    try {
      const id = await upsertReviewCheckRun({
        token,
        refresh,
        quick: outcome === "running",
        repo: row.datasetId,
        headSha: row.headSha,
        checkRunId: row.checkRunId,
        conclusion: outcome === "running" ? null : conclusionOf(outcome),
        ...rendered,
      });
      checked = true;
      if (id !== row.checkRunId) {
        // Its own try: the check exists on GitHub whether or not this write lands.
        try {
          await db
            .prepare("UPDATE pr_reviews SET check_run_id = ? WHERE id = ?")
            .bind(id, row.id)
            .run();
          row.checkRunId = id;
        } catch (err) {
          console.error(`[pr-review] review ${row.id}: check id not stored (${errName(err)})`);
        }
      }
    } catch (err) {
      console.error(`[pr-review] review ${row.id}: check-run not published (${errName(err)})`);
    }
  }

  if (outcome === "running") return checked;
  try {
    if (await isLatestReview(db, row)) {
      const commentId = row.commentId ?? (await existingCommentId(db, row.datasetId, row.prNumber));
      const id = await upsertReviewComment({
        token,
        refresh,
        repo: row.datasetId,
        prNumber: row.prNumber,
        commentId,
        body: renderComment(outcome, row.headSha),
      });
      if (id !== row.commentId) {
        try {
          await db
            .prepare("UPDATE pr_reviews SET comment_id = ? WHERE id = ?")
            .bind(id, row.id)
            .run();
          row.commentId = id;
        } catch (err) {
          console.error(`[pr-review] review ${row.id}: comment id not stored (${errName(err)})`);
        }
      }
    }
  } catch (err) {
    // Typically the App lacks pull_requests: write. The check still carries the whole review.
    console.error(`[pr-review] review ${row.id}: comment not published (${errName(err)})`);
  }

  if (checked) {
    try {
      await db
        .prepare("UPDATE pr_reviews SET published_at = datetime('now') WHERE id = ?")
        .bind(row.id)
        .run();
    } catch (err) {
      console.error(`[pr-review] review ${row.id}: published_at not stored (${errName(err)})`);
    }
  }
  return checked;
}

/**
 * A stranger pushing commit after commit would otherwise cost two GitHub writes per push for a
 * message that never changes. A decline is published the first time; the same decline for the
 * same pull request within the hour is recorded without being published again.
 */
async function publishDecline(env: Bindings, row: ReviewRow, reason: DeclineReason): Promise<void> {
  const repeat = await env.DB.prepare(
    `SELECT 1 AS ok FROM pr_reviews
      WHERE dataset_id = ? AND pr_number = ? AND state = 'declined' AND detail = ?
        AND published_at IS NOT NULL AND id < ? AND created_at >= datetime('now', '-1 hour')
      LIMIT 1`,
  )
    .bind(row.datasetId, row.prNumber, reason, row.id)
    .first<{ ok: number }>();
  if (repeat) {
    await env.DB.prepare("UPDATE pr_reviews SET published_at = datetime('now') WHERE id = ?")
      .bind(row.id)
      .run();
    return;
  }
  await publishOutcome(env, row, { kind: "declined", reason });
}

// ---------------------------------------------------------------------------------------------
// The webhook entry point
// ---------------------------------------------------------------------------------------------

export interface PrReviewResponse {
  ok: true;
  dispatched: boolean;
  reason: string;
  review_id?: number;
}

const no = (reason: string, reviewId?: number): PrReviewResponse => ({
  ok: true,
  dispatched: false,
  reason,
  ...(reviewId === undefined ? {} : { review_id: reviewId }),
});

/**
 * Take up a `pull_request` delivery. The caller has already verified the delivery's signature and
 * applied the production/dev ownership fence; everything else is decided here. A database error
 * throws, and the route answers 500 (see the module comment).
 */
export async function handlePullRequestEvent(
  env: Bindings,
  payload: unknown,
): Promise<PrReviewResponse> {
  if (env.PR_REVIEW_ENABLED !== "1") return no("pr_review_disabled");
  const intake = readPullRequestEvent(payload);
  if (!intake.ok) return no(intake.reason);
  const pr = intake.pr;
  const db = env.DB;

  const secret = env.PRESCREEN_CALLBACK_SECRET;
  if (!secret) {
    console.error(
      `[pr-review] PRESCREEN_CALLBACK_SECRET is unset; not reviewing ${pr.datasetId}#${pr.prNumber}`,
    );
    return no("misconfigured");
  }

  // Only a dataset NEMAR holds. A repository that merely has a dataset-shaped name is not one.
  const known = await db
    .prepare("SELECT 1 AS ok FROM datasets WHERE dataset_id = ?")
    .bind(pr.datasetId)
    .first<{ ok: number }>();
  if (!known) return no("unknown_dataset");

  const existing = await readRowByKey(db, pr.datasetId, pr.prNumber, pr.headSha);
  if (existing) return await handleRepeat(env, existing, secret);

  const standing = standingOf(
    await readAuthorTally(db, pr.authorId),
    await readAuthorOverride(db, pr.authorId),
  );
  const paused = standing.paused;
  const nonce = crypto.randomUUID();
  const inserted = await db
    .prepare(
      `INSERT INTO pr_reviews
         (dataset_id, pr_number, head_sha, author_id, author_login, author_association,
          from_fork, state, detail, nonce, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${paused ? "datetime('now')" : "NULL"})
       ON CONFLICT (dataset_id, pr_number, head_sha) DO NOTHING`,
    )
    .bind(
      pr.datasetId,
      pr.prNumber,
      pr.headSha,
      pr.authorId,
      pr.authorLogin,
      pr.authorAssociation,
      pr.fromFork ? 1 : 0,
      paused ? "declined" : "dispatched",
      paused ? "contributor_paused" : null,
      paused ? null : nonce,
    )
    .run();
  if ((inserted.meta.changes ?? 0) !== 1) {
    // Another delivery of the same commit won the insert between the read and the write.
    const raced = await readRowByKey(db, pr.datasetId, pr.prNumber, pr.headSha);
    return raced ? await handleRepeat(env, raced, secret) : no("duplicate");
  }
  const reviewId = Number(inserted.meta.last_row_id);
  try {
    return await decideInserted(env, pr, reviewId, paused, nonce, secret);
  } catch (err) {
    // The row exists but nothing has run for it (a database error between the insert and the
    // dispatch). Left as 'dispatched' it would count against the caps and wait for the watchdog
    // to call it late, and a redelivery would find it and answer "duplicate". Mark it as a
    // dispatch that did not happen, which a redelivery retries, and let the route answer 500.
    try {
      await db
        .prepare(
          `UPDATE pr_reviews SET state = 'errored', detail = 'dispatch_failed', nonce = NULL,
                  decided_at = datetime('now')
            WHERE id = ? AND state = 'dispatched' AND claimed_at IS NULL`,
        )
        .bind(reviewId)
        .run();
    } catch (inner) {
      console.error(`[pr-review] review ${reviewId}: failure not recorded (${errName(inner)})`);
    }
    throw err;
  }
}

/** Everything after the insert: publish a decline, or check the allowances and start the review. */
async function decideInserted(
  env: Bindings,
  pr: PrIntake,
  reviewId: number,
  paused: boolean,
  nonce: string,
  secret: string,
): Promise<PrReviewResponse> {
  const db = env.DB;
  const row = await readRow(db, reviewId);
  if (!row) return no("duplicate", reviewId);

  if (paused) {
    await publishDecline(env, row, "contributor_paused");
    return no("contributor_paused", reviewId);
  }

  const over = await capDecision(db, pr, reviewId);
  if (over) {
    await db
      .prepare(
        `UPDATE pr_reviews SET state = 'declined', detail = ?, nonce = NULL, decided_at = datetime('now')
          WHERE id = ? AND state = 'dispatched'`,
      )
      .bind(over, reviewId)
      .run();
    const declined = await readRow(db, reviewId);
    await publishDecline(env, declined ?? row, over);
    return no(over, reviewId);
  }

  return await startReview(env, row, nonce, secret);
}

/**
 * The commit has been delivered before. It is marked seen again (so it is the pull request's
 * current commit, which is what force-pushing back to an earlier reviewed commit means), its
 * stored result is re-stated on the pull request, and a review whose dispatch failed is tried
 * again. Nothing else is reviewed twice.
 */
async function handleRepeat(
  env: Bindings,
  existing: ReviewRow,
  secret: string,
): Promise<PrReviewResponse> {
  const db = env.DB;
  await db
    .prepare(`UPDATE pr_reviews SET seen_at = ${NOW_MS} WHERE id = ?`)
    .bind(existing.id)
    .run();

  if (existing.state === "errored" && existing.detail === "dispatch_failed") {
    const nonce = crypto.randomUUID();
    const reset = await db
      .prepare(
        `UPDATE pr_reviews
            SET state = 'dispatched', detail = NULL, nonce = ?, claimed_at = NULL,
                published_at = NULL, publish_attempts = 0, decided_at = NULL,
                created_at = datetime('now')
          WHERE id = ? AND state = 'errored' AND detail = 'dispatch_failed'`,
      )
      .bind(nonce, existing.id)
      .run();
    if ((reset.meta.changes ?? 0) === 1) {
      const row = await readRow(db, existing.id);
      if (row) {
        const res = await startReview(env, row, nonce, secret);
        return res.dispatched ? { ...res, reason: "redispatched" } : res;
      }
    }
  }

  const outcome = outcomeOfRow(existing);
  if (outcome) await publishOutcome(env, existing, outcome, { commentOnly: true });
  return no("duplicate", existing.id);
}

/** Show the review as running, hand it to GitHub, and record a failure to do so. */
async function startReview(
  env: Bindings,
  row: ReviewRow,
  nonce: string,
  secret: string,
): Promise<PrReviewResponse> {
  const db = env.DB;
  await publishOutcome(env, row, "running");
  try {
    const token = await signPrReviewCallbackToken(
      { datasetId: row.datasetId, reviewId: row.id, nonce },
      secret,
    );
    await triggerPrReviewRun(
      {
        datasetId: row.datasetId,
        prNumber: row.prNumber,
        headSha: row.headSha,
        reviewId: row.id,
        callbackToken: token,
        environment: approvalDispatchEnvironment(env),
      },
      await getDatasetsToken(env),
      DISPATCH_TIMEOUT_MS,
    );
  } catch (err) {
    console.error(
      `[pr-review] review ${row.id} (${row.datasetId}#${row.prNumber}): dispatch failed (${errName(err)})`,
    );
    try {
      await db
        .prepare(
          `UPDATE pr_reviews SET state = 'errored', detail = 'dispatch_failed', nonce = NULL,
                  decided_at = datetime('now')
            WHERE id = ? AND state = 'dispatched'`,
        )
        .bind(row.id)
        .run();
      const fresh = await readRow(db, row.id);
      await publishOutcome(env, fresh ?? row, { kind: "error", error: "dispatch_failed" });
    } catch (inner) {
      console.error(`[pr-review] review ${row.id}: failure not recorded (${errName(inner)})`);
    }
    return no("dispatch_failed", row.id);
  }
  return { ok: true, dispatched: true, reason: "dispatched", review_id: row.id };
}

// ---------------------------------------------------------------------------------------------
// The claim and the callback
// ---------------------------------------------------------------------------------------------

/** The nonce of a review still waiting for its report, or null. Replays and strangers find nothing. */
export async function pendingNonce(
  db: Db,
  reviewId: number,
  datasetId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT nonce FROM pr_reviews
        WHERE id = ? AND dataset_id = ? AND state IN ('dispatched', 'unreported')
          AND nonce IS NOT NULL LIMIT 1`,
    )
    .bind(reviewId, datasetId)
    .first<{ nonce: string }>();
  return row?.nonce ?? null;
}

export type ClaimResult = "claimed" | "already_claimed" | "superseded";

/**
 * The workflow's first real step, before it mints an identity or reads anything: take the review. The
 * caller has verified the token. A review is claimed once, so one dispatch buys one model call;
 * a dispatch for a commit that is no longer the pull request's latest is refused and recorded
 * as `stale_head`, so a superseded commit never spends a model call.
 */
export async function claimPrReview(
  env: Bindings,
  reviewId: number,
  datasetId: string,
  nonce: string,
): Promise<ClaimResult> {
  const db = env.DB;
  const row = await readRow(db, reviewId);
  if (!row || row.datasetId !== datasetId) return "already_claimed";

  if (!(await isLatestReview(db, row))) {
    const res = await db
      .prepare(
        `UPDATE pr_reviews SET state = 'errored', detail = 'stale_head', nonce = NULL,
                decided_at = datetime('now'), published_at = NULL, publish_attempts = 0
          WHERE id = ? AND dataset_id = ? AND nonce = ? AND claimed_at IS NULL
            AND state IN ('dispatched', 'unreported')`,
      )
      .bind(reviewId, datasetId, nonce)
      .run();
    if ((res.meta.changes ?? 0) === 1) {
      const fresh = await readRow(db, reviewId);
      await publishOutcome(env, fresh ?? row, { kind: "error", error: "stale_head" });
    }
    return "superseded";
  }

  const res = await db
    .prepare(
      `UPDATE pr_reviews SET claimed_at = datetime('now')
        WHERE id = ? AND dataset_id = ? AND nonce = ? AND claimed_at IS NULL
          AND state IN ('dispatched', 'unreported')`,
    )
    .bind(reviewId, datasetId, nonce)
    .run();
  return (res.meta.changes ?? 0) === 1 ? "claimed" : "already_claimed";
}

/**
 * Store a verified callback and publish it. The write is one conditional UPDATE keyed on the
 * nonce, so a duplicate callback stores nothing twice. The caller has already turned the body
 * into an outcome with `parseCallbackOutcome`: a report the parser refused is the run error
 * `report_invalid` and never a verdict. A late report for a row the watchdog gave up on is
 * accepted, and replaces the "could not decide" check.
 */
export async function storePrReviewResult(
  env: Bindings,
  reviewId: number,
  datasetId: string,
  nonce: string,
  outcome: CallbackOutcome,
): Promise<{ stored: boolean; state: ReviewState | null }> {
  const db = env.DB;
  const res = await db
    .prepare(
      `UPDATE pr_reviews
          SET state = ?, verdict = ?, detail = ?, report = ?, nonce = NULL,
              decided_at = datetime('now'), published_at = NULL, publish_attempts = 0
        WHERE id = ? AND dataset_id = ? AND nonce = ? AND state IN ('dispatched', 'unreported')`,
    )
    .bind(
      outcome.kind === "reported" ? "reported" : "errored",
      outcome.kind === "reported" ? verdictOf(outcome.report) : null,
      outcome.kind === "error" ? outcome.error : null,
      outcome.kind === "reported" ? JSON.stringify(outcome.report) : null,
      reviewId,
      datasetId,
      nonce,
    )
    .run();
  if ((res.meta.changes ?? 0) !== 1) return { stored: false, state: null };
  const row = await readRow(db, reviewId);
  if (row) await publishOutcome(env, row, outcome);
  return { stored: true, state: row?.state ?? null };
}

// ---------------------------------------------------------------------------------------------
// The watchdog
// ---------------------------------------------------------------------------------------------

export interface PrReviewSweepResult {
  /** Reviews that never reported and were marked unreported. */
  timedOut: number;
  /** Stored results that had not reached GitHub and did on this pass. */
  republished: number;
  /** Results whose last allowed attempt to reach GitHub failed on this pass. */
  abandoned: number;
  errors: number;
  skipped: boolean;
}

/**
 * Two jobs, both so a check cannot stay wrong for good.
 *
 * 1. Give up on reviews that never reported. GitHub answers a dispatch 204 whether or not any
 *    workflow listens, so a review can be handed over and never run. The row is marked
 *    `unreported` and its nonce KEPT, so a report that arrives late is still accepted and then
 *    replaces the "could not decide" check.
 * 2. Publish again any stored result that did not reach GitHub (a GitHub error, a token that
 *    would not mint), a few times each.
 *
 * It does not depend on `PR_REVIEW_ENABLED`: turning the review off must not strand a check that
 * is already running. PRODUCTION-ONLY, like the other watchdogs: it writes to the shared
 * `nemarDatasets` org.
 */
export async function sweepStalePrReviews(env: Bindings): Promise<PrReviewSweepResult> {
  const result: PrReviewSweepResult = {
    timedOut: 0,
    republished: 0,
    abandoned: 0,
    errors: 0,
    skipped: false,
  };
  if (isNonProductionEnv(env)) {
    result.skipped = true;
    return result;
  }
  const db = env.DB;

  try {
    const overdue = (
      await db
        .prepare(
          `SELECT id FROM pr_reviews
            WHERE state = 'dispatched'
              AND created_at < datetime('now', '-${PR_REVIEW_DEADLINE_MINUTES} minutes')
            ORDER BY id LIMIT ?`,
        )
        .bind(SWEEP_LIMIT)
        .all<{ id: number }>()
    ).results;
    for (const { id } of overdue) {
      try {
        const res = await db
          .prepare(
            `UPDATE pr_reviews SET state = 'unreported', decided_at = datetime('now'),
                    published_at = NULL, publish_attempts = 0
              WHERE id = ? AND state = 'dispatched'`,
          )
          .bind(id)
          .run();
        if ((res.meta.changes ?? 0) !== 1) continue;
        result.timedOut++;
        const row = await readRow(db, id);
        if (row) {
          // Which dataset, so a workflow that is not deployed or not federated can be traced.
          console.warn(
            `[pr-review-sweep] review ${id} (${row.datasetId}#${row.prNumber}) did not report in time`,
          );
          await publishOutcome(env, row, { kind: "unreported" });
        }
      } catch (err) {
        result.errors++;
        console.error(`[pr-review-sweep] review ${id} failed (${errName(err)})`);
      }
    }
  } catch (err) {
    result.errors++;
    console.error(`[pr-review-sweep] overdue query failed (${errName(err)})`);
  }

  try {
    const unpublished = (
      await db
        .prepare(
          `SELECT id, publish_attempts FROM pr_reviews
            WHERE state != 'dispatched' AND published_at IS NULL
              AND publish_attempts < ${PUBLISH_MAX_ATTEMPTS}
              AND COALESCE(decided_at, created_at)
                  < datetime('now', '-${PUBLISH_RETRY_AFTER_MINUTES} minutes')
            ORDER BY id LIMIT ?`,
        )
        .bind(SWEEP_LIMIT)
        .all<{ id: number; publish_attempts: number }>()
    ).results;
    for (const { id, publish_attempts } of unpublished) {
      try {
        await db
          .prepare("UPDATE pr_reviews SET publish_attempts = publish_attempts + 1 WHERE id = ?")
          .bind(id)
          .run();
        const row = await readRow(db, id);
        const outcome = row ? outcomeOfRow(row) : null;
        if (!row || !outcome) continue;
        const published = await publishOutcome(env, row, outcome);
        if (published) {
          result.republished++;
        } else if (publish_attempts + 1 >= PUBLISH_MAX_ATTEMPTS) {
          // The last allowed attempt failed: nothing selects this row again, and its check stays
          // as it is. Say so, because nobody else will.
          result.abandoned++;
          console.error(
            `[pr-review-sweep] review ${id} (${row.datasetId}#${row.prNumber}): check not published after ${PUBLISH_MAX_ATTEMPTS} attempts; giving up`,
          );
        }
      } catch (err) {
        result.errors++;
        console.error(`[pr-review-sweep] republish ${id} failed (${errName(err)})`);
      }
    }
  } catch (err) {
    result.errors++;
    console.error(`[pr-review-sweep] republish query failed (${errName(err)})`);
  }
  return result;
}
