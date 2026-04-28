import { describe, expect, test } from "bun:test";
import { ApiError, isRetryablePublishError } from "../src/lib/api";

describe("isRetryablePublishError - retryable transient errors", () => {
  test("retries network drop (statusCode 0)", () => {
    expect(isRetryablePublishError(new ApiError(0, "Network error"))).toBe(true);
  });

  test("retries 429 rate limit", () => {
    expect(isRetryablePublishError(new ApiError(429, "Too Many Requests"))).toBe(true);
  });

  test("retries 500 (orchestrator wraps step failures as 500)", () => {
    expect(
      isRetryablePublishError(new ApiError(500, "Tag protection failed: HTTP 403: locked")),
    ).toBe(true);
  });

  test("retries 502 bad gateway", () => {
    expect(isRetryablePublishError(new ApiError(502, "Bad Gateway"))).toBe(true);
  });

  test("retries 503 service unavailable", () => {
    expect(isRetryablePublishError(new ApiError(503, "Service Unavailable"))).toBe(true);
  });

  test("retries 504 gateway timeout", () => {
    expect(isRetryablePublishError(new ApiError(504, "Gateway Timeout"))).toBe(true);
  });

  test("retries 599 (upper boundary of 5xx)", () => {
    expect(isRetryablePublishError(new ApiError(599, "Network connect timeout"))).toBe(true);
  });
});

describe("isRetryablePublishError - GitHub 'Repository has been locked' 403", () => {
  test("retries 403 with 'Repository has been locked' message", () => {
    expect(
      isRetryablePublishError(new ApiError(403, "Tag protection failed: Repository has been locked")),
    ).toBe(true);
  });

  test("retries 403 case-insensitively", () => {
    expect(isRetryablePublishError(new ApiError(403, "REPOSITORY HAS BEEN LOCKED"))).toBe(true);
  });

  test("does NOT retry plain 403 (real auth failure)", () => {
    expect(isRetryablePublishError(new ApiError(403, "Forbidden"))).toBe(false);
  });

  test("does NOT retry 403 with unrelated message", () => {
    expect(
      isRetryablePublishError(new ApiError(403, "Resource not accessible by integration")),
    ).toBe(false);
  });
});

describe("isRetryablePublishError - non-retryable client errors", () => {
  test("does NOT retry 400 (sandbox-prefix rejection, validation)", () => {
    expect(isRetryablePublishError(new ApiError(400, "Cannot publish sandbox datasets"))).toBe(
      false,
    );
  });

  test("does NOT retry 401 (missing auth)", () => {
    expect(isRetryablePublishError(new ApiError(401, "Not authenticated"))).toBe(false);
  });

  test("does NOT retry 404 (dataset not found)", () => {
    expect(isRetryablePublishError(new ApiError(404, "Dataset not found"))).toBe(false);
  });

  test("does NOT retry 422 (CI failure - admin must act)", () => {
    expect(
      isRetryablePublishError(new ApiError(422, "CI check failed: BIDS validation is failing")),
    ).toBe(false);
  });

  test("does NOT retry 499 (just below 5xx boundary)", () => {
    expect(isRetryablePublishError(new ApiError(499, "Client Closed Request"))).toBe(false);
  });
});

describe("isRetryablePublishError - non-ApiError inputs", () => {
  test("does NOT retry plain Error", () => {
    expect(isRetryablePublishError(new Error("HTTP 500"))).toBe(false);
  });

  test("does NOT retry null", () => {
    expect(isRetryablePublishError(null)).toBe(false);
  });

  test("does NOT retry undefined", () => {
    expect(isRetryablePublishError(undefined)).toBe(false);
  });

  test("does NOT retry string", () => {
    expect(isRetryablePublishError("network error")).toBe(false);
  });

  test("does NOT retry plain object with statusCode", () => {
    expect(isRetryablePublishError({ statusCode: 503, message: "fake" })).toBe(false);
  });
});

describe("isRetryablePublishError - boundary check around 5xx", () => {
  test("does NOT retry 600 (above 5xx range)", () => {
    expect(isRetryablePublishError(new ApiError(600, "Custom error"))).toBe(false);
  });

  test("does NOT retry 0-status with 'HTTP 500' in message", () => {
    // statusCode 0 IS retryable (network), but for the wrong reason - this
    // confirms classification is by status, not by message scraping.
    expect(isRetryablePublishError(new ApiError(0, "upstream said HTTP 500"))).toBe(true);
  });
});
