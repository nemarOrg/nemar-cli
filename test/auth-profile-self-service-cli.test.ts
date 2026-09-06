/**
 * CLI `nemar auth profile set-*` / `orcid` (#1266, epic #1250; ADR 0044),
 * driven through the real entry point (`bun run src/index.ts auth profile ...`).
 *
 * What these commands add over a curl one-liner is entirely in what reaches
 * the terminal and what lands in the local config, so that is what is pinned:
 *
 *  - a refusal prints the backend's SENTENCE, never the machine code that
 *    rides in `error` (lib/api/client.ts decides that from the shared
 *    contract's code vocabularies, so a code the CLI does not know about would
 *    print as a bare token);
 *  - the two-step email change remembers its address, so `verify-email <code>`
 *    is a code and nothing else; and
 *  - the stored account is refreshed after a change, so `nemar auth status`
 *    stops showing the value that was just replaced.
 *
 * Harness mirrors test/auth-request-upload-access-cli.test.ts: a real
 * subprocess CLI run against a real local HTTP server via TEST_API_URL, an
 * isolated NEMAR_CONFIG_DIR, and the real on-disk config store. No mocks.
 * `NEMAR_NO_BROWSER=1` keeps the ORCID cases from reaching for a browser.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

const ORCID = "0000-0002-1825-0097";

interface Reply {
  status: number;
  body: unknown;
}

interface Recorded {
  path: string;
  method: string;
  body: unknown;
}

interface FakeBackend {
  url: string;
  calls: Recorded[];
  stop: () => void;
}

/** The `/users/me` envelope, as the real backend shapes it. */
function meUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    username: "harlow",
    email: "harlow@example.org",
    github_username: "harlow-gh",
    role: "member",
    orcid: null,
    status: "verified",
    email_verified: true,
    orcid_verified: false,
    given_name: "Ada",
    family_name: "Lovelace",
    created_at: "2026-05-01T00:00:00Z",
    approved_at: null,
    dataset_count: 0,
    sandbox_completed: false,
    sandbox_completed_at: null,
    sandbox_dataset_id: null,
    service_access: false,
    ...overrides,
  };
}

interface BackendOptions {
  /** Keyed by path; the default is 200 `{ ok: true }`. */
  replies?: Record<string, Reply>;
  /** The user `/users/me` returns; a function is called per request so a test
   *  can make the ORCID iD appear part-way through a poll. */
  user?: Record<string, unknown> | ((callIndex: number) => Record<string, unknown>);
}

function startBackend(options: BackendOptions = {}): FakeBackend {
  const calls: Recorded[] = [];
  let meCalls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      if (url.pathname === "/users/me") {
        const user =
          typeof options.user === "function"
            ? options.user(meCalls++)
            : (options.user ?? meUser());
        return Response.json({ user, token: null });
      }
      calls.push({
        path: url.pathname,
        method: req.method,
        body: await req.json().catch(() => null),
      });
      const reply = options.replies?.[url.pathname];
      if (!reply) return Response.json({ ok: true });
      return Response.json(reply.body, { status: reply.status });
    },
  });
  return { url: `http://localhost:${server.port}`, calls, stop: () => server.stop(true) };
}

let configDir: string;

function seedAuthenticatedConfig(extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "harlow",
      accounts: {
        harlow: { apiKey: "test-user-key-0123456789", username: "harlow", ...extra },
      },
    }),
  );
}

function storedAccount(): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
  return raw.accounts.harlow;
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-profile-selfservice-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

async function runCli(args: string[], apiUrl: string) {
  const env = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: apiUrl,
    NEMAR_NO_UPDATE_CHECK: "1",
    NEMAR_NO_BROWSER: "1",
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
  // ora writes its spinner lines to stderr, so assertions that cover a
  // succeed/fail line read both streams.
  return { stdout, stderr, out: `${stdout}${stderr}`, exitCode };
}

// ---------------------------------------------------------------------------
// Email change
// ---------------------------------------------------------------------------

describe("nemar auth profile set-email", () => {
  test("sends the code and says what the second step is", async () => {
    seedAuthenticatedConfig();
    const backend = startBackend({
      replies: {
        "/auth/email/change/request": {
          status: 200,
          body: { ok: true, masked_email: "a**@lab.example.org" },
        },
      },
    });
    try {
      const result = await runCli(
        ["auth", "profile", "set-email", "ada@lab.example.org"],
        backend.url,
      );
      expect(result.exitCode).toBe(0);
      expect(result.out).toContain("Code sent to a**@lab.example.org");
      expect(result.out).toContain("nemar auth profile verify-email <code>");
      expect(backend.calls).toEqual([
        {
          path: "/auth/email/change/request",
          method: "POST",
          body: { email: "ada@lab.example.org" },
        },
      ]);
      // Remembered so the second step needs only the code.
      expect(storedAccount().pendingEmailChange).toBe("ada@lab.example.org");
      // Nothing has changed yet -- the address moves at verify time.
      expect(storedAccount().email).toBeUndefined();
    } finally {
      backend.stop();
    }
  });

  test("prints the backend's sentence for a taken address, not the code", async () => {
    seedAuthenticatedConfig();
    const backend = startBackend({
      replies: {
        "/auth/email/change/request": {
          status: 409,
          body: {
            error: "email_in_use",
            code: "email_in_use",
            message:
              "That email address already belongs to a NEMAR account. Sign in to that account instead, or change its address first (Settings, https://nemar.org/settings).",
          },
        },
      },
    });
    try {
      const result = await runCli(
        ["auth", "profile", "set-email", "taken@lab.example.org"],
        backend.url,
      );
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain("already belongs to a NEMAR account");
      expect(result.out).toContain("nemar.org/settings");
      // The machine code must not be what a person reads.
      expect(result.out).not.toContain("email_in_use");
      expect(storedAccount().pendingEmailChange).toBeUndefined();
    } finally {
      backend.stop();
    }
  });
});

describe("nemar auth profile verify-email", () => {
  test("uses the remembered address and updates the stored account", async () => {
    seedAuthenticatedConfig({ email: "old@example.org", pendingEmailChange: "ada@lab.example.org" });
    const backend = startBackend({
      replies: {
        "/auth/email/change/verify": { status: 200, body: { ok: true, old_address_notified: true } },
      },
      user: meUser({ email: "ada@lab.example.org" }),
    });
    try {
      const result = await runCli(["auth", "profile", "verify-email", "123456"], backend.url);
      expect(result.exitCode).toBe(0);
      expect(result.out).toContain("Account email is now ada@lab.example.org");
      expect(backend.calls[0]).toEqual({
        path: "/auth/email/change/verify",
        method: "POST",
        body: { email: "ada@lab.example.org", code: "123456" },
      });
      const account = storedAccount();
      expect(account.email).toBe("ada@lab.example.org");
      expect(account.pendingEmailChange).toBeUndefined();
    } finally {
      backend.stop();
    }
  });

  test("says so when the old address could not be told", async () => {
    seedAuthenticatedConfig({ pendingEmailChange: "ada@lab.example.org" });
    const backend = startBackend({
      replies: {
        "/auth/email/change/verify": {
          status: 200,
          body: { ok: true, old_address_notified: false },
        },
      },
      user: meUser({ email: "ada@lab.example.org" }),
    });
    try {
      const result = await runCli(["auth", "profile", "verify-email", "123456"], backend.url);
      expect(result.exitCode).toBe(0);
      expect(result.out).toContain("previous address could not be notified");
      expect(result.out).toContain("the change still applied");
    } finally {
      backend.stop();
    }
  });

  test("with nothing pending it explains rather than guessing an address", async () => {
    seedAuthenticatedConfig();
    const backend = startBackend();
    try {
      const result = await runCli(["auth", "profile", "verify-email", "123456"], backend.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain("No pending email change");
      expect(result.out).toContain("set-email");
      // Nothing was sent: a code alone cannot say which address it proves.
      expect(backend.calls).toEqual([]);
    } finally {
      backend.stop();
    }
  });

  test("--email finishes a change started on another machine", async () => {
    seedAuthenticatedConfig();
    const backend = startBackend({ user: meUser({ email: "ada@lab.example.org" }) });
    try {
      const result = await runCli(
        ["auth", "profile", "verify-email", "123456", "--email", "ada@lab.example.org"],
        backend.url,
      );
      expect(result.exitCode).toBe(0);
      expect(backend.calls[0].body).toEqual({ email: "ada@lab.example.org", code: "123456" });
    } finally {
      backend.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Profile fields
// ---------------------------------------------------------------------------

describe("nemar auth profile set-github / set-username / set-name / set-location", () => {
  test("set-github sends the handle and refreshes the stored account", async () => {
    seedAuthenticatedConfig();
    const backend = startBackend({ user: meUser({ github_username: "octocat" }) });
    try {
      const result = await runCli(["auth", "profile", "set-github", "octocat"], backend.url);
      expect(result.exitCode).toBe(0);
      expect(result.out).toContain("GitHub username set to octocat");
      expect(backend.calls[0]).toEqual({
        path: "/auth/profile",
        method: "PATCH",
        body: { github_username: "octocat" },
      });
      expect(storedAccount().githubUsername).toBe("octocat");
      // Every subcommand says where else the change can be made.
      expect(result.out).toContain("https://nemar.org/settings");
    } finally {
      backend.stop();
    }
  });

  test("set-github prints the refusal for a handle another account holds", async () => {
    seedAuthenticatedConfig();
    const backend = startBackend({
      replies: {
        "/auth/profile": {
          status: 409,
          body: {
            error: "github_in_use",
            code: "github_in_use",
            message:
              "That GitHub account is already linked to a NEMAR account. Sign in to that account instead, or change its GitHub username first (Settings, https://nemar.org/settings).",
          },
        },
      },
    });
    try {
      const result = await runCli(["auth", "profile", "set-github", "octocat"], backend.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain("already linked to a NEMAR account");
      expect(result.out).not.toContain("github_in_use");
    } finally {
      backend.stop();
    }
  });

  test("set-username prints the post-approval lock in the backend's words", async () => {
    seedAuthenticatedConfig();
    const backend = startBackend({
      replies: {
        "/auth/profile": {
          status: 409,
          body: {
            error: "username_locked",
            message:
              "Your username is fixed once an admin has approved your account; contact an admin to change it",
          },
        },
      },
    });
    try {
      const result = await runCli(["auth", "profile", "set-username", "adal"], backend.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain("fixed once an admin has approved");
      expect(result.out).not.toContain("username_locked");
    } finally {
      backend.stop();
    }
  });

  test("set-name sends both halves, and refuses to send an empty patch", async () => {
    seedAuthenticatedConfig();
    const backend = startBackend({ user: meUser() });
    try {
      const ok = await runCli(
        ["auth", "profile", "set-name", "--given", "Ada", "--family", "Lovelace"],
        backend.url,
      );
      expect(ok.exitCode).toBe(0);
      expect(backend.calls[0].body).toEqual({ given_name: "Ada", family_name: "Lovelace" });

      const empty = await runCli(["auth", "profile", "set-name"], backend.url);
      expect(empty.exitCode).toBe(1);
      expect(empty.out).toContain("Nothing to set");
      // Still one call: the empty invocation sent nothing.
      expect(backend.calls.length).toBe(1);
    } finally {
      backend.stop();
    }
  });

  test("set-name prints the ORCID-canonical refusal", async () => {
    seedAuthenticatedConfig();
    const backend = startBackend({
      replies: {
        "/auth/profile": {
          status: 409,
          body: {
            error: "name_is_orcid_canonical",
            message:
              "Your name comes from your ORCID record and is refreshed on every sign-in. Update it at orcid.org and sign in again.",
          },
        },
      },
    });
    try {
      const result = await runCli(
        ["auth", "profile", "set-name", "--given", "Augusta"],
        backend.url,
      );
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain("comes from your ORCID record");
      expect(result.out).not.toContain("name_is_orcid_canonical");
    } finally {
      backend.stop();
    }
  });

  test("set-location sends city and country together", async () => {
    seedAuthenticatedConfig();
    const backend = startBackend({ user: meUser() });
    try {
      const result = await runCli(
        ["auth", "profile", "set-location", "--city", "San Diego", "--country", "USA"],
        backend.url,
      );
      expect(result.exitCode).toBe(0);
      expect(result.out).toContain("Location updated");
      expect(backend.calls[0].body).toEqual({ city: "San Diego", country: "USA" });
    } finally {
      backend.stop();
    }
  });

  test("an unauthenticated config exits non-zero without calling the API", async () => {
    const backend = startBackend();
    try {
      const result = await runCli(["auth", "profile", "set-github", "octocat"], backend.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain("Not authenticated");
      expect(backend.calls).toEqual([]);
    } finally {
      backend.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// ORCID
// ---------------------------------------------------------------------------

describe("nemar auth profile orcid", () => {
  test("link prints the URL and waits for the iD to appear", async () => {
    seedAuthenticatedConfig();
    const backend = startBackend({
      replies: {
        "/auth/orcid/cli-start": {
          status: 200,
          body: {
            authorize_url: "https://app.nemar.org/auth/orcid/cli-handoff?t=signed-state",
            expires_in: 600,
            mode: "link",
          },
        },
      },
      // Call 0 is the "what is linked now" read before the flow starts; the
      // browser finishes between then and the first poll.
      user: (n) => meUser(n === 0 ? { orcid: null } : { orcid: ORCID, orcid_verified: true }),
    });
    try {
      const result = await runCli(
        ["auth", "profile", "orcid", "link", "--timeout", "20"],
        backend.url,
      );
      expect(result.exitCode).toBe(0);
      // The URL is always printed, whether or not a browser opened -- that is
      // what makes a headless machine a copy-and-paste rather than a dead end.
      expect(result.out).toContain("https://app.nemar.org/auth/orcid/cli-handoff?t=signed-state");
      expect(result.out).toContain(`ORCID iD ${ORCID} is linked`);
      expect(backend.calls[0]).toEqual({
        path: "/auth/orcid/cli-start",
        method: "POST",
        body: { mode: "link" },
      });
    } finally {
      backend.stop();
    }
  }, 30000);

  test("link gives up rather than claiming success it cannot see", async () => {
    seedAuthenticatedConfig();
    const backend = startBackend({
      replies: {
        "/auth/orcid/cli-start": {
          status: 200,
          body: {
            authorize_url: "https://app.nemar.org/auth/orcid/cli-handoff?t=signed-state",
            expires_in: 600,
            mode: "link",
          },
        },
      },
      // Nobody ever finishes in the browser.
      user: meUser({ orcid: null }),
    });
    try {
      const result = await runCli(
        ["auth", "profile", "orcid", "link", "--timeout", "1"],
        backend.url,
      );
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain("Gave up waiting");
      expect(result.out).toContain("nemar auth profile");
    } finally {
      backend.stop();
    }
  }, 30000);

  test("relink waits for a DIFFERENT iD, not merely for a non-empty one", async () => {
    // A relink starts and ends with `orcid` set, so "an iD is present" would
    // report success the instant the command started, before the person had
    // touched the browser. The previous value is what the wait is measured
    // against.
    const OTHER = "0000-0002-1974-1293";
    seedAuthenticatedConfig();
    const backend = startBackend({
      replies: {
        "/auth/orcid/cli-start": {
          status: 200,
          body: {
            authorize_url: "https://app.nemar.org/auth/orcid/cli-handoff?t=signed-state",
            expires_in: 600,
            mode: "relink",
          },
        },
      },
      // The OLD iD is still on the account for the first poll.
      user: (n) => meUser({ orcid: n < 2 ? ORCID : OTHER, orcid_verified: true }),
    });
    try {
      const result = await runCli(
        ["auth", "profile", "orcid", "relink", "--timeout", "20"],
        backend.url,
      );
      expect(result.exitCode).toBe(0);
      expect(result.out).toContain(`ORCID iD ${OTHER} is linked`);
      expect(result.out).not.toContain(`ORCID iD ${ORCID} is linked`);
      expect(backend.calls[0].body).toEqual({ mode: "relink" });
    } finally {
      backend.stop();
    }
  }, 30000);

  test("link prints the refusal when an iD is already linked", async () => {
    seedAuthenticatedConfig();
    const backend = startBackend({
      replies: {
        "/auth/orcid/cli-start": {
          status: 409,
          body: {
            error: "orcid_already_have",
            message:
              "This account is already linked to ORCID iD 0000-0002-1825-0097. Replace it with 'nemar auth profile orcid relink', or remove it with 'nemar auth profile orcid unlink'.",
          },
        },
      },
      user: meUser({ orcid: ORCID, orcid_verified: true }),
    });
    try {
      const result = await runCli(["auth", "profile", "orcid", "link"], backend.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain("already linked to ORCID iD");
      expect(result.out).toContain("orcid relink");
      expect(result.out).not.toContain("orcid_already_have");
    } finally {
      backend.stop();
    }
  });

  test("unlink asks first, and --yes goes through", async () => {
    seedAuthenticatedConfig();
    const backend = startBackend({ user: meUser() });
    try {
      const declined = await runCli(["auth", "profile", "orcid", "unlink", "--no"], backend.url);
      expect(declined.exitCode).toBe(0);
      expect(declined.out).toContain("Declined");
      expect(backend.calls).toEqual([]);

      const done = await runCli(["auth", "profile", "orcid", "unlink", "--yes"], backend.url);
      expect(done.exitCode).toBe(0);
      expect(done.out).toContain("ORCID iD unlinked");
      expect(backend.calls[0].path).toBe("/auth/orcid/unlink");
    } finally {
      backend.stop();
    }
  });

  test("an unknown action is named rather than silently ignored", async () => {
    seedAuthenticatedConfig();
    const backend = startBackend();
    try {
      const result = await runCli(["auth", "profile", "orcid", "connect"], backend.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain("Unknown action 'connect'");
      expect(backend.calls).toEqual([]);
    } finally {
      backend.stop();
    }
  });
});
