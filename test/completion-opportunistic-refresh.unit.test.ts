/**
 * Opportunistic completion-cache refresh after a successful `dataset
 * list`/`dataset search` (epic #1144 phase 5b, issue #1149 -- plan
 * verification case 7, D3).
 *
 * `triggerOpportunisticRefresh()` (src/lib/completion/refresh.ts) fires a
 * fire-and-forget `GET /datasets/facets` after list/search output is
 * already rendered. This file proves the "never blocks or breaks" half:
 * a failing facets endpoint (500, a non-JSON body, or a 200 with a body
 * that fails the contract schema) must produce BYTE-IDENTICAL stdout and
 * the same exit code as a run where the facets endpoint is healthy -- the
 * whole point of catching the refresh's rejection rather than letting it
 * propagate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

const EMPTY_LIST_ENVELOPE = { datasets: [], count: 0, total_count: 0, limit: 20, offset: 0 };
const EMPTY_SEARCH_ENVELOPE = { results: [], count: 0 };

type FacetsBehavior = "healthy" | "http-500" | "malformed-json" | "schema-mismatch";

function startServer(
  listOrSearchBody: unknown,
  facetsBehavior: FacetsBehavior,
): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") {
        return new Response(JSON.stringify({ notices: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/datasets/facets") {
        switch (facetsBehavior) {
          case "healthy":
            return new Response(JSON.stringify({}), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          case "http-500":
            return new Response(JSON.stringify({ error: "internal error" }), { status: 500 });
          case "malformed-json":
            return new Response("not json at all {{{", { status: 200 });
          case "schema-mismatch":
            // Right JSON, wrong shape: `task` must be {values,...}, not a
            // bare array -- fails datasetFacetsEnvelopeSchema.safeParse.
            return new Response(JSON.stringify({ task: ["a", "b"] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
        }
      }
      return new Response(JSON.stringify(listOrSearchBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-opportunistic-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

async function runCli(
  args: string[],
  apiUrl: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: apiUrl,
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

describe("verification case 7: opportunistic refresh never blocks or breaks a command", () => {
  const FAILURE_MODES: FacetsBehavior[] = ["http-500", "malformed-json", "schema-mismatch"];

  for (const mode of FAILURE_MODES) {
    test(`dataset list: a facets endpoint failing with "${mode}" changes nothing`, async () => {
      const healthyServer = startServer(EMPTY_LIST_ENVELOPE, "healthy");
      const failingServer = startServer(EMPTY_LIST_ENVELOPE, mode);
      try {
        const baseline = await runCli(["dataset", "list", "--json"], healthyServer.url);
        const withFailure = await runCli(["dataset", "list", "--json"], failingServer.url);

        expect(withFailure.exitCode).toBe(baseline.exitCode);
        expect(withFailure.exitCode).toBe(0);
        expect(withFailure.stdout).toBe(baseline.stdout);
      } finally {
        healthyServer.stop();
        failingServer.stop();
      }
    });

    test(`dataset search: a facets endpoint failing with "${mode}" changes nothing`, async () => {
      const healthyServer = startServer(EMPTY_SEARCH_ENVELOPE, "healthy");
      const failingServer = startServer(EMPTY_SEARCH_ENVELOPE, mode);
      try {
        const baseline = await runCli(["dataset", "search", "eeg", "--json"], healthyServer.url);
        const withFailure = await runCli(["dataset", "search", "eeg", "--json"], failingServer.url);

        expect(withFailure.exitCode).toBe(baseline.exitCode);
        expect(withFailure.exitCode).toBe(0);
        expect(withFailure.stdout).toBe(baseline.stdout);
      } finally {
        healthyServer.stop();
        failingServer.stop();
      }
    });
  }

  test("a failure prints nothing to stderr beyond the command's own spinner (silent unless VERBOSE)", async () => {
    const healthyServer = startServer(EMPTY_LIST_ENVELOPE, "healthy");
    const failingServer = startServer(EMPTY_LIST_ENVELOPE, "http-500");
    try {
      const baseline = await runCli(["dataset", "list", "--json"], healthyServer.url);
      const withFailure = await runCli(["dataset", "list", "--json"], failingServer.url);
      expect(withFailure.exitCode).toBe(0);
      // Identical to the healthy run's stderr (the ora spinner's own
      // output) -- no [completion] failure line leaks through without
      // VERBOSE set.
      expect(withFailure.stderr).toBe(baseline.stderr);
      expect(withFailure.stderr).not.toContain("completion");
    } finally {
      healthyServer.stop();
      failingServer.stop();
    }
  });

  function cacheWritten(): boolean {
    const cachePath = join(configDir, "completion-cache.json");
    if (!existsSync(cachePath)) return false;
    const parsed = JSON.parse(readFileSync(cachePath, "utf-8"));
    return typeof parsed.cachedAt === "number";
  }

  test("a healthy facets response after list --json is written to the completion cache", async () => {
    const server = startServer(EMPTY_LIST_ENVELOPE, "healthy");
    try {
      const result = await runCli(["dataset", "list", "--json"], server.url);
      expect(result.exitCode).toBe(0);
      expect(cacheWritten()).toBe(true);
    } finally {
      server.stop();
    }
  });

  // The plan's D3 fires this on EVERY successful list/search render, not
  // just the --json branch -- each of the six call sites in
  // src/commands/dataset.ts (json / empty-results / rendered-table, times
  // list and search) needs its own proof, or a call site removed from one
  // branch would go undetected by the --json-only test above.
  const ONE_DATASET = {
    id: 1,
    dataset_id: "nm000001",
    name: "Fixture Dataset",
    description: null,
    owner_username: "tester",
    status: "active",
    visibility: "public",
    github_repo: null,
    concept_doi: null,
    created_at: new Date().toISOString(),
  };

  test("list: refresh fires on the plain-text empty-results branch", async () => {
    const server = startServer(EMPTY_LIST_ENVELOPE, "healthy");
    try {
      const result = await runCli(["dataset", "list"], server.url);
      expect(result.exitCode).toBe(0);
      expect(cacheWritten()).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("list: refresh fires on the rendered-table branch (non-JSON, non-empty)", async () => {
    const server = startServer(
      { ...EMPTY_LIST_ENVELOPE, datasets: [ONE_DATASET], count: 1, total_count: 1 },
      "healthy",
    );
    try {
      const result = await runCli(["dataset", "list"], server.url);
      expect(result.exitCode).toBe(0);
      expect(cacheWritten()).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("search: refresh fires on the plain-text empty-results branch", async () => {
    const server = startServer(EMPTY_SEARCH_ENVELOPE, "healthy");
    try {
      const result = await runCli(["dataset", "search", "eeg"], server.url);
      expect(result.exitCode).toBe(0);
      expect(cacheWritten()).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("search: refresh fires on the rendered-results branch (non-JSON, non-empty)", async () => {
    const server = startServer(
      {
        results: [
          {
            id: "nm000001",
            name: "Fixture Dataset",
            modalities: "eeg",
            participants: 5,
            doi: "",
            tasks: "rest",
            authors: "someone",
            score: 0.9,
          },
        ],
        count: 1,
        method: "text",
      },
      "healthy",
    );
    try {
      const result = await runCli(["dataset", "search", "eeg"], server.url);
      expect(result.exitCode).toBe(0);
      expect(cacheWritten()).toBe(true);
    } finally {
      server.stop();
    }
  });
});
