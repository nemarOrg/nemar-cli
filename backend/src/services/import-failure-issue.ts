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
 * Accrual control (epic #1306 phase 2) rides on top of that dedup: a re-failure
 * whose CAUSE changed is relabelled rather than left filed as something it no
 * longer is, and past a cap a burst joins one rollup issue per cause instead of
 * opening dozens. The rules are in services/import-issue-accrual.ts.
 *
 * Closing on recovery is deliberately NOT here. It belongs to a sweep
 * (services/import-issue-sweep.ts), because a recovery does not necessarily
 * pass through this code path at all -- a manual `nemar admin recover` or an
 * operator's forced verify would never reach it.
 */

import type { Bindings } from "../types/bindings.js";
import { isSandboxDatasetId } from "./datasetId.js";
import { isNonProductionEnv } from "./environment.js";
import { getDatasetsToken } from "./github-auth.js";
import {
  type GitHubIssue,
  addIssueComment,
  createIssue,
  issueLabelNames,
  listOpenIssuesByLabel,
  setIssueLabels,
} from "./github.js";
import { type ClassifiedImportFailure, classifyImportFailure } from "./import-failure-cause.js";
import {
  IMPORT_ROLLUP_ISSUE_LABEL,
  type RollupEntry,
  buildRollupIssueBody,
  buildRollupUpdateComment,
  computeLabelUpdate,
  decideIssueMode,
  rollupIssueTitle,
} from "./import-issue-accrual.js";
import {
  IMPORT_FAILURE_ISSUES_REPO,
  IMPORT_FAILURE_ISSUE_LABEL,
  importFailureIssueTitle,
} from "./import-issue-identity.js";

// Identity lives in a leaf module so import-issue-accrual.ts can recognise an
// issue without importing this one (which imports it back). Re-exported here so
// existing import sites keep working and there is still one obvious place to
// import them from.
export { IMPORT_FAILURE_ISSUE_LABEL, IMPORT_FAILURE_ISSUES_REPO, importFailureIssueTitle };

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

export interface ImportFailureIssueDetails {
  datasetId: string;
  sourceId: string;
  stage: string;
  errorMessage: string | null;
  workflowRunUrl: string | null;
}

/** Issue body for a fresh CREATE. */
export function buildImportFailureIssueBody(details: ImportFailureIssueDetails): string {
  const classified = classifyImportFailure({
    stage: details.stage,
    lastError: details.errorMessage,
  });
  return [
    `Dataset: ${details.datasetId}`,
    `Source: OpenNeuro ${details.sourceId}`,
    `Stage: ${details.stage}`,
    `Cause: ${classified.cause}`,
    `Error: ${details.errorMessage ?? "(none reported)"}`,
    `Workflow run: ${details.workflowRunUrl ?? "(none reported)"}`,
    "",
    classified.summary,
    "",
    "See nemarOrg/nemar-cli#967 and docs/import-failure-procedure.md for the triage procedure.",
  ].join("\n");
}

/** Comment body for a re-failure against an existing open issue. `nowIso` is
 *  caller-supplied so the function stays pure and deterministic in tests. */
export function buildImportFailureIssueComment(
  details: ImportFailureIssueDetails,
  nowIso: string,
): string {
  const classified = classifyImportFailure({
    stage: details.stage,
    lastError: details.errorMessage,
  });
  return [
    `Re-failed at stage \`${details.stage}\` (${nowIso}).`,
    `Cause: ${classified.cause}`,
    `Error: ${details.errorMessage ?? "(none reported)"}`,
    `Workflow run: ${details.workflowRunUrl ?? "(none reported)"}`,
    "",
    classified.summary,
  ].join("\n");
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
 * Injection seams for tests. The one real caller
 * (routes/callbacks/import-state.ts) omits them.
 *
 * TRANSPORT only -- the GitHub client calls and the token fetch -- exactly as
 * `ImportIssueSweepDeps` does. The gate, the D1 read, the classification, the
 * mode decision and every content body still run for real, so a test drives the
 * same code production does (`.rules/testing.md`). Before this existed the
 * create/comment/relabel/rollup branch could only be reached by letting
 * `getDatasetsToken` throw, which meant the branch that CHOOSES between them was
 * never executed at all.
 */
export interface ImportFailureIssueDeps {
  listOpenIssues?: typeof listOpenIssuesByLabel;
  create?: typeof createIssue;
  comment?: typeof addIssueComment;
  setLabels?: typeof setIssueLabels;
  token?: (env: Bindings) => Promise<string>;
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
  deps: ImportFailureIssueDeps = {},
): Promise<void> {
  const listOpenIssues = deps.listOpenIssues ?? listOpenIssuesByLabel;
  const create = deps.create ?? createIssue;
  const comment = deps.comment ?? addIssueComment;
  const setLabels = deps.setLabels ?? setIssueLabels;
  const token = deps.token ?? getDatasetsToken;

  // A missing datasets row defaults is_sandbox/is_exemplar to false below, i.e.
  // the sandbox/exemplar gate "fails open" (it WILL file). Safe today only via
  // an invariant enforced elsewhere: OpenNeuro imports always mint on###### ids
  // whose datasets row is inserted with is_sandbox=0 synchronously at import
  // kickoff (routes/admin/imports.ts), and is_exemplar=1 exists only on
  // xx-prefixed rows (migration 0057; the xx-band id check in the gate is the
  // independent guard for those). A D1 read that THROWS instead fails closed
  // (the whole function rejects into the caller's .catch, no issue filed).
  const row = await db
    .prepare("SELECT is_sandbox, is_exemplar FROM datasets WHERE dataset_id = ?")
    .bind(args.datasetId)
    .first<{ is_sandbox: number | null; is_exemplar: number | null }>();

  // The STORED error, not `args.errorMessage`, is what the cause is classified
  // from (see the note on classifiedCause below). Read here, next to the other
  // gate read, because the caller has already upserted it.
  const jobRow = await db
    .prepare("SELECT last_error FROM import_jobs WHERE dataset_id = ?")
    .bind(args.datasetId)
    .first<{ last_error: string | null }>();

  const shouldFile = shouldFileImportFailureIssue({
    datasetId: args.datasetId,
    resultingStatus: args.resultingStatus,
    isSandbox: row?.is_sandbox === 1,
    isExemplar: row?.is_exemplar === 1,
    isProduction: !isNonProductionEnv(env),
  });
  if (!shouldFile) return;

  const pat = await token(env);
  const title = importFailureIssueTitle(args.datasetId, args.sourceId);
  const details: ImportFailureIssueDetails = {
    datasetId: args.datasetId,
    sourceId: args.sourceId,
    stage: args.stage,
    errorMessage: args.errorMessage,
    workflowRunUrl: args.workflowRunUrl,
  };

  // ONE listing answers all three questions this function asks of GitHub: is
  // there already an issue for this dataset, how many per-dataset issues are
  // open (the mode), and is this cause's rollup already open. Rollups carry the
  // tracking label too, so they are in the same listing -- paging it once per
  // question would be three identical walks of the same pages.
  //
  // Dedup is check-then-act (find open issue by title, else create) with no
  // lock/idempotency key. Within one workflow run the report job posts
  // status=failed exactly once per dataset, so no self-race. The only race is
  // two near-simultaneous FIRST failures for the same dataset from two
  // different workflow runs (e.g. overlapping manual + auto dispatch): both see
  // "no open issue" and both create one. Worst case = a cosmetic duplicate
  // issue, never data loss or a masked failure. Accepted; the triage sweep
  // (services/import-issue-sweep.ts) also cleans these up on recovery.
  const open = await listOpenIssues(IMPORT_FAILURE_ISSUES_REPO, IMPORT_FAILURE_ISSUE_LABEL, pat);
  const existing = open.find((i) => i.title === title) ?? null;

  // Classified from the STORED `last_error`, never from `args.errorMessage`.
  //
  // The caller (routes/callbacks/import-state.ts) deliberately refuses to let a
  // GENERIC incoming message overwrite a SPECIFIC stored one -- ADR 0051's rule,
  // enforced in SQL by `lastErrorAssignmentSql`. Classifying from the raw
  // incoming value applied that rule to D1 and ignored it for the issue: a second
  // `failed` callback carrying `terminal: prepare=failure copy=failure
  // finalize=failure` (which is what the shard legs running under `if:
  // !cancelled()` post, and what every issue between 2026-07-22 and 2026-09-08
  // recorded) classified as UNKNOWN, and `computeLabelUpdate` then STRIPPED the
  // correct cause label back to `needs-triage`, silently and with no comment
  // saying why. It also set up a two-writer fight with the triage sweep, which
  // reads the protected stored value: sweep relabels to the real cause, next
  // generic callback flips it back, once per run, forever.
  //
  // Reading the stored value makes both writers agree because they read the same
  // column. `args.errorMessage` is still what the issue BODY and the comment
  // quote -- that is this callback's own report and belongs verbatim -- but it no
  // longer decides a label.
  const classified = classifyImportFailure({
    stage: args.stage,
    lastError: jobRow?.last_error ?? args.errorMessage,
  });

  if (existing) {
    await comment(
      IMPORT_FAILURE_ISSUES_REPO,
      existing.number,
      buildImportFailureIssueComment(details, new Date().toISOString()),
      pat,
    );
    // A re-failure whose cause CHANGED used to comment under the original
    // label, leaving the issue filed as something it no longer is. The label
    // set is recomputed rather than appended to, so the stale cause is retired
    // while every label this module does not own is preserved.
    const relabel = computeLabelUpdate(issueLabelNames(existing), classified.label);
    if (relabel) {
      await setLabels(IMPORT_FAILURE_ISSUES_REPO, existing.number, relabel, pat);
    }
    console.log(
      `[import-failure-issue] commented on ${IMPORT_FAILURE_ISSUES_REPO}#${existing.number} for ${args.datasetId}${relabel ? ` (relabelled -> ${classified.label})` : ""}`,
    );
    return;
  }

  // Past the cap, a burst joins one rollup issue per cause instead of opening
  // dozens of near-identical ones. Below it, per-dataset issues stay the default
  // -- they are greppable and keep per-dataset history -- so this is a pressure
  // valve, not the normal mode. See services/import-issue-accrual.ts.
  if (shouldRollUp(open, classified.cause)) {
    try {
      await appendToRollup(
        pat,
        classified,
        {
          datasetId: args.datasetId,
          sourceId: args.sourceId,
          workflowRunUrl: args.workflowRunUrl,
        },
        open,
        { create, comment },
      );
    } catch (err) {
      // Rollup mode makes a lost write strictly costlier than per-dataset mode:
      // no per-dataset issue was opened (that IS the mode) and the rollup comment
      // did not land, so this dataset's failure is recorded nowhere, and the
      // triage sweep cannot recover it because it walks existing ISSUES, never
      // `import_jobs` rows. Phase 3's coverage sweep (#1311) reconciles rows
      // against issues and is the durable fix; until it lands this line is the
      // only trace, so it names the dataset, the source and the cause and is
      // greppable as one string.
      console.error(
        `[import-failure-issue] UNTRACKED FAILURE ${args.datasetId} (${args.sourceId}) cause=${classified.label}: rollup write failed:`,
        err,
      );
      throw err;
    }
    return;
  }

  // The cause label rides alongside the tracking label so the repo can be
  // filtered by what actually failed, not just that something did.
  const created = await create(
    IMPORT_FAILURE_ISSUES_REPO,
    title,
    buildImportFailureIssueBody(details),
    [IMPORT_FAILURE_ISSUE_LABEL, classified.label],
    pat,
  );
  console.log(
    `[import-failure-issue] filed ${IMPORT_FAILURE_ISSUES_REPO}#${created.number} for ${args.datasetId}`,
  );
}

/** Whether an issue in the tracking listing is a per-cause rollup. */
function isRollup(issue: GitHubIssue): boolean {
  return issueLabelNames(issue).includes(IMPORT_ROLLUP_ISSUE_LABEL);
}

/**
 * Whether this failure should join a rollup instead of opening its own issue.
 *
 * Counts the OPEN per-dataset issues (rollups carry the tracking label too, so
 * they are excluded or they would count themselves and latch the cap on), and
 * asks {@link decideIssueMode}. Whether this cause's rollup is already open is
 * what supplies the hysteresis, so no stored flag can drift out of sync.
 */
function shouldRollUp(open: readonly GitHubIssue[], cause: string): boolean {
  const perDatasetCount = open.filter((i) => !isRollup(i)).length;
  const rollupOpen = open.some((i) => isRollup(i) && i.title === rollupIssueTitle(cause));
  return decideIssueMode({ openPerDatasetCount: perDatasetCount, rollupOpen }) === "rollup";
}

/** Add this dataset to its cause's rollup, opening the rollup if it is the
 *  first one. Deduped by the rollup title, exactly as per-dataset issues are,
 *  and out of the same listing the caller already fetched. */
async function appendToRollup(
  pat: string,
  classified: ClassifiedImportFailure,
  entry: RollupEntry,
  open: readonly GitHubIssue[],
  io: { create: typeof createIssue; comment: typeof addIssueComment },
): Promise<void> {
  const title = rollupIssueTitle(classified.cause);
  const nowIso = new Date().toISOString();
  const existing = open.find((i) => isRollup(i) && i.title === title);

  if (existing) {
    await io.comment(
      IMPORT_FAILURE_ISSUES_REPO,
      existing.number,
      buildRollupUpdateComment(entry, nowIso),
      pat,
    );
    console.log(
      `[import-failure-issue] rolled ${entry.datasetId} into ${IMPORT_FAILURE_ISSUES_REPO}#${existing.number}`,
    );
    return;
  }

  const created = await io.create(
    IMPORT_FAILURE_ISSUES_REPO,
    title,
    buildRollupIssueBody(classified.cause, classified.summary, [entry], nowIso),
    [IMPORT_FAILURE_ISSUE_LABEL, IMPORT_ROLLUP_ISSUE_LABEL, classified.label],
    pat,
  );
  console.log(
    `[import-failure-issue] opened rollup ${IMPORT_FAILURE_ISSUES_REPO}#${created.number} for cause ${classified.cause}`,
  );
}
