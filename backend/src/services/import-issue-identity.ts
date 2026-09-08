/**
 * Identity of an import-failure tracking issue: where it lives, the label that
 * marks it, and the title that doubles as its dedup key.
 *
 * Split out of `import-failure-issue.ts` in epic #1306 phase 2 purely to break a
 * cycle. `import-issue-accrual.ts` decides what to do with an existing issue and
 * therefore needs to recognise one; `import-failure-issue.ts` files them and
 * needs the accrual rules. Both depending on this leaf module keeps the
 * dependency one-directional, the same discipline `import-error.ts` follows.
 *
 * `import-failure-issue.ts` re-exports all three, so every existing import site
 * keeps working and there is still one obvious place to import them from.
 */

export const IMPORT_FAILURE_ISSUE_LABEL = "import-failure";

/** Central repo the failure-tracking issue template + triage doc live on
 *  (nemarDatasets/.github#83) -- same repo the onboard workflow itself is
 *  deployed to (github/dispatch.ts CENTRAL_WORKFLOW_REPO). */
export const IMPORT_FAILURE_ISSUES_REPO = "nemarDatasets/.github";

/** Deterministic per-dataset issue title -- doubles as the dedup key, and as the
 *  signature that tells a machine-filed issue from a hand-written one. */
export function importFailureIssueTitle(datasetId: string, sourceId: string): string {
  return `Import failure: ${datasetId} (${sourceId})`;
}
