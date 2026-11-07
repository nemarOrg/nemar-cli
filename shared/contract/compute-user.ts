/**
 * The person's read routes of the compute gateway, `/compute/me*` and `/compute/stats` (epic #2021 phase
 * D2, #2023; ADR 0118 and ADR 0119, the addenda of that phase): their query bounds, their error words
 * and the RESPONSES the command-line interface (CLI) and the website parse.
 *
 * Like `./compute-admin.ts` and `./compute-responses.ts`, every response schema here is open: a released
 * reader keeps working when the Worker adds a key, so each object accepts and keeps one it does not know,
 * a word the Worker may grow (a state, a partition, a source) is a string and not an enum, and an addition
 * is `.optional()` with no default. No schema here is strict and this file imports nothing from
 * `./compute.ts` or `./compute-launch.ts` (a test holds both).
 *
 * Money is whole thousandths of a service unit (SU) throughout, as an integer: `12.5` SU is `12500`
 * (`formatSu` in `./compute.ts` prints it). `available_milli` may be negative (an overrun, or a grant
 * corrected below what is used), so it is an integer and not a natural number.
 *
 * Times are the Worker's database clock in UTC, as `YYYY-MM-DD HH:MM:SS`, the form every other compute
 * view uses. Days are `YYYY-MM-DD` in UTC.
 */

import { z } from "zod";

// --- Query bounds -----------------------------------------------------------------------------

/** The most jobs one page of `GET /compute/me/jobs` holds, and the page when `limit` is absent. */
export const COMPUTE_JOBS_PAGE_MAX = 100;
export const COMPUTE_JOBS_PAGE_DEFAULT = 25;

/** The groups `GET /compute/me/usage` may be grouped by, in the order a row lists them. */
export const COMPUTE_USAGE_GROUPS = ["day", "app", "partition", "source"] as const;
export type ComputeUsageGroup = (typeof COMPUTE_USAGE_GROUPS)[number];

/** The longest window (both ends counted) `usage` and `stats` answer for, and the default window. */
export const COMPUTE_WINDOW_MAX_DAYS = 366;
export const COMPUTE_WINDOW_DEFAULT_DAYS = 30;

/** A queue estimate: the jobs that started in the last `window_days` days, at most this many per partition. */
export const COMPUTE_QUEUE_WINDOW_DAYS = 7;
export const COMPUTE_QUEUE_SAMPLE_CAP = 2000;

/** Fewer samples than this give `null` figures with the count, so a thin sample never reads as an estimate. */
export const COMPUTE_QUEUE_MIN_SAMPLES = 5;

// --- Credentials and errors -------------------------------------------------------------------

/**
 * The OpenID Connect scopes the routes accept (ADR 0119 rule 6, and the ADR's addendum for this phase):
 * a person's token carries `compute.read`; `compute.stats` is a client credentials token's, machine only.
 */
export const COMPUTE_READ_SCOPE = "compute.read";
export const COMPUTE_STATS_SCOPE = "compute.stats";

/**
 * Every word a read route answers a refusal with, and its status. A refusal is `{ error: <sentence>,
 * code: <word> }`; the sentence repeats nothing the caller sent. `job_not_found` and `policy_unavailable`
 * are the job routes' shared words (`COMPUTE_ROUTE_SENTENCES`), listed here for the routes' own table.
 *
 *  - `forbidden_credential` (403): the credential is of a kind this route never accepts (a key or a
 *    person's token on `/compute/stats`, a client credentials token on a `/compute/me*` route).
 *  - `insufficient_scope` (403): a live access token without the scope the route needs.
 *  - `invalid_token` (401): an OpenID Connect token that is not a live access token.
 *  - `missing_credential` (401): `/compute/stats` with no `Authorization` header.
 *  - `invalid_range`, `invalid_group`, `invalid_state`, `invalid_limit`, `invalid_cursor` (400): the
 *    query string.
 */
export const COMPUTE_USER_ERROR_STATUS = {
  forbidden_credential: 403,
  insufficient_scope: 403,
  invalid_token: 401,
  missing_credential: 401,
  invalid_range: 400,
  invalid_group: 400,
  invalid_state: 400,
  invalid_limit: 400,
  invalid_cursor: 400,
  job_not_found: 404,
  policy_unavailable: 503,
} as const;

export type ComputeUserErrorCode = keyof typeof COMPUTE_USER_ERROR_STATUS;

export const COMPUTE_USER_ERROR_CODES = Object.keys(
  COMPUTE_USER_ERROR_STATUS,
) as ComputeUserErrorCode[];

/** The sentence each credential and query refusal answers with (the job words use `COMPUTE_ROUTE_SENTENCES`). */
export const COMPUTE_USER_SENTENCES = {
  forbidden_credential: "This credential cannot be used on this route.",
  insufficient_scope: "The access token does not carry the scope this route needs.",
  invalid_token: "The access token is not valid.",
  missing_credential: "This route needs an access token.",
  invalid_range:
    "from and to are days as YYYY-MM-DD in UTC, from is not after to, and the window is at most 366 days.",
  invalid_group: "group is a comma list of day, app, partition and source, each at most once.",
  invalid_state: "state is not a job state.",
  invalid_limit: "limit is a whole number from 1 to 100.",
  invalid_cursor: "after is not a cursor this route gave.",
} as const satisfies Partial<Record<ComputeUserErrorCode, string>>;

// --- Shapes -----------------------------------------------------------------------------------

const nullableString = z.string().nullable();
const count = z.number().int().nonnegative();

/** One pool of the caller's: the three totals the ledger keeps and what is left (may be negative). */
export const ComputePoolBalanceSchema = z
  .object({
    granted_milli: count,
    held_milli: count,
    charged_milli: count,
    available_milli: z.number().int(),
  })
  .passthrough();

export type ComputePoolBalance = z.infer<typeof ComputePoolBalanceSchema>;

/** A partition a person may use, with the owner's ceilings on one job. */
export const ComputePartitionLimitSchema = z
  .object({
    name: z.string(),
    pool: z.string(),
    max_nodes: count,
    max_cores_per_node: count,
    max_gpus_per_node: count,
    max_minutes: count,
  })
  .passthrough();

export type ComputePartitionLimit = z.infer<typeof ComputePartitionLimitSchema>;

/**
 * How long jobs on a partition have waited to start lately. `median_seconds` and `p90_seconds` are
 * `null`, with the `count`, when fewer than `COMPUTE_QUEUE_MIN_SAMPLES` jobs started in the window.
 */
export const ComputeQueueEstimateSchema = z
  .object({
    partition: z.string(),
    median_seconds: z.number().int().nonnegative().nullable(),
    p90_seconds: z.number().int().nonnegative().nullable(),
    count,
    window_days: count,
  })
  .passthrough();

export type ComputeQueueEstimate = z.infer<typeof ComputeQueueEstimateSchema>;

/**
 * `GET /compute/me`: the caller's compute access, balances, limits and queue estimates. It answers for
 * every access state, `none` and `suspended` included, so a partner can show why a launch is refused.
 *
 *  - `access.state` is one of `none`, `requested`, `active`, `suspended`, `denied`, `revoked`.
 *  - `access.terms_version` is the version the person accepted (null if none),
 *    `access.current_terms_version` the one in force, `access.terms_published` whether the owner has
 *    published them, and `access.requests_open` whether a new request would be taken now (false in
 *    production while the terms are unpublished).
 *  - `pools` holds `cpu` and `gpu`; a pool nobody granted is all zeros, which is true: nothing was granted.
 *  - `frozen` is true when any of the account's pools is frozen (an ended account, a suspension).
 *  - `limits.partitions` lists only the partitions offered to people; `limits.max_live_jobs` is the most
 *    jobs the person may have created, queued or running at once (the owner's policy has one number for
 *    both); `limits.results_days` is how long results are kept.
 */
export const ComputeMeResponseSchema = z
  .object({
    access: z
      .object({
        state: z.string(),
        requested_at: nullableString,
        granted_at: nullableString,
        terms_version: nullableString,
        current_terms_version: z.string(),
        terms_published: z.boolean(),
        requests_open: z.boolean().optional(),
      })
      .passthrough(),
    pools: z.object({ cpu: ComputePoolBalanceSchema, gpu: ComputePoolBalanceSchema }).passthrough(),
    frozen: z.boolean(),
    limits: z
      .object({
        partitions: z.array(ComputePartitionLimitSchema),
        max_live_jobs: count,
        results_days: count,
      })
      .passthrough(),
    queue: z.array(ComputeQueueEstimateSchema),
  })
  .passthrough();

export type ComputeMeResponse = z.infer<typeof ComputeMeResponseSchema>;

/**
 * One row of `GET /compute/me/usage`: the group keys asked for and the net charge. A group key is
 * `null` for an administrator's correction that names no job (it has no app, partition or source); a
 * group with no charge has no row.
 */
export const ComputeUsageRowSchema = z
  .object({
    day: z.string().optional(),
    app: nullableString.optional(),
    partition: nullableString.optional(),
    source: nullableString.optional(),
    charged_milli: z.number().int(),
    jobs: count,
  })
  .passthrough();

export type ComputeUsageRow = z.infer<typeof ComputeUsageRowSchema>;

export const ComputeUsageResponseSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    group: z.array(z.string()),
    rows: z.array(ComputeUsageRowSchema),
  })
  .passthrough();

export type ComputeUsageResponse = z.infer<typeof ComputeUsageResponseSchema>;

/**
 * A job as its own person sees it. No flag, no failure attribution, no Slurm or Tapis identifier, no
 * hold figure and no identity: only what the person did and what it cost. `charged_milli` is what the
 * pool was charged so far (0 until the job ends).
 */
export const ComputeUserJobSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    source: z.string(),
    state: z.string(),
    app_id: z.string(),
    app_version: z.string(),
    partition: z.string(),
    pool: z.string(),
    resources: z
      .object({
        nodes: count,
        cores_per_node: count,
        memory_mb: z.number().int().nonnegative().nullable(),
        gpus: count,
        minutes: count,
      })
      .passthrough(),
    created_at: z.string(),
    started_at: nullableString,
    ended_at: nullableString,
    charged_milli: z.number().int().nonnegative(),
    failure_code: nullableString,
    cancel_requested: z.boolean(),
  })
  .passthrough();

export type ComputeUserJob = z.infer<typeof ComputeUserJobSchema>;

/** `GET /compute/me/jobs`: newest first; `next_after` is the cursor for the next page, null on the last. */
export const ComputeUserJobsResponseSchema = z
  .object({
    jobs: z.array(ComputeUserJobSchema),
    next_after: nullableString,
  })
  .passthrough();

export type ComputeUserJobsResponse = z.infer<typeof ComputeUserJobsResponseSchema>;

/**
 * `GET /compute/me/jobs/:id`: the job. `stale` is true when the job is live, its stored record is more
 * than 60 seconds old, and the refresh from Tapis could not be made: the stored record is served as it is.
 */
export const ComputeUserJobResponseSchema = z
  .object({
    job: ComputeUserJobSchema,
    stale: z.boolean().optional(),
  })
  .passthrough();

export type ComputeUserJobResponse = z.infer<typeof ComputeUserJobResponseSchema>;

/**
 * `GET /compute/stats`: platform-wide aggregates for the partner, and nothing that names a person or an
 * account: no id, subject, name, email or per-person row. `active_people` counts the distinct people who
 * created a job in the window (NEMAR's own pipelines and unreserved jobs are not people);
 * `jobs_by_outcome` counts the jobs created in the window by terminal state, every terminal state listed.
 */
export const ComputeStatsResponseSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    by_day_partition_source: z.array(
      z
        .object({
          day: z.string(),
          partition: z.string(),
          source: z.string(),
          charged_milli: z.number().int(),
          jobs: count,
        })
        .passthrough(),
    ),
    active_people: count,
    jobs_by_outcome: z.record(count),
  })
  .passthrough();

export type ComputeStatsResponse = z.infer<typeof ComputeStatsResponseSchema>;
