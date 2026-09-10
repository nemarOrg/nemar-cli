/**
 * Do the failures and their tracking issues agree? (issue #1352, epic #1306)
 *
 * The epic gave every import failure a name (ADR 0051), a tracking issue that
 * drains (ADR 0052), a detector for silence (ADR 0053) and a weekly report
 * (ADR 0054). All four read ONE side of the correspondence and trust the other:
 * the triage sweep starts from the open issues and asks whether each dataset has
 * recovered; the weekly report counts issues by cause. Nothing asks whether the
 * two sides describe the same set.
 *
 * Two ways they can disagree, and they fail in opposite directions:
 *
 *   - **A row with no issue.** `import_jobs` says `failed` or `quarantined` and
 *     nothing on `nemarDatasets/.github` is tracking it. The dataset is broken and
 *     INVISIBLE: not in the sweep's candidate list, because that list comes from
 *     the issues, and not in the weekly report's cause counts, because those count
 *     issues. This is the direction that loses work silently.
 *   - **An issue with no row.** An open machine-filed issue whose dataset has no
 *     `import_jobs` row at all. ADR 0051's taxonomy already names this
 *     (`no_import_row`), which is evidence it happens. The sweep cannot answer it:
 *     with no row there is nothing to verify, so the issue is `keep`-ed forever.
 *     This direction accrues stale issues, which is what ADR 0052 exists to stop.
 *
 * ## Coverage is a looser test than ownership, on purpose
 *
 * `decideIssueAction` decides whether the automation may MUTATE an issue, and that
 * question demands an exact rebuilt-title match: a hand-written issue that merely
 * resembles the format must never be closed by a machine. Coverage is a different
 * question -- is a human going to see this? -- and there the strict test produces a
 * false positive nobody can act on: a person who filed their own issue about
 * on008065 would be told the dataset is untracked, and the only way to satisfy the
 * report would be to file a duplicate. So a row counts as covered by an exact
 * machine-filed title, by ANY open issue naming the dataset, or by an open rollup
 * for its cause. Ownership stays strict; visibility is what is being measured.
 *
 * ## Rollup mode is not a gap
 *
 * When ADR 0052's rollup is engaged, per-dataset issues are deliberately not filed.
 * A reconcile that did not know this would report nearly every failed row as an
 * orphan at exactly the moment the rollup is doing its job -- turning the mechanism
 * that prevents notification fatigue into the loudest source of it. An open rollup
 * whose cause matches the row therefore counts as coverage.
 */

import { type ImportFailureCause, classifyImportFailure } from "./import-failure-cause.js";
import { rollupIssueTitle } from "./import-issue-accrual.js";
import {
  IMPORT_FAILURE_ISSUE_LABEL,
  importFailureIssueTitle,
  parseImportFailureIssueTitle,
} from "./import-issue-identity.js";

/** Import statuses that mean "this needs a human and is not resolved". Deliberately
 *  NOT `rolled_back`: that orphan was cleaned up, which is the resolution, and
 *  counting it would make the report permanently non-empty on a set nobody intends
 *  to act on -- the fastest way to teach an operator to ignore it (ADR 0053's rule,
 *  reused). */
export const RECONCILE_UNRESOLVED_STATUSES = ["failed", "quarantined"] as const;

/** A `failed`/`quarantined` import with nothing tracking it. */
export interface ImportRowWithoutIssue {
  datasetId: string;
  sourceId: string;
  status: string;
  stage: string;
  /** Classified from `last_error`, so triage reads a cause rather than a row. */
  cause: ImportFailureCause;
  /** The label the issue WOULD carry, if one is filed for it. */
  label: string;
  updatedAt: string | null;
}

/** An open machine-filed issue whose dataset has no `import_jobs` row. */
export interface ImportIssueWithoutRow {
  number: number;
  datasetId: string;
  title: string;
}

export interface ImportReconcileVerdict {
  rowsWithoutIssue: ImportRowWithoutIssue[];
  issuesWithoutRow: ImportIssueWithoutRow[];
  /** Rows examined, so a zero verdict can be told from an empty input. */
  rowsExamined: number;
  /** Open issues examined, same reason. */
  issuesExamined: number;
  /** One line for a human, naming both directions. */
  reason: string;
}

/** The `import_jobs` shape this needs. A subset, so a test can build one by hand. */
export interface ReconcileJobRow {
  dataset_id: string;
  source_id: string;
  status: string;
  stage: string;
  last_error: string | null;
  updated_at: string | null;
}

/** The issue shape this needs, matching `listOpenIssuesByLabel`'s output. */
export interface ReconcileIssue {
  number: number;
  title: string;
  labels?: { name: string }[];
}

function labelNames(issue: ReconcileIssue): string[] {
  return (issue.labels ?? []).map((l) => l.name);
}

/**
 * Compare the two sides. Pure: every read happens in the caller.
 *
 * `openIssues` must be the FULL open set for `import-failure`, not a rotation
 * window. The sweep's window bounds how many issues it will act on per run; using
 * it here would report the rest of the fleet as untracked every day.
 */
export function decideReconcile(args: {
  rows: readonly ReconcileJobRow[];
  openIssues: readonly ReconcileIssue[];
}): ImportReconcileVerdict {
  const unresolved = args.rows.filter((r) =>
    (RECONCILE_UNRESOLVED_STATUSES as readonly string[]).includes(r.status),
  );

  // Every dataset id named by any open issue title, machine-filed or not.
  const namedByAnyIssue = new Set<string>();
  for (const issue of args.openIssues) {
    const parsed = parseImportFailureIssueTitle(issue.title);
    if (parsed) namedByAnyIssue.add(parsed);
    // A hand-written title mentioning the id counts as coverage too: see the note
    // at the top. Bounded to `on######`, so a stray six digits cannot match.
    for (const m of issue.title.matchAll(/\bon\d{6}\b/g)) namedByAnyIssue.add(m[0]);
  }

  // Open rollup titles, so a cause covered by a rollup is not reported per dataset.
  const openTitles = new Set(args.openIssues.map((i) => i.title));

  const rowsWithoutIssue: ImportRowWithoutIssue[] = [];
  for (const row of unresolved) {
    const classified = classifyImportFailure({ stage: row.stage, lastError: row.last_error });
    const exactTitle = importFailureIssueTitle(row.dataset_id, row.source_id);
    const covered =
      openTitles.has(exactTitle) ||
      namedByAnyIssue.has(row.dataset_id) ||
      // `cause`, NOT `label`: the filer builds the rollup title from
      // `classified.cause` (`auth_invalid`), while the LABEL is the hyphenated
      // `auth-invalid`. Passing the label here matched no rollup that exists, which
      // would have reported the whole fleet as untracked in rollup mode -- the exact
      // false-positive storm this coverage rule was added to prevent.
      openTitles.has(rollupIssueTitle(classified.cause));
    if (covered) continue;
    rowsWithoutIssue.push({
      datasetId: row.dataset_id,
      sourceId: row.source_id,
      status: row.status,
      stage: row.stage,
      cause: classified.cause,
      label: classified.label,
      updatedAt: row.updated_at,
    });
  }

  // The other direction. Machine-filed only: a human's issue about a dataset with
  // no import row is a legitimate thing for a human to have written, and telling
  // them it is inconsistent with a table they did not know about is noise.
  const rowIds = new Set(args.rows.map((r) => r.dataset_id));
  const issuesWithoutRow: ImportIssueWithoutRow[] = [];
  for (const issue of args.openIssues) {
    const datasetId = parseImportFailureIssueTitle(issue.title);
    if (!datasetId) continue;
    if (!labelNames(issue).includes(IMPORT_FAILURE_ISSUE_LABEL)) continue;
    if (rowIds.has(datasetId)) continue;
    issuesWithoutRow.push({ number: issue.number, datasetId, title: issue.title });
  }

  return {
    rowsWithoutIssue,
    issuesWithoutRow,
    rowsExamined: unresolved.length,
    issuesExamined: args.openIssues.length,
    reason: reconcileReason(rowsWithoutIssue.length, issuesWithoutRow.length, unresolved.length),
  };
}

function reconcileReason(rows: number, issues: number, examined: number): string {
  if (rows === 0 && issues === 0) {
    return `Failures and tracking issues agree (${examined} unresolved import row(s) examined).`;
  }
  const parts: string[] = [];
  if (rows > 0) {
    parts.push(
      `${rows} unresolved import(s) have no tracking issue, so nothing surfaces them to triage`,
    );
  }
  if (issues > 0) {
    parts.push(
      `${issues} open issue(s) have no import_jobs row, so the sweep can never verify or close them`,
    );
  }
  return `${parts.join("; ")}.`;
}

/** Truncation cap for the reported lists, matching the rest of the epic (ADR 0036):
 *  counts are exact, the ids are a sample, and the body says how many are hidden. */
export const RECONCILE_MAX_LISTED = 20;

/** The report block, appended to the triage run's output. Pure so the wording is
 *  testable without a sweep. */
export function buildReconcileReport(v: ImportReconcileVerdict): string[] {
  const lines: string[] = [];
  if (v.rowsWithoutIssue.length === 0 && v.issuesWithoutRow.length === 0) return lines;

  if (v.rowsWithoutIssue.length > 0) {
    lines.push(`Unresolved imports with no tracking issue (${v.rowsWithoutIssue.length}):`);
    for (const r of v.rowsWithoutIssue.slice(0, RECONCILE_MAX_LISTED)) {
      lines.push(`  ${r.datasetId} (${r.sourceId}) ${r.status} at ${r.stage} -- ${r.cause}`);
    }
    const hidden = v.rowsWithoutIssue.length - RECONCILE_MAX_LISTED;
    if (hidden > 0) lines.push(`  ... and ${hidden} more`);
  }
  if (v.issuesWithoutRow.length > 0) {
    lines.push(`Open issues with no import_jobs row (${v.issuesWithoutRow.length}):`);
    for (const i of v.issuesWithoutRow.slice(0, RECONCILE_MAX_LISTED)) {
      lines.push(`  #${i.number} ${i.datasetId}`);
    }
    const hidden = v.issuesWithoutRow.length - RECONCILE_MAX_LISTED;
    if (hidden > 0) lines.push(`  ... and ${hidden} more`);
  }
  return lines;
}
