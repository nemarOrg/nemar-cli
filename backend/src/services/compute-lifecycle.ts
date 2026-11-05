/**
 * The compute job lifecycle (epic #2005 phase A5, #2010; ADR 0118 and its amendments; design sections
 * 5, 6, 7 and 9): a job row becomes a running, settled, verified Tapis job without anyone watching.
 *
 *   submit    `submitComputeJob`: idempotent against Tapis (a tag search first, never a blind
 *             re-submit), the launch specification in one environment variable, a webhook subscription.
 *   advance   `applyTapisJob`: the ONE transition function for a webhook, the 30-minute tick, a cancel
 *             and an administrator's command. `advanceComputeJob` reads the job back from Tapis first.
 *   settle    a terminal transition and its ledger entry are ONE batch, guarded on the new state.
 *   verify    a Tapis `FINISHED` stands only after the launcher's upload is verified (compute-verify.ts).
 *   records   `copyResultRecords`: the launcher's files and the logs into the locked records.
 *   cancel    `requestComputeCancel` records the intent; the cancel itself is retried by the tick.
 *
 * THE RULES, each one deliberate:
 *  - NEMAR OWNS EVERY TAPIS JOB (the repository owner's decision of 2026-11-04). The Tapis `owner` of a
 *    job is the NEMAR service identity the Tapis configuration names (`tapisConfig(env).username`, the
 *    same identity the credential strategy uses), never a constant in code and never a person. A person
 *    exists only in the job row and the records.
 *  - NO AUTOMATIC REFUNDS, whoever caused the failure. A job that never started on the scheduler is
 *    RELEASED in full (nothing was consumed, so nothing is refunded); one that started is charged what
 *    the Tapis record says it used. `isPlatformFailure` survives as an INFORMATION flag
 *    (`platform_failure` on the row, for reports and for an administrator's manual grant) and it
 *    never drives a ledger write. This module calls `releaseStatements` and `settleStatements` and
 *    never `settleFinal` or `adjustPool` (and there is no `refundJob`: it was deleted); no path here
 *    credits a budget.
 *  - A WEBHOOK IS A HINT. Nothing is acted on until the job has been READ BACK from Tapis, and a
 *    subscription cannot be deduplicated, so advancing from one is idempotent: every state write is
 *    `WHERE id = ? AND state = <from>`, so a replayed, reordered or concurrent writer changes nothing.
 *  - THE OUTCOME OF A SUBMIT MAY BE UNKNOWN. After `unavailable` or `invalid_response` the job may
 *    exist at Tapis, so the next attempt searches by tag (`nemar_job:<id>`) BEFORE it submits, and binds
 *    what it finds. A tag search that finds two jobs submits nothing and flags the job.
 *  - A TRANSITION AND ITS SETTLEMENT ARE ONE BATCH. The state UPDATE, the ledger entry (gated on the job
 *    row having just taken the new state) and the stamp of what was settled run in one D1 batch, which
 *    is one transaction: if a statement THROWS (the ledger's own triggers refuse an entry), the state
 *    change is rolled back with it. A conditional INSERT that merely DECLINES (the hold is already
 *    closed, the gate is false) writes nothing and does not undo the state UPDATE before it, so "terminal
 *    and closed, or neither" holds for a thrown error only; what the gate adds is that a writer that
 *    LOST its UPDATE settles nothing. A retry repairs a terminal row whose `settled_provisional_at` is
 *    still NULL.
 *  - NOTHING THE JOB WRITES IS TRUSTED. Resources and times come from the Tapis record, the failure code
 *    from the launcher's `result.json` only after its job id, its exit number and (through the
 *    provenance) its launch specification digest agree with what NEMAR knows, and `tapisjob.out` is
 *    copied as a log and never parsed.
 *  - THE LAUNCH SPECIFICATION IS NEVER STORED, LOGGED OR RETURNED. It holds the job token. Its SHA-256 is
 *    written to the row BEFORE the submit, so a launcher that ran another one fails verification.
 *  - LOGS CARRY JOB IDS, FIXED WORDS AND ERROR CLASSES ONLY: no token, name, path, address or output.
 *  - THE SWITCH IS READ HERE ONLY, in `submitLeased` (the attempt `submitComputeJob` makes once it holds
 *    the lease). A job that is live is never stranded by it: `compute-source-scan.test.ts` pins that.
 */

import {
  type ComputeFailureCode,
  type ComputeFailureDetail,
  type ComputeJobFlag,
  type ComputeState,
  LIVE_COMPUTE_STATES,
  RECORDS_UNREADABLE,
  TERMINAL_COMPUTE_STATES,
  canTransitionCompute,
  failureCodeFromTapisCondition,
  isPlatformFailure,
  isTerminalComputeState,
  resultRefusalOf,
  stateFromTapisStatus,
} from "../../../shared/compute-state.js";
import {
  encodeLaunchSpec,
  encodeLaunchSpecEnv,
  resultsLauncherKey,
} from "../../../shared/contract/compute-launch.js";
import {
  type JobSpec,
  LAUNCHER_FILES,
  type LauncherFileName,
  type PartitionName,
  RATE_TABLE_V1,
  RECORDS_RESULT_MANIFEST_FILE,
  dataTagForVersion,
  suMilliFor,
} from "../../../shared/contract/compute.js";
import type { Bindings } from "../types/bindings.js";
import { ACCESS_REPORT_PENDING_SQL } from "./access-attributes.js";
import {
  type ComputeJobRow,
  LIVE_STATES_SQL,
  TAPIS_REPORTING_STATES_SQL,
  TERMINAL_STATES_SQL,
  getJob,
} from "./compute-jobs.js";
import { releaseStatements, settleStatements } from "./compute-ledger.js";
import { getPolicy } from "./compute-policy.js";
import { submitMemoryForQueue } from "./compute-queues.js";
import {
  OUTPUTS_BODY_CEILING_BYTES,
  logKey,
  outputsBodyLimitBytes,
  putRecordOnce,
  recordKey,
  sha256Hex,
} from "./compute-records.js";
import { sendComputeResultsReadyEmail } from "./compute-results.js";
import { type ImageFacts, imageFacts, readRuntimeImage } from "./compute-runtime-image.js";
import { computeEnabled } from "./compute-switches.js";
import { signComputeToken } from "./compute-tokens.js";
import {
  readLauncherDocs,
  readRecordedSpec,
  tapisExitCode,
  verifyResults,
} from "./compute-verify.js";
import {
  type TapisContext,
  type TapisJob,
  cancelJob,
  downloadOutputPrefix,
  getJob as getTapisJob,
  nemarJobTag,
  searchJobsByTag,
  submitJob,
  subscribeWebhook,
} from "./tapis/client.js";
import { tapisConfig } from "./tapis/config.js";
import { TapisError } from "./tapis/errors.js";
import { TAPIS_JOB_UUID_RE, TAPIS_OWNER_RE } from "./tapis/schemas.js";

// --- Constants -----------------------------------------------------------------------------------

/** How a read made on behalf of a request is made: one attempt and a short ceiling (never 46 seconds). */
export const REQUEST_READ = { maxAttempts: 1, timeoutMs: 8_000 } as const;

/** How the 30-minute tick reads: two attempts, a little longer, because nobody is waiting on it. */
export const TICK_READ = { maxAttempts: 2, timeoutMs: 10_000 } as const;

/**
 * What a launcher may stage, as the launch specification carries it. These two numbers bound the
 * DATASET SELECTION and are NOT the outputs' limits (`limits.max_total_bytes` bounds what is staged;
 * the Worker's own per-job results limit is `resultLimits.maxJobBytes`, a separate policy value the
 * outputs route enforces, and the two are never one number). The owner's policy has no key for them
 * yet, so they are named here, in one place: a policy key replaces them without touching a caller.
 */
export const LAUNCH_DATASET_LIMITS = {
  /** The most files one job may stage: the launch specification's own ceiling. */
  maxFiles: 1_000_000,
  /** One tebibyte of dataset bytes. */
  maxTotalBytes: 1024 ** 4,
} as const;

/** The most bytes of a log copied into the records: 5 MiB, for `tapisjob.out` and `launcher.log` alike. */
export const LOG_COPY_MAX_BYTES = 5 * 1024 * 1024;

/** The object metadata a log copy carries when it was cut at its bound (the records say so). */
export const TRUNCATED_NOTE = { truncated: "1" } as const;

/** A live job whose last good read from Tapis is older than this is `unreported`. */
export const UNREPORTED_AFTER_HOURS = 24;

/** The most minutes a webhook subscription lives: Tapis's own limit, four weeks. */
const WEBHOOK_TTL_MAX_MINUTES = 40_320;

/** A copy of a terminal job's files is retried while the job ended within this many days. */
export const RECORDS_COPY_RETRY_DAYS = 3;

// --- Statements ----------------------------------------------------------------------------------

/**
 * A live transition, or a self-edge that refreshes the record. `?1` the job, `?2` the state it was
 * read in (the compare), `?3` the new state, `?4` Tapis's status, `?5` and `?6` Tapis's submit and
 * start times (normalised, or NULL), `?7` the Slurm id (or NULL). The `state = ?2` term is what makes
 * a replay, a reordered hint and a concurrent writer change nothing.
 */
export const LIVE_TRANSITION_SQL = `UPDATE compute_jobs SET
    state = ?3, tapis_status = ?4, tapis_synced_at = datetime('now'),
    remote_submitted_at = COALESCE(?5, remote_submitted_at),
    started_at = COALESCE(?6, started_at),
    slurm_job_id = COALESCE(slurm_job_id, ?7)
  WHERE id = ?1 AND state = ?2`;

/**
 * A terminal transition. `?1` the job, `?2` the state it was read in, `?3` the new state, `?4` the
 * failure code (or NULL), `?5` the detail (or NULL, which keeps one already recorded), `?6` the cancel
 * reason (kept if one is recorded), `?7` platform failure 0 or 1, `?8` verified 0 or 1, `?9` mismatch 0
 * or 1, `?10` Tapis's status (or NULL), `?11` and `?12` and `?13` the submit, start and end times (or
 * NULL), `?14` the Slurm id (or NULL), `?15` the records retention as a SQLite modifier (`+7 years`),
 * `?16` 1 when the job must have no Tapis job (a job that was never submitted). The settlement that
 * follows it in the batch is gated on this row having taken `?3`.
 */
export const TERMINAL_TRANSITION_SQL = `UPDATE compute_jobs SET
    state = ?3,
    failure_code = ?4,
    failure_detail = COALESCE(?5, failure_detail),
    cancel_reason = COALESCE(cancel_reason, ?6),
    platform_failure = ?7,
    results_verified_at = CASE WHEN ?8 = 1 THEN datetime('now') ELSE results_verified_at END,
    flag_mismatch = CASE WHEN ?9 = 1 THEN 1 ELSE flag_mismatch END,
    tapis_status = COALESCE(?10, tapis_status),
    tapis_synced_at = CASE WHEN ?10 IS NULL THEN tapis_synced_at ELSE datetime('now') END,
    remote_submitted_at = COALESCE(?11, remote_submitted_at),
    started_at = COALESCE(?12, started_at),
    ended_at = COALESCE(?13, datetime('now')),
    slurm_job_id = COALESCE(slurm_job_id, ?14),
    retention_until = datetime(COALESCE(?13, datetime('now')), ?15)
  WHERE id = ?1 AND state = ?2 AND (?16 = 0 OR tapis_uuid IS NULL)`;

/**
 * The gate of the settlement statement: this job row has taken the terminal state `?` and has not been
 * settled. The settlement runs after the transition in one batch, so for the writer that won the
 * transition this is true, and for any other it is false (and the ledger's own "the hold is open"
 * term is the second guard). Plain `?` placeholders: the job and the state.
 */
export const SETTLEMENT_GATE_SQL = `EXISTS (SELECT 1 FROM compute_jobs
    WHERE id = ? AND state = ? AND settled_provisional_at IS NULL)`;

/**
 * The stamp that says the provisional settlement happened: `?1` the job, `?2` the state. It writes
 * only if the ledger holds the entry that closed the hold, takes the job's whole charge from the
 * ledger (the charge and any overrun, which are the only entries so far), and sets the overrun flag
 * when there was one. Run in the same batch as the settlement.
 */
export const SETTLED_STAMP_SQL = `UPDATE compute_jobs SET
    settled_provisional_at = datetime('now'),
    charged_milli = (SELECT COALESCE(SUM(e.charged_delta_milli), 0) FROM compute_ledger e
                      WHERE e.job_id = ?1),
    flag_overrun = CASE WHEN EXISTS (SELECT 1 FROM compute_ledger o
                                      WHERE o.job_id = ?1 AND o.kind = 'overrun')
                        THEN 1 ELSE flag_overrun END
  WHERE id = ?1 AND state = ?2 AND settled_provisional_at IS NULL
    AND EXISTS (SELECT 1 FROM compute_ledger c
                 WHERE c.job_id = ?1 AND c.kind IN ('charge', 'release'))`;

/** The job's tag search and its result are bound to the job with this: `?1` the job, `?2` the uuid, `?3` the status, `?4` the submit time. */
export const BIND_TAPIS_JOB_SQL = `UPDATE compute_jobs SET
    tapis_uuid = ?2, tapis_status = ?3, state = 'submitted', submitted_at = datetime('now'),
    tapis_synced_at = datetime('now'), remote_submitted_at = COALESCE(?4, remote_submitted_at)
  WHERE id = ?1 AND tapis_uuid IS NULL AND state IN ('created', 'uploading')
    AND cancel_requested_at IS NULL`;

/** A Tapis job that came back after the row moved on (a cancel or a timeout won): the row still learns its uuid. */
export const BIND_ORPHAN_UUID_SQL = `UPDATE compute_jobs SET tapis_uuid = ?2
  WHERE id = ?1 AND tapis_uuid IS NULL`;

/** How long a submitter's lease lasts: longer than one attempt (a tag search, a submit and a subscribe). */
export const SUBMIT_LEASE_MINUTES = 5;

/**
 * The submitter's lease, taken BEFORE the tag search: `?1` the job, `?2` the claim stamp (the
 * submitter's own time, to the millisecond, which is also how it knows the lease is its own). One
 * conditional UPDATE, so two submitters cannot both reach Tapis: only the one that changes a row goes
 * on, and an expired lease (a submitter that died or stalled) may be taken again. Released when the
 * attempt ends, whatever it ended in, and only by the submitter whose stamp it still is.
 */
export const CLAIM_SUBMIT_SQL = `UPDATE compute_jobs SET submit_claimed_at = ?2
  WHERE id = ?1 AND state IN ('created', 'uploading') AND tapis_uuid IS NULL
    AND cancel_requested_at IS NULL
    AND (submit_claimed_at IS NULL
         OR submit_claimed_at < datetime('now', '-${SUBMIT_LEASE_MINUTES} minutes'))`;

/**
 * The release of a lease: `?1` the job, `?2` the stamp the submitter claimed with. It clears only a
 * lease that is STILL that submitter's: an attempt that outlived its lease (a stall past the five
 * minutes) must not clear the lease of the submitter that took the job over (round 2 of #2041).
 */
export const RELEASE_SUBMIT_SQL =
  "UPDATE compute_jobs SET submit_claimed_at = NULL WHERE id = ?1 AND submit_claimed_at = ?2";

/** A claim stamp: a UTC time as the row writes its own, with milliseconds (`YYYY-MM-DD HH:MM:SS.mmm`). */
export function claimStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace("T", " ").replace("Z", "");
}

/**
 * A Tapis job NEMAR made that no row owns (the row ended, or is bound to another Tapis job): its uuid
 * is recorded so a cancel that failed is never forgotten: the next tick retries it. `?1` the job, `?2`
 * the uuid.
 */
export const SET_ORPHAN_SQL = `UPDATE compute_jobs SET orphan_tapis_uuid = ?2
  WHERE id = ?1 AND orphan_tapis_uuid IS NULL`;

/** The orphan is cancelled (or is gone, or is already over): the record of it is cleared. */
export const CLEAR_ORPHAN_SQL = `UPDATE compute_jobs SET orphan_tapis_uuid = NULL
  WHERE id = ?1 AND orphan_tapis_uuid = ?2`;

/** Every examination of a live row, successful or not, moves it to the back of the rotation. */
export const STAMP_EXAMINED_SQL =
  "UPDATE compute_jobs SET examined_at = datetime('now') WHERE id = ?1";

/**
 * The digest of the launch specification, written BEFORE the submit: `?1` the job, `?2` the digest, `?3`
 * the digest of the image the launch specification names (the runtime image can change between two
 * attempts, so a retry that finds nothing overwrites it: the row records what was last sent).
 */
export const LAUNCH_DIGEST_SQL = `UPDATE compute_jobs SET
    launch_spec_digest = ?2, image_digest = ?3
  WHERE id = ?1 AND state IN ('created', 'uploading') AND tapis_uuid IS NULL
    AND cancel_requested_at IS NULL`;

/** The intent to cancel, recorded in D1 before anything is asked of Tapis: `?1` the job, `?2` the reason. */
export const CANCEL_INTENT_SQL = `UPDATE compute_jobs SET
    cancel_requested_at = COALESCE(cancel_requested_at, datetime('now')),
    cancel_reason = COALESCE(cancel_reason, ?2)
  WHERE id = ?1 AND state IN (${LIVE_STATES_SQL})`;

/** A live job whose last good read is too old: `?1` the job, `?2` the state it was read in. */
export const UNREPORTED_SQL = `UPDATE compute_jobs SET state = 'unreported'
  WHERE id = ?1 AND state = ?2 AND state IN (${TAPIS_REPORTING_STATES_SQL})
    AND tapis_uuid IS NOT NULL
    AND COALESCE(tapis_synced_at, submitted_at) < datetime('now', '-${UNREPORTED_AFTER_HOURS} hours')`;

/** The job's webhook address stops working: one day after the job is terminal its nonce is cleared. */
export const CLEAR_NONCES_SQL = `UPDATE compute_jobs SET webhook_nonce = NULL
  WHERE webhook_nonce IS NOT NULL AND state IN (${TERMINAL_STATES_SQL})
    AND ended_at < datetime('now', '-1 day')`;

/** `?1` the job: a tag search found more than one Tapis job, so an administrator looks. */
export const FLAG_MISMATCH_SQL = "UPDATE compute_jobs SET flag_mismatch = 1 WHERE id = ?1";

/** Terminal jobs whose provisional settlement is owed and whose hold exists: the repair's list. */
export const UNSETTLED_TERMINAL_SQL = `SELECT id FROM compute_jobs j
  WHERE j.state IN (${TERMINAL_STATES_SQL}) AND j.settled_provisional_at IS NULL
    AND EXISTS (SELECT 1 FROM compute_ledger h WHERE h.kind = 'hold' AND h.job_id = j.id)
  ORDER BY j.ended_at ASC LIMIT ?1`;

/** Terminal jobs whose launcher files and logs have not been copied into the records yet. */
export const UNCOPIED_TERMINAL_SQL = `SELECT id FROM compute_jobs
  WHERE state IN (${TERMINAL_STATES_SQL}) AND result_records_at IS NULL AND settled_provisional_at IS NOT NULL
    AND ended_at >= datetime('now', '-${RECORDS_COPY_RETRY_DAYS} days')
  ORDER BY ended_at ASC LIMIT ?1`;

// --- Small helpers -------------------------------------------------------------------------------

/** The error's class name: all a log line ever says of a failure. */
export const errorClassName = (err: unknown): string =>
  err instanceof Error ? err.name : typeof err;

/** The tag word of a Tapis error, for a log line: the kind and whether the outcome is unknown. */
function tapisWord(err: unknown): string {
  if (err instanceof TapisError) return `${err.kind}${err.outcomeUnknown ? "_unknown" : ""}`;
  return errorClassName(err);
}

function parseMs(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const ms = Date.parse(hasZone ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** A time as the row writes its own (`YYYY-MM-DD HH:MM:SS`, UTC), or null when it is not a time. */
export function sqliteTime(value: unknown): string | null {
  const ms = parseMs(value);
  return ms === null ? null : new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

const wholeOrNull = (value: unknown, min: number): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : null;

/** The job's age in minutes on D1's own clock format, or 0 when it cannot be told. */
function ageMinutes(timestamp: string | null, nowMs: number): number {
  const ms = parseMs(timestamp);
  return ms === null ? 0 : (nowMs - ms) / 60_000;
}

const looksUnique = (err: unknown) => /UNIQUE constraint failed/i.test(String(err));

/** The Tapis access of a call: a context with the NEMAR service identity, or null when it is not configured. */
export function tapisAccess(
  env: Bindings,
  mode: { maxAttempts: number; timeoutMs: number; retryDelayMs?: number },
): TapisContext | null {
  const config = tapisConfig(env);
  if (config.unconfigured) return null;
  const owner = config.username;
  if (owner === undefined || !TAPIS_OWNER_RE.test(owner)) return null;
  return { env, owner, ...mode };
}

// --- Settlement: what a job used -----------------------------------------------------------------

export type Provisional =
  /** Nothing shows the job ran: its whole hold is released, nothing is charged. */
  | { kind: "release" }
  | {
      kind: "charge";
      /** What the Tapis record says the job used, in milli-SU (never above the hold when written). */
      milli: number;
      seconds: number;
      /**
       * The figure is not what the record's own times and resources price (a run with no start time, a
       * start time that is not a time, a rate that cannot be priced): the job is flagged `mismatch`.
       */
      fallback: boolean;
    };

/** What shows that a job RAN even when its Tapis record gives no start time. */
export function runEvidenced(
  job: Pick<ComputeJobRow, "results_bytes" | "outputs_completed_at">,
  rec: TapisJob | null,
): boolean {
  return (
    rec?.status === "FINISHED" || job.results_bytes !== null || job.outputs_completed_at !== null
  );
}

/**
 * What a job's provisional settlement is, from the Tapis record (design section 5). ONLY A JOB THAT
 * NEVER STARTED IS RELEASED (the owner's rule), and a job that ran can never be released: a release
 * closes the hold, and the ledger then refuses a charge, so a wrong release is permanent.
 *  - the record has a start time that parses: `suMilliFor` over the record's resources and the seconds
 *    from `remoteStarted` to `remoteEnded` (the record's `ended`, then now, when the end is missing),
 *    rounded up, never negative. The record's resources are used when they are whole numbers and the
 *    row's otherwise; the partition and the GPUs are the row's (the record names neither);
 *  - the record has a start time that is NOT a time (a non-empty string that does not parse): the
 *    record cannot be read, so the hold is charged and the job is flagged (fail closed);
 *  - the record has NO start time: release, unless something shows the job ran (Tapis says FINISHED, or
 *    the launcher reached the Worker: it claimed bytes or completed an upload), and then the contract's
 *    minimum is charged and the job is flagged `mismatch`;
 *  - a rate that cannot be priced charges the hold and flags the job, because a failure of the
 *    arithmetic must not give compute away. Pure.
 */
export function provisionalCharge(
  job: Pick<
    ComputeJobRow,
    | "partition"
    | "nodes"
    | "cores_per_node"
    | "memory_mb"
    | "gpus"
    | "held_milli"
    | "results_bytes"
    | "outputs_completed_at"
  >,
  rec: TapisJob | null,
  nowMs: number = Date.now(),
): Provisional {
  const startedRaw = rec?.remoteStarted;
  const started = parseMs(startedRaw);
  if (rec !== null && typeof startedRaw === "string" && startedRaw !== "" && started === null) {
    return { kind: "charge", milli: job.held_milli, seconds: 0, fallback: true };
  }
  if (rec === null || started === null) {
    if (!runEvidenced(job, rec)) return { kind: "release" };
    return { kind: "charge", milli: RATE_TABLE_V1.minChargeMilli, seconds: 0, fallback: true };
  }
  const ended = parseMs(rec.remoteEnded) ?? parseMs(rec.ended) ?? nowMs;
  const seconds = Math.max(0, Math.ceil((ended - started) / 1000));
  const memory = wholeOrNull(rec.memoryMB, 1) ?? job.memory_mb ?? undefined;
  try {
    const milli = suMilliFor(
      job.partition as PartitionName,
      {
        nodes: wholeOrNull(rec.nodeCount, 1) ?? job.nodes,
        cores: wholeOrNull(rec.coresPerNode, 1) ?? job.cores_per_node,
        ...(memory === undefined ? {} : { memory_mb: memory }),
        gpus: job.gpus,
      },
      seconds,
    );
    return { kind: "charge", milli, seconds, fallback: false };
  } catch {
    return { kind: "charge", milli: job.held_milli, seconds, fallback: true };
  }
}

// --- The terminal batch --------------------------------------------------------------------------

/** What a terminal transition writes, decided before the batch is built. */
export interface TerminalPlan {
  to: "finished" | "failed" | "cancelled";
  failureCode: ComputeFailureCode | null;
  failureDetail: ComputeFailureDetail | null;
  cancelReason: string | null;
  platformFailure: boolean;
  /** Tapis said FINISHED and the results were verified. */
  verified: boolean;
  /** The launcher's documents disagreed with what NEMAR knows (or the rate could not be priced). */
  mismatch: boolean;
  tapisStatus: string | null;
  remoteSubmittedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  slurmJobId: string | null;
  settlement: Provisional;
  /** The job was never submitted: the statement refuses a row that has a Tapis job. */
  unsubmittedOnly: boolean;
}

/**
 * Commit a terminal transition and its settlement as ONE batch. The first statement is the state
 * change `WHERE state = <from>`; the settlement (a charge, or a release for a job that never started)
 * is gated on the job row having taken the new state and not being settled; the third stamps what was
 * settled. Returns true when THIS writer won the transition: a job some other writer already moved
 * changes nothing here and answers false, and it is that writer's batch that settled it.
 */
async function commitTerminal(
  env: Bindings,
  job: ComputeJobRow,
  plan: TerminalPlan,
  recordsRetentionYears: number,
): Promise<boolean> {
  const db = env.DB;
  const gate = { sql: SETTLEMENT_GATE_SQL, binds: [job.id, plan.to] };
  const settle =
    plan.settlement.kind === "release"
      ? releaseStatements(db, { jobId: job.id }, gate)
      : settleStatements(db, { jobId: job.id, chargeMilli: plan.settlement.milli }, gate);
  const results = await db.batch([
    db
      .prepare(TERMINAL_TRANSITION_SQL)
      .bind(
        job.id,
        job.state,
        plan.to,
        plan.failureCode,
        plan.failureDetail,
        plan.cancelReason,
        plan.platformFailure ? 1 : 0,
        plan.verified ? 1 : 0,
        plan.mismatch ? 1 : 0,
        plan.tapisStatus,
        plan.remoteSubmittedAt,
        plan.startedAt,
        plan.endedAt,
        plan.slurmJobId,
        `+${recordsRetentionYears} years`,
        plan.unsubmittedOnly ? 1 : 0,
      ),
    ...settle,
    db.prepare(SETTLED_STAMP_SQL).bind(job.id, plan.to),
    // The report ACCESS is owed for a job whose record first shows its Slurm id at its END (phase A8,
    // #2013): the same batch as the write that gave the row the id, `OR IGNORE`, and no network call.
    ...(plan.slurmJobId === null ? [] : [db.prepare(ACCESS_REPORT_PENDING_SQL).bind(job.id)]),
  ]);
  return (results[0]?.meta?.changes ?? 0) === 1;
}

/** The settlement alone, for a terminal row whose first batch could not settle it (the repair). */
async function commitSettlementOnly(
  env: Bindings,
  job: ComputeJobRow,
  settlement: Provisional,
): Promise<void> {
  const db = env.DB;
  const gate = { sql: SETTLEMENT_GATE_SQL, binds: [job.id, job.state] };
  const settle =
    settlement.kind === "release"
      ? releaseStatements(db, { jobId: job.id }, gate)
      : settleStatements(db, { jobId: job.id, chargeMilli: settlement.milli }, gate);
  await db.batch([...settle, db.prepare(SETTLED_STAMP_SQL).bind(job.id, job.state)]);
}

// --- Reading what ended --------------------------------------------------------------------------

async function recordsRetentionYears(env: Bindings): Promise<number> {
  return (await getPolicy(env.DB)).policy.retention.recordsYears;
}

/** The byte bound for one launcher document: the outputs body's bound for the owner's `maxFiles`. */
async function launcherDocumentLimit(env: Bindings): Promise<number> {
  try {
    return outputsBodyLimitBytes((await getPolicy(env.DB)).policy.resultLimits.maxFiles);
  } catch {
    return OUTPUTS_BODY_CEILING_BYTES;
  }
}

/**
 * What a Tapis `FAILED` job's failure is: the Worker's own recorded refusal first (the outputs route
 * recorded a result refusal as `failure_detail`, which the launcher's `result_upload_failed` carries
 * too), then the launcher's `result.json` when it is TRUSTED (this job's id, an exit number that agrees
 * with the one Tapis reports, and a provenance, when there is one, whose launch specification digest is
 * the one NEMAR stored), else the Tapis termination condition. `tapisjob.out` is never read for this.
 */
async function resolveFailure(
  env: Bindings,
  job: ComputeJobRow,
  rec: TapisJob,
): Promise<{
  code: ComputeFailureCode;
  detail: ComputeFailureDetail | null;
  mismatch: boolean;
  cancelledByUs: boolean;
}> {
  const refusal = resultRefusalOf(job.failure_detail);
  let mismatch = false;
  let code: ComputeFailureCode | null = null;
  let detail: ComputeFailureDetail | null = null;
  if (refusal === null && env.COMPUTE_RESULTS) {
    const docs = await readLauncherDocs(
      env.COMPUTE_RESULTS,
      job.id,
      await launcherDocumentLimit(env),
    );
    if (docs.result.kind === "ok") {
      const result = docs.result.value;
      const tapisExit = tapisExitCode(rec);
      const provenanceBad =
        docs.provenance.kind === "ok" &&
        (docs.provenance.value.job_id !== job.id ||
          job.launch_spec_digest === null ||
          docs.provenance.value.launch_spec_digest !== job.launch_spec_digest);
      const exitBad = tapisExit !== null && tapisExit !== result.exit_number;
      if (result.job_id !== job.id || provenanceBad || exitBad) mismatch = true;
      else if (result.failure_code !== null) {
        code = result.failure_code;
        // The launcher's own fixed word: declared for its code or not, kept as said (a transport word,
        // say), and the one place such a word is accepted as a detail.
        detail = result.detail as ComputeFailureDetail | null;
      }
    }
  }
  // The Worker's own cancel record overrules the launcher's `terminated` detail: the launcher cannot
  // tell a cancel by the person from a Slurm preemption (ADR 0118, decision 13 of its Decision section).
  const cancelledByUs =
    job.cancel_requested_at !== null && code === "runtime_error" && detail === "terminated";
  if (refusal !== null)
    return { code: "result_upload_failed", detail: refusal, mismatch, cancelledByUs };
  return {
    code: code ?? failureCodeFromTapisCondition(rec.condition),
    detail: code === null ? null : detail,
    mismatch,
    cancelledByUs,
  };
}

/** The plan for a Tapis record that says the job ended; `null` for one that has not. */
async function planFromTapis(
  env: Bindings,
  job: ComputeJobRow,
  rec: TapisJob,
  nowMs: number,
): Promise<TerminalPlan | null> {
  const target = stateFromTapisStatus(rec.status);
  if (target !== "finished" && target !== "failed" && target !== "cancelled") return null;
  const settlement = provisionalCharge(job, rec, nowMs);
  const base = {
    tapisStatus: rec.status,
    remoteSubmittedAt: sqliteTime(rec.remoteSubmitted),
    startedAt: sqliteTime(rec.remoteStarted),
    endedAt: sqliteTime(rec.remoteEnded) ?? sqliteTime(rec.ended),
    slurmJobId:
      typeof rec.remoteJobId === "string" && rec.remoteJobId !== "" ? rec.remoteJobId : null,
    settlement,
    unsubmittedOnly: false,
    failureCode: null,
    failureDetail: null,
    cancelReason: null,
    platformFailure: false,
    verified: false,
    mismatch: settlement.kind === "charge" && settlement.fallback,
  };
  if (target === "cancelled") {
    return { ...base, to: "cancelled", cancelReason: job.cancel_reason ?? "scheduler" };
  }
  if (target === "failed") {
    const failure = await resolveFailure(env, job, rec);
    if (failure.cancelledByUs) {
      return { ...base, to: "cancelled", cancelReason: job.cancel_reason ?? "user" };
    }
    return {
      ...base,
      to: "failed",
      failureCode: failure.code,
      failureDetail: failure.detail,
      platformFailure: isPlatformFailure(failure.code, failure.detail),
      mismatch: base.mismatch || failure.mismatch,
    };
  }
  // Tapis says FINISHED: it stands only after the upload is verified.
  if (!env.COMPUTE_RESULTS || !env.COMPUTE_RECORDS) {
    return {
      ...base,
      to: "failed",
      failureCode: "records_unavailable",
      failureDetail: RECORDS_UNREADABLE,
      platformFailure: true,
    };
  }
  const verdict = await verifyResults(
    env.COMPUTE_RESULTS,
    env.COMPUTE_RECORDS,
    job,
    rec,
    await launcherDocumentLimit(env),
  );
  if (verdict.ok) return { ...base, to: "finished", verified: true };
  // A Worker-recorded refusal is the reason a launcher that was refused did not complete.
  const refusal = resultRefusalOf(job.failure_detail);
  const code: ComputeFailureCode = refusal !== null ? "result_upload_failed" : verdict.code;
  const detail: ComputeFailureDetail = refusal ?? verdict.reason;
  return {
    ...base,
    to: "failed",
    failureCode: code,
    failureDetail: detail,
    platformFailure: isPlatformFailure(code, detail),
    mismatch: base.mismatch || verdict.mismatch,
  };
}

// --- applyTapisJob -------------------------------------------------------------------------------

export type ApplyOutcome =
  | "advanced"
  | "refreshed"
  | "terminal_committed"
  | "terminal"
  | "stale"
  | "lost"
  | "unknown_status"
  | "record_mismatch";

export interface ApplyResult {
  /** This call moved the row (or settled it). */
  changed: boolean;
  /** The state the row is believed to be in after the call. */
  state: ComputeState;
  outcome: ApplyOutcome;
  /** The call made the job `finished`, so the caller may tell the person. */
  becameFinished: boolean;
}

/**
 * THE ONE TRANSITION FUNCTION, for a webhook, the 30-minute tick, a cancel and an administrator's
 * command: given the job row and the Tapis record just read for it, take the job to the state the
 * record's status maps to, if the edge exists, writing with `WHERE id = ? AND state = <from>`. A
 * self-edge refreshes `tapis_status`, `tapis_synced_at` and the times only. A terminal status runs the
 * verification first (for `FINISHED`) and commits the transition with its settlement as one batch; the
 * copy of the launcher's files into the records follows the commit, and the caller tells the person.
 * A row that is already terminal changes nothing, except that one whose settlement is still owed is
 * settled now (the repair).
 *
 * Idempotent and order-insensitive by construction: replaying a record, applying an older one after a
 * newer, and applying the same one from two places at once each leave one final state and, at most,
 * one ledger entry.
 */
export async function applyTapisJob(
  env: Bindings,
  job: ComputeJobRow,
  rec: TapisJob,
  nowMs: number = Date.now(),
): Promise<ApplyResult> {
  // A write that lost to a concurrent LIVE write (a poll moved the job from `queued` to `running` while
  // a terminal hint held the `queued` row) must not drop the hint for 30 minutes or more: the row is
  // read again and the same record applied while the job is still not terminal. A concurrent write that
  // made the job terminal is the end of it: that writer settled it.
  let current = job;
  for (let attempt = 0; ; attempt++) {
    const result = await applyOnce(env, current, rec, nowMs);
    if (result.outcome !== "lost" || attempt >= LOST_WRITE_RETRIES) return result;
    const fresh = await getJob(env.DB, job.id);
    if (!fresh || isTerminalComputeState(fresh.state)) return result;
    current = fresh;
  }
}

/** How many times a write that lost to a concurrent live write is tried again. */
export const LOST_WRITE_RETRIES = 2;

async function applyOnce(
  env: Bindings,
  job: ComputeJobRow,
  rec: TapisJob,
  nowMs: number,
): Promise<ApplyResult> {
  const unchanged = (outcome: ApplyOutcome, state = job.state): ApplyResult => ({
    changed: false,
    state,
    outcome,
    becameFinished: false,
  });
  if (job.tapis_uuid !== null && rec.uuid !== job.tapis_uuid) return unchanged("record_mismatch");

  if (isTerminalComputeState(job.state)) {
    if (job.settled_provisional_at === null) {
      const repaired = await repairSettlement(env, job, rec, nowMs);
      if (repaired)
        return { changed: true, state: job.state, outcome: "terminal", becameFinished: false };
    }
    return unchanged("terminal");
  }

  const target = stateFromTapisStatus(rec.status);
  if (target === null) return unchanged("unknown_status");

  if (!isTerminalComputeState(target)) {
    if (!canTransitionCompute(job.state, target)) return unchanged("stale");
    const slurm =
      typeof rec.remoteJobId === "string" && rec.remoteJobId !== "" ? rec.remoteJobId : null;
    // THE SLURM ID HOOK (phase A8, #2013): the report ACCESS is owed for a job is made in the SAME BATCH
    // as the write that gives the row its Slurm id, so a job that shows an id always owes one report
    // and the two can never disagree. It is `INSERT OR IGNORE` and reads the job row, so this write
    // (which runs on every live read, a self-edge included) adds nothing the second time. Nothing here
    // calls ACCESS: the report is sent later, by `runAccessReportCron`, never inside a batch.
    const live = env.DB.prepare(LIVE_TRANSITION_SQL).bind(
      job.id,
      job.state,
      target,
      rec.status,
      sqliteTime(rec.remoteSubmitted),
      sqliteTime(rec.remoteStarted),
      slurm,
    );
    const wrote =
      slurm === null
        ? await live.run()
        : (await env.DB.batch([live, env.DB.prepare(ACCESS_REPORT_PENDING_SQL).bind(job.id)]))[0];
    if ((wrote?.meta?.changes ?? 0) !== 1) return unchanged("lost");
    return {
      changed: job.state !== target,
      state: target,
      outcome: job.state === target ? "refreshed" : "advanced",
      becameFinished: false,
    };
  }

  const plan = await planFromTapis(env, job, rec, nowMs);
  if (plan === null) return unchanged("unknown_status");
  if (!canTransitionCompute(job.state, plan.to)) return unchanged("stale");
  const won = await commitTerminal(env, job, plan, await recordsRetentionYears(env));
  if (!won) return unchanged("lost");
  const done = (await getJob(env.DB, job.id)) ?? job;
  await afterTerminal(env, done, plan);
  return {
    changed: true,
    state: plan.to,
    outcome: "terminal_committed",
    becameFinished: plan.to === "finished",
  };
}

/**
 * What follows a terminal commit, none of it part of it: the launcher's files and the logs are copied
 * into the records (a failure leaves `result_records_at` NULL for the tick to retry), and a finished
 * job's person is told. Neither may fail the transition.
 */
async function afterTerminal(env: Bindings, job: ComputeJobRow, plan: TerminalPlan): Promise<void> {
  try {
    await copyResultRecords(env, job);
  } catch (err) {
    console.error(
      `[compute-lifecycle] records_copy_failed job=${job.id} class=${errorClassName(err)}`,
    );
  }
  if (plan.to === "finished") {
    try {
      await sendComputeResultsReadyEmail(env, job);
    } catch (err) {
      console.error(`[compute-lifecycle] mail_failed job=${job.id} class=${errorClassName(err)}`);
    }
  }
}

/** A terminal row whose settlement is owed is settled from the record it ended with. */
async function repairSettlement(
  env: Bindings,
  job: ComputeJobRow,
  rec: TapisJob | null,
  nowMs: number,
): Promise<boolean> {
  const settlement = provisionalCharge(job, rec, nowMs);
  await commitSettlementOnly(env, job, settlement);
  const after = await getJob(env.DB, job.id);
  return after !== null && after.settled_provisional_at !== null;
}

// --- Records copy --------------------------------------------------------------------------------

/**
 * Copy a terminal job's launcher files and logs into the records bucket, through the bindings, and
 * stamp `result_records_at`: `result.json`, `provenance.json` and the manifest (as
 * `result-manifest.json`) from `jobs/<id>/launcher/` into `records/<id>/`, `launcher.log` into
 * `logs/<id>/`, and Tapis's `tapisjob.out` (the entry's own stdout and stderr, at most 5 MiB) into
 * `logs/<id>/`. A source that is not there is nothing to copy (a job that never ran has none), a
 * launcher document larger than the bound is skipped, a log is copied only up to 5 MiB, and NOTHING
 * IS EVER OVERWRITTEN: an object already in the records stays as it is, so a copy that died halfway is
 * finished by the next call and a rewrite is not attempted. `tapisjob.out` is untrusted and is only
 * copied, never parsed. A Tapis failure other than a missing or unusable file throws, leaving the row
 * unstamped for a retry. Returns the number of objects written.
 */
export async function copyResultRecords(env: Bindings, job: ComputeJobRow): Promise<number> {
  if (!env.COMPUTE_RECORDS || !env.COMPUTE_RESULTS) {
    throw new Error("the compute buckets are not bound");
  }
  const results = env.COMPUTE_RESULTS;
  const limit = await launcherDocumentLimit(env);
  let written = 0;

  const files: Array<{ name: LauncherFileName; to: string; cap: number; truncate: boolean }> = [
    {
      name: LAUNCHER_FILES.result,
      to: recordKey(job.id, "result.json"),
      cap: limit,
      truncate: false,
    },
    {
      name: LAUNCHER_FILES.provenance,
      to: recordKey(job.id, "provenance.json"),
      cap: limit,
      truncate: false,
    },
    {
      name: LAUNCHER_FILES.manifest,
      to: recordKey(job.id, RECORDS_RESULT_MANIFEST_FILE),
      cap: limit,
      truncate: false,
    },
    {
      name: LAUNCHER_FILES.log,
      to: logKey(job.id, "launcher.log"),
      cap: LOG_COPY_MAX_BYTES,
      truncate: true,
    },
  ];
  for (const file of files) {
    const key = resultsLauncherKey(job.id, file.name);
    const info = await results.head(key);
    if (!info) continue;
    // A document over its bound is not one the launcher wrote; a log is copied up to its bound.
    if (info.size > file.cap && !file.truncate) continue;
    const cut = info.size > file.cap;
    const object = cut
      ? await results.get(key, { range: { offset: 0, length: file.cap } })
      : await results.get(key);
    if (!object) continue;
    const bytes = new Uint8Array(await object.arrayBuffer());
    const contentType = file.truncate ? "text/plain" : "application/json";
    if (await putRecordOnce(env, file.to, bytes, contentType, cut ? TRUNCATED_NOTE : undefined)) {
      written++;
    }
  }

  if (job.tapis_uuid !== null && TAPIS_JOB_UUID_RE.test(job.tapis_uuid)) {
    const ctx = tapisAccess(env, REQUEST_READ);
    if (ctx === null) throw new Error("the Tapis tenant is not configured");
    let log: { bytes: Uint8Array; truncated: boolean } | null = null;
    try {
      log = await downloadOutputPrefix(ctx, job.tapis_uuid, "tapisjob.out", LOG_COPY_MAX_BYTES);
    } catch (err) {
      // Only a log that does not exist is skipped (the job wrote none). Anything else, a timeout, a
      // refusal or an answer that is not a file, may clear: it throws, the copy stays OWED, and a later
      // tick asks again, so a log that could not be read is never stamped as copied.
      if (!(err instanceof TapisError) || err.kind !== "not_found") throw err;
    }
    if (
      log !== null &&
      (await putRecordOnce(
        env,
        logKey(job.id, "tapisjob.out"),
        log.bytes,
        "text/plain",
        log.truncated ? TRUNCATED_NOTE : undefined,
      ))
    ) {
      written++;
    }
  }

  await env.DB.prepare(
    `UPDATE compute_jobs SET result_records_at = datetime('now')
      WHERE id = ?1 AND result_records_at IS NULL AND state IN (${TERMINAL_STATES_SQL})`,
  )
    .bind(job.id)
    .run();
  return written;
}

// --- Submit --------------------------------------------------------------------------------------

export type SubmitOutcome =
  | "submitted"
  | "bound"
  | "already_submitted"
  | "compute_disabled"
  | "job_not_found"
  | "bad_state"
  | "records_not_written"
  | "unconfigured"
  | "unavailable"
  | "ambiguous"
  | "in_progress"
  | "failed";

export interface SubmitResult {
  ok: boolean;
  outcome: SubmitOutcome;
}

const submitted = (outcome: "submitted" | "bound" | "already_submitted"): SubmitResult => ({
  ok: true,
  outcome,
});
const refused = (outcome: Exclude<SubmitOutcome, "submitted" | "bound" | "already_submitted">) => ({
  ok: false,
  outcome,
});

/**
 * The launch specification as it is sent and what the row records of it. Never logged, never returned.
 * `env` is the `NEMAR_LAUNCH_SPEC` value (the specification's text in base64url, A1c); `digest` is the
 * SHA-256 of the TEXT the launcher decodes it to, never of `env`.
 */
interface BuiltLaunch {
  env: string;
  digest: string;
  imageDigest: string;
}

type BuildResult =
  | { ok: true; launch: BuiltLaunch }
  | { ok: false; why: "unconfigured" | "unbuildable" };

/**
 * Build the launch specification for a job (`nemar.launch-spec.v1`): from the job's RECORDED
 * specification (read back from the records bucket and accepted only if its bytes are the ones whose
 * digest the row holds), each dataset version as its data-plane tag (`dataTagForVersion`; a null
 * refuses the job here, never at the launcher), the image (the job's own for an `image` runtime, the
 * Worker's configured runtime image for `python`, the Singularity image file named for its digest), the
 * allowlisted environment, the GPUs, the staging limits, the API base the launcher calls, and the
 * per-job token (`compute-job`, valid until the job is terminal). The text is ASCII-only JSON within 64
 * KiB (`encodeLaunchSpec`), and its SHA-256 is the `launch_spec_digest` the row records. What is sent
 * is that text in base64url (`encodeLaunchSpecEnv`), the shell-inert value of `NEMAR_LAUNCH_SPEC`: the
 * digest is over the text, which is what the launcher decodes and hashes, and never over the value.
 *
 * `limits.max_total_bytes` bounds the dataset selection and NOT the outputs: the Worker's per-job
 * results limit is `resultLimits.maxJobBytes` and the outputs route enforces it; the two numbers are
 * never one.
 */
async function buildLaunch(env: Bindings, job: ComputeJobRow): Promise<BuildResult> {
  const secret = env.PRESCREEN_CALLBACK_SECRET;
  const apiBase = (env.API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!secret || apiBase === "" || job.webhook_nonce === null || !env.COMPUTE_RECORDS) {
    return { ok: false, why: "unconfigured" };
  }
  const spec: JobSpec | null = await readRecordedSpec(env.COMPUTE_RECORDS, job);
  if (spec === null || spec.runtime === "matlab") return { ok: false, why: "unbuildable" };

  let image: ImageFacts | null;
  if (spec.runtime === "image") {
    if (spec.image === undefined) return { ok: false, why: "unbuildable" };
    image = imageFacts(spec.image);
    if (image === null) return { ok: false, why: "unbuildable" };
  } else {
    const configured = readRuntimeImage(env);
    if (configured.state !== "ok") return { ok: false, why: "unconfigured" };
    image = configured;
  }
  const { ref: imageRef, digest, sif } = image;

  const datasets = spec.datasets.map((d) => ({
    id: d.id,
    version: dataTagForVersion(d.version),
    ...(d.include === undefined ? {} : { include: d.include }),
  }));
  const token = await signComputeToken("job", { jobId: job.id, nonce: job.webhook_nonce }, secret);
  try {
    const text = encodeLaunchSpec({
      job_id: job.id,
      runtime: spec.runtime === "image" ? "image" : "python",
      ...(spec.entry === undefined ? {} : { entry: spec.entry }),
      ...(spec.command === undefined ? {} : { command: spec.command }),
      args: spec.args,
      ...(spec.bundle === undefined
        ? {}
        : { bundle: { sha256: spec.bundle.sha256, size: spec.bundle.size } }),
      datasets,
      api_base: apiBase,
      image: { uri: imageRef, digest, sif },
      env: spec.env,
      resources: { gpus: job.gpus },
      limits: {
        max_files: LAUNCH_DATASET_LIMITS.maxFiles,
        max_total_bytes: LAUNCH_DATASET_LIMITS.maxTotalBytes,
      },
      job_token: token,
    });
    return {
      ok: true,
      launch: {
        env: encodeLaunchSpecEnv(text),
        digest: await sha256Hex(new TextEncoder().encode(text)),
        imageDigest: digest,
      },
    };
  } catch {
    // The text is not a valid launch specification (a recipe job that names no entry or command, a
    // dataset version with no tag): the job cannot launch, and no message says what it held.
    return { ok: false, why: "unbuildable" };
  }
}

/** The data every terminal write for a job that never reached Tapis shares. */
function unsubmittedPlan(
  job: ComputeJobRow,
  to: "failed" | "cancelled",
  code: ComputeFailureCode | null,
  detail: ComputeFailureDetail | null,
): TerminalPlan {
  return {
    to,
    failureCode: code,
    failureDetail: detail,
    cancelReason: to === "cancelled" ? (job.cancel_reason ?? "user") : null,
    platformFailure: code !== null && isPlatformFailure(code, detail),
    verified: false,
    mismatch: false,
    tapisStatus: null,
    remoteSubmittedAt: null,
    startedAt: null,
    endedAt: null,
    slurmJobId: null,
    // Never started on the scheduler: the whole hold is released, nothing is charged or refunded.
    settlement: { kind: "release" },
    unsubmittedOnly: true,
  };
}

/** End a job that never reached Tapis: failed (the hold is released) or cancelled. True if this call did it. */
async function endUnsubmitted(
  env: Bindings,
  job: ComputeJobRow,
  to: "failed" | "cancelled",
  code: ComputeFailureCode | null,
  detail: ComputeFailureDetail | null,
): Promise<boolean> {
  const won = await commitTerminal(
    env,
    job,
    unsubmittedPlan(job, to, code, detail),
    await recordsRetentionYears(env),
  );
  if (won) {
    const done = (await getJob(env.DB, job.id)) ?? job;
    try {
      await copyResultRecords(env, done);
    } catch (err) {
      console.error(
        `[compute-lifecycle] records_copy_failed job=${job.id} class=${errorClassName(err)}`,
      );
    }
  }
  return won;
}

/** The webhook subscription of a bound job: a hint only, so a failure is a fixed word and nothing more. */
async function subscribe(
  env: Bindings,
  ctx: TapisContext,
  job: ComputeJobRow,
  uuid: string,
): Promise<void> {
  const secret = env.PRESCREEN_CALLBACK_SECRET;
  const apiBase = (env.API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!secret || apiBase === "" || job.webhook_nonce === null) return;
  try {
    const token = await signComputeToken(
      "webhook",
      { jobId: job.id, nonce: job.webhook_nonce },
      secret,
    );
    const ttl = Math.min(WEBHOOK_TTL_MAX_MINUTES, job.minutes + 24 * 60);
    await subscribeWebhook(ctx, uuid, `${apiBase}/webhooks/tapis/${job.id}/${token}`, ttl);
  } catch (err) {
    // Never retried: a lost answer would make a second subscription, which cannot be deduplicated.
    // The backstop poll carries the job either way.
    console.warn(`[compute-lifecycle] subscribe_failed job=${job.id} kind=${tapisWord(err)}`);
  }
}

/**
 * Cancel a Tapis job NEMAR made that no row owns, and clear the record of it once that is known to have
 * worked: the cancel was accepted, Tapis says the job is already over (409) or says there is no such job.
 * Any other failure leaves `orphan_tapis_uuid` set, and the next tick tries again. True when cleared.
 */
async function cancelOrphan(
  env: Bindings,
  ctx: TapisContext,
  jobId: string,
  uuid: string,
): Promise<boolean> {
  try {
    await cancelJob(ctx, uuid);
  } catch (err) {
    const settled =
      err instanceof TapisError && (err.kind === "rejected" || err.kind === "not_found");
    if (!settled) {
      console.warn(`[compute-lifecycle] orphan_cancel_failed job=${jobId} kind=${tapisWord(err)}`);
      return false;
    }
  }
  await env.DB.prepare(CLEAR_ORPHAN_SQL).bind(jobId, uuid).run();
  return true;
}

/**
 * The retry of a recorded orphan: the tick calls it for every row with `orphan_tapis_uuid` set. Never
 * throws for what Tapis does; true when the orphan is cleared.
 */
export async function retryOrphanCancel(
  env: Bindings,
  jobId: string,
  mode: { maxAttempts: number; timeoutMs: number },
): Promise<boolean> {
  const row = await getJob(env.DB, jobId);
  if (!row || row.orphan_tapis_uuid === null) return false;
  const ctx = tapisAccess(env, mode);
  if (ctx === null) return false;
  return cancelOrphan(env, ctx, row.id, row.orphan_tapis_uuid);
}

/**
 * Bind a Tapis job to a row that has none: `tapis_uuid`, its status, `submitted`. A bind that changes
 * no row means the row is not the one it was read as, and the answer depends on WHAT it now holds:
 *  - the SAME uuid: another path (an adoption by tag, a webhook's read-back) bound this very Tapis job
 *    first. Nothing is wrong and nothing is cancelled (`already`);
 *  - ANOTHER uuid: this Tapis job is a duplicate of the one the row owns. It is recorded as an orphan and
 *    cancelled, and the job is flagged `mismatch`;
 *  - NO uuid, and the row has ended or has a cancel pending (a cancel or a timeout won while Tapis was
 *    creating the job): the row learns the uuid, which is recorded as an orphan and cancelled, so none
 *    is left running for a job NEMAR has ended.
 * The orphan is written to the row BEFORE the cancel is asked, so a cancel that fails is retried by the
 * tick and never forgotten.
 */
async function bindTapisJob(
  env: Bindings,
  ctx: TapisContext,
  job: ComputeJobRow,
  rec: TapisJob,
): Promise<"bound" | "already" | "orphaned" | "ambiguous"> {
  if (!TAPIS_JOB_UUID_RE.test(rec.uuid)) return "ambiguous";
  try {
    const bound = await env.DB.prepare(BIND_TAPIS_JOB_SQL)
      .bind(job.id, rec.uuid, rec.status, sqliteTime(rec.remoteSubmitted))
      .run();
    if ((bound.meta?.changes ?? 0) === 1) {
      await subscribe(env, ctx, job, rec.uuid);
      return "bound";
    }
  } catch (err) {
    if (looksUnique(err)) return "ambiguous";
    throw err;
  }
  const now = await getJob(env.DB, job.id);
  if (now?.tapis_uuid === rec.uuid) return "already";
  if (now?.tapis_uuid != null) await env.DB.prepare(FLAG_MISMATCH_SQL).bind(job.id).run();
  else await env.DB.prepare(BIND_ORPHAN_UUID_SQL).bind(job.id, rec.uuid).run();
  await env.DB.prepare(SET_ORPHAN_SQL).bind(job.id, rec.uuid).run();
  await cancelOrphan(env, ctx, job.id, rec.uuid);
  return "orphaned";
}

/**
 * Submit a job to Tapis, idempotently. In order:
 *  1. the row, and that the job may be submitted: it exists, is `created` (or `uploading`), is NEMAR's
 *     to submit (a partner submits its own), has no Tapis job, has no cancel pending, and has its
 *     records written (`records_written_at`);
 *  2. the SUBMITTER'S LEASE (`CLAIM_SUBMIT_SQL`), one conditional UPDATE: only the submitter that
 *     changed the row goes on, so two submitters cannot both reach Tapis;
 *  3. a SEARCH BY TAG (`nemar_job:<id>`) before anything is sent: one hit is bound instead of a
 *     submit, two are a duplicate (nothing is submitted and the job is flagged), none goes on;
 *  4. a `created` row older than the policy's reservation wait, with no Tapis job, fails
 *     `submit_timeout` and its hold is released: this needs no switch, so a job does not wait for ever
 *     because compute is off;
 *  5. THE SWITCH, read here and nowhere else in the lifecycle, and only now: it guards the call that
 *     creates something at Tapis, not the search, the bind of a job that exists or the timeout;
 *  6. the launch specification is built and its SHA-256 written to the row in a conditional UPDATE
 *     BEFORE the call to Tapis (a retry that finds nothing overwrites it: the policy's limits can have
 *     changed), then the job is submitted with no archive fields, owned by the NEMAR service identity;
 *  7. a 4xx rejection fails the job `tapis_submit_failed` and releases the hold; an unavailable or
 *     unclear Tapis leaves the row `created` for the next tick, which searches by tag first (a 2xx
 *     answer that fails its schema means the job may exist);
 *  8. one conditional UPDATE binds `tapis_uuid` and moves `created` to `submitted`, and a webhook is
 *     subscribed (a hint, never retried).
 * The lease is released when the attempt ends, whatever it ended in.
 */
export async function submitComputeJob(
  env: Bindings,
  jobId: string,
  nowMs: number = Date.now(),
): Promise<SubmitResult> {
  const row = await getJob(env.DB, jobId);
  if (!row) return refused("job_not_found");
  if (row.tapis_uuid !== null) return submitted("already_submitted");
  if (row.source === "partner" || (row.state !== "created" && row.state !== "uploading")) {
    return refused("bad_state");
  }
  if (row.cancel_requested_at !== null) return refused("bad_state");

  let policy: Awaited<ReturnType<typeof getPolicy>>["policy"];
  try {
    policy = (await getPolicy(env.DB)).policy;
  } catch {
    return refused("unavailable");
  }
  const overdue = ageMinutes(row.created_at, nowMs) > policy.reservationWaitMinutes;
  if (row.records_written_at === null && !overdue) return refused("records_not_written");

  const ctx = tapisAccess(env, TICK_READ);
  if (ctx === null) return refused("unconfigured");

  const stamp = claimStamp(Date.now());
  const leased = await env.DB.prepare(CLAIM_SUBMIT_SQL).bind(row.id, stamp).run();
  if ((leased.meta?.changes ?? 0) !== 1) return refused("in_progress");
  try {
    return await submitLeased(env, ctx, row, overdue, nowMs);
  } finally {
    await env.DB.prepare(RELEASE_SUBMIT_SQL)
      .bind(row.id, stamp)
      .run()
      .catch(() => undefined);
  }
}

async function submitLeased(
  env: Bindings,
  ctx: TapisContext,
  row: ComputeJobRow,
  overdue: boolean,
  nowMs: number,
): Promise<SubmitResult> {
  // 3. A search by tag, before any submit: the outcome of an earlier submit may be unknown.
  let found: TapisJob[];
  try {
    found = await searchJobsByTag(ctx, nemarJobTag(row.id));
  } catch (err) {
    console.warn(`[compute-lifecycle] tag_search_failed job=${row.id} kind=${tapisWord(err)}`);
    return refused("unavailable");
  }
  if (found.length > 1) {
    await env.DB.prepare(FLAG_MISMATCH_SQL).bind(row.id).run();
    console.error(`[compute-lifecycle] tag_ambiguous job=${row.id} count=${found.length}`);
    return refused("ambiguous");
  }
  const existing = found[0];
  if (existing !== undefined) return adopt(env, ctx, row, existing, nowMs);

  // 4. Nothing at Tapis and past the deadline: end the job and release the hold.
  if (overdue) {
    return (await endUnsubmitted(env, row, "failed", "submit_timeout", null))
      ? refused("failed")
      : refused("bad_state");
  }

  // 5. The switch: the one place it is read.
  if (!computeEnabled(env)) return refused("compute_disabled");

  // 6. Build, record the digest, submit.
  const built = await buildLaunch(env, row);
  if (!built.ok) {
    if (built.why === "unconfigured") return refused("unconfigured");
    console.error(`[compute-lifecycle] launch_unbuildable job=${row.id}`);
    return (await endUnsubmitted(env, row, "failed", "tapis_submit_failed", "invalid_spec"))
      ? refused("failed")
      : refused("bad_state");
  }
  // ALWAYS sent: Tapis passes a memory to the scheduler whatever it is given (its own default is 100 MB),
  // so a job that names none would be limited to that however much the hold charged it for. The figure
  // is the memory the charge pays for (`submitMemoryMb`), clamped to what the queue can schedule
  // (`QUEUE_MAX_MEMORY_MB`: a whole node's nominal memory is more than Slurm will ever hand out); a row
  // that has none to ask for cannot launch.
  let memoryMb: number;
  try {
    memoryMb = submitMemoryForQueue(row.partition as PartitionName, {
      cores: row.cores_per_node,
      memory_mb: row.memory_mb,
      gpus: row.gpus,
    });
  } catch {
    console.error(`[compute-lifecycle] launch_unbuildable job=${row.id}`);
    return (await endUnsubmitted(env, row, "failed", "tapis_submit_failed", "invalid_spec"))
      ? refused("failed")
      : refused("bad_state");
  }
  const wrote = await env.DB.prepare(LAUNCH_DIGEST_SQL)
    .bind(row.id, built.launch.digest, built.launch.imageDigest)
    .run();
  if ((wrote.meta?.changes ?? 0) !== 1) return refused("bad_state");

  let rec: TapisJob;
  try {
    rec = await submitJob(
      { ...ctx, maxAttempts: 1, timeoutMs: 15_000 },
      {
        jobId: row.id,
        appId: row.app_id,
        appVersion: row.app_version,
        partition: row.partition as PartitionName,
        nodes: row.nodes,
        coresPerNode: row.cores_per_node,
        memoryMb,
        gpus: row.gpus,
        minutes: row.minutes,
        launchSpec: built.launch.env,
      },
    );
  } catch (err) {
    if (err instanceof TapisError && (err.kind === "rejected" || err.kind === "not_found")) {
      console.error(`[compute-lifecycle] submit_rejected job=${row.id} kind=${err.kind}`);
      return (await endUnsubmitted(env, row, "failed", "tapis_submit_failed", null))
        ? refused("failed")
        : refused("bad_state");
    }
    // Unavailable, an unclear answer, a refused credential, a request that never left: the job may or
    // may not exist, and the next tick finds out with a tag search before it submits again.
    console.warn(`[compute-lifecycle] submit_unclear job=${row.id} kind=${tapisWord(err)}`);
    return refused(
      err instanceof TapisError && err.kind === "unconfigured" ? "unconfigured" : "unavailable",
    );
  }
  return adopt(env, ctx, row, rec, nowMs, "submitted");
}

/**
 * Bind a Tapis job to the row and answer. A job found by tag may already be running or over, and the
 * SEARCH record is a summary (it has no exit code), so what is applied is the FULL record, read with
 * `getJob` after the bind: the exit-number cross-check and the times come from the record a poll would
 * read. A failed read is left to the tick.
 */
async function adopt(
  env: Bindings,
  ctx: TapisContext,
  row: ComputeJobRow,
  rec: TapisJob,
  nowMs: number,
  how: "submitted" | "bound" = "bound",
): Promise<SubmitResult> {
  const result = await bindTapisJob(env, ctx, row, rec);
  if (result === "ambiguous") {
    await env.DB.prepare(FLAG_MISMATCH_SQL).bind(row.id).run();
    return refused("ambiguous");
  }
  if (result === "orphaned") return refused("bad_state");
  if (result === "already") {
    const now = await getJob(env.DB, row.id);
    return now && isTerminalComputeState(now.state)
      ? refused("bad_state")
      : submitted("already_submitted");
  }
  if (how === "bound") {
    try {
      const full = await getTapisJob(ctx, rec.uuid);
      const fresh = await getJob(env.DB, row.id);
      if (fresh) await applyTapisJob(env, fresh, full, nowMs);
    } catch (err) {
      console.warn(
        `[compute-lifecycle] adopt_readback_failed job=${row.id} kind=${tapisWord(err)}`,
      );
    }
  }
  return submitted(how);
}

// --- Cancel --------------------------------------------------------------------------------------

export interface CancelResult {
  ok: boolean;
  /** `cancel_requested` is recorded; `already_cancelled` for a replay; `bad_state` for a job that ended otherwise. */
  outcome: "cancel_requested" | "already_cancelled" | "bad_state" | "job_not_found";
  state: ComputeState | null;
}

/**
 * Record the intent to cancel (in D1, first) and then drive it. A job that never reached Tapis is
 * cancelled here and its hold released; one that did is cancelled AT TAPIS, and becomes `cancelled`
 * only when Tapis says so (a read-back follows), after which it is charged what it used. A failed call
 * to Tapis leaves the intent recorded for `sweepComputeCancellations`, which retries every tick.
 * Cancel is idempotent in effect but the client does not retry it, so an unclear answer is simply
 * asked again later.
 */
export async function requestComputeCancel(
  env: Bindings,
  jobId: string,
  reason: "user" | "admin",
): Promise<CancelResult> {
  const job = await getJob(env.DB, jobId);
  if (!job) return { ok: false, outcome: "job_not_found", state: null };
  if (job.state === "cancelled")
    return { ok: true, outcome: "already_cancelled", state: job.state };
  if (isTerminalComputeState(job.state))
    return { ok: false, outcome: "bad_state", state: job.state };
  await env.DB.prepare(CANCEL_INTENT_SQL).bind(job.id, reason).run();
  await driveCancel(env, job.id, REQUEST_READ);
  const after = await getJob(env.DB, job.id);
  return { ok: true, outcome: "cancel_requested", state: after?.state ?? job.state };
}

/**
 * Carry out a recorded cancel as far as it can go now. Never throws for what Tapis does: a failure is a
 * fixed word, and the intent stays recorded.
 */
export async function driveCancel(
  env: Bindings,
  jobId: string,
  mode: { maxAttempts: number; timeoutMs: number },
): Promise<void> {
  let job = await getJob(env.DB, jobId);
  if (!job || isTerminalComputeState(job.state) || job.cancel_requested_at === null) return;
  if (job.tapis_uuid === null) {
    if (job.state !== "created" && job.state !== "uploading") return;
    // A PARTNER'S RESERVATION is the partner contract's (phase D4), never ended here. NEMAR does not take
    // a submit lease or write a launch specification for a partner job (the partner launches its own
    // Tapis job under the reservation), so every test below, which proves that NEMAR's own submit never
    // reached Tapis, is true of such a row whether or not the partner has launched; ending it would
    // release a hold for a job that may be running. The intent stays recorded and the sweep's list leaves
    // the row out (`CANCEL_ROWS_SQL`), like `CREATED_ROWS_SQL`. Once it HAS a Tapis job it is cancelled
    // there like any other: NEMAR owns every Tapis job.
    if (job.source === "partner") return;
    // A submitter holds the lease: a Tapis job may be in flight that no search can see yet (Tapis has
    // not persisted it, or the answer has not come back). Ending the row now could release the hold for a
    // job that then appears, and if the submitter's answer is also lost nothing would ever search for it
    // again. So the intent stays recorded and the sweep carries it out: the submitter's bind turns a
    // pending cancel into an orphan cancel, and once the lease ends the sweep's tag search is the
    // authority (round 2 of #2041).
    const claimedMs = parseMs(job.submit_claimed_at);
    if (claimedMs !== null && Date.now() - claimedMs < SUBMIT_LEASE_MINUTES * 60_000) return;
    // A job that never reached Tapis is ended here, and a submit in flight meets a row it cannot bind
    // and cancels the Tapis job it made. But a job whose launch specification was written has been
    // SUBMITTED at least once, and a submit whose answer was lost may have made a Tapis job: ending the
    // row now would release the hold for a job that runs, charged to nobody. So Tapis is asked first,
    // by tag. If it cannot be asked, the cancel stays recorded for the sweep and nothing is released.
    if (job.launch_spec_digest !== null) {
      const ctx = tapisAccess(env, mode);
      if (ctx === null) return;
      let found: TapisJob[];
      try {
        found = await searchJobsByTag(ctx, nemarJobTag(job.id));
      } catch (err) {
        console.warn(
          `[compute-lifecycle] cancel_search_failed job=${job.id} kind=${tapisWord(err)}`,
        );
        return;
      }
      const first = found[0];
      if (first !== undefined && TAPIS_JOB_UUID_RE.test(first.uuid)) {
        await env.DB.prepare(BIND_ORPHAN_UUID_SQL).bind(job.id, first.uuid).run();
        for (const extra of found.slice(1)) {
          // A duplicate under one tag: every one of them is cancelled, and the job is flagged.
          await env.DB.prepare(FLAG_MISMATCH_SQL).bind(job.id).run();
          if (TAPIS_JOB_UUID_RE.test(extra.uuid)) {
            await env.DB.prepare(SET_ORPHAN_SQL).bind(job.id, extra.uuid).run();
            await cancelOrphan(env, ctx, job.id, extra.uuid);
          }
        }
        job = await getJob(env.DB, jobId);
        if (!job || job.tapis_uuid === null || isTerminalComputeState(job.state)) return;
      } else {
        await endUnsubmitted(env, job, "cancelled", null, null);
        return;
      }
    } else {
      await endUnsubmitted(env, job, "cancelled", null, null);
      return;
    }
  }
  const uuid = job.tapis_uuid as string;
  const ctx = tapisAccess(env, mode);
  if (ctx === null) return;
  try {
    await cancelJob(ctx, uuid);
  } catch (err) {
    // 409: Tapis says the job is already over, which the read-back below shows. Anything else is left
    // for the sweep (a lost answer may have cancelled it; the read-back shows that too).
    if (!(err instanceof TapisError && err.kind === "rejected")) {
      console.warn(`[compute-lifecycle] cancel_unclear job=${job.id} kind=${tapisWord(err)}`);
    }
  }
  try {
    const rec = await getTapisJob(ctx, uuid);
    const fresh = (await getJob(env.DB, job.id)) ?? job;
    await applyTapisJob(env, fresh, rec);
  } catch (err) {
    console.warn(`[compute-lifecycle] cancel_readback_failed job=${job.id} kind=${tapisWord(err)}`);
  }
}

// --- Advance -------------------------------------------------------------------------------------

export type AdvanceOutcome =
  | ApplyOutcome
  | "job_not_found"
  | "submitted"
  | "waiting"
  | "unreachable"
  | "nothing_to_do";

export interface AdvanceResult {
  outcome: AdvanceOutcome;
  job: ComputeJobRow | null;
  /** Set when a submit was attempted: what it answered. */
  submit?: SubmitOutcome;
}

/**
 * Take a job one step on, wherever it is: a `created` job with no Tapis job is submitted (or its
 * cancel carried out); one with a Tapis job is READ BACK from Tapis (one attempt, a short ceiling) and
 * given to `applyTapisJob`; a terminal job whose settlement or copy is owed is repaired. The way a job
 * advances in development, where no compute cron runs, and what a webhook, the tick and an
 * administrator's command all call. A webhook's body is never consulted.
 */
export async function advanceComputeJob(
  env: Bindings,
  jobId: string,
  options: { read?: { maxAttempts: number; timeoutMs: number }; nowMs?: number } = {},
): Promise<AdvanceResult> {
  const read = options.read ?? REQUEST_READ;
  const nowMs = options.nowMs ?? Date.now();
  const job = await getJob(env.DB, jobId);
  if (!job) return { outcome: "job_not_found", job: null };

  if (isTerminalComputeState(job.state)) {
    return repairTerminal(env, job, read, nowMs);
  }
  if (job.tapis_uuid === null) {
    if (job.cancel_requested_at !== null) {
      await driveCancel(env, job.id, read);
      return { outcome: "advanced", job: await getJob(env.DB, job.id) };
    }
    if (job.state === "created" || job.state === "uploading") {
      const result = await submitComputeJob(env, job.id, nowMs);
      return {
        outcome: result.ok ? "submitted" : "waiting",
        job: await getJob(env.DB, job.id),
        submit: result.outcome,
      };
    }
    return { outcome: "nothing_to_do", job };
  }
  const ctx = tapisAccess(env, read);
  if (ctx === null) return { outcome: "unreachable", job };
  let rec: TapisJob;
  try {
    rec = await getTapisJob(ctx, job.tapis_uuid);
  } catch (err) {
    console.warn(`[compute-lifecycle] readback_failed job=${job.id} kind=${tapisWord(err)}`);
    await markUnreportedIfStale(env, job);
    return { outcome: "unreachable", job: await getJob(env.DB, job.id) };
  }
  const applied = await applyTapisJob(env, job, rec, nowMs);
  return { outcome: applied.outcome, job: await getJob(env.DB, job.id) };
}

/** A live row whose last good read is more than a day old is `unreported`: Tapis has said nothing. */
export async function markUnreportedIfStale(env: Bindings, job: ComputeJobRow): Promise<boolean> {
  const wrote = await env.DB.prepare(UNREPORTED_SQL).bind(job.id, job.state).run();
  return (wrote.meta?.changes ?? 0) === 1;
}

/** What a terminal row may still be owed: its settlement, and the copy of its files. */
async function repairTerminal(
  env: Bindings,
  job: ComputeJobRow,
  read: { maxAttempts: number; timeoutMs: number },
  nowMs: number,
): Promise<AdvanceResult> {
  let current = job;
  let rec: TapisJob | null = null;
  const needsSettlement = current.settled_provisional_at === null;
  const needsCopy = current.result_records_at === null;
  if (!needsSettlement && !needsCopy) return { outcome: "terminal", job: current };

  if (current.tapis_uuid !== null) {
    const ctx = tapisAccess(env, read);
    if (ctx !== null) {
      try {
        rec = await getTapisJob(ctx, current.tapis_uuid);
      } catch (err) {
        console.warn(
          `[compute-lifecycle] readback_failed job=${current.id} kind=${tapisWord(err)}`,
        );
      }
    }
  }
  if (needsSettlement && (current.tapis_uuid === null || rec !== null)) {
    await repairSettlement(env, current, rec, nowMs);
    current = (await getJob(env.DB, current.id)) ?? current;
  }
  if (current.settled_provisional_at !== null && current.result_records_at === null) {
    try {
      await copyResultRecords(env, current);
    } catch (err) {
      console.error(
        `[compute-lifecycle] records_copy_failed job=${current.id} class=${errorClassName(err)}`,
      );
    }
    current = (await getJob(env.DB, current.id)) ?? current;
  }
  return { outcome: "terminal", job: current };
}

// --- What an administrator is shown ----------------------------------------------------------------

/**
 * A job as an administrator's command prints it: fixed words, numbers and times. No identity, no
 * specification, no token, no address and no log. The flags are the four an administrator is told, and
 * `platform_failure` is the information flag that says NEMAR caused the failure (so an administrator can
 * compensate it by a manual grant: nothing is refunded automatically).
 */
export function jobView(job: ComputeJobRow) {
  const flags: ComputeJobFlag[] = [];
  if (job.flag_unreserved === 1) flags.push("unreserved");
  if (job.flag_unattributed === 1) flags.push("unattributed");
  if (job.flag_mismatch === 1) flags.push("mismatch");
  if (job.flag_overrun === 1) flags.push("overrun");
  return {
    id: job.id,
    account_id: job.account_id,
    source: job.source,
    kind: job.kind,
    state: job.state,
    tapis_status: job.tapis_status,
    failure_code: job.failure_code,
    failure_detail: job.failure_detail,
    platform_failure: job.platform_failure === 1,
    cancel_requested: job.cancel_requested_at !== null,
    cancel_reason: job.cancel_reason,
    partition: job.partition,
    pool: job.pool,
    held_milli: job.held_milli,
    charged_milli: job.charged_milli,
    settled: job.settled_provisional_at !== null,
    flags,
    created_at: job.created_at,
    submitted_at: job.submitted_at,
    started_at: job.started_at,
    ended_at: job.ended_at,
    tapis_synced_at: job.tapis_synced_at,
    outputs_completed: job.outputs_completed_at !== null,
    results_verified: job.results_verified_at !== null,
    results_bytes: job.results_bytes,
    records_copied: job.result_records_at !== null,
  };
}

export type ComputeJobView = ReturnType<typeof jobView>;
