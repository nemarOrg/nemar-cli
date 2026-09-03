/**
 * CLI `nemar admin recording-stats-sweep` / `nemar admin signal-defaults-sweep`
 * (issue #1194), driven through the real entry point (`bun run src/index.ts
 * admin ... `). Mirrors test/zarr-fidelity-sweep-cli.test.ts's harness: a
 * real subprocess CLI invocation pointed at a real local HTTP server via
 * TEST_API_URL (src/lib/api/client.ts#getApiUrl) -- the recorded request is
 * what the CLI's own `fetch()` actually sent, not a re-implementation of it.
 *
 * Both commands are admin-only, so the harness also seeds a real
 * config.json ({activeAccount, accounts: {<name>: {apiKey}}}) into an
 * isolated NEMAR_CONFIG_DIR -- the same shape src/lib/config.ts's Conf
 * store reads (cwd: NEMAR_CONFIG_DIR) -- so isAuthenticated() is genuinely
 * true rather than stubbed.
 *
 * Unlike zarr-fidelity-sweep, both commands loop, calling the batch
 * endpoint repeatedly until `remaining` reaches 0 (mirrors
 * hedSweepCommand/availabilityReportCommand). The capture server below can
 * be seeded with a queue of responses to exercise that loop for real.
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

/** Serves each entry in `responses` in order (one per non-excluded POST);
 *  the last entry repeats if more requests arrive than responses provided. */
function startCaptureServer(responses: unknown[], status = 200): CaptureServer {
  const requests: URL[] = [];
  let i = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      // Real traffic every invocation fires that is not what these tests
      // check (mirrors zarr-fidelity-sweep-cli.test.ts's exclusions).
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
      activeAccount: "sweepcliuser",
      accounts: { sweepcliuser: { apiKey: "test-admin-key" } },
    }),
  );
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-recording-signal-sweeps-cli-"));
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

const RECORDING_STATS_DONE = {
  processed: 1,
  measured: 1,
  unmeasured: 0,
  errors: [],
  remaining: 0,
};

const SIGNAL_DEFAULTS_DONE = {
  processed: 1,
  populated: 1,
  noData: 0,
  errors: [],
  remaining: 0,
};

describe("nemar admin recording-stats-sweep: auth", () => {
  test("without a stored apiKey, requireAuth blocks before any request is sent", async () => {
    const server = startCaptureServer([RECORDING_STATS_DONE]);
    try {
      const result = await runCli(["admin", "recording-stats-sweep"], server.url);
      expect(result.stdout).toContain("Not authenticated");
      expect(server.requests.length).toBe(0);
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin recording-stats-sweep: request shape", () => {
  test("--limit is forwarded as ?limit=N on the real request", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([RECORDING_STATS_DONE]);
    try {
      const result = await runCli(
        ["admin", "recording-stats-sweep", "--limit", "10", "--json"],
        server.url,
      );
      expect(result.exitCode).toBe(0);
      expect(server.requests.length).toBe(1);
      expect(server.requests[0].pathname).toBe("/admin/datasets/recording-stats-sweep");
      expect(server.requests[0].searchParams.get("limit")).toBe("10");
    } finally {
      server.stop();
    }
  });

  test("without --limit, the CLI's own default (50) is sent", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([RECORDING_STATS_DONE]);
    try {
      const result = await runCli(["admin", "recording-stats-sweep", "--json"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests[0].searchParams.get("limit")).toBe("50");
    } finally {
      server.stop();
    }
  });

  test("--reset sends ?reset=1 and does not fall through to a sweep batch", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([{ reset: 7 }]);
    try {
      const result = await runCli(
        ["admin", "recording-stats-sweep", "--reset", "--json"],
        server.url,
      );
      expect(result.exitCode).toBe(0);
      expect(server.requests.length).toBe(1);
      expect(server.requests[0].searchParams.get("reset")).toBe("1");
      expect(JSON.parse(result.stdout)).toEqual({ reset: 7 });
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin recording-stats-sweep: loop and output", () => {
  test("loops across batches until remaining reaches 0, then reports totals", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([
      { processed: 5, measured: 3, unmeasured: 2, errors: [], remaining: 2 },
      { processed: 2, measured: 2, unmeasured: 0, errors: [], remaining: 0 },
    ]);
    try {
      const result = await runCli(["admin", "recording-stats-sweep", "--json"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests.length).toBe(2);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.processed).toBe(7);
      expect(parsed.measured).toBe(5);
      expect(parsed.unmeasured).toBe(2);
      expect(parsed.batches).toBe(2);
      expect(parsed.remaining).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("the human summary reports processed/measured/unmeasured/remaining", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([RECORDING_STATS_DONE]);
    try {
      const result = await runCli(["admin", "recording-stats-sweep"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("processed=1");
      expect(result.stdout).toContain("measured=1");
      expect(result.stdout).toContain("unmeasured=0");
      expect(result.stdout).toContain("remaining=0");
    } finally {
      server.stop();
    }
  });

  test("a non-empty errors array exits non-zero", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([
      {
        processed: 1,
        measured: 0,
        unmeasured: 0,
        errors: [{ dataset_id: "nm000900", error: "s3: simulated timeout" }],
        remaining: 0,
      },
    ]);
    try {
      const result = await runCli(["admin", "recording-stats-sweep", "--json"], server.url);
      expect(result.exitCode).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("a null remaining count exits non-zero (an uncertain sweep is never reported as success)", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([
      { processed: 1, measured: 1, unmeasured: 0, errors: [], remaining: null },
    ]);
    try {
      const result = await runCli(["admin", "recording-stats-sweep", "--json"], server.url);
      expect(result.exitCode).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("remaining stuck at the same value stops the loop instead of looping forever", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([
      { processed: 0, measured: 0, unmeasured: 0, errors: [], remaining: 3 },
      { processed: 0, measured: 0, unmeasured: 0, errors: [], remaining: 3 },
    ]);
    try {
      const result = await runCli(["admin", "recording-stats-sweep"], server.url);
      // Mirrors hedSweepCommand/availabilityReportCommand: a stuck (but
      // non-null, error-free) `remaining` breaks the loop with a warning
      // rather than exiting non-zero -- only a null `remaining` or a
      // non-empty errors array trips the final exit-code guard.
      expect(result.exitCode).toBe(0);
      // The "No progress" warning is printed via ora's spinner, which
      // writes to stderr, not stdout.
      expect(result.stderr).toContain("No progress");
      // Stops after the second identical `remaining`, not the caller-side
      // repeat-response fallback going on forever.
      expect(server.requests.length).toBe(2);
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin signal-defaults-sweep: auth", () => {
  test("without a stored apiKey, requireAuth blocks before any request is sent", async () => {
    const server = startCaptureServer([SIGNAL_DEFAULTS_DONE]);
    try {
      const result = await runCli(["admin", "signal-defaults-sweep"], server.url);
      expect(result.stdout).toContain("Not authenticated");
      expect(server.requests.length).toBe(0);
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin signal-defaults-sweep: request shape", () => {
  test("--limit is forwarded as ?limit=N on the real request", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([SIGNAL_DEFAULTS_DONE]);
    try {
      const result = await runCli(
        ["admin", "signal-defaults-sweep", "--limit", "5", "--json"],
        server.url,
      );
      expect(result.exitCode).toBe(0);
      expect(server.requests.length).toBe(1);
      expect(server.requests[0].pathname).toBe("/admin/datasets/signal-defaults-sweep");
      expect(server.requests[0].searchParams.get("limit")).toBe("5");
    } finally {
      server.stop();
    }
  });

  test("without --limit, the CLI's own default (15) is sent", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([SIGNAL_DEFAULTS_DONE]);
    try {
      const result = await runCli(["admin", "signal-defaults-sweep", "--json"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests[0].searchParams.get("limit")).toBe("15");
    } finally {
      server.stop();
    }
  });

  test("--reset sends ?reset=1 and does not fall through to a sweep batch", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([{ reset: 4 }]);
    try {
      const result = await runCli(
        ["admin", "signal-defaults-sweep", "--reset", "--json"],
        server.url,
      );
      expect(result.exitCode).toBe(0);
      expect(server.requests.length).toBe(1);
      expect(server.requests[0].searchParams.get("reset")).toBe("1");
      expect(JSON.parse(result.stdout)).toEqual({ reset: 4 });
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin signal-defaults-sweep: loop and output", () => {
  test("loops across batches until remaining reaches 0, then reports totals", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([
      { processed: 3, populated: 1, noData: 2, errors: [], remaining: 1 },
      { processed: 1, populated: 0, noData: 1, errors: [], remaining: 0 },
    ]);
    try {
      const result = await runCli(["admin", "signal-defaults-sweep", "--json"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests.length).toBe(2);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.processed).toBe(4);
      expect(parsed.populated).toBe(1);
      expect(parsed.noData).toBe(3);
      expect(parsed.batches).toBe(2);
      expect(parsed.remaining).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("the human summary reports processed/populated/no-data/remaining", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([SIGNAL_DEFAULTS_DONE]);
    try {
      const result = await runCli(["admin", "signal-defaults-sweep"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("processed=1");
      expect(result.stdout).toContain("populated=1");
      expect(result.stdout).toContain("no-data=0");
      expect(result.stdout).toContain("remaining=0");
    } finally {
      server.stop();
    }
  });

  test("a non-empty errors array exits non-zero", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer([
      {
        processed: 1,
        populated: 0,
        noData: 0,
        errors: [{ dataset_id: "*", error: "github auth failed" }],
        remaining: 0,
      },
    ]);
    try {
      const result = await runCli(["admin", "signal-defaults-sweep", "--json"], server.url);
      expect(result.exitCode).toBe(1);
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin recording-stats-sweep / signal-defaults-sweep: help", () => {
  test("recording-stats-sweep --help documents the reset flag", async () => {
    const server = startCaptureServer([RECORDING_STATS_DONE]);
    try {
      const result = await runCli(["admin", "recording-stats-sweep", "--help"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--limit");
      expect(result.stdout).toContain("--reset");
      expect(result.stdout).toContain("--json");
    } finally {
      server.stop();
    }
  });

  test("signal-defaults-sweep --help documents the reset flag", async () => {
    const server = startCaptureServer([SIGNAL_DEFAULTS_DONE]);
    try {
      const result = await runCli(["admin", "signal-defaults-sweep", "--help"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--limit");
      expect(result.stdout).toContain("--reset");
      expect(result.stdout).toContain("--json");
    } finally {
      server.stop();
    }
  });

  test("nemar admin --help lists both new sweep commands", async () => {
    const server = startCaptureServer([RECORDING_STATS_DONE]);
    try {
      const result = await runCli(["admin", "--help"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("recording-stats-sweep");
      expect(result.stdout).toContain("signal-defaults-sweep");
    } finally {
      server.stop();
    }
  });
});
