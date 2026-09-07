/**
 * CLI `nemar admin approve` success output (ADR 0040, #1251), driven through
 * the real entry point (`bun run src/index.ts admin approve ...`).
 *
 * The Tier line is read off the RESPONSE, not hardcoded. That is the whole
 * point of these tests: a backend that still approves without granting is
 * exactly the #1249 bug, and a CLI that prints "Tier: upload" unconditionally
 * would report success on the one deployment where an admin needs to see the
 * failure. So the "grant not confirmed" case is covered as carefully as the
 * happy one.
 *
 * Harness mirrors test/hed-sweep-cli.test.ts: a real subprocess CLI invocation
 * against a real local HTTP server via TEST_API_URL, isolated NEMAR_CONFIG_DIR,
 * no mocks. `--yes` skips the interactive confirmation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

interface ApproveServer {
  url: string;
  requests: string[];
  stop: () => void;
}

function startApproveServer(body: unknown): ApproveServer {
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

/** The normal approval body: status flipped and the grant confirmed. */
const GRANTED_BODY = {
  message: "User halloway has been approved",
  user: {
    id: 31,
    username: "halloway",
    email: "halloway@example.org",
    status: "approved",
    service_access: true,
  },
  email_sent: false,
};

/** The repair body: only the grant was written, so a `note` explains why. */
const REPAIR_BODY = {
  message: "User halloway already had status 'approved'; upload access granted",
  note: "Only the upload grant was written — the account was already approved, so no status change or approval email was needed.",
  user: {
    id: 31,
    username: "halloway",
    email: "halloway@example.org",
    status: "approved",
    service_access: true,
  },
  email_sent: false,
};

/**
 * A pre-#1251 backend: approval succeeded, but the response says nothing about
 * upload access. Written out in full rather than cloned-and-deleted, because
 * the absent key IS the fixture — a spread of GRANTED_BODY.user would quietly
 * reacquire it and this would stop testing what it says it tests.
 * `assertNoGrantKey` makes that drift a failure.
 */
const NO_GRANT_BODY = {
  message: "User halloway has been approved",
  user: {
    id: 31,
    username: "halloway",
    email: "halloway@example.org",
    status: "approved",
  },
  email_sent: false,
};

/** Guards the fixture's whole point: the key must not be there at all. */
function assertNoGrantKey(): void {
  expect(Object.keys(NO_GRANT_BODY.user)).not.toContain("service_access");
  expect(JSON.stringify(NO_GRANT_BODY)).not.toContain("service_access");
}

let configDir: string;

function seedAuthenticatedConfig(): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "approvecliadmin",
      accounts: { approvecliadmin: { apiKey: "test-admin-key" } },
    }),
  );
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-admin-approve-cli-"));
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

describe("nemar admin approve: the Tier line", () => {
  test("a confirmed grant prints Tier: upload", async () => {
    seedAuthenticatedConfig();
    const server = startApproveServer(GRANTED_BODY);
    try {
      const result = await runCli(["admin", "approve", "halloway", "--yes"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests).toContain("/admin/approve/halloway");
      expect(result.stdout).toContain("Tier: upload");
      expect(result.stdout).not.toContain("grant not confirmed");
      // The confirmation preamble promises the grant; the result must agree.
      expect(result.stdout).toContain("Mark the account approved and grant upload access");
    } finally {
      server.stop();
    }
  });

  test("a response with no service_access says the grant was not confirmed", async () => {
    assertNoGrantKey();
    seedAuthenticatedConfig();
    const server = startApproveServer(NO_GRANT_BODY);
    try {
      const result = await runCli(["admin", "approve", "halloway", "--yes"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Tier: grant not confirmed by server");
      expect(result.stdout).toContain("verify with 'nemar admin users'");
      // The failure this guards: reporting the outcome we wanted rather than
      // the one the API reported (#1249 all over again).
      expect(result.stdout).not.toContain("Tier: upload");
    } finally {
      server.stop();
    }
  });

  test("an explicit service_access: false is also treated as unconfirmed", async () => {
    seedAuthenticatedConfig();
    const server = startApproveServer({
      ...GRANTED_BODY,
      user: { ...GRANTED_BODY.user, service_access: false },
    });
    try {
      const result = await runCli(["admin", "approve", "halloway", "--yes"], server.url);
      expect(result.stdout).toContain("Tier: grant not confirmed by server");
      expect(result.stdout).not.toContain("Tier: upload");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin approve: the repair note", () => {
  test("the server's note is surfaced verbatim alongside Tier: upload", async () => {
    seedAuthenticatedConfig();
    const server = startApproveServer(REPAIR_BODY);
    try {
      const result = await runCli(["admin", "approve", "halloway", "--yes"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Tier: upload");
      expect(result.stdout).toContain("Only the upload grant was written");
    } finally {
      server.stop();
    }
  });

  test("the repair path says nothing about email delivery", async () => {
    // The account was already approved, so no notification was owed and none
    // was attempted — the backend returns email_sent: false by design. Warning
    // about a failed send here sends an admin chasing a problem that does not
    // exist.
    seedAuthenticatedConfig();
    const server = startApproveServer(REPAIR_BODY);
    try {
      const result = await runCli(["admin", "approve", "halloway", "--yes"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("Notification email failed to send");
      expect(result.stdout).not.toContain("notify the user manually");
      expect(result.stdout).not.toContain("User notified");
    } finally {
      server.stop();
    }
  });

  test("a normal approval with email_sent false still warns", async () => {
    // The email branch is only silenced on the repair path; a real approval
    // whose notification failed must still say so.
    seedAuthenticatedConfig();
    const server = startApproveServer(GRANTED_BODY);
    try {
      const result = await runCli(["admin", "approve", "halloway", "--yes"], server.url);
      expect(result.stdout).toContain("Notification email failed to send");
    } finally {
      server.stop();
    }
  });

  test("a normal approval prints no note line", async () => {
    seedAuthenticatedConfig();
    const server = startApproveServer(GRANTED_BODY);
    try {
      const result = await runCli(["admin", "approve", "halloway", "--yes"], server.url);
      expect(result.stdout).not.toContain("Only the upload grant was written");
    } finally {
      server.stop();
    }
  });

  test("--id approves by numeric id and reports the same tier", async () => {
    seedAuthenticatedConfig();
    const server = startApproveServer({
      ...GRANTED_BODY,
      user: { ...GRANTED_BODY.user, username: null },
    });
    try {
      const result = await runCli(["admin", "approve", "--id", "31", "--yes"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests).toContain("/admin/approve/by-id/31");
      expect(result.stdout).toContain("Tier: upload");
    } finally {
      server.stop();
    }
  });
});
