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
 * Failures NEMAR caused. This is an ATTRIBUTION, never a billing rule: no failure is refunded
 * automatically, and consumed service units stay consumed whoever caused the failure (ADR 0118,
 * amendment of 2026-11-04, #2010); a platform failure is flagged so that an administrator can
 * compensate it by a manual grant. Three of them are also launcher codes (a fetch and an upload,
 * by default NEMAR's); the launcher's other four (`entry_not_found`, `runtime_error`,
 * `out_of_memory`, `time_limit`) are by default the submitter's. A launcher code's `detail` can
 * overrule the default either way: see {@link LAUNCHER_DETAILS} and {@link isPlatformFailure}.
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
 * The submitter caused each, so such a job is not attributed to the platform. Each is also a refusal
 * code, since the outputs route answers with it.
 */
export const RESULT_REFUSAL_DETAILS = [
  "results_too_large",
  "results_quota_exceeded",
  "too_many_outputs",
] as const;

export type ResultRefusalDetail = (typeof RESULT_REFUSAL_DETAILS)[number];

/**
 * Every fixed-word `detail` the launcher may write into `launcher/result.json` with each of its
 * seven codes (a word, never text a person, a response or the container chose). Declared here so
 * that who pays is a table and not a guess: see {@link PLATFORM_LAUNCHER_DETAILS}. A detail not
 * declared for its code (a transport word such as `http_500`, say) is not in the table and the code
 * alone decides.
 *
 * The three codes with an empty list carry no detail. The first three words of
 * `result_upload_failed` are {@link RESULT_REFUSAL_DETAILS}.
 */
export const LAUNCHER_DETAILS = {
  code_fetch_failed: [
    "unsafe_archive",
    "archive_too_large",
    "bad_response",
    "fetch_failed",
    "checksum_mismatch",
    "digest_mismatch",
    "size_mismatch",
    "content_missing",
    "disk_error",
  ],
  dataset_fetch_failed: [
    "bad_include",
    "too_many_files",
    "too_many_bytes",
    "dataset_not_found",
    "bad_manifest",
    "manifest_too_large",
    "unsafe_path",
    "bad_response",
    "fetch_failed",
    "checksum_mismatch",
    "size_mismatch",
    "content_missing",
    "file_not_found",
    "disk_error",
  ],
  entry_not_found: [],
  runtime_error: [
    "entry_failed",
    "terminated",
    "outputs_unreadable",
    "invalid_spec",
    "unsupported_runtime",
    "scratch_in_output",
    "scratch_unavailable",
    "no_container_runtime",
    "image_missing",
    "runtime_unusable",
    "internal_error",
    "output_dir_not_empty",
    "bind_source_unsafe",
    "pid_namespace_unavailable",
  ],
  out_of_memory: [],
  time_limit: [],
  result_upload_failed: [
    ...RESULT_REFUSAL_DETAILS,
    "outputs_unreadable",
    "bad_response",
    "fetch_failed",
    "incomplete_plan",
    "upload_failed",
    "outputs_refused",
    "complete_refused",
    "internal_error",
  ],
} as const satisfies Record<LauncherFailureCode, readonly string[]>;

export type LauncherDetail = (typeof LAUNCHER_DETAILS)[LauncherFailureCode][number];

/**
 * The launcher details that are a NEMAR, node, runtime or contract fault, so that the job is
 * attributed to the platform, even under `runtime_error`. The rule: a detail is the platform's if and only if a
 * submitter cannot cause it with a valid specification and bundle. Every other word of
 * {@link LAUNCHER_DETAILS} is the submitter's, even under `code_fetch_failed` and
 * `dataset_fetch_failed`: an archive that is unsafe or too large, a selection over the job's own
 * limits or an include pattern that is not a glob, an entry that failed or was terminated, outputs
 * that cannot be read, and the results NEMAR refused for their size or count.
 */
export const PLATFORM_LAUNCHER_DETAILS = [
  "invalid_spec",
  "unsupported_runtime",
  "scratch_in_output",
  "scratch_unavailable",
  "no_container_runtime",
  "image_missing",
  "runtime_unusable",
  "internal_error",
  "output_dir_not_empty",
  "bind_source_unsafe",
  "pid_namespace_unavailable",
  "content_missing",
  "dataset_not_found",
  "bad_response",
  "checksum_mismatch",
  "digest_mismatch",
  "size_mismatch",
  "disk_error",
  "fetch_failed",
  "bad_manifest",
  "manifest_too_large",
  "unsafe_path",
  "file_not_found",
  "incomplete_plan",
  "upload_failed",
  "outputs_refused",
  "complete_refused",
] as const;

export type ComputeFailureCode = LauncherFailureCode | PlatformFailureCode;

/** Every code a failed job may carry, each once: the launcher's seven, then the platform's rest. */
export const COMPUTE_FAILURE_CODES: readonly ComputeFailureCode[] = [
  ...LAUNCHER_FAILURE_CODES,
  ...PLATFORM_FAILURE_CODES.filter(
    (c) => !(LAUNCHER_FAILURE_CODES as readonly string[]).includes(c),
  ),
];

/**
 * Whether NEMAR caused a failure. An information flag for reports and manual compensation: it never
 * drives a ledger write (no automatic refund exists). For a launcher code with a detail that
 * {@link LAUNCHER_DETAILS} declares for that code, the detail decides: a platform detail
 * ({@link PLATFORM_LAUNCHER_DETAILS}) is a platform failure even under `runtime_error`, and any
 * other declared detail is the submitter's even under `code_fetch_failed` or
 * `dataset_fetch_failed`. With no detail, or one not declared for its code, the code alone decides,
 * as it always did: true for every platform code, false for the rest. A code that is not a failure
 * code is not a platform failure.
 */
export function isPlatformFailure(code: string, detail?: string | null): boolean {
  if (detail != null && Object.hasOwn(LAUNCHER_DETAILS, code)) {
    const declared: readonly string[] = LAUNCHER_DETAILS[code as LauncherFailureCode];
    if (declared.includes(detail)) {
      return (PLATFORM_LAUNCHER_DETAILS as readonly string[]).includes(detail);
    }
  }
  return (PLATFORM_FAILURE_CODES as readonly string[]).includes(code);
}

/**
 * Tapis's own termination conditions, from the `Job.condition` enum of its published Jobs
 * specification, sorted into NEMAR's failure codes. Anything not listed is `tapis_error`, which is
 * the safe default: a platform failure, flagged, and looked at.
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
  // Phase A2 (#2007): a hold the caller's own guard refused (a person's live-job limit, say). The
  // ledger cannot name the guard, so it answers with this word and the caller says which one.
  "guard_refused",
  // Phase A5 (#2010): the launcher called `complete` and an object it declared is missing or short.
  // Retryable: the launcher uploads what is missing and asks again.
  "results_incomplete",
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
  guard_refused: 409,
  results_incomplete: 409,
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

/**
 * The reasons the ledger writes of itself (phase A2, #2007), each a fixed word. An administrator's
 * own reason is any word of {@link COMPUTE_WORD_RE}; these are the ones the service defaults to:
 * a grant (`admin_grant` from an administrator's route, `grant` otherwise), a release, a refund,
 * an expiry and a job's final settlement.
 */
export const COMPUTE_LEDGER_REASONS = [
  "admin_grant",
  "grant",
  "released",
  "refund",
  "expired",
  "final_settlement",
] as const;

export type ComputeLedgerReason = (typeof COMPUTE_LEDGER_REASONS)[number];

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
