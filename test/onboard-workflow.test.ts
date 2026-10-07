/**
 * Structural assertions for the sharded onboard-openneuro workflow (#750).
 * Pure file read + YAML parse — routes to the unit-pure tier.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  FINALIZE_JOB_TIMEOUT_MS,
  FINALIZE_RESERVE_MS,
  MIN_SCREEN_WAIT_MS,
  SCREEN_WAIT_MS,
  screenWaitBudget,
} from "../src/lib/import-publication";

const wf = parse(
  readFileSync(
    join(import.meta.dir, "..", ".github/dataset-workflows/onboard-openneuro.yml"),
    "utf-8",
  ),
) as {
  jobs: Record<
    string,
    {
      "timeout-minutes"?: number;
      if?: string;
      needs?: string | string[];
      strategy?: { "max-parallel"?: number; "fail-fast"?: boolean; matrix?: unknown };
    }
  >;
};

const asNeeds = (n: string | string[] | undefined): string[] =>
  n === undefined ? [] : Array.isArray(n) ? n : [n];

describe("onboard-openneuro workflow", () => {
  test("has prepare, copy, finalize jobs", () => {
    expect(wf.jobs.prepare).toBeDefined();
    expect(wf.jobs.copy).toBeDefined();
    expect(wf.jobs.finalize).toBeDefined();
  });

  test("copy job is sharded, bounded, and isolation-safe", () => {
    const copy = wf.jobs.copy;
    expect(copy["timeout-minutes"]).toBeLessThan(360); // under GitHub's hard cap
    expect(copy.strategy?.["max-parallel"]).toBeGreaterThan(0);
    expect(copy.strategy?.["fail-fast"]).toBe(false);
    expect(copy.if).toContain("cancelled");
  });

  test("finalize's wait for the identifier screen is cut to the job's own timeout (ADR 0089)", () => {
    // The CLI cannot see the job's clock, so it carries the timeout as a constant and this pins
    // the two together: raise the timeout and the constant must follow, which lets the full wait
    // apply. A job killed by its timeout while it waits reports a failure for data in place.
    expect(wf.jobs.finalize["timeout-minutes"]).toBe(FINALIZE_JOB_TIMEOUT_MS / 60_000);
    // Started at once, the whole wait fits only if the job has room for it and the reserve.
    expect(screenWaitBudget(0)).toBe(
      Math.min(SCREEN_WAIT_MS, FINALIZE_JOB_TIMEOUT_MS - FINALIZE_RESERVE_MS),
    );
    // A slow run gets a shorter wait, never a negative or zero one, and never past the reserve.
    expect(screenWaitBudget(40 * 60_000)).toBe(
      FINALIZE_JOB_TIMEOUT_MS - FINALIZE_RESERVE_MS - 40 * 60_000,
    );
    expect(screenWaitBudget(10 * 60 * 60_000)).toBe(MIN_SCREEN_WAIT_MS);
    for (const elapsed of [0, 10, 20, 30, 40, 50, 60].map((m) => m * 60_000)) {
      const total = elapsed + screenWaitBudget(elapsed) + FINALIZE_RESERVE_MS;
      if (screenWaitBudget(elapsed) > MIN_SCREEN_WAIT_MS) {
        expect(total).toBeLessThanOrEqual(FINALIZE_JOB_TIMEOUT_MS);
      }
    }
  });

  test("finalize runs per-dataset even if a copy shard failed", () => {
    expect(wf.jobs.finalize.if).toContain("cancelled");
    expect(wf.jobs.finalize.strategy?.["fail-fast"]).toBe(false);
  });

  test("phase dependency graph is wired (prepare -> copy -> finalize)", () => {
    // Without these, copy/finalize could run before their inputs exist (e.g.
    // finalize reading an incomplete manifest while copy shards are still going).
    expect(asNeeds(wf.jobs.copy.needs)).toContain("prepare");
    expect(asNeeds(wf.jobs.finalize.needs)).toContain("copy");
    // Both also need parse-ids for their matrix.
    expect(asNeeds(wf.jobs.copy.needs)).toContain("parse-ids");
    expect(asNeeds(wf.jobs.finalize.needs)).toContain("parse-ids");
  });
});
