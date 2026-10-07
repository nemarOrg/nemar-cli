/**
 * The identifier sweep's mail category in the terminal (epic #1610, phase 5,
 * ADR 0088), driven through the real CLI entry point.
 *
 * Same harness as test/identifier-screen-cli.test.ts: a real subprocess
 * (`bun run src/index.ts ...`) pointed at a local HTTP server that answers with
 * the backend's response shape, so what is asserted is what the CLI sends and
 * prints. The rule it holds: `--all false` turns the weekly report off too, and
 * the category can be shown and changed on its own.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

const PREFS = {
  user_approval: true,
  publication_request: true,
  announcements: true,
  dataset_anonymity: true,
  identifier_sweep: true,
};

function startServer() {
  const puts: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/admin/email-preferences" && req.method === "GET") {
        return Response.json({ ...PREFS, identifier_sweep: false });
      }
      if (url.pathname === "/admin/email-preferences" && req.method === "PUT") {
        const body = (await req.json()) as Record<string, boolean>;
        puts.push(body);
        return Response.json({ ...PREFS, ...body });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return { url: `http://localhost:${server.port}`, puts, stop: () => server.stop(true) };
}

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-sweep-cli-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ activeAccount: "sweepcli", accounts: { sweepcli: { apiKey: "k" } } }),
  );
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

async function runCli(args: string[], apiUrl: string) {
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

describe("nemar admin email-preferences and the identifier sweep", () => {
  test("show lists the weekly report and its state", async () => {
    const server = startServer();
    try {
      const r = await runCli(["admin", "email-preferences", "show"], server.url);
      expect(r.exitCode).toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/Identifier sweep weekly report\s+disabled/);
    } finally {
      server.stop();
    }
  });

  test("--all false turns the weekly report off with everything else", async () => {
    const server = startServer();
    try {
      const r = await runCli(
        ["admin", "email-preferences", "update", "--all", "false"],
        server.url,
      );
      expect(r.exitCode).toBe(0);
      expect(server.puts).toEqual([
        {
          user_approval: false,
          publication_request: false,
          announcements: false,
          dataset_anonymity: false,
          identifier_sweep: false,
        },
      ]);
      expect(`${r.stdout}${r.stderr}`).toMatch(/Identifier sweep:\s+disabled/);
    } finally {
      server.stop();
    }
  });

  test("--identifier-sweep changes that one category alone", async () => {
    const server = startServer();
    try {
      const r = await runCli(
        ["admin", "email-preferences", "update", "--identifier-sweep", "off"],
        server.url,
      );
      expect(r.exitCode).toBe(0);
      expect(server.puts).toEqual([{ identifier_sweep: false }]);
    } finally {
      server.stop();
    }
  });
});
