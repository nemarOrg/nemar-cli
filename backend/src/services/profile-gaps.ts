/**
 * The one adapter between a `users` row and the shared gap matrix (#1268,
 * ADR 0045).
 *
 * The rules live in `shared/contract/profile-gaps.ts`, which is transcribed by
 * the website and must therefore stay free of anything D1-shaped. What is
 * D1-shaped is exactly this: `email_verified` and `orcid_verified` are 0/1
 * INTEGERs on the row and booleans on the wire, and three different SELECTs
 * feed the same computation (`GET /users/me`, `GET /auth/me` via `publicUser`,
 * and the upload-access precondition row). Converting them at each call site is
 * how one of the three ends up passing `0` where a boolean was expected and
 * silently reporting every account's inbox as verified.
 */

import { type ProfileGapEntry, computeProfileGaps } from "../../../shared/contract/profile-gaps.js";

/**
 * The columns the gap rules read, as SQLite hands them over.
 *
 * Both flags accept `number | boolean` because `publicUser` has already
 * normalised its row by the time it gets here while `/users/me` has not, and
 * demanding one spelling would only add a cast at one of the two call sites.
 */
export interface ProfileGapRow {
  status: string;
  email_verified: number | boolean;
  orcid_verified: number | boolean;
  username: string | null;
  given_name: string | null;
  family_name: string | null;
  github_username: string | null;
  city: string | null;
  country: string | null;
}

function flag(value: number | boolean): boolean {
  return value === true || value === 1;
}

/** Compute `profile_gaps` for one account row. */
export function profileGapsForRow(row: ProfileGapRow): ProfileGapEntry[] {
  return computeProfileGaps({
    status: row.status,
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
