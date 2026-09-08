/**
 * What actually went wrong with an OpenNeuro import (epic #1306, issue #1309).
 *
 * Replaces a two-entry stage->hint map that guessed "possible git-divergence"
 * for every prepare failure and "possible upstream-403/shard-gap" for every copy
 * failure. Between 2026-07-22 and 2026-09-08 every automated import failed, and
 * that map described none of them: the real causes were an expired GitHub PAT, a
 * git-annex bucket uuid collision, a branch-protection ruleset, and a rebase
 * conflict. Meanwhile a human was reading Actions logs and hand-applying the
 * labels this module now derives, so the taxonomy below is transcribed from
 * triage that was already known to be correct -- not invented.
 *
 * ## Classify the message, never the log
 *
 * Input is `import_jobs.last_error` -- the structured message the failing job
 * posted -- and nothing else. Two false positives make whole-log matching
 * actively wrong, both hit while diagnosing this:
 *
 *   - `403` matches apt output on every runner (`Packages [403 kB]`), so any
 *     rule keying on a bare status code classifies healthy setup noise.
 *   - `[openneuro-upstream-inaccessible]` appears in EVERY prepare log, because
 *     the reporting step's own source is echoed by Actions
 *     (`if grep -qF "[openneuro-upstream-inaccessible]" "$log"`). Matching a
 *     whole log for it marks every failure upstream-inaccessible -- the most
 *     likely origin of the misattributed `upstream-403` labels on the existing
 *     tracking issues.
 *
 * ## `unknown` is a real answer
 *
 * A generic roll-up (`terminal: ...`) or a null carries no diagnosis, and the
 * honest classification is `unknown`, routed to `needs-triage` so a person still
 * looks. Guessing is what produced the misleading labels in the first place.
 */

/** Marker the import CLI emits for an OpenNeuro-side fetch failure. Duplicated
 *  from import-recovery.ts on purpose -- see the note there; importing it would
 *  couple this pure module to the recovery service. */
const UPSTREAM_MARKER = "[openneuro-upstream-inaccessible]";

export type ImportFailureCause =
  | "upstream_inaccessible"
  | "auth_invalid"
  | "annex_uuid_conflict"
  | "branch_protection"
  | "git_divergence"
  | "bids_validation"
  | "rate_limit"
  | "timeout"
  | "unknown";

export interface ClassifiedImportFailure {
  cause: ImportFailureCause;
  /** Label applied to the tracking issue on nemarDatasets/.github. */
  label: string;
  /** One sentence naming the cause and what to do about it. */
  summary: string;
}

/**
 * Ordered rules, first match wins. Order matters where messages can overlap: the
 * upstream marker is checked first because it is an explicit, deliberate signal
 * from the CLI, and `timeout` is checked last because "cancelled" appears in
 * cascading messages from other causes.
 */
const RULES: {
  cause: Exclude<ImportFailureCause, "unknown">;
  label: string;
  summary: string;
  match: RegExp;
}[] = [
  {
    cause: "upstream_inaccessible",
    label: "upstream-inaccessible",
    summary:
      "OpenNeuro's own objects could not be fetched. Verify with an anonymous ranged GET before assuming it is still true -- this has resolved upstream before without notice.",
    // Literal marker, escaped: [ ] are a character class in a regex.
    match: /\[openneuro-upstream-inaccessible\]/,
  },
  {
    cause: "auth_invalid",
    label: "auth-invalid",
    summary:
      "GitHub rejected the credential. NEMAR_GITHUB_PAT (repo secret on nemarDatasets/.github) is expired, revoked, or lacks Contents: write.",
    match: /Invalid username or token|Authentication failed for/i,
  },
  {
    cause: "annex_uuid_conflict",
    label: "annex-uuid-conflict",
    summary:
      "The S3 prefix already carries an annex-uuid from an earlier import attempt, so initialising the special remote conflicts. Affects re-imports only. See nemarOrg/nemar-cli#1320.",
    match: /annex-uuid file indicates it is used by a different special remote/i,
  },
  {
    cause: "branch_protection",
    label: "branch-protection",
    summary:
      "A branch-protection ruleset on the published dataset repo rejected the push. See nemarOrg/nemar-cli#998.",
    // Only the two GH0xx codes that actually mean protection: GH006 (protected
    // branch update failed) and GH013 (repository rule violations). A bare
    // `GH0\d{2}` would also swallow GH001/GH002 (file too large), GH003
    // (force-push refused) and GH007 (private email blocked), none of which is a
    // protection rule -- and each would then be handed the summary below, which
    // would send triage to the wrong issue entirely.
    match: /GH0(?:06|13):|Repository rule violations|protected branch/i,
  },
  {
    cause: "git_divergence",
    label: "git-divergence",
    summary:
      "The dataset repo's main has diverged from the import's history and auto-rebase failed. Needs a human to reconcile the two histories.",
    match: /diverging commits|auto-rebase failed/i,
  },
  {
    cause: "bids_validation",
    label: "bids-validation",
    summary: "The dataset failed BIDS validation. This is a data problem, not a pipeline problem.",
    match: /bids-validator|BIDS validation failed/i,
  },
  {
    cause: "rate_limit",
    label: "rate-limit",
    summary:
      "GitHub rate-limited the run. Retrying later is usually sufficient; a burst of dispatches is the usual trigger.",
    match: /secondary rate limit|API rate limit exceeded/i,
  },
  {
    cause: "timeout",
    label: "timeout",
    summary:
      "The job hit its time limit or was cancelled. Large datasets may need sharding or a longer window.",
    match: /timed out|exceeded the maximum execution time|The job was cancelled/i,
  },
];

const UNKNOWN: ClassifiedImportFailure = {
  cause: "unknown",
  label: "needs-triage",
  summary:
    "No cause could be determined from the reported error. Open the workflow run to classify it by hand.",
};

/**
 * Classify a failure from its structured error message.
 *
 * `stage` is accepted for call-site symmetry and future stage-specific rules but
 * is deliberately NOT used to infer a cause: inferring from stage alone is what
 * the old STAGE_HINTS map did, and it was wrong for every failure it ever
 * described.
 */
export function classifyImportFailure(args: {
  stage: string;
  lastError: string | null | undefined;
}): ClassifiedImportFailure {
  const message = args.lastError?.trim();
  if (!message) return UNKNOWN;
  for (const rule of RULES) {
    if (rule.match.test(message)) {
      return { cause: rule.cause, label: rule.label, summary: rule.summary };
    }
  }
  return UNKNOWN;
}

/** Every label this module can apply, for the label-provisioning checklist. */
export const IMPORT_FAILURE_CAUSE_LABELS: string[] = [...RULES.map((r) => r.label), UNKNOWN.label];

/**
 * The private copy above, exposed so a test can assert it still equals
 * `OPENNEURO_UPSTREAM_MARKER` in import-recovery.ts. Duplicating the literal keeps
 * this module pure, but a drift between the copies would be silent -- upstream
 * failures would quietly start classifying as `unknown` -- so the copies are pinned
 * together in import-failure-cause.test.ts rather than merely hoped to match.
 */
export const IMPORT_UPSTREAM_MARKER_FOR_CLASSIFY = UPSTREAM_MARKER;
