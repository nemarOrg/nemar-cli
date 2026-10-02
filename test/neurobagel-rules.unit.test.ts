/**
 * Column rules called directly (epic #1586, phase 1).
 *
 * The entry-point tests (neurobagel-transform.unit.test.ts) drive every rule through
 * `buildNeurobagelArtifacts`.
 * This file holds what the entry point cannot reach: a column larger than any dataset
 * in the catalog.
 * The inputs are SYNTHETIC, by necessity.
 */

import { describe, expect, test } from "bun:test";
import { mapAgeColumn } from "../shared/neurobagel/participants";

describe("mapAgeColumn on a very large column", () => {
  test("a column of 300,000 ages is mapped, with its true range (Math.min(...ages) would throw)", () => {
    const cells = Array.from({ length: 300_000 }, (_, i) => String(1 + (i % 90)));
    const outcome = mapAgeColumn("age", cells, undefined);
    expect(outcome.status).toBe("mapped");
    if (outcome.status !== "mapped") return;
    expect(outcome.valueRange).toEqual({ min: 1, max: 90 });
    expect(outcome.counts.cells).toBe(300_000);
    expect(outcome.counts.mapped).toBe(300_000);
  });
});
