/**
 * `nemar dataset publish request --anonymous` (#1408, epic #1406), driven
 * through the real CLI entry point.
 *
 * Same harness as test/has-zarr-cli-flag.test.ts: a real subprocess
 * (`bun run src/index.ts ...`) pointed at a real local HTTP server via
 * TEST_API_URL, so the recorded body is what the CLI's own `fetch()` actually
 * sent rather than a re-implementation of it.
 *
 * What makes this worth writing: the flag's entire job is to reach the wire.
 * An ordinary publication request posts NO body at all, and a `--anonymous`
 * request that silently lost its flag would look identical from the terminal
 * -- the depositor would be told their release was requested and would be
 * published under their own name instead. Both directions are asserted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

interface Recorded {
  pathname: string;
  body: string;
}

interface CaptureServer {
  url: string;
  requests: Recorded[];
  stop: () => void;
}

function startCaptureServer(body: unknown, status = 200): CaptureServer {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      // Every real `nemar` invocation fires a `GET /notices` preAction hook,
      // and commands can fire a fire-and-forget facets refresh. Both are
      // genuine traffic this server must answer, and neither is what this
      // test checks.
      if (url.pathname === "/notices") {
        return Response.json({ notices: [] });
      }
      if (url.pathname === "/datasets/facets") {
        return Response.json({});
      }
      requests.push({ pathname: url.pathname, body: await req.text() });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-publish-anon-cli-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "anoncli",
      accounts: { anoncli: { apiKey: "test-anon-key" } },
    }),
  );
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

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

const ACCEPTED = {
  message: "Publication requested",
  dataset_id: "nm000104",
  status: "requested",
};

describe("nemar dataset publish request --anonymous", () => {
  test("sends anonymous: true in the request body", async () => {
    const server = startCaptureServer(ACCEPTED);
    try {
      const result = await runCli(
        ["dataset", "publish", "request", "nm000104", "--anonymous"],
        server.url,
      );
      expect(result.exitCode).toBe(0);
      const posted = server.requests.filter((r) => r.pathname.endsWith("/publish/request"));
      expect(posted.length).toBe(1);
      expect(JSON.parse(posted[0].body)).toEqual({ anonymous: true });
    } finally {
      server.stop();
    }
  });

  test("without the flag the request carries no body at all", async () => {
    // The control, and it also pins a compatibility fact: an ordinary
    // publication request has always been a bodyless POST, and it stays one.
    const server = startCaptureServer(ACCEPTED);
    try {
      const result = await runCli(["dataset", "publish", "request", "nm000104"], server.url);
      expect(result.exitCode).toBe(0);
      const posted = server.requests.filter((r) => r.pathname.endsWith("/publish/request"));
      expect(posted.length).toBe(1);
      expect(posted[0].body).toBe("");
    } finally {
      server.stop();
    }
  });

  test("the terminal says which of the two was asked for", async () => {
    // A depositor who typed --anonymous and got an ordinary publication has no
    // way to tell from the output unless the output distinguishes them.
    const server = startCaptureServer(ACCEPTED);
    try {
      const result = await runCli(
        ["dataset", "publish", "request", "nm000104", "--anonymous"],
        server.url,
      );
      expect(result.stdout + result.stderr).toMatch(/anonymous release/i);
    } finally {
      server.stop();
    }
  });
});

describe("nemar dataset status reports the state", () => {
  function statusServer(anonymous: number | null): CaptureServer {
    return startCaptureServer({
      dataset: {
        dataset_id: "nm000104",
        name: "A study of something",
        status: "active",
        visibility: "public",
        created_at: "2026-01-01T00:00:00Z",
        github_repo: "nemarDatasets/nm000104",
        anonymous,
      },
    });
  }

  test("an anonymous deposit is named as such, and its repository is not offered", async () => {
    // `visibility: public` with no authors reads as an incomplete record
    // unless the state is stated. And the repository is PRIVATE, so printing
    // its URL offers a link that 404s while disclosing the repo exists.
    const server = statusServer(1);
    try {
      const result = await runCli(["dataset", "status", "nm000104"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Anonymous:\s+identity withheld until publication/);
      expect(result.stdout).toContain("without --anonymous");
      expect(result.stdout).not.toContain("github.com/nemarDatasets/nm000104");
    } finally {
      server.stop();
    }
  });

  test("an ordinary dataset shows its repository and no anonymity line", async () => {
    // The control: the same payload minus the flag must behave as it always has.
    const server = statusServer(0);
    try {
      const result = await runCli(["dataset", "status", "nm000104"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("github.com/nemarDatasets/nm000104");
      expect(result.stdout).not.toContain("Anonymous:");
    } finally {
      server.stop();
    }
  });
});
