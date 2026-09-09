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
 * `import-failure-issue.ts` re-exports the three the pre-split call sites used,
 * so every existing import keeps working. `parseImportFailureIssueTitle` arrived
 * with the split and has no legacy call site, so it is imported from here.
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
