/**
 * The `admin dataset` group (ADR 0135): the `repo` alias, `--apply` with its hidden `--execute`
 * alias on the lifecycle commands, and `doi create` without `--provider`. Driven through the real
 * entry point against a recording Bun.serve stand-in, so each assertion is about what the command
 * sent, not only what it printed.
 *
 * CI TIER: unit-pure. Hermetic: the CLI is spawned with an environment built from nothing.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { startIsolatedCli } from "./helpers/isolated-cli";

setDefaultTimeout(30_000);

const cli = startIsolatedCli();
afterAll(() => cli.stop());
beforeEach(() => cli.reset());

describe("repo is an alias of dataset", () => {
  test("admin repo publish approve --help is the dataset command's help", async () => {
    const r = await cli.run(["admin", "repo", "publish", "approve", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage: nemar admin dataset publish approve");
    expect(cli.requests).toEqual([]);
  });

  test("admin repo --help and admin dataset --help are the same text", async () => {
    const viaAlias = await cli.run(["admin", "repo", "--help"]);
    const direct = await cli.run(["admin", "dataset", "--help"]);
    expect(viaAlias.exitCode).toBe(0);
    expect(viaAlias.stdout).toBe(direct.stdout);
  });
});

describe("--apply writes; --execute is its hidden alias", () => {
  // `--no` declines the confirmation that only a writing run asks for, so reaching "Skipped" with
  // no request proves the flag turned the dry run off. Without a write flag the dry run is sent.
  const cases: [string, string[]][] = [
    ["restore", ["restore", "nm000999"]],
    ["withdraw", ["withdraw", "nm000999", "--force", "--reason", "broken"]],
    ["unpublish", ["unpublish", "nm000999", "--reason", "authors request"]],
  ];

  test.each(cases)("dataset %s without a write flag sends a dry run", async (name, args) => {
    await cli.run(["admin", "dataset", ...args]);
    expect(cli.requests.map((q) => [q.path, q.body?.dry_run])).toEqual([
      [`/admin/datasets/nm000999/${name}`, true],
    ]);
  });

  for (const flag of ["--apply", "--execute"]) {
    test.each(cases)(`dataset %s ${flag} asks before writing`, async (_name, args) => {
      const r = await cli.run(["admin", "dataset", ...args, flag, "--no"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Skipped");
      expect(cli.requests).toEqual([]);
    });
  }

  for (const flag of ["--apply", "--execute"]) {
    test.each(cases)(
      `dataset %s ${flag} --yes sends the write, not a dry run`,
      async (name, args) => {
        await cli.run(["admin", "dataset", ...args, flag, "--yes"]);
        expect(cli.requests.map((q) => q.path)).toEqual([`/admin/datasets/nm000999/${name}`]);
        expect(cli.requests[0].body?.dry_run).not.toBe(true);
        expect(cli.requests[0].body?.dry_run).toBe(false);
      },
    );
  }

  test.each(cases)("dataset %s --help lists --apply and hides --execute", async (_name, args) => {
    const r = await cli.run(["admin", "dataset", args[0], "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--apply");
    expect(r.stdout).not.toContain("--execute");
  });
});

describe("dataset doi create has no --provider", () => {
  test("help does not offer it", async () => {
    const r = await cli.run(["admin", "dataset", "doi", "create", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("--provider");
  });

  test("passing it is Commander's unknown-option error, before any request", async () => {
    const r = await cli.run([
      "admin",
      "dataset",
      "doi",
      "create",
      "nm000999",
      "--provider",
      "ezid",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown option '--provider'");
    expect(cli.requests).toEqual([]);
  });
});
