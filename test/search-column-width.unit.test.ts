/**
 * D4 (epic #1144 phase 6, issue #1150): the search result table derives its
 * column widths from the terminal width instead of a hardcoded `nameWidth`,
 * shrinking the name column first and then dropping the least load-bearing
 * columns (HED, then Subj, then Modality) before the id -- which the user
 * copies into their next command -- is ever touched.
 *
 * `planSearchColumns`/`renderSearchResultLines` ARE `nemar dataset
 * search`'s real column-layout logic (exported directly from
 * `src/commands/dataset.ts`, not a re-implementation of it): the command's
 * action calls exactly these with `process.stdout.columns ?? 80`. Real
 * `process.stdout.columns` being undefined for piped output is exercised
 * end-to-end over a real subprocess in test/search-color.unit.test.ts and
 * test/search-score-column.unit.test.ts (every one of those spawns pipes
 * stdout, so `columns` is always undefined there and the search command
 * still exits 0 with a full table) -- there is no way to drive an actual
 * 200/80/40-column terminal through a real pty in this test runner, so
 * those specific widths are exercised directly against the same exported
 * function the command calls.
 *
 * D7: a non-finite or non-positive `columns` value (a terminal-capability
 * probe gone wrong) must degrade to the default rather than crashing or
 * producing a zero-width column.
 */

import { describe, expect, test } from "bun:test";
import {
  SEARCH_DEFAULT_COLUMNS,
  planSearchColumns,
  renderSearchResultLines,
} from "../src/commands/dataset";
import type { DatasetSearchResult } from "../src/lib/api/datasets";

function makeResult(overrides: Partial<DatasetSearchResult> = {}): DatasetSearchResult {
  return {
    id: "nm000262",
    name: "P300 BCI EEG dataset (Chailloux Peguero et al. 2020)",
    modalities: "eeg",
    participants: 19,
    doi: "10.82901/nemar.nm000262",
    tasks: "p300",
    authors: "J. David Chailloux Peguero",
    has_hed: 1,
    score: 0.0315,
    ...overrides,
  };
}

describe("planSearchColumns (#1150 D4)", () => {
  test("at 200 columns, everything is shown and the name column reaches its cap", () => {
    const results = [makeResult({ name: "A".repeat(60) })];
    const plan = planSearchColumns(results, 200);
    expect(plan.showModality).toBe(true);
    expect(plan.showSubj).toBe(true);
    expect(plan.showHed).toBe(true);
    expect(plan.nameWidth).toBe(35); // SEARCH_MAX_NAME_WIDTH
  });

  test("at 80 columns (the default), a typical result set still shows every column", () => {
    const results = [makeResult()];
    const plan = planSearchColumns(results, 80);
    expect(plan.showModality).toBe(true);
    expect(plan.showSubj).toBe(true);
    expect(plan.showHed).toBe(true);
  });

  test("at 40 columns, less load-bearing columns are dropped before the name disappears", () => {
    const results = [makeResult({ name: "A".repeat(60) })];
    const plan = planSearchColumns(results, 40);
    // HED is dropped first, then Subj, then Modality if still too tight --
    // but the name column and the id column both survive in some form.
    expect(plan.idWidth).toBeGreaterThanOrEqual(10);
    expect(plan.nameWidth).toBeGreaterThan(0);
  });

  test("the id column width is never smaller than the longest real id, at any width", () => {
    const longId = "on0037681234567890";
    const results = [makeResult({ id: longId })];
    for (const columns of [200, 80, 40, 20, 10, 1]) {
      const plan = planSearchColumns(results, columns);
      expect(plan.idWidth).toBeGreaterThanOrEqual(longId.length);
    }
  });

  test("dropping order is HED, then Subj, then Modality -- never all at once when unnecessary", () => {
    // A width just narrow enough to force dropping HED but not Subj/Modality.
    const results = [makeResult({ id: "nm000262", name: "Short name" })];
    const wide = planSearchColumns(results, 80);
    expect(wide.showHed).toBe(true);
    // Shrink until something drops; whichever drops first must be HED.
    let columns = 80;
    let plan = wide;
    while (plan.showHed && plan.showSubj && plan.showModality && columns > 10) {
      columns -= 1;
      plan = planSearchColumns(results, columns);
    }
    if (columns > 10) {
      expect(plan.showHed).toBe(false);
    }
  });

  test("(#1150 D7) a non-finite columns value falls back to SEARCH_DEFAULT_COLUMNS", () => {
    // A long id + long name so the 80-column default actually has to shrink
    // the name column by one to fit -- if a NaN/undefined `columns` were
    // NOT clamped to the default, the "greater than" width comparisons
    // would be false for every comparison against NaN (NaN is never > or <
    // anything), so no shrinking would happen at all and this fixture would
    // silently produce a DIFFERENT (wider, unshrunk) plan than the real
    // 80-column default. A short-name fixture wouldn't need any shrinking
    // at 80 columns either way, which would make this assertion pass
    // whether or not the clamp exists (testing.md's "smell that means the
    // test cannot fail").
    const results = [makeResult({ id: "on00376812345678901", name: "A".repeat(60) })];
    const nanPlan = planSearchColumns(results, Number.NaN);
    const defaultPlan = planSearchColumns(results, SEARCH_DEFAULT_COLUMNS);
    expect(defaultPlan.nameWidth).toBeLessThan(35); // sanity: the fixture DOES force a shrink
    expect(nanPlan).toEqual(defaultPlan);
  });

  test("(#1150 D7) a zero or negative columns value does not crash or produce a zero-width column", () => {
    const results = [makeResult()];
    expect(() => planSearchColumns(results, 0)).not.toThrow();
    expect(() => planSearchColumns(results, -50)).not.toThrow();
    const zeroPlan = planSearchColumns(results, 0);
    const negPlan = planSearchColumns(results, -50);
    expect(zeroPlan.idWidth).toBeGreaterThan(0);
    expect(zeroPlan.nameWidth).toBeGreaterThan(0);
    expect(negPlan.idWidth).toBeGreaterThan(0);
    expect(negPlan.nameWidth).toBeGreaterThan(0);
  });
});

describe("renderSearchResultLines (#1150 D4/D7)", () => {
  test("piped/non-TTY (columns undefined upstream, caller passes the 80 default) renders a full table", () => {
    const results = [makeResult()];
    const lines = renderSearchResultLines(results, SEARCH_DEFAULT_COLUMNS);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("ID");
    expect(lines[0]).toContain("Name");
  });

  test("the id is never truncated in the rendered header or row, at any width", () => {
    const longId = "on0037681234567890";
    const results = [makeResult({ id: longId, name: "x" })];
    for (const columns of [200, 80, 40, 20, 10]) {
      const lines = renderSearchResultLines(results, columns);
      const idLine = lines.find((line) => line.includes(longId));
      expect(idLine).toBeDefined();
    }
  });

  test("(#1150 D7) a non-finite columns value does not throw and still renders the table", () => {
    const results = [makeResult()];
    expect(() => renderSearchResultLines(results, Number.NaN)).not.toThrow();
    expect(() => renderSearchResultLines(results, 0)).not.toThrow();
    expect(() => renderSearchResultLines(results, -10)).not.toThrow();
    expect(renderSearchResultLines(results, 0).length).toBeGreaterThan(0);
  });

  test("(#1150 D7) a malformed row (non-string modalities) does not take down the rest of the table", () => {
    const goodResult = makeResult({ id: "nm000001", name: "Good Dataset" });
    const badResult = makeResult({
      id: "nm000002",
      name: "Bad Dataset",
      modalities: 12345 as unknown as string,
    });
    let lines: string[] = [];
    expect(() => {
      lines = renderSearchResultLines([goodResult, badResult], SEARCH_DEFAULT_COLUMNS);
    }).not.toThrow();
    expect(lines.some((line) => line.includes("nm000001"))).toBe(true);
    expect(lines.some((line) => line.includes("nm000002"))).toBe(true);
  });
});
