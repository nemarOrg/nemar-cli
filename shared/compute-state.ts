/**
 * The compute gateway's states, the only edges between them, and every fixed word the gateway
 * speaks (epic #2005 phase A1, #2006; ADR 0118). Pure and import-free, so the Worker, the CLI,
 * the launcher contract and the tests read one table and nobody declares a second copy of a word.
 *
 * The words are snake_case and match {@link COMPUTE_WORD_RE}: they travel in D1 `CHECK`s, JSON
 * bodies, object keys and logs, where a free-form string is a place to leak something.
 *
 * What this module does not hold: money (`shared/contract/compute.ts`), the launch specification
 * (`shared/contract/compute-launch.ts`), and anything that reads a clock, a database or a network.
 */

/** A fixed word: lowercase letters, digits and underscore, 1 to 64 characters. */
export const COMPUTE_WORD_RE = /^[a-z0-9_]{1,64}$/;

// --- States ------------------------------------------------------------------------------------

/**
 * Every state of a job, in the order of the design's state table. The first six and `finished`
 * are the happy path; `unreported` is the side state a job enters when Tapis has said nothing past
 * the deadline, and an administrator looks.
 */
export const COMPUTE_STATES = [
  "created",
  "uploading",
  "submitted",
  "queued",
  "running",
  "archiving",
  "finished",
  "failed",
  "cancelled",
  "unreported",
] as const;

export type ComputeState = (typeof COMPUTE_STATES)[number];

/** A terminal job never moves again, so its charge is settled once. */
export const TERMINAL_COMPUTE_STATES = [
  "finished",
  "failed",
  "cancelled",
] as const satisfies readonly ComputeState[];

/** Every state that is not terminal, `unreported` included: such a job may still end. */
export const LIVE_COMPUTE_STATES = [
  "created",
  "uploading",
  "submitted",
  "queued",
  "running",
  "archiving",
  "unreported",
] as const satisfies readonly ComputeState[];

export function isComputeState(value: unknown): value is ComputeState {
  return typeof value === "string" && (COMPUTE_STATES as readonly string[]).includes(value);
}

export function isTerminalComputeState(state: ComputeState): boolean {
  return (TERMINAL_COMPUTE_STATES as readonly string[]).includes(state);
}

/**
 * The only edges a state write may take. Forward edges and self-edges only, because Tapis may
 * resend or reorder a status and a poll can skip any of them, so every later state is reachable
 * and none earlier is. A self-edge refreshes a record without moving the job.
 *
 * `failed` and `cancelled` are reachable from every live state. `unreported` is reachable from
 * every live state and leaves to any state from `submitted` on, never back to `created` or
 * `uploading`: once Tapis has spoken, the job has at least been submitted. Terminal states have
 * no edge at all, not even to themselves; a repeated report of a finished job is a no-op that the
 * caller recognises by comparing states, not a transition.
 */
export const COMPUTE_TRANSITIONS: Readonly<Record<ComputeState, readonly ComputeState[]>> = {
  created: [
    "created",
    "uploading",
    "submitted",
    "queued",
    "running",
    "archiving",
    "finished",
    "failed",
    "cancelled",
    "unreported",
  ],
  uploading: [
    "uploading",
    "submitted",
    "queued",
    "running",
    "archiving",
    "finished",
    "failed",
    "cancelled",
    "unreported",
  ],
  submitted: [
    "submitted",
    "queued",
    "running",
    "archiving",
    "finished",
    "failed",
    "cancelled",
    "unreported",
  ],
  queued: ["queued", "running", "archiving", "finished", "failed", "cancelled", "unreported"],
  running: ["running", "archiving", "finished", "failed", "cancelled", "unreported"],
  archiving: ["archiving", "finished", "failed", "cancelled", "unreported"],
  unreported: [
    "unreported",
    "submitted",
    "queued",
    "running",
    "archiving",
    "finished",
    "failed",
    "cancelled",
  ],
  finished: [],
  failed: [],
  cancelled: [],
};

/** Whether a job in `from` may be written as `to`. A value that is no state is refused. */
export function canTransitionCompute(from: ComputeState, to: ComputeState): boolean {
  if (!isComputeState(from) || !isComputeState(to)) return false;
  return COMPUTE_TRANSITIONS[from].includes(to);
}

// --- Tapis -------------------------------------------------------------------------------------

/** The thirteen statuses of a Tapis job, from Tapis's published Jobs specification. */
export const TAPIS_JOB_STATUSES = [
  "PENDING",
  "PROCESSING_INPUTS",
  "STAGING_INPUTS",
  "STAGING_JOB",
  "SUBMITTING_JOB",
  "QUEUED",
  "RUNNING",
  "ARCHIVING",
  "BLOCKED",
  "PAUSED",
  "FINISHED",
  "CANCELLED",
  "FAILED",
] as const;

export type TapisJobStatus = (typeof TAPIS_JOB_STATUSES)[number];

const TAPIS_STATUS_STATE: ReadonlyMap<string, ComputeState> = new Map<TapisJobStatus, ComputeState>(
  [
    ["PENDING", "submitted"],
    ["PROCESSING_INPUTS", "submitted"],
    ["STAGING_INPUTS", "submitted"],
    ["STAGING_JOB", "submitted"],
    ["SUBMITTING_JOB", "submitted"],
    // Tapis holds a blocked or paused job before it runs; to NEMAR it is still waiting to start.
    ["BLOCKED", "submitted"],
    ["PAUSED", "submitted"],
    ["QUEUED", "queued"],
    ["RUNNING", "running"],
    ["ARCHIVING", "archiving"],
    // `finished` is the state Tapis reports; NEMAR confirms it only after it has verified the
    // results, and otherwise records `failed` with `result_verification_failed`.
    ["FINISHED", "finished"],
    ["FAILED", "failed"],
    ["CANCELLED", "cancelled"],
  ],
);

/** The state a Tapis status maps to, or null for a status this table does not know. */
export function stateFromTapisStatus(status: string): ComputeState | null {
  return TAPIS_STATUS_STATE.get(status) ?? null;
}

// --- Failure codes -----------------------------------------------------------------------------

/**
 * What the launcher on the node writes into `launcher/result.json`, in the order of its exit
 * numbers: the nth word exits 10 + n (see {@link launcherExitNumber}). The first failure wins.
 */
export const LAUNCHER_FAILURE_CODES = [
  "code_fetch_failed",
  "dataset_fetch_failed",
  "entry_not_found",
  "runtime_error",
  "out_of_memory",
  "time_limit",
  "result_upload_failed",
] as const;

export type LauncherFailureCode = (typeof LAUNCHER_FAILURE_CODES)[number];

/** The launcher's exit number when nothing failed. */
export const LAUNCHER_EXIT_OK = 0;

/** The exit number of the first launcher failure code; the rest follow in order. */
export const LAUNCHER_EXIT_FIRST = 10;

/** The exit number the launcher ends with for a failure code. */
export function launcherExitNumber(code: LauncherFailureCode): number {
  const index = (LAUNCHER_FAILURE_CODES as readonly string[]).indexOf(code);
  if (index < 0) throw new RangeError("not a launcher failure code");
  return LAUNCHER_EXIT_FIRST + index;
}

/**
 * Failures NEMAR caused, which are refunded automatically (design section 5). Three of them are
 * also launcher codes: a fetch that failed on NEMAR's side, and an upload that failed. The
 * launcher's other four (`entry_not_found`, `runtime_error`, `out_of_memory`, `time_limit`) are the
 * submitter's and are charged.
 */
export const PLATFORM_FAILURE_CODES = [
  "code_fetch_failed",
  "dataset_fetch_failed",
  "tapis_submit_failed",
  "submit_timeout",
  "staging_failed",
  "launch_failed",
  "archive_failed",
  "tapis_error",
  "result_verification_failed",
  "records_unavailable",
  "result_upload_failed",
] as const;

export type PlatformFailureCode = (typeof PLATFORM_FAILURE_CODES)[number];

/**
 * Why NEMAR refused to take a job's results, recorded as the detail of `result_upload_failed`.
 * The submitter caused each, so such a job is charged and never refunded. Each is also a refusal
 * code, since the outputs route answers with it.
 */
export const RESULT_REFUSAL_DETAILS = [
  "results_too_large",
  "results_quota_exceeded",
  "too_many_outputs",
] as const;

export type ResultRefusalDetail = (typeof RESULT_REFUSAL_DETAILS)[number];

export type ComputeFailureCode = LauncherFailureCode | PlatformFailureCode;

/** Every code a failed job may carry, each once: the launcher's seven, then the platform's rest. */
export const COMPUTE_FAILURE_CODES: readonly ComputeFailureCode[] = [
  ...LAUNCHER_FAILURE_CODES,
  ...PLATFORM_FAILURE_CODES.filter(
    (c) => !(LAUNCHER_FAILURE_CODES as readonly string[]).includes(c),
  ),
];

/**
 * Whether NEMAR caused a failure, so that its charge is refunded. True for every platform code
 * except `result_upload_failed` with a detail in {@link RESULT_REFUSAL_DETAILS}, which the
 * submitter caused (too many files, too many bytes, over quota) and which is never refunded.
 * A code that is not a failure code is not a platform failure.
 */
export function isPlatformFailure(code: string, detail?: string | null): boolean {
  if (!(PLATFORM_FAILURE_CODES as readonly string[]).includes(code)) return false;
  if (code === "result_upload_failed" && detail != null) {
    return !(RESULT_REFUSAL_DETAILS as readonly string[]).includes(detail);
  }
  return true;
}

/**
 * Tapis's own termination conditions, from the `Job.condition` enum of its published Jobs
 * specification, sorted into NEMAR's failure codes. Anything not listed is `tapis_error`, which is
 * the safe default: a platform failure, refunded, and looked at.
 */
const TAPIS_CONDITION_CODE: ReadonlyMap<string, ComputeFailureCode> = new Map<
  string,
  ComputeFailureCode
>([
  ["SCHEDULER_TIMEOUT", "time_limit"],
  ["SCHEDULER_DEADLINE", "time_limit"],
  ["SCHEDULER_OUT_OF_MEMORY", "out_of_memory"],
  // Staging, the files service and transfers.
  ["JOB_UNABLE_TO_STAGE_INPUTS", "staging_failed"],
  ["JOB_UNABLE_TO_STAGE_JOB", "staging_failed"],
  ["JOB_FILES_SERVICE_ERROR", "staging_failed"],
  ["JOB_TRANSFER_FAILED_OR_CANCELLED", "staging_failed"],
  ["JOB_TRANSFER_MONITORING_TIMEOUT", "staging_failed"],
  ["JOB_ARCHIVING_FAILED", "archive_failed"],
  // Launching, and a job definition Tapis could not run.
  ["JOB_LAUNCH_FAILURE", "launch_failed"],
  ["JOB_INVALID_DEFINITION", "launch_failed"],
  ["JOB_REMOTE_OUTCOME_ERROR", "runtime_error"],
]);

/** The failure code for a Tapis termination condition; `tapis_error` for any other or none. */
export function failureCodeFromTapisCondition(
  condition: string | null | undefined,
): ComputeFailureCode {
  return TAPIS_CONDITION_CODE.get(condition ?? "") ?? "tapis_error";
}

// --- Refusal codes -----------------------------------------------------------------------------

/**
 * Why a compute route refuses. The first seven are the partner contract's (design section 6);
 * the rest are the gateway's own. Three of them (`results_too_large`, `results_quota_exceeded` and
 * `too_many_outputs`) are also what the launcher's outputs route refuses with, and so are the
 * details in {@link RESULT_REFUSAL_DETAILS}.
 */
export const COMPUTE_REFUSAL_CODES = [
  "no_compute_access",
  "suspended",
  "insufficient_balance",
  "over_job_limit",
  "over_concurrency",
  "platform_budget_exhausted",
  "client_cap_reached",
  "invalid_spec",
  "partition_not_offered",
  "runtime_unavailable",
  "registry_not_allowed",
  "compute_disabled",
  "dataset_not_eligible",
  "recipe_unknown",
  "pipelines_account_missing",
  "live_attempt_exists",
  "bundle_too_large",
  "bundle_too_many_files",
  "results_too_large",
  "results_quota_exceeded",
  "too_many_outputs",
  "results_expired",
  "job_not_found",
  "bad_state",
] as const;

export type ComputeRefusalCode = (typeof COMPUTE_REFUSAL_CODES)[number];

/**
 * The HTTP status each refusal is answered with, declared once so no route picks its own.
 * 400: the request body is not a valid specification (`invalid_spec`). 403: the person may not.
 * 404: no such job for this caller (`job_not_found`, which never says whether it exists for
 * someone else). 409: the pool, the job or the stored results are in a state that refuses it now
 * and may clear. 410: the results existed and have expired (`results_expired`). 413 and 422: the
 * request itself is over a limit or outside what is offered. 503: the platform is not configured
 * or the switch is off.
 */
export const COMPUTE_REFUSAL_STATUS = {
  no_compute_access: 403,
  suspended: 403,
  insufficient_balance: 409,
  over_job_limit: 422,
  over_concurrency: 409,
  platform_budget_exhausted: 409,
  client_cap_reached: 409,
  invalid_spec: 400,
  partition_not_offered: 422,
  runtime_unavailable: 422,
  registry_not_allowed: 422,
  compute_disabled: 503,
  dataset_not_eligible: 422,
  recipe_unknown: 422,
  pipelines_account_missing: 503,
  live_attempt_exists: 409,
  bundle_too_large: 413,
  bundle_too_many_files: 413,
  results_too_large: 413,
  results_quota_exceeded: 409,
  too_many_outputs: 413,
  results_expired: 410,
  job_not_found: 404,
  bad_state: 409,
} as const satisfies Record<ComputeRefusalCode, number>;

// --- The rest of the vocabulary ----------------------------------------------------------------

/** What a ledger entry does to a pool (design section 5). */
export const LEDGER_ENTRY_KINDS = [
  "grant",
  "hold",
  "release",
  "charge",
  "refund",
  "adjust",
  "overrun",
  "expire",
] as const;

export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];

/** The front door that submitted a job. */
export const COMPUTE_SOURCES = ["cli", "web", "partner", "pipeline"] as const;

export type ComputeSource = (typeof COMPUTE_SOURCES)[number];

/** A batch job runs to its end; an interactive session is the record of the session itself. */
export const COMPUTE_KINDS = ["batch", "interactive"] as const;

export type ComputeKind = (typeof COMPUTE_KINDS)[number];

/** What an administrator is told about a job, in addition to its state. */
export const COMPUTE_JOB_FLAGS = ["unreserved", "unattributed", "mismatch", "overrun"] as const;

export type ComputeJobFlag = (typeof COMPUTE_JOB_FLAGS)[number];

/** Why a job was cancelled, recorded with the cancellation. */
export const COMPUTE_CANCEL_REASONS = [
  "user",
  "admin",
  "account_ended",
  "unreserved",
  "unattributed",
  "scheduler",
] as const;

export type ComputeCancelReason = (typeof COMPUTE_CANCEL_REASONS)[number];
