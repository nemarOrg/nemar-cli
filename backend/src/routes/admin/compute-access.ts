/**
 * The administrator's routes for compute access (epic #2021 phase D1, #2022; ADR 0118, the
 * compute-access addendum; ADR 0040 and 0042: a person's decision, and a grant of its own).
 *
 *   GET  /compute/access?state=&limit=&after=                  admin   a page of accounts with a compute-access state
 *   POST /compute/access/grant/:username                       admin   open compute access (and the default allocation)
 *   POST /compute/access/deny/:username                        admin   decline a request
 *   POST /compute/access/suspend/:username                     admin   pause access; freeze the pools, cancel live jobs
 *   POST /compute/access/revoke/:username                      admin   end access; the same, for good
 *   POST /compute/access/{grant|deny|suspend|revoke}/by-id/:id admin   the same, for an account with no username
 *
 * The by-id twins exist because a web account has `username = NULL` by design (migration 0026), so the
 * username-keyed route can never address one (#1012). Each pair shares ONE implementation
 * ({@link decide}), so the two addressing modes cannot come apart.
 *
 * EVERY DECISION IS ONE BATCH (`db.batch`, a single transaction): the state flip with its from-states in
 * the WHERE, the audit row only if the flip landed, and the rest guarded on the state the flip leaves, so
 * a decision that lost a race to another changes nothing but its own zero-row flip and answers 409
 * `stale_state`. A grant carries the owner's default allocation (Epic A's `GRANT_INSERT_SQL`, one entry
 * per pool word, an idempotency key per account so a re-grant after a suspension adds nothing; a zero
 * default grants nothing and the response says so) and the unfreezing of the account's pools. A
 * suspension and a revocation carry Epic A's release statements for the account and the end of its
 * compute OpenID Connect grants. No network call is made inside a batch: the Tapis cancels of live jobs
 * follow from the retried sweep. The person is mailed AFTER the commit and never inside it; a send that
 * fails leaves the decision standing and the response says `email_sent: false`.
 *
 * THESE ROUTES READ NO COMPUTE SWITCH. A decision is bookkeeping: it spends nothing and calls no Tapis,
 * so it works whether or not compute is on (the switch is read in the one place
 * `compute-source-scan.test.ts` pins). They never read or write `service_access` (ADR 0040).
 *
 * Refusals are `{ error: <sentence>, code: <word> }` with the words of `COMPUTE_ACCESS_ADMIN_ERROR_CODES`;
 * an invalid body or query names the fields and never echoes a value.
 */

import type { Context } from "hono";
import { z } from "zod";
import {
  COMPUTE_ACCESS_DECISIONS,
  COMPUTE_ACCESS_STATES,
  COMPUTE_DECISION_TARGET,
  type ComputeAccessDecision,
  type ComputeAccessState,
} from "../../../../shared/compute-access-state";
import type { ComputePool } from "../../../../shared/contract/compute";
import {
  COMPUTE_ACCESS_ADMIN_ERROR_STATUS,
  COMPUTE_ACCESS_PAGE_MAX,
  COMPUTE_ACCESS_REASON_MAX_CHARS,
  type ComputeAccessAccount,
  type ComputeAccessAdminErrorCode,
  type ComputeAccessAllocation,
} from "../../../../shared/contract/compute-access";
import { SYSTEM_USER_ID } from "../../lib/constants";
import { ACTIVE_ACCOUNT_STATUSES } from "../../services/account-tier";
import {
  DEFAULT_GRANT_INSERT_SQL,
  DEFAULT_GRANT_REASON,
  POOL_WORDS,
  UNFREEZE_POOLS_SQL,
  asState,
  decisionAllowed,
  decisionAuditStatement,
  decisionFlipStatement,
  defaultGrantKey,
  endComputeStatements,
} from "../../services/compute-access";
import type { DecisionStatement } from "../../services/compute-access";
import { ensurePool } from "../../services/compute-ledger";
import { ComputePolicyUnreadable, fieldPath, getPolicy } from "../../services/compute-policy";
import {
  type ComputeAccessDecisionMail,
  resolveEmailConfig,
  sendComputeAccessDecisionEmail,
} from "../../services/email";
import { appBase } from "../../services/environment";
import { backgroundOf, deferLogoutDelivery } from "../../services/oidc-logout";
import type { Bindings, Variables } from "../../types/bindings";
import type { AdminRouter } from "./shared";

type Ctx = Context<{ Bindings: Bindings; Variables: Variables }>;

const SENTENCES: Record<ComputeAccessAdminErrorCode, string> = {
  invalid_body: "The request body is not valid.",
  invalid_query: "The query is not valid.",
  account_not_found: "There is no such account.",
  not_requested: "That account has no open compute access request to decide.",
  not_active: "That account does not hold compute access.",
  already_active: "That account already holds compute access.",
  account_not_in_good_standing:
    "That account is deleted, revoked or not verified, so compute access cannot be granted to it.",
  self_decision:
    "An administrator cannot grant their own compute access; ask another administrator or an owner.",
  stale_state: "The account's compute access changed while this was being decided; read it again.",
  policy_unreadable: "The stored policy cannot be read, so nothing was granted.",
  internal: "The compute access routes failed unexpectedly.",
};

function refuse(c: Ctx, code: ComputeAccessAdminErrorCode, error?: string, extra: object = {}) {
  return c.json(
    { error: error ?? SENTENCES[code], code, ...extra },
    COMPUTE_ACCESS_ADMIN_ERROR_STATUS[code],
  );
}

/** A 400 that names the fields and what is wrong with each, never what was sent. */
function invalid(c: Ctx, code: "invalid_body" | "invalid_query", error: z.ZodError) {
  const fields = error.issues.slice(0, 20).map((i) => ({ path: fieldPath(i.path), code: i.code }));
  const named = fields.slice(0, 5).map((f) => `${f.path || "body"}: ${f.code}`);
  return refuse(c, code, `${SENTENCES[code]} ${named.join("; ")}`, { fields });
}

// --- The account, as the routes read and report it ---------------------------------------------

const ACCOUNT_COLUMNS = `id, username, email, given_name, family_name, affiliation, city, country, orcid,
  account_kind, status, deleted_at, compute_access, compute_access_requested_at,
  compute_access_notified_at, compute_access_granted_at, compute_access_granted_by, compute_purpose,
  compute_terms_version, compute_terms_accepted_at`;

export const ACCESS_ACCOUNT_BY_ID_SQL = `SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = ?1`;
export const ACCESS_ACCOUNT_BY_USERNAME_SQL = `SELECT ${ACCOUNT_COLUMNS} FROM users
  WHERE username = ?1 AND deleted_at IS NULL`;

interface AccountRow {
  id: number;
  username: string | null;
  email: string;
  given_name: string | null;
  family_name: string | null;
  affiliation: string | null;
  city: string | null;
  country: string | null;
  orcid: string | null;
  account_kind: string;
  status: string;
  deleted_at: string | null;
  compute_access: string;
  compute_access_requested_at: string | null;
  compute_access_notified_at: string | null;
  compute_access_granted_at: string | null;
  compute_access_granted_by: number | null;
  compute_purpose: string | null;
  compute_terms_version: string | null;
  compute_terms_accepted_at: string | null;
}

function accountView(row: AccountRow): ComputeAccessAccount {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    given_name: row.given_name,
    family_name: row.family_name,
    affiliation: row.affiliation,
    city: row.city,
    country: row.country,
    orcid: row.orcid,
    account_kind: row.account_kind,
    compute_access: row.compute_access,
    compute_access_requested_at: row.compute_access_requested_at,
    compute_access_notified_at: row.compute_access_notified_at,
    compute_access_granted_at: row.compute_access_granted_at,
    compute_access_granted_by: row.compute_access_granted_by,
    compute_purpose: row.compute_purpose,
    compute_terms_version: row.compute_terms_version,
    compute_terms_accepted_at: row.compute_terms_accepted_at,
  };
}

// --- The listing -------------------------------------------------------------------------------

/** `none` is every account that never asked, so it is not a listing state. */
const LISTED_STATES = COMPUTE_ACCESS_STATES.filter((s) => s !== "none") as [
  ComputeAccessState,
  ...ComputeAccessState[],
];

const listQuery = z
  .object({
    state: z.enum(LISTED_STATES).optional(),
    after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.coerce.number().int().min(1).max(COMPUTE_ACCESS_PAGE_MAX).default(50),
  })
  .strict();

/**
 * One page, ordered by account id (a stable cursor; an account asks once, so the order is the order the
 * accounts were made, not the order they asked in). `?1` the state or NULL for every listed state, `?2`
 * the cursor, `?3` one more than the page so the next page's start is known. Deleted accounts are left out.
 */
export const ACCESS_LIST_SQL = `SELECT ${ACCOUNT_COLUMNS} FROM users
  WHERE compute_access <> 'none' AND deleted_at IS NULL
    AND (?1 IS NULL OR compute_access = ?1)
    AND id > ?2
  ORDER BY id LIMIT ?3`;

// --- The decision ------------------------------------------------------------------------------

const decisionBody = z
  .object({ reason: z.string().max(COMPUTE_ACCESS_REASON_MAX_CHARS).optional() })
  .strict();

/** The body as JSON; `{}` for an empty body, null for something that is not JSON. */
async function readBody(c: Ctx): Promise<unknown | null> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The refusal a decision gets from the state it finds, or null when the state may take it. */
function stateRefusal(
  decision: ComputeAccessDecision,
  from: ComputeAccessState,
): ComputeAccessAdminErrorCode | null {
  if (decisionAllowed(decision, from)) return null;
  if (decision === "grant") return from === "active" ? "already_active" : "not_requested";
  if (decision === "deny") return "not_requested";
  return "not_active";
}

const MAIL_KIND: Record<ComputeAccessDecision, ComputeAccessDecisionMail> = {
  grant: "granted",
  deny: "denied",
  suspend: "suspended",
  revoke: "revoked",
};

/** Mail the person what was decided, after the commit. Never throws; false when nothing went. */
async function mailDecision(
  c: Ctx,
  decision: ComputeAccessDecision,
  row: AccountRow,
): Promise<boolean> {
  try {
    // A service account has no inbox a person reads, as for a job's results.
    if (row.account_kind === "service" || !row.email) return false;
    const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
    await sendComputeAccessDecisionEmail(
      MAIL_KIND[decision],
      row.email,
      row.given_name,
      `${appBase(c.env)}/compute`,
      c.env.RESEND_API_KEY,
      fromEmail,
      replyTo,
      isDev,
      c.env,
    );
    return true;
  } catch (err) {
    console.error(
      `[compute-access] the ${decision} mail for id=${row.id} was not sent:`,
      err instanceof Error ? err.name : "unknown error",
    );
    return false;
  }
}

/**
 * The shared implementation of the four decisions, for either addressing mode. `lookup` reads the account
 * (the route already answered 400 for a malformed id); everything else is the same for both.
 */
async function decide(
  c: Ctx,
  decision: ComputeAccessDecision,
  lookup: () => Promise<AccountRow | null>,
): Promise<Response> {
  const db = c.env.DB;
  const actor = c.get("user");
  try {
    const parsed = decisionBody.safeParse(await readBody(c));
    if (!parsed.success) return invalid(c, "invalid_body", parsed.error);
    const reason = parsed.data.reason?.trim() || null;

    const account = await lookup();
    if (!account) return refuse(c, "account_not_found");
    const from = asState(account.compute_access);

    const refusal = stateRefusal(decision, from);
    if (refusal) return refuse(c, refusal);

    // An administrator does not grant THEMSELVES compute access (an owner may). Deny, suspend and
    // revoke of oneself stay allowed: they only take access away.
    if (decision === "grant" && account.id === actor.id && actor.role !== "owner") {
      return refuse(c, "self_decision");
    }

    const via = c.get("authMethod") === "cookie" ? "web" : "cli";
    const to = COMPUTE_DECISION_TARGET[decision];
    const statements: DecisionStatement[] = [
      decisionFlipStatement(decision, actor.id, account.id, from),
      decisionAuditStatement({
        decision,
        from,
        actorId: actor.id,
        userId: account.id,
        reason,
        via,
      }),
    ];
    // The pools a grant writes into, with the amounts the owner's policy opens (milli-SU).
    const opened: Array<{ word: ComputePool; amount: number }> = [];
    let policyVersion: number | null = null;

    if (decision === "grant") {
      if (
        account.deleted_at !== null ||
        !(ACTIVE_ACCOUNT_STATUSES as readonly string[]).includes(account.status)
      ) {
        return refuse(c, "account_not_in_good_standing");
      }
      // Read BEFORE the batch: an unreadable policy fails closed and nothing is granted.
      const view = await getPolicy(db);
      policyVersion = view.version;
      for (const word of POOL_WORDS) {
        const amount = view.policy.defaultGrantMilli[word];
        if (amount > 0) {
          // A pool is made if it is not there (an idempotent insert of zero totals), so the entry has
          // a pool to name. A decision that then loses its race leaves a pool of zeros, which is nothing.
          const pool = await ensurePool(db, "account", String(account.id), word);
          opened.push({ word, amount });
          statements.push({
            sql: DEFAULT_GRANT_INSERT_SQL,
            binds: [
              pool.id,
              amount,
              actor.id,
              DEFAULT_GRANT_REASON,
              defaultGrantKey(account.id, word),
              account.id,
            ],
          });
        }
      }
      statements.push({ sql: UNFREEZE_POOLS_SQL, binds: [String(account.id), account.id] });
    } else if (decision === "suspend" || decision === "revoke") {
      statements.push(
        ...endComputeStatements(account.id, decision === "suspend" ? "suspended" : "revoked"),
      );
    }

    const results = await db.batch(statements.map((s) => db.prepare(s.sql).bind(...s.binds)));

    if ((results[0]?.meta?.changes ?? 0) === 0) {
      // The flip matched nothing: the state, or the account's standing, changed since it was read.
      const now = await db.prepare(ACCESS_ACCOUNT_BY_ID_SQL).bind(account.id).first<AccountRow>();
      if (now && decision === "grant" && asState(now.compute_access) !== "active") {
        const standing =
          now.deleted_at !== null ||
          !(ACTIVE_ACCOUNT_STATUSES as readonly string[]).includes(now.status);
        if (standing) return refuse(c, "account_not_in_good_standing");
      }
      return refuse(c, "stale_state");
    }

    if (decision === "suspend" || decision === "revoke") {
      // The logouts the batch queued for the compute clients are tried once now, after the response, so
      // no partner can slow or fail the decision; a partner that fails leaves it standing (the tick retries).
      deferLogoutDelivery(c.env, account.id, backgroundOf(c));
    }

    const after = await db.prepare(ACCESS_ACCOUNT_BY_ID_SQL).bind(account.id).first<AccountRow>();
    const emailSent = await mailDecision(c, decision, account);

    let allocation: ComputeAccessAllocation | undefined;
    if (decision === "grant") {
      const written = (word: ComputePool) => {
        const at = opened.findIndex((o) => o.word === word);
        // The grant statements follow the flip and its audit row, in `opened` order.
        return at >= 0 && (results[2 + at]?.meta?.changes ?? 0) > 0;
      };
      const milli = (word: ComputePool) =>
        written(word) ? (opened.find((o) => o.word === word)?.amount ?? 0) : 0;
      const wrote = POOL_WORDS.some(written);
      allocation = {
        granted: wrote,
        cpu_milli: milli("cpu"),
        gpu_milli: milli("gpu"),
        reason: wrote ? null : opened.length === 0 ? "policy_default_zero" : "already_granted",
        policy_version: policyVersion,
      };
    }

    return c.json({
      decision,
      from,
      to,
      account: accountView(after ?? account),
      ...(allocation ? { allocation } : {}),
      email_sent: emailSent,
    });
  } catch (err) {
    if (err instanceof ComputePolicyUnreadable) return refuse(c, "policy_unreadable");
    console.error(
      `[admin/compute-access] ${decision} failed:`,
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
    return refuse(c, "internal");
  }
}

// --- Registration ------------------------------------------------------------------------------

export function registerComputeAccessAdminRoutes(admin: AdminRouter): void {
  admin.get("/compute/access", async (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success) return invalid(c, "invalid_query", parsed.error);
    const { state, after, limit } = parsed.data;
    try {
      const { results } = await c.env.DB.prepare(ACCESS_LIST_SQL)
        .bind(state ?? null, after ?? 0, limit + 1)
        .all<AccountRow>();
      const page = results.slice(0, limit);
      return c.json({
        accounts: page.map(accountView),
        next_after: results.length > limit ? (page[page.length - 1]?.id ?? null) : null,
      });
    } catch (err) {
      console.error(
        "[admin/compute-access] list failed:",
        err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      );
      return refuse(c, "internal");
    }
  });

  for (const decision of COMPUTE_ACCESS_DECISIONS) {
    admin.post(`/compute/access/${decision}/:username`, (c) =>
      decide(c, decision, () =>
        c.env.DB.prepare(ACCESS_ACCOUNT_BY_USERNAME_SQL)
          .bind(c.req.param("username"))
          .first<AccountRow>(),
      ),
    );

    admin.post(`/compute/access/${decision}/by-id/:id`, async (c) => {
      const raw = c.req.param("id");
      const id = /^[1-9][0-9]{0,14}$/.test(raw) ? Number(raw) : 0;
      if (!Number.isSafeInteger(id) || id <= 0 || id === SYSTEM_USER_ID) {
        return refuse(c, "invalid_query", "That is not an account id (a whole number from 1).");
      }
      return decide(c, decision, async () => {
        const row = await c.env.DB.prepare(ACCESS_ACCOUNT_BY_ID_SQL).bind(id).first<AccountRow>();
        return row && row.deleted_at === null ? row : null;
      });
    });
  }
}
