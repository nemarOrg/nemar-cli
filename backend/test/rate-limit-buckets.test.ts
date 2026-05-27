/**
 * Rate limiter bucket-selection tests (issue #275).
 *
 * Covers two layers:
 *  1. `__selectBucket` — pure function that picks the bucket kind, raw
 *     key material, and cap. Hit every branch (auth path, token,
 *     IP-fallback).
 *  2. End-to-end through `rateLimiter` against a real Hono app, with a
 *     real in-memory Cache implementation (not a mock — a working
 *     Cache backed by Map that satisfies the shape we actually use).
 *     Verifies that an authenticated client can fire >100 requests
 *     without 429ing (the regression in #275: admins running batch
 *     publish-approves hit the per-IP 100/60s cap), and that an
 *     unauthenticated client still 429s at the IP cap.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  __limits,
  __readBearerTokenFromHeader,
  __selectBucket,
  rateLimiter,
} from "../src/middleware/rateLimit";
import type { Bindings, Variables } from "../src/types/bindings";

type AppEnv = { Bindings: Bindings; Variables: Variables };

// --------------------------------------------------------------------------
// Minimal in-memory Cache implementation — not a mock; this is a real
// Cache that stores Response objects against Request URLs. The rate
// limiter only uses `match`/`put` and the body is small, so we don't
// need to reproduce the full HTTP semantics.
// --------------------------------------------------------------------------

class InMemoryCache implements Cache {
  private store = new Map<string, { body: string; headers: Record<string, string>; expiresAt: number }>();

  // Injected clock so tests can advance time without real sleeps.
  // Defaults to the real wall clock.
  getNow: () => number = () => Date.now();

  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    const url = req instanceof Request ? req.url : String(req);
    const entry = this.store.get(url);
    if (!entry) return undefined;
    // Honour TTL: expired entries are invisible (matches CF Cache API behavior).
    if (this.getNow() >= entry.expiresAt) {
      this.store.delete(url);
      return undefined;
    }
    return new Response(entry.body, { headers: entry.headers });
  }

  async put(req: RequestInfo | URL, res: Response): Promise<void> {
    const url = req instanceof Request ? req.url : String(req);
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    // Parse Cache-Control: max-age=N to compute expiry using the injected clock.
    const cc = res.headers.get("Cache-Control") || "";
    const maxAgeMatch = cc.match(/max-age=(\d+)/);
    const maxAgeSec = maxAgeMatch ? Number.parseInt(maxAgeMatch[1], 10) : 60;
    this.store.set(url, { body, headers, expiresAt: this.getNow() + maxAgeSec * 1000 });
  }

  async add(): Promise<void> {
    throw new Error("not implemented");
  }
  async addAll(): Promise<void> {
    throw new Error("not implemented");
  }
  async delete(req: RequestInfo | URL): Promise<boolean> {
    const url = req instanceof Request ? req.url : String(req);
    return this.store.delete(url);
  }
  async keys(): Promise<readonly Request[]> {
    return Array.from(this.store.keys()).map((u) => new Request(u));
  }
  async matchAll(): Promise<readonly Response[]> {
    return [];
  }

  // Convenience used by tests to reset between runs.
  clear(): void {
    this.store.clear();
  }
}

const ourCache = new InMemoryCache();
let originalCaches: typeof caches | undefined;

// Cloudflare exposes a `caches.default` singleton. Bun has no `caches`
// global by default — install a real working in-memory implementation
// for the duration of this suite. Restored in `afterAll` so other
// suites that legitimately expect Bun's default state still see it.
beforeAll(() => {
  // biome-ignore lint/suspicious/noExplicitAny: test-only runtime patch
  originalCaches = (globalThis as any).caches;
  // biome-ignore lint/suspicious/noExplicitAny: test-only runtime patch
  (globalThis as any).caches = { default: ourCache } as unknown as CacheStorage;
});

afterAll(() => {
  // biome-ignore lint/suspicious/noExplicitAny: test-only runtime restore
  (globalThis as any).caches = originalCaches as CacheStorage;
});

beforeEach(() => {
  ourCache.clear();
});

// --------------------------------------------------------------------------
// __selectBucket — pure function
// --------------------------------------------------------------------------

const VALID_TOKEN = "a".repeat(48); // ≥32 chars, matches auth middleware floor
const VALID_TOKEN_2 = "b".repeat(48);
const SHORT_TOKEN = "a".repeat(10);

describe("__selectBucket", () => {
  test("auth-path requests bucket on IP regardless of bearer", () => {
    const sel = __selectBucket("/auth/login", `Bearer ${VALID_TOKEN}`, "10.0.0.1");
    expect(sel.keyKind).toBe("auth-ip");
    expect(sel.rawKey).toBe("10.0.0.1");
    expect(sel.maxRequests).toBe(__limits.AUTH_MAX_REQUESTS);
  });

  test("authenticated non-auth requests bucket on token with higher cap", () => {
    const sel = __selectBucket("/admin/publish/nm000110/approve", `Bearer ${VALID_TOKEN}`, "10.0.0.1");
    expect(sel.keyKind).toBe("token");
    expect(sel.rawKey).toBe(VALID_TOKEN);
    expect(sel.maxRequests).toBe(__limits.TOKEN_MAX_REQUESTS_AUTHED);
    expect(sel.maxRequests).toBeGreaterThan(__limits.MAX_REQUESTS);
  });

  test("unauthenticated requests bucket on IP with legacy cap", () => {
    const sel = __selectBucket("/datasets", undefined, "10.0.0.2");
    expect(sel.keyKind).toBe("ip");
    expect(sel.rawKey).toBe("10.0.0.2");
    expect(sel.maxRequests).toBe(__limits.MAX_REQUESTS);
  });

  test("malformed Authorization header falls through to IP bucket", () => {
    // The auth middleware rejects sub-32-char tokens. The rate limiter
    // must match that floor so a "Bearer abc" client can't trade up to
    // the higher authenticated cap.
    expect(__selectBucket("/datasets", `Bearer ${SHORT_TOKEN}`, "1.2.3.4").keyKind).toBe("ip");
    expect(__selectBucket("/datasets", "Bearer ", "1.2.3.4").keyKind).toBe("ip");
    expect(__selectBucket("/datasets", "Token abc", "1.2.3.4").keyKind).toBe("ip");
    expect(__selectBucket("/datasets", "", "1.2.3.4").keyKind).toBe("ip");
  });

  test("admin paths use the token bucket (not exempt)", () => {
    // Pre-#275 the middleware exempted /admin/* entirely. The new
    // behavior is "still bounded, just with a higher cap" — verify the
    // 500/60s cap actually applies rather than an exempt path being
    // silently re-introduced.
    const sel = __selectBucket("/admin/users", `Bearer ${VALID_TOKEN}`, "10.0.0.1");
    expect(sel.keyKind).toBe("token");
    expect(sel.maxRequests).toBe(__limits.TOKEN_MAX_REQUESTS_AUTHED);
  });
});

describe("__readBearerTokenFromHeader", () => {
  test("returns the token for a well-formed header", () => {
    expect(__readBearerTokenFromHeader(`Bearer ${VALID_TOKEN}`)).toBe(VALID_TOKEN);
  });

  test("returns null for missing/malformed/short headers", () => {
    expect(__readBearerTokenFromHeader(undefined)).toBeNull();
    expect(__readBearerTokenFromHeader("")).toBeNull();
    expect(__readBearerTokenFromHeader("Token abc")).toBeNull();
    expect(__readBearerTokenFromHeader(`Bearer ${SHORT_TOKEN}`)).toBeNull();
  });
});

// --------------------------------------------------------------------------
// End-to-end through the middleware
// --------------------------------------------------------------------------

function buildApp(env: Bindings): { app: Hono<AppEnv>; env: Bindings } {
  const app = new Hono<AppEnv>();
  app.use("*", rateLimiter);
  app.get("/datasets", (c) => c.json({ ok: true }));
  app.get("/admin/users", (c) => c.json({ ok: true }));
  return { app, env };
}

const PROD_ENV = {
  ENVIRONMENT: "production",
  API_BASE_URL: "http://localhost",
  FRONTEND_URL: "http://localhost",
  AWS_REGION: "us-east-2",
  S3_BUCKET: "nemar",
  DB: undefined as unknown as D1Database,
  GITHUB_ADMIN_PAT: "",
  AWS_ACCESS_KEY_ID: "",
  AWS_SECRET_ACCESS_KEY: "",
  RESEND_API_KEY: "",
  ZENODO_API_KEY: "",
  EZID_USERNAME: "",
  EZID_PASSWORD: "",
} satisfies Partial<Bindings> as unknown as Bindings;

async function hit(
  app: Hono<AppEnv>,
  env: Bindings,
  path: string,
  headers: Record<string, string>,
): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, { method: "GET", headers }), env);
}

describe("rateLimiter end-to-end", () => {
  test("authenticated client survives 150 requests (used to 429 at 100)", async () => {
    // Pre-#275: an admin running `publish approve` on a few datasets
    // back-to-back blew through the per-IP 100/60s cap and the resume
    // attempts then 429'd. After the fix, the same volume sits in the
    // 500/60s token bucket and goes through cleanly.
    const { app, env } = buildApp(PROD_ENV);
    const headers = {
      Authorization: `Bearer ${VALID_TOKEN}`,
      "CF-Connecting-IP": "10.99.0.1",
    };

    let okCount = 0;
    let rateLimitedCount = 0;
    for (let i = 0; i < 150; i++) {
      const res = await hit(app, env, "/admin/users", headers);
      if (res.status === 200) okCount++;
      else if (res.status === 429) rateLimitedCount++;
    }
    expect(okCount).toBe(150);
    expect(rateLimitedCount).toBe(0);
  });

  test("unauthenticated client still 429s once the IP cap is exhausted", async () => {
    const { app, env } = buildApp(PROD_ENV);
    const headers = { "CF-Connecting-IP": "10.99.0.2" };

    let okCount = 0;
    let rateLimitedCount = 0;
    // Loop the cap + a fixed overrun. Mirrors the authed-bucket test
    // pattern so the assertion stays correct when MAX_REQUESTS changes
    // (most recently 100 → 500 in #639).
    const total = __limits.MAX_REQUESTS + 25;
    for (let i = 0; i < total; i++) {
      const res = await hit(app, env, "/datasets", headers);
      if (res.status === 200) okCount++;
      else if (res.status === 429) rateLimitedCount++;
    }
    // The unauth cap is exactly MAX_REQUESTS — anything beyond should 429.
    expect(okCount).toBe(__limits.MAX_REQUESTS);
    expect(rateLimitedCount).toBe(25);
  });

  test("two authenticated clients on the same IP don't share a bucket", async () => {
    // The point of per-token bucketing: admin A's heavy orchestration
    // sweep does not consume admin B's quota even though they share an
    // egress IP (common when both admins run from the same office). 250
    // requests from each should both succeed (each under the 500 cap).
    const { app, env } = buildApp(PROD_ENV);
    const ip = "10.99.0.3";

    let aOk = 0;
    let bOk = 0;
    for (let i = 0; i < 250; i++) {
      const aRes = await hit(app, env, "/admin/users", {
        Authorization: `Bearer ${VALID_TOKEN}`,
        "CF-Connecting-IP": ip,
      });
      const bRes = await hit(app, env, "/admin/users", {
        Authorization: `Bearer ${VALID_TOKEN_2}`,
        "CF-Connecting-IP": ip,
      });
      if (aRes.status === 200) aOk++;
      if (bRes.status === 200) bOk++;
    }
    expect(aOk).toBe(250);
    expect(bOk).toBe(250);
  });

  test("a single authenticated client still 429s once its bucket is exhausted", async () => {
    // The cap exists to bound a malformed loop. Run past 500 and
    // confirm the next request 429s — the floor must not be silently
    // absent.
    const { app, env } = buildApp(PROD_ENV);
    const headers = {
      Authorization: `Bearer ${VALID_TOKEN}`,
      "CF-Connecting-IP": "10.99.0.4",
    };

    let okCount = 0;
    let rateLimitedCount = 0;
    const total = __limits.TOKEN_MAX_REQUESTS_AUTHED + 25;
    for (let i = 0; i < total; i++) {
      const res = await hit(app, env, "/admin/users", headers);
      if (res.status === 200) okCount++;
      else if (res.status === 429) rateLimitedCount++;
    }
    expect(okCount).toBe(__limits.TOKEN_MAX_REQUESTS_AUTHED);
    expect(rateLimitedCount).toBe(25);
  });

  test("429 response exposes the X-RateLimit-Bucket header", async () => {
    const { app, env } = buildApp(PROD_ENV);
    const headers = { "CF-Connecting-IP": "10.99.0.5" };

    // Exhaust the unauth bucket
    for (let i = 0; i < __limits.MAX_REQUESTS; i++) {
      await hit(app, env, "/datasets", headers);
    }
    const res = await hit(app, env, "/datasets", headers);
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("ip");
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(__limits.MAX_REQUESTS));
  });

  test("development environment bypasses rate limiting entirely", async () => {
    // Sanity check: the dev-skip branch is intact after the bucket
    // refactor.
    const devEnv = { ...PROD_ENV, ENVIRONMENT: "development" } as Bindings;
    const { app, env } = buildApp(devEnv);
    const headers = { "CF-Connecting-IP": "10.99.0.6" };

    for (let i = 0; i < 200; i++) {
      const res = await hit(app, env, "/datasets", headers);
      expect(res.status).toBe(200);
    }
  });

  test("bucket resets after the TTL window expires", async () => {
    // Exercise the window-expiry path: exhaust the IP bucket, advance
    // the injected clock past WINDOW_SIZE seconds so cached entries are
    // treated as expired, then confirm the client gets a fresh quota.
    // This covers the TTL/window-reset code path that `beforeEach` clears
    // globally but never exercises within a single window.
    let fakeNow = Date.now();
    ourCache.getNow = () => fakeNow;

    const { app, env } = buildApp(PROD_ENV);
    const headers = { "CF-Connecting-IP": "10.99.0.7" };

    // Exhaust the unauthenticated IP bucket.
    for (let i = 0; i < __limits.MAX_REQUESTS; i++) {
      const res = await hit(app, env, "/datasets", headers);
      expect(res.status).toBe(200);
    }
    // Next request must be rate-limited.
    expect((await hit(app, env, "/datasets", headers)).status).toBe(429);

    // Advance the clock past the 60s window so all cache entries expire.
    fakeNow += (__limits.WINDOW_SIZE + 1) * 1000;

    // The bucket is now expired; the client should get a fresh quota.
    const resetRes = await hit(app, env, "/datasets", headers);
    expect(resetRes.status).toBe(200);

    // Restore the real clock for subsequent tests.
    ourCache.getNow = () => Date.now();
  });
});
