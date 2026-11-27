/**
 * The web-button approval calls `admin dataset publish approve` directly.
 *
 * nemarDatasets/.github `.github/workflows/approve-publication.yml` is not authored in this
 * repository; it is read from the same deployed checkout the onboarding parity test reads
 * (`test/helpers/deployed-dataset-workflows.ts`: `NEMAR_DATASET_WORKFLOW_LIVE` in CI, a sibling
 * checkout locally), and this file skips exactly when that test does. Until #2348 the workflow
 * probed `nemar admin repo --help` and fell back to `admin publish approve`, a moved-command stub
 * that exits 1. Both install tags carry the new path now, so the probe and the fallback are gone,
 * and this test fails if either comes back or if the path or its flags move in the CLI.
 *
 * CI TIER: unit-pure. Hermetic: the CLI is spawned with an environment built from nothing;
 * `--help` makes no request, and the account's apiUrl is a recording stand-in that would show one.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { deployedWorkflow } from "./helpers/deployed-dataset-workflows";
import { startIsolatedCli } from "./helpers/isolated-cli";

setDefaultTimeout(30_000);

const DEPLOYED = deployedWorkflow("approve-publication.yml");

/** The run scripts of the deployed workflow's steps. */
function runScripts(path: string): string[] {
  const doc = parse(readFileSync(path, "utf-8")) as {
    jobs: Record<string, { steps?: { run?: string }[] }>;
  };
  return Object.values(doc.jobs).flatMap((j) => (j.steps ?? []).map((s) => s.run ?? ""));
}

/** Script lines that are not comments. */
const commandLines = (scripts: string[]): string[] =>
  scripts.flatMap((s) => s.split("\n")).filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));

/** The checks, on one workflow file; the control below runs them on a mutant too. */
function assertDirectApprove(path: string): void {
  const raw = readFileSync(path, "utf-8");
  const lines = commandLines(runScripts(path)).map((l) => l.trim());
  // One argument line, naming the canonical path with --yes, and --resume added on a resume.
  expect(lines.filter((l) => l.startsWith("args=("))).toEqual([
    'args=(admin dataset publish approve "$DATASET_ID" --yes)',
  ]);
  expect(lines).toContain('if [ "$RESUME" = "true" ]; then args+=(--resume); fi');
  expect(lines).toContain('nemar "${args[@]}"');
  // No probe and no fallback, in commands or comments.
  for (const gone of ["approve_cmd", "repo_help", "admin repo --help", "admin publish approve"]) {
    expect({ gone, present: raw.includes(gone) }).toEqual({ gone, present: false });
  }
}

describe.skipIf(DEPLOYED === null)("the deployed approve-publication.yml", () => {
  test("is present beside the deployed onboarding copy", () => {
    // Not a skip: a checkout that has the onboarding copy and not this file is a broken
    // checkout (the sparse list in test.yml names both).
    expect(existsSync(DEPLOYED ?? ""), `${DEPLOYED} does not exist`).toBe(true);
  });

  test("calls admin dataset publish approve directly, with no probe or fallback", () => {
    assertDirectApprove(DEPLOYED ?? "");
  });

  test("control: the check fails on a copy with the fallback put back", () => {
    const dir = mkdtempSync(join(tmpdir(), "approve-mutant-"));
    try {
      const mutant = join(dir, "approve-publication.yml");
      writeFileSync(
        mutant,
        readFileSync(DEPLOYED ?? "", "utf-8").replace(
          '          args=(admin dataset publish approve "$DATASET_ID" --yes)\n',
          [
            '          repo_help="$(nemar admin repo --help 2>/dev/null || true)"',
            '          if [[ "$repo_help" == *publish* ]]; then approve_cmd=(admin dataset publish approve); else approve_cmd=(admin publish approve); fi',
            '          args=("${approve_cmd[@]}" "$DATASET_ID" --yes)',
            "",
          ].join("\n"),
        ),
      );
      expect(readFileSync(mutant, "utf-8")).toContain("approve_cmd=(admin publish approve)");
      expect(() => assertDirectApprove(mutant)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const cli = startIsolatedCli();
afterAll(() => cli.stop());
beforeEach(() => cli.reset());

describe("the approve path in this CLI", () => {
  test("admin dataset publish approve is live, and takes --yes and --resume", async () => {
    const live = await cli.run(["admin", "dataset", "publish", "approve", "--help"]);
    expect(live.exitCode).toBe(0);
    // Commander answers --help under an unknown word with the parent's help and exit 0, so the
    // exit code alone cannot tell; the usage line names the command that answered.
    expect(live.stdout).toContain(
      "Usage: nemar admin dataset publish approve [options] <dataset-id>",
    );
    expect(live.stdout).toContain("--yes");
    expect(live.stdout).toContain("--resume");
    expect(cli.requests).toEqual([]);
  });

  test("the fallback the workflow no longer has is a stub that exits 1", async () => {
    // Why the fallback was dead and must not come back: the old path runs nothing.
    const dead = await cli.run(["admin", "publish", "approve", "nm000999", "--yes"]);
    expect(dead.exitCode).toBe(1);
    expect(dead.stderr).toContain("moved to 'nemar admin dataset publish'");
    expect(cli.requests).toEqual([]);
  });
});
