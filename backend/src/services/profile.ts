/**
 * Profile self-service helpers (#912), used by PATCH /auth/profile in
 * auth-web.ts. Pure functions so the semantics are unit-testable without a
 * Worker (same pattern as decideLinkOutcome / decideVerifiedFlag in
 * orcid-auth.ts).
 *
 * Field semantics, per the website Settings form (nemarOrg/website PR #144):
 *   - github_username: optional handle; empty string clears it (NULL). It is
 *     only *required* at publish time, not here. A leading "@" is stripped
 *     because people paste their handle that way.
 *   - city / country: required non-empty once submitted (US export-control
 *     screening, ADR 0010). The columns are nullable in D1 (migration 0052)
 *     for pre-existing rows; the non-empty rule lives here, at the write.
 *   - affiliation: optional free text; empty string clears it (NULL).
 *
 * Name (given_name/family_name) is deliberately NOT accepted: it is
 * ORCID-canonical (#835) and refreshed from the ORCID record on every
 * login/link, so a hand-edited value would just be overwritten.
 */

/**
 * GitHub handle rule, matching the website's client-side check: 1-39 chars,
 * alphanumeric or hyphen, no leading/trailing/consecutive hyphens. Stricter
 * than the CLI signup regex (which permits consecutive hyphens GitHub itself
 * refuses); existing stored handles are unaffected because this only gates
 * new writes.
 */
export const GITHUB_HANDLE_RE = /^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/;

/** Sparse update: `undefined` = field absent from the PATCH, `null` = clear. */
export interface ProfilePatch {
  github_username?: string | null;
  city?: string;
  country?: string;
  affiliation?: string | null;
}

export interface ProfilePatchInput {
  github_username?: string;
  city?: string;
  country?: string;
  affiliation?: string;
}

export type NormalizeResult =
  | { ok: true; patch: ProfilePatch }
  | { ok: false; error: string; message: string };

/**
 * Normalize a raw PATCH body into a sparse, validated update. Keys absent
 * from the input stay absent from the patch (true PATCH semantics); the
 * website always sends all four, but the endpoint contract is any subset.
 */
export function normalizeProfilePatch(input: ProfilePatchInput): NormalizeResult {
  const patch: ProfilePatch = {};

  if (input.github_username !== undefined) {
    const handle = input.github_username.trim().replace(/^@/, "");
    if (handle.length === 0) {
      patch.github_username = null;
    } else if (!GITHUB_HANDLE_RE.test(handle)) {
      return {
        ok: false,
        error: "invalid_github_username",
        message:
          "GitHub username must be 1-39 characters, alphanumeric or hyphens, and cannot start, end, or double up on a hyphen",
      };
    } else {
      patch.github_username = handle;
    }
  }

  if (input.city !== undefined) {
    const city = input.city.trim();
    if (city.length === 0) {
      return { ok: false, error: "city_required", message: "City cannot be empty" };
    }
    patch.city = city;
  }

  if (input.country !== undefined) {
    const country = input.country.trim();
    if (country.length === 0) {
      return { ok: false, error: "country_required", message: "Country cannot be empty" };
    }
    patch.country = country;
  }

  if (input.affiliation !== undefined) {
    const affiliation = input.affiliation.trim();
    patch.affiliation = affiliation.length === 0 ? null : affiliation;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "empty_patch", message: "No profile fields provided" };
  }

  return { ok: true, patch };
}

/**
 * Whether a submitted handle needs the external GitHub existence + dedup
 * checks. Re-saving your own current handle (case-insensitively) is a no-op
 * for those checks — it keeps routine "save profile" clicks from spending a
 * GitHub API call, and from failing when GitHub is unreachable.
 */
export function githubHandleChanged(submitted: string, current: string | null): boolean {
  return submitted.toLowerCase() !== (current ?? "").toLowerCase();
}
