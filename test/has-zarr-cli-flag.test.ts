/**
 * CLI `--has-zarr` flag (issue #1062, epic #1181 phase 2), driven through
 * the real `nemar dataset list` / `nemar dataset search` entry points.
 * Mirrors test/facet-cli-options.unit.test.ts's harness exactly: a real
 * subprocess CLI invocation (`bun run src/index.ts ...`) pointed at a real
 * local HTTP server via TEST_API_URL (src/lib/api/client.ts#getApiUrl) --
 * the recorded request's query string is what the CLI's own `fetch()` call
 * actually sent, not a re-implementation of it.
 *
 * There is no pre-existing `--has-hed` flag to mirror byte-for-byte (the
 * real HED flag is `--hed`, serialized to `has_hed=1` -- see
 * src/commands/dataset.ts); this test follows the same MECHANISM
 * (commander option -> DatasetListFilters/DatasetSearchFilters ->
 * URLSearchParams) that flag already uses, for the `--has-zarr` name the
 * phase 2 brief specifies.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

interface CaptureServer {
  url: string;
  requests: URL[];
  stop: () => void;
}

function startCaptureServer(body: unknown, status = 200): CaptureServer {
  const requests: URL[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      // Every real `nemar` invocation fires a `GET /notices` preAction hook
      // first, and a successful list/search fires a fire-and-forget `GET
      // /datasets/facets` refresh afterward (src/lib/completion/refresh.ts)
      // -- genuine traffic this capture server must answer but that is not
      // part of what these tests check, so both are excluded from the
      // recorded requests (same exclusions as facet-cli-options.unit.test.ts).
      if (url.pathname === "/notices") {
        return new Response(JSON.stringify({ notices: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/datasets/facets") {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      requests.push(url);
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
  configDir = mkdtempSync(join(tmpdir(), "nemar-has-zarr-cli-"));
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

const EMPTY_LIST_ENVELOPE = { datasets: [], count: 0, total_count: 0, limit: 20, offset: 0 };
const EMPTY_SEARCH_ENVELOPE = { results: [], count: 0 };

describe("nemar dataset list --has-zarr", () => {
  test("maps to ?has_zarr=1 on the real request", async () => {
    const server = startCaptureServer(EMPTY_LIST_ENVELOPE);
    try {
      const result = await runCli(["dataset", "list", "--json", "--has-zarr"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests.length).toBe(1);
      expect(server.requests[0].searchParams.get("has_zarr")).toBe("1");
    } finally {
      server.stop();
    }
  });

  test("without the flag, has_zarr is absent from the query string", async () => {
    const server = startCaptureServer(EMPTY_LIST_ENVELOPE);
    try {
      const result = await runCli(["dataset", "list", "--json"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests.length).toBe(1);
      expect(server.requests[0].searchParams.has("has_zarr")).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("stacks with an unrelated filter (--doi) without disturbing it", async () => {
    const server = startCaptureServer(EMPTY_LIST_ENVELOPE);
    try {
      const result = await runCli(["dataset", "list", "--json", "--has-zarr", "--doi"], server.url);
      expect(result.exitCode).toBe(0);
      const params = server.requests[0].searchParams;
      expect(params.get("has_zarr")).toBe("1");
      expect(params.get("has_doi")).toBe("true");
    } finally {
      server.stop();
    }
  });
});

describe("nemar dataset search --has-zarr", () => {
  test("maps to ?has_zarr=1 on the real request", async () => {
    const server = startCaptureServer(EMPTY_SEARCH_ENVELOPE);
    try {
      const result = await runCli(
        ["dataset", "search", "resting state", "--json", "--has-zarr"],
        server.url,
      );
      expect(result.exitCode).toBe(0);
      expect(server.requests.length).toBe(1);
      const params = server.requests[0].searchParams;
      expect(params.get("has_zarr")).toBe("1");
      expect(params.get("q")).toBe("resting state");
    } finally {
      server.stop();
    }
  });

  test("without the flag, has_zarr is absent from the query string", async () => {
    const server = startCaptureServer(EMPTY_SEARCH_ENVELOPE);
    try {
      const result = await runCli(["dataset", "search", "resting state", "--json"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests[0].searchParams.has("has_zarr")).toBe(false);
    } finally {
      server.stop();
    }
  });
});
