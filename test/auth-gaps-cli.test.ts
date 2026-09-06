/**
 * What the terminal actually prints about a missing profile field (#1268,
 * ADR 0045), driven through the real entry point (`bun run src/index.ts ...`).
 *
 * The sentences are asserted VERBATIM, and that is the point of the file: they
 * are the strings `shared/contract/account-copy.ts` holds and the website
 * transcribes, so a CLI that started paraphrasing them would be the drift phase
 * 8 exists to prevent — and paraphrasing is exactly what a test asserting
 * `toContain("username")` would let through.
 *
 * Harness mirrors test/auth-status-upload-access.test.ts: a real subprocess CLI
 * invocation against a real local HTTP server via TEST_API_URL, an isolated
 * NEMAR_CONFIG_DIR, and a real on-disk config store. No mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

/** The exact sentences. Spelled out rather than imported so this file fails
 *  when the copy table changes, instead of following it. */
const USERNAME_LINE =
  "Username is missing: needed to request upload access. Set it in Settings or run `nemar auth profile set-username`.";
const GITHUB_LINE =
  "GitHub handle is missing: needed to request upload access. Set it in Settings or run `nemar auth profile set-github`.";
const GIVEN_ORCID_LINE =
  "Given name is missing: needed to request upload access. Set it in your ORCID record at orcid.org, then sign in again.";
const SANDBOX_LINE =
  "Sandbox training is missing: needed to upload a dataset from the CLI. Run `nemar sandbox`.";
const NOTHING_LINE = "Nothing outstanding — every field NEMAR needs is filled in.";
const NOT_CHECKED_LINE = "not checked — run 'nemar auth status --refresh'";
const UNREPORTED_LINE = "not reported by this backend";
const PREFLIGHT_TITLE = "Upload access is not granted yet";
const PREFLIGHT_CTA = "Ask for it with `nemar auth request-upload-access`.";
const PREFLIGHT_DRY_RUN = "Continuing anyway: --dry-run uploads nothing.";
const UPLOAD_GAPS_TITLE = "Before you can ask, your account still needs:";
const PREFLIGHT_GAPS_UNKNOWN =
  "Could not determine what is still missing; run `nemar auth profile` for the list.";
/** Printed by the step AFTER the preflight, so it is how a test proves the
 *  pipeline continued rather than stopped. */
const CONTINUED_MARKER = "Path does not exist";

interface UserOptions {
  service_access?: boolean;
  profile_gaps?: { field: string; blocks: string[]; set_on: string[] }[] | undefined;
  orcid_verified?: boolean;
  sandbox_completed?: boolean;
}

/** Serves the real /users/me envelope shape: `{ user, token }`. */
function startMeServer(options: UserOptions = {}) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      return Response.json({
        user: {
          id: 12,
          username: "harlow",
          email: "harlow@example.org",
          github_username: "harlow-gh",
          role: "member",
          orcid: "0000-0002-1825-0097",
          orcid_verified: options.orcid_verified ?? false,
          status: "verified",
          email_verified: true,
          given_name: "Ada",
          family_name: "Harlow",
          created_at: "2026-05-01T00:00:00Z",
          approved_at: null,
          dataset_count: 0,
          sandbox_completed: options.sandbox_completed ?? true,
          sandbox_completed_at: null,
          sandbox_dataset_id: null,
          username_auto_assigned: false,
          ...(options.service_access === undefined
            ? {}
            : { service_access: options.service_access }),
          ...(options.profile_gaps === undefined ? {} : { profile_gaps: options.profile_gaps }),
        },
        token: null,
      });
    },
  });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

/** A backend that is up but broken: /users/me 500s. Neither 401 nor 403. */
function startBrokenMeServer() {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      return Response.json({ error: "Database is having a moment" }, { status: 500 });
    },
  });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

const GAP = (field: string, blocks: string[], setOn = ["web", "cli"]) => ({
  field,
  blocks,
  set_on: setOn,
});

let configDir: string;

function seedAuthenticatedConfig(extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "harlow",
      accounts: { harlow: { apiKey: "test-user-key", username: "harlow", ...extra } },
    }),
  );
}

function storedAccount(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")).accounts.harlow;
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-auth-gaps-cli-"));
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
  return { stdout, stderr, exitCode, all: `${stdout}${stderr}` };
}

describe("nemar auth status: the Profile block", () => {
  test("--refresh prints one exact sentence per gap, and caches them", async () => {
    seedAuthenticatedConfig();
    const server = startMeServer({
      service_access: false,
      profile_gaps: [
        GAP("username", ["upload_access"]),
        GAP("github_username", ["upload_access", "publication"]),
      ],
    });
    try {
      const result = await runCli(["auth", "status", "--refresh"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Profile");
      expect(result.stdout).toContain(USERNAME_LINE);
      expect(result.stdout).toContain(GITHUB_LINE);
      expect(storedAccount().profileGaps).toEqual([
        { field: "username", blocks: ["upload_access"], set_on: ["web", "cli"] },
        {
          field: "github_username",
          blocks: ["upload_access", "publication"],
          set_on: ["web", "cli"],
        },
      ]);
    } finally {
      server.stop();
    }
  });

  test("the cached list is what a later offline status prints", async () => {
    // No server: the second run does not refresh, so it can only be reading
    // what the first run wrote.
    seedAuthenticatedConfig({ profileGaps: [GAP("username", ["upload_access"])] });
    const result = await runCli(["auth", "status"], "http://127.0.0.1:1");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(USERNAME_LINE);
  });

  test("an empty list says so, and is not confused with never having looked", async () => {
    seedAuthenticatedConfig();
    const server = startMeServer({ service_access: true, profile_gaps: [] });
    try {
      const result = await runCli(["auth", "status", "--refresh"], server.url);
      expect(result.stdout).toContain(NOTHING_LINE);
      expect(result.stdout).not.toContain(NOT_CHECKED_LINE);
    } finally {
      server.stop();
    }
  });

  test("a never-refreshed account reports not-checked rather than 'nothing missing'", async () => {
    seedAuthenticatedConfig();
    const result = await runCli(["auth", "status"], "http://127.0.0.1:1");
    expect(result.stdout).toContain(NOT_CHECKED_LINE);
    expect(result.stdout).not.toContain(NOTHING_LINE);
  });

  test("a failed refresh reports not-checked instead of a stale list", async () => {
    // The cache says one thing; the refresh the user asked for did not land.
    // Printing the cache would present a claim about the past as the present.
    seedAuthenticatedConfig({ profileGaps: [GAP("username", ["upload_access"])] });
    const server = startBrokenMeServer();
    try {
      const result = await runCli(["auth", "status", "--refresh"], server.url);
      expect(result.stdout).toContain(NOT_CHECKED_LINE);
      expect(result.stdout).not.toContain(USERNAME_LINE);
      // ...and the cache is not overwritten, so an offline run still has it.
      expect(storedAccount().profileGaps).toHaveLength(1);
    } finally {
      server.stop();
    }
  });

  test("a backend that omits profile_gaps leaves the cache alone", async () => {
    seedAuthenticatedConfig({ profileGaps: [GAP("city", ["upload_access"])] });
    const server = startMeServer({ service_access: false, profile_gaps: undefined });
    try {
      await runCli(["auth", "status", "--refresh"], server.url);
      expect(storedAccount().profileGaps).toEqual([
        { field: "city", blocks: ["upload_access"], set_on: ["web", "cli"] },
      ]);
    } finally {
      server.stop();
    }
  });

  test("sandbox training is listed last, and only when it is outstanding", async () => {
    seedAuthenticatedConfig();
    const server = startMeServer({
      service_access: false,
      sandbox_completed: false,
      profile_gaps: [GAP("username", ["upload_access"])],
    });
    try {
      const result = await runCli(["auth", "status", "--refresh"], server.url);
      expect(result.stdout).toContain(SANDBOX_LINE);
      expect(result.stdout.indexOf(SANDBOX_LINE)).toBeGreaterThan(
        result.stdout.indexOf(USERNAME_LINE),
      );
    } finally {
      server.stop();
    }

    const done = startMeServer({
      service_access: false,
      sandbox_completed: true,
      profile_gaps: [GAP("username", ["upload_access"])],
    });
    try {
      const result = await runCli(["auth", "status", "--refresh"], done.url);
      expect(result.stdout).not.toContain(SANDBOX_LINE);
    } finally {
      done.stop();
    }
  });

  test("whoami prints the same block (it is the same action)", async () => {
    seedAuthenticatedConfig({ profileGaps: [GAP("username", ["upload_access"])] });
    const result = await runCli(["auth", "whoami"], "http://127.0.0.1:1");
    expect(result.stdout).toContain(USERNAME_LINE);
  });
});

describe("nemar auth profile", () => {
  test("prints the same sentences, from a live fetch", async () => {
    seedAuthenticatedConfig();
    const server = startMeServer({
      service_access: false,
      profile_gaps: [GAP("github_username", ["upload_access", "publication"])],
    });
    try {
      const result = await runCli(["auth", "profile"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(GITHUB_LINE);
    } finally {
      server.stop();
    }
  });

  test("a verified ORCID iD points the name at orcid.org, not at Settings", async () => {
    seedAuthenticatedConfig();
    const server = startMeServer({
      service_access: false,
      orcid_verified: true,
      profile_gaps: [GAP("given_name", ["upload_access", "publication"], ["web"])],
    });
    try {
      const result = await runCli(["auth", "profile"], server.url);
      expect(result.stdout).toContain(GIVEN_ORCID_LINE);
      expect(result.stdout).not.toContain("nemar auth profile set-name`");
    } finally {
      server.stop();
    }
  });

  test("an older backend is told apart from a complete profile", async () => {
    // `profile` always fetches, so "run --refresh" would be advice it just
    // followed. What is missing is the field, not the fetch.
    seedAuthenticatedConfig();
    const server = startMeServer({ service_access: false, profile_gaps: undefined });
    try {
      const result = await runCli(["auth", "profile"], server.url);
      expect(result.stdout).toContain(UNREPORTED_LINE);
      expect(result.stdout).not.toContain(NOTHING_LINE);
    } finally {
      server.stop();
    }
  });
});

describe("nemar dataset upload: the upload-access preflight", () => {
  const NO_SUCH_PATH = join(tmpdir(), "nemar-no-such-dataset-dir");

  test("a missing grant stops the run before anything else happens", async () => {
    seedAuthenticatedConfig({ sandboxCompleted: true });
    const server = startMeServer({
      service_access: false,
      profile_gaps: [
        GAP("username", ["upload_access"]),
        GAP("github_username", ["upload_access", "publication"]),
      ],
    });
    try {
      const result = await runCli(["dataset", "upload", NO_SUCH_PATH], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.all).toContain(PREFLIGHT_TITLE);
      expect(result.all).toContain(UPLOAD_GAPS_TITLE);
      expect(result.all).toContain(USERNAME_LINE);
      expect(result.all).toContain(GITHUB_LINE);
      expect(result.all).toContain(PREFLIGHT_CTA);
      // It really stopped: the very next step never ran.
      expect(result.all).not.toContain(CONTINUED_MARKER);
    } finally {
      server.stop();
    }
  });

  test("a publication-only gap is not listed as something blocking the request", async () => {
    seedAuthenticatedConfig({ sandboxCompleted: true });
    const server = startMeServer({
      service_access: false,
      profile_gaps: [GAP("given_name", ["publication"])],
    });
    try {
      const result = await runCli(["dataset", "upload", NO_SUCH_PATH], server.url);
      expect(result.all).toContain(PREFLIGHT_TITLE);
      expect(result.all).not.toContain(UPLOAD_GAPS_TITLE);
    } finally {
      server.stop();
    }
  });

  test("a backend that reports no gap list says so instead of nothing", async () => {
    // Not granted, and the list itself is absent -- an older backend. Printing
    // the refusal with no reasons under it reads as "nothing is missing", which
    // is a claim this build cannot make. `service_access` already distinguishes
    // absent from false; so must this.
    seedAuthenticatedConfig({ sandboxCompleted: true });
    const server = startMeServer({ service_access: false, profile_gaps: undefined });
    try {
      const result = await runCli(["dataset", "upload", NO_SUCH_PATH], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.all).toContain(PREFLIGHT_TITLE);
      expect(result.all).toContain(PREFLIGHT_GAPS_UNKNOWN);
      // Not the list heading: there is no list.
      expect(result.all).not.toContain(UPLOAD_GAPS_TITLE);
    } finally {
      server.stop();
    }
  });

  test("--dry-run warns and continues, because it uploads nothing", async () => {
    seedAuthenticatedConfig({ sandboxCompleted: true });
    const server = startMeServer({ service_access: false, profile_gaps: [] });
    try {
      const result = await runCli(["dataset", "upload", NO_SUCH_PATH, "--dry-run"], server.url);
      expect(result.all).toContain(PREFLIGHT_TITLE);
      expect(result.all).toContain(PREFLIGHT_DRY_RUN);
      expect(result.all).toContain(CONTINUED_MARKER);
    } finally {
      server.stop();
    }
  });

  test("a granted account passes straight through", async () => {
    seedAuthenticatedConfig({ sandboxCompleted: true });
    const server = startMeServer({ service_access: true, profile_gaps: [] });
    try {
      const result = await runCli(["dataset", "upload", NO_SUCH_PATH], server.url);
      expect(result.all).toContain("Upload access granted");
      expect(result.all).not.toContain(PREFLIGHT_TITLE);
      expect(result.all).toContain(CONTINUED_MARKER);
    } finally {
      server.stop();
    }
  });

  test("an unreachable backend warns and continues rather than inventing a refusal", async () => {
    // The server enforces the gate regardless; failing an upload because a
    // status endpoint was briefly down would refuse something nobody refused.
    seedAuthenticatedConfig({ sandboxCompleted: true });
    const result = await runCli(["dataset", "upload", NO_SUCH_PATH], "http://127.0.0.1:1");
    expect(result.all).toContain("Upload access could not be checked");
    expect(result.all).toContain(CONTINUED_MARKER);
  });

  test("a backend that does not report the grant is not treated as a refusal", async () => {
    seedAuthenticatedConfig({ sandboxCompleted: true });
    const server = startMeServer({ service_access: undefined });
    try {
      const result = await runCli(["dataset", "upload", NO_SUCH_PATH], server.url);
      expect(result.all).toContain("this backend does not report it");
      expect(result.all).toContain(CONTINUED_MARKER);
    } finally {
      server.stop();
    }
  });

  test("sandbox training is still the CLI-only gate, in the shared sentence", async () => {
    seedAuthenticatedConfig({ sandboxCompleted: false });
    const server = startMeServer({ service_access: true, profile_gaps: [] });
    try {
      const result = await runCli(["dataset", "upload", NO_SUCH_PATH], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.all).toContain(SANDBOX_LINE);
      // Ahead of the upload-access check: it costs no network call.
      expect(result.all).not.toContain("Upload access granted");
    } finally {
      server.stop();
    }
  });
});
