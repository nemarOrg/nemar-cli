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
 *   2. Range pass-through (zarrita range-reads sharded level-0); a single
 *      accepted byte-range is now edge-cached too, not just relayed
 *      (#1178 phase 1) -- see item 3.
 *   3. Edge caching via the Workers Cache API (the hot path -- index.json,
 *      zarr.json, the small non-sharded view-pyramid chunks, and now
 *      single-range chunk reads -- is shared across all users and caches
 *      with a near-total hit rate). Before phase 1, every Range request
 *      (which level-0 always is) skipped the edge entirely.
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
 *  index.json is 95% of Worker egress (#1035). The zarr-ready callback
 *  purges it on rebuild via zarrPurgeTargets() (services/cloudflare.ts) --
 *  but CLOUDFLARE_API_TOKEN/CLOUDFLARE_ZONE_ID are unset in production today
 *  (wrangler-sccn.toml), so that purge is currently a documented no-op and
 *  the TTL below is the ONLY bound on staleness right now, not a backstop
 *  under an active purge. (Separately: Cloudflare's purge-by-URL cannot
 *  reach a Cache API entry stored under a custom cache key -- that applies
 *  to the `__cr` range entries above, NOT to index.json, whose cache key
 *  equals its own URL.) Raising this TTL further should wait until the
 *  purge is verified working in staging once the zone id is provisioned.
 *
 *  Chunk objects get a long TTL regardless of tokening and are never a
 *  purge target -- zarrPurgeTargets() only ever lists index.json and each
 *  changed store's zarr.json, never a chunk URL (enumerating every chunk
 *  for a URL-list purge isn't worthwhile, and prefix purge is
 *  Enterprise-only) -- so chunks rely entirely on the 24h TTL plus ETag
 *  revalidation, with no purge backstop at all, active or not. */
export function cacheControlFor(key: string, opts: { tokened: boolean }): string {
  const { tokened } = opts;
  if (key.endsWith("/zarr.json")) {
    return tokened
      ? "public, max-age=86400, stale-while-revalidate=86400"
      : "public, max-age=60, stale-while-revalidate=300";
  }
  if (key.endsWith("/index.json")) {
    return tokened
      ? "public, max-age=86400, stale-while-revalidate=86400"
      : "public, max-age=300, stale-while-revalidate=3600";
  }
  return "public, max-age=86400, stale-while-revalidate=86400";
}

/** Cache-Control for every 404 this route produces (bad path, private
 *  dataset, missing object). Short: a private dataset can flip to public,
 *  and a missing object can appear after a re-conversion, so this must not
 *  be pinned for long even where it IS cached at the edge (see the
 *  missing-object branch in serve() below). */
const NOT_FOUND_CACHE_CONTROL = "public, max-age=60";

/** Header carrying the real upstream Content-Range while a range entry is
 *  stored at the edge as a synthetic 200 (the Cache API refuses to store a
 *  206 outright). Both the write site (serve()'s cache-put branch) and the
 *  read site (respondFromCache()) reference this one constant so the header
 *  name can't drift between them. */
const NEMAR_CONTENT_RANGE_HEADER = "x-nemar-content-range";

/** Skip the edge cache for anything above these sizes, rather than let one
 *  huge object crowd out the working set or exceed whatever per-entry size
 *  limit the real Workers Cache API enforces. Applied only once the
 *  upstream Content-Length is known; an object with no Content-Length is
 *  never cached either, since its size can't be checked (#1181 review
 *  item 4). Exported so tests can build fixtures at the exact boundary
 *  instead of hand-copying these numbers. */
export const RANGE_CACHE_MAX_BYTES = 8 * 1024 * 1024;
export const FULL_OBJECT_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** A range spec that has passed parseCacheableRange(): exactly one
 *  `bytes=A-B` / `bytes=A-` / `bytes=-N`, lowercased and whitespace-free. */
export type NormalizedRange = string & { readonly __brand: "NormalizedRange" };

/** A cache key built by canonicalCacheUrl(): origin + re-encoded S3 key
 *  (+ `v` if tokened), never a raw, possibly differently-encoded request
 *  pathname. */
export type CanonicalCacheUrl = string & { readonly __brand: "CanonicalCacheUrl" };

/**
 * Canonical edge-cache key for an object: origin + "/" + the normalised S3
 * key, with each path segment individually `encodeURIComponent`'d, plus the
 * `v` query parameter when present.
 *
 * Deriving this from the already-decoded/normalised `key` -- not the raw
 * request pathname -- means two differently percent-encoded spellings of
 * the same object collapse onto the identical cache key instead of
 * fragmenting the cache into one entry per spelling. No other query
 * parameter can leak in either: `v` is the only one the caller (serve())
 * ever reads off the request before calling this.
 */
export function canonicalCacheUrl(
  origin: string,
  key: string,
  v: string | null,
): CanonicalCacheUrl {
  const encodedPath = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const url = new URL(`${origin}/${encodedPath}`);
  if (v) url.searchParams.set("v", v);
  return url.toString() as CanonicalCacheUrl;
}

/**
 * Range-keyed cache URL: the canonical URL plus one extra query parameter
 * carrying the normalised range (e.g. `__cr=bytes%3D0-999`).
 *
 * A URL *fragment* can't be used for this: per RFC 3986 a fragment is
 * client-side only and is never transmitted to a server as part of a
 * request, so the Cache API -- which keys purely on the request it's
 * given -- would never see it; two different ranges "keyed" by fragment
 * would be indistinguishable to it and collide on one entry. A query
 * parameter IS part of the request, hence visible to (and keyable by) the
 * Cache API, which is why the range rides there instead.
 */
function rangeCacheUrl(canonical: CanonicalCacheUrl, normalizedRange: NormalizedRange): string {
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
export function parseCacheableRange(header: string): NormalizedRange | null {
  const normalized = header.replace(/\s+/g, "").toLowerCase();
  return /^bytes=(\d+-\d+|\d+-|-\d+)$/.test(normalized) ? (normalized as NormalizedRange) : null;
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

/** Write to the edge cache without letting a rejected (or throwing)
 *  `cache.put()` surface as an unhandled rejection under `waitUntil` --
 *  Workers reports those as a bare isolate error with none of this
 *  context. `key` is the S3 object key (for log correlation); `cacheKeyUrl`
 *  is the actual cache key that was written (#1181 review item 6). */
async function safeCachePut(
  cache: CacheLike,
  cacheKeyUrl: string,
  key: string,
  entry: Response,
): Promise<void> {
  // A plain (non-async) CacheLike.put can throw SYNCHRONOUSLY -- the
  // documented Cache API behaviour for a 206 -- rather than returning a
  // rejected promise. Wrapping the call in a try/catch (not
  // Promise.resolve(cache.put(...)).catch(...), which only ever sees a
  // rejection: a synchronous throw during the cache.put(...) call
  // expression happens before Promise.resolve is even reached) catches
  // both shapes of failure the same way.
  try {
    await cache.put(new Request(cacheKeyUrl, { method: "GET" }), entry);
  } catch (err) {
    console.error("[zarr-data] cache.put failed", { key, cacheKeyUrl }, err);
  }
}

/**
 * Rebuild the client-facing response from a cache hit (a data entry OR a
 * cached missing-object 404 -- both flow through here).
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
 *    upstream Content-Range preserved under NEMAR_CONTENT_RANGE_HEADER (see
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
  const storedRange = headers.get(NEMAR_CONTENT_RANGE_HEADER);
  if (storedRange) {
    headers.delete(NEMAR_CONTENT_RANGE_HEADER);
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

  // Gate FIRST, before ANY cache lookup, on every request regardless of hit
  // or miss (#1181 review item 1): a dataset flipped to private must stop
  // being served immediately, not up to a day later when the last-primed
  // cache entry's TTL happens to expire. One indexed D1 point read; this
  // mirrors the data.nemar.org route's loadPublishedDataset gate (both
  // data-plane hosts bypass the api rate limiter by design). A Range
  // request always paid this cost even before there was a cache to check
  // (Range responses were never cached pre-#1178), so this is not a new
  // cost on that path -- only a now-universal one on the full-object and
  // negative-404 paths that used to be gated "on miss only". Keeping the
  // missing-object 404 negative cache below is safe precisely because this
  // gate now runs first: a cache lookup can only ever be reached once we've
  // reconfirmed the dataset is CURRENTLY public.
  if (!(await isPublicDataset(c.env, datasetId))) {
    return c.body(null, 404, { ...cors, "Cache-Control": NOT_FOUND_CACHE_CONTROL });
  }

  const reqUrl = new URL(c.req.url);
  const v = reqUrl.searchParams.get("v");
  const tokened = Boolean(v);
  const canonical = canonicalCacheUrl(reqUrl.origin, key, v);

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
    if (normalizedRange) {
      // The range key missed. Also check the canonical (no-range) key: if a
      // PRIOR request already cached this object as missing (404), reuse
      // that instead of re-hitting S3 for every distinct range a client
      // probes -- otherwise a ranged probe storm against one missing object
      // never converges, since each new range mints its own cache key
      // (#1181 review item 2). A cached full-object 200 at the canonical
      // key is deliberately NOT reused here -- answering a specific byte
      // range with the full body would be wrong.
      const canonicalHit = await cache.match(new Request(canonical, { method: "GET" }));
      if (canonicalHit && canonicalHit.status === 404) {
        return respondFromCache(canonicalHit, cors, c.env, datasetId, key);
      }
    }
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
    // (never cached, never put, see below).
    if (!isHead) {
      const notFound = new Response(null, {
        status: 404,
        headers: { "Cache-Control": NOT_FOUND_CACHE_CONTROL },
      });
      c.executionCtx.waitUntil(safeCachePut(cache, canonical, key, notFound));
    }
    return c.body(null, 404, { ...cors, "Cache-Control": NOT_FOUND_CACHE_CONTROL });
  }
  if (upstream.status === 416) {
    // Out-of-range single-range request: pass the real status through
    // (never collapse it into the generic 502 mapping below) with whatever
    // Content-Range upstream sent, uncached (#1181 review item 5).
    const cr = upstream.headers.get("content-range");
    return c.body(null, 416, cr ? { ...cors, "Content-Range": cr } : cors);
  }
  if (!upstream.ok && upstream.status !== 206) {
    return c.body(null, 502, cors);
  }

  const headers = new Headers(cors);
  for (const h of ["content-type", "content-length", "content-range", "etag", "last-modified"]) {
    const hv = upstream.headers.get(h);
    if (hv) headers.set(h, hv);
  }
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", cacheControlFor(key, { tokened }));

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
  // client while waitUntil writes the cache copy. Both branches below skip
  // the clone()/put() entirely (stream straight through, no edge copy) when
  // Content-Length is missing or exceeds the relevant size cap (#1181
  // review item 4) -- there is no cap-then-drop; the cap is checked BEFORE
  // any clone happens.
  //  - A full-object 200 (no Range header at all) caches under the
  //    canonical key, as before this change.
  //  - An accepted single-range 206 caches under the range key, but the
  //    Workers Cache API refuses to store a 206 response outright -- so it
  //    is written as a synthetic 200, with Content-Range moved to
  //    NEMAR_CONTENT_RANGE_HEADER, and rebuilt back into a real 206 on the
  //    way out (respondFromCache above). A 206 that arrives with no
  //    Content-Range at all is a fail-closed case: don't guess, just stream
  //    it through uncached and warn (#1181 review item 3).
  //  - A bypassed Range (multi-range/malformed) is never cached, and
  //    neither is any other non-206 answer to an accepted range (e.g. a 200
  //    that ignored the Range entirely).
  if (!isHead && !bypassCache) {
    const contentLengthHeader = headers.get("content-length");
    const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;

    if (!rangeHeader && upstream.status === 200) {
      if (contentLength !== null && contentLength <= FULL_OBJECT_CACHE_MAX_BYTES) {
        c.executionCtx.waitUntil(safeCachePut(cache, cacheKeyUrl, key, res.clone()));
      }
    } else if (normalizedRange && upstream.status === 206) {
      const contentRange = headers.get("content-range");
      if (!contentRange) {
        console.warn(`[zarr-data] 206 without Content-Range, not caching: ${key}`);
      } else if (contentLength !== null && contentLength <= RANGE_CACHE_MAX_BYTES) {
        const cacheHeaders = new Headers(headers);
        cacheHeaders.delete("content-range");
        cacheHeaders.set(NEMAR_CONTENT_RANGE_HEADER, contentRange);
        const cacheEntry = new Response(res.clone().body, { status: 200, headers: cacheHeaders });
        c.executionCtx.waitUntil(safeCachePut(cache, cacheKeyUrl, key, cacheEntry));
      }
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

  // Any uncaught throw from a handler -- including a CacheLike.match/put
  // that throws -- lands here instead of a bare, CORS-less Workers 500
  // (#1181 review item 7). Log with the path for correlation and still
  // answer with CORS, so a genuinely allowed browser origin gets a readable
  // 500 instead of an opaque CORS-blocked network error stacked on top of
  // the underlying failure.
  app.onError((err, c) => {
    console.error("[zarr-data] unhandled", { path: c.req.path }, err);
    return c.body(null, 500, corsHeaders(c.req.header("origin") ?? null));
  });

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
