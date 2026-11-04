/**
 * The compute gateway's allocation ledger (epic #2005 phase A2, #2007; ADR 0118, decision 3).
 *
 * A hold, a release, a settlement, a refund, a grant, an adjustment and an expiry, over the three
 * tables of migration 0114: `compute_pools` (a holder's running totals), `compute_ledger` (the
 * append-only entries) and the trigger that is the ONE writer of the totals. Amounts are whole
 * thousandths of a service unit (SU), never floating point.
 *
 * THE RULES, each one deliberate:
 *  - Nothing here writes a total. Every function inserts a ledger entry; the migration's AFTER
 *    INSERT trigger takes its deltas into the pool's row (and its held and charged deltas into the
 *    budget pool's), in the same statement. So the totals can never disagree with the ledger, "only
 *    if the entry was written" needs no second statement, and an entry the totals refuse (a stored
 *    total may not go negative) is not written either. A test reads every source file for a write
 *    of a total that is not the trigger's.
 *  - A hold is ONE conditional INSERT (`HOLD_INSERT_SQL`): the pool not frozen, the pool's
 *    available at least the amount, the budget pool's available at least the amount, the key unused
 *    and any guard the caller adds, all in its WHERE. D1 runs a statement whole, so two holds for the
 *    last SU cannot both be written, and a refused hold writes nothing (ADR 0099; the claim of
 *    upstream-repull-dispatch.ts is the precedent). `meta.changes` is the winner test, and the
 *    reasons are read only after a refusal, to say which one.
 *  - A closing entry is one INSERT too, taken from the hold row itself (`RELEASE_INSERT_SQL`,
 *    `SETTLE_INSERT_SQL`): the amounts are the hold's, so a caller cannot misstate them, and the hold
 *    must be open in the same statement, so a hold closes once. A settlement's charge and any
 *    overrun are one statement.
 *  - Available is granted minus held minus charged and MAY BE NEGATIVE (an overrun, or an
 *    adjustment of the grant below what is used, is a fact that already happened). It is computed
 *    in BigInt, so it is exact at the largest total. A stored total never is negative.
 *  - Arithmetic is integer. Every amount is checked to be a safe whole number before a statement is
 *    built (`ComputeLedgerError`, `invalid_argument`), so a fraction, NaN or a number a double
 *    cannot hold exactly never reaches SQL; the table refuses what slips past (`typeof`).
 *  - A retry is safe. Every entry has a unique key; a hold, a grant, an adjustment and an expiry
 *    take the caller's, and the entries the Worker writes for a job take a key made of the job (or
 *    the hold) and the step (`hold:<id>:charge`, `job:<id>:final`), so a step happens once. A key
 *    that finds its entry returns it, and a key reused for a different request is a conflict.
 *  - Nothing here mails, calls GitHub or Tapis, or is a cron. The job table and the job-count
 *    guards on a hold are phase A3's: `placeHold` takes a caller's own guards and writes nothing.
 */

import { COMPUTE_WORD_RE, type LedgerEntryKind } from "../../../shared/compute-state.js";
import {
  COMPUTE_POOL_HOLDER_KINDS,
  type ComputePoolHolderKind,
} from "../../../shared/contract/compute-admin.js";
import {
  COMPUTE_JOB_ID_RE,
  COMPUTE_POOLS,
  type ComputePool,
} from "../../../shared/contract/compute.js";

export const POOL_HOLDER_KINDS = COMPUTE_POOL_HOLDER_KINDS;
export type PoolHolderKind = ComputePoolHolderKind;

/** The largest amount: what a double holds exactly, and what the table's CHECKs allow. */
export const MAX_MILLI = Number.MAX_SAFE_INTEGER;

/** A ledger key: 1 to 128 letters, digits and `. _ : -`, which is what the table accepts. */
export const LEDGER_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** A pool's holder, as the table's CHECK takes it. */
const HOLDER_REF_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ACCOUNT_REF_RE = /^[1-9][0-9]*$/;

export interface PoolRow {
  id: number;
  holder_kind: PoolHolderKind;
  holder_ref: string;
  pool: ComputePool;
  granted_milli: number;
  held_milli: number;
  charged_milli: number;
  frozen: number;
  created_at: string;
  updated_at: string;
}

export interface LedgerRow {
  id: number;
  kind: LedgerEntryKind;
  pool_id: number;
  budget_pool_id: number | null;
  granted_delta_milli: number;
  held_delta_milli: number;
  charged_delta_milli: number;
  job_id: string | null;
  hold_ref: number | null;
  reason: string | null;
  actor_user_id: number | null;
  idempotency_key: string;
  created_at: string;
}

export type LedgerErrorCode = "invalid_argument" | "idempotency_conflict" | "pool_not_found";

/**
 * A request the ledger cannot answer with a result: an argument that is not what the table takes
 * (a programming error, never a refusal), a key reused for something else, or a pool that is not
 * there. Nothing has been written when one is thrown.
 */
export class ComputeLedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ComputeLedgerError";
  }
}

const invalid = (message: string): never => {
  throw new ComputeLedgerError("invalid_argument", message);
};

// --- Arguments -------------------------------------------------------------------------------

/** A whole number of milli-SU from `min` to the largest a double holds exactly. */
function amount(name: string, value: unknown, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    return invalid(`${name} is a whole number of milli-SU, at least ${min}`);
  }
  return value;
}

/** A nonzero whole number, either sign, within what a double holds exactly. */
function signedAmount(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value === 0) {
    return invalid(`${name} is a whole number of milli-SU and not 0`);
  }
  return value;
}

function positiveId(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return invalid(`${name} is a positive whole number`);
  }
  return value;
}

function jobIdArg(value: unknown): string {
  if (typeof value !== "string" || !COMPUTE_JOB_ID_RE.test(value)) {
    return invalid("a job id is job_ and 24 lowercase hex digits");
  }
  return value;
}

function keyArg(value: unknown): string {
  if (typeof value !== "string" || !LEDGER_KEY_RE.test(value)) {
    return invalid("an idempotency key is 1 to 128 letters, digits and . _ : -");
  }
  return value;
}

function reasonArg(value: unknown, fallback: string | null): string | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !COMPUTE_WORD_RE.test(value)) {
    return invalid("a reason is a fixed word of lowercase letters, digits and _");
  }
  return value;
}

function actorArg(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return positiveId("an actor", value);
}

// --- Available -------------------------------------------------------------------------------

/**
 * What a pool may still take: granted minus held minus charged. It MAY BE NEGATIVE (an overrun
 * happened, or a grant was adjusted below what is used). BigInt, so it is exact at the largest
 * total, and a total that is not a whole number (which the table never stores) throws.
 */
export function availableMilli(
  row: Pick<PoolRow, "granted_milli" | "held_milli" | "charged_milli">,
): number {
  const value = BigInt(row.granted_milli) - BigInt(row.held_milli) - BigInt(row.charged_milli);
  if (value > BigInt(MAX_MILLI) || value < -BigInt(MAX_MILLI)) {
    throw new RangeError("available is beyond what a double holds exactly");
  }
  return Number(value);
}

// --- Pools -----------------------------------------------------------------------------------

const POOL_COLUMNS =
  "id, holder_kind, holder_ref, pool, granted_milli, held_milli, charged_milli, frozen, created_at, updated_at";

export const POOL_BY_ID_SQL = `SELECT ${POOL_COLUMNS} FROM compute_pools WHERE id = ?1`;

export const POOL_BY_HOLDER_SQL = `SELECT ${POOL_COLUMNS} FROM compute_pools
  WHERE holder_kind = ?1 AND holder_ref = ?2 AND pool = ?3`;

/**
 * A pool of a holder, once. The unique key makes it idempotent, and the insert names no total: a
 * new pool starts at zero and only the ledger moves it.
 */
export const ENSURE_POOL_SQL = `INSERT INTO compute_pools (holder_kind, holder_ref, pool)
  VALUES (?1, ?2, ?3)
  ON CONFLICT (holder_kind, holder_ref, pool) DO NOTHING`;

export async function getPool(db: D1Database, id: number): Promise<PoolRow | null> {
  return db.prepare(POOL_BY_ID_SQL).bind(id).first<PoolRow>();
}

/**
 * The pool of a holder, made if it is not there (an idempotent insert). Phase A3 and #2012 use it
 * for a person's and a partner's pools; the platform's four are seeded by the migration.
 */
export async function ensurePool(
  db: D1Database,
  holderKind: PoolHolderKind,
  holderRef: string,
  pool: ComputePool,
): Promise<PoolRow> {
  if (!(POOL_HOLDER_KINDS as readonly string[]).includes(holderKind)) {
    return invalid("a pool's holder is an account, the platform or a partner");
  }
  if (!(COMPUTE_POOLS as readonly string[]).includes(pool)) {
    return invalid("a pool is cpu or gpu");
  }
  if (
    typeof holderRef !== "string" ||
    !HOLDER_REF_RE.test(holderRef) ||
    (holderKind === "account" && !ACCOUNT_REF_RE.test(holderRef))
  ) {
    return invalid("a pool's holder reference is not one the table takes");
  }
  await db.prepare(ENSURE_POOL_SQL).bind(holderKind, holderRef, pool).run();
  const row = await db
    .prepare(POOL_BY_HOLDER_SQL)
    .bind(holderKind, holderRef, pool)
    .first<PoolRow>();
  if (!row) throw new Error("a pool that was just ensured could not be read");
  return row;
}

// --- Entries ---------------------------------------------------------------------------------

const ENTRY_COLUMNS = `id, kind, pool_id, budget_pool_id, granted_delta_milli, held_delta_milli,
  charged_delta_milli, job_id, hold_ref, reason, actor_user_id, idempotency_key, created_at`;

export const ENTRY_BY_KEY_SQL = `SELECT ${ENTRY_COLUMNS} FROM compute_ledger WHERE idempotency_key = ?1`;

async function entryByKey(db: D1Database, key: string): Promise<LedgerRow | null> {
  return db.prepare(ENTRY_BY_KEY_SQL).bind(key).first<LedgerRow>();
}

/** The audit row an administrator's entry leaves, written only if the entry before it was. */
export const AUDIT_LEDGER_ENTRY_SQL = `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
  SELECT ?1, ?2, 'compute_pool', CAST(l.pool_id AS TEXT),
         json_object('entry_id', l.id, 'kind', l.kind, 'holder_kind', p.holder_kind,
                     'holder_ref', p.holder_ref, 'pool', p.pool,
                     'granted_delta_milli', l.granted_delta_milli,
                     'charged_delta_milli', l.charged_delta_milli, 'reason', l.reason)
    FROM compute_ledger l JOIN compute_pools p ON p.id = l.pool_id
   WHERE l.id = last_insert_rowid() AND changes() > 0`;

/** The audit row to write in the same batch as an entry: who, and the action word. */
export interface LedgerAudit {
  userId: number | null;
  action: string;
}

/** Run an entry's INSERT, with its audit row in the same batch when there is one; the rows it wrote. */
async function writeEntry(
  db: D1Database,
  insert: D1PreparedStatement,
  audit?: LedgerAudit,
): Promise<number> {
  if (audit) {
    const results = await db.batch([
      insert,
      db.prepare(AUDIT_LEDGER_ENTRY_SQL).bind(audit.userId, audit.action),
    ]);
    return results[0]?.meta?.changes ?? 0;
  }
  const result = await insert.run();
  return result.meta?.changes ?? 0;
}

const looksUnique = (err: unknown) => /UNIQUE constraint failed/i.test(String(err));

// --- Hold ------------------------------------------------------------------------------------

/**
 * A guard of the caller's, ANDed into a hold's WHERE: a boolean SQL expression with plain `?`
 * placeholders and the values to bind to them. It runs in the same statement as the hold, so a
 * limit it expresses (a person's live jobs) holds under a race as the balance does.
 */
export interface HoldGuard {
  sql: string;
  binds?: readonly unknown[];
}

export interface HoldInput {
  poolId: number;
  /** The platform pool this spend is also counted against, or null for the platform's own pool. */
  budgetPoolId: number | null;
  amountMilli: number;
  jobId: string;
  idempotencyKey: string;
  extraGuards?: readonly HoldGuard[];
}

/**
 * The hold, with no guard of the caller's. `?1` pool, `?2` budget pool (NULL for none), `?3` amount,
 * `?4` job, `?5` key. One INSERT whose WHERE is every condition; it inserts a row or none, and the
 * trigger of migration 0114 takes the held amount into both pools in the same statement.
 */
export const HOLD_INSERT_SQL = `INSERT INTO compute_ledger
  (kind, pool_id, budget_pool_id, held_delta_milli, job_id, idempotency_key)
  SELECT 'hold', p.id, ?2, ?3, ?4, ?5
    FROM compute_pools p
   WHERE p.id = ?1
     AND p.frozen = 0
     AND p.granted_milli - p.held_milli - p.charged_milli >= ?3
     AND (?2 IS NULL OR (SELECT b.granted_milli - b.held_milli - b.charged_milli
                           FROM compute_pools b WHERE b.id = ?2) >= ?3)
     AND NOT EXISTS (SELECT 1 FROM compute_ledger WHERE idempotency_key = ?5)`;

const HOLD_FIXED_PARAMS = 5;

/** A guard's `?` placeholders numbered after the statement's own, and how many it takes. */
function numberedGuard(sql: string, from: number): { sql: string; count: number } {
  if (/\?\d|\?\?/.test(sql)) invalid("a hold guard uses plain ? placeholders");
  let n = from;
  const numbered = sql.replace(/\?/g, () => `?${n++}`);
  return { sql: numbered, count: n - from };
}

/**
 * The hold's statement, to run alone (`placeHold`) or in a batch with the caller's own, where a
 * statement after it that checks `changes()` happens only if the hold was written. An array so a
 * caller can spread it into a batch; today it holds the one INSERT.
 */
export function holdStatements(db: D1Database, input: HoldInput): D1PreparedStatement[] {
  const poolId = positiveId("a pool", input.poolId);
  const budget =
    input.budgetPoolId === null ? null : positiveId("a budget pool", input.budgetPoolId);
  const milli = amount("a hold", input.amountMilli, 1);
  const job = jobIdArg(input.jobId);
  const key = keyArg(input.idempotencyKey);
  let sql = HOLD_INSERT_SQL;
  const binds: unknown[] = [poolId, budget, milli, job, key];
  for (const guard of input.extraGuards ?? []) {
    const { sql: part, count } = numberedGuard(guard.sql, binds.length + 1);
    const values = guard.binds ?? [];
    if (values.length !== count) invalid("a hold guard binds one value for each ? it has");
    sql += `\n     AND (${part})`;
    binds.push(...values);
  }
  return [db.prepare(sql).bind(...binds)];
}

export type HoldRefusal =
  | "insufficient_balance"
  | "suspended"
  | "platform_budget_exhausted"
  /** The caller's own guard refused it; the caller knows which. */
  | "guard_refused"
  /** The job already has a hold, under another key. */
  | "job_already_held";

export type HoldResult =
  | { ok: true; replayed: boolean; entry: LedgerRow }
  | { ok: false; code: HoldRefusal };

/** A key that found an entry is a replay only if it is the same hold. */
function sameHold(entry: LedgerRow, input: HoldInput): boolean {
  return (
    entry.kind === "hold" &&
    entry.pool_id === input.poolId &&
    entry.budget_pool_id === input.budgetPoolId &&
    entry.held_delta_milli === input.amountMilli &&
    entry.job_id === input.jobId
  );
}

/**
 * Take a hold, or say why not. One INSERT decides (`HOLD_INSERT_SQL`), and a refusal writes
 * nothing. On a refusal the pool and the budget are read to name the reason, in this order: a
 * frozen pool is `suspended`, a pool without the amount is `insufficient_balance`, a budget without
 * it is `platform_budget_exhausted`, and a refusal none of those explains is the caller's own guard.
 * A replayed key returns the original hold; the same key for another request throws
 * `idempotency_conflict`.
 */
export async function placeHold(db: D1Database, input: HoldInput): Promise<HoldResult> {
  const [insert] = holdStatements(db, input);
  let changes: number;
  try {
    changes = (await (insert as D1PreparedStatement).run()).meta?.changes ?? 0;
  } catch (err) {
    // A second hold of a job under another key meets the one-hold-per-job index.
    if (looksUnique(err) && /compute_ledger\.job_id/.test(String(err))) {
      return { ok: false, code: "job_already_held" };
    }
    throw err;
  }
  if (changes > 0) {
    const entry = await entryByKey(db, input.idempotencyKey);
    if (!entry) throw new Error("a hold that was just written could not be read");
    return { ok: true, replayed: false, entry };
  }

  const existing = await entryByKey(db, input.idempotencyKey);
  if (existing) {
    if (!sameHold(existing, input)) {
      throw new ComputeLedgerError(
        "idempotency_conflict",
        "that idempotency key was used for a different request",
      );
    }
    return { ok: true, replayed: true, entry: existing };
  }

  const pool = await getPool(db, input.poolId);
  if (!pool) throw new ComputeLedgerError("pool_not_found", "no such pool");
  if (pool.frozen !== 0) return { ok: false, code: "suspended" };
  if (availableMilli(pool) < input.amountMilli) return { ok: false, code: "insufficient_balance" };
  if (input.budgetPoolId !== null) {
    const budget = await getPool(db, input.budgetPoolId);
    if (!budget) throw new ComputeLedgerError("pool_not_found", "no such budget pool");
    if (availableMilli(budget) < input.amountMilli) {
      return { ok: false, code: "platform_budget_exhausted" };
    }
  }
  return { ok: false, code: "guard_refused" };
}

// --- Closing a hold --------------------------------------------------------------------------

/** The job's hold, and whether it is still open (nothing closed it). */
const HOLD_OF_JOB_SQL = `SELECT h.id, h.pool_id, h.budget_pool_id, h.held_delta_milli,
    EXISTS (SELECT 1 FROM compute_ledger c WHERE c.hold_ref = h.id AND c.kind IN ('release', 'charge'))
      AS closed
  FROM compute_ledger h WHERE h.kind = 'hold' AND h.job_id = ?1`;

interface HoldOfJob {
  id: number;
  pool_id: number;
  budget_pool_id: number | null;
  held_delta_milli: number;
  closed: number;
}

/**
 * A release, taken from the open hold of the job: `?1` the job, `?2` the reason (or NULL). The
 * amount is the hold's, the key is the hold's (`hold:<id>:release`), and the hold must be open in
 * this statement: a hold that was closed, or never made, writes nothing.
 */
export const RELEASE_INSERT_SQL = `INSERT INTO compute_ledger
  (kind, pool_id, budget_pool_id, held_delta_milli, job_id, hold_ref, reason, idempotency_key)
  SELECT 'release', h.pool_id, h.budget_pool_id, -h.held_delta_milli, h.job_id, h.id, ?2,
         'hold:' || h.id || ':release'
    FROM compute_ledger h
   WHERE h.kind = 'hold' AND h.job_id = ?1
     AND NOT EXISTS (SELECT 1 FROM compute_ledger c
                      WHERE c.hold_ref = h.id AND c.kind IN ('release', 'charge'))`;

/**
 * A settlement, taken from the open hold of the job: `?1` the job, `?2` what the job used. One
 * INSERT of up to two rows: the `charge` (the hold leaves `held`; what was used, at most the hold,
 * enters `charged`, so the rest of the hold is released by it), and an `overrun` for what was used
 * above the hold. Both read the open hold in this statement, so a hold settles once, and the two
 * rows are written together or not at all.
 */
export const SETTLE_INSERT_SQL = `INSERT INTO compute_ledger
  (kind, pool_id, budget_pool_id, held_delta_milli, charged_delta_milli, job_id, hold_ref,
   idempotency_key)
  SELECT 'charge', h.pool_id, h.budget_pool_id, -h.held_delta_milli,
         MIN(?2, h.held_delta_milli), h.job_id, h.id, 'hold:' || h.id || ':charge'
    FROM compute_ledger h
   WHERE h.kind = 'hold' AND h.job_id = ?1
     AND NOT EXISTS (SELECT 1 FROM compute_ledger c
                      WHERE c.hold_ref = h.id AND c.kind IN ('release', 'charge'))
  UNION ALL
  SELECT 'overrun', h.pool_id, h.budget_pool_id, 0, ?2 - h.held_delta_milli, h.job_id, h.id,
         'hold:' || h.id || ':overrun'
    FROM compute_ledger h
   WHERE h.kind = 'hold' AND h.job_id = ?1 AND ?2 > h.held_delta_milli
     AND NOT EXISTS (SELECT 1 FROM compute_ledger c
                      WHERE c.hold_ref = h.id AND c.kind IN ('release', 'charge'))`;

export type CloseRefusal = "no_hold" | "hold_closed";

/** Why a closing statement wrote nothing: the job has no hold, or its hold is closed. */
async function whyNotClosed(db: D1Database, job: string): Promise<CloseRefusal> {
  const hold = await db.prepare(HOLD_OF_JOB_SQL).bind(job).first<HoldOfJob>();
  return hold ? "hold_closed" : "no_hold";
}

export type ReleaseResult =
  | { ok: true; holdId: number; releasedMilli: number }
  | { ok: false; code: CloseRefusal };

/**
 * Give the job's whole hold back (a job that never started). The hold must be open: one that was
 * released or settled writes nothing and is `hold_closed`; a job with no hold is `no_hold`.
 */
export async function releaseHold(
  db: D1Database,
  input: { jobId: string; reason?: string },
): Promise<ReleaseResult> {
  const job = jobIdArg(input.jobId);
  const reason = reasonArg(input.reason, "released");
  let changes: number;
  try {
    changes = (await db.prepare(RELEASE_INSERT_SQL).bind(job, reason).run()).meta?.changes ?? 0;
  } catch (err) {
    if (looksUnique(err)) return { ok: false, code: "hold_closed" };
    throw err;
  }
  if (changes === 0) return { ok: false, code: await whyNotClosed(db, job) };
  const entry = await db
    .prepare(`SELECT ${ENTRY_COLUMNS} FROM compute_ledger WHERE job_id = ?1 AND kind = 'release'`)
    .bind(job)
    .first<LedgerRow>();
  if (!entry) throw new Error("a release that was just written could not be read");
  return { ok: true, holdId: entry.hold_ref as number, releasedMilli: -entry.held_delta_milli };
}

export type SettleResult =
  | {
      ok: true;
      holdId: number;
      holdMilli: number;
      /** What entered `charged` through the charge entry: at most the hold. */
      chargedMilli: number;
      /** The hold's remainder, returned to available. */
      releasedMilli: number;
      /** What was used above the hold, written as an `overrun` (available may go negative). */
      overrunMilli: number;
    }
  | { ok: false; code: CloseRefusal };

/**
 * Settle the job's hold provisionally, from what the job used (`chargeMilli`, 0 or more): one
 * `charge` entry closes the hold and enters at most the hold, the rest of the hold is released, and
 * any excess is an `overrun` entry written in the same statement. Available may then be negative.
 * A hold that was already released or settled writes nothing: `hold_closed`.
 */
export async function settleProvisional(
  db: D1Database,
  input: { jobId: string; chargeMilli: number },
): Promise<SettleResult> {
  const job = jobIdArg(input.jobId);
  const used = amount("a charge", input.chargeMilli, 0);
  let changes: number;
  try {
    changes = (await db.prepare(SETTLE_INSERT_SQL).bind(job, used).run()).meta?.changes ?? 0;
  } catch (err) {
    if (looksUnique(err)) return { ok: false, code: "hold_closed" };
    throw err;
  }
  if (changes === 0) return { ok: false, code: await whyNotClosed(db, job) };
  const rows = (
    await db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM compute_ledger
          WHERE job_id = ?1 AND kind IN ('charge', 'overrun') ORDER BY id`,
      )
      .bind(job)
      .all<LedgerRow>()
  ).results;
  const charge = rows.find((r) => r.kind === "charge");
  if (!charge) throw new Error("a settlement that was just written could not be read");
  const overrun = rows.find((r) => r.kind === "overrun")?.charged_delta_milli ?? 0;
  const holdMilli = -charge.held_delta_milli;
  return {
    ok: true,
    holdId: charge.hold_ref as number,
    holdMilli,
    chargedMilli: charge.charged_delta_milli,
    releasedMilli: holdMilli - charge.charged_delta_milli,
    overrunMilli: overrun,
  };
}

// --- Final settlement and refund -------------------------------------------------------------

/**
 * What a job has been charged on its pool, and whether its hold was settled by a charge: `?1` the
 * job. Read only to say why a final settlement or a refund wrote nothing.
 */
const JOB_CHARGE_SQL = `SELECT
    EXISTS (SELECT 1 FROM compute_ledger h JOIN compute_ledger c ON c.hold_ref = h.id AND c.kind = 'charge'
             WHERE h.kind = 'hold' AND h.job_id = ?1) AS settled,
    COALESCE((SELECT SUM(e.charged_delta_milli) FROM compute_ledger e
               JOIN compute_ledger h ON h.kind = 'hold' AND h.job_id = e.job_id AND h.pool_id = e.pool_id
              WHERE e.job_id = ?1), 0) AS total`;

/**
 * The final settlement: `?1` the job, `?2` the figure Expanse's own accounting gave. One `adjust`
 * entry of the difference between that and everything already charged to the job on its pool (the
 * charge, any overrun, any earlier adjustment or refund), once per job (`job:<id>:final`), and only
 * after the hold was settled by a charge. A difference of 0 writes no entry, and one that would take
 * the pool's or the budget's charged below zero (an administrator already corrected it) writes none.
 */
export const FINAL_INSERT_SQL = `INSERT INTO compute_ledger
  (kind, pool_id, budget_pool_id, charged_delta_milli, job_id, reason, idempotency_key)
  SELECT 'adjust', d.pool_id, d.budget_pool_id, d.delta, d.job_id, 'final_settlement',
         'job:' || d.job_id || ':final'
    FROM (SELECT h.pool_id AS pool_id, h.budget_pool_id AS budget_pool_id, h.job_id AS job_id,
                 ?2 - COALESCE((SELECT SUM(e.charged_delta_milli) FROM compute_ledger e
                                 WHERE e.job_id = h.job_id AND e.pool_id = h.pool_id), 0) AS delta
            FROM compute_ledger h
           WHERE h.kind = 'hold' AND h.job_id = ?1
             AND EXISTS (SELECT 1 FROM compute_ledger c WHERE c.hold_ref = h.id AND c.kind = 'charge')) d
   WHERE d.delta <> 0
     AND (SELECT charged_milli FROM compute_pools WHERE id = d.pool_id) + d.delta >= 0
     AND (d.budget_pool_id IS NULL
          OR (SELECT charged_milli FROM compute_pools WHERE id = d.budget_pool_id) + d.delta >= 0)
     AND NOT EXISTS (SELECT 1 FROM compute_ledger WHERE idempotency_key = 'job:' || d.job_id || ':final')`;

export type FinalResult =
  | { ok: true; deltaMilli: number; entry: LedgerRow | null }
  | { ok: false; code: "not_settled" | "already_final" | "would_go_negative" };

/**
 * Settle the job finally, to `finalMilli` (Expanse's own figure): an `adjust` of the charged delta
 * that brings the job's whole charge to it, once per job. `not_settled` when the hold was never
 * settled by a charge (open, released or never made); `already_final` when the figure was already
 * settled; a figure equal to the charge so far writes no entry (`deltaMilli` 0, `entry` null); a
 * correction that would take a stored total below zero is `would_go_negative` and writes nothing.
 */
export async function settleFinal(
  db: D1Database,
  input: { jobId: string; finalMilli: number },
): Promise<FinalResult> {
  const job = jobIdArg(input.jobId);
  const figure = amount("a final figure", input.finalMilli, 0);
  const key = `job:${job}:final`;
  let changes: number;
  try {
    changes = (await db.prepare(FINAL_INSERT_SQL).bind(job, figure).run()).meta?.changes ?? 0;
  } catch (err) {
    if (looksUnique(err)) return { ok: false, code: "already_final" };
    throw err;
  }
  if (changes > 0) {
    const entry = await entryByKey(db, key);
    if (!entry) throw new Error("a final settlement that was just written could not be read");
    return { ok: true, deltaMilli: entry.charged_delta_milli, entry };
  }
  if (await entryByKey(db, key)) return { ok: false, code: "already_final" };
  const charged = await db
    .prepare(JOB_CHARGE_SQL)
    .bind(job)
    .first<{ settled: number; total: number }>();
  if (!charged || charged.settled === 0) return { ok: false, code: "not_settled" };
  // Settled, and the figure is what is already charged: nothing to adjust. Anything else was
  // refused for the totals it would take below zero.
  return charged.total === figure
    ? { ok: true, deltaMilli: 0, entry: null }
    : { ok: false, code: "would_go_negative" };
}

/**
 * A refund of everything charged to a job on its pool (`?1` the job, `?2` the reason), once per job
 * (`job:<id>:refund`): a failure NEMAR caused is returned whole. A job with nothing charged writes
 * nothing, and neither does a refund that would take the pool's or the budget's charged below zero
 * (an administrator already corrected it).
 */
export const REFUND_INSERT_SQL = `INSERT INTO compute_ledger
  (kind, pool_id, budget_pool_id, charged_delta_milli, job_id, reason, idempotency_key)
  SELECT 'refund', d.pool_id, d.budget_pool_id, -d.total, d.job_id, ?2,
         'job:' || d.job_id || ':refund'
    FROM (SELECT h.pool_id AS pool_id, h.budget_pool_id AS budget_pool_id, h.job_id AS job_id,
                 COALESCE((SELECT SUM(e.charged_delta_milli) FROM compute_ledger e
                            WHERE e.job_id = h.job_id AND e.pool_id = h.pool_id), 0) AS total
            FROM compute_ledger h
           WHERE h.kind = 'hold' AND h.job_id = ?1) d
   WHERE d.total > 0
     AND (SELECT charged_milli FROM compute_pools WHERE id = d.pool_id) >= d.total
     AND (d.budget_pool_id IS NULL
          OR (SELECT charged_milli FROM compute_pools WHERE id = d.budget_pool_id) >= d.total)
     AND NOT EXISTS (SELECT 1 FROM compute_ledger WHERE idempotency_key = 'job:' || d.job_id || ':refund')`;

export type RefundResult =
  | { ok: true; refundedMilli: number; entry: LedgerRow }
  | { ok: false; code: "nothing_to_refund" | "already_refunded" | "would_go_negative" };

/**
 * Return a job's whole charge to its pool (and its budget), once. `already_refunded` for a second
 * call; `nothing_to_refund` for a job with nothing charged (released, never settled, never held);
 * `would_go_negative` when the pool or its budget no longer holds that much charge.
 */
export async function refundJob(
  db: D1Database,
  input: { jobId: string; reason?: string },
): Promise<RefundResult> {
  const job = jobIdArg(input.jobId);
  const reason = reasonArg(input.reason, "refund");
  const key = `job:${job}:refund`;
  let changes: number;
  try {
    changes = (await db.prepare(REFUND_INSERT_SQL).bind(job, reason).run()).meta?.changes ?? 0;
  } catch (err) {
    if (looksUnique(err)) return { ok: false, code: "already_refunded" };
    throw err;
  }
  if (changes > 0) {
    const entry = await entryByKey(db, key);
    if (!entry) throw new Error("a refund that was just written could not be read");
    return { ok: true, refundedMilli: -entry.charged_delta_milli, entry };
  }
  if (await entryByKey(db, key)) return { ok: false, code: "already_refunded" };
  const charged = await db
    .prepare(JOB_CHARGE_SQL)
    .bind(job)
    .first<{ settled: number; total: number }>();
  return (charged?.total ?? 0) > 0
    ? { ok: false, code: "would_go_negative" }
    : { ok: false, code: "nothing_to_refund" };
}

// --- Grant, adjustment and expiry ------------------------------------------------------------

/** A grant: `?1` pool, `?2` amount, `?3` actor, `?4` reason, `?5` key. Only if the pool is there and the key unused. */
export const GRANT_INSERT_SQL = `INSERT INTO compute_ledger
  (kind, pool_id, granted_delta_milli, actor_user_id, reason, idempotency_key)
  SELECT 'grant', p.id, ?2, ?3, ?4, ?5
    FROM compute_pools p
   WHERE p.id = ?1
     AND NOT EXISTS (SELECT 1 FROM compute_ledger WHERE idempotency_key = ?5)`;

/**
 * An adjustment: `?1` pool, `?2` the budget pool (NULL for none), `?3` the change to granted, `?4`
 * the change to charged, `?5` actor, `?6` reason, `?7` key. Only if the pool is there, the key
 * unused, and no stored total (the pool's, or the budget's charged) would go negative.
 */
export const ADJUST_INSERT_SQL = `INSERT INTO compute_ledger
  (kind, pool_id, budget_pool_id, granted_delta_milli, charged_delta_milli, actor_user_id, reason,
   idempotency_key)
  SELECT 'adjust', p.id, ?2, ?3, ?4, ?5, ?6, ?7
    FROM compute_pools p
   WHERE p.id = ?1
     AND p.granted_milli + ?3 >= 0
     AND p.charged_milli + ?4 >= 0
     AND (?2 IS NULL OR (SELECT b.charged_milli FROM compute_pools b WHERE b.id = ?2) + ?4 >= 0)
     AND NOT EXISTS (SELECT 1 FROM compute_ledger WHERE idempotency_key = ?7)`;

/** An expiry of the pool's whole unused balance: `?1` pool, `?2` reason, `?3` key, `?4` actor. */
export const EXPIRE_INSERT_SQL = `INSERT INTO compute_ledger
  (kind, pool_id, granted_delta_milli, reason, idempotency_key, actor_user_id)
  SELECT 'expire', p.id, -(p.granted_milli - p.held_milli - p.charged_milli), ?2, ?3, ?4
    FROM compute_pools p
   WHERE p.id = ?1
     AND p.granted_milli - p.held_milli - p.charged_milli > 0
     AND NOT EXISTS (SELECT 1 FROM compute_ledger WHERE idempotency_key = ?3)`;

export type EntryResult = { ok: true; replayed: boolean; entry: LedgerRow };

const conflict = (): never => {
  throw new ComputeLedgerError(
    "idempotency_conflict",
    "that idempotency key was used for a different request",
  );
};

/**
 * Give SU to a pool: one `grant` entry, with who did it and a fixed-word reason (default
 * `grant`). `audit` writes an audit row in the same batch, only if the entry was written. A repeated
 * key returns the entry it made and grants once; the same key for another amount or pool throws
 * `idempotency_conflict`.
 */
export async function grantPool(
  db: D1Database,
  input: {
    poolId: number;
    amountMilli: number;
    actorUserId: number | null;
    reason?: string;
    idempotencyKey: string;
    audit?: LedgerAudit;
  },
): Promise<EntryResult> {
  const poolId = positiveId("a pool", input.poolId);
  const milli = amount("a grant", input.amountMilli, 1);
  const actor = actorArg(input.actorUserId);
  const reason = reasonArg(input.reason, "grant");
  const key = keyArg(input.idempotencyKey);
  const changes = await writeEntry(
    db,
    db.prepare(GRANT_INSERT_SQL).bind(poolId, milli, actor, reason, key),
    input.audit,
  );
  const entry = await entryByKey(db, key);
  if (changes > 0) {
    if (!entry) throw new Error("a grant that was just written could not be read");
    return { ok: true, replayed: false, entry };
  }
  if (entry) {
    if (entry.kind !== "grant" || entry.pool_id !== poolId || entry.granted_delta_milli !== milli) {
      return conflict();
    }
    return { ok: true, replayed: true, entry };
  }
  throw new ComputeLedgerError("pool_not_found", "no such pool");
}

export type AdjustResult = EntryResult | { ok: false; code: "would_go_negative" };

/**
 * Correct a pool's grant or its charge, up or down: one `adjust` entry whose delta is on exactly
 * one of them, with who and a fixed-word reason (required). A correction of the charge of an
 * account's or a partner's pool names the platform budget it was counted against (`budgetPoolId`),
 * which follows it; a correction of the grant names none. One that would make a stored total
 * negative (the pool's granted or charged, or the budget's charged) is `would_go_negative` and
 * writes nothing; a grant adjusted below what is used is allowed, and available goes negative.
 */
export async function adjustPool(
  db: D1Database,
  input: {
    poolId: number;
    budgetPoolId?: number | null;
    grantedDeltaMilli?: number;
    chargedDeltaMilli?: number;
    actorUserId: number | null;
    reason: string;
    idempotencyKey: string;
    audit?: LedgerAudit;
  },
): Promise<AdjustResult> {
  const poolId = positiveId("a pool", input.poolId);
  const granted =
    input.grantedDeltaMilli === undefined
      ? 0
      : signedAmount("an adjustment of the grant", input.grantedDeltaMilli);
  const charged =
    input.chargedDeltaMilli === undefined
      ? 0
      : signedAmount("an adjustment of the charge", input.chargedDeltaMilli);
  if ((granted !== 0) === (charged !== 0)) {
    return invalid("an adjustment changes exactly one of the grant and the charge");
  }
  const budget =
    input.budgetPoolId === undefined || input.budgetPoolId === null
      ? null
      : positiveId("a budget pool", input.budgetPoolId);
  if (budget !== null && charged === 0) invalid("only an adjustment of the charge names a budget");
  if (input.reason === undefined || input.reason === null) invalid("an adjustment has a reason");
  const reason = reasonArg(input.reason, null);
  const actor = actorArg(input.actorUserId);
  const key = keyArg(input.idempotencyKey);
  const changes = await writeEntry(
    db,
    db.prepare(ADJUST_INSERT_SQL).bind(poolId, budget, granted, charged, actor, reason, key),
    input.audit,
  );
  const entry = await entryByKey(db, key);
  if (changes > 0) {
    if (!entry) throw new Error("an adjustment that was just written could not be read");
    return { ok: true, replayed: false, entry };
  }
  if (entry) {
    if (
      entry.kind !== "adjust" ||
      entry.pool_id !== poolId ||
      entry.budget_pool_id !== budget ||
      entry.granted_delta_milli !== granted ||
      entry.charged_delta_milli !== charged
    ) {
      return conflict();
    }
    return { ok: true, replayed: true, entry };
  }
  if (!(await getPool(db, poolId))) {
    throw new ComputeLedgerError("pool_not_found", "no such pool");
  }
  return { ok: false, code: "would_go_negative" };
}

export type ExpireResult =
  | { ok: true; replayed: boolean; expiredMilli: number; entry: LedgerRow }
  | { ok: false; code: "nothing_to_expire" };

/**
 * Let a pool's unused balance lapse (a renewal): one `expire` entry that takes the whole available
 * balance out of granted. What is held and charged stays, so an open hold still settles. A pool with
 * no positive available (an overrun left it negative) has nothing to take: `nothing_to_expire`. A
 * repeated key returns the entry it made.
 */
export async function expireUnused(
  db: D1Database,
  input: { poolId: number; reason?: string; idempotencyKey: string; actorUserId?: number | null },
): Promise<ExpireResult> {
  const poolId = positiveId("a pool", input.poolId);
  const reason = reasonArg(input.reason, "expired");
  const key = keyArg(input.idempotencyKey);
  const actor = actorArg(input.actorUserId);
  const changes =
    (await db.prepare(EXPIRE_INSERT_SQL).bind(poolId, reason, key, actor).run()).meta?.changes ?? 0;
  const entry = await entryByKey(db, key);
  if (changes > 0) {
    if (!entry) throw new Error("an expiry that was just written could not be read");
    return { ok: true, replayed: false, expiredMilli: -entry.granted_delta_milli, entry };
  }
  if (entry) {
    if (entry.kind !== "expire" || entry.pool_id !== poolId) return conflict();
    return { ok: true, replayed: true, expiredMilli: -entry.granted_delta_milli, entry };
  }
  if (!(await getPool(db, poolId))) {
    throw new ComputeLedgerError("pool_not_found", "no such pool");
  }
  return { ok: false, code: "nothing_to_expire" };
}

// --- Reads for the routes --------------------------------------------------------------------

/** A page of pools, oldest first: `?1` holder kind (NULL for any), `?2` after this id, `?3` a page of this many. */
export const POOLS_PAGE_SQL = `SELECT ${POOL_COLUMNS} FROM compute_pools
  WHERE (?1 IS NULL OR holder_kind = ?1) AND id > ?2 ORDER BY id LIMIT ?3`;

export async function listPools(
  db: D1Database,
  q: { holderKind?: PoolHolderKind; after?: number; limit: number },
): Promise<{ pools: PoolRow[]; nextAfter: number | null }> {
  const rows = (
    await db
      .prepare(POOLS_PAGE_SQL)
      .bind(q.holderKind ?? null, q.after ?? 0, q.limit + 1)
      .all<PoolRow>()
  ).results;
  const pools = rows.slice(0, q.limit);
  return { pools, nextAfter: rows.length > q.limit ? (pools[pools.length - 1]?.id ?? null) : null };
}

/** An account's pools (at most one for each word), cpu first. */
export const ACCOUNT_POOLS_SQL = `SELECT ${POOL_COLUMNS} FROM compute_pools
  WHERE holder_kind = 'account' AND holder_ref = ?1 ORDER BY pool`;

export async function accountPools(db: D1Database, accountId: number): Promise<PoolRow[]> {
  return (await db.prepare(ACCOUNT_POOLS_SQL).bind(String(accountId)).all<PoolRow>()).results;
}

/** A platform budget's pool of one word, which the migration seeds for `pipelines` and `people`. */
export async function platformPool(
  db: D1Database,
  key: string,
  pool: ComputePool,
): Promise<PoolRow | null> {
  return db.prepare(POOL_BY_HOLDER_SQL).bind("platform", key, pool).first<PoolRow>();
}
