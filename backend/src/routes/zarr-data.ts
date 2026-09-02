/**
 * zarr.nemar.org data plane (epic #684, Stream D enablement).
 *
 * The authoritative browser gateway for the per-recording Zarr serving copies.
 * The viewer (nemarOrg/website) reads stores from this host with zarrita; this
 * sub-app proxies the public S3 objects under `s3://<bucket>/<id>/zarr/...` and
 * adds the three things a browser needs that raw S3 does not give us here:
 *
 *   1. CORS restricted to NEMAR origins (so a third-party site can't cross-origin
 *      stream our chunks in a browser) -- the S3 data stays openly downloadable,
 *      but the *browser* path is funnelled through and gated here.
 *   2. Range pass-through (zarrita range-reads sharded level-0).
 *   3. Edge caching via the Workers Cache API (the hot path -- index.json,
 *      zarr.json, and the small non-sharded view-pyramid chunks -- is shared
 *      across all users and caches with a near-total hit rate). Phase 1
 *      (#1178 items 3-4, #1035) extended this to single-range chunk reads
 *      too, since level-0 is Range-only and every such request used to skip
 *      the edge entirely.
 *
 * Only PUBLIC datasets are served (private data is never browser-streamable).
 * Mounted on the `zarr.nemar.org` host fork in index.ts and path-mounted at
 * `/zarrproxy` for workers.dev/dev access.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { rateLimiter } from "../middleware/rateLimit.js";
import { recordAccess, zarrObjectType } from "../services/access-metrics";
import { normalizeBidsPath } from "../services/data-router";
import { isValidDatasetId } from "../services/datasetId";
import type { Bindings } from "../types/bindings.js";

/** Origins allowed to read zarr chunks cross-origin in a browser: the NEMAR
 *  web properties (+ localhost for dev). Anything else gets no
 *  Access-Control-Allow-Origin and is blocked by the browser -- which is what
 *  makes zarr.nemar.org the authoritative browser gateway. */
export function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  try {
    const { hostname } = new URL(origin);
    if (hostname === "localhost" || hostname === "127.0.0.1") return origin;
    if (hostname === "nemar.org" || hostname.endsWith(".nemar.org")) return origin;
  } catch {
    return null;
  }
  return null;
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const allow = allowedOrigin(origin);
  const headers: Record<string, string> = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range",
    // What zarrita needs to read back off the response.
    "Access-Control-Expose-Headers": "ETag, Content-Length, Content-Range, Accept-Ranges",
    "Access-Control-Max-Age": "86400",
  };
  if (allow) headers["Access-Control-Allow-Origin"] = allow;
  return headers;
}

function s3PublicUrl(env: Bindings, key: string, base?: string): string {
  // Test seam (#1178 phase 1): a real Bun.serve() upstream stands in for S3
  // in tests via deps.s3Base, instead of parsing env vars for a fake host.
  if (base) return `${base}/${key}`;
  // Public-read object (deny-list policy makes a public dataset's prefix public).
  const region = env.AWS_REGION || "us-east-2";
  return `https://${env.S3_BUCKET}.s3.${region}.amazonaws.com/${key}`;
}

/** Cache-Control for the origin + edge.
 *
 *  `tokened` is true when the request carried a non-empty `v` query
 *  parameter (the viewer's `?v=<updated_utc>` cache-busting token). A
 *  tokened URL is immutable by construction -- a re-conversion mints a new
 *  `v`, so the OLD url+v pair will never again resolve to different bytes --
 *  so it gets a full day of edge/browser caching. An untokened request
 *  (a bare fetch, or a viewer that hasn't picked up the new token yet) keeps
 *  a short TTL so a re-conversion surfaces quickly there instead.
 *
 *  index.json is 95% of Worker egress (#1035): the zarr-ready callback
 *  already purges it on rebuild (services/cloudflare.ts zarrPurgeTargets),
 *  so an untokened hour-long TTL is safe -- that purge is what actually
 *  invalidates it, not the TTL.
 *
 *  Chunk objects get a long TTL regardless of tokening: they're immutable
 *  for a given conversion and the /webhooks/zarr-ready purge handles the
 *  rare in-place replace. */
export function cacheControlFor(key: string, tokened: boolean): string {
  if (key.endsWith("/zarr.json")) {
    return tokened
      ? "public, max-age=86400, stale-while-revalidate=86400"
      : "public, max-age=60, stale-while-revalidate=300";
  }
  if (key.endsWith("/index.json")) {
    return tokened
      ? "public, max-age=86400, stale-while-revalidate=86400"
      : "public, max-age=3600, stale-while-revalidate=86400";
  }
  return "public, max-age=86400, stale-while-revalidate=86400";
}

/** Cache-Control for every 404 this route produces (bad path, private
 *  dataset, missing object). Short: a private dataset can flip to public,
 *  and a missing object can appear after a re-conversion, so this must not
 *  be pinned for long even where it IS cached at the edge (see the
 *  missing-object branch in serve() below). */
const NOT_FOUND_CACHE_CONTROL = "public, max-age=60";

/**
 * Canonical edge-cache key: origin + path + at most the `v` query
 * parameter. Every other query parameter is dropped -- including a
 * client-supplied `__cr` (see rangeCacheUrl below), which would otherwise
 * let a request poison the range-keyed cache by forging the synthetic
 * parameter, and any other param a viewer might attach. This also lets a
 * `?v=` tokened request and an untokened request for the same object share
 * a cache entry keyspace distinction that's meaningful (tokened vs not),
 * rather than fragmenting on every unrelated query string.
 */
export function canonicalCacheUrl(reqUrl: URL): string {
  const canonical = new URL(`${reqUrl.origin}${reqUrl.pathname}`);
  const v = reqUrl.searchParams.get("v");
  if (v) canonical.searchParams.set("v", v);
  return canonical.toString();
}

/**
 * Range-keyed cache URL: the canonical URL plus one extra query parameter
 * carrying the normalised range (e.g. `__cr=bytes%3D0-999`).
 *
 * A URL *fragment* can't be used for this: the Cache API keys purely on the
 * request URL and, like a browser, never transmits or stores anything after
 * `#`, so two different ranges "keyed" by fragment would collide on the same
 * entry. A query parameter IS visible to (and keyable by) the Cache API,
 * which is why the range rides there instead.
 */
function rangeCacheUrl(canonical: string, normalizedRange: string): string {
  const url = new URL(canonical);
  url.searchParams.set("__cr", normalizedRange);
  return url.toString();
}

/**
 * Parse a `Range` header into the normalised (lowercase, whitespace-stripped)
 * single-range spec, but only for exactly one `bytes=A-B`, `bytes=A-`, or
 * `bytes=-N` range. Anything else -- multiple ranges, a non-bytes unit, or a
 * malformed spec -- returns null so the caller passes the request through
 * uncached, exactly as any Range request did before this change.
 */
export function parseCacheableRange(header: string): string | null {
  const normalized = header.replace(/\s+/g, "").toLowerCase();
  return /^bytes=(\d+-\d+|\d+-|-\d+)$/.test(normalized) ? normalized : null;
}

async function isPublicDataset(env: Bindings, datasetId: string): Promise<boolean> {
  if (!isValidDatasetId(datasetId)) return false;
  const row = await env.DB.prepare("SELECT visibility FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ visibility: string }>();
  return row?.visibility === "public";
}

/** Minimal shape of the Workers Cache API surface this route uses, so tests
 *  can supply a real in-memory implementation -- bun:test has neither
 *  `caches` nor a Worker-shaped `fetch` global, see ZarrDataDeps below. */
export type CacheLike = Pick<Cache, "match" | "put">;

/** Dependency seam for tests (#1178 phase 1). `cache` is a thunk, not a bare
 *  value, so `defaultDeps.cache()` reads `caches.default` lazily on each
 *  request rather than at module load -- evaluating `caches.default` at
 *  import time throws outside a Worker (bun:test included). `s3Base` lets
 *  tests point the route at a local Bun.serve() standing in for S3 instead
 *  of parsing env vars for a fake host. */
export interface ZarrDataDeps {
  cache: () => CacheLike;
  fetch: typeof fetch;
  s3Base?: string;
}

const defaultDeps: ZarrDataDeps = {
  cache: () => caches.default,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
};

/**
 * Rebuild the client-facing response from a cache hit.
 *
 *  - The Cache API does not honour `Vary: Origin` the way a browser cache
 *    does -- `match()` here is keyed purely on our own canonical/range URL,
 *    never on request headers, so one stored entry is shared across every
 *    requesting origin regardless of which origin primed it. CORS therefore
 *    has to be reapplied per request rather than trusted from the stored
 *    copy: delete the priming requester's ACAO first (corsHeaders omits
 *    ACAO for a blocked origin, so the loop below wouldn't overwrite a
 *    stale allowed value), then set the current origin's headers.
 *  - The Cache API refuses to store a 206 response at all (`cache.put`
 *    throws), so a range entry was written as a synthetic 200 with the
 *    upstream Content-Range preserved under `X-Nemar-Content-Range` (see
 *    the cache-put branch in serve()). Restore the real 206 + Content-Range
 *    here, on the way back out, and drop the synthetic header.
 */
function respondFromCache(
  hit: Response,
  cors: Record<string, string>,
  env: Bindings,
  datasetId: string,
  key: string,
): Response {
  const headers = new Headers(hit.headers);
  headers.delete("Access-Control-Allow-Origin");
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);

  let status = hit.status;
  const storedRange = headers.get("x-nemar-content-range");
  if (storedRange) {
    headers.delete("x-nemar-content-range");
    headers.set("content-range", storedRange);
    status = 206;
  }

  // Only a data entry (stored as a synthetic/real 200) represents served
  // bytes; a cached missing-object 404 (see serve()) is stored as a literal
  // 404 and must not be counted as an access.
  if (hit.status === 200) {
    // The event count is exact; bytes fall back to 0 if the cached entry has
    // no content-length (the Cache API may not preserve it) -- acceptable,
    // the read side treats bytes as best-effort, not an event count.
    recordAccess(env, {
      datasetId,
      source: "zarr",
      detail: zarrObjectType(key),
      bytes: Number(headers.get("content-length")) || 0,
    });
  }

  return new Response(hit.body, { status, headers });
}

/**
 * GET/HEAD /<id>/zarr/<path> -> proxied, CORS'd, edge-cached S3 object.
 *
 * `*` captures everything after `/<id>/zarr/`, so the S3 key is exactly
 * `<id>/zarr/<rest>` (the producer writes index.json + every store under that
 * prefix). The full path is re-derived from the URL rather than the `*` param
 * so encoded segments survive intact.
 */
async function serve(c: Context<{ Bindings: Bindings }>, isHead: boolean, deps: ZarrDataDeps) {
  const origin = c.req.header("origin") ?? null;
  const cors = corsHeaders(origin);
  const datasetId = c.req.param("datasetId");

  const prefix = `/${datasetId}/zarr/`;
  const idx = c.req.path.indexOf(prefix);
  const rawRest = idx === -1 ? "" : c.req.path.slice(idx + prefix.length);
  const rest = normalizeBidsPath(decodeURIComponent(rawRest));
  if (rest === null || rest === "") {
    return c.body(null, 404, { ...cors, "Cache-Control": NOT_FOUND_CACHE_CONTROL });
  }
  const key = `${datasetId}/zarr/${rest}`;

  const reqUrl = new URL(c.req.url);
  const tokened = Boolean(reqUrl.searchParams.get("v"));
  const canonical = canonicalCacheUrl(reqUrl);

  const rangeHeader = c.req.header("range");
  const normalizedRange = rangeHeader ? parseCacheableRange(rangeHeader) : null;
  // A Range header that isn't exactly one bytes-range (multi-range,
  // malformed, non-bytes) passes through uncached -- same as any Range
  // request did before this change.
  const bypassCache = Boolean(rangeHeader) && normalizedRange === null;
  const cacheKeyUrl = normalizedRange ? rangeCacheUrl(canonical, normalizedRange) : canonical;
  const cache = deps.cache();

  // Edge cache lookup: full-object GETs under the canonical key, an
  // accepted single-range GET under its range key. HEAD and a bypassed
  // Range never consult the cache.
  if (!isHead && !bypassCache) {
    const hit = await cache.match(new Request(cacheKeyUrl, { method: "GET" }));
    if (hit) {
      return respondFromCache(hit, cors, c.env, datasetId, key);
    }
  }

  // Gate on cache miss only (a cached object/404 was already gated when
  // first stored). This per-request D1 read on cache misses mirrors the
  // data.nemar.org route's loadPublishedDataset gate (both data-plane hosts
  // bypass the api rate limiter by design); the non-Worker cache-rule
  // migration noted in the runbook removes the Worker + D1 from the hot
  // path entirely if viewing volume warrants it.
  if (!(await isPublicDataset(c.env, datasetId))) {
    return c.body(null, 404, { ...cors, "Cache-Control": NOT_FOUND_CACHE_CONTROL });
  }

  const upstream = await deps.fetch(s3PublicUrl(c.env, key, deps.s3Base), {
    method: isHead ? "HEAD" : "GET",
    headers: rangeHeader ? { Range: rangeHeader } : undefined,
  });
  if (upstream.status === 403 || upstream.status === 404) {
    // Missing object (or not actually public in S3) -> clean 404, not a
    // leak. Cache it at the canonical key (dropping any range -- the 404 is
    // about the object, not any one byte window of it) so a probe storm for
    // a missing object (e.g. an unconverted view level) stops at the edge
    // instead of re-hitting S3 on every retry. HEAD probes are excluded
    // (never cached, never put, see below), as is the private-dataset 404
    // above -- that gate's state can flip and must not be pinned at the edge.
    if (!isHead) {
      const notFound = new Response(null, {
        status: 404,
        headers: { "Cache-Control": NOT_FOUND_CACHE_CONTROL },
      });
      c.executionCtx.waitUntil(cache.put(new Request(canonical, { method: "GET" }), notFound));
    }
    return c.body(null, 404, { ...cors, "Cache-Control": NOT_FOUND_CACHE_CONTROL });
  }
  if (!upstream.ok && upstream.status !== 206) {
    return c.body(null, 502, cors);
  }

  const headers = new Headers(cors);
  for (const h of ["content-type", "content-length", "content-range", "etag", "last-modified"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", cacheControlFor(key, tokened));

  const body = isHead ? null : upstream.body;
  const res = new Response(body, { status: upstream.status, headers });

  // Count served bytes (full objects and Range chunks; skip HEAD probes).
  if (!isHead && (upstream.status === 200 || upstream.status === 206)) {
    recordAccess(c.env, {
      datasetId,
      source: "zarr",
      detail: zarrObjectType(key),
      bytes: Number(headers.get("content-length")) || 0,
    });
  }

  // Cache at the edge. clone() so the body is still streamable to the
  // client while waitUntil writes the cache copy.
  //  - A full-object 200 (no Range header at all) caches under the
  //    canonical key, as before this change.
  //  - An accepted single-range 206 caches under the range key, but the
  //    Workers Cache API refuses to store a 206 response outright -- so it
  //    is written as a synthetic 200, with Content-Range moved to
  //    X-Nemar-Content-Range, and rebuilt back into a real 206 on the way
  //    out (respondFromCache above).
  //  - A bypassed Range (multi-range/malformed) is never cached, and
  //    neither is any other non-206 answer to an accepted range (e.g. 416).
  if (!isHead && !bypassCache) {
    if (!rangeHeader && upstream.status === 200) {
      c.executionCtx.waitUntil(cache.put(new Request(cacheKeyUrl, { method: "GET" }), res.clone()));
    } else if (normalizedRange && upstream.status === 206) {
      const cacheHeaders = new Headers(headers);
      const contentRange = cacheHeaders.get("content-range");
      cacheHeaders.delete("content-range");
      if (contentRange) cacheHeaders.set("x-nemar-content-range", contentRange);
      const cacheEntry = new Response(res.clone().body, { status: 200, headers: cacheHeaders });
      c.executionCtx.waitUntil(cache.put(new Request(cacheKeyUrl, { method: "GET" }), cacheEntry));
    }
  }
  return res;
}

/** Build the zarr.nemar.org sub-app. `deps` is the dependency seam (#1178
 *  phase 1) that lets tests supply a real in-memory cache and a real local
 *  upstream instead of the Workers-only `caches.default` / bare `fetch`.
 *  Defaults to the real bindings so `index.ts` (which imports the plain
 *  `zarrDataRoutes` export below) is untouched. */
export function createZarrDataRoutes(
  deps: ZarrDataDeps = defaultDeps,
): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();

  // #901: the zarr host fork in index.ts dispatches straight here, bypassing the
  // api middleware stack (and its rate limiter). As the highest-volume data-plane
  // path this ran unthrottled. Apply the shared data-plane rate-limit bucket
  // (__selectBucket routes /<id>/zarr/* to the generous DATA bucket), but let CORS
  // preflights through un-throttled so a 429 never strips the preflight's headers.
  // The cast bridges this sub-app's Bindings-only generic to rateLimiter's
  // Bindings+Variables context; rateLimiter only touches env/req/header + its own
  // Variables slot, all present at runtime on any Hono context.
  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const res = await rateLimiter(c as unknown as Parameters<typeof rateLimiter>[0], next);
    // rateLimiter returns a bare 429 (no zarr CORS) when the bucket is exhausted;
    // without ACAO the browser sees an opaque failure instead of a readable 429 +
    // retry_after. Re-apply the zarr CORS headers so the viewer can back off.
    if (res && res.status === 429) {
      for (const [k, v] of Object.entries(corsHeaders(c.req.header("origin") ?? null))) {
        res.headers.set(k, v);
      }
    }
    return res;
  });

  // Preflight: answer for any path so the browser's OPTIONS check passes before
  // the real GET. No D1/S3 work here.
  app.options("/*", (c) => c.body(null, 204, corsHeaders(c.req.header("origin") ?? null)));

  // Hono auto-derives HEAD from the GET handler, re-dispatching the original
  // request with method still "HEAD"; serve() reads that to skip the body and do
  // an upstream HEAD instead of fetching bytes.
  app.get("/:datasetId/zarr/*", (c) => serve(c, c.req.method === "HEAD", deps));

  // Friendly root so a bare zarr.nemar.org/ doesn't 404 confusingly.
  app.get("/", (c) =>
    c.json(
      { service: "zarr.nemar.org", usage: "/<dataset_id>/zarr/<path>.zarr/..." },
      200,
      corsHeaders(c.req.header("origin") ?? null),
    ),
  );

  return app;
}

export const zarrDataRoutes = createZarrDataRoutes();
