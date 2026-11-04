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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import {
  UPSTREAM_STATES,
  type UpstreamSnapshot,
  type UpstreamState,
  type UpstreamStatusRow,
  countUpstreamStates,
} from "../shared/upstream-staleness";
import { startOpenNeuroFilesStandin } from "./helpers/openneuro-files-standin";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

type Page = { status?: number; body: Record<string, unknown> };

interface StatusServer {
  url: string;
  requests: URL[];
  methods: string[];
  /** Calls to GET /admin/repulls/switches: kept apart, so they never take a page or count in `requests`. */
  switchRequests: URL[];
  stop: () => void;
}

/**
 * Serves `pages` in order to successive upstream-status calls (the last one repeats). `--measure`
 * also reads the Worker's open cap at GET /admin/repulls/switches: that route answers `switches`
 * when it is given, and the API's own 404 (a backend that predates the route) when it is not.
 */
function startServer(pages: Page[], switches?: Page): StatusServer {
  const requests: URL[] = [];
  const methods: string[] = [];
  const switchRequests: URL[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      if (url.pathname === "/admin/repulls/switches") {
        switchRequests.push(url);
        if (switches === undefined) {
          return Response.json(
            { error: "Not Found", message: "Route GET /admin/repulls/switches not found" },
            { status: 404 },
          );
        }
        return Response.json(switches.body, { status: switches.status ?? 200 });
      }
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
    switchRequests,
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
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env = {
    ...process.env,
    ...extraEnv,
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
      // The row is named, so an administrator can find it.
      expect(result.stdout).toContain("on000001  ds000001");
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

  test("--dataset answered with no row exits 2: the mirror was not examined", async () => {
    seedAuthenticatedConfig();
    // A withdrawn or unmanaged mirror: a 200 with no rows (the route answers 404, but a CLI must
    // not call an empty answer a clean one).
    const server = startServer([{ body: page([], { population_total: 900 }) }]);
    try {
      const result = await runCli(
        ["admin", "upstream-status", "--dataset", "on000008"],
        server.url,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("exactly one row");
    } finally {
      server.stop();
    }
  });

  test("a failed first request prints the failure and no table of zeros", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ status: 500, body: { error: "boom" } }]);
    try {
      const result = await runCli(["admin", "upstream-status"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Stopped:");
      expect(result.stdout).not.toContain("Examined");
      expect(result.stdout).not.toMatch(/^\s+current\s+0\s/m);
      expect(result.stdout).not.toContain("Stale in total");
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

  test("a request that fails after the first page is complete:false with a reason, and exits 1", async () => {
    seedAuthenticatedConfig();
    const server = startServer([
      {
        body: page([row("on000001", "current")], { next_cursor: "on000001", population_total: 3 }),
      },
      { status: 500, body: { error: "boom" } },
    ]);
    try {
      const result = await runCli(["admin", "upstream-status", "--json"], server.url);
      const json = JSON.parse(result.stdout);
      expect(json.complete).toBe(false);
      expect(json.could_not_see.length).toBeGreaterThan(0);
      expect(json.failure).toBeTruthy();
      expect(json.examined).toBe(1);
      expect(result.exitCode).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("a failed first request in --json has no rows, complete:false and a failure", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ status: 500, body: { error: "boom" } }]);
    try {
      const result = await runCli(["admin", "upstream-status", "--json"], server.url);
      const json = JSON.parse(result.stdout);
      expect(json.complete).toBe(false);
      expect(json.rows).toEqual([]);
      expect(json.failure).toBeTruthy();
      expect(result.exitCode).toBe(1);
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

// ----------------------------------------------------------------------------
// --measure (Phase 4c)
// ----------------------------------------------------------------------------

describe("nemar admin upstream-status --measure", () => {
  // The two recorded listings: ds002893 1.0.0 -> 2.0.0 (data-changing, 3,431,782,003 bytes to copy)
  // and ds003082 1.0.0 -> 1.0.1 (metadata-only, a real zero). The wire rows are hand-written; their
  // snapshot lists are the recorded ones, so the DOI volume reads real creation dates.
  const GRAPHQL = join(import.meta.dir, "../backend/test/fixtures/openneuro-graphql");
  const recordedSnapshots = (ds: string): UpstreamSnapshot[] => {
    const request = JSON.parse(
      readFileSync(join(GRAPHQL, "graphql-upstream-snapshots.request.json"), "utf-8"),
    ) as { variables: Record<string, string> };
    const response = JSON.parse(
      readFileSync(join(GRAPHQL, "graphql-upstream-snapshots.response.json"), "utf-8"),
    ) as { data: Record<string, { snapshots: { tag: string; created: string }[] } | null> };
    const alias = Object.keys(request.variables).find((a) => request.variables[a] === ds);
    return response.data[alias as string]?.snapshots ?? [];
  };
  const staleRow = (id: string, from: string, to: string) =>
    row(id, "stale_ready", {
      recorded: { version: "1.0.0", tag: from, basis: "doi" },
      upstream: {
        latest_tag: to,
        latest_created: "2022-06-18T00:00:00.000Z",
        snapshots: recordedSnapshots(`ds${id.slice(2)}`),
      },
    });
  const DATA = staleRow("on002893", "1.0.0", "2.0.0");
  const META = staleRow("on003082", "1.0.0", "1.0.1");

  test("totals the two recorded deltas, in JSON and in the human block", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ body: page([META, DATA]) }]);
    const files = startOpenNeuroFilesStandin();
    try {
      const env = { NEMAR_OPENNEURO_GRAPHQL_URL: files.url };
      const json = await runCli(
        ["admin", "upstream-status", "--measure", "--json"],
        server.url,
        env,
      );
      expect(json.exitCode).toBe(0);
      const out = JSON.parse(json.stdout);
      expect(out.measurement.totals).toEqual({
        stale: 2,
        measured: 2,
        not_measured: 0,
        metadata_only: 1,
        data_changing: 1,
        delta_unknown: 0,
        files_added: 29,
        files_changed: 326,
        files_deleted: 76,
        bytes_to_copy: 3431782003,
        bytes_to_copy_known: 3431782003,
        not_comparable: {
          unknown: 0,
          probably_stale: 0,
          not_examined: 0,
          unchecked: 0,
          anomaly: 0,
          in_progress: 0,
          parked: 0,
          unpublished: 0,
        },
        catch_up_days: 1,
      });
      expect(out.measurement.scope).toBe("fleet");
      expect(out.measurement.complete).toBe(true);
      expect(out.measurement_skipped).toBeNull();
      // This stand-in has no switches route (a 404), so the estimate uses the default cap, says so
      // in the measurement, and warns on stderr (never into the JSON on stdout).
      expect(out.measurement.open_cap).toEqual({ value: 2, source: "default" });
      expect(json.stderr).toContain("Warning: the Worker's open cap could not be read (");
      expect(out.measurement.doi_volume.catch_up).toBe(2);
      expect(out.measurement.deltas.map((d: { dataset_id: string }) => d.dataset_id)).toEqual([
        "on002893",
        "on003082",
      ]);
      // One request per mirror, asking for exactly the recorded and the latest tag.
      expect(files.requests.map((r) => [r.ds, r.from, r.to])).toEqual([
        ["ds002893", "1.0.0", "2.0.0"],
        ["ds003082", "1.0.0", "1.0.1"],
      ]);

      const human = await runCli(["admin", "upstream-status", "--measure"], server.url, env);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain("Measured 2: metadata-only 1, data-changing 1");
      expect(human.stdout).toContain("Files added 29, changed 326, deleted 76");
      expect(human.stdout).toContain("Bytes to copy: 3431782003 (3.2 GiB)");
      expect(human.stdout).toContain("Scope: the whole fleet; only stale mirrors are measured");
      expect(human.stdout).toContain("Not covered by these totals (never measured, not zero)");
      expect(human.stdout).toContain(
        "At the default open cap (2; the Worker's cap could not be read) the catch-up takes 1 day(s).",
      );
      expect(human.stdout).not.toContain("REPULL_DAILY_OPEN_CAP=");
      expect(human.stdout).not.toContain("Warning:");
      expect(human.stderr).toContain("Warning: the Worker's open cap could not be read (");
      expect(human.stdout).toContain("upstream's between the two tags, not NEMAR's tree");
      expect(human.stdout).toContain("a declaration, not a tree comparison");
      expect(human.stdout).toContain("nemar admin repull plan");
      expect(human.stdout).toMatch(/on002893 {2}ds002893 {2}1\.0\.0 -> 2\.0\.0 {2}data-changing/);
      expect(human.stdout).toMatch(/on003082 {2}ds003082 {2}1\.0\.0 -> 1\.0\.1 {2}metadata-only/);
    } finally {
      server.stop();
      files.stop();
    }
  }, 30_000);

  // The Worker's answer to GET /admin/repulls/switches, in the wire shape of
  // shared/repull-observability.ts (`RepullSwitchesReport`). `value` and `source` are loose on
  // purpose, so a case can send a word or a value this CLI does not know.
  const switchesReply = (value: unknown, source: string): Page => ({
    body: {
      switches: {
        environment_is_production: true,
        auto_repull_enabled: true,
        auto_repull_merge_enabled: false,
        open_cap: { value, source },
        merge_cap: { value: 5, source: "default" },
      },
      scheduler: null,
    },
  });

  test("the open cap the Worker reports sets the catch-up estimate", async () => {
    seedAuthenticatedConfig();
    const files = startOpenNeuroFilesStandin();
    // Two stale mirrors are two re-pulls: ceil(2 / 1) = 2 days at a cap of 1, and ceil(2 / 2) = 1 day
    // at a cap of 2, whether the Worker set it or defaulted it. A cap of 0, set on purpose or
    // unreadable (a malformed binding reads 0), opens no automatic re-pull: no day count, a null in
    // the JSON, and a line that says so. An unreadable cap is the Worker's answer and must never
    // fall back to the default of 2, which would promise a finish that cannot happen.
    const cases = [
      {
        reply: switchesReply(1, "set"),
        open_cap: { value: 1, source: "worker" },
        days: 2,
        line: "  At the open cap the Worker reports (1) the catch-up takes 2 day(s).",
      },
      {
        reply: switchesReply(2, "default"),
        open_cap: { value: 2, source: "worker" },
        days: 1,
        line: "  At the open cap the Worker reports (2) the catch-up takes 1 day(s).",
      },
      {
        reply: switchesReply(0, "set"),
        open_cap: { value: 0, source: "worker" },
        days: null,
        line: "  At the open cap the Worker reports (0), so no automatic re-pull is opened and the catch-up never finishes.",
      },
      {
        reply: switchesReply(0, "unreadable"),
        open_cap: { value: 0, source: "unreadable" },
        days: null,
        line: "  The Worker cannot read its open cap (its binding is malformed, so it reads 0), so no automatic re-pull is opened and the catch-up never finishes until the binding is fixed.",
      },
    ];
    try {
      const env = { NEMAR_OPENNEURO_GRAPHQL_URL: files.url };
      for (const c of cases) {
        const server = startServer([{ body: page([META, DATA]) }], c.reply);
        try {
          const json = await runCli(
            ["admin", "upstream-status", "--measure", "--json"],
            server.url,
            env,
          );
          expect(json.exitCode).toBe(0);
          const m = JSON.parse(json.stdout).measurement;
          expect(m.open_cap).toEqual(c.open_cap);
          expect(m.totals.catch_up_days).toBe(c.days);
          // A reading the CLI understands is not a warning, whatever it says about the cap.
          expect(json.stderr).not.toContain("Warning:");

          const human = await runCli(["admin", "upstream-status", "--measure"], server.url, env);
          expect(human.exitCode).toBe(0);
          expect(human.stdout).toContain(c.line);
          expect(human.stdout).not.toContain("default open cap");
          expect(human.stdout).not.toMatch(/Infinity|NaN/);
          expect(human.stderr).not.toContain("Warning:");
          // One read of the switches per run, kept apart from the pages: two runs, two of each.
          expect(server.switchRequests.length).toBe(2);
          expect(server.requests.length).toBe(2);
        } finally {
          server.stop();
        }
      }
    } finally {
      files.stop();
    }
  }, 60_000);

  test("a switches read that fails, or that this CLI does not know, leaves the default cap, warns on stderr and changes no exit code", async () => {
    seedAuthenticatedConfig();
    const files = startOpenNeuroFilesStandin();
    // The warning lines, quoted. A failed call names why in parentheses; an unknown reading says
    // so.
    const failedRead =
      /^Warning: the Worker's open cap could not be read \(.+\); the estimate uses the default\.$/m;
    const unknownReading =
      "Warning: the Worker's open cap reading is not one this CLI knows; the estimate uses the default.";
    // The call fails: a refusal, and a 200 whose body has no `switches` (so reading its `open_cap`
    // throws). Neither may fail the command.
    const failedCalls: Page[] = [{ status: 500, body: { error: "boom" } }, { body: {} }];
    // The call succeeds with a reading this CLI cannot use: a source it does not know, and values
    // that are not a count. The default stands in for each, and the CLI says so.
    const unknownReadings: Page[] = [
      switchesReply(2, "bogus"),
      switchesReply("two", "set"),
      switchesReply(-1, "set"),
      switchesReply(1.5, "default"),
    ];
    try {
      const env = { NEMAR_OPENNEURO_GRAPHQL_URL: files.url };
      for (const reply of [...failedCalls, ...unknownReadings]) {
        const failed = failedCalls.includes(reply);
        const server = startServer([{ body: page([META, DATA]) }], reply);
        try {
          const result = await runCli(
            ["admin", "upstream-status", "--measure", "--json"],
            server.url,
            env,
          );
          expect(result.exitCode).toBe(0);
          // The JSON on stdout stays one clean document: the warning goes to stderr, once.
          const m = JSON.parse(result.stdout).measurement;
          expect(m.open_cap).toEqual({ value: 2, source: "default" });
          expect(m.totals.catch_up_days).toBe(1);
          expect(result.stdout).not.toContain("Warning:");
          if (failed) expect(result.stderr).toMatch(failedRead);
          else expect(result.stderr).toContain(unknownReading);
          expect(result.stderr.match(/Warning:/g)?.length).toBe(1);
          expect(server.switchRequests.length).toBe(1);
        } finally {
          server.stop();
        }
      }

      // The exit code stays the pass's own: a delta that cannot be read is still a 2.
      files.failDataset("ds003082", 503);
      const server = startServer([{ body: page([META, DATA]) }], failedCalls[0]);
      try {
        const result = await runCli(["admin", "upstream-status", "--measure"], server.url, env);
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toContain(
          "At the default open cap (2; the Worker's cap could not be read)",
        );
        expect(result.stdout).not.toContain("Warning:");
        expect(result.stderr).toMatch(failedRead);
      } finally {
        server.stop();
      }
    } finally {
      files.stop();
    }
  }, 60_000);

  test("a listing that cannot be read is an unknown delta, null bytes, an at-least sum, exit 2", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ body: page([META, DATA]) }]);
    const files = startOpenNeuroFilesStandin();
    files.failDataset("ds003082", 503);
    try {
      const env = { NEMAR_OPENNEURO_GRAPHQL_URL: files.url };
      const json = await runCli(
        ["admin", "upstream-status", "--measure", "--json"],
        server.url,
        env,
      );
      expect(json.exitCode).toBe(2);
      const out = JSON.parse(json.stdout);
      const t = out.measurement.totals;
      expect(t.delta_unknown).toBe(1);
      expect(t.measured).toBe(1);
      expect(t.bytes_to_copy).toBeNull();
      expect(t.bytes_to_copy_known).toBe(3431782003);
      expect(out.complete).toBe(false);
      const bad = out.measurement.deltas.find(
        (d: { dataset_id: string }) => d.dataset_id === "on003082",
      );
      expect(bad.delta).toBeNull();
      expect(bad.reason).toContain("HTTP 503");

      const human = await runCli(["admin", "upstream-status", "--measure"], server.url, env);
      expect(human.exitCode).toBe(2);
      expect(human.stdout).toContain("unknown; at least 3431782003");
      expect(human.stdout).toContain("delta unknown: OpenNeuro GraphQL answered HTTP 503");
      expect(human.stdout).toContain("had a delta that could not be read");
    } finally {
      server.stop();
      files.stop();
    }
  }, 30_000);

  test("--measure-limit measures the first stale mirrors in order; the rest are not measured, not zero", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ body: page([META, DATA]) }]);
    const files = startOpenNeuroFilesStandin();
    try {
      const env = { NEMAR_OPENNEURO_GRAPHQL_URL: files.url };
      const result = await runCli(
        ["admin", "upstream-status", "--measure", "--measure-limit", "1", "--json"],
        server.url,
        env,
      );
      expect(result.exitCode).toBe(0);
      const t = JSON.parse(result.stdout).measurement.totals;
      expect(t.measured).toBe(1);
      expect(t.not_measured).toBe(1);
      expect(t.bytes_to_copy).toBeNull();
      expect(t.bytes_to_copy_known).toBe(3431782003);
      expect(files.requests.length).toBe(1);
    } finally {
      server.stop();
      files.stop();
    }
  }, 30_000);

  test("mirror_lag and stale_unverified rows are stale and are measured too", async () => {
    seedAuthenticatedConfig();
    const lag = { ...staleRow("on002893", "1.0.0", "2.0.0"), state: "mirror_lag" as const };
    const unverified = {
      ...staleRow("on003082", "1.0.0", "1.0.1"),
      state: "stale_unverified" as const,
    };
    const server = startServer([{ body: page([lag, unverified]) }]);
    const files = startOpenNeuroFilesStandin();
    try {
      const env = { NEMAR_OPENNEURO_GRAPHQL_URL: files.url };
      const result = await runCli(
        ["admin", "upstream-status", "--measure", "--json"],
        server.url,
        env,
      );
      expect(result.exitCode).toBe(0);
      const t = JSON.parse(result.stdout).measurement.totals;
      expect([t.stale, t.measured, t.data_changing, t.metadata_only]).toEqual([2, 2, 1, 1]);
      expect(files.requests.length).toBe(2);
    } finally {
      server.stop();
      files.stop();
    }
  }, 30_000);

  test("rows that cannot be measured are counted beside the totals and say what the scope was", async () => {
    seedAuthenticatedConfig();
    const rows = [
      DATA,
      row("on000010", "unknown", { recorded: null, probably_stale: true }),
      row("on000011", "unknown", { recorded: null, probably_stale: false }),
      row("on000012", "not_examined", { recorded: null }),
      row("on000013", "anomaly", { anomaly: "upstream_deleted" }),
      row("on000014", "in_progress"),
    ];
    const server = startServer([{ body: page(rows) }]);
    const files = startOpenNeuroFilesStandin();
    try {
      const env = { NEMAR_OPENNEURO_GRAPHQL_URL: files.url };
      const json = await runCli(
        ["admin", "upstream-status", "--measure", "--dataset", "on002893", "--json"],
        server.url,
        env,
      );
      // The dataset scope expects exactly one row, so this pass is not complete and is not measured.
      expect(JSON.parse(json.stdout).measurement).toBeNull();

      const result = await runCli(
        ["admin", "upstream-status", "--measure", "--json"],
        server.url,
        env,
      );
      expect(result.exitCode).toBe(0);
      const out = JSON.parse(result.stdout).measurement;
      expect(out.totals.not_comparable).toEqual({
        unknown: 2,
        probably_stale: 1,
        not_examined: 1,
        unchecked: 0,
        anomaly: 1,
        in_progress: 1,
        parked: 0,
        unpublished: 0,
      });
      expect(out.doi_volume.excluded).toMatchObject({
        unknown: 2,
        not_examined: 1,
        anomaly: 1,
        in_progress: 1,
      });
      const human = await runCli(["admin", "upstream-status", "--measure"], server.url, env);
      expect(human.stdout).toContain(
        "2 unknown tag (1 of them probably stale by date), 1 never examined, 0 unchecked, 1 anomaly, 1 in progress, 0 parked, 0 unpublished",
      );
      expect(human.stdout).toContain("DOI estimate left out:");
      expect(human.stdout).toContain("2 unknown");
      expect(human.stdout).toContain("1 not_examined");
    } finally {
      server.stop();
      files.stop();
    }
  }, 30_000);

  test("a scoped pass names its scope in the measurement", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ body: page([DATA]) }]);
    const files = startOpenNeuroFilesStandin();
    try {
      const env = { NEMAR_OPENNEURO_GRAPHQL_URL: files.url };
      const byDataset = await runCli(
        ["admin", "upstream-status", "--measure", "--dataset", "on002893", "--json"],
        server.url,
        env,
      );
      expect(JSON.parse(byDataset.stdout).measurement.scope).toBe("dataset");
      const byCursor = await runCli(
        ["admin", "upstream-status", "--measure", "--after", "on000001", "--json"],
        server.url,
        env,
      );
      expect(JSON.parse(byCursor.stdout).measurement.scope).toBe("after");
    } finally {
      server.stop();
      files.stop();
    }
  }, 30_000);

  test("a refused (502) page is not measured: null, the reason, exit 2, OpenNeuro not asked", async () => {
    seedAuthenticatedConfig();
    const refused = page([DATA], {
      ok: false,
      error: "OpenNeuro could not be read for any mirror that needed a verdict",
      next_cursor: "on002893",
      population_total: 5,
    });
    const server = startServer([{ status: 502, body: refused }]);
    const files = startOpenNeuroFilesStandin();
    try {
      const env = { NEMAR_OPENNEURO_GRAPHQL_URL: files.url };
      const json = await runCli(
        ["admin", "upstream-status", "--measure", "--json"],
        server.url,
        env,
      );
      expect(json.exitCode).toBe(2);
      const out = JSON.parse(json.stdout);
      expect(out.measurement).toBeNull();
      expect(out.measurement_skipped).toContain("did not finish cleanly");
      const human = await runCli(["admin", "upstream-status", "--measure"], server.url, env);
      expect(human.exitCode).toBe(2);
      expect(human.stdout).toContain("Not measured: the pass did not finish cleanly");
      expect(files.requests.length).toBe(0);
      // Nothing is measured, so nothing asks the Worker for its cap.
      expect(server.switchRequests.length).toBe(0);
    } finally {
      server.stop();
      files.stop();
    }
  }, 30_000);

  test("--max-pages reached is not measured either", async () => {
    seedAuthenticatedConfig();
    const server = startServer([
      { body: page([DATA], { next_cursor: "on002893", population_total: 2 }) },
      { body: page([META], { population_total: 2 }) },
    ]);
    const files = startOpenNeuroFilesStandin();
    try {
      const env = { NEMAR_OPENNEURO_GRAPHQL_URL: files.url };
      const result = await runCli(
        ["admin", "upstream-status", "--measure", "--max-pages", "1", "--json"],
        server.url,
        env,
      );
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout).measurement).toBeNull();
      expect(files.requests.length).toBe(0);
    } finally {
      server.stop();
      files.stop();
    }
  }, 30_000);

  test("an unchecked row means the stale set may be partial: not measured", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ body: page([DATA, row("on000020", "unchecked")]) }]);
    const files = startOpenNeuroFilesStandin();
    try {
      const env = { NEMAR_OPENNEURO_GRAPHQL_URL: files.url };
      const result = await runCli(
        ["admin", "upstream-status", "--measure", "--json"],
        server.url,
        env,
      );
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout).measurement).toBeNull();
      expect(files.requests.length).toBe(0);
    } finally {
      server.stop();
      files.stop();
    }
  }, 30_000);

  test("a population that changed during the pass is not measured", async () => {
    seedAuthenticatedConfig();
    const server = startServer([
      { body: page([DATA], { next_cursor: "on002893", population_total: 2 }) },
      { body: page([META], { population_total: 3 }) },
    ]);
    const files = startOpenNeuroFilesStandin();
    try {
      const env = { NEMAR_OPENNEURO_GRAPHQL_URL: files.url };
      const result = await runCli(
        ["admin", "upstream-status", "--measure", "--json"],
        server.url,
        env,
      );
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout).measurement).toBeNull();
      expect(files.requests.length).toBe(0);
    } finally {
      server.stop();
      files.stop();
    }
  }, 30_000);

  test("five reads in a row failing stops the measurement; the rest are unknown with the reason", async () => {
    seedAuthenticatedConfig();
    // Seven stale rows that all name a recorded dataset; the stand-in refuses every request.
    const rows = Array.from({ length: 7 }, (_, i) => ({
      ...staleRow("on003082", "1.0.0", "1.0.1"),
      dataset_id: `on00010${i}`,
    }));
    const server = startServer([{ body: page(rows) }]);
    const files = startOpenNeuroFilesStandin();
    files.setStatus(503);
    try {
      const env = { NEMAR_OPENNEURO_GRAPHQL_URL: files.url };
      const result = await runCli(
        ["admin", "upstream-status", "--measure", "--json"],
        server.url,
        env,
      );
      expect(result.exitCode).toBe(2);
      const m = JSON.parse(result.stdout).measurement;
      expect(files.requests.length).toBe(5);
      expect(m.totals.delta_unknown).toBe(7);
      expect(m.totals.bytes_to_copy).toBeNull();
      expect(m.complete).toBe(false);
      expect(m.deltas[4].reason).toContain("HTTP 503");
      expect(m.deltas[5].reason).toContain("5 reads in a row failed");
      expect(m.deltas[6].reason).toContain("5 reads in a row failed");
    } finally {
      server.stop();
      files.stop();
    }
  }, 30_000);

  test("a progress line goes to stderr every ten mirrors, never into the JSON", async () => {
    seedAuthenticatedConfig();
    // Eleven stale rows on distinct ids (on000200 to on000210), all naming a recorded dataset.
    const rows = Array.from({ length: 11 }, (_, i) => ({
      ...staleRow("on003082", "1.0.0", "1.0.1"),
      dataset_id: `on0002${String(i).padStart(2, "0")}`,
    }));
    const server = startServer([{ body: page(rows) }]);
    const files = startOpenNeuroFilesStandin();
    try {
      const env = { NEMAR_OPENNEURO_GRAPHQL_URL: files.url };
      const result = await runCli(
        ["admin", "upstream-status", "--measure", "--json"],
        server.url,
        env,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("measured 10 of 11 stale mirror(s)");
      expect(result.stderr.match(/measured \d+ of/g)?.length).toBe(1);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    } finally {
      server.stop();
      files.stop();
    }
  }, 60_000);

  test("the DOI volume is read at the CLI's clock: snapshots relative to now are counted", async () => {
    seedAuthenticatedConfig();
    // Built relative to now (a recorded list ages out of any fixed window): an import 400 days
    // ago, then re-pulls 100, 90 and 5 days ago, and one the CLI's `now` must call the future.
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const aged = {
      ...staleRow("on002893", "1.0.0", "2.0.0"),
      upstream: {
        latest_tag: "2.0.0",
        latest_created: ago(5),
        snapshots: [
          { tag: "1.0.0", created: ago(400) },
          { tag: "1.1.0", created: ago(100) },
          { tag: "1.2.0", created: ago(90) },
          { tag: "2.0.0", created: ago(5) },
          { tag: "2.1.0", created: ago(-3) },
        ],
      },
    };
    const server = startServer([{ body: page([aged]) }]);
    const files = startOpenNeuroFilesStandin();
    try {
      const env = { NEMAR_OPENNEURO_GRAPHQL_URL: files.url };
      const result = await runCli(
        ["admin", "upstream-status", "--measure", "--json"],
        server.url,
        env,
      );
      const v = JSON.parse(result.stdout).measurement.doi_volume;
      expect(v.per_snapshot).toBe(3);
      expect(v.at_most_every_30_days).toBe(2);
      expect(v.busiest_day).toBe(1);
      expect(v.snapshots_dated_in_the_future).toBe(1);
    } finally {
      server.stop();
      files.stop();
    }
  }, 30_000);

  test("without --measure OpenNeuro is never asked and the JSON has no measurement", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ body: page([META, DATA]) }]);
    const files = startOpenNeuroFilesStandin();
    try {
      const env = { NEMAR_OPENNEURO_GRAPHQL_URL: files.url };
      const result = await runCli(["admin", "upstream-status", "--json"], server.url, env);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).not.toHaveProperty("measurement");
      expect(files.requests.length).toBe(0);
      expect(server.switchRequests.length).toBe(0);
    } finally {
      server.stop();
      files.stop();
    }
  });

  test("no stale mirror means nothing to copy: a real zero, and OpenNeuro is not asked", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ body: page([CURRENT]) }]);
    const files = startOpenNeuroFilesStandin();
    try {
      const env = { NEMAR_OPENNEURO_GRAPHQL_URL: files.url };
      const result = await runCli(
        ["admin", "upstream-status", "--measure", "--json"],
        server.url,
        env,
      );
      expect(result.exitCode).toBe(0);
      const t = JSON.parse(result.stdout).measurement.totals;
      expect(t.stale).toBe(0);
      expect(t.bytes_to_copy).toBe(0);
      expect(files.requests.length).toBe(0);
    } finally {
      server.stop();
      files.stop();
    }
  });

  test("a failed pass is not measured: exit 1 and no measurement", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ status: 500, body: { error: "boom" } }]);
    const files = startOpenNeuroFilesStandin();
    try {
      const env = { NEMAR_OPENNEURO_GRAPHQL_URL: files.url };
      const result = await runCli(
        ["admin", "upstream-status", "--measure", "--json"],
        server.url,
        env,
      );
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).measurement).toBeNull();
      expect(files.requests.length).toBe(0);
      expect(server.switchRequests.length).toBe(0);
    } finally {
      server.stop();
      files.stop();
    }
  });

  test("--measure-limit without --measure, or not a positive integer, exits 1", async () => {
    seedAuthenticatedConfig();
    const server = startServer([{ body: page([CURRENT]) }]);
    try {
      for (const args of [
        ["--measure-limit", "3"],
        ["--measure", "--measure-limit", "0"],
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
