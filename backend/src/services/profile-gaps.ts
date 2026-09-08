/**
 * The one adapter between a `users` row and the shared gap matrix (#1268,
 * ADR 0045).
 *
 * The rules live in `shared/contract/profile-gaps.ts`, which is transcribed by
 * the website and must therefore stay free of anything D1-shaped. What is
 * D1-shaped is exactly this: `email_verified` and `orcid_verified` are 0/1
 * INTEGERs on the row and booleans on the wire, and three call sites feed the
 * same computation (`GET /users/me`, `GET /auth/me` via `publicUser`, and the
 * upload-access precondition row). Converting them at each call site is how
 * one of the three ends up passing `0` where a boolean was expected and
 * silently reporting every account's inbox as verified. `account_kind` (epic
 * #1272 phase 4, #1284; ADR 0048) needs no such narrowing here -- migration
 * 0082's CHECK constraint closes its vocabulary at the database, unlike the
 * `role`-based exemption this replaced.
 */

import { type ProfileGapEntry, computeProfileGaps } from "../../../shared/contract/profile-gaps.js";
import type { AccountKind, AccountStatus } from "../../../shared/contract/user.js";
import { flag } from "../db/flag";

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
  /** What the account IS (epic #1272 phase 4, #1284; ADR 0048). Closed by
   *  migration 0082's CHECK constraint, so this is a claim the database
   *  enforces rather than an assumption -- unlike the `role` column this
   *  replaced, which had no such constraint and needed narrowing here. */
  account_kind: AccountKind;
  email_verified: number | boolean;
  orcid_verified: number | boolean;
  username: string | null;
  given_name: string | null;
  family_name: string | null;
  github_username: string | null;
  city: string | null;
  country: string | null;
}

/** Compute `profile_gaps` for one account row. */
export function profileGapsForRow(row: ProfileGapRow): ProfileGapEntry[] {
  return computeProfileGaps({
    status: row.status,
    account_kind: row.account_kind,
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
