/**
 * The write flag of the two `admin fleet` commands that had their own spelling (ADR 0135 decision
 * 4): `fleet sweep availability` (formerly `--write`) and `fleet summary check` (formerly `--fix`,
 * with `--yes` to skip its prompt). `--apply` writes and the old spelling is a hidden alias of it.
 * Driven through the real entry point against a recording Bun.serve stand-in, so each assertion is
 * on what reached the backend.
 *
 * CI TIER: unit-pure. Hermetic: the CLI is spawned with an environment built from nothing.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { startIsolatedCli } from "./helpers/isolated-cli";

setDefaultTimeout(30_000);

const COVERAGE = {
  generated_at: "2026-11-23T00:00:00Z",
  target_schema: "2",
  totals: { versions: 2, ok: 1, stale: 1, missing: 0, error: 0 },
  versions: [
    {
      dataset_id: "nm000901",
      version: "1.0.0",
      doi: "10.82901/nemar.nm000901.v1.0.0",
      concept_doi: null,
      state: { kind: "ok", schema_version: "2" },
    },
    {
      dataset_id: "nm000902",
      version: "1.0.0",
      doi: "10.82901/nemar.nm000902.v1.0.0",
      concept_doi: null,
      state: { kind: "stale", schema_version: "1" },
    },
  ],
};

const cli = startIsolatedCli(({ path }) => {
  if (path === "/admin/summary/coverage") return Response.json(COVERAGE);
  if (path === "/admin/manifest/dispatch") {
    return Response.json({ dispatched: true, dataset_id: "nm000902", version: "1.0.0" });
  }
  return Response.json({ error: "not stood in" }, { status: 500 });
});
afterAll(() => cli.stop());
beforeEach(() => cli.reset());

const availabilityCalls = () =>
  cli.requests
    .filter((q) => q.path === "/admin/datasets/nm000999/availability-report")
    .map((q) => q.query ?? "");
const dispatches = () => cli.requests.filter((q) => q.path === "/admin/manifest/dispatch");

describe("admin fleet sweep availability", () => {
  test("without a write flag it previews (dry_run=1)", async () => {
    await cli.run(["admin", "fleet", "sweep", "availability", "nm000999"]);
    expect(availabilityCalls()).toEqual(["?dry_run=1"]);
  });

  test.each(["--apply", "--write"])("%s commits the report (no dry_run)", async (flag) => {
    await cli.run(["admin", "fleet", "sweep", "availability", "nm000999", flag]);
    expect(availabilityCalls()).toEqual([""]);
  });

  test("help lists --apply and hides --write", async () => {
    const r = await cli.run(["admin", "fleet", "sweep", "availability", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--apply");
    expect(r.stdout).not.toContain("--write");
  });
});

describe("admin fleet summary check", () => {
  test("without a write flag it reports and names --apply, dispatching nothing", async () => {
    const r = await cli.run(["admin", "fleet", "summary", "check"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Run with --apply to dispatch generate-manifest for the 1");
    expect(dispatches()).toEqual([]);
  });

  test.each(["--apply", "--fix"])("%s with --no asks and dispatches nothing", async (flag) => {
    const r = await cli.run(["admin", "fleet", "summary", "check", flag, "--no"]);
    expect(r.stdout).toContain("Skipped");
    expect(dispatches()).toEqual([]);
  });

  test.each(["--apply", "--fix"])("%s with --yes dispatches each drifted version", async (flag) => {
    const r = await cli.run(["admin", "fleet", "summary", "check", flag, "--yes"]);
    expect(r.exitCode).toBe(0);
    expect(dispatches().map((q) => q.body)).toEqual([
      { dataset_id: "nm000902", version: "1.0.0", skip_canary: false },
    ]);
  });

  test("help lists --apply and hides --fix", async () => {
    const r = await cli.run(["admin", "fleet", "summary", "check", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--apply");
    expect(r.stdout).not.toContain("--fix");
  });
});
