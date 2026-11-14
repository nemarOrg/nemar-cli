/**
 * Eligibility for the explicit administrative naming-rule override (ADR 0107).
 *
 * This module does not decide whether an automatic pull-request review runs: every otherwise
 * reviewable pull request is reviewed regardless of author role (ADR 0120). The separate
 * `pr-reviews allow` operation remains limited to an owner or administrator author and uses this
 * module to verify the linked NEMAR account and GitHub's repository role. No webhook gate or queue
 * calls `isReviewExempt`.
 *
 * Eligibility requires a live, approved NEMAR owner/admin account of kind `person` or `service`
 * (never `test`; ADR 0048), matched case-insensitively to the GitHub login, plus GitHub reporting
 * the repository `admin` role on this repository. The result is never cached. Database failures
 * throw; GitHub failures return `unknown`, and the explicit override fails closed.
 */

import type { AccountKind } from "../../../shared/contract/user.js";
import type { Bindings, UserRole } from "../types/bindings.js";
import { getDatasetsTokenWithRefresher } from "./github-auth.js";
import { GITHUB_API, ORG_NAME, ghHeaders } from "./github/shared.js";
import { githubFetchWithRetry } from "./github/transport.js";

/** NEMAR roles eligible to use the explicit naming-rule override. */
export const REVIEW_EXEMPT_ROLES = ["owner", "admin"] as const satisfies readonly UserRole[];

/**
 * The account kinds eligible for the explicit naming-rule override. `test` is not one of them
 * (ADR 0048): a test persona is not a real identity.
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
 * not authorize the override.
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
 * The longest the question to GitHub may take before override eligibility becomes `unknown`. It
 * runs inside the webhook's own request, which GitHub gives ten seconds, and a
 * pusher other than the author is a second question.
 */
let permissionTimeoutMs = 4_000;

export function __setPermissionTimeoutForTests(ms: number | null): void {
  permissionTimeoutMs = ms ?? 4_000;
}

/** The repository role GitHub reports for a login: `role_name`, which is finer than `permission`. */
const ADMIN_ROLE = "admin";

/**
 * What GitHub says about this login on this repository: `admin` when it holds the `admin` role,
 * `not_admin` when GitHub answered and it does not (a login GitHub does not know, 404, is an answer
 * too), and `unknown` when GitHub did not say: a refusal, a throttle, a timeout, no token to ask
 * with, or a body that is not an object with a string `role_name`. Never throws. `role_name`, not
 * the legacy `permission` field: `permission` folds `maintain` into `write` and cannot tell a role
 * apart.
 *
 * The endpoint answers `read` for ANY login on a public repository, so only an explicit `admin`
 * means anything here.
 */
async function repositoryRole(
  env: Bindings,
  who: ReviewExemptSubject,
): Promise<"admin" | "not_admin" | "unknown"> {
  try {
    const { token, refresh } = await getDatasetsTokenWithRefresher(env);
    const res = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${encodeURIComponent(who.repo)}/collaborators/${encodeURIComponent(who.login)}/permission`,
      { headers: ghHeaders(token), signal: AbortSignal.timeout(permissionTimeoutMs) },
      { kind: "interactive", maxAttempts: 2, maxThrottleMs: 2_000, refreshTokenOn401: refresh },
    );
    if (!res.ok) {
      // A login GitHub does not know is an answer (an account that names a login nobody holds).
      // Other failures mean the explicit override cannot be authorized.
      const line = `[pr-review-naming-override] ${who.repo}: GitHub answered HTTP ${res.status} to the permission check; override not authorized`;
      if (res.status === 404) {
        console.warn(line);
        return "not_admin";
      }
      console.error(line);
      return "unknown";
    }
    const body: unknown = await res.json().catch(() => null);
    const role =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>).role_name
        : undefined;
    if (typeof role !== "string") {
      // The answer is not the shape this reads. Fail closed and surface the fixed category.
      console.error(
        `[pr-review-naming-override] ${who.repo}: the permission check answered with no usable role_name; override not authorized`,
      );
      return "unknown";
    }
    return role === ADMIN_ROLE ? "admin" : "not_admin";
  } catch (err) {
    // Fixed words and the error's own message (a status or a timeout), never a token or a login.
    console.error(
      `[pr-review-naming-override] ${who.repo}: the permission check failed (${err instanceof Error ? err.message.slice(0, 120) : "unknown"}); override not authorized`,
    );
    return "unknown";
  }
}

/**
 * Whether this GitHub login is eligible for the explicit naming-rule override on this dataset: a
 * live, approved owner or administrator account holds it (the query), and GitHub agrees that it
 * holds `admin` on the repository. This result does not affect automatic review intake. A login
 * that is not shaped like one is not looked up, and GitHub is asked only after the account query
 * matches. Nothing is remembered between calls.
 */
export async function isReviewExempt(env: Bindings, who: ReviewExemptSubject): Promise<boolean> {
  return (await reviewExemption(env, who)) === "exempt";
}

/**
 * {@link isReviewExempt}, with GitHub's silence kept apart: `unknown` when the account matches and
 * GitHub did not answer. The explicit override must not mistake that for a confirmed ineligible
 * author.
 */
export async function reviewExemption(
  env: Bindings,
  who: ReviewExemptSubject,
): Promise<"exempt" | "not_exempt" | "unknown"> {
  if (!GITHUB_LOGIN.test(who.login)) return "not_exempt";
  const row = await env.DB.prepare(REVIEW_EXEMPT_SQL).bind(who.login).first<{ exempt: number }>();
  // `!row`, not `=== null`: anything but a row is "no account", whatever D1 answers with.
  if (!row) return "not_exempt";
  const role = await repositoryRole(env, who);
  return role === "admin" ? "exempt" : role === "not_admin" ? "not_exempt" : "unknown";
}
