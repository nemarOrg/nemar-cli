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
const MAX_REQUESTS = 100; // unauthenticated, per IP
// Authenticated bucket. Sized for the worst orchestration we actually
// see in practice: `nemar admin publish approve` on a 6500-object
// dataset reaches ~165 sequential subrequests (1 LIST + 100 PUTs per
// page × ~65 pages) plus the surrounding orchestrator steps; doing
// that back-to-back across a handful of datasets in a sweep used to
// 429 the rate limiter within seconds. 500/60s gives a ~3× headroom
// over the heaviest single approve, comfortably fits a small back-to-back
// queue of admin operations, and still 429s on a runaway loop (which is
// the floor the limiter exists to provide). Not exposed as configuration
// — the appropriate number lives in code review, not at runtime.
const TOKEN_MAX_REQUESTS_AUTHED = 500;

// Stricter limits for auth endpoints
const AUTH_MAX_REQUESTS = 10;
const AUTH_PATHS = [
  "/auth/signup",
  "/auth/login",
  "/auth/verify",
  "/auth/retrieve-key",
  "/auth/request-key-regeneration",
  "/auth/confirm-key-regeneration",
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
 *  - `ip` for everything else (100/60s, the legacy cap).
 *
 * Admin endpoints used to be entirely exempt; that gave an admin
 * running a malformed loop unbounded access to the worker. Keeping the
 * limit but raising the cap for authenticated buckets preserves the
 * floor without the floor being absent.
 */
export interface __BucketSelection {
  keyKind: "auth-ip" | "ip" | "token";
  /** Pre-hash key material: the IP, or the raw bearer token. */
  rawKey: string;
  maxRequests: number;
}

export function __selectBucket(
  path: string,
  authHeader: string | undefined,
  ip: string,
): __BucketSelection {
  if (AUTH_PATHS.some((p) => path === p || path.startsWith(p + "/") || path.startsWith(p + "?"))) {
    return { keyKind: "auth-ip", rawKey: ip, maxRequests: AUTH_MAX_REQUESTS };
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
  WINDOW_SIZE,
};
