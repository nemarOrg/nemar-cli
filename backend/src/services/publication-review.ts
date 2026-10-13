/**
 * The publication review, Worker side: the write path (ADR 0101).
 *
 * When the identifier screen of a publication request reports for a commit and its gate is clear
 * or needs an acknowledgment, the Worker starts a review of that commit: it records the attempt in
 * `publication_reviews` (migration 0096) and dispatches a workflow to `nemarDatasets/.github`.
 * The workflow CLAIMS the review (the Worker accepts the one-shot token, checks the request is
 * still the one it was dispatched for, and records the time) before it spends anything, reads the
 * root documents at the commit as git data, asks a model four questions and posts a report. The
 * Worker parses it at the door ({@link storePublicationReviewResult}), derives the verdict, and
 * moves a request whose submission minimum failed at that commit to `blocked`.
 *
 * This module owns everything that CHANGES a review row, or a request because of a review: the
 * start ({@link startPublicationReview}), the caps, the dispatch, the claim, the result, the
 * watchdog. How a row is read, and the SQL fragments the single-statement decisions share, live in
 * `publication-review-rows.ts`; what it all means to a person is `shared/publication-review.ts`.
 *
 * **Nothing here sends GitHub anything but the dispatch.** There is no check-run, comment, label
 * or tag, so no republish pass exists and a GitHub outage can only delay a review.
 *
 * **Nothing here trusts the dataset or the job.** The dispatch carries the review's coordinates
 * (ids, a commit, a flag, a token) and never a byte of the dataset. The report that comes back
 * goes through `parsePublicationReviewReport` before a byte is stored, the stored verdict is
 * derived from it here and never read from it, and a report whose echoed commit or release kind
 * differs from the row is refused as `report_invalid`.
 *
 * **Unknown is never green.** A review that was declined, errored or never reported is a row in
 * that state, and every reader turns a row that has not reported into a reason.
 *
 * **Every log line is ids and fixed words.** No token, nonce, secret, document text or model
 * output is ever printed.
 *
 * Two statements decide in SQL because each is one conditional write: the claim and the re-block.
 * Both read the screened commit the way the mail lease does (`screenedHeadSql`), and carry the
 * module comment of `publication-review-rows.ts` about the one place that reading can differ from
 * `readStoredReport`: a report edited by hand, which the claim then also refuses unless the edited
 * row keeps a reviewable state. That risk is accepted.
 */

import type { StartReason } from "../../../shared/contract/publication-review-admin.js";
import { screenGate } from "../../../shared/identifier-screen-report.js";
import {
  DEPOSITOR_DAILY_CAP,
  NEVER_REACHED_MODEL,
  PLATFORM_DAILY_CAP,
  PUBLICATION_REVIEW_DEADLINE_MINUTES,
  type PublicationCallbackOutcome,
  type PublicationDeclineDetail,
  type PublicationReviewState,
  reportReasons,
  verdictOf,
} from "../../../shared/publication-review.js";
import { minimumFailureSentence } from "../../../shared/submission-minimums.js";
import type { Bindings } from "../types/bindings.js";
import { isNonProductionEnv } from "./environment.js";
import { getDatasetsAuth, getDatasetsToken } from "./github-auth.js";
import { signPublicationReviewCallbackToken } from "./github/callback-tokens.js";
import { approvalDispatchEnvironment, triggerPublicationReviewRun } from "./github/dispatch.js";
import { readStoredReport, readStoredState } from "./identifier-screen-stored.js";
import { notifyAdminsOfScreen } from "./identifier-screen.js";
import { ownedHere } from "./pr-review-queue.js";
import {
  type PublicationReviewRow,
  REVIEWABLE_SCREEN_STATES_SQL,
  readReview,
  readReviewByKey,
  screenedHeadSql,
} from "./publication-review-rows.js";
import { publicationReviewApplies, reviewEnabled } from "./publication-review-view.js";

type Db = D1Database;

/**
 * Hand work to the runtime so the caller's answer need not wait for it: true when it took the
 * task, false when it cannot (a test harness has no execution context), and the caller awaits it.
 */
export type Defer = (task: Promise<unknown>) => boolean;

/** Rows the watchdog handles per tick. */
const SWEEP_LIMIT = 20;

/** How long the dispatch may wait for GitHub before the start answers. */
const DISPATCH_TIMEOUT_MS = 10_000;

const SHA40 = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------------------------
// The flag, applicability, words
// ---------------------------------------------------------------------------------------------

// The flag (exactly the word `1`, so the kill switch is one reviewed character) and the scope
// (OpenNeuro mirrors and exemplars passed an upstream review, so there is no row, no gate and no
// change to ADR 0089's importer) are declared once, in the view module: the admin mail imports
// that module, and this one imports the mail, so a declaration here would be a cycle.
export { publicationReviewApplies, reviewEnabled };

/** A closed word of lowercase letters and underscores, safe to splice into SQL. */
function sqlWord(w: string): string {
  if (!/^[a-z_]+$/.test(w)) throw new Error("not a plain word");
  return `'${w}'`;
}

/**
 * What an error is called in a log line: a class or a status, never its message, which may carry
 * text from a service that echoed something it was sent.
 */
export function errClass(err: unknown): string {
  if (!(err instanceof Error)) return "unknown";
  if (err.name === "TimeoutError" || err.name === "AbortError") return "timeout";
  const status = /^Publication review dispatch rejected: HTTP (\d{3})$/.exec(err.message);
  if (status) return `http_${status[1]}`;
  return /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "error";
}

/** Try the request's admin mail. It never throws, and a failure here must not fail a store. */
async function tryMail(env: Bindings, requestId: number): Promise<"sent" | "other"> {
  try {
    return (await notifyAdminsOfScreen(env, requestId)) === "sent" ? "sent" : "other";
  } catch (err) {
    console.error(`[publication-review] request ${requestId}: mail failed (${errClass(err)})`);
    return "other";
  }
}

/**
 * Try the mail after the caller's answer when it can be deferred (the job's POST must not wait on
 * Resend), and now when it cannot.
 */
async function tryMailAfterAnswer(
  env: Bindings,
  requestId: number,
  defer: Defer | undefined,
): Promise<void> {
  const mail = tryMail(env, requestId);
  if (!defer?.(mail)) await mail;
}

// ---------------------------------------------------------------------------------------------
// The caps
// ---------------------------------------------------------------------------------------------

/**
 * What a row's `attempts` stands for. It is the number of model calls the row may have cost, ONE
 * SLOT PER ATTEMPT: an insert starts with one (the call it is about to make), and a restart of an
 * attempt that reached a model adds one (that call is now an earlier, spent one, and the restart
 * has its own slot). An attempt that never reached a model gives its slot back, which is not a
 * write but a reading ({@link CAP_CALLS_SQL}), so nothing that happens to an attempt (a decline, a
 * failed dispatch, the watchdog giving up) can change what the calls before it cost.
 *
 * An attempt reached a model, or may yet, when it is still `dispatched` (the job may claim it) or
 * has reported, or a claim was taken and it did not end in a word that says no model was reached.
 * The claim precedes any model spend, so a row nobody claimed (the workflow undeployed, Actions
 * down) held no model: it does not count, and five of them do not exhaust a depositor.
 * Derived from `NEVER_REACHED_MODEL`, so the cap and the restart rule cannot disagree about which
 * attempts were free.
 */
const ATTEMPT_REACHED_SQL = `(state IN ('dispatched', 'reported')
    OR (claimed_at IS NOT NULL AND (state = 'unreported'
        OR (state = 'errored' AND detail NOT IN (${NEVER_REACHED_MODEL.map(sqlWord).join(", ")})))))`;

/**
 * The model calls that count against an allowance: every slot, less the current attempt's when it
 * never reached a model. Over a window of rows, so `SUM(attempts) - COUNT(unreached rows)`.
 */
export const CAP_CALLS_SQL = `COALESCE(SUM(attempts), 0)
    - COUNT(CASE WHEN NOT ${ATTEMPT_REACHED_SQL} THEN 1 END)`;

/**
 * A row's place in an allowance: the model calls that count against it, up to and including this
 * row, started inside the window. Counted AFTER the row is inserted (or restarted, which bumps its
 * slots in the same write), so two starts that race each see the other and at most the cap
 * survive; checking before inserting let a burst all pass the same check.
 *
 * The depositor's tally includes calls an administrator started on the depositor's requests, and
 * it is intended: an administrator is not held by the depositor's allowance (it exists to stop a
 * depositor spending the platform's money), but the call still costs the platform, so it bounds
 * the depositor's own next request. See `capDecision`.
 */
export const DEPOSITOR_RANK_SQL = `SELECT ${CAP_CALLS_SQL} AS n FROM publication_reviews
  WHERE requested_by = ? AND created_at >= datetime('now', '-1 day') AND id <= ?`;
export const PLATFORM_RANK_SQL = `SELECT ${CAP_CALLS_SQL} AS n FROM publication_reviews
  WHERE created_at >= datetime('now', '-1 day') AND id <= ?`;

/**
 * Which allowance, if any, the row just inserted (or restarted) is over. An administrator who
 * starts a review by name is held by the platform's allowance only: the depositor's exists to
 * stop a depositor spending the platform's money, and an administrator is not one. The call still
 * counts toward the depositor's tally (see {@link DEPOSITOR_RANK_SQL}).
 */
async function capDecision(
  db: Db,
  row: { requestedBy: number },
  rankId: number,
  skipDepositorCap: boolean,
): Promise<PublicationDeclineDetail | null> {
  if (!skipDepositorCap) {
    const depositor = await db
      .prepare(DEPOSITOR_RANK_SQL)
      .bind(row.requestedBy, rankId)
      .first<{ n: number }>();
    if ((depositor?.n ?? 0) > DEPOSITOR_DAILY_CAP) return "depositor_limit";
  }
  const platform = await db.prepare(PLATFORM_RANK_SQL).bind(rankId).first<{ n: number }>();
  if ((platform?.n ?? 0) > PLATFORM_DAILY_CAP) return "platform_limit";
  return null;
}

/** An attempt that ended in a word that says no model was reached (and so may be started again free). */
function endedBeforeAModel(row: PublicationReviewRow): boolean {
  return (
    row.state === "errored" && (NEVER_REACHED_MODEL as readonly string[]).includes(row.detail ?? "")
  );
}

/**
 * Whether a row's attempt reached a model, as far as a restart can tell. A restart replaces the
 * nonce, so an attempt that is not claimed by then never can be: a `dispatched` row counts here
 * only once a claim was taken. (The allowance counts a `dispatched` row whole, because there the
 * job may still claim it.)
 */
function attemptReachedModel(row: PublicationReviewRow): boolean {
  return row.claimedAt !== null && row.state !== "declined" && !endedBeforeAModel(row);
}

// ---------------------------------------------------------------------------------------------
// Starting a review
// ---------------------------------------------------------------------------------------------

/**
 * What a start did, or why it did not. The reasons are `StartReason` of the admin contract, plus
 * `duplicate`: a screen result found a review of its commit and release kind already on record,
 * which is not an error and buys nothing. An administrator's start never answers `duplicate`: it
 * restarts what can be restarted and names what cannot (`running`, `has_result`).
 */
export type StartResult = StartReason | "duplicate";

export interface StartOutcome {
  /** A run is going: handed to GitHub now, or an earlier hand-over whose claim stands. */
  started: boolean;
  reason: StartResult;
  reviewId: number | null;
}

const answer = (
  reason: StartResult,
  reviewId: number | null = null,
  started = false,
): StartOutcome => ({ started, reason, reviewId });

interface RequestRow {
  id: number;
  dataset_id: string;
  status: string;
  anonymous: number;
  requested_by: number;
  identifier_screen_status: string | null;
  identifier_screen_report: string | null;
  source: string | null;
  is_exemplar: number | null;
}

/** What a start does with the row it found (or did not find) for its commit and release kind. */
type Plan =
  | { kind: "insert" }
  | { kind: "restart"; row: PublicationReviewRow; extraCalls: number }
  | { kind: "refuse"; reason: StartResult };

/**
 * A screen result starts a review only for a commit that has none, or whose last attempt never
 * reached a model (a new result is the retry). An administrator's start also restarts a row that
 * was declined, ended in an error, never reported, or is past its deadline and so is read as
 * never reported; it never restarts one that is running or has a result.
 */
function planFor(existing: PublicationReviewRow | null, admin: boolean): Plan {
  if (existing === null) return { kind: "insert" };
  // A call the row already spent is a second one when the attempt is made again.
  const extraCalls = attemptReachedModel(existing) ? 1 : 0;
  if (endedBeforeAModel(existing)) return { kind: "restart", row: existing, extraCalls };
  if (!admin) return { kind: "refuse", reason: "duplicate" };
  switch (existing.state) {
    case "reported":
      return { kind: "refuse", reason: "has_result" };
    default:
      // A `dispatched` row is restarted only once overdue, which the compare-and-set decides in
      // SQL on the clock the watchdog uses ({@link restartGuard}); a fresh row matches nothing.
      return { kind: "restart", row: existing, extraCalls };
  }
}

/**
 * What a restart's write is conditioned on: the row is the one that was read (state, word and
 * claim, so the call it is charged for is the call that was made), and a `dispatched` row is past
 * its deadline. One rule for every restart, whether it hands the review over or records that it
 * cannot be handed over.
 */
function restartGuard(row: PublicationReviewRow): {
  sql: string;
  binds: (string | number | null)[];
} {
  const overdue =
    row.state === "dispatched"
      ? ` AND created_at < datetime('now', '-${PUBLICATION_REVIEW_DEADLINE_MINUTES} minutes')`
      : "";
  return {
    sql: `id = ? AND state = ? AND detail IS ? AND claimed_at IS ?${overdue}`,
    binds: [row.id, row.state, row.detail, row.claimedAt],
  };
}

/** Why a row that could not be restarted cannot be, as an administrator reads it. */
function reasonForRow(row: PublicationReviewRow | null): StartResult {
  if (row?.state === "reported") return "has_result";
  return "running";
}

/**
 * Called by the screen callback after a stored result and before the admin mail. Starts the
 * review of that result's commit when the flag is on, the dataset is this Worker's and the
 * request still stands. Never throws: a database fault is logged and returned, so it cannot fail
 * the callback that stores the screen. The mail is not tried here, because the callback tries it
 * straight after, with the review row already written.
 */
export async function startPublicationReviewForScreen(
  env: Bindings,
  args: { requestId: number; datasetId: string },
): Promise<StartOutcome> {
  try {
    const out = await startPublicationReview(env, args, { mail: false });
    // Quiet for the answers that are the normal case (off, not ours, not applicable, not ready, a
    // repeat), which would otherwise print a line for every screen result.
    if (
      out.started ||
      out.reason === "depositor_limit" ||
      out.reason === "platform_limit" ||
      out.reason === "dispatch_failed" ||
      out.reason === "dispatch_unconfigured"
    ) {
      console.log(
        `[publication-review] request ${args.requestId} (${args.datasetId}): start ${out.reason}${
          out.reviewId === null ? "" : ` review=${out.reviewId}`
        }`,
      );
    }
    return out;
  } catch (err) {
    console.error(
      `[publication-review] request ${args.requestId} (${args.datasetId}): start failed (${errClass(err)})`,
    );
    return answer("dispatch_failed");
  }
}

export interface StartOptions {
  /** Try the request's admin mail when a start ends in a state that is final. Default true. */
  mail?: boolean;
}

/**
 * The one start path: a screen result's (through {@link startPublicationReviewForScreen}) and an
 * administrator's (`adminUserId` set, WP6's route). Every refusal returns its reason and writes
 * nothing. A database error after the row is written marks the row `dispatch_failed` and
 * throws.
 */
export async function startPublicationReview(
  env: Bindings,
  args: { requestId: number; datasetId: string; adminUserId?: number },
  options: StartOptions = {},
): Promise<StartOutcome> {
  const db = env.DB;
  const admin = args.adminUserId !== undefined;
  const mail = options.mail !== false;

  if (!reviewEnabled(env)) return answer("review_disabled");
  // The `nemarDatasets` org is shared between the two Workers and their D1s are not: each starts
  // reviews only for the datasets it owns, so the other's would all read "not reviewed" here.
  if (!ownedHere(env, args.datasetId)) return answer("not_owned_here");

  const request = await db
    .prepare(
      `SELECT pr.id, pr.dataset_id, pr.status, pr.anonymous, pr.requested_by,
              pr.identifier_screen_status, pr.identifier_screen_report, d.source, d.is_exemplar
         FROM publication_requests pr JOIN datasets d ON d.dataset_id = pr.dataset_id
        WHERE pr.id = ? AND pr.dataset_id = ?`,
    )
    .bind(args.requestId, args.datasetId)
    .first<RequestRow>();
  if (!request) return answer("request_not_requested");
  if (!publicationReviewApplies(request)) return answer("not_applicable");
  // Only a request waiting for its decision is reviewed. One that is blocked, being approved,
  // denied or published has nothing a review could change (ADR 0101, section 7).
  if (request.status !== "requested") return answer("request_not_requested");

  // The screen is read the gate's way: its state and its commit through the two readers, never a
  // column read by hand.
  const gate = screenGate(readStoredState(request.identifier_screen_status));
  const head = readStoredReport(request.identifier_screen_report)?.head ?? null;
  if ((gate !== "clear" && gate !== "acknowledge") || head === null || !SHA40.test(head)) {
    return answer("screen_not_ready");
  }
  const anonymous = request.anonymous === 1;

  const secret = env.PRESCREEN_CALLBACK_SECRET;
  const configured = Boolean(secret) && hasGithubCredential(env);

  // A row may be moved by another writer between the read and the write (a second screen result,
  // an administrator, the watchdog, a report). Each lost race is re-read and planned again.
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await readReviewByKey(db, request.id, head, anonymous);
    const plan = planFor(existing, admin);
    if (plan.kind === "refuse") return answer(plan.reason, existing?.id ?? null);

    if (!configured || !secret) {
      return await recordUnconfigured(env, request, head, anonymous, plan, args.adminUserId, mail);
    }

    const nonce = crypto.randomUUID();
    let reviewId: number;
    let rankId: number;
    if (plan.kind === "insert") {
      const inserted = await db
        .prepare(
          `INSERT INTO publication_reviews
             (request_id, dataset_id, head_sha, anonymous, requested_by, started_by, state, nonce)
           VALUES (?, ?, ?, ?, ?, ?, 'dispatched', ?)
           ON CONFLICT (request_id, head_sha, anonymous) DO NOTHING`,
        )
        .bind(
          request.id,
          request.dataset_id,
          head,
          anonymous ? 1 : 0,
          request.requested_by,
          args.adminUserId ?? null,
          nonce,
        )
        .run();
      // Another start of the same commit won the insert between the read and the write.
      if ((inserted.meta.changes ?? 0) !== 1) continue;
      reviewId = Number(inserted.meta.last_row_id);
      rankId = reviewId;
    } else {
      // The call the row already spent is recorded HERE, in the same write that takes the row
      // back, and never after the allowances have been consulted: a restart that is then declined
      // or fails to dispatch has still not undone the call before it.
      const guard = restartGuard(plan.row);
      const reset = await db
        .prepare(
          `UPDATE publication_reviews
              SET state = 'dispatched', detail = NULL, nonce = ?, claimed_at = NULL,
                  decided_at = NULL, created_at = datetime('now'),
                  attempts = attempts + ?, started_by = COALESCE(?, started_by)
            WHERE ${guard.sql}`,
        )
        .bind(nonce, plan.extraCalls, args.adminUserId ?? null, ...guard.binds)
        .run();
      if ((reset.meta.changes ?? 0) !== 1) {
        // A dispatched row that is not overdue matches nothing: it is running, and an
        // administrator is told so. Any other lost race is re-read and planned again.
        if (plan.row.state === "dispatched") {
          const now = await readReview(db, plan.row.id);
          if (now?.state === "dispatched") return answer("running", now.id);
        }
        continue;
      }
      reviewId = plan.row.id;
      // A restarted row keeps its old id, which the allowance queries (`id <= ?`) would rank
      // ahead of everything inserted since: it is ranked as the newest instead.
      rankId = Number.MAX_SAFE_INTEGER;
    }

    const restarted = plan.kind === "restart";
    try {
      return await handOver(env, {
        reviewId,
        rankId,
        restarted,
        request,
        head,
        anonymous,
        nonce,
        secret,
        admin,
        mail,
      });
    } catch (err) {
      await markDispatchFailed(db, reviewId, nonce);
      throw err;
    }
  }
  // Three lost races in a row: whatever is there now is being run by someone else.
  const latest = await readReviewByKey(db, request.id, head, anonymous);
  return answer(admin ? reasonForRow(latest) : "duplicate", latest?.id ?? null);
}

/** Whether a credential for the `nemarDatasets` org is configured at all. */
function hasGithubCredential(env: Bindings): boolean {
  try {
    getDatasetsAuth(env);
    return true;
  } catch {
    return false;
  }
}

/**
 * The review could not be handed over because the Worker has no callback secret or no GitHub
 * credential. Recorded as `errored` / `dispatch_unconfigured` so the administrator is told, and
 * so a later screen result or `start` retries once it is fixed. Written directly in that state:
 * there is no nonce and no run.
 */
async function recordUnconfigured(
  env: Bindings,
  request: RequestRow,
  head: string,
  anonymous: boolean,
  plan: Plan,
  adminUserId: number | undefined,
  mail: boolean,
): Promise<StartOutcome> {
  const db = env.DB;
  let reviewId: number | null = null;
  if (plan.kind === "insert") {
    const inserted = await db
      .prepare(
        `INSERT INTO publication_reviews
           (request_id, dataset_id, head_sha, anonymous, requested_by, started_by, state, detail,
            nonce, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, 'errored', 'dispatch_unconfigured', NULL, datetime('now'))
         ON CONFLICT (request_id, head_sha, anonymous) DO NOTHING`,
      )
      .bind(
        request.id,
        request.dataset_id,
        head,
        anonymous ? 1 : 0,
        request.requested_by,
        adminUserId ?? null,
      )
      .run();
    if ((inserted.meta.changes ?? 0) === 1) reviewId = Number(inserted.meta.last_row_id);
  } else if (plan.kind === "restart") {
    // The same rule as the restart that does hand over (`restartGuard`): a `dispatched` row is
    // closed only once it is overdue. A review that is running is not made unanswerable because
    // the Worker could not have started another.
    const guard = restartGuard(plan.row);
    const closed = await db
      .prepare(
        `UPDATE publication_reviews
            SET state = 'errored', detail = 'dispatch_unconfigured', nonce = NULL,
                claimed_at = NULL, decided_at = datetime('now'),
                attempts = attempts + ?, started_by = COALESCE(?, started_by)
          WHERE ${guard.sql}`,
      )
      .bind(plan.extraCalls, adminUserId ?? null, ...guard.binds)
      .run();
    if ((closed.meta.changes ?? 0) === 1) {
      reviewId = plan.row.id;
    } else if (plan.row.state === "dispatched") {
      const now = await readReview(db, plan.row.id);
      if (now?.state === "dispatched") return answer("running", now.id);
    }
  }
  console.warn(
    `[publication-review] ${request.dataset_id} request ${request.id}: dispatch_unconfigured`,
  );
  if (mail) await tryMail(env, request.id);
  return answer("dispatch_unconfigured", reviewId);
}

/**
 * The row exists but nothing has run for it (a database error between the write and the dispatch).
 * Left as `dispatched` it would count against the caps, hold the request's mail and wait for a
 * watchdog that never runs on dev. Mark it as a dispatch that did not happen, which the next screen
 * result retries. Fenced by the nonce, so it cannot touch a row another start has since replaced.
 */
async function markDispatchFailed(db: Db, reviewId: number, nonce: string): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE publication_reviews
            SET state = 'errored', detail = 'dispatch_failed', nonce = NULL,
                decided_at = datetime('now')
          WHERE id = ? AND state = 'dispatched' AND nonce = ? AND claimed_at IS NULL`,
      )
      .bind(reviewId, nonce)
      .run();
  } catch (inner) {
    console.error(
      `[publication-review] review ${reviewId}: failure not recorded (${errClass(inner)})`,
    );
  }
}

interface HandOver {
  reviewId: number;
  rankId: number;
  restarted: boolean;
  request: RequestRow;
  head: string;
  anonymous: boolean;
  nonce: string;
  secret: string;
  admin: boolean;
  mail: boolean;
}

/** Everything after the row is written: the allowances, then the dispatch. */
async function handOver(env: Bindings, h: HandOver): Promise<StartOutcome> {
  const db = env.DB;
  const over = await capDecision(db, { requestedBy: h.request.requested_by }, h.rankId, h.admin);
  if (over) {
    await db
      .prepare(
        `UPDATE publication_reviews
            SET state = 'declined', detail = ?, nonce = NULL, decided_at = datetime('now')
          WHERE id = ? AND state = 'dispatched'`,
      )
      .bind(over, h.reviewId)
      .run();
    if (h.mail) await tryMail(env, h.request.id);
    return answer(over, h.reviewId);
  }

  try {
    const token = await signPublicationReviewCallbackToken(
      { datasetId: h.request.dataset_id, reviewId: h.reviewId, nonce: h.nonce },
      h.secret,
    );
    await triggerPublicationReviewRun(
      {
        datasetId: h.request.dataset_id,
        requestId: h.request.id,
        reviewId: h.reviewId,
        headSha: h.head,
        anonymous: h.anonymous,
        callbackToken: token,
        environment: approvalDispatchEnvironment(env),
      },
      await getDatasetsToken(env),
      DISPATCH_TIMEOUT_MS,
    );
  } catch (err) {
    console.error(
      `[publication-review] review ${h.reviewId} (${h.request.dataset_id}): dispatch failed (${errClass(err)})`,
    );
    try {
      // Fenced by the nonce and by `claimed_at IS NULL`: GitHub may have accepted the dispatch
      // and the workflow may already have claimed it before the response failed. Clearing a
      // claimed row's nonce would make its valid report fail.
      const failed = await db
        .prepare(
          `UPDATE publication_reviews
              SET state = 'errored', detail = 'dispatch_failed', nonce = NULL,
                  decided_at = datetime('now')
            WHERE id = ? AND state = 'dispatched' AND nonce = ? AND claimed_at IS NULL`,
        )
        .bind(h.reviewId, h.nonce)
        .run();
      if ((failed.meta.changes ?? 0) === 1) {
        if (h.mail) await tryMail(env, h.request.id);
      } else {
        const claim = await db
          .prepare("SELECT claimed_at FROM publication_reviews WHERE id = ?")
          .bind(h.reviewId)
          .first<{ claimed_at: string | null }>();
        if (claim?.claimed_at) return answer("dispatch_claimed", h.reviewId, true);
      }
    } catch (inner) {
      console.error(
        `[publication-review] review ${h.reviewId}: failure not recorded (${errClass(inner)})`,
      );
    }
    return answer("dispatch_failed", h.reviewId);
  }
  return answer(h.restarted ? "redispatched" : "dispatched", h.reviewId, true);
}

// ---------------------------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------------------------

/**
 * The nonce of a review still waiting for its report, and the state it waits in. Replays and
 * strangers find nothing: a stored result has no nonce, a declined or errored row has none, and
 * a re-start replaced it. The one place a nonce is read; every other read of a review selects
 * `ROW_COLUMNS`, which leaves it out.
 */
export async function pendingPublicationReviewNonce(
  db: Db,
  reviewId: number,
  datasetId: string,
): Promise<{ nonce: string; state: "dispatched" | "unreported" } | null> {
  const row = await db
    .prepare(
      `SELECT nonce, state FROM publication_reviews
        WHERE id = ? AND dataset_id = ? AND state IN ('dispatched', 'unreported')
          AND nonce IS NOT NULL LIMIT 1`,
    )
    .bind(reviewId, datasetId)
    .first<{ nonce: string; state: "dispatched" | "unreported" }>();
  return row ? { nonce: row.nonce, state: row.state } : null;
}

export type PublicationClaimResult =
  | "claimed"
  | "already_claimed"
  | "stale_head"
  | "claim_unsettled"
  | "review_disabled"
  | "not_owned_here";

/**
 * The request is still the one the review was dispatched for: waiting for its decision, with the
 * same release kind, and a screen whose gate is clear or acknowledge that read THIS commit. The
 * states come from `screenGate` (`REVIEWABLE_SCREEN_STATES_SQL`), never typed by hand, and the
 * commit is read as the mail lease reads it. A request with no screened commit matches nothing,
 * so a claim fails closed.
 */
const REQUEST_IS_CURRENT = `(SELECT 1 FROM publication_requests AS pr
      WHERE pr.id = publication_reviews.request_id
        AND pr.dataset_id = publication_reviews.dataset_id
        AND pr.status = 'requested'
        AND pr.anonymous = publication_reviews.anonymous
        AND pr.identifier_screen_status IN (${REVIEWABLE_SCREEN_STATES_SQL})
        AND ${screenedHeadSql("pr")} = publication_reviews.head_sha)`;

/**
 * The claim: one conditional write, so a dispatch buys one model call. It takes the review only
 * while its nonce is the live one, it was never claimed, and the request still stands as above.
 */
export const CLAIM_SQL = `UPDATE publication_reviews SET claimed_at = datetime('now')
  WHERE id = ? AND dataset_id = ? AND nonce = ? AND claimed_at IS NULL
    AND state IN ('dispatched', 'unreported')
    AND EXISTS ${REQUEST_IS_CURRENT}`;

/** The refusal of a claim: the same row predicate, with the request no longer current. */
export const CLAIM_STALE_SQL = `UPDATE publication_reviews
    SET state = 'errored', detail = 'stale_head', nonce = NULL, decided_at = datetime('now')
  WHERE id = ? AND dataset_id = ? AND nonce = ? AND claimed_at IS NULL
    AND state IN ('dispatched', 'unreported')
    AND NOT EXISTS ${REQUEST_IS_CURRENT}`;

/** The review was switched off before its job started: close this unclaimed attempt. */
const CLAIM_DISABLED_SQL = `UPDATE publication_reviews
    SET state = 'errored', detail = 'review_disabled', nonce = NULL, decided_at = datetime('now')
  WHERE id = ? AND dataset_id = ? AND nonce = ? AND claimed_at IS NULL
    AND state IN ('dispatched', 'unreported')`;

/** The claim and the refusal kept changing across both tries: close this same attempt. */
const CLAIM_UNSETTLED_SQL = `UPDATE publication_reviews
    SET state = 'errored', detail = 'stale_head', nonce = NULL, decided_at = datetime('now')
  WHERE id = ? AND dataset_id = ? AND nonce = ? AND claimed_at IS NULL
    AND state IN ('dispatched', 'unreported')`;

/**
 * The workflow's first real step, before it mints an identity or reads anything: take the review.
 * The caller has verified the token. A review is claimed once; a request that changed since the
 * dispatch (blocked, denied, approved, re-requested, a screen that moved to another commit or now
 * blocks) is refused and the attempt recorded as `stale_head`, which is not counted against a
 * cap because no model was reached. With the flag off a claim is refused so that no model call is
 * spent; the result of a run that WAS claimed is still stored.
 */
export async function claimPublicationReview(
  env: Bindings,
  reviewId: number,
  datasetId: string,
  nonce: string,
  defer?: Defer,
): Promise<PublicationClaimResult> {
  const db = env.DB;
  const row = await readReview(db, reviewId);
  if (!row || row.datasetId !== datasetId) return "already_claimed";

  if (!reviewEnabled(env)) {
    const closed = await db.prepare(CLAIM_DISABLED_SQL).bind(reviewId, datasetId, nonce).run();
    if ((closed.meta.changes ?? 0) === 1) await tryMailAfterAnswer(env, row.requestId, defer);
    return "review_disabled";
  }
  if (!ownedHere(env, datasetId)) return "not_owned_here";

  // Two tries: the request can change between the claim and its refusal, and a request that
  // becomes current in that gap would otherwise leave the row dispatched until the watchdog.
  for (let attempt = 0; attempt < 2; attempt++) {
    const claimed = await db.prepare(CLAIM_SQL).bind(reviewId, datasetId, nonce).run();
    if ((claimed.meta.changes ?? 0) === 1) return "claimed";

    const stale = await db.prepare(CLAIM_STALE_SQL).bind(reviewId, datasetId, nonce).run();
    if ((stale.meta.changes ?? 0) === 1) {
      await tryMailAfterAnswer(env, row.requestId, defer);
      return "stale_head";
    }
  }

  // Neither statement settled in two tries: fail closed and finish this same unclaimed attempt,
  // so it neither waits for the watchdog nor reaches a model without a settled claim.
  const unsettled = await db.prepare(CLAIM_UNSETTLED_SQL).bind(reviewId, datasetId, nonce).run();
  if ((unsettled.meta.changes ?? 0) === 1) {
    await tryMailAfterAnswer(env, row.requestId, defer);
    return "claim_unsettled";
  }
  return "already_claimed";
}

// ---------------------------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------------------------

/**
 * The row a result may be stored on: waiting under THIS nonce, in one of `states`, and, for a
 * report, claimed. One predicate, spliced into the write of the result and into the guard of every
 * statement that must fire only if that write will take effect.
 */
function waitingRow(states: readonly ("dispatched" | "unreported")[], needsClaim: boolean): string {
  return `id = ? AND dataset_id = ? AND nonce = ? AND state IN (${states.map(sqlWord).join(", ")})${
    needsClaim ? " AND claimed_at IS NOT NULL" : ""
  }`;
}

/**
 * The guard of a statement that follows a result: the review row is still waiting as `waitingRow`
 * says. Evaluated BEFORE the write of the result in the same batch, so it is true exactly when
 * that write will match: a batch is one transaction, and nothing can move the row between them.
 */
function whileWaiting(
  states: readonly ("dispatched" | "unreported")[],
  needsClaim: boolean,
): string {
  return `EXISTS (SELECT 1 FROM publication_reviews WHERE ${waitingRow(states, needsClaim)})`;
}

/**
 * A request whose submission minimum failed at the reviewed commit goes back to `blocked`, the
 * transition the blocked-request sweep already makes, so the depositor can fix it and request
 * again. Only the request the review is the one in force for (still `requested`, same release
 * kind, same screened commit), so a result for a superseded commit changes nothing. The screen's
 * columns are facts about that commit and stay; the depositor's re-request resets them.
 *
 * Fires only while the claimed review it came from is still waiting under its nonce (the last
 * three binds), so a replay, a stranger's nonce or a report nobody claimed re-blocks nothing.
 */
export const REBLOCK_SQL = `UPDATE publication_requests
    SET status = 'blocked', block_reason = 'min_requirements_failed',
        min_requirements_reasons = ?, updated_at = datetime('now')
  WHERE id = ? AND status = 'requested' AND anonymous = ?
    AND ${screenedHeadSql("publication_requests")} = ?
    AND ${whileWaiting(["dispatched", "unreported"], true)}`;

/**
 * A late report re-arms the request's mail: the mail already sent said the review did not report.
 * Only for the request whose review this is, as above, and only while the review waits as
 * `unreported` (the last three binds), so a replay does not re-arm a mail that was since sent.
 * `needsClaim` is whether the result being stored is a report, which needs a claim.
 */
export function rearmMailSql(needsClaim: boolean): string {
  return `UPDATE publication_requests
    SET identifier_screen_emailed_at = NULL, identifier_screen_mail_claimed_at = NULL
  WHERE id = ? AND status IN ('requested', 'blocked') AND anonymous = ?
    AND ${screenedHeadSql("publication_requests")} = ?
    AND ${whileWaiting(["unreported"], needsClaim)}`;
}

/** The write of a result, keyed on the nonce and on the state the row waits in. */
function storeSql(from: "unreported" | "dispatched", needsClaim: boolean): string {
  return `UPDATE publication_reviews
      SET state = ?, verdict = ?, detail = ?, report = ?, nonce = NULL,
          decided_at = datetime('now')
    WHERE ${waitingRow([from], needsClaim)}`;
}

/**
 * Store a verified callback and try the request's mail. The caller has already turned the body
 * into an outcome with `parsePublicationCallbackOutcome`: a report the parser refused is the run
 * error `report_invalid` and never a verdict, and a run error only the Worker may write is
 * `workflow_failed`.
 *
 * The stored verdict is derived HERE, from the parsed report's own reasons (`reportReasons`), and
 * never read from the report, so the column never depends on a fact that can change. A report
 * whose echoed commit or release kind differs from the row's is refused as `report_invalid`: a
 * dispatch payload cannot change what a stored review claims to be about.
 *
 * ONE batch, which D1 runs as a transaction: the re-block (when the report says a minimum failed),
 * the mail re-arm (when the row waits as `unreported`) and the two writes of the result, `dispatched`
 * first and then `unreported`. Each follow-on is guarded by the very predicate its write uses and
 * runs ahead of it, so it fires exactly when the write takes effect, and a fault on any of them
 * leaves nothing stored and the token unspent, which is what lets the job's retry land. The
 * state only moves from `dispatched` to `unreported`, so no gap lies between the two writes. The
 * flag is not consulted: a result whose run was already claimed is stored whatever the flag says,
 * because the call was spent and the record stays honest.
 *
 * A report (which implies a model call) needs a claim; an error word does not, so a failure before
 * the claim (a payload the job could not validate, a fetch that failed) is still recorded.
 * `refusal` says why nothing was stored when that is the reason.
 *
 * The mail follows the store, handed to `defer` when the caller can finish it after its answer
 * (the job's POST has a timeout, and its retry finds the token spent); without one it is awaited.
 */
export async function storePublicationReviewResult(
  env: Bindings,
  reviewId: number,
  datasetId: string,
  nonce: string,
  result: PublicationCallbackOutcome,
  defer?: Defer,
): Promise<{
  stored: boolean;
  state: PublicationReviewState | null;
  refusal?: "unclaimed";
}> {
  const db = env.DB;
  const row = await readReview(db, reviewId);
  if (!row || row.datasetId !== datasetId) return { stored: false, state: null };

  let outcomeToStore = result;
  if (
    outcomeToStore.kind === "reported" &&
    (outcomeToStore.report.evidence.head !== row.headSha ||
      outcomeToStore.report.evidence.anonymous !== row.anonymous)
  ) {
    console.warn(
      `[publication-review] review ${reviewId} (${datasetId}): report refused (evidence_mismatch)`,
    );
    outcomeToStore = { kind: "error", error: "report_invalid" };
  }
  const reported = outcomeToStore.kind === "reported" ? outcomeToStore.report : null;
  const binds = [
    reported ? "reported" : "errored",
    reported ? verdictOf(reportReasons(reported)) : null,
    outcomeToStore.kind === "error" ? outcomeToStore.error : null,
    reported ? JSON.stringify(reported) : null,
    reviewId,
    datasetId,
    nonce,
  ];
  const guard = [reviewId, datasetId, nonce];
  // A report implies a model call, and a call is made only by a run that took its claim.
  const needsClaim = reported !== null;
  const kind = row.anonymous ? 1 : 0;

  const statements: D1PreparedStatement[] = [];
  if (reported && reported.evidence.minimums === "failed") {
    const reasons = reported.evidence.minimum_failures.map(minimumFailureSentence);
    statements.push(
      db
        .prepare(REBLOCK_SQL)
        .bind(JSON.stringify(reasons), row.requestId, kind, row.headSha, ...guard),
    );
  }
  statements.push(
    db.prepare(rearmMailSql(needsClaim)).bind(row.requestId, kind, row.headSha, ...guard),
  );
  statements.push(db.prepare(storeSql("dispatched", needsClaim)).bind(...binds));
  statements.push(db.prepare(storeSql("unreported", needsClaim)).bind(...binds));

  const results = await db.batch(statements);
  const fromDispatched = (results[statements.length - 2]?.meta?.changes ?? 0) === 1;
  const fromUnreported = (results[statements.length - 1]?.meta?.changes ?? 0) === 1;
  if (!fromDispatched && !fromUnreported) {
    // Nothing waited for this result: a duplicate, a restart that replaced the nonce, or a report
    // nobody claimed (which the claim, and not this route, must precede).
    const now = await readReview(db, reviewId);
    const unclaimed =
      needsClaim &&
      now !== null &&
      now.claimedAt === null &&
      (now.state === "dispatched" || now.state === "unreported");
    return unclaimed
      ? { stored: false, state: null, refusal: "unclaimed" }
      : { stored: false, state: null };
  }
  if (
    reported &&
    reported.evidence.minimums === "failed" &&
    (results[0]?.meta?.changes ?? 0) === 1
  ) {
    console.log(
      `[publication-review] review ${reviewId} (${datasetId}): request ${row.requestId} blocked (min_requirements_failed)`,
    );
  }
  await tryMailAfterAnswer(env, row.requestId, defer);
  return { stored: true, state: reported ? "reported" : "errored" };
}

// ---------------------------------------------------------------------------------------------
// The watchdog
// ---------------------------------------------------------------------------------------------

export interface PublicationReviewSweepResult {
  /** Reviews that never reported and were marked unreported. */
  timedOut: number;
  /** Of those, how many requests' mail reached an administrator on this pass. */
  mailed: number;
  errors: number;
  skipped: boolean;
}

/**
 * Give up on reviews that never reported. GitHub answers a dispatch 204 whether or not any workflow
 * listens, so a review can be handed over and never run. The row is marked `unreported` and its
 * nonce KEPT, so a report that arrives late is still accepted, and the request's mail is tried,
 * because it has been waiting for a review that will not come.
 *
 * It does not depend on `PUBLICATION_REVIEW_ENABLED`: turning the review off must not strand a
 * request whose mail waits on a row already in flight. PRODUCTION-ONLY by AGENTS.md's default for a
 * new cron job: it mails administrators, and the dev Worker shares the `users` table with
 * production. The dev Worker never ages a row, so every surface reads a dispatched row older than
 * the deadline plus one tick as "did not report" (`REVIEW_OVERDUE_VIEW_MINUTES`).
 */
export async function sweepPublicationReviews(
  env: Bindings,
): Promise<PublicationReviewSweepResult> {
  const result: PublicationReviewSweepResult = {
    timedOut: 0,
    mailed: 0,
    errors: 0,
    skipped: false,
  };
  if (isNonProductionEnv(env)) {
    result.skipped = true;
    return result;
  }
  const db = env.DB;
  const overdue = `created_at < datetime('now', '-${PUBLICATION_REVIEW_DEADLINE_MINUTES} minutes')`;

  let rows: { id: number; request_id: number }[];
  try {
    rows = (
      await db
        .prepare(
          `SELECT id, request_id FROM publication_reviews
            WHERE state = 'dispatched' AND ${overdue} ORDER BY id LIMIT ?`,
        )
        .bind(SWEEP_LIMIT)
        .all<{ id: number; request_id: number }>()
    ).results;
  } catch (err) {
    result.errors++;
    console.error(`[publication-review-sweep] overdue query failed (${errClass(err)})`);
    return result;
  }
  for (const { id, request_id } of rows) {
    try {
      const moved = await db
        .prepare(
          `UPDATE publication_reviews SET state = 'unreported', decided_at = datetime('now')
            WHERE id = ? AND state = 'dispatched' AND ${overdue}`,
        )
        .bind(id)
        .run();
      if ((moved.meta.changes ?? 0) !== 1) continue;
      result.timedOut++;
      console.warn(`[publication-review-sweep] review ${id} did not report in time`);
      if ((await tryMail(env, request_id)) === "sent") result.mailed++;
    } catch (err) {
      result.errors++;
      console.error(`[publication-review-sweep] review ${id} failed (${errClass(err)})`);
    }
  }
  return result;
}
