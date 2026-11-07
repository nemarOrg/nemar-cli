/**
 * The partner contract of the compute gateway (epic #2021 phase D4, #2025; ADR 0118, the amendment of this
 * phase; ADR 0119, the addendum): how `compute.nemar.org`, or a test client, reserves compute time for a
 * signed-in person, reports the Tapis job it launched under the reservation, and releases a reservation.
 * The partner site (run by another institution) and the website read this file; neither declares a second
 * copy of a word or a number.
 *
 *   POST   /compute/holds             reserve: 201 `{ job_id, hold_id, tag, expires_at }`
 *   POST   /compute/jobs/:id/report   report the Tapis job launched under the reservation: 200 verified,
 *                                     202 pending (NEMAR could not read the job back just now)
 *   DELETE /compute/holds/:id         release a reservation nothing was launched under: 200
 *
 * THE CREDENTIAL of every route is an OpenID Connect access token carrying `compute.reserve`, for a PERSON
 * (an authorization code token; a client credentials token names no person and is refused). A CLI key or the
 * session cookie is `forbidden_credential`; a token without the scope is `insufficient_scope`; a token whose
 * audience does not name the NEMAR API is `wrong_audience`. Every write needs an `Idempotency-Key`
 * (`^[A-Za-z0-9._:-]{1,64}$`, `idempotency_key_required`): one key names ONE request of one client for one
 * person; the same request again is the same answer, another request under the key is
 * `idempotency_conflict` (422) and writes nothing.
 *
 * WHAT NEMAR DOES NOT TRUST: the partner can mint a Tapis token for any username, so a Tapis job's `owner`
 * and its tag prove nothing alone. Only the Tapis job id the partner reports and NEMAR's own read of that
 * job from Tapis prove what ran: the owner is the person's Tapis username, the application and its version
 * are the reservation's, and the resources do not exceed it. A job that does not match is cancelled by
 * NEMAR, flagged, and charged to the partner's pool and never to the person. Until a report is verified
 * NEMAR charges nothing beyond the hold.
 *
 * Refusals are `{ error: <sentence>, code: <word> }` and, for `invalid_spec`, `field` (the name of a field
 * of the request, never a value). A refusal about a job that is not the caller's is `job_not_found`
 * whether the job is another person's, another client's or absent. The status of each word is
 * {@link COMPUTE_PARTNER_ERROR_STATUS}; the sentences are {@link COMPUTE_PARTNER_SENTENCES}.
 *
 * Responses are open (`.passthrough()`): a released reader keeps working when the Worker adds a key. This
 * file declares no strict schema and imports none; the REQUESTS, which the Worker validates as they come
 * in and which are closed so a typo is refused instead of dropped, are `./compute-partner-request.ts`.
 */

import { z } from "zod";

// --- Names and bounds ---------------------------------------------------------------------------

/** The scope of all three routes (ADR 0119 rule 6). */
export const COMPUTE_RESERVE_SCOPE = "compute.reserve";

/** The request header every write needs. */
export const COMPUTE_PARTNER_IDEMPOTENCY_HEADER = "Idempotency-Key";

/** A key is 1 to 64 letters, digits and `. _ : -`. */
export const COMPUTE_PARTNER_KEY_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** The response header on a replayed answer: its value is `true`. */
export const COMPUTE_PARTNER_REPLAYED_HEADER = "Idempotent-Replayed";

/** The tag the partner puts on the Tapis job it launches: `nemar_job:<job id>`. */
export const COMPUTE_PARTNER_TAG_PREFIX = "nemar_job:";

/** The id of a reservation on the wire: `hold_` and the 24 hex digits of its job. Not a row number. */
export const COMPUTE_HOLD_ID_RE = /^hold_[0-9a-f]{24}$/;

/** `hold_<hex>` for a job id (`job_<hex>`). */
export function holdIdForJob(jobId: string): string {
  return `hold_${jobId.slice(4)}`;
}

/** The job id (`job_<hex>`) a hold id names, or null when the text is not a hold id. */
export function jobIdForHold(holdId: string): string | null {
  return COMPUTE_HOLD_ID_RE.test(holdId) ? `job_${holdId.slice(5)}` : null;
}

/** What a report's files may come to, in characters of path and number of files (the Worker also applies the owner's byte limits). */
export const COMPUTE_PARTNER_FILES_MAX = 500;

// --- Refusal words -------------------------------------------------------------------------------

/**
 * Every word a partner route answers a refusal with, and its status. This is a CLOSED list: a word
 * outside it is a bug in the Worker. Declared once, so the partner, the website and the tests read the
 * same table.
 */
export const COMPUTE_PARTNER_ERROR_STATUS = {
  // The credential.
  missing_credential: 401,
  invalid_token: 401,
  forbidden_credential: 403,
  insufficient_scope: 403,
  wrong_audience: 403,
  // The request.
  idempotency_key_required: 400,
  invalid_spec: 400,
  idempotency_conflict: 422,
  // The person's standing, the owner's ceilings and the balances (the order of `POST /compute/holds`).
  no_compute_access: 403,
  suspended: 403,
  partition_not_offered: 422,
  over_job_limit: 422,
  over_concurrency: 409,
  insufficient_balance: 409,
  platform_budget_exhausted: 409,
  client_cap_reached: 409,
  // A reservation.
  job_not_found: 404,
  already_bound: 409,
  tapis_job_in_use: 409,
  tapis_job_not_found: 422,
  hold_released: 409,
  hold_cancelled: 409,
  hold_bound: 409,
  report_mismatch: 409,
  // Files.
  bundle_too_many_files: 413,
  bundle_too_large: 413,
  // The platform.
  compute_disabled: 503,
  policy_unavailable: 503,
  storage_unavailable: 503,
} as const;

export type ComputePartnerErrorCode = keyof typeof COMPUTE_PARTNER_ERROR_STATUS;

/** The words a report that does not match is flagged with (`report_mismatch` carries one as `mismatch`). */
export const COMPUTE_REPORT_MISMATCHES = [
  "owner_mismatch",
  "app_mismatch",
  "resources_mismatch",
] as const;

export type ComputeReportMismatch = (typeof COMPUTE_REPORT_MISMATCHES)[number];

/**
 * The one sentence per refusal. A sentence says what was refused and never why a job, a person or a
 * Tapis job was not accepted: it repeats nothing the caller sent.
 */
export const COMPUTE_PARTNER_SENTENCES = {
  missing_credential: "An access token is required.",
  invalid_token: "The access token is not valid.",
  forbidden_credential: "This credential cannot be used here.",
  insufficient_scope: "The access token does not carry the scope this route needs.",
  wrong_audience: "The access token was not issued for the NEMAR API.",
  idempotency_key_required: "An Idempotency-Key header is required.",
  invalid_spec: "The request is not valid.",
  idempotency_conflict: "That Idempotency-Key was already used for a different request.",
  no_compute_access: "The person does not have compute access.",
  suspended: "Compute is paused for the person.",
  partition_not_offered: "That partition is not offered to people.",
  over_job_limit: "The request asks for more than one job may have on that partition.",
  over_concurrency: "The person already has as many jobs running or waiting as they may.",
  insufficient_balance: "The person's compute balance is used up.",
  platform_budget_exhausted: "The shared compute budget has no room for this reservation right now.",
  client_cap_reached: "This client has reached the limit the owner set for it.",
  job_not_found: "No such job.",
  already_bound: "A different Tapis job is already reported under this reservation.",
  tapis_job_in_use: "That Tapis job is already accounted for.",
  tapis_job_not_found: "NEMAR could not find that Tapis job.",
  hold_released: "The reservation has ended.",
  hold_cancelled: "The reservation was cancelled.",
  hold_bound: "A Tapis job is reported under this reservation, so it cannot be released.",
  report_mismatch:
    "The Tapis job does not match the reservation, so NEMAR is cancelling it and it is not charged to the person.",
  bundle_too_many_files: "The report declares more files than the limit allows.",
  bundle_too_large: "A declared file, or the files together, are over the size limit.",
  compute_disabled: "Compute storage is not configured.",
  policy_unavailable: "The platform could not read its limits just now; ask again shortly.",
  storage_unavailable: "Compute storage could not be reached just now; ask again shortly.",
} as const satisfies Record<ComputePartnerErrorCode, string>;

/** The status and sentence of a refusal word. */
export function partnerRefusal(code: ComputePartnerErrorCode): {
  status: number;
  error: string;
  code: ComputePartnerErrorCode;
} {
  return {
    status: COMPUTE_PARTNER_ERROR_STATUS[code],
    error: COMPUTE_PARTNER_SENTENCES[code],
    code,
  };
}

// --- Responses ---------------------------------------------------------------------------------

/**
 * `POST /compute/holds`, 201. `hold_id` is what `DELETE /compute/holds/:id` takes; `tag` is what to put on
 * the Tapis job (`nemar_job:<job_id>`); `expires_at` is when NEMAR looks for a job under the tag and, finding
 * none, releases the hold (the owner's reservation wait after the request). `replayed` is true on an
 * answer to a repeated `Idempotency-Key`: the reservation is the original.
 */
export const ComputePartnerHoldResponseSchema = z
  .object({
    job_id: z.string(),
    hold_id: z.string(),
    tag: z.string(),
    expires_at: z.string(),
    replayed: z.literal(true).optional(),
  })
  .passthrough();

export type ComputePartnerHoldResponse = z.infer<typeof ComputePartnerHoldResponseSchema>;

/** One PUT address for a declared file: `PUT url` with exactly `headers`; works until `expires_at`. */
export const ComputePartnerReportUploadSchema = z
  .object({
    path: z.string(),
    url: z.string(),
    method: z.literal("PUT"),
    headers: z.record(z.string()),
  })
  .passthrough();

/**
 * What became of the files a report declared. `awaiting_upload`: upload each file to its address and
 * send the same report again; `recorded`: every file is in the person's record. Present only when the
 * report declared files.
 */
export const ComputePartnerReportFilesSchema = z
  .object({
    state: z.enum(["awaiting_upload", "recorded"]),
    uploads: z.array(ComputePartnerReportUploadSchema).optional(),
    expires_at: z.string().optional(),
  })
  .passthrough();

/**
 * `POST /compute/jobs/:id/report`, 200 or 202. `verification` is `verified` (200: NEMAR read the Tapis
 * job back and it matches, and from now on it is an ordinary job that NEMAR follows and charges for what
 * it uses) or `pending` (202: NEMAR could not read the job back just now and will; nothing is charged
 * beyond the hold meanwhile; repeat the same report to learn the outcome). `state` is the job's state.
 */
export const ComputePartnerReportResponseSchema = z
  .object({
    job_id: z.string(),
    verification: z.enum(["verified", "pending"]),
    state: z.string(),
    files: ComputePartnerReportFilesSchema.optional(),
    replayed: z.literal(true).optional(),
  })
  .passthrough();

export type ComputePartnerReportResponse = z.infer<typeof ComputePartnerReportResponseSchema>;

/** `DELETE /compute/holds/:id`, 200. A reservation that is already released answers 200 again. */
export const ComputePartnerReleaseResponseSchema = z
  .object({
    job_id: z.string(),
    hold_id: z.string(),
    released: z.literal(true),
    state: z.string(),
    replayed: z.literal(true).optional(),
  })
  .passthrough();

export type ComputePartnerReleaseResponse = z.infer<typeof ComputePartnerReleaseResponseSchema>;

/** A refusal: the sentence, the word and, where it applies, the field or the mismatch word. */
export const ComputePartnerErrorSchema = z
  .object({
    error: z.string(),
    code: z.string(),
    field: z.string().optional(),
    mismatch: z.string().optional(),
    job_id: z.string().optional(),
  })
  .passthrough();

export type ComputePartnerError = z.infer<typeof ComputePartnerErrorSchema>;
