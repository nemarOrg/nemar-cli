/**
 * The dataset pull-request review, Worker side (ADR 0092).
 *
 * A pull request opened or updated against `main` of a dataset repository reaches the Worker as a
 * `pull_request` delivery from the NEMAR GitHub App. The Worker decides whether to review it,
 * records the attempt in `pr_reviews`, and dispatches a workflow to `nemarDatasets/.github` that
 * reads the change as git data and asks a model three questions. The workflow posts a report back;
 * the Worker validates it against the closed vocabulary in `shared/pr-review.ts`, derives the
 * verdict, and publishes a check-run and one pull-request comment.
 *
 * **Why the Worker is the gate.** Every pull request reaches it, a fork's included, from a
 * delivery GitHub signs; no workflow in a dataset repository takes part, so no collaborator can
 * edit the review or reach the credentials it uses by editing a branch. It is also the only place
 * that can count: who opened which pull request, how many were rejected, how many reviews were
 * started this hour. Those counts decide whether a review is spent at all.
 *
 * **Nothing here trusts the pull request.** The event is read by {@link readPullRequestEvent},
 * which accepts only the shapes it expects; the dispatch carries the review's coordinates and not
 * the pull request's text; the report that comes back goes through `parsePrReviewReport` before a
 * byte is stored; and the check and comment are rendered from the parsed report, never from the
 * request body.
 *
 * **Unknown is never green.** A review that was declined, errored, or never reported is published
 * as `action_required`, which GitHub does not count as passing for a required check.
 */

import {
  type AuthorOverride,
  type AuthorTally,
  DAILY_REVIEW_CAP,
  type DeclineReason,
  PrReviewReportError,
  RUN_ERRORS,
  type ReviewOutcome,
  type RunError,
  conclusionOf,
  hourlyCapFor,
  parsePrReviewReport,
  renderCheck,
  renderComment,
  standingOf,
  verdictOf,
} from "../../../shared/pr-review.js";
import type { Bindings } from "../types/bindings.js";
import { isValidDatasetId } from "./datasetId.js";
import { isNonProductionEnv } from "./environment.js";
import { getDatasetsToken } from "./github-auth.js";
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

/** How long a dispatched review may take before the watchdog gives up on it. The workflow's own deadline is 20. */
export const PR_REVIEW_DEADLINE_MINUTES = 30;

/** Rows the watchdog handles per tick. */
const SWEEP_LIMIT = 20;

/** How long the dispatch may wait for GitHub before the Worker answers the webhook. */
const DISPATCH_TIMEOUT_MS = 10_000;

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
 * The tally for one contributor, counted from the reviews themselves.
 *
 * `decided` is the number of distinct pull requests with at least one decided (pass or fail)
 * review; `rejected` is how many of those were most recently decided as a fail. Counting the
 * LATEST decided review of each pull request means a contributor who fixes a rejected pull
 * request is not punished for iterating, and five pushes to one bad pull request are one
 * rejection, not five.
 */
export const AUTHOR_TALLY_SQL = `
  WITH latest AS (
    SELECT verdict,
           ROW_NUMBER() OVER (PARTITION BY dataset_id, pr_number ORDER BY id DESC) AS rn
      FROM pr_reviews
     WHERE author_id = ? AND state = 'reported' AND verdict IN ('pass', 'fail')
  )
  SELECT COUNT(*) AS decided,
         COALESCE(SUM(CASE WHEN verdict = 'fail' THEN 1 ELSE 0 END), 0) AS rejected
    FROM latest
   WHERE rn = 1`;

/** Reviews that cost something: a declined row never reached the model. */
const AUTHOR_HOURLY_SQL = `SELECT COUNT(*) AS n FROM pr_reviews
  WHERE author_id = ? AND state != 'declined' AND created_at >= datetime('now', '-1 hour')`;
const PLATFORM_DAILY_SQL = `SELECT COUNT(*) AS n FROM pr_reviews
  WHERE state != 'declined' AND created_at >= datetime('now', '-1 day')`;

export async function readAuthorTally(db: D1Database, authorId: number): Promise<AuthorTally> {
  const row = await db
    .prepare(AUTHOR_TALLY_SQL)
    .bind(authorId)
    .first<{ decided: number; rejected: number }>();
  return { decided: row?.decided ?? 0, rejected: row?.rejected ?? 0 };
}

export async function readAuthorOverride(
  db: D1Database,
  authorId: number,
): Promise<AuthorOverride> {
  const row = await db
    .prepare("SELECT mode FROM pr_review_overrides WHERE author_id = ?")
    .bind(authorId)
    .first<{ mode: string }>();
  return row?.mode === "allow" || row?.mode === "block" ? row.mode : null;
}

/** Whether to spend a review on this pull request, and if not, the fixed word for why. */
export async function decideReview(
  db: D1Database,
  pr: PrIntake,
): Promise<{ review: true } | { review: false; reason: DeclineReason }> {
  const standing = standingOf(
    await readAuthorTally(db, pr.authorId),
    await readAuthorOverride(db, pr.authorId),
  );
  if (standing.paused) return { review: false, reason: "contributor_paused" };

  const hourly = await db.prepare(AUTHOR_HOURLY_SQL).bind(pr.authorId).first<{ n: number }>();
  if ((hourly?.n ?? 0) >= hourlyCapFor(pr.authorAssociation)) {
    return { review: false, reason: "rate_limited" };
  }
  const daily = await db.prepare(PLATFORM_DAILY_SQL).first<{ n: number }>();
  if ((daily?.n ?? 0) >= DAILY_REVIEW_CAP) return { review: false, reason: "daily_limit" };
  return { review: true };
}

// ---------------------------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------------------------

interface ReviewRow {
  id: number;
  datasetId: string;
  prNumber: number;
  headSha: string;
  checkRunId: number | null;
  commentId: number | null;
}

/** The comment this pull request already carries, from any earlier review of it. */
async function existingCommentId(
  db: D1Database,
  datasetId: string,
  prNumber: number,
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT comment_id FROM pr_reviews
        WHERE dataset_id = ? AND pr_number = ? AND comment_id IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
    )
    .bind(datasetId, prNumber)
    .first<{ comment_id: number }>();
  return row?.comment_id ?? null;
}

/** True when no later commit of this pull request has been taken up since `id`. */
async function isLatestReview(db: D1Database, row: ReviewRow): Promise<boolean> {
  const latest = await db
    .prepare("SELECT MAX(id) AS id FROM pr_reviews WHERE dataset_id = ? AND pr_number = ?")
    .bind(row.datasetId, row.prNumber)
    .first<{ id: number }>();
  return latest?.id === row.id;
}

/**
 * Publish an outcome to GitHub: the check-run on the reviewed commit, and (for a decided outcome,
 * and only while this is still the latest commit of the pull request) the pull-request comment.
 * Each surface fails on its own and is logged by status; neither can lose the stored verdict.
 * `running` publishes the in-progress check only.
 */
export async function publishOutcome(
  env: Bindings,
  row: ReviewRow,
  outcome: ReviewOutcome | "running",
): Promise<void> {
  let token: string;
  try {
    token = await getDatasetsToken(env);
  } catch (err) {
    console.error(`[pr-review] review ${row.id}: no GitHub token (${errName(err)})`);
    return;
  }
  const db = env.DB;
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
      repo: row.datasetId,
      headSha: row.headSha,
      checkRunId: row.checkRunId,
      conclusion: outcome === "running" ? null : conclusionOf(outcome),
      ...rendered,
    });
    if (id !== row.checkRunId) {
      await db
        .prepare("UPDATE pr_reviews SET check_run_id = ? WHERE id = ?")
        .bind(id, row.id)
        .run();
    }
  } catch (err) {
    console.error(`[pr-review] review ${row.id}: check-run not published (${errName(err)})`);
  }
  if (outcome === "running" || !(await isLatestReview(db, row))) return;
  try {
    const commentId = row.commentId ?? (await existingCommentId(db, row.datasetId, row.prNumber));
    const id = await upsertReviewComment({
      token,
      repo: row.datasetId,
      prNumber: row.prNumber,
      commentId,
      body: renderComment(outcome, row.headSha),
    });
    if (id !== row.commentId) {
      await db.prepare("UPDATE pr_reviews SET comment_id = ? WHERE id = ?").bind(id, row.id).run();
    }
  } catch (err) {
    // Typically the App lacks pull_requests: write. The check still carries the whole review.
    console.error(`[pr-review] review ${row.id}: comment not published (${errName(err)})`);
  }
}

function errName(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 120) : "unknown";
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

const no = (reason: string): PrReviewResponse => ({ ok: true, dispatched: false, reason });

/**
 * Take up a `pull_request` delivery. The caller has already verified the delivery's signature and
 * applied the production/dev ownership fence; everything else is decided here, and nothing here
 * throws into the webhook (a retried delivery would only repeat the work).
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
    console.error("[pr-review] PRESCREEN_CALLBACK_SECRET is unset; not reviewing");
    return no("misconfigured");
  }

  // Only a dataset NEMAR holds. A repository that merely has a dataset-shaped name is not one.
  const known = await db
    .prepare("SELECT 1 AS ok FROM datasets WHERE dataset_id = ?")
    .bind(pr.datasetId)
    .first<{ ok: number }>();
  if (!known) return no("unknown_dataset");

  const decision = await decideReview(db, pr);
  const nonce = decision.review ? crypto.randomUUID() : null;
  const inserted = await db
    .prepare(
      `INSERT INTO pr_reviews
         (dataset_id, pr_number, head_sha, author_id, author_login, author_association,
          from_fork, state, detail, nonce)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      decision.review ? "dispatched" : "declined",
      decision.review ? null : decision.reason,
      nonce,
    )
    .run();
  // The same commit again (a repeated delivery, or a second event for it) finds its row.
  if ((inserted.meta.changes ?? 0) !== 1) return no("duplicate");
  const reviewId = Number(inserted.meta.last_row_id);
  const row: ReviewRow = {
    id: reviewId,
    datasetId: pr.datasetId,
    prNumber: pr.prNumber,
    headSha: pr.headSha,
    checkRunId: null,
    commentId: null,
  };

  if (!decision.review) {
    await publishOutcome(env, row, { kind: "declined", reason: decision.reason });
    return { ok: true, dispatched: false, reason: decision.reason, review_id: reviewId };
  }

  await publishOutcome(env, row, "running");
  try {
    const token = await signPrReviewCallbackToken(
      { datasetId: pr.datasetId, reviewId, nonce: nonce as string },
      secret,
    );
    await triggerPrReviewRun(
      {
        datasetId: pr.datasetId,
        prNumber: pr.prNumber,
        headSha: pr.headSha,
        reviewId,
        callbackToken: token,
        environment: approvalDispatchEnvironment(env),
      },
      await getDatasetsToken(env),
      DISPATCH_TIMEOUT_MS,
    );
  } catch (err) {
    console.error(`[pr-review] review ${reviewId}: dispatch failed (${errName(err)})`);
    await db
      .prepare(
        `UPDATE pr_reviews SET state = 'errored', detail = 'workflow_failed', nonce = NULL,
                decided_at = datetime('now')
          WHERE id = ? AND state = 'dispatched'`,
      )
      .bind(reviewId)
      .run();
    const fresh = await readRow(db, reviewId);
    await publishOutcome(env, fresh ?? row, { kind: "error", error: "workflow_failed" });
    return { ok: true, dispatched: false, reason: "dispatch_failed", review_id: reviewId };
  }
  return { ok: true, dispatched: true, reason: "dispatched", review_id: reviewId };
}

async function readRow(db: D1Database, id: number): Promise<ReviewRow | null> {
  const r = await db
    .prepare(
      `SELECT id, dataset_id, pr_number, head_sha, check_run_id, comment_id
         FROM pr_reviews WHERE id = ?`,
    )
    .bind(id)
    .first<{
      id: number;
      dataset_id: string;
      pr_number: number;
      head_sha: string;
      check_run_id: number | null;
      comment_id: number | null;
    }>();
  return r
    ? {
        id: r.id,
        datasetId: r.dataset_id,
        prNumber: r.pr_number,
        headSha: r.head_sha,
        checkRunId: r.check_run_id,
        commentId: r.comment_id,
      }
    : null;
}

// ---------------------------------------------------------------------------------------------
// The callback
// ---------------------------------------------------------------------------------------------

/** The nonce of a review still waiting for its report, or null. Replays and strangers find nothing. */
export async function pendingNonce(
  db: D1Database,
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

export interface ReviewCallbackBody {
  outcome: unknown;
  report: unknown;
  error: unknown;
}

/**
 * Store a verified callback and publish it. The write is one conditional UPDATE keyed on the
 * nonce, so a duplicate callback or the watchdog winning the race stores nothing twice; a report
 * the parser refuses is stored as the run error `report_invalid` and never as a verdict.
 */
export async function storePrReviewResult(
  env: Bindings,
  reviewId: number,
  datasetId: string,
  nonce: string,
  body: ReviewCallbackBody,
): Promise<{ stored: boolean }> {
  const db = env.DB;
  let outcome: ReviewOutcome;
  if (body.outcome === "reported") {
    try {
      outcome = { kind: "reported", report: parsePrReviewReport(body.report) };
    } catch (err) {
      if (!(err instanceof PrReviewReportError)) throw err;
      outcome = { kind: "error", error: "report_invalid" };
    }
  } else {
    const word = (RUN_ERRORS as readonly unknown[]).includes(body.error)
      ? (body.error as RunError)
      : "workflow_failed";
    outcome = { kind: "error", error: word };
  }

  const res = await db
    .prepare(
      `UPDATE pr_reviews
          SET state = ?, verdict = ?, detail = ?, report = ?, nonce = NULL,
              decided_at = datetime('now')
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
  if ((res.meta.changes ?? 0) !== 1) return { stored: false };
  const row = await readRow(db, reviewId);
  if (row) await publishOutcome(env, row, outcome);
  return { stored: true };
}

// ---------------------------------------------------------------------------------------------
// The watchdog
// ---------------------------------------------------------------------------------------------

export interface PrReviewSweepResult {
  timedOut: number;
  errors: number;
  skipped: boolean;
}

/**
 * Give up on reviews that never reported. GitHub answers a dispatch 204 whether or not any
 * workflow listens, so a review can be handed over and never run; left alone its check would
 * stay "in progress" for good. The row is marked `unreported` and its nonce KEPT, so a report that
 * arrives late is still accepted and replaces the verdict. PRODUCTION-ONLY, like the other
 * watchdogs: it writes to GitHub on the shared `nemarDatasets` org.
 */
export async function sweepStalePrReviews(env: Bindings): Promise<PrReviewSweepResult> {
  const result: PrReviewSweepResult = { timedOut: 0, errors: 0, skipped: false };
  if (isNonProductionEnv(env) || env.PR_REVIEW_ENABLED !== "1") {
    result.skipped = true;
    return result;
  }
  const db = env.DB;
  let overdue: { id: number }[] = [];
  try {
    overdue = (
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
  } catch (err) {
    result.errors++;
    console.error(`[pr-review-sweep] overdue query failed (${errName(err)})`);
    return result;
  }
  for (const { id } of overdue) {
    try {
      const res = await db
        .prepare(
          `UPDATE pr_reviews SET state = 'unreported', decided_at = datetime('now')
            WHERE id = ? AND state = 'dispatched'`,
        )
        .bind(id)
        .run();
      if ((res.meta.changes ?? 0) !== 1) continue;
      result.timedOut++;
      const row = await readRow(db, id);
      if (row) await publishOutcome(env, row, { kind: "unreported" });
    } catch (err) {
      result.errors++;
      console.error(`[pr-review-sweep] review ${id} failed (${errName(err)})`);
    }
  }
  return result;
}
