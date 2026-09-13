/**
 * `nemar admin docs` and the retrieval helper behind it (epic #1336 phase 3,
 * issue #1341).
 *
 * TWO LAYERS, and they test different things. {@link toMirrorPath} is pure, so
 * it is exercised directly. The command is driven through the real entry point
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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { DOCS_SESSION_COOKIE_NAME } from "../shared/contract/docs-auth.js";
import { toMirrorPath } from "../src/lib/docs-fetch.js";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const API_KEY = "nm_secret_cli_key_0123456789abcdefghij";
const DOCS_SESSION = "docs-session-value-0123456789";

describe("toMirrorPath", () => {
  test("adds .md to a bare path", () => {
    expect(toMirrorPath("admin/operations/zarr-serving")).toBe("/admin/operations/zarr-serving.md");
  });

  test("accepts a leading slash", () => {
    expect(toMirrorPath("/cli/commands")).toBe("/cli/commands.md");
  });

  test("drops the trailing slash the HTML spelling carries", () => {
    // `build.format` is 'directory' on this site, so every page's browser URL
    // ends in a slash. `.../commands/.md` is not a page, so the slash has to go
    // before the extension is added -- this is the spelling someone copying
    // from the address bar will paste.
    expect(toMirrorPath("/cli/commands/")).toBe("/cli/commands.md");
  });

  test("leaves an existing .md alone", () => {
    expect(toMirrorPath("cli/commands.md")).toBe("/cli/commands.md");
  });

  test("leaves other real extensions alone", () => {
    // llms.txt is the index an agent starts from, and sitemap.xml is how the
    // completeness check reads the site; both must stay reachable through the
    // same command rather than being rewritten to llms.txt.md.
    expect(toMirrorPath("llms.txt")).toBe("/llms.txt");
    expect(toMirrorPath("sitemap.xml")).toBe("/sitemap.xml");
  });

  test("maps the site root to /index.md", () => {
    // The root entry's id is literally `index`, so this needs no special case
    // on the serving side either; leaving `slug` undefined there would emit
    // `/.md`, a dotfile at the site root.
    expect(toMirrorPath("/")).toBe("/index.md");
    expect(toMirrorPath("")).toBe("/index.md");
  });

  test("accepts a full docs URL, taking only the path", () => {
    expect(toMirrorPath("https://docs.nemar.org/admin/commands/")).toBe("/admin/commands.md");
  });

  test("refuses a URL for another host rather than re-pointing it", () => {
    // Silently rewriting the host would answer a different question than the
    // one asked, with a page that looks like the answer.
    expect(() => toMirrorPath("https://example.com/admin/commands/")).toThrow(/docs\.nemar\.org/);
  });
});

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
  mints: number;
  docsRequests: { path: string; headers: Record<string, string> }[];
  stop: () => void;
}

/** `pages` maps a mirror path to what the docs host answers with. */
function startServers(pages: Record<string, Response | (() => Response)>): Servers {
  const state = {
    mints: 0,
    docsRequests: [] as { path: string; headers: Record<string, string> }[],
  };

  const api = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      if (url.pathname === "/auth/docs/cli-session") {
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
    rmSync(join(configDir, "config.json"), { force: true });
    const servers = startServers({ "/cli/commands.md": markdown("# Nope\n") });
    try {
      const result = await runCli(["admin", "docs", "cli/commands"], servers);
      expect(result.combined).toContain("Not authenticated");
      expect(servers.mints).toBe(0);
      expect(servers.docsRequests).toHaveLength(0);
    } finally {
      servers.stop();
    }
  });
});
