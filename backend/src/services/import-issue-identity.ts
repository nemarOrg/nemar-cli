/**
 * Identity of the import tracking issues: where they live, the labels that mark
 * them, and the titles that double as their dedup keys.
 *
 * Split out of `import-failure-issue.ts` in epic #1306 phase 2 purely to break a
 * cycle. `import-issue-accrual.ts` decides what to do with an existing issue and
 * therefore needs to recognise one; `import-failure-issue.ts` files them and
 * needs the accrual rules. Both depending on this leaf module keeps the
 * dependency one-directional, the same discipline `import-error.ts` follows.
 *
 * `import-failure-issue.ts` re-exports the three the pre-split call sites used,
 * so every existing import keeps working. `parseImportFailureIssueTitle` arrived
 * with the split and has no legacy call site, so it is imported from here.
 *
 * Phase 3 (#1311) added the COVERAGE issue's identity alongside the failure
 * one. Two different questions, deliberately two different labels: a failure
 * issue says "this dataset broke", a coverage issue says "the pipeline as a
 * whole has stopped keeping up".
 *
 * They must never share a label. Not because the failure sweep would try to
 * verify the coverage issue as a dataset -- `planOneIssue` already refuses a
 * title it cannot parse -- but because the sweep's listing is keyed on
 * `import-failure`, so a shared label would put the coverage issue in
 * `perDataset`: it would inflate `openPerDatasetCount`, which is what drives
 * `decideIssueMode`'s rollup cap, and consume a slot in the rotation window.
 */

export const IMPORT_FAILURE_ISSUE_LABEL = "import-failure";

/** Central repo the failure-tracking issue template + triage doc live on (added
 *  by nemarDatasets/.github PR #83) -- same repo the onboard workflow itself is
 *  deployed to (github/dispatch.ts CENTRAL_WORKFLOW_REPO). */
export const IMPORT_FAILURE_ISSUES_REPO = "nemarDatasets/.github";

/** Deterministic per-dataset issue title -- doubles as the dedup key, and as the
 *  signature that tells a machine-filed issue from a hand-written one. */
export function importFailureIssueTitle(datasetId: string, sourceId: string): string {
  return `Import failure: ${datasetId} (${sourceId})`;
}

/**
 * Best-effort inverse: the dataset id an issue title appears to be about.
 *
 * Only ever used to FIND the candidate `import_jobs` row to check. It is
 * deliberately not the authority on whether an issue is machine-filed -- that
 * decision rebuilds the title from the D1 row via
 * {@link importFailureIssueTitle} and compares, so a hand-written title that
 * merely resembles the format cannot pass by parsing alone.
 */
export function parseImportFailureIssueTitle(title: string): string | null {
  const match = /^Import failure: (on\d{6}) \(ds\d{6}\)$/.exec(title);
  return match?.[1] ?? null;
}

// ============================================================================
// Coverage issue (epic #1306 phase 3, #1311)
// ============================================================================

/** Marks the ONE standing import-coverage issue. Deliberately not
 *  `import-failure`: see the note at the top of this file. */
export const IMPORT_COVERAGE_ISSUE_LABEL = "import-coverage";

/**
 * The coverage issue's title, and therefore its dedup key.
 *
 * Takes no arguments ON PURPOSE. There is exactly one coverage issue at a time
 * -- coverage is a property of the pipeline, not of a dataset -- so the title
 * must be constant across runs or the dedup lookup would miss the issue it
 * opened yesterday and file a second one every day. Everything that varies (the
 * counts, the verdict, the timestamp) lives in the body, which is rewritten in
 * place.
 */
export function importCoverageIssueTitle(): string {
  return "Import coverage: backlog or dispatch silence";
}

/**
 * Labels naming WHICH coverage problem is live, so the current kind is readable
 * off the issue instead of stored anywhere.
 *
 * Same discipline as `decideIssueMode`'s `rollupOpen` in phase 2: the state is an
 * observation of a document that exists, not a flag that can drift. It is what
 * lets the sweep comment only when the kind CHANGES rather than once per day.
 */
export const IMPORT_COVERAGE_KIND_LABELS = {
  backlog: "coverage-backlog",
  silence: "coverage-silence",
  disabled: "coverage-disabled",
  "dispatch-lost": "coverage-dispatch-lost",
} as const;

// ============================================================================
// Weekly summary issue (epic #1306 phase 4, #1312)
// ============================================================================

/**
 * Marks a weekly summary issue.
 *
 * A third label, not a reuse of either existing one, for the reason spelled out at
 * the top of this file: the phase 2 sweep lists by `import-failure`, so a shared
 * label would put a foreign issue into `perDataset` and inflate the count that
 * drives the rollup cap. `import-coverage` is likewise the coverage sweep's own
 * listing key.
 */
export const IMPORT_WEEKLY_ISSUE_LABEL = "import-weekly";

/**
 * The weekly summary's title, and therefore its dedup key.
 *
 * Takes the ISO week, which is what gives this series ONE ISSUE PER WEEK -- the
 * opposite cardinality from the coverage issue's no-argument constant title, and
 * from the per-dataset title's two arguments. Arity is the cardinality in this
 * module.
 *
 * The week label is zero-padded (`2026-W07`, not `2026-W7`) so the series sorts
 * lexicographically in chronological order, which is what lets the rollover find
 * last week's issue without trusting issue numbers.
 */
export function importWeeklySummaryIssueTitle(week: string): string {
  return `Import weekly summary: ${week}`;
}

/**
 * The week a weekly-summary title is for, or null if it is not one.
 *
 * Used to find the previous week's issue for the rollover. Like
 * {@link parseImportFailureIssueTitle}, it is deliberately not the authority on
 * whether an issue is machine-filed -- the anchored pattern makes a hand-written
 * lookalike unlikely, but the filing path compares against a rebuilt title rather
 * than trusting a parse.
 */
export function parseWeeklySummaryIssueTitle(title: string): string | null {
  const match = /^Import weekly summary: (\d{4}-W\d{2})$/.exec(title);
  return match?.[1] ?? null;
}
