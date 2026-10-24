/**
 * CLI `nemar admin upstream-status` (epic #1046 phase 4b, #1910; ADR 0111), driven through the
 * real entry point (`bun run src/index.ts admin upstream-status ...`) as a subprocess pointed at a
 * real local HTTP server via TEST_API_URL, the harness `upstream-backfill-cli.test.ts` uses: the
 * recorded requests are what the CLI's own `fetch()` sent. The server is the backend stand-in
 * only, serving hand-written page bodies in the wire shape (wire fixtures); the route behind it
 * is tested on real SQLite in `backend/test/upstream-status-route.test.ts`.
 *
 * What is pinned: the method and query, the loop following `next_cursor`, every state printed
 * with its number (zeros included), the totals recounted from the rows (a page's own `counts` is
 * never added up), and the exit codes: 0 with stale mirrors, 2 for anything the pass could not
 * see (an `unchecked` row, a 502 page, a 200 carrying `errors[]`, `--max-pages`, a population that
 * changed), 1 for a failed request.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import {
  UPSTREAM_STATES,
  type UpstreamState,
  type UpstreamStatusRow,
  countUpstreamStates,
} from "../shared/upstream-staleness";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

type Page = { status?: number; body: Record<string, unknown> };

interface StatusServer {
  url: string;
  requests: URL[];
  methods: string[];
  stop: () => void;
}

/** Serves `pages` in order to successive upstream-status calls (the last one repeats). */
function startServer(pages: Page[]): StatusServer {
  const requests: URL[] = [];
  const methods: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      requests.push(url);
      methods.push(req.method);
      const page = pages[Math.min(requests.length - 1, pages.length - 1)] as Page;
      return Response.json(page.body, { status: page.status ?? 200 });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    requests,
    methods,
    stop: () => server.stop(true),
  };
}

let configDir: string;

function seedAuthenticatedConfig(): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "upscliuser",
      accounts: { upscliuser: { apiKey: "test-admin-key" } },
    }),
  );
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-upstream-status-cli-"));
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

// ----------------------------------------------------------------------------
// Wire fixtures
// ----------------------------------------------------------------------------

function row(
  id: string,
  state: UpstreamState,
  over: Partial<UpstreamStatusRow> = {},
): UpstreamStatusRow {
  return {
    dataset_id: id,
    ds: `ds${id.slice(2)}`,
    visibility: "public",
    state,
    anomaly: null,
    reason: `reason for ${id}`,
    recorded: { version: "1.0.0", tag: "2.0.2", basis: "doi" },
    upstream: { latest_tag: "2.1.0", latest_created: "2026-10-24T04:10:36.000Z", snapshots: [] },
    import_status: "complete",
    probably_stale: null,
    ...over,
  };
}

/** A page body in the shape the route answers; counts are for the page, as the route's are. */
function page(
  rows: UpstreamStatusRow[],
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ok: true,
    rows,
    counts: countUpstreamStates(rows),
    next_cursor: null,
    remaining: 0,
    population_total: rows.length,
    withdrawn: 2,
    excluded_unmanaged: 1,
    upstream_requests: 1,
    probes: { attempted: 0, budget: 100 },
    errors: [],
    ...over,
  };
}

const STALE = row("on003645", "stale_ready");
const CURRENT = row("on002893", "current", {
  recorded: { version: "1.0.0", tag: "2.0.0", basis: "doi" },
});

describe("nemar admin upstream-status: auth and arguments", () => {
  test("without a stored apiKey nothing is sent", async () => {
    const server = startServer([{ body: page([CURRENT]) }]);
    try {
      const result = await runCli(["admin", "upstream-status"], server.url);
      expect(result.stdout).toContain("Not authenticated");
      expect(server.requests.length).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("bad arguments exit 1 and send nothing", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ body: page([CURRENT]) }]);
    try {
      for (const args of [
        ["--limit", "0"],
        ["--limit", "abc"],
        ["--max-pages", "0"],
        ["--list", "-1"],
        ["--dataset", "ds003645"],
        ["--after", "nope"],
        ["--dataset", "on003645", "--after", "on000001"],
      ]) {
        const result = await runCli(["admin", "upstream-status", ...args], server.url);
        expect(result.exitCode).toBe(1);
      }
      expect(server.requests.length).toBe(0);
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin upstream-status: the request", () => {
  test("a GET carrying limit, after and dataset", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ body: page([STALE]) }]);
    try {
      await runCli(["admin", "upstream-status", "--limit", "7", "--after", "on000010"], server.url);
      await runCli(["admin", "upstream-status", "--dataset", "on003645"], server.url);
      expect(server.methods).toEqual(["GET", "GET"]);
      expect(server.requests[0]?.pathname).toBe("/admin/upstream-status");
      expect(server.requests[0]?.searchParams.get("limit")).toBe("7");
      expect(server.requests[0]?.searchParams.get("after")).toBe("on000010");
      expect(server.requests[0]?.searchParams.get("dataset")).toBeNull();
      expect(server.requests[1]?.searchParams.get("dataset")).toBe("on003645");
      expect(server.requests[1]?.searchParams.get("after")).toBeNull();
    } finally {
      server.stop();
    }
  });

  test("the loop follows next_cursor until it is null", async () => {
    seedAuthenticatedConfig();
    const server = startServer([
      {
        body: page([row("on000001", "current")], { next_cursor: "on000001", population_total: 3 }),
      },
      {
        body: page([row("on000002", "current")], { next_cursor: "on000002", population_total: 3 }),
      },
      { body: page([row("on000003", "current")], { population_total: 3 }) },
    ]);
    try {
      const result = await runCli(["admin", "upstream-status", "--limit", "1"], server.url);
      expect(server.requests.map((u) => u.searchParams.get("after"))).toEqual([
        null,
        "on000001",
        "on000002",
      ]);
      expect(result.stdout).toContain("Examined 3 of 3");
      expect(result.exitCode).toBe(0);
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin upstream-status: the report", () => {
  test("every state prints with its number, zeros included, in order", async () => {
    seedAuthenticatedConfig();
    const rows = [STALE, CURRENT, row("on000004", "in_progress")];
    const server = startServer([{ body: page(rows) }]);
    try {
      const result = await runCli(["admin", "upstream-status"], server.url);
      const lines = result.stdout.split("\n");
      let at = -1;
      for (const state of UPSTREAM_STATES) {
        const index = lines.findIndex((l) => new RegExp(`^\\s+${state}\\s+\\d+\\s`).test(l));
        expect(index).toBeGreaterThan(at);
        at = index;
      }
      const count = (state: string) =>
        Number(new RegExp(`^\\s+${state}\\s+(\\d+)\\s`, "m").exec(result.stdout)?.[1]);
      expect(count("stale_ready")).toBe(1);
      expect(count("current")).toBe(1);
      expect(count("in_progress")).toBe(1);
      expect(count("unchecked")).toBe(0);
      expect(count("mirror_lag")).toBe(0);
      expect(result.stdout).toContain("Stale in total: 1");
      expect(result.stdout).toContain("2 withdrawn and 1 unmanaged");
    } finally {
      server.stop();
    }
  });

  test("a stale row is named with both tags and its reason", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ body: page([STALE]) }]);
    try {
      const result = await runCli(["admin", "upstream-status"], server.url);
      expect(result.stdout).toContain("on003645  ds003645  2.0.2 -> 2.1.0  reason for on003645");
    } finally {
      server.stop();
    }
  });

  test("--list bounds the rows per state and says how many more", async () => {
    seedAuthenticatedConfig();
    const rows = ["on000001", "on000002", "on000003"].map((id) => row(id, "stale_ready"));
    const server = startServer([{ body: page(rows) }]);
    try {
      const result = await runCli(["admin", "upstream-status", "--list", "2"], server.url);
      expect(result.stdout).toContain("on000001  ds000001");
      expect(result.stdout).toContain("on000002  ds000002");
      expect(result.stdout).not.toContain("on000003  ds000003");
      expect(result.stdout).toContain("and 1 more");
    } finally {
      server.stop();
    }
  });

  test("the totals are recounted from the rows, never added from the pages' counts", async () => {
    seedAuthenticatedConfig();
    // The same row on both pages (it cannot happen with a keyset, but the totals must not care)
    // and page counts that lie: only the rows count.
    const lie = { ...countUpstreamStates([]), stale: 99 };
    const server = startServer([
      { body: page([STALE], { next_cursor: "on003645", population_total: 1, counts: lie }) },
      { body: page([STALE], { population_total: 1, counts: lie }) },
    ]);
    try {
      const result = await runCli(["admin", "upstream-status", "--json"], server.url);
      const json = JSON.parse(result.stdout);
      expect(json.examined).toBe(1);
      expect(json.counts.states.stale_ready).toBe(1);
      expect(json.counts.stale).toBe(1);
      expect(json.rows).toHaveLength(1);
    } finally {
      server.stop();
    }
  });

  test("unknown rows are said to be not compared, and are not a failure", async () => {
    seedAuthenticatedConfig();
    const unknown = row("on003082", "unknown", {
      recorded: { version: "1.0.0", tag: null, basis: "unknown" },
      reason:
        "version 1.0.0 names no single upstream tag; OpenNeuro could not be read for ds003082: HTTP 503",
      probably_stale: null,
    });
    const server = startServer([{ body: page([CURRENT, unknown]) }]);
    try {
      const result = await runCli(["admin", "upstream-status"], server.url);
      expect(result.stdout).toContain("1 mirror(s) have an unknown tag");
      expect(result.stdout).toContain("not compared");
      expect(result.exitCode).toBe(0);
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin upstream-status: exit codes", () => {
  test("stale rows alone exit 0", async () => {
    seedAuthenticatedConfig();
    const rows = [STALE, row("on004362", "mirror_lag"), row("on000001", "stale_unverified")];
    const server = startServer([{ body: page(rows) }]);
    try {
      const result = await runCli(["admin", "upstream-status"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Stale in total: 3");
    } finally {
      server.stop();
    }
  });

  test("an unchecked row on a 200 exits 2 and says so", async () => {
    seedAuthenticatedConfig();
    const server = startServer([
      {
        body: page([
          CURRENT,
          row("on000001", "unchecked", { reason: "OpenNeuro could not be read" }),
        ]),
      },
    ]);
    try {
      const result = await runCli(["admin", "upstream-status"], server.url);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("1 mirror(s) could not be compared");
    } finally {
      server.stop();
    }
  });

  test("a 200 whose errors[] is not empty exits 2 even with no unchecked row", async () => {
    seedAuthenticatedConfig();
    const server = startServer([
      { body: page([CURRENT], { errors: ["ds000001..ds000050: OpenNeuro answered HTTP 503"] }) },
    ]);
    try {
      const result = await runCli(["admin", "upstream-status"], server.url);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("OpenNeuro answered HTTP 503");
    } finally {
      server.stop();
    }
  });

  test("a 502 page exits 2, is read and not thrown away, and the walk stops there", async () => {
    seedAuthenticatedConfig();
    const refused = page([row("on000001", "unchecked")], {
      ok: false,
      error: "OpenNeuro could not be read for any mirror that needed a verdict",
      next_cursor: "on000001",
      population_total: 5,
    });
    const server = startServer([{ status: 502, body: refused }, { body: page([CURRENT]) }]);
    try {
      const result = await runCli(["admin", "upstream-status"], server.url);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("HTTP 502");
      expect(result.stdout).toContain("OpenNeuro could not be read for any mirror");
      expect(server.requests.length).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("a 502 is a refusal whatever its body's ok says", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ status: 502, body: page([row("on000001", "unchecked")]) }]);
    try {
      const result = await runCli(["admin", "upstream-status"], server.url);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("HTTP 502");
    } finally {
      server.stop();
    }
  });

  test("--max-pages reached with more to read exits 2", async () => {
    seedAuthenticatedConfig();
    const server = startServer([
      {
        body: page([row("on000001", "current")], { next_cursor: "on000001", population_total: 2 }),
      },
      { body: page([row("on000002", "current")], { population_total: 2 }) },
    ]);
    try {
      const result = await runCli(["admin", "upstream-status", "--max-pages", "1"], server.url);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("--max-pages");
      expect(server.requests.length).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("--max-pages that is exactly enough is a complete pass", async () => {
    seedAuthenticatedConfig();
    const server = startServer([
      {
        body: page([row("on000001", "current")], { next_cursor: "on000001", population_total: 2 }),
      },
      { body: page([row("on000002", "current")], { population_total: 2 }) },
    ]);
    try {
      const result = await runCli(["admin", "upstream-status", "--max-pages", "2"], server.url);
      expect(result.exitCode).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("a population that changed during the pass exits 2", async () => {
    seedAuthenticatedConfig();
    const changedDuring = startServer([
      {
        body: page([row("on000001", "current")], { next_cursor: "on000001", population_total: 2 }),
      },
      { body: page([row("on000002", "current")], { population_total: 3 }) },
    ]);
    const shortOfPopulation = startServer([{ body: page([CURRENT], { population_total: 3 }) }]);
    try {
      const a = await runCli(["admin", "upstream-status"], changedDuring.url);
      expect(a.exitCode).toBe(2);
      expect(a.stdout).toContain("population changed");
      const b = await runCli(["admin", "upstream-status"], shortOfPopulation.url);
      expect(b.exitCode).toBe(2);
      expect(b.stdout).toContain("rerun");
    } finally {
      changedDuring.stop();
      shortOfPopulation.stop();
    }
  });

  test("--after and --dataset do not demand the whole fleet", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ body: page([CURRENT], { population_total: 900 }) }]);
    try {
      expect(
        (await runCli(["admin", "upstream-status", "--after", "on000001"], server.url)).exitCode,
      ).toBe(0);
      expect(
        (await runCli(["admin", "upstream-status", "--dataset", "on002893"], server.url)).exitCode,
      ).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("a failed request exits 1 and names the failure", async () => {
    seedAuthenticatedConfig();
    const server = startServer([
      { status: 404, body: { error: "on000008 is not a managed OpenNeuro mirror" } },
    ]);
    try {
      const result = await runCli(
        ["admin", "upstream-status", "--dataset", "on000008"],
        server.url,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Stopped:");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin upstream-status --json", () => {
  test("parses and carries complete, the population and could_not_see", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ body: page([STALE, CURRENT]) }]);
    try {
      const result = await runCli(["admin", "upstream-status", "--json"], server.url);
      const json = JSON.parse(result.stdout);
      expect(json.complete).toBe(true);
      expect(json.could_not_see).toEqual([]);
      expect(json.examined).toBe(2);
      expect(json.population).toEqual({ start: 2, end: 2, withdrawn: 2, excluded_unmanaged: 1 });
      expect(json.counts.states.stale_ready).toBe(1);
      expect(Object.keys(json.counts.states)).toEqual([...UPSTREAM_STATES]);
      expect(json.rows).toHaveLength(2);
      expect(json.errors).toEqual([]);
      expect(result.exitCode).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("an incomplete pass says so in the JSON and still exits 2", async () => {
    seedAuthenticatedConfig();
    const server = startServer([
      { body: page([row("on000001", "unchecked")], { errors: ["batch failed"] }) },
    ]);
    try {
      const result = await runCli(["admin", "upstream-status", "--json"], server.url);
      const json = JSON.parse(result.stdout);
      expect(json.complete).toBe(false);
      expect(json.could_not_see.length).toBeGreaterThan(0);
      expect(json.errors).toEqual(["batch failed"]);
      expect(result.exitCode).toBe(2);
    } finally {
      server.stop();
    }
  });
});
