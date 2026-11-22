/**
 * `GET /compute/me` (epic #2021 phase D2, #2023; ADR 0118, the addendum of this phase), through the REAL
 * compute router over real migrated SQLite, with a real API key.
 *
 * What is pinned, each by a test of its own:
 *  - the pool figures are exact after a grant, an open hold, a settled hold and a released hold, all
 *    made through Epic A's ledger services; `available_milli` is granted - held - charged, and a frozen
 *    account reports `frozen: true`;
 *  - the route answers in EVERY access state, `none` and `suspended` included, with the access object;
 *  - the limits and the queue estimates are the owner policy's (read through `getPolicy`), only for the
 *    partitions offered to people, and an unreadable policy is 503 `policy_unavailable`, never a default;
 *  - nothing an administrator alone sees (a purpose, a flag, a pseudonym) is on the wire;
 *  - it works with the compute switch off, and answers the same with it on.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { COMPUTE_ACCESS_STATES } from "../../shared/compute-access-state";
import {
  COMPUTE_TERMS_PUBLISHED,
  COMPUTE_TERMS_VERSION,
} from "../../shared/contract/compute-terms";
import { ComputeMeResponseSchema } from "../../shared/contract/compute-user";
import { placeHold, releaseHold, settleProvisional } from "../src/services/compute-ledger";
import { fundAccount, fundPlatform, seedUser, setPolicy } from "./helpers/compute-seed";
import { insertJob, jobIdFor, personWithKey, readApp, sqliteAt } from "./helpers/compute-user-seed";
import { freshDb, realD1 } from "./helpers/d1";

let db: Database;

beforeEach(() => {
  db = freshDb();
});

/** The platform `people` pool of a word, which the migration seeds. */
const peoplePool = (word: "cpu" | "gpu" = "cpu") =>
  (
    db
      .query<{ id: number }, [string]>(
        "SELECT id FROM compute_pools WHERE holder_kind = 'platform' AND holder_ref = 'people' AND pool = ?",
      )
      .get(word) as { id: number }
  ).id;

describe("the pool figures are exact", () => {
  test("a grant, an open hold, a settled hold (charge below the hold) and a released hold", async () => {
    const d1 = realD1(db);
    const person = await personWithKey(db);
    await fundPlatform(d1, "people", 10_000_000);
    const pool = await fundAccount(d1, person.id, 100_000);
    const budget = peoplePool();

    // Open hold of 20,000.
    const open = jobIdFor();
    expect(
      (
        await placeHold(d1, {
          poolId: pool,
          budgetPoolId: budget,
          amountMilli: 20_000,
          jobId: open,
        })
      ).ok,
    ).toBe(true);
    // A hold of 30,000 that the job settles at 12,500: 12,500 charged, 17,500 returned.
    const settled = jobIdFor();
    expect(
      (
        await placeHold(d1, {
          poolId: pool,
          budgetPoolId: budget,
          amountMilli: 30_000,
          jobId: settled,
        })
      ).ok,
    ).toBe(true);
    expect((await settleProvisional(d1, { jobId: settled, chargeMilli: 12_500 })).ok).toBe(true);
    // A hold of 5,000 that never started: released in full.
    const released = jobIdFor();
    expect(
      (
        await placeHold(d1, {
          poolId: pool,
          budgetPoolId: budget,
          amountMilli: 5_000,
          jobId: released,
        })
      ).ok,
    ).toBe(true);
    expect((await releaseHold(d1, { jobId: released })).ok).toBe(true);

    const res = await readApp(db).call("/me", { key: person.key });
    expect(res.status).toBe(200);
    expect(ComputeMeResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.pools.cpu).toEqual({
      granted_milli: 100_000,
      held_milli: 20_000,
      charged_milli: 12_500,
      // 100,000 - 20,000 - 12,500
      available_milli: 67_500,
    });
    // Nothing granted in the other pool is zero, which is true: nothing was granted.
    expect(res.body.pools.gpu).toEqual({
      granted_milli: 0,
      held_milli: 0,
      charged_milli: 0,
      available_milli: 0,
    });
    expect(res.body.frozen).toBe(false);
  });

  test("an overrun takes available below zero and the route says so (an integer, not clamped)", async () => {
    const d1 = realD1(db);
    const person = await personWithKey(db);
    await fundPlatform(d1, "people", 10_000_000);
    const pool = await fundAccount(d1, person.id, 10_000);
    const job = jobIdFor();
    await placeHold(d1, {
      poolId: pool,
      budgetPoolId: peoplePool(),
      amountMilli: 10_000,
      jobId: job,
    });
    // Used 14,000 against a hold of 10,000: 10,000 charged and a 4,000 overrun.
    await settleProvisional(d1, { jobId: job, chargeMilli: 14_000 });
    const res = await readApp(db).call("/me", { key: person.key });
    expect(res.body.pools.cpu).toMatchObject({
      held_milli: 0,
      charged_milli: 14_000,
      available_milli: -4_000,
    });
    expect(Number.isInteger(res.body.pools.cpu.available_milli)).toBe(true);
  });

  test("a gpu pool is its own: the two words never mix", async () => {
    const d1 = realD1(db);
    const person = await personWithKey(db);
    await fundAccount(d1, person.id, 8_000, "gpu");
    await fundAccount(d1, person.id, 3_000, "cpu");
    const res = await readApp(db).call("/me", { key: person.key });
    expect(res.body.pools.gpu.granted_milli).toBe(8_000);
    expect(res.body.pools.cpu.granted_milli).toBe(3_000);
  });

  test("a frozen pool reports frozen: true, and the balance is still stated", async () => {
    const d1 = realD1(db);
    const person = await personWithKey(db, { access: "suspended" });
    const pool = await fundAccount(d1, person.id, 50_000);
    db.query("UPDATE compute_pools SET frozen = 1 WHERE id = ?").run(pool);
    const res = await readApp(db).call("/me", { key: person.key });
    expect(res.status).toBe(200);
    expect(res.body.frozen).toBe(true);
    expect(res.body.pools.cpu.available_milli).toBe(50_000);
  });
});

describe("the access object, in every state", () => {
  for (const state of COMPUTE_ACCESS_STATES) {
    test(`state ${state} is answered, with the terms fields`, async () => {
      const person = await personWithKey(db, { access: state });
      db.query(
        `UPDATE users SET compute_access_requested_at = '2026-11-01 10:00:00',
                compute_access_granted_at = ?, compute_terms_version = 'older-terms' WHERE id = ?`,
      ).run(state === "active" ? "2026-11-02 11:00:00" : null, person.id);
      const res = await readApp(db).call("/me", { key: person.key });
      expect(res.status).toBe(200);
      expect(ComputeMeResponseSchema.safeParse(res.body).success).toBe(true);
      expect(res.body.access).toMatchObject({
        state,
        requested_at: "2026-11-01 10:00:00",
        granted_at: state === "active" ? "2026-11-02 11:00:00" : null,
        // The version the person accepted is theirs, and the one in force is the Worker's.
        terms_version: "older-terms",
        current_terms_version: COMPUTE_TERMS_VERSION,
        terms_published: COMPUTE_TERMS_PUBLISHED,
      });
    });
  }

  test("a person who never asked has null stamps and no accepted terms", async () => {
    const person = await personWithKey(db, { access: "none" });
    const res = await readApp(db).call("/me", { key: person.key });
    expect(res.body.access).toMatchObject({
      state: "none",
      requested_at: null,
      granted_at: null,
      terms_version: null,
    });
  });

  test("requests_open is false in production while the terms are unpublished, and true elsewhere", async () => {
    const person = await personWithKey(db, { access: "none" });
    const production = await readApp(db, { ENVIRONMENT: "production" }).call("/me", {
      key: person.key,
    });
    const staging = await readApp(db, { ENVIRONMENT: "development" }).call("/me", {
      key: person.key,
    });
    expect(COMPUTE_TERMS_PUBLISHED).toBe(false);
    expect(production.body.access.requests_open).toBe(false);
    expect(staging.body.access.requests_open).toBe(true);
  });
});

describe("limits and queue estimates come from the owner's policy", () => {
  test("the default policy: the offered partitions with their ceilings, the live-job limit, the results days", async () => {
    const person = await personWithKey(db);
    const res = await readApp(db).call("/me", { key: person.key });
    const names = res.body.limits.partitions.map((p: { name: string }) => p.name);
    // `large-shared` and `preempt` have no default ceiling: they are NEMAR's pipelines only.
    expect(names).not.toContain("large-shared");
    expect(names).not.toContain("preempt");
    expect(names).toContain("shared");
    const shared = res.body.limits.partitions.find((p: { name: string }) => p.name === "shared");
    expect(shared).toEqual({
      name: "shared",
      pool: "cpu",
      max_nodes: 1,
      max_cores_per_node: 64,
      max_gpus_per_node: 0,
      max_minutes: 2880,
    });
    expect(res.body.limits.max_live_jobs).toBe(4);
    expect(res.body.limits.results_days).toBe(30);
    // One queue entry per offered partition, in the same order.
    expect(res.body.queue.map((q: { partition: string }) => q.partition)).toEqual(names);
  });

  test("a policy the owner set is the one read: its limits, its offered partitions", async () => {
    const d1 = realD1(db);
    const owner = await seedUser(d1, { role: "owner" });
    await setPolicy(d1, owner, {
      maxLiveJobsPerPerson: 7,
      retention: { recordsYears: 7, logsDays: 365, resultsDays: 21 },
      ceilings: { shared: { maxNodes: 1, maxCoresPerNode: 8, maxGpusPerNode: 0, maxMinutes: 120 } },
    });
    const person = await personWithKey(db);
    const res = await readApp(db).call("/me", { key: person.key });
    expect(res.body.limits.partitions).toEqual([
      {
        name: "shared",
        pool: "cpu",
        max_nodes: 1,
        max_cores_per_node: 8,
        max_gpus_per_node: 0,
        max_minutes: 120,
      },
    ]);
    expect(res.body.limits.max_live_jobs).toBe(7);
    expect(res.body.limits.results_days).toBe(21);
    expect(res.body.queue.map((q: { partition: string }) => q.partition)).toEqual(["shared"]);
  });

  test("a queue estimate is real with five samples and null (with the count) with four", async () => {
    const person = await personWithKey(db);
    const now = Date.now();
    const started = (partition: string, wait: number) =>
      insertJob(db, {
        partition,
        account_id: 999,
        started_at: sqliteAt(now - 3_600_000),
        remote_submitted_at: sqliteAt(now - 3_600_000 - wait * 1000),
      });
    for (const wait of [10, 20, 30, 40, 50]) started("shared", wait);
    for (const wait of [5, 6, 7, 8]) started("compute", wait);
    const res = await readApp(db).call("/me", { key: person.key });
    const queue = Object.fromEntries(
      res.body.queue.map((q: { partition: string }) => [q.partition, q]),
    );
    expect(queue.shared).toEqual({
      partition: "shared",
      median_seconds: 30,
      p90_seconds: 50,
      count: 5,
      window_days: 7,
    });
    expect(queue.compute).toMatchObject({ median_seconds: null, p90_seconds: null, count: 4 });
  });

  test("an unreadable policy is 503 policy_unavailable, never the default", async () => {
    const person = await personWithKey(db);
    // A stored version that is a JSON object and fails the strict schema.
    db.query("INSERT INTO compute_policy (policy_json, set_by) VALUES ('{}', 1)").run();
    const res = await readApp(db).call("/me", { key: person.key });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("policy_unavailable");
    expect(res.body.limits).toBeUndefined();
  });
});

describe("what it does not say, and when it works", () => {
  test("no purpose, no pseudonym, no flag, no email or name of anyone is on the wire", async () => {
    const purpose = "A purpose text only an administrator reads in the queue 7f3a";
    const person = await personWithKey(db, { purpose });
    const stranger = await personWithKey(db, { purpose: "Another purpose 91cc for somebody else" });
    insertJob(db, {
      account_id: person.id,
      flag_mismatch: 1,
      flag_overrun: 1,
      platform_failure: 1,
    });
    const res = await readApp(db).call("/me", { key: person.key });
    for (const word of [
      purpose,
      "Another purpose",
      "purpose",
      "gateway_user",
      "gw_",
      person.email,
      stranger.email,
      "Lovelace",
      "Freedonia",
      "flags",
      "platform_failure",
      "oidc_subject",
      "nmu_",
    ]) {
      expect([word, res.text.includes(word)]).toEqual([word, false]);
    }
  });

  test("it works with the compute switch off, and answers the same with it on", async () => {
    const person = await personWithKey(db);
    await fundAccount(realD1(db), person.id, 4_000);
    const off = await readApp(db).call("/me", { key: person.key });
    const on = await readApp(db, { COMPUTE_ENABLED: "1" }).call("/me", { key: person.key });
    expect(off.status).toBe(200);
    expect(on.body).toEqual(off.body);
  });

  test("the answer is private and not cached", async () => {
    const person = await personWithKey(db);
    const res = await readApp(db).call("/me", { key: person.key });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
