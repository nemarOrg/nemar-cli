/**
 * Rate limiting middleware using Cloudflare Cache API
 *
 * Uses Cache API instead of KV to avoid daily operation limits.
 * Cache API has no daily limits and is designed for this use case.
 *
 * Bucket policy:
 *   - Unauthenticated requests are keyed by IP and capped at 100/60s
 *     (`MAX_REQUESTS`).
 *   - Authenticated requests are keyed by the SHA-256 hash of the
 *     bearer token and capped at 500/60s (`TOKEN_MAX_REQUESTS_AUTHED`).
 *     This is the fix for #275: admin orchestration that fans out into
 *     many sequential backend calls (publication approve, CI deploy
 *     loops) used to drown out the per-IP bucket every time several
 *     datasets shipped in quick succession. Per-token bucketing means
 *     one admin's batch can't starve another admin's quota, and the
 *     500/60s cap still bounds a malformed loop hammering the worker.
 *   - Auth endpoints (the explicit set in `AUTH_PATHS`) keep their
 *     stricter 10/60s cap and stay keyed by IP — those run pre-auth so
 *     a token isn't available, and they need to resist password
 *     guessing across IPs without any single bucket being unbounded.
 */

import type { Context, Next } from "hono";
import { hashApiKey } from "../services/token";
import type { Bindings, Variables } from "../types/bindings";

// Rate limit configuration
const WINDOW_SIZE = 60; // seconds
// Unauthenticated bucket. The website's SSR fetches GET endpoints from
// inside a Cloudflare Worker (@astrojs/cloudflare); those requests share a
// small pool of CF egress IPs, so a handful of concurrent visitors of
// ww2.nemar.org are bucketed as one client by the per-IP keyer and trip
// the cap. This middleware is the secondary floor against runaway loops;
// if Cloudflare bot management is enabled at the zone level it is the
// primary control against abuse. Bumped 100 → 500 in #639 along with
// adding Cache-Control to the three dataset GET endpoints (which is the
// real architectural fix; this cap raise is defense-in-depth).
const MAX_REQUESTS = 500;
// Authenticated bucket. Originally sized for the heaviest single admin
// orchestration: `nemar admin publish approve` on a 6500-object dataset
// makes ~65 sequential CLI→Worker HTTP calls (one batch per ~100-object
// page) plus the surrounding orchestrator steps — call it ~165 total
// requests counting orchestrator overhead. (Each Worker invocation
// itself fans out internally to ~120 sub-fetches against S3/D1; that's
// a separate budget governed by CF's per-invocation subrequest cap and
// is unrelated to this token-bucket count.) 1000/60s gives ~6× headroom
// over the heaviest single approve and comfortably absorbs back-to-back
// queues across multiple admins / multiple datasets. Bumped 500 → 1000
// in #639. Not exposed as configuration — the appropriate number lives
// in code review, not at runtime.
const TOKEN_MAX_REQUESTS_AUTHED = 1000;

// Public read data-plane bucket (`data.nemar.org/*`, which the host fork in
// index.ts rewrites to `/data/*`; also reachable as `/nemar/data/*`). These
// endpoints are read-only, anonymous, CDN-cacheable, and never stream bytes
// through the Worker — the per-file route 302-redirects to a presigned S3 URL
// or raw.githubusercontent.com, so the actual download egress is on S3/GitHub,
// not here. A parallel client (e.g. `nemar-py --jobs 16` on its HTTPS backend,
// or `rclone`) legitimately bursts hundreds of per-file 302s for one dataset
// and was tripping the 500/60s anonymous IP floor (#615 follow-up; Bruno's
// `data.nemar.org` 429 reports). Give the data plane its own much larger
// IP-keyed bucket so a real downloader runs unthrottled while a runaway loop
// is still bounded (a scraper can't make unbounded Worker invocations), and so
// data-plane traffic and the write/management API can't starve each other —
// the same isolation rationale as the per-token bucket in #275.
const DATA_MAX_REQUESTS = 10000;
// Matches the data sub-app mount: `/data`, `/data/...`, and the `/nemar`
// path-mount forms. Deliberately anchored with `(\/|$)` so it does NOT match
// the management API at `/datasets/*` (that keeps the standard ip/token cap).
const DATA_PATH_RE = /^\/(nemar\/)?data(\/|$)/;
// The zarr serving gateway (#901), the highest-request-volume data-plane path,
// which bypassed the middleware stack and went unthrottled. Two reachable path
// shapes, because Hono's `app.route("/zarrproxy", zarrDataRoutes)` PREPENDS the
// prefix (it does not strip it before dispatch):
//   - `/<id>/zarr/...`          — the zarr.nemar.org host fork (zarrDataRoutes.fetch)
//   - `/zarrproxy/<id>/zarr/...` — the path mount, reachable on api.nemar.org and
//     the workers.dev fallback. `c.req.path` keeps the /zarrproxy prefix here.
// Match both so neither entry point is mis-bucketed to the tighter ip cap.
const ZARR_PATH_RE = /^(?:\/zarrproxy)?\/[a-z]{2}\d+\/zarr(\/|$)/;

// Stricter limits for auth endpoints
const AUTH_MAX_REQUESTS = 10;
const AUTH_PATHS = [
  "/auth/signup",
  "/auth/login",
  "/auth/verify",
  "/auth/retrieve-key",
  "/auth/request-key-regeneration",
  "/auth/confirm-key-regeneration",
  // Web-dashboard passwordless flow (#569). The route handler also
  // enforces a per-email rate limit (1/min, 5/hour) — the per-IP cap
  // here is the outer floor against flooding from a single network.
  // /auth/me is intentionally NOT in this list: the dashboard polls
  // it on every navigation and should hit the standard token/IP
  // bucket, not the stricter auth bucket.
  "/auth/code/request",
  "/auth/code/verify",
  "/auth/logout",
];

type RateLimitContext = Context<{ Bindings: Bindings; Variables: Variables }>;

/**
 * Read a syntactically-plausible bearer token from the request, without
 * touching the database. Returns `null` for missing/malformed headers —
 * those fall through to the IP bucket. The auth middleware later runs
 * a real validation against D1; this lookup is only used to pick a
 * stable bucket key for a *plausible* authenticated request. Even if
 * the token turns out to be invalid in the auth middleware (and the
 * request 401s), bucketing it separately from the per-IP pool means a
 * single bad client can't blow through the unauthenticated cap on
 * shared egress IPs.
 *
 * Exported (with the `__` test-only prefix) for the focused unit test
 * in `test/rate-limit-buckets.test.ts`.
 */
export function __readBearerTokenFromHeader(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.substring(7);
  // The auth middleware enforces `length >= 32`. Mirror that here so
  // a 3-char "Bearer abc" attempt doesn't get the higher authenticated
  // cap.
  if (!token || token.length < 32) return null;
  return token;
}

/**
 * Bucket selection — the core of the #275 fix. Pure function of the
 * request shape so the test suite can exercise every branch without
 * standing up a Cloudflare runtime. Returns the bucket key kind, the
 * raw key value, and the cap.
 *
 *  - `auth-ip` for `/auth/*` endpoints (10/60s, IP-keyed). Stays
 *    pre-auth-friendly: signup/login don't have a token yet.
 *  - `token` for any request carrying a syntactically-valid bearer
 *    (500/60s). Admin orchestration (`publish approve`, CI deploy
 *    sweeps) fits here; per-token bucketing means one admin's batch
 *    can't 429 another admin's batch through the shared IP pool.
 *  - `data-ip` for the public read data plane (`/data/*`, `/nemar/data/*`).
 *    10000/60s, IP-keyed. Checked before the bearer branch because the data
 *    plane is anonymous-by-design; a tokened request to a public file is
 *    still charged to the (generous) IP bucket, not the tighter token bucket.
 *  - `ip` for everything else (the unauthenticated cap).
 *
 * Admin endpoints used to be entirely exempt; that gave an admin
 * running a malformed loop unbounded access to the worker. Keeping the
 * limit but raising the cap for authenticated buckets preserves the
 * floor without the floor being absent.
 */
export interface __BucketSelection {
  keyKind: "auth-ip" | "ip" | "token" | "data-ip";
  /** Pre-hash key material: the IP, or the raw bearer token. */
  rawKey: string;
  maxRequests: number;
}

export function __selectBucket(
  path: string,
  authHeader: string | undefined,
  ip: string,
): __BucketSelection {
  if (AUTH_PATHS.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`))) {
    return { keyKind: "auth-ip", rawKey: ip, maxRequests: AUTH_MAX_REQUESTS };
  }
  // Public read data plane gets its own generous IP bucket before the bearer
  // check: it is anonymous-by-design (no token), and even a tokened request to
  // a public file should not be charged against the tighter token bucket.
  if (DATA_PATH_RE.test(path) || ZARR_PATH_RE.test(path)) {
    return { keyKind: "data-ip", rawKey: ip, maxRequests: DATA_MAX_REQUESTS };
  }
  const bearer = __readBearerTokenFromHeader(authHeader);
  if (bearer) {
    return { keyKind: "token", rawKey: bearer, maxRequests: TOKEN_MAX_REQUESTS_AUTHED };
  }
  return { keyKind: "ip", rawKey: ip, maxRequests: MAX_REQUESTS };
}

/**
 * Rate limiting middleware
 *
 * - Disabled in development environment
 * - Uses Cache API in production (no KV daily limits)
 * - Supports test bypass for CI/CD
 */
/**
 * Cached lookup: does this token belong to an admin or owner user?
 *
 * Bulk admin orchestration (`nemar admin reindex --missing-metadata`,
 * release sweeps, mass-publish) routinely fans out beyond the 500/60s
 * token bucket. Capping admins at the same per-token bucket as any other
 * authenticated user makes those operations brittle and forces operators
 * to add manual pacing.
 *
 * The lookup hits D1 once per token-and-window: results are memoized in
 * caches.default for the rate-limit window (60s), so the hot path stays
 * O(1) cache lookup. Cache misses fall through to a D1 SELECT joining
 * tokens -> users. Failures (cache outage, D1 error) return false so we
 * never accidentally grant unlimited quota.
 */
async function isPrivilegedToken(env: Bindings, hashedApiKey: string): Promise<boolean> {
  const cacheKey = new Request(`https://rate-limit.internal/admin-flag:${hashedApiKey}`);
  try {
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const data = (await cached.json()) as { admin: boolean };
      return data.admin === true;
    }
    const row = await env.DB.prepare(
      `SELECT u.role FROM tokens t JOIN users u ON t.user_id = u.id
       WHERE t.api_key_hash = ?
         AND t.revoked_at IS NULL
         AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))
         AND u.status = 'approved'
         AND u.deleted_at IS NULL`,
    )
      .bind(hashedApiKey)
      .first<{ role: string | null }>();
    const admin = row?.role === "admin" || row?.role === "owner";
    const ttl = admin ? WINDOW_SIZE : Math.min(WINDOW_SIZE, 30);
    await cache.put(
      cacheKey,
      new Response(JSON.stringify({ admin }), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `max-age=${ttl}`,
        },
      }),
    );
    return admin;
  } catch (err) {
    console.warn(`[rate-limit] admin-flag lookup failed: ${(err as Error).message ?? err}`);
    return false;
  }
}

export async function rateLimiter(c: RateLimitContext, next: Next) {
  // Skip rate limiting in development
  if (c.env.ENVIRONMENT === "development") {
    await next();
    return;
  }

  // Check for test bypass header (for CI/CD and integration tests)
  const testBypassToken = c.req.header("X-Test-Bypass");
  if (testBypassToken && c.env.TEST_BYPASS_TOKEN && testBypassToken === c.env.TEST_BYPASS_TOKEN) {
    await next();
    return;
  }

  const path = c.req.path;
  // Fall back to a random UUID instead of the shared "unknown" sentinel
  // so headerless requests each get their own bucket rather than pooling.
  const ip =
    c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || crypto.randomUUID();

  const { keyKind, rawKey, maxRequests } = __selectBucket(path, c.req.header("Authorization"), ip);

  // Token buckets hash the raw bearer; the auth middleware later
  // re-hashes the same value to look the user up in D1. IP buckets use
  // the raw IP as the bucket key directly — no hashing needed.
  const bucketKeyValue = keyKind === "token" ? await hashApiKey(rawKey) : rawKey;

  // Admin / owner tokens bypass the app-side limiter entirely. Bulk
  // operations (mass reindex, release sweeps) routinely exceed the
  // 500/60s token bucket; capping them produced opaque "Network error"
  // failures in the CLI because requests dropped after the local
  // limiter 429d. The CF-edge layer still enforces its own per-IP
  // ceilings, so the floor isn't absent.
  if (keyKind === "token" && (await isPrivilegedToken(c.env, bucketKeyValue))) {
    c.header("X-RateLimit-Bucket", "admin-bypass");
    await next();
    return;
  }

  // Cache API key. The URL just needs to be a unique, stable string —
  // we never actually `fetch()` it; it's a placeholder identity for
  // the cache entry. Each kind gets its own prefix so a token bucket
  // and an IP bucket can't collide on the same key material.
  const cacheKey = new Request(`https://rate-limit.internal/rl:${keyKind}:${bucketKeyValue}`);

  try {
    const cache = caches.default;

    // Get current count from cache
    const cached = await cache.match(cacheKey);
    let count = 0;

    if (cached) {
      const data = (await cached.json()) as { count: number };
      count = data.count;
    }

    if (count >= maxRequests) {
      // Calculate retry-after (approximate)
      const retryAfter = WINDOW_SIZE;

      return c.json(
        {
          error: "Rate limit exceeded",
          message: `Too many requests. Please try again in ${retryAfter} seconds.`,
          retry_after: retryAfter,
        },
        429,
        {
          "Retry-After": retryAfter.toString(),
          "X-RateLimit-Limit": maxRequests.toString(),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": (Math.floor(Date.now() / 1000) + retryAfter).toString(),
          "X-RateLimit-Bucket": keyKind,
        },
      );
    }

    // Increment counter and store in cache with TTL
    const newCount = count + 1;
    const response = new Response(JSON.stringify({ count: newCount }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `max-age=${WINDOW_SIZE}`,
      },
    });
    await cache.put(cacheKey, response);

    // Add rate limit headers to response
    c.header("X-RateLimit-Limit", maxRequests.toString());
    c.header("X-RateLimit-Remaining", (maxRequests - newCount).toString());
    c.header("X-RateLimit-Bucket", keyKind);
  } catch (error) {
    // Fail open so a cache outage doesn't block all traffic, but emit a
    // structured log so Workers tail / log tooling surfaces the issue.
    // TODO(#478): replace with Sentry captureException once DSN is wired.
    console.error("[rate-limit] cache failure", {
      route: path,
      keyKind,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await next();
}

// Internal limits exposed for the focused unit test in
// `test/rate-limit-buckets.test.ts`. Prefixed with `__` so static
// analysis flags any production code that tries to import them.
export const __limits = {
  AUTH_MAX_REQUESTS,
  TOKEN_MAX_REQUESTS_AUTHED,
  MAX_REQUESTS,
  DATA_MAX_REQUESTS,
  WINDOW_SIZE,
};
