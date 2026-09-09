/**
 * CLI `nemar admin import-issue-triage` (#1310, epic #1306), driven through the
 * real entry point (`bun run src/index.ts admin import-issue-triage ...`).
 *
 * Harness mirrors test/hed-sweep-cli.test.ts exactly: a real subprocess CLI
 * invocation pointed at a real local HTTP server via TEST_API_URL
 * (src/lib/api/client.ts#getApiUrl), no mocks.
 *
 * Three properties are worth a subprocess to pin, because each is a way for a
 * scripted caller to be misled:
 *
 *   1. A bare invocation sends NO `apply` param. This is the only thing between
 *      an operator's habit and closing real issues on the shared nemarDatasets
 *      org.
 *   2. The exit code is 1 whenever the run reported errors, INCLUDING under
 *      `--json` -- the ordering in the source is deliberate and was untested.
 *   3. The 502 body's per-issue causes are rendered rather than discarded. The
 *      route's own message says "see errors[]", so a count with no reasons is the
 *      one outcome where the output is useless.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function seedAuthenticatedConfig(): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "triagecliuser",
      accounts: { triagecliuser: { apiKey: "test-admin-key" } },
    }),
  );
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-triage-cli-"));
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

/** A clean dry run: one issue that would close, one kept. */
const DRY_RUN = {
  applied: false,
  openIssues: 2,
  mode: "per-dataset",
  rollups: [],
  rollupsReleased: 0,
  examined: 2,
  attempted: 0,
  closed: 1,
  relabelled: 0,
  kept: 1,
  plan: [
    {
      issueNumber: 105,
      datasetId: "on006136",
      title: "Import failure: on006136 (ds006136)",
      kind: "close",
      reason: "verified complete (4812/4812 objects present at declared size)",
    },
    {
      issueNumber: 97,
      datasetId: "on005279",
      title: "Import failure: on005279 (ds005279)",
      kind: "keep",
      reason: "still incomplete (0/3310 objects present)",
    },
  ],
  errors: [],
  remaining: 0,
  ok: true,
};

describe("nemar admin import-issue-triage: auth", () => {
  test("without a stored apiKey, nothing is sent", async () => {
    const server = startCaptureServer(DRY_RUN);
    try {
      const result = await runCli(["admin", "import-issue-triage"], server.url);
      expect(result.stdout).toContain("Not authenticated");
      expect(server.requests.length).toBe(0);
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin import-issue-triage: dry run is the default", () => {
  test("a bare invocation sends no apply param", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer(DRY_RUN);
    try {
      const result = await runCli(["admin", "import-issue-triage"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.searchParams.get("apply")).toBeNull();
      expect(server.requests[0]?.pathname).toBe("/admin/imports/issue-triage");
      // And the reader is told nothing happened.
      expect(result.stdout).toContain("DRY RUN");
      expect(result.stdout).toContain("WOULD CLOSE");
      expect(result.stdout).toContain("Re-run with --apply");
    } finally {
      server.stop();
    }
  });

  test("--apply sends apply=1", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({ ...DRY_RUN, applied: true });
    try {
      const result = await runCli(["admin", "import-issue-triage", "--apply"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests[0]?.searchParams.get("apply")).toBe("1");
      expect(result.stdout).not.toContain("DRY RUN");
      expect(result.stdout).toContain("CLOSE");
    } finally {
      server.stop();
    }
  });

  test("--limit is forwarded", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer(DRY_RUN);
    try {
      await runCli(["admin", "import-issue-triage", "--limit", "7"], server.url);
      expect(server.requests[0]?.searchParams.get("limit")).toBe("7");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin import-issue-triage: a bad --limit is refused, not coerced", () => {
  for (const bad of ["abc", "0", "-5", ""]) {
    test(`--limit ${JSON.stringify(bad)} sends nothing and exits 1`, async () => {
      seedAuthenticatedConfig();
      const server = startCaptureServer(DRY_RUN);
      try {
        const result = await runCli(["admin", "import-issue-triage", "--limit", bad], server.url);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Invalid --limit");
        // The operator asked for something specific; silently substituting 15
        // would run a batch they did not ask for.
        expect(server.requests).toHaveLength(0);
      } finally {
        server.stop();
      }
    });
  }
});

describe("nemar admin import-issue-triage: a failed action is not reported as done", () => {
  test("an entry marked failed prints FAILED CLOSE, not CLOSE", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({
      ...DRY_RUN,
      applied: true,
      attempted: 1,
      closed: 0,
      plan: [{ ...DRY_RUN.plan[0], failed: true }],
      errors: [
        {
          issue: 105,
          dataset_id: "on006136",
          stage: "apply",
          error: "HTTP 403 - secondary rate limit",
        },
      ],
    });
    try {
      const result = await runCli(["admin", "import-issue-triage", "--apply"], server.url);
      expect(result.stdout).toContain("FAILED CLOSE");
      expect(result.stdout).toContain("apply: HTTP 403");
      // A per-issue error is not fatal, but it must not read as a clean run.
      expect(result.exitCode).toBe(1);
    } finally {
      server.stop();
    }
  });

  /** The ordering in the source is deliberate: the exit code is set BEFORE the
   *  --json return, so both output modes agree on the verdict. */
  test("--json still exits 1 on a run that errored, and emits parseable JSON", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({
      ...DRY_RUN,
      errors: [{ issue: 105, dataset_id: "on006136", stage: "plan", error: "S3 timeout" }],
    });
    try {
      const result = await runCli(["admin", "import-issue-triage", "--json"], server.url);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout) as { errors: unknown[] };
      expect(parsed.errors).toHaveLength(1);
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin import-issue-triage: the 502 body is not discarded", () => {
  const TOTAL_FAILURE = {
    ...DRY_RUN,
    applied: true,
    attempted: 2,
    closed: 0,
    ok: false,
    error: "All 2 attempted issue(s) failed; see errors[]",
    errors: [
      { issue: 105, dataset_id: "on006136", stage: "apply", error: "HTTP 403 - forbidden" },
      { issue: 106, dataset_id: "on006137", stage: "apply", error: "HTTP 403 - forbidden" },
    ],
    details: {
      errors: [
        { issue: 105, dataset_id: "on006136", stage: "apply", error: "HTTP 403 - forbidden" },
        { issue: 106, dataset_id: "on006137", stage: "apply", error: "HTTP 403 - forbidden" },
      ],
    },
  };

  test("the per-issue causes are printed, not just the count", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer(TOTAL_FAILURE, 502);
    try {
      const result = await runCli(["admin", "import-issue-triage", "--apply"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("#105");
      expect(result.stderr).toContain("HTTP 403 - forbidden");
      expect(result.stderr).toContain("#106");
    } finally {
      server.stop();
    }
  });

  test("--json emits the error body, so the JSON contract holds on failure too", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer(TOTAL_FAILURE, 502);
    try {
      const result = await runCli(
        ["admin", "import-issue-triage", "--apply", "--json"],
        server.url,
      );
      expect(result.exitCode).toBe(1);
      // Without this, stdout was EMPTY on the most interesting outcome.
      const parsed = JSON.parse(result.stdout) as { errors?: unknown[] };
      expect(parsed.errors).toHaveLength(2);
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin import-issue-triage: rollups are visible", () => {
  test("an open rollup that would be released is reported", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({
      ...DRY_RUN,
      rollups: [{ number: 900, title: "Import failures (rollup): auth_invalid" }],
      rollupsReleased: 1,
    });
    try {
      const result = await runCli(["admin", "import-issue-triage"], server.url);
      expect(result.stdout).toContain("WOULD RELEASE");
      expect(result.stdout).toContain("#900");
      expect(result.stdout).toContain("Would release 1 rollup(s)");
    } finally {
      server.stop();
    }
  });
});
