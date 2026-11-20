/**
 * `nemar admin email-preferences` and the community mail categories (epic #2260 phase 1, ADR 0132),
 * driven through the real CLI entry point.
 *
 * Same harness as test/identifier-sweep-cli.test.ts: a real subprocess (`bun run src/index.ts ...`)
 * pointed at a local HTTP server that answers with the backend's response shape, so what is
 * asserted is what the CLI sends and prints. The rules it holds: `--news`, `--rfcs` and
 * `--maintenance` change one category each; `--announcements` is refused with the replacement flags
 * and sends nothing; `--all` includes the three categories; a recall is shown as always on with
 * the sentence that says why; and an admin reading another account sees no admin-alert rows.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { mailRecallWhy } from "../shared/contract/mail-categories";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

const FULL = {
  user_approval: true,
  publication_request: true,
  dataset_anonymity: true,
  identifier_sweep: true,
  support_tickets: true,
  news: true,
  rfcs: false,
  maintenance: true,
  recall: { on: true, locked: true },
};

/** What an admin who is not an owner gets for another account: community categories only. */
const COMMUNITY_ONLY = {
  news: false,
  rfcs: true,
  maintenance: true,
  recall: { on: true, locked: true },
  username: "someone",
};

function startServer() {
  const requests: Array<{ method: string; search: string; body?: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname !== "/admin/email-preferences") {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      const other = url.searchParams.get("user");
      if (req.method === "GET") {
        requests.push({ method: "GET", search: url.search });
        return Response.json(other ? COMMUNITY_ONLY : FULL);
      }
      const body = (await req.json()) as Record<string, boolean>;
      requests.push({ method: "PUT", search: url.search, body });
      return Response.json({ ...(other ? COMMUNITY_ONLY : FULL), ...body });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    requests,
    puts: () => requests.filter((r) => r.method === "PUT"),
    stop: () => server.stop(true),
  };
}

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-mailprefs-cli-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ activeAccount: "mailcli", accounts: { mailcli: { apiKey: "k" } } }),
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

describe("show", () => {
  test("lists the three categories with their state, and a recall as always on with why", async () => {
    const server = startServer();
    try {
      const r = await runCli(["admin", "email-preferences", "show"], server.url);
      const out = `${r.stdout}${r.stderr}`;
      expect(r.exitCode).toBe(0);
      expect(out).toMatch(/News\s+enabled/);
      expect(out).toMatch(/Requests for comments\s+disabled/);
      expect(out).toMatch(/Maintenance\s+enabled/);
      expect(out).toMatch(/Recalls\s+always on/);
      expect(out).toContain(mailRecallWhy());
      // The admin alerts are still listed, and the retired line is gone.
      expect(out).toMatch(/Identifier sweep weekly report\s+enabled/);
      expect(out).not.toMatch(/Announcement/);
    } finally {
      server.stop();
    }
  });

  test("an admin reading another account sees no admin-alert rows, only the categories", async () => {
    const server = startServer();
    try {
      const r = await runCli(
        ["admin", "email-preferences", "show", "--user", "someone"],
        server.url,
      );
      const out = `${r.stdout}${r.stderr}`;
      expect(r.exitCode).toBe(0);
      expect(server.requests[0].search).toBe("?user=someone");
      expect(out).toMatch(/News\s+disabled/);
      expect(out).toMatch(/Recalls\s+always on/);
      expect(out).not.toMatch(/Identifier sweep|User approval|Support tickets/);
    } finally {
      server.stop();
    }
  });
});

describe("update", () => {
  test("--news off changes that one category and nothing else", async () => {
    const server = startServer();
    try {
      const r = await runCli(["admin", "email-preferences", "update", "--news", "off"], server.url);
      expect(r.exitCode).toBe(0);
      expect(server.puts().map((p) => p.body)).toEqual([{ news: false }]);
      expect(`${r.stdout}${r.stderr}`).toMatch(/News:\s+disabled/);
    } finally {
      server.stop();
    }
  });

  test("--rfcs and --maintenance are separate flags, sent together when given together", async () => {
    const server = startServer();
    try {
      const r = await runCli(
        ["admin", "email-preferences", "update", "--rfcs", "on", "--maintenance", "false"],
        server.url,
      );
      expect(r.exitCode).toBe(0);
      expect(server.puts().map((p) => p.body)).toEqual([{ rfcs: true, maintenance: false }]);
    } finally {
      server.stop();
    }
  });

  test("--all false includes the three categories and never names a recall", async () => {
    const server = startServer();
    try {
      const r = await runCli(
        ["admin", "email-preferences", "update", "--all", "false"],
        server.url,
      );
      expect(r.exitCode).toBe(0);
      const body = server.puts()[0].body as Record<string, boolean>;
      expect(body).toEqual({
        user_approval: false,
        publication_request: false,
        dataset_anonymity: false,
        identifier_sweep: false,
        support_tickets: false,
        news: false,
        rfcs: false,
        maintenance: false,
      });
      expect("recall" in body).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("--announcements is refused, names the replacement flags, and sends nothing", async () => {
    const server = startServer();
    try {
      const r = await runCli(
        ["admin", "email-preferences", "update", "--announcements", "false"],
        server.url,
      );
      expect(r.exitCode).toBe(1);
      expect(`${r.stdout}${r.stderr}`).toContain("--news, --rfcs and --maintenance");
      expect(server.requests).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("with --user the request carries ?user= and a community flag (an admin may turn one on)", async () => {
    const server = startServer();
    try {
      const r = await runCli(
        ["admin", "email-preferences", "update", "--user", "someone", "--news", "on"],
        server.url,
      );
      expect(r.exitCode).toBe(0);
      expect(server.puts()).toEqual([
        { method: "PUT", search: "?user=someone", body: { news: true } },
      ]);
      expect(`${r.stdout}${r.stderr}`).not.toMatch(/Identifier sweep|User approval/);
    } finally {
      server.stop();
    }
  });

  test("no flag at all is refused with the list, including the new ones", async () => {
    const server = startServer();
    try {
      const r = await runCli(["admin", "email-preferences", "update"], server.url);
      expect(r.exitCode).toBe(1);
      const out = `${r.stdout}${r.stderr}`;
      expect(out).toContain("--news <bool>");
      expect(out).toContain("--maintenance <bool>");
      expect(out).not.toContain("--announcements");
      expect(server.requests).toEqual([]);
    } finally {
      server.stop();
    }
  });
});
