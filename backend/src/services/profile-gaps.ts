/**
 * The one adapter between a `users` row and the shared gap matrix (#1268,
 * ADR 0045).
 *
 * The rules live in `shared/contract/profile-gaps.ts`, which is transcribed by
 * the website and must therefore stay free of anything D1-shaped. What is
 * D1-shaped is exactly this: `email_verified` and `orcid_verified` are 0/1
 * INTEGERs on the row and booleans on the wire, `role` is an unconstrained TEXT
 * column that has to be narrowed to the matrix's vocabulary (#1271), and three
 * feed the same computation (`GET /users/me`, `GET /auth/me` via `publicUser`,
 * and the upload-access precondition row). Converting them at each call site is
 * how one of the three ends up passing `0` where a boolean was expected and
 * silently reporting every account's inbox as verified.
 */

import {
  type ProfileGapAccount,
  type ProfileGapEntry,
  computeProfileGaps,
} from "../../../shared/contract/profile-gaps.js";
import type { AccountStatus } from "../../../shared/contract/user.js";
import { flag } from "../db/flag";
import { isValidRole } from "../types/bindings";

/**
 * The columns the gap rules read, as SQLite hands them over.
 *
 * Both flags accept `number | boolean` because `publicUser` has already
 * normalised its row by the time it gets here while `/users/me` has not, and
 * demanding one spelling would only add a cast at one of the two call sites.
 */
export interface ProfileGapRow {
  /** The column's own vocabulary, not the dashboard's collapsed one: this is
   *  what SQLite hands back, and migration 0001's CHECK constraint is what
   *  closes the set. */
  status: AccountStatus;
  /** `string | null` because migration 0009's column has no CHECK constraint
   *  and predates every row that was backfilled into it -- the narrowing to the
   *  matrix's vocabulary happens once, below. `UserRole | null` from a caller
   *  that has already parsed it is assignable as it stands. */
  role: string | null;
  email_verified: number | boolean;
  orcid_verified: number | boolean;
  username: string | null;
  given_name: string | null;
  family_name: string | null;
  github_username: string | null;
  city: string | null;
  country: string | null;
}

/**
 * The row's role as the matrix reads it, or `null`.
 *
 * Exported because the upload-access preconditions read the same column off
 * their own SELECT (services/upload-access.ts) and there must be exactly one
 * answer to "is this row exempt" -- two narrowings that agree today is the
 * arrangement ADR 0045 exists to end.
 *
 * An unrecognised value is `null` and therefore NOT exempt from the
 * `orcid_verified` row (#1271): the exemption is a licence to skip a check, and
 * a column this build cannot read is not a reason to hand one out. `parseRole`
 * is deliberately not reused -- it defaults a NULL role to `"member"` and logs,
 * which is right for authorisation and pointless here, where `null` and
 * `"member"` already mean the same thing.
 */
export function gapRole(role: string | null): ProfileGapAccount["role"] {
  return role !== null && isValidRole(role) ? role : null;
}

/** Compute `profile_gaps` for one account row. */
export function profileGapsForRow(row: ProfileGapRow): ProfileGapEntry[] {
  return computeProfileGaps({
    status: row.status,
    role: gapRole(row.role),
    email_verified: flag(row.email_verified),
    orcid_verified: flag(row.orcid_verified),
    username: row.username,
    given_name: row.given_name,
    family_name: row.family_name,
    github_username: row.github_username,
    city: row.city,
    country: row.country,
  });
}
