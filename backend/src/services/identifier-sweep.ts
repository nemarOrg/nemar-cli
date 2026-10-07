/**
 * The scheduled identifier sweep (epic #1610, phase 5, ADR 0088).
 *
 * Published datasets are screened again on a cycle, with the same workflow and
 * the same report contract as a publication request (ADR 0086): the tick
 * dispatches `run-identifier-screen` on `nemarDatasets/.github` for a few
 * datasets at a time, the workflow reads every header and posts a report to
 * `/webhooks/identifier-sweep-result`, and the Worker stores what
 * `parseScreenReport` accepted. The runner does the reading; the Worker only
 * dispatches, so the sweep never comes near a Worker's subrequest limit.
 *
 * **It reports and never repairs** (ADR 0067). It writes `sweep_stamps`
 * (ADR 0035) and its own `audit_log` rows (the weekly report's claims and
 * sends, and an administrator's rescreen request). It edits no dataset, files
 * no GitHub issue (`nemarDatasets` is public-facing), and mails no depositor;
 * the weekly admin report is its one mail (`identifier-sweep-report.ts` builds
 * it, {@link sendIdentifierSweepWeeklyReport} sends it).
 *
 * **A verdict comes only from a scan.** The stamps keep the last verdict apart
 * from the last attempt (see `sweep-stamps.ts`). A screen that could not start,
 * failed, never reported, or posted a body outside the contract moves the
 * attempt and never the verdict, so an infrastructure failure can neither stand
 * in for a screen nor make an old one look fresh (ADR 0053, ADR 0067). And a
 * screen that read less than the one before it does not retract what the one
 * before it found.
 *
 * **The cadence never depends on the verdict.** The Actions logs of
 * `nemarDatasets/.github` are public and name the dataset a run screens, so a
 * dataset re-screened more often because it was flagged would be pointed out to
 * anyone reading the run list. Only verdict-free facts move a dataset forward:
 * no verdict yet, the verdict's age, a newer version (already public), failed
 * attempts (already visible in their own runs), an administrator's request.
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
import {
  IdentifierScreenDispatchRejected,
  signIdentifierSweepCallbackToken,
  triggerIdentifierScreenRun,
} from "./github.js";
import { SCREEN_REPORT_DEADLINE_MINUTES, workerErrorReport } from "./identifier-screen.js";
import {
  FINDING_STATUSES,
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
  IDENTIFIER_SWEEP_FAILURES_PATH,
  IDENTIFIER_SWEEP_FINDING_PATH,
  IDENTIFIER_SWEEP_NONCE_PATH,
  IDENTIFIER_SWEEP_REPORT_PATH,
  IDENTIFIER_SWEEP_REQUESTED_AT_PATH,
  IDENTIFIER_SWEEP_STATUS_PATH,
  IDENTIFIER_SWEEP_VERSION_PATH,
} from "./sweep-stamps.js";

// ============================================================================
// The numbers (ADR 0088)
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
 * Hours a dataset waits after its last attempt before it is dispatched again,
 * by how many attempts in a row produced no verdict (the last entry holds from
 * there on). The first entry also keeps a screen in flight from being
 * dispatched twice. A dataset whose screen always fails is tried every 6 hours
 * at first and every 4 days in the end, never four times a day forever.
 */
export const IDENTIFIER_SWEEP_BACKOFF_HOURS: readonly number[] = [6, 6, 12, 24, 48, 96];

/** Dispatches per tick, at most (the tick is every 30 minutes). */
export const IDENTIFIER_SWEEP_SLICE = 3;

/** No dispatch while this many sweep screens are in flight. */
export const IDENTIFIER_SWEEP_MAX_IN_FLIGHT = 6;

/**
 * A sweep screen still pending this long after its dispatch has not reported.
 * The same workflow as a publication screen, so the same deadline.
 */
export const IDENTIFIER_SWEEP_DEADLINE_MINUTES = SCREEN_REPORT_DEADLINE_MINUTES;

/**
 * A report for an `unreported` attempt is still accepted for this long after
 * its dispatch, and refused after. Far beyond the workflow's 45-minute job
 * timeout and its callback retries, and short enough that a nonce does not stay
 * good for the weeks a dataset with a fresh verdict may wait for its next screen.
 */
export const IDENTIFIER_SWEEP_LATE_REPORT_HOURS = 24;

/** How long the tick waits for GitHub to answer a dispatch. */
export const IDENTIFIER_SWEEP_DISPATCH_TIMEOUT_MS = 10_000;

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
 * is screened (the workflow refuses an `xx` id, so such a row ends
 * `workflow-failed` and is reported, never skipped in silence). `on` mirrors
 * are screened like any deposit, and so is an anonymous deposit, whose row is
 * public over a private repository the workflow's App token can clone; the run
 * log names its id, which the public catalog already shows.
 */
function sweepScopeSql(alias = "d"): string {
  const a = alias ? `${alias}.` : "";
  return `${a}status = 'active' AND ${a}visibility = 'public' AND ${a}withdrawn_at IS NULL
     AND NOT (${a}dataset_id GLOB 'xx[0-9][0-9][0-9][0-9][0-9][0-9]')`;
}

/**
 * The stamps are an object (or not there yet). `json_set` on a JSON array or
 * scalar that passes the column's `json_valid` CHECK changes nothing and still
 * counts the row as changed, so a claim or a request on such a row would report
 * a write it never made.
 */
function stampsWritableSql(alias = "d"): string {
  const a = alias ? `${alias}.` : "";
  return `(${a}sweep_stamps IS NULL OR json_type(${a}sweep_stamps) = 'object')`;
}

/** The dataset's latest version, by the newest `dataset_versions` row (ties broken by id). */
const LATEST_VERSION_SQL = `(SELECT dv.version FROM dataset_versions dv
      WHERE dv.dataset_id = d.dataset_id
      ORDER BY dv.created_at DESC, dv.id DESC LIMIT 1)`;

const STATUS_LIST = DATASET_STATUSES.map((s) => `'${s}'`).join(", ");

/** The backoff for this row's failure count, as a `datetime` modifier. */
function backoffModifierSql(alias: string): string {
  const failures = `COALESCE(${stamp(IDENTIFIER_SWEEP_FAILURES_PATH, alias)}, 0)`;
  const last = IDENTIFIER_SWEEP_BACKOFF_HOURS.length - 1;
  const arms = IDENTIFIER_SWEEP_BACKOFF_HOURS.slice(0, last)
    .map((h, i) => `WHEN ${failures} <= ${i} THEN '-${h} hours'`)
    .join(" ");
  return `CASE ${arms} ELSE '-${IDENTIFIER_SWEEP_BACKOFF_HOURS[last]} hours' END`;
}

/**
 * When a dataset may be dispatched: never attempted, or not attempted within its
 * backoff, or asked for by an administrator and not in flight. NULL-safe: an
 * absent attempt time is "never", an absent failure count is zero, and a time
 * in the future (a hand edit, or a restore) is not one the sweep wrote, so it
 * holds nothing back.
 */
function backoffClearSql(alias = "d"): string {
  return `(${stamp(IDENTIFIER_SWEEP_ATTEMPTED_AT_PATH, alias)} IS NULL
       OR ${stamp(IDENTIFIER_SWEEP_ATTEMPTED_AT_PATH, alias)} < datetime('now', ${backoffModifierSql(alias)})
       OR ${stamp(IDENTIFIER_SWEEP_ATTEMPTED_AT_PATH, alias)} > datetime('now', '+5 minutes')
       OR (${stamp(IDENTIFIER_SWEEP_REQUESTED_AT_PATH, alias)} IS NOT NULL
           AND COALESCE(${stamp(IDENTIFIER_SWEEP_ATTEMPT_PATH, alias)}, '') != 'pending'))`;
}

/**
 * Why a dataset is due, verdict-free (see the module header): an administrator
 * asked; there is no verdict on record (no status, a status that is not one, no
 * report object, no time, or a time in the future); the verdict is older than
 * the refresh; or it was of an older version than the latest. Never "because it
 * was flagged". NULL-safe throughout: a missing version on either side
 * compares as ''.
 */
const DUE_SQL = `(${stamp(IDENTIFIER_SWEEP_REQUESTED_AT_PATH)} IS NOT NULL
       OR ${stamp(IDENTIFIER_SWEEP_STATUS_PATH)} IS NULL
       OR ${stamp(IDENTIFIER_SWEEP_STATUS_PATH)} NOT IN (${STATUS_LIST})
       OR json_type(d.sweep_stamps, '${IDENTIFIER_SWEEP_REPORT_PATH}') IS NOT 'object'
       OR ${stamp(IDENTIFIER_SWEEP_CHECKED_AT_PATH)} IS NULL
       OR ${stamp(IDENTIFIER_SWEEP_CHECKED_AT_PATH)} < datetime('now', '-${IDENTIFIER_SWEEP_REFRESH_DAYS} days')
       OR ${stamp(IDENTIFIER_SWEEP_CHECKED_AT_PATH)} > datetime('now', '+5 minutes')
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
      AND ${stampsWritableSql()}
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
      AND ${stampsWritableSql()}
      AND ${backoffClearSql()}
      AND ${DUE_SQL}`;

/**
 * How many datasets are owed a screen at all: the due predicate without the
 * backoff. The weekly report reads liveness from this, so a sweep whose every
 * dispatch is refused (and whose datasets therefore sit out their backoff) is
 * not mistaken for a sweep with nothing to do.
 */
export const IDENTIFIER_SWEEP_OWED_COUNT_SQL = `SELECT COUNT(*) AS n
     FROM datasets d
    WHERE ${sweepScopeSql()}
      AND ${stampsWritableSql()}
      AND ${DUE_SQL}`;

/** Sweep screens in flight, in or out of scope (a dataset made private mid-run still holds a runner). */
export const IDENTIFIER_SWEEP_IN_FLIGHT_SQL = `SELECT COUNT(*) AS n FROM datasets d
    WHERE ${stamp(IDENTIFIER_SWEEP_ATTEMPT_PATH)} = 'pending'`;

/** One more failure for an attempt that was still pending; none for one already counted. */
const COUNT_FAILURE_SQL = `COALESCE(${stamp(IDENTIFIER_SWEEP_FAILURES_PATH, "")}, 0)
              + CASE WHEN ${stamp(IDENTIFIER_SWEEP_ATTEMPT_PATH, "")} = 'pending' THEN 1 ELSE 0 END`;

/** The same, only when the bound flag is 1: a fault that is not the dataset's own counts nothing. */
const COUNT_FAILURE_IF_SQL = `COALESCE(${stamp(IDENTIFIER_SWEEP_FAILURES_PATH, "")}, 0)
              + CASE WHEN ? = 1 AND ${stamp(IDENTIFIER_SWEEP_ATTEMPT_PATH, "")} = 'pending' THEN 1 ELSE 0 END`;

/**
 * A screen pending past the deadline becomes `unreported`. NULL-safe: a pending
 * attempt with no dispatch time, or one in the future, is overdue (else it
 * would hold an in-flight slot forever). The nonce is KEPT, so a report that
 * arrives later (within {@link IDENTIFIER_SWEEP_LATE_REPORT_HOURS}) is still the
 * run's own answer. The verdict is untouched; the failure is counted.
 */
export const IDENTIFIER_SWEEP_UNREPORTED_SQL = `UPDATE datasets
      SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'),
            '${IDENTIFIER_SWEEP_FAILURES_PATH}', ${COUNT_FAILURE_SQL},
            '${IDENTIFIER_SWEEP_ATTEMPT_PATH}', 'unreported',
            '${IDENTIFIER_SWEEP_ATTEMPT_ERROR_PATH}', 'no-report-in-time')
    WHERE ${stamp(IDENTIFIER_SWEEP_ATTEMPT_PATH, "")} = 'pending'
      AND (${stamp(IDENTIFIER_SWEEP_ATTEMPTED_AT_PATH, "")} IS NULL
           OR ${stamp(IDENTIFIER_SWEEP_ATTEMPTED_AT_PATH, "")} < datetime('now', '-${IDENTIFIER_SWEEP_DEADLINE_MINUTES} minutes')
           OR ${stamp(IDENTIFIER_SWEEP_ATTEMPTED_AT_PATH, "")} > datetime('now', '+5 minutes'))`;

/**
 * Claim one dataset for a dispatch: the attempt becomes `pending` with a fresh
 * nonce, the dispatch time and the version it is for, and a request it answers
 * is cleared. Conditional on the scope, writable stamps and the backoff, so a
 * dataset that left scope or was claimed by a concurrent tick is not dispatched.
 * Bind order: attempt version, nonce, dataset id.
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
      AND ${stampsWritableSql("")}
      AND ${backoffClearSql("")}`;

/**
 * The attempt still waits for its report: `pending`, or `unreported` and
 * dispatched no longer ago than the late-report bound.
 */
function waitingSql(alias: string): string {
  return `(${stamp(IDENTIFIER_SWEEP_ATTEMPT_PATH, alias)} = 'pending'
         OR (${stamp(IDENTIFIER_SWEEP_ATTEMPT_PATH, alias)} = 'unreported'
             AND ${stamp(IDENTIFIER_SWEEP_ATTEMPTED_AT_PATH, alias)} >= datetime('now', '-${IDENTIFIER_SWEEP_LATE_REPORT_HOURS} hours')))`;
}

/**
 * An attempt that produced no scan: the error word is recorded, the failure
 * counted (once per attempt, and only when the bound flag is 1) and the nonce
 * dropped; the verdict is untouched. Compare-and-set on the nonce and an
 * attempt still waiting, so it can only close the attempt it is about. Bind
 * order: count flag (1 or 0), error word, dataset id, nonce.
 */
export const IDENTIFIER_SWEEP_ATTEMPT_FAILED_SQL = `UPDATE datasets
      SET sweep_stamps = json_remove(
            json_set(COALESCE(sweep_stamps, '{}'),
              '${IDENTIFIER_SWEEP_FAILURES_PATH}', ${COUNT_FAILURE_IF_SQL},
              '${IDENTIFIER_SWEEP_ATTEMPT_PATH}', 'error',
              '${IDENTIFIER_SWEEP_ATTEMPT_ERROR_PATH}', ?),
            '${IDENTIFIER_SWEEP_NONCE_PATH}')
    WHERE dataset_id = ?
      AND ${stamp(IDENTIFIER_SWEEP_NONCE_PATH, "")} = ?
      AND ${waitingSql("")}`;

/**
 * A scan landed: it becomes the verdict, with the version its screen was
 * DISPATCHED for (read from the attempt, not from the catalog now), the
 * finding it must keep listing (`$.identifier_sweep_finding`, computed by
 * {@link storeSweepResult}), and the attempt is closed with its failure count
 * cleared. The one conditional UPDATE that stores, so of a callback, a retry of
 * it and a late duplicate exactly one writes. Bind order: status, report JSON,
 * retained finding JSON (or null), dataset id, nonce.
 */
export const IDENTIFIER_SWEEP_STORE_SQL = `UPDATE datasets
      SET sweep_stamps = json_remove(
            json_set(COALESCE(sweep_stamps, '{}'),
              '${IDENTIFIER_SWEEP_STATUS_PATH}', ?,
              '${IDENTIFIER_SWEEP_REPORT_PATH}', json(?),
              '${IDENTIFIER_SWEEP_FINDING_PATH}', json(?),
              '${IDENTIFIER_SWEEP_CHECKED_AT_PATH}', datetime('now'),
              '${IDENTIFIER_SWEEP_VERSION_PATH}', ${stamp(IDENTIFIER_SWEEP_ATTEMPT_VERSION_PATH, "")},
              '${IDENTIFIER_SWEEP_ATTEMPT_PATH}', 'reported'),
            '${IDENTIFIER_SWEEP_NONCE_PATH}',
            '${IDENTIFIER_SWEEP_ATTEMPT_ERROR_PATH}',
            '${IDENTIFIER_SWEEP_FAILURES_PATH}')
    WHERE dataset_id = ?
      AND ${stamp(IDENTIFIER_SWEEP_NONCE_PATH, "")} = ?
      AND ${waitingSql("")}`;

/** The verdict a store replaces, and the finding it carries forward. */
export const IDENTIFIER_SWEEP_PRIOR_SQL = `SELECT ${stamp(IDENTIFIER_SWEEP_STATUS_PATH)} AS status,
          ${stamp(IDENTIFIER_SWEEP_CHECKED_AT_PATH)} AS checked_at,
          ${stamp(IDENTIFIER_SWEEP_REPORT_PATH)} AS report,
          ${stamp(IDENTIFIER_SWEEP_FINDING_PATH)} AS finding
     FROM datasets d WHERE d.dataset_id = ?`;

/** The nonce of an attempt still waiting for its report, for the callback to verify against. */
export const IDENTIFIER_SWEEP_NONCE_SQL = `SELECT ${stamp(IDENTIFIER_SWEEP_NONCE_PATH)} AS nonce
     FROM datasets d
    WHERE d.dataset_id = ?
      AND ${waitingSql("d")}
    LIMIT 1`;

/** An administrator's request to screen one dataset again. */
export const IDENTIFIER_SWEEP_REQUEST_SQL = `UPDATE datasets
      SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'),
            '${IDENTIFIER_SWEEP_REQUESTED_AT_PATH}', datetime('now'))
    WHERE dataset_id = ? AND ${sweepScopeSql("")} AND ${stampsWritableSql("")}`;

/** Every dataset in scope with its stamps, for the weekly report. */
export const IDENTIFIER_SWEEP_ROWS_SQL = `SELECT d.dataset_id,
          ${LATEST_VERSION_SQL} AS latest_version,
          json_type(d.sweep_stamps) AS stamps_type,
          ${stamp(IDENTIFIER_SWEEP_STATUS_PATH)} AS status,
          ${stamp(IDENTIFIER_SWEEP_CHECKED_AT_PATH)} AS checked_at,
          ${stamp(IDENTIFIER_SWEEP_VERSION_PATH)} AS version,
          -- json_extract gives an object back as its JSON text, and anything else
          -- as itself, which the reader refuses; json() here would make one bad
          -- row an error for the whole query, and blind the week.
          ${stamp(IDENTIFIER_SWEEP_REPORT_PATH)} AS report,
          ${stamp(IDENTIFIER_SWEEP_FINDING_PATH)} AS finding,
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

export type DispatchBlock = "dispatch-unconfigured" | "dispatch-failed";

/**
 * Statuses that say the credential cannot reach the central repository (bad
 * token, no access, no such repository): the whole tick's fault, not one
 * dataset's.
 */
const SYSTEMIC_DISPATCH_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

export interface IdentifierSweepTickResult {
  /** True when the tick did nothing because this is not production. */
  skipped: boolean;
  /** Screens marked `unreported` this tick; null when that statement failed. */
  timedOut: number | null;
  /** Screens in flight before dispatching; null when they could not be counted (nothing is dispatched then). */
  inFlight: number | null;
  /** Datasets the candidate query returned. */
  candidates: number;
  /** Candidates whose claim matched no row (they left scope, or another tick took them). */
  unclaimed: number;
  /** Screens GitHub accepted this tick. */
  dispatched: number;
  /**
   * Dispatches whose answer was lost (a timeout, a dropped connection, a 5xx):
   * GitHub may have started the run, so the attempt stays pending, its nonce
   * good, and the unreported pass closes it if no report comes.
   */
  unconfirmed: string[];
  /** Claimed attempts that GitHub refused, or that had no repository, with the word recorded on each. */
  failed: { dataset_id: string; error: DispatchBlock }[];
  /**
   * The Worker could not dispatch at all this tick (no secret, API base or
   * credential, or no token could be minted: nothing was claimed), or GitHub
   * refused the credential itself (401, 403, 404: the one claimed attempt is
   * closed without counting against its dataset, and nothing more is claimed).
   */
  blocked: DispatchBlock | null;
  /** Statement-level failures, with the database's own message (Worker log only). */
  errors: string[];
}

interface Candidate {
  dataset_id: string;
  github_repo: string | null;
  latest_version: string | null;
}

type DispatchCredential =
  | { ok: true; token: string; secret: string; apiBase: string }
  | { ok: false; error: DispatchBlock };

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
 *    {@link IDENTIFIER_SWEEP_MAX_IN_FLIGHT} in flight, are selected. The
 *    credential is resolved once, BEFORE anything is claimed: a Worker that
 *    cannot dispatch claims nothing and says so in `blocked`, rather than
 *    stamping three datasets a tick with a fault that is not theirs.
 * 4. Each candidate is claimed and dispatched. GitHub refusing it (a 4xx), or a
 *    dataset with no repository, records why on its own attempt; a lost answer
 *    leaves the attempt pending for the unreported pass.
 *
 * At most one token mint and {@link IDENTIFIER_SWEEP_SLICE} dispatch calls per
 * tick, and about twenty D1 statements. Never throws.
 */
export async function runIdentifierSweepTick(env: Bindings): Promise<IdentifierSweepTickResult> {
  const result: IdentifierSweepTickResult = {
    skipped: false,
    timedOut: null,
    inFlight: null,
    candidates: 0,
    unclaimed: 0,
    dispatched: 0,
    unconfirmed: [],
    failed: [],
    blocked: null,
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
  result.candidates = candidates.length;
  if (candidates.length === 0) return result;

  // One credential for the tick, resolved before any claim, and only when some
  // candidate has a repository to screen.
  let credential: DispatchCredential | null = null;
  if (candidates.some((c) => c.github_repo)) {
    credential = await resolveDispatchCredential(env);
    if (!credential.ok) {
      result.blocked = credential.error;
      return result;
    }
  }

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
    if (!claimed) {
      result.unclaimed++;
      continue;
    }

    let failure: DispatchBlock;
    let systemic = false;
    if (!c.github_repo || !credential?.ok) {
      // The workflow addresses the repository by the dataset id, and a row with
      // no repository has nothing to clone.
      failure = "dispatch-unconfigured";
    } else {
      try {
        const callbackToken = await signIdentifierSweepCallbackToken(
          { datasetId: c.dataset_id, nonce },
          credential.secret,
        );
        await triggerIdentifierScreenRun(
          c.dataset_id,
          "main",
          0,
          callbackToken,
          `${credential.apiBase}${IDENTIFIER_SWEEP_CALLBACK_PATH}`,
          credential.token,
          IDENTIFIER_SWEEP_DISPATCH_TIMEOUT_MS,
        );
        result.dispatched++;
        continue;
      } catch (err) {
        console.error(`[identifier-sweep] dispatch of ${c.dataset_id} failed: ${errorText(err)}`);
        if (!(err instanceof IdentifierScreenDispatchRejected && err.definitelyNotSent)) {
          // GitHub may have accepted it and lost only the answer. Leave the
          // attempt pending with its nonce, so a run that did start can still
          // report; the unreported pass closes it if none does.
          result.unconfirmed.push(c.dataset_id);
          continue;
        }
        failure = "dispatch-failed";
        // 401, 403, 404: the credential cannot reach the central repository at
        // all, which is no fault of this dataset. Close its attempt without
        // counting it, and claim nobody else this tick, so a broken credential
        // does not run the queue's backoff up dataset by dataset.
        systemic = SYSTEMIC_DISPATCH_STATUSES.has(
          (err as IdentifierScreenDispatchRejected).httpStatus,
        );
      }
    }

    result.failed.push({ dataset_id: c.dataset_id, error: failure });
    try {
      await db
        .prepare(IDENTIFIER_SWEEP_ATTEMPT_FAILED_SQL)
        .bind(systemic ? 0 : 1, failure, c.dataset_id, nonce)
        .run();
    } catch (err) {
      // The attempt stays `pending`, and the unreported pass closes it after the
      // deadline. Nothing reads it as a verdict meanwhile.
      result.errors.push(
        `recording the failed dispatch of ${c.dataset_id} failed: ${errorText(err)}`,
      );
    }
    if (systemic) {
      result.blocked = "dispatch-failed";
      break;
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
 * What a stored report keeps: the verdict, its counts and what it read, and
 * nothing a reader does not use (sampling statistics, per-class read failures,
 * distinct-value counts, per-kind file counts, the manifest source, and the
 * unparsed-format map, whose keys are a pattern rather than a closed list). The projection is parsed again
 * before it is written, so what is stored is still a report the contract
 * accepts; the row stays small (ADR 0034, and the restore limit of #1188).
 */
export function projectReport(report: ScreenReport): ScreenReport {
  if (!report.scan) return report;
  const s = report.scan;
  const scan: Record<string, unknown> = {
    id: s.id,
    version: s.version,
    scanned_at: s.scanned_at,
    status: s.status,
    incomplete: s.incomplete,
    incomplete_reasons: s.incomplete_reasons,
  };
  if (s.files !== undefined) scan.files = s.files;
  if (s.findings_by_kind !== undefined) scan.findings_by_kind = s.findings_by_kind;
  if (s.edf_bdf_files_flagged !== undefined) scan.edf_bdf_files_flagged = s.edf_bdf_files_flagged;
  return parseScreenReport({
    version: report.version,
    scanner: report.scanner,
    head: report.head,
    scan,
  });
}

const FINDING_SET: ReadonlySet<string> = new Set(FINDING_STATUSES);

/** How much a verdict found: a direct identifier above a review item above nothing. */
export function findingRank(status: unknown): number {
  return status === "direct-identifiers" ? 2 : status === "review" ? 1 : 0;
}

/** A stored time in the shape `datetime('now')` writes, or null. */
const SQLITE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

interface CarriedFinding {
  status: DatasetStatus;
  checked_at: string | null;
  /** Null when the finding's report does not read back: its status still does, and is still listed. */
  report: ScreenReport | null;
}

/** A carried finding read back from its stamp, or null when there is none (or no status to carry). */
function readCarried(raw: unknown): CarriedFinding | null {
  if (typeof raw !== "string") return null;
  try {
    const f = JSON.parse(raw) as { status?: unknown; checked_at?: unknown; report?: unknown };
    if (typeof f.status !== "string" || !FINDING_SET.has(f.status)) return null;
    let report: ScreenReport | null = null;
    try {
      report = f.report == null ? null : parseScreenReport(f.report);
      if (report?.scan?.status !== f.status) report = null;
    } catch {
      report = null;
    }
    return {
      status: f.status as DatasetStatus,
      checked_at:
        typeof f.checked_at === "string" && SQLITE_TIME.test(f.checked_at) ? f.checked_at : null,
      report,
    };
  } catch {
    return null;
  }
}

/**
 * The finding a new verdict must carry forward, as JSON text, or null.
 *
 * A COMPLETE verdict is the whole answer and carries nothing. An INCOMPLETE one
 * read less than the screens before it, so it is not evidence that what they
 * found is gone: it carries forward the strongest finding among the prior
 * verdict and the finding the prior verdict was already carrying, unless it
 * found at least as much itself (an incomplete `review` does not displace a
 * `direct-identifiers`). A prior finding whose report does not read back is
 * carried as its status alone, so it stays named.
 */
function findingToKeep(
  status: DatasetStatus,
  incomplete: boolean,
  prior: { status: unknown; checked_at: unknown; report: unknown; finding: unknown } | null,
): string | null {
  if (!incomplete || !prior) return null;
  const candidates: CarriedFinding[] = [];
  if (typeof prior.status === "string" && FINDING_SET.has(prior.status)) {
    const report = readJsonReport(prior.report);
    candidates.push({
      status: prior.status as DatasetStatus,
      checked_at:
        typeof prior.checked_at === "string" && SQLITE_TIME.test(prior.checked_at)
          ? prior.checked_at
          : null,
      report: report?.scan?.status === prior.status ? report : null,
    });
  }
  const carried = readCarried(prior.finding);
  if (carried) candidates.push(carried);
  // Strongest first; between equals, the prior verdict (the newer screen) wins.
  const best = candidates.reduce<CarriedFinding | null>(
    (a, c) => (a === null || findingRank(c.status) > findingRank(a.status) ? c : a),
    null,
  );
  if (best === null || findingRank(best.status) <= findingRank(status)) return null;
  return JSON.stringify(best);
}

function readJsonReport(raw: unknown): ScreenReport | null {
  if (typeof raw !== "string") return null;
  try {
    return parseScreenReport(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Store a verified callback's report on the dataset it was issued for.
 *
 * `body` is untrusted. It reaches the row only through `parseScreenReport`: a
 * body outside the contract, or a scan of another dataset, is recorded as the
 * attempt's `workflow-failed` and only the parser's fixed word is logged. A
 * scan becomes the verdict (projected, see {@link projectReport}); an error
 * report (the workflow's own word) closes the attempt and leaves the verdict
 * where it was.
 *
 * The prior verdict is read first, for the finding an incomplete screen must
 * keep; the write that follows is a compare-and-set on the nonce, and only a
 * store holding the nonce writes a verdict, so the read cannot go stale under it.
 *
 * Mails nobody. The weekly report is the sweep's only mail. Throws on a
 * database error, so the route answers 500 and the workflow retries with its
 * nonce still good.
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
    const stored = projectReport(report);
    const status = report.scan.status;
    const prior = await db
      .prepare(IDENTIFIER_SWEEP_PRIOR_SQL)
      .bind(args.datasetId)
      .first<{ status: unknown; checked_at: unknown; report: unknown; finding: unknown }>();
    const finding = findingToKeep(status, report.scan.incomplete, prior);
    const res = await db
      .prepare(IDENTIFIER_SWEEP_STORE_SQL)
      .bind(status, JSON.stringify(stored), finding, args.datasetId, args.nonce)
      .run();
    if ((res.meta.changes ?? 0) !== 1) return { stored: false };
    return { stored: true, kind: "verdict", status };
  }
  const error = report.error as ScreenError;
  const res = await db
    .prepare(IDENTIFIER_SWEEP_ATTEMPT_FAILED_SQL)
    .bind(1, error, args.datasetId, args.nonce)
    .run();
  if ((res.meta.changes ?? 0) !== 1) return { stored: false };
  return { stored: true, kind: "error", error };
}

// ============================================================================
// An administrator's request
// ============================================================================

export type RescreenOutcome = "requested" | "not-found" | "out-of-scope" | "unwritable";

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
    const row = await db
      .prepare(
        `SELECT ${sweepScopeSql()} AS in_scope, ${stampsWritableSql()} AS writable
           FROM datasets d WHERE d.dataset_id = ?`,
      )
      .bind(args.datasetId)
      .first<{ in_scope: number; writable: number }>();
    if (!row) return "not-found";
    return row.in_scope ? "unwritable" : "out-of-scope";
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

/** What a claim whose send reached nobody is marked with, so it does not count toward the cap. */
export const IDENTIFIER_SWEEP_REPORT_UNDELIVERED = '{"delivered":0}';

/**
 * A claim on a week's report holds this long: a send in progress is not
 * started twice, and a send that reached nobody is tried again after it.
 */
export const IDENTIFIER_SWEEP_REPORT_LEASE_MINUTES = 120;

/**
 * Claims per week that may have mailed someone, at most. A claim whose every
 * send was refused outright (a 4xx, or the dev fence) is marked and does not
 * count, because retrying it cannot duplicate anything; one with a send that
 * ended without an answer counts, and so does one one that delivered and then could not write its `sent`
 * row, or whose Worker died mid-send, does. The cap keeps that broken record
 * from becoming a mail every lease, all week: the trade ADR 0054 makes, in the
 * same direction.
 */
export const IDENTIFIER_SWEEP_REPORT_MAX_CLAIMS = 12;

const CLAIM_ROWS_SQL = `FROM audit_log
                       WHERE action = '${IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION}'
                         AND resource_type = 'identifier_sweep' AND resource_id = ?`;

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
      AND NOT EXISTS (SELECT 1 ${CLAIM_ROWS_SQL}
                         AND timestamp >= datetime('now', '-${IDENTIFIER_SWEEP_REPORT_LEASE_MINUTES} minutes'))
      AND (SELECT COUNT(*) ${CLAIM_ROWS_SQL} AND details IS NULL) < ${IDENTIFIER_SWEEP_REPORT_MAX_CLAIMS}`;

/** Mark a claim whose send reached nobody. By row id, so it can only touch that claim. */
export const IDENTIFIER_SWEEP_REPORT_UNDELIVERED_SQL = `UPDATE audit_log SET details = ?
    WHERE id = ? AND action = '${IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION}' AND details IS NULL`;

/** Where a week's report stands: sent or not, how many claims count toward the cap, and whether one is live. Bind: the week three times. */
export const IDENTIFIER_SWEEP_REPORT_STATE_SQL = `SELECT
      (SELECT COUNT(*) FROM audit_log
        WHERE action = '${IDENTIFIER_SWEEP_REPORT_SENT_ACTION}'
          AND resource_type = 'identifier_sweep' AND resource_id = ?) AS sent,
      (SELECT COUNT(*) ${CLAIM_ROWS_SQL} AND details IS NULL) AS counted,
      (SELECT COUNT(*) ${CLAIM_ROWS_SQL}
          AND timestamp >= datetime('now', '-${IDENTIFIER_SWEEP_REPORT_LEASE_MINUTES} minutes')) AS live`;

export interface WeeklyRecordState {
  week: string;
  sent: boolean;
  /** Claims that count toward the cap. */
  counted: number;
  /** True when the week is not sent, no claim is live, and no further claim is allowed. */
  exhausted: boolean;
}

/** Where the weekly report for the week before `now` stands; null when it cannot be read. */
export async function weeklyRecordState(
  db: D1Database,
  now: Date,
): Promise<WeeklyRecordState | null> {
  const { week } = reportWindow(now);
  try {
    const row = await db
      .prepare(IDENTIFIER_SWEEP_REPORT_STATE_SQL)
      .bind(week, week, week)
      .first<{ sent: number; counted: number; live: number }>();
    if (!row) return null;
    const sent = row.sent > 0;
    return {
      week,
      sent,
      counted: row.counted,
      // Not while the last claim's send may still be running.
      exhausted: !sent && row.live === 0 && row.counted >= IDENTIFIER_SWEEP_REPORT_MAX_CLAIMS,
    };
  } catch (err) {
    console.error(
      `[identifier-sweep] weekly state for ${week} could not be read: ${errorText(err)}`,
    );
    return null;
  }
}

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
  let owed: number | null = null;
  try {
    const row = await db.prepare(IDENTIFIER_SWEEP_OWED_COUNT_SQL).first<{ n: number }>();
    owed = typeof row?.n === "number" ? row.n : null;
    if (owed === null) errors.push("the work owed could not be counted");
  } catch (err) {
    errors.push("the work owed could not be counted");
    console.error(`[identifier-sweep] owed count failed: ${errorText(err)}`);
  }
  if (rows !== null) {
    try {
      return buildIdentifierWeek(rows, {
        now,
        due,
        owed,
        errors,
        cycleDays: IDENTIFIER_SWEEP_CYCLE_DAYS,
      });
    } catch (err) {
      errors.push("the sweep's records could not be summarized");
      console.error(`[identifier-sweep] building the week failed: ${errorText(err)}`);
    }
  }
  return unknownIdentifierWeek(now, due, owed, errors, IDENTIFIER_SWEEP_CYCLE_DAYS);
}

export interface SweepWeeklyOutcome {
  week: string;
  /** False when another tick holds the claim, the week was already sent, or no claim is left. */
  claimed: boolean;
  /** True when the week is not sent and its claims are used up: it will not arrive. */
  exhausted: boolean;
  attempted: number;
  delivered: number;
  /** Sends that ended without a definite answer (a timeout, a dropped connection, a 5xx). */
  ambiguous: number;
  attention: boolean | null;
}

/**
 * Send the weekly report for the week before `now`, once, PRODUCTION ONLY.
 *
 * It goes whether or not anything is wrong: a report that only arrives on
 * breakage cannot tell a healthy week from a broken reporter (ADR 0054). The
 * claim is reserved before the facts are gathered; a send that reached nobody
 * for certain marks its claim and leaves no `sent` row, so a later tick tries
 * again once the lease is up without spending the cap. Returns null outside production (the mail fence in
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
    exhausted: false,
    attempted: 0,
    delivered: 0,
    ambiguous: 0,
    attention: null,
  };

  let claimId: number | null = null;
  try {
    const res = await db
      .prepare(IDENTIFIER_SWEEP_REPORT_CLAIM_SQL)
      .bind(week, week, week, week)
      .run();
    outcome.claimed = (res.meta.changes ?? 0) === 1;
    const id = res.meta.last_row_id;
    claimId = outcome.claimed && typeof id === "number" && id > 0 ? id : null;
  } catch (err) {
    console.error(`[identifier-sweep] weekly claim for ${week} failed: ${errorText(err)}`);
    return outcome;
  }
  if (!outcome.claimed) {
    // Sent, or a claim is live: routine. Out of claims with nothing sent is not.
    const state = await weeklyRecordState(db, now);
    outcome.exhausted = state?.exhausted ?? false;
    return outcome;
  }

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
    const sent = await sendIdentifierSweepReportEmail(
      admins,
      report,
      env.RESEND_API_KEY,
      fromEmail,
      replyTo,
      isDev,
      env,
    );
    outcome.delivered = sent.delivered;
    outcome.ambiguous = sent.ambiguous;
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
          attempted: outcome.attempted,
          attention: report.attention,
          scope: facts.scope,
          screened: facts.screened,
          unchecked: facts.unchecked,
          with_identifiers: facts.flagged?.length ?? null,
          needs_review: facts.review?.length ?? null,
        }),
      }).run();
    } catch (err) {
      // The claim stays unmarked and counts toward the cap; a later tick sends
      // again once its lease is up, which can repeat a mail but never loses one.
      console.error(
        `[identifier-sweep] the weekly report for ${week} was delivered but could not be recorded: ${errorText(err)}`,
      );
    }
  } else {
    console.error(
      `[identifier-sweep] the weekly report for ${week} was delivered to nobody (${outcome.ambiguous} sends without a definite answer)`,
    );
    // Only a send that certainly reached nobody frees its claim from the cap: a
    // timeout, a dropped connection or a 5xx may have been accepted, and a
    // retry of that could repeat a mail, so it counts.
    if (claimId !== null && outcome.ambiguous === 0) {
      try {
        await db
          .prepare(IDENTIFIER_SWEEP_REPORT_UNDELIVERED_SQL)
          .bind(IDENTIFIER_SWEEP_REPORT_UNDELIVERED, claimId)
          .run();
      } catch (err) {
        // Unmarked, the claim counts toward the cap: the safe direction.
        console.error(
          `[identifier-sweep] could not mark the undelivered claim for ${week}: ${errorText(err)}`,
        );
      }
    }
  }
  return outcome;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
