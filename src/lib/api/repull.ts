/**
 * NEMAR API client: the record of an upstream re-pull (ADR 0111, decision 3; epic #1046 phase 6),
 * `/admin/repulls`. Admin role.
 *
 * The Worker records, verifies and refuses; execution runs on the administrator's machine and
 * reports each step here. A refusal answers `{ error: <sentence>, code: <word>, repull? }`: the
 * sentence is `ApiError.message`, and the word is read with {@link repullErrorCode}, never from
 * `ApiError.code` (which is the body's `error`, the sentence, under this convention).
 */

import type { RepullRow, RepullStatus } from "../../../shared/repull-state.js";
import { request } from "./client.js";
import { ApiError } from "./errors.js";

export interface CreateRepullRequest {
  dataset_id: string;
  upstream_ds: string;
  from_tag: string;
  to_tag: string;
  from_version: string;
  to_version: string;
  plan_digest: string;
  planner: number;
  base_sha: string;
  /** The administrator's assertion that the plan compared the from-version's tree with upstream's. */
  lineage_recordable: boolean;
  counts?: Record<string, number>;
}

export interface CreateRepullResponse {
  repull: RepullRow;
  /** False when the open record for the same plan was returned as it is. */
  created: boolean;
  lineage_rows: number;
}

/** `POST /admin/repulls`: create the record, or return the open one for the same plan. */
export async function createRepull(body: CreateRepullRequest): Promise<CreateRepullResponse> {
  return request<CreateRepullResponse>(
    "/admin/repulls",
    { method: "POST", body: JSON.stringify(body) },
    true,
  );
}

/** `GET /admin/repulls/:id`. */
export async function getRepull(id: number): Promise<RepullRow> {
  const res = await request<{ repull: RepullRow }>(`/admin/repulls/${id}`, {}, true);
  return res.repull;
}

/** `GET /admin/repulls`: newest first, a page of at most 50 (`next_after` continues it). */
export async function listRepulls(
  q: { dataset?: string; open?: boolean; after?: number; limit?: number } = {},
): Promise<{ repulls: RepullRow[]; next_after: number | null }> {
  const params = new URLSearchParams();
  if (q.dataset) params.set("dataset", q.dataset);
  if (q.open) params.set("open", "1");
  if (q.after !== undefined) params.set("after", String(q.after));
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  const query = params.toString() ? `?${params.toString()}` : "";
  return request<{ repulls: RepullRow[]; next_after: number | null }>(
    `/admin/repulls${query}`,
    {},
    true,
  );
}

/**
 * `POST /admin/repulls/:id/transition`: one allowed edge from the status the caller read, writing
 * only the columns the edge names, with `error` recorded through ADR 0051's rule.
 */
export async function transitionRepull(
  id: number,
  t: { from: RepullStatus; to: RepullStatus; fields?: Record<string, unknown>; error?: string },
): Promise<RepullRow> {
  const res = await request<{ repull: RepullRow }>(
    `/admin/repulls/${id}/transition`,
    { method: "POST", body: JSON.stringify(t) },
    true,
  );
  return res.repull;
}

/** One identifier screen of a re-pull's pull request, as the Worker shows it (counts, fixed words). */
export interface RepullScreen {
  pr: "n0" | "n1";
  sha: string;
  state: string | null;
  /** `clear`, `acknowledge`, `blocks`, `wait` or `rerun` (`shared/identifier-screen-report.ts`). */
  gate: string;
  headline: string;
  lines: string[];
  dispatched_at: string;
  reported_at: string | null;
  waiting: boolean;
  acknowledged_by: number | null;
  acknowledged_at: string | null;
}

/** `GET /admin/repulls/:id/screens`: newest first; an `xx` dataset is exempt and has none. */
export async function listRepullScreens(
  id: number,
): Promise<{ exempt: boolean; screens: RepullScreen[] }> {
  return request<{ exempt: boolean; screens: RepullScreen[] }>(
    `/admin/repulls/${id}/screens`,
    {},
    true,
  );
}

/**
 * `POST /admin/repulls/:id/screen`: dispatch the screen of the recorded head. A screen that already
 * exists for the commit is the Worker's 409 `screen-exists`, which carries it.
 */
export async function dispatchRepullScreen(
  id: number,
  target: { pr: "n0" | "n1"; sha: string },
): Promise<{ exempt: boolean; dispatched: boolean; screen: RepullScreen | null }> {
  return request<{ exempt: boolean; dispatched: boolean; screen: RepullScreen | null }>(
    `/admin/repulls/${id}/screen`,
    { method: "POST", body: JSON.stringify(target) },
    true,
  );
}

/** `POST /admin/repulls/:id/screen/acknowledge`: the administrator's reason (ADR 0086). */
export async function acknowledgeRepullScreen(
  id: number,
  body: { pr: "n0" | "n1"; sha: string; reason: string },
): Promise<{ screen: RepullScreen }> {
  return request<{ screen: RepullScreen }>(
    `/admin/repulls/${id}/screen/acknowledge`,
    { method: "POST", body: JSON.stringify(body) },
    true,
  );
}

/**
 * `POST /admin/repulls/:id/merge-claim/release`: free a claim to merge whose merge was not sent,
 * was refused, or (`expired`) whose outcome is not known and that is long past; the Worker reads
 * GitHub itself and keeps a claim whose pull request merged.
 */
export async function releaseRepullMergeClaim(
  id: number,
  body: { pr: "n0" | "n1"; sha: string; outcome: "not_sent" | "refused" | "expired" },
): Promise<RepullRow> {
  const res = await request<{ repull: RepullRow }>(
    `/admin/repulls/${id}/merge-claim/release`,
    { method: "POST", body: JSON.stringify(body) },
    true,
  );
  return res.repull;
}

/** `POST /admin/repulls/:id/merged`: the Worker reads the merge on GitHub and records it. */
export async function recordRepullMerged(
  id: number,
  pr: "n0" | "n1",
): Promise<{
  repull: RepullRow;
  merged_outside_tool: boolean;
  merged_unscreened_head: boolean;
  replayed: boolean;
}> {
  return request(
    `/admin/repulls/${id}/merged`,
    { method: "POST", body: JSON.stringify({ pr }) },
    true,
  );
}

/**
 * `POST /admin/repulls/:id/released`: the Worker reads the version row and the tag and records
 * the release; `tree_verified` is the caller's assertion that the tagged tree is the synthesized
 * one outside NEMAR's paths.
 */
export async function recordRepullReleased(
  id: number,
  body: { pr: "n0" | "n1"; tag_sha: string; tree_verified: boolean },
): Promise<{
  repull: RepullRow;
  lineage_rows: number | null;
  stamps_rearmed: number | null;
  replayed: boolean;
}> {
  return request(
    `/admin/repulls/${id}/released`,
    { method: "POST", body: JSON.stringify(body) },
    true,
  );
}

/** The closed word of a `/admin/repulls` refusal (`rawBody.code`), or undefined. */
export function repullErrorCode(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const body = err.rawBody;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const code = (body as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}
