/**
 * The reconcile's rules (issue #1352, epic #1306): do the failures and the
 * tracking issues describe the same set?
 *
 * Pure, so every branch is reachable without a sweep. The cases that matter most are
 * the two ways this could be WRONG rather than merely incomplete:
 *
 *   - reporting a row as untracked when a rollup or a human is already covering it,
 *     which turns ADR 0052's flood control into the flood, and
 *   - reporting nothing when it could not look, which is ADR 0054's founding
 *     confusion one level down.
 */

import { describe, expect, test } from "bun:test";
import { IMPORT_ROLLUP_ISSUE_LABEL, rollupIssueTitle } from "../src/services/import-issue-accrual";
import {
  IMPORT_FAILURE_ISSUE_LABEL,
  importFailureIssueTitle,
} from "../src/services/import-issue-identity";
import {
  RECONCILE_MAX_LISTED,
  type ReconcileIssue,
  type ReconcileJobRow,
  buildReconcileReport,
  decideReconcile,
} from "../src/services/import-reconcile";

function row(over: Partial<ReconcileJobRow> = {}): ReconcileJobRow {
  return {
    dataset_id: "on008065",
    source_id: "ds008065",
    status: "failed",
    stage: "prepare",
    last_error: "Failed to clone: fatal: Authentication failed for https://github.com/x",
    updated_at: "2026-09-01 03:00:00",
    blocklisted: 0,
    ...over,
  };
}

function machineIssue(number: number, datasetId: string, sourceId: string): ReconcileIssue {
  return {
    number,
    title: importFailureIssueTitle(datasetId, sourceId),
    labels: [{ name: IMPORT_FAILURE_ISSUE_LABEL }],
  };
}

describe("a failure with nothing tracking it is reported", () => {
  test("an unresolved row with no issue at all", async () => {
    const v = decideReconcile({ rows: [row()], openIssues: [] });
    expect(v.rowsWithoutIssue).toHaveLength(1);
    expect(v.rowsWithoutIssue[0]?.datasetId).toBe("on008065");
    // Classified, so triage reads a cause rather than a table row.
    expect(v.rowsWithoutIssue[0]?.cause).toBe("auth_invalid");
    expect(v.reason).toContain("no tracking issue");
  });

  test("quarantined counts, rolled_back does not", () => {
    // `rolled_back` IS the resolution -- the orphan was cleaned up. Counting it
    // would make the report permanently non-empty on a set nobody intends to act
    // on, which is how an operator learns to ignore it.
    const v = decideReconcile({
      rows: [
        row({ dataset_id: "on000001", source_id: "ds000001", status: "quarantined" }),
        row({ dataset_id: "on000002", source_id: "ds000002", status: "rolled_back" }),
        row({ dataset_id: "on000003", source_id: "ds000003", status: "complete" }),
        row({ dataset_id: "on000004", source_id: "ds000004", status: "copying" }),
      ],
      openIssues: [],
    });
    expect(v.rowsWithoutIssue.map((r) => r.datasetId)).toEqual(["on000001"]);
    expect(v.rowsExamined).toBe(1);
  });

  test("the exact machine-filed issue counts as coverage", () => {
    const v = decideReconcile({
      rows: [row()],
      openIssues: [machineIssue(10, "on008065", "ds008065")],
    });
    expect(v.rowsWithoutIssue).toEqual([]);
    expect(v.reason).toContain("agree");
  });
});

describe("coverage is looser than ownership, deliberately", () => {
  /**
   * `decideIssueAction` demands an exact rebuilt title before MUTATING an issue, and
   * that strictness is right there. Here the question is whether a human will see
   * the failure, and the strict test produces a false positive nobody can act on:
   * the only way to satisfy it would be to file a duplicate of the issue you already
   * wrote.
   */
  test("a hand-written issue naming the dataset counts as coverage", () => {
    const human: ReconcileIssue = {
      number: 42,
      title: "on008065 keeps failing on re-import, needs a look",
      labels: [],
    };
    const v = decideReconcile({ rows: [row()], openIssues: [human] });
    expect(v.rowsWithoutIssue).toEqual([]);
  });

  test("but a hand-written issue is never reported as an issue-without-row", () => {
    // The other direction stays strict: telling someone their own issue is
    // inconsistent with a table they have never heard of is noise, not a finding.
    const human: ReconcileIssue = { number: 42, title: "on999999 something", labels: [] };
    const v = decideReconcile({ rows: [], openIssues: [human] });
    expect(v.issuesWithoutRow).toEqual([]);
  });

  test("a six-digit number that is not an on-id does not count", () => {
    const notAnId: ReconcileIssue = { number: 42, title: "flaky since 008065, see run 1234567" };
    const v = decideReconcile({ rows: [row()], openIssues: [notAnId] });
    expect(v.rowsWithoutIssue).toHaveLength(1);
  });
});

describe("rollup mode is not a gap", () => {
  /**
   * THE false positive to avoid. In rollup mode ADR 0052 deliberately stops filing
   * per-dataset issues, so a reconcile that did not know this would report nearly
   * every failed row as untracked at exactly the moment the rollup is working --
   * turning the mechanism that prevents notification fatigue into its largest
   * source.
   */
  test("an open rollup for the row's cause covers it", () => {
    const rollup: ReconcileIssue = {
      number: 900,
      // Built from the CAUSE (`auth_invalid`), which is what the filer uses -- not
      // the hyphenated LABEL. Getting that backwards matched no rollup that exists.
      title: rollupIssueTitle("auth_invalid"),
      labels: [{ name: IMPORT_FAILURE_ISSUE_LABEL }, { name: IMPORT_ROLLUP_ISSUE_LABEL }],
    };
    const v = decideReconcile({
      rows: [
        row({ dataset_id: "on000001", source_id: "ds000001" }),
        row({ dataset_id: "on000002", source_id: "ds000002" }),
      ],
      openIssues: [rollup],
    });
    expect(v.rowsWithoutIssue).toEqual([]);
  });

  test("a rollup for a DIFFERENT cause does not cover this row", () => {
    const rollup: ReconcileIssue = {
      number: 900,
      title: rollupIssueTitle("timeout"),
      labels: [{ name: IMPORT_FAILURE_ISSUE_LABEL }, { name: IMPORT_ROLLUP_ISSUE_LABEL }],
    };
    const v = decideReconcile({ rows: [row()], openIssues: [rollup] });
    expect(v.rowsWithoutIssue).toHaveLength(1);
    expect(v.rowsWithoutIssue[0]?.cause).toBe("auth_invalid");
  });

  test("an unclassifiable row is covered by the unknown rollup, not by any other", () => {
    // A roll-up message classifies as `unknown`, and `unknown` has its own rollup
    // title like any other cause.
    const unresolvable = row({ last_error: "terminal: prepare=failure copy=failure" });
    const unknownRollup: ReconcileIssue = {
      number: 901,
      title: rollupIssueTitle("unknown"),
      labels: [{ name: IMPORT_FAILURE_ISSUE_LABEL }, { name: IMPORT_ROLLUP_ISSUE_LABEL }],
    };
    expect(decideReconcile({ rows: [unresolvable], openIssues: [] }).rowsWithoutIssue).toHaveLength(
      1,
    );
    expect(
      decideReconcile({ rows: [unresolvable], openIssues: [unknownRollup] }).rowsWithoutIssue,
    ).toEqual([]);
  });
});

describe("a row the retry engine has parked is not untracked", () => {
  /**
   * It is already reported: the weekly summary lists every `blocklisted = 1` row in
   * its parked section with the reason and the duration (ADR 0054). Calling it
   * "untracked, so nothing surfaces it to triage" would be false about a set that IS
   * surfaced -- and it is the same rule ADR 0053 applies when it keeps blocklisted
   * datasets out of its backlog, for the same reason: an alarm that is permanent on a
   * set nobody intends to act on gets muted, and then the real one is muted too.
   */
  test("a blocklisted failure is counted as parked, not reported", () => {
    const v = decideReconcile({
      rows: [
        row({ dataset_id: "on004148", source_id: "ds004148", blocklisted: 1 }),
        row({ dataset_id: "on000777", source_id: "ds000777", blocklisted: 0 }),
      ],
      openIssues: [],
    });
    expect(v.rowsWithoutIssue.map((r) => r.datasetId)).toEqual(["on000777"]);
    expect(v.parked).toBe(1);
    // Both still counted as examined, so the arithmetic is explainable.
    expect(v.rowsExamined).toBe(2);
  });

  test("the reason says how many were parked, so a smaller number is explainable", () => {
    const v = decideReconcile({
      rows: [row({ blocklisted: 1 })],
      openIssues: [],
    });
    expect(v.rowsWithoutIssue).toEqual([]);
    expect(v.reason).toContain("1 parked by the retry engine and reported weekly");
  });

  test("a null blocklisted column is treated as not parked", () => {
    // The column is nullable in older rows; the safe reading is "not parked", which
    // reports rather than hides.
    const v = decideReconcile({ rows: [row({ blocklisted: null })], openIssues: [] });
    expect(v.rowsWithoutIssue).toHaveLength(1);
    expect(v.parked).toBe(0);
  });
});

describe("an issue whose dataset has no import row", () => {
  test("is reported, with its number", () => {
    const v = decideReconcile({
      rows: [],
      openIssues: [machineIssue(77, "on004148", "ds004148")],
    });
    expect(v.issuesWithoutRow).toEqual([
      { number: 77, datasetId: "on004148", title: "Import failure: on004148 (ds004148)" },
    ]);
    expect(v.reason).toContain("can never verify or close them");
  });

  test("a row in ANY status counts as the row existing", () => {
    // The question is whether a row exists at all, not what it says. A `complete`
    // row means the sweep can verify and close the issue; that is its job, not this
    // one's.
    for (const status of ["complete", "failed", "rolled_back", "copying"]) {
      const v = decideReconcile({
        rows: [row({ dataset_id: "on004148", source_id: "ds004148", status })],
        openIssues: [machineIssue(77, "on004148", "ds004148")],
      });
      expect(v.issuesWithoutRow).toEqual([]);
    }
  });

  test("a rollup issue is never reported as missing a row", () => {
    // It is not about one dataset, so the question does not apply.
    const rollup: ReconcileIssue = {
      number: 900,
      title: rollupIssueTitle("auth_invalid"),
      labels: [{ name: IMPORT_FAILURE_ISSUE_LABEL }, { name: IMPORT_ROLLUP_ISSUE_LABEL }],
    };
    expect(decideReconcile({ rows: [], openIssues: [rollup] }).issuesWithoutRow).toEqual([]);
  });

  test("a machine-shaped title without the label is not machine-filed", () => {
    // The label is half the identity. A title alone can be typed by anyone.
    const impostor: ReconcileIssue = {
      number: 5,
      title: importFailureIssueTitle("on004148", "ds004148"),
      labels: [],
    };
    expect(decideReconcile({ rows: [], openIssues: [impostor] }).issuesWithoutRow).toEqual([]);
  });
});

describe("both directions at once, and the counts", () => {
  test("a disagreement in each direction is reported independently", () => {
    const v = decideReconcile({
      rows: [row({ dataset_id: "on000001", source_id: "ds000001" })],
      openIssues: [machineIssue(77, "on004148", "ds004148")],
    });
    expect(v.rowsWithoutIssue.map((r) => r.datasetId)).toEqual(["on000001"]);
    expect(v.issuesWithoutRow.map((i) => i.datasetId)).toEqual(["on004148"]);
    expect(v.reason).toContain("no tracking issue");
    expect(v.reason).toContain("no import_jobs row");
  });

  test("examined counts distinguish an agreement from an empty input", () => {
    // "They agree" over zero rows and "they agree" over 40 rows are different
    // statements, and an operator reading a clean report needs to know which.
    const empty = decideReconcile({ rows: [], openIssues: [] });
    expect(empty.rowsExamined).toBe(0);
    expect(empty.issuesExamined).toBe(0);
    const covered = decideReconcile({
      rows: [row()],
      openIssues: [machineIssue(10, "on008065", "ds008065")],
    });
    expect(covered.rowsExamined).toBe(1);
    expect(covered.issuesExamined).toBe(1);
    expect(covered.rowsWithoutIssue).toEqual([]);
  });
});

describe("the report block", () => {
  test("is empty when the two sides agree, so a clean run adds nothing", () => {
    expect(buildReconcileReport(decideReconcile({ rows: [], openIssues: [] }))).toEqual([]);
  });

  test("names the cause per row, so the list is actionable", () => {
    const lines = buildReconcileReport(decideReconcile({ rows: [row()], openIssues: [] }));
    expect(lines.join("\n")).toContain("on008065 (ds008065) failed at prepare -- auth_invalid");
  });

  test("truncates with a count of what is hidden", () => {
    // ADR 0036: exact counts, a sample of ids, and never a silent stop.
    const many = Array.from({ length: RECONCILE_MAX_LISTED + 3 }, (_, i) =>
      row({
        dataset_id: `on${String(i).padStart(6, "0")}`,
        source_id: `ds${String(i).padStart(6, "0")}`,
      }),
    );
    const lines = buildReconcileReport(decideReconcile({ rows: many, openIssues: [] }));
    expect(lines[0]).toContain(`(${RECONCILE_MAX_LISTED + 3})`);
    expect(lines.join("\n")).toContain("... and 3 more");
  });
});
