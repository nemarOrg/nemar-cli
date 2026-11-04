/**
 * The allocation pool routes (epic #2005 phase A2, #2007; ADR 0118), through the REAL admin router
 * and its middleware (`app.fetch`), against a real migrated database (bun:sqlite behind `realD1`),
 * with real API keys. No mocks.
 *
 * What is pinned:
 *  - who may do what: a member is refused everywhere, an admin reads every pool and grants and
 *    adjusts an account's, and only an owner grants or adjusts a platform budget;
 *  - a grant and an adjustment need an `Idempotency-Key`, and a repeat of one grants once (the same
 *    key for another request is a 409), with one audit row for the one grant;
 *  - an invalid body is a 400 that names the fields and never echoes a value, and nothing is
 *    written; amounts are whole milli-SU (a fraction, a string and a number a double cannot hold
 *    are refused);
 *  - an adjustment of the charge of an account's pool follows the `people` budget of the same
 *    word, and one that would make a stored total negative is a 409 that writes nothing;
 *  - the totals still equal the ledger's sums after all of it.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  computeEnv,
  makeComputeApp,
  seedComputeUsers,
} from "./helpers/compute-app";
import { totalsDisagreements } from "./helpers/compute-ledger";
import { freshDb, realD1, yieldingD1 } from "./helpers/d1";

const MARK = "SECRET-MARKER-5512";
const handle = makeComputeApp();

let db: Database;
let ids: Record<ComputeWho, number>;
let accountId: number;
let keySeq = 0;
const freshKey = () => `route-test-key-${++keySeq}-${Math.random().toString(36).slice(2, 8)}`;

beforeEach(async () => {
  db = freshDb();
  ids = await seedComputeUsers(db);
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified, service_access, account_kind)
     VALUES ('cmp-holder', 'cmp-holder@example.org', 'x', 'verified', 'member', 'cli', 1, 0, 'person')`,
  );
  accountId = (
    db.query("SELECT id FROM users WHERE username = 'cmp-holder'").get() as { id: number }
  ).id;
});

interface Called {
  status: number;
  body: Record<string, any>;
  text: string;
}

async function call(
  who: ComputeWho | null,
  method: string,
  path: string,
  o: {
    body?: unknown;
    raw?: string;
    key?: string | null;
    env?: ReturnType<typeof computeEnv>;
  } = {},
): Promise<Called> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (who) headers.Authorization = `Bearer ${COMPUTE_KEYS[who]}`;
  if (o.key !== null && method === "POST") headers["Idempotency-Key"] = o.key ?? freshKey();
  const res = await handle(
    new Request(`http://api.test/admin/compute/pools${path}`, {
      method,
      headers,
      body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)),
    }),
    o.env ?? computeEnv(db),
  );
  const text = await res.text();
  let body: Record<string, any> = {};
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON; `text` is what the assertion reads.
  }
  return { status: res.status, body, text };
}

const grant = (who: ComputeWho | null, path: string, body: unknown, key?: string | null) =>
  call(who, "POST", `${path}/grant`, { body, key });
const adjust = (who: ComputeWho | null, path: string, body: unknown, key?: string | null) =>
  call(who, "POST", `${path}/adjust`, { body, key });

const ACCOUNT = () => `/by-id/${accountId}`;
const PEOPLE = "/platform/people";

const count = (sql: string, ...binds: unknown[]) =>
  (db.query(sql).get(...(binds as never[])) as { n: number }).n;
const ledger = () => count("SELECT COUNT(*) AS n FROM compute_ledger");
const audits = (action: string) =>
  db.query("SELECT * FROM audit_log WHERE action = ? ORDER BY id").all(action) as Array<{
    user_id: number | null;
    resource_type: string | null;
    resource_id: string | null;
    details: string | null;
  }>;
const poolOf = (kind: string, ref: string, word: string) =>
  db
    .query("SELECT * FROM compute_pools WHERE holder_kind = ? AND holder_ref = ? AND pool = ?")
    .get(kind, ref, word) as Record<string, number | string> | null;

describe("who may read and write", () => {
  test("no key is a 401 and a member is a 403, on every route", async () => {
    const g = { pool: "cpu", amount_milli: 1000 };
    const a = { pool: "cpu", target: "granted", delta_milli: 1, reason: "correction" };
    for (const who of [null, "member"] as const) {
      const want = who === null ? 401 : 403;
      expect((await call(who, "GET", "")).status).toBe(want);
      expect((await call(who, "GET", ACCOUNT())).status).toBe(want);
      expect((await grant(who, ACCOUNT(), g)).status).toBe(want);
      expect((await adjust(who, ACCOUNT(), a)).status).toBe(want);
      expect((await grant(who, PEOPLE, g)).status).toBe(want);
      expect((await adjust(who, PEOPLE, a)).status).toBe(want);
    }
    expect(ledger()).toBe(0);
  });

  test("an admin reads, and grants and adjusts an account's pool", async () => {
    expect((await call("admin", "GET", "")).status).toBe(200);
    expect((await call("admin", "GET", ACCOUNT())).status).toBe(200);
    const g = await grant("admin", ACCOUNT(), { pool: "cpu", amount_milli: 5000 });
    expect(g.status).toBe(201);
    const a = await adjust("admin", ACCOUNT(), {
      pool: "cpu",
      target: "granted",
      delta_milli: -1000,
      reason: "correction",
    });
    expect(a.status).toBe(201);
    expect(a.body.pool.granted_milli).toBe(4000);
  });

  test("an admin is refused a platform budget, with owner_only, and nothing is written", async () => {
    const g = await grant("admin", PEOPLE, { pool: "cpu", amount_milli: 1000 });
    expect([g.status, g.body.code]).toEqual([403, "owner_only"]);
    const a = await adjust("admin", PEOPLE, {
      pool: "cpu",
      target: "granted",
      delta_milli: 1,
      reason: "correction",
    });
    expect([a.status, a.body.code]).toEqual([403, "owner_only"]);
    expect(ledger()).toBe(0);
    expect(audits("compute.pool.grant")).toEqual([]);
  });

  test("an owner grants and adjusts a platform budget, and an account's pool too", async () => {
    const g = await grant("owner", PEOPLE, { pool: "gpu", amount_milli: 90000 });
    expect(g.status).toBe(201);
    expect(g.body.pool).toMatchObject({
      holder_kind: "platform",
      holder_ref: "people",
      pool: "gpu",
      granted_milli: 90000,
      available_milli: 90000,
    });
    const a = await adjust("owner", PEOPLE, {
      pool: "gpu",
      target: "granted",
      delta_milli: -40000,
      reason: "correction",
    });
    expect(a.body.pool.granted_milli).toBe(50000);
    expect((await grant("owner", ACCOUNT(), { pool: "cpu", amount_milli: 1 })).status).toBe(201);
  });
});

describe("a grant", () => {
  test("moves the amount in milli-SU, makes the pool on first use, and is audited", async () => {
    const r = await grant("admin", ACCOUNT(), {
      pool: "cpu",
      amount_milli: 12500,
      reason: "top_up",
    });
    expect(r.status).toBe(201);
    expect(r.body.replayed).toBe(false);
    expect(r.body.pool).toMatchObject({
      holder_kind: "account",
      holder_ref: String(accountId),
      pool: "cpu",
      granted_milli: 12500,
      held_milli: 0,
      charged_milli: 0,
      available_milli: 12500,
      frozen: false,
    });
    expect(r.body.entry).toMatchObject({
      kind: "grant",
      granted_delta_milli: 12500,
      actor_user_id: ids.admin,
      reason: "top_up",
    });
    expect(r.body.entry.idempotency_key).toBeUndefined();
    const [audit] = audits("compute.pool.grant");
    expect(audit).toMatchObject({ user_id: ids.admin, resource_type: "compute_pool" });
    expect(JSON.parse(audit?.details ?? "{}")).toMatchObject({
      entry_id: r.body.entry.id,
      kind: "grant",
      holder_kind: "account",
      holder_ref: String(accountId),
      pool: "cpu",
      granted_delta_milli: 12500,
      reason: "top_up",
    });
    // The other word is its own pool.
    const gpu = await grant("admin", ACCOUNT(), { pool: "gpu", amount_milli: 1 });
    expect(gpu.body.pool.pool).toBe("gpu");
    expect(count("SELECT COUNT(*) AS n FROM compute_pools WHERE holder_kind = 'account'")).toBe(2);
    expect(await totalsDisagreements(realD1(db))).toEqual([]);
  });

  test("a repeated key grants once, and says it was a repeat", async () => {
    const key = freshKey();
    const body = { pool: "cpu", amount_milli: 7000 };
    const first = await grant("admin", ACCOUNT(), body, key);
    const again = await grant("admin", ACCOUNT(), body, key);
    expect([first.status, first.body.replayed]).toEqual([201, false]);
    expect([again.status, again.body.replayed]).toEqual([200, true]);
    expect(again.body.entry).toEqual(first.body.entry);
    expect(again.body.pool.granted_milli).toBe(7000);
    expect(count("SELECT COUNT(*) AS n FROM compute_ledger WHERE kind = 'grant'")).toBe(1);
    expect(audits("compute.pool.grant")).toHaveLength(1);
  });

  test("the same key for another request is a 409 and changes nothing", async () => {
    const key = freshKey();
    await grant("admin", ACCOUNT(), { pool: "cpu", amount_milli: 7000 }, key);
    for (const body of [
      { pool: "cpu", amount_milli: 7001 },
      { pool: "gpu", amount_milli: 7000 },
    ]) {
      const r = await grant("admin", ACCOUNT(), body, key);
      expect([r.status, r.body.code]).toEqual([409, "idempotency_conflict"]);
    }
    // And a key an adjustment used is not one a grant can reuse.
    const adjKey = freshKey();
    await adjust(
      "admin",
      ACCOUNT(),
      { pool: "cpu", target: "granted", delta_milli: 1, reason: "correction" },
      adjKey,
    );
    expect((await grant("admin", ACCOUNT(), { pool: "cpu", amount_milli: 1 }, adjKey)).status).toBe(
      201,
    );
    expect(poolOf("account", String(accountId), "cpu")?.granted_milli).toBe(7002);
    expect(audits("compute.pool.grant")).toHaveLength(2);
  });

  test("the same key from two requests at once grants once", async () => {
    const key = freshKey();
    const env = computeEnv(db, { DB: yieldingD1(realD1(db)) });
    const body = { pool: "cpu", amount_milli: 4000 };
    const both = await Promise.all([
      call("admin", "POST", `${ACCOUNT()}/grant`, { body, key, env }),
      call("admin", "POST", `${ACCOUNT()}/grant`, { body, key, env }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(poolOf("account", String(accountId), "cpu")?.granted_milli).toBe(4000);
    expect(audits("compute.pool.grant")).toHaveLength(1);
  });

  test("needs an Idempotency-Key of 8 to 100 letters, digits and . _ -", async () => {
    const body = { pool: "cpu", amount_milli: 1000 };
    const missing = await grant("admin", ACCOUNT(), body, null);
    expect([missing.status, missing.body.code]).toEqual([400, "idempotency_key_required"]);
    for (const key of [
      "short",
      "has space here",
      "k".repeat(101),
      "a/b/c/d/e/f",
      "ünïcode-key-1",
    ]) {
      const r = await grant("admin", ACCOUNT(), body, key);
      expect([key, r.status, r.body.code]).toEqual([key, 400, "idempotency_key_invalid"]);
    }
    expect((await grant("admin", ACCOUNT(), body, "k".repeat(100))).status).toBe(201);
    expect(ledger()).toBe(1);
  });

  test("a key an admin sends can never be one of the Worker's own", async () => {
    // The Worker's keys are `hold:<id>:charge` and `job:<id>:final`: an admin key is stored behind
    // `grant:` or `adjust:`, so it can neither collide with those nor pre-empt them.
    await grant("admin", ACCOUNT(), { pool: "cpu", amount_milli: 5 }, "hold.1.charge");
    await adjust(
      "admin",
      ACCOUNT(),
      { pool: "cpu", target: "granted", delta_milli: 1, reason: "correction" },
      "job.1.final",
    );
    expect(db.query("SELECT idempotency_key FROM compute_ledger ORDER BY id").all()).toEqual([
      { idempotency_key: "grant:hold.1.charge" },
      { idempotency_key: "adjust:job.1.final" },
    ]);
    expect(
      count("SELECT COUNT(*) AS n FROM compute_ledger WHERE idempotency_key LIKE 'hold:%'"),
    ).toBe(0);
    expect(
      count("SELECT COUNT(*) AS n FROM compute_ledger WHERE idempotency_key LIKE 'job:%'"),
    ).toBe(0);
  });

  test("refuses an account that does not exist, and an id that is not one", async () => {
    const body = { pool: "cpu", amount_milli: 1000 };
    // `0005` is the number 5 and an account may exist at 5, but it is not that account's id.
    for (const id of ["99999", "0", "abc", "012", "1.5", `0${accountId}`, `${accountId}.0`]) {
      const r = await grant("admin", `/by-id/${id}`, body);
      expect([id, r.status, r.body.code]).toEqual([id, 404, "account_not_found"]);
    }
    expect((await call("admin", "GET", "/by-id/99999")).body.code).toBe("account_not_found");
    // The id must be the canonical one on every route that takes it, not only the grant.
    for (const id of [`0${accountId}`, `${accountId}.0`, "abc"]) {
      const adjusted = await adjust("admin", `/by-id/${id}`, {
        pool: "cpu",
        target: "granted",
        delta_milli: 1,
        reason: "correction",
      });
      expect([id, adjusted.status, adjusted.body.code]).toEqual([id, 404, "account_not_found"]);
      const read = await call("admin", "GET", `/by-id/${id}`);
      expect([id, read.status, read.body.code]).toEqual([id, 404, "account_not_found"]);
    }
    expect(ledger()).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM compute_pools WHERE holder_kind = 'account'")).toBe(0);
  });

  test("refuses a platform key that is not a budget, and does not make one", async () => {
    const r = await grant("owner", "/platform/nonesuch", { pool: "cpu", amount_milli: 1 });
    expect([r.status, r.body.code]).toEqual([404, "pool_not_found"]);
    expect(
      (await grant("owner", "/platform/Bad%20Key", { pool: "cpu", amount_milli: 1 })).status,
    ).toBe(404);
    expect(count("SELECT COUNT(*) AS n FROM compute_pools WHERE holder_kind = 'platform'")).toBe(4);
  });

  test("an invalid body is a 400 that names the fields, never echoes a value, and writes nothing", async () => {
    const bad: unknown[] = [
      { pool: MARK, amount_milli: 1 },
      { pool: "cpu", amount_milli: MARK },
      { pool: "cpu", amount_milli: 1.5 },
      { pool: "cpu", amount_milli: 0 },
      { pool: "cpu", amount_milli: -1 },
      { pool: "cpu", amount_milli: Number.MAX_SAFE_INTEGER + 1 },
      { pool: "cpu", amount_milli: "12500" },
      { pool: "cpu", amount_milli: 1, reason: `Bad ${MARK}` },
      { pool: "cpu", amount_milli: 1, reason: "r".repeat(65) },
      { pool: "cpu", amount_milli: 1, [MARK]: 1 },
      { amount_milli: 1 },
      { pool: "cpu" },
      {},
      null,
      [],
      MARK,
    ];
    for (const body of bad) {
      const r = await grant("admin", ACCOUNT(), body);
      expect([JSON.stringify(body), r.status, r.body.code]).toEqual([
        JSON.stringify(body),
        400,
        "invalid_body",
      ]);
      expect(r.text).not.toContain(MARK);
      expect(typeof r.body.error).toBe("string");
    }
    expect((await grant("admin", ACCOUNT(), undefined)).body.code).toBe("invalid_body");
    expect(
      (await call("admin", "POST", `${ACCOUNT()}/grant`, { raw: "{not json" })).body.code,
    ).toBe("invalid_body");
    expect(ledger()).toBe(0);
    expect(audits("compute.pool.grant")).toEqual([]);
  });

  test("names the field that is wrong", async () => {
    const r = await grant("admin", ACCOUNT(), { pool: "cpu", amount_milli: 1.5 });
    expect(r.body.error).toContain("amount_milli");
    expect(r.body.fields).toEqual([{ path: "amount_milli", code: "invalid_type" }]);
  });

  test("the largest exact amount is accepted, and one more SU of it is refused by the table", async () => {
    const r = await grant("owner", PEOPLE, { pool: "cpu", amount_milli: Number.MAX_SAFE_INTEGER });
    expect(r.status).toBe(201);
    expect(r.body.pool.available_milli).toBe(Number.MAX_SAFE_INTEGER);
    const again = await grant("owner", PEOPLE, { pool: "cpu", amount_milli: 1 });
    expect([again.status, again.body.code]).toEqual([500, "internal"]);
    expect(poolOf("platform", "people", "cpu")?.granted_milli).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("an adjustment", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    pool: "cpu",
    target: "granted",
    delta_milli: -500,
    reason: "correction",
    ...over,
  });

  test("corrects the grant, up or down, with a reason, and is audited", async () => {
    await grant("admin", ACCOUNT(), { pool: "cpu", amount_milli: 10000 });
    const down = await adjust("admin", ACCOUNT(), body({ delta_milli: -2500 }));
    expect(down.body.pool.granted_milli).toBe(7500);
    expect(down.body.entry).toMatchObject({
      kind: "adjust",
      granted_delta_milli: -2500,
      charged_delta_milli: 0,
      reason: "correction",
      actor_user_id: ids.admin,
    });
    const up = await adjust("admin", ACCOUNT(), body({ delta_milli: 100 }));
    expect(up.body.pool.granted_milli).toBe(7600);
    const audit = audits("compute.pool.adjust");
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ user_id: ids.admin, resource_type: "compute_pool" });
    expect(JSON.parse(audit[0]?.details ?? "{}")).toMatchObject({
      kind: "adjust",
      granted_delta_milli: -2500,
    });
  });

  test("an adjustment of the charge follows the people budget of the same word", async () => {
    await grant("owner", PEOPLE, { pool: "cpu", amount_milli: 100000 });
    await grant("admin", ACCOUNT(), { pool: "cpu", amount_milli: 10000 });
    const up = await adjust("admin", ACCOUNT(), body({ target: "charged", delta_milli: 3000 }));
    expect(up.body.pool).toMatchObject({ charged_milli: 3000, available_milli: 7000 });
    expect(up.body.entry).toMatchObject({ charged_delta_milli: 3000, granted_delta_milli: 0 });
    expect(poolOf("platform", "people", "cpu")?.charged_milli).toBe(3000);
    expect(poolOf("platform", "people", "gpu")?.charged_milli).toBe(0);
    expect(poolOf("platform", "pipelines", "cpu")?.charged_milli).toBe(0);
    const down = await adjust("admin", ACCOUNT(), body({ target: "charged", delta_milli: -3000 }));
    expect(down.body.pool.charged_milli).toBe(0);
    expect(poolOf("platform", "people", "cpu")?.charged_milli).toBe(0);
    expect(await totalsDisagreements(realD1(db))).toEqual([]);
  });

  test("a correction of a grant leaves the budget alone, and of a platform pool has none", async () => {
    await grant("admin", ACCOUNT(), { pool: "cpu", amount_milli: 10000 });
    await adjust("admin", ACCOUNT(), body({ delta_milli: 1000 }));
    expect(poolOf("platform", "people", "cpu")).toMatchObject({
      granted_milli: 0,
      held_milli: 0,
      charged_milli: 0,
    });
    await grant("owner", PEOPLE, { pool: "cpu", amount_milli: 5000 });
    const r = await adjust("owner", PEOPLE, body({ target: "charged", delta_milli: 1000 }));
    expect(r.body.pool.charged_milli).toBe(1000);
    expect(r.body.entry.budget_pool_id).toBeNull();
    expect(await totalsDisagreements(realD1(db))).toEqual([]);
  });

  test("one that would make a stored total negative is a 409 and writes nothing", async () => {
    await grant("admin", ACCOUNT(), { pool: "cpu", amount_milli: 1000 });
    const before = ledger();
    for (const over of [{ delta_milli: -1001 }, { target: "charged", delta_milli: -1 }]) {
      const r = await adjust("admin", ACCOUNT(), body(over));
      expect([r.status, r.body.code]).toEqual([409, "would_go_negative"]);
    }
    // And one the budget could not take: the person has charge the budget never counted.
    db.run(
      "INSERT INTO compute_ledger (kind, pool_id, charged_delta_milli, job_id, idempotency_key) VALUES ('overrun', ?, 500, 'job_000000000000000000000001', 'seed-1')",
      [(poolOf("account", String(accountId), "cpu") as { id: number }).id],
    );
    const budgetRefusal = await adjust(
      "admin",
      ACCOUNT(),
      body({ target: "charged", delta_milli: -500 }),
    );
    expect([budgetRefusal.status, budgetRefusal.body.code]).toEqual([409, "would_go_negative"]);
    expect(ledger()).toBe(before + 1);
    expect(audits("compute.pool.adjust")).toEqual([]);
  });

  test("a grant adjusted below what is used is allowed, and available says so", async () => {
    await grant("admin", ACCOUNT(), { pool: "cpu", amount_milli: 1000 });
    await adjust("admin", ACCOUNT(), body({ target: "charged", delta_milli: 800 }));
    const r = await adjust("admin", ACCOUNT(), body({ delta_milli: -900 }));
    expect(r.status).toBe(201);
    expect(r.body.pool).toMatchObject({
      granted_milli: 100,
      charged_milli: 800,
      available_milli: -700,
    });
  });

  test("a repeated key adjusts once, and another request for the key is a 409", async () => {
    await grant("admin", ACCOUNT(), { pool: "cpu", amount_milli: 10000 });
    const key = freshKey();
    const a = await adjust("admin", ACCOUNT(), body({ delta_milli: 100 }), key);
    const b = await adjust("admin", ACCOUNT(), body({ delta_milli: 100 }), key);
    expect([a.status, a.body.replayed, b.status, b.body.replayed]).toEqual([201, false, 200, true]);
    expect(b.body.pool.granted_milli).toBe(10100);
    const c = await adjust("admin", ACCOUNT(), body({ delta_milli: 101 }), key);
    expect([c.status, c.body.code]).toEqual([409, "idempotency_conflict"]);
    expect(audits("compute.pool.adjust")).toHaveLength(1);
  });

  test("an adjustment never makes a pool, and a platform key that is not a budget is not found", async () => {
    const none = await adjust("admin", ACCOUNT(), body());
    expect([none.status, none.body.code]).toEqual([404, "pool_not_found"]);
    const budget = await adjust("owner", "/platform/nonesuch", body());
    expect([budget.status, budget.body.code]).toEqual([404, "pool_not_found"]);
    expect(count("SELECT COUNT(*) AS n FROM compute_pools WHERE holder_kind = 'account'")).toBe(0);
    expect(ledger()).toBe(0);
  });

  test("needs a key, a reason and a nonzero whole amount, and echoes nothing it was sent", async () => {
    await grant("admin", ACCOUNT(), { pool: "cpu", amount_milli: 1000 });
    const before = ledger();
    expect((await adjust("admin", ACCOUNT(), body(), null)).body.code).toBe(
      "idempotency_key_required",
    );
    const bad: unknown[] = [
      body({ delta_milli: 0 }),
      body({ delta_milli: 1.5 }),
      body({ delta_milli: "5" }),
      body({ delta_milli: Number.MAX_SAFE_INTEGER + 1 }),
      body({ target: "held" }),
      body({ target: MARK }),
      body({ reason: undefined }),
      body({ reason: `Bad ${MARK}` }),
      body({ pool: MARK }),
      body({ [MARK]: 1 }),
      { pool: "cpu", target: "granted", reason: "correction" },
      {},
      null,
    ];
    for (const b of bad) {
      const r = await adjust("admin", ACCOUNT(), b);
      expect([JSON.stringify(b), r.status, r.body.code]).toEqual([
        JSON.stringify(b),
        400,
        "invalid_body",
      ]);
      expect(r.text).not.toContain(MARK);
    }
    expect(ledger()).toBe(before);
  });
});

describe("reading pools", () => {
  test("lists the four platform pools first, then accounts', a page at a time", async () => {
    await grant("admin", ACCOUNT(), { pool: "cpu", amount_milli: 1 });
    await grant("admin", ACCOUNT(), { pool: "gpu", amount_milli: 1 });
    const all = await call("admin", "GET", "");
    expect(all.status).toBe(200);
    expect(all.body.pools.map((p: { holder_kind: string }) => p.holder_kind)).toEqual([
      "platform",
      "platform",
      "platform",
      "platform",
      "account",
      "account",
    ]);
    expect(all.body.next_after).toBeNull();
    const first = await call("admin", "GET", "?limit=4");
    expect(first.body.pools).toHaveLength(4);
    expect(first.body.next_after).toBe(first.body.pools[3].id);
    const rest = await call("admin", "GET", `?limit=4&after=${first.body.next_after}`);
    expect(rest.body.pools.map((p: { holder_kind: string }) => p.holder_kind)).toEqual([
      "account",
      "account",
    ]);
    expect(rest.body.next_after).toBeNull();
    const platform = await call("admin", "GET", "?holder_kind=platform");
    expect(platform.body.pools).toHaveLength(4);
  });

  test("refuses a query that is not one, naming the field", async () => {
    for (const q of [
      "?limit=0",
      "?limit=201",
      "?limit=x",
      "?after=-1",
      "?holder_kind=tenant",
      "?after=1.5",
    ]) {
      const r = await call("admin", "GET", q);
      expect([q, r.status, r.body.code]).toEqual([q, 400, "invalid_query"]);
    }
  });

  test("shows one account's pools, none yet as an empty list", async () => {
    const none = await call("admin", "GET", ACCOUNT());
    expect(none.body).toEqual({ account_id: accountId, pools: [] });
    await grant("admin", ACCOUNT(), { pool: "gpu", amount_milli: 2500 });
    await grant("admin", ACCOUNT(), { pool: "cpu", amount_milli: 1500 });
    const some = await call("admin", "GET", ACCOUNT());
    expect(
      some.body.pools.map((p: { pool: string; granted_milli: number }) => [
        p.pool,
        p.granted_milli,
      ]),
    ).toEqual([
      ["cpu", 1500],
      ["gpu", 2500],
    ]);
  });

  test("shows a frozen pool as frozen", async () => {
    await grant("admin", ACCOUNT(), { pool: "cpu", amount_milli: 1000 });
    expect((await call("admin", "GET", ACCOUNT())).body.pools[0].frozen).toBe(false);
    db.run("UPDATE compute_pools SET frozen = 1 WHERE holder_kind = 'account'");
    expect((await call("admin", "GET", ACCOUNT())).body.pools[0].frozen).toBe(true);
    expect(
      (await call("admin", "GET", "")).body.pools.some((p: { frozen: boolean }) => p.frozen),
    ).toBe(true);
  });

  test("reports a negative available as it is, never a negative total", async () => {
    await grant("admin", ACCOUNT(), { pool: "cpu", amount_milli: 1000 });
    const id = (poolOf("account", String(accountId), "cpu") as { id: number }).id;
    db.run(
      "INSERT INTO compute_ledger (kind, pool_id, charged_delta_milli, job_id, idempotency_key) VALUES ('overrun', ?, 1500, 'job_000000000000000000000002', 'seed-2')",
      [id],
    );
    const r = await call("admin", "GET", ACCOUNT());
    expect(r.body.pools[0]).toMatchObject({
      granted_milli: 1000,
      charged_milli: 1500,
      available_milli: -500,
    });
  });
});

describe("after all of it", () => {
  test("the totals equal the ledger's sums", async () => {
    await grant("owner", PEOPLE, { pool: "cpu", amount_milli: 50000 });
    await grant("admin", ACCOUNT(), { pool: "cpu", amount_milli: 9000 });
    await adjust("admin", ACCOUNT(), {
      pool: "cpu",
      target: "charged",
      delta_milli: 2000,
      reason: "correction",
    });
    await adjust("admin", ACCOUNT(), {
      pool: "cpu",
      target: "granted",
      delta_milli: -1000,
      reason: "correction",
    });
    expect(await totalsDisagreements(realD1(db))).toEqual([]);
  });
});
