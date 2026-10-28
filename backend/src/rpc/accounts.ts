/**
 * `describeAccounts`: the public face of accounts a caller names by user id
 * (ADR 0115, which reads ADR 0078 for a method that takes ids).
 *
 * A page that lists members has user ids and wants people. This answers that
 * and nothing else: a username, a given and a family name, and an ORCID iD
 * where one is safe to show. It never returns the email, the role, the status
 * or any other column, and the answer is built field by field from the row, so
 * a column added to `users` later cannot reach a caller by accident.
 *
 * THE IDS NAME WHO TO DESCRIBE; THEY CONFER NOTHING. ADR 0078's first rule is
 * that no method takes a bare user id as authority. This one takes ids as the
 * SUBJECT of a read and takes the visitor's own credential as the authority:
 * the credential is resolved by `resolvePrincipal` (never a second copy of its
 * SELECTs), so only a live, active account can ask, and a caller that holds no
 * such credential gets the credential refusal and learns nothing about any id.
 *
 * The answer has one entry per requested id, in the request's order, in one of
 * three states: `active` (the public face), `inactive` (a `pending` account,
 * which exists and cannot authenticate yet) and `gone` (revoked, deleted or
 * never there, one answer for all three). `inactive` and `gone` carry the id
 * and the state alone.
 *
 * THE ORCID iD IS SHOWN ONLY WHEN IT IS VERIFIED AND CANONICAL. `orcid` is
 * `users.orcid` when `orcid_verified` is 1 and `identity_conflict` is 0, and
 * `null` otherwise. The second condition is ADR 0043's: a flagged row is the
 * non-canonical duplicate of an identifier another live account holds, and it
 * keeps the iD in its column on purpose, so reading the column without the flag
 * would show an iD that belongs to somebody else. The flag is one column for the
 * three identifiers (iD, email, GitHub handle), so a row flagged for an email
 * collision hides its iD too, which is the safe direction. The verified flag is
 * read with `flag()` (true only for 1), and the conflict flag is required to be
 * exactly 0 rather than "not flagged": a value nobody expects hides the iD.
 *
 * MAINTENANCE MODE IS MIRRORED AS A READ, BY HAND, as for `resolvePrincipal`:
 * RPC bypasses the HTTP middleware, so `full` answers `unavailable` and
 * `read-only` keeps answering, as a `GET` does.
 *
 * Refusals are values; faults throw (ADR 0078, rule 2). A D1 error is not
 * caught here, and nothing is logged: no line names an account or a credential.
 */

import {
  type AccountDescription,
  DESCRIBE_ACCOUNTS_MAX,
  type DescribeAccountsResult,
} from "../../../shared/contract/private-site.js";
import { flag } from "../db/flag";
import { maintenanceRefuses } from "../middleware/maintenance";
import { isActiveAccountStatus } from "../services/account-tier";
import type { BackgroundContext } from "../services/web-session";
import type { Bindings } from "../types/bindings";
import { resolvePrincipal } from "./principal";

const INVALID_REQUEST: DescribeAccountsResult = { ok: false, error: "invalid_request" };

/** The columns the answer is made of, and the two flags that decide the iD.
 *  Nothing else of a user is selected, so nothing else can be returned. */
interface DescribedRow {
  id: number;
  status: string;
  username: string | null;
  given_name: string | null;
  family_name: string | null;
  orcid: string | null;
  orcid_verified: number;
  identity_conflict: number;
}

/**
 * `userIds` as the request carries it, or null when it is not one to answer:
 * an array of 1 to `DESCRIBE_ACCOUNTS_MAX` positive safe integers with none
 * twice. The length is read first, so an oversized array is refused before it
 * is walked. `Number.isSafeInteger` does not coerce, so a string, a bigint, a
 * float, `NaN` and a hole in the array are refused, and `> 0` refuses 0, a
 * negative number and `-0`.
 */
function distinctUserIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length < 1 || value.length > DESCRIBE_ACCOUNTS_MAX) return null;
  const ids: number[] = [];
  for (const id of value as unknown[]) {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
    ids.push(id);
  }
  return new Set(ids).size === ids.length ? ids : null;
}

/** An ORCID iD that is a non-blank string, or null. A blank value is no iD:
 *  the live-iD index treats `TRIM(orcid) = ''` as none. */
function storedOrcid(orcid: string | null): string | null {
  return typeof orcid === "string" && orcid.trim() !== "" ? orcid : null;
}

/** One row (or none) as the contract's union. Built field by field. */
function describeRow(userId: number, row: DescribedRow | undefined): AccountDescription {
  if (row === undefined) return { userId, state: "gone" };
  if (isActiveAccountStatus(row.status)) {
    const shown = flag(row.orcid_verified) && row.identity_conflict === 0;
    return {
      userId,
      state: "active",
      username: row.username,
      givenName: row.given_name,
      familyName: row.family_name,
      orcid: shown ? storedOrcid(row.orcid) : null,
    };
  }
  // `pending` is the only other status that is not gone: its email is not
  // verified yet. A revoked account, and any value this code does not know,
  // reads as gone, which says the least.
  return row.status === "pending" ? { userId, state: "inactive" } : { userId, state: "gone" };
}

/**
 * Describe the accounts a caller names, on behalf of the visitor whose
 * credential it passes.
 *
 * Order of refusals: maintenance, then the shape of the request (which is
 * public and says nothing about any account), then the credential, then the
 * read. A request that is not worth a credential lookup does not cost one.
 */
export async function describeAccounts(
  env: Bindings,
  request: unknown,
  ctx?: BackgroundContext,
): Promise<DescribeAccountsResult> {
  if (maintenanceRefuses(env.MAINTENANCE_MODE, "read")) {
    return { ok: false, error: "unavailable" };
  }
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return INVALID_REQUEST;
  }
  const { credential, userIds: rawIds } = request as { credential?: unknown; userIds?: unknown };
  const userIds = distinctUserIds(rawIds);
  if (userIds === null) return INVALID_REQUEST;

  // The existing resolver, with its own maintenance check, its own bounds and
  // its own refusals, passed through unchanged. A missing or malformed
  // credential is its `invalid_credential`.
  const caller = await resolvePrincipal(env, credential, ctx);
  if (!caller.ok) return caller;

  // At most `DESCRIBE_ACCOUNTS_MAX` (100) binds, which is D1's limit per
  // statement, so this is always one read. `deleted_at IS NULL` is the rule
  // every auth lookup applies: a tombstone is gone (it is also `revoked`).
  const placeholders = userIds.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT id, status, username, given_name, family_name, orcid, orcid_verified, identity_conflict
       FROM users
      WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
  )
    .bind(...userIds)
    .all<DescribedRow>();

  const byId = new Map<number, DescribedRow>();
  for (const row of results) byId.set(row.id, row);
  return { ok: true, accounts: userIds.map((userId) => describeRow(userId, byId.get(userId))) };
}
