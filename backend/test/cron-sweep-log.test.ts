/**
 * Tests for sweepLogLines (issue #1166, #1167 review finding).
 *
 * These exist because the logic they cover previously had NONE. It lived
 * inline in `scheduled()`'s `.then()` callbacks, and no test in this repo
 * invokes the Worker `scheduled()` handler, so deleting the `if (!r) return`
 * guard from a call site left the entire backend suite green. Pulling the
 * decision into a pure function is what made it reachable.
 *
 * No DB and no console here on purpose: the function returns the lines and the
 * caller prints them, so these assert on values rather than on captured output.
 */

import { describe, expect, test } from "bun:test";
import { type SweepOutcome, sweepLogLines } from "../src/services/cron-sweep-log";

const summary = (r: SweepOutcome) => `processed=${r.processed}`;

describe("sweepLogLines: a skipped run says nothing", () => {
  test("null yields no info line and no errors", () => {
    // The regression this file exists for. A wrapper returns null when its
    // isNonProductionEnv guard skips the run; it already logged that.
    expect(sweepLogLines("x-sweep", null, summary)).toEqual({ info: null, errors: [] });
  });

  test("null is handled before any field is read", () => {
    // Proves the guard is a null CHECK, not a lucky property access. If the
    // implementation reached for `.processed` first it would throw here rather
    // than return, which is exactly the failure the guard prevents: the
    // caller's chained .catch() would report a routine skip as
    // "sweep failed: TypeError".
    const summaryThatMustNotRun = () => {
      throw new Error("summary builder must not run for a skipped sweep");
    };
    expect(() => sweepLogLines("x-sweep", null, summaryThatMustNotRun)).not.toThrow();
  });
});

describe("sweepLogLines: a real result", () => {
  const base: SweepOutcome = { processed: 0, remaining: null, errors: [] };

  test("an all-zero result is NOT an info line, and is not the same as a skip", () => {
    // The distinction the null return exists to preserve: "ran, nothing to do"
    // and "did not run" both stay quiet, but only the latter suppresses errors
    // too, and only the former can carry any.
    expect(sweepLogLines("x-sweep", base, summary).info).toBeNull();
  });

  test("processed > 0 produces the caller's summary verbatim", () => {
    const r = { ...base, processed: 3 };
    expect(sweepLogLines("x-sweep", r, summary).info).toBe("processed=3");
  });

  test("remaining > 0 alone produces a summary, so a stalled batch is visible", () => {
    // processed=0 with work still queued means the batch made no progress --
    // the case most worth seeing in the logs.
    const r = { ...base, remaining: 12 };
    expect(sweepLogLines("x-sweep", r, summary).info).toBe("processed=0");
  });

  test("remaining null is not treated as remaining > 0", () => {
    // `remaining` is null when its count query failed, which is not evidence
    // of pending work.
    expect(sweepLogLines("x-sweep", { ...base, remaining: null }, summary).info).toBeNull();
  });

  test("per-dataset errors are reported even when nothing was processed", () => {
    // A batch that failed every candidate has processed=0, so gating errors on
    // the summary condition would silence exactly the run worth hearing about.
    const r: SweepOutcome = {
      processed: 0,
      remaining: null,
      errors: [
        { dataset_id: "nm000111", error: "boom" },
        { dataset_id: "*", error: "auth failed" },
      ],
    };
    const lines = sweepLogLines("x-sweep", r, summary);
    expect(lines.info).toBeNull();
    expect(lines.errors).toEqual([
      "[x-sweep] nm000111: boom",
      "[x-sweep] *: auth failed",
    ]);
  });

  test("the label prefixes every error line", () => {
    const r: SweepOutcome = {
      processed: 1,
      remaining: 0,
      errors: [{ dataset_id: "nm000222", error: "e" }],
    };
    expect(sweepLogLines("other-sweep", r, summary).errors).toEqual(["[other-sweep] nm000222: e"]);
  });
});
