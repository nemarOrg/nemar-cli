/**
 * `nemar admin dataset doctor fix` is a dry run unless `--apply` is given (ADR 0135, the admin
 * tree restructure). Driven through the real entry point against a local Bun.serve stand-in that
 * is the account's stored apiUrl and records every request body, so a run that wrote anything
 * shows up as a fix request without `dry_run`.
 *
 * CI TIER: unit-pure. Hermetic: the CLI is spawned with an environment built from nothing.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { startIsolatedCli } from "./helpers/isolated-cli";

setDefaultTimeout(30_000);

const FINDING = { dataset_id: "nm000213", version: "1.0.0" };

const cli = startIsolatedCli(({ path, body }) => {
  if (path === "/admin/doctor/scan") {
    return Response.json({
      scanned: ["missing-manifest"],
      results: { "missing-manifest": { description: "stand-in", count: 1, findings: [FINDING] } },
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
});

afterAll(() => cli.stop());
beforeEach(() => cli.reset());

const fix = (...extra: string[]) =>
  cli.run(["admin", "dataset", "doctor", "fix", "missing-manifest", ...extra]);

describe("admin dataset doctor fix", () => {
  test("without --apply it lists what would be fixed and sends only a dry run", async () => {
    const r = await fix();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Would fix 1 finding(s) for missing-manifest");
    expect(r.stdout).toContain("Re-run with --apply to fix.");
    expect(cli.requests).toEqual([
      {
        method: "POST",
        path: "/admin/doctor/fix",
        body: { check: "missing-manifest", dry_run: true },
      },
    ]);
  });

  test("the old --dry-run spelling is still a dry run", async () => {
    const r = await fix("--dry-run");
    expect(r.exitCode).toBe(0);
    expect(cli.requests.map((q) => q.body?.dry_run)).toEqual([true]);
  });

  test("--apply scans, then fixes each dataset", async () => {
    const r = await fix("--apply");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("1 fixed");
    expect(cli.requests).toEqual([
      { method: "POST", path: "/admin/doctor/scan", body: { check: "missing-manifest" } },
      {
        method: "POST",
        path: "/admin/doctor/fix",
        body: { check: "missing-manifest", dataset_id: "nm000213" },
      },
    ]);
  });

  test("--apply with --dry-run is refused before any request", async () => {
    const r = await fix("--apply", "--dry-run");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("pass --apply or --dry-run, not both");
    expect(cli.requests).toEqual([]);
  });

  test("help names --apply and hides --dry-run", async () => {
    const r = await cli.run(["admin", "dataset", "doctor", "fix", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--apply");
    expect(r.stdout).not.toContain("--dry-run");
  });
});
