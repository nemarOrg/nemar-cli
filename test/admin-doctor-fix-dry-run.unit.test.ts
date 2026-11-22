/**
 * `nemar admin dataset doctor fix` is a dry run unless `--apply` is given (ADR 0135, the admin
 * tree restructure). Driven through the real entry point against a local Bun.serve stand-in that
 * is the account's stored apiUrl and records every request body, so a run that wrote anything
 * shows up as a fix request without `dry_run`.
 *
 * CI TIER: unit-pure. Hermetic: the CLI is spawned with an environment built from nothing.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

setDefaultTimeout(30_000);

const REPO_ROOT = join(import.meta.dir, "..");
const CLI_ENTRY = join(REPO_ROOT, "src", "index.ts");

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape byte is the point
const stripAnsi = (text: string): string => text.replace(/\u001B\[[0-9;]*m/g, "");

const FINDING = { dataset_id: "nm000213", version: "1.0.0" };

let configDir: string;
let server: ReturnType<typeof Bun.serve>;
let requests: { path: string; body: Record<string, unknown> | null }[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/notices") return Response.json({ notices: [] });
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      requests.push({ path, body });
      if (path === "/admin/doctor/scan") {
        return Response.json({
          scanned: ["missing-manifest"],
          results: {
            "missing-manifest": { description: "stand-in", count: 1, findings: [FINDING] },
          },
        });
      }
      if (path === "/admin/doctor/fix" && body?.dry_run === true) {
        return Response.json({
          check: "missing-manifest",
          dry_run: true,
          would_fix: 1,
          findings: [FINDING],
        });
      }
      if (path === "/admin/doctor/fix") {
        return Response.json({
          check: "missing-manifest",
          total: 1,
          fixed: 1,
          skipped: 0,
          failed: 0,
          results: [{ ...FINDING, status: "fixed" }],
        });
      }
      return Response.json({ error: "not stood in" }, { status: 500 });
    },
  });
  configDir = mkdtempSync(join(tmpdir(), "nemar-doctor-fix-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "root",
      accounts: {
        root: {
          apiKey: "test-admin-key",
          username: "root",
          role: "admin",
          apiUrl: `http://localhost:${server.port}`,
        },
      },
    }),
  );
});

afterAll(() => {
  server.stop(true);
  rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
});

async function run(args: string[]) {
  // Built from nothing, so no API override in the parent's environment can send a request past
  // the stand-in.
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    NEMAR_CONFIG_DIR: configDir,
    NEMAR_NO_UPDATE_CHECK: "1",
    NEMAR_NO_BROWSER: "1",
    NO_COLOR: "1",
  };
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), exitCode };
}

describe("admin dataset doctor fix", () => {
  test("without --apply it lists what would be fixed and sends only a dry run", async () => {
    const r = await run(["admin", "dataset", "doctor", "fix", "missing-manifest"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Would fix 1 finding(s) for missing-manifest");
    expect(r.stdout).toContain("Re-run with --apply to fix.");
    expect(requests).toEqual([
      { path: "/admin/doctor/fix", body: { check: "missing-manifest", dry_run: true } },
    ]);
  });

  test("the old --dry-run spelling is still a dry run", async () => {
    const r = await run(["admin", "dataset", "doctor", "fix", "missing-manifest", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(requests.map((q) => q.body?.dry_run)).toEqual([true]);
  });

  test("--apply scans, then fixes each dataset", async () => {
    const r = await run(["admin", "dataset", "doctor", "fix", "missing-manifest", "--apply"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("1 fixed");
    expect(requests).toEqual([
      { path: "/admin/doctor/scan", body: { check: "missing-manifest" } },
      { path: "/admin/doctor/fix", body: { check: "missing-manifest", dataset_id: "nm000213" } },
    ]);
  });

  test("--apply with --dry-run is refused before any request", async () => {
    const r = await run([
      "admin",
      "dataset",
      "doctor",
      "fix",
      "missing-manifest",
      "--apply",
      "--dry-run",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("pass --apply or --dry-run, not both");
    expect(requests).toEqual([]);
  });

  test("help names --apply and hides --dry-run", async () => {
    const r = await run(["admin", "dataset", "doctor", "fix", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--apply");
    expect(r.stdout).not.toContain("--dry-run");
  });
});
