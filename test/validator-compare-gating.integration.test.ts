/**
 * The reference-dataset comparison that the monthly bump runs before it opens its pull request.
 *
 * compare-gating.sh runs two validator releases over each dataset with the gate the central
 * workflow applies. These tests run the real script with the real validator on the bids-minimal
 * fixture and on a generated canary layout. The canary is a data file that is an unfetched
 * git-annex link, with a sidecar next to it. Published JSR releases never change, so the known
 * difference between 2.4.1 and 3.0.2 on that layout is a stable expectation. No mocks.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts/validator/compare-gating.sh");
const FIXTURE = join(ROOT, "test/fixtures/bids-minimal");

/** Run the script with the given arguments, writing its output into a fresh directory. */
function compare(args: string[]): { out: string; exitCode: number; stderr: string } {
  const out = mkdtempSync(join(tmpdir(), "compare-gating-"));
  const proc = Bun.spawnSync(["bash", SCRIPT, ...args, "--out", out], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { out, exitCode: proc.exitCode, stderr: proc.stderr.toString() };
}

/** The rows of results.tsv, keyed by dataset: dataset, status, gating old, gating new, changed, note. */
function rows(out: string): Record<string, string[]> {
  const lines = readFileSync(join(out, "results.tsv"), "utf-8").trim().split("\n").slice(1);
  return Object.fromEntries(lines.map((line) => [line.split("\t")[0], line.split("\t")]));
}

describe("compare-gating.sh", () => {
  test("a release compared with itself changes nothing", () => {
    const run = compare([
      "--old",
      "3.0.2",
      "--new",
      "3.0.2",
      "--ids",
      "",
      "--local",
      FIXTURE,
      "--canary",
    ]);
    expect(run.exitCode).toBe(0);
    expect(rows(run.out)["bids-minimal"]).toEqual([
      "bids-minimal",
      "compared",
      "0",
      "0",
      "no",
      "-",
    ]);
    // Under 3.0.2 the canary's sidecar error survives the filter, so the gate would refuse it.
    expect(rows(run.out)["canary-emg-annex-sidecar"]?.slice(1, 5)).toEqual([
      "compared",
      "1",
      "1",
      "no",
    ]);
    const summary = readFileSync(join(run.out, "summary.md"), "utf-8");
    expect(summary).toContain("| bids-minimal | 0 | 0 | no |");
    expect(summary).toContain("Compared 2 of 2 datasets; 0 changed.");
  }, 120_000);

  test("the canary's gating verdict changes between 2.4.1 and 3.0.2", () => {
    const run = compare(["--old", "2.4.1", "--new", "3.0.2", "--ids", "", "--canary"]);
    expect(run.exitCode).toBe(0);
    expect(rows(run.out)["canary-emg-annex-sidecar"]?.slice(1, 5)).toEqual([
      "compared",
      "0",
      "1",
      "yes",
    ]);
    const diff = readFileSync(join(run.out, "diff-canary-emg-annex-sidecar.txt"), "utf-8");
    expect(diff).toContain("SIDECAR_WITHOUT_DATAFILE");
    expect(readFileSync(join(run.out, "summary.md"), "utf-8")).toContain(
      "### canary-emg-annex-sidecar",
    );
  }, 120_000);

  test("a dataset that cannot be cloned is listed as not compared, never as unchanged", () => {
    const run = compare(["--old", "3.0.2", "--new", "3.0.2", "--ids", "nm999999"]);
    expect(run.exitCode).toBe(0);
    const row = rows(run.out).nm999999;
    expect(row?.slice(1, 5)).toEqual(["not_compared", "-", "-", "-"]);
    const summary = readFileSync(join(run.out, "summary.md"), "utf-8");
    expect(summary).toContain("Not compared, so not counted as unchanged: nm999999");
    expect(summary).toContain("Compared 0 of 1 datasets; 0 changed.");
  }, 120_000);

  test("refuses to run without both versions and an output directory", () => {
    const proc = Bun.spawnSync(["bash", SCRIPT, "--old", "3.0.2"], { cwd: ROOT, stderr: "pipe" });
    expect(proc.exitCode).toBe(2);
  });
});
