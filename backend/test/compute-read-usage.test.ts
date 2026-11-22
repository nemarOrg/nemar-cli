/**
 * `GET /compute/me/usage` (epic #2021 phase D2, #2023): the net charge by day, app, partition and
 * source, built from the ledger's charge entries, through the REAL compute router over real migrated
 * SQLite. The ledger entries carry times the test chooses (the ledger's clock is the database's, so a
 * day boundary cannot be made by waiting).
 *
 * What is pinned:
 *  - every combination of `group` sums to the same total, and that total is the sum of the entries;
 *  - a day-boundary entry lands on the right UTC day, 23:59:59 on one and 00:00:00 on the next;
 *  - the window is `[from 00:00:00, to + 1 day 00:00:00)`: the entry at midnight after `to` is out;
 *  - the default window is the last 30 days; a bad range or group is refused with its word;
 *  - a group with no charge has no row; an administrator's correction (no job) is in the totals with
 *    `null` for the job's words;
 *  - another person's charges are never in a person's rows.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  COMPUTE_USAGE_GROUPS,
  ComputeUsageResponseSchema,
} from "../../shared/contract/compute-user";
import {
  placeHold,
  releaseHold,
  settleFinal,
  settleProvisional,
} from "../src/services/compute-ledger";
import { fundAccount, fundPlatform } from "./helpers/compute-seed";
import {
  chargeAt,
  correctionAt,
  insertJob,
  personWithKey,
  readApp,
  sqliteAt,
} from "./helpers/compute-user-seed";
import { freshDb, realD1 } from "./helpers/d1";

let db: Database;
beforeEach(() => {
  db = freshDb();
});

const usage = (key: string, query = "") =>
  readApp(db).call(`/me/usage${query ? `?${query}` : ""}`, { key });

/** Three jobs across two apps, two partitions, two sources and two days, charged at fixed times. */
async function seedMixed() {
  const a = await personWithKey(db);
  const j1 = insertJob(db, {
    account_id: a.id,
    app_id: "app-alpha",
    partition: "shared",
    source: "cli",
  });
  const j2 = insertJob(db, {
    account_id: a.id,
    app_id: "app-beta",
    partition: "compute",
    source: "web",
  });
  const j3 = insertJob(db, {
    account_id: a.id,
    app_id: "app-alpha",
    partition: "shared",
    source: "web",
  });
  chargeAt(db, { accountId: a.id, jobId: j1, milli: 4_000, at: "2026-10-01 08:00:00" });
  chargeAt(db, { accountId: a.id, jobId: j2, milli: 128_000, at: "2026-10-01 23:59:59" });
  chargeAt(db, { accountId: a.id, jobId: j3, milli: 2_500, at: "2026-10-02 00:00:00" });
  chargeAt(db, { accountId: a.id, jobId: j1, milli: 1_000, at: "2026-10-02 12:00:00" });
  return { a, total: 4_000 + 128_000 + 2_500 + 1_000 };
}

describe("grouping", () => {
  test("every combination of groups sums to the same total, which is the sum of the entries", async () => {
    const { a, total } = await seedMixed();
    // All 16 subsets of the four words (the empty subset is no `group` parameter).
    const words = [...COMPUTE_USAGE_GROUPS];
    for (let mask = 0; mask < 1 << words.length; mask++) {
      const chosen = words.filter((_, i) => mask & (1 << i));
      const query = `from=2026-10-01&to=2026-10-03${chosen.length > 0 ? `&group=${chosen.join(",")}` : ""}`;
      const res = await usage(a.key, query);
      expect([chosen.join(","), res.status]).toEqual([chosen.join(","), 200]);
      expect(ComputeUsageResponseSchema.safeParse(res.body).success).toBe(true);
      const sum = res.body.rows.reduce(
        (n: number, r: { charged_milli: number }) => n + r.charged_milli,
        0,
      );
      expect([chosen.join(","), sum]).toEqual([chosen.join(","), total]);
      expect(res.body.group).toEqual(chosen);
    }
  });

  test("the rows of each grouping are the exact figures", async () => {
    const { a } = await seedMixed();
    const byDay = await usage(a.key, "from=2026-10-01&to=2026-10-03&group=day");
    expect(byDay.body.rows).toEqual([
      { day: "2026-10-01", charged_milli: 132_000, jobs: 2 },
      { day: "2026-10-02", charged_milli: 3_500, jobs: 2 },
    ]);
    const byApp = await usage(a.key, "from=2026-10-01&to=2026-10-03&group=app");
    expect(byApp.body.rows).toEqual([
      { app: "app-alpha", charged_milli: 7_500, jobs: 2 },
      { app: "app-beta", charged_milli: 128_000, jobs: 1 },
    ]);
    const both = await usage(a.key, "from=2026-10-01&to=2026-10-03&group=source,partition");
    expect(both.body.group).toEqual(["partition", "source"]);
    expect(both.body.rows).toEqual([
      { partition: "compute", source: "web", charged_milli: 128_000, jobs: 1 },
      { partition: "shared", source: "cli", charged_milli: 5_000, jobs: 1 },
      { partition: "shared", source: "web", charged_milli: 2_500, jobs: 1 },
    ]);
  });

  test("no group parameter is one total row; a window with no charge has no row", async () => {
    const { a, total } = await seedMixed();
    const one = await usage(a.key, "from=2026-10-01&to=2026-10-03");
    expect(one.body.rows).toEqual([{ charged_milli: total, jobs: 3 }]);
    const none = await usage(a.key, "from=2026-09-01&to=2026-09-30&group=day");
    expect(none.status).toBe(200);
    expect(none.body.rows).toEqual([]);
    const noneTotal = await usage(a.key, "from=2026-09-01&to=2026-09-30");
    expect(noneTotal.body.rows).toEqual([]);
  });

  test("a group whose charges cancel to nothing has no row, and a gpu charge counts like a cpu one", async () => {
    const a = await personWithKey(db);
    const j = insertJob(db, { account_id: a.id, app_id: "app-zero" });
    chargeAt(db, { accountId: a.id, jobId: j, milli: 5_000, at: "2026-10-05 09:00:00" });
    chargeAt(db, { accountId: a.id, jobId: j, milli: -5_000, at: "2026-10-05 10:00:00" });
    const g = insertJob(db, { account_id: a.id, app_id: "app-gpu", partition: "gpu", pool: "gpu" });
    chargeAt(db, {
      accountId: a.id,
      jobId: g,
      milli: 7_000,
      at: "2026-10-05 11:00:00",
      pool: "gpu",
    });
    const res = await usage(a.key, "from=2026-10-05&to=2026-10-05&group=app");
    expect(res.body.rows).toEqual([{ app: "app-gpu", charged_milli: 7_000, jobs: 1 }]);
  });

  test("a net-negative day (a final settlement below the provisional charge) is a negative row", async () => {
    const a = await personWithKey(db);
    const j = insertJob(db, { account_id: a.id });
    chargeAt(db, { accountId: a.id, jobId: j, milli: 9_000, at: "2026-10-05 09:00:00" });
    chargeAt(db, { accountId: a.id, jobId: j, milli: -2_000, at: "2026-10-06 09:00:00" });
    const res = await usage(a.key, "from=2026-10-05&to=2026-10-06&group=day");
    expect(res.body.rows).toEqual([
      { day: "2026-10-05", charged_milli: 9_000, jobs: 1 },
      { day: "2026-10-06", charged_milli: -2_000, jobs: 1 },
    ]);
  });

  test("an administrator's correction (no job) is in the total, with null for the job's words", async () => {
    const a = await personWithKey(db);
    const j = insertJob(db, { account_id: a.id, app_id: "app-alpha", source: "cli" });
    chargeAt(db, { accountId: a.id, jobId: j, milli: 3_000, at: "2026-10-05 09:00:00" });
    correctionAt(db, { accountId: a.id, milli: 1_500, at: "2026-10-05 10:00:00" });
    const total = await usage(a.key, "from=2026-10-05&to=2026-10-05");
    expect(total.body.rows).toEqual([{ charged_milli: 4_500, jobs: 1 }]);
    const byApp = await usage(a.key, "from=2026-10-05&to=2026-10-05&group=app,source");
    expect(byApp.body.rows).toEqual([
      { app: null, source: null, charged_milli: 1_500, jobs: 0 },
      { app: "app-alpha", source: "cli", charged_milli: 3_000, jobs: 1 },
    ]);
  });
});

describe("days and windows", () => {
  test("a day-boundary charge lands on the right UTC day", async () => {
    const a = await personWithKey(db);
    const j = insertJob(db, { account_id: a.id });
    chargeAt(db, { accountId: a.id, jobId: j, milli: 1_000, at: "2026-10-05 23:59:59" });
    chargeAt(db, { accountId: a.id, jobId: j, milli: 2_000, at: "2026-10-06 00:00:00" });
    const res = await usage(a.key, "from=2026-10-05&to=2026-10-06&group=day");
    expect(res.body.rows).toEqual([
      { day: "2026-10-05", charged_milli: 1_000, jobs: 1 },
      { day: "2026-10-06", charged_milli: 2_000, jobs: 1 },
    ]);
  });

  test("the window is half open at the end: the entry at midnight after `to` is out, at the start it is in", async () => {
    const a = await personWithKey(db);
    const j = insertJob(db, { account_id: a.id });
    chargeAt(db, { accountId: a.id, jobId: j, milli: 1_000, at: "2026-10-05 00:00:00" });
    chargeAt(db, { accountId: a.id, jobId: j, milli: 10_000, at: "2026-10-06 00:00:00" });
    const res = await usage(a.key, "from=2026-10-05&to=2026-10-05");
    expect(res.body.rows).toEqual([{ charged_milli: 1_000, jobs: 1 }]);
    const wider = await usage(a.key, "from=2026-10-05&to=2026-10-06");
    expect(wider.body.rows).toEqual([{ charged_milli: 11_000, jobs: 1 }]);
    const before = await usage(a.key, "from=2026-10-06&to=2026-10-06");
    expect(before.body.rows).toEqual([{ charged_milli: 10_000, jobs: 1 }]);
  });

  test("the default window is the last 30 days ending today (UTC)", async () => {
    const a = await personWithKey(db);
    const j = insertJob(db, { account_id: a.id });
    const now = Date.now();
    chargeAt(db, { accountId: a.id, jobId: j, milli: 1_000, at: sqliteAt(now - 10 * 86_400_000) });
    chargeAt(db, { accountId: a.id, jobId: j, milli: 20_000, at: sqliteAt(now - 40 * 86_400_000) });
    const res = await usage(a.key);
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([{ charged_milli: 1_000, jobs: 1 }]);
    const today = new Date(now).toISOString().slice(0, 10);
    expect(res.body.to).toBe(today);
    expect(res.body.from).toBe(new Date(now - 29 * 86_400_000).toISOString().slice(0, 10));
  });

  test("366 days is the longest window; 367 is invalid_range", async () => {
    const a = await personWithKey(db);
    // 2025-01-01 to 2026-01-01 is 366 days counting both ends (2025 has 365 days).
    expect((await usage(a.key, "from=2025-01-01&to=2026-01-01")).status).toBe(200);
    const long = await usage(a.key, "from=2024-12-31&to=2026-01-01");
    expect(long.status).toBe(400);
    expect(long.body.code).toBe("invalid_range");
  });

  test("bad days, from after to, and a lone far-off from are invalid_range", async () => {
    const a = await personWithKey(db);
    for (const query of [
      "from=2026-10-06&to=2026-10-05",
      "from=2026-02-30&to=2026-03-31",
      "from=2026-01-01&to=2026-02-29",
      "from=2026-13-01",
      "from=abc",
      "to=2026-1-1",
      "from=2026-10-05T00:00:00Z",
      "from=2020-01-01",
      "from=",
    ]) {
      const res = await usage(a.key, query);
      expect([query, res.status, res.body.code]).toEqual([query, 400, "invalid_range"]);
    }
  });

  test("a bad or repeated group is invalid_group", async () => {
    const a = await personWithKey(db);
    for (const group of ["hour", "day,day", "", ",day", "day,", "Day", "day;app", "pool"]) {
      const res = await usage(a.key, `group=${encodeURIComponent(group)}`);
      expect([group, res.status, res.body.code]).toEqual([group, 400, "invalid_group"]);
    }
  });
});

describe("only the caller's own charges", () => {
  test("another person's charges are in neither the rows nor the total", async () => {
    const a = await personWithKey(db);
    const b = await personWithKey(db);
    const ja = insertJob(db, { account_id: a.id, app_id: "mine" });
    const jb = insertJob(db, { account_id: b.id, app_id: "theirs" });
    chargeAt(db, { accountId: a.id, jobId: ja, milli: 1_000, at: "2026-10-05 09:00:00" });
    chargeAt(db, { accountId: b.id, jobId: jb, milli: 777_000, at: "2026-10-05 09:00:00" });
    correctionAt(db, { accountId: b.id, milli: 55_000, at: "2026-10-05 09:30:00" });
    const mine = await usage(a.key, "from=2026-10-05&to=2026-10-05&group=app");
    expect(mine.body.rows).toEqual([{ app: "mine", charged_milli: 1_000, jobs: 1 }]);
    expect(mine.text).not.toContain("theirs");
    expect(mine.text).not.toContain("777000");
    const theirs = await usage(b.key, "from=2026-10-05&to=2026-10-05&group=app");
    expect(theirs.body.rows.map((r: { app: string | null }) => r.app)).toEqual([null, "theirs"]);
  });
});

describe("usage agrees with the ledger's own totals", () => {
  test("hold, charge with an overrun, a final settlement and a release: the usage total is the pool's charged total", async () => {
    const d1 = realD1(db);
    const a = await personWithKey(db);
    await fundPlatform(d1, "people", 10_000_000);
    const pool = await fundAccount(d1, a.id, 100_000);
    const budget = (
      db
        .query<{ id: number }, []>(
          "SELECT id FROM compute_pools WHERE holder_kind = 'platform' AND holder_ref = 'people' AND pool = 'cpu'",
        )
        .get() as { id: number }
    ).id;
    const make = async (hold: number) => {
      const id = insertJob(db, { account_id: a.id, app_id: `app-${hold}` });
      const r = await placeHold(d1, {
        poolId: pool,
        budgetPoolId: budget,
        amountMilli: hold,
        jobId: id,
      });
      expect(r.ok).toBe(true);
      return id;
    };
    // Used 40,000 on a hold of 30,000: a charge of 30,000 and an overrun of 10,000. Final: 38,000.
    const x = await make(30_000);
    expect((await settleProvisional(d1, { jobId: x, chargeMilli: 40_000 })).ok).toBe(true);
    expect((await settleFinal(d1, { jobId: x, finalMilli: 38_000 })).ok).toBe(true);
    // Used 6,000 on a hold of 10,000.
    const y = await make(10_000);
    expect((await settleProvisional(d1, { jobId: y, chargeMilli: 6_000 })).ok).toBe(true);
    // Never started: released, no charge.
    const z = await make(5_000);
    expect((await releaseHold(d1, { jobId: z })).ok).toBe(true);

    const app = readApp(db);
    const me = await app.call("/me", { key: a.key });
    expect(me.body.pools.cpu.charged_milli).toBe(44_000);
    const byApp = await app.call("/me/usage?group=app", { key: a.key });
    expect(byApp.body.rows).toEqual([
      { app: "app-10000", charged_milli: 6_000, jobs: 1 },
      { app: "app-30000", charged_milli: 38_000, jobs: 1 },
    ]);
    const total = await app.call("/me/usage", { key: a.key });
    expect(total.body.rows).toEqual([{ charged_milli: 44_000, jobs: 2 }]);
  });

  test("a job whose final settlement was of nothing is not counted among a group's charged jobs", async () => {
    const a = await personWithKey(db);
    const charged = insertJob(db, { account_id: a.id, app_id: "same-app" });
    const nothing = insertJob(db, { account_id: a.id, app_id: "same-app" });
    chargeAt(db, { accountId: a.id, jobId: charged, milli: 2_000, at: "2026-10-05 09:00:00" });
    // The entry of a final settlement that changed nothing: a charged delta of 0 on the job.
    db.query(
      `INSERT INTO compute_ledger (kind, pool_id, budget_pool_id, charged_delta_milli, job_id,
                                   idempotency_key, created_at)
       SELECT 'adjust', p.id, b.id, 0, ?, 'seed:zero:final', '2026-10-05 10:00:00'
         FROM compute_pools p, compute_pools b
        WHERE p.holder_kind = 'account' AND p.holder_ref = ? AND p.pool = 'cpu'
          AND b.holder_kind = 'platform' AND b.holder_ref = 'people' AND b.pool = 'cpu'`,
    ).run(nothing, String(a.id));
    const res = await usage(a.key, "from=2026-10-05&to=2026-10-05&group=app");
    expect(res.body.rows).toEqual([{ app: "same-app", charged_milli: 2_000, jobs: 1 }]);
  });
});
