import { describe, expect, test } from "bun:test";
import { HttpError, isRetryable, withRetry } from "../backend/src/services/retry";

describe("isRetryable - HttpError classification", () => {
  test("retries 500", () => {
    expect(isRetryable(new HttpError("server error", 500))).toBe(true);
  });
  test("retries 503", () => {
    expect(isRetryable(new HttpError("service unavailable", 503))).toBe(true);
  });
  test("retries 429", () => {
    expect(isRetryable(new HttpError("rate limit", 429))).toBe(true);
  });
  test("does not retry 404", () => {
    expect(isRetryable(new HttpError("not found", 404))).toBe(false);
  });
  test("does not retry 422", () => {
    expect(isRetryable(new HttpError("validation", 422))).toBe(false);
  });
  test("does not retry 401", () => {
    expect(isRetryable(new HttpError("unauthorized", 401))).toBe(false);
  });
});

describe("isRetryable - Error with .status property", () => {
  test("retries when .status is 503", () => {
    const err = new Error("github 503") as Error & { status?: number };
    err.status = 503;
    expect(isRetryable(err)).toBe(true);
  });
  test("does not retry when .status is 422 even if message contains 'HTTP 500'", () => {
    const err = new Error("validation failed; upstream said HTTP 500 but we got 422") as Error & {
      status?: number;
    };
    err.status = 422;
    expect(isRetryable(err)).toBe(false);
  });
});

describe("isRetryable - network message classification", () => {
  test.each([
    ["fetch failed"],
    ["connection reset"],
    ["network timeout"],
    ["ECONNRESET while reading"],
    ["request timeout after 30s"],
  ])("retries on %p", (msg) => {
    expect(isRetryable(new Error(msg))).toBe(true);
  });
});

describe("isRetryable - HTTP status text fallback", () => {
  test("retries GitHub-style 'HTTP 503'", () => {
    expect(isRetryable(new Error("Failed to resolve ref 'main': HTTP 503"))).toBe(true);
  });
  test("retries EZID-style 'EZID HTTP error (503 ...)'", () => {
    expect(isRetryable(new Error("EZID HTTP error (503 Service Unavailable): retry later"))).toBe(
      true,
    );
  });
  test("retries 'status 429'", () => {
    expect(isRetryable(new Error("status 429 received"))).toBe(true);
  });
  test("does NOT retry on dataset id like nm000500 (no HTTP/status prefix)", () => {
    expect(isRetryable(new Error("dataset nm000500 not found"))).toBe(false);
  });
  test("does NOT retry on plain HTTP 4xx", () => {
    expect(isRetryable(new Error("HTTP 422 unprocessable entity"))).toBe(false);
  });
  test("does NOT retry on EZID 4xx error string", () => {
    expect(isRetryable(new Error("EZID create error: identifier already exists"))).toBe(false);
  });
});

describe("isRetryable - non-retryable inputs", () => {
  test("returns false for null", () => {
    expect(isRetryable(null)).toBe(false);
  });
  test("returns false for plain string", () => {
    expect(isRetryable("HTTP 500")).toBe(false);
  });
  test("returns false for parse-style errors", () => {
    expect(isRetryable(new Error("Unexpected token in JSON at position 12"))).toBe(false);
  });
});

describe("withRetry", () => {
  test("returns first-try result and attempts=1 on success", async () => {
    let calls = 0;
    const { result, attempts } = await withRetry(
      async () => {
        calls += 1;
        return "ok";
      },
      "test-step",
      { maxAttempts: 3, delayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(1);
    expect(calls).toBe(1);
  });

  test("retries until success and reports attempts", async () => {
    let calls = 0;
    const { result, attempts } = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new HttpError("transient", 503);
        return "ok";
      },
      "test-step",
      { maxAttempts: 5, delayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(calls).toBe(3);
  });

  test("does not retry on non-retryable error", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new HttpError("validation", 422);
        },
        "test-step",
        { maxAttempts: 3, delayMs: 1 },
      ),
    ).rejects.toThrow("validation");
    expect(calls).toBe(1);
  });

  test("re-throws last error after exhausting attempts", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new HttpError(`attempt ${calls}`, 503);
        },
        "test-step",
        { maxAttempts: 3, delayMs: 1 },
      ),
    ).rejects.toThrow("attempt 3");
    expect(calls).toBe(3);
  });

  test("custom isRetryable overrides default", async () => {
    let calls = 0;
    const { attempts } = await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error("custom-retryable-marker");
        return "ok";
      },
      "test-step",
      {
        maxAttempts: 3,
        delayMs: 1,
        isRetryable: (e) => e instanceof Error && e.message.includes("custom-retryable-marker"),
      },
    );
    expect(attempts).toBe(2);
    expect(calls).toBe(2);
  });
});
