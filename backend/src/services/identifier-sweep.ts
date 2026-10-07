/**
 * The scheduled identifier sweep (epic #1610, phase 5, ADR 0087).
 *
 * Published datasets are screened again on a cycle, with the same workflow and
 * the same report contract as a publication request (ADR 0086): the tick
 * dispatches `run-identifier-screen` on `nemarDatasets/.github` for a few
 * datasets at a time, the workflow reads every header and posts a report to
 * `/webhooks/identifier-sweep-result`, and the Worker stores what
 * `parseScreenReport` accepted. The runner does the reading; the Worker only
 * dispatches, so the sweep never comes near a Worker's subrequest limit.
 *
 * **It reports and never repairs** (ADR 0067). It writes only `sweep_stamps`
 * (ADR 0035), and the weekly report's own `audit_log` rows. It edits no
 * dataset, files no GitHub issue (`nemarDatasets` is public-facing), and mails
 * no depositor; the weekly admin report is its one mail
 * (`identifier-sweep-report.ts` builds it, {@link sendIdentifierSweepWeeklyReport}
 * sends it).
 *
 * **A verdict comes only from a scan.** The stamps keep the last verdict apart
 * from the last attempt (see `sweep-stamps.ts`). A screen that could not start,
 * failed, never reported, or posted a body outside the contract moves the
 * attempt and never the verdict, so an infrastructure failure can neither stand
 * in for a screen nor make an old one look fresh (ADR 0053, ADR 0067).
 *
 * **The cadence never depends on the verdict.** The Actions logs of
 * `nemarDatasets/.github` are public and name the dataset a run screens, so a
 * dataset re-screened more often because it was flagged would be pointed out to
 * anyone reading the run list. Only verdict-free facts move a dataset forward:
 * no verdict yet, the verdict's age, a newer version (already public), a failed
 * attempt (already visible in its own run), an administrator's request.
 *
 * **Production only.** It dispatches against the `nemarDatasets` org that the
 * dev worker shares, and its report mails admins, so the tick and the weekly
 * report refuse outside production on their own, as well as at the call site in
 * `scheduled()` (AGENTS.md: a new cron job is production-only by default).
 */

import {
  DATASET_STATUSES,
  type DatasetStatus,
  type ScreenError,
  type ScreenReport,
  parseScreenReport,
} from "../../../shared/identifier-screen-report.js";
import { auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import {
  getAdminEmailsForCategory,
  resolveEmailConfig,
  sendIdentifierSweepReportEmail,
} from "./email.js";
import { isNonProductionEnv } from "./environment.js";
import { getDatasetsAuth } from "./github-auth.js";
import { signIdentifierSweepCallbackToken, triggerIdentifierScreenRun } from "./github.js";
import { SCREEN_REPORT_DEADLINE_MINUTES, workerErrorReport } from "./identifier-screen.js";
import {
  type IdentifierSweepRow,
  type IdentifierWeekFacts,
  buildIdentifierWeek,
  renderIdentifierWeek,
  reportWindow,
  unknownIdentifierWeek,
} from "./identifier-sweep-report.js";
import {
  IDENTIFIER_SWEEP_ATTEMPTED_AT_PATH,
  IDENTIFIER_SWEEP_ATTEMPT_ERROR_PATH,
  IDENTIFIER_SWEEP_ATTEMPT_PATH,
  IDENTIFIER_SWEEP_ATTEMPT_VERSION_PATH,
  IDENTIFIER_SWEEP_CHECKED_AT_PATH,
  IDENTIFIER_SWEEP_NONCE_PATH,
  IDENTIFIER_SWEEP_REPORT_PATH,
  IDENTIFIER_SWEEP_REQUESTED_AT_PATH,
  IDENTIFIER_SWEEP_STATUS_PATH,
  IDENTIFIER_SWEEP_VERSION_PATH,
} from "./sweep-stamps.js";

// ============================================================================
// The numbers (ADR 0087)
// ============================================================================

/** Where the workflow posts a sweep screen's report, under API_BASE_URL. */
export const IDENTIFIER_SWEEP_CALLBACK_PATH = "/webhooks/identifier-sweep-result";

/** A verdict this old makes the dataset a candidate again. */
export const IDENTIFIER_SWEEP_REFRESH_DAYS = 21;

/**
 * A verdict older than this no longer counts: the dataset is `unchecked`. Longer
 * than the refresh, so a dataset that comes due has a week of retries before it
 * falls out of the cycle.
 */
export const IDENTIFIER_SWEEP_CYCLE_DAYS = 28;

/**
 * No dataset is dispatched again within this many hours of its last attempt,
 * whatever came of it. It is the retry backoff for a screen that failed, and it
 * also keeps a screen in flight from being dispatched twice.
 */
export const IDENTIFIER_SWEEP_RETRY_HOURS = 6;

/** Dispatches per tick, at most (the tick is every 30 minutes). */
export const IDENTIFIER_SWEEP_SLICE = 3;

/** No dispatch while this many sweep screens are in flight. */
export const IDENTIFIER_SWEEP_MAX_IN_FLIGHT = 6;

/**
 * A sweep screen still pending this long after its dispatch has not reported.
 * The same workflow as a publication screen, so the same deadline.
 */
export const IDENTIFIER_SWEEP_DEADLINE_MINUTES = SCREEN_REPORT_DEADLINE_MINUTES;

// ============================================================================
// SQL
// ============================================================================

const stamp = (path: string, alias = "d") =>
  `json_extract(${alias ? `${alias}.` : ""}sweep_stamps, '${path}')`;

/**
 * What the sweep screens: an active, public, not withdrawn dataset that is not a
 * well-formed sandbox id. `xx` datasets never publish real data (ADR 0068) and
 * are exempt from the publication screen for the same reason (`isScreenExempt`);
 * the GLOB is that rule, so a malformed id that merely starts with the letters
 * is screened. `on` mirrors are screened like any deposit.
 */
function sweepScopeSql(alias = "d"): string {
  const a = alias ? `${alias}.` : "";
  return `${a}status = 'active' AND ${a}visibility = 'public' AND ${a}withdrawn_at IS NULL
     AND NOT (${a}dataset_id GLOB 'xx[0-9][0-9][0-9][0-9][0-9][0-9]')`;
}

/** The dataset's latest version, by the newest `dataset_versions` row (ties broken by id). */
const LATEST_VERSION_SQL = `(SELECT dv.version FROM dataset_versions dv
      WHERE dv.dataset_id = d.dataset_id
      ORDER BY dv.created_at DESC, dv.id DESC LIMIT 1)`;

const STATUS_LIST = DATASET_STATUSES.map((s) => `'${s}'`).join(", ");

/**
 * When a dataset may be dispatched: never attempted, or not attempted within the
 * backoff, or asked for by an administrator and not in flight. NULL-safe: an
 * absent attempt time is "never".
 */
function backoffClearSql(alias = "d"): string {
  return `(${stamp(IDENTIFIER_SWEEP_ATTEMPTED_AT_PATH, alias)} IS NULL
       OR ${stamp(IDENTIFIER_SWEEP_ATTEMPTED_AT_PATH, alias)} < datetime('now', '-${IDENTIFIER_SWEEP_RETRY_HOURS} hours')
       OR (${stamp(IDENTIFIER_SWEEP_REQUESTED_AT_PATH, alias)} IS NOT NULL
           AND COALESCE(${stamp(IDENTIFIER_SWEEP_ATTEMPT_PATH, alias)}, '') != 'pending'))`;
}

/**
 * Why a dataset is due, verdict-free (see the module header): an administrator
 * asked; there is no readable verdict; the verdict is older than the refresh; or
 * it was of an older version than the latest. Never "because it was flagged".
 * NULL-safe throughout: a missing version on either side compares as ''.
 */
const DUE_SQL = `(${stamp(IDENTIFIER_SWEEP_REQUESTED_AT_PATH)} IS NOT NULL
       OR ${stamp(IDENTIFIER_SWEEP_STATUS_PATH)} IS NULL
       OR ${stamp(IDENTIFIER_SWEEP_STATUS_PATH)} NOT IN (${STATUS_LIST})
       OR ${stamp(IDENTIFIER_SWEEP_CHECKED_AT_PATH)} IS NULL
       OR ${stamp(IDENTIFIER_SWEEP_CHECKED_AT_PATH)} < datetime('now', '-${IDENTIFIER_SWEEP_REFRESH_DAYS} days')
       OR COALESCE(${stamp(IDENTIFIER_SWEEP_VERSION_PATH)}, '') != COALESCE(${LATEST_VERSION_SQL}, ''))`;

/**
 * The next datasets to dispatch. Ordered requested first, then never attempted,
 * then a newer version, then the oldest attempt: a dataset that fails every
 * time costs one slot per backoff window and never holds the front of the queue.
 */
export const IDENTIFIER_SWEEP_CANDIDATES_SQL = `SELECT d.dataset_id, d.github_repo,
          ${LATEST_VERSION_SQL} AS latest_version
     FROM datasets d
    WHERE ${sweepScopeSql()}
      AND ${backoffClearSql()}
      AND ${DUE_SQL}
    ORDER BY ${stamp(IDENTIFIER_SWEEP_REQUESTED_AT_PATH)} IS NULL,
             ${stamp(IDENTIFIER_SWEEP_ATTEMPTED_AT_PATH)} IS NOT NULL,
             COALESCE(${stamp(IDENTIFIER_SWEEP_VERSION_PATH)}, '') = COALESCE(${LATEST_VERSION_SQL}, ''),
             ${stamp(IDENTIFIER_SWEEP_ATTEMPTED_AT_PATH)},
             d.dataset_id
    LIMIT ?`;

/** How many datasets the queue would take now: the candidate predicate, counted. */
export const IDENTIFIER_SWEEP_DUE_COUNT_SQL = `SELECT COUNT(*) AS n
     FROM datasets d
    WHERE ${sweepScopeSql()}
      AND ${backoffClearSql()}
      AND ${DUE_SQL}`;

/** Sweep screens in flight, in or out of scope (a dataset made private mid-run still holds a runner). */
export const IDENTIFIER_SWEEP_IN_FLIGHT_SQL = `SELECT COUNT(*) AS n FROM datasets d
    WHERE ${stamp(IDENTIFIER_SWEEP_ATTEMPT_PATH)} = 'pending'`;

/**
 * A screen pending past the deadline becomes `unreported`. NULL-safe: a pending
 * attempt with no dispatch time is overdue. The nonce is KEPT, so a report that
 * arrives later is still the run's own answer. The verdict is untouched.
 */
export const IDENTIFIER_SWEEP_UNREPORTED_SQL = `UPDATE datasets
      SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'),
            '${IDENTIFIER_SWEEP_ATTEMPT_PATH}', 'unreported',
            '${IDENTIFIER_SWEEP_ATTEMPT_ERROR_PATH}', 'no-report-in-time')
    WHERE ${stamp(IDENTIFIER_SWEEP_ATTEMPT_PATH, "")} = 'pending'
      AND (${stamp(IDENTIFIER_SWEEP_ATTEMPTED_AT_PATH, "")} IS NULL
           OR ${stamp(IDENTIFIER_SWEEP_ATTEMPTED_AT_PATH, "")} < datetime('now', '-${IDENTIFIER_SWEEP_DEADLINE_MINUTES} minutes'))`;

/**
 * Claim one dataset for a dispatch: the attempt becomes `pending` with a fresh
 * nonce, the dispatch time and the version it is for, and a request it answers
 * is cleared. Conditional on the scope and the backoff, so a dataset that left
 * scope or was claimed by a concurrent tick is not dispatched. Bind order:
 * attempt version, nonce, dataset id.
 */
export const IDENTIFIER_SWEEP_CLAIM_SQL = `UPDATE datasets
      SET sweep_stamps = json_remove(
            json_set(COALESCE(sweep_stamps, '{}'),
              '${IDENTIFIER_SWEEP_ATTEMPT_PATH}', 'pending',
              '${IDENTIFIER_SWEEP_ATTEMPTED_AT_PATH}', datetime('now'),
              '${IDENTIFIER_SWEEP_ATTEMPT_VERSION_PATH}', ?,
              '${IDENTIFIER_SWEEP_NONCE_PATH}', ?),
            '${IDENTIFIER_SWEEP_ATTEMPT_ERROR_PATH}',
            '${IDENTIFIER_SWEEP_REQUESTED_AT_PATH}')
    WHERE dataset_id = ?
      AND ${sweepScopeSql("")}
      AND ${backoffClearSql("")}`;

/**
 * An attempt that produced no scan: the error word is recorded and the nonce
 * dropped; the verdict is untouched. Compare-and-set on the nonce and an
 * attempt still waiting, so it can only close the attempt it is about. Bind
 * order: error word, dataset id, nonce.
 */
export const IDENTIFIER_SWEEP_ATTEMPT_FAILED_SQL = `UPDATE datasets
      SET sweep_stamps = json_remove(
            json_set(COALESCE(sweep_stamps, '{}'),
              '${IDENTIFIER_SWEEP_ATTEMPT_PATH}', 'error',
              '${IDENTIFIER_SWEEP_ATTEMPT_ERROR_PATH}', ?),
            '${IDENTIFIER_SWEEP_NONCE_PATH}')
    WHERE dataset_id = ?
      AND ${stamp(IDENTIFIER_SWEEP_NONCE_PATH, "")} = ?
      AND ${stamp(IDENTIFIER_SWEEP_ATTEMPT_PATH, "")} IN ('pending', 'unreported')`;

/**
 * A scan landed: it becomes the verdict, with the version its screen was
 * DISPATCHED for (read from the attempt, not from the catalog now), and the
 * attempt is closed. The one conditional UPDATE that stores, so of a callback,
 * a retry of it and a late duplicate exactly one writes. Bind order: status,
 * report JSON, dataset id, nonce.
 */
export const IDENTIFIER_SWEEP_STORE_SQL = `UPDATE datasets
      SET sweep_stamps = json_remove(
            json_set(COALESCE(sweep_stamps, '{}'),
              '${IDENTIFIER_SWEEP_STATUS_PATH}', ?,
              '${IDENTIFIER_SWEEP_REPORT_PATH}', json(?),
              '${IDENTIFIER_SWEEP_CHECKED_AT_PATH}', datetime('now'),
              '${IDENTIFIER_SWEEP_VERSION_PATH}', ${stamp(IDENTIFIER_SWEEP_ATTEMPT_VERSION_PATH, "")},
              '${IDENTIFIER_SWEEP_ATTEMPT_PATH}', 'reported'),
            '${IDENTIFIER_SWEEP_NONCE_PATH}',
            '${IDENTIFIER_SWEEP_ATTEMPT_ERROR_PATH}')
    WHERE dataset_id = ?
      AND ${stamp(IDENTIFIER_SWEEP_NONCE_PATH, "")} = ?
      AND ${stamp(IDENTIFIER_SWEEP_ATTEMPT_PATH, "")} IN ('pending', 'unreported')`;

/** The nonce of an attempt still waiting for its report, for the callback to verify against. */
export const IDENTIFIER_SWEEP_NONCE_SQL = `SELECT ${stamp(IDENTIFIER_SWEEP_NONCE_PATH)} AS nonce
     FROM datasets d
    WHERE d.dataset_id = ?
      AND ${stamp(IDENTIFIER_SWEEP_ATTEMPT_PATH)} IN ('pending', 'unreported')
    LIMIT 1`;

/** An administrator's request to screen one dataset again. */
export const IDENTIFIER_SWEEP_REQUEST_SQL = `UPDATE datasets
      SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'),
            '${IDENTIFIER_SWEEP_REQUESTED_AT_PATH}', datetime('now'))
    WHERE dataset_id = ? AND ${sweepScopeSql("")}`;

/** Every dataset in scope with its stamps, for the weekly report. */
export const IDENTIFIER_SWEEP_ROWS_SQL = `SELECT d.dataset_id,
          ${LATEST_VERSION_SQL} AS latest_version,
          ${stamp(IDENTIFIER_SWEEP_STATUS_PATH)} AS status,
          ${stamp(IDENTIFIER_SWEEP_CHECKED_AT_PATH)} AS checked_at,
          ${stamp(IDENTIFIER_SWEEP_VERSION_PATH)} AS version,
          -- json_extract gives an object back as its JSON text, and anything else
          -- as itself, which the reader refuses; json() here would make one bad
          -- row an error for the whole query, and blind the week.
          ${stamp(IDENTIFIER_SWEEP_REPORT_PATH)} AS report,
          ${stamp(IDENTIFIER_SWEEP_ATTEMPT_PATH)} AS attempt,
          ${stamp(IDENTIFIER_SWEEP_ATTEMPT_ERROR_PATH)} AS attempt_error,
          ${stamp(IDENTIFIER_SWEEP_ATTEMPTED_AT_PATH)} AS attempted_at,
          ${stamp(IDENTIFIER_SWEEP_REQUESTED_AT_PATH)} AS requested_at
     FROM datasets d
    WHERE ${sweepScopeSql()}
    ORDER BY d.dataset_id`;

// ============================================================================
// The tick
// ============================================================================

export interface IdentifierSweepTickResult {
  /** True when the tick did nothing because this is not production. */
  skipped: boolean;
  /** Screens marked `unreported` this tick; null when that statement failed. */
  timedOut: number | null;
  /** Screens in flight before dispatching; null when they could not be counted (nothing is dispatched then). */
  inFlight: number | null;
  /** Screens GitHub accepted this tick. */
  dispatched: number;
  /** Claimed attempts that could not be started, with the word recorded on each. */
  failed: { dataset_id: string; error: "dispatch-unconfigured" | "dispatch-failed" }[];
  /** Statement-level failures, as fixed text. */
  errors: string[];
}

interface Candidate {
  dataset_id: string;
  github_repo: string | null;
  latest_version: string | null;
}

type DispatchCredential =
  | { ok: true; token: string; secret: string; apiBase: string }
  | { ok: false; error: "dispatch-unconfigured" | "dispatch-failed" };

/**
 * What a dispatch needs from the Worker: the callback secret, the API base the
 * workflow reports to, and a GitHub token for the central repository.
 * `dispatch-unconfigured` is a Worker missing one of the three (the same word
 * the publication screen records); `dispatch-failed` is a credential that could
 * not produce a token this time. Never throws.
 */
async function resolveDispatchCredential(env: Bindings): Promise<DispatchCredential> {
  const secret = env.PRESCREEN_CALLBACK_SECRET;
  const apiBase = env.API_BASE_URL;
  if (!secret || !apiBase) return { ok: false, error: "dispatch-unconfigured" };
  let auth: ReturnType<typeof getDatasetsAuth>;
  try {
    auth = getDatasetsAuth(env);
  } catch (err) {
    console.error(`[identifier-sweep] no GitHub credential: ${errorText(err)}`);
    return { ok: false, error: "dispatch-unconfigured" };
  }
  try {
    const token = auth.kind === "app" ? await auth.getToken() : auth.token;
    if (!token) return { ok: false, error: "dispatch-failed" };
    return { ok: true, token, secret, apiBase };
  } catch (err) {
    console.error(`[identifier-sweep] could not mint a GitHub token: ${errorText(err)}`);
    return { ok: false, error: "dispatch-failed" };
  }
}

/**
 * One tick of the sweep, on the 30-minute schedule, PRODUCTION ONLY.
 *
 * 1. A screen pending past the deadline becomes `unreported`.
 * 2. Screens in flight are counted; if they cannot be, nothing is dispatched
 *    (fail closed: an unknown count is not room to spare).
 * 3. Up to {@link IDENTIFIER_SWEEP_SLICE} candidates, and never more than
 *    {@link IDENTIFIER_SWEEP_MAX_IN_FLIGHT} in flight, are claimed and
 *    dispatched. One token is minted for the tick, lazily; a claim that cannot
 *    be started records why on its own attempt.
 *
 * At most one token mint and {@link IDENTIFIER_SWEEP_SLICE} dispatch calls per
 * tick, and about twenty D1 statements. Never throws.
 */
export async function runIdentifierSweepTick(env: Bindings): Promise<IdentifierSweepTickResult> {
  const result: IdentifierSweepTickResult = {
    skipped: false,
    timedOut: null,
    inFlight: null,
    dispatched: 0,
    failed: [],
    errors: [],
  };
  if (isNonProductionEnv(env)) {
    result.skipped = true;
    return result;
  }
  const db = env.DB;

  try {
    const res = await db.prepare(IDENTIFIER_SWEEP_UNREPORTED_SQL).run();
    result.timedOut = res.meta.changes ?? 0;
  } catch (err) {
    result.errors.push(`unreported pass failed: ${errorText(err)}`);
  }

  try {
    const row = await db.prepare(IDENTIFIER_SWEEP_IN_FLIGHT_SQL).first<{ n: number }>();
    result.inFlight = typeof row?.n === "number" ? row.n : null;
  } catch (err) {
    result.errors.push(`in-flight count failed: ${errorText(err)}`);
  }
  if (result.inFlight === null) return result;

  const slots = Math.min(IDENTIFIER_SWEEP_SLICE, IDENTIFIER_SWEEP_MAX_IN_FLIGHT - result.inFlight);
  if (slots <= 0) return result;

  let candidates: Candidate[];
  try {
    candidates = (await db.prepare(IDENTIFIER_SWEEP_CANDIDATES_SQL).bind(slots).all<Candidate>())
      .results;
  } catch (err) {
    result.errors.push(`candidate query failed: ${errorText(err)}`);
    return result;
  }

  // One credential for the tick, resolved on first use and shared by every
  // dispatch in it.
  let credential: Promise<DispatchCredential> | null = null;

  for (const c of candidates) {
    const nonce = crypto.randomUUID();
    let claimed = false;
    try {
      const res = await db
        .prepare(IDENTIFIER_SWEEP_CLAIM_SQL)
        .bind(c.latest_version ?? null, nonce, c.dataset_id)
        .run();
      claimed = (res.meta.changes ?? 0) === 1;
    } catch (err) {
      result.errors.push(`claim of ${c.dataset_id} failed: ${errorText(err)}`);
      continue;
    }
    if (!claimed) continue;

    let failure: "dispatch-unconfigured" | "dispatch-failed";
    // The workflow addresses the repository by the dataset id, and a row with
    // no repository has nothing to clone.
    if (c.github_repo && credential === null) credential = resolveDispatchCredential(env);
    const cred: DispatchCredential =
      c.github_repo && credential !== null
        ? await credential
        : { ok: false, error: "dispatch-unconfigured" };
    if (!cred.ok) {
      failure = cred.error;
    } else {
      try {
        const callbackToken = await signIdentifierSweepCallbackToken(
          { datasetId: c.dataset_id, nonce },
          cred.secret,
        );
        await triggerIdentifierScreenRun(
          c.dataset_id,
          "main",
          0,
          callbackToken,
          `${cred.apiBase}${IDENTIFIER_SWEEP_CALLBACK_PATH}`,
          cred.token,
        );
        result.dispatched++;
        continue;
      } catch (err) {
        console.error(`[identifier-sweep] dispatch of ${c.dataset_id} failed: ${errorText(err)}`);
        failure = "dispatch-failed";
      }
    }

    result.failed.push({ dataset_id: c.dataset_id, error: failure });
    try {
      await db
        .prepare(IDENTIFIER_SWEEP_ATTEMPT_FAILED_SQL)
        .bind(failure, c.dataset_id, nonce)
        .run();
    } catch (err) {
      // The attempt stays `pending`, and the unreported pass closes it after the
      // deadline. Nothing reads it as a verdict meanwhile.
      result.errors.push(
        `recording the failed dispatch of ${c.dataset_id} failed: ${errorText(err)}`,
      );
    }
  }
  return result;
}

// ============================================================================
// Storing a result
// ============================================================================

export type SweepStoreOutcome =
  | { stored: true; kind: "verdict"; status: DatasetStatus }
  | { stored: true; kind: "error"; error: ScreenError }
  | { stored: false };

/**
 * Store a verified callback's report on the dataset it was issued for.
 *
 * `body` is untrusted. It reaches the row only through `parseScreenReport`: a
 * body outside the contract, or a scan of another dataset, is recorded as the
 * attempt's `workflow-failed` and only the parser's fixed word is logged. A
 * scan becomes the verdict; an error report (the workflow's own word) closes
 * the attempt and leaves the verdict where it was.
 *
 * Mails nobody. The weekly report is the sweep's only mail.
 */
export async function storeSweepResult(
  env: Bindings,
  args: { datasetId: string; nonce: string; body: unknown },
): Promise<SweepStoreOutcome> {
  let report: ScreenReport;
  try {
    report = parseScreenReport(args.body);
    if (report.scan && report.scan.id !== args.datasetId) {
      console.warn(
        `[identifier-sweep] report for ${args.datasetId} describes another dataset; recorded as workflow-failed`,
      );
      report = workerErrorReport("workflow-failed");
    }
  } catch (err) {
    const code = err instanceof Error && err.name === "ReportError" ? err.message : "unparseable";
    console.warn(
      `[identifier-sweep] report for ${args.datasetId} is outside the contract (${code}); recorded as workflow-failed`,
    );
    report = workerErrorReport("workflow-failed");
  }

  const db = env.DB;
  if (report.scan) {
    const status = report.scan.status;
    const res = await db
      .prepare(IDENTIFIER_SWEEP_STORE_SQL)
      .bind(status, JSON.stringify(report), args.datasetId, args.nonce)
      .run();
    if ((res.meta.changes ?? 0) !== 1) return { stored: false };
    return { stored: true, kind: "verdict", status };
  }
  const error = report.error as ScreenError;
  const res = await db
    .prepare(IDENTIFIER_SWEEP_ATTEMPT_FAILED_SQL)
    .bind(error, args.datasetId, args.nonce)
    .run();
  if ((res.meta.changes ?? 0) !== 1) return { stored: false };
  return { stored: true, kind: "error", error };
}

// ============================================================================
// An administrator's request
// ============================================================================

export type RescreenOutcome = "requested" | "not-found" | "out-of-scope";

/**
 * Ask for one dataset to be screened again: it goes to the front of the queue
 * and the next production tick dispatches it (unless a screen of it is in
 * flight). A D1 write only, so it is safe on any worker; only production
 * dispatches. Audited.
 */
export async function requestRescreen(
  env: Bindings,
  args: { datasetId: string; adminUserId: number },
): Promise<RescreenOutcome> {
  const db = env.DB;
  const res = await db.prepare(IDENTIFIER_SWEEP_REQUEST_SQL).bind(args.datasetId).run();
  if ((res.meta.changes ?? 0) !== 1) {
    const exists = await db
      .prepare("SELECT 1 AS ok FROM datasets WHERE dataset_id = ?")
      .bind(args.datasetId)
      .first<{ ok: number }>();
    return exists ? "out-of-scope" : "not-found";
  }
  try {
    await auditLogStatement(db, {
      userId: args.adminUserId,
      action: "identifier_sweep_rescreen_requested",
      resourceType: "dataset",
      resourceId: args.datasetId,
      details: null,
    }).run();
  } catch (err) {
    console.error(
      `[identifier-sweep] audit write for the rescreen of ${args.datasetId} failed: ${errorText(err)}`,
    );
  }
  return "requested";
}

// ============================================================================
// The weekly report
// ============================================================================

/** The audit actions the weekly report's once-per-week record uses. */
export const IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION = "identifier_sweep_report_claim";
export const IDENTIFIER_SWEEP_REPORT_SENT_ACTION = "identifier_sweep_report_sent";

/**
 * A claim on a week's report holds this long: a send in progress is not
 * started twice, and a send that reached nobody is tried again after it.
 */
export const IDENTIFIER_SWEEP_REPORT_LEASE_MINUTES = 120;

/**
 * Claims per week, at most. The cap is what keeps a broken record (a delivered
 * mail whose `sent` row could not be written) from becoming a mail every lease,
 * all week: the trade ADR 0054 makes, in the same direction.
 */
export const IDENTIFIER_SWEEP_REPORT_MAX_CLAIMS = 12;

/**
 * Claim a week's report, atomically: one INSERT that lands only when the week
 * has not been sent, no claim is live, and the cap is not reached. Fails CLOSED:
 * a statement that errors claims nothing, so nothing is sent (ADR 0054).
 * Bind: the week label, four times.
 */
export const IDENTIFIER_SWEEP_REPORT_CLAIM_SQL = `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
   SELECT NULL, '${IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION}', 'identifier_sweep', ?, NULL
    WHERE NOT EXISTS (SELECT 1 FROM audit_log
                       WHERE action = '${IDENTIFIER_SWEEP_REPORT_SENT_ACTION}'
                         AND resource_type = 'identifier_sweep' AND resource_id = ?)
      AND NOT EXISTS (SELECT 1 FROM audit_log
                       WHERE action = '${IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION}'
                         AND resource_type = 'identifier_sweep' AND resource_id = ?
                         AND timestamp >= datetime('now', '-${IDENTIFIER_SWEEP_REPORT_LEASE_MINUTES} minutes'))
      AND (SELECT COUNT(*) FROM audit_log
            WHERE action = '${IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION}'
              AND resource_type = 'identifier_sweep' AND resource_id = ?) < ${IDENTIFIER_SWEEP_REPORT_MAX_CLAIMS}`;

/**
 * Gather the week's facts. Never throws: a read that fails makes what it
 * would have answered `unknown`, and says so in `errors` (ADR 0054).
 */
export async function gatherIdentifierWeek(
  db: D1Database,
  now: Date,
): Promise<IdentifierWeekFacts> {
  let rows: IdentifierSweepRow[] | null = null;
  const errors: string[] = [];
  try {
    rows = (await db.prepare(IDENTIFIER_SWEEP_ROWS_SQL).all<IdentifierSweepRow>()).results;
  } catch (err) {
    errors.push("the sweep's records could not be read");
    console.error(`[identifier-sweep] rows query failed: ${errorText(err)}`);
  }
  let due: number | null = null;
  try {
    const row = await db.prepare(IDENTIFIER_SWEEP_DUE_COUNT_SQL).first<{ n: number }>();
    due = typeof row?.n === "number" ? row.n : null;
    if (due === null) errors.push("the queue could not be counted");
  } catch (err) {
    errors.push("the queue could not be counted");
    console.error(`[identifier-sweep] due count failed: ${errorText(err)}`);
  }
  if (rows === null) return unknownIdentifierWeek(now, due, errors, IDENTIFIER_SWEEP_CYCLE_DAYS);
  return buildIdentifierWeek(rows, { now, due, errors, cycleDays: IDENTIFIER_SWEEP_CYCLE_DAYS });
}

export interface SweepWeeklyOutcome {
  week: string;
  /** False when another tick holds the claim or the week was already sent. */
  claimed: boolean;
  attempted: number;
  delivered: number;
  attention: boolean | null;
}

/**
 * Send the weekly report for the week before `now`, once, PRODUCTION ONLY.
 *
 * It goes whether or not anything is wrong: a report that only arrives on
 * breakage cannot tell a healthy week from a broken reporter (ADR 0054). The
 * claim is reserved before the facts are gathered; a send that reached nobody
 * leaves no `sent` row, so a later tick tries again once the lease is up, up to
 * the cap. Returns null outside production (the mail fence in
 * `getAdminEmailsForCategory` would also refuse; this refuses first, so not even
 * the claim is written).
 */
export async function sendIdentifierSweepWeeklyReport(
  env: Bindings,
  now: Date = new Date(),
): Promise<SweepWeeklyOutcome | null> {
  if (isNonProductionEnv(env)) return null;
  const db = env.DB;
  const { week } = reportWindow(now);
  const outcome: SweepWeeklyOutcome = {
    week,
    claimed: false,
    attempted: 0,
    delivered: 0,
    attention: null,
  };

  try {
    const res = await db
      .prepare(IDENTIFIER_SWEEP_REPORT_CLAIM_SQL)
      .bind(week, week, week, week)
      .run();
    outcome.claimed = (res.meta.changes ?? 0) === 1;
  } catch (err) {
    console.error(`[identifier-sweep] weekly claim for ${week} failed: ${errorText(err)}`);
    return outcome;
  }
  if (!outcome.claimed) return outcome;

  const facts = await gatherIdentifierWeek(db, now);
  const report = renderIdentifierWeek(facts);
  outcome.attention = report.attention;

  let admins: string[] = [];
  try {
    admins = await getAdminEmailsForCategory(db, "identifier_sweep", env);
  } catch (err) {
    console.error(`[identifier-sweep] admin lookup for ${week} failed: ${errorText(err)}`);
  }
  outcome.attempted = admins.length;
  if (admins.length > 0) {
    const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
    outcome.delivered = await sendIdentifierSweepReportEmail(
      admins,
      report,
      env.RESEND_API_KEY,
      fromEmail,
      replyTo,
      isDev,
      env,
    );
  }

  if (outcome.delivered > 0) {
    try {
      await auditLogStatement(db, {
        userId: null,
        action: IDENTIFIER_SWEEP_REPORT_SENT_ACTION,
        resourceType: "identifier_sweep",
        resourceId: week,
        details: JSON.stringify({
          delivered: outcome.delivered,
          attention: report.attention,
          scope: facts.scope,
          screened: facts.screened,
          unchecked: facts.unchecked,
          with_identifiers: facts.flagged?.length ?? null,
          needs_review: facts.review?.length ?? null,
        }),
      }).run();
    } catch (err) {
      // The claim stays and expires; a later tick sends again, up to the cap.
      console.error(
        `[identifier-sweep] the weekly report for ${week} was delivered but could not be recorded: ${errorText(err)}`,
      );
    }
  } else {
    console.error(`[identifier-sweep] the weekly report for ${week} reached nobody`);
  }
  return outcome;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
