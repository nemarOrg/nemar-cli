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
import { OPERATIONAL_ACCOUNT_KINDS } from "../shared/contract/user.js";

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

/** A stand-in for a backend that predates `?kind=` (epic #1272 phase 4,
 *  #1284 review): it records the query string but always returns every
 *  user, unfiltered -- proving the CLI's own client-side re-filter is what
 *  narrows the listing, not the (ignored) server param. */
function startUsersServerIgnoringKind(users: unknown[]): CaptureServer {
  const requests: URL[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      requests.push(url);
      return Response.json({ users, count: users.length });
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

  test("re-filters client-side, so a backend that ignores ?kind= cannot mislabel the listing", async () => {
    seedAuthenticatedConfig();
    const server = startUsersServerIgnoringKind([PERSON_USER, TEST_PERSONA_USER]);
    try {
      const result = await runCli(["admin", "users", "--kind", "test"], server.url);
      expect(result.exitCode).toBe(0);
      // The param was still SENT (a newer client talking to an older
      // backend costs nothing extra) -- it is just not trusted alone.
      expect(server.requests.some((u) => u.searchParams.get("kind") === "test")).toBe(true);
      expect(result.stdout).toContain("cool-vibers");
      expect(result.stdout).not.toContain("riverstone");
      expect(result.stdout).toContain("1 total");
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

  test("a 409 orcid_linked refusal prints the SENTENCE a person reads, not just the bare code", async () => {
    // Epic #1272 phase 4 (#1284 review; ADR 0048): every kind-route refusal
    // is `{ error: <code>, message }`, and `nemar admin kind` must show the
    // MESSAGE -- the bare code `orcid_linked` on its own tells nobody what
    // to do next.
    seedAuthenticatedConfig();
    const server = startKindServer(
      {
        error: "orcid_linked",
        message:
          "An ORCID iD identifies a person, and this account has one verified and linked. Run `nemar auth profile orcid unlink` on that account first, then retry.",
      },
      409,
    );
    try {
      const result = await runCli(["admin", "kind", "cool-vibers", "service", "--yes"], server.url);
      const combined = `${result.stdout}${result.stderr}`;
      expect(combined).toContain(
        "An ORCID iD identifies a person, and this account has one verified and linked.",
      );
      expect(combined).toContain("nemar auth profile orcid unlink");
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

  function seedUserConfig(extra: Record<string, unknown> = {}): void {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        activeAccount: "cool-vibers",
        accounts: {
          "cool-vibers": { apiKey: "test-user-key", username: "cool-vibers", ...extra },
        },
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

  test("--refresh against a service-kind account prints Kind: service", async () => {
    seedUserConfig();
    const server = startMeServer("service");
    try {
      const result = await runCli(["auth", "status", "--refresh"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Kind:");
      expect(result.stdout).toContain("service");
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

  test("without --refresh, a cached test kind from a prior refresh is NOT printed (#1284 review)", async () => {
    // src/commands/auth.ts: `userKind` is a local variable set ONLY inside
    // the `--refresh` branch -- the `Kind:` line is never driven by the
    // cached `accountKind` config field this same seed simulates having been
    // written by an earlier `auth status --refresh` or `auth login`. This is
    // the deliberate shipped behavior (see the field's own comment in
    // src/lib/config.ts), not a gap: a plain `auth status` makes no network
    // call for this field and so has nothing fresher to report than what a
    // stale cached value might already be wrong about.
    seedUserConfig({ accountKind: "test" });
    const server = startMeServer("test");
    try {
      const result = await runCli(["auth", "status"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("Kind:");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin doctor kinds", () => {
  /** Stand-in for `GET /admin/users/:username`, the one endpoint `nemar
   *  admin doctor kinds` calls once per entry of OPERATIONAL_ACCOUNT_KINDS
   *  (#1284 review). `users` maps username -> the kind the stand-in should
   *  report for it; a username with no entry answers 404, exactly like the
   *  real route does for an unknown username. */
  function startAdminUserServer(users: Record<string, string>): CaptureServer {
    const requests: URL[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/notices") return Response.json({ notices: [] });
        if (url.pathname === "/datasets/facets") return Response.json({});
        requests.push(url);
        const match = url.pathname.match(/^\/admin\/users\/([^/]+)$/);
        if (!match) return Response.json({ error: "not found" }, { status: 404 });
        const username = decodeURIComponent(match[1]);
        const kind = users[username];
        if (kind === undefined) return Response.json({ error: "User not found" }, { status: 404 });
        return Response.json({ user: { username, account_kind: kind } });
      },
    });
    return { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) };
  }

  function allExpectedKinds(): Record<string, string> {
    return { ...OPERATIONAL_ACCOUNT_KINDS };
  }

  test("every operational account matches its expected kind: reports all clean", async () => {
    seedAuthenticatedConfig();
    const server = startAdminUserServer(allExpectedKinds());
    try {
      const result = await runCli(["admin", "doctor", "kinds"], server.url);
      expect(result.exitCode).toBe(0);
      const combined = `${result.stdout}${result.stderr}`;
      expect(combined).toContain("carry their expected kind");
      expect(combined).not.toContain("kind mismatch");
      expect(combined).not.toContain("account absent");
      expect(server.requests.length).toBe(Object.keys(OPERATIONAL_ACCOUNT_KINDS).length);
    } finally {
      server.stop();
    }
  });

  test("a mismatched kind is reported by username, naming expected and found", async () => {
    seedAuthenticatedConfig();
    const users = allExpectedKinds();
    users.nemarOwner = "person"; // expected 'service'
    const server = startAdminUserServer(users);
    try {
      const result = await runCli(["admin", "doctor", "kinds"], server.url);
      expect(result.exitCode).toBe(0);
      const combined = `${result.stdout}${result.stderr}`;
      expect(combined).toContain("kind mismatch");
      expect(combined).toContain("nemarOwner: expected 'service', found 'person'");
      expect(combined).toContain("nemar admin kind <username> <kind>");
    } finally {
      server.stop();
    }
  });

  test("an absent operational account is reported separately from a mismatch", async () => {
    seedAuthenticatedConfig();
    const { "test-owner": _omitted, ...users } = allExpectedKinds();
    const server = startAdminUserServer(users);
    try {
      const result = await runCli(["admin", "doctor", "kinds"], server.url);
      expect(result.exitCode).toBe(0);
      const combined = `${result.stdout}${result.stderr}`;
      expect(combined).toContain("account absent");
      expect(combined).toContain("test-owner");
      expect(combined).not.toContain("test-owner: expected");
    } finally {
      server.stop();
    }
  });
});
