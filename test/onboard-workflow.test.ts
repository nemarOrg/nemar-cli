/**
 * Structural assertions for the sharded onboard-openneuro workflow (#750).
 * Pure file read + YAML parse — routes to the unit-pure tier.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

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
