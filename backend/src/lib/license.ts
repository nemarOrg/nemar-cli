// License permissiveness tiers for the dataset catalog (#653).
//
// This is the backend authority for the same classification the website's
// `src/lib/tags.ts#licenseTier` does client-side. Both MUST stay byte-for-byte
// equivalent: the website reads the raw `license` string off each /datasets row
// and re-derives the tier to color/filter cards, while the backend stores the
// derived tier in `datasets.license_tier` (migration 0034) so `?license=<tier>`
// can filter the FULL catalog server-side rather than only the current page.
//
// The parity with the website is asserted by test/license-tier.test.ts against
// the real catalog values. `LICENSE_TIERS`/`LicenseTier` themselves moved to
// shared/license-tiers.ts in epic #1144 phase 4 (#1148, D4) so the CLI
// (src/commands/dataset.ts) can validate `--license` against the SAME list
// instead of hand-rolling a second copy; re-exported here verbatim so this
// file's own import path, and every existing importer, does not change.

import { LICENSE_TIERS, type LicenseTier } from "../../../shared/license-tiers.js";

export { LICENSE_TIERS, type LicenseTier };

/**
 * Classify a free-text license string into a permissiveness tier. Tolerant of
 * the spacing / hyphenation / version-suffix drift seen across catalog rows
 * ("CC-BY-NC 4.0", "CC-BY-NC-SA-4.0", "CC-BY-NC-4.0", ...). The most
 * restrictive marker is checked first so combined clauses land in the
 * stricter tier: CC-BY-NC-ND -> noderiv, CC-BY-NC-SA -> noncommercial.
 *
 * Mirrors nemarOrg/website src/lib/tags.ts#licenseTier exactly.
 */
export function licenseTier(license: string | null | undefined): LicenseTier {
  if (!license || !license.trim()) return "unknown";
  // Pass an already-classified tier name straight through, so a caller that
  // hands us a tier (not a raw license string) isn't silently re-bucketed to
  // "unknown".
  const lower = license.trim().toLowerCase();
  if ((LICENSE_TIERS as readonly string[]).includes(lower)) return lower as LicenseTier;
  const s = license.toUpperCase().replace(/[\s_]+/g, "-");
  // Most restrictive marker first, so combined clauses land in the stricter
  // tier (CC-BY-NC-ND -> noderiv, CC-BY-NC-SA -> noncommercial).
  if (/(^|-)ND(-|$)|NO-?DERIV/.test(s)) return "noderiv";
  if (/(^|-)NC(-|$)|NON-?COMMERCIAL/.test(s)) return "noncommercial";
  if (/(^|-)SA(-|$)|SHARE-?ALIKE|ODBL/.test(s)) return "sharealike";
  // `UNLICENSE(?!D)` so "UNLICENSED" (all-rights-reserved) is NOT read as
  // public domain -- misclassifying toward *more* permissive is the dangerous
  // direction for a usage-rights signal.
  if (/CC-?0|PDDL|UNLICENSE(?!D)|PUBLIC-?DOMAIN|(^|-)PD(-|$)/.test(s)) return "public";
  // Attribution only via the CC-BY / ODC-BY tokens, never a stray "by" that a
  // free-text custom license sentence might contain.
  if (/CC-BY|ODC-BY|ATTRIBUTION/.test(s)) return "attribution";
  return "unknown";
}

/**
 * Parse a comma-separated `?license=` query value into a deduped list of valid
 * tiers (OR semantics at the call site). Unknown tokens are dropped, so a
 * caller can treat a non-empty result as a safe `IN (...)` list and an empty
 * result as "no license filter requested". Case/space tolerant.
 */
export function parseLicenseTierFilter(raw: string | undefined | null): LicenseTier[] {
  if (!raw) return [];
  const seen = new Set<LicenseTier>();
  for (const token of raw.split(",")) {
    const t = token.trim().toLowerCase();
    if ((LICENSE_TIERS as readonly string[]).includes(t)) {
      seen.add(t as LicenseTier);
    }
  }
  return [...seen];
}
