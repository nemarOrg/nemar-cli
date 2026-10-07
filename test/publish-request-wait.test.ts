/**
 * `nemar dataset publish request` right after an upload (iEEG campaign item 7).
 *
 * The request is refused with block_reason bids_validation_pending /
 * bids_validation_in_progress until the dataset's validation run concludes.
 * The CLI used to exit 1 with only "re-request publication", so every lane had
 * to wrap it in its own retry loop. Now: a precise hint without --wait, and a
 * --wait mode that keeps retrying while (and only while) CI is pending.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { ApiError } from "../src/lib/api/errors";
import {
  DEFAULT_WAIT_MINUTES,
  ciPendingHint,
  isCiPendingBlock,
  parseWaitOption,
  requestWaitingForCi,
} from "../src/lib/publish-wait";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

interface Recorded {
  pathname: string;
  body: string;
}

interface CaptureServer {
  url: string;
  requests: Recorded[];
  stop: () => void;
}

function startCaptureServer(body: unknown, status = 200): CaptureServer {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      // Every real `nemar` invocation fires a `GET /notices` preAction hook,
      // and commands can fire a fire-and-forget facets refresh. Both are
      // genuine traffic this server must answer, and neither is what this
      // test checks.
      if (url.pathname === "/notices") {
        return Response.json({ notices: [] });
      }
      if (url.pathname === "/datasets/facets") {
        return Response.json({});
      }
      requests.push({ pathname: url.pathname, body: await req.text() });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-publish-wait-cli-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "waitcli",
      accounts: { waitcli: { apiKey: "test-anon-key" } },
    }),
  );
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

async function runCli(
  args: string[],
  testApiUrl: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: testApiUrl,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  env.FORCE_COLOR = undefined;
  env.CLICOLOR_FORCE = undefined;
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

const PENDING = {
  status: "blocked",
  block_reason: "bids_validation_pending",
  message:
    "BIDS validation has not run yet. Please wait for CI to complete, then re-request publication.",
  dataset_id: "nm000358",
};

function pending(reason = "bids_validation_pending"): ApiError {
  return new ApiError(422, "BIDS validation has not run yet.", undefined, undefined, reason);
}

describe("isCiPendingBlock", () => {
  test("only the two CI-not-concluded reasons count", () => {
    expect(isCiPendingBlock(pending())).toBe(true);
    expect(isCiPendingBlock(pending("bids_validation_in_progress"))).toBe(true);
    expect(isCiPendingBlock(pending("bids_validation_failed"))).toBe(false);
    expect(isCiPendingBlock(pending("min_requirements_failed"))).toBe(false);
    expect(isCiPendingBlock(new ApiError(409, "already requested"))).toBe(false);
    expect(isCiPendingBlock(new Error("x"))).toBe(false);
  });
});

describe("parseWaitOption", () => {
  test("absent, bare and numeric forms", () => {
    expect(parseWaitOption(undefined)).toBeNull();
    expect(parseWaitOption(true)).toBe(DEFAULT_WAIT_MINUTES);
    expect(parseWaitOption("45")).toBe(45);
    expect(parseWaitOption("100000")).toBe(24 * 60);
  });

  test("garbage is an error, not a silent default", () => {
    expect(() => parseWaitOption("soon")).toThrow("--wait expects a number of minutes");
    expect(() => parseWaitOption("0")).toThrow();
  });
});

describe("requestWaitingForCi", () => {
  function clock() {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  }

  test("retries while CI is pending, then returns the accepted request", async () => {
    const c = clock();
    const answers = [pending(), pending("bids_validation_in_progress"), "accepted"];
    const seen: string[] = [];
    const result = await requestWaitingForCi({
      request: async () => {
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      waitMs: 30 * 60 * 1000,
      intervalMs: 60 * 1000,
      onPending: (reason) => seen.push(reason),
      ...c,
    });
    expect(result).toBe("accepted");
    expect(seen).toEqual(["bids_validation_pending", "bids_validation_in_progress"]);
    expect(c.now()).toBe(2 * 60 * 1000);
  });

  test("a validation failure is thrown at once, never waited out", async () => {
    const c = clock();
    let calls = 0;
    await expect(
      requestWaitingForCi({
        request: async () => {
          calls++;
          throw pending("bids_validation_failed");
        },
        waitMs: 30 * 60 * 1000,
        ...c,
      }),
    ).rejects.toMatchObject({ blockReason: "bids_validation_failed" });
    expect(calls).toBe(1);
  });

  test("gives up after the wait and rethrows the last pending refusal", async () => {
    const c = clock();
    let calls = 0;
    await expect(
      requestWaitingForCi({
        request: async () => {
          calls++;
          throw pending();
        },
        waitMs: 5 * 60 * 1000,
        intervalMs: 60 * 1000,
        ...c,
      }),
    ).rejects.toMatchObject({ blockReason: "bids_validation_pending" });
    // t = 0, 1, ..., 5 min: the last attempt lands exactly at the end of the wait.
    expect(calls).toBe(6);
    expect(c.now()).toBeLessThanOrEqual(5 * 60 * 1000);
  });
});

describe("ciPendingHint", () => {
  test("says the request is recorded and how to wait", () => {
    const text = ciPendingHint("nm000358", false).join("\n");
    expect(text).toContain("re-checked automatically");
    expect(text).toContain("nemar dataset publish request nm000358 --wait");
    expect(text).toContain("nemar dataset ci nm000358");
  });
});

describe("nemar dataset publish request (CLI)", () => {
  test("a CI-pending refusal prints the retry hint, not a generic failure", async () => {
    const server = startCaptureServer(PENDING, 422);
    try {
      const result = await runCli(["dataset", "publish", "request", "nm000358"], server.url);
      expect(result.exitCode).toBe(1);
      const out = result.stdout + result.stderr;
      expect(out).toContain("BIDS validation has not concluded yet");
      expect(out).toContain("publish request nm000358 --wait");
      const posted = server.requests.filter((r) => r.pathname.endsWith("/publish/request"));
      expect(posted.length).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("--wait with a bad value is refused before any request is sent", async () => {
    const server = startCaptureServer(PENDING, 422);
    try {
      const result = await runCli(
        ["dataset", "publish", "request", "nm000358", "--wait", "soon"],
        server.url,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain("--wait expects a number of minutes");
      expect(server.requests.filter((r) => r.pathname.endsWith("/publish/request"))).toHaveLength(
        0,
      );
    } finally {
      server.stop();
    }
  });
});
