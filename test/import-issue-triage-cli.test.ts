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
  reconcile: {
    rowsWithoutIssue: [],
    issuesWithoutRow: [],
    parked: 0,
    quarantined: 0,
    issueListEmpty: false,
    rowsExamined: 2,
    issuesExamined: 2,
    reason: "Failures and tracking issues agree (2 unresolved import row(s) examined).",
  },
  reconcileError: null,
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

  /** These ARE integers, so they are honest requests, forwarded at full value for
   *  the server to clamp to [1,30]. `Number` is what makes them honest: parseInt
   *  read `1e9` as 1, which is a silent substitution rather than a clamp. */
  test("an exotic but integral limit is forwarded at its real value", async () => {
    seedAuthenticatedConfig();
    for (const [input, sent] of [
      ["1e9", "1000000000"],
      ["0x20", "32"],
    ] as const) {
      const server = startCaptureServer(DRY_RUN);
      try {
        await runCli(["admin", "import-issue-triage", "--limit", input], server.url);
        expect(server.requests[0]?.searchParams.get("limit")).toBe(sent);
      } finally {
        server.stop();
      }
    }
  });
});

describe("nemar admin import-issue-triage: a bad --limit is refused, not coerced", () => {
  // parseInt stopped at the first non-digit and returned what it had, so `15abc`
  // became 15 and `3.9` became 3 -- a different batch size than the one asked for.
  for (const bad of ["abc", "0", "-5", "", "15abc", "3.9", " ", "Infinity"]) {
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
  test("a release whose close failed prints FAILED RELEASE", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({
      ...DRY_RUN,
      applied: true,
      attempted: 1,
      closed: 0,
      rollupsReleased: 0,
      rollups: [
        { number: 900, title: "Import failures (rollup): auth_invalid", outcome: "failed" },
      ],
      errors: [{ issue: 900, dataset_id: null, stage: "apply", error: "HTTP 403 - forbidden" }],
    });
    try {
      const result = await runCli(["admin", "import-issue-triage", "--apply"], server.url);
      expect(result.stdout).toContain("FAILED RELEASE");
      expect(result.exitCode).toBe(1);
    } finally {
      server.stop();
    }
  });

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

describe("nemar admin import-issue-triage: the reconcile section (#1352)", () => {
  test("agreement prints the counts, not silence", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer(DRY_RUN);
    try {
      const r = await runCli(["admin", "import-issue-triage"], server.url);
      expect(r.stdout).toContain("rows_without_issue=0");
      expect(r.stdout).toContain("issues_without_row=0");
      // The denominator: "they agree over 2 rows" is a different claim from "they
      // agree over nothing", and a reader of a clean run needs to know which.
      expect(r.stdout).toContain("rows_examined=2");
    } finally {
      server.stop();
    }
  });

  test("an untracked failure is listed with its cause", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({
      ...DRY_RUN,
      reconcile: {
        rowsWithoutIssue: [
          {
            datasetId: "on000777",
            sourceId: "ds000777",
            status: "failed",
            stage: "prepare",
            cause: "auth_invalid",
            label: "auth-invalid",
            updatedAt: "2026-09-01 03:00:00",
          },
        ],
        issuesWithoutRow: [],
        parked: 0,
        quarantined: 0,
        issueListEmpty: false,
        rowsExamined: 3,
        issuesExamined: 2,
        reason:
          "1 unresolved import(s) have no tracking issue, so nothing surfaces them to triage.",
      },
    });
    try {
      const r = await runCli(["admin", "import-issue-triage"], server.url);
      expect(r.stdout).toContain("UNTRACKED");
      expect(r.stdout).toContain("on000777 (ds000777) failed at prepare");
      expect(r.stdout).toContain("auth_invalid");
      // It must be obvious that reading this changed nothing.
      expect(r.stdout).toContain("files and closes nothing");
    } finally {
      server.stop();
    }
  });

  test("an issue with no import row is listed by number", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({
      ...DRY_RUN,
      reconcile: {
        rowsWithoutIssue: [],
        issuesWithoutRow: [
          { number: 77, datasetId: "on004148", title: "Import failure: on004148 (ds004148)" },
        ],
        parked: 0,
        quarantined: 0,
        issueListEmpty: false,
        rowsExamined: 2,
        issuesExamined: 3,
        reason:
          "1 open issue(s) have no import_jobs row, so the sweep can never verify or close them.",
      },
    });
    try {
      const r = await runCli(["admin", "import-issue-triage"], server.url);
      expect(r.stdout).toContain("NO IMPORT ROW");
      expect(r.stdout).toContain("#77 on004148");
    } finally {
      server.stop();
    }
  });

  test("a null verdict reads as unknown, never as agreement", async () => {
    // THE property, the same one ADR 0054 turns on. "Could not compare" printed as
    // zeros would be indistinguishable from "compared, and they agree".
    seedAuthenticatedConfig();
    const server = startCaptureServer({
      ...DRY_RUN,
      reconcile: null,
      reconcileError: "D1 read failed: no such table: import_jobs",
    });
    try {
      const r = await runCli(["admin", "import-issue-triage"], server.url);
      expect(r.stdout).toContain("reconcile=unknown");
      expect(r.stdout).toContain("no such table: import_jobs");
      expect(r.stdout).not.toContain("rows_without_issue=0");
    } finally {
      server.stop();
    }
  });

  test("a long untracked list says how many are hidden", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({
      ...DRY_RUN,
      reconcile: {
        // 24 against a budget of 20. Deliberately expressed as budget + 4 in the
        // assertion below rather than as a bare number, since the budget moved once
        // already (10 -> 20, to match the backend's single cap).
        rowsWithoutIssue: Array.from({ length: 24 }, (_, i) => ({
          datasetId: `on${String(i).padStart(6, "0")}`,
          sourceId: `ds${String(i).padStart(6, "0")}`,
          status: "failed",
          stage: "prepare",
          cause: "unknown",
          label: "needs-triage",
          updatedAt: null,
        })),
        issuesWithoutRow: [],
        parked: 0,
        quarantined: 0,
        issueListEmpty: false,
        rowsExamined: 24,
        issuesExamined: 2,
        reason:
          "14 unresolved import(s) have no tracking issue, so nothing surfaces them to triage.",
      },
    });
    try {
      const r = await runCli(["admin", "import-issue-triage"], server.url);
      // A list that stops without saying so under-counts, and an under-count reads
      // as good news.
      expect(r.stdout).toContain("... and 4 more untracked");
      expect(r.stdout).toContain("rows_without_issue=24");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin import-issue-triage: an older backend omits the reconcile", () => {
  /**
   * Found by the first real production run, AFTER the merge: production had the epic
   * but not the reconcile, so the response carried no `reconcile` key at all. The
   * renderer tested `=== null`, `undefined` failed that, and the command died on
   * `rec.rowsWithoutIssue` -- after printing a complete and correct triage report.
   *
   * The CLI ships to npm independently of the Worker, so it is routinely newer or
   * older than the backend it talks to. A field one side adds must never be
   * load-bearing on the other.
   */
  test("a response with no reconcile field renders the triage report and exits 0", async () => {
    seedAuthenticatedConfig();
    const { reconcile: _r, reconcileError: _e, ...withoutReconcile } = DRY_RUN;
    const server = startCaptureServer(withoutReconcile);
    try {
      const r = await runCli(["admin", "import-issue-triage"], server.url);
      // The triage half is unaffected...
      expect(r.stdout).toContain("WOULD CLOSE");
      expect(r.stdout).toContain("open=2");
      // ...and the missing section reads as unknown rather than crashing.
      expect(r.stdout).toContain("reconcile=unknown");
      expect(r.exitCode).toBe(0);
      expect(r.stdout + r.stderr).not.toContain("is not an object");
    } finally {
      server.stop();
    }
  });
});
