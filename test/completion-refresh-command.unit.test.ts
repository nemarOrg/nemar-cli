/**
 * `nemar completion refresh` (epic #1144 phase 5b, issue #1149,
 * src/commands/completion.ts -- test-review follow-up on #1173).
 *
 * Neither path had coverage: the success path (facets fetched, cache file
 * written, green "refreshed" message) or the failure path (red error
 * message on stdout, exit 1). `test/completion-opportunistic-refresh.unit.test.ts`
 * only covers the FIRE-AND-FORGET refresh after `dataset list`/`search`,
 * which deliberately swallows every failure -- this command is the other
 * caller of the same `refreshCompletionCache()` (src/lib/completion/refresh.ts),
 * and it does the opposite: it awaits the result directly and reports it to
 * the user, so its own success/failure behaviour needs its own proof.
 *
 * Driven through the real CLI subprocess against a local Bun.serve stand-in
 * for `/datasets/facets` (same pattern as the opportunistic-refresh and
 * network test files), so this exercises the actual command's action
 * callback, not `refreshCompletionCache()` in isolation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

function startServer(status: number, body: unknown): { url: string; stop: () => void } {
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
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-completion-refresh-cmd-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

async function runRefresh(apiUrl: string): Promise<{ stdout: string; exitCode: number }> {
  const env = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: apiUrl,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  env.FORCE_COLOR = undefined;
  env.CLICOLOR_FORCE = undefined;
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, "completion", "refresh"],
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

function cachePath(): string {
  return join(configDir, "completion-cache.json");
}

describe("nemar completion refresh: success path", () => {
  test("writes the cache and prints a success message", async () => {
    const server = startServer(200, {
      task: { values: [{ value: "rest", count: 5 }], distinct_total: 1, truncated: false },
    });
    try {
      const result = await runRefresh(server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Completion cache refreshed.");
      expect(existsSync(cachePath())).toBe(true);
      const written = JSON.parse(readFileSync(cachePath(), "utf-8"));
      expect(written.data.task.values).toEqual([{ value: "rest", count: 5 }]);
    } finally {
      server.stop();
    }
  });
});

describe("nemar completion refresh: failure path", () => {
  test("an HTTP error prints a failure message, exits 1, and writes no cache", async () => {
    const server = startServer(500, { error: "internal error" });
    try {
      const result = await runRefresh(server.url);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Failed to refresh completion cache:");
      expect(existsSync(cachePath())).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("a response that fails the contract schema also fails cleanly, exits 1", async () => {
    // Right JSON, wrong shape: `task` must be {values,...}, not a bare array.
    const server = startServer(200, { task: ["not", "an", "object"] });
    try {
      const result = await runRefresh(server.url);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Failed to refresh completion cache:");
      expect(existsSync(cachePath())).toBe(false);
    } finally {
      server.stop();
    }
  });
});
