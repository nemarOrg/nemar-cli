/**
 * Derived-projection cache for the recording-level MCP tools (epic #1065
 * phase 3, issue #1295; plan decision 4; design doc section 7).
 *
 * `index.json` is fetched through the real zarr sub-app and its own edge
 * cache (`index-reader.ts`); the compact PROJECTIONS this file caches --
 * `list_recordings`' full recording list, `get_events`' per-store row
 * groups, and `render_overview`'s rendered PNG bytes -- are a SEPARATE
 * cache layer keyed on synthetic `https://mcp.nemar.org/_cache/...` URLs.
 * `mcp.nemar.org` here is a constant key NAMESPACE, never a real route the
 * MCP sub-app answers -- these keys exist only inside the Cache API.
 *
 * Immutable per `(dataset_id, source_commit)`: a re-conversion mints a new
 * `source_commit`, so the OLD key never again resolves to different bytes,
 * which is why every entry gets a full 7-day TTL regardless of tokening
 * (contrast `zarr-data.ts`'s `cacheControlFor`, which has to split
 * tokened/untokened because a chunk key does NOT change on re-conversion).
 *
 * `put()` always goes through `ctx.waitUntil` and is never awaited on the
 * response path -- the same `safeCachePut` discipline `zarr-data.ts` uses:
 * a `CacheLike.put` that throws (synchronously OR as a rejected promise) is
 * caught, logged once, and treated as though the write never happened,
 * never as a request failure.
 */

import type { CacheLike } from "../routes/zarr-data.js";

/** 7 days: immutable per `(dataset_id, source_commit)` (see module doc). */
export const PROJECTION_CACHE_CONTROL = "public, max-age=604800";

const PROJECTION_HOST = "https://mcp.nemar.org/_cache";

/** Synthetic cache key for a projection: `<host>/<id>/<commit>/<projection>`.
 *  `projection` is one of `"recordings"`, `` `events/${zarr}` ``,
 *  `"events/_stores"`, or `` `overview/${zarr}/${group}/${widthPx}` `` --
 *  see the three tool files for how each builds its own string. */
export function projectionUrl(datasetId: string, sourceCommit: string, projection: string): string {
  return `${PROJECTION_HOST}/${encodeURIComponent(datasetId)}/${encodeURIComponent(sourceCommit)}/${projection}`;
}

async function safeCacheMatch(cache: CacheLike, url: string): Promise<Response | undefined> {
  try {
    return await cache.match(new Request(url, { method: "GET" }));
  } catch (err) {
    console.error("[mcp] projection cache.match failed", { url }, err);
    return undefined;
  }
}

/** Mirrors `zarr-data.ts`'s `safeCachePut`: a plain (non-async) `put` can
 *  throw SYNCHRONOUSLY, so the call is wrapped in try/catch rather than
 *  `.catch()`, which only ever observes a rejected promise. */
async function safeCachePutEntry(cache: CacheLike, url: string, entry: Response): Promise<void> {
  try {
    await cache.put(new Request(url, { method: "GET" }), entry);
  } catch (err) {
    console.error("[mcp] projection cache.put failed", { url }, err);
  }
}

export type ProjectionReadResult<T> = { status: "hit"; value: T } | { status: "miss" };

/** Read a JSON projection. A cache miss, a `match()` throw, and a stored
 *  entry that fails to parse as JSON all answer the same `{status:"miss"}`
 *  -- a corrupt cache entry is exactly as actionable as no entry at all: a
 *  fresh write on this call. */
export async function readJsonProjection<T>(
  cache: CacheLike,
  url: string,
): Promise<ProjectionReadResult<T>> {
  const hit = await safeCacheMatch(cache, url);
  if (!hit) return { status: "miss" };
  try {
    return { status: "hit", value: (await hit.json()) as T };
  } catch (err) {
    console.error("[mcp] projection cache hit did not parse as JSON", { url }, err);
    return { status: "miss" };
  }
}

/** Write a JSON projection via `ctx.waitUntil` -- never awaited on the
 *  response path, per the module doc. */
export function writeJsonProjection(
  executionCtx: ExecutionContext,
  cache: CacheLike,
  url: string,
  value: unknown,
): void {
  const entry = new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": PROJECTION_CACHE_CONTROL },
  });
  executionCtx.waitUntil(safeCachePutEntry(cache, url, entry));
}

export type BinaryProjectionReadResult =
  | { status: "hit"; bytes: Uint8Array; contentType: string | null }
  | { status: "miss" };

/** Read a binary projection (the `render_overview` PNG). */
export async function readBinaryProjection(
  cache: CacheLike,
  url: string,
): Promise<BinaryProjectionReadResult> {
  const hit = await safeCacheMatch(cache, url);
  if (!hit) return { status: "miss" };
  try {
    return {
      status: "hit",
      bytes: new Uint8Array(await hit.arrayBuffer()),
      contentType: hit.headers.get("content-type"),
    };
  } catch (err) {
    console.error("[mcp] projection cache hit did not read as bytes", { url }, err);
    return { status: "miss" };
  }
}

/** Write a binary projection via `ctx.waitUntil`. */
export function writeBinaryProjection(
  executionCtx: ExecutionContext,
  cache: CacheLike,
  url: string,
  bytes: Uint8Array,
  contentType: string,
): void {
  const entry = new Response(bytes, {
    status: 200,
    headers: { "Content-Type": contentType, "Cache-Control": PROJECTION_CACHE_CONTROL },
  });
  executionCtx.waitUntil(safeCachePutEntry(cache, url, entry));
}
