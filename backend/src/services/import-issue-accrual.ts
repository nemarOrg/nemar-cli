/**
 * Accrual control for import-failure tracking issues (epic #1306, issue #1310).
 *
 * `nemarDatasets/.github` had 28 open import-failure issues and zero closed
 * ones, because nothing ever closed one. A tracker that only accumulates cannot
 * tell a live problem from one that healed weeks ago, which is a large part of
 * why a seven-week pipeline outage went unnoticed: the signal was buried in
 * noise that never drained.
 *
 * Three rules live here, all pure:
 *
 *   1. A recovered import closes its issue -- but only on VERIFIED S3 state.
 *   2. A changed cause relabels, rather than appending under a stale label.
 *   3. Past a cap, failures join one rollup issue per cause instead of opening
 *      dozens of near-identical per-dataset issues.
 *
 * Rule 3 exists because failures arrive in bursts: 14 issues opened on
 * 2026-07-22 and 6 more on 2026-09-08 (the day auto-import was re-enabled). A
 * systemic cause hits many datasets at once, and per-dataset filing is what
 * floods a repo that also carries dataset CI. Per-dataset issues stay the
 * DEFAULT below the cap -- they are greppable and keep per-dataset history --
 * so the rollup is a pressure valve, not the normal mode.
 */

import { IMPORT_FAILURE_CAUSE_LABELS } from "./import-failure-cause.js";
import { IMPORT_FAILURE_ISSUE_LABEL, importFailureIssueTitle } from "./import-issue-identity.js";

/** Label marking a per-cause rollup issue, so it is never counted as one of the
 *  per-dataset issues that decide the mode. A rollup that counted itself would
 *  latch the cap on and never release it. */
export const IMPORT_ROLLUP_ISSUE_LABEL = "import-rollup";

/** At or above this many open per-dataset issues, new failures roll up. */
export const IMPORT_ISSUE_CAP = 10;
/** At or below this many, per-dataset filing resumes. */
export const IMPORT_ISSUE_RESUME = 5;

export type ImportIssueMode = "per-dataset" | "rollup";

/**
 * Which filing mode applies right now.
 *
 * The band between {@link IMPORT_ISSUE_RESUME} and {@link IMPORT_ISSUE_CAP} is
 * the hysteresis: inside it, whatever mode is already in effect holds. Without
 * it, a tracker hovering at the threshold would flap between opening
 * per-dataset issues and folding them into a rollup on alternating runs.
 *
 * There is deliberately NO new D1 state behind this. The current mode is
 * already observable: a rollup issue for the cause is either open on GitHub or
 * it is not. `rollupOpen` is that observation, which makes the mode a function
 * of the world rather than a flag that can drift out of sync with it.
 */
export function decideIssueMode(args: {
  openPerDatasetCount: number;
  rollupOpen: boolean;
}): ImportIssueMode {
  if (args.rollupOpen) {
    // Only drop back once the backlog is genuinely drained, not merely one
    // issue below the cap.
    return args.openPerDatasetCount <= IMPORT_ISSUE_RESUME ? "per-dataset" : "rollup";
  }
  return args.openPerDatasetCount >= IMPORT_ISSUE_CAP ? "rollup" : "per-dataset";
}

/** Deterministic per-cause rollup title -- doubles as its dedup key, exactly as
 *  {@link importFailureIssueTitle} does for the per-dataset issues. */
export function rollupIssueTitle(cause: string): string {
  return `Import failures (rollup): ${cause}`;
}

/**
 * Cause labels this module OWNS and may therefore replace on a relabel.
 *
 * `upstream-403` is included as a legacy member: it is the pre-#1309 spelling
 * of `upstream-inaccessible`, and the 403 framing was disproven (anonymous
 * ranged GETs return HTTP 206 on datasets #967 listed as blocked). Replacing it
 * is the point of the relabel pass.
 *
 * Everything else on an issue is left alone -- notably `no-import-row`, which a
 * human applies from triage and which no classifier emits.
 */
const MANAGED_CAUSE_LABELS: ReadonlySet<string> = new Set([
  ...IMPORT_FAILURE_CAUSE_LABELS,
  "upstream-403",
]);

/**
 * The label set an issue should carry, given its current labels and the freshly
 * classified cause. Returns null when nothing would change, so a caller can
 * skip a pointless API write.
 *
 * Preserves every label this module does not own, and keeps the issue's
 * `import-failure` tracking label regardless.
 */
export function computeLabelUpdate(
  currentLabels: readonly string[],
  causeLabel: string,
): string[] | null {
  const kept = currentLabels.filter((l) => !MANAGED_CAUSE_LABELS.has(l));
  const next = new Set(kept);
  next.add(IMPORT_FAILURE_ISSUE_LABEL);
  next.add(causeLabel);

  const before = new Set(currentLabels);
  if (before.size === next.size && [...next].every((l) => before.has(l))) return null;
  // Stable order so a diff of two runs is readable.
  return [...next].sort();
}

/** The subset of {@link import("./import-integrity.js").DatasetVersionIntegrityResult}
 *  this decision needs. Narrow on purpose: the rule is about completeness and
 *  whether a version could be resolved at all, nothing else. */
export interface IssueVerifyState {
  complete: boolean;
  version: string | null;
  expectedCount: number;
  presentCount: number;
}

export type ImportIssueActionKind = "close" | "relabel" | "keep";

export interface ImportIssueAction {
  kind: ImportIssueActionKind;
  /** Human-readable justification, surfaced in the dry-run output and in the
   *  comment the action writes. */
  reason: string;
  /** Present only when kind is "relabel". */
  labels?: string[];
}

/**
 * What to do with one open tracking issue.
 *
 * Two refusals matter more than the happy path:
 *
 *   - **A human-authored issue is never closed** (issue #1310's constraint). The
 *     machine-filed signature is an exact {@link importFailureIssueTitle} match
 *     plus the `import-failure` label; anything else is somebody's hand-written
 *     record and stays untouched.
 *   - **`version === null` is not "incomplete", it is "unknown".** It means no
 *     manifest could be resolved, so there is nothing to compare against.
 *     Treating that as clean would close issues for datasets that never
 *     published at all -- the one mistake here that silently discards a live
 *     problem. `verify: null` (verification itself failed) is the same refusal.
 */
export function decideIssueAction(args: {
  datasetId: string;
  sourceId: string;
  issueTitle: string;
  currentLabels: readonly string[];
  causeLabel: string;
  /** null when verification could not be run at all (transient S3/D1 error). */
  verify: IssueVerifyState | null;
}): ImportIssueAction {
  const machineFiled =
    args.issueTitle === importFailureIssueTitle(args.datasetId, args.sourceId) &&
    args.currentLabels.includes(IMPORT_FAILURE_ISSUE_LABEL);
  if (!machineFiled) {
    return { kind: "keep", reason: "human-authored issue; never touched automatically" };
  }

  if (args.verify === null) {
    return { kind: "keep", reason: "verification unavailable this run" };
  }
  if (args.verify.version === null) {
    return { kind: "keep", reason: "no published manifest; completeness unknown" };
  }
  if (args.verify.complete) {
    return {
      kind: "close",
      reason: `verified complete (${args.verify.presentCount}/${args.verify.expectedCount} objects present at declared size)`,
    };
  }

  const labels = computeLabelUpdate(args.currentLabels, args.causeLabel);
  if (labels) {
    const previous =
      args.currentLabels.filter((l) => MANAGED_CAUSE_LABELS.has(l)).join(", ") || "(none)";
    return {
      kind: "relabel",
      reason: `cause changed: ${previous} -> ${args.causeLabel}`,
      labels,
    };
  }

  return {
    kind: "keep",
    reason: `still incomplete (${args.verify.presentCount}/${args.verify.expectedCount} objects present)`,
  };
}

// ============================================================================
// Content builders. `nowIso` is caller-supplied so these stay deterministic in
// tests, matching buildImportFailureIssueComment's convention.
// ============================================================================

/** Comment left on an issue as it is closed. Says what was verified and how,
 *  because "verified" here means present at declared SIZE -- nothing re-hashes
 *  object bytes against the manifest checksum, and the comment must not imply
 *  otherwise. */
export function buildRecoveryCloseComment(verify: IssueVerifyState, nowIso: string): string {
  return [
    `Recovered: closing automatically (${nowIso}).`,
    "",
    `Version \`${verify.version}\` verifies as complete: ${verify.presentCount} of ${verify.expectedCount} annex-keyed objects are present in S3 at their declared size.`,
    "",
    "Size-level verification, not checksum-level. Re-open if the dataset is still wrong in a way this check cannot see.",
  ].join("\n");
}

/** Comment left when the classified cause changes under an open issue. */
export function buildRelabelComment(
  action: ImportIssueAction,
  causeSummary: string,
  nowIso: string,
): string {
  return [`Relabelled (${nowIso}): ${action.reason}.`, "", causeSummary].join("\n");
}

export interface RollupEntry {
  datasetId: string;
  sourceId: string;
  workflowRunUrl: string | null;
}

/**
 * Body for a per-cause rollup issue. One row per affected dataset, which is a
 * count-and-pointer shape rather than an unbounded dump (ADR 0036): the run URL
 * is the pointer to each dataset's full story.
 */
export function buildRollupIssueBody(
  cause: string,
  causeSummary: string,
  entries: readonly RollupEntry[],
  nowIso: string,
): string {
  return [
    `Import failures sharing cause \`${cause}\`, rolled up because more than ${IMPORT_ISSUE_CAP} per-dataset issues were open.`,
    "",
    causeSummary,
    "",
    `Updated ${nowIso}. ${entries.length} dataset(s) affected:`,
    "",
    ...entries.map(
      (e) => `- ${e.datasetId} (${e.sourceId})${e.workflowRunUrl ? ` -- ${e.workflowRunUrl}` : ""}`,
    ),
    "",
    `Per-dataset issues resume automatically once open ones drop to ${IMPORT_ISSUE_RESUME} or fewer.`,
    "",
    "See nemarOrg/nemar-cli#967 and docs/import-failure-procedure.md for the triage procedure.",
  ].join("\n");
}

/** Comment appended when a further dataset joins an existing rollup. */
export function buildRollupUpdateComment(entry: RollupEntry, nowIso: string): string {
  return [
    `Also failed with this cause (${nowIso}): ${entry.datasetId} (${entry.sourceId}).`,
    entry.workflowRunUrl
      ? `Workflow run: ${entry.workflowRunUrl}`
      : "Workflow run: (none reported)",
  ].join("\n");
}
