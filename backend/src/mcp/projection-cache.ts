/**
 * Derived-projection cache for the recording-level MCP tools (epic #1065
 * phase 3, issue #1295; design doc section 7).
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
 * which is why every entry gets a full 7-day TTL regardless of tokening.
 * Contrast `zarr-data.ts`'s `cacheControlFor`: ITS tokened/untokened split
 * applies to `zarr.json` and the dataset-level documents (`index.json`,
 * `manifest.json`, `events.parquet`), which get a SHORT untokened TTL so a
 * re-conversion surfaces quickly there; a chunk object there gets the flat
 * 24h case regardless of tokening, because a chunk key does not change on
 * re-conversion -- the same reason every entry here gets one flat TTL, not
 * a token split of its own.
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

/** Bumped whenever a cached payload's SHAPE changes (a field renamed, an
 *  invariant tightened, a new required field). The last path segment of
 *  every `projectionUrl`, so a deploy that changes a payload shape can
 *  never read an entry a previous deploy wrote for it -- the entry simply
 *  lives at a different key and the old one ages out on its own 7-day TTL,
 *  never mixing an old and a new shape under one key. Bump this alongside
 *  any change to `RecordingsProjection`, the events row shape, or the
 *  `_stores` summary shape. */
export const PROJECTION_SCHEMA_VERSION = 1;

/** Synthetic cache key for a projection:
 *  `<host>/<id>/<commit>/<projection>/v<PROJECTION_SCHEMA_VERSION>`.
 *  `projection` is one of `"recordings"`, `` `events/${zarr}` ``,
 *  `"events/_stores"`, or `` `overview/${zarr}/${group}/${widthPx}` `` --
 *  see the three tool files for how each builds its own string. */
export function projectionUrl(datasetId: string, sourceCommit: string, projection: string): string {
  return `${PROJECTION_HOST}/${encodeURIComponent(datasetId)}/${encodeURIComponent(sourceCommit)}/${projection}/v${PROJECTION_SCHEMA_VERSION}`;
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

/** The minimal Standard-Schema-shaped validator every payload schema this
 *  file accepts must implement -- zod's own `.safeParse` already is one, so
 *  callers pass a real zod schema (`recordingsProjectionSchema`, an
 *  `z.array(eventRowSchema)`, the `_stores` schema) with no adapter. */
export interface ProjectionPayloadSchema<T> {
  safeParse: (input: unknown) => { success: boolean; data?: T };
}

/** Read a JSON projection, validated against `schema` (decision: every
 *  cached payload has a declared shape, checked on every hit, not just
 *  trusted because it round-tripped through `JSON.parse`). A cache miss, a
 *  `match()` throw, a stored entry that fails to parse as JSON, AND a
 *  stored entry that fails `schema` validation all answer the same
 *  `{status:"miss"}` -- a corrupt or stale-shaped cache entry is exactly as
 *  actionable as no entry at all: a fresh write on this call, at the
 *  CURRENT `PROJECTION_SCHEMA_VERSION` key. A schema mismatch is logged
 *  once with `console.warn` (not `console.error`: an expected, recoverable
 *  event across a deploy that changed a shape without also bumping
 *  `PROJECTION_SCHEMA_VERSION`, not an operational failure). */
export async function readJsonProjection<T>(
  cache: CacheLike,
  url: string,
  schema: ProjectionPayloadSchema<T>,
): Promise<ProjectionReadResult<T>> {
  const hit = await safeCacheMatch(cache, url);
  if (!hit) return { status: "miss" };
  let json: unknown;
  try {
    json = await hit.json();
  } catch (err) {
    console.error("[mcp] projection cache hit did not parse as JSON", { url }, err);
    return { status: "miss" };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.warn("[mcp] projection cache hit failed schema validation, treated as a miss", { url });
    return { status: "miss" };
  }
  return { status: "hit", value: parsed.data as T };
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
