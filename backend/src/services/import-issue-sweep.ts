/**
 * Triage sweep for import-failure tracking issues (epic #1306, issue #1310).
 *
 * Walks the open `import-failure` issues on `nemarDatasets/.github`, verifies
 * each one's dataset against S3, and closes the recovered ones / relabels the
 * ones whose cause has changed. Dry run by default.
 *
 * ## Why a sweep, and not a hook on the success callback
 *
 * `POST /webhooks/import-state` has no post-success action at all today -- its
 * only side-effect block is gated on `status === "failed"`. A `complete` hook
 * would be the responsive option, but it would only ever catch recoveries that
 * pass through that webhook. A manual `nemar admin recover`, an operator's
 * forced verify, and every one of the 28 issues that accumulated before this
 * existed would all be missed. One sweep covers all of them through one tested
 * path, and keeps GitHub I/O off a webhook route that already carries two
 * `waitUntil` calls. The cost is up to a day's latency before a healed issue
 * closes, which does not matter for a tracker.
 *
 * ## Fail-open on the row, never on the verdict
 *
 * Mirrors `zarr-fidelity-sweep`: a transient S3, D1 or GitHub error aborts THAT
 * issue only. It lands in `errors`, the issue is left exactly as it was, and it
 * is still a candidate next run. The failure mode this protects against is
 * closing an issue for a dataset that is actually still broken, which would
 * discard a live problem silently -- so every uncertainty resolves to "keep".
 *
 * ## Bounds
 *
 * `verifyDatasetVersionS3` does one fully-paginated `listObjectSizes` walk per
 * dataset, i.e. O(pages) Worker subrequests. The existing `data-integrity-sweep`
 * bounds itself to 15 per request (max 30) for exactly that reason and this uses
 * the same numbers. A backlog therefore drains over several runs, which is fine.
 */

import type { Bindings } from "../types/bindings.js";
import { getDatasetsToken } from "./github-auth.js";
import {
  type GitHubIssue,
  addIssueComment,
  closeIssue,
  issueLabelNames,
  listOpenIssuesByLabel,
  setIssueLabels,
} from "./github.js";
import { classifyImportFailure } from "./import-failure-cause.js";
import { type DatasetVersionIntegrityResult, verifyDatasetVersionS3 } from "./import-integrity.js";
import {
  IMPORT_ROLLUP_ISSUE_LABEL,
  type ImportIssueAction,
  type ImportIssueMode,
  type IssueVerifyState,
  buildRecoveryCloseComment,
  buildRelabelComment,
  decideIssueAction,
  decideIssueMode,
} from "./import-issue-accrual.js";
import {
  IMPORT_FAILURE_ISSUES_REPO,
  IMPORT_FAILURE_ISSUE_LABEL,
  importFailureIssueTitle,
  parseImportFailureIssueTitle,
} from "./import-issue-identity.js";

export const IMPORT_ISSUE_SWEEP_DEFAULT_LIMIT = 15;
export const IMPORT_ISSUE_SWEEP_MAX_LIMIT = 30;

export interface ImportIssueSweepPlanEntry {
  issueNumber: number;
  datasetId: string | null;
  title: string;
  kind: ImportIssueAction["kind"];
  reason: string;
  labels?: string[];
  /** The verdict this entry was decided from, carried so the comment written on
   *  apply quotes the REAL numbers rather than restating the summary line. */
  verify?: IssueVerifyState;
  /** The classified cause's one-line explanation, for the relabel comment. */
  causeSummary?: string;
}

export interface ImportIssueSweepResult {
  /** False on a dry run: nothing was written to GitHub. */
  applied: boolean;
  /** Open per-dataset issues seen (excludes rollups). */
  openIssues: number;
  /** Filing mode implied by that count -- what NEW failures would do. */
  mode: ImportIssueMode;
  examined: number;
  closed: number;
  relabelled: number;
  kept: number;
  plan: ImportIssueSweepPlanEntry[];
  errors: { issue: number; dataset_id: string | null; error: string }[];
  /** Candidates left unexamined because the limit was reached. */
  remaining: number;
}

/**
 * Injection seams for tests. Every real caller omits them.
 *
 * These replace TRANSPORT only -- the GitHub client calls and the S3 verify.
 * The decisions, the SQL and the content builders all run for real, so a test
 * exercises the same code production does (`.rules/testing.md`).
 */
export interface ImportIssueSweepDeps {
  listOpenIssues?: typeof listOpenIssuesByLabel;
  close?: typeof closeIssue;
  setLabels?: typeof setIssueLabels;
  comment?: typeof addIssueComment;
  verify?: (env: Bindings, datasetId: string) => Promise<DatasetVersionIntegrityResult>;
  token?: (env: Bindings) => Promise<string>;
}

/** The `import_jobs` fields the sweep needs to judge one issue. */
interface ImportJobRow {
  source_id: string;
  stage: string;
  last_error: string | null;
}

export async function runImportIssueSweep(
  env: Bindings,
  opts: { limit?: number; apply?: boolean } = {},
  deps: ImportIssueSweepDeps = {},
): Promise<ImportIssueSweepResult> {
  const listOpenIssues = deps.listOpenIssues ?? listOpenIssuesByLabel;
  const close = deps.close ?? closeIssue;
  const setLabels = deps.setLabels ?? setIssueLabels;
  const comment = deps.comment ?? addIssueComment;
  const verify = deps.verify ?? verifyDatasetVersionS3;
  const token = deps.token ?? getDatasetsToken;

  const apply = opts.apply === true;
  const limit = Math.min(
    Math.max(opts.limit ?? IMPORT_ISSUE_SWEEP_DEFAULT_LIMIT, 1),
    IMPORT_ISSUE_SWEEP_MAX_LIMIT,
  );

  const pat = await token(env);

  // A listing failure is fatal to the whole run, not to one row: without it
  // there is nothing to iterate and no honest count to report.
  const open = await listOpenIssues(IMPORT_FAILURE_ISSUES_REPO, IMPORT_FAILURE_ISSUE_LABEL, pat);

  // A rollup carries the tracking label too, so it would otherwise count itself
  // and latch the mode on forever.
  const perDataset = open.filter((i) => !issueLabelNames(i).includes(IMPORT_ROLLUP_ISSUE_LABEL));
  const rollupOpen = open.length !== perDataset.length;

  const result: ImportIssueSweepResult = {
    applied: apply,
    openIssues: perDataset.length,
    mode: decideIssueMode({ openPerDatasetCount: perDataset.length, rollupOpen }),
    examined: 0,
    closed: 0,
    relabelled: 0,
    kept: 0,
    plan: [],
    errors: [],
    remaining: Math.max(perDataset.length - limit, 0),
  };

  for (const issue of perDataset.slice(0, limit)) {
    result.examined++;
    const datasetId = parseImportFailureIssueTitle(issue.title);
    try {
      const entry = await planOneIssue(env, issue, datasetId, verify);
      result.plan.push(entry);

      if (entry.kind === "close") result.closed++;
      else if (entry.kind === "relabel") result.relabelled++;
      else result.kept++;

      if (apply) await applyOneIssue(issue, entry, { close, setLabels, comment }, pat);
    } catch (err) {
      // Fail open on this row: nothing is written, the issue stays a candidate.
      result.errors.push({
        issue: issue.number,
        dataset_id: datasetId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/** Decide what should happen to one issue. Throws on a transient failure, which
 *  the caller records as a row-level error rather than a verdict. */
async function planOneIssue(
  env: Bindings,
  issue: GitHubIssue,
  datasetId: string | null,
  verify: NonNullable<ImportIssueSweepDeps["verify"]>,
): Promise<ImportIssueSweepPlanEntry> {
  const base = { issueNumber: issue.number, datasetId, title: issue.title };

  // A title that does not parse cannot be matched to a row, so it is somebody's
  // hand-written issue. Left alone, without spending an S3 walk on it.
  if (!datasetId) {
    return { ...base, kind: "keep", reason: "title is not machine-generated" };
  }

  const job = await env.DB.prepare(
    "SELECT source_id, stage, last_error FROM import_jobs WHERE dataset_id = ?",
  )
    .bind(datasetId)
    .first<ImportJobRow>();
  if (!job) {
    // No row to judge against -- e.g. the `no-import-row` class in the triage
    // doc. Nothing to verify and nothing to reclassify.
    return { ...base, kind: "keep", reason: "no import_jobs row for this dataset" };
  }

  const integrity = await verify(env, datasetId);
  const classified = classifyImportFailure({ stage: job.stage, lastError: job.last_error });
  const verifyState: IssueVerifyState = {
    complete: integrity.complete,
    version: integrity.version,
    expectedCount: integrity.expectedCount,
    presentCount: integrity.presentCount,
  };

  const action = decideIssueAction({
    datasetId,
    sourceId: job.source_id,
    issueTitle: issue.title,
    currentLabels: issueLabelNames(issue),
    causeLabel: classified.label,
    verify: verifyState,
  });

  return {
    ...base,
    kind: action.kind,
    reason: action.reason,
    labels: action.labels,
    verify: verifyState,
    causeSummary: classified.summary,
  };
}

/** Perform a planned action. Comment first, so an issue is never closed or
 *  relabelled without the record of why alongside it. */
async function applyOneIssue(
  issue: GitHubIssue,
  entry: ImportIssueSweepPlanEntry,
  io: {
    close: typeof closeIssue;
    setLabels: typeof setIssueLabels;
    comment: typeof addIssueComment;
  },
  pat: string,
): Promise<void> {
  const nowIso = new Date().toISOString();

  if (entry.kind === "close") {
    // entry.verify is always set on a close: decideIssueAction cannot return
    // "close" without a verdict to base it on.
    if (!entry.verify) throw new Error(`close planned for #${issue.number} with no verdict`);
    await io.comment(
      IMPORT_FAILURE_ISSUES_REPO,
      issue.number,
      buildRecoveryCloseComment(entry.verify, nowIso),
      pat,
    );
    await io.close(IMPORT_FAILURE_ISSUES_REPO, issue.number, pat);
    console.log(`[import-issue-sweep] closed ${IMPORT_FAILURE_ISSUES_REPO}#${issue.number}`);
    return;
  }

  if (entry.kind === "relabel" && entry.labels) {
    await io.comment(
      IMPORT_FAILURE_ISSUES_REPO,
      issue.number,
      buildRelabelComment(
        { kind: "relabel", reason: entry.reason },
        entry.causeSummary ?? "",
        nowIso,
      ),
      pat,
    );
    await io.setLabels(IMPORT_FAILURE_ISSUES_REPO, issue.number, entry.labels, pat);
    console.log(
      `[import-issue-sweep] relabelled ${IMPORT_FAILURE_ISSUES_REPO}#${issue.number} -> ${entry.labels.join(",")}`,
    );
  }
}

/** One-line-per-issue summary for the CLI and the cron log. */
export function importIssueSweepLogLines(result: ImportIssueSweepResult): string[] {
  const verb = result.applied ? "" : "WOULD ";
  return result.plan.map((e) => {
    const action =
      e.kind === "close" ? `${verb}CLOSE` : e.kind === "relabel" ? `${verb}RELABEL` : "KEEP";
    return `${action.padEnd(14)} #${e.issueNumber} ${e.datasetId ?? "(unknown)"}  ${e.reason}`;
  });
}
