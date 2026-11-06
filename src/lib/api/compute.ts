/**
 * NEMAR API client: the compute gateway's policy and allocation pools (epic #2005 phase A2, #2007;
 * ADR 0118), `/admin/compute`. Owner and admin roles.
 *
 * Every response is parsed with an OPEN schema (shared/contract/compute-admin.ts): a Worker that
 * adds a key, at the top level or nested, must not break a released CLI. The strict schema of the
 * owner policy is for what `policy set` sends, and `policy show` never parses a response with it.
 * A refusal answers `{ error: <sentence>, code: <word> }`: the sentence is `ApiError.message`, and
 * the word is in `ApiError.rawBody.code` (never `ApiError.code`, which is the body's `error`, the
 * sentence, under this convention); nothing reads it yet, and the reader is added with the first
 * caller that needs one.
 */

import {
  type ComputeAccountPoolsResponse,
  ComputeAccountPoolsResponseSchema,
  type ComputeJobAdminResponse,
  ComputeJobAdminResponseSchema,
  type ComputePipelineRunRequest,
  type ComputePipelineRunResponse,
  ComputePipelineRunResponseSchema,
  type ComputePipelineStatusResponse,
  ComputePipelineStatusResponseSchema,
  type ComputePolicyResponse,
  ComputePolicyResponseSchema,
  type ComputePoolAdjustRequest,
  type ComputePoolGrantRequest,
  type ComputePoolHolderKind,
  type ComputePoolWriteResponse,
  ComputePoolWriteResponseSchema,
  type ComputePoolsResponse,
  ComputePoolsResponseSchema,
  type ComputeStatusResponse,
  ComputeStatusResponseSchema,
} from "../../../shared/contract/compute-admin.js";
import { request } from "./client.js";
import { ApiError } from "./errors.js";

/** `GET /admin/compute/policy` (owner): the policy in force, or the default while none is set. */
export async function getComputePolicy(): Promise<ComputePolicyResponse> {
  return request("/admin/compute/policy", {}, true, ComputePolicyResponseSchema);
}

/** `PUT /admin/compute/policy` (owner): the next version, which the Worker validates strictly again. */
export async function putComputePolicy(
  policy: unknown,
  note?: string,
): Promise<ComputePolicyResponse> {
  return request(
    "/admin/compute/policy",
    { method: "PUT", body: JSON.stringify(note === undefined ? { policy } : { policy, note }) },
    true,
    ComputePolicyResponseSchema,
  );
}

/** `GET /admin/compute/pools` (admin): a keyset page, at most 200; `next_after` continues it. */
export async function listComputePools(
  q: { holderKind?: ComputePoolHolderKind; after?: number; limit?: number } = {},
): Promise<ComputePoolsResponse> {
  const params = new URLSearchParams();
  if (q.holderKind) params.set("holder_kind", q.holderKind);
  if (q.after !== undefined) params.set("after", String(q.after));
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  const query = params.toString() ? `?${params.toString()}` : "";
  return request(`/admin/compute/pools${query}`, {}, true, ComputePoolsResponseSchema);
}

/** `GET /admin/compute/pools/by-id/:accountId` (admin): the account's pools; none yet is an empty list. */
export async function getAccountComputePools(
  accountId: number,
): Promise<ComputeAccountPoolsResponse> {
  return request(
    `/admin/compute/pools/by-id/${accountId}`,
    {},
    true,
    ComputeAccountPoolsResponseSchema,
  );
}

function post(
  path: string,
  body: unknown,
  idempotencyKey: string,
): Promise<ComputePoolWriteResponse> {
  return request(
    path,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Idempotency-Key": idempotencyKey },
    },
    true,
    ComputePoolWriteResponseSchema,
  );
}

/** `POST /admin/compute/pools/by-id/:accountId/grant` (admin). One key for one request, ever. */
export async function grantAccountComputePool(
  accountId: number,
  body: ComputePoolGrantRequest,
  idempotencyKey: string,
): Promise<ComputePoolWriteResponse> {
  return post(`/admin/compute/pools/by-id/${accountId}/grant`, body, idempotencyKey);
}

/** `POST /admin/compute/pools/by-id/:accountId/adjust` (admin). */
export async function adjustAccountComputePool(
  accountId: number,
  body: ComputePoolAdjustRequest,
  idempotencyKey: string,
): Promise<ComputePoolWriteResponse> {
  return post(`/admin/compute/pools/by-id/${accountId}/adjust`, body, idempotencyKey);
}

/** `POST /admin/compute/pools/platform/:key/grant` (owner): a platform budget. */
export async function grantPlatformComputePool(
  key: string,
  body: ComputePoolGrantRequest,
  idempotencyKey: string,
): Promise<ComputePoolWriteResponse> {
  return post(
    `/admin/compute/pools/platform/${encodeURIComponent(key)}/grant`,
    body,
    idempotencyKey,
  );
}

/** `POST /admin/compute/pools/platform/:key/adjust` (owner). */
export async function adjustPlatformComputePool(
  key: string,
  body: ComputePoolAdjustRequest,
  idempotencyKey: string,
): Promise<ComputePoolWriteResponse> {
  return post(
    `/admin/compute/pools/platform/${encodeURIComponent(key)}/adjust`,
    body,
    idempotencyKey,
  );
}

/**
 * `GET /admin/compute/status` (admin): the switches as the Worker reads them, whether Tapis, the two
 * compute buckets with their signing secrets and the ACCESS key are configured, and one token mint
 * and one health call, as booleans and fixed words (epic #2005 phase A4, #2009).
 */
export async function getComputeStatus(): Promise<ComputeStatusResponse> {
  return request("/admin/compute/status", {}, true, ComputeStatusResponseSchema);
}

/**
 * `POST /admin/compute/jobs/:id/cancel` (admin): cancel a job at Tapis (a job that never started is ended
 * here and its hold released). The Worker records the intent and carries it out; a job Tapis could not be
 * asked about is retried by the Worker's own sweep.
 */
export async function cancelComputeJobAsAdmin(jobId: string): Promise<ComputeJobAdminResponse> {
  return request(
    `/admin/compute/jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST" },
    true,
    ComputeJobAdminResponseSchema,
  );
}

/**
 * `POST /admin/compute/jobs/:id/advance` (admin): one step of a job, wherever it is: a `created` job is
 * submitted, a submitted one is read back from Tapis and applied, and a finished one gets what it is
 * owed. The way a job advances in development, where no compute cron runs.
 */
export async function advanceComputeJobAsAdmin(jobId: string): Promise<ComputeJobAdminResponse> {
  return request(
    `/admin/compute/jobs/${encodeURIComponent(jobId)}/advance`,
    { method: "POST" },
    true,
    ComputeJobAdminResponseSchema,
  );
}

/**
 * `POST /admin/compute/pipeline/run` (admin): run a recipe over one dataset version, or over the next
 * datasets it has not been run over (`eligible` with a `limit`), or say what that would do (`dry_run`,
 * which reads only). A refusal about the one named dataset answers an error with its word in
 * `rawBody.code` (see {@link computeRefusalCode}); a run over the queue answers 200 with each dataset's
 * outcome and the word that stopped it, if one did (epic #2005 phase A6, #2011).
 */
export async function runComputePipeline(
  body: ComputePipelineRunRequest,
): Promise<ComputePipelineRunResponse> {
  return request(
    "/admin/compute/pipeline/run",
    { method: "POST", body: JSON.stringify(body) },
    true,
    ComputePipelineRunResponseSchema,
  );
}

/** What `GET /admin/compute/pipeline/status` filters by; `before` continues a page. */
export interface ComputePipelineStatusQuery {
  recipe?: string;
  dataset?: string;
  state?: string;
  before?: number;
  limit?: number;
}

/**
 * `GET /admin/compute/pipeline/status` (admin): the stamps, newest first, after the Worker synced them
 * with their jobs. `next_before` continues the page.
 */
export async function getComputePipelineStatus(
  q: ComputePipelineStatusQuery = {},
): Promise<ComputePipelineStatusResponse> {
  const params = new URLSearchParams();
  if (q.recipe) params.set("recipe", q.recipe);
  if (q.dataset) params.set("dataset", q.dataset);
  if (q.state) params.set("state", q.state);
  if (q.before !== undefined) params.set("before", String(q.before));
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  const query = params.toString() ? `?${params.toString()}` : "";
  return request(
    `/admin/compute/pipeline/status${query}`,
    {},
    true,
    ComputePipelineStatusResponseSchema,
  );
}

/**
 * The fixed word of a compute route's refusal (`rawBody.code`) and, for a refused dataset, the terms of
 * the eligibility predicate that block it (`rawBody.blocked_by`); undefined for anything else.
 */
export function computeRefusalCode(
  err: unknown,
): { code: string; blockedBy: string[] } | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const body = err.rawBody;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const { code, blocked_by: blocked } = body as Record<string, unknown>;
  if (typeof code !== "string") return undefined;
  const blockedBy = Array.isArray(blocked)
    ? blocked.filter((t): t is string => typeof t === "string")
    : [];
  return { code, blockedBy };
}
