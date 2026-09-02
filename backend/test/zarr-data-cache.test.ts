/**
 * Edge-cache tests for zarr.nemar.org's data plane (#1178 phase 1 / #1035,
 * epic #1181).
 *
 * Real engines throughout, no mocks:
 *  - Upstream S3 is a real `Bun.serve()` on an ephemeral port, standing in
 *    for the S3 origin via `deps.s3Base` (see ZarrDataDeps in
 *    ../src/routes/zarr-data.ts). It serves fixed byte buffers with real
 *    Range semantics (206 + Content-Range/Content-Length, 416 for
 *    out-of-range, 200 for full GET, HEAD support, ETag, 404 for unknown
 *    keys) and logs every request it receives so tests can assert on
 *    upstream call counts -- the thing that actually proves caching worked
 *    or didn't.
 *  - The edge cache is a real in-memory CacheLike: whatever is `put()` is
 *    what `match()` returns, keyed by request URL, nothing canned.
 *  - D1 is bun:sqlite behind realD1() with every migration applied
 *    (backend/test/helpers/d1.ts), seeded with one public and one private
 *    dataset.
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
 * reapplication, telemetry) runs the real route logic.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import type { Hono } from "hono";
import {
  type CacheLike,
  type ZarrDataDeps,
  canonicalCacheUrl,
  createZarrDataRoutes,
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

const OBJECTS: Record<string, Uint8Array> = {
  [`${PUBLIC_ID}/zarr/index.json`]: INDEX_JSON,
  [`${PUBLIC_ID}/zarr/store.zarr/zarr.json`]: ZARR_JSON,
  [`${PUBLIC_ID}/zarr/store.zarr/c/0/0`]: CHUNK_BYTES,
  [`${PRIVATE_ID}/zarr/store.zarr/zarr.json`]: ZARR_JSON,
};

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
        return new Response(isHead ? null : slice, {
          status: 206,
          headers: {
            "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
            "Content-Length": String(slice.length),
            "Content-Type": "application/octet-stream",
            ETag: etag,
          },
        });
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
    this.store.set(keyFor(request), response.clone());
  }
}

function keyFor(request: RequestInfo | URL): string {
  return request instanceof Request ? request.url : String(request);
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

/** Drives one request through the real route and flushes every promise the
 *  handler handed to executionCtx.waitUntil (the cache.put() calls) before
 *  returning, so the next request in the test sees a settled cache state --
 *  mirrors the real Workers runtime, which keeps the isolate alive until
 *  waitUntil promises settle. */
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const waited: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waited.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const res = await app.request(path, init, testEnv(), ctx);
  await Promise.allSettled(waited);
  return res;
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
  test("keeps only the v query parameter", () => {
    const url = new URL("https://zarr.nemar.org/on000001/zarr/store.zarr/zarr.json?v=abc&foo=bar");
    expect(canonicalCacheUrl(url)).toBe(
      "https://zarr.nemar.org/on000001/zarr/store.zarr/zarr.json?v=abc",
    );
  });

  test("drops a client-supplied __cr entirely", () => {
    const url = new URL("https://zarr.nemar.org/on000001/zarr/store.zarr/c/0/0?__cr=bytes%3D0-9");
    expect(canonicalCacheUrl(url)).toBe("https://zarr.nemar.org/on000001/zarr/store.zarr/c/0/0");
  });

  test("drops an empty v the same as an absent one", () => {
    const url = new URL("https://zarr.nemar.org/on000001/zarr/index.json?v=");
    expect(canonicalCacheUrl(url)).toBe("https://zarr.nemar.org/on000001/zarr/index.json");
  });

  test("no query at all round-trips to origin + path", () => {
    const url = new URL("https://zarr.nemar.org/on000001/zarr/index.json");
    expect(canonicalCacheUrl(url)).toBe("https://zarr.nemar.org/on000001/zarr/index.json");
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

describe("range-keyed cache entries (#1178 item 3)", () => {
  test("(a) ranged GET miss then identical ranged GET hit", async () => {
    const first = await request(CHUNK_PATH, { headers: { Range: "bytes=0-99" } });
    expect(first.status).toBe(206);
    expect(first.headers.get("content-range")).toBe(`bytes 0-99/${CHUNK_BYTES.length}`);
    const firstBytes = new Uint8Array(await first.arrayBuffer());
    expect(countUpstream(CHUNK_KEY, "bytes=0-99")).toBe(1);

    const second = await request(CHUNK_PATH, { headers: { Range: "bytes=0-99" } });
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
    await request(CHUNK_PATH, { headers: { Range: "bytes=0-99" } });
    expect(countUpstream(CHUNK_KEY, "bytes=0-99")).toBe(1);
    expect(countUpstream(CHUNK_KEY, "bytes=100-199")).toBe(0);

    const res = await request(CHUNK_PATH, { headers: { Range: "bytes=100-199" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 100-199/${CHUNK_BYTES.length}`);
    expect(countUpstream(CHUNK_KEY, "bytes=100-199")).toBe(1);
    // The first range's cache entry is untouched.
    expect(countUpstream(CHUNK_KEY, "bytes=0-99")).toBe(1);
  });

  test("(c) full GET after a ranged GET is a separate miss", async () => {
    await request(CHUNK_PATH, { headers: { Range: "bytes=0-99" } });
    expect(countUpstream(CHUNK_KEY, "bytes=0-99")).toBe(1);
    expect(countUpstream(CHUNK_KEY, "")).toBe(0);

    const res = await request(CHUNK_PATH);
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(CHUNK_BYTES.length);
    expect(bytes).toEqual(CHUNK_BYTES);
    expect(countUpstream(CHUNK_KEY, "")).toBe(1);
  });

  test("(d) a client-supplied __cr on a full GET is ignored for keying", async () => {
    const res = await request(`${CHUNK_PATH}?__cr=bytes%3D0-9`);
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(CHUNK_BYTES.length);
    expect(bytes).toEqual(CHUNK_BYTES);
    // No Range header was ever sent upstream -- the __cr query param never
    // reached the fetch, it only exists to poison the cache key if honoured.
    expect(countUpstream(CHUNK_KEY, "")).toBe(1);

    // A second, plain full GET is a cache HIT sharing the same canonical
    // entry -- proving __cr was dropped from the key on the priming request.
    const second = await request(CHUNK_PATH);
    expect(second.status).toBe(200);
    expect(countUpstream(CHUNK_KEY, "")).toBe(1);
  });

  test("(e) multi-range is passed through and never cached", async () => {
    const first = await request(CHUNK_PATH, { headers: { Range: "bytes=0-1,4-5" } });
    expect(first.status).toBe(200); // fake upstream ignores the unsupported spec
    expect(countUpstream(CHUNK_KEY, "bytes=0-1,4-5")).toBe(1);

    const second = await request(CHUNK_PATH, { headers: { Range: "bytes=0-1,4-5" } });
    expect(second.status).toBe(200);
    // Hit upstream again -- never cached.
    expect(countUpstream(CHUNK_KEY, "bytes=0-1,4-5")).toBe(2);
  });

  test("(f) 416 is not cached", async () => {
    const outOfRange = "bytes=999999-1000010";
    const first = await request(CHUNK_PATH, { headers: { Range: outOfRange } });
    expect(countUpstream(CHUNK_KEY, outOfRange)).toBe(1);

    const second = await request(CHUNK_PATH, { headers: { Range: outOfRange } });
    // Hit upstream again -- the 416 was never written to the cache.
    expect(countUpstream(CHUNK_KEY, outOfRange)).toBe(2);
    expect(second.status).toBe(first.status);
  });
});

describe("Cache-Control by tokening (#1178 item 4 / #1035)", () => {
  test("(g) zarr.json: tokened gets 86400, untokened gets 60", async () => {
    const tokened = await request(`/${PUBLIC_ID}/zarr/store.zarr/zarr.json?v=abc123`);
    expect(tokened.headers.get("cache-control")).toBe(
      "public, max-age=86400, stale-while-revalidate=86400",
    );

    const untokened = await request(`/${PUBLIC_ID}/zarr/store.zarr/zarr.json`);
    expect(untokened.headers.get("cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=300",
    );
  });

  test("(g) index.json: untokened gets 3600 (was 60)", async () => {
    const res = await request(`/${PUBLIC_ID}/zarr/index.json`);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=3600, stale-while-revalidate=86400",
    );
  });

  test("(g) index.json: tokened matches zarr.json's tokened TTL", async () => {
    const res = await request(`/${PUBLIC_ID}/zarr/index.json?v=abc123`);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=86400, stale-while-revalidate=86400",
    );
  });

  test("chunks are unchanged: 86400 regardless of tokening", async () => {
    const untokened = await request(CHUNK_PATH);
    expect(untokened.headers.get("cache-control")).toBe(
      "public, max-age=86400, stale-while-revalidate=86400",
    );
    const tokened = await request(`${CHUNK_PATH}?v=abc123`);
    expect(tokened.headers.get("cache-control")).toBe(
      "public, max-age=86400, stale-while-revalidate=86400",
    );
  });
});

describe("HEAD never touches the cache", () => {
  test("(h) HEAD is never cached and never puts", async () => {
    const head = await request(`/${PUBLIC_ID}/zarr/store.zarr/zarr.json`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(countUpstream(`${PUBLIC_ID}/zarr/store.zarr/zarr.json`, "")).toBe(1);

    // A GET for the same object afterwards is still a miss -- HEAD wrote
    // nothing to the cache.
    const get = await request(`/${PUBLIC_ID}/zarr/store.zarr/zarr.json`);
    expect(get.status).toBe(200);
    expect(countUpstream(`${PUBLIC_ID}/zarr/store.zarr/zarr.json`, "")).toBe(2);

    // And a second HEAD, after that GET primed a cache entry, still goes
    // upstream -- HEAD never reads the cache either.
    const head2 = await request(`/${PUBLIC_ID}/zarr/store.zarr/zarr.json`, { method: "HEAD" });
    expect(head2.status).toBe(200);
    expect(countUpstream(`${PUBLIC_ID}/zarr/store.zarr/zarr.json`, "")).toBe(3);
  });
});

describe("CORS reapplication on a cache hit (#1178)", () => {
  const ALLOWED = "https://nemar.org";
  const BLOCKED = "https://evil.example.org";

  test("(i) an allowed origin gets ACAO on a hit, a blocked one does not", async () => {
    const path = `/${PUBLIC_ID}/zarr/store.zarr/zarr.json`;
    // Prime the cache from the allowed origin.
    const primed = await request(path, { headers: { Origin: ALLOWED } });
    expect(primed.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(countUpstream(`${PUBLIC_ID}/zarr/store.zarr/zarr.json`, "")).toBe(1);

    // A blocked origin hits the SAME cache entry (Vary: Origin is not
    // honoured by the Cache API) but must not get the priming origin's ACAO.
    const blockedHit = await request(path, { headers: { Origin: BLOCKED } });
    expect(countUpstream(`${PUBLIC_ID}/zarr/store.zarr/zarr.json`, "")).toBe(1); // still a hit
    expect(blockedHit.headers.get("access-control-allow-origin")).toBeNull();

    // A subsequent allowed-origin request gets its ACAO back.
    const allowedHit = await request(path, { headers: { Origin: ALLOWED } });
    expect(countUpstream(`${PUBLIC_ID}/zarr/store.zarr/zarr.json`, "")).toBe(1); // still a hit
    expect(allowedHit.headers.get("access-control-allow-origin")).toBe(ALLOWED);
  });

  test("a range hit also gets CORS reapplied per requester", async () => {
    await request(CHUNK_PATH, { headers: { Range: "bytes=0-9", Origin: ALLOWED } });
    const blockedHit = await request(CHUNK_PATH, {
      headers: { Range: "bytes=0-9", Origin: BLOCKED },
    });
    expect(blockedHit.status).toBe(206);
    expect(blockedHit.headers.get("access-control-allow-origin")).toBeNull();
    expect(countUpstream(CHUNK_KEY, "bytes=0-9")).toBe(1);
  });
});

describe("404 caching (#1178 item 4)", () => {
  test("(j) missing-object 404 carries max-age=60 and is served from cache", async () => {
    const missing = `/${PUBLIC_ID}/zarr/nope.zarr/zarr.json`;
    const first = await request(missing);
    expect(first.status).toBe(404);
    expect(first.headers.get("cache-control")).toBe("public, max-age=60");
    expect(countUpstream(`${PUBLIC_ID}/zarr/nope.zarr/zarr.json`, "")).toBe(1);

    const second = await request(missing);
    expect(second.status).toBe(404);
    expect(second.headers.get("cache-control")).toBe("public, max-age=60");
    // Zero additional upstream hits -- served from the edge.
    expect(countUpstream(`${PUBLIC_ID}/zarr/nope.zarr/zarr.json`, "")).toBe(1);
  });

  test("(j) private dataset 404 is not cached", async () => {
    const path = `/${PRIVATE_ID}/zarr/store.zarr/zarr.json`;
    const first = await request(path);
    expect(first.status).toBe(404);
    expect(first.headers.get("cache-control")).toBe("public, max-age=60");
    // The D1 gate rejects before any upstream fetch.
    expect(countUpstream(`${PRIVATE_ID}/zarr/store.zarr/zarr.json`)).toBe(0);

    const second = await request(path);
    expect(second.status).toBe(404);
    // Still gated by D1 on every request -- never short-circuited by a
    // cached entry (the private dataset's visibility can flip).
    expect(countUpstream(`${PRIVATE_ID}/zarr/store.zarr/zarr.json`)).toBe(0);
  });

  test("bad-path 404 carries max-age=60 and is not cached", async () => {
    const first = await request(`/${PUBLIC_ID}/zarr/`);
    expect(first.status).toBe(404);
    expect(first.headers.get("cache-control")).toBe("public, max-age=60");
  });

  test("HEAD on a missing object is never cached", async () => {
    const missing = `/${PUBLIC_ID}/zarr/also-missing.zarr/zarr.json`;
    const head = await request(missing, { method: "HEAD" });
    expect(head.status).toBe(404);
    expect(countUpstream(`${PUBLIC_ID}/zarr/also-missing.zarr/zarr.json`, "")).toBe(1);

    const get = await request(missing);
    expect(get.status).toBe(404);
    // The HEAD did not populate the cache -- this GET still hits upstream.
    expect(countUpstream(`${PUBLIC_ID}/zarr/also-missing.zarr/zarr.json`, "")).toBe(2);
  });
});

describe("telemetry (#1178)", () => {
  test("(k) recordAccess is fire-and-forget with no ANALYTICS binding", async () => {
    // env.ANALYTICS is left undefined by testEnv() -- recordAccess() no-ops
    // in that case (see services/access-metrics.ts). This just proves the
    // route doesn't throw or block on it, for both a fresh fetch and a
    // cache hit.
    const fresh = await request(`/${PUBLIC_ID}/zarr/store.zarr/zarr.json`);
    expect(fresh.status).toBe(200);
    const hit = await request(`/${PUBLIC_ID}/zarr/store.zarr/zarr.json`);
    expect(hit.status).toBe(200);
  });
});
