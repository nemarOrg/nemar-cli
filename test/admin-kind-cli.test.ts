/**
 * CLI `nemar admin users --kind`, the `Kind:` row line, `nemar admin kind`,
 * and `nemar auth status`'s `Kind:` line (epic #1272 phase 4, #1284; ADR
 * 0048), driven through the real entry point (`bun run src/index.ts ...`).
 *
 * Harness mirrors test/admin-approve-tier-cli.test.ts / test/admin-users-tier-cli.test.ts:
 * a real subprocess CLI invocation against a real local HTTP server via
 * TEST_API_URL, isolated NEMAR_CONFIG_DIR, no mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

let configDir: string;

function seedAuthenticatedConfig(): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "kindcliowner",
      accounts: { kindcliowner: { apiKey: "test-owner-key" } },
    }),
  );
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-admin-kind-cli-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

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
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      requests.push(url);
      const kind = url.searchParams.get("kind");
      const filtered = kind
        ? users.filter((u) => (u as { account_kind?: string }).account_kind === kind)
        : users;
      return Response.json({ users: filtered, count: filtered.length });
    },
  });
  return { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) };
}

function startKindServer(body: unknown, status = 200): CaptureServer {
  const requests: URL[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      requests.push(url);
      return Response.json(body, { status });
    },
  });
  return { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) };
}

const PERSON_USER = {
  id: 1,
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
  account_kind: "person",
};

const TEST_PERSONA_USER = {
  ...PERSON_USER,
  id: 2,
  username: "cool-vibers",
  email: "cool-vibers@example.org",
  github_username: "cool-vibers-gh",
  given_name: "Cool",
  family_name: "Vibers",
  account_kind: "test",
};

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

describe("nemar admin users --kind", () => {
  test("sends the kind query param and narrows the listing", async () => {
    seedAuthenticatedConfig();
    const server = startUsersServer([PERSON_USER, TEST_PERSONA_USER]);
    try {
      const result = await runCli(["admin", "users", "--kind", "test"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests.some((u) => u.searchParams.get("kind") === "test")).toBe(true);
      expect(result.stdout).toContain("cool-vibers");
      expect(result.stdout).not.toContain("riverstone");
    } finally {
      server.stop();
    }
  });

  test("an invalid --kind value is refused at the Commander boundary, no request sent", async () => {
    seedAuthenticatedConfig();
    const server = startUsersServer([PERSON_USER]);
    try {
      const result = await runCli(["admin", "users", "--kind", "bogus"], server.url);
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("Invalid kind");
      expect(server.requests).toHaveLength(0);
    } finally {
      server.stop();
    }
  });

  test("the Kind: row line prints only for a non-person account", async () => {
    seedAuthenticatedConfig();
    const server = startUsersServer([PERSON_USER, TEST_PERSONA_USER]);
    try {
      const result = await runCli(["admin", "users"], server.url);
      const entries = result.stdout.split(/\n\s*\n/).filter((e) => e.trim() !== "");
      const personEntry = entries.find((e) => e.includes("riverstone"));
      const testEntry = entries.find((e) => e.includes("cool-vibers"));
      expect(personEntry).toBeDefined();
      expect(testEntry).toBeDefined();
      expect(personEntry).not.toContain("Kind:");
      expect(testEntry).toContain("Kind:");
      expect(testEntry).toContain("test");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin kind", () => {
  test("--yes skips the confirmation prompt and prints the server's message", async () => {
    seedAuthenticatedConfig();
    const server = startKindServer({
      message: "User cool-vibers account kind changed from 'person' to 'test'",
      user: { username: "cool-vibers", account_kind: "test" },
    });
    try {
      const result = await runCli(["admin", "kind", "cool-vibers", "test", "--yes"], server.url);
      expect(result.exitCode).toBe(0);
      // ora's spinner writes to stderr under a non-TTY pipe (as every other
      // ora-only success line in this CLI does); the combined stream is what
      // a terminal user actually sees.
      expect(`${result.stdout}${result.stderr}`).toContain(
        "account kind changed from 'person' to 'test'",
      );
      expect(server.requests.some((u) => u.pathname === "/admin/users/cool-vibers/kind")).toBe(
        true,
      );
    } finally {
      server.stop();
    }
  });

  test("an invalid kind argument is refused before any request", async () => {
    seedAuthenticatedConfig();
    const server = startKindServer({ message: "unused" });
    try {
      const result = await runCli(["admin", "kind", "cool-vibers", "bogus", "--yes"], server.url);
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("Invalid kind");
      expect(server.requests).toHaveLength(0);
    } finally {
      server.stop();
    }
  });

  test("--no skips the request entirely", async () => {
    seedAuthenticatedConfig();
    const server = startKindServer({ message: "unused" });
    try {
      const result = await runCli(["admin", "kind", "cool-vibers", "test", "--no"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests).toHaveLength(0);
    } finally {
      server.stop();
    }
  });

  test("a 403 from the server surfaces the owner-access hint", async () => {
    seedAuthenticatedConfig();
    const server = startKindServer({ error: "Owner access required" }, 403);
    try {
      const result = await runCli(["admin", "kind", "cool-vibers", "test", "--yes"], server.url);
      expect(`${result.stdout}${result.stderr}`).toContain("Owner access required");
    } finally {
      server.stop();
    }
  });
});

describe("nemar auth status: Kind:", () => {
  function startMeServer(accountKind: string | undefined) {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/notices") return Response.json({ notices: [] });
        if (url.pathname === "/datasets/facets") return Response.json({});
        return Response.json({
          user: {
            id: 2,
            username: "cool-vibers",
            email: "cool-vibers@example.org",
            github_username: "cool-vibers-gh",
            role: "member",
            orcid: null,
            created_at: "2026-05-01T00:00:00Z",
            approved_at: null,
            dataset_count: 0,
            sandbox_completed: true,
            sandbox_completed_at: null,
            sandbox_dataset_id: null,
            ...(accountKind === undefined ? {} : { account_kind: accountKind }),
          },
          token: null,
        });
      },
    });
    return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
  }

  function seedUserConfig(): void {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        activeAccount: "cool-vibers",
        accounts: { "cool-vibers": { apiKey: "test-user-key", username: "cool-vibers" } },
      }),
    );
  }

  test("--refresh against a test-kind account prints Kind: test", async () => {
    seedUserConfig();
    const server = startMeServer("test");
    try {
      const result = await runCli(["auth", "status", "--refresh"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Kind:");
      expect(result.stdout).toContain("test");
    } finally {
      server.stop();
    }
  });

  test("--refresh against a person account prints no Kind: line", async () => {
    seedUserConfig();
    const server = startMeServer("person");
    try {
      const result = await runCli(["auth", "status", "--refresh"], server.url);
      expect(result.stdout).not.toContain("Kind:");
    } finally {
      server.stop();
    }
  });

  test("a backend that omits account_kind prints no Kind: line", async () => {
    seedUserConfig();
    const server = startMeServer(undefined);
    try {
      const result = await runCli(["auth", "status", "--refresh"], server.url);
      expect(result.stdout).not.toContain("Kind:");
    } finally {
      server.stop();
    }
  });
});
