/**
 * Rate limiting middleware using Cloudflare Cache API
 *
 * Uses Cache API instead of KV to avoid daily operation limits.
 * Cache API has no daily limits and is designed for this use case.
 */

import type { Context, Next } from "hono";
import type { Bindings, Variables } from "../types/bindings";

// Rate limit configuration
const WINDOW_SIZE = 60; // seconds
const MAX_REQUESTS = 100; // requests per window

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

  // Get client identifier (IP or authenticated user)
  const ip = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || "unknown";
  const path = c.req.path;

  // Skip rate limiting for admin endpoints. These are already protected by
  // authMiddleware + adminMiddleware (API key + admin role). Rate limiting
  // would break multi-request orchestration like S3 lock pagination, which
  // can require 100+ sequential API calls for large datasets.
  // Within the Hono sub-app, c.req.path is relative to the mount point,
  // so admin routes appear as "/admin/..." regardless of the app prefix.
  if (path.startsWith("/admin")) {
    await next();
    return;
  }

  // Use stricter limits for auth endpoints
  const isAuthEndpoint = AUTH_PATHS.some((p) => path.startsWith(p));
  const maxRequests = isAuthEndpoint ? AUTH_MAX_REQUESTS : MAX_REQUESTS;

  // Create rate limit key
  const keyPrefix = isAuthEndpoint ? "rl:auth:" : "rl:";
  const cacheKey = new Request(`https://rate-limit.internal/${keyPrefix}${ip}`);

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
  } catch (error) {
    // If cache fails, log but don't block the request
    console.error("Rate limit cache error:", error);
  }

  await next();
}
