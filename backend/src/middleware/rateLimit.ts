/**
 * Rate limiting middleware using Cloudflare KV
 *
 * Implements a simple sliding window rate limiter.
 */

import type { Context, Next } from "hono";
import type { Bindings, Variables } from "../types/bindings";

// Rate limit configuration
const WINDOW_SIZE = 60; // seconds
const MAX_REQUESTS = 100; // requests per window

// Stricter limits for auth endpoints
const AUTH_MAX_REQUESTS = 10;
const AUTH_PATHS = ["/auth/signup", "/auth/login", "/auth/verify"];

type RateLimitContext = Context<{ Bindings: Bindings; Variables: Variables }>;

/**
 * Rate limiting middleware
 *
 * Uses Cloudflare KV with TTL for automatic expiration.
 */
export async function rateLimiter(c: RateLimitContext, next: Next) {
  // Check for test bypass header (for CI/CD and integration tests)
  const testBypassToken = c.req.header("X-Test-Bypass");
  if (testBypassToken && c.env.TEST_BYPASS_TOKEN && testBypassToken === c.env.TEST_BYPASS_TOKEN) {
    await next();
    return;
  }

  const kv = c.env.RATE_LIMIT_KV;

  // Get client identifier (IP or authenticated user)
  const ip = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || "unknown";
  const path = c.req.path;

  // Use stricter limits for auth endpoints
  const isAuthEndpoint = AUTH_PATHS.some((p) => path.startsWith(p));
  const maxRequests = isAuthEndpoint ? AUTH_MAX_REQUESTS : MAX_REQUESTS;

  // Create rate limit key
  const keyPrefix = isAuthEndpoint ? "rl:auth:" : "rl:";
  const key = `${keyPrefix}${ip}`;

  try {
    // Get current count
    const current = await kv.get(key);
    const count = current ? parseInt(current, 10) : 0;

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
        }
      );
    }

    // Increment counter with TTL
    await kv.put(key, (count + 1).toString(), {
      expirationTtl: WINDOW_SIZE,
    });

    // Add rate limit headers to response
    c.header("X-RateLimit-Limit", maxRequests.toString());
    c.header("X-RateLimit-Remaining", (maxRequests - count - 1).toString());
  } catch (error) {
    // If KV fails, log but don't block the request
    console.error("Rate limit KV error:", error);
  }

  await next();
}
