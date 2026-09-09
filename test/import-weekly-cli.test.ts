/**
 * CLI `nemar admin import-weekly` (#1312, epic #1306 phase 4), driven through the
 * real entry point.
 *
 * Harness mirrors test/import-coverage-cli.test.ts: a real subprocess CLI invocation
 * pointed at a real local HTTP server via TEST_API_URL, no mocks.
 *
 * The property worth a subprocess is that **an unknown never prints as a zero**. The
 * CLI carries its own renderer (it cannot import from backend/src), so the rule has
 * to hold twice -- and the second copy is exactly where it would rot unnoticed.
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
  return { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) };
}

let configDir: string;

function seedAuthenticatedConfig(): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "weeklycliuser",
      accounts: { weeklycliuser: { apiKey: "test-admin-key" } },
    }),
  );
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-weekly-cli-"));
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
  posted: false,
  gateReason: "forced",
  facts: {
    week: "2026-W37",
    windowStart: "2026-09-02T03:00:00.000Z",
    windowEnd: "2026-09-09T03:00:00.000Z",
    importedThisWeek: 9,
    importedTotal: 764,
    coverageStatus: "healthy",
    coverageReason: "nothing outstanding",
    outstanding: 0,
    discovered: 766,
    importedNotInScan: 4,
    autoImportEnabled: true,
    dispatchPhrase: "2 hours ago",
    dispatchLost: false,
    failuresByCause: { "auth-invalid": 2, timeout: 0 },
    openFailureTotal: 2,
    parked: [{ datasetId: "on004148", reason: "upstream_403_after_window", parkedDays: 64 }],
    issuesClosed: 3,
    issuesRelabelled: 1,
    errors: [],
  },
  issue: null,
  closedPrevious: null,
  renderedBody: "# Import summary, 2026-W37\n\ncc @nemarAdmin",
  ok: true,
};

describe("nemar admin import-weekly: auth", () => {
  test("without a stored apiKey, nothing is sent", async () => {
    const server = startCaptureServer(HEALTHY);
    try {
      const result = await runCli(["admin", "import-weekly"], server.url);
      expect(result.stdout).toContain("Not authenticated");
      expect(server.requests.length).toBe(0);
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin import-weekly: the report reads correctly", () => {
  test("a clean week exits 0 and shows the headline numbers", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer(HEALTHY);
    try {
      const result = await runCli(["admin", "import-weekly"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Import summary 2026-W37");
      expect(result.stdout).toContain("imported_this_week=9");
      expect(result.stdout).toContain("total=764");
      expect(result.stdout).toContain("closed_this_week=3");
      expect(server.requests[0]?.pathname).toBe("/admin/imports/weekly-summary");
      expect(server.requests[0]?.searchParams.get("apply")).toBeNull();
    } finally {
      server.stop();
    }
  });

  test("only non-zero causes are listed, and parked shows its duration", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer(HEALTHY);
    try {
      const result = await runCli(["admin", "import-weekly"], server.url);
      expect(result.stdout).toContain("auth-invalid: 2");
      expect(result.stdout).not.toContain("timeout: 0");
      expect(result.stdout).toContain("parked on004148");
      expect(result.stdout).toContain("64 days");
    } finally {
      server.stop();
    }
  });

  test("--body prints the issue exactly as it would be posted", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer(HEALTHY);
    try {
      const result = await runCli(["admin", "import-weekly", "--body"], server.url);
      // The point of the flag: review the artifact, not a summary of it.
      expect(result.stdout).toContain("rendered issue body");
      expect(result.stdout).toContain("cc @nemarAdmin");
    } finally {
      server.stop();
    }
  });

  test("--apply sends apply=1 and reports what was posted", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({
      ...HEALTHY,
      applied: true,
      posted: true,
      issue: { number: 900, action: "created" },
      closedPrevious: 700,
    });
    try {
      const result = await runCli(["admin", "import-weekly", "--apply"], server.url);
      expect(server.requests[0]?.searchParams.get("apply")).toBe("1");
      expect(result.stdout).toContain("Posted #900");
      expect(result.stdout).toContain("closed #700");
    } finally {
      server.stop();
    }
  });

  test("a gate refusal is reported, not treated as a failure", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({
      ...HEALTHY,
      applied: true,
      posted: false,
      gateReason: "already posted for 2026-W37",
    });
    try {
      const result = await runCli(["admin", "import-weekly", "--apply"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Not posted: already posted for 2026-W37");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin import-weekly: an unknown never prints as a zero", () => {
  /**
   * THE property, checked in the CLI's own renderer. The CLI cannot import from
   * backend/src, so it carries a second copy of the unknown-vs-zero rule -- and a
   * second copy is exactly where the rule rots without a test.
   */
  test("null counts print as unknown, not 0", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({
      ...HEALTHY,
      facts: {
        ...HEALTHY.facts,
        importedThisWeek: null,
        importedTotal: null,
        outstanding: null,
        openFailureTotal: null,
        issuesClosed: null,
        issuesRelabelled: null,
      },
    });
    try {
      const result = await runCli(["admin", "import-weekly"], server.url);
      expect(result.stdout).toContain("imported_this_week=unknown");
      expect(result.stdout).toContain("total=unknown");
      expect(result.stdout).toContain("outstanding=unknown");
      expect(result.stdout).toContain("closed_this_week=unknown");
      // The specific confusion this phase exists to prevent.
      expect(result.stdout).not.toContain("imported_this_week=0");
      expect(result.stdout).not.toContain("closed_this_week=0");
    } finally {
      server.stop();
    }
  });

  test("a zero still prints as 0, so the two stay distinguishable", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({
      ...HEALTHY,
      facts: { ...HEALTHY.facts, importedThisWeek: 0, issuesClosed: 0 },
    });
    try {
      const result = await runCli(["admin", "import-weekly"], server.url);
      expect(result.stdout).toContain("imported_this_week=0");
      expect(result.stdout).toContain("closed_this_week=0");
      expect(result.stdout).not.toContain("imported_this_week=unknown");
    } finally {
      server.stop();
    }
  });

  test("a null parked list is unknown, distinct from an empty one", async () => {
    seedAuthenticatedConfig();
    const nullParked = startCaptureServer({
      ...HEALTHY,
      facts: { ...HEALTHY.facts, parked: null },
    });
    try {
      const r = await runCli(["admin", "import-weekly"], nullParked.url);
      expect(r.stdout).toContain("parked=unknown");
    } finally {
      nullParked.stop();
    }

    const emptyParked = startCaptureServer({
      ...HEALTHY,
      facts: { ...HEALTHY.facts, parked: [] },
    });
    try {
      const r = await runCli(["admin", "import-weekly"], emptyParked.url);
      expect(r.stdout).toContain("parked=0");
    } finally {
      emptyParked.stop();
    }
  });

  test("a disabled importer and an unknown one read differently", async () => {
    seedAuthenticatedConfig();
    const off = startCaptureServer({
      ...HEALTHY,
      facts: { ...HEALTHY.facts, autoImportEnabled: false },
    });
    try {
      const r = await runCli(["admin", "import-weekly"], off.url);
      expect(r.stdout).toContain("auto_import=DISABLED");
    } finally {
      off.stop();
    }

    const unknown = startCaptureServer({
      ...HEALTHY,
      facts: { ...HEALTHY.facts, autoImportEnabled: null },
    });
    try {
      const r = await runCli(["admin", "import-weekly"], unknown.url);
      expect(r.stdout).toContain("auto_import=unknown");
      expect(r.stdout).not.toContain("auto_import=DISABLED");
    } finally {
      unknown.stop();
    }
  });

  test("a report with unknowns exits 1, because something could not be measured", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({
      ...HEALTHY,
      facts: {
        ...HEALTHY.facts,
        parked: null,
        errors: [{ stage: "parked", error: "D1 timeout" }],
      },
    });
    try {
      const result = await runCli(["admin", "import-weekly"], server.url);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("UNKNOWN");
      expect(result.stdout).toContain("parked: D1 timeout");
    } finally {
      server.stop();
    }
  });

  test("--json passes the nulls through unchanged", async () => {
    seedAuthenticatedConfig();
    const server = startCaptureServer({
      ...HEALTHY,
      facts: { ...HEALTHY.facts, importedThisWeek: null },
    });
    try {
      const result = await runCli(["admin", "import-weekly", "--json"], server.url);
      const parsed = JSON.parse(result.stdout) as { facts: { importedThisWeek: number | null } };
      // A consumer must be able to tell them apart too, so this must not coalesce.
      expect(parsed.facts.importedThisWeek).toBeNull();
    } finally {
      server.stop();
    }
  });
});
