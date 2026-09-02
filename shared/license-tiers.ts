/**
 * License permissiveness tiers for the dataset catalog (#653).
 *
 * Moved here from `backend/src/lib/license.ts` in epic #1144 phase 4 (#1148,
 * D4): the CLI (`src/commands/dataset.ts`) used to hand-roll its own copy of
 * this exact list to validate `--license` client-side, with a comment
 * admitting it mirrored this one. Two copies of a six-string enum are two
 * chances to drift, so both now import this single declaration.
 *
 * `backend/src/lib/license.ts` re-exports `LICENSE_TIERS`/`LicenseTier`
 * verbatim, so its own import path -- and the classification logic that
 * reads `LICENSE_TIERS` -- does not change.
 */

export const LICENSE_TIERS = [
  "public",
  "attribution",
  "sharealike",
  "noncommercial",
  "noderiv",
  "unknown",
] as const;

export type LicenseTier = (typeof LICENSE_TIERS)[number];
