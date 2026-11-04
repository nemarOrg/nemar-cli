/**
 * Migration 0114_compute_ledger.sql (epic #2005 phase A2, #2007; ADR 0118), on two engines:
 * bun:sqlite, which every other suite uses, and Miniflare's D1, the implementation `wrangler
 * --local` runs. bun:sqlite is more permissive than the SQLite D1 ships (a GLOB that D1 calls too
 * complex, a construct it compiles differently), so a CHECK, a trigger or an index proven only on
 * the first is not proven.
 *
 * What is pinned: the words in the file are the words of `shared/compute-state.ts` and
 * `shared/contract/compute.ts`; every CHECK of the three tables refuses its violating row, by name,
 * and accepts its valid one; the ledger and the policy are append-only and a pool is never deleted;
 * the AFTER INSERT trigger is the one writer of a pool's totals (the entry and the totals are one
 * statement, so an entry the totals refuse is not written either); the entry's pool and its budget
 * are checked to exist; a hold closes once and a job has one hold; and the stored totals equal the
 * sums of the ledger after a mixed sequence.
 *
 * The ledger is append-only, so nothing can be cleaned up between tests: every test makes its own
 * account, pools, jobs and keys, and reads only what it made.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPUTE_WORD_RE, LEDGER_ENTRY_KINDS } from "../../shared/compute-state";
import { COMPUTE_JOB_ID_RE, COMPUTE_POOLS } from "../../shared/contract/compute";
import {
  type MiniflareD1,
  jobId,
  miniflareD1,
  platformPoolId,
  totalsDisagreements,
} from "./helpers/compute-ledger";
import { freshDb, realD1 } from "./helpers/d1";
import { MIGRATIONS_DIR } from "./helpers/miniflare-d1";

const FILE = "0114_compute_ledger.sql";
const SQL = readFileSync(join(MIGRATIONS_DIR, FILE), "utf-8");

type Row = Record<string, unknown>;

interface Engine {
  name: string;
  d1: D1Database;
  run(sql: string, ...binds: unknown[]): Promise<string | null>;
  all<T>(sql: string, ...binds: unknown[]): Promise<T[]>;
}

let seq = 1000;
const next = () => ++seq;
const key = () => `k-${next()}-${Math.random().toString(36).slice(2, 8)}`;

const ENGINES: Engine[] = [];
let mf: MiniflareD1;

beforeAll(async () => {
  const db = freshDb();
  const sqlite = realD1(db);
  ENGINES.push({
    name: "bun:sqlite",
    d1: sqlite,
    async run(sql, ...binds) {
      try {
        db.prepare(sql).run(...(binds as never[]));
        return null;
      } catch (err) {
        return String(err);
      }
    },
    async all<T>(sql: string, ...binds: unknown[]) {
      return db.prepare(sql).all(...(binds as never[])) as T[];
    },
  });
  mf = await miniflareD1();
  ENGINES.push({
    name: "Miniflare D1",
    d1: mf.d1,
    async run(sql, ...binds) {
      try {
        await mf.d1
          .prepare(sql)
          .bind(...binds)
          .run();
        return null;
      } catch (err) {
        return String(err);
      }
    },
    async all<T>(sql: string, ...binds: unknown[]) {
      return (
        await mf.d1
          .prepare(sql)
          .bind(...binds)
          .all<T>()
      ).results;
    },
  });
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
}, 30_000);

function onEveryEngine(name: string, body: (e: Engine) => Promise<void>) {
  test(name, async () => {
    expect(ENGINES).toHaveLength(2);
    for (const e of ENGINES) {
      try {
        await body(e);
      } catch (err) {
        throw new Error(`${e.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
}

async function insertRow(e: Engine, table: string, row: Row): Promise<string | null> {
  const cols = Object.keys(row);
  return e.run(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...cols.map((c) => row[c]),
  );
}

/** A new account's pool of one word; the account number is unique per call. */
async function accountPool(
  e: Engine,
  pool: "cpu" | "gpu" = "cpu",
  over: Row = {},
): Promise<number> {
  const ref = String(100000 + next());
  const err = await insertRow(e, "compute_pools", {
    holder_kind: "account",
    holder_ref: ref,
    pool,
    ...over,
  });
  if (err) throw new Error(`could not make a pool: ${err}`);
  const row = (
    await e.all<{ id: number }>(
      "SELECT id FROM compute_pools WHERE holder_kind = 'account' AND holder_ref = ? AND pool = ?",
      ref,
      pool,
    )
  )[0];
  return row?.id ?? 0;
}

/** A platform pool of its own (cpu), so a test can read a budget nobody else has touched. */
async function accountPlatform(e: Engine): Promise<number> {
  const ref = `bt${next()}`;
  const err = await insertRow(e, "compute_pools", {
    holder_kind: "platform",
    holder_ref: ref,
    pool: "cpu",
  });
  if (err) throw new Error(`could not make a platform pool: ${err}`);
  const row = (
    await e.all<{ id: number }>(
      "SELECT id FROM compute_pools WHERE holder_kind = 'platform' AND holder_ref = ?",
      ref,
    )
  )[0];
  return row?.id ?? 0;
}

async function entry(e: Engine, row: Row): Promise<string | null> {
  return insertRow(e, "compute_ledger", { idempotency_key: key(), ...row });
}

/** What a pool holds. */
async function totals(e: Engine, id: number) {
  const rows = await e.all<{ granted_milli: number; held_milli: number; charged_milli: number }>(
    "SELECT granted_milli, held_milli, charged_milli FROM compute_pools WHERE id = ?",
    id,
  );
  const r = rows[0];
  return [r?.granted_milli, r?.held_milli, r?.charged_milli];
}

/** A pool with 100000 granted, 5000 held and 10000 charged, so any single entry of a kind applies. */
async function richPool(e: Engine, pool: "cpu" | "gpu" = "cpu"): Promise<number> {
  const id = await accountPool(e, pool);
  expect(await entry(e, { kind: "grant", pool_id: id, granted_delta_milli: 100000 })).toBeNull();
  expect(
    await entry(e, { kind: "hold", pool_id: id, held_delta_milli: 5000, job_id: jobId(next()) }),
  ).toBeNull();
  expect(
    await entry(e, {
      kind: "overrun",
      pool_id: id,
      charged_delta_milli: 10000,
      job_id: jobId(next()),
    }),
  ).toBeNull();
  return id;
}

const NAMED = (name: string) => new RegExp(`CHECK constraint failed: ${name}\\b`);
const UNIQUE = /UNIQUE constraint failed/;
const APPEND_ONLY = /append-only/;

describe("the file says the shared words", () => {
  test("the kinds are the ledger kinds of shared/compute-state.ts, in its order", () => {
    const m = /CONSTRAINT compute_ledger_kind CHECK \(kind IN\s*\(([^)]*)\)\)/.exec(SQL);
    const words = [...(m?.[1] ?? "").matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
    expect(words).toEqual([...LEDGER_ENTRY_KINDS]);
  });

  test("the pool words are the pools of shared/contract/compute.ts", () => {
    const m = /CONSTRAINT compute_pools_pool CHECK \(pool IN \(([^)]*)\)\)/.exec(SQL);
    const words = [...(m?.[1] ?? "").matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
    expect(words).toEqual([...COMPUTE_POOLS]);
  });

  test("no GLOB pattern is longer than D1 takes (50 characters)", () => {
    const patterns = [...SQL.matchAll(/GLOB\s+'([^']*)'/g)].map((m) => m[1] as string);
    expect(patterns.length).toBeGreaterThan(3);
    for (const p of patterns) expect([p, p.length <= 50]).toEqual([p, true]);
  });

  onEveryEngine("a reason takes what COMPUTE_WORD_RE takes", async (e) => {
    const samples = [
      "a",
      "top_up",
      "9lives",
      "A",
      "a-b",
      "a b",
      "",
      "é",
      "a.b",
      "x".repeat(64),
      "x".repeat(65),
    ];
    const pool = await accountPool(e);
    for (const reason of samples) {
      // Only the reason varies; a grant is valid otherwise, so a refusal here is the reason's.
      const err = await entry(e, {
        kind: "grant",
        pool_id: pool,
        granted_delta_milli: 1,
        reason,
      });
      expect([reason, err === null]).toEqual([reason, COMPUTE_WORD_RE.test(reason)]);
    }
  });

  onEveryEngine("a job id takes what COMPUTE_JOB_ID_RE takes", async (e) => {
    const good = jobId(next());
    const samples = [
      good,
      good.toUpperCase(),
      `JOB_${good.slice(4)}`,
      good.slice(0, -1),
      `${good}0`,
      `job_${"g".repeat(24)}`,
      `job-${good.slice(4)}`,
      "",
    ];
    const pool = await richPool(e);
    for (const job of samples) {
      const err = await entry(e, {
        kind: "overrun",
        pool_id: pool,
        charged_delta_milli: 1,
        job_id: job,
      });
      expect([job, err === null]).toEqual([job, COMPUTE_JOB_ID_RE.test(job)]);
    }
  });
});

describe("compute_policy", () => {
  const policy = (over: Row = {}) => ({
    policy_json: '{"a":1}',
    set_by: 7,
    note: "first",
    ...over,
  });

  onEveryEngine(
    "a valid version is accepted, and the highest version is the current one",
    async (e) => {
      expect(await insertRow(e, "compute_policy", policy())).toBeNull();
      expect(
        await insertRow(e, "compute_policy", policy({ policy_json: '{"b":2}', note: null })),
      ).toBeNull();
      const rows = await e.all<{ version: number; policy_json: string; created_at: string }>(
        "SELECT version, policy_json, created_at FROM compute_policy ORDER BY version DESC LIMIT 1",
      );
      expect(rows[0]?.policy_json).toBe('{"b":2}');
      expect(rows[0]?.created_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
      const versions = (
        await e.all<{ version: number }>("SELECT version FROM compute_policy ORDER BY version")
      ).map((r) => r.version);
      expect(versions[versions.length - 1]).toBeGreaterThan(versions[0] as number);
    },
  );

  const refused: Array<[string, Row]> = [
    ["text that is not JSON", { policy_json: "{not json" }],
    ["an empty string", { policy_json: "" }],
    ["JSON that is an array", { policy_json: "[]" }],
    ["JSON that is a number", { policy_json: "1" }],
    ["JSON that is null", { policy_json: "null" }],
    ["a document over 64 KiB", { policy_json: `{"a":"${"x".repeat(65536)}"}` }],
    ["no document", { policy_json: null }],
    ["an author of 0", { set_by: 0 }],
    ["no author", { set_by: null }],
    ["an empty note", { note: "" }],
    ["a note of 501 characters", { note: "n".repeat(501) }],
  ];
  for (const [name, over] of refused) {
    onEveryEngine(`${name} is refused`, async (e) => {
      expect(await insertRow(e, "compute_policy", policy(over))).toMatch(
        /CHECK constraint failed|NOT NULL constraint failed/,
      );
    });
  }

  onEveryEngine("a note of 500 characters and a document of 64 KiB are accepted", async (e) => {
    const pad = 65536 - '{"a":""}'.length;
    expect(
      await insertRow(
        e,
        "compute_policy",
        policy({ note: "n".repeat(500), policy_json: `{"a":"${"x".repeat(pad)}"}` }),
      ),
    ).toBeNull();
  });

  onEveryEngine("a version cannot be changed or removed", async (e) => {
    expect(await insertRow(e, "compute_policy", policy())).toBeNull();
    const v = (
      await e.all<{ version: number }>("SELECT MAX(version) AS version FROM compute_policy")
    )[0]?.version;
    expect(await e.run("UPDATE compute_policy SET note = 'changed' WHERE version = ?", v)).toMatch(
      APPEND_ONLY,
    );
    expect(
      await e.run("UPDATE compute_policy SET policy_json = '{}' WHERE version = ?", v),
    ).toMatch(APPEND_ONLY);
    expect(await e.run("DELETE FROM compute_policy WHERE version = ?", v)).toMatch(APPEND_ONLY);
    expect(await e.run("DELETE FROM compute_policy")).toMatch(APPEND_ONLY);
    const kept = await e.all<{ note: string | null }>(
      "SELECT note FROM compute_policy WHERE version = ?",
      v,
    );
    expect(kept[0]?.note).toBe("first");
  });
});

describe("compute_pools", () => {
  onEveryEngine("the four platform pools are seeded", async (e) => {
    const rows = await e.all<{ holder_ref: string; pool: string }>(
      "SELECT holder_ref, pool FROM compute_pools WHERE holder_kind = 'platform' ORDER BY holder_ref, pool",
    );
    expect(rows).toEqual([
      { holder_ref: "people", pool: "cpu" },
      { holder_ref: "people", pool: "gpu" },
      { holder_ref: "pipelines", pool: "cpu" },
      { holder_ref: "pipelines", pool: "gpu" },
    ]);
  });

  onEveryEngine(
    "an account, a partner and a platform pool are accepted, with zero totals",
    async (e) => {
      const n = next();
      for (const row of [
        { holder_kind: "account", holder_ref: String(n), pool: "cpu" },
        { holder_kind: "account", holder_ref: String(n), pool: "gpu" },
        { holder_kind: "partner", holder_ref: `client-${n}.v_2`, pool: "cpu" },
        { holder_kind: "platform", holder_ref: `extra${n}`, pool: "gpu" },
      ]) {
        expect(await insertRow(e, "compute_pools", row)).toBeNull();
      }
      expect(await totals(e, await accountPool(e))).toEqual([0, 0, 0]);
    },
  );

  const base = () => ({ holder_kind: "account", holder_ref: String(500000 + next()), pool: "cpu" });
  const refused: Array<[string, string, Row]> = [
    ["a holder kind outside the three", "compute_pools_holder_kind", { holder_kind: "tenant" }],
    ["an empty holder", "compute_pools_holder_ref", { holder_ref: "" }],
    [
      "a holder of 65 characters",
      "compute_pools_holder_ref",
      { holder_kind: "partner", holder_ref: "p".repeat(65) },
    ],
    [
      "a holder with a space",
      "compute_pools_holder_ref",
      { holder_kind: "partner", holder_ref: "a b" },
    ],
    [
      "a holder with a slash",
      "compute_pools_holder_ref",
      { holder_kind: "partner", holder_ref: "a/b" },
    ],
    ["an account that is not a number", "compute_pools_holder_ref", { holder_ref: "abc" }],
    [
      "an account that starts with a digit and goes on",
      "compute_pools_holder_ref",
      { holder_ref: "1a" },
    ],
    ["an account with a dot", "compute_pools_holder_ref", { holder_ref: "1.5" }],
    ["an account with a leading zero", "compute_pools_holder_ref", { holder_ref: "012" }],
    ["an account of 0", "compute_pools_holder_ref", { holder_ref: "0" }],
    ["a pool outside the two", "compute_pools_pool", { pool: "tpu" }],
    ["a negative grant", "compute_pools_granted", { granted_milli: -1 }],
    ["a negative hold", "compute_pools_held", { held_milli: -1 }],
    ["a negative charge", "compute_pools_charged", { charged_milli: -1 }],
    ["a fractional grant", "compute_pools_granted", { granted_milli: 1.5 }],
    ["a fractional hold", "compute_pools_held", { held_milli: 0.5 }],
    ["a fractional charge", "compute_pools_charged", { charged_milli: 2.25 }],
    ["a grant that is text", "compute_pools_granted", { granted_milli: "lots" }],
    [
      "a grant beyond what a double holds exactly",
      "compute_pools_granted",
      { granted_milli: "9007199254740992" },
    ],
    ["a frozen flag of 2", "compute_pools_frozen", { frozen: 2 }],
  ];
  for (const [name, constraint, over] of refused) {
    onEveryEngine(`${name} is refused`, async (e) => {
      expect(await insertRow(e, "compute_pools", { ...base(), ...over })).toMatch(
        NAMED(constraint),
      );
    });
  }

  onEveryEngine("the same holder and pool twice is refused, the other word is not", async (e) => {
    const row = base();
    expect(await insertRow(e, "compute_pools", row)).toBeNull();
    expect(await insertRow(e, "compute_pools", row)).toMatch(UNIQUE);
    expect(await insertRow(e, "compute_pools", { ...row, pool: "gpu" })).toBeNull();
  });

  onEveryEngine("a pool is never deleted and its identity never changes", async (e) => {
    const id = await accountPool(e);
    expect(await e.run("DELETE FROM compute_pools WHERE id = ?", id)).toMatch(/never deleted/);
    expect(await e.run("UPDATE compute_pools SET pool = 'gpu' WHERE id = ?", id)).toMatch(
      /identity/,
    );
    expect(await e.run("UPDATE compute_pools SET holder_ref = '999' WHERE id = ?", id)).toMatch(
      /identity/,
    );
    expect(
      await e.run("UPDATE compute_pools SET holder_kind = 'partner' WHERE id = ?", id),
    ).toMatch(/identity/);
    expect(await e.run("UPDATE compute_pools SET id = id + 90000000 WHERE id = ?", id)).toMatch(
      /identity/,
    );
    // The flag is the one thing that is not the ledger's, and an operator may set it.
    expect(await e.run("UPDATE compute_pools SET frozen = 1 WHERE id = ?", id)).toBeNull();
    expect(await e.run("UPDATE compute_pools SET frozen = 0 WHERE id = ?", id)).toBeNull();
  });
});

describe("compute_ledger: what each kind may carry", () => {
  /** A valid entry of each kind, laid over with `over`. `n` makes the job and the hold unique. */
  function valid(kind: string, pool: number, over: Row = {}): Row {
    const n = next();
    const job = jobId(n);
    const base: Record<string, Row> = {
      grant: { granted_delta_milli: 5000 },
      hold: { held_delta_milli: 2000, job_id: job },
      release: { held_delta_milli: -2000, job_id: job, hold_ref: n },
      charge: { held_delta_milli: -2000, charged_delta_milli: 1500, job_id: job, hold_ref: n },
      refund: { charged_delta_milli: -500, job_id: job },
      adjust: { charged_delta_milli: 100 },
      overrun: { charged_delta_milli: 300, job_id: job },
      expire: { granted_delta_milli: -100 },
    };
    return { kind, pool_id: pool, ...base[kind], ...over };
  }

  onEveryEngine("a valid entry of every kind is accepted", async (e) => {
    const pool = await richPool(e);
    for (const kind of LEDGER_ENTRY_KINDS) {
      expect([kind, await entry(e, valid(kind, pool))]).toEqual([kind, null]);
    }
    // Both ways of an adjustment, and an adjustment of the grant.
    expect(await entry(e, valid("adjust", pool, { charged_delta_milli: -100 }))).toBeNull();
    expect(
      await entry(e, valid("adjust", pool, { charged_delta_milli: 0, granted_delta_milli: 100 })),
    ).toBeNull();
    expect(
      await entry(e, valid("adjust", pool, { charged_delta_milli: 0, granted_delta_milli: -100 })),
    ).toBeNull();
    expect(await totalsDisagreements(e.d1)).toEqual([]);
  });

  type Case = [string, string, Row, string];
  /** Stands for the platform pool of the person's word, which only a running engine can name. */
  const PLATFORM = "platform-pool";
  const D = "compute_ledger_deltas";
  const cases: Case[] = [
    ["a grant that holds", "grant", { held_delta_milli: 1 }, D],
    ["a grant of nothing", "grant", { granted_delta_milli: 0 }, D],
    ["a grant that takes away", "grant", { granted_delta_milli: -1 }, D],
    ["a grant that charges", "grant", { charged_delta_milli: 1 }, D],
    ["a hold that grants", "hold", { granted_delta_milli: 1 }, D],
    ["a hold of nothing", "hold", { held_delta_milli: 0 }, D],
    ["a hold that gives back", "hold", { held_delta_milli: -1 }, D],
    ["a hold that charges", "hold", { charged_delta_milli: 1 }, D],
    ["a release that holds", "release", { held_delta_milli: 1 }, D],
    ["a release of nothing", "release", { held_delta_milli: 0 }, D],
    ["a release that charges", "release", { charged_delta_milli: 1 }, D],
    ["a release that grants", "release", { granted_delta_milli: 1 }, D],
    ["a charge that holds more", "charge", { held_delta_milli: 1 }, D],
    ["a charge that refunds", "charge", { charged_delta_milli: -1 }, D],
    ["a charge that grants", "charge", { granted_delta_milli: 1 }, D],
    ["a refund of nothing", "refund", { charged_delta_milli: 0 }, D],
    ["a refund that charges", "refund", { charged_delta_milli: 1 }, D],
    ["a refund that holds", "refund", { held_delta_milli: 1 }, D],
    ["a refund that grants", "refund", { granted_delta_milli: 1 }, D],
    ["an adjustment of nothing", "adjust", { charged_delta_milli: 0 }, D],
    [
      "an adjustment of both the grant and the charge",
      "adjust",
      { granted_delta_milli: 1, charged_delta_milli: 1 },
      D,
    ],
    ["an adjustment that holds", "adjust", { held_delta_milli: 1 }, D],
    ["an overrun of nothing", "overrun", { charged_delta_milli: 0 }, D],
    ["an overrun that refunds", "overrun", { charged_delta_milli: -1 }, D],
    ["an overrun that holds", "overrun", { held_delta_milli: 1 }, D],
    ["an overrun that grants", "overrun", { granted_delta_milli: 1 }, D],
    ["an expiry of nothing", "expire", { granted_delta_milli: 0 }, D],
    ["an expiry that grants", "expire", { granted_delta_milli: 1 }, D],
    ["an expiry that holds", "expire", { held_delta_milli: 1 }, D],
    ["an expiry that charges", "expire", { charged_delta_milli: 1 }, D],
    ["a kind outside the eight", "close", {}, "compute_ledger_kind"],
    ["a hold with no job", "hold", { job_id: null }, "compute_ledger_job_required"],
    ["a release with no job", "release", { job_id: null }, "compute_ledger_job_required"],
    ["a charge with no job", "charge", { job_id: null }, "compute_ledger_job_required"],
    ["a refund with no job", "refund", { job_id: null }, "compute_ledger_job_required"],
    ["an overrun with no job", "overrun", { job_id: null }, "compute_ledger_job_required"],
    ["a release with no hold", "release", { hold_ref: null }, "compute_ledger_closing_hold"],
    ["a charge with no hold", "charge", { hold_ref: null }, "compute_ledger_closing_hold"],
    ["a grant that names a hold", "grant", { hold_ref: 1 }, "compute_ledger_hold_ref_kinds"],
    ["a hold that names a hold", "hold", { hold_ref: 1 }, "compute_ledger_hold_ref_kinds"],
    ["a refund that names a hold", "refund", { hold_ref: 1 }, "compute_ledger_hold_ref_kinds"],
    ["an adjustment that names a hold", "adjust", { hold_ref: 1 }, "compute_ledger_hold_ref_kinds"],
    ["an expiry that names a hold", "expire", { hold_ref: 1 }, "compute_ledger_hold_ref_kinds"],
    ["a hold of 0 as its reference", "release", { hold_ref: 0 }, "compute_ledger_hold_ref"],
    ["a budget on a grant", "grant", { budget_pool_id: PLATFORM }, "compute_ledger_budget_kinds"],
    [
      "a budget on an expiry",
      "expire",
      { budget_pool_id: PLATFORM },
      "compute_ledger_budget_kinds",
    ],
    [
      "a budget on an adjustment of the grant",
      "adjust",
      { charged_delta_milli: 0, granted_delta_milli: 1, budget_pool_id: PLATFORM },
      "compute_ledger_budget_kinds",
    ],
    ["a fractional grant", "grant", { granted_delta_milli: 1.5 }, "compute_ledger_granted_int"],
    ["a fractional hold", "hold", { held_delta_milli: 0.5 }, "compute_ledger_held_int"],
    ["a fractional charge", "overrun", { charged_delta_milli: 2.5 }, "compute_ledger_charged_int"],
    [
      "a grant that is text",
      "grant",
      { granted_delta_milli: "lots" },
      "compute_ledger_granted_int",
    ],
    [
      "a grant beyond what a double holds exactly",
      "grant",
      { granted_delta_milli: "9007199254740992" },
      "compute_ledger_granted_int",
    ],
    [
      "a charge beyond what a double holds exactly",
      "overrun",
      { charged_delta_milli: "9007199254740992" },
      "compute_ledger_charged_int",
    ],
    ["a job id in capitals", "hold", { job_id: `job_${"A".repeat(24)}` }, "compute_ledger_job_id"],
    ["a job id one short", "hold", { job_id: `job_${"a".repeat(23)}` }, "compute_ledger_job_id"],
    ["a reason in capitals", "grant", { reason: "Top_Up" }, "compute_ledger_reason"],
    ["an empty reason", "grant", { reason: "" }, "compute_ledger_reason"],
    ["a reason with a hyphen", "grant", { reason: "top-up" }, "compute_ledger_reason"],
    ["a reason of 65 characters", "grant", { reason: "r".repeat(65) }, "compute_ledger_reason"],
    ["an actor of 0", "grant", { actor_user_id: 0 }, "compute_ledger_actor"],
    ["an empty key", "grant", { idempotency_key: "" }, "compute_ledger_key"],
    ["a key with a space", "grant", { idempotency_key: "a b" }, "compute_ledger_key"],
    ["a key with a slash", "grant", { idempotency_key: "a/b" }, "compute_ledger_key"],
    [
      "a key of 129 characters",
      "grant",
      { idempotency_key: "k".repeat(129) },
      "compute_ledger_key",
    ],
  ];
  for (const [name, kind, over, constraint] of cases) {
    onEveryEngine(`${name} is refused`, async (e) => {
      const pool = await richPool(e);
      const resolved =
        over.budget_pool_id === PLATFORM
          ? { ...over, budget_pool_id: await platformPoolId(e.d1, "people", "cpu") }
          : over;
      expect(await entry(e, valid(kind, pool, resolved))).toMatch(NAMED(constraint));
    });
  }

  onEveryEngine("a reason, an actor and a key at their limits are accepted", async (e) => {
    const pool = await accountPool(e);
    expect(
      await entry(e, {
        kind: "grant",
        pool_id: pool,
        granted_delta_milli: 9007199254740991,
        reason: "r".repeat(64),
        actor_user_id: 1,
        idempotency_key: `a${"k".repeat(126)}z`,
      }),
    ).toBeNull();
    expect(await totals(e, pool)).toEqual([9007199254740991, 0, 0]);
    expect(
      await entry(e, {
        kind: "grant",
        pool_id: await accountPool(e),
        granted_delta_milli: 1,
        idempotency_key: "grant:Ab9._:-x",
      }),
    ).toBeNull();
  });

  onEveryEngine(
    "a total beyond what a double holds exactly is refused, with its entry",
    async (e) => {
      const pool = await accountPool(e);
      const big = { kind: "grant", pool_id: pool, granted_delta_milli: 9007199254740991 };
      expect(await entry(e, big)).toBeNull();
      expect(await entry(e, { kind: "grant", pool_id: pool, granted_delta_milli: 1 })).toMatch(
        NAMED("compute_pools_granted"),
      );
      expect(
        (
          await e.all<{ n: number }>(
            "SELECT COUNT(*) AS n FROM compute_ledger WHERE pool_id = ?",
            pool,
          )
        )[0]?.n,
      ).toBe(1);
      expect(await totals(e, pool)).toEqual([9007199254740991, 0, 0]);
    },
  );

  onEveryEngine("an entry may carry a budget only if it spends", async (e) => {
    const person = await richPool(e, "cpu");
    const budget = await platformPoolId(e.d1, "people", "cpu");
    // Seed the budget so a release and a refund can apply to it.
    const bj = jobId(next());
    expect(
      await entry(e, { kind: "grant", pool_id: budget, granted_delta_milli: 1000000 }),
    ).toBeNull();
    expect(
      await entry(e, {
        kind: "hold",
        pool_id: person,
        budget_pool_id: budget,
        held_delta_milli: 10000,
        job_id: bj,
      }),
    ).toBeNull();
    for (const kind of ["release", "charge", "overrun", "refund"] as const) {
      const row = valid(kind, person, { budget_pool_id: budget });
      expect([kind, await entry(e, row)]).toEqual([kind, null]);
    }
    expect(await entry(e, valid("hold", person, { budget_pool_id: budget }))).toBeNull();
    expect(await entry(e, valid("adjust", person, { budget_pool_id: budget }))).toBeNull();
    expect(await totalsDisagreements(e.d1)).toEqual([]);
  });
});

describe("compute_ledger: the pool and the budget it names", () => {
  onEveryEngine("an entry for a pool that does not exist is refused", async (e) => {
    for (const id of [90000000 + next(), 0, -1]) {
      expect(await entry(e, { kind: "grant", pool_id: id, granted_delta_milli: 1 })).toMatch(
        /names a pool that exists/,
      );
    }
  });

  onEveryEngine(
    "a budget that does not exist, is not a platform pool or is the other word is refused",
    async (e) => {
      const person = await richPool(e, "cpu");
      const hold = (budget: number) => ({
        kind: "hold",
        pool_id: person,
        budget_pool_id: budget,
        held_delta_milli: 1,
        job_id: jobId(next()),
      });
      const before = await totals(e, person);
      expect(await entry(e, hold(90000000 + next()))).toMatch(/platform pool of the same word/);
      expect(await entry(e, hold(await accountPool(e, "cpu")))).toMatch(
        /platform pool of the same word/,
      );
      expect(await entry(e, hold(await platformPoolId(e.d1, "people", "gpu")))).toMatch(
        /platform pool of the same word/,
      );
      expect(await totals(e, person)).toEqual(before);
      expect(await entry(e, hold(await platformPoolId(e.d1, "people", "cpu")))).toBeNull();
      expect(await entry(e, hold(await platformPoolId(e.d1, "pipelines", "cpu")))).toBeNull();
    },
  );

  onEveryEngine("an entry cannot be its own budget", async (e) => {
    const own = await platformPoolId(e.d1, "pipelines", "gpu");
    expect(
      await entry(e, {
        kind: "hold",
        pool_id: own,
        budget_pool_id: own,
        held_delta_milli: 1,
        job_id: jobId(next()),
      }),
    ).toMatch(NAMED("compute_ledger_budget_distinct"));
  });
});

describe("compute_ledger: append-only, and one close per hold", () => {
  onEveryEngine("an entry cannot be changed or removed", async (e) => {
    const pool = await accountPool(e);
    const k = key();
    expect(
      await entry(e, { kind: "grant", pool_id: pool, granted_delta_milli: 10, idempotency_key: k }),
    ).toBeNull();
    for (const sql of [
      "UPDATE compute_ledger SET granted_delta_milli = 999 WHERE idempotency_key = ?",
      "UPDATE compute_ledger SET reason = 'edited' WHERE idempotency_key = ?",
      "UPDATE compute_ledger SET pool_id = 1 WHERE idempotency_key = ?",
      "DELETE FROM compute_ledger WHERE idempotency_key = ?",
    ]) {
      expect([sql, await e.run(sql, k)]).toEqual([sql, expect.stringMatching(APPEND_ONLY)]);
    }
    expect(await e.run("DELETE FROM compute_ledger")).toMatch(APPEND_ONLY);
    expect(await totals(e, pool)).toEqual([10, 0, 0]);
  });

  onEveryEngine("a key is used once", async (e) => {
    const pool = await accountPool(e);
    const k = key();
    const grant = { kind: "grant", pool_id: pool, granted_delta_milli: 10, idempotency_key: k };
    expect(await entry(e, grant)).toBeNull();
    expect(await entry(e, grant)).toMatch(UNIQUE);
    expect(await totals(e, pool)).toEqual([10, 0, 0]);
  });

  onEveryEngine(
    "a hold closes once, by a release or a charge, and a job has one hold",
    async (e) => {
      const pool = await richPool(e);
      const n = next();
      const job = jobId(n);
      expect(
        await entry(e, { kind: "hold", pool_id: pool, held_delta_milli: 100, job_id: job }),
      ).toBeNull();
      expect(
        await entry(e, { kind: "hold", pool_id: pool, held_delta_milli: 100, job_id: job }),
      ).toMatch(UNIQUE);
      const release = {
        kind: "release",
        pool_id: pool,
        held_delta_milli: -100,
        job_id: job,
        hold_ref: n,
      };
      const charge = {
        kind: "charge",
        pool_id: pool,
        held_delta_milli: -100,
        charged_delta_milli: 50,
        job_id: job,
        hold_ref: n,
      };
      expect(await entry(e, release)).toBeNull();
      expect(await entry(e, release)).toMatch(UNIQUE);
      expect(await entry(e, charge)).toMatch(UNIQUE);
      // An overrun and the entries of other holds are not closes.
      expect(
        await entry(e, {
          kind: "overrun",
          pool_id: pool,
          charged_delta_milli: 5,
          job_id: job,
          hold_ref: n,
        }),
      ).toBeNull();
      expect(await entry(e, { ...charge, hold_ref: n + 5000 })).toBeNull();
    },
  );
});

describe("the trigger is the one writer of a pool's totals", () => {
  onEveryEngine(
    "each kind moves the totals of its pool, and a budget's held and charged",
    async (e) => {
      const person = await accountPool(e, "gpu");
      const budget = await platformPoolId(e.d1, "people", "gpu");
      const base = (await totals(e, budget)) as number[];
      const n = next();
      const job = jobId(n);
      const step = async (row: Row, pool: number[], bud: number[]) => {
        expect(await entry(e, row)).toBeNull();
        expect(await totals(e, person)).toEqual(pool);
        const now = (await totals(e, budget)) as number[];
        expect(now.map((v, i) => v - (base[i] as number))).toEqual(bud);
      };
      await step(
        { kind: "grant", pool_id: person, granted_delta_milli: 10000 },
        [10000, 0, 0],
        [0, 0, 0],
      );
      await step(
        {
          kind: "hold",
          pool_id: person,
          budget_pool_id: budget,
          held_delta_milli: 4000,
          job_id: job,
        },
        [10000, 4000, 0],
        [0, 4000, 0],
      );
      await step(
        {
          kind: "charge",
          pool_id: person,
          budget_pool_id: budget,
          held_delta_milli: -4000,
          charged_delta_milli: 2500,
          job_id: job,
          hold_ref: n,
        },
        [10000, 0, 2500],
        [0, 0, 2500],
      );
      await step(
        {
          kind: "overrun",
          pool_id: person,
          budget_pool_id: budget,
          charged_delta_milli: 700,
          job_id: job,
        },
        [10000, 0, 3200],
        [0, 0, 3200],
      );
      await step(
        { kind: "adjust", pool_id: person, budget_pool_id: budget, charged_delta_milli: -200 },
        [10000, 0, 3000],
        [0, 0, 3000],
      );
      await step(
        {
          kind: "refund",
          pool_id: person,
          budget_pool_id: budget,
          charged_delta_milli: -3000,
          job_id: job,
        },
        [10000, 0, 0],
        [0, 0, 0],
      );
      await step(
        { kind: "adjust", pool_id: person, granted_delta_milli: -1000 },
        [9000, 0, 0],
        [0, 0, 0],
      );
      await step(
        { kind: "expire", pool_id: person, granted_delta_milli: -9000 },
        [0, 0, 0],
        [0, 0, 0],
      );
      expect(await totalsDisagreements(e.d1)).toEqual([]);
    },
  );

  onEveryEngine(
    "an entry whose totals would be negative is refused, and is not written either",
    async (e) => {
      const pool = await accountPool(e);
      expect(
        await entry(e, { kind: "grant", pool_id: pool, granted_delta_milli: 1000 }),
      ).toBeNull();
      // Charged 500 on the pool, with no budget, so the budget below holds nothing to take back.
      expect(
        await entry(e, {
          kind: "overrun",
          pool_id: pool,
          charged_delta_milli: 500,
          job_id: jobId(next()),
        }),
      ).toBeNull();
      const count = async () =>
        (
          await e.all<{ n: number }>(
            "SELECT COUNT(*) AS n FROM compute_ledger WHERE pool_id = ?",
            pool,
          )
        )[0]?.n;
      const before = await count();
      // A refund of more than was charged, an expiry of more than was granted, a release of what was
      // never held: the pool's own CHECK refuses the total, and the entry goes with it.
      for (const row of [
        { kind: "refund", pool_id: pool, charged_delta_milli: -501, job_id: jobId(next()) },
        { kind: "expire", pool_id: pool, granted_delta_milli: -1001 },
        {
          kind: "release",
          pool_id: pool,
          held_delta_milli: -1,
          job_id: jobId(next()),
          hold_ref: next(),
        },
        { kind: "adjust", pool_id: pool, charged_delta_milli: -501 },
        { kind: "adjust", pool_id: pool, granted_delta_milli: -1001 },
      ]) {
        expect([row.kind, await entry(e, row)]).toEqual([
          row.kind,
          expect.stringMatching(/CHECK constraint failed/),
        ]);
      }
      // The pool could take it and the budget could not: one statement, so neither is written.
      const budget = await accountPlatform(e);
      expect(
        await entry(e, {
          kind: "refund",
          pool_id: pool,
          budget_pool_id: budget,
          charged_delta_milli: -500,
          job_id: jobId(next()),
        }),
      ).toMatch(/CHECK constraint failed/);
      expect(await count()).toBe(before);
      expect(await totals(e, pool)).toEqual([1000, 0, 500]);
      expect(await totals(e, budget)).toEqual([0, 0, 0]);
      expect(await totalsDisagreements(e.d1)).toEqual([]);
    },
  );

  onEveryEngine("a refused statement of several entries leaves none of them", async (e) => {
    // The settle statement writes a charge and an overrun in one INSERT; if the second is refused
    // the first must not stay, because the statement is the unit.
    const pool = await accountPool(e);
    expect(await entry(e, { kind: "grant", pool_id: pool, granted_delta_milli: 100 })).toBeNull();
    const k = key();
    const err = await e.run(
      `INSERT INTO compute_ledger (kind, pool_id, granted_delta_milli, idempotency_key)
       SELECT 'grant', ?1, 5, ?2 UNION ALL SELECT 'grant', ?1, 0, ?3`,
      pool,
      k,
      key(),
    );
    expect(err).toMatch(NAMED("compute_ledger_deltas"));
    expect(
      (
        await e.all<{ n: number }>(
          "SELECT COUNT(*) AS n FROM compute_ledger WHERE idempotency_key = ?",
          k,
        )
      )[0]?.n,
    ).toBe(0);
    expect(await totals(e, pool)).toEqual([100, 0, 0]);
  });
});

describe("the tables and indexes", () => {
  onEveryEngine("the indexes exist", async (e) => {
    const names = (
      await e.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'compute_ledger'",
      )
    ).map((r) => r.name);
    for (const n of [
      "compute_ledger_closes_once",
      "compute_ledger_one_hold_per_job",
      "compute_ledger_pool",
      "compute_ledger_job",
    ]) {
      expect(names).toContain(n);
    }
  });

  onEveryEngine("the triggers exist", async (e) => {
    const names = (
      await e.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'compute_%' ORDER BY name",
      )
    ).map((r) => r.name);
    expect(names).toEqual([
      "compute_ledger_apply",
      "compute_ledger_budget_platform",
      "compute_ledger_no_delete",
      "compute_ledger_no_update",
      "compute_ledger_pool_exists",
      "compute_policy_no_delete",
      "compute_policy_no_update",
      "compute_pools_identity_fixed",
      "compute_pools_no_delete",
    ]);
  });
});
