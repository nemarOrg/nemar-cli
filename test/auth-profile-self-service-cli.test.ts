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
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
        // The sentinel a test uses to revoke the key part-way through a poll.
        if ((user as { unauthorized?: boolean }).unauthorized) {
          return Response.json({ error: "Invalid or expired API key" }, { status: 401 });
        }
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

interface RunOptions {
  /** Let the CLI actually try to open a browser, with `pathPrefix` supplying
   *  a fake opener. Every other test keeps NEMAR_NO_BROWSER=1: a test suite
   *  may not open real browser windows. */
  allowBrowser?: boolean;
  /** Prepended to PATH, so a fake `open` / `xdg-open` is found first. */
  pathPrefix?: string;
}

async function runCli(args: string[], apiUrl: string, options: RunOptions = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: apiUrl,
    NEMAR_NO_UPDATE_CHECK: "1",
    NEMAR_NO_BROWSER: options.allowBrowser ? undefined : "1",
    NO_COLOR: "1",
  };
  if (options.pathPrefix) env.PATH = `${options.pathPrefix}:${process.env.PATH ?? ""}`;
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

  test("a wrong code prints the attempts left, not the code name", async () => {
    seedAuthenticatedConfig({ pendingEmailChange: "ada@lab.example.org" });
    const backend = startBackend({
      replies: {
        "/auth/email/change/verify": {
          status: 401,
          body: {
            error: "code_incorrect",
            message: "That code did not match. 4 attempts left before it is invalidated.",
            attempts_remaining: 4,
          },
        },
      },
    });
    try {
      const result = await runCli(["auth", "profile", "verify-email", "000000"], backend.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain("4 attempts left");
      expect(result.out).not.toContain("code_incorrect");
      // The pending address survives a wrong guess: the next attempt is the
      // same two-step flow, not a new one.
      expect(storedAccount().pendingEmailChange).toBe("ada@lab.example.org");
      expect(storedAccount().email).toBeUndefined();
    } finally {
      backend.stop();
    }
  });

  test("an expired code says to request a new one", async () => {
    seedAuthenticatedConfig({ pendingEmailChange: "ada@lab.example.org" });
    const backend = startBackend({
      replies: {
        "/auth/email/change/verify": {
          status: 401,
          body: {
            error: "code_expired",
            message: "That code has expired or has already been used. Request a new one.",
          },
        },
      },
    });
    try {
      const result = await runCli(["auth", "profile", "verify-email", "123456"], backend.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain("Request a new one");
      expect(result.out).not.toContain("code_expired");
    } finally {
      backend.stop();
    }
  });

  test("a config write that fails does not report the change as failed", async () => {
    // The server has already moved the address and spent the code by the time
    // the local write runs, so a `conf` failure is a stale local copy, not a
    // failed change. Inside the request's try/catch it printed "Could not
    // confirm the new address", which sends a person to request a code they
    // no longer need (#1266 review item 5).
    seedAuthenticatedConfig({ pendingEmailChange: "ada@lab.example.org" });
    const backend = startBackend({
      replies: {
        "/auth/email/change/verify": { status: 200, body: { ok: true, old_address_notified: true } },
      },
      user: meUser({ email: "ada@lab.example.org" }),
    });
    // Readable, not writable: the store loads and every write fails.
    chmodSync(configDir, 0o500);
    try {
      const result = await runCli(["auth", "profile", "verify-email", "123456"], backend.url);
      expect(result.out).toContain("Account email is now ada@lab.example.org");
      expect(result.out).toContain("The change is live on the server");
      expect(result.out).toContain("local config could not be updated");
      expect(result.out).not.toContain("Could not confirm the new address");
      expect(result.exitCode).toBe(0);
    } finally {
      chmodSync(configDir, 0o700);
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

  test("set-username re-keys the stored account, so `auth switch` finds it", async () => {
    // The accounts map is keyed by username. Writing the new name into the
    // account's fields and leaving the key alone produced an account that
    // `nemar auth switch <new>` could not find (#1266 review item 4).
    seedAuthenticatedConfig();
    const backend = startBackend({ user: meUser({ username: "alovelace" }) });
    try {
      const result = await runCli(["auth", "profile", "set-username", "alovelace"], backend.url);
      expect(result.exitCode).toBe(0);
      expect(result.out).toContain("Username set to alovelace");
      expect(backend.calls[0].body).toEqual({ username: "alovelace" });

      const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
      expect(Object.keys(config.accounts)).toEqual(["alovelace"]);
      expect(config.activeAccount).toBe("alovelace");
      // The credentials moved with the key, rather than being left behind.
      expect(config.accounts.alovelace.apiKey).toBe("test-user-key-0123456789");

      // The actual thing that was broken: switching by the new name.
      const switched = await runCli(["auth", "switch", "alovelace"], backend.url);
      expect(switched.exitCode).toBe(0);
      expect(switched.out).toContain("alovelace");
      expect(switched.out).not.toContain("not found");
    } finally {
      backend.stop();
    }
  });

  test("a name another stored account holds is kept, and said out loud", async () => {
    // Two accounts on one machine, and the server accepts a rename onto the
    // OTHER one's key -- sign in as harlow, sign in as alovelace, then rename
    // harlow to alovelace. The re-key declines rather than deleting a working
    // API key to fix a display name, and the warning is the point: without it
    // `nemar auth switch alovelace` silently selects the other account.
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        activeAccount: "harlow",
        accounts: {
          harlow: { apiKey: "test-user-key-0123456789", username: "harlow" },
          alovelace: { apiKey: "someone-elses-key", username: "alovelace" },
        },
      }),
    );
    const backend = startBackend({ user: meUser({ username: "alovelace" }) });
    try {
      const result = await runCli(["auth", "profile", "set-username", "alovelace"], backend.url);
      // The change DID land on the server; only the local re-key was skipped.
      expect(result.exitCode).toBe(0);
      expect(result.out).toContain("Username set to alovelace");
      expect(result.out).toContain("already has a different account stored as 'alovelace'");
      expect(result.out).toContain("stay under the old name");

      const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
      expect(Object.keys(config.accounts).sort()).toEqual(["alovelace", "harlow"]);
      expect(config.activeAccount).toBe("harlow");
      // Neither account's credentials were clobbered by the other's.
      expect(config.accounts.harlow.apiKey).toBe("test-user-key-0123456789");
      expect(config.accounts.alovelace.apiKey).toBe("someone-elses-key");
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

  test("an older backend that lacks the route says so, in its own words", async () => {
    // The API's 404 body names the route; leading with `error` rendered the
    // whole thing as the words "Not Found", which reads as "your account is
    // missing" rather than "this deployment predates the command you ran"
    // (#1266 review item 6).
    seedAuthenticatedConfig();
    const backend = startBackend({
      replies: {
        "/auth/profile": {
          status: 404,
          body: { error: "Not Found", message: "Route PATCH /auth/profile not found" },
        },
      },
    });
    try {
      const result = await runCli(["auth", "profile", "set-github", "octocat"], backend.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain("Route PATCH /auth/profile not found");
      expect(result.out).toContain("does not support this command yet");
      expect(result.out).not.toContain("Could not update your profile");
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

  test("--timeout rejects a value it would otherwise silently ignore", async () => {
    // It used to fall back to 300 on anything unparseable, so `--timeout 5m`
    // was accepted and then ignored -- and the person watched a five-minute
    // wait they thought they had shortened (#1266 review item 9).
    seedAuthenticatedConfig();
    const backend = startBackend();
    try {
      for (const bad of ["5m", "0", "-30", "abc"]) {
        const result = await runCli(
          ["auth", "profile", "orcid", "link", "--timeout", bad],
          backend.url,
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.out).toContain("--timeout must be a whole number of seconds");
        // Refused at the argument boundary: nothing was minted.
        expect(backend.calls).toEqual([]);
      }
    } finally {
      backend.stop();
    }
  });

  test("a poll that stops authenticating gives up early and says why", async () => {
    // Burning the full timeout on a revoked key ends in "gave up waiting",
    // which sends the person to look at their browser rather than at their
    // credentials (#1266 review item 7).
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
      // The pre-flight read succeeds; the key is revoked before the first poll.
      user: (n) => (n === 0 ? meUser({ orcid: null }) : { unauthorized: true }),
    });
    try {
      const started = Date.now();
      const result = await runCli(
        ["auth", "profile", "orcid", "link", "--timeout", "120"],
        backend.url,
      );
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain("no longer authenticate");
      expect(result.out).toContain("nemar auth login");
      expect(result.out).not.toContain("Gave up waiting");
      // The point of the change: it did not wait out the two minutes.
      expect(Date.now() - started).toBeLessThan(30_000);
    } finally {
      backend.stop();
    }
  }, 40000);

  test("--no-open suppresses the opener; without it the opener runs", async () => {
    // NEMAR_NO_BROWSER=1 is set for every other test in this file, which made
    // --no-open untestable (#1266 review item 14). Here the flag is the only
    // difference, and a fake `open` / `xdg-open` first on PATH records
    // whether the CLI reached for a browser at all.
    seedAuthenticatedConfig();
    const binDir = mkdtempSync(join(tmpdir(), "nemar-fake-opener-"));
    const marker = join(binDir, "opened.txt");
    // Both names, so the test does not depend on which platform runs it.
    for (const name of ["open", "xdg-open"]) {
      writeFileSync(join(binDir, name), `#!/bin/sh
echo "$1" >> "${marker}"
`);
      chmodSync(join(binDir, name), 0o755);
    }
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
      user: meUser({ orcid: null }),
    });

    /** The spawn is detached, so the marker can land after the CLI exits. */
    async function markerAppears(): Promise<boolean> {
      for (let i = 0; i < 20; i++) {
        if (existsSync(marker)) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    }

    try {
      const suppressed = await runCli(
        ["auth", "profile", "orcid", "link", "--no-open", "--timeout", "1"],
        backend.url,
        { allowBrowser: true, pathPrefix: binDir },
      );
      expect(suppressed.out).toContain("https://app.nemar.org/auth/orcid/cli-handoff?t=signed-state");
      expect(suppressed.out).not.toContain("trying to open your browser");
      expect(await markerAppears()).toBe(false);

      const opened = await runCli(
        ["auth", "profile", "orcid", "link", "--timeout", "1"],
        backend.url,
        { allowBrowser: true, pathPrefix: binDir },
      );
      expect(opened.out).toContain("trying to open your browser");
      expect(await markerAppears()).toBe(true);
      // It opened the URL it printed, not something else.
      expect(readFileSync(marker, "utf8")).toContain("cli-handoff?t=signed-state");
    } finally {
      backend.stop();
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 40000);

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
