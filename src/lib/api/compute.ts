/**
 * NEMAR API client: the compute gateway's policy and allocation pools (epic #2005 phase A2, #2007;
 * ADR 0118), `/admin/compute`. Owner and admin roles.
 *
 * Every response is parsed with an OPEN schema (shared/contract/compute-admin.ts): a Worker that
 * adds a key, at the top level or nested, must not break a released CLI. The strict schema of the
 * owner policy is for what `policy set` sends, and `policy show` never parses a response with it.
 * A refusal answers `{ error: <sentence>, code: <word> }`: the sentence is `ApiError.message`, and
 * the word is read with {@link computeErrorCode}, never from `ApiError.code` (which is the body's
 * `error`, the sentence, under this convention).
 */

import {
  type ComputeAccountPoolsResponse,
  ComputeAccountPoolsResponseSchema,
  type ComputePolicyResponse,
  ComputePolicyResponseSchema,
  type ComputePoolAdjustRequest,
  type ComputePoolGrantRequest,
  type ComputePoolHolderKind,
  type ComputePoolWriteResponse,
  ComputePoolWriteResponseSchema,
  type ComputePoolsResponse,
  ComputePoolsResponseSchema,
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

/** The closed word of a `/admin/compute` refusal (`rawBody.code`), or undefined. */
export function computeErrorCode(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const body = err.rawBody;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const code = (body as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}
