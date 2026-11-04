/**
 * The compute ledger service (epic #2005 phase A2, #2007; ADR 0118), against the real migration on
 * a real database (bun:sqlite behind `realD1`). The trigger of migration 0114 is the one writer of
 * a pool's totals, so what is proven here is the service's behaviour on top of it and the property
 * the design rests on: after any sequence of operations every pool's three totals equal the sums of
 * its ledger deltas.
 *
 * What is pinned: a seeded random sequence of every operation leaves the totals equal to the
 * ledger's sums (and reaches the refusals, the overruns and a negative available, so it is not a
 * sequence that cannot fail); a settle then a final adjustment ends at the final figure, once;
 * excess use writes an `overrun` and a negative available but never a negative total; a hold closes
 * once whichever way it is closed; a refund, an adjustment and an expiry move what they say and
 * refuse what would make a total negative; an amount that is not a whole number of milli-SU is
 * refused before anything is written; a hold that is not written leaves the database as it was; and
 * no source file or migration writes a pool's totals except the trigger.
 *
 * The concurrency of a hold is proven on Miniflare's D1 in compute-ledger-race.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ComputeLedgerError,
  type LedgerRow,
  type PoolRow,
  adjustPool,
  availableMilli,
  ensurePool,
  expireUnused,
  grantPool,
  holdStatements,
  placeHold,
  refundJob,
  releaseHold,
  settleFinal,
  settleProvisional,
} from "../src/services/compute-ledger";
import { jobId, seeded, totalsDisagreements } from "./helpers/compute-ledger";
import { freshDb, realD1 } from "./helpers/d1";

const MAX = Number.MAX_SAFE_INTEGER;

let seq = 0;
const next = () => ++seq;

function world() {
  const db = freshDb();
  const d1 = realD1(db);
  return { db, d1 };
}
type World = ReturnType<typeof world>;

async function platform(w: World, key: "pipelines" | "people", pool: "cpu" | "gpu") {
  return ensurePool(w.d1, "platform", key, pool);
}

async function reread(w: World, pool: PoolRow): Promise<PoolRow> {
  return (await w.d1
    .prepare("SELECT * FROM compute_pools WHERE id = ?")
    .bind(pool.id)
    .first<PoolRow>()) as PoolRow;
}

async function grant(w: World, pool: PoolRow, amountMilli: number) {
  const r = await grantPool(w.d1, {
    poolId: pool.id,
    amountMilli,
    actorUserId: 1,
    idempotencyKey: `grant-${next()}`,
  });
  expect(r.ok).toBe(true);
}

/** A person with `grantMilli` cpu, a platform budget of `budgetMilli`, and a job held for `holdMilli`. */
async function held(
  w: World,
  o: { grantMilli?: number; budgetMilli?: number; holdMilli?: number },
) {
  const person = await ensurePool(w.d1, "account", String(10000 + next()), "cpu");
  const budget = await platform(w, "people", "cpu");
  await grant(w, person, o.grantMilli ?? 100000);
  if ((o.budgetMilli ?? 0) > 0) await grant(w, budget, o.budgetMilli as number);
  const job = jobId(next());
  const hold = await placeHold(w.d1, {
    poolId: person.id,
    budgetPoolId: budget.id,
    amountMilli: o.holdMilli ?? 5000,
    jobId: job,
    idempotencyKey: `hold-${next()}`,
  });
  return { person, budget, job, hold };
}

const count = async (w: World, where = "1 = 1") =>
  (
    await w.d1
      .prepare(`SELECT COUNT(*) AS n FROM compute_ledger WHERE ${where}`)
      .first<{ n: number }>()
  )?.n;

describe("availableMilli", () => {
  test("is granted minus held minus charged, and may be negative", () => {
    expect(availableMilli({ granted_milli: 10, held_milli: 3, charged_milli: 2 })).toBe(5);
    expect(availableMilli({ granted_milli: 10, held_milli: 0, charged_milli: 14 })).toBe(-4);
    expect(availableMilli({ granted_milli: 0, held_milli: 0, charged_milli: 0 })).toBe(0);
  });

  test("is exact at the largest total, where a double would not be", () => {
    expect(availableMilli({ granted_milli: MAX, held_milli: 0, charged_milli: MAX })).toBe(0);
    expect(availableMilli({ granted_milli: 0, held_milli: 0, charged_milli: MAX })).toBe(-MAX);
    expect(availableMilli({ granted_milli: MAX, held_milli: 1, charged_milli: 0 })).toBe(MAX - 1);
  });

  test("refuses a total that is not a whole number, and a result no double holds", () => {
    expect(() => availableMilli({ granted_milli: 1.5, held_milli: 0, charged_milli: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      availableMilli({ granted_milli: Number.NaN, held_milli: 0, charged_milli: 0 }),
    ).toThrow(RangeError);
    expect(() => availableMilli({ granted_milli: 0, held_milli: MAX, charged_milli: MAX })).toThrow(
      RangeError,
    );
  });
});

describe("ensurePool", () => {
  test("makes a pool once, with zero totals, and returns the same one again", async () => {
    const w = world();
    const a = await ensurePool(w.d1, "account", "77", "gpu");
    const b = await ensurePool(w.d1, "account", "77", "gpu");
    expect(b.id).toBe(a.id);
    expect([a.granted_milli, a.held_milli, a.charged_milli, a.frozen]).toEqual([0, 0, 0, 0]);
    expect((await ensurePool(w.d1, "account", "77", "cpu")).id).not.toBe(a.id);
    expect((await ensurePool(w.d1, "partner", "tenant", "cpu")).holder_kind).toBe("partner");
  });

  test("never changes the totals of a pool that has them", async () => {
    const w = world();
    const p = await ensurePool(w.d1, "account", "78", "cpu");
    await grant(w, p, 4000);
    const again = await ensurePool(w.d1, "account", "78", "cpu");
    expect(again.granted_milli).toBe(4000);
  });

  test("refuses a holder or a pool the table would, before writing", async () => {
    const w = world();
    for (const [kind, ref, pool] of [
      ["account", "abc", "cpu"],
      ["account", "012", "cpu"],
      ["partner", "has space", "cpu"],
      ["tenant", "x", "cpu"],
      ["account", "5", "tpu"],
    ] as const) {
      await expect(ensurePool(w.d1, kind as never, ref, pool as never)).rejects.toBeInstanceOf(
        ComputeLedgerError,
      );
    }
    expect(
      (await w.d1.prepare("SELECT COUNT(*) AS n FROM compute_pools").first<{ n: number }>())?.n,
    ).toBe(4);
  });
});

describe("a hold", () => {
  test("is one entry that takes the amount from the pool's and the budget's available", async () => {
    const w = world();
    const { person, budget, hold } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    expect(hold.ok).toBe(true);
    if (!hold.ok) return;
    expect(hold.replayed).toBe(false);
    expect(hold.entry.kind).toBe("hold");
    expect(hold.entry.held_delta_milli).toBe(5000);
    expect(hold.entry.budget_pool_id).toBe(budget.id);
    expect(availableMilli(await reread(w, person))).toBe(95000);
    expect(availableMilli(await reread(w, budget))).toBe(45000);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("takes exactly what is available, and no more", async () => {
    const w = world();
    const { person, budget } = await held(w, {
      grantMilli: 10000,
      budgetMilli: 50000,
      holdMilli: 6000,
    });
    const second = (milli: number) =>
      placeHold(w.d1, {
        poolId: person.id,
        budgetPoolId: budget.id,
        amountMilli: milli,
        jobId: jobId(next()),
        idempotencyKey: `hold-${next()}`,
      });
    expect(await second(4001)).toEqual({ ok: false, code: "insufficient_balance" });
    expect((await second(4000)).ok).toBe(true);
    expect(await second(1)).toEqual({ ok: false, code: "insufficient_balance" });
    expect(availableMilli(await reread(w, person))).toBe(0);
  });

  test("a pipelines hold names no budget: its own pool is the platform's", async () => {
    const w = world();
    const pipelines = await platform(w, "pipelines", "gpu");
    await grant(w, pipelines, 8000);
    const r = await placeHold(w.d1, {
      poolId: pipelines.id,
      budgetPoolId: null,
      amountMilli: 3000,
      jobId: jobId(next()),
      idempotencyKey: `hold-${next()}`,
    });
    expect(r.ok).toBe(true);
    expect(availableMilli(await reread(w, pipelines))).toBe(5000);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("refuses a pool that does not exist, without writing", async () => {
    const w = world();
    const budget = await platform(w, "people", "cpu");
    await expect(
      placeHold(w.d1, {
        poolId: 987654,
        budgetPoolId: budget.id,
        amountMilli: 1,
        jobId: jobId(next()),
        idempotencyKey: `hold-${next()}`,
      }),
    ).rejects.toMatchObject({ code: "pool_not_found" });
    expect(await count(w)).toBe(0);
  });

  test("a second hold of the same job under another key is refused as a held job", async () => {
    const w = world();
    const { person, budget, job } = await held(w, { budgetMilli: 50000 });
    const again = await placeHold(w.d1, {
      poolId: person.id,
      budgetPoolId: budget.id,
      amountMilli: 100,
      jobId: job,
      idempotencyKey: `hold-${next()}`,
    });
    expect(again).toEqual({ ok: false, code: "job_already_held" });
    expect(await count(w, "kind = 'hold'")).toBe(1);
    expect(availableMilli(await reread(w, person))).toBe(95000);
  });

  test("a replayed key returns the first hold; the same key for another request is a conflict", async () => {
    const w = world();
    const { person, budget, job, hold } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    expect(hold.ok).toBe(true);
    if (!hold.ok) return;
    const input = {
      poolId: person.id,
      budgetPoolId: budget.id,
      amountMilli: 5000,
      jobId: job,
      idempotencyKey: hold.entry.idempotency_key,
    };
    const replay = await placeHold(w.d1, input);
    expect(replay).toEqual({ ok: true, replayed: true, entry: hold.entry });
    for (const other of [
      { ...input, amountMilli: 5001 },
      { ...input, jobId: jobId(next()) },
      { ...input, budgetPoolId: null },
    ]) {
      await expect(placeHold(w.d1, other)).rejects.toMatchObject({ code: "idempotency_conflict" });
    }
    expect(await count(w, "kind = 'hold'")).toBe(1);
    expect(availableMilli(await reread(w, person))).toBe(95000);
  });

  test("a key already used by an entry of another kind is a conflict, not a replay", async () => {
    const w = world();
    const person = await ensurePool(w.d1, "account", "31", "cpu");
    const budget = await platform(w, "people", "cpu");
    await grantPool(w.d1, {
      poolId: person.id,
      amountMilli: 9000,
      actorUserId: 1,
      idempotencyKey: "shared-key",
    });
    await expect(
      placeHold(w.d1, {
        poolId: person.id,
        budgetPoolId: budget.id,
        amountMilli: 1,
        jobId: jobId(next()),
        idempotencyKey: "shared-key",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  test("composes into a batch: a statement after it that checks changes() runs only if it was written", async () => {
    const w = world();
    const person = await ensurePool(w.d1, "account", "32", "cpu");
    const budget = await platform(w, "people", "cpu");
    await grant(w, person, 3000);
    await grant(w, budget, 3000);
    const markIfHeld = (tag: string) =>
      w.d1
        .prepare(
          "INSERT INTO audit_log (user_id, action, resource_type, resource_id) SELECT NULL, ?, 'test', 'x' WHERE changes() > 0",
        )
        .bind(tag);
    const make = (amount: number, tag: string) =>
      w.d1.batch([
        ...holdStatements(w.d1, {
          poolId: person.id,
          budgetPoolId: budget.id,
          amountMilli: amount,
          jobId: jobId(next()),
          idempotencyKey: `hold-${next()}`,
        }),
        markIfHeld(tag),
      ]);
    await make(2000, "compute-test-first");
    await make(2000, "compute-test-refused");
    const tags = w.db
      .query("SELECT action FROM audit_log WHERE action LIKE 'compute-test-%' ORDER BY id")
      .all() as Array<{ action: string }>;
    expect(tags.map((t) => t.action)).toEqual(["compute-test-first"]);
  });

  describe("a caller's own guard", () => {
    const limitedTo = (n: number, poolId: number) => ({
      sql: "(SELECT COUNT(*) FROM compute_ledger WHERE kind = 'hold' AND pool_id = ?) < ?",
      binds: [poolId, n],
    });

    test("is part of the statement's WHERE: a hold it refuses writes nothing", async () => {
      const w = world();
      const person = await ensurePool(w.d1, "account", "33", "cpu");
      const budget = await platform(w, "people", "cpu");
      await grant(w, person, 90000);
      await grant(w, budget, 90000);
      const place = () =>
        placeHold(w.d1, {
          poolId: person.id,
          budgetPoolId: budget.id,
          amountMilli: 1000,
          jobId: jobId(next()),
          idempotencyKey: `hold-${next()}`,
          extraGuards: [limitedTo(2, person.id)],
        });
      expect((await place()).ok).toBe(true);
      expect((await place()).ok).toBe(true);
      const before = await count(w);
      expect(await place()).toEqual({ ok: false, code: "guard_refused" });
      expect(await count(w)).toBe(before);
      expect(availableMilli(await reread(w, person))).toBe(88000);
    });

    test("is bound after the statement's own parameters, and a guard that misuses them is refused", async () => {
      const w = world();
      const person = await ensurePool(w.d1, "account", "34", "cpu");
      const budget = await platform(w, "people", "cpu");
      const input = {
        poolId: person.id,
        budgetPoolId: budget.id,
        amountMilli: 1,
        jobId: jobId(next()),
        idempotencyKey: `hold-${next()}`,
      };
      for (const bad of [
        { sql: "? = ?", binds: [1] },
        { sql: "?1 = ?", binds: [1, 2] },
        { sql: "1 = 1", binds: [1] },
      ]) {
        expect(() => holdStatements(w.d1, { ...input, extraGuards: [bad] })).toThrow(
          ComputeLedgerError,
        );
      }
      expect(await count(w)).toBe(0);
    });
  });
});

describe("a refused hold writes nothing", () => {
  /** Every table's row count and the pools as they are: a refused hold leaves all of it alone. */
  function snapshot(w: World): string {
    const counts = ["compute_ledger", "audit_log", "compute_policy"].map(
      (t) => (w.db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
    );
    const pools = w.db.query("SELECT * FROM compute_pools ORDER BY id").all();
    return JSON.stringify({ counts, pools });
  }

  test("for want of balance, of budget, of a thaw, or of a guard", async () => {
    const w = world();
    const person = await ensurePool(w.d1, "account", "41", "cpu");
    const budget = await platform(w, "people", "cpu");
    await grant(w, person, 1000);
    await grant(w, budget, 500);
    const place = (amount: number, poolId = person.id, guards: unknown[] = []) =>
      placeHold(w.d1, {
        poolId,
        budgetPoolId: budget.id,
        amountMilli: amount,
        jobId: jobId(next()),
        idempotencyKey: `hold-${next()}`,
        extraGuards: guards as never,
      });
    const before = snapshot(w);
    expect(await place(1001)).toEqual({ ok: false, code: "insufficient_balance" });
    expect(await place(501)).toEqual({ ok: false, code: "platform_budget_exhausted" });
    expect(await place(10, person.id, [{ sql: "0 = 1" }])).toEqual({
      ok: false,
      code: "guard_refused",
    });
    expect(snapshot(w)).toBe(before);
    w.db.run("UPDATE compute_pools SET frozen = 1 WHERE id = ?", [person.id]);
    const frozen = snapshot(w);
    expect(await place(10)).toEqual({ ok: false, code: "suspended" });
    expect(snapshot(w)).toBe(frozen);
  });

  test("a frozen pool is suspended before it is short, and a short pool before a short budget", async () => {
    const w = world();
    const person = await ensurePool(w.d1, "account", "42", "cpu");
    const budget = await platform(w, "people", "cpu");
    const input = (amount: number) => ({
      poolId: person.id,
      budgetPoolId: budget.id,
      amountMilli: amount,
      jobId: jobId(next()),
      idempotencyKey: `hold-${next()}`,
    });
    // Nothing granted to either: the person is short first.
    expect(await placeHold(w.d1, input(1))).toEqual({ ok: false, code: "insufficient_balance" });
    w.db.run("UPDATE compute_pools SET frozen = 1 WHERE id = ?", [person.id]);
    expect(await placeHold(w.d1, input(1))).toEqual({ ok: false, code: "suspended" });
    w.db.run("UPDATE compute_pools SET frozen = 0 WHERE id = ?", [person.id]);
    await grant(w, person, 100);
    expect(await placeHold(w.d1, input(1))).toEqual({
      ok: false,
      code: "platform_budget_exhausted",
    });
  });
});

describe("integer thousandths only", () => {
  const BAD = [
    1.5,
    0.1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    0,
    MAX + 1,
    "5",
    null,
    undefined,
  ];

  test("a hold, a grant, an adjustment and a settlement refuse any amount that is not a whole number", async () => {
    const w = world();
    const person = await ensurePool(w.d1, "account", "51", "cpu");
    const budget = await platform(w, "people", "cpu");
    await grant(w, person, 100000);
    await grant(w, budget, 100000);
    const { job } = await held(w, { budgetMilli: 10000 });
    const before = await count(w);
    for (const bad of BAD) {
      const amount = bad as number;
      const attempts: Array<[string, () => Promise<unknown>]> = [
        [
          "hold",
          () =>
            placeHold(w.d1, {
              poolId: person.id,
              budgetPoolId: budget.id,
              amountMilli: amount,
              jobId: jobId(next()),
              idempotencyKey: `hold-${next()}`,
            }),
        ],
        [
          "grant",
          () =>
            grantPool(w.d1, {
              poolId: person.id,
              amountMilli: amount,
              actorUserId: 1,
              idempotencyKey: `grant-${next()}`,
            }),
        ],
        [
          "adjust of the grant",
          () =>
            adjustPool(w.d1, {
              poolId: person.id,
              grantedDeltaMilli: amount,
              actorUserId: 1,
              reason: "correction",
              idempotencyKey: `adjust-${next()}`,
            }),
        ],
        ["settle", () => settleProvisional(w.d1, { jobId: job, chargeMilli: amount })],
        ["final", () => settleFinal(w.d1, { jobId: job, finalMilli: amount })],
      ];
      /** Whether this operation takes the value, so the attempt would be a real write. */
      const takes = (name: string): boolean => {
        const whole = Number.isSafeInteger(amount);
        if (name === "hold" || name === "grant") return whole && amount >= 1;
        if (name === "adjust of the grant") return whole && amount !== 0;
        return whole && amount >= 0;
      };
      for (const [name, run] of attempts) {
        if (takes(name)) continue;
        await expect(run(), `${name} ${String(amount)}`).rejects.toMatchObject({
          code: "invalid_argument",
        });
      }
    }
    expect(await count(w)).toBe(before);
  });

  test("a negative charge or final figure is refused, and 0 is a charge", async () => {
    const w = world();
    const { job } = await held(w, { budgetMilli: 10000 });
    await expect(settleProvisional(w.d1, { jobId: job, chargeMilli: -1 })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    const r = await settleProvisional(w.d1, { jobId: job, chargeMilli: 0 });
    expect(r).toMatchObject({ ok: true, chargedMilli: 0, releasedMilli: 5000, overrunMilli: 0 });
  });

  test("a job id, a key and a reason that the table would refuse are refused first", async () => {
    const w = world();
    const person = await ensurePool(w.d1, "account", "52", "cpu");
    const budget = await platform(w, "people", "cpu");
    const hold = (over: Record<string, unknown>) =>
      placeHold(w.d1, {
        poolId: person.id,
        budgetPoolId: budget.id,
        amountMilli: 1,
        jobId: jobId(next()),
        idempotencyKey: `hold-${next()}`,
        ...over,
      } as never);
    await expect(hold({ jobId: "job_nope" })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(hold({ idempotencyKey: "has space" })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(hold({ idempotencyKey: "" })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      grantPool(w.d1, {
        poolId: person.id,
        amountMilli: 1,
        actorUserId: 1,
        reason: "Not A Word",
        idempotencyKey: `grant-${next()}`,
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(releaseHold(w.d1, { jobId: "nope" })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(await count(w)).toBe(0);
  });
});

describe("a release", () => {
  test("gives the whole hold back, to the pool and to the budget", async () => {
    const w = world();
    const { person, budget, job } = await held(w, { budgetMilli: 50000, holdMilli: 7000 });
    const r = await releaseHold(w.d1, { jobId: job, reason: "never_started" });
    expect(r).toMatchObject({ ok: true, releasedMilli: 7000 });
    expect(availableMilli(await reread(w, person))).toBe(100000);
    expect(availableMilli(await reread(w, budget))).toBe(50000);
    const e = w.db.query("SELECT * FROM compute_ledger WHERE kind = 'release'").get() as LedgerRow;
    expect([e.held_delta_milli, e.reason, e.job_id]).toEqual([-7000, "never_started", job]);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });
});

describe("a hold closes once", () => {
  const settledTwice = async (first: "release" | "settle", second: "release" | "settle") => {
    const w = world();
    const { person, budget, job } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    const run = (which: "release" | "settle") =>
      which === "release"
        ? releaseHold(w.d1, { jobId: job })
        : settleProvisional(w.d1, { jobId: job, chargeMilli: 3000 });
    expect((await run(first)).ok).toBe(true);
    const entries = await count(w);
    const poolAfter = await reread(w, person);
    const budgetAfter = await reread(w, budget);
    expect(await run(second)).toEqual({ ok: false, code: "hold_closed" });
    // A second settle with another figure is no different: it is closed.
    expect(await settleProvisional(w.d1, { jobId: job, chargeMilli: 99999 })).toEqual({
      ok: false,
      code: "hold_closed",
    });
    expect(await count(w)).toBe(entries);
    expect(await reread(w, person)).toEqual(poolAfter);
    expect(await reread(w, budget)).toEqual(budgetAfter);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  };

  test("a settle cannot be settled again, or released", async () => {
    await settledTwice("settle", "settle");
    await settledTwice("settle", "release");
  });

  test("a release cannot be released again, or settled", async () => {
    await settledTwice("release", "release");
    await settledTwice("release", "settle");
  });

  test("a job that was never held has nothing to close", async () => {
    const w = world();
    const job = jobId(next());
    expect(await releaseHold(w.d1, { jobId: job })).toEqual({ ok: false, code: "no_hold" });
    expect(await settleProvisional(w.d1, { jobId: job, chargeMilli: 1 })).toEqual({
      ok: false,
      code: "no_hold",
    });
    expect(await count(w)).toBe(0);
  });
});

describe("a provisional settlement", () => {
  test("charges what was used, releases the rest, and never writes an overrun for less", async () => {
    const w = world();
    const { person, budget, job } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    const r = await settleProvisional(w.d1, { jobId: job, chargeMilli: 3200 });
    expect(r).toMatchObject({
      ok: true,
      holdMilli: 5000,
      chargedMilli: 3200,
      releasedMilli: 1800,
      overrunMilli: 0,
    });
    const p = await reread(w, person);
    expect([p.held_milli, p.charged_milli, availableMilli(p)]).toEqual([0, 3200, 96800]);
    const b = await reread(w, budget);
    expect([b.held_milli, b.charged_milli]).toEqual([0, 3200]);
    expect(await count(w, "kind = 'overrun'")).toBe(0);
    const charge = w.db
      .query("SELECT * FROM compute_ledger WHERE kind = 'charge'")
      .get() as LedgerRow;
    expect([charge.held_delta_milli, charge.charged_delta_milli]).toEqual([-5000, 3200]);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("an exact hold is a charge of all of it", async () => {
    const w = world();
    const { person, job } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    expect(await settleProvisional(w.d1, { jobId: job, chargeMilli: 5000 })).toMatchObject({
      releasedMilli: 0,
      overrunMilli: 0,
    });
    expect((await reread(w, person)).charged_milli).toBe(5000);
  });

  test("excess use writes an overrun, may make available negative, and never a stored total", async () => {
    const w = world();
    const { person, budget, job } = await held(w, {
      grantMilli: 6000,
      budgetMilli: 20000,
      holdMilli: 5000,
    });
    const r = await settleProvisional(w.d1, { jobId: job, chargeMilli: 8000 });
    expect(r).toMatchObject({
      ok: true,
      chargedMilli: 5000,
      releasedMilli: 0,
      overrunMilli: 3000,
    });
    const p = await reread(w, person);
    expect([p.granted_milli, p.held_milli, p.charged_milli]).toEqual([6000, 0, 8000]);
    expect(availableMilli(p)).toBe(-2000);
    const b = await reread(w, budget);
    expect([b.held_milli, b.charged_milli]).toEqual([0, 8000]);
    const overrun = w.db
      .query("SELECT * FROM compute_ledger WHERE kind = 'overrun'")
      .get() as LedgerRow;
    expect([overrun.charged_delta_milli, overrun.job_id, overrun.budget_pool_id]).toEqual([
      3000,
      job,
      budget.id,
    ]);
    // Negative available is a balance that refuses a hold, not a state the pool cannot be in.
    expect(
      await placeHold(w.d1, {
        poolId: person.id,
        budgetPoolId: budget.id,
        amountMilli: 1,
        jobId: jobId(next()),
        idempotencyKey: `hold-${next()}`,
      }),
    ).toEqual({ ok: false, code: "insufficient_balance" });
    // Until a grant brings it back above zero.
    await grant(w, person, 2001);
    expect(availableMilli(await reread(w, person))).toBe(1);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });
});

describe("the final settlement", () => {
  const settle = async (w: World, job: string, charge: number) =>
    settleProvisional(w.d1, { jobId: job, chargeMilli: charge });

  test("a final figure above the provisional one is an adjustment of the difference, and ends there", async () => {
    const w = world();
    const { person, budget, job } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    await settle(w, job, 3000);
    const r = await settleFinal(w.d1, { jobId: job, finalMilli: 3500 });
    expect(r).toMatchObject({ ok: true, deltaMilli: 500 });
    const entry = w.db
      .query("SELECT * FROM compute_ledger WHERE kind = 'adjust'")
      .get() as LedgerRow;
    expect([entry.charged_delta_milli, entry.granted_delta_milli, entry.job_id]).toEqual([
      500,
      0,
      job,
    ]);
    expect((await reread(w, person)).charged_milli).toBe(3500);
    expect((await reread(w, budget)).charged_milli).toBe(3500);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("a final figure below it takes the difference back", async () => {
    const w = world();
    const { person, budget, job } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    await settle(w, job, 3000);
    expect(await settleFinal(w.d1, { jobId: job, finalMilli: 2000 })).toMatchObject({
      ok: true,
      deltaMilli: -1000,
    });
    expect((await reread(w, person)).charged_milli).toBe(2000);
    expect((await reread(w, budget)).charged_milli).toBe(2000);
  });

  test("counts an overrun in what was charged, so the final figure is the job's whole charge", async () => {
    const w = world();
    const { person, job } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    await settle(w, job, 7000);
    expect((await reread(w, person)).charged_milli).toBe(7000);
    expect(await settleFinal(w.d1, { jobId: job, finalMilli: 6000 })).toMatchObject({
      deltaMilli: -1000,
    });
    expect((await reread(w, person)).charged_milli).toBe(6000);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("is once per job: a second figure, the same or another, writes nothing", async () => {
    const w = world();
    const { person, job } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    await settle(w, job, 3000);
    await settleFinal(w.d1, { jobId: job, finalMilli: 3500 });
    const entries = await count(w);
    expect(await settleFinal(w.d1, { jobId: job, finalMilli: 3500 })).toEqual({
      ok: false,
      code: "already_final",
    });
    expect(await settleFinal(w.d1, { jobId: job, finalMilli: 9000 })).toEqual({
      ok: false,
      code: "already_final",
    });
    expect(await count(w)).toBe(entries);
    expect((await reread(w, person)).charged_milli).toBe(3500);
  });

  test("a figure equal to the provisional charge is no entry at all", async () => {
    const w = world();
    const { job } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    await settle(w, job, 3000);
    const entries = await count(w);
    expect(await settleFinal(w.d1, { jobId: job, finalMilli: 3000 })).toEqual({
      ok: true,
      deltaMilli: 0,
      entry: null,
    });
    expect(await count(w)).toBe(entries);
  });

  test("needs the hold to have been settled: not before, not after a release", async () => {
    const w = world();
    const open = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    expect(await settleFinal(w.d1, { jobId: open.job, finalMilli: 100 })).toEqual({
      ok: false,
      code: "not_settled",
    });
    await releaseHold(w.d1, { jobId: open.job });
    expect(await settleFinal(w.d1, { jobId: open.job, finalMilli: 100 })).toEqual({
      ok: false,
      code: "not_settled",
    });
    expect(await settleFinal(w.d1, { jobId: jobId(next()), finalMilli: 100 })).toEqual({
      ok: false,
      code: "not_settled",
    });
  });
});

describe("a refund", () => {
  test("returns the whole charge of a job, an overrun and an adjustment included, once", async () => {
    const w = world();
    const { person, budget, job } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    await settleProvisional(w.d1, { jobId: job, chargeMilli: 6000 });
    await settleFinal(w.d1, { jobId: job, finalMilli: 6500 });
    const r = await refundJob(w.d1, { jobId: job, reason: "platform_failure" });
    expect(r).toMatchObject({ ok: true, refundedMilli: 6500 });
    const p = await reread(w, person);
    expect([p.charged_milli, availableMilli(p)]).toEqual([0, 100000]);
    expect((await reread(w, budget)).charged_milli).toBe(0);
    const entries = await count(w);
    expect(await refundJob(w.d1, { jobId: job })).toEqual({ ok: false, code: "already_refunded" });
    expect(await count(w)).toBe(entries);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("has nothing to return for a job that was released, or never held", async () => {
    const w = world();
    const { job } = await held(w, { budgetMilli: 50000 });
    await releaseHold(w.d1, { jobId: job });
    expect(await refundJob(w.d1, { jobId: job })).toEqual({ ok: false, code: "nothing_to_refund" });
    expect(await refundJob(w.d1, { jobId: jobId(next()) })).toEqual({
      ok: false,
      code: "nothing_to_refund",
    });
  });
});

describe("a refund or a final figure after an administrator corrected the charge", () => {
  test("a refund that would take the pool's charged below zero is would_go_negative and writes nothing", async () => {
    const w = world();
    const { person, budget, job } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    await settleProvisional(w.d1, { jobId: job, chargeMilli: 4000 });
    // An administrator took 3000 of the charge back, so the job's 4000 is more than the pool holds.
    expect(
      (
        await adjustPool(w.d1, {
          poolId: person.id,
          budgetPoolId: budget.id,
          chargedDeltaMilli: -3000,
          actorUserId: 9,
          reason: "correction",
          idempotencyKey: `adjust-${next()}`,
        })
      ).ok,
    ).toBe(true);
    const entries = await count(w);
    expect(await refundJob(w.d1, { jobId: job })).toEqual({ ok: false, code: "would_go_negative" });
    expect(await count(w)).toBe(entries);
    expect((await reread(w, person)).charged_milli).toBe(1000);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("a final figure that would take it below zero is would_go_negative and writes nothing", async () => {
    const w = world();
    const { person, budget, job } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    await settleProvisional(w.d1, { jobId: job, chargeMilli: 4000 });
    await adjustPool(w.d1, {
      poolId: person.id,
      budgetPoolId: budget.id,
      chargedDeltaMilli: -3000,
      actorUserId: 9,
      reason: "correction",
      idempotencyKey: `adjust-${next()}`,
    });
    const entries = await count(w);
    // Expanse says the job cost 500: 3500 less than the 4000 charged, and the pool holds 1000.
    expect(await settleFinal(w.d1, { jobId: job, finalMilli: 500 })).toEqual({
      ok: false,
      code: "would_go_negative",
    });
    expect(await count(w)).toBe(entries);
    // A figure the pool can take still settles.
    expect(await settleFinal(w.d1, { jobId: job, finalMilli: 3500 })).toMatchObject({
      ok: true,
      deltaMilli: -500,
    });
    expect((await reread(w, person)).charged_milli).toBe(500);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });
});

describe("an administrator's grant and adjustment", () => {
  test("a grant adds to granted, with who did it and why", async () => {
    const w = world();
    const p = await ensurePool(w.d1, "account", "61", "cpu");
    const r = await grantPool(w.d1, {
      poolId: p.id,
      amountMilli: 12500,
      actorUserId: 9,
      reason: "top_up",
      idempotencyKey: "grant-61-a",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([
      r.replayed,
      r.entry.granted_delta_milli,
      r.entry.actor_user_id,
      r.entry.reason,
    ]).toEqual([false, 12500, 9, "top_up"]);
    expect((await reread(w, p)).granted_milli).toBe(12500);
  });

  test("a repeated key grants once, and the same key for another amount is a conflict", async () => {
    const w = world();
    const p = await ensurePool(w.d1, "account", "62", "cpu");
    const input = { poolId: p.id, amountMilli: 1000, actorUserId: 9, idempotencyKey: "grant-62-a" };
    const first = await grantPool(w.d1, input);
    const again = await grantPool(w.d1, input);
    expect(first.ok && again.ok && again.replayed && !first.replayed).toBe(true);
    if (first.ok && again.ok) expect(again.entry).toEqual(first.entry);
    await expect(grantPool(w.d1, { ...input, amountMilli: 2000 })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    await expect(grantPool(w.d1, { ...input, poolId: p.id + 1 })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    expect((await reread(w, p)).granted_milli).toBe(1000);
    expect(await count(w)).toBe(1);
  });

  test("a grant to a pool that does not exist is refused", async () => {
    const w = world();
    await expect(
      grantPool(w.d1, {
        poolId: 99999,
        amountMilli: 1,
        actorUserId: 1,
        idempotencyKey: "grant-63-a",
      }),
    ).rejects.toMatchObject({ code: "pool_not_found" });
    expect(await count(w)).toBe(0);
  });

  test("an adjustment corrects the grant or the charge, either way, and exactly one of them", async () => {
    const w = world();
    const p = await ensurePool(w.d1, "account", "64", "cpu");
    await grant(w, p, 10000);
    const adjust = (over: Record<string, unknown>) =>
      adjustPool(w.d1, {
        poolId: p.id,
        actorUserId: 9,
        reason: "correction",
        idempotencyKey: `adjust-${next()}`,
        ...over,
      } as never);
    expect((await adjust({ grantedDeltaMilli: -2500 })).ok).toBe(true);
    expect((await adjust({ chargedDeltaMilli: 700 })).ok).toBe(true);
    expect((await adjust({ chargedDeltaMilli: -200 })).ok).toBe(true);
    const row = await reread(w, p);
    expect([row.granted_milli, row.held_milli, row.charged_milli]).toEqual([7500, 0, 500]);
    await expect(adjust({})).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(adjust({ grantedDeltaMilli: 0, chargedDeltaMilli: 0 })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(adjust({ grantedDeltaMilli: 1, chargedDeltaMilli: 1 })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(adjust({ grantedDeltaMilli: 1, reason: undefined })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("an adjustment that would make a stored total negative is refused and writes nothing", async () => {
    const w = world();
    const p = await ensurePool(w.d1, "account", "65", "cpu");
    await grant(w, p, 1000);
    const before = await count(w);
    for (const over of [
      { grantedDeltaMilli: -1001 },
      { chargedDeltaMilli: -1 },
      { grantedDeltaMilli: -MAX },
    ]) {
      expect(
        await adjustPool(w.d1, {
          poolId: p.id,
          actorUserId: 9,
          reason: "correction",
          idempotencyKey: `adjust-${next()}`,
          ...over,
        }),
      ).toEqual({ ok: false, code: "would_go_negative" });
    }
    expect(await count(w)).toBe(before);
    expect(await reread(w, p)).toMatchObject({ granted_milli: 1000, charged_milli: 0 });
  });

  test("an adjustment of the grant below what is used makes available negative, not a total", async () => {
    const w = world();
    const { person, job } = await held(w, {
      grantMilli: 10000,
      budgetMilli: 50000,
      holdMilli: 4000,
    });
    await settleProvisional(w.d1, { jobId: job, chargeMilli: 4000 });
    const r = await adjustPool(w.d1, {
      poolId: person.id,
      grantedDeltaMilli: -9000,
      actorUserId: 9,
      reason: "correction",
      idempotencyKey: "adjust-65-a",
    });
    expect(r.ok).toBe(true);
    expect(availableMilli(await reread(w, person))).toBe(-3000);
  });

  test("an adjustment of the charge of an account's pool follows the platform budget it was counted against", async () => {
    const w = world();
    const { person, budget, job } = await held(w, { budgetMilli: 50000, holdMilli: 4000 });
    await settleProvisional(w.d1, { jobId: job, chargeMilli: 4000 });
    const adjust = (delta: number) =>
      adjustPool(w.d1, {
        poolId: person.id,
        budgetPoolId: budget.id,
        chargedDeltaMilli: delta,
        actorUserId: 9,
        reason: "correction",
        idempotencyKey: `adjust-${next()}`,
      });
    expect((await adjust(1000)).ok).toBe(true);
    expect((await reread(w, budget)).charged_milli).toBe(5000);
    expect((await adjust(-5000)).ok).toBe(true);
    expect((await reread(w, budget)).charged_milli).toBe(0);
    // More than the budget has charged would put the budget below zero.
    expect(await adjust(-1)).toEqual({ ok: false, code: "would_go_negative" });
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("an adjustment of the grant never names a budget", async () => {
    const w = world();
    const p = await ensurePool(w.d1, "account", "66", "cpu");
    const budget = await platform(w, "people", "cpu");
    await grant(w, p, 100);
    await expect(
      adjustPool(w.d1, {
        poolId: p.id,
        budgetPoolId: budget.id,
        grantedDeltaMilli: 5,
        actorUserId: 9,
        reason: "correction",
        idempotencyKey: `adjust-${next()}`,
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  test("a repeated adjustment key adjusts once", async () => {
    const w = world();
    const p = await ensurePool(w.d1, "account", "67", "cpu");
    await grant(w, p, 1000);
    const input = {
      poolId: p.id,
      grantedDeltaMilli: 500,
      actorUserId: 9,
      reason: "correction",
      idempotencyKey: "adjust-67-a",
    };
    const a = await adjustPool(w.d1, input);
    const b = await adjustPool(w.d1, input);
    expect(a.ok && b.ok && !a.replayed && b.replayed).toBe(true);
    expect((await reread(w, p)).granted_milli).toBe(1500);
    await expect(adjustPool(w.d1, { ...input, grantedDeltaMilli: 501 })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
  });
});

describe("expiry of unused SU", () => {
  test("takes the unused balance out of granted and leaves what is held and charged", async () => {
    const w = world();
    const { person, job } = await held(w, {
      grantMilli: 10000,
      budgetMilli: 50000,
      holdMilli: 3000,
    });
    const r = await expireUnused(w.d1, { poolId: person.id, idempotencyKey: "expire-71-a" });
    expect(r).toMatchObject({ ok: true, replayed: false, expiredMilli: 7000 });
    const p = await reread(w, person);
    expect([p.granted_milli, p.held_milli, availableMilli(p)]).toEqual([3000, 3000, 0]);
    // The job the hold is for still settles.
    expect(await settleProvisional(w.d1, { jobId: job, chargeMilli: 2000 })).toMatchObject({
      ok: true,
    });
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("has nothing to take from a pool with no unused balance, and is replayed by its key", async () => {
    const w = world();
    const p = await ensurePool(w.d1, "account", "72", "cpu");
    expect(await expireUnused(w.d1, { poolId: p.id, idempotencyKey: "expire-72-a" })).toEqual({
      ok: false,
      code: "nothing_to_expire",
    });
    await grant(w, p, 500);
    const first = await expireUnused(w.d1, { poolId: p.id, idempotencyKey: "expire-72-b" });
    const again = await expireUnused(w.d1, { poolId: p.id, idempotencyKey: "expire-72-b" });
    expect(first).toMatchObject({ ok: true, replayed: false, expiredMilli: 500 });
    expect(again).toMatchObject({ ok: true, replayed: true, expiredMilli: 500 });
    expect((await reread(w, p)).granted_milli).toBe(0);
  });

  test("never expires a negative balance", async () => {
    const w = world();
    const { person, job } = await held(w, {
      grantMilli: 6000,
      budgetMilli: 20000,
      holdMilli: 5000,
    });
    await settleProvisional(w.d1, { jobId: job, chargeMilli: 8000 });
    expect(await expireUnused(w.d1, { poolId: person.id, idempotencyKey: "expire-73-a" })).toEqual({
      ok: false,
      code: "nothing_to_expire",
    });
    expect((await reread(w, person)).granted_milli).toBe(6000);
  });
});

describe("a seeded random sequence of every operation", () => {
  const STEPS = 700;

  async function run(seed: number) {
    const w = world();
    const rand = seeded(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const amount = (max: number) => 1 + Math.floor(rand() * max);

    const accounts = ["101", "102", "103"];
    const pools: PoolRow[] = [];
    for (const a of accounts) {
      for (const word of ["cpu", "gpu"] as const) {
        pools.push(await ensurePool(w.d1, "account", a, word));
      }
    }
    const budgets = {
      cpu: await platform(w, "people", "cpu"),
      gpu: await platform(w, "people", "gpu"),
    };
    const pipelines = {
      cpu: await platform(w, "pipelines", "cpu"),
      gpu: await platform(w, "pipelines", "gpu"),
    };
    for (const p of pools) await grant(w, p, 30000);
    // The budgets are smaller than what the people can ask for, so the platform refusal is reached.
    await grant(w, budgets.cpu, 120000);
    await grant(w, budgets.gpu, 120000);
    await grant(w, pipelines.cpu, 40000);
    await grant(w, pipelines.gpu, 20000);

    const open: string[] = [];
    const settled: string[] = [];
    const tally = {
      holds: 0,
      insufficient: 0,
      platform: 0,
      overruns: 0,
      negativeAvailable: 0,
      refunds: 0,
      finals: 0,
      negativeRefused: 0,
      expired: 0,
      released: 0,
    };

    for (let step = 1; step <= STEPS; step++) {
      const op = rand();
      if (op < 0.14) {
        await grant(w, pick(pools), amount(40000));
      } else if (op < 0.4) {
        const p = pick(pools);
        const job = jobId(next());
        const useBudget = rand() < 0.85;
        const target = useBudget ? p : pick([pipelines.cpu, pipelines.gpu]);
        const r = await placeHold(w.d1, {
          poolId: target.id,
          budgetPoolId: useBudget ? (p.pool === "cpu" ? budgets.cpu.id : budgets.gpu.id) : null,
          amountMilli: amount(15000),
          jobId: job,
          idempotencyKey: `hold-${next()}`,
        });
        if (r.ok) {
          tally.holds++;
          open.push(job);
        } else if (r.code === "insufficient_balance") tally.insufficient++;
        else if (r.code === "platform_budget_exhausted") tally.platform++;
      } else if (op < 0.5 && open.length > 0) {
        const job = open.splice(Math.floor(rand() * open.length), 1)[0] as string;
        expect((await releaseHold(w.d1, { jobId: job })).ok).toBe(true);
        tally.released++;
      } else if (op < 0.66 && open.length > 0) {
        const job = open.splice(Math.floor(rand() * open.length), 1)[0] as string;
        const r = await settleProvisional(w.d1, {
          jobId: job,
          chargeMilli: Math.floor(rand() * 22000),
        });
        expect(r.ok).toBe(true);
        if (r.ok && r.overrunMilli > 0) tally.overruns++;
        settled.push(job);
      } else if (op < 0.74 && settled.length > 0) {
        const r = await settleFinal(w.d1, {
          jobId: pick(settled),
          finalMilli: Math.floor(rand() * 25000),
        });
        if (r.ok && r.deltaMilli !== 0) tally.finals++;
      } else if (op < 0.8 && settled.length > 0) {
        const r = await refundJob(w.d1, { jobId: pick(settled), reason: "platform_failure" });
        if (r.ok) tally.refunds++;
      } else if (op < 0.9) {
        const p = pick([...pools, budgets.cpu, pipelines.cpu]);
        const field = rand() < 0.5 ? "grantedDeltaMilli" : "chargedDeltaMilli";
        const delta = (rand() < 0.5 ? -1 : 1) * amount(20000);
        const isBudget = p.holder_kind === "platform";
        const bud =
          !isBudget && field === "chargedDeltaMilli"
            ? p.pool === "cpu"
              ? budgets.cpu
              : budgets.gpu
            : null;
        const r = await adjustPool(w.d1, {
          poolId: p.id,
          budgetPoolId: bud?.id ?? null,
          [field]: delta,
          actorUserId: 9,
          reason: "correction",
          idempotencyKey: `adjust-${next()}`,
        } as never);
        if (!r.ok) tally.negativeRefused++;
      } else if (op < 0.94) {
        const r = await expireUnused(w.d1, {
          poolId: pick(pools).id,
          idempotencyKey: `expire-${next()}`,
        });
        if (r.ok) tally.expired++;
      } else {
        const p = pick(pools);
        expect((await ensurePool(w.d1, "account", p.holder_ref, p.pool)).id).toBe(p.id);
      }

      if (step % 25 === 0 || step === STEPS) {
        expect(await totalsDisagreements(w.d1), `seed ${seed} step ${step}`).toEqual([]);
      }
      for (const p of pools) {
        if (availableMilli(await reread(w, p)) < 0) {
          tally.negativeAvailable++;
          break;
        }
      }
    }

    // Replaying every hold of the run: the same key finds the same entry and moves nothing.
    const holds = w.db
      .query("SELECT * FROM compute_ledger WHERE kind = 'hold'")
      .all() as LedgerRow[];
    const before = await count(w);
    for (const h of holds) {
      const replay = await placeHold(w.d1, {
        poolId: h.pool_id,
        budgetPoolId: h.budget_pool_id,
        amountMilli: h.held_delta_milli,
        jobId: h.job_id as string,
        idempotencyKey: h.idempotency_key,
      });
      expect(replay).toEqual({ ok: true, replayed: true, entry: h });
    }
    expect(await count(w)).toBe(before);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
    if (process.env.COMPUTE_TALLY) console.log(seed, JSON.stringify(tally));
    return tally;
  }

  for (const seed of [1, 2, 3, 20261104]) {
    test(`seed ${seed}: the totals equal the ledger's sums, and the run reached the boundaries`, async () => {
      const tally = await run(seed);
      // A run that never refuses, never overruns and never goes negative proves nothing about them.
      expect(tally.holds).toBeGreaterThan(20);
      expect(tally.insufficient).toBeGreaterThan(0);
      expect(tally.platform).toBeGreaterThan(0);
      expect(tally.overruns).toBeGreaterThan(0);
      expect(tally.negativeAvailable).toBeGreaterThan(0);
      expect(tally.refunds).toBeGreaterThan(0);
      expect(tally.finals).toBeGreaterThan(0);
      expect(tally.released).toBeGreaterThan(0);
    });
  }
});

describe("no path writes a pool's totals except a ledger entry", () => {
  const ROOT = join(import.meta.dir, "..", "..");
  const TOTALS = /\b(granted|held|charged)_milli\b/;

  /** Every TypeScript and SQL file the product ships, by relative path. */
  function sources(): Array<{ path: string; text: string }> {
    const out: Array<{ path: string; text: string }> = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".wrangler") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|sql|js)$/.test(entry.name)) {
          out.push({ path: relative(ROOT, full), text: readFileSync(full, "utf8") });
        }
      }
    };
    for (const dir of ["backend/src", "src", "shared", "scripts"]) walk(join(ROOT, dir));
    return out;
  }

  /** The statements of a file that name the pools or the ledger, as text from the verb to the `;` or backtick. */
  function statements(text: string): string[] {
    return [
      ...text.matchAll(
        /\b(UPDATE|DELETE\s+FROM|INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO)\s+compute_(?:pools|ledger)\b[^;`]*/gi,
      ),
    ].map((m) => m[0]);
  }

  test("the scan reads the files it is meant to, and finds the trigger", () => {
    const all = sources();
    expect(all.length).toBeGreaterThan(200);
    const migration = all.find((s) => s.path.endsWith("0114_compute_ledger.sql"));
    expect(migration).toBeDefined();
    expect(statements(migration?.text ?? "").some((s) => /^UPDATE\s+compute_pools/i.test(s))).toBe(
      true,
    );
  });

  test("only migration 0114's trigger updates a pool's totals, and nothing deletes or replaces a pool or an entry", () => {
    const offences: string[] = [];
    for (const { path, text } of sources()) {
      for (const s of statements(text)) {
        const trigger = path.endsWith("0114_compute_ledger.sql");
        if (/^UPDATE\s+compute_pools/i.test(s) && TOTALS.test(s) && !trigger) {
          offences.push(`${path}: ${s.slice(0, 80)}`);
        }
        if (/^(DELETE\s+FROM|REPLACE\s+INTO|INSERT\s+OR\s+REPLACE)/i.test(s)) {
          offences.push(`${path}: ${s.slice(0, 80)}`);
        }
      }
      // An upsert that updates a total is a write of it too.
      for (const m of text.matchAll(/ON\s+CONFLICT[^;`]*DO\s+UPDATE[^;`]*/gi)) {
        if (TOTALS.test(m[0])) offences.push(`${path}: ${m[0].slice(0, 80)}`);
      }
    }
    expect(offences).toEqual([]);
  });

  test("the service's inserts into the pools name no total", () => {
    const service = readFileSync(join(ROOT, "backend/src/services/compute-ledger.ts"), "utf8");
    const inserts = [...service.matchAll(/INSERT\s+INTO\s+compute_pools[^;`]*/gi)].map((m) => m[0]);
    expect(inserts.length).toBe(1);
    for (const s of inserts) expect(TOTALS.test(s)).toBe(false);
  });
});
