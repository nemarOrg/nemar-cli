/**
 * CLI `nemar admin zarr-fidelity-sweep` (issue #1068, epic #1181 phase 8),
 * driven through the real entry point (`bun run src/index.ts admin
 * zarr-fidelity-sweep ...`). Mirrors test/has-zarr-cli-flag.test.ts's
 * harness: a real subprocess CLI invocation pointed at a real local HTTP
 * server via TEST_API_URL (src/lib/api/client.ts#getApiUrl) -- the
 * recorded request is what the CLI's own `fetch()` actually sent, not a
 * re-implementation of it.
 *
 * Unlike the has_zarr flag (an unauthenticated GET /datasets filter), this
 * command is admin-only, so the harness also seeds a real config.json
 * ({activeAccount, accounts: {<name>: {apiKey}}}) into an isolated
 * NEMAR_CONFIG_DIR -- the same shape src/lib/config.ts's Conf store reads
 * (cwd: NEMAR_CONFIG_DIR) -- so isAuthenticated() is genuinely true rather
 * than stubbed.
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

function startCaptureServer(body: unknown, status = 200): CaptureServer {
  const requests: URL[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      // Real traffic every invocation fires that is not what these tests
      // check (mirrors has-zarr-cli-flag.test.ts's exclusions).
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
      activeAccount: "zfscliuser",
      accounts: { zfscliuser: { apiKey: "test-admin-key" } },
    }),
  );
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-zarr-fidelity-sweep-cli-"));
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

const VERIFIED_RESPONSE = {
  processed: 1,
  verified: 1,
  failed: 0,
  unverifiable: 0,
  results: [{ dataset_id: "on800001", verdict: "verified", sampled: 1, checked: 1, examples: [] }],
  errors: [],
  remaining: 0,
};

const FAILED_RESPONSE = {
  processed: 1,
  verified: 0,
  failed: 1,
  unverifiable: 0,
  results: [
    {
      dataset_id: "on800002",
      verdict: "failed",
      sampled: 1,
      checked: 1,
      examples: [{ path: "sub-01/eeg/sub-01_task-x_eeg.set", code: "channel_count_mismatch" }],
    },
  ],
  errors: [],
  remaining: 0,
};

describe("nemar admin zarr-fidelity-sweep: auth", () => {
  test("without a stored apiKey, requireAuth blocks before any request is sent", async () => {
    const server = startCaptureServer(VERIFIED_RESPONSE);
    try {
      const result = await runCli(["admin", "zarr-fidelity-sweep"], server.url);
      expect(result.stdout).toContain("Not authenticated");
      expect(server.requests.length).toBe(0);
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin zarr-fidelity-sweep: request shape", () => {
  test("--limit is forwarded as ?limit=N on the real request", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer(VERIFIED_RESPONSE);
    try {
      const result = await runCli(
        ["admin", "zarr-fidelity-sweep", "--limit", "10", "--json"],
        server.url,
      );
      expect(result.exitCode).toBe(0);
      expect(server.requests.length).toBe(1);
      expect(server.requests[0].pathname).toBe("/admin/datasets/zarr-fidelity-sweep");
      expect(server.requests[0].searchParams.get("limit")).toBe("10");
    } finally {
      server.stop();
    }
  });

  test("without --limit, the CLI's own default (25) is sent", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer(VERIFIED_RESPONSE);
    try {
      const result = await runCli(["admin", "zarr-fidelity-sweep", "--json"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests[0].searchParams.get("limit")).toBe("25");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin zarr-fidelity-sweep: output and exit code", () => {
  test("--json prints the raw response verbatim", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer(VERIFIED_RESPONSE);
    try {
      const result = await runCli(["admin", "zarr-fidelity-sweep", "--json"], server.url);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(VERIFIED_RESPONSE);
    } finally {
      server.stop();
    }
  });

  test("the human summary prints each dataset's verdict", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer(VERIFIED_RESPONSE);
    try {
      const result = await runCli(["admin", "zarr-fidelity-sweep"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("verified");
      expect(result.stdout).toContain("on800001");
      expect(result.stdout).toContain("processed=1");
    } finally {
      server.stop();
    }
  });

  test("a 'failed' verdict prints its mismatch examples and still exits 0 (the sweep succeeded; it reported the truth)", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer(FAILED_RESPONSE);
    try {
      const result = await runCli(["admin", "zarr-fidelity-sweep"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("failed");
      expect(result.stdout).toContain("on800002");
      expect(result.stdout).toContain("channel_count_mismatch");
    } finally {
      server.stop();
    }
  });

  test("a non-empty errors array exits non-zero", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({
      processed: 1,
      verified: 0,
      failed: 0,
      unverifiable: 0,
      results: [],
      errors: [{ dataset_id: "on800003", error: "s3: simulated timeout" }],
      remaining: 0,
    });
    try {
      const result = await runCli(["admin", "zarr-fidelity-sweep", "--json"], server.url);
      expect(result.exitCode).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("a null remaining count exits non-zero (an uncertain sweep is never reported as success)", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({
      processed: 1,
      verified: 1,
      failed: 0,
      unverifiable: 0,
      results: [
        { dataset_id: "on800001", verdict: "verified", sampled: 1, checked: 1, examples: [] },
      ],
      errors: [],
      remaining: null,
    });
    try {
      const result = await runCli(["admin", "zarr-fidelity-sweep", "--json"], server.url);
      expect(result.exitCode).toBe(1);
    } finally {
      server.stop();
    }
  });
});
