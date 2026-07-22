/**
 * Auto-file GitHub issues for genuine OpenNeuro import failures (epic #967
 * follow-up to issue #967 / #969; automation half of nemarDatasets/.github#83,
 * which added the issue TEMPLATE + triage doc).
 *
 * onboard-openneuro.yml's `report` job POSTs `status:"failed"` to
 * /webhooks/import-state for EVERY dataset in a matrix run, whether or not
 * that dataset actually failed -- the backend's monotonic sticky upsert
 * (routes/callbacks/import-state.ts) is the one place that knows whether THIS
 * call landed a genuine failure or was a no-op against an already-terminal
 * row (the WHERE clause on that upsert refuses to regress a row already
 * complete/rolled_back/quarantined). shouldFileImportFailureIssue therefore
 * keys off the row's RESULTING status after the upsert, never the raw
 * callback payload, so a "failed" POST against an already-complete dataset
 * never opens an issue.
 *
 * Dedup: a deterministic per-dataset title is both the issue title and the
 * dedup key -- a re-failure finds the existing OPEN issue by title (scoped to
 * the import-failure label) and comments instead of opening a duplicate.
 *
 * No close-on-recovery here (follow-up; a recovered import currently leaves
 * its issue open for a human to close).
 */

import type { Bindings } from "../types/bindings.js";
import { isSandboxDatasetId } from "./datasetId.js";
import { isNonProductionEnv } from "./environment.js";
import { getDatasetsToken } from "./github-auth.js";
import { addIssueComment, createIssue, findOpenIssueByTitle } from "./github.js";

export const IMPORT_FAILURE_ISSUE_LABEL = "import-failure";
/** Central repo the failure-tracking issue template + triage doc live on
 *  (nemarDatasets/.github#83) -- same repo the onboard workflow itself is
 *  deployed to (github/dispatch.ts CENTRAL_WORKFLOW_REPO). */
export const IMPORT_FAILURE_ISSUES_REPO = "nemarDatasets/.github";

// ============================================================================
// Pure decision + content functions -- no I/O, exhaustively unit-tested.
// ============================================================================

export interface ImportFailureIssueContext {
  datasetId: string;
  /** The import_jobs row's status AFTER the upsert ran -- NOT the raw
   *  callback payload's status. This is what distinguishes a genuine
   *  failure from a no-op against an already-terminal row. */
  resultingStatus: string;
  /** datasets.is_sandbox for this id (false/absent when the datasets row
   *  doesn't exist -- OpenNeuro imports always mint on###### ids, which are
   *  never sandbox rows, so an absent row is not itself a reason to skip). */
  isSandbox: boolean;
  /** datasets.is_exemplar for this id. */
  isExemplar: boolean;
  /** !isNonProductionEnv(env) -- the dev/test worker shares real GitHub org
   *  access but must never open real org issues. */
  isProduction: boolean;
}

/**
 * Gate: file (create or update) an import-failure issue only for a GENUINE,
 * production, non-sandbox/exemplar failure. Pure -- no I/O.
 */
export function shouldFileImportFailureIssue(ctx: ImportFailureIssueContext): boolean {
  if (!ctx.isProduction) return false;
  if (ctx.resultingStatus !== "failed") return false;
  if (isSandboxDatasetId(ctx.datasetId)) return false;
  if (ctx.isSandbox || ctx.isExemplar) return false;
  return true;
}

/** Deterministic per-dataset issue title -- doubles as the dedup key. */
export function importFailureIssueTitle(datasetId: string, sourceId: string): string {
  return `Import failure: ${datasetId} (${sourceId})`;
}

export interface ImportFailureIssueDetails {
  datasetId: string;
  sourceId: string;
  stage: string;
  errorMessage: string | null;
  workflowRunUrl: string | null;
}

/** Best-effort, clearly-labeled failure-class hint from the failing stage.
 *  Unrecognized/finalize stages get no hint rather than a guess. */
const STAGE_HINTS: Record<string, string> = {
  prepare: "possible git-divergence",
  copy: "possible upstream-403/shard-gap",
};

function stageHint(stage: string): string | null {
  return STAGE_HINTS[stage] ?? null;
}

/** Issue body for a fresh CREATE. */
export function buildImportFailureIssueBody(details: ImportFailureIssueDetails): string {
  const lines = [
    `Dataset: ${details.datasetId}`,
    `Source: OpenNeuro ${details.sourceId}`,
    `Stage: ${details.stage}`,
    `Error: ${details.errorMessage ?? "(none reported)"}`,
    `Workflow run: ${details.workflowRunUrl ?? "(none reported)"}`,
  ];
  const hint = stageHint(details.stage);
  if (hint)
    lines.push(`Hint (best-effort, from stage=${details.stage}, not authoritative): ${hint}`);
  lines.push(
    "",
    "See nemarOrg/nemar-cli#967 and docs/import-failure-procedure.md for the triage procedure.",
  );
  return lines.join("\n");
}

/** Comment body for a re-failure against an existing open issue. `nowIso` is
 *  caller-supplied so the function stays pure and deterministic in tests. */
export function buildImportFailureIssueComment(
  details: ImportFailureIssueDetails,
  nowIso: string,
): string {
  const lines = [
    `Re-failed at stage \`${details.stage}\` (${nowIso}).`,
    `Error: ${details.errorMessage ?? "(none reported)"}`,
    `Workflow run: ${details.workflowRunUrl ?? "(none reported)"}`,
  ];
  const hint = stageHint(details.stage);
  if (hint)
    lines.push(`Hint (best-effort, from stage=${details.stage}, not authoritative): ${hint}`);
  return lines.join("\n");
}

// ============================================================================
// I/O orchestration -- best-effort, never throws out of the caller's
// perspective when wired via .catch() (see routes/callbacks/import-state.ts).
// The GitHub API calls themselves are untested here (same constraint as
// every other github.ts consumer); the gate + content are covered above.
// ============================================================================

export interface FileImportFailureIssueArgs {
  datasetId: string;
  sourceId: string;
  stage: string;
  errorMessage: string | null;
  workflowRunUrl: string | null;
  /** The import_jobs row's status after the upsert -- see
   *  ImportFailureIssueContext.resultingStatus. */
  resultingStatus: string;
}

/**
 * Decide + (best-effort) act: look up the dataset's sandbox/exemplar flags,
 * run the pure gate, and on a genuine prod failure either comment on an
 * existing open issue or create a new one. Returns without touching GitHub
 * at all when the gate says no -- callers relying on that (e.g. sandbox/
 * exemplar rows never needing GITHUB_ADMIN_PAT configured) can rely on this
 * short-circuit.
 */
export async function fileImportFailureIssueIfNeeded(
  db: D1Database,
  env: Bindings,
  args: FileImportFailureIssueArgs,
): Promise<void> {
  const row = await db
    .prepare("SELECT is_sandbox, is_exemplar FROM datasets WHERE dataset_id = ?")
    .bind(args.datasetId)
    .first<{ is_sandbox: number | null; is_exemplar: number | null }>();

  const shouldFile = shouldFileImportFailureIssue({
    datasetId: args.datasetId,
    resultingStatus: args.resultingStatus,
    isSandbox: row?.is_sandbox === 1,
    isExemplar: row?.is_exemplar === 1,
    isProduction: !isNonProductionEnv(env),
  });
  if (!shouldFile) return;

  const pat = await getDatasetsToken(env);
  const title = importFailureIssueTitle(args.datasetId, args.sourceId);
  const details: ImportFailureIssueDetails = {
    datasetId: args.datasetId,
    sourceId: args.sourceId,
    stage: args.stage,
    errorMessage: args.errorMessage,
    workflowRunUrl: args.workflowRunUrl,
  };

  const existing = await findOpenIssueByTitle(
    IMPORT_FAILURE_ISSUES_REPO,
    IMPORT_FAILURE_ISSUE_LABEL,
    title,
    pat,
  );
  if (existing) {
    await addIssueComment(
      IMPORT_FAILURE_ISSUES_REPO,
      existing.number,
      buildImportFailureIssueComment(details, new Date().toISOString()),
      pat,
    );
    console.log(
      `[import-failure-issue] commented on ${IMPORT_FAILURE_ISSUES_REPO}#${existing.number} for ${args.datasetId}`,
    );
    return;
  }

  const created = await createIssue(
    IMPORT_FAILURE_ISSUES_REPO,
    title,
    buildImportFailureIssueBody(details),
    [IMPORT_FAILURE_ISSUE_LABEL],
    pat,
  );
  console.log(
    `[import-failure-issue] filed ${IMPORT_FAILURE_ISSUES_REPO}#${created.number} for ${args.datasetId}`,
  );
}
