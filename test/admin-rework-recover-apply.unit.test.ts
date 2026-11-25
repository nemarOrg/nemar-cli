/**
 * `nemar admin rework recover`: `--apply` is the write flag and `--execute` its hidden alias
 * (ADR 0135 decision 4). Driven through the real entry point against a recording Bun.serve
 * stand-in, with the checked-in recover list. `--no` declines the confirmation that only a
 * writing run asks for, so reaching "This verifies" with no request proves the flag turned the
 * dry run off, and nothing here verifies or dispatches anything.
 *
 * CI TIER: unit-pure. Hermetic: the CLI is spawned with an environment built from nothing.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { startIsolatedCli } from "./helpers/isolated-cli";

setDefaultTimeout(30_000);

const cli = startIsolatedCli();
afterAll(() => cli.stop());
beforeEach(() => cli.reset());

describe("admin rework recover", () => {
  test("without a write flag it is a dry run that names --apply", async () => {
    const r = await cli.run(["admin", "rework", "recover", "--all"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[dry-run] Would recover");
    expect(r.stdout).toContain("Pass --apply to run.");
    expect(cli.requests).toEqual([]);
  });

  test.each(["--apply", "--execute"])("%s asks before verifying anything", async (flag) => {
    const r = await cli.run(["admin", "rework", "recover", "--all", flag, "--no"]);
    expect(r.stdout).not.toContain("[dry-run]");
    expect(r.stdout).toContain("This verifies (reclassifies) and re-dispatches");
    expect(cli.requests).toEqual([]);
  });

  test("help lists --apply and hides --execute", async () => {
    const r = await cli.run(["admin", "rework", "recover", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--apply");
    expect(r.stdout).not.toMatch(/^\s+--execute/m);
  });
});
