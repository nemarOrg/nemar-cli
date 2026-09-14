/**
 * `nemar admin docs` and the retrieval helper behind it (epic #1336 phase 3,
 * issue #1341).
 *
 * The command is driven through the real entry point
 * (`bun run src/index.ts admin docs ...`) against two real local HTTP servers,
 * one standing in for `api.nemar.org` via `TEST_API_URL` and one for
 * `docs.nemar.org` via `NEMAR_DOCS_URL` -- the same harness shape as
 * test/admin-keys-cli.test.ts, and real HTTP rather than a mocked fetch, so the
 * `redirect: "manual"` behavior and the cookie header are what is actually
 * observed on the wire.
 *
 * THE ASSERTION THAT MATTERS MOST is that the API key never reaches the docs
 * host. That is the separation ADR 0056 exists for and the reason this command
 * trades the key for something weaker, so the docs server records every header
 * it is sent and the test looks for the key in all of them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { DOCS_SESSION_COOKIE_NAME } from "../shared/contract/docs-auth.js";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const API_KEY = "nm_secret_cli_key_0123456789abcdefghij";
const DOCS_SESSION = "docs-session-value-0123456789";

// --------------------------------------------------------------------------
// The command, end to end
// --------------------------------------------------------------------------

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-docs-fetch-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "docsadmin",
      accounts: { docsadmin: { apiKey: API_KEY } },
    }),
  );
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

interface Servers {
  apiUrl: string;
  docsUrl: string;
  /** Set before running the CLI to make the mint answer 401. */
  refuseMint: boolean;
  mints: number;
  docsRequests: { path: string; headers: Record<string, string> }[];
  stop: () => void;
}

/** `pages` maps a mirror path to what the docs host answers with. */
function startServers(pages: Record<string, Response | (() => Response)>): Servers {
  const state = {
    mints: 0,
    refuseMint: false,
    docsRequests: [] as { path: string; headers: Record<string, string> }[],
  };

  const api = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      if (url.pathname === "/auth/docs/cli-session") {
        if (state.refuseMint) {
          return Response.json({ error: "Invalid or expired API key" }, { status: 401 });
        }
        if (req.headers.get("Authorization") !== `Bearer ${API_KEY}`) {
          return Response.json({ error: "unauthenticated" }, { status: 401 });
        }
        state.mints += 1;
        return Response.json(
          { session: DOCS_SESSION, max_age_seconds: 900, username: "docsadmin" },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  const docs = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      state.docsRequests.push({
        path: url.pathname,
        headers: Object.fromEntries(req.headers.entries()),
      });
      const page = pages[url.pathname];
      if (!page) return new Response("not found", { status: 404 });
      return typeof page === "function" ? page() : page.clone();
    },
  });

  return {
    apiUrl: `http://localhost:${api.port}`,
    docsUrl: `http://localhost:${docs.port}`,
    get refuseMint() {
      return state.refuseMint;
    },
    set refuseMint(value: boolean) {
      state.refuseMint = value;
    },
    get mints() {
      return state.mints;
    },
    get docsRequests() {
      return state.docsRequests;
    },
    stop: () => {
      api.stop(true);
      docs.stop(true);
    },
  };
}

async function runCli(args: string[], servers: Servers) {
  const env = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: servers.apiUrl,
    NEMAR_DOCS_URL: servers.docsUrl,
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
  return { stdout, stderr, exitCode, combined: `${stdout}${stderr}` };
}

function markdown(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}

describe("nemar admin docs", () => {
  test("prints a gated page's markdown to stdout", async () => {
    const servers = startServers({
      "/admin/operations/zarr-serving.md": markdown("# Zarr serving\n\nThe cron runs hourly.\n"),
    });
    try {
      const result = await runCli(["admin", "docs", "admin/operations/zarr-serving"], servers);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("# Zarr serving");
      expect(result.stdout).toContain("The cron runs hourly.");
    } finally {
      servers.stop();
    }
  });

  test("sends the docs session as a cookie and never the API key", async () => {
    // The whole point of the exchange. If this ever fails, the long-lived key
    // is reaching a host whose logs we do not control.
    const servers = startServers({ "/admin/commands.md": markdown("# Admin commands\n") });
    try {
      const result = await runCli(["admin", "docs", "admin/commands"], servers);
      expect(result.exitCode).toBe(0);

      expect(servers.docsRequests).toHaveLength(1);
      const sent = servers.docsRequests[0];
      expect(sent.headers.cookie).toBe(`${DOCS_SESSION_COOKIE_NAME}=${DOCS_SESSION}`);

      const everyHeaderValue = servers.docsRequests
        .flatMap((r) => Object.values(r.headers))
        .join("\n");
      expect(everyHeaderValue).not.toContain(API_KEY);
    } finally {
      servers.stop();
    }
  });

  test("several paths share one mint", async () => {
    // `/auth/docs/cli-session` is in the strict 10/min per-IP bucket, so a
    // reading session has to cost one credential rather than one per page.
    const servers = startServers({
      "/admin/commands.md": markdown("# One\n"),
      "/admin/operations/zarr-serving.md": markdown("# Two\n"),
      "/cli/commands.md": markdown("# Three\n"),
    });
    try {
      const result = await runCli(
        ["admin", "docs", "admin/commands", "admin/operations/zarr-serving", "cli/commands"],
        servers,
      );
      expect(result.exitCode).toBe(0);
      expect(servers.mints).toBe(1);
      expect(servers.docsRequests).toHaveLength(3);
      expect(result.stdout).toContain("# One");
      expect(result.stdout).toContain("# Two");
      expect(result.stdout).toContain("# Three");
    } finally {
      servers.stop();
    }
  });

  test("a refused page does not lose the pages that worked", async () => {
    const servers = startServers({ "/cli/commands.md": markdown("# Good\n") });
    try {
      const result = await runCli(["admin", "docs", "cli/commands", "admin/nope"], servers);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("# Good");
      expect(result.stderr).toContain("/admin/nope.md");
    } finally {
      servers.stop();
    }
  });

  test("does not follow the gate's redirect and call it a page", async () => {
    // `redirect: "manual"` is load-bearing: the gate refuses with a 302 to the
    // website's sign-in page, and following it returns 200 and a body of HTML
    // that would print as though the read succeeded.
    // The redirect target is a path on the STAND-IN docs host rather than the
    // real app.nemar.org, so that removing `redirect: "manual"` from the helper
    // follows it locally and this test goes red, instead of reaching for the
    // internet and being decided by whether CI has egress.
    const servers = startServers({
      "/admin/commands.md": () =>
        new Response(null, {
          status: 302,
          headers: { Location: "/auth/docs/authorize?next=%2Fadmin%2F" },
        }),
      "/auth/docs/authorize": () =>
        new Response("<!DOCTYPE html><title>Sign in</title>", {
          headers: { "Content-Type": "text/html" },
        }),
    });
    try {
      const result = await runCli(["admin", "docs", "admin/commands"], servers);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toContain("<!DOCTYPE");
      expect(result.stderr).toContain("expired");
    } finally {
      servers.stop();
    }
  });

  test("reports a gate that could not reach the API as retryable, not as a verdict", async () => {
    const servers = startServers({
      "/admin/commands.md": () => new Response("unavailable", { status: 503 }),
    });
    try {
      const result = await runCli(["admin", "docs", "admin/commands"], servers);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("try again");
      // Not phrased as an authorization problem: this says nothing about the
      // account, and telling someone they lack access when the gate merely
      // could not check is how a transient fault becomes a support ticket.
      expect(result.stderr).not.toContain("not an admin");
    } finally {
      servers.stop();
    }
  });

  test("a 404 says both things it can mean", async () => {
    // The gate answers a non-admin with 404 on purpose, so from out here these
    // two causes genuinely cannot be separated. Saying so beats guessing.
    const servers = startServers({});
    try {
      const result = await runCli(["admin", "docs", "admin/commands"], servers);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not found");
      expect(result.stderr).toContain("not an admin");
    } finally {
      servers.stop();
    }
  });

  test("refuses to run unauthenticated, without touching either host", async () => {
    // ASSERTS THE STREAM AND THE EXIT CODE, not `combined`. The first version
    // checked `combined`, which is stream-agnostic by construction, and so was
    // blind to both properties this command promises -- it passed while the
    // command exited 0 and wrote "Error: Not authenticated" to STDOUT, which
    // for `nemar admin docs x > page.md` means a success exit and an error
    // message sitting in page.md where a script would parse it as the page.
    rmSync(join(configDir, "config.json"), { force: true });
    const servers = startServers({ "/cli/commands.md": markdown("# Nope\n") });
    try {
      const result = await runCli(["admin", "docs", "cli/commands"], servers);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Not authenticated");
      expect(result.stdout).toBe("");
      expect(servers.mints).toBe(0);
      expect(servers.docsRequests).toHaveLength(0);
    } finally {
      servers.stop();
    }
  });

  test("a failed mint reports to stderr, exits 1, and writes nothing to stdout", async () => {
    // The other half of the same family, and previously untested: the shared
    // `handleCommandError` prints its hint with `console.log`, so a dead key
    // put "Sign in again with ..." into the redirected page file.
    const servers = startServers({});
    servers.refuseMint = true;
    try {
      const result = await runCli(["admin", "docs", "cli/commands"], servers);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Sign in again");
      expect(servers.docsRequests).toHaveLength(0);
    } finally {
      servers.stop();
    }
  });

  test("stdout carries only page bodies when a page fails alongside a good one", async () => {
    const servers = startServers({ "/cli/commands.md": markdown("# Good\n") });
    try {
      const result = await runCli(["admin", "docs", "cli/commands", "admin/nope"], servers);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("# Good");
      expect(result.stdout).not.toContain("nope");
      expect(result.stderr).toContain("/admin/nope.md");
    } finally {
      servers.stop();
    }
  });

  test("--no-headers silences the stderr banner without touching stdout", async () => {
    // The banner is on stderr, so this flag changes nothing about redirected
    // output -- which is exactly why it needs a test saying so, rather than
    // being assumed to control the page text.
    const pages = {
      "/cli/commands.md": markdown("# One\n"),
      "/admin/commands.md": markdown("# Two\n"),
    };
    const withBanner = startServers(pages);
    let plain: Awaited<ReturnType<typeof runCli>>;
    try {
      plain = await runCli(["admin", "docs", "cli/commands", "admin/commands"], withBanner);
    } finally {
      withBanner.stop();
    }
    const withoutBanner = startServers(pages);
    try {
      const quiet = await runCli(
        ["admin", "docs", "--no-headers", "cli/commands", "admin/commands"],
        withoutBanner,
      );
      expect(plain.exitCode).toBe(0);
      expect(quiet.exitCode).toBe(0);
      expect(plain.stderr).toContain("/cli/commands.md");
      expect(quiet.stderr).not.toContain("/cli/commands.md");
      // The pages themselves are byte-identical either way.
      expect(quiet.stdout).toBe(plain.stdout);
      expect(quiet.stdout).toContain("# One");
      expect(quiet.stdout).toContain("# Two");
    } finally {
      withoutBanner.stop();
    }
  });

  test("--debug never writes the docs session to the log file", async () => {
    // THE REGRESSION TEST FOR A SHIPPED LEAK. `SENSITIVE_BODY_KEY_RE` in
    // lib/debug-log.ts redacted `session_token` but not the bare key `session`,
    // which is what this response actually uses, so the debug log recorded a
    // live admin-docs credential in plaintext -- on the line after the one
    // where it correctly redacted the long-lived API key. The CLI's own error
    // hint tells people to re-run with --debug and attach the log to an issue.
    //
    // Asserted against the log FILE rather than the redactor in isolation: the
    // leak was in the composition (a response shape whose key the pattern did
    // not name), and a unit test of the redactor would have been written
    // against the keys its author already had in mind. The log lands under
    // NEMAR_CONFIG_DIR/logs, which runCli already isolates per test.
    const servers = startServers({ "/cli/commands.md": markdown("# Page\n") });
    try {
      const result = await runCli(["admin", "docs", "cli/commands", "--debug"], servers);
      expect(result.exitCode).toBe(0);

      const logDir = join(configDir, "logs");
      const files = existsSync(logDir) ? readdirSync(logDir) : [];
      expect(files.length).toBeGreaterThan(0);
      const all = files.map((f) => readFileSync(join(logDir, f), "utf8")).join("\n");

      // The log must prove it actually captured this exchange, or the two
      // assertions below would pass on an empty file.
      expect(all).toContain("/auth/docs/cli-session");
      expect(all).not.toContain(DOCS_SESSION);
      expect(all).not.toContain(API_KEY);
    } finally {
      servers.stop();
    }
  });

  test("a call with only unusable paths spends no credential", async () => {
    // The mint sits in the strict per-address bucket, so discovering that there
    // was nothing to fetch must not cost one. Paths are parsed first.
    const servers = startServers({});
    try {
      const result = await runCli(["admin", "docs", "https://example.com/admin/x"], servers);
      expect(result.exitCode).toBe(1);
      expect(servers.mints).toBe(0);
      expect(servers.docsRequests).toHaveLength(0);
      expect(result.stderr).toContain("example.com");
    } finally {
      servers.stop();
    }
  });
});
