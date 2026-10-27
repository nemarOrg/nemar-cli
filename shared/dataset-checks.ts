/**
 * The two checks a dataset repository's pull requests run, by the names GitHub shows them under:
 * BIDS validation and `version-check`. Named once, here, and read by the Worker's branch rulesets
 * (`deriveContexts` in `backend/src/services/github/branch-protection.ts`, which re-exports
 * {@link LEGACY_INLINE_BIDS_REPOS}), by its re-pull readers, and by the CLI's re-pull gates, which
 * must read the check the ruleset requires; nothing in `shared/` imports the Worker.
 */

/**
 * Dataset repositories created before the centralized BIDS validation (#601) that still run the
 * old inline `bids-validation.yml`, whose check run is literally named `bids-validation` and is
 * posted by GitHub Actions. Every other repository's is `Run BIDS Validation`, which the NEMAR App
 * posts cross-repo.
 */
export const LEGACY_INLINE_BIDS_REPOS: ReadonlySet<string> = new Set([
  "nm000103",
  "nm000105",
  "nm000106",
  "nm000107",
]);

/** The BIDS validation check of a central-flow repository, posted by the NEMAR App. */
export const BIDS_CHECK_NAME = "Run BIDS Validation";

/** The BIDS validation check of a {@link LEGACY_INLINE_BIDS_REPOS} repository. */
export const LEGACY_BIDS_CHECK_NAME = "bids-validation";

/** The version check, which the NEMAR App posts on a central-flow repository. */
export const VERSION_CHECK_NAME = "version-check";

/** The name of the BIDS validation check of `datasetId`'s repository. */
export function bidsCheckName(datasetId: string): string {
  return LEGACY_INLINE_BIDS_REPOS.has(datasetId) ? LEGACY_BIDS_CHECK_NAME : BIDS_CHECK_NAME;
}
