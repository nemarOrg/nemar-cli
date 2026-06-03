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
 *      across all users and caches with a near-total hit rate).
 *
 * Only PUBLIC datasets are served (private data is never browser-streamable).
 * Mounted on the `zarr.nemar.org` host fork in index.ts and path-mounted at
 * `/zarrproxy` for workers.dev/dev access.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { normalizeBidsPath } from "../services/data-router";
import { isValidDatasetId } from "../services/datasetId";
import type { Bindings } from "../types/bindings.js";

export const zarrDataRoutes = new Hono<{ Bindings: Bindings }>();

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

function s3PublicUrl(env: Bindings, key: string): string {
  // Public-read object (deny-list policy makes a public dataset's prefix public).
  const region = env.AWS_REGION || "us-east-2";
  return `https://${env.S3_BUCKET}.s3.${region}.amazonaws.com/${key}`;
}

/** Cache-Control for the origin + edge. The small shared metadata (index.json,
 *  zarr.json) gets a short TTL so a re-conversion surfaces quickly; the bulk
 *  chunk objects get a long TTL (they're immutable for a given conversion and
 *  the /webhooks/zarr-ready purge handles the rare in-place replace). */
export function cacheControlFor(key: string): string {
  if (key.endsWith("/index.json") || key.endsWith("/zarr.json")) {
    return "public, max-age=60, stale-while-revalidate=300";
  }
  return "public, max-age=86400, stale-while-revalidate=86400";
}

async function isPublicDataset(env: Bindings, datasetId: string): Promise<boolean> {
  if (!isValidDatasetId(datasetId)) return false;
  const row = await env.DB.prepare("SELECT visibility FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ visibility: string }>();
  return row?.visibility === "public";
}

// Preflight: answer for any path so the browser's OPTIONS check passes before
// the real GET. No D1/S3 work here.
zarrDataRoutes.options("/*", (c) => c.body(null, 204, corsHeaders(c.req.header("origin") ?? null)));

/**
 * GET/HEAD /<id>/zarr/<path> -> proxied, CORS'd, edge-cached S3 object.
 *
 * `*` captures everything after `/<id>/zarr/`, so the S3 key is exactly
 * `<id>/zarr/<rest>` (the producer writes index.json + every store under that
 * prefix). The full path is re-derived from the URL rather than the `*` param
 * so encoded segments survive intact.
 */
async function serve(c: Context<{ Bindings: Bindings }>, isHead: boolean) {
  const origin = c.req.header("origin") ?? null;
  const cors = corsHeaders(origin);
  const datasetId = c.req.param("datasetId");

  const prefix = `/${datasetId}/zarr/`;
  const idx = c.req.path.indexOf(prefix);
  const rawRest = idx === -1 ? "" : c.req.path.slice(idx + prefix.length);
  const rest = normalizeBidsPath(decodeURIComponent(rawRest));
  if (rest === null || rest === "") {
    return c.body(null, 404, cors);
  }
  const key = `${datasetId}/zarr/${rest}`;

  // Edge cache: only full-object GETs are cached (Range responses pass through).
  const range = c.req.header("range");
  const cache = caches.default;
  const cacheKey = new Request(new URL(c.req.url).toString(), { method: "GET" });
  if (!isHead && !range) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const h = new Headers(hit.headers);
      for (const [k, v] of Object.entries(cors)) h.set(k, v);
      return new Response(hit.body, { status: hit.status, headers: h });
    }
  }

  // Gate on cache miss only (a cached object was already gated when first stored).
  if (!(await isPublicDataset(c.env, datasetId))) {
    return c.body(null, 404, cors);
  }

  const upstream = await fetch(s3PublicUrl(c.env, key), {
    method: isHead ? "HEAD" : "GET",
    headers: range ? { Range: range } : undefined,
  });
  if (upstream.status === 403 || upstream.status === 404) {
    // Missing object (or not actually public in S3) -> clean 404, not a leak.
    return c.body(null, 404, cors);
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
  headers.set("Cache-Control", cacheControlFor(key));

  const body = isHead ? null : upstream.body;
  const res = new Response(body, { status: upstream.status, headers });

  // Cache full-object 200 GETs at the edge. clone() so the body is still
  // streamable to the client while waitUntil writes the cache copy.
  if (!isHead && !range && upstream.status === 200) {
    c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  }
  return res;
}

zarrDataRoutes.get("/:datasetId/zarr/*", (c) => serve(c, false));
// Hono derives HEAD from GET, re-dispatching the original (method still HEAD)
// request; `serve` reads c.req.method via the isHead flag below.
zarrDataRoutes.on("HEAD", "/:datasetId/zarr/*", (c) => serve(c, true));

// Friendly root so a bare zarr.nemar.org/ doesn't 404 confusingly.
zarrDataRoutes.get("/", (c) =>
  c.json(
    { service: "zarr.nemar.org", usage: "/<dataset_id>/zarr/<path>.zarr/..." },
    200,
    corsHeaders(c.req.header("origin") ?? null),
  ),
);
