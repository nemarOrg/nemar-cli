/**
 * CLI `nemar admin import-coverage` (#1311, epic #1306 phase 3), driven through the
 * real entry point (`bun run src/index.ts admin import-coverage ...`).
 *
 * Harness mirrors test/import-issue-triage-cli.test.ts: a real subprocess CLI
 * invocation pointed at a real local HTTP server via TEST_API_URL, no mocks.
 *
 * The property worth a subprocess is the EXIT CODE. This is the command an operator
 * or a cron wrapper runs to ask "is the importer keeping up?", so the three answers
 * have to be three codes: 0 healthy, 1 alarm (the sweep ran and the pipeline is
 * unhealthy), 2 unknown (the sweep could not tell). An earlier version gave alarm
 * and unknown both 1, which collapsed "the pipeline is broken" and "the check is
 * broken" into one signal -- the precise confusion this phase exists to prevent.
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
      activeAccount: "coveragecliuser",
      accounts: { coveragecliuser: { apiKey: "test-admin-key" } },
    }),
  );
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-coverage-cli-"));
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

const HEALTHY = {
  applied: false,
  status: "healthy",
  kind: null,
  reason: "2 in-scope dataset(s) never attempted, below the alarm threshold of 5.",
  enabled: true,
  lastDispatchAt: "2026-09-09 10:00:00",
  dispatchAgeHours: 2,
  discovered: 764,
  lastDispatchSourceId: "ds007763",
  dispatchLost: false,
  imported: 760,
  importedInScan: 760,
  importedNotInScan: 0,
  inFlight: 0,
  terminal: 0,
  backlog: {
    neverAttempted: ["ds000001", "ds000002"],
    untracked: [],
    tracked: [],
    blocklisted: [],
  },
  issue: null,
  errors: [],
  ok: true,
};

const ALARM = {
  ...HEALTHY,
  status: "alarm",
  kind: "disabled",
  reason: 'AUTO_IMPORT_ENABLED is not "true" and 19 in-scope dataset(s) have never been attempted.',
  enabled: false,
  dispatchAgeHours: 24 * 49,
  imported: 745,
  importedInScan: 745,
  backlog: {
    neverAttempted: Array.from({ length: 19 }, (_, i) => `ds${String(i + 1).padStart(6, "0")}`),
    untracked: [],
    tracked: [],
    blocklisted: [],
  },
  issue: { number: 900, action: "created" },
};

describe("nemar admin import-coverage: auth", () => {
  test("without a stored apiKey, nothing is sent", async () => {
    const server = startCaptureServer(HEALTHY);
    try {
      const result = await runCli(["admin", "import-coverage"], server.url);
      expect(result.stdout).toContain("Not authenticated");
      expect(server.requests.length).toBe(0);
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin import-coverage: the exit code is the verdict", () => {
  test("healthy exits 0", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer(HEALTHY);
    try {
      const result = await runCli(["admin", "import-coverage"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("HEALTHY");
      expect(result.stdout).toContain("never_attempted=2");
      expect(server.requests[0]?.pathname).toBe("/admin/imports/coverage-sweep");
    } finally {
      server.stop();
    }
  });

  /** An alarm is a successful RUN and an unhealthy STATE. A script asking "is the
   *  importer keeping up?" needs non-zero here, or the check is pointless. */
  test("alarm exits 1 and names the kind", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer(ALARM);
    try {
      const result = await runCli(["admin", "import-coverage"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("ALARM (disabled)");
      expect(result.stdout).toContain("AUTO_IMPORT_ENABLED");
      // The disabled flag is the actionable part, so it is called out.
      expect(result.stdout).toContain("DISABLED");
    } finally {
      server.stop();
    }
  });

  test("only the never-attempted ids are listed, since only they drive the verdict", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({
      ...HEALTHY,
      imported: 761,
      importedInScan: 761,
      backlog: {
        neverAttempted: ["ds000001"],
        untracked: [],
        tracked: ["ds000900"],
        blocklisted: ["ds000901"],
      },
    });
    try {
      const result = await runCli(["admin", "import-coverage"], server.url);
      expect(result.stdout).toContain("never attempted: ds000001");
      expect(result.stdout).not.toContain("ds000900");
      // ...but the counts are all reported.
      expect(result.stdout).toContain("tracked=1");
      expect(result.stdout).toContain("blocklisted=1");
    } finally {
      server.stop();
    }
  });

  test("a long never-attempted list is truncated with a count", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({
      ...HEALTHY,
      imported: 714,
      importedInScan: 714,
      backlog: {
        neverAttempted: Array.from({ length: 50 }, (_, i) => `ds${String(i + 1).padStart(6, "0")}`),
        untracked: [],
        tracked: [],
        blocklisted: [],
      },
    });
    try {
      const result = await runCli(["admin", "import-coverage"], server.url);
      expect(result.stdout).toContain("and 30 more");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin import-coverage: dry run is the default", () => {
  test("a bare invocation sends no apply param and says what it would do", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer(ALARM);
    try {
      const result = await runCli(["admin", "import-coverage"], server.url);
      expect(server.requests[0]?.searchParams.get("apply")).toBeNull();
      expect(result.stdout).toContain("would create");
      expect(result.stdout).toContain("Re-run with --apply");
    } finally {
      server.stop();
    }
  });

  test("--apply sends apply=1 and reports the action as done", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({ ...ALARM, applied: true });
    try {
      const result = await runCli(["admin", "import-coverage", "--apply"], server.url);
      expect(server.requests[0]?.searchParams.get("apply")).toBe("1");
      expect(result.stdout).toContain("Issue: created #900");
      expect(result.stdout).not.toContain("Re-run with --apply");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin import-coverage: an unknown verdict is not a healthy one", () => {
  const UNKNOWN = {
    ...HEALTHY,
    status: "unknown",
    reason: "OpenNeuro discovery failed, so coverage could not be determined this run.",
    errors: [{ stage: "discovery", error: "GraphQL 502 Bad Gateway" }],
    ok: false,
    error: "Coverage could not be determined: OpenNeuro discovery failed",
    details: { errors: [{ stage: "discovery", error: "GraphQL 502 Bad Gateway" }] },
  };

  test("the 502 exits 2 -- could not tell, which is not the same as unhealthy", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer(UNKNOWN, 502);
    try {
      const result = await runCli(["admin", "import-coverage"], server.url);
      expect(result.exitCode).toBe(2);
      // An operator has to be able to tell an OpenNeuro outage from a D1 one.
      expect(result.stderr).toContain("discovery");
      expect(result.stderr).toContain("GraphQL 502");
    } finally {
      server.stop();
    }
  });

  test("--json emits the error body, so the JSON contract holds on failure too", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer(UNKNOWN, 502);
    try {
      const result = await runCli(["admin", "import-coverage", "--json"], server.url);
      expect(result.exitCode).toBe(2);
      const parsed = JSON.parse(result.stdout) as { errors?: { stage?: string }[] };
      expect(parsed.errors?.[0]?.stage).toBe("discovery");
    } finally {
      server.stop();
    }
  });

  test("--json on a healthy run emits the result and exits 0", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer(HEALTHY);
    try {
      const result = await runCli(["admin", "import-coverage", "--json"], server.url);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { status: string };
      expect(parsed.status).toBe("healthy");
    } finally {
      server.stop();
    }
  });

  test("--json on an alarm still exits 1, so both output modes agree", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer(ALARM);
    try {
      const result = await runCli(["admin", "import-coverage", "--json"], server.url);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).status).toBe("alarm");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin import-coverage: partial failures are surfaced", () => {
  test("a report-stage error is shown without invalidating the verdict", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({
      ...ALARM,
      applied: true,
      issue: null,
      errors: [{ stage: "report", error: "HTTP 403 - forbidden" }],
    });
    try {
      const result = await runCli(["admin", "import-coverage", "--apply"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("ALARM");
      expect(result.stdout).toContain("report: HTTP 403");
    } finally {
      server.stop();
    }
  });

  test("a landed change whose comment failed says so", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({
      ...HEALTHY,
      applied: true,
      issue: { number: 900, action: "closed", commentError: "HTTP 502" },
    });
    try {
      const result = await runCli(["admin", "import-coverage", "--apply"], server.url);
      expect(result.stdout).toContain("comment failed: HTTP 502");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin import-coverage: the balance line", () => {
  /**
   * The counts balance against `discovered` by construction. A line that does not
   * add up means the run did not see the whole catalogue, which is the one thing a
   * reader cannot infer from the verdict itself.
   */
  test("counts that do not add up are called out", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({ ...HEALTHY, discovered: 900 });
    try {
      const result = await runCli(["admin", "import-coverage"], server.url);
      expect(result.stdout).toContain("Counts do not balance");
      expect(result.stdout).toContain("treat the verdict as unreliable");
    } finally {
      server.stop();
    }
  });

  test("counts that add up say nothing", async () => {
    seedAuthenticatedConfig();
    // 760 imported + 2 never-attempted = 762 discovered.
    const server = startCaptureServer({ ...HEALTHY, discovered: 762 });
    try {
      const result = await runCli(["admin", "import-coverage"], server.url);
      expect(result.stdout).not.toContain("Counts do not balance");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin import-coverage: truncation matches the backend", () => {
  /**
   * The CLI cannot import from backend/src, so it carries its own copy of the
   * truncation width. Pinned against the backend's constant here rather than left
   * free to drift, so the terminal and the GitHub issue never disagree about where
   * a list stops.
   */
  test("the CLI truncates at the same width as the issue body", async () => {
    const { MAX_LISTED_IDS } = await import("../backend/src/services/import-coverage");
    const src = await Bun.file(join(import.meta.dir, "..", "src", "commands", "admin.ts")).text();
    const match = /const COVERAGE_MAX_LISTED_IDS = (\d+);/.exec(src);
    expect(match?.[1]).toBe(String(MAX_LISTED_IDS));
  });
});

describe("nemar admin import-coverage: a reported verdict is not a bug to file", () => {
  /**
   * The exit code IS the answer here -- 1 unhealthy, 2 could-not-determine -- and a
   * monitoring caller reads it. The exit hook used to print "Run again with --debug
   * and attach the log to a new issue" underneath a correct report, which was
   * observed on the first real production run of `import-weekly`, whose
   * `closed_this_week=unknown` is the designed first-week answer. Inviting a bug
   * report for a working command teaches people to ignore the hint that matters.
   */
  test("a non-zero verdict does not print the file-a-bug nudge", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer(ALARM);
    try {
      const r = await runCli(["admin", "import-coverage"], server.url);
      expect(r.exitCode).not.toBe(0);
      const out = r.stdout + r.stderr;
      expect(out).not.toContain("attach the log to a new issue");
      expect(out).not.toContain("Debug log:");
    } finally {
      server.stop();
    }
  });
});
