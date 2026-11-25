/**
 * CLI `nemar admin notice clear <id>`: a declined or non-interactive confirmation must not delete.
 * `confirm()` returns the strings "confirmed", "declined" or "cancelled", all truthy, so the caller
 * has to compare against "confirmed". Driven through the real entry point against a local HTTP
 * server via TEST_API_URL (a provably fake host), with an isolated NEMAR_CONFIG_DIR.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-admin-notice-clear-cli-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "noticeadmin",
      accounts: { noticeadmin: { apiKey: "test-admin-key" } },
    }),
  );
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function startServer() {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      requests.push(`${req.method} ${url.pathname}`);
      if (req.method === "DELETE" && url.pathname === "/admin/notices/5") {
        return Response.json({ message: "Notice deleted" });
      }
      return new Response("{}", { status: 404 });
    },
  });
  return { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) };
}

async function runCli(args: string[], testApiUrl: string) {
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
  return { stdout, stderr, exitCode: await proc.exited };
}

describe("nemar admin notice clear", () => {
  test("--yes deletes the notice", async () => {
    const server = startServer();
    try {
      const r = await runCli(["admin", "notice", "clear", "5", "--yes"], server.url);
      expect(r.exitCode).toBe(0);
      expect(server.requests).toContain("DELETE /admin/notices/5");
    } finally {
      server.stop();
    }
  });

  test("--no declines: nothing is deleted", async () => {
    const server = startServer();
    try {
      await runCli(["admin", "notice", "clear", "5", "--no"], server.url);
      expect(server.requests).not.toContain("DELETE /admin/notices/5");
    } finally {
      server.stop();
    }
  });

  test("without a terminal and without --yes nothing is deleted", async () => {
    const server = startServer();
    try {
      await runCli(["admin", "notice", "clear", "5"], server.url);
      expect(server.requests).not.toContain("DELETE /admin/notices/5");
    } finally {
      server.stop();
    }
  });
});
