/**
 * zarr.nemar.org data plane (epic #684, Stream D enablement; redirects added
 * #1178 phase 6 / issue #1061, epic #1181).
 *
 * The authoritative gateway for the per-recording Zarr serving copies -- but
 * "gateway" no longer means "proxy" for every request. `index.json` (the
 * contract entry point) and any request carrying an allowlisted browser
 * `Origin` are proxied, exactly as before phase 6, and get the three things
 * a browser needs that raw S3 does not give us here:
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
 * A plain GET for a store object with no allowlisted Origin -- libraries, HPC
 * jobs, agents: the overwhelming majority of request volume -- gets none of
 * that. It 302s straight to the public S3 object instead (phase 6):
 * Cloudflare's terms restrict proxying large files at this scale on a
 * non-Enterprise plan, and every request is still counted whether this
 * Worker carries the bytes or not. The redirect branch runs BEFORE the D1
 * visibility gate and never touches the edge cache or an upstream fetch --
 * see isRedirectCandidate() and the redirect branch in serve() for why
 * that's safe (short version: the bucket's own NotResource deny-list, see
 * services/bucket-policy.ts, is the real enforcement point, so a redirect
 * that 403s at S3 for a private dataset leaks nothing the proxied 404
 * does not).
 *
 * HEAD is never redirected, regardless of Origin -- always answered by the
 * proxied path. This is load-bearing: fsspec's `info()` and rclone's sync
 * both probe with HEAD, and rclone's HTTP backend does not follow HEAD
 * redirects (data.ts's fileOrIndexHandler documents the identical rule on
 * the archive route).
 *
 * Only PUBLIC datasets are gated on the proxied branches (private data is
 * never browser-streamable; the redirect branch relies on the bucket policy
 * instead, see above). Mounted on the `zarr.nemar.org` host fork in
 * index.ts and path-mounted at `/zarrproxy` for workers.dev/dev access --
 * the same code serves both entry points, redirect included.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { rateLimiter } from "../middleware/rateLimit.js";
import { recordAccess, zarrObjectType } from "../services/access-metrics";
import { ZARR_DATASET_DOCUMENTS } from "../services/cloudflare.js";
import { normalizeBidsPath } from "../services/data-router";
import { isValidDatasetId } from "../services/datasetId";
import { ZarrCatalogForbiddenError, fetchZarrCatalogObject } from "../services/zarr-catalog";
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

/**
 * Path shape for a zarr object request, tolerant of both entry points:
 *   `/<id>/zarr/<rest>`            (zarr.nemar.org host fork)
 *   `/zarrproxy/<id>/zarr/<rest>`  (path-mounted on api.nemar.org / workers.dev)
 * Anchored on the `zarr` segment itself -- `(?:\/(.*))?$` requires either
 * end-of-string right after `zarr` or a literal `/` before any rest, so
 * `/on000001/zarrbogus` or `/on000001/zarr-x` cannot match (#1181 phase 6
 * review item 2: the old `\/zarr\/?(.*)$` treated "bogus" as `rest` for
 * `/on000001/zarrbogus`, misclassifying it as a redirect candidate that
 * never actually reaches serve()'s `/:datasetId/zarr/*` route at all).
 * Mirrors ZARR_PATH_RE in middleware/rateLimit.ts (kept as an independent
 * literal rather than imported from there -- this file already imports
 * `rateLimiter` FROM rateLimit.ts, so importing the other direction too
 * would create a cycle). The id is captured too (group 1) so
 * isRedirectCandidate can validate it below -- the path shape alone
 * (`[a-z]{2}\d+`) doesn't enforce the real id contract (exactly 6 digits,
 * an `nm`/`xx`/`on` prefix, `<= 99999`; see isValidDatasetId).
 */
const ZARR_OBJECT_PATH_RE = /^(?:\/zarrproxy)?\/([a-z]{2}\d+)\/zarr(?:\/(.*))?$/;

/**
 * True when a request to this sub-app WILL take the redirect branch in
 * serve() below, rather than being proxied: a `GET` (never `HEAD` -- see
 * the module doc comment, that rule is load-bearing) for a store object --
 * not the always-proxied `index.json`, and not an empty/malformed path,
 * which the proxied branch 404s either way -- on a VALID dataset id, with
 * no allowlisted browser `Origin`.
 *
 * The id check matters on its own (#1181 phase 6 review item 3): without
 * it, `zz000001` (wrong prefix), `nm1234567` (too many digits), and
 * `nm999999` (over the 99999 cap) all satisfied the old path-shape-only
 * regex and got redirected to a garbage S3 URL -- with `recordAccess`
 * writing an invalid dataset id into Analytics Engine -- while the exact
 * same request with a browser Origin correctly 404'd via serve()'s
 * isPublicDataset -> isValidDatasetId gate. A malformed id must fall
 * through to that SAME 404 path regardless of Origin, not take a
 * different, D1-free branch of its own.
 *
 * Called from exactly two places: serve()'s own routing decision, and the
 * rate-limit middleware below that exempts these hits from the data-ip
 * bucket (#1181 phase 6 / issue #1061). Both call sites hand it the same
 * raw `method` / `path` / `origin` triple a Hono middleware already has,
 * so routing and rate-limiting can never disagree about which requests
 * actually reach D1/the edge cache/S3 through this Worker -- there is
 * exactly one rule, not two hand-written copies of it.
 */
export function isRedirectCandidate(method: string, path: string, origin: string | null): boolean {
  if (method !== "GET") return false;
  if (allowedOrigin(origin)) return false;
  const match = ZARR_OBJECT_PATH_RE.exec(path);
  if (!match) return false;
  const [, datasetId, rawRest] = match;
  if (!isValidDatasetId(datasetId)) return false;
  let rest: string | null;
  try {
    rest = normalizeBidsPath(decodeURIComponent(rawRest ?? ""));
  } catch {
    // Malformed percent-encoding: fall through to the proxied path, which
    // hits the same decodeURIComponent call and 500s via onError -- the
    // same failure mode as today, not a new one.
    return false;
  }
  // index.json is always top-level (the producer never nests a store under
  // that name) and stays proxied/edge-cached/D1-gated -- the contract entry
  // point (#1061). catalog.json (phase 2, #1062) is a SEPARATE route
  // (`GET /catalog.json`, no `<id>/zarr/` segment at all) and can never
  // match ZARR_OBJECT_PATH_RE in the first place, so it needs no exemption
  // here -- see the "catalog.json can never match" unit tests.
  return Boolean(rest) && rest !== "index.json";
}

/**
 * Bytes to report for a redirect telemetry point, computed from the
 * client's Range header rather than a blanket 0 -- unlike the archive
 * route's 302 (which redirects the WHOLE file and never sees a Range), this
 * one redirects a request that named its own slice, so the exact count is
 * knowable without asking S3. A bounded (`A-B`) or suffix (`-N`) range has
 * a known exact length; an open-ended (`A-`) range, a missing header, or
 * anything parseCacheableRange() doesn't recognise as a single range does
 * not (the total object size is unknown without an upstream fetch, which
 * the redirect branch deliberately never makes) and falls back to 0 --
 * never guessed (#1181 phase 6 / issue #1061).
 */
export function bytesFromRangeHeader(rangeHeader: string | null): number {
  if (!rangeHeader) return 0;
  const normalized = parseCacheableRange(rangeHeader);
  if (!normalized) return 0;
  const bounded = /^bytes=(\d+)-(\d+)$/.exec(normalized);
  if (bounded) {
    // parseCacheableRange only checks the digits-A-digits SHAPE, not that
    // end >= start -- "bytes=100-50" is syntactically a valid single range
    // and would otherwise compute -49 here, landing a negative byte count
    // in Analytics Engine (#1181 phase 6 review item 4). Real S3 answers an
    // inverted range with 416, same as any other out-of-range request, so
    // there is never a real number of bytes served for one -- fall back to
    // the same "unknown" 0 as every other unmeasurable case here.
    const start = Number(bounded[1]);
    const end = Number(bounded[2]);
    return end >= start ? end - start + 1 : 0;
  }
  const suffix = /^bytes=-(\d+)$/.exec(normalized);
  if (suffix) return Number(suffix[1]);
  return 0; // open-ended `bytes=A-`: length unknown without hitting S3
}

/**
 * Build the public S3 URL for a key -- the upstream fetch target for the
 * proxied branch AND the redirect `Location` for the redirect branch
 * (#1181 phase 6). `key` is the already-decoded, normalised S3 key (see
 * serve()'s `rest`), so it is re-encoded per path segment here via
 * encodeS3KeyPath() -- the SAME encoding canonicalCacheUrl() uses for the
 * edge-cache key -- rather than interpolated raw. Exported for a direct
 * unit test of the real (non-`base`) branch; production code never imports
 * it from outside this file.
 */
export function s3PublicUrl(env: Bindings, key: string, base?: string): string {
  const encodedKey = encodeS3KeyPath(key);
  // Test seam (#1178 phase 1): a real Bun.serve() upstream stands in for S3
  // in tests via deps.s3Base, instead of parsing env vars for a fake host.
  if (base) return `${base}/${encodedKey}`;
  // Public-read object (deny-list policy makes a public dataset's prefix public).
  const region = env.AWS_REGION || "us-east-2";
  return `https://${env.S3_BUCKET}.s3.${region}.amazonaws.com/${encodedKey}`;
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
 *  index.json is 95% of Worker egress (#1035), and it shares its TTL with the
 *  other dataset-level documents (manifest.json, events.parquet), which are
 *  rewritten by the same conversion. The zarr-ready callback
 *  purges all of them on rebuild via zarrPurgeTargets() (services/cloudflare.ts) --
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
 *  purge target -- zarrPurgeTargets() only ever lists the dataset documents
 *  and each changed store's zarr.json, never a chunk URL (enumerating every
 *  chunk for a URL-list purge isn't worthwhile, and prefix purge is
 *  Enterprise-only) -- so chunks rely entirely on the 24h TTL plus ETag
 *  revalidation, with no purge backstop at all, active or not. */
export function cacheControlFor(key: string, opts: { tokened: boolean }): string {
  const { tokened } = opts;
  if (key.endsWith("/zarr.json")) {
    return tokened
      ? "public, max-age=86400, stale-while-revalidate=86400"
      : "public, max-age=60, stale-while-revalidate=300";
  }
  // index.json, manifest.json, events.parquet: the dataset-level documents,
  // rewritten by every conversion and few enough to purge by URL. Same list the
  // zarr-ready purge uses (services/cloudflare.ts), so the TTL and the purge
  // cannot cover different files -- manifest.json used to fall through to the
  // chunk branch below and get a day of edge cache with no purge behind it.
  if (ZARR_DATASET_DOCUMENTS.some((name) => key.endsWith(`/${name}`))) {
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
 * Percent-encode each path segment of an S3 key independently (never the
 * whole key as one string, which would also escape the `/` separators).
 *
 * Shared by canonicalCacheUrl() (the edge-cache key) and s3PublicUrl() (the
 * upstream fetch target AND the redirect Location, #1181 phase 6 review) so
 * all three agree on the exact same encoded spelling for a given key. Before
 * this was shared, s3PublicUrl() interpolated the raw (decoded) key
 * unescaped: a literal `#` truncated the URL at the fragment, `?`/space
 * broke the request line, and a non-Latin-1 character landed raw in a
 * `Location` header, which workerd (unlike Bun, where tests ran) refuses to
 * send at all.
 */
function encodeS3KeyPath(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

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
  const url = new URL(`${origin}/${encodeS3KeyPath(key)}`);
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

  // Redirect branch (#1181 phase 6 / issue #1061): a non-browser GET for a
  // store object never touches D1, the edge cache, or an upstream fetch
  // through this Worker -- see the module doc comment for why that's safe.
  // isRedirectCandidate is the SAME predicate the rate-limit middleware
  // below uses to decide whether to exempt the request from the data-ip
  // bucket, so routing and rate-limiting can't disagree about which
  // requests actually reach S3 through this Worker. `!isHead` is redundant
  // with the predicate's own method check (HEAD can never be a redirect
  // candidate) but is left explicit here: the HEAD-never-redirects rule is
  // load-bearing enough (fsspec/rclone probe with HEAD; rclone's HTTP
  // backend does not follow HEAD redirects) that it should be readable at
  // the call site, not only inside the predicate.
  if (!isHead && isRedirectCandidate(c.req.method, c.req.path, origin)) {
    recordAccess(c.env, {
      datasetId,
      source: "zarr",
      // Blob slots are fixed (buildAccessDataPoint always writes exactly
      // three); a redirect isn't a new AccessSource, it's a marker in the
      // existing `detail` slot that zarrObjectType() never produces on its
      // own, so the dashboard can tell a redirected chunk apart from a
      // proxied one without a schema change.
      detail: "chunk-redirect",
      bytes: bytesFromRangeHeader(c.req.header("range") ?? null),
    });
    return new Response(null, {
      status: 302,
      headers: {
        Location: s3PublicUrl(c.env, key, deps.s3Base),
        // The redirect TARGET is stable for a given key (bucket/region/key
        // never change shape), unlike the proxied branch's per-object-class
        // TTL from cacheControlFor() -- an hour is a reasonable middle
        // ground for a value that in practice never changes.
        "Cache-Control": "public, max-age=3600",
        // Documents that the SAME URL answers differently for an
        // allowlisted browser Origin (proxied bytes, not a redirect), even
        // though nothing about this particular response is cached by us.
        Vary: "Origin",
        // No Content-Length (RFC 9110 SS8.6: it would describe the empty
        // redirect body, not the S3 target) and no
        // Access-Control-Allow-Origin (nothing of ours is exposed here --
        // see data.ts's fileOrIndexHandler for the identical archive-route
        // convention).
      },
    });
  }

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
  //
  // This gate does NOT run on the redirect branch above (#1181 phase 6 /
  // issue #1061): a redirect never touches D1, the edge cache, or an
  // upstream fetch, so there is no cache entry or D1 staleness to protect
  // here. The bucket's own NotResource deny-list (services/bucket-policy.ts)
  // is the enforcement point on that path instead -- a redirect to a URL
  // that 403s at S3 for a private dataset leaks nothing this 404 does not.
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

/**
 * GET /catalog.json -> the top-level Zarr discovery front door (#1062, epic
 * #1181 phase 2): one JSON document listing every publicly streamable
 * dataset, for a client (human or agent) with no dataset id to start from
 * and no s3:ListBucket. Published to `s3://<bucket>/zarr-catalog.json` by
 * the daily cron / `POST /admin/zarr-catalog/publish`
 * (services/zarr-catalog.ts); this route only proxies + edge-caches it.
 * Unlike `serve()` above, there is no D1 read here at all: the document
 * only ever lists already-public datasets (built at publish time by the
 * SQL in zarr-catalog.ts), so there is no per-request visibility gate to
 * check for this single, top-level object.
 *
 * Always a SIGNED GET (Worker creds), unlike `serve()`'s per-dataset
 * objects, which fetch unsigned-first: the bucket-root key's read policy is
 * a separate, narrower carve-out from the per-dataset prefix policy (see
 * bucket-policy.ts), so this works whether or not the root key happens to
 * be anonymously readable. `deps.s3Base` (the phase 1 test seam, #1199)
 * doubles as the signed request's endpoint override when set, so tests use
 * the exact same local upstream `serve()`'s tests already stand up.
 *
 * A 403 from S3 -- {@link ZarrCatalogForbiddenError}, a policy/IAM
 * regression on a fixed, always-expected-to-exist key -- answers 503, kept
 * distinct from the 404 a genuine "not published yet" (or any other
 * `fetchZarrCatalogObject` throw, mapped to 502) gets, matching how `serve()`
 * separates a real absence from an infra failure above.
 *
 * Edge-cached via `deps.cache()` and `safeCachePut` for an hour -- the same
 * mechanism `serve()` uses, kept as its own cache entry (keyed on this
 * route's own URL) rather than sharing a helper with `respondFromCache()`,
 * which exists to handle range/synthetic-206 reconstruction this route has
 * no need for.
 */
async function serveCatalog(
  c: Context<{ Bindings: Bindings }>,
  deps: ZarrDataDeps,
): Promise<Response> {
  const origin = c.req.header("origin") ?? null;
  const cors = corsHeaders(origin);
  const cache = deps.cache();
  const cacheKeyUrl = new URL(c.req.url).toString();

  const hit = await cache.match(new Request(cacheKeyUrl, { method: "GET" }));
  if (hit) {
    // Same per-request CORS reapplication as respondFromCache() above: the
    // Cache API does not honour Vary: Origin, so one stored entry is shared
    // across every requesting origin regardless of which origin primed it.
    const headers = new Headers(hit.headers);
    headers.delete("Access-Control-Allow-Origin");
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(hit.body, { status: hit.status, headers });
  }

  let object: { body: string; etag: string | null } | null;
  try {
    object = await fetchZarrCatalogObject(
      {
        bucket: c.env.S3_BUCKET,
        region: c.env.AWS_REGION || "us-east-2",
        accessKeyId: c.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
        endpointUrl: deps.s3Base,
      },
      deps.fetch,
    );
  } catch (err) {
    if (err instanceof ZarrCatalogForbiddenError) {
      console.error("[zarr-data] GET /catalog.json forbidden", { path: c.req.path }, err);
      return c.body(null, 503, cors);
    }
    console.error("[zarr-data] GET /catalog.json fetch failed", { path: c.req.path }, err);
    return c.body(null, 502, cors);
  }
  if (!object) return c.body(null, 404, cors);

  const headers = new Headers(cors);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=3600");
  if (object.etag) headers.set("ETag", object.etag);

  const res = new Response(object.body, { status: 200, headers });
  c.executionCtx.waitUntil(safeCachePut(cache, cacheKeyUrl, "zarr-catalog.json", res.clone()));
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
    // Redirect candidates (#1181 phase 6 / issue #1061) cost a fraction of a
    // millisecond of CPU and zero bytes through this Worker -- the IP-keyed
    // data-ip bucket exists to bound a runaway PROXIED loop, not to punish a
    // cluster behind one NAT address for traffic that never touches D1, the
    // edge cache, or S3 through here. Observe-only (#1181 phase 6 review
    // item 5): rateLimiter still counts these against the SAME shared
    // bucket a proxied request from this IP would be enforced against, but
    // never blocks this one, and logs at most one console.warn per window
    // instead of the unconditional per-request log this used to be. Uses
    // the SAME predicate serve() uses to pick its response branch (see
    // isRedirectCandidate's doc comment), so this can never observe-only a
    // request that serve() actually proxies.
    const observeOnly = isRedirectCandidate(
      c.req.method,
      c.req.path,
      c.req.header("origin") ?? null,
    );
    const res = await rateLimiter(
      c as unknown as Parameters<typeof rateLimiter>[0],
      next,
      observeOnly ? { observeOnly: true } : undefined,
    );
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

  // Coordinated with phase 1 (#1199): a single, clearly separated handler,
  // kept above the root `/` handler below.
  app.get("/catalog.json", (c) => serveCatalog(c, deps));

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
