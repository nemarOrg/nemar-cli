/**
 * CLI `nemar admin upstream-backfill` (epic #1046 phase 2, #1908; ADR 0111), driven through the
 * real entry point (`bun run src/index.ts admin upstream-backfill ...`) as a subprocess pointed
 * at a real local HTTP server via TEST_API_URL, the harness `zarr-fidelity-sweep-cli.test.ts`
 * uses: the recorded requests are what the CLI's own `fetch()` sent. The server is the backend
 * stand-in only; the route behind it is tested on real SQLite in
 * `backend/test/upstream-backfill-route.test.ts`.
 *
 * What is pinned: a dry run by default (no `execute=1` on the wire), `--execute` sends it, the
 * loop follows `next_cursor`, a 502 body is read (not thrown away) so the cursor is printed, and
 * every outcome that is not a finished, error-free pass exits 1.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

type Page = { status?: number; body: Record<string, unknown> };

interface BackfillServer {
  url: string;
  requests: URL[];
  stop: () => void;
}

/** Serves `pages` in order to successive upstream-backfill calls (the last one repeats). */
function startServer(pages: Page[]): BackfillServer {
  const requests: URL[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      requests.push(url);
      const page = pages[Math.min(requests.length - 1, pages.length - 1)] as Page;
      return Response.json(page.body, { status: page.status ?? 200 });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

let configDir: string;

function seedAuthenticatedConfig(): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "ubfcliuser",
      accounts: { ubfcliuser: { apiKey: "test-admin-key" } },
    }),
  );
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-upstream-backfill-cli-"));
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

const COUNTS = { doi: 2, lineage: 0, unknown: 1, not_examined: 4 };

/** A batch body in the shape the route answers. */
function batch(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    execute: false,
    scanned: 2,
    recorded: { doi: 1, unknown: 1 },
    not_examined: 0,
    unparseable: 0,
    absent: 0,
    skipped_existing: 0,
    errors: [],
    suspect_credential: false,
    next_cursor: null,
    remaining: 0,
    counts: COUNTS,
    unknown_samples: [],
    ...over,
  };
}

describe("nemar admin upstream-backfill: auth", () => {
  test("without a stored apiKey nothing is sent", async () => {
    const server = startServer([{ body: batch() }]);
    try {
      const result = await runCli(["admin", "upstream-backfill"], server.url);
      expect(result.stdout).toContain("Not authenticated");
      expect(server.requests.length).toBe(0);
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin upstream-backfill: dry run by default", () => {
  test("no execute on the wire, the default limit is sent, and it says so", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ body: batch() }]);
    try {
      const result = await runCli(["admin", "upstream-backfill"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests).toHaveLength(1);
      const req = server.requests[0] as URL;
      expect(req.pathname).toBe("/admin/datasets/upstream-backfill");
      expect(req.searchParams.has("execute")).toBe(false);
      expect(req.searchParams.get("limit")).toBe("25");
      expect(result.stdout).toContain("Dry run");
      expect(result.stdout).toContain("pass --execute");
      expect(result.stdout).toContain("would record");
    } finally {
      server.stop();
    }
  });

  test("--execute sends execute=1 and does not print the dry-run notice", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ body: batch({ execute: true }) }]);
    try {
      const result = await runCli(["admin", "upstream-backfill", "--execute"], server.url);
      expect(result.exitCode).toBe(0);
      expect((server.requests[0] as URL).searchParams.get("execute")).toBe("1");
      expect(result.stdout).not.toContain("Dry run");
      expect(result.stdout).toContain("On versions now: doi=2");
    } finally {
      server.stop();
    }
  });

  test("--limit and --after are forwarded", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ body: batch() }]);
    try {
      await runCli(
        ["admin", "upstream-backfill", "--limit", "10", "--after", "on000123@1.0.0"],
        server.url,
      );
      const req = server.requests[0] as URL;
      expect(req.searchParams.get("limit")).toBe("10");
      expect(req.searchParams.get("after")).toBe("on000123@1.0.0");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin upstream-backfill: the loop", () => {
  test("it follows next_cursor until the pass is done, and sends each cursor as `after`", async () => {
    seedAuthenticatedConfig();
    const server = startServer([
      { body: batch({ next_cursor: "on000002@1.0.0", remaining: 3 }) },
      { body: batch({ next_cursor: "on000004@1.0.0", remaining: 1 }) },
      { body: batch({ next_cursor: null, remaining: 0 }) },
    ]);
    try {
      const result = await runCli(["admin", "upstream-backfill", "--execute"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests.map((r) => r.searchParams.get("after"))).toEqual([
        null,
        "on000002@1.0.0",
        "on000004@1.0.0",
      ]);
      expect(result.stdout).toContain("batch 3");
      expect(result.stdout).not.toContain("Resume with");
    } finally {
      server.stop();
    }
  });

  test("an error in a batch is reported, the pass continues, and the exit code is 1", async () => {
    seedAuthenticatedConfig();
    const server = startServer([
      {
        body: batch({
          next_cursor: "on000002@1.0.0",
          remaining: 1,
          not_examined: 1,
          errors: [
            { dataset_id: "on000001", version: "1.0.0", error: "HTTP 500 for the raw host" },
          ],
        }),
      },
      { body: batch() },
    ]);
    try {
      const result = await runCli(["admin", "upstream-backfill", "--execute"], server.url);
      expect(result.exitCode).toBe(1);
      expect(server.requests).toHaveLength(2);
      expect(result.stdout).toContain("on000001@1.0.0");
      expect(result.stdout).toContain("HTTP 500 for the raw host");
    } finally {
      server.stop();
    }
  });

  test("a 502 body is read, not thrown away: the cursor is printed and the loop stops", async () => {
    seedAuthenticatedConfig();
    const server = startServer([
      {
        status: 502,
        body: batch({
          ok: false,
          suspect_credential: true,
          absent: 25,
          next_cursor: "on000025@1.0.0",
          remaining: 100,
          error:
            "All 25 descriptions read as absent; the GitHub credential may not see these repositories. Nothing was written.",
        }),
      },
    ]);
    try {
      const result = await runCli(["admin", "upstream-backfill", "--execute"], server.url);
      expect(result.exitCode).toBe(1);
      expect(server.requests).toHaveLength(1);
      expect(result.stderr).toContain("read as absent");
      expect(result.stdout).toContain("Resume with: --after on000025@1.0.0");
    } finally {
      server.stop();
    }
  });

  test("an error response that is not a batch fails with its message", async () => {
    seedAuthenticatedConfig();
    const server = startServer([
      { status: 500, body: { error: "Failed to read or write dataset_versions" } },
    ]);
    try {
      const result = await runCli(["admin", "upstream-backfill", "--execute"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Failed to read or write dataset_versions");
    } finally {
      server.stop();
    }
  });

  test("--max-batches stops an unfinished pass, says so, prints the cursor and exits 1", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ body: batch({ next_cursor: "on000002@1.0.0", remaining: 9 }) }]);
    try {
      const result = await runCli(
        ["admin", "upstream-backfill", "--execute", "--max-batches", "2"],
        server.url,
      );
      expect(result.exitCode).toBe(1);
      expect(server.requests).toHaveLength(2);
      expect(result.stdout).toContain("--max-batches 2");
      expect(result.stdout).toContain("Resume with: --after on000002@1.0.0");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin upstream-backfill: what the operator is told", () => {
  test("it says that unknown is final, in a dry run and with --execute", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ body: batch() }]);
    try {
      for (const args of [
        ["admin", "upstream-backfill"],
        ["admin", "upstream-backfill", "--execute"],
      ]) {
        const result = await runCli(args, server.url);
        expect(result.stdout).toContain("'unknown' is final");
      }
    } finally {
      server.stop();
    }
  });

  test("a finished pass with transient rows says to rerun without --after", async () => {
    seedAuthenticatedConfig();
    const server = startServer([
      {
        body: batch({
          not_examined: 2,
          errors: [
            { dataset_id: "on000001", version: "1.0.0", error: "HTTP 500", kind: "transient" },
            {
              dataset_id: "on000002",
              version: "1.0.0",
              error: "control failed",
              kind: "transient",
            },
          ],
        }),
      },
    ]);
    try {
      const result = await runCli(["admin", "upstream-backfill", "--execute"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("2 row(s) were not examined after a transient error");
      expect(result.stdout).toContain("rerun without --after");
      expect(result.stdout).not.toContain("admin look");
    } finally {
      server.stop();
    }
  });

  test("rows absent at the tag and at main are told apart: no rerun, an admin look", async () => {
    seedAuthenticatedConfig();
    const server = startServer([
      {
        body: batch({
          not_examined: 3,
          errors: [
            { dataset_id: "on000001", version: "1.0.0", error: "HTTP 500", kind: "transient" },
            {
              dataset_id: "on000002",
              version: "1.0.0",
              error: "absent at both",
              kind: "needs_admin",
            },
            {
              dataset_id: "on000003",
              version: "2.0.0",
              error: "absent at both",
              kind: "needs_admin",
            },
          ],
        }),
      },
    ]);
    try {
      const result = await runCli(["admin", "upstream-backfill", "--execute"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("1 row(s) were not examined after a transient error");
      expect(result.stdout).toContain(
        "2 row(s) have no description at the tag or at main (or the default branch is not main): a rerun will not fix them and they need an admin look",
      );
      expect(result.stdout).toContain("on000002@1.0.0, on000003@2.0.0");
      expect(result.stdout).toContain("[needs admin]");
    } finally {
      server.stop();
    }
  });

  test("an unfinished pass prints the resume cursor, not the rerun line", async () => {
    seedAuthenticatedConfig();
    const server = startServer([
      {
        body: batch({
          next_cursor: "on000002@1.0.0",
          remaining: 5,
          not_examined: 1,
          errors: [{ dataset_id: "on000001", version: "1.0.0", error: "HTTP 500" }],
        }),
      },
    ]);
    try {
      const result = await runCli(
        ["admin", "upstream-backfill", "--execute", "--max-batches", "1"],
        server.url,
      );
      expect(result.stdout).toContain("Resume with: --after on000002@1.0.0");
      expect(result.stdout).not.toContain("rerun without --after");
    } finally {
      server.stop();
    }
  });

  test("a clean finished pass does not print the rerun line", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ body: batch() }]);
    try {
      const result = await runCli(["admin", "upstream-backfill", "--execute"], server.url);
      expect(result.stdout).not.toContain("rerun without --after");
    } finally {
      server.stop();
    }
  });

  test("--json prints no prose line", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ body: batch() }]);
    try {
      const result = await runCli(["admin", "upstream-backfill", "--json"], server.url);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin upstream-backfill: --json", () => {
  test("prints one summary object with the totals and the final counts", async () => {
    seedAuthenticatedConfig();
    const server = startServer([
      { body: batch({ next_cursor: "on000002@1.0.0", remaining: 1 }) },
      { body: batch() },
    ]);
    try {
      const result = await runCli(
        ["admin", "upstream-backfill", "--execute", "--json"],
        server.url,
      );
      expect(result.exitCode).toBe(0);
      const out = JSON.parse(result.stdout);
      expect(out).toMatchObject({
        execute: true,
        done: true,
        failure: null,
        batches: 2,
        scanned: 4,
        recorded: { doi: 2, unknown: 2 },
        next_cursor: null,
        counts: COUNTS,
      });
    } finally {
      server.stop();
    }
  });
});
