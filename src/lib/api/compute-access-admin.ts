/**
 * NEMAR API client: an administrator's decisions on compute access (epic #2021 phase D1, #2022;
 * ADR 0118, the compute-access addendum), `/admin/compute/access`. Admin and owner roles.
 *
 * Every response is parsed with an OPEN schema (shared/contract/compute-access.ts): a Worker that adds a
 * key must not break a released CLI. A refusal answers `{ error: <sentence>, code: <word> }`: the
 * sentence is `ApiError.message` and the word is in `ApiError.rawBody.code`, which `computeRefusalCode`
 * (./compute.ts) reads for every compute route.
 */

import type { ComputeAccessDecision } from "../../../shared/compute-access-state.js";
import {
  COMPUTE_ACCESS_ADMIN_ERROR_CODES,
  type ComputeAccessDecisionResponse,
  type ComputeAccessListResponse,
  computeAccessDecisionResponseSchema,
  computeAccessListResponseSchema,
} from "../../../shared/contract/compute-access.js";
import { request } from "./client.js";
import { ApiError } from "./errors.js";

/** What `GET /admin/compute/access` filters by; `after` continues a page. */
export interface ComputeAccessListQuery {
  state?: string;
  limit?: number;
  after?: number;
}

/** `GET /admin/compute/access` (admin): a page of accounts with a compute-access state, oldest account first. */
export async function listComputeAccess(
  query: ComputeAccessListQuery = {},
): Promise<ComputeAccessListResponse> {
  const params = new URLSearchParams();
  if (query.state !== undefined) params.set("state", query.state);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.after !== undefined) params.set("after", String(query.after));
  const qs = params.size > 0 ? `?${params.toString()}` : "";
  return request(`/admin/compute/access${qs}`, {}, true, computeAccessListResponseSchema);
}

/** The account a decision is about: a username, or the numeric id of an account with none. */
export type ComputeAccessTarget = { username: string } | { id: number };

/**
 * `POST /admin/compute/access/{grant|deny|suspend|revoke}/...` (admin): decide. The optional reason is
 * recorded on the audit row and is NOT sent to the person. A grant opens the owner's default allocation
 * once; a suspension and a revocation freeze the person's pools and end their live compute.
 */
export async function decideComputeAccess(
  decision: ComputeAccessDecision,
  target: ComputeAccessTarget,
  reason?: string,
): Promise<ComputeAccessDecisionResponse> {
  const where =
    "id" in target
      ? `by-id/${target.id}`
      : encodeURIComponent((target as { username: string }).username);
  return request(
    `/admin/compute/access/${decision}/${where}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reason === undefined ? {} : { reason }),
    },
    true,
    computeAccessDecisionResponseSchema,
  );
}

/** The fixed word of a refused decision (`rawBody.code`), or undefined for anything else. */
export function computeAccessAdminErrorCode(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const code = (err.rawBody as { code?: unknown } | undefined)?.code;
  return typeof code === "string" &&
    (COMPUTE_ACCESS_ADMIN_ERROR_CODES as readonly string[]).includes(code)
    ? code
    : undefined;
}
