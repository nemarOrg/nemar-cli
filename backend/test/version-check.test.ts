/**
 * Behavior tests for the hardened version-check (epic #713, phase #718).
 *
 * Runs the EXACT bash that the generated `version-check.yml` workflow executes
 * (`VERSION_COMPARE_SNIPPET`) via a real bash subprocess with sample env, and
 * asserts the exit code. No mocks: this is the actual algorithm that gates
 * published-dataset PRs, exercised end-to-end.
 */

import { describe, expect, test } from "bun:test";
import { VERSION_COMPARE_SNIPPET } from "../src/services/github";

async function runCompare(prVersion: string, mainVersion: string): Promise<number> {
  const proc = Bun.spawn(["bash", "-c", VERSION_COMPARE_SNIPPET], {
    env: { ...process.env, PR_VERSION: prVersion, MAIN_VERSION: mainVersion },
    stdout: "pipe",
    stderr: "pipe",
  });
  return await proc.exited;
}

describe("VERSION_COMPARE_SNIPPET", () => {
  test("accepts a strict patch increment", async () => {
    expect(await runCompare("1.0.1", "1.0.0")).toBe(0);
  });

  test("accepts minor and major increments", async () => {
    expect(await runCompare("1.1.0", "1.0.9")).toBe(0);
    expect(await runCompare("2.0.0", "1.9.9")).toBe(0);
  });

  test("compares numerically, not lexically (1.0.10 > 1.0.9)", async () => {
    expect(await runCompare("1.0.10", "1.0.9")).toBe(0);
  });

  test("rejects an unchanged version", async () => {
    expect(await runCompare("1.0.0", "1.0.0")).not.toBe(0);
  });

  test("rejects a downgrade", async () => {
    expect(await runCompare("1.0.0", "2.0.0")).not.toBe(0);
    expect(await runCompare("1.0.9", "1.0.10")).not.toBe(0);
  });

  test("rejects a non-semver PR version", async () => {
    for (const bad of ["v1.0.0", "1.0", "1.0.0.0", "latest", "1.0.0-rc1", ""]) {
      expect(await runCompare(bad, "0.0.0")).not.toBe(0);
    }
  });

  test("first version (X.Y.Z over default 0.0.0) passes", async () => {
    expect(await runCompare("1.0.0", "0.0.0")).toBe(0);
    expect(await runCompare("0.1.0", "0.0.0")).toBe(0);
  });

  test("treats a non-semver / empty main as 0.0.0", async () => {
    expect(await runCompare("1.0.0", "")).toBe(0);
    expect(await runCompare("1.0.0", "not-a-version")).toBe(0);
  });

  test("0.0.0 over 0.0.0 is rejected (no increment)", async () => {
    expect(await runCompare("0.0.0", "0.0.0")).not.toBe(0);
  });
});
