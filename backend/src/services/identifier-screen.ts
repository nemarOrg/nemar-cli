/**
 * The identifier screen of a publication request (epic #1610, phase 4).
 *
 * When a depositor requests publication, the Worker hands the dataset to the
 * `run-identifier-screen` workflow on `nemarDatasets/.github`, which screens it
 * for identifying information (names, birth dates and record numbers in EDF/BDF
 * headers, identifying sidecar columns and keys, identifying file names) and
 * posts a report to `/webhooks/identifier-screen-result`. The admin's
 * publication-request email WAITS for that report and states it.
 *
 * Every way of not getting a report still reaches the admin, and says so:
 *   - the dispatch was impossible (no credential, callback secret, API base or
 *     repository): stored `error` / `dispatch-unconfigured`, mailed at once;
 *   - GitHub refused or the call failed: `error` / `dispatch-failed`, mailed at once;
 *   - the workflow posted an error, or a body outside the report contract:
 *     `error`, mailed when it lands;
 *   - the workflow never reported: GitHub answers a dispatch 204 even when no
 *     workflow listens for the event, so a 2xx proves nothing. The watchdog
 *     ({@link sweepIdentifierScreens}) turns a screen still pending after
 *     {@link SCREEN_REPORT_DEADLINE_MINUTES} into `unreported` and mails it.
 * Unknown is never healthy (ADR 0053): none of those is described, stored or
 * gated as clean (`screenGate` answers "rerun").
 *
 * **Nothing a workflow wrote reaches D1, an email, a log line or an API response
 * except through `parseScreenReport` and `describeScreen`**
 * (`shared/identifier-screen-report.ts`). The stored report is the parsed one,
 * re-serialized; a body that does not parse is replaced by a Worker-built error
 * report and only the parser's fixed error word is logged.
 *
 * The routes stay thin; this module owns the logic: starting a screen
 * ({@link startIdentifierScreen}), storing a result ({@link storeScreenResult}),
 * mailing it exactly once ({@link notifyAdminsOfScreen}) and the watchdog.
 */

import {
  REPORT_VERSION,
  type ScreenDescription,
  type ScreenError,
  type ScreenGate,
  type ScreenReport,
  type ScreenState,
  describeScreen,
  isScreenState,
  parseScreenReport,
  screenGate,
  stateOf,
} from "../../../shared/identifier-screen-report.js";
import type { Bindings } from "../types/bindings.js";
import { isSandboxDatasetId } from "./datasetId.js";
import {
  type PublicationScreenSection,
  getAdminEmailsForCategory,
  resolveEmailConfig,
  sendPublicationRequestEmail,
} from "./email.js";
import { isNonProductionEnv } from "./environment.js";
import { getDatasetsAuth } from "./github-auth.js";
import { signIdentifierScreenCallbackToken, triggerIdentifierScreenRun } from "./github.js";

/** A screen still pending this long after its dispatch has not reported, and is mailed as such. */
export const SCREEN_REPORT_DEADLINE_MINUTES = 40;

/** A stored result whose email has not gone out this long after it landed is retried by the watchdog. */
export const SCREEN_EMAIL_RETRY_AFTER_MINUTES = 5;

/**
 * Rows the watchdog handles per tick, in EACH of its two passes. Each row costs a
 * few D1 statements and one Resend call per admin; the tick it rides also runs
 * the auto-import, so the bound keeps a backlog from spending that tick's budget.
 */
export const SCREEN_SWEEP_LIMIT = 10;

/** Where the workflow posts its report, under API_BASE_URL. */
export const IDENTIFIER_SCREEN_CALLBACK_PATH = "/webhooks/identifier-screen-result";

/**
 * Sandbox (`xx`) datasets are not screened: the band is training and staging
 * exemplars, which never publish real data (ADR 0068's bands). The same rule
 * `isSandboxDatasetId` states, used by name so the exemption reads as a policy.
 */
export function isScreenExempt(datasetId: string): boolean {
  return isSandboxDatasetId(datasetId);
}

/** What an exempt dataset's email and status say about the screen. Worker-fixed words. */
export const EXEMPT_SCREEN_DESCRIPTION: ScreenDescription = {
  headline: "Identifier screen: not applicable (sandbox)",
  tone: "note",
  lines: ["Sandbox (xx) datasets never publish real data, so they are not screened."],
};

/**
 * Every column the screen owns, reset to NULL. Spliced into the UPDATE that
 * unblocks a re-request, and into every dispatch, so a stale result, nonce,
 * email claim or acknowledgment can never carry over to new content. A module
 * constant, never input.
 */
export const RESET_SCREEN_COLUMNS_SQL = `identifier_screen_status = NULL,
       identifier_screen_nonce = NULL,
       identifier_screen_dispatched_at = NULL,
       identifier_screen_at = NULL,
       identifier_screen_report = NULL,
       identifier_screen_emailed_at = NULL,
       identifier_screen_ack_by = NULL,
       identifier_screen_ack_reason = NULL,
       identifier_screen_ack_at = NULL`;

/** A report the Worker writes itself, for a screen that produced none. */
export function workerErrorReport(error: ScreenError): ScreenReport {
  return parseScreenReport({ version: REPORT_VERSION, scanner: null, head: null, error });
}

/** The stored status column, read without trusting it: anything that is not a state is null. */
export function readStoredState(raw: unknown): ScreenState | null {
  return isScreenState(raw) ? raw : null;
}

/**
 * The stored report column, re-validated on the way out. The Worker only ever
 * writes a parsed report, so a failure here means the row was edited by hand;
 * it reads as "no report", which every reader treats as not clear.
 */
export function readStoredReport(raw: unknown): ScreenReport | null {
  if (typeof raw !== "string") return null;
  try {
    return parseScreenReport(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** The screen as a status view shows it. */
export interface ScreenView {
  /** The stored state; `exempt` for a sandbox dataset; null when no screen was started. */
  state: ScreenState | "exempt" | null;
  headline: string;
  tone: ScreenDescription["tone"];
  lines: string[];
}

/** One reading of a row's screen, for every surface that shows it. */
export function screenView(datasetId: string, rawStatus: unknown, rawReport: unknown): ScreenView {
  if (isScreenExempt(datasetId)) return { state: "exempt", ...EXEMPT_SCREEN_DESCRIPTION };
  const state = readStoredState(rawStatus);
  const report = state === null ? null : readStoredReport(rawReport);
  const d = describeScreen(state, report);
  return { state, headline: d.headline, tone: d.tone, lines: d.lines };
}

/** The sentence that tells an admin what approval may do next, by gate. Worker-fixed words. */
function nextStep(gate: ScreenGate, datasetId: string): string | undefined {
  switch (gate) {
    case "clear":
      return undefined;
    case "blocks":
      return "Approval is refused while this stands. The request is blocked and the depositor has been told to fix the data and request publication again, which re-runs the screen.";
    case "acknowledge":
      return `Approval needs a recorded reason: nemar admin publish approve ${datasetId} --acknowledge-identifier-screen "<reason>"`;
    case "wait":
      return "The screen is still running; this request is mailed again when it finishes.";
    case "rerun":
      return `Approval is held until the screen is re-run: nemar admin publish screen ${datasetId}`;
  }
}

/** The email section for a row's screen. */
export function screenEmailSection(
  datasetId: string,
  rawStatus: unknown,
  rawReport: unknown,
): PublicationScreenSection {
  const view = screenView(datasetId, rawStatus, rawReport);
  if (view.state === "exempt") {
    return { headline: view.headline, tone: view.tone, lines: view.lines };
  }
  return {
    headline: view.headline,
    tone: view.tone,
    lines: view.lines,
    next: nextStep(screenGate(view.state), datasetId),
  };
}

// ============================================================================
// Mailing the admins
// ============================================================================

/** Send the publication-request email to the admins, with a screen section. */
export async function mailPublicationRequest(
  env: Bindings,
  args: {
    datasetId: string;
    username: string;
    anonymous: boolean;
    screen: PublicationScreenSection;
  },
): Promise<{ attempted: number; delivered: number }> {
  const adminEmails = await getAdminEmailsForCategory(env.DB, "publication_request", env);
  if (adminEmails.length === 0) return { attempted: 0, delivered: 0 };
  const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
  const outcome = await sendPublicationRequestEmail(
    adminEmails,
    args.datasetId,
    args.username,
    env.RESEND_API_KEY,
    fromEmail,
    replyTo,
    isDev,
    env,
    { anonymous: args.anonymous, screen: args.screen },
  );
  return { attempted: outcome.attempted, delivered: outcome.delivered };
}

export type NotifyOutcome = "sent" | "not-claimed" | "undelivered";

/**
 * Mail the admins the publication request with its screen result, at most once
 * per result, and never lose it.
 *
 * The claim comes FIRST: one conditional UPDATE stamps `identifier_screen_emailed_at`
 * only while it is NULL, the result is in (not pending, not NULL) and the request
 * is still active, so of two triggers racing for the same result (the callback
 * and the watchdog, or two watchdog ticks) exactly one sends. When no recipient
 * could be reached the claim is RELEASED, compare-and-set on the value this call
 * wrote so it can never release somebody else's, and the watchdog's second pass
 * retries it. A send that reached at least one admin keeps the claim.
 *
 * Exported for the route and the watchdog; it never throws.
 */
export async function notifyAdminsOfScreen(
  env: Bindings,
  requestId: number,
): Promise<NotifyOutcome> {
  const db = env.DB;
  let claim: {
    claim: string;
    dataset_id: string;
    requested_by: number;
    anonymous: number | null;
    identifier_screen_status: string | null;
    identifier_screen_report: string | null;
  } | null;
  try {
    claim = await db
      .prepare(
        `UPDATE publication_requests
            SET identifier_screen_emailed_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
          WHERE id = ?
            AND identifier_screen_emailed_at IS NULL
            AND identifier_screen_status IS NOT NULL
            AND identifier_screen_status != 'pending'
            AND status IN ('requested', 'blocked')
          RETURNING identifier_screen_emailed_at AS claim, dataset_id, requested_by, anonymous,
                    identifier_screen_status, identifier_screen_report`,
      )
      .bind(requestId)
      .first();
  } catch (err) {
    console.error(
      `[identifier-screen] could not claim the admin email for request ${requestId}: ${errorText(err)}`,
    );
    return "undelivered";
  }
  if (!claim) return "not-claimed";

  let delivered = 0;
  try {
    const user = await db
      .prepare("SELECT username FROM users WHERE id = ?")
      .bind(claim.requested_by)
      .first<{ username: string | null }>();
    const outcome = await mailPublicationRequest(env, {
      datasetId: claim.dataset_id,
      username: user?.username ?? `user ${claim.requested_by}`,
      anonymous: claim.anonymous === 1,
      screen: screenEmailSection(
        claim.dataset_id,
        claim.identifier_screen_status,
        claim.identifier_screen_report,
      ),
    });
    delivered = outcome.delivered;
  } catch (err) {
    console.error(
      `[identifier-screen] admin email for request ${requestId} failed: ${errorText(err)}`,
    );
  }
  if (delivered > 0) return "sent";

  try {
    await db
      .prepare(
        `UPDATE publication_requests SET identifier_screen_emailed_at = NULL
          WHERE id = ? AND identifier_screen_emailed_at = ?`,
      )
      .bind(requestId, claim.claim)
      .run();
  } catch (err) {
    // The claim stays, so this result is not retried. Loud, because it is the
    // one way a result can go unmailed.
    console.error(
      `[identifier-screen] RELEASE FAILED for request ${requestId}: its result was not mailed and will not be retried: ${errorText(err)}`,
    );
  }
  console.warn(
    `[identifier-screen] admin email for request ${requestId} reached nobody; released for retry`,
  );
  return "undelivered";
}

// ============================================================================
// Starting a screen
// ============================================================================

export type StartScreenOutcome =
  | { kind: "exempt" }
  | { kind: "dispatched" }
  | { kind: "failed"; error: "dispatch-unconfigured" | "dispatch-failed" };

/** Record a screen that could not be started. Replaces whatever the row held. */
async function recordDispatchFailure(
  db: D1Database,
  requestId: number,
  error: "dispatch-unconfigured" | "dispatch-failed",
  nonce: string | null,
): Promise<void> {
  const report = JSON.stringify(workerErrorReport(error));
  if (nonce === null) {
    await db
      .prepare(
        `UPDATE publication_requests
            SET ${RESET_SCREEN_COLUMNS_SQL},
                identifier_screen_status = 'error', identifier_screen_report = ?,
                identifier_screen_at = datetime('now')
          WHERE id = ?`,
      )
      .bind(report, requestId)
      .run();
    return;
  }
  // After a claim: only the pending screen THIS dispatch claimed is turned into
  // an error. A callback cannot have landed (the token never left the Worker),
  // but a concurrent re-run could have replaced the nonce.
  await db
    .prepare(
      `UPDATE publication_requests
          SET identifier_screen_status = 'error', identifier_screen_report = ?,
              identifier_screen_at = datetime('now'), identifier_screen_nonce = NULL
        WHERE id = ? AND identifier_screen_status = 'pending' AND identifier_screen_nonce = ?`,
    )
    .bind(report, requestId, nonce)
    .run();
}

/**
 * Claim a request's screen as pending with a fresh nonce, resetting every other
 * screen column. `guard` is an extra SQL condition (a module constant); the
 * claim is refused, and null returned, when it does not hold.
 */
async function claimPending(db: D1Database, requestId: number, guard = ""): Promise<string | null> {
  const nonce = crypto.randomUUID();
  const res = await db
    .prepare(
      `UPDATE publication_requests
          SET ${RESET_SCREEN_COLUMNS_SQL},
              identifier_screen_status = 'pending', identifier_screen_nonce = ?,
              identifier_screen_dispatched_at = datetime('now')
        WHERE id = ? ${guard}`,
    )
    .bind(nonce, requestId)
    .run();
  return (res.meta.changes ?? 0) === 1 ? nonce : null;
}

/**
 * Start the screen of one request. Does NOT mail: on `failed` the caller mails
 * at once ({@link notifyAdminsOfScreen}); on `dispatched` the mail waits for the
 * result; on `exempt` nothing is recorded and the caller mails as before.
 *
 * Deliberately not gated on PRESCREEN_ENABLED: the screen must not be silently
 * switchable off. A Worker without the secret records `dispatch-unconfigured`,
 * which the admin is told about and which the approval gate refuses.
 *
 * `guard` lets the admin re-run route refuse to replace a fresh pending run in
 * the same statement that claims it. Returns null when that guard refused.
 */
export async function startIdentifierScreen(
  env: Bindings,
  args: { requestId: number; datasetId: string; githubRepo: string | null },
  guard = "",
): Promise<StartScreenOutcome | null> {
  const { requestId, datasetId } = args;
  if (isScreenExempt(datasetId)) return { kind: "exempt" };
  const db = env.DB;

  // The workflow addresses the dataset's repository by its id; a row with no
  // repository has nothing to screen yet.
  const secret = env.PRESCREEN_CALLBACK_SECRET;
  const apiBase = env.API_BASE_URL;
  let pat: string | null = null;
  let unconfigured = !secret || !apiBase || !args.githubRepo;
  let failed = false;
  if (!unconfigured) {
    let auth: ReturnType<typeof getDatasetsAuth> | null = null;
    try {
      auth = getDatasetsAuth(env);
    } catch (err) {
      console.error(`[identifier-screen] no GitHub credential for ${datasetId}: ${errorText(err)}`);
      unconfigured = true;
    }
    if (auth) {
      try {
        pat = auth.kind === "app" ? await auth.getToken() : auth.token;
      } catch (err) {
        console.error(
          `[identifier-screen] could not mint a GitHub token for ${datasetId}: ${errorText(err)}`,
        );
        failed = true;
      }
    }
  }

  if (unconfigured || failed || !pat || !secret || !apiBase) {
    const error = unconfigured ? "dispatch-unconfigured" : "dispatch-failed";
    if (guard) {
      // The re-run route: claim first, so the guard decides, then fail it.
      const nonce = await claimPending(db, requestId, guard);
      if (nonce === null) return null;
      await recordDispatchFailure(db, requestId, error, nonce);
    } else {
      await recordDispatchFailure(db, requestId, error, null);
    }
    console.warn(`[identifier-screen] ${datasetId} request ${requestId}: ${error}`);
    return { kind: "failed", error };
  }

  const nonce = await claimPending(db, requestId, guard);
  if (nonce === null) return null;
  try {
    const token = await signIdentifierScreenCallbackToken({ datasetId, requestId, nonce }, secret);
    await triggerIdentifierScreenRun(
      datasetId,
      "main",
      requestId,
      token,
      `${apiBase}${IDENTIFIER_SCREEN_CALLBACK_PATH}`,
      pat,
    );
  } catch (err) {
    console.error(
      `[identifier-screen] dispatch failed for ${datasetId} request ${requestId}: ${errorText(err)}`,
    );
    await recordDispatchFailure(db, requestId, "dispatch-failed", nonce);
    return { kind: "failed", error: "dispatch-failed" };
  }
  console.log(`[identifier-screen] ${datasetId} request ${requestId}: dispatched`);
  return { kind: "dispatched" };
}

// ============================================================================
// Storing a result
// ============================================================================

export type StoreOutcome = { stored: true; state: ScreenState } | { stored: false };

/**
 * Store a verified callback's report on the row it was issued for.
 *
 * `body` is the untrusted `report` field. It goes through `parseScreenReport`
 * and nothing else: a body outside the contract is stored as the Worker's own
 * `workflow-failed` error report and only the parser's fixed word is logged. A
 * scan of a DIFFERENT dataset than the row's is the same failure.
 *
 * One conditional UPDATE (`status = 'pending'` and the nonce that verified) is
 * the write, so of a callback and a replay, or a callback and the watchdog,
 * exactly one stores. The nonce is cleared with it, so a replay finds nothing
 * to verify against.
 */
export async function storeScreenResult(
  env: Bindings,
  args: { requestId: number; datasetId: string; nonce: string; body: unknown },
): Promise<StoreOutcome> {
  const db = env.DB;
  let report: ScreenReport;
  try {
    report = parseScreenReport(args.body);
    if (report.scan && report.scan.id !== args.datasetId) {
      console.warn(
        `[identifier-screen] report for request ${args.requestId} describes another dataset; stored as workflow-failed`,
      );
      report = workerErrorReport("workflow-failed");
    }
  } catch (err) {
    // The parser's message is a fixed word that never quotes the input.
    const code = err instanceof Error && err.name === "ReportError" ? err.message : "unparseable";
    console.warn(
      `[identifier-screen] report for request ${args.requestId} is outside the contract (${code}); stored as workflow-failed`,
    );
    report = workerErrorReport("workflow-failed");
  }
  const state = stateOf(report);

  const res = await db
    .prepare(
      `UPDATE publication_requests
          SET identifier_screen_status = ?, identifier_screen_report = ?,
              identifier_screen_at = datetime('now'), identifier_screen_nonce = NULL
        WHERE id = ? AND identifier_screen_status = 'pending' AND identifier_screen_nonce = ?`,
    )
    .bind(state, JSON.stringify(report), args.requestId, args.nonce)
    .run();
  if ((res.meta.changes ?? 0) !== 1) return { stored: false };
  return { stored: true, state };
}

// ============================================================================
// The watchdog
// ============================================================================

export interface ScreenSweepResult {
  /** Pending screens past the deadline, now `unreported`. */
  timedOut: number;
  /** Results mailed by this run (timed out or retried). */
  emailed: number;
  /** Results whose mail reached nobody this run; released for the next. */
  undelivered: number;
  /** Rows whose handling threw. */
  errors: number;
  /** True when the run did nothing because this is not production. */
  skipped: boolean;
}

/** Pending screens past the deadline. NULL-safe: a pending row with no dispatch time is overdue too. */
export const OVERDUE_SCREENS_SQL = `SELECT id FROM publication_requests
   WHERE identifier_screen_status = 'pending'
     AND (identifier_screen_dispatched_at IS NULL
          OR identifier_screen_dispatched_at < datetime('now', '-${SCREEN_REPORT_DEADLINE_MINUTES} minutes'))
   ORDER BY id LIMIT ?`;

/** Stored results on active requests whose admin email never went out. */
export const UNMAILED_SCREENS_SQL = `SELECT id FROM publication_requests
   WHERE status IN ('requested', 'blocked')
     AND identifier_screen_status IS NOT NULL
     AND identifier_screen_status != 'pending'
     AND identifier_screen_emailed_at IS NULL
     AND COALESCE(identifier_screen_at, identifier_screen_dispatched_at, '')
         < datetime('now', '-${SCREEN_EMAIL_RETRY_AFTER_MINUTES} minutes')
   ORDER BY id LIMIT ?`;

/**
 * The watchdog, run on the 30-minute tick in PRODUCTION ONLY (the call site in
 * `scheduled()` is fenced, and so is this function, which answers `skipped`
 * outside production). It mails admins, and the dev worker shares the `users`
 * table with production (AGENTS.md); staging recovers a stuck screen with the
 * admin re-run route instead.
 *
 * Two passes, both D1 only (no GitHub call, so no infrastructure verdict to get
 * wrong), each bounded by {@link SCREEN_SWEEP_LIMIT}, each row independent:
 *   (a) a screen pending past {@link SCREEN_REPORT_DEADLINE_MINUTES} becomes
 *       `unreported` with the Worker's `no-report-in-time` report, by a
 *       conditional UPDATE that a late callback racing it can win instead, and
 *       is mailed;
 *   (b) a result on an active request whose mail never went out (the send
 *       reached nobody and was released, or the Worker died between storing and
 *       sending) is mailed, once it is {@link SCREEN_EMAIL_RETRY_AFTER_MINUTES}
 *       old so the path that stored it has had its chance.
 */
export async function sweepIdentifierScreens(env: Bindings): Promise<ScreenSweepResult> {
  const result: ScreenSweepResult = {
    timedOut: 0,
    emailed: 0,
    undelivered: 0,
    errors: 0,
    skipped: false,
  };
  if (isNonProductionEnv(env)) {
    result.skipped = true;
    return result;
  }
  const db = env.DB;
  const count = (o: NotifyOutcome) => {
    if (o === "sent") result.emailed++;
    else if (o === "undelivered") result.undelivered++;
  };

  let overdue: { id: number }[] = [];
  try {
    overdue = (await db.prepare(OVERDUE_SCREENS_SQL).bind(SCREEN_SWEEP_LIMIT).all<{ id: number }>())
      .results;
  } catch (err) {
    result.errors++;
    console.error(`[identifier-screen-sweep] overdue query failed: ${errorText(err)}`);
  }
  const unreported = JSON.stringify(workerErrorReport("no-report-in-time"));
  for (const row of overdue) {
    try {
      const res = await db
        .prepare(
          `UPDATE publication_requests
              SET identifier_screen_status = 'unreported', identifier_screen_report = ?,
                  identifier_screen_at = datetime('now'), identifier_screen_nonce = NULL
            WHERE id = ? AND identifier_screen_status = 'pending'
              AND (identifier_screen_dispatched_at IS NULL
                   OR identifier_screen_dispatched_at < datetime('now', '-${SCREEN_REPORT_DEADLINE_MINUTES} minutes'))`,
        )
        .bind(unreported, row.id)
        .run();
      if ((res.meta.changes ?? 0) !== 1) continue;
      result.timedOut++;
      count(await notifyAdminsOfScreen(env, row.id));
    } catch (err) {
      result.errors++;
      console.error(`[identifier-screen-sweep] request ${row.id}: ${errorText(err)}`);
    }
  }

  let unmailed: { id: number }[] = [];
  try {
    unmailed = (
      await db.prepare(UNMAILED_SCREENS_SQL).bind(SCREEN_SWEEP_LIMIT).all<{ id: number }>()
    ).results;
  } catch (err) {
    result.errors++;
    console.error(`[identifier-screen-sweep] unmailed query failed: ${errorText(err)}`);
  }
  for (const row of unmailed) {
    try {
      count(await notifyAdminsOfScreen(env, row.id));
    } catch (err) {
      result.errors++;
      console.error(`[identifier-screen-sweep] request ${row.id}: ${errorText(err)}`);
    }
  }
  return result;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
