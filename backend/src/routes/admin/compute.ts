/**
 * The compute gateway's owner and admin routes: the policy and the allocation pools (epic #2005
 * phase A2, #2007; ADR 0118). The wire words and the shapes the CLI parses are in
 * shared/contract/compute-admin.ts.
 *
 *   GET  /compute/policy                              owner     the policy in force
 *   PUT  /compute/policy                              owner     the next version (audited)
 *   GET  /compute/pools                               admin     a page of pools
 *   GET  /compute/pools/by-id/:accountId              admin     one account's pools
 *   POST /compute/pools/by-id/:accountId/grant        admin     SU into an account's pool
 *   POST /compute/pools/by-id/:accountId/adjust       admin     a correction of its grant or charge
 *   POST /compute/pools/platform/:key/grant           owner     SU into a platform budget
 *   POST /compute/pools/platform/:key/adjust          owner     a correction of a platform budget
 *
 * Admin-only through the router's middleware; the owner-only routes check the role here and say so
 * (403, `owner_only`). A grant and an adjustment need an `Idempotency-Key` header, and a repeat of
 * one grants once. Every refusal is `{ error: <sentence>, code: <word> }`; an invalid body names
 * the fields and never echoes a value. Every write is audited in the same batch as its ledger entry
 * (`compute.policy.set`, `compute.pool.grant`, `compute.pool.adjust`).
 *
 * Nothing here mails anyone, calls GitHub, or is a cron. The platform budget is counted when a
 * person's charge is adjusted: an adjustment of the charge of an account's pool also moves the
 * `people` budget of the same word, so the budget and the people never disagree.
 */

import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import { COMPUTE_WORD_RE } from "../../../../shared/compute-state";
import { COMPUTE_POOLS, type ComputePool } from "../../../../shared/contract/compute";
import {
  COMPUTE_ADJUST_TARGETS,
  COMPUTE_ADMIN_ERROR_STATUS,
  COMPUTE_IDEMPOTENCY_KEY_RE,
  COMPUTE_POOLS_PAGE_MAX,
  COMPUTE_POOL_HOLDER_KINDS,
  type ComputeAdminErrorCode,
  type ComputeLedgerEntryView,
  type ComputePoolView,
} from "../../../../shared/contract/compute-admin";
import {
  ComputeLedgerError,
  type LedgerRow,
  type PoolRow,
  accountPools,
  adjustPool,
  availableMilli,
  ensurePool,
  getPool,
  grantPool,
  listPools,
  platformPool,
} from "../../services/compute-ledger";
import {
  ComputePolicyUnreadable,
  type PolicyIssue,
  fieldPath,
  getPolicy,
  getPolicyVersion,
  putPolicy,
} from "../../services/compute-policy";
import type { Bindings, Variables } from "../../types/bindings";
import type { AdminRouter } from "./shared";

type Ctx = Context<{ Bindings: Bindings; Variables: Variables }>;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const SENTENCES: Record<ComputeAdminErrorCode, string> = {
  invalid_body: "The request body is not valid.",
  invalid_query: "The query is not valid.",
  idempotency_key_required: "An Idempotency-Key header is required.",
  idempotency_key_invalid: "Idempotency-Key is 8 to 100 letters, digits or . _ -.",
  idempotency_conflict: "That Idempotency-Key was used for a different request.",
  owner_only: "Only an owner can do that.",
  account_not_found: "There is no such account.",
  pool_not_found: "There is no such pool.",
  would_go_negative: "That would make a stored total negative, so nothing was written.",
  policy_unreadable: "The stored policy cannot be read, so nothing is served from it.",
  internal: "The compute routes failed unexpectedly.",
};

function refuse(c: Ctx, code: ComputeAdminErrorCode, error?: string, extra: object = {}) {
  return c.json(
    { error: error ?? SENTENCES[code], code, ...extra },
    COMPUTE_ADMIN_ERROR_STATUS[code],
  );
}

/** A 400 that names the fields and what is wrong with each, never what was sent. */
function invalidBody(c: Ctx, fields: PolicyIssue[]) {
  const named = fields.slice(0, 5).map((f) => `${f.path || "body"}: ${f.code}`);
  return refuse(c, "invalid_body", `The request body is not valid: ${named.join("; ")}`, {
    fields,
  });
}

function zodFields(error: z.ZodError, prefix = ""): PolicyIssue[] {
  return error.issues.slice(0, 20).map((i) => {
    const path = fieldPath(i.path);
    return {
      path: [prefix, path].filter((p) => p !== "").join("."),
      code: i.code,
      ...(i.code === "custom" ? { message: i.message } : {}),
    };
  });
}

/** An error the service threw, as the route answers it; null when it is not one this knows. */
function ledgerRefusal(c: Ctx, err: unknown) {
  if (err instanceof ComputeLedgerError) {
    if (err.code === "idempotency_conflict") return refuse(c, "idempotency_conflict");
    if (err.code === "pool_not_found") return refuse(c, "pool_not_found");
  }
  if (err instanceof ComputePolicyUnreadable) return refuse(c, "policy_unreadable");
  return null;
}

function fail(c: Ctx, err: unknown) {
  const known = ledgerRefusal(c, err);
  if (known) return known;
  console.error(
    "[admin/compute] unexpected failure:",
    err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  );
  return refuse(c, "internal");
}

const requireOwner: MiddlewareHandler<{ Bindings: Bindings; Variables: Variables }> = async (
  c,
  next,
) => {
  if (c.get("user").role !== "owner") return refuse(c, "owner_only");
  await next();
};

// --- Views -----------------------------------------------------------------------------------

function poolView(row: PoolRow): ComputePoolView {
  return {
    id: row.id,
    holder_kind: row.holder_kind,
    holder_ref: row.holder_ref,
    pool: row.pool,
    granted_milli: row.granted_milli,
    held_milli: row.held_milli,
    charged_milli: row.charged_milli,
    available_milli: availableMilli(row),
    frozen: row.frozen !== 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function entryView(row: LedgerRow): ComputeLedgerEntryView {
  return {
    id: row.id,
    kind: row.kind,
    pool_id: row.pool_id,
    budget_pool_id: row.budget_pool_id,
    granted_delta_milli: row.granted_delta_milli,
    held_delta_milli: row.held_delta_milli,
    charged_delta_milli: row.charged_delta_milli,
    job_id: row.job_id,
    hold_ref: row.hold_ref,
    reason: row.reason,
    actor_user_id: row.actor_user_id,
    created_at: row.created_at,
  };
}

// --- Bodies ----------------------------------------------------------------------------------

const poolWord = z.enum(COMPUTE_POOLS);
const reasonWord = z.string().regex(COMPUTE_WORD_RE);
const wholeMilli = z.number().int().min(-MAX_SAFE).max(MAX_SAFE);

const putPolicyBody = z.object({ policy: z.unknown(), note: z.string().optional() }).strict();

const grantBody = z
  .object({
    pool: poolWord,
    amount_milli: z.number().int().min(1).max(MAX_SAFE),
    reason: reasonWord.optional(),
  })
  .strict();

const adjustBody = z
  .object({
    pool: poolWord,
    target: z.enum(COMPUTE_ADJUST_TARGETS),
    delta_milli: wholeMilli.refine((n) => n !== 0, {
      message: "an adjustment of 0 changes nothing",
    }),
    reason: reasonWord,
  })
  .strict();

const listQuery = z.object({
  holder_kind: z.enum(COMPUTE_POOL_HOLDER_KINDS).optional(),
  after: z.coerce.number().int().min(0).max(MAX_SAFE).optional(),
  limit: z.coerce.number().int().min(1).max(COMPUTE_POOLS_PAGE_MAX).default(50),
});

/** The body as JSON, or null when it is not JSON (an empty body included). */
async function readJson(c: Ctx): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** The `Idempotency-Key` header, or the refusal to answer with. */
function idempotencyKey(c: Ctx): { key: string } | { refusal: Response } {
  const raw = c.req.header("Idempotency-Key");
  if (raw === undefined || raw === "") return { refusal: refuse(c, "idempotency_key_required") };
  if (!COMPUTE_IDEMPOTENCY_KEY_RE.test(raw))
    return { refusal: refuse(c, "idempotency_key_invalid") };
  return { key: raw };
}

const ACCOUNT_ID_RE = /^[1-9]\d{0,14}$/;

async function accountExists(db: D1Database, id: number): Promise<boolean> {
  return (await db.prepare("SELECT id FROM users WHERE id = ?1").bind(id).first()) !== null;
}

// --- The grant and the adjustment, for an account's pool and for a platform pool --------------

type Holder = { kind: "account"; id: number } | { kind: "platform"; key: string };

/** The pool a write is about, or the refusal: an account's is made on its first grant, a platform's must exist. */
async function targetPool(
  c: Ctx,
  holder: Holder,
  word: ComputePool,
  create: boolean,
): Promise<PoolRow | Response> {
  const db = c.env.DB;
  if (holder.kind === "account") {
    if (!(await accountExists(db, holder.id))) return refuse(c, "account_not_found");
    if (create) return ensurePool(db, "account", String(holder.id), word);
    const existing = (await accountPools(db, holder.id)).find((p) => p.pool === word);
    return existing ?? refuse(c, "pool_not_found");
  }
  // Only the platform's own budgets are there to find; nothing here makes one.
  const pool = await platformPool(db, holder.key, word);
  return pool ?? refuse(c, "pool_not_found");
}

async function grantRoute(c: Ctx, holder: Holder) {
  const idem = idempotencyKey(c);
  if ("refusal" in idem) return idem.refusal;
  const parsed = grantBody.safeParse(await readJson(c));
  if (!parsed.success) return invalidBody(c, zodFields(parsed.error));
  try {
    const pool = await targetPool(c, holder, parsed.data.pool, true);
    if (pool instanceof Response) return pool;
    const result = await grantPool(c.env.DB, {
      poolId: pool.id,
      amountMilli: parsed.data.amount_milli,
      actorUserId: c.get("user").id,
      reason: parsed.data.reason ?? "admin_grant",
      idempotencyKey: `grant:${idem.key}`,
      audit: { userId: c.get("user").id, action: "compute.pool.grant" },
    });
    const after = (await getPool(c.env.DB, pool.id)) ?? pool;
    return c.json(
      { pool: poolView(after), entry: entryView(result.entry), replayed: result.replayed },
      result.replayed ? 200 : 201,
    );
  } catch (err) {
    return fail(c, err);
  }
}

async function adjustRoute(c: Ctx, holder: Holder) {
  const idem = idempotencyKey(c);
  if ("refusal" in idem) return idem.refusal;
  const parsed = adjustBody.safeParse(await readJson(c));
  if (!parsed.success) return invalidBody(c, zodFields(parsed.error));
  const body = parsed.data;
  try {
    const pool = await targetPool(c, holder, body.pool, false);
    if (pool instanceof Response) return pool;
    // A correction of what a person or a partner was charged follows the `people` budget of the
    // same word; a platform pool is its own budget, and a correction of a grant has none.
    let budgetPoolId: number | null = null;
    if (body.target === "charged" && pool.holder_kind !== "platform") {
      const budget = await platformPool(c.env.DB, "people", body.pool);
      if (!budget) throw new Error("the platform people budget is missing");
      budgetPoolId = budget.id;
    }
    const result = await adjustPool(c.env.DB, {
      poolId: pool.id,
      budgetPoolId,
      ...(body.target === "granted"
        ? { grantedDeltaMilli: body.delta_milli }
        : { chargedDeltaMilli: body.delta_milli }),
      actorUserId: c.get("user").id,
      reason: body.reason,
      idempotencyKey: `adjust:${idem.key}`,
      audit: { userId: c.get("user").id, action: "compute.pool.adjust" },
    });
    if (!result.ok) return refuse(c, result.code);
    const after = (await getPool(c.env.DB, pool.id)) ?? pool;
    return c.json(
      { pool: poolView(after), entry: entryView(result.entry), replayed: result.replayed },
      result.replayed ? 200 : 201,
    );
  } catch (err) {
    return fail(c, err);
  }
}

// --- Registration ----------------------------------------------------------------------------

export function registerComputeAdminRoutes(admin: AdminRouter): void {
  admin.get("/compute/policy", requireOwner, async (c) => {
    try {
      return c.json(await getPolicy(c.env.DB));
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.put("/compute/policy", requireOwner, async (c) => {
    const parsed = putPolicyBody.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c, zodFields(parsed.error));
    try {
      const result = await putPolicy(
        c.env.DB,
        c.get("user").id,
        parsed.data.policy,
        parsed.data.note,
      );
      if (!result.ok) {
        if (result.code === "not_owner") return refuse(c, "owner_only");
        if (result.code === "invalid_note") {
          return invalidBody(c, [{ path: "note", code: "invalid_string" }]);
        }
        return invalidBody(
          c,
          result.issues.map((i) => ({
            ...i,
            path: ["policy", i.path].filter((p) => p !== "").join("."),
          })),
        );
      }
      const written = await getPolicyVersion(c.env.DB, result.version);
      if (!written) throw new Error("a policy version that was just written could not be read");
      return c.json(written);
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.get("/compute/pools", async (c) => {
    const query = listQuery.safeParse(c.req.query());
    if (!query.success) {
      return refuse(
        c,
        "invalid_query",
        `The query is not valid: ${query.error.issues
          .slice(0, 5)
          .map((i) => `${fieldPath(i.path) || "query"}: ${i.code}`)
          .join("; ")}`,
      );
    }
    try {
      const page = await listPools(c.env.DB, {
        holderKind: query.data.holder_kind,
        after: query.data.after,
        limit: query.data.limit,
      });
      return c.json({ pools: page.pools.map(poolView), next_after: page.nextAfter });
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.get("/compute/pools/by-id/:accountId", async (c) => {
    const raw = c.req.param("accountId");
    if (!ACCOUNT_ID_RE.test(raw)) return refuse(c, "account_not_found");
    const id = Number(raw);
    try {
      if (!(await accountExists(c.env.DB, id))) return refuse(c, "account_not_found");
      const pools = await accountPools(c.env.DB, id);
      return c.json({ account_id: id, pools: pools.map(poolView) });
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.post("/compute/pools/by-id/:accountId/grant", async (c) => {
    const raw = c.req.param("accountId");
    if (!ACCOUNT_ID_RE.test(raw)) return refuse(c, "account_not_found");
    return grantRoute(c, { kind: "account", id: Number(raw) });
  });

  admin.post("/compute/pools/by-id/:accountId/adjust", async (c) => {
    const raw = c.req.param("accountId");
    if (!ACCOUNT_ID_RE.test(raw)) return refuse(c, "account_not_found");
    return adjustRoute(c, { kind: "account", id: Number(raw) });
  });

  admin.post("/compute/pools/platform/:key/grant", requireOwner, (c) =>
    grantRoute(c, { kind: "platform", key: c.req.param("key") }),
  );

  admin.post("/compute/pools/platform/:key/adjust", requireOwner, (c) =>
    adjustRoute(c, { kind: "platform", key: c.req.param("key") }),
  );
}
