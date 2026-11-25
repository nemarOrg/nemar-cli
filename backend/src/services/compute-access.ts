/**
 * Compute access: the person's one request, and the administrator's decisions (epic #2021 phase D1,
 * #2022; ADR 0118, the compute-access addendum; ADR 0040, 0042, 0043, 0045, 0048, 0106).
 *
 * COMPUTE ACCESS IS ITS OWN GRANT. `users.compute_access` (migration 0131) is read and written here and
 * in the routes that call this file, and `service_access` is read and written by none of them (ADR 0040:
 * upload approval is its single writer). A source scan holds that (`compute-access-source-scan.test.ts`).
 * The states and the edges are `shared/compute-access-state.ts`; this file is the Worker's half.
 *
 * THE REQUEST. A verified person with a proven ORCID iD asks ONCE (ADR 0042). `checkComputeAccessRequest`
 * is the rulebook and is pure, so the order of its answers is testable without a Worker: the text the
 * person just typed first (the purpose, then the terms version), then their account's own step (the
 * inbox), then the proof of who they are (the ORCID iD), then the profile gaps that stop THIS grant, all at
 * once. Every refusal is `{ error, message, missing }` with a code from `COMPUTE_ACCESS_ERROR_CODES`.
 *
 * "ORCID PROVEN" IS A ROW, NOT A FLAG. `users.orcid_verified` can be set by an owner without any sign-in
 * (ADR 0106), and an administrator's compute review is a judgement about a person, so the proof here is
 * an `oauth_identities` row for provider `orcid`, which only a real ORCID sign-in writes. The `service`
 * and `test` kinds are exempt (ADR 0048): a service account has no human to prove an identity, and a test
 * persona is a human's secondary account.
 *
 * THE DECISIONS. Each is ONE batch built here and run by the route: the state flip with its from-state in
 * the WHERE (a lost race writes nothing), the audit row only if the flip landed, and the rest guarded on
 * the state the flip leaves, so a decision that lost a race changes nothing else. A grant carries the
 * owner's default allocation and the unfreezing of the person's pools; a suspension and a revocation carry
 * Epic A's release statements for the account and the end of its compute OpenID Connect grants. No
 * network call is made inside a batch: a live job is canceled at Tapis by the retried sweep.
 *
 * THE FREEZE HAS TWO CAUSES AND ONE BIT. A pool is frozen by the end of the ACCOUNT
 * (`finalizeRevocation`, `tombstoneUserCascade`) and by the end of COMPUTE (a suspension or a revocation
 * here). Lifting one must not lift the other (ADR 0118, A8 amendment, item 3), so the bit is derived from
 * the access state: a pool is unfrozen only by a GRANT, and a grant is refused unless the account is in
 * good standing (not deleted, status `verified` or `approved`). An account that was revoked, then put
 * back, stays refused for compute until an administrator grants it.
 */

import {
  COMPUTE_ACCESS_STATES,
  COMPUTE_DECISION_FROM,
  COMPUTE_DECISION_TARGET,
  type ComputeAccessDecision,
  type ComputeAccessState,
  canTransition,
} from "../../../shared/compute-access-state.js";
import { ACCOUNT_COPY } from "../../../shared/contract/account-copy.js";
import {
  COMPUTE_PURPOSE_MAX_CHARS,
  COMPUTE_PURPOSE_MIN_CHARS,
  type ComputeAccessErrorCode,
  type ComputeAccessRefusal,
  hasPurposeControlChar,
} from "../../../shared/contract/compute-access.js";
import {
  COMPUTE_TERMS_PUBLISHED,
  COMPUTE_TERMS_VERSION,
} from "../../../shared/contract/compute-terms.js";
import { COMPUTE_POOLS, type ComputePool } from "../../../shared/contract/compute.js";
import { profileGapFields } from "../../../shared/contract/profile-gaps.js";
import type { AccountKind } from "../../../shared/contract/user.js";
import { OIDC_COMPUTE_SCOPE_PREFIX } from "../../../shared/oidc.js";
import { AUDIT_IF_PREVIOUS_CHANGED_SQL } from "../db/audit-log";
import type { Bindings } from "../types/bindings";
import { ACTIVE_ACCOUNT_STATUSES } from "./account-tier";
import { GRANT_INSERT_SQL } from "./compute-ledger";
import { type ComputeReleaseStatement, computeReleaseStatements } from "./compute-release";
import { oidcEndStatements } from "./oidc-cascade";
import { isExactProduction } from "./repull-switches";

// --- The request -------------------------------------------------------------------------------

/** The purpose bounds the rule and the migration's CHECK share, re-exported for the route and the tests. */
export const PURPOSE_MIN_CHARS = COMPUTE_PURPOSE_MIN_CHARS;
export const PURPOSE_MAX_CHARS = COMPUTE_PURPOSE_MAX_CHARS;

/** The length of a text in code points, the unit SQLite's `length()` counts in (a JavaScript `length` counts UTF-16 units). */
export function purposeLength(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/**
 * The account columns the request reads. Every field REQUIRED, so a SELECT that forgets one is a
 * compile error and not a silently narrower refusal (the failure mode a gap computed from a partial
 * row has).
 */
export interface ComputeAccessProfile {
  email_verified: number;
  /** An `oauth_identities` row for provider `orcid` exists: a real ORCID sign-in, not the `orcid_verified` flag. */
  orcid_proven: boolean;
  /** `service` and `test` kinds are exempt from the ORCID proof (ADR 0048). */
  account_kind: AccountKind;
  given_name: string | null;
  family_name: string | null;
  affiliation: string | null;
  city: string | null;
  country: string | null;
}

export interface ComputeAccessRequestInput {
  purpose: string;
  accept_terms_version: string;
}

function refusal(
  error: ComputeAccessErrorCode,
  message: string,
  missing: string[] = [],
): ComputeAccessRefusal {
  return { error, message, missing };
}

/**
 * Check everything that can be decided from the account row plus the submitted text. Returns the refusal
 * to send, or null when the request may be recorded. ORDER IS DELIBERATE, and is the only thing a caller
 * with several problems at once experiences:
 *
 *  1. `purpose_required`: the text the person JUST typed, so nobody is sent to fix their profile because
 *     of a typo in the field in front of them.
 *  2. `terms_not_accepted`: the other thing they just sent. Terms that were not accepted are not a
 *     profile problem either.
 *  3. `email_not_verified`: the account's own step, with its own endpoint; every message about this
 *     request goes to that address.
 *  4. `orcid_not_proven`: who they are, proven by a sign-in (`missing: ["orcid_verified"]`).
 *  5. `profile_incomplete`: the remaining gaps that stop compute access, AT ONCE.
 *
 * The gap list is `profileGapFields(..., "compute_access")` over the same matrix `/users/me` reports, so a
 * refusal and a status nudge cannot name different fields (ADR 0045). It is split at `email_verified`
 * because the inbox has its own code; the ORCID flag is not in the compute list at all (the proof is the
 * row above).
 */
export function checkComputeAccessRequest(
  profile: ComputeAccessProfile,
  input: ComputeAccessRequestInput,
): ComputeAccessRefusal | null {
  const purpose = input.purpose.trim();
  const chars = purposeLength(purpose);
  if (chars < PURPOSE_MIN_CHARS || chars > PURPOSE_MAX_CHARS) {
    return refusal(
      "purpose_required",
      `Describe what you intend to compute in ${PURPOSE_MIN_CHARS}-${PURPOSE_MAX_CHARS} characters`,
      ["purpose"],
    );
  }
  if (hasPurposeControlChar(purpose)) {
    return refusal(
      "purpose_required",
      "Describe what you intend to compute in plain text, without control characters (newlines and tabs are fine)",
      ["purpose"],
    );
  }

  if (input.accept_terms_version !== COMPUTE_TERMS_VERSION) {
    return refusal(
      "terms_not_accepted",
      `Accept the compute terms (version ${COMPUTE_TERMS_VERSION}) to request compute access`,
      ["accept_terms_version"],
    );
  }

  const gaps = profileGapFields(
    {
      email_verified: profile.email_verified === 1,
      given_name: profile.given_name,
      family_name: profile.family_name,
      affiliation: profile.affiliation,
      city: profile.city,
      country: profile.country,
    },
    "compute_access",
  );

  if (gaps.includes("email_verified")) {
    return refusal(
      "email_not_verified",
      "Verify your email address before requesting compute access; the review happens over email",
      ["email_verified"],
    );
  }

  const exempt = profile.account_kind === "service" || profile.account_kind === "test";
  if (!profile.orcid_proven && !exempt) {
    return refusal(
      "orcid_not_proven",
      "Prove your ORCID iD by signing in with ORCID before requesting compute access",
      ["orcid_verified"],
    );
  }

  if (gaps.length > 0) {
    return refusal(
      "profile_incomplete",
      `Complete your profile before requesting compute access: ${gaps.join(", ")}`,
      gaps,
    );
  }

  return null;
}

/** The 409 for an account that already holds compute access. `missing` is empty so every refusal has one shape. */
export const ALREADY_ACTIVE_REFUSAL: ComputeAccessRefusal = refusal(
  "already_active",
  "This account already has compute access; there is nothing to request",
);

/**
 * The 409 for a request that was answered (denied or revoked): a person asks once, and an administrator
 * re-opens it by granting. The message IS the shared copy, so the website, the CLI and this body say one thing.
 */
export const ACCESS_CLOSED_REFUSAL: ComputeAccessRefusal = refusal(
  "access_closed",
  ACCOUNT_COPY["compute_access.closed.body"],
);

/**
 * The same code for a SUSPENDED account, with its own words: its access exists and is paused, so it is
 * not told its request "has been answered and cannot be asked again". No new code (a client switches on
 * `access_closed`); the message differs.
 */
export const ACCESS_SUSPENDED_REFUSAL: ComputeAccessRefusal = refusal(
  "access_closed",
  ACCOUNT_COPY["compute_access.suspended.body"],
);

/** The refusal for an account in `denied`, `revoked` or `suspended`. */
export function closedRefusalFor(state: ComputeAccessState): ComputeAccessRefusal {
  return state === "suspended" ? ACCESS_SUSPENDED_REFUSAL : ACCESS_CLOSED_REFUSAL;
}

/** The 503 while the compute terms are not published (exact production only). */
export const TERMS_UNPUBLISHED_REFUSAL: ComputeAccessRefusal = refusal(
  "terms_unpublished",
  ACCOUNT_COPY["compute_access.terms_unpublished.body"],
);

/**
 * Whether a request must be refused because the terms are not published: the exact production
 * environment (no trim, no case fold, unset is not production) while `COMPUTE_TERMS_PUBLISHED` is
 * false. Other environments take requests, so the flow is built and tested before publication.
 */
export function termsUnpublished(env: Pick<Bindings, "ENVIRONMENT">): boolean {
  return isExactProduction(env) && !COMPUTE_TERMS_PUBLISHED;
}

/** The row the request reads. `orcid_proven` is the existence of the identity row, not a flag. */
export const COMPUTE_ACCESS_REQUEST_ROW_SQL = `SELECT id, username, email, given_name, family_name, github_username,
         city, country, affiliation, orcid, account_kind, email_verified,
         compute_access, compute_access_requested_at, compute_access_notified_at, compute_purpose, compute_terms_version,
         EXISTS (SELECT 1 FROM oauth_identities oi
                  WHERE oi.user_id = users.id AND oi.provider = 'orcid') AS orcid_proven
    FROM users
   WHERE id = ? AND deleted_at IS NULL`;

/**
 * Open the request, once: only an account at `none`, not deleted, writes it, so `meta.changes` is what
 * decides which of two concurrent requests mails. `?1` the purpose (trimmed), `?2` the terms version, `?3`
 * the account. The stamps are history and are not cleared by a later decision.
 */
export const COMPUTE_ACCESS_REQUEST_UPDATE_SQL = `UPDATE users
    SET compute_access = 'requested',
        compute_access_requested_at = datetime('now'),
        compute_purpose = ?1,
        compute_terms_version = ?2,
        compute_terms_accepted_at = datetime('now'),
        updated_at = datetime('now')
  WHERE id = ?3 AND compute_access = 'none' AND deleted_at IS NULL`;

/**
 * Stamp that at least one administrator was told, once: conditional on it still being NULL so two
 * concurrent retries stamp one timestamp and a later re-send never moves it. `?1` the account.
 */
export const COMPUTE_ACCESS_NOTIFIED_SQL = `UPDATE users
    SET compute_access_notified_at = datetime('now')
  WHERE id = ?1 AND compute_access_notified_at IS NULL AND compute_access = 'requested'`;

/** The audit row of a request: the shape of the event, never the prose (ADR 0036). */
export function requestAuditDetails(purpose: string, via: "web" | "cli"): string {
  return JSON.stringify({ via, why_chars: purposeLength(purpose) });
}

// --- The decisions -----------------------------------------------------------------------------

/** The audit action of each decision. */
export const DECISION_AUDIT_ACTION: Readonly<Record<ComputeAccessDecision, string>> = {
  grant: "compute_access_granted",
  deny: "compute_access_denied",
  suspend: "compute_access_suspended",
  revoke: "compute_access_revoked",
};

/** The account's standing, as a WHERE term over `users` with no alias: not deleted, status verified or approved. */
const GOOD_STANDING = `deleted_at IS NULL AND status IN (${ACTIVE_ACCOUNT_STATUSES.map((s) => `'${s}'`).join(", ")})`;

const FROM_LIST = (decision: ComputeAccessDecision): string =>
  COMPUTE_DECISION_FROM[decision].map((s) => `'${s}'`).join(", ");

/**
 * The state flip of a decision. A grant binds `?1` the actor, `?2` the account and `?3` the state the
 * administrator READ; the others bind `?1` the account and `?2` the state read. BOTH the observed state
 * and the list of states the decision may start from are in the WHERE: the list alone would let a
 * decision made on a stale read land on a state it was never shown (two administrators read `suspended`,
 * one revokes, and the other's grant would then match `revoked`, reopen the account, unfreeze its pools,
 * open the allocation and record the wrong `from`). A decision on a state that moved matches nothing and
 * answers 409 `stale_state`. A grant is also refused for an account that is not in good standing (see the
 * header, on the freeze) and for an administrator granting THEMSELVES: the `admin` role may not, an `owner`
 * may (the route answers 409 `self_decision` first; the flip says it again so a caller that skipped the
 * route writes nothing). A grant stamps who and when, over the previous grant's stamps: they are the
 * history of the LATEST grant, and are never cleared by a decision.
 */
export const DECISION_UPDATE_SQL: Readonly<Record<ComputeAccessDecision, string>> = {
  grant: `UPDATE users
    SET compute_access = '${COMPUTE_DECISION_TARGET.grant}',
        compute_access_granted_at = datetime('now'),
        compute_access_granted_by = ?1,
        updated_at = datetime('now')
  WHERE id = ?2 AND compute_access = ?3 AND compute_access IN (${FROM_LIST("grant")})
    AND ${GOOD_STANDING}
    AND (?1 <> ?2 OR (SELECT role FROM users WHERE id = ?1) = 'owner')`,
  deny: `UPDATE users
    SET compute_access = '${COMPUTE_DECISION_TARGET.deny}', updated_at = datetime('now')
  WHERE id = ?1 AND compute_access = ?2 AND compute_access IN (${FROM_LIST("deny")})
    AND deleted_at IS NULL`,
  suspend: `UPDATE users
    SET compute_access = '${COMPUTE_DECISION_TARGET.suspend}', updated_at = datetime('now')
  WHERE id = ?1 AND compute_access = ?2 AND compute_access IN (${FROM_LIST("suspend")})
    AND deleted_at IS NULL`,
  revoke: `UPDATE users
    SET compute_access = '${COMPUTE_DECISION_TARGET.revoke}', updated_at = datetime('now')
  WHERE id = ?1 AND compute_access = ?2 AND compute_access IN (${FROM_LIST("revoke")})
    AND deleted_at IS NULL`,
};

/**
 * A guard appended to a statement of a decision, so a decision that lost its race changes nothing but
 * its own (zero-row) flip: true only while the account is in the state the flip leaves. Two plain `?`
 * placeholders (the account, the state) placed after the statement's own, which is why every statement it
 * is appended to ends in a predicate that takes an `AND`.
 */
export const STATE_GUARD_SQL =
  " AND EXISTS (SELECT 1 FROM users WHERE id = ? AND compute_access = ?)";

/** One statement of a decision's batch: text and binds, for the caller to prepare on its own D1. */
export interface DecisionStatement {
  sql: string;
  binds: unknown[];
}

const guarded = (
  s: ComputeReleaseStatement | DecisionStatement,
  userId: number,
  state: string,
): DecisionStatement => ({
  sql: s.sql + STATE_GUARD_SQL,
  binds: [...s.binds, userId, state],
});

/** The audit row of a decision, only if the flip before it landed. */
export function decisionAuditStatement(input: {
  decision: ComputeAccessDecision;
  from: ComputeAccessState;
  actorId: number;
  userId: number;
  reason: string | null;
  via: "web" | "cli";
}): DecisionStatement {
  return {
    sql: AUDIT_IF_PREVIOUS_CHANGED_SQL,
    binds: [
      input.actorId,
      DECISION_AUDIT_ACTION[input.decision],
      "user",
      String(input.userId),
      JSON.stringify({
        decision: input.decision,
        from: input.from,
        to: COMPUTE_DECISION_TARGET[input.decision],
        reason: input.reason,
        via: input.via,
      }),
    ],
  };
}

/** The flip itself, bound to the state the administrator read (`from`). */
export function decisionFlipStatement(
  decision: ComputeAccessDecision,
  actorId: number,
  userId: number,
  from: ComputeAccessState,
): DecisionStatement {
  return {
    sql: DECISION_UPDATE_SQL[decision],
    binds: decision === "grant" ? [actorId, userId, from] : [userId, from],
  };
}

/**
 * What a suspension or a revocation does to the account's compute, in one place (epic #2021 phase D1):
 * Epic A's release statements for the account (every live job records `account_ended`, a job that never
 * reached Tapis is canceled with its hold released, every pool is frozen) and the end of the account's
 * compute OpenID Connect grants (only those that carry a `compute.` scope, and only their clients are told).
 * Each is guarded on the state the flip leaves.
 *
 * THIS FUNCTION IS ONE OF THE CALLERS of `computeReleaseStatements` (`COMPUTE_END_CALLERS`) and of
 * `oidcEndStatements` (`OIDC_END_CALLERS`): a role demotion and a key revocation still end neither.
 * Nothing here calls Tapis or the network; the retried sweep cancels at Tapis.
 */
export function endComputeStatements(
  userId: number,
  to: Extract<ComputeAccessState, "suspended" | "revoked">,
): DecisionStatement[] {
  return [
    ...computeReleaseStatements(userId).map((s) => guarded(s, userId, to)),
    ...oidcEndStatements(userId, "compute_suspended", {
      scopePrefix: OIDC_COMPUTE_SCOPE_PREFIX,
    }).map((s) => guarded(s, userId, to)),
  ];
}

// --- The default allocation --------------------------------------------------------------------

/** The ledger key of an account's default grant of one pool: one per account and word, so a re-grant adds nothing. */
export const defaultGrantKey = (userId: number, pool: ComputePool): string =>
  `compute_access_grant:${userId}:${pool}`;

/**
 * Epic A's grant (`GRANT_INSERT_SQL`), guarded on the account being `active`: `?1` pool, `?2` amount, `?3`
 * actor, `?4` reason, `?5` key, `?6` the account. The statement is the ledger's own, with one term
 * appended, so a grant that lost a race to a revocation writes nothing and the statement cannot drift
 * from the ledger's. The trigger is the only writer of the totals.
 */
export const DEFAULT_GRANT_INSERT_SQL = `${GRANT_INSERT_SQL}
     AND EXISTS (SELECT 1 FROM users WHERE id = ?6 AND compute_access = '${COMPUTE_DECISION_TARGET.grant}')`;

/** The ledger reason the default grant is written with: Epic A's `grant`, the actor naming the administrator. */
export const DEFAULT_GRANT_REASON = "grant";

/**
 * Unfreeze an account's pools, only for an account that is `active` and in good standing. A grant is the
 * ONLY thing that unfreezes (see the header, on the two causes of the freeze). `?1` the account id as text
 * (the holder of an account's pool), `?2` the account id.
 */
export const UNFREEZE_POOLS_SQL = `UPDATE compute_pools
    SET frozen = 0, updated_at = datetime('now')
  WHERE holder_kind = 'account' AND holder_ref = ?1 AND frozen = 1
    AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND compute_access = 'active' AND ${GOOD_STANDING})`;

/** The two pool words, cpu first. */
export const POOL_WORDS: readonly ComputePool[] = COMPUTE_POOLS;

/** A state that is not one of the six (a column read back that the CHECK should have refused): fail closed. */
export function asState(value: unknown): ComputeAccessState {
  if (typeof value === "string" && (COMPUTE_ACCESS_STATES as readonly string[]).includes(value)) {
    return value as ComputeAccessState;
  }
  throw new RangeError("compute_access is not one of the six states");
}

/** Whether a decision may be taken from a state, by the state machine and not by the SQL. */
export function decisionAllowed(
  decision: ComputeAccessDecision,
  from: ComputeAccessState,
): boolean {
  return canTransition(from, COMPUTE_DECISION_TARGET[decision]);
}
