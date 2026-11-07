/**
 * The owner and admin routes of the compute gateway's allocation ledger and policy (epic #2005
 * phase A2, #2007; ADR 0118): their error words, request shapes and the RESPONSES the command-line
 * interface (CLI) parses.
 *
 * Every response schema here is open. A released CLI must keep working when the Worker adds a key,
 * so each object accepts and keeps one it does not know, at the top level and nested, and a word
 * the Worker may grow (a holder kind, a ledger kind) is a string here and not an enum. The strict
 * schema of the owner policy (`ComputePolicySchema` in `./compute.ts`) checks what the owner SENDS
 * and what the Worker WRITES; no response is parsed with it, and this file never imports it (a test
 * keeps every file under shared/contract but `compute.ts` and `compute-launch.ts` from doing so).
 *
 * It also holds the status route's response (epic #2005 phase A4, #2009): booleans and fixed words
 * only, never a secret value, an address or a name of the tenant.
 *
 * Money is whole thousandths of a service unit (SU) throughout: `*_milli` is an integer, `12.5`
 * SU is 12500 (`parseSuToMilli` and `formatSu` in `./compute.ts`).
 */

import { z } from "zod";
import type { ComputePool } from "./compute.js";

// --- Words -----------------------------------------------------------------------------------

/** Whose pool it is: a person, one of NEMAR's two platform budgets, or a partner client. */
export const COMPUTE_POOL_HOLDER_KINDS = ["account", "platform", "partner"] as const;

export type ComputePoolHolderKind = (typeof COMPUTE_POOL_HOLDER_KINDS)[number];

/** NEMAR's own pipelines' share of the platform budget, and the one nobody else's spend is counted against. */
export const COMPUTE_PIPELINES_BUDGET = "pipelines" as const;

/** Everyone else's share: the budget every account's and partner's spend is counted against. */
export const COMPUTE_PEOPLE_BUDGET = "people" as const;

/** NEMAR's own two budgets. The migration seeds each of them, for cpu and for gpu. */
export const COMPUTE_PLATFORM_KEYS = [COMPUTE_PIPELINES_BUDGET, COMPUTE_PEOPLE_BUDGET] as const;

export type ComputePlatformKey = (typeof COMPUTE_PLATFORM_KEYS)[number];

/** Whether a word is the key of one of the platform's budgets. */
export function isComputePlatformKey(word: string): word is ComputePlatformKey {
  return (COMPUTE_PLATFORM_KEYS as readonly string[]).includes(word);
}

/**
 * The most SU one request may grant or move, in milli-SU: 2^40, about a billion SU, far above any
 * grant and far below the 2^53 - 1 that a stored total may not pass (a total that would pass it is
 * refused too, as `would_exceed_limit`).
 */
export const COMPUTE_REQUEST_MILLI_MAX = 2 ** 40;

/** Which total an admin's adjustment corrects. */
export const COMPUTE_ADJUST_TARGETS = ["granted", "charged"] as const;

export type ComputeAdjustTarget = (typeof COMPUTE_ADJUST_TARGETS)[number];

/** The most pools a listing answers with at once. */
export const COMPUTE_POOLS_PAGE_MAX = 200;

/**
 * The `Idempotency-Key` header a grant or an adjustment must carry: 8 to 100 letters, digits and
 * `. _ -` (a UUID fits). The ledger stores it behind a prefix of its own, so a key an admin sends
 * can never be the key of an entry the Worker writes for a job.
 */
export const COMPUTE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{8,100}$/;

/** The words an administrator's route answers with, in `{ error: <sentence>, code: <word> }`. */
export const COMPUTE_ADMIN_ERROR_CODES = [
  "invalid_body",
  "invalid_query",
  "idempotency_key_required",
  "idempotency_key_invalid",
  "idempotency_conflict",
  "owner_only",
  "account_not_found",
  "pool_not_found",
  "would_go_negative",
  "would_exceed_limit",
  "policy_unreadable",
  "internal",
  // Phase A7 (#2012): reporting, legal holds, the observer and the ACCESS re-queue.
  "job_not_found",
  "hold_exists",
  "hold_not_found",
  "target_not_found",
  "acknowledgement_required",
  "report_not_found",
  "invalid_reason",
  "record_missing",
  "compute_disabled",
  "audit_failed",
] as const;

export type ComputeAdminErrorCode = (typeof COMPUTE_ADMIN_ERROR_CODES)[number];

/** The HTTP status of each word, declared once so no route picks its own. */
export const COMPUTE_ADMIN_ERROR_STATUS = {
  invalid_body: 400,
  invalid_query: 400,
  idempotency_key_required: 400,
  idempotency_key_invalid: 400,
  idempotency_conflict: 409,
  owner_only: 403,
  account_not_found: 404,
  pool_not_found: 404,
  would_go_negative: 409,
  would_exceed_limit: 409,
  policy_unreadable: 503,
  internal: 500,
  job_not_found: 404,
  hold_exists: 409,
  hold_not_found: 404,
  target_not_found: 404,
  acknowledgement_required: 400,
  report_not_found: 404,
  invalid_reason: 400,
  record_missing: 404,
  compute_disabled: 503,
  audit_failed: 500,
} as const satisfies Record<ComputeAdminErrorCode, number>;

// --- Requests (plain types: the Worker validates them, the CLI builds them) -------------------

/** `PUT /admin/compute/policy`: the whole policy (the strict schema decides) and an optional note. */
export interface ComputePolicyPutRequest {
  policy: unknown;
  note?: string;
}

/** `POST /admin/compute/pools/.../grant`: SU into one pool. The reason is a fixed word. */
export interface ComputePoolGrantRequest {
  pool: ComputePool;
  amount_milli: number;
  reason?: string;
}

/** `POST /admin/compute/pools/.../adjust`: a correction of the grant or of the charge, either way. */
export interface ComputePoolAdjustRequest {
  pool: ComputePool;
  target: ComputeAdjustTarget;
  /** Never 0; negative takes away. */
  delta_milli: number;
  reason: string;
}

// --- Responses (open) ------------------------------------------------------------------------

const milli = z.number().int();

/** A pool as the Worker reports it; `available_milli` is granted - held - charged and may be negative. */
export const ComputePoolViewSchema = z
  .object({
    id: z.number().int(),
    holder_kind: z.string(),
    holder_ref: z.string(),
    pool: z.string(),
    granted_milli: milli,
    held_milli: milli,
    charged_milli: milli,
    available_milli: milli,
    frozen: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export type ComputePoolView = z.infer<typeof ComputePoolViewSchema>;

/** One ledger entry. */
export const ComputeLedgerEntryViewSchema = z
  .object({
    id: z.number().int(),
    kind: z.string(),
    pool_id: z.number().int(),
    budget_pool_id: z.number().int().nullable(),
    granted_delta_milli: milli,
    held_delta_milli: milli,
    charged_delta_milli: milli,
    job_id: z.string().nullable(),
    hold_ref: z.number().int().nullable(),
    reason: z.string().nullable(),
    actor_user_id: z.number().int().nullable(),
    created_at: z.string(),
  })
  .passthrough();

export type ComputeLedgerEntryView = z.infer<typeof ComputeLedgerEntryViewSchema>;

/** `GET /admin/compute/pools`: a keyset page, newest last; `next_after` continues it. */
export const ComputePoolsResponseSchema = z
  .object({
    pools: z.array(ComputePoolViewSchema),
    next_after: z.number().int().nullable(),
  })
  .passthrough();

export type ComputePoolsResponse = z.infer<typeof ComputePoolsResponseSchema>;

/** `GET /admin/compute/pools/by-id/:accountId`: the account's pools; none yet is an empty list. */
export const ComputeAccountPoolsResponseSchema = z
  .object({
    account_id: z.number().int(),
    pools: z.array(ComputePoolViewSchema),
  })
  .passthrough();

export type ComputeAccountPoolsResponse = z.infer<typeof ComputeAccountPoolsResponseSchema>;

/** A grant or an adjustment: the pool afterwards, the entry, and whether the key had been used. */
export const ComputePoolWriteResponseSchema = z
  .object({
    pool: ComputePoolViewSchema,
    entry: ComputeLedgerEntryViewSchema,
    replayed: z.boolean(),
  })
  .passthrough();

export type ComputePoolWriteResponse = z.infer<typeof ComputePoolWriteResponseSchema>;

/**
 * `GET` and `PUT /admin/compute/policy`. `version` is null and `is_default` true while no version
 * has been set (the policy in force is then the default); `policy` is the policy as an open object,
 * so a key the Worker adds later still reaches the CLI.
 */
export const ComputePolicyResponseSchema = z
  .object({
    version: z.number().int().nullable(),
    is_default: z.boolean(),
    policy: z.object({}).passthrough(),
    set_by: z.number().int().nullable(),
    note: z.string().nullable(),
    created_at: z.string().nullable(),
  })
  .passthrough();

export type ComputePolicyResponse = z.infer<typeof ComputePolicyResponseSchema>;

/**
 * `GET /admin/compute/status` (epic #2005 phase A4, #2009): what the Worker reads of the two dark
 * switches, whether Tapis, the two compute buckets with their signing secrets and the ACCESS key are
 * configured, and the result of ONE token mint and ONE health call, as fixed words. Booleans and
 * words only: no secret value, no address, no tenant name, no username.
 *
 *  - `switches.environment` is `production`, `development` or `other`, never the value;
 *  - `tapis.strategy` is `password`, `service` or null (not usable); `tapis.problems` are the names
 *    of what is wrong (`TAPIS_PASSWORD:missing`), empty when it is usable;
 *  - `tapis.token` and `tapis.health` are `ok`, `unconfigured`, `skipped` (no username to probe
 *    with under the service strategy) or the kind of the error the call failed with
 *    (`unauthorized`, `not_found`, `rejected`, `unavailable`, `invalid_response`): a string here,
 *    not an enum, so a word the Worker adds does not break a released CLI;
 *  - `runtime_image` is whether the runtime image variable is set and valid, and its digest.
 */
export const ComputeStatusResponseSchema = z
  .object({
    switches: z
      .object({
        environment: z.string(),
        compute_enabled: z.boolean(),
        pipelines_dispatch_enabled: z.boolean(),
      })
      .passthrough(),
    tapis: z
      .object({
        configured: z.boolean(),
        strategy: z.string().nullable(),
        problems: z.array(z.string()),
        token: z.string(),
        health: z.string(),
      })
      .passthrough(),
    storage: z
      .object({
        records_binding: z.boolean(),
        results_binding: z.boolean(),
        signing_configured: z.boolean(),
      })
      .passthrough(),
    /**
     * Whether the two secrets the ACCESS reports wait for are SET (presence only, never a value): the key
     * and, optional so a CLI that reads a Worker from before the field existed still parses its answer,
     * the resource name.
     */
    access: z
      .object({ key_configured: z.boolean(), resource_name_configured: z.boolean().optional() })
      .passthrough(),
    /**
     * `COMPUTE_RUNTIME_IMAGE`, NEMAR's own image for a `python` job: whether it is `set`, whether it is a
     * `valid` digest-pinned reference, and its `digest` (null unless valid; the reference is never sent).
     * Optional so a CLI that reads a Worker from before the field existed still parses its answer.
     */
    runtime_image: z
      .object({ set: z.boolean(), valid: z.boolean(), digest: z.string().nullable() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type ComputeStatusResponse = z.infer<typeof ComputeStatusResponseSchema>;

const nullableString = z.string().nullable();

/**
 * A job as an administrator's command prints it (epic #2005 phase A5, #2010): fixed words, numbers and
 * times. No identity, no specification, no token, no address and no log. `platform_failure` is an
 * INFORMATION flag, true when NEMAR, the node, the runtime or the contract caused the failure, so that an
 * administrator can compensate it by a manual grant: nothing is refunded automatically. Every word is a
 * string here, not an enum, so a word the Worker adds does not break a released CLI.
 */
export const ComputeJobViewSchema = z
  .object({
    id: z.string(),
    account_id: z.number().int().nullable(),
    source: z.string(),
    kind: z.string(),
    state: z.string(),
    tapis_status: nullableString,
    failure_code: nullableString,
    failure_detail: nullableString,
    platform_failure: z.boolean(),
    cancel_requested: z.boolean(),
    cancel_reason: nullableString,
    partition: z.string(),
    pool: z.string(),
    held_milli: milli,
    charged_milli: milli,
    settled: z.boolean(),
    flags: z.array(z.string()),
    created_at: z.string(),
    submitted_at: nullableString,
    started_at: nullableString,
    ended_at: nullableString,
    tapis_synced_at: nullableString,
    outputs_completed: z.boolean(),
    results_verified: z.boolean(),
    results_bytes: z.number().int().nullable(),
    records_copied: z.boolean(),
  })
  .passthrough();

export type ComputeJobView = z.infer<typeof ComputeJobViewSchema>;

/** `POST /admin/compute/jobs/:id/cancel` and `.../advance`: what happened, and the job as it is now. */
export const ComputeJobAdminResponseSchema = z
  .object({
    ok: z.boolean(),
    outcome: z.string(),
    submit: z.string().optional(),
    job: ComputeJobViewSchema.nullable(),
  })
  .passthrough();

export type ComputeJobAdminResponse = z.infer<typeof ComputeJobAdminResponseSchema>;

// --- NEMAR's own pipelines (epic #2005 phase A6, #2011) ---------------------------------------------------

/** The most datasets one `--eligible` run may dispatch: the policy's daily cap is the real ceiling. */
export const COMPUTE_PIPELINE_RUN_LIMIT_MAX = 100;

/** The default number of datasets an `--eligible` run takes when none is named. */
export const COMPUTE_PIPELINE_RUN_LIMIT_DEFAULT = 10;

/** The states a stamp is filtered by, as the registry declares them. */
export const COMPUTE_PIPELINE_STAMP_STATES = [
  "dispatched",
  "succeeded",
  "failed",
  "refused",
] as const;

/** The most stamps one status page answers with. */
export const COMPUTE_PIPELINE_STATUS_PAGE_MAX = 200;

/**
 * `POST /admin/compute/pipeline/run`: a recipe, then ONE dataset (with an optional version) or the
 * queue (`eligible`, with a `limit`), and `dry_run`. The Worker validates it strictly; the request
 * names nothing else, because the dataset row, the version row, the account and the pool are the
 * Worker's own.
 */
export interface ComputePipelineRunRequest {
  recipe: string;
  dataset?: string;
  version?: string;
  eligible?: boolean;
  limit?: number;
  dry_run?: boolean;
}

/**
 * The HTTP status of each word a pipeline run is refused with, declared once so no route picks its own
 * (the ledger's words keep the statuses `shared/compute-state.ts` gives them).
 */
export const COMPUTE_PIPELINE_REFUSAL_STATUS: Readonly<Record<string, number>> = {
  recipe_unknown: 422,
  recipe_not_automatic: 422,
  recipe_placeholder: 422,
  registry_drift: 409,
  dataset_not_eligible: 422,
  version_not_found: 404,
  version_untagged: 422,
  too_many_files: 422,
  runtime_unavailable: 422,
  pipelines_account_missing: 503,
  compute_disabled: 503,
  live_attempt_exists: 409,
  insufficient_balance: 409,
  platform_budget_exhausted: 409,
  suspended: 403,
  over_concurrency: 409,
  invalid_spec: 400,
  create_failed: 502,
};

/** One dataset's outcome in a run: dispatched (a job and a stamp) or refused (a word). Words are strings. */
export const ComputePipelineResultSchema = z
  .object({
    dataset_id: z.string(),
    ok: z.boolean(),
    version: z.string().optional(),
    job_id: z.string().optional(),
    stamp_id: z.number().int().optional(),
    attempt: z.number().int().optional(),
    submit: z.string().optional(),
    code: z.string().optional(),
    blocked_by: z.array(z.string()).optional(),
  })
  .passthrough();

export type ComputePipelineResult = z.infer<typeof ComputePipelineResultSchema>;

/**
 * The answer of a pipeline run, live or dry. A live run has `results`, `dispatched` and `stopped_by`;
 * a dry run has the estimate, the config a real run needs, what would be dispatched and what blocks the
 * rest. Every field of the other kind is optional, so one schema reads both, and the response is open.
 */
export const ComputePipelineRunResponseSchema = z
  .object({
    ok: z.boolean(),
    dry_run: z.boolean(),
    recipe: z.string(),
    results: z.array(ComputePipelineResultSchema).optional(),
    dispatched: z.number().int().optional(),
    stopped_by: z.string().nullable().optional(),
    /** True when the run was made and the Worker could not write its audit row: nothing is lost but the row. */
    audit_pending: z.boolean().optional(),
    estimate_milli_per_job: milli.optional(),
    estimate_milli_total: milli.optional(),
    config: z
      .object({
        compute_enabled: z.boolean(),
        runtime_image: z.boolean(),
        pipelines_account: z.boolean(),
      })
      .passthrough()
      .optional(),
    would_dispatch: z
      .array(z.object({ dataset_id: z.string(), version: z.string() }).passthrough())
      .optional(),
    blocked: z
      .object({ code: z.string(), blocked_by: z.array(z.string()), version: z.string().optional() })
      .passthrough()
      .optional(),
    blocked_by_term: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type ComputePipelineRunResponse = z.infer<typeof ComputePipelineRunResponseSchema>;

/** A stamp as an administrator is shown it: a tuple, a state, a job and a fixed word. */
export const ComputePipelineStampViewSchema = z
  .object({
    id: z.number().int(),
    dataset_id: z.string(),
    version: z.string(),
    recipe: z.string(),
    recipe_version: z.string(),
    engine: z.string(),
    attempt: z.number().int(),
    state: z.string(),
    job_id: nullableString,
    refusal_code: nullableString,
    created_at: z.string(),
    /** While `dispatched`: when the Worker last examined the stamp. Once ended: when it ended. */
    updated_at: z.string(),
  })
  .passthrough();

export type ComputePipelineStampView = z.infer<typeof ComputePipelineStampViewSchema>;

/** `GET /admin/compute/pipeline/status`: a page of stamps, newest first, after the stamps were synced. */
export const ComputePipelineStatusResponseSchema = z
  .object({
    stamps: z.array(ComputePipelineStampViewSchema),
    next_before: z.number().int().nullable(),
  })
  .passthrough();

export type ComputePipelineStatusResponse = z.infer<typeof ComputePipelineStatusResponseSchema>;

// --- Reporting, holds, the observer and ACCESS reports (epic #2005 phase A7, #2012) ---------------------------

/** The most rows a listing answers with at once. */
export const COMPUTE_REPORT_PAGE_MAX = 200;

/** The shortest and longest reason an owner states for reading a record (the records bucket's own bounds). */
export const COMPUTE_RECORD_REASON_MIN = 8;
export const COMPUTE_RECORD_REASON_MAX = 200;

/** `GET /admin/compute/jobs`: a page of jobs, newest first; `next_after` continues it. */
export const ComputeJobsListResponseSchema = z
  .object({
    jobs: z.array(ComputeJobViewSchema),
    next_after: z.number().int().nullable(),
  })
  .passthrough();

export type ComputeJobsListResponse = z.infer<typeof ComputeJobsListResponseSchema>;

/** `GET /admin/compute/jobs?unmatched=1`: Expanse's rows that no job claims. */
export const ComputeUnmatchedResponseSchema = z
  .object({
    rows: z.array(
      z
        .object({
          slurm_job_id: z.string(),
          partition: z.string(),
          state: z.string(),
          elapsed_seconds: z.number().int(),
          alloc_nodes: z.number().int(),
          alloc_cpus: z.number().int(),
          alloc_gpus: z.number().int(),
          charged_milli: z.number().int().nullable(),
          ingested_at: z.string(),
        })
        .passthrough(),
    ),
    total: z.number().int(),
  })
  .passthrough();

export type ComputeUnmatchedResponse = z.infer<typeof ComputeUnmatchedResponseSchema>;

/** What reading one record for a job's summary found: present, absent, or present and unusable. */
export const COMPUTE_RECORD_STATUSES = ["ok", "missing", "unreadable"] as const;
export type ComputeRecordStatus = (typeof COMPUTE_RECORD_STATUSES)[number];

/**
 * `GET /admin/compute/records/:ref`: one job's index row, ledger entries, provenance and manifest summary.
 * OPEN (passthrough): the CLI never parses it with a strict compute schema (the amendment on #2006).
 */
export const ComputeRecordResponseSchema = z
  .object({
    job: ComputeJobViewSchema,
    identifiers: z.object({}).passthrough(),
    ledger: z.array(z.object({}).passthrough()),
    provenance: z.object({}).passthrough().nullable(),
    // Why `provenance` or `manifest` is null: the object is not there (`missing`) or is there and
    // cannot be read (`unreadable`); `ok` means the value is present, however empty. Optional so a
    // CLI newer than its Worker still reads the answer.
    provenance_status: z.enum(COMPUTE_RECORD_STATUSES).optional(),
    manifest: z
      .object({ files: z.number().int(), bytes: z.number().int() })
      .passthrough()
      .nullable(),
    manifest_status: z.enum(COMPUTE_RECORD_STATUSES).optional(),
    legal_hold: z.boolean(),
    retention_until: z.string().nullable().optional(),
    launcher_files: z.array(z.string()).optional(),
  })
  .passthrough();

export type ComputeRecordResponse = z.infer<typeof ComputeRecordResponseSchema>;

/** `POST /admin/compute/records/:ref/read`: an owner's reasoned read of one record. */
export const ComputeRecordReadResponseSchema = z
  .object({
    job_id: z.string(),
    name: z.string(),
    kind: z.string(),
    content: z.unknown().optional(),
    url: z.string().optional(),
    expires_at: z.string().optional(),
  })
  .passthrough();

export type ComputeRecordReadResponse = z.infer<typeof ComputeRecordReadResponseSchema>;

/** `GET /admin/compute/report`: one account's jobs and charge in a date range. */
export const ComputeAccountReportResponseSchema = z
  .object({
    account_id: z.number().int(),
    from: z.string(),
    to: z.string(),
    totals: z.object({ jobs: z.number().int(), charged_milli: z.number().int() }).passthrough(),
    // Each value is an open object (`jobs`, `charged_milli`): a word the Worker adds is kept.
    by_pool: z.record(z.object({}).passthrough()),
    jobs: z.array(z.object({}).passthrough()),
    truncated: z.boolean(),
  })
  .passthrough();

export type ComputeAccountReportResponse = z.infer<typeof ComputeAccountReportResponseSchema>;

/** `GET /admin/compute/access-report`: for ACCESS, distinct gateway users and jobs by partition and source. */
export const ComputeAccessReportResponseSchema = z
  .object({
    quarter: z.string(),
    rows: z.array(
      z
        .object({
          partition: z.string(),
          source: z.string(),
          distinct_users: z.number().int(),
          jobs: z.number().int(),
        })
        .passthrough(),
    ),
    totals: z.object({ distinct_users: z.number().int(), jobs: z.number().int() }).passthrough(),
  })
  .passthrough();

export type ComputeAccessReportResponse = z.infer<typeof ComputeAccessReportResponseSchema>;

/** A legal hold. */
export const ComputeHoldViewSchema = z
  .object({
    id: z.number().int(),
    scope: z.string(),
    ref: z.string(),
    reason: z.string(),
    placed_by: z.number().int(),
    placed_at: z.string(),
    released_at: z.string().nullable(),
  })
  .passthrough();

export type ComputeHoldView = z.infer<typeof ComputeHoldViewSchema>;

/** `GET /admin/compute/holds`. */
export const ComputeHoldsResponseSchema = z
  .object({ holds: z.array(ComputeHoldViewSchema) })
  .passthrough();

export type ComputeHoldsResponse = z.infer<typeof ComputeHoldsResponseSchema>;

/** `POST` and `DELETE /admin/compute/holds`. */
export const ComputeHoldResponseSchema = z.object({ hold: ComputeHoldViewSchema }).passthrough();

export type ComputeHoldResponse = z.infer<typeof ComputeHoldResponseSchema>;

/** `GET /admin/compute/access-reports`: ACCESS report rows in one state, and the `failed` rows counted by word. */
export const ComputeAccessReportsResponseSchema = z
  .object({
    rows: z.array(
      z
        .object({
          job_id: z.string(),
          state: z.string(),
          attempts: z.number().int(),
          last_error_code: z.string().nullable(),
          next_attempt_at: z.string(),
          sent_at: z.string().nullable(),
          created_at: z.string(),
        })
        .passthrough(),
    ),
    // Fixed word to count; open, so a word the Worker adds is kept as it came.
    failed_by_word: z.record(z.unknown()),
    next_after: z.string().nullable(),
  })
  .passthrough();

export type ComputeAccessReportsResponse = z.infer<typeof ComputeAccessReportsResponseSchema>;

/** `POST /admin/compute/access-reports/:jobId/requeue`. */
export const ComputeRequeueResponseSchema = z
  .object({ ok: z.boolean(), job_id: z.string(), previous: z.string().nullable() })
  .passthrough();

export type ComputeRequeueResponse = z.infer<typeof ComputeRequeueResponseSchema>;

/** `POST /admin/compute/observer-runs`: the run and its token, shown once. */
export const ComputeObserverRunResponseSchema = z
  .object({ run_id: z.string(), token: z.string(), expires_in_minutes: z.number().int() })
  .passthrough();

export type ComputeObserverRunResponse = z.infer<typeof ComputeObserverRunResponseSchema>;
