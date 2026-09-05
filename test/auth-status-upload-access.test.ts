/**
 * CLI `nemar auth status` / `whoami` upload-access line (ADR 0040, #1251),
 * driven through the real entry point (`bun run src/index.ts auth status`).
 *
 * `status='approved'` stopped implying upload access in v0.9.5 and nothing in
 * the CLI ever said so, which is half of why #1249 went unnoticed. This pins
 * the three states the line can be in, and that `--refresh` is what learns the
 * value from the real /users/me envelope.
 *
 * Harness mirrors test/hed-sweep-cli.test.ts: a real subprocess CLI invocation
 * against a real local HTTP server via TEST_API_URL, with an isolated
 * NEMAR_CONFIG_DIR and a real on-disk config store. No mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

const NOT_GRANTED_HINT = "(one-time admin approval; see https://nemar.org/support)";

/** Serves the real /users/me envelope shape: `{ user, token }`. */
function startMeServer(serviceAccess: boolean | undefined) {
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
          orcid: null,
          created_at: "2026-05-01T00:00:00Z",
          approved_at: null,
          dataset_count: 0,
          sandbox_completed: true,
          sandbox_completed_at: null,
          sandbox_dataset_id: null,
          ...(serviceAccess === undefined ? {} : { service_access: serviceAccess }),
        },
        token: null,
      });
    },
  });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

/** A backend that is up but broken: /users/me 500s. Neither 401 nor 403, so it
 *  takes the fall-through path where the cached account is displayed. */
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
  const store = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
  return store.accounts.harlow;
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-auth-status-cli-"));
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

describe("nemar auth status: upload access", () => {
  test("--refresh against a granted account prints granted and caches it", async () => {
    seedAuthenticatedConfig();
    const server = startMeServer(true);
    try {
      const result = await runCli(["auth", "status", "--refresh"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Upload access: granted");
      expect(storedAccount().serviceAccess).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("--refresh against an ungranted account prints the request hint", async () => {
    seedAuthenticatedConfig();
    const server = startMeServer(false);
    try {
      const result = await runCli(["auth", "status", "--refresh"], server.url);
      expect(result.stdout).toContain("Upload access: not granted");
      expect(result.stdout).toContain(NOT_GRANTED_HINT);
      expect(storedAccount().serviceAccess).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("the cached value is what a later offline status prints", async () => {
    // No server: the second run does not refresh, so it can only be reading
    // what the first run wrote.
    seedAuthenticatedConfig({ serviceAccess: true });
    const result = await runCli(["auth", "status"], "http://127.0.0.1:1");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Upload access: granted");
  });

  test("whoami prints the same line (it is the same action)", async () => {
    seedAuthenticatedConfig({ serviceAccess: false });
    const result = await runCli(["auth", "whoami"], "http://127.0.0.1:1");
    expect(result.stdout).toContain("Upload access: not granted");
  });

  test("a never-refreshed account reports unknown rather than guessing", async () => {
    seedAuthenticatedConfig();
    const result = await runCli(["auth", "status"], "http://127.0.0.1:1");
    expect(result.stdout).toContain("Upload access: unknown");
    expect(result.stdout).toContain("--refresh");
    expect(result.stdout).not.toContain("not granted");
  });

  test("a 5xx refresh reports unknown instead of a stale granted", async () => {
    // The cache says granted; the refresh the user explicitly asked for did not
    // land. Printing "granted" here presents a claim about the past as the
    // present answer, and the grant may have been revoked in between.
    seedAuthenticatedConfig({ serviceAccess: true });
    const server = startBrokenMeServer();
    try {
      const result = await runCli(["auth", "status", "--refresh"], server.url);
      expect(result.stdout).toContain(
        "Upload access: unknown (refresh failed; showing cached account)",
      );
      expect(result.stdout).not.toContain("Upload access: granted");
    } finally {
      server.stop();
    }
  });

  test("an offline refresh reports unknown too, and names the reason", async () => {
    seedAuthenticatedConfig({ serviceAccess: true });
    const result = await runCli(["auth", "status", "--refresh"], "http://127.0.0.1:1");
    expect(result.stdout).not.toContain("Upload access: granted");
    expect(result.stdout).toContain("Upload access: unknown (refresh failed");
    // The reason belongs on the failure line, not scrolled past as a bare
    // "Could not refresh user info".
    expect(`${result.stdout}${result.stderr}`).toContain("Could not refresh user info:");
  });

  test("a failed refresh does not overwrite the cached value", async () => {
    // Unknown is what THIS run reports; the cache is still the last known good
    // answer, so a later successful (or offline, unrefreshed) run still has it.
    seedAuthenticatedConfig({ serviceAccess: true });
    const server = startBrokenMeServer();
    try {
      await runCli(["auth", "status", "--refresh"], server.url);
      expect(storedAccount().serviceAccess).toBe(true);
    } finally {
      server.stop();
    }
    const later = await runCli(["auth", "status"], "http://127.0.0.1:1");
    expect(later.stdout).toContain("Upload access: granted");
  });

  test("a 5xx refresh does not claim 'not granted' either", async () => {
    seedAuthenticatedConfig({ serviceAccess: false });
    const server = startBrokenMeServer();
    try {
      const result = await runCli(["auth", "status", "--refresh"], server.url);
      expect(result.stdout).toContain("Upload access: unknown (refresh failed");
      expect(result.stdout).not.toContain("not granted");
    } finally {
      server.stop();
    }
  });

  test("a backend that omits the field leaves the cache untouched", async () => {
    // An older backend sends no service_access. Writing `false` there would
    // tell someone who holds the grant that they do not.
    seedAuthenticatedConfig({ serviceAccess: true });
    const server = startMeServer(undefined);
    try {
      const result = await runCli(["auth", "status", "--refresh"], server.url);
      expect(result.stdout).toContain("Upload access: granted");
      expect(storedAccount().serviceAccess).toBe(true);
    } finally {
      server.stop();
    }
  });
});
