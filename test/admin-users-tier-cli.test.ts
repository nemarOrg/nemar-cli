/**
 * CLI `nemar admin users` tier rendering and filters (ADR 0040, #1251),
 * driven through the real entry point (`bun run src/index.ts admin users`).
 *
 * Two things this pins that nothing else can:
 *   - a web/ORCID row has username = NULL and github_username = NULL on the
 *     wire, and the listing used to interpolate those straight into the
 *     output, printing the literal "null" where a name and a handle belong;
 *   - the tier column, which is the only thing in the listing that separates
 *     an uploader from a browse-only account now that `status` no longer does
 *     (#1249).
 *
 * Harness mirrors test/hed-sweep-cli.test.ts exactly: a real subprocess CLI
 * invocation pointed at a real local HTTP server via TEST_API_URL
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
  requests: URL[];
  stop: () => void;
}

function startUsersServer(users: unknown[]): CaptureServer {
  const requests: URL[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") {
        return Response.json({ notices: [] });
      }
      if (url.pathname === "/datasets/facets") {
        return Response.json({});
      }
      requests.push(url);
      // Mirror the real route: `status` filters server-side, the tier filters
      // do not (they are applied by the CLI over the returned rows).
      const status = url.searchParams.get("status");
      const filtered = status
        ? users.filter((u) => (u as { status: string }).status === status)
        : users;
      return Response.json({ users: filtered, count: filtered.length });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

/** A CLI account: username and GitHub handle present. */
const CLI_UPLOADER = {
  id: 7,
  username: "riverstone",
  email: "riverstone@example.org",
  github_username: "riverstone-gh",
  status: "approved",
  email_verified: 1,
  role: "member",
  created_at: "2026-03-01T00:00:00Z",
  approved_at: "2026-03-02T00:00:00Z",
  revoked_at: null,
  signup_source: "cli",
  service_access: 1,
  service_access_granted_at: "2026-03-02T00:00:00Z",
  given_name: "Ada",
  family_name: "Riverstone",
  orcid: "0000-0002-1825-0097",
};

/** A web/ORCID account: username and GitHub handle are NULL by design (#1012). */
const WEB_BROWSER = {
  id: 8,
  username: null,
  email: "quillon@example.org",
  github_username: null,
  status: "verified",
  email_verified: 1,
  role: "member",
  created_at: "2026-04-01T00:00:00Z",
  approved_at: null,
  revoked_at: null,
  signup_source: "web",
  service_access: 0,
  service_access_granted_at: null,
  given_name: "Mira",
  family_name: "Quillon",
  orcid: "0000-0001-5109-3700",
};

/** A CLI account still at the base tier. */
const CLI_BROWSER = {
  ...CLI_UPLOADER,
  id: 9,
  username: "tolliver",
  email: "tolliver@example.org",
  github_username: "tolliver-gh",
  status: "verified",
  service_access: 0,
  service_access_granted_at: null,
  approved_at: null,
  given_name: "Ben",
  family_name: "Tolliver",
};

/**
 * `verified` while holding the grant. Migration 0075 removes this shape and the
 * routes maintain the invariant, so it should not exist -- which is exactly why
 * the fixture is here: without it the server-side `status=verified` filter
 * alone satisfies --awaiting-approval's assertions and the CLI's own tier
 * filter could be deleted with the test still green.
 */
const VERIFIED_BUT_GRANTED = {
  ...CLI_UPLOADER,
  id: 10,
  username: "ashgrove",
  email: "ashgrove@example.org",
  github_username: "ashgrove-gh",
  status: "verified",
  service_access: 1,
};

let configDir: string;

function seedAuthenticatedConfig(): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "tieradmin",
      accounts: { tieradmin: { apiKey: "test-admin-key" } },
    }),
  );
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-admin-users-cli-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

/** One user's entry: from the line carrying `marker` to the blank line that
 *  ends the entry. Throws rather than returning "" so a marker that stopped
 *  appearing fails as a missing entry instead of a silently empty match. */
function entryContaining(stdout: string, marker: string): string {
  const lines = stdout.split("\n");
  const start = lines.findIndex((l) => l.includes(marker));
  if (start === -1) throw new Error(`no listing entry contains ${marker}`);
  const rest = lines.slice(start);
  const end = rest.findIndex((l, i) => i > 0 && l.trim() === "");
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
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

describe("nemar admin users: null fields", () => {
  test("a username-less web row shows its email and id, never the word null", async () => {
    seedAuthenticatedConfig();
    const server = startUsersServer([WEB_BROWSER]);
    try {
      const result = await runCli(["admin", "users"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("quillon@example.org");
      expect(result.stdout).toContain("no username, id 8");
      // The bug: `${user.username}` and `@${user.github_username}` on NULLs.
      expect(result.stdout).not.toContain("null");
      expect(result.stdout).not.toContain("@null");
    } finally {
      server.stop();
    }
  });

  test("a missing GitHub handle renders as a dash", async () => {
    seedAuthenticatedConfig();
    const server = startUsersServer([WEB_BROWSER]);
    try {
      const result = await runCli(["admin", "users"], server.url);
      expect(result.stdout).toContain("GitHub:  -");
    } finally {
      server.stop();
    }
  });

  test("a CLI row still renders its username and @handle", async () => {
    seedAuthenticatedConfig();
    const server = startUsersServer([CLI_UPLOADER]);
    try {
      const result = await runCli(["admin", "users"], server.url);
      expect(result.stdout).toContain("riverstone");
      expect(result.stdout).toContain("GitHub:  @riverstone-gh");
      expect(result.stdout).not.toContain("no username");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin users: tier column", () => {
  test("service_access renders as upload, its absence as browse", async () => {
    seedAuthenticatedConfig();
    const server = startUsersServer([CLI_UPLOADER, WEB_BROWSER]);
    try {
      const result = await runCli(["admin", "users"], server.url);
      // Tier is printed after Email inside the same entry, so slicing from the
      // (unique) email to the blank line that ends the entry keeps the two
      // users' tiers from being read off each other's block.
      expect(entryContaining(result.stdout, "riverstone@example.org")).toContain("Tier:    upload");
      expect(entryContaining(result.stdout, "quillon@example.org")).toContain("Tier:    browse");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin users: tier filters", () => {
  test("--no-upload-access drops the accounts that hold the grant", async () => {
    seedAuthenticatedConfig();
    const server = startUsersServer([CLI_UPLOADER, WEB_BROWSER, CLI_BROWSER]);
    try {
      const result = await runCli(["admin", "users", "--no-upload-access"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("riverstone");
      expect(result.stdout).toContain("quillon@example.org");
      expect(result.stdout).toContain("tolliver");
      // The header counts what is shown, not what the server returned.
      expect(result.stdout).toContain("(2 total, filter: no-upload-access)");
      // Filtering is client-side, so no new query param goes on the wire.
      expect(server.requests[0].searchParams.get("status")).toBeNull();
    } finally {
      server.stop();
    }
  });

  test("--awaiting-approval asks the server for verified and drops any grant holder", async () => {
    seedAuthenticatedConfig();
    const server = startUsersServer([CLI_UPLOADER, WEB_BROWSER, CLI_BROWSER, VERIFIED_BUT_GRANTED]);
    try {
      const result = await runCli(["admin", "users", "--awaiting-approval"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests[0].searchParams.get("status")).toBe("verified");
      expect(result.stdout).toContain("quillon@example.org");
      expect(result.stdout).toContain("tolliver");
      expect(result.stdout).not.toContain("riverstone");
      // Dropped by the CLI's own tier filter, not by the server's status filter.
      expect(result.stdout).not.toContain("ashgrove");
      expect(result.stdout).toContain("filter: verified, awaiting-approval");
    } finally {
      server.stop();
    }
  });

  test("--awaiting-approval with a conflicting status flag is refused", async () => {
    seedAuthenticatedConfig();
    const server = startUsersServer([CLI_UPLOADER]);
    try {
      const result = await runCli(
        ["admin", "users", "--awaiting-approval", "--approved"],
        server.url,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--awaiting-approval implies --verified");
      expect(server.requests.length).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("an empty tier-filtered result says which filter emptied it", async () => {
    seedAuthenticatedConfig();
    const server = startUsersServer([CLI_UPLOADER]);
    try {
      const result = await runCli(["admin", "users", "--no-upload-access"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No users found (filter: no-upload-access)");
    } finally {
      server.stop();
    }
  });
});
