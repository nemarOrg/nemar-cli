/**
 * Edge-cache tests for zarr.nemar.org's data plane (#1178 phase 1 / #1035,
 * epic #1181), plus the epic #1181 five-reviewer follow-up round: the
 * visibility-gate ordering fix, the ranged-404 canonical fallback, the
 * fail-closed 206-without-Content-Range path, size caps on cached entries,
 * 416 pass-through, cache.put failure visibility, onError CORS, the
 * S3-key-derived canonical cache key, and the index.json TTL correction.
 *
 * Real engines throughout, no mocks:
 *  - Upstream S3 is a real `Bun.serve()` on an ephemeral port, standing in
 *    for the S3 origin via `deps.s3Base` (see ZarrDataDeps in
 *    ../src/routes/zarr-data.ts). It serves fixed byte buffers with real
 *    Range semantics (206 + Content-Range/Content-Length, 416 for
 *    out-of-range, 200 for full GET, HEAD support, ETag, 404 for unknown
 *    keys), a per-key quirk switch for the malformed-upstream cases the
 *    review asked for (missing Content-Range, missing Content-Length, an
 *    ignored single-range request), and logs every request it receives so
 *    tests can assert on upstream call counts -- the thing that actually
 *    proves caching worked or didn't.
 *  - The edge cache is a real in-memory CacheLike: whatever is `put()` is
 *    what `match()` returns, keyed by request URL, nothing canned -- and it
 *    throws on a 206 exactly like the real Workers Cache API does (see
 *    InMemoryCache.put below).
 *  - D1 is bun:sqlite behind realD1() with every migration applied
 *    (backend/test/helpers/d1.ts), seeded with one public and one private
 *    dataset. The visibility-gate tests mutate that row directly with D1
 *    UPDATEs to flip visibility mid-test.
 *  - The route is driven through the real Hono app returned by
 *    createZarrDataRoutes(), via app.request(), exactly as index.ts drives
 *    it in production -- not by calling any helper directly.
 *
 * The rate limiter that zarrDataRoutes mounts on every request talks to the
 * real `caches.default` global, which doesn't exist under bun:test; env.
 * ENVIRONMENT is set to "development" so rateLimiter's own short-circuit
 * skips it (see middleware/rateLimit.ts), same as it does for real local
 * dev. That's the only thing narrowed for testability -- everything under
 * test (canonical keys, range keys, Cache-Control, 404 caching, CORS
 * reapplication, telemetry, the gate ordering, size caps, error handling)
 * runs the real route logic.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { __limits } from "../src/middleware/rateLimit";
import {
  type CacheLike,
  FULL_OBJECT_CACHE_MAX_BYTES,
  RANGE_CACHE_MAX_BYTES,
  type ZarrDataDeps,
  bytesFromRangeHeader,
  canonicalCacheUrl,
  createZarrDataRoutes,
  isRedirectCandidate,
  parseCacheableRange,
} from "../src/routes/zarr-data";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const PUBLIC_ID = "on000001";
const PRIVATE_ID = "on000002";

// ---------------------------------------------------------------------------
// Fixed byte objects served by the fake upstream.
// ---------------------------------------------------------------------------

const CHUNK_BYTES = new Uint8Array(2048);
for (let i = 0; i < CHUNK_BYTES.length; i++) CHUNK_BYTES[i] = i % 256;

const ZARR_JSON = new TextEncoder().encode(JSON.stringify({ zarr_format: 3, node_type: "group" }));
const INDEX_JSON = new TextEncoder().encode(JSON.stringify({ stores: ["store.zarr"] }));
const QUIRK_BYTES = new Uint8Array(64).fill(3);

// One oversized buffer serves both size-cap tests (#1181 review item 4): a
// full GET of it exceeds FULL_OBJECT_CACHE_MAX_BYTES, and a range within it
// exceeds RANGE_CACHE_MAX_BYTES. Real bytes, real transfer -- not mocked.
const CAP_TEST_BYTES = new Uint8Array(FULL_OBJECT_CACHE_MAX_BYTES + 1024).fill(9);

const OBJECTS: Record<string, Uint8Array> = {
  [`${PUBLIC_ID}/zarr/index.json`]: INDEX_JSON,
  [`${PUBLIC_ID}/zarr/store.zarr/zarr.json`]: ZARR_JSON,
  [`${PUBLIC_ID}/zarr/store.zarr/c/0/0`]: CHUNK_BYTES,
  [`${PUBLIC_ID}/zarr/store.zarr/c/quirk/no-range-header`]: QUIRK_BYTES,
  [`${PUBLIC_ID}/zarr/store.zarr/c/quirk/no-length-header`]: QUIRK_BYTES,
  [`${PUBLIC_ID}/zarr/store.zarr/c/quirk/ignored-range`]: QUIRK_BYTES,
  [`${PUBLIC_ID}/zarr/store.zarr/c/big/oversized`]: CAP_TEST_BYTES,
  [`${PRIVATE_ID}/zarr/store.zarr/zarr.json`]: ZARR_JSON,
};

/** Per-key upstream misbehaviour the review asked the fake server to be
 *  able to produce, so the route's fail-closed / size-cap handling can be
 *  exercised against a REAL (if deliberately quirky) HTTP response rather
 *  than a canned one. */
type UpstreamQuirk = "no-content-range" | "no-content-length" | "ignored-range";
const QUIRKS = new Map<string, UpstreamQuirk>([
  [`${PUBLIC_ID}/zarr/store.zarr/c/quirk/no-range-header`, "no-content-range"],
  [`${PUBLIC_ID}/zarr/store.zarr/c/quirk/no-length-header`, "no-content-length"],
  [`${PUBLIC_ID}/zarr/store.zarr/c/quirk/ignored-range`, "ignored-range"],
]);

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  // Bun's HTTP server eagerly computes Content-Length when a stream body
  // resolves to a single synchronous enqueue -- it can see the whole body
  // before flushing headers. Splitting into two chunks separated by a real
  // async gap forces it to flush headers (chunked, no Content-Length)
  // before the total size is known, which is what the "no Content-Length"
  // upstream quirk actually needs to exercise.
  const mid = Math.max(1, Math.floor(bytes.length / 2));
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(bytes.slice(0, mid));
      await new Promise((resolve) => setTimeout(resolve, 1));
      controller.enqueue(bytes.slice(mid));
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// Real upstream: Bun.serve() with genuine single-range Range semantics.
// ---------------------------------------------------------------------------

interface LoggedRequest {
  method: string;
  path: string;
  range: string;
}

let upstream: Server;
let requestLog: LoggedRequest[] = [];

function countUpstream(path: string, range = ""): number {
  return requestLog.filter((r) => r.path === path && r.range === range).length;
}

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const key = url.pathname.slice(1);
      const range = req.headers.get("range") ?? "";
      requestLog.push({ method: req.method, path: key, range });

      const bytes = OBJECTS[key];
      if (!bytes) return new Response(null, { status: 404 });
      const etag = `"${key}"`;
      const isHead = req.method === "HEAD";
      const quirk = QUIRKS.get(key);

      if (range) {
        const single = /^bytes=(?:(\d+)-(\d+)|(\d+)-|-(\d+))$/.exec(range);
        if (!single) {
          // Multi-range / malformed: simulate a server that ignores an
          // unsupported Range spec and answers with the full representation.
          return new Response(isHead ? null : bytes, {
            status: 200,
            headers: {
              "Content-Length": String(bytes.length),
              "Content-Type": "application/octet-stream",
              ETag: etag,
            },
          });
        }

        if (quirk === "ignored-range") {
          // Upstream chooses to ignore a perfectly well-formed single range
          // and answer 200 full (#1181 review item 18).
          return new Response(isHead ? null : bytes, {
            status: 200,
            headers: {
              "Content-Length": String(bytes.length),
              "Content-Type": "application/octet-stream",
              ETag: etag,
            },
          });
        }

        let start: number;
        let end: number;
        if (single[4] !== undefined) {
          const n = Number(single[4]);
          start = Math.max(0, bytes.length - n);
          end = bytes.length - 1;
        } else if (single[3] !== undefined) {
          start = Number(single[3]);
          end = bytes.length - 1;
        } else {
          start = Number(single[1]);
          end = Number(single[2]);
        }
        if (start >= bytes.length || start > end) {
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${bytes.length}` },
          });
        }
        end = Math.min(end, bytes.length - 1);
        const slice = bytes.slice(start, end + 1);

        if (quirk === "no-content-length") {
          // A stream body with no declared length -- forces chunked
          // transfer, so no Content-Length reaches the client at all
          // (#1181 review items 3/4).
          return new Response(isHead ? null : streamOf(slice), {
            status: 206,
            headers: {
              "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
              "Content-Type": "application/octet-stream",
              ETag: etag,
            },
          });
        }

        const rangeHeaders: Record<string, string> = {
          "Content-Length": String(slice.length),
          "Content-Type": "application/octet-stream",
          ETag: etag,
        };
        if (quirk !== "no-content-range") {
          rangeHeaders["Content-Range"] = `bytes ${start}-${end}/${bytes.length}`;
        }
        return new Response(isHead ? null : slice, { status: 206, headers: rangeHeaders });
      }

      return new Response(isHead ? null : bytes, {
        status: 200,
        headers: {
          "Content-Length": String(bytes.length),
          "Content-Type": "application/octet-stream",
          ETag: etag,
        },
      });
    },
  });
});

afterAll(() => {
  upstream.stop(true);
});

// ---------------------------------------------------------------------------
// Real in-memory CacheLike -- whatever is put() is what match() returns.
// ---------------------------------------------------------------------------

class InMemoryCache implements CacheLike {
  private store = new Map<string, Response>();

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const stored = this.store.get(keyFor(request));
    return stored?.clone();
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    // The real Workers Cache API refuses to store a 206 Partial Content
    // response outright (`cache.put` throws) -- mirrored here so any future
    // code path that tries to put a raw 206 (rather than the synthetic 200
    // zarr-data.ts writes for a cached range, or a real 404 negative entry
    // -- both of which the real API DOES accept) fails the same way in
    // tests (#1181 review item 13).
    if (response.status === 206) {
      throw new Error("Cache API cannot store a 206 response");
    }
    this.store.set(keyFor(request), response.clone());
  }
}

function keyFor(request: RequestInfo | URL): string {
  return request instanceof Request ? request.url : String(request);
}

/** Always misses, and every put() rejects -- for the cache.put-failure
 *  visibility test (#1181 review item 6). */
class RejectingPutCache implements CacheLike {
  async match(): Promise<Response | undefined> {
    return undefined;
  }
  async put(): Promise<void> {
    throw new Error("simulated cache.put failure");
  }
}

/** Always misses, and put() throws SYNCHRONOUSLY -- a plain (non-async)
 *  method, not one that returns a rejected promise -- reproducing the
 *  documented Cache API behaviour for a 206 (#1181 final review: this is
 *  the shape RejectingPutCache above did NOT cover, since an `async put()`
 *  that throws always becomes a rejected promise, never a synchronous
 *  throw, to its caller). */
class SynchronousThrowPutCache implements CacheLike {
  async match(): Promise<Response | undefined> {
    return undefined;
  }
  put(): Promise<void> {
    throw new Error("simulated synchronous cache.put throw");
  }
}

/** match() throws synchronously -- for the onError/CORS test (#1181 review
 *  item 7). */
class ThrowingMatchCache implements CacheLike {
  async match(): Promise<Response | undefined> {
    throw new Error("simulated cache.match failure");
  }
  async put(): Promise<void> {
    // Unreachable in the onError test; present to satisfy CacheLike.
  }
}

// ---------------------------------------------------------------------------
// D1 fixtures: one public dataset, one private dataset.
// ---------------------------------------------------------------------------

let db: Database;
let cache: InMemoryCache;
let app: Hono<{ Bindings: Bindings }>;

function seed(): void {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('zarrcacheowner', 'zarrcacheowner@example.org', 'x', 'approved', 'user', 1)`,
  );
  const owner = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='zarrcacheowner'")
    .get();
  if (!owner) throw new Error("seed: owner insert failed");
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility)
     VALUES (?, 'Public zarr fixture', ?, 'active', 'public')`,
    [PUBLIC_ID, owner.id],
  );
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility)
     VALUES (?, 'Private zarr fixture', ?, 'active', 'private')`,
    [PRIVATE_ID, owner.id],
  );
}

function testEnv(): Bindings {
  return {
    DB: realD1(db),
    // rateLimiter (mounted on every request by createZarrDataRoutes) hits
    // the real caches.default global under its non-"development" path;
    // that global doesn't exist under bun:test. "development" is
    // rateLimiter's own documented bypass -- see middleware/rateLimit.ts.
    ENVIRONMENT: "development",
    AWS_REGION: "us-east-2",
    S3_BUCKET: "unused-in-tests",
  } as unknown as Bindings;
}

function testDeps(): ZarrDataDeps {
  return {
    cache: () => cache,
    fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
    s3Base: `http://localhost:${upstream.port}`,
  };
}

/** Drives one request through the given app/env and flushes every promise
 *  the handler handed to executionCtx.waitUntil (the cache.put() calls)
 *  before returning, so the next request in the test sees a settled cache
 *  state -- mirrors the real Workers runtime, which keeps the isolate alive
 *  until waitUntil promises settle. */
async function requestWith(
  targetApp: Hono<{ Bindings: Bindings }>,
  path: string,
  init: RequestInit,
  env: Bindings,
): Promise<Response> {
  const waited: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waited.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const res = await targetApp.request(path, init, env, ctx);
  await Promise.allSettled(waited);
  return res;
}

async function requestWithEnv(path: string, init: RequestInit, env: Bindings): Promise<Response> {
  return requestWith(app, path, init, env);
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return requestWithEnv(path, init, testEnv());
}

beforeEach(() => {
  db = freshDb();
  seed();
  cache = new InMemoryCache();
  app = createZarrDataRoutes(testDeps());
  requestLog = [];
});

// ---------------------------------------------------------------------------
// Unit tests: canonicalCacheUrl + the range parser, directly.
// ---------------------------------------------------------------------------

describe("canonicalCacheUrl", () => {
  test("builds origin + re-encoded key, no v", () => {
    expect(canonicalCacheUrl("https://zarr.nemar.org", "on000001/zarr/index.json", null)).toBe(
      "https://zarr.nemar.org/on000001/zarr/index.json",
    );
  });

  test("appends v when present", () => {
    expect(canonicalCacheUrl("https://zarr.nemar.org", "on000001/zarr/index.json", "abc")).toBe(
      "https://zarr.nemar.org/on000001/zarr/index.json?v=abc",
    );
  });

  test("treats an empty v the same as no v", () => {
    expect(canonicalCacheUrl("https://zarr.nemar.org", "on000001/zarr/index.json", "")).toBe(
      "https://zarr.nemar.org/on000001/zarr/index.json",
    );
  });

  test("percent-encodes each path segment independently", () => {
    expect(canonicalCacheUrl("https://zarr.nemar.org", "on000001/zarr/a b/c~d.json", null)).toBe(
      "https://zarr.nemar.org/on000001/zarr/a%20b/c~d.json",
    );
  });
});

describe("parseCacheableRange", () => {
  test("accepts bytes=A-B", () => {
    expect(parseCacheableRange("bytes=0-999")).toBe("bytes=0-999");
  });

  test("accepts bytes=A-", () => {
    expect(parseCacheableRange("bytes=1000-")).toBe("bytes=1000-");
  });

  test("accepts bytes=-N", () => {
    expect(parseCacheableRange("bytes=-500")).toBe("bytes=-500");
  });

  test("normalises case and whitespace", () => {
    expect(parseCacheableRange("Bytes = 0 - 999")).toBe("bytes=0-999");
  });

  test("rejects multi-range", () => {
    expect(parseCacheableRange("bytes=0-1,4-5")).toBeNull();
  });

  test("rejects a non-bytes unit", () => {
    expect(parseCacheableRange("items=0-1")).toBeNull();
  });

  test("rejects malformed specs", () => {
    expect(parseCacheableRange("bytes=")).toBeNull();
    expect(parseCacheableRange("bytes=-")).toBeNull();
    expect(parseCacheableRange("garbage")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Route tests, through the real Hono app.
// ---------------------------------------------------------------------------

const CHUNK_PATH = `/${PUBLIC_ID}/zarr/store.zarr/c/0/0`;
const CHUNK_KEY = `${PUBLIC_ID}/zarr/store.zarr/c/0/0`;

// Phase 6 (#1181 phase 6 / issue #1061) redirects a store-object GET with no
// allowlisted Origin instead of proxying it. Every phase-1 test below that
// exercises the proxied/edge-cache machinery on a store-object path (not
// index.json, which stays proxied regardless of Origin) needs an allowed
// Origin to keep reaching that machinery -- exactly what a real browser
// viewer request looks like, and the ONLY thing that changed about how
// these paths reach the proxy branch post-phase-6.
const BROWSER_ORIGIN = "https://nemar.org";

describe("range-keyed cache entries (#1178 item 3)", () => {
  // Phase 6: a bare (no-Origin) chunk GET now redirects instead of proxying
  // (see the "routing fork" describe block below), so every request here
  // needs an allowed browser Origin to keep exercising the edge-cache
  // machinery these tests are actually about.
  test("(a) ranged GET miss then identical ranged GET hit", async () => {
    const first = await request(CHUNK_PATH, {
      headers: { Range: "bytes=0-99", Origin: BROWSER_ORIGIN },
    });
    expect(first.status).toBe(206);
    expect(first.headers.get("content-range")).toBe(`bytes 0-99/${CHUNK_BYTES.length}`);
    const firstBytes = new Uint8Array(await first.arrayBuffer());
    expect(countUpstream(CHUNK_KEY, "bytes=0-99")).toBe(1);

    const second = await request(CHUNK_PATH, {
      headers: { Range: "bytes=0-99", Origin: BROWSER_ORIGIN },
    });
    expect(second.status).toBe(206);
    expect(second.headers.get("content-range")).toBe(`bytes 0-99/${CHUNK_BYTES.length}`);
    const secondBytes = new Uint8Array(await second.arrayBuffer());
    expect(secondBytes).toEqual(firstBytes);
    expect(secondBytes).toEqual(CHUNK_BYTES.slice(0, 100));

    // Upstream was hit exactly once for this range -- the second response
    // came from the edge cache.
    expect(countUpstream(CHUNK_KEY, "bytes=0-99")).toBe(1);
  });

  test("(b) a different range is a separate miss", async () => {
    await request(CHUNK_PATH, { headers: { Range: "bytes=0-99", Origin: BROWSER_ORIGIN } });
    expect(countUpstream(CHUNK_KEY, "bytes=0-99")).toBe(1);
    expect(countUpstream(CHUNK_KEY, "bytes=100-199")).toBe(0);

    const res = await request(CHUNK_PATH, {
      headers: { Range: "bytes=100-199", Origin: BROWSER_ORIGIN },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 100-199/${CHUNK_BYTES.length}`);
    expect(countUpstream(CHUNK_KEY, "bytes=100-199")).toBe(1);
    // The first range's cache entry is untouched.
    expect(countUpstream(CHUNK_KEY, "bytes=0-99")).toBe(1);
  });

  test("(c) full GET after a ranged GET is a separate miss", async () => {
    await request(CHUNK_PATH, { headers: { Range: "bytes=0-99", Origin: BROWSER_ORIGIN } });
    expect(countUpstream(CHUNK_KEY, "bytes=0-99")).toBe(1);
    expect(countUpstream(CHUNK_KEY, "")).toBe(0);

    const res = await request(CHUNK_PATH, { headers: { Origin: BROWSER_ORIGIN } });
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(CHUNK_BYTES.length);
    expect(bytes).toEqual(CHUNK_BYTES);
    expect(countUpstream(CHUNK_KEY, "")).toBe(1);
  });

  test("(d) a client-supplied __cr on a full GET is ignored for keying", async () => {
    const res = await request(`${CHUNK_PATH}?__cr=bytes%3D0-9`, {
      headers: { Origin: BROWSER_ORIGIN },
    });
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(CHUNK_BYTES.length);
    expect(bytes).toEqual(CHUNK_BYTES);
    // No Range header was ever sent upstream -- the __cr query param never
    // reached the fetch, it only exists to poison the cache key if honoured.
    expect(countUpstream(CHUNK_KEY, "")).toBe(1);

    // A second, plain full GET is a cache HIT sharing the same canonical
    // entry -- proving __cr was dropped from the key on the priming request.
    const second = await request(CHUNK_PATH, { headers: { Origin: BROWSER_ORIGIN } });
    expect(second.status).toBe(200);
    expect(countUpstream(CHUNK_KEY, "")).toBe(1);
  });

  test("(e) multi-range is passed through and never cached", async () => {
    const first = await request(CHUNK_PATH, {
      headers: { Range: "bytes=0-1,4-5", Origin: BROWSER_ORIGIN },
    });
    expect(first.status).toBe(200); // fake upstream ignores the unsupported spec
    expect(countUpstream(CHUNK_KEY, "bytes=0-1,4-5")).toBe(1);

    const second = await request(CHUNK_PATH, {
      headers: { Range: "bytes=0-1,4-5", Origin: BROWSER_ORIGIN },
    });
    expect(second.status).toBe(200);
    // Hit upstream again -- never cached.
    expect(countUpstream(CHUNK_KEY, "bytes=0-1,4-5")).toBe(2);
  });

  test("(f) 416 is returned to the client, not mapped to 502, and never cached (#1181 review item 5)", async () => {
    const outOfRange = "bytes=999999-1000010";
    const first = await request(CHUNK_PATH, {
      headers: { Range: outOfRange, Origin: BROWSER_ORIGIN },
    });
    expect(first.status).toBe(416);
    expect(first.headers.get("content-range")).toBe(`bytes */${CHUNK_BYTES.length}`);
    expect(countUpstream(CHUNK_KEY, outOfRange)).toBe(1);

    const second = await request(CHUNK_PATH, {
      headers: { Range: outOfRange, Origin: BROWSER_ORIGIN },
    });
    expect(second.status).toBe(416);
    // Hit upstream again -- the 416 was never written to the cache.
    expect(countUpstream(CHUNK_KEY, outOfRange)).toBe(2);
  });
});

describe("Cache-Control by tokening (#1178 item 4 / #1035, #1181 review item 9)", () => {
  test("(g) zarr.json: tokened gets 86400, untokened gets 60", async () => {
    // Phase 6: a per-store zarr.json is a store object, not the top-level
    // index.json, so a bare request redirects -- an allowed Origin is
    // needed to reach the proxied Cache-Control logic under test here.
    const tokened = await request(`/${PUBLIC_ID}/zarr/store.zarr/zarr.json?v=abc123`, {
      headers: { Origin: BROWSER_ORIGIN },
    });
    expect(tokened.headers.get("cache-control")).toBe(
      "public, max-age=86400, stale-while-revalidate=86400",
    );

    const untokened = await request(`/${PUBLIC_ID}/zarr/store.zarr/zarr.json`, {
      headers: { Origin: BROWSER_ORIGIN },
    });
    expect(untokened.headers.get("cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=300",
    );
  });

  test("(g) index.json: untokened gets 300/3600 (review item 9 -- was 3600/86400)", async () => {
    const res = await request(`/${PUBLIC_ID}/zarr/index.json`);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
  });

  test("(g) index.json: tokened matches zarr.json's tokened TTL (86400, unchanged)", async () => {
    const res = await request(`/${PUBLIC_ID}/zarr/index.json?v=abc123`);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=86400, stale-while-revalidate=86400",
    );
  });

  test("chunks are unchanged: 86400 regardless of tokening", async () => {
    const untokened = await request(CHUNK_PATH, { headers: { Origin: BROWSER_ORIGIN } });
    expect(untokened.headers.get("cache-control")).toBe(
      "public, max-age=86400, stale-while-revalidate=86400",
    );
    const tokened = await request(`${CHUNK_PATH}?v=abc123`, {
      headers: { Origin: BROWSER_ORIGIN },
    });
    expect(tokened.headers.get("cache-control")).toBe(
      "public, max-age=86400, stale-while-revalidate=86400",
    );
  });
});

describe("v-token round trip (#1181 review item 14)", () => {
  test("same tokened URL is a hit; different v values are separate entries; untokened is a third", async () => {
    const path = `/${PUBLIC_ID}/zarr/store.zarr/zarr.json`;
    const headers = { Origin: BROWSER_ORIGIN };

    const v1a = await request(`${path}?v=aaa`, { headers });
    expect(v1a.status).toBe(200);
    expect(countUpstream(`${PUBLIC_ID}/zarr/store.zarr/zarr.json`, "")).toBe(1);

    const v1b = await request(`${path}?v=aaa`, { headers });
    expect(v1b.status).toBe(200);
    expect(countUpstream(`${PUBLIC_ID}/zarr/store.zarr/zarr.json`, "")).toBe(1); // hit

    const v2 = await request(`${path}?v=bbb`, { headers });
    expect(v2.status).toBe(200);
    expect(countUpstream(`${PUBLIC_ID}/zarr/store.zarr/zarr.json`, "")).toBe(2); // separate entry

    const untokened = await request(path, { headers });
    expect(untokened.status).toBe(200);
    expect(countUpstream(`${PUBLIC_ID}/zarr/store.zarr/zarr.json`, "")).toBe(3); // a third entry
  });
});

describe("HEAD never touches the cache", () => {
  test("(h) HEAD is never cached and never puts", async () => {
    const head = await request(`/${PUBLIC_ID}/zarr/store.zarr/zarr.json`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(countUpstream(`${PUBLIC_ID}/zarr/store.zarr/zarr.json`, "")).toBe(1);

    // A GET for the same object afterwards is still a miss -- HEAD wrote
    // nothing to the cache. An allowed Origin keeps this GET on the proxied
    // path (phase 6): a bare GET would redirect instead of reaching the
    // cache at all.
    const get = await request(`/${PUBLIC_ID}/zarr/store.zarr/zarr.json`, {
      headers: { Origin: BROWSER_ORIGIN },
    });
    expect(get.status).toBe(200);
    expect(countUpstream(`${PUBLIC_ID}/zarr/store.zarr/zarr.json`, "")).toBe(2);

    // And a second HEAD, after that GET primed a cache entry, still goes
    // upstream -- HEAD never reads the cache either.
    const head2 = await request(`/${PUBLIC_ID}/zarr/store.zarr/zarr.json`, { method: "HEAD" });
    expect(head2.status).toBe(200);
    expect(countUpstream(`${PUBLIC_ID}/zarr/store.zarr/zarr.json`, "")).toBe(3);
  });

  test("(17) HEAD with a Range header is never cached, never puts, and forwards the Range upstream", async () => {
    const range = "bytes=0-9";
    const first = await request(CHUNK_PATH, { method: "HEAD", headers: { Range: range } });
    expect(first.status).toBe(206);
    expect(countUpstream(CHUNK_KEY, range)).toBe(1);

    const second = await request(CHUNK_PATH, { method: "HEAD", headers: { Range: range } });
    expect(second.status).toBe(206);
    // Still going upstream every time -- proves neither HEAD wrote or read
    // a cache entry. The upstream log entry only exists because the Range
    // header really was forwarded (the fake server keys its log on it).
    expect(countUpstream(CHUNK_KEY, range)).toBe(2);
  });
});

describe("CORS reapplication on a cache hit (#1178)", () => {
  const ALLOWED = "https://nemar.org";
  const BLOCKED = "https://evil.example.org";

  test("(i) an allowed origin gets ACAO on a hit, a blocked one does not", async () => {
    // Phase 6: a store object (store.zarr/zarr.json) with a blocked Origin
    // now redirects rather than reaching the cache at all, which would make
    // this test pass for the wrong reason (a redirect never carries ACAO
    // either). index.json is never a redirect candidate, so a blocked
    // Origin genuinely reaches the shared cache entry here -- the scenario
    // this test is actually about: the Cache API doesn't honour
    // Vary: Origin, so CORS has to be reapplied per requester on the way out.
    const path = `/${PUBLIC_ID}/zarr/index.json`;
    const key = `${PUBLIC_ID}/zarr/index.json`;
    // Prime the cache from the allowed origin.
    const primed = await request(path, { headers: { Origin: ALLOWED } });
    expect(primed.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(countUpstream(key, "")).toBe(1);

    // A blocked origin hits the SAME cache entry (Vary: Origin is not
    // honoured by the Cache API) but must not get the priming origin's ACAO.
    const blockedHit = await request(path, { headers: { Origin: BLOCKED } });
    expect(blockedHit.status).toBe(200);
    expect(countUpstream(key, "")).toBe(1); // still a hit
    expect(blockedHit.headers.get("access-control-allow-origin")).toBeNull();

    // A subsequent allowed-origin request gets its ACAO back.
    const allowedHit = await request(path, { headers: { Origin: ALLOWED } });
    expect(countUpstream(key, "")).toBe(1); // still a hit
    expect(allowedHit.headers.get("access-control-allow-origin")).toBe(ALLOWED);
  });

  test("a range hit also gets CORS reapplied per requester", async () => {
    // Same reasoning as above: index.json stays proxied for a blocked
    // Origin (phase 6), so this exercises the range-cache CORS-reapplication
    // path rather than the redirect branch a store object would now take.
    const path = `/${PUBLIC_ID}/zarr/index.json`;
    const key = `${PUBLIC_ID}/zarr/index.json`;
    await request(path, { headers: { Range: "bytes=0-5", Origin: ALLOWED } });
    const blockedHit = await request(path, {
      headers: { Range: "bytes=0-5", Origin: BLOCKED },
    });
    expect(blockedHit.status).toBe(206);
    expect(blockedHit.headers.get("access-control-allow-origin")).toBeNull();
    expect(countUpstream(key, "bytes=0-5")).toBe(1);
  });
});

describe("404 caching (#1178 item 4)", () => {
  test("(j) missing-object 404 carries max-age=60 and is served from cache", async () => {
    // An allowed Origin keeps this on the proxied path (phase 6) -- a bare
    // request to a store object now redirects instead of reaching the
    // missing-object 404/negative-cache logic under test here.
    const missing = `/${PUBLIC_ID}/zarr/nope.zarr/zarr.json`;
    const headers = { Origin: BROWSER_ORIGIN };
    const first = await request(missing, { headers });
    expect(first.status).toBe(404);
    expect(first.headers.get("cache-control")).toBe("public, max-age=60");
    expect(countUpstream(`${PUBLIC_ID}/zarr/nope.zarr/zarr.json`, "")).toBe(1);

    const second = await request(missing, { headers });
    expect(second.status).toBe(404);
    expect(second.headers.get("cache-control")).toBe("public, max-age=60");
    // Zero additional upstream hits -- served from the edge.
    expect(countUpstream(`${PUBLIC_ID}/zarr/nope.zarr/zarr.json`, "")).toBe(1);
  });

  test("(j) private dataset 404 is not cached", async () => {
    // An allowed Origin keeps this on the proxied/D1-gated path. A bare
    // request to this same store-object path is ALSO still a 302 today
    // (phase 6 redirects regardless of visibility, see the "no D1 read on
    // the redirect path" describe block below) -- this test is specifically
    // about the D1 gate a BROWSER request still goes through.
    const path = `/${PRIVATE_ID}/zarr/store.zarr/zarr.json`;
    const headers = { Origin: BROWSER_ORIGIN };
    const first = await request(path, { headers });
    expect(first.status).toBe(404);
    expect(first.headers.get("cache-control")).toBe("public, max-age=60");
    // The D1 gate rejects before any upstream fetch.
    expect(countUpstream(`${PRIVATE_ID}/zarr/store.zarr/zarr.json`)).toBe(0);

    const second = await request(path, { headers });
    expect(second.status).toBe(404);
    // Still gated by D1 on every request -- never short-circuited by a
    // cached entry (the private dataset's visibility can flip).
    expect(countUpstream(`${PRIVATE_ID}/zarr/store.zarr/zarr.json`)).toBe(0);
  });

  test("bad-path 404 carries max-age=60 and is not cached", async () => {
    // Empty rest 404s before the redirect decision is even made (serve()'s
    // own null/empty-rest check runs first), so no Origin is needed here.
    const first = await request(`/${PUBLIC_ID}/zarr/`);
    expect(first.status).toBe(404);
    expect(first.headers.get("cache-control")).toBe("public, max-age=60");
  });

  test("HEAD on a missing object is never cached", async () => {
    const missing = `/${PUBLIC_ID}/zarr/also-missing.zarr/zarr.json`;
    const head = await request(missing, { method: "HEAD" });
    expect(head.status).toBe(404);
    expect(countUpstream(`${PUBLIC_ID}/zarr/also-missing.zarr/zarr.json`, "")).toBe(1);

    // An allowed Origin keeps this GET on the proxied path (phase 6); a
    // bare GET here would redirect rather than hit the missing-object 404.
    const get = await request(missing, { headers: { Origin: BROWSER_ORIGIN } });
    expect(get.status).toBe(404);
    // The HEAD did not populate the cache -- this GET still hits upstream.
    expect(countUpstream(`${PUBLIC_ID}/zarr/also-missing.zarr/zarr.json`, "")).toBe(2);
  });

  test("(2) a ranged 404 probe reuses the canonical negative-cache entry (#1181 review item 2)", async () => {
    const missing = `/${PUBLIC_ID}/zarr/still-missing.zarr/zarr.json`;
    const missingKey = `${PUBLIC_ID}/zarr/still-missing.zarr/zarr.json`;
    const range = "bytes=0-9";
    const headers = { Origin: BROWSER_ORIGIN };

    const first = await request(missing, { headers: { Range: range, ...headers } });
    expect(first.status).toBe(404);
    expect(countUpstream(missingKey, range)).toBe(1);

    const second = await request(missing, { headers: { Range: range, ...headers } });
    expect(second.status).toBe(404);
    // The second request's range-key lookup misses (each range mints its
    // own key) but falls back to the canonical key, which the first
    // request's 404 was cached under -- so this never reaches upstream.
    expect(countUpstream(missingKey, range)).toBe(1);

    // A DIFFERENT range on the same missing object also converges on the
    // same canonical negative entry.
    const third = await request(missing, { headers: { Range: "bytes=10-19", ...headers } });
    expect(third.status).toBe(404);
    expect(countUpstream(missingKey, "bytes=10-19")).toBe(0);
  });
});

describe("visibility gate runs before every cache lookup (#1181 review item 1)", () => {
  test("flipping a dataset private stops both a primed full-object entry and a primed range entry immediately", async () => {
    // An allowed Origin keeps both paths on the proxied/D1-gated branch
    // (phase 6): a bare request to either would redirect regardless of
    // visibility, which is a different (and separately tested, see "no D1
    // read on the redirect path" below) guarantee than the one under test
    // here -- that the PROXIED path's D1 gate runs before every cache
    // lookup, not just on a miss.
    const origin = { Origin: BROWSER_ORIGIN };
    const fullPath = `/${PUBLIC_ID}/zarr/store.zarr/zarr.json`;
    const fullKey = `${PUBLIC_ID}/zarr/store.zarr/zarr.json`;
    const range = "bytes=0-9";

    // Prime both a full-object entry and a range entry while public.
    const primedFull = await request(fullPath, { headers: origin });
    expect(primedFull.status).toBe(200);
    const primedRange = await request(CHUNK_PATH, { headers: { Range: range, ...origin } });
    expect(primedRange.status).toBe(206);
    expect(countUpstream(fullKey, "")).toBe(1);
    expect(countUpstream(CHUNK_KEY, range)).toBe(1);

    // Flip visibility to private directly in D1.
    db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = ?", [PUBLIC_ID]);

    const flippedFull = await request(fullPath, { headers: origin });
    expect(flippedFull.status).toBe(404);
    const flippedRange = await request(CHUNK_PATH, { headers: { Range: range, ...origin } });
    expect(flippedRange.status).toBe(404);
    // No new upstream calls either -- the gate rejected BEFORE either cache
    // entry was even consulted, so a stale cached response never left the
    // edge and S3 was never re-hit.
    expect(countUpstream(fullKey, "")).toBe(1);
    expect(countUpstream(CHUNK_KEY, range)).toBe(1);

    // Flip back to public: the primed cache entries are untouched by any of
    // this and are served again without a new upstream hit.
    db.run("UPDATE datasets SET visibility = 'public' WHERE dataset_id = ?", [PUBLIC_ID]);
    const restoredFull = await request(fullPath, { headers: origin });
    expect(restoredFull.status).toBe(200);
    const restoredRange = await request(CHUNK_PATH, { headers: { Range: range, ...origin } });
    expect(restoredRange.status).toBe(206);
    expect(countUpstream(fullKey, "")).toBe(1);
    expect(countUpstream(CHUNK_KEY, range)).toBe(1);
  });
});

describe("a 206 with no Content-Range fails closed (#1181 review item 3)", () => {
  test("passes through uncached and warns once with the key", async () => {
    const path = `/${PUBLIC_ID}/zarr/store.zarr/c/quirk/no-range-header`;
    const key = `${PUBLIC_ID}/zarr/store.zarr/c/quirk/no-range-header`;
    const range = "bytes=0-9";
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const first = await request(path, { headers: { Range: range, Origin: BROWSER_ORIGIN } });
      expect(first.status).toBe(206);
      expect(first.headers.get("content-range")).toBeNull();
      expect(countUpstream(key, range)).toBe(1);
      expect(warnings.length).toBe(1);
      expect(String(warnings[0][0])).toContain("without Content-Range");
      expect(String(warnings[0][0])).toContain(key);

      const second = await request(path, { headers: { Range: range, Origin: BROWSER_ORIGIN } });
      expect(second.status).toBe(206);
      // Never cached -- the second identical request hits upstream again.
      expect(countUpstream(key, range)).toBe(2);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("size caps on cached entries (#1181 review item 4)", () => {
  test("a range slice over RANGE_CACHE_MAX_BYTES is served correctly and not cached", async () => {
    const path = `/${PUBLIC_ID}/zarr/store.zarr/c/big/oversized`;
    const key = `${PUBLIC_ID}/zarr/store.zarr/c/big/oversized`;
    const end = RANGE_CACHE_MAX_BYTES; // inclusive 0..end => cap+1 bytes, over the cap
    const range = `bytes=0-${end}`;

    const first = await request(path, { headers: { Range: range, Origin: BROWSER_ORIGIN } });
    expect(first.status).toBe(206);
    const firstBuf = await first.arrayBuffer();
    expect(firstBuf.byteLength).toBe(end + 1);
    expect(countUpstream(key, range)).toBe(1);

    const second = await request(path, { headers: { Range: range, Origin: BROWSER_ORIGIN } });
    expect(second.status).toBe(206);
    // Not cached -- served fresh from upstream again.
    expect(countUpstream(key, range)).toBe(2);
  }, 20000);

  test("a full object over FULL_OBJECT_CACHE_MAX_BYTES is served correctly and not cached", async () => {
    const path = `/${PUBLIC_ID}/zarr/store.zarr/c/big/oversized`;
    const key = `${PUBLIC_ID}/zarr/store.zarr/c/big/oversized`;

    const first = await request(path, { headers: { Origin: BROWSER_ORIGIN } });
    expect(first.status).toBe(200);
    const firstBuf = await first.arrayBuffer();
    expect(firstBuf.byteLength).toBe(CAP_TEST_BYTES.length);
    expect(countUpstream(key, "")).toBe(1);

    const second = await request(path, { headers: { Origin: BROWSER_ORIGIN } });
    expect(second.status).toBe(200);
    expect(countUpstream(key, "")).toBe(2); // not cached
  }, 20000);

  test("a 206 with no Content-Length is not cached", async () => {
    const path = `/${PUBLIC_ID}/zarr/store.zarr/c/quirk/no-length-header`;
    const key = `${PUBLIC_ID}/zarr/store.zarr/c/quirk/no-length-header`;
    const range = "bytes=0-9";

    const first = await request(path, { headers: { Range: range, Origin: BROWSER_ORIGIN } });
    expect(first.status).toBe(206);
    expect(first.headers.get("content-length")).toBeNull();
    expect(first.headers.get("content-range")).toBe(`bytes 0-9/${QUIRK_BYTES.length}`);
    expect(countUpstream(key, range)).toBe(1);

    const second = await request(path, { headers: { Range: range, Origin: BROWSER_ORIGIN } });
    expect(second.status).toBe(206);
    expect(countUpstream(key, range)).toBe(2); // not cached -- size couldn't be checked
  });
});

describe("upstream can ignore a well-formed single range (#1181 review item 18)", () => {
  test("passed through as 200 and never cached under the range key", async () => {
    const path = `/${PUBLIC_ID}/zarr/store.zarr/c/quirk/ignored-range`;
    const key = `${PUBLIC_ID}/zarr/store.zarr/c/quirk/ignored-range`;
    const range = "bytes=0-9";

    const first = await request(path, { headers: { Range: range, Origin: BROWSER_ORIGIN } });
    expect(first.status).toBe(200);
    expect(countUpstream(key, range)).toBe(1);

    const second = await request(path, { headers: { Range: range, Origin: BROWSER_ORIGIN } });
    expect(second.status).toBe(200);
    // Never cached -- upstream hit again.
    expect(countUpstream(key, range)).toBe(2);
  });
});

describe("concurrent identical range requests (#1181 review item 16)", () => {
  test("four at once: all 206 with identical bytes; at most 4 upstream hits, then a hit", async () => {
    const range = "bytes=0-49";
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(CHUNK_PATH, { headers: { Range: range, Origin: BROWSER_ORIGIN } }),
      ),
    );
    for (const res of results) {
      expect(res.status).toBe(206);
    }
    const bodies = await Promise.all(results.map((r) => r.arrayBuffer()));
    for (const b of bodies) {
      expect(new Uint8Array(b)).toEqual(CHUNK_BYTES.slice(0, 50));
    }

    const hitsAfterBurst = countUpstream(CHUNK_KEY, range);
    expect(hitsAfterBurst).toBeGreaterThan(0);
    expect(hitsAfterBurst).toBeLessThanOrEqual(4);

    const fifth = await request(CHUNK_PATH, { headers: { Range: range, Origin: BROWSER_ORIGIN } });
    expect(fifth.status).toBe(206);
    // No new upstream hit -- the burst left a usable cache entry.
    expect(countUpstream(CHUNK_KEY, range)).toBe(hitsAfterBurst);
  });
});

describe("canonical key from the normalised S3 key (#1181 review item 8)", () => {
  test("an encoded and an unencoded spelling of the same path share one cache entry", async () => {
    const plain = `/${PUBLIC_ID}/zarr/store.zarr/zarr.json`;
    // %2e decodes to '.' -- a differently percent-encoded spelling of the
    // identical object, not a different one.
    const encoded = `/${PUBLIC_ID}/zarr/store.zarr/zarr%2ejson`;
    const objectKey = `${PUBLIC_ID}/zarr/store.zarr/zarr.json`;

    const first = await request(plain, { headers: { Origin: BROWSER_ORIGIN } });
    expect(first.status).toBe(200);
    expect(countUpstream(objectKey, "")).toBe(1);

    const second = await request(encoded, { headers: { Origin: BROWSER_ORIGIN } });
    expect(second.status).toBe(200);
    const secondBytes = new Uint8Array(await second.arrayBuffer());
    expect(secondBytes).toEqual(ZARR_JSON);
    // Same cache key despite the different raw spelling on the wire -- hit,
    // not a second upstream fetch.
    expect(countUpstream(objectKey, "")).toBe(1);
  });
});

describe("cache.put failures are logged, not fatal (#1181 review item 6)", () => {
  test("a rejecting CacheLike.put still serves the response; the failure is logged", async () => {
    const rejectingApp = createZarrDataRoutes({
      ...testDeps(),
      cache: () => new RejectingPutCache(),
    });
    const originalError = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      // An allowed Origin keeps this on the proxied/cache-writing path
      // (phase 6) -- a bare request would redirect and never call
      // cache.put() at all.
      const res = await requestWith(
        rejectingApp,
        `/${PUBLIC_ID}/zarr/store.zarr/zarr.json`,
        { headers: { Origin: BROWSER_ORIGIN } },
        testEnv(),
      );
      expect(res.status).toBe(200);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes).toEqual(ZARR_JSON);
      expect(calls.some((args) => String(args[0]).includes("cache.put failed"))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });

  test("a rejecting put on a range entry also still serves the response", async () => {
    const rejectingApp = createZarrDataRoutes({
      ...testDeps(),
      cache: () => new RejectingPutCache(),
    });
    const originalError = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      const res = await requestWith(
        rejectingApp,
        CHUNK_PATH,
        { headers: { Range: "bytes=0-9", Origin: BROWSER_ORIGIN } },
        testEnv(),
      );
      expect(res.status).toBe(206);
      expect(calls.some((args) => String(args[0]).includes("cache.put failed"))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });

  test("a synchronously-throwing CacheLike.put still serves the response; the failure is logged", async () => {
    const throwingPutApp = createZarrDataRoutes({
      ...testDeps(),
      cache: () => new SynchronousThrowPutCache(),
    });
    const originalError = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      const res = await requestWith(
        throwingPutApp,
        `/${PUBLIC_ID}/zarr/store.zarr/zarr.json`,
        { headers: { Origin: BROWSER_ORIGIN } },
        testEnv(),
      );
      expect(res.status).toBe(200);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes).toEqual(ZARR_JSON);
      expect(calls.some((args) => String(args[0]).includes("cache.put failed"))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });

  test("a synchronously-throwing put on a range entry (the real 206 case) also still serves the response", async () => {
    const throwingPutApp = createZarrDataRoutes({
      ...testDeps(),
      cache: () => new SynchronousThrowPutCache(),
    });
    const originalError = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      const res = await requestWith(
        throwingPutApp,
        CHUNK_PATH,
        { headers: { Range: "bytes=0-9", Origin: BROWSER_ORIGIN } },
        testEnv(),
      );
      expect(res.status).toBe(206);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes).toEqual(CHUNK_BYTES.slice(0, 10));
      expect(calls.some((args) => String(args[0]).includes("cache.put failed"))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });
});

describe("onError applies CORS to an unhandled failure (#1181 review item 7)", () => {
  test("a throwing CacheLike.match yields 500 with CORS for an allowed origin", async () => {
    const throwingApp = createZarrDataRoutes({
      ...testDeps(),
      cache: () => new ThrowingMatchCache(),
    });
    const originalError = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      const res = await requestWith(
        throwingApp,
        `/${PUBLIC_ID}/zarr/store.zarr/zarr.json`,
        { headers: { Origin: "https://nemar.org" } },
        testEnv(),
      );
      expect(res.status).toBe(500);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://nemar.org");
      expect(calls.some((args) => String(args[0]).includes("unhandled"))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });

  test("a blocked origin gets 500 with no ACAO", async () => {
    // Phase 6: a blocked-Origin request to a STORE object (store.zarr/
    // zarr.json) now redirects and never calls cache.match() at all, so it
    // would no longer reach onError -- use index.json (never a redirect
    // candidate) to keep exercising the throwing-cache/onError path with a
    // blocked Origin.
    const throwingApp = createZarrDataRoutes({
      ...testDeps(),
      cache: () => new ThrowingMatchCache(),
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      const res = await requestWith(
        throwingApp,
        `/${PUBLIC_ID}/zarr/index.json`,
        { headers: { Origin: "https://evil.example.org" } },
        testEnv(),
      );
      expect(res.status).toBe(500);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      console.error = originalError;
    }
  });
});

describe("telemetry with a real binding-shaped collector (#1181 review item 15)", () => {
  test("range miss and hit both report the slice length; a full-object hit reports the full length", async () => {
    const points: Array<{ blobs: string[]; doubles: number[] }> = [];
    const env = {
      ...testEnv(),
      ANALYTICS: {
        writeDataPoint: (p: { blobs: string[]; doubles: number[] }) => {
          points.push(p);
        },
      },
    } as unknown as Bindings;

    // An allowed Origin keeps these on the proxied path (phase 6): this
    // test is about recordAccess()'s bytes reporting on the PROXY branch,
    // which has its own dedicated tests above for the redirect branch.
    const origin = { Origin: BROWSER_ORIGIN };
    await requestWithEnv(CHUNK_PATH, { headers: { Range: "bytes=0-9", ...origin } }, env); // range MISS
    expect(points.length).toBe(1);
    expect(points[0].doubles[0]).toBe(10); // bytes 0-9 inclusive

    await requestWithEnv(CHUNK_PATH, { headers: { Range: "bytes=0-9", ...origin } }, env); // range HIT
    expect(points.length).toBe(2);
    expect(points[1].doubles[0]).toBe(10);

    const fullPath = `/${PUBLIC_ID}/zarr/store.zarr/zarr.json`;
    await requestWithEnv(fullPath, { headers: origin }, env); // full-object MISS (primes the entry)
    expect(points.length).toBe(3);
    expect(points[2].doubles[0]).toBe(ZARR_JSON.length);

    await requestWithEnv(fullPath, { headers: origin }, env); // full-object HIT
    expect(points.length).toBe(4);
    expect(points[3].doubles[0]).toBe(ZARR_JSON.length);
  });

  test("(k) recordAccess is fire-and-forget with no ANALYTICS binding", async () => {
    // env.ANALYTICS is left undefined by testEnv() -- recordAccess() no-ops
    // in that case (see services/access-metrics.ts). This just proves the
    // route doesn't throw or block on it, for both a fresh fetch and a
    // cache hit. An allowed Origin keeps this on the proxied path.
    const headers = { Origin: BROWSER_ORIGIN };
    const fresh = await request(`/${PUBLIC_ID}/zarr/store.zarr/zarr.json`, { headers });
    expect(fresh.status).toBe(200);
    const hit = await request(`/${PUBLIC_ID}/zarr/store.zarr/zarr.json`, { headers });
    expect(hit.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Phase 6 (#1181 phase 6 / issue #1061): redirect the bytes for non-browser
// clients instead of proxying them. The sections below extend this file's
// existing harness (real Bun.serve() upstream, real in-memory edge cache,
// real D1) rather than forking it -- `app`, `db`, `cache`, `upstream`,
// `request()`, `requestWithEnv()`, `requestWith()`, `testEnv()`, `testDeps()`,
// `countUpstream()`, and the fixture constants above are all shared.
// ---------------------------------------------------------------------------

describe("routing fork stays correct at the edges (#1181 phase 6 / issue #1061)", () => {
  test("a non-browser GET (no Origin) of a chunk redirects to the exact public S3 URL", async () => {
    const res = await request(CHUNK_PATH);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`http://localhost:${upstream.port}/${CHUNK_KEY}`);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    // Never touched the fake upstream -- serve() builds the Location string,
    // it never fetches it.
    expect(countUpstream(CHUNK_KEY, "")).toBe(0);
  });

  test("a non-allowlisted Origin also redirects", async () => {
    const res = await request(CHUNK_PATH, { headers: { Origin: "https://evil.example.org" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`http://localhost:${upstream.port}/${CHUNK_KEY}`);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("an allowlisted Origin is still proxied with bytes + CORS, exactly as phase 1", async () => {
    const res = await request(CHUNK_PATH, { headers: { Origin: "https://nemar.org" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://nemar.org");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(CHUNK_BYTES);
    expect(countUpstream(CHUNK_KEY, "")).toBe(1);
  });

  test("index.json with no Origin is still proxied, edge-cached, and D1-gated -- never redirected", async () => {
    const res = await request(`/${PUBLIC_ID}/zarr/index.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(INDEX_JSON);
    expect(countUpstream(`${PUBLIC_ID}/zarr/index.json`, "")).toBe(1);

    // Cached on the second hit -- the proxied path, unchanged.
    const hit = await request(`/${PUBLIC_ID}/zarr/index.json`);
    expect(hit.status).toBe(200);
    expect(countUpstream(`${PUBLIC_ID}/zarr/index.json`, "")).toBe(1);
  });

  test("index.json on a private dataset is still 404 (D1-gated), never redirected", async () => {
    // index.json is never a redirect candidate, so the private dataset stays
    // protected by the D1 gate exactly as before phase 6.
    const res = await request(`/${PRIVATE_ID}/zarr/index.json`);
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  test("HEAD is never redirected, with or without Origin, and stays D1-gated", async () => {
    const noOrigin = await request(`/${PUBLIC_ID}/zarr/store.zarr/zarr.json`, { method: "HEAD" });
    expect(noOrigin.status).toBe(200);
    expect(noOrigin.headers.get("location")).toBeNull();

    const withOrigin = await request(`/${PUBLIC_ID}/zarr/store.zarr/zarr.json`, {
      method: "HEAD",
      headers: { Origin: "https://evil.example.org" },
    });
    expect(withOrigin.status).toBe(200);
    expect(withOrigin.headers.get("location")).toBeNull();

    const privateHead = await request(`/${PRIVATE_ID}/zarr/store.zarr/zarr.json`, {
      method: "HEAD",
    });
    expect(privateHead.status).toBe(404);
  });
});

function countingDb(inner: D1Database): { db: D1Database; prepareCalls: () => number } {
  let calls = 0;
  const wrapped = {
    ...inner,
    prepare: (sql: string) => {
      calls++;
      return inner.prepare(sql);
    },
  } as D1Database;
  return { db: wrapped, prepareCalls: () => calls };
}

describe("no D1 read on the redirect path (#1181 phase 6 / issue #1061)", () => {
  test("a redirect-candidate GET performs zero D1 prepare calls and zero upstream requests", async () => {
    const { db: countedDb, prepareCalls } = countingDb(realD1(db));
    const env = { ...testEnv(), DB: countedDb } as Bindings;

    const res = await requestWithEnv(CHUNK_PATH, {}, env);
    expect(res.status).toBe(302);
    expect(prepareCalls()).toBe(0);
    expect(requestLog.length).toBe(0);
  });

  test("still redirects (no D1 read) for a PRIVATE dataset's chunk -- the bucket's own deny-list is the real gate on this path, not D1", async () => {
    const { db: countedDb, prepareCalls } = countingDb(realD1(db));
    const env = { ...testEnv(), DB: countedDb } as Bindings;
    const path = `/${PRIVATE_ID}/zarr/store.zarr/zarr.json`;

    const res = await requestWithEnv(path, {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `http://localhost:${upstream.port}/${PRIVATE_ID}/zarr/store.zarr/zarr.json`,
    );
    expect(prepareCalls()).toBe(0);
    expect(requestLog.length).toBe(0);
  });

  test("a redirect candidate with a Range header still performs zero D1 calls", async () => {
    const { db: countedDb, prepareCalls } = countingDb(realD1(db));
    const env = { ...testEnv(), DB: countedDb } as Bindings;

    const res = await requestWithEnv(CHUNK_PATH, { headers: { Range: "bytes=0-9" } }, env);
    expect(res.status).toBe(302);
    expect(prepareCalls()).toBe(0);
  });
});

describe("/zarrproxy path-mount entry point (#1181 phase 6)", () => {
  test("redirects identically through the path-mounted entry point", async () => {
    // Mirrors index.ts's `app.route("/zarrproxy", zarrDataRoutes)` -- Hono
    // prepends the mount prefix without stripping it from c.req.path inside
    // the sub-app, which is exactly what serve()'s prefix search and
    // isRedirectCandidate's ZARR_OBJECT_PATH_RE are both written to tolerate.
    const mounted = new Hono<{ Bindings: Bindings }>();
    mounted.route("/zarrproxy", app);

    const res = await requestWith(mounted, `/zarrproxy${CHUNK_PATH}`, {}, testEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`http://localhost:${upstream.port}/${CHUNK_KEY}`);
    expect(countUpstream(CHUNK_KEY, "")).toBe(0);
  });

  test("index.json still proxies through the path-mounted entry point", async () => {
    const mounted = new Hono<{ Bindings: Bindings }>();
    mounted.route("/zarrproxy", app);

    const res = await requestWith(
      mounted,
      `/zarrproxy/${PUBLIC_ID}/zarr/index.json`,
      {},
      testEnv(),
    );
    expect(res.status).toBe(200);
    expect(countUpstream(`${PUBLIC_ID}/zarr/index.json`, "")).toBe(1);
  });
});

describe("telemetry bytes on the redirect path (#1181 phase 6 / issue #1061)", () => {
  function collector(): { env: Bindings; points: Array<{ blobs: string[]; doubles: number[] }> } {
    const points: Array<{ blobs: string[]; doubles: number[] }> = [];
    const env = {
      ...testEnv(),
      ANALYTICS: {
        writeDataPoint: (p: { blobs: string[]; doubles: number[] }) => {
          points.push(p);
        },
      },
    } as unknown as Bindings;
    return { env, points };
  }

  test("a bounded range (bytes=0-999) reports exactly 1000 bytes, never a 0 fallback", async () => {
    const { env, points } = collector();
    const res = await requestWithEnv(CHUNK_PATH, { headers: { Range: "bytes=0-999" } }, env);
    expect(res.status).toBe(302);
    expect(points.length).toBe(1);
    expect(points[0].doubles[0]).toBe(1000);
    expect(points[0].blobs).toEqual([PUBLIC_ID, "zarr", "chunk-redirect"]);
  });

  test("a suffix range (bytes=-500) reports exactly 500 bytes", async () => {
    const { env, points } = collector();
    await requestWithEnv(CHUNK_PATH, { headers: { Range: "bytes=-500" } }, env);
    expect(points[0].doubles[0]).toBe(500);
  });

  test("an open-ended range (bytes=500-) reports 0 -- total size unknown without hitting S3", async () => {
    const { env, points } = collector();
    await requestWithEnv(CHUNK_PATH, { headers: { Range: "bytes=500-" } }, env);
    expect(points[0].doubles[0]).toBe(0);
  });

  test("no Range header reports 0", async () => {
    const { env, points } = collector();
    await requestWithEnv(CHUNK_PATH, {}, env);
    expect(points[0].doubles[0]).toBe(0);
  });

  test("a multi-range header reports 0 (not reducible to one bounded count)", async () => {
    const { env, points } = collector();
    await requestWithEnv(CHUNK_PATH, { headers: { Range: "bytes=0-1,4-5" } }, env);
    expect(points[0].doubles[0]).toBe(0);
  });
});

describe("isRedirectCandidate (#1181 phase 6 / issue #1061)", () => {
  test("GET to a store object with no Origin is a candidate", () => {
    expect(isRedirectCandidate("GET", "/on000001/zarr/store.zarr/c/0/0", null)).toBe(true);
  });

  test("GET with an allowlisted Origin is not a candidate", () => {
    expect(isRedirectCandidate("GET", "/on000001/zarr/store.zarr/c/0/0", "https://nemar.org")).toBe(
      false,
    );
  });

  test("GET with a non-allowlisted Origin is still a candidate", () => {
    expect(
      isRedirectCandidate("GET", "/on000001/zarr/store.zarr/c/0/0", "https://evil.example.org"),
    ).toBe(true);
  });

  test("HEAD is never a candidate, Origin or not", () => {
    expect(isRedirectCandidate("HEAD", "/on000001/zarr/store.zarr/c/0/0", null)).toBe(false);
    expect(
      isRedirectCandidate("HEAD", "/on000001/zarr/store.zarr/c/0/0", "https://evil.example.org"),
    ).toBe(false);
  });

  test("OPTIONS is never a candidate", () => {
    expect(isRedirectCandidate("OPTIONS", "/on000001/zarr/store.zarr/c/0/0", null)).toBe(false);
  });

  test("index.json is never a candidate", () => {
    expect(isRedirectCandidate("GET", "/on000001/zarr/index.json", null)).toBe(false);
  });

  test("an empty or malformed rest is never a candidate", () => {
    expect(isRedirectCandidate("GET", "/on000001/zarr/", null)).toBe(false);
    expect(isRedirectCandidate("GET", "/on000001/zarr", null)).toBe(false);
    expect(isRedirectCandidate("GET", "/on000001/zarr/..", null)).toBe(false);
  });

  test("the /zarrproxy path-mount shape is recognised identically", () => {
    expect(isRedirectCandidate("GET", "/zarrproxy/on000001/zarr/store.zarr/c/0/0", null)).toBe(
      true,
    );
    expect(isRedirectCandidate("GET", "/zarrproxy/on000001/zarr/index.json", null)).toBe(false);
  });

  test("a path outside the zarr shape is never a candidate", () => {
    expect(isRedirectCandidate("GET", "/datasets", null)).toBe(false);
  });

  test("malformed percent-encoding falls through to 'not a candidate' rather than throwing", () => {
    expect(isRedirectCandidate("GET", "/on000001/zarr/%", null)).toBe(false);
  });
});

describe("bytesFromRangeHeader (#1181 phase 6 / issue #1061)", () => {
  test("bounded range: B - A + 1", () => {
    expect(bytesFromRangeHeader("bytes=0-999")).toBe(1000);
    expect(bytesFromRangeHeader("bytes=1000-1999")).toBe(1000);
  });

  test("suffix range: N", () => {
    expect(bytesFromRangeHeader("bytes=-500")).toBe(500);
  });

  test("open-ended range: 0 (unknown without hitting S3)", () => {
    expect(bytesFromRangeHeader("bytes=1000-")).toBe(0);
  });

  test("no header: 0", () => {
    expect(bytesFromRangeHeader(null)).toBe(0);
  });

  test("multi-range / malformed: 0", () => {
    expect(bytesFromRangeHeader("bytes=0-1,4-5")).toBe(0);
    expect(bytesFromRangeHeader("garbage")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rate-limiter exemption for redirect candidates (#1181 phase 6 / issue
// #1061). rateLimiter's own request counter reads/writes the REAL
// `caches.default` global directly -- a different cache from the
// deps.cache() seam this file otherwise uses for zarr-data.ts's OWN edge
// cache, an unrelated concern. bun:test has no `caches` global at all, and
// every describe block above sidesteps that by keeping ENVIRONMENT:
// "development" in testEnv(), which is rateLimiter's own documented bypass
// (see middleware/rateLimit.ts). This block is the one place that needs the
// REAL, non-bypassed rateLimiter code path, so it installs a real in-memory
// CacheStorage stand-in for its own duration only -- the same technique
// rate-limit-buckets.test.ts uses for the same reason, restored in afterAll
// so no other suite sharing this process (root `bun test` runs test/ and
// backend/test/ together, see AGENTS.md) sees a stray global.
// ---------------------------------------------------------------------------

class RateLimitCache implements Cache {
  private store = new Map<string, { body: string; headers: Record<string, string> }>();

  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    const entry = this.store.get(keyFor(req));
    return entry ? new Response(entry.body, { headers: entry.headers }) : undefined;
  }

  async put(req: RequestInfo | URL, res: Response): Promise<void> {
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    this.store.set(keyFor(req), { body: await res.text(), headers });
  }

  async delete(): Promise<boolean> {
    return false;
  }
  async add(): Promise<void> {
    throw new Error("not implemented");
  }
  async addAll(): Promise<void> {
    throw new Error("not implemented");
  }
  async keys(): Promise<readonly Request[]> {
    return [];
  }
  async matchAll(): Promise<readonly Response[]> {
    return [];
  }

  clear(): void {
    this.store.clear();
  }

  /** Read back the counter rateLimiter itself wrote (`{"count": N}`), or
   *  undefined if this bucket key was never touched at all -- the strongest
   *  proof that a redirect candidate never reached the enforcement code. */
  count(url: string): number | undefined {
    const entry = this.store.get(url);
    return entry ? (JSON.parse(entry.body) as { count: number }).count : undefined;
  }

  /** Seed a bucket directly at the real cap boundary, in the exact shape
   *  rateLimiter writes, so a test can prove enforcement AT the production
   *  DATA_MAX_REQUESTS cap without looping thousands of real requests
   *  through the full D1/cache-backed app. */
  seedCount(url: string, count: number): void {
    this.store.set(url, {
      body: JSON.stringify({ count }),
      headers: { "Cache-Control": `max-age=${__limits.WINDOW_SIZE}` },
    });
  }
}

describe("rate limiter exemption for redirect candidates (#1181 phase 6 / issue #1061)", () => {
  const rlCache = new RateLimitCache();
  // biome-ignore lint/suspicious/noExplicitAny: test-only runtime patch, mirrors rate-limit-buckets.test.ts
  let originalCaches: any;

  beforeAll(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only runtime patch
    originalCaches = (globalThis as any).caches;
    // biome-ignore lint/suspicious/noExplicitAny: test-only runtime patch
    (globalThis as any).caches = { default: rlCache } as unknown as CacheStorage;
  });

  afterAll(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only runtime restore
    (globalThis as any).caches = originalCaches;
  });

  beforeEach(() => {
    rlCache.clear();
  });

  // ENVIRONMENT must NOT be "development" here -- that's rateLimiter's own
  // bypass, and this block exists specifically to exercise the real,
  // non-bypassed code path. Computed lazily (per call, not per describe) so
  // it always reads the CURRENT `db` the outer beforeEach just rebuilt.
  function rlEnv(): Bindings {
    return { ...testEnv(), ENVIRONMENT: "production" } as Bindings;
  }

  test("a redirect candidate never touches the data-ip counter, no matter the IP or volume", async () => {
    const ip = "203.0.113.10";
    for (let i = 0; i < 5; i++) {
      const res = await requestWith(
        app,
        CHUNK_PATH,
        { headers: { "CF-Connecting-IP": ip } },
        rlEnv(),
      );
      expect(res.status).toBe(302);
    }
    // Never created -- proves the middleware skipped rateLimiter entirely
    // for these hits, not just that they landed under a generous cap.
    expect(rlCache.count(`https://rate-limit.internal/rl:data-ip:${ip}`)).toBeUndefined();
  });

  test("a redirect candidate still succeeds even once the SAME IP's data-ip bucket is fully exhausted", async () => {
    const ip = "203.0.113.11";
    rlCache.seedCount(`https://rate-limit.internal/rl:data-ip:${ip}`, __limits.DATA_MAX_REQUESTS);

    const res = await requestWith(
      app,
      CHUNK_PATH,
      { headers: { "CF-Connecting-IP": ip } },
      rlEnv(),
    );
    expect(res.status).toBe(302);
  });

  test("a proxied GET (index.json, no Origin) DOES charge the data-ip bucket and 429s at the real cap", async () => {
    const ip = "203.0.113.12";
    const key = `https://rate-limit.internal/rl:data-ip:${ip}`;
    rlCache.seedCount(key, __limits.DATA_MAX_REQUESTS - 1);

    const path = `/${PUBLIC_ID}/zarr/index.json`;
    const first = await requestWith(app, path, { headers: { "CF-Connecting-IP": ip } }, rlEnv());
    expect(first.status).toBe(200);
    expect(rlCache.count(key)).toBe(__limits.DATA_MAX_REQUESTS);

    const second = await requestWith(app, path, { headers: { "CF-Connecting-IP": ip } }, rlEnv());
    expect(second.status).toBe(429);
  });

  test("an allowlisted-Origin GET for a store chunk (proxied, not redirected) also charges the bucket", async () => {
    const ip = "203.0.113.13";
    const key = `https://rate-limit.internal/rl:data-ip:${ip}`;
    rlCache.seedCount(key, __limits.DATA_MAX_REQUESTS - 1);

    const res = await requestWith(
      app,
      CHUNK_PATH,
      { headers: { "CF-Connecting-IP": ip, Origin: "https://nemar.org" } },
      rlEnv(),
    );
    expect(res.status).toBe(200);
    expect(rlCache.count(key)).toBe(__limits.DATA_MAX_REQUESTS);
  });
});
