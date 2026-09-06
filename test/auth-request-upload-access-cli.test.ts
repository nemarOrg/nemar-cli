/**
 * CLI `nemar auth request-upload-access` (ADR 0042, #1253, epic #1250),
 * driven through the real entry point (`bun run src/index.ts auth ...`).
 *
 * The refusal rendering is the reason this command exists rather than a curl
 * one-liner: the API answers with a LIST of account fields that still need
 * filling in, and a user who is told "profile incomplete" and nothing else has
 * to guess which of six fields it means. So what is pinned here is that every
 * name in `missing` reaches the terminal, each with somewhere to go and fix it.
 *
 * Harness mirrors test/admin-users-tier-cli.test.ts exactly: a real subprocess
 * CLI invocation pointed at a real local HTTP server via TEST_API_URL
 * (src/lib/api/client.ts#getApiUrl), no mocks. `--why` is always passed because
 * the subprocess runs with stdin ignored, so the inquirer prompt would hang.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const WHY = "Depositing our lab's 64-channel EEG study of motor imagery, 40 participants.";

interface CaptureServer {
  url: string;
  bodies: unknown[];
  stop: () => void;
}

/** Answers the upload-access request with `reply`, capturing what was sent. */
function startServer(reply: { status: number; body: unknown }): CaptureServer {
  const bodies: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      if (url.pathname === "/users/me/upload-access/request") {
        bodies.push(await req.json().catch(() => null));
        return Response.json(reply.body, { status: reply.status });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://localhost:${server.port}`, bodies, stop: () => server.stop(true) };
}

let configDir: string;

function seedAuthenticatedConfig(): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "requester",
      accounts: { requester: { apiKey: "test-user-key" } },
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
  configDir = mkdtempSync(join(tmpdir(), "nemar-upload-req-cli-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("nemar auth request-upload-access", () => {
  test("sends the why text and reports that an admin will review it", async () => {
    seedAuthenticatedConfig();
    const server = startServer({ status: 201, body: { ok: true, already_requested: false } });
    try {
      const result = await runCli(["auth", "request-upload-access", "--why", WHY], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.bodies).toEqual([{ why: WHY }]);
      // ora writes its spinner lines to stderr, so success is asserted over
      // the combined output.
      expect(`${result.stdout}${result.stderr}`).toContain("Upload access requested");
      expect(result.stdout).toContain("reviews the request once");
    } finally {
      server.stop();
    }
  });

  test("an open request is reported as such, not as an error", async () => {
    seedAuthenticatedConfig();
    const server = startServer({
      status: 200,
      body: { ok: true, already_requested: true, requested_at: "2026-09-04T12:00:00Z" },
    });
    try {
      const result = await runCli(["auth", "request-upload-access", "--why", WHY], server.url);
      expect(result.exitCode).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "already have an open upload access request",
      );
    } finally {
      server.stop();
    }
  });

  test("every missing field is printed with where to fix it", async () => {
    seedAuthenticatedConfig();
    const server = startServer({
      status: 400,
      body: {
        error: "profile_incomplete",
        message: "Complete your profile before requesting upload access: username, city, country",
        missing: ["username", "city", "country"],
      },
    });
    try {
      const result = await runCli(["auth", "request-upload-access", "--why", WHY], server.url);
      expect(result.exitCode).toBe(1);
      const out = `${result.stdout}${result.stderr}`;
      for (const field of ["username", "city", "country"]) {
        expect(out).toContain(field);
      }
      // Not just the field names: where to go. Today that is Settings for all
      // of them, because PATCH /auth/profile is cookie-authenticated and the
      // CLI cannot write any of these fields itself.
      expect(out).toContain("Settings on nemar.org");
      expect(out).toContain("https://nemar.org/settings");
    } finally {
      server.stop();
    }
  });

  test("an unverified inbox is pointed at the CLI command that fixes it", async () => {
    // The one precondition the CLI CAN act on today, so it must not be swept
    // into the generic "go to Settings" advice.
    seedAuthenticatedConfig();
    const server = startServer({
      status: 400,
      body: {
        error: "email_not_verified",
        message: "Verify your email address before requesting upload access",
        missing: ["email_verified"],
      },
    });
    try {
      const result = await runCli(["auth", "request-upload-access", "--why", WHY], server.url);
      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("nemar auth resend-verification");
    } finally {
      server.stop();
    }
  });

  test("a 409 for an account that already holds the grant is not a crash", async () => {
    seedAuthenticatedConfig();
    const server = startServer({
      status: 409,
      body: {
        error: "already_approved",
        message: "This account already has upload access; there is nothing to request",
        missing: [],
      },
    });
    try {
      const result = await runCli(["auth", "request-upload-access", "--why", WHY], server.url);
      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("already has upload access");
      // An empty `missing` renders no field list rather than an empty heading.
      expect(result.stdout).not.toContain("Still needed");
    } finally {
      server.stop();
    }
  });

  test("refuses to ask when nobody is logged in", async () => {
    // No config seeded: the command must not reach the network at all.
    const server = startServer({ status: 201, body: { ok: true, already_requested: false } });
    try {
      const result = await runCli(["auth", "request-upload-access", "--why", WHY], server.url);
      expect(result.exitCode).toBe(1);
      expect(server.bodies).toHaveLength(0);
      // The command's own guidance, and NOT the client's generic 401 -- the
      // check happens before the spinner starts, so a script never sees a
      // request that was never going to be sent being "submitted".
      expect(`${result.stdout}${result.stderr}`).toContain(
        "Run 'nemar auth login' to authenticate",
      );
      expect(`${result.stdout}${result.stderr}`).not.toContain("Submitting upload access request");
    } finally {
      server.stop();
    }
  });
});
