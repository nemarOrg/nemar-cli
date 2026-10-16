/**
 * Who the dataset pull-request review does not apply to (ADR 0107).
 *
 * A pull request opened by a NEMAR owner or administrator is not reviewed: the review stands in for
 * an administrator's judgment of someone else's change, and an administrator needs no stand-in for
 * their own. This module is the ONE place a NEMAR role is read for that purpose. Every caller (the
 * webhook intake, the allowance check, the admin queue) asks {@link isReviewExempt}; none of them
 * knows a role, an account kind or a login.
 *
 * **The rule is an identity match.** A GitHub login is exempt only when it is the `github_username`
 * of a live NEMAR account that is approved, holds the `owner` or `admin` role, and is a person or a
 * service account. The match ignores case, as GitHub does. An account of kind `test` is never
 * exempt (ADR 0048): a persona is not a real identity, whatever role it holds. No login is written
 * into this code, so adding or removing an owner or administrator changes who is exempt and nothing
 * else has to.
 *
 * **Nothing stores the answer.** No column holds it, and every call reads `users` again, so a
 * demotion, a revocation or a deleted account ends the exemption on the very next pull request.
 *
 * A database failure throws, like every read in the review's intake: the webhook answers 500 and
 * the delivery can be redelivered.
 */

import type { AccountKind } from "../../../shared/contract/user.js";
import type { Bindings, UserRole } from "../types/bindings.js";

/** The NEMAR roles whose pull requests are not reviewed. */
export const REVIEW_EXEMPT_ROLES = ["owner", "admin"] as const satisfies readonly UserRole[];

/**
 * The account kinds that can be exempt. `test` is not one of them (ADR 0048): a test persona is a
 * person's secondary account and not a real identity, so no role it is given makes its pull
 * requests skip the review.
 */
export const REVIEW_EXEMPT_KINDS = ["person", "service"] as const satisfies readonly AccountKind[];

/** A SQL list literal, rendered from a constant list (the same construction as `docs-auth.ts`). */
const sqlList = (words: readonly string[]): string => `(${words.map((w) => `'${w}'`).join(", ")})`;

/**
 * One live, approved owner or administrator whose GitHub login is the one asked about. Binds: login.
 *
 * The role and kind lists are rendered from the constants above rather than spelled beside them, so
 * the rule has one definition. The comparison carries `COLLATE NOCASE` so it is the same collation
 * as `idx_users_github` (unique, `github_username COLLATE NOCASE`) and the lookup is an index
 * search; a test reads the query plan. `deleted_at IS NULL` is there for the same reason it is
 * everywhere an account is looked up: a tombstoned row keeps no usable handle, and one that did must
 * not exempt anyone.
 */
export const REVIEW_EXEMPT_SQL = `SELECT 1 AS exempt FROM users
  WHERE github_username = ? COLLATE NOCASE
    AND role IN ${sqlList(REVIEW_EXEMPT_ROLES)}
    AND status = 'approved'
    AND deleted_at IS NULL
    AND account_kind IN ${sqlList(REVIEW_EXEMPT_KINDS)}
  LIMIT 1`;

/** A GitHub login: letters, digits and single hyphens, at most 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Whose pull request this is, and where. `repo` is the dataset id (the repository's name). */
export interface ReviewExemptSubject {
  login: string;
  repo: string;
}

/**
 * Whether this GitHub login is exempt from the review on this dataset. A login that is not shaped
 * like one is never exempt and is not looked up.
 */
export async function isReviewExempt(env: Bindings, who: ReviewExemptSubject): Promise<boolean> {
  if (!GITHUB_LOGIN.test(who.login)) return false;
  const row = await env.DB.prepare(REVIEW_EXEMPT_SQL).bind(who.login).first<{ exempt: number }>();
  return row !== null;
}
