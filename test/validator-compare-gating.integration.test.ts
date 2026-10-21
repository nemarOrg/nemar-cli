/**
 * The reference-dataset comparison that the monthly bump runs before it opens its pull request.
 *
 * compare-gating.sh runs two validator releases over each dataset with the gate the central
 * workflow applies. These tests run the real script with the real validator, on the bids-minimal
 * fixture and on two generated canary layouts. Published JSR releases never change, so the known
 * difference between 2.4.1 and 3.0.2 on the symlink canary is a stable expectation. The tests need
 * the network (JSR and GitHub), so they belong to the integration tier. No mocks.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts/validator/compare-gating.sh");
const FIXTURE = join(ROOT, "test/fixtures/bids-minimal");
const ESCAPE = "\u001b";

/** Every directory a test creates, removed when the file's tests finish. */
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** Run the script with exactly these arguments. */
function run(args: string[]): { exitCode: number; stderr: string } {
  const proc = Bun.spawnSync(["bash", SCRIPT, ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stderr: proc.stderr.toString() };
}

/** Run the script with an output directory of its own; returns that directory too. */
function compare(args: string[]): { out: string; exitCode: number; stderr: string } {
  const out = freshDir("compare-gating-");
  return { out, ...run([...args, "--out", out]) };
}

/** The rows of results.tsv, keyed by dataset: dataset, status, gating old, gating new, changed, note. */
function rows(out: string): Record<string, string[]> {
  const lines = readFileSync(join(out, "results.tsv"), "utf-8").trim().split("\n").slice(1);
  return Object.fromEntries(lines.map((line) => [line.split("\t")[0], line.split("\t")]));
}

function readOut(out: string, name: string): string {
  return readFileSync(join(out, name), "utf-8");
}

describe("compare-gating.sh", () => {
  test("a release compared with itself changes nothing, on the fixture and both canaries", () => {
    const run1 = compare([
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
    expect(run1.exitCode).toBe(0);
    expect(rows(run1.out)["bids-minimal"]?.slice(1, 5)).toEqual(["compared", "0", "0", "no"]);
    // Under 3.0.2 the symlink canary's sidecar error survives the filter, so the gate would refuse it.
    expect(rows(run1.out)["canary-emg-annex-sidecar"]?.slice(1, 5)).toEqual([
      "compared",
      "1",
      "1",
      "no",
    ]);
    // The pointer canary is filtered by the central gate under both releases.
    expect(rows(run1.out)["canary-emg-annex-pointer"]?.slice(1, 5)).toEqual([
      "compared",
      "0",
      "0",
      "no",
    ]);
    expect(readOut(run1.out, "summary.md")).toContain("Compared 3 of 3 datasets; 0 changed.");
  }, 120_000);

  test("the symlink canary's gating verdict changes between 2.4.1 and 3.0.2; the pointer canary's does not", () => {
    const run2 = compare(["--old", "2.4.1", "--new", "3.0.2", "--ids", "", "--canary"]);
    expect(run2.exitCode).toBe(0);
    expect(rows(run2.out)["canary-emg-annex-sidecar"]?.slice(1, 5)).toEqual([
      "compared",
      "0",
      "1",
      "yes",
    ]);
    expect(rows(run2.out)["canary-emg-annex-pointer"]?.slice(1, 5)).toEqual([
      "compared",
      "0",
      "0",
      "no",
    ]);
    expect(readOut(run2.out, "diff-canary-emg-annex-sidecar.txt")).toContain(
      "SIDECAR_WITHOUT_DATAFILE",
    );
    const summary = readOut(run2.out, "summary.md");
    expect(summary).toContain("### canary-emg-annex-sidecar");
    expect(summary).not.toContain("### canary-emg-annex-pointer");
  }, 120_000);

  test("a dataset that cannot be cloned fails the run, unless partial results are accepted", () => {
    const strict = compare(["--old", "3.0.2", "--new", "3.0.2", "--ids", "nm999999"]);
    expect(strict.exitCode).toBe(1);
    expect(rows(strict.out).nm999999?.slice(1, 5)).toEqual(["not_compared", "-", "-", "-"]);
    expect(readOut(strict.out, "summary.md")).toContain(
      "Not compared, so not counted as unchanged: nm999999",
    );

    const partial = compare([
      "--old",
      "3.0.2",
      "--new",
      "3.0.2",
      "--ids",
      "nm999999",
      "--allow-partial",
    ]);
    expect(partial.exitCode).toBe(0);
    expect(readOut(partial.out, "summary.md")).toContain("Compared 0 of 1 datasets; 0 changed.");
  }, 120_000);

  test("a validator release that does not exist is a failed comparison, with plain messages", () => {
    const failed = compare(["--old", "99.0.0", "--new", "3.0.2", "--ids", "", "--canary"]);
    expect(failed.exitCode).toBe(1);
    const sidecar = rows(failed.out)["canary-emg-annex-sidecar"];
    expect(sidecar?.[1]).toBe("not_compared");
    expect(sidecar?.[5]).toContain("validator 99.0.0 exited");
    expect(readOut(failed.out, "results.tsv")).not.toContain(ESCAPE);
    expect(readOut(failed.out, "summary.md")).toContain(
      "Not compared, so not counted as unchanged",
    );
  }, 120_000);

  test("nothing to compare is a failure, not an empty pass", () => {
    expect(compare(["--old", "3.0.2", "--new", "3.0.2", "--ids", ""]).exitCode).toBe(1);
  });

  test("refuses to run without each required argument", () => {
    const out = freshDir("compare-args-");
    expect(run(["--new", "3.0.2", "--out", out]).exitCode).toBe(2);
    expect(run(["--old", "3.0.2", "--out", out]).exitCode).toBe(2);
    expect(run(["--old", "3.0.2", "--new", "3.0.2"]).exitCode).toBe(2);
    expect(run(["--old", "3.0.2", "--new", "3.0.2", "--out"]).exitCode).toBe(2);
  });

  test("refuses an output directory that cannot be created", () => {
    const blocker = join(freshDir("compare-blocker-"), "a-file");
    writeFileSync(blocker, "not a directory");
    expect(
      run([
        "--old",
        "3.0.2",
        "--new",
        "3.0.2",
        "--ids",
        "",
        "--canary",
        "--out",
        join(blocker, "sub"),
      ]).exitCode,
    ).toBe(1);
  });
});
