/**
 * Rate-limit retry tests (issue #411).
 *
 * Exercises `githubFetchWithRetry` against a local Bun.serve fake GitHub.
 * Tests inject a synchronous `sleepFn` that records the requested delay so
 * wall-clock stays sub-second; assertions are on the recorded delays.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./setup";
import { type FakeGithubServer, startFakeGithub } from "./helpers/fetch-counter";
import {
  __resetRateLimitStateForTests,
  __seedRateLimitStateForTests,
  githubFetchWithRetry,
} from "../backend/src/services/github";

const PATH = "/repos/nemarDatasets/nm099999/branches/main";

let fake: FakeGithubServer;
let recordedSleeps: number[] = [];

const recordingSleep = async (ms: number): Promise<void> => {
  recordedSleeps.push(ms);
  // resolve immediately; tests assert on recorded values, not real waits
};

function setGithubApiOverride(url: string | undefined): void {
  if (url === undefined) {
    delete (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL;
  } else {
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = url;
  }
}

let nextHandler: ((req: Request, callIndex: number) => Response) | null = null;
let callIndex = 0;

beforeAll(() => {
  fake = startFakeGithub({
    [`GET ${PATH}`]: (req) => {
      const idx = callIndex++;
      if (!nextHandler) throw new Error("test did not set nextHandler");
      return nextHandler(req, idx);
    },
  });
  setGithubApiOverride(fake.url);
});

afterAll(() => {
  fake.stop();
  setGithubApiOverride(undefined);
});

beforeEach(() => {
  fake.reset();
  recordedSleeps = [];
  callIndex = 0;
  nextHandler = null;
  __resetRateLimitStateForTests();
});

afterEach(() => {
  __resetRateLimitStateForTests();
});

function plainHeaders(extra: Record<string, string> = {}): HeadersInit {
  return { "Content-Type": "application/json", ...extra };
}

describe("Retry-After header honoring", () => {
  test("429 with Retry-After: 2 waits exactly 2000ms", async () => {
    nextHandler = (_req, idx) => {
      if (idx === 0) {
        return new Response("{}", {
          status: 429,
          headers: plainHeaders({ "Retry-After": "2" }),
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: plainHeaders(),
      });
    };

    const res = await githubFetchWithRetry(
      `${fake.url}${PATH}`,
      { method: "GET" },
      { sleepFn: recordingSleep, delayMs: 999_999 },
    );

    expect(res.status).toBe(200);
    expect(recordedSleeps).toEqual([2_000]);
    expect(callIndex).toBe(2);
  });

  test("429 with Retry-After HTTP-date roughly 3s in future waits ~3000ms", async () => {
    const futureDate = new Date(Date.now() + 3_000).toUTCString();
    nextHandler = (_req, idx) => {
      if (idx === 0) {
        return new Response("{}", {
          status: 429,
          headers: plainHeaders({ "Retry-After": futureDate }),
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: plainHeaders() });
    };

    const res = await githubFetchWithRetry(
      `${fake.url}${PATH}`,
      { method: "GET" },
      { sleepFn: recordingSleep, delayMs: 999_999 },
    );

    expect(res.status).toBe(200);
    expect(recordedSleeps.length).toBe(1);
    // HTTP-date precision is 1s and Date.parse drops sub-second, so allow a
    // generous tolerance around the requested 3s.
    expect(recordedSleeps[0]).toBeGreaterThanOrEqual(1_500);
    expect(recordedSleeps[0]).toBeLessThanOrEqual(3_500);
  });

  test("429 without Retry-After falls back to delayMs", async () => {
    nextHandler = (_req, idx) => {
      if (idx === 0) {
        return new Response("{}", { status: 429, headers: plainHeaders() });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: plainHeaders() });
    };

    const res = await githubFetchWithRetry(
      `${fake.url}${PATH}`,
      { method: "GET" },
      { sleepFn: recordingSleep, delayMs: 750 },
    );

    expect(res.status).toBe(200);
    expect(recordedSleeps).toEqual([750]);
  });
});

describe("Secondary rate limit detection", () => {
  test("403 with secondary-rate-limit body + Retry-After: 1 retries with 1000ms wait", async () => {
    nextHandler = (_req, idx) => {
      if (idx === 0) {
        return new Response(
          JSON.stringify({ message: "You have exceeded a secondary rate limit." }),
          { status: 403, headers: plainHeaders({ "Retry-After": "1" }) },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: plainHeaders() });
    };

    const res = await githubFetchWithRetry(
      `${fake.url}${PATH}`,
      { method: "GET" },
      { sleepFn: recordingSleep, delayMs: 999_999 },
    );

    expect(res.status).toBe(200);
    expect(recordedSleeps).toEqual([1_000]);
    expect(callIndex).toBe(2);
  });

  test("403 without secondary-rate-limit body is terminal (no retry)", async () => {
    nextHandler = (_req, _idx) =>
      new Response(JSON.stringify({ message: "Forbidden" }), {
        status: 403,
        headers: plainHeaders(),
      });

    const res = await githubFetchWithRetry(
      `${fake.url}${PATH}`,
      { method: "GET" },
      { sleepFn: recordingSleep },
    );

    expect(res.status).toBe(403);
    expect(recordedSleeps).toEqual([]);
  });
});

// 401 refresh path (issue #596): stale App-installation tokens should
// self-heal after one fresh-mint retry. Separate from the rate-limit
// suite because the trigger is auth, not throttling, but it lives here
// so both transient-retry paths share fixtures.
describe("401 refresh-token-on-401", () => {
  test("401 then 200 retries once with the refreshed bearer", async () => {
    const seen: string[] = [];
    nextHandler = (req, idx) => {
      seen.push(req.headers.get("Authorization") ?? "");
      if (idx === 0) {
        return new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 401,
          headers: plainHeaders(),
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: plainHeaders() });
    };

    let refreshCount = 0;
    const res = await githubFetchWithRetry(
      `${fake.url}${PATH}`,
      { method: "GET", headers: { Authorization: "Bearer stale-token" } },
      {
        sleepFn: recordingSleep,
        refreshTokenOn401: async () => {
          refreshCount += 1;
          return "fresh-token";
        },
      },
    );

    expect(res.status).toBe(200);
    expect(refreshCount).toBe(1);
    expect(callIndex).toBe(2);
    // No backoff sleep on the auth-refresh retry; it fires immediately.
    expect(recordedSleeps).toEqual([]);
    expect(seen).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
  });

  test("second 401 after refresh is terminal", async () => {
    nextHandler = (_req, _idx) =>
      new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        headers: plainHeaders(),
      });

    let refreshCount = 0;
    const res = await githubFetchWithRetry(
      `${fake.url}${PATH}`,
      { method: "GET", headers: { Authorization: "Bearer stale-token" } },
      {
        sleepFn: recordingSleep,
        refreshTokenOn401: async () => {
          refreshCount += 1;
          return "fresh-token";
        },
      },
    );

    expect(res.status).toBe(401);
    expect(refreshCount).toBe(1);
    expect(callIndex).toBe(2);
  });

  test("401 without refresher is terminal (no retry)", async () => {
    nextHandler = (_req, _idx) =>
      new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        headers: plainHeaders(),
      });

    const res = await githubFetchWithRetry(
      `${fake.url}${PATH}`,
      { method: "GET", headers: { Authorization: "Bearer stale-token" } },
      { sleepFn: recordingSleep },
    );

    expect(res.status).toBe(401);
    expect(callIndex).toBe(1);
  });

  test("refresher that throws falls back to returning the original 401", async () => {
    nextHandler = (_req, _idx) =>
      new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        headers: plainHeaders(),
      });

    const res = await githubFetchWithRetry(
      `${fake.url}${PATH}`,
      { method: "GET", headers: { Authorization: "Bearer stale-token" } },
      {
        sleepFn: recordingSleep,
        refreshTokenOn401: async () => {
          throw new Error("App key rotation in progress");
        },
      },
    );

    expect(res.status).toBe(401);
    expect(callIndex).toBe(1);
    expect(callIndex).toBe(1);
  });
});

describe("Pre-flight throttling", () => {
  test("background kind sleeps until reset when remaining is below threshold", async () => {
    __seedRateLimitStateForTests({
      resource: "core",
      remaining: 5,
      resetEpoch: Math.floor((Date.now() + 10_000) / 1_000),
    });

    nextHandler = () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: plainHeaders() });

    const res = await githubFetchWithRetry(
      `${fake.url}${PATH}`,
      { method: "GET" },
      { sleepFn: recordingSleep, kind: "background", lowRemainingThreshold: 50 },
    );

    expect(res.status).toBe(200);
    expect(recordedSleeps.length).toBe(1);
    // resetEpoch was computed from Date.now(); allow generous tolerance for
    // execution drift between seeding and the throttle check.
    expect(recordedSleeps[0]).toBeGreaterThanOrEqual(7_000);
    expect(recordedSleeps[0]).toBeLessThanOrEqual(10_500);
  });

  test("interactive kind throws HttpError 503 instead of sleeping", async () => {
    __seedRateLimitStateForTests({
      resource: "core",
      remaining: 5,
      resetEpoch: Math.floor((Date.now() + 10_000) / 1_000),
    });

    nextHandler = () => {
      throw new Error("interactive pre-flight should not call fetch");
    };

    try {
      await githubFetchWithRetry(
        `${fake.url}${PATH}`,
        { method: "GET" },
        { sleepFn: recordingSleep, kind: "interactive" },
      );
      throw new Error("expected HttpError(503) but call resolved");
    } catch (err) {
      expect(err).toBeDefined();
      const { status } = err as { status?: number };
      expect(status).toBe(503);
    }
    expect(recordedSleeps).toEqual([]);
    expect(callIndex).toBe(0);
  });

  test("pre-flight sleep is capped by maxThrottleMs", async () => {
    __seedRateLimitStateForTests({
      resource: "core",
      remaining: 5,
      resetEpoch: Math.floor((Date.now() + 3_600_000) / 1_000),
    });

    nextHandler = () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: plainHeaders() });

    const res = await githubFetchWithRetry(
      `${fake.url}${PATH}`,
      { method: "GET" },
      { sleepFn: recordingSleep, maxThrottleMs: 60_000 },
    );

    expect(res.status).toBe(200);
    expect(recordedSleeps).toEqual([60_000]);
  });
});

describe("Header parsing populates the cache", () => {
  test("X-RateLimit-* headers on a 200 are cached and observable on next call", async () => {
    const futureResetEpoch = Math.floor((Date.now() + 8_000) / 1_000);
    nextHandler = (_req, idx) => {
      if (idx === 0) {
        // First call: populate the cache via response headers.
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: plainHeaders({
            "X-RateLimit-Remaining": "3",
            "X-RateLimit-Reset": String(futureResetEpoch),
            "X-RateLimit-Resource": "core",
            "X-RateLimit-Limit": "5000",
          }),
        });
      }
      // Second call: should not be reached if pre-flight blocks correctly,
      // but interactive kind throws before fetch so this stays unreached.
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: plainHeaders() });
    };

    const first = await githubFetchWithRetry(
      `${fake.url}${PATH}`,
      { method: "GET" },
      { sleepFn: recordingSleep },
    );
    expect(first.status).toBe(200);
    expect(recordedSleeps).toEqual([]);

    // Second call should see remaining=3 in cache and throw on interactive kind.
    try {
      await githubFetchWithRetry(
        `${fake.url}${PATH}`,
        { method: "GET" },
        { sleepFn: recordingSleep, kind: "interactive" },
      );
      throw new Error("expected HttpError(503)");
    } catch (err) {
      const { status, message } = err as { status?: number; message?: string };
      expect(status).toBe(503);
      expect(message).toContain("remaining=3");
    }
  });
});

describe("Retry-After takes precedence over delayMs", () => {
  test("when both are set, Retry-After wins", async () => {
    nextHandler = (_req, idx) => {
      if (idx === 0) {
        return new Response("{}", {
          status: 429,
          headers: plainHeaders({ "Retry-After": "5" }),
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: plainHeaders() });
    };

    const res = await githubFetchWithRetry(
      `${fake.url}${PATH}`,
      { method: "GET" },
      { sleepFn: recordingSleep, delayMs: 1 },
    );

    expect(res.status).toBe(200);
    expect(recordedSleeps).toEqual([5_000]);
  });
});

describe("Coverage of additional retry paths", () => {
  test("fetch throw is retried with delayMs and propagates after exhaustion", async () => {
    // 127.0.0.1:1 is reserved + unused. fetch() will reject on every attempt,
    // exercising the catch branch.
    const deadUrl = `http://127.0.0.1:1${PATH}`;
    let thrown: unknown;
    try {
      await githubFetchWithRetry(
        deadUrl,
        { method: "GET" },
        { sleepFn: recordingSleep, delayMs: 333, maxAttempts: 3 },
      );
      throw new Error("expected fetch to throw");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    // Two retries between three attempts; the catch path uses delayMs.
    expect(recordedSleeps).toEqual([333, 333]);
  });

  test("retryOn404 retries 404 with delayMs; without it 404 is terminal", async () => {
    // First sub-test: retryOn404 true.
    nextHandler = (_req, idx) =>
      idx === 0
        ? new Response("{}", { status: 404, headers: plainHeaders() })
        : new Response(JSON.stringify({ ok: true }), { status: 200, headers: plainHeaders() });

    const okRes = await githubFetchWithRetry(
      `${fake.url}${PATH}`,
      { method: "GET" },
      { sleepFn: recordingSleep, delayMs: 250, retryOn404: true },
    );
    expect(okRes.status).toBe(200);
    expect(recordedSleeps).toEqual([250]);
    expect(callIndex).toBe(2);

    // Reset state between sub-tests.
    recordedSleeps = [];
    callIndex = 0;
    fake.reset();

    // Second sub-test: retryOn404 false (default).
    nextHandler = () => new Response("{}", { status: 404, headers: plainHeaders() });

    const noRetryRes = await githubFetchWithRetry(
      `${fake.url}${PATH}`,
      { method: "GET" },
      { sleepFn: recordingSleep },
    );
    expect(noRetryRes.status).toBe(404);
    expect(recordedSleeps).toEqual([]);
    expect(callIndex).toBe(1);
  });

  test("maxAttempts exhausted on a transient response returns the final response", async () => {
    nextHandler = () =>
      new Response("{}", { status: 503, headers: plainHeaders() });

    const res = await githubFetchWithRetry(
      `${fake.url}${PATH}`,
      { method: "GET" },
      { sleepFn: recordingSleep, delayMs: 100, maxAttempts: 3 },
    );

    expect(res.status).toBe(503);
    expect(res.ok).toBe(false);
    // Two retries between three attempts.
    expect(recordedSleeps).toEqual([100, 100]);
    expect(callIndex).toBe(3);
  });

  test("5xx with Retry-After honors the header (not delayMs)", async () => {
    nextHandler = (_req, idx) => {
      if (idx === 0) {
        return new Response("{}", {
          status: 503,
          headers: plainHeaders({ "Retry-After": "4" }),
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: plainHeaders() });
    };

    const res = await githubFetchWithRetry(
      `${fake.url}${PATH}`,
      { method: "GET" },
      { sleepFn: recordingSleep, delayMs: 1 },
    );

    expect(res.status).toBe(200);
    expect(recordedSleeps).toEqual([4_000]);
  });

  test("in-loop Retry-After is capped by maxThrottleMs", async () => {
    nextHandler = (_req, idx) => {
      if (idx === 0) {
        return new Response("{}", {
          status: 429,
          headers: plainHeaders({ "Retry-After": "600" }),
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: plainHeaders() });
    };

    const res = await githubFetchWithRetry(
      `${fake.url}${PATH}`,
      { method: "GET" },
      { sleepFn: recordingSleep, maxThrottleMs: 5_000 },
    );

    expect(res.status).toBe(200);
    expect(recordedSleeps).toEqual([5_000]);
  });

  // Note: the "403 with unreadable body falls back to secondary" code path
  // is intentionally hard to exercise via Bun.serve (a server-side body
  // error materializes as an empty body on the client, not a thrown read).
  // The fail-safe behavior is implemented and exercised manually; this test
  // file does not cover it deterministically.
});

describe("Structured logging", () => {
  test("emits one github-rl JSON line per call with parsed fields", async () => {
    const futureResetEpoch = Math.floor((Date.now() + 7_000) / 1_000);
    nextHandler = () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: plainHeaders({
          "X-RateLimit-Remaining": "4321",
          "X-RateLimit-Reset": String(futureResetEpoch),
          "X-RateLimit-Resource": "core",
          "X-RateLimit-Limit": "5000",
        }),
      });

    const captured: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };

    try {
      const res = await githubFetchWithRetry(
        `${fake.url}${PATH}`,
        { method: "GET" },
        { sleepFn: recordingSleep },
      );
      expect(res.status).toBe(200);
    } finally {
      console.log = originalLog;
    }

    const rlLines = captured
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry): entry is Record<string, unknown> => entry !== null && entry.tag === "github-rl");
    expect(rlLines.length).toBe(1);
    const entry = rlLines[0];
    expect(entry.method).toBe("GET");
    expect(entry.path).toBe(PATH);
    expect(entry.status).toBe(200);
    expect(entry.resource).toBe("core");
    expect(entry.remaining).toBe(4321);
    expect(entry.resetEpoch).toBe(futureResetEpoch);
    expect(entry.limit).toBe(5000);
    expect(entry.attempt).toBe(1);
    expect(entry.maxAttempts).toBe(3);
  });
});
