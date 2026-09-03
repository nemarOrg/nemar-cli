/**
 * Route tests for `GET /catalog.json` on the zarr.nemar.org data plane
 * (issue #1062, epic #1181 phase 2 -- moved inside `createZarrDataRoutes(deps)`
 * once phase 1, #1199, merged into the epic branch; PR #1201 review,
 * deferred item).
 *
 * Real engines throughout, matching zarr-data-cache.test.ts's harness:
 *  - Upstream S3 is a real `Bun.serve()` on an ephemeral port, standing in
 *    via `deps.s3Base` -- the SAME test seam `serve()`'s own tests use.
 *    `fetchZarrCatalogObject`'s signed request still targets `s3Base` when
 *    set (aws4fetch's Authorization/X-Amz-* headers ride along; the
 *    receiver never validates them, exactly like backend/test/zarr-catalog.test.ts's
 *    own PUT/GET receiver tests).
 *  - The edge cache is a real in-memory `CacheLike`.
 *  - D1 is bun:sqlite behind a COUNTING wrapper around `realD1()` (every
 *    migration applied, though nothing is seeded -- this route never reads
 *    a dataset row): `.prepare()` calls are counted so "no D1 query on this
 *    route" is proven directly, not assumed from reading the source.
 *  - The route is driven through the real Hono app `createZarrDataRoutes()`
 *    returns, via `app.request()`, exactly as index.ts drives it in
 *    production.
 *
 * `ENVIRONMENT: "development"` is set only because it is rateLimiter's own
 * documented bypass (mounted on every request by createZarrDataRoutes) --
 * without it, rateLimiter's non-dev path reads the real `caches.default`
 * global, which does not exist under bun:test. It has nothing to do with
 * the catalog route itself.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import type { Hono } from "hono";
import { type CacheLike, type ZarrDataDeps, createZarrDataRoutes } from "../src/routes/zarr-data";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const CATALOG_JSON = JSON.stringify({
  format: "nemar-zarr-catalog",
  format_version: 1,
  generated_utc: "2026-09-02T00:00:00.000Z",
  contract_base: "https://zarr.nemar.org/",
  count: 1,
  datasets: [{ dataset_id: "on007763" }],
});

// ---------------------------------------------------------------------------
// Real in-memory CacheLike (mirrors zarr-data-cache.test.ts's own).
// ---------------------------------------------------------------------------

class InMemoryCache implements CacheLike {
  private store = new Map<string, Response>();

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    return this.store.get(keyFor(request))?.clone();
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.store.set(keyFor(request), response.clone());
  }
}

function keyFor(request: RequestInfo | URL): string {
  return request instanceof Request ? request.url : String(request);
}

// ---------------------------------------------------------------------------
// Real upstream: Bun.serve() standing in for S3's zarr-catalog.json object.
// ---------------------------------------------------------------------------

let upstream: Server;
let nextStatus: number;
let upstreamRequests: number;

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch(req) {
      upstreamRequests++;
      if (new URL(req.url).pathname !== "/zarr-catalog.json") {
        return new Response(null, { status: 404 });
      }
      if (nextStatus === 200) {
        return new Response(CATALOG_JSON, {
          status: 200,
          headers: { "Content-Type": "application/json", ETag: '"cat-etag"' },
        });
      }
      return new Response(nextStatus === 500 ? "boom" : "", { status: nextStatus });
    },
  });
});

afterAll(() => {
  upstream.stop(true);
});

// ---------------------------------------------------------------------------
// D1: a counting wrapper, so "zero D1 queries" is proven, not assumed.
// ---------------------------------------------------------------------------

let db: Database;
let prepareCount: number;

function countingD1(target: Database): D1Database {
  const base = realD1(target);
  return {
    ...base,
    prepare(sql: string) {
      prepareCount++;
      return base.prepare(sql);
    },
  } as D1Database;
}

let cache: InMemoryCache;
let app: Hono<{ Bindings: Bindings }>;

function testEnv(): Bindings {
  return {
    DB: countingD1(db),
    ENVIRONMENT: "development",
    AWS_REGION: "us-east-2",
    S3_BUCKET: "unused-in-tests",
    AWS_ACCESS_KEY_ID: "AKIATEST",
    AWS_SECRET_ACCESS_KEY: "secret",
  } as unknown as Bindings;
}

function testDeps(overrides: Partial<ZarrDataDeps> = {}): ZarrDataDeps {
  return {
    cache: () => cache,
    fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
    s3Base: `http://localhost:${upstream.port}`,
    ...overrides,
  };
}

/** Mirrors zarr-data-cache.test.ts's requestWith: flushes every promise
 *  handed to executionCtx.waitUntil (the cache.put() call) before
 *  returning, so a following request in the same test sees a settled
 *  cache state -- matches the real Workers runtime's own guarantee. */
async function requestCatalog(
  init: RequestInit = {},
  targetApp: Hono<{ Bindings: Bindings }> = app,
  env: Bindings = testEnv(),
): Promise<Response> {
  const waited: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waited.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const res = await targetApp.request("/catalog.json", init, env, ctx);
  await Promise.allSettled(waited);
  return res;
}

beforeEach(() => {
  db = freshDb();
  cache = new InMemoryCache();
  app = createZarrDataRoutes(testDeps());
  nextStatus = 200;
  upstreamRequests = 0;
  prepareCount = 0;
});

describe("GET /catalog.json: success, miss then hit", () => {
  test("a cache MISS fetches from S3 and returns 200 with CORS + Cache-Control", async () => {
    const res = await requestCatalog({ headers: { origin: "https://nemar.org" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CATALOG_JSON);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://nemar.org");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=3600, stale-while-revalidate=3600",
    );
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("ETag")).toBe('"cat-etag"');
    expect(upstreamRequests).toBe(1);
  });

  test("a cache HIT does not re-fetch from S3, and still returns 200 with CORS + Cache-Control", async () => {
    await requestCatalog({ headers: { origin: "https://nemar.org" } });
    expect(upstreamRequests).toBe(1);

    const res = await requestCatalog({ headers: { origin: "https://nemar.org" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CATALOG_JSON);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://nemar.org");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=3600, stale-while-revalidate=3600",
    );
    // The whole point: no second upstream hit.
    expect(upstreamRequests).toBe(1);
  });

  test("CORS is re-applied per REQUESTING origin on a hit, not the priming origin's", async () => {
    await requestCatalog({ headers: { origin: "https://nemar.org" } });
    const res = await requestCatalog({ headers: { origin: "https://zarr-test.nemar.org" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://zarr-test.nemar.org");
  });

  test("an origin outside the allowlist gets no Access-Control-Allow-Origin, on miss or hit", async () => {
    const missRes = await requestCatalog({ headers: { origin: "https://evil.example" } });
    expect(missRes.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const hitRes = await requestCatalog({ headers: { origin: "https://evil.example" } });
    expect(hitRes.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("no D1 query is ever made for this route -- miss and hit both", async () => {
    await requestCatalog();
    await requestCatalog();
    expect(prepareCount).toBe(0);
  });

  test("no Origin is still proxied, never redirected -- catalog.json can never match the zarr redirect path shape (#1181 phase 6 review item 7)", async () => {
    // Unlike a store object under /<id>/zarr/, this route has no
    // <id>/zarr/ segment at all, so isRedirectCandidate's path regex can
    // never match it -- there is no Origin-dependent fork here, only the
    // one path serveCatalog() implements.
    const res = await requestCatalog();
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(upstreamRequests).toBe(1);
  });
});

describe("GET /catalog.json: absence and failure", () => {
  test("404 when not yet published (a genuine absence)", async () => {
    nextStatus = 404;
    const res = await requestCatalog();
    expect(res.status).toBe(404);
  });

  test("503 when S3 answers 403 -- forbidden, distinct from the 404 absence case", async () => {
    nextStatus = 403;
    const res = await requestCatalog();
    expect(res.status).toBe(503);
  });

  test("502 on a non-2xx/403/404 upstream response (an infra failure surfaced as a thrown Error)", async () => {
    nextStatus = 500;
    const res = await requestCatalog();
    expect(res.status).toBe(502);
  });

  test("502 on a literal fetch() throw (a network failure, not just a bad status)", async () => {
    const throwingApp = createZarrDataRoutes(
      testDeps({
        fetch: (() => {
          throw new Error("simulated network failure");
        }) as unknown as typeof fetch,
      }),
    );
    const res = await requestCatalog({}, throwingApp);
    expect(res.status).toBe(502);
  });

  test("neither the 404, 503, nor 502 path ever queries D1", async () => {
    for (const status of [404, 403, 500]) {
      nextStatus = status;
      await requestCatalog();
    }
    expect(prepareCount).toBe(0);
  });

  test("a 404/503/502 response is never cached (the next request re-hits the upstream)", async () => {
    nextStatus = 404;
    await requestCatalog();
    expect(upstreamRequests).toBe(1);
    await requestCatalog();
    expect(upstreamRequests).toBe(2);
  });
});
