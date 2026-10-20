/**
 * The monthly bump finds the newest stable @bids/validator release on JSR and opens a pin PR for it.
 *
 * The selection is scripts/validator/latest-stable.jq, and bump-validator.yml runs that same file.
 * These tests run it with the real jq binary: against a snapshot of JSR's metadata (the version
 * list the old 2.x-only regex stopped at 2.4.1 on), and against small version lists that pin each
 * rule. Real files and real jq, no mocks.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = join(import.meta.dir, "..");
const PROGRAM = join(ROOT, "scripts/validator/latest-stable.jq");
const SNAPSHOT = join(ROOT, "test/fixtures/jsr-bids-validator-meta.json");

/** Run the workflow's selection on a JSR metadata document. */
function latestStable(meta: unknown): { exitCode: number; stdout: string } {
  const proc = Bun.spawnSync(["jq", "-r", "-f", PROGRAM], {
    stdin: new TextEncoder().encode(JSON.stringify(meta)),
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString().trim() };
}

/** A JSR metadata document listing only these versions. */
function versionsMeta(...versions: string[]): { versions: Record<string, object> } {
  return { versions: Object.fromEntries(versions.map((version) => [version, {}])) };
}

describe("latest-stable.jq", () => {
  test("picks 3.0.2 from the JSR snapshot that the 2.x regex froze at 2.4.1", () => {
    const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf-8"));
    expect(latestStable(snapshot)).toEqual({ exitCode: 0, stdout: "3.0.2" });
  });

  test("takes a newer major version instead of staying on one line", () => {
    expect(latestStable(versionsMeta("2.4.1", "3.0.2", "4.0.0"))).toEqual({
      exitCode: 0,
      stdout: "4.0.0",
    });
  });

  test("never selects a prerelease, even when it is the highest version listed", () => {
    expect(latestStable(versionsMeta("2.4.1", "3.0.0-alpha.4"))).toEqual({
      exitCode: 0,
      stdout: "2.4.1",
    });
  });

  test("compares each part as a number, so 2.0.10 is newer than 2.0.9", () => {
    expect(latestStable(versionsMeta("2.0.2", "2.0.10", "2.0.9"))).toEqual({
      exitCode: 0,
      stdout: "2.0.10",
    });
  });

  test("fails rather than printing nothing when no stable release is listed", () => {
    expect(latestStable(versionsMeta("3.0.0-alpha.0")).exitCode).not.toBe(0);
  });
});

describe("bump-validator.yml", () => {
  const workflow = parse(readFileSync(join(ROOT, ".github/workflows/bump-validator.yml"), "utf-8"));
  const steps: { id?: string; name?: string; run?: string; uses?: string; with?: object }[] =
    workflow.jobs.bump.steps;

  test("resolves the newest release with the shared program and no major-version pin", () => {
    const resolve = steps.find((step) => step.id === "resolve");
    expect(resolve?.run).toContain("scripts/validator/latest-stable.jq");
    expect(resolve?.run).not.toContain("^2");
  });

  test("runs monthly, on the first day of the month", () => {
    expect(workflow.on.schedule[0].cron).toBe("0 6 1 * *");
  });

  test("compares the reference datasets before it opens the pull request, and the body carries the result", () => {
    const compareAt = steps.findIndex((step) => step.run?.includes("compare-gating.sh"));
    const openAt = steps.findIndex((step) =>
      step.uses?.startsWith("peter-evans/create-pull-request"),
    );
    expect(compareAt).toBeGreaterThanOrEqual(0);
    expect(openAt).toBeGreaterThan(compareAt);
    expect(steps[openAt].with).toHaveProperty("body-path");
    expect(steps.find((step) => step.name === "Write the pull request body")?.run).toContain(
      "validator-compare/summary.md",
    );
  });
});
