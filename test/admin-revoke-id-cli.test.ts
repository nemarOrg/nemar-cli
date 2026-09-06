/**
 * CLI `nemar admin revoke` addressing (#1274), driven through the real entry
 * point (`bun run src/index.ts admin revoke ...`).
 *
 * `admin approve` grew `--id` for web/ORCID accounts, whose username is NULL by
 * design (#1012), and `admin revoke` did not — so an account approval could
 * reach was one revocation could not. ADR 0040 makes revoke the eraser of what
 * approval writes, which only holds if both commands address the same accounts.
 * These pin the addressing rule (exactly one of username or --id, checked
 * before the auth gate) and the endpoint each one calls.
 *
 * Harness mirrors test/admin-approve-tier-cli.test.ts: a real subprocess CLI
 * invocation against a real local HTTP server via TEST_API_URL, isolated
 * NEMAR_CONFIG_DIR, no mocks. `--yes` skips the typed confirmation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

interface RevokeServer {
  url: string;
  requests: string[];
  stop: () => void;
}

function startRevokeServer(body: unknown): RevokeServer {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      requests.push(url.pathname);
      return Response.json(body);
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

/** What the by-id route answers for a web account: no username anywhere. */
const NAMELESS_BODY = {
  message: "User id 31 access has been fully revoked",
  user: { id: 31, username: null, status: "revoked" },
  repos_removed: 0,
  email_sent: false,
  iam_revoked: false,
};

const NAMED_BODY = {
  message: "User halloway access has been fully revoked",
  user: { id: 31, username: "halloway", status: "revoked" },
  repos_removed: 0,
  email_sent: false,
  iam_revoked: false,
};

let configDir: string;

function seedAuthenticatedConfig(): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "revokecliadmin",
      accounts: { revokecliadmin: { apiKey: "test-admin-key" } },
    }),
  );
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-admin-revoke-cli-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

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
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("nemar admin revoke: addressing", () => {
  test("--id revokes by numeric id", async () => {
    seedAuthenticatedConfig();
    const server = startRevokeServer(NAMELESS_BODY);
    try {
      const result = await runCli(["admin", "revoke", "--id", "31", "--yes"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests).toContain("/admin/revoke/by-id/31");
      // The account has no username, so every line the admin sees names the id
      // instead. (The spinner writes to stderr; the warning block to stdout.)
      expect(result.stdout).toContain("Revoking access for: user id 31");
      expect(result.stderr).toContain("Revoked access for user id 31");
    } finally {
      server.stop();
    }
  });

  test("--no declines and calls nothing", async () => {
    // The typed-confirmation gate is what stands between a mistyped id and a
    // revoked account, so it has to be reachable on this path too.
    seedAuthenticatedConfig();
    const server = startRevokeServer(NAMELESS_BODY);
    try {
      const result = await runCli(["admin", "revoke", "--id", "31", "--no"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests).not.toContain("/admin/revoke/by-id/31");
      expect(result.stdout).toContain("Skipped");
    } finally {
      server.stop();
    }
  });

  test("a username still revokes by username (regression)", async () => {
    seedAuthenticatedConfig();
    const server = startRevokeServer(NAMED_BODY);
    try {
      const result = await runCli(["admin", "revoke", "halloway", "--yes"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests).toContain("/admin/revoke/halloway");
      expect(server.requests).not.toContain("/admin/revoke/by-id/halloway");
      expect(result.stderr).toContain("Revoked access for halloway");
    } finally {
      server.stop();
    }
  });

  test("the confirmation says upload access goes too", async () => {
    // ADR 0040: revoke is the eraser of what approval wrote, and the backend
    // clears the grant. An admin reading the warning should know that.
    seedAuthenticatedConfig();
    const server = startRevokeServer(NAMED_BODY);
    try {
      const result = await runCli(["admin", "revoke", "halloway", "--yes"], server.url);
      expect(result.stdout).toContain("Revoke upload access");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin revoke: the exactly-one-of rule", () => {
  // Enforced by the action before the auth gate, like `admin approve`'s, so
  // these run without a seeded config and never reach the network.
  const UNREACHABLE = "http://127.0.0.1:1";

  test("neither a username nor --id is refused", async () => {
    const result = await runCli(["admin", "revoke"], UNREACHABLE);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("provide a username or --id");
  });

  test("both a username and --id is refused", async () => {
    const result = await runCli(["admin", "revoke", "someone", "--id", "5"], UNREACHABLE);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("mutually exclusive");
  });

  test("a non-numeric --id is refused before anything is revoked", async () => {
    const result = await runCli(["admin", "revoke", "--id", "abc", "--yes"], UNREACHABLE);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid user id");
  });
});
