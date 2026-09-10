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
 *   - **A failure with no issue.** `import_jobs` says `failed` and nothing on
 *     `nemarDatasets/.github` names it. It is outside the sweep's candidate list, so
 *     nothing will ever verify or close it, and it appears in the weekly counts only
 *     as an anonymous increment. This is the direction that loses work.
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

/**
 * The one status whose absence of an issue is a real gap: `failed`.
 *
 * `shouldFileImportFailureIssue` requires `resultingStatus === "failed"`, so `failed`
 * is the only status the filer ever acts on -- which makes "failed with no issue" a
 * statement about a mechanism that should have fired and did not.
 *
 * The others are deliberately NOT gaps:
 *
 *   - `quarantined` has its OWN channel. Recovery emails an admin, writes an
 *     `import_quarantined` audit row, and the row is listable at
 *     `GET /admin/imports?status=quarantined`. Worse, most quarantine reasons
 *     (`has_doi`, `made_public`, `reached_complete`, `system_owned`, ...) are excluded
 *     from the retry candidate set forever, so no machine action could ever clear the
 *     entry: it would be a permanent line item saying "nothing surfaces this" about
 *     something three things surface. Counted as {@link ImportReconcileVerdict.quarantined}.
 *   - `incomplete` is the retry engine's, by the same argument the weekly report's
 *     `OPEN_FAILURES_QUERY` uses when it lists it and this does not: a row in the
 *     retry lane has an owner and a next attempt.
 *   - `rolled_back` is the resolution, not a problem. Counting it would make the
 *     report permanently non-empty on a set nobody intends to act on, which is how an
 *     operator learns to ignore a report (ADR 0053's rule, reused).
 */
export const RECONCILE_GAP_STATUS = "failed";

/** Statuses examined, so the denominator covers what was looked at rather than only
 *  what was reported. */
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
  /**
   * Unresolved rows the retry engine has parked, and which are therefore NOT
   * reported as untracked.
   *
   * They are already surfaced: the weekly report lists every `blocklisted = 1` row
   * in its parked section with the reason and how long it has been there
   * (`PARKED_QUERY`, ADR 0054). Calling them "untracked, so nothing surfaces them to
   * triage" would be a false statement about a set that IS reported, and the same
   * rule ADR 0053 applies when it keeps blocklisted datasets out of its backlog.
   * Counted rather than dropped, so a reader can see why a number is smaller than
   * the raw failure count.
   */
  parked: number;
  /**
   * Unresolved rows in `quarantined`, reported as a count and never as a gap.
   *
   * They have their own channel -- the admin quarantine email, the
   * `import_quarantined` audit row, `GET /admin/imports?status=quarantined` -- and
   * most quarantine reasons can never re-enter the retry lane, so listing them here
   * would be a permanent line item claiming nothing surfaces them.
   */
  quarantined: number;
  /** Rows examined, so a zero verdict can be told from an empty input. */
  rowsExamined: number;
  /** Open issues examined, same reason. */
  issuesExamined: number;
  /**
   * True when there were failures to check but the issue list came back EMPTY.
   *
   * `listOpenIssuesByLabel` throws on any non-2xx and refuses a truncated set, so
   * this is not a swallowed transport error -- but a renamed or deleted label yields
   * a legitimate 200 with no issues, and then every failure looks untracked at once.
   * The sweep's own "listed issues but none had labels" guard cannot see it either,
   * because it only fires when the list is non-empty. Reported so a reader suspects
   * the label before they suspect the fleet.
   */
  issueListEmpty: boolean;
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
  /** 1 when the retry engine has parked this row. Load-bearing: see `parked` below. */
  blocklisted: number | null;
}

/** The issue shape this needs, matching `listOpenIssuesByLabel`'s output. */
export interface ReconcileIssue {
  number: number;
  title: string;
  labels?: { name: string }[];
  /** Optional, and load-bearing when present: a rollup lists its datasets in the
   *  body, so scanning it is what makes rollup coverage independent of the row's
   *  CURRENT classification. See the note in `decideReconcile`. */
  body?: string | null;
}

/** The label a human applies once they have confirmed an issue has no import row.
 *  Preserved by `decideIssueAction`, so it is a durable "already triaged" marker. */
export const NO_IMPORT_ROW_LABEL = "no-import-row";

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
    // And the BODY, which is how a rollup names its datasets.
    //
    // Without this, rollup coverage depended on the row's CURRENT cause matching the
    // rollup's title -- and the cause is re-derived from `last_error` on every run, so
    // a new classifier rule shipped in a deploy could move a row to a cause whose
    // rollup is not open and report it untracked while it sits listed in the old
    // rollup. Reading the body makes coverage a fact about what is written down rather
    // than about today's classification.
    for (const m of (issue.body ?? "").matchAll(/\bon\d{6}\b/g)) namedByAnyIssue.add(m[0]);
  }

  // Open rollup titles, so a cause covered by a rollup is not reported per dataset.
  const openTitles = new Set(args.openIssues.map((i) => i.title));

  const rowsWithoutIssue: ImportRowWithoutIssue[] = [];
  let parked = 0;
  let quarantined = 0;
  for (const row of unresolved) {
    // Parked by the retry engine: reported by the weekly summary already. See the
    // note on `parked`.
    if (row.blocklisted === 1) {
      parked++;
      continue;
    }
    // Quarantined: its own channel, and mostly unclearable. See RECONCILE_GAP_STATUS.
    if (row.status !== RECONCILE_GAP_STATUS) {
      quarantined++;
      continue;
    }
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
    const labels = labelNames(issue);
    if (!labels.includes(IMPORT_FAILURE_ISSUE_LABEL)) continue;
    if (rowIds.has(datasetId)) continue;
    // Already triaged. `no-import-row` is a label a HUMAN applies from exactly this
    // finding, and `decideIssueAction` deliberately preserves it. Re-reporting it
    // every day would make the list mean "rows are missing" rather than "rows are
    // missing and nobody has looked yet" -- and the second is the actionable one.
    if (labels.includes(NO_IMPORT_ROW_LABEL)) continue;
    issuesWithoutRow.push({ number: issue.number, datasetId, title: issue.title });
  }

  return {
    rowsWithoutIssue,
    issuesWithoutRow,
    parked,
    quarantined,
    issueListEmpty: args.openIssues.length === 0 && unresolved.length > 0,
    rowsExamined: unresolved.length,
    issuesExamined: args.openIssues.length,
    reason: reconcileReason({
      rows: rowsWithoutIssue.length,
      issues: issuesWithoutRow.length,
      examined: unresolved.length,
      parked,
      quarantined,
      issuesExamined: args.openIssues.length,
      issueListEmpty: args.openIssues.length === 0 && unresolved.length > 0,
    }),
  };
}

function reconcileReason(args: {
  rows: number;
  issues: number;
  examined: number;
  parked: number;
  quarantined: number;
  issuesExamined: number;
  issueListEmpty: boolean;
}): string {
  const aside: string[] = [];
  if (args.parked > 0) aside.push(`${args.parked} parked by the retry engine`);
  if (args.quarantined > 0) aside.push(`${args.quarantined} quarantined`);
  const asideNote = aside.length === 0 ? "" : `, ${aside.join(" and ")} and reported elsewhere`;

  // An ANNOTATION, not a replacement. The first version returned early here, which
  // meant that whenever there were failures and no open issues -- which IS the gap,
  // in its largest form -- the report talked about the label instead of about the
  // untracked rows. The label is a hypothesis; the disagreement is the finding.
  const emptyNote = args.issueListEmpty
    ? " No open import-failure issues were found AT ALL, so check the label before the fleet: a renamed or deleted label returns an empty list without an error."
    : "";

  if (args.rows === 0 && args.issues === 0) {
    return `Failures and tracking issues agree (${args.examined} unresolved import row(s) and ${args.issuesExamined} open issue(s) examined${asideNote}).`;
  }
  const parts: string[] = [];
  if (args.rows > 0) {
    parts.push(
      `${args.rows} failed import(s) have no tracking issue, so the triage sweep will never reach them`,
    );
  }
  if (args.issues > 0) {
    parts.push(
      `${args.issues} open issue(s) have no import_jobs row, so the sweep can never verify or close them`,
    );
  }
  return `${parts.join("; ")}${asideNote}.${emptyNote}`;
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
