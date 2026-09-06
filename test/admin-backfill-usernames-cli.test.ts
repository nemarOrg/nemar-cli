/**
 * CLI `nemar admin backfill-usernames` (ADR 0042, #1253, epic #1250), driven
 * through the real entry point (`bun run src/index.ts admin ...`).
 *
 * The sweep is destructive-ish (it assigns handles and mails people), so the
 * two things pinned here are the ones an operator's decision rests on: that a
 * run without `--apply` says so loudly and sends `apply: false` on the wire,
 * and that a run which left work behind exits non-zero rather than reading as
 * a clean sweep.
 *
 * Harness mirrors test/admin-users-tier-cli.test.ts exactly: a real subprocess
 * CLI invocation pointed at a real local HTTP server via TEST_API_URL
 * (src/lib/api/client.ts#getApiUrl), no mocks.
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
  bodies: Record<string, unknown>[];
  stop: () => void;
}

function startServer(reply: unknown): CaptureServer {
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      if (url.pathname === "/admin/users/backfill-usernames") {
        bodies.push((await req.json().catch(() => ({}))) as Record<string, unknown>);
        return Response.json(reply);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://localhost:${server.port}`, bodies, stop: () => server.stop(true) };
}

const DRY_RUN_REPLY = {
  apply: false,
  scanned: 2,
  assigned: 0,
  would_assign: 2,
  single_name: 0,
  no_name: 0,
  lookup_failed: 0,
  conflict: 0,
  verify_sent: 0,
  remaining: 2,
  results: [
    {
      id: 21,
      email: "ada@example.org",
      orcid: "0000-0002-1825-0097",
      outcome: "would_assign",
      username: "alovelace",
      given_name: "Ada",
      family_name: "Lovelace",
      verify: "not_attempted",
    },
    {
      id: 22,
      email: "alan@example.org",
      orcid: null,
      outcome: "would_assign",
      username: "alovelace-2",
      given_name: "Alan",
      family_name: "Lovelace",
      verify: "not_attempted",
    },
  ],
};

let configDir: string;

function seedAuthenticatedConfig(): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "unameadmin",
      accounts: { unameadmin: { apiKey: "test-admin-key" } },
    }),
  );
}

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

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-backfill-usernames-cli-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("nemar admin backfill-usernames", () => {
  test("defaults to a dry run and says so", async () => {
    seedAuthenticatedConfig();
    const server = startServer(DRY_RUN_REPLY);
    try {
      const result = await runCli(["admin", "backfill-usernames"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.bodies[0]).toMatchObject({ apply: false, limit: 25 });
      expect(result.stdout).toContain("DRY RUN");
      // The plan an operator reads before executing it: both handles, with the
      // collision suffix already resolved.
      expect(result.stdout).toContain("alovelace");
      expect(result.stdout).toContain("alovelace-2");
    } finally {
      server.stop();
    }
  });

  test("--apply is what sets apply on the wire", async () => {
    seedAuthenticatedConfig();
    const server = startServer({
      ...DRY_RUN_REPLY,
      apply: true,
      assigned: 2,
      would_assign: 0,
      verify_sent: 1,
      remaining: 0,
      results: DRY_RUN_REPLY.results.map((r, i) => ({
        ...r,
        outcome: "assigned",
        verify: i === 0 ? "sent" : "skipped_fence",
      })),
    });
    try {
      const result = await runCli(["admin", "backfill-usernames", "--apply"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.bodies[0]).toMatchObject({ apply: true });
      expect(result.stdout).not.toContain("DRY RUN");
      // The verify outcome is printed per row: `skipped_fence` is the NORMAL
      // result outside production and reads as a failure if it is not named.
      expect(result.stdout).toContain("verify: sent");
      expect(result.stdout).toContain("verify: skipped_fence");
    } finally {
      server.stop();
    }
  });

  test("--limit is forwarded", async () => {
    seedAuthenticatedConfig();
    const server = startServer(DRY_RUN_REPLY);
    try {
      await runCli(["admin", "backfill-usernames", "--limit", "5"], server.url);
      expect(server.bodies[0]).toMatchObject({ limit: 5 });
    } finally {
      server.stop();
    }
  });

  test("a one-part name is reported for a human, and the reason is stated", async () => {
    seedAuthenticatedConfig();
    const server = startServer({
      ...DRY_RUN_REPLY,
      scanned: 1,
      would_assign: 0,
      single_name: 1,
      remaining: 1,
      results: [
        {
          id: 23,
          email: "prince@example.org",
          orcid: null,
          outcome: "single_name",
          given_name: "Prince",
          family_name: null,
          verify: "not_attempted",
        },
      ],
    });
    try {
      const result = await runCli(["admin", "backfill-usernames"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("one name");
      expect(result.stdout).toContain("pick a username by hand");
      // Why it is not guessed at, so the next operator does not "fix" it.
      expect(result.stdout).toContain("never guessed at");
    } finally {
      server.stop();
    }
  });

  test("a run that left work behind exits non-zero", async () => {
    seedAuthenticatedConfig();
    const server = startServer({
      ...DRY_RUN_REPLY,
      scanned: 1,
      would_assign: 0,
      lookup_failed: 1,
      remaining: 1,
      results: [
        {
          id: 24,
          email: "flaky@example.org",
          orcid: "0000-0002-1825-0097",
          outcome: "lookup_failed",
          verify: "not_attempted",
          error: "ORCID personal-details -> HTTP 503",
        },
      ],
    });
    try {
      const result = await runCli(["admin", "backfill-usernames"], server.url);
      // A transient failure must not read as a clean sweep to a script.
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("HTTP 503");
    } finally {
      server.stop();
    }
  });

  test("an unknown remainder is surfaced, not silently reported as done", async () => {
    seedAuthenticatedConfig();
    const server = startServer({
      ...DRY_RUN_REPLY,
      remaining: null,
      warning: "Could not count remaining candidates: D1_ERROR",
    });
    try {
      const result = await runCli(["admin", "backfill-usernames"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("remaining=unknown");
      expect(result.stdout).toContain("Could not count remaining candidates");
    } finally {
      server.stop();
    }
  });

  test("--json prints the raw response and nothing else", async () => {
    seedAuthenticatedConfig();
    const server = startServer(DRY_RUN_REPLY);
    try {
      const result = await runCli(["admin", "backfill-usernames", "--json"], server.url);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(DRY_RUN_REPLY);
    } finally {
      server.stop();
    }
  });
});
