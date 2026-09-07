/**
 * CLI `nemar auth profile` (#1254, epic #1250; ADR 0043), driven through the
 * real entry point (`bun run src/index.ts auth profile`).
 *
 * Identity uniqueness means a duplicate sign-up is REFUSED rather than
 * created, so the message a person hits is "that already belongs to an
 * account" -- and the only useful next sentence is where to go and change it.
 * This command is that sentence, so what it prints is the behaviour under
 * test: the identifiers, whether each is verified, and the footer that says
 * which are self-service today and which are not.
 *
 * Harness mirrors test/auth-status-upload-access.test.ts: a real subprocess
 * CLI invocation against a real local HTTP server via TEST_API_URL, with an
 * isolated NEMAR_CONFIG_DIR and a real on-disk config store. No mocks -- the
 * server serves the real `/users/me` envelope shape and the CLI's real
 * contract validation runs against it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

/** The full `/users/me` envelope a current backend returns. */
function meUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 12,
    username: "harlow",
    email: "harlow@example.org",
    github_username: "harlow-gh",
    role: "member",
    orcid: "0000-0002-1825-0097",
    status: "approved",
    email_verified: true,
    orcid_verified: true,
    given_name: "Ada",
    family_name: "Lovelace",
    created_at: "2026-05-01T00:00:00Z",
    approved_at: null,
    dataset_count: 0,
    sandbox_completed: true,
    sandbox_completed_at: null,
    sandbox_dataset_id: null,
    service_access: true,
    ...overrides,
  };
}

function startMeServer(user: Record<string, unknown>) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      return Response.json({ user, token: null });
    },
  });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

let configDir: string;

function seedAuthenticatedConfig(): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "harlow",
      accounts: { harlow: { apiKey: "test-user-key", username: "harlow" } },
    }),
  );
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-auth-profile-cli-"));
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

describe("nemar auth profile", () => {
  test("prints every identifier with its verification state", async () => {
    seedAuthenticatedConfig();
    const server = startMeServer(meUser());
    try {
      const result = await runCli(["auth", "profile"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Username: harlow");
      expect(result.stdout).toContain("Name:     Ada Lovelace");
      expect(result.stdout).toContain("Email:    harlow@example.org  verified");
      expect(result.stdout).toContain("GitHub:   @harlow-gh");
      expect(result.stdout).toContain("ORCID:    0000-0002-1825-0097  verified");
      expect(result.stdout).toContain("Tier:          approved");
      expect(result.stdout).toContain("Upload access: granted");
    } finally {
      server.stop();
    }
  });

  test("an unverified email and an unverified iD say so, separately", async () => {
    seedAuthenticatedConfig();
    const server = startMeServer(meUser({ email_verified: false, orcid_verified: false }));
    try {
      const result = await runCli(["auth", "profile"], server.url);
      expect(result.stdout).toContain("Email:    harlow@example.org  not verified");
      expect(result.stdout).toContain("ORCID:    0000-0002-1825-0097  not verified");
    } finally {
      server.stop();
    }
  });

  test("a backend that omits the flags reports unknown, never 'not verified'", async () => {
    // The ADR 0040 rule applied to the new fields: telling someone their
    // confirmed inbox is unconfirmed sends them to redeem a code they do not
    // need, so absence must not collapse to `false`.
    seedAuthenticatedConfig();
    const user = meUser();
    // biome-ignore lint/performance/noDelete: absence is the case under test.
    delete user.email_verified;
    // biome-ignore lint/performance/noDelete: absence is the case under test.
    delete user.orcid_verified;
    // biome-ignore lint/performance/noDelete: absence is the case under test.
    delete user.service_access;
    // biome-ignore lint/performance/noDelete: absence is the case under test.
    delete user.status;
    const server = startMeServer(user);
    try {
      const result = await runCli(["auth", "profile"], server.url);
      expect(result.stdout).toContain("verification state unknown");
      expect(result.stdout).not.toContain("not verified");
      expect(result.stdout).toContain("Upload access: unknown");
      expect(result.stdout).not.toContain("not granted");
    } finally {
      server.stop();
    }
  });

  test("missing identifiers render as 'not set', not as the word null", async () => {
    // Web/ORCID rows carry username = NULL and github_username = NULL by
    // design (#1012); printing the literal `null` is the bug that put it in
    // the admin listing.
    seedAuthenticatedConfig();
    const server = startMeServer(
      meUser({
        username: null,
        github_username: null,
        orcid: null,
        given_name: null,
        family_name: null,
      }),
    );
    try {
      const result = await runCli(["auth", "profile"], server.url);
      expect(result.stdout).toContain("Username: not set");
      expect(result.stdout).toContain("Name:     not set");
      expect(result.stdout).toContain("GitHub:   not set");
      expect(result.stdout).toContain("ORCID:    not set");
      expect(result.stdout).not.toContain("null");
    } finally {
      server.stop();
    }
  });

  test("the footer names the command that changes each identifier", async () => {
    seedAuthenticatedConfig();
    const server = startMeServer(meUser());
    try {
      const result = await runCli(["auth", "profile"], server.url);
      expect(result.stdout).toContain("Where to change each");
      // Since #1266 every identifier is self-service from the CLI, so the
      // footer names the command rather than a page the person then has to
      // find. Username and name used to read "not editable yet" here.
      expect(result.stdout).toContain("nemar auth profile set-email <address>");
      expect(result.stdout).toContain("nemar auth profile set-username <name>");
      expect(result.stdout).toContain("nemar auth profile set-name --given <g> --family <f>");
      expect(result.stdout).toContain("nemar auth profile set-github <handle>");
      expect(result.stdout).toContain("nemar auth profile orcid link|relink|unlink");
      expect(result.stdout).not.toContain("not editable yet");
      // The website is still the other half of the same rules, not a rival.
      expect(result.stdout).toContain("https://nemar.org/settings");
      expect(result.stdout).toContain("at most one NEMAR account");
    } finally {
      server.stop();
    }
  });

  test("it always fetches: nothing is served from the config cache", async () => {
    // The command someone runs BEFORE changing an identifier, so a cached
    // answer is the wrong thing to hand them. With no reachable backend it
    // must fail rather than print the stored username and email.
    seedAuthenticatedConfig();
    const result = await runCli(["auth", "profile"], "http://127.0.0.1:1");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain("harlow@example.org");
    expect(`${result.stdout}${result.stderr}`).toContain("Could not fetch your profile");
  });

  test("an unauthenticated config says how to authenticate", async () => {
    const result = await runCli(["auth", "profile"], "http://127.0.0.1:1");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Not authenticated");
    expect(result.stdout).toContain("nemar auth login");
  });
});
