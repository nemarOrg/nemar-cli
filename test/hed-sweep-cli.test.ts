/**
 * CLI `nemar admin hed-sweep` (#869), driven through the real entry point
 * (`bun run src/index.ts admin hed-sweep ...`).
 *
 * PR #1223 review, suggestion 5: hed-sweep's batch-loop control flow (the
 * do-while loop, progress guard, GitHub-pacing sleep, and the try/catch
 * around it) is now shared with recording-stats-sweep and
 * signal-defaults-sweep via `runSweepBatchLoop` in src/commands/admin.ts.
 * hed-sweep itself had no CLI-level test asserting its exact output before
 * that extraction, so this file closes that gap and doubles as the
 * regression guard for the shared helper's hed-sweep call site -- mirrors
 * test/recording-signal-sweeps-cli.test.ts's harness exactly: a real
 * subprocess CLI invocation pointed at a real local HTTP server via
 * TEST_API_URL (src/lib/api/client.ts#getApiUrl), no mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

interface CaptureServer {
  url: string;
  requests: URL[];
  stop: () => void;
}

function startCaptureServer(responses: unknown[], status = 200): CaptureServer {
  const requests: URL[] = [];
  let i = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") {
        return new Response(JSON.stringify({ notices: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/datasets/facets") {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      requests.push(url);
      const body = responses[Math.min(i, responses.length - 1)];
      i++;
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

function seedAuthenticatedConfig(): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "hedsweepcliuser",
      accounts: { hedsweepcliuser: { apiKey: "test-admin-key" } },
    }),
  );
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-hed-sweep-cli-"));
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

const HED_SWEEP_DONE = {
  processed: 1,
  withHed: 1,
  withoutHed: 0,
  unknown: 0,
  errors: [],
  remaining: 0,
};

describe("nemar admin hed-sweep: auth", () => {
  test("without a stored apiKey, requireAuth blocks before any request is sent", async () => {
    const server = startCaptureServer([HED_SWEEP_DONE]);
    try {
      const result = await runCli(["admin", "hed-sweep"], server.url);
      expect(result.stdout).toContain("Not authenticated");
      expect(server.requests.length).toBe(0);
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin hed-sweep: request shape", () => {
  test("--limit is forwarded as ?limit=N on the real request", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([HED_SWEEP_DONE]);
    try {
      const result = await runCli(["admin", "hed-sweep", "--limit", "10", "--json"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests.length).toBe(1);
      expect(server.requests[0].pathname).toBe("/admin/datasets/hed-sweep");
      expect(server.requests[0].searchParams.get("limit")).toBe("10");
    } finally {
      server.stop();
    }
  });

  test("without --limit, the CLI's own default (15) is sent", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([HED_SWEEP_DONE]);
    try {
      const result = await runCli(["admin", "hed-sweep", "--json"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests[0].searchParams.get("limit")).toBe("15");
    } finally {
      server.stop();
    }
  });

  test("--reset sends ?reset=1 and does not fall through to a sweep batch", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([{ reset: 9 }]);
    try {
      const result = await runCli(["admin", "hed-sweep", "--reset", "--json"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests.length).toBe(1);
      expect(server.requests[0].searchParams.get("reset")).toBe("1");
      expect(JSON.parse(result.stdout)).toEqual({ reset: 9 });
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin hed-sweep: loop and output", () => {
  test("loops across batches until remaining reaches 0, then reports totals", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([
      { processed: 4, withHed: 2, withoutHed: 1, unknown: 1, errors: [], remaining: 3 },
      { processed: 3, withHed: 1, withoutHed: 2, unknown: 0, errors: [], remaining: 0 },
    ]);
    try {
      const result = await runCli(["admin", "hed-sweep", "--json"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests.length).toBe(2);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.processed).toBe(7);
      expect(parsed.withHed).toBe(3);
      expect(parsed.withoutHed).toBe(3);
      expect(parsed.unknown).toBe(1);
      expect(parsed.batches).toBe(2);
      expect(parsed.remaining).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("the human summary reports processed/hed/no-hed/unknown/remaining", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([HED_SWEEP_DONE]);
    try {
      const result = await runCli(["admin", "hed-sweep"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("processed=1");
      expect(result.stdout).toContain("hed=1");
      expect(result.stdout).toContain("no-hed=0");
      expect(result.stdout).toContain("unknown=0");
      expect(result.stdout).toContain("remaining=0");
    } finally {
      server.stop();
    }
  });

  // NOT covered here: a `--verbose` per-batch-line assertion. Investigating
  // this test surfaced a PRE-EXISTING, unrelated bug (confirmed with a
  // temporary debug patch, not committed): the root `program` also
  // declares a global `.option("--verbose", ...)` (src/index.ts:54), which
  // shadows every subcommand's own local `--verbose` (hed-sweep,
  // recording-stats-sweep, signal-defaults-sweep, and at least two more --
  // admin.ts:3372, 4750) -- `options.verbose` in the action handler comes
  // back `undefined` no matter what, so `--verbose` is currently a no-op
  // on all of them. Predates this PR and this refactor; out of scope for
  // PR #1223 review suggestion 5 (extracting runSweepBatchLoop without
  // changing output) and left for a separate follow-up issue.

  test("a non-empty errors array exits non-zero", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([
      {
        processed: 1,
        withHed: 0,
        withoutHed: 0,
        unknown: 1,
        errors: [{ dataset_id: "nm000900", error: "github: simulated failure" }],
        remaining: 0,
      },
    ]);
    try {
      const result = await runCli(["admin", "hed-sweep", "--json"], server.url);
      expect(result.exitCode).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("a null remaining count exits non-zero (an uncertain sweep is never reported as success)", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([
      { processed: 1, withHed: 1, withoutHed: 0, unknown: 0, errors: [], remaining: null },
    ]);
    try {
      const result = await runCli(["admin", "hed-sweep", "--json"], server.url);
      expect(result.exitCode).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("remaining stuck at the same value stops the loop instead of looping forever", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([
      { processed: 0, withHed: 0, withoutHed: 0, unknown: 0, errors: [], remaining: 2 },
      { processed: 0, withHed: 0, withoutHed: 0, unknown: 0, errors: [], remaining: 2 },
    ]);
    try {
      const result = await runCli(["admin", "hed-sweep"], server.url);
      // Mirrors recording-stats-sweep/signal-defaults-sweep: a stuck (but
      // non-null, error-free) `remaining` breaks the loop with a warning
      // rather than exiting non-zero.
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("No progress");
      expect(server.requests.length).toBe(2);
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin hed-sweep: help", () => {
  test("--help documents the reset flag", async () => {
    const server = startCaptureServer([HED_SWEEP_DONE]);
    try {
      const result = await runCli(["admin", "hed-sweep", "--help"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--limit");
      expect(result.stdout).toContain("--reset");
      expect(result.stdout).toContain("--json");
    } finally {
      server.stop();
    }
  });
});
