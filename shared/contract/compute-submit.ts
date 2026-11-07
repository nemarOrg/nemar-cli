/**
 * A person's job submission, `POST /compute/jobs` and the routes around it (epic #2021 phase D3, #2024;
 * ADR 0118, the amendment of this phase): the request, the open responses, the header names, the
 * bounds and the one sentence per refusal. The command-line interface (CLI) and the website's job page
 * (nemarOrg/website#496) read this file; neither declares a second copy of a word or a number.
 *
 *   POST /compute/jobs                     submit; a code bundle gets ONE upload address, an image job is submitted at once
 *   POST /compute/jobs/:id/finalize        the bundle is uploaded: record it and submit
 *   POST /compute/jobs/:id/cancel          cancel (the contract is `./compute-responses.ts`, plus `cancelled`)
 *   GET  /compute/jobs/:id/logs            plain text, at most 1 MiB, `X-Nemar-Truncated: true` when cut
 *   GET  /compute/jobs/:id/results         seven-day links to the outputs of a finished job (bearer links)
 *   POST /compute/jobs/:id/results/renew   the same links, made again while the objects exist
 *
 * Refusals are `{ error: <sentence>, code: <word> }` and, for `invalid_spec`, `field`: the name of the
 * field in the request body, never a value. The status of each word is `COMPUTE_REFUSAL_STATUS`
 * (`../compute-state.ts`); the sentences are {@link COMPUTE_SUBMIT_SENTENCES}.
 *
 * Responses are open (`.passthrough()`): a released reader keeps working when the Worker adds a key. The
 * request is closed, so a typo is refused instead of dropped.
 */

import { z } from "zod";
import {
  COMPUTE_REFUSAL_STATUS,
  COMPUTE_ROUTE_SENTENCES,
  type ComputeRefusalCode,
} from "../compute-state.js";
import { BundleManifestSchema } from "./compute-bundle.js";
import { JobSpecSchema } from "./compute.js";

// --- Names and bounds ---------------------------------------------------------------------------

/** The request header that makes `POST /compute/jobs` safe to repeat. Optional. */
export const COMPUTE_IDEMPOTENCY_HEADER = "Idempotency-Key";

/** A key is 8 to 128 letters, digits and `. _ : -`; one key names one request for one person. */
export const COMPUTE_SUBMIT_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/** The response header on a log that was cut at {@link COMPUTE_LOG_MAX_BYTES}: its value is `true`. */
export const COMPUTE_TRUNCATED_HEADER = "X-Nemar-Truncated";

/** The response header on a replayed submission: its value is `true`. */
export const COMPUTE_REPLAYED_HEADER = "Idempotent-Replayed";

/** The most bytes `GET /compute/jobs/:id/logs` returns: the FIRST 1 MiB of the log. */
export const COMPUTE_LOG_MAX_BYTES = 1024 * 1024;

/**
 * How long an upload address lives, and how long a job may wait in `uploading` before it is failed
 * `upload_expired` and its hold released. The release counts from the job's creation, not from the
 * address, so an address issued again by a replay never extends the hour.
 */
export const COMPUTE_UPLOAD_WINDOW_SECONDS = 3600;

/** The most links one results answer holds; `next_after` pages on. */
export const COMPUTE_RESULTS_PAGE_MAX = 1000;

/** What a results link lives: seven days. The links are bearer links. */
export const COMPUTE_RESULT_LINK_SECONDS = 7 * 24 * 3600;

/** The sentence a results answer carries beside its links. */
export const COMPUTE_BEARER_NOTICE =
  "Anyone who holds a link can download that file until the link expires; keep them private.";

// --- Requests ----------------------------------------------------------------------------------

/**
 * `POST /compute/jobs`. `spec` is the job specification exactly as `spec.json` records it (its `name`
 * included: the name is part of the specification, not a column), and `manifest` is the
 * `bundle-manifest.json` of the archive: required when `spec.bundle` is present, refused when it is not.
 * The archive itself is not in the request; the Worker answers with the address to PUT it to.
 */
export const ComputeSubmitRequestSchema = z
  .object({ spec: JobSpecSchema, manifest: BundleManifestSchema.optional() })
  .strict();

export type ComputeSubmitRequest = z.infer<typeof ComputeSubmitRequestSchema>;

/**
 * `POST /compute/jobs/:id/finalize`: `bundle-manifest.json` again (the Worker keeps nothing of the
 * request between the two calls but the specification, so the manifest it records is the one in THIS
 * call, checked against the same caps and the job's `entry`). An empty body is accepted only for a job
 * that is already past the upload, which the Worker answers unchanged.
 */
export const ComputeFinalizeRequestSchema = BundleManifestSchema;

export type ComputeFinalizeRequest = z.infer<typeof ComputeFinalizeRequestSchema>;

// --- Responses ---------------------------------------------------------------------------------

/**
 * The one address a code bundle is uploaded to: `PUT` the archive's bytes to `url` with exactly the
 * `headers` (the signed `x-amz-checksum-sha256`), a `Content-Length` of `size`. The key is fixed by the
 * Worker (`incoming/<id>/bundle.tar.gz`); the address works until `expires_at` and for that one object.
 */
export const ComputeUploadSchema = z
  .object({
    url: z.string(),
    method: z.literal("PUT"),
    headers: z.record(z.string()),
    expires_at: z.string(),
    size: z.number().int().nonnegative(),
  })
  .passthrough();

export type ComputeUpload = z.infer<typeof ComputeUploadSchema>;

/**
 * `POST /compute/jobs`, 201. `state` is `uploading` for a bundle (with `upload`) and `submitted` for a
 * job that went to the cluster at once; `created` when the Worker could not submit it just now and the
 * 30-minute tick will (compute off, or Tapis unreachable), with no `upload`. `replayed` is present
 * (true) on an answer to a repeated `Idempotency-Key`: the job is the original, `state` is its current
 * state, and `upload` is a fresh address while the job is still `uploading`.
 */
export const ComputeSubmitResponseSchema = z
  .object({
    job_id: z.string(),
    state: z.string(),
    tag: z.string(),
    name: z.string(),
    upload: ComputeUploadSchema.optional(),
    replayed: z.literal(true).optional(),
  })
  .passthrough();

export type ComputeSubmitResponse = z.infer<typeof ComputeSubmitResponseSchema>;

/**
 * `POST /compute/jobs/:id/finalize`, 200. `submitted` is whether Tapis has the job now; when it is
 * false the records are written and the 30-minute tick submits it (`state` is then still `uploading`).
 * `replayed` is true when the job was already past the upload and is returned unchanged.
 */
export const ComputeFinalizeResponseSchema = z
  .object({
    job_id: z.string(),
    state: z.string(),
    name: z.string().optional(),
    submitted: z.boolean(),
    replayed: z.boolean(),
  })
  .passthrough();

export type ComputeFinalizeResponse = z.infer<typeof ComputeFinalizeResponseSchema>;

/** `POST /compute/jobs/:id/cancel`, 200: the contract of `./compute-responses.ts`, which gained `cancelled`. */
export const COMPUTE_CANCEL_ENDED_OUTCOME = "already_ended";

const resultFileSchema = z
  .object({
    path: z.string(),
    size: z.number().int().nonnegative(),
    sha256: z.string(),
    url: z.string(),
  })
  .passthrough();

/**
 * `GET /compute/jobs/:id/results` and `POST .../results/renew`, 200. `files` is at most
 * {@link COMPUTE_RESULTS_PAGE_MAX} outputs in path order; `truncated` and `next_after` say whether more
 * follow (send `after=<next_after>`). Every `url` is a bearer link valid until `expires_at` (seven days
 * from this answer); `bearer_links` is always true and `notice` says what it means.
 */
export const ComputeResultsResponseSchema = z
  .object({
    expires_at: z.string(),
    files: z.array(resultFileSchema),
    total: z.number().int().nonnegative(),
    truncated: z.boolean(),
    next_after: z.string().nullable(),
    bearer_links: z.literal(true),
    notice: z.string(),
  })
  .passthrough();

export type ComputeResultsResponse = z.infer<typeof ComputeResultsResponseSchema>;

/** A refusal: the sentence, the word and, for `invalid_spec`, the name of the field (never its value). */
export const ComputeSubmitErrorSchema = z
  .object({ error: z.string(), code: z.string(), field: z.string().optional() })
  .passthrough();

export type ComputeSubmitError = z.infer<typeof ComputeSubmitErrorSchema>;

// --- Sentences ---------------------------------------------------------------------------------

/**
 * The one sentence per refusal the routes above answer with, beside the status in
 * `COMPUTE_REFUSAL_STATUS`. A sentence says what was refused and never why a job, a path or a dataset was
 * not accepted: a dataset that is not eligible is one sentence whatever made it so.
 *
 * `insufficient_balance` is the owner's wording (2026-11-04): the balance is used up and an administrator
 * can give more; no refund is promised anywhere, because none exists.
 */
export const COMPUTE_SUBMIT_SENTENCES = {
  ...COMPUTE_ROUTE_SENTENCES,
  no_compute_access: "Your account does not have compute access.",
  suspended: "Compute is paused for your account.",
  insufficient_balance:
    "Your compute balance is used up. Contact an administrator to ask for more; a way to add more yourself is planned.",
  over_job_limit: "The job asks for more than one job may have on that partition.",
  over_concurrency: "You already have as many jobs running or waiting as you may.",
  platform_budget_exhausted: "The shared compute budget has no room for this job right now.",
  partition_not_offered: "That partition is not offered to people.",
  runtime_unavailable: "That runtime is not available.",
  registry_not_allowed: "The container image is not from a registry that is allowed.",
  dataset_not_eligible: "A dataset the job names is not available to compute.",
  version_not_found: "A dataset version the job names does not exist.",
  version_untagged: "A dataset version the job names cannot be read by a job.",
  too_many_files: "A dataset the job names has too many files for a job to read.",
  bundle_too_large: "The code bundle is over the size limit.",
  bundle_too_many_files: "The code bundle holds more files than the limit allows.",
  entry_not_in_bundle: "The job's entry is not one of the files in the bundle.",
  bundle_incomplete:
    "The bundle has not been uploaded in full; upload it to the address and ask again.",
  idempotency_conflict: "That Idempotency-Key was already used for a different request.",
  logs_not_available: "The job has no log yet.",
  upload_expired: "The upload window closed and the job was ended; submit it again.",
  storage_unavailable: "Compute storage could not be reached just now; ask again shortly.",
} as const satisfies Partial<Record<ComputeRefusalCode, string>>;

export type ComputeSubmitSentenceCode = keyof typeof COMPUTE_SUBMIT_SENTENCES;

/** The status and sentence of a refusal word the submit routes answer with. */
export function submitRefusal(code: ComputeSubmitSentenceCode): {
  status: number;
  error: string;
  code: ComputeSubmitSentenceCode;
} {
  return { status: COMPUTE_REFUSAL_STATUS[code], error: COMPUTE_SUBMIT_SENTENCES[code], code };
}
