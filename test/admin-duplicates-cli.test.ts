/**
 * CLI `nemar admin duplicates` (#1254, epic #1250; ADR 0043), driven through
 * the real entry point (`bun run src/index.ts admin duplicates`).
 *
 * The duplicate report is the whole operator interface for the
 * `identity_conflict` flag migration 0077 introduces -- the flag is invisible
 * to a user and to every other listing -- so what this command prints, and
 * what it exits with, is the behaviour under test.
 *
 * Harness mirrors test/auth-status-upload-access.test.ts: a real subprocess
 * CLI invocation against a real local HTTP server via TEST_API_URL, with an
 * isolated NEMAR_CONFIG_DIR and a real on-disk config store. The server serves
 * the real wire shapes, and the CLI's real contract validation runs against
 * them. No mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

const REPORT_WITH_GROUP = {
  groups: [
    {
      kind: "orcid",
      value: "0000-0002-1974-1293",
      canonical_user_id: 43,
      accounts: [
        {
          id: 42,
          username: null,
          email: "robert.oostenveld@donders.ru.nl",
          created_at: "2026-08-04 18:57:00",
          has_oauth_identity: false,
          dataset_count: 0,
          identity_conflict: 1,
          canonical: false,
        },
        {
          id: 43,
          username: null,
          email: "r.oostenveld@donders.ru.nl",
          created_at: "2026-08-04 19:18:00",
          has_oauth_identity: true,
          dataset_count: 3,
          identity_conflict: 0,
          canonical: true,
        },
      ],
    },
  ],
  group_count: 1,
  flagged_count: 1,
};

const EMPTY_REPORT = { groups: [], group_count: 0, flagged_count: 0 };

interface ServerOptions {
  report?: unknown;
  /** Response for POST /admin/users/:id/clear-identity-conflict. */
  clear?: { status: number; body: unknown };
}

function startServer(options: ServerOptions) {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push(`${req.method} ${url.pathname}`);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      if (url.pathname === "/admin/users/duplicates") {
        return Response.json(options.report ?? EMPTY_REPORT);
      }
      if (url.pathname.endsWith("/clear-identity-conflict")) {
        const c = options.clear ?? { status: 200, body: { ok: true, id: 42, cleared: true } };
        return Response.json(c.body, { status: c.status });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) };
}

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-admin-duplicates-cli-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "root",
      accounts: { root: { apiKey: "test-admin-key", username: "root", role: "admin" } },
    }),
  );
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

describe("nemar admin duplicates", () => {
  test("prints the group, marks the canonical row, and exits non-zero", async () => {
    const server = startServer({ report: REPORT_WITH_GROUP });
    try {
      const result = await runCli(["admin", "duplicates"], server.url);
      expect(result.stdout).toContain("1 duplicate group(s); 1 account(s) flagged");
      expect(result.stdout).toContain("orcid  0000-0002-1974-1293");
      expect(result.stdout).toContain("id 42");
      expect(result.stdout).toContain("[flagged]");
      expect(result.stdout).toContain("[canonical, orcid-login]");
      expect(result.stdout).toContain("datasets=3");
      // The report is a finding, not a status line: a scheduled run has to be
      // able to notice it without parsing stdout.
      expect(result.exitCode).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("a clean catalog says so and exits zero", async () => {
    const server = startServer({ report: EMPTY_REPORT });
    try {
      const result = await runCli(["admin", "duplicates"], server.url);
      expect(result.stdout).toContain("No duplicate accounts.");
      expect(result.exitCode).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("a flag with no group behind it is called out, not left as a zero", async () => {
    // Someone resolved the collision on the other account; the flag survives
    // and is invisible in the groups list by definition.
    const server = startServer({
      report: { groups: [], group_count: 0, flagged_count: 2 },
    });
    try {
      const result = await runCli(["admin", "duplicates"], server.url);
      expect(result.stdout).toContain("No duplicate accounts.");
      expect(result.stdout).toContain("2 account(s) still carry an identity-conflict flag");
      expect(result.stdout).toContain("--clear <id>");
    } finally {
      server.stop();
    }
  });

  test("--json emits the raw report and nothing else", async () => {
    const server = startServer({ report: REPORT_WITH_GROUP });
    try {
      const result = await runCli(["admin", "duplicates", "--json"], server.url);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.group_count).toBe(1);
      expect(parsed.groups[0].canonical_user_id).toBe(43);
      expect(result.stdout).not.toContain("duplicate group(s)");
    } finally {
      server.stop();
    }
  });

  test("--clear reports success and never fetches the report", async () => {
    const server = startServer({ clear: { status: 200, body: { ok: true, id: 42, cleared: true } } });
    try {
      const result = await runCli(["admin", "duplicates", "--clear", "42"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Cleared the identity-conflict flag on user 42");
      expect(server.requests).toContain("POST /admin/users/42/clear-identity-conflict");
      expect(server.requests).not.toContain("GET /admin/users/duplicates");
    } finally {
      server.stop();
    }
  });

  test("--clear on an unflagged row says nothing to clear", async () => {
    const server = startServer({ clear: { status: 200, body: { ok: true, id: 7, cleared: false } } });
    try {
      const result = await runCli(["admin", "duplicates", "--clear", "7"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("was not flagged");
    } finally {
      server.stop();
    }
  });

  test("a 409 prints the server's own sentence and exits non-zero", async () => {
    // The expected answer while the collision stands, so it has to say what to
    // fix rather than looking like a crash.
    const server = startServer({
      clear: {
        status: 409,
        body: {
          error: "identity_conflict_remains",
          code: "identity_conflict_remains",
          message:
            "The collision that flagged this account is still there. Resolve it on the other account first.",
          colliding: [{ kind: "orcid", value: "0000-0002-1974-1293", user_ids: [43] }],
        },
      },
    });
    try {
      const result = await runCli(["admin", "duplicates", "--clear", "42"], server.url);
      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("Still colliding");
      // The SENTENCE, not the code. Until #1266 taught the client which
      // strings in `error` are machine codes (shared/contract), this line
      // printed the literal `identity_conflict_remains` at an operator.
      expect(`${result.stdout}${result.stderr}`).toContain(
        "Resolve it on the other account first",
      );
    } finally {
      server.stop();
    }
  });

  test("a malformed report fails loudly instead of printing a wrong answer", async () => {
    // The command is validated against the shared contract, so a backend that
    // drifts is a loud parse failure rather than "No duplicate accounts." --
    // which is the one output that must never be produced by accident, because
    // an operator reads it as "nothing to do".
    const server = startServer({ report: { groups: "not-an-array", group_count: 1 } });
    try {
      const result = await runCli(["admin", "duplicates"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toContain("No duplicate accounts.");
      expect(`${result.stdout}${result.stderr}`).toContain("contract");
    } finally {
      server.stop();
    }
  });

  test("a report missing flagged_count is rejected, not read as zero", async () => {
    // A field silently defaulting to 0 would hide exactly the state the
    // `--clear` half exists for: flags with no collision left behind them.
    const server = startServer({ report: { groups: [], group_count: 0 } });
    try {
      const result = await runCli(["admin", "duplicates"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toContain("No duplicate accounts.");
    } finally {
      server.stop();
    }
  });

  test("a non-numeric --clear id is rejected before any request", async () => {
    const server = startServer({});
    try {
      const result = await runCli(["admin", "duplicates", "--clear", "abc"], server.url);
      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("Invalid user id");
      expect(server.requests.some((r) => r.includes("clear-identity-conflict"))).toBe(false);
    } finally {
      server.stop();
    }
  });
});
