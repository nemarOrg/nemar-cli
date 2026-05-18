/**
 * Unit tests for the bucket-selector portion of the rate-limit middleware.
 * The admin bypass itself depends on D1 + caches.default and is covered by
 * post-deploy assertion (an admin token must succeed at >500/60s and a
 * non-admin token must 429 at the 501st call); structural tests here pin
 * the selector logic that decides which bucket a request lands in.
 */

import { describe, expect, test } from "bun:test";
import {
  __readBearerTokenFromHeader,
  __selectBucket,
} from "../backend/src/middleware/rateLimit";

const VALID_TOKEN = "n".repeat(40);

describe("__readBearerTokenFromHeader", () => {
  test("returns the token when prefix + length are valid", () => {
    expect(__readBearerTokenFromHeader(`Bearer ${VALID_TOKEN}`)).toBe(VALID_TOKEN);
  });

  test("returns null for missing header / wrong scheme / too short", () => {
    expect(__readBearerTokenFromHeader(undefined)).toBeNull();
    expect(__readBearerTokenFromHeader("Basic abc")).toBeNull();
    expect(__readBearerTokenFromHeader("Bearer ")).toBeNull();
    expect(__readBearerTokenFromHeader("Bearer abc")).toBeNull();
    expect(__readBearerTokenFromHeader("Bearer 0123456789")).toBeNull();
  });
});

describe("__selectBucket", () => {
  test("auth endpoints use the stricter ip-keyed bucket regardless of bearer", () => {
    const r = __selectBucket("/auth/login", `Bearer ${VALID_TOKEN}`, "1.2.3.4");
    expect(r.keyKind).toBe("auth-ip");
    expect(r.maxRequests).toBe(10);
    expect(r.rawKey).toBe("1.2.3.4");
  });

  test("authenticated non-auth endpoints get the token bucket at 500/60s", () => {
    const r = __selectBucket("/datasets", `Bearer ${VALID_TOKEN}`, "1.2.3.4");
    expect(r.keyKind).toBe("token");
    expect(r.maxRequests).toBe(500);
    expect(r.rawKey).toBe(VALID_TOKEN);
  });

  test("unauthenticated non-auth endpoints fall back to the ip bucket at 100/60s", () => {
    const r = __selectBucket("/datasets", undefined, "1.2.3.4");
    expect(r.keyKind).toBe("ip");
    expect(r.maxRequests).toBe(100);
    expect(r.rawKey).toBe("1.2.3.4");
  });

  test("syntactically-bad bearer falls through to ip bucket (no false escalation)", () => {
    const r = __selectBucket("/admin/datasets", "Bearer short", "1.2.3.4");
    expect(r.keyKind).toBe("ip");
    expect(r.maxRequests).toBe(100);
  });
});
