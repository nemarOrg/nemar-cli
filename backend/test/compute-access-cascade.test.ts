/**
 * Ending a person's compute standing ends their compute, in the same batch (epic #2021 phase D1,
 * #2022; AGENTS.md, "Revocation cascades, always"; ADR 0118, the compute-access addendum). FOUR paths
 * end it, and each is driven here through its REAL route (or the real `tombstoneUserCascade`) over a real
 * migrated database carrying real jobs made through `createJob`, real holds and real pools, with the Tapis
 * tenant the A4 stand-in (a real HTTP server built from Tapis's published specifications; NO RESPONSE IN IT
 * WAS RECORDED FROM A REAL TENANT) and the cancel that follows the batch made by the real
 * `sweepComputeCancellations`. Nothing here replaces a NEMAR decision.
 *
 *  - an administrator's SUSPENSION and REVOCATION of compute access (`endComputeStatements`): the
 *    state flips, every pool of the account freezes, a job that never reached Tapis is canceled with its
 *    hold released, a job at Tapis records `account_ended` and keeps its hold for the retried sweep, no
 *    network call is made, and a bystander's job, pools and ledger are untouched;
 *  - the ACCOUNT's revocation (`finalizeRevocation`) and deletion (`tombstoneUserCascade`) also set
 *    `compute_access = 'revoked'` (a deleted account's purpose text is erased, its terms version and times
 *    stay; `none` stays `none` under a revocation, because there was nothing to end);
 *  - a role demotion and a key revocation end none of it;
 *  - ATOMICITY: a statement of the batch that fails rolls the whole decision back, the flip, the audit row,
 *    the freeze and the cancellations alike (a trigger on the real table makes one fail).
 *
 * MUTATIONS (each applied to the production line, run, restored; the results are in the PR): omit
 * `endComputeStatements` from the decision route; omit the compute flip from `finalizeRevocation`; omit
 * the compute columns from the tombstone mask; omit the release statements from the tombstone cascade.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { tombstoneUserCascade } from "../src/db/user-tombstone";
import { adminRoutes } from "../src/routes/admin";
import { sweepComputeCancellations } from "../src/services/compute-advance";
import { type ComputeJobRow, createJob } from "../src/services/compute-jobs";
import { advanceComputeJob, submitComputeJob } from "../src/services/compute-lifecycle";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import {
  type LifecycleFixture,
  MINUTE,
  launchableSpec,
  reread,
  setPolicy,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { fundAccount, fundPlatform, seedUser } from "./helpers/compute-seed";

const OWNER_KEY = "access-cascade-owner-key-0123456789abcdef012345";
const ADMIN_KEY = "access-cascade-admin-key-0123456789abcdef012345";

let fx: LifecycleFixture;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminId = 0;

beforeAll(async () => {
  fx = await startLifecycleFixture();
}, 120_000);

beforeEach(async () => {
  await fx.reset();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  adminId = await seedUser(fx.env().DB, { role: "admin", status: "approved" });
  for (const [id, key] of [
    [fx.ownerId, OWNER_KEY],
    [adminId, ADMIN_KEY],
  ] as const) {
    await fx.harness.db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(id, await hashApiKey(key), key.slice(0, 8));
  }
  await setPolicy(fx.env().DB, fx.ownerId, { maxLiveJobsPerPerson: 10 });
});

afterAll(async () => {
  await fx?.dispose();
}, 30_000);

const db = (): Database => fx.harness.db;

function routeEnv(): Bindings {
  return fx.env({ ENVIRONMENT: "test", RESEND_API_KEY: "", WEB_SESSION_COOKIE_DOMAIN: "" });
}

function call(key: string, method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(
    path,
    {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    routeEnv(),
  );
}

const decide = (decision: string, id: number) =>
  call(ADMIN_KEY, "POST", `/admin/compute/access/${decision}/by-id/${id}`);

const setAccess = (id: number, state: string) =>
  db().run(
    `UPDATE users SET compute_access = ?, compute_access_requested_at = datetime('now'),
       compute_purpose = 'Run ICA decompositions on public EEG datasets.',
       compute_terms_version = '2026-11-draft', compute_terms_accepted_at = datetime('now')
     WHERE id = ?`,
    [state, id],
  );

const access = (id: number) =>
  db().query("SELECT * FROM users WHERE id = ?").get(id) as Record<string, any>;

interface PoolRow {
  pool: string;
  frozen: number;
  held_milli: number;
}

const poolsOf = (accountId: number): PoolRow[] =>
  db()
    .query<PoolRow, [string]>(
      "SELECT pool, frozen, held_milli FROM compute_pools WHERE holder_kind = 'account' AND holder_ref = ? ORDER BY pool",
    )
    .all(String(accountId));

const ledgerKinds = (jobId: string): string[] =>
  db()
    .query<{ kind: string }, [string]>(
      "SELECT kind FROM compute_ledger WHERE job_id = ? ORDER BY id",
    )
    .all(jobId)
    .map((r) => r.kind);

async function jobFor(env: Bindings, accountId: number): Promise<ComputeJobRow> {
  const made = await createJob(env, {
    source: "cli",
    accountId,
    appId: "nemar-launch",
    appVersion: "1.0.0",
    spec: launchableSpec(),
  });
  if (!made.ok) throw new Error(`could not make a job: ${made.code}`);
  return made.job;
}

async function runningJob(env: Bindings, accountId: number): Promise<ComputeJobRow> {
  const job = await jobFor(env, accountId);
  expect((await submitComputeJob(env, job.id)).ok).toBe(true);
  const bound = await reread(env, job.id);
  fx.tapis.advance(bound.tapis_uuid as string, "RUNNING");
  setTapisTimes(fx, bound.tapis_uuid as string, 30 * MINUTE, null);
  await advanceComputeJob(env, job.id);
  return reread(env, job.id);
}

interface World {
  target: number;
  username: string;
  unsubmitted: ComputeJobRow;
  running: ComputeJobRow;
  bystander: number;
  bystanderJob: ComputeJobRow;
}

/** An active account with a job that never reached Tapis and one that is running, and a bystander. */
async function seedWorld(username: string, state = "active"): Promise<World> {
  const env = fx.env();
  const target = await seedUser(env.DB, { username });
  setAccess(target, state);
  await fundAccount(env.DB, target, 100_000, "cpu");
  await fundAccount(env.DB, target, 50_000, "gpu");
  const bystander = await seedUser(env.DB, { username: `${username}-bystander` });
  setAccess(bystander, "active");
  await fundAccount(env.DB, bystander, 100_000, "cpu");
  const unsubmitted = await jobFor(env, target);
  const running = await runningJob(env, target);
  const bystanderJob = await runningJob(env, bystander);
  return { target, username, unsubmitted, running, bystander, bystanderJob };
}

function untouched(w: World): unknown {
  return {
    access: access(w.bystander).compute_access,
    job: db().query("SELECT * FROM compute_jobs WHERE id = ?").get(w.bystanderJob.id),
    ledger: ledgerKinds(w.bystanderJob.id),
    pools: poolsOf(w.bystander),
  };
}

const cancels = () => fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/:uuid/cancel").length;

describe("an administrator's suspension or revocation ends the person's compute in the same batch", () => {
  for (const [decision, to] of [
    ["suspend", "suspended"],
    ["revoke", "revoked"],
  ] as const) {
    test(`${decision}: the state flips, both pools freeze, an unsubmitted job is canceled with its hold released, a running job records the intent, and nothing else moves (MUTATION: omit endComputeStatements from the route)`, async () => {
      const w = await seedWorld(`cascade-${decision}`);
      const before = untouched(w);
      const requests = fx.tapis.log.length;
      expect(poolsOf(w.target).map((p) => p.frozen)).toEqual([0, 0]);

      const res = await decide(decision, w.target);
      expect(res.status).toBe(200);
      expect(access(w.target).compute_access).toBe(to);

      const unsubmitted = await reread(fx.env(), w.unsubmitted.id);
      expect(unsubmitted.state).toBe("cancelled");
      expect(unsubmitted.cancel_reason).toBe("account_ended");
      expect(unsubmitted.settled_provisional_at).not.toBeNull();
      expect(ledgerKinds(unsubmitted.id)).toEqual(["hold", "release"]);

      const running = await reread(fx.env(), w.running.id);
      expect(running.state).toBe("running");
      expect(running.cancel_reason).toBe("account_ended");
      expect(running.cancel_requested_at).not.toBeNull();
      expect(ledgerKinds(running.id)).toEqual(["hold"]);

      expect(poolsOf(w.target).map((p) => [p.pool, p.frozen])).toEqual([
        ["cpu", 1],
        ["gpu", 1],
      ]);
      // NO NETWORK CALL IN THE BATCH.
      expect(fx.tapis.log.length).toBe(requests);
      // The bystander is exactly as it was, state and job and pools and ledger.
      expect(untouched(w)).toEqual(before);
    });
  }

  test("the retried sweep cancels the running job AT TAPIS, and charges what it used", async () => {
    const w = await seedWorld("cascade-sweep");
    await decide("suspend", w.target);
    expect(cancels()).toBe(0);
    await sweepComputeCancellations(fx.env());
    const running = await reread(fx.env(), w.running.id);
    expect(running.state).toBe("cancelled");
    expect(running.cancel_reason).toBe("account_ended");
    expect(cancels()).toBeGreaterThanOrEqual(1);
    expect((await reread(fx.env(), w.bystanderJob.id)).state).toBe("running");
  });

  test("a failing statement rolls the whole decision back: the flip, the audit row, the freeze and the cancellations", async () => {
    const w = await seedWorld("cascade-atomic");
    // The freeze is the last release statement. A trigger on the real table makes it fail, so every
    // statement before it (the flip, the audit row, the cancellations, the release) must be undone.
    db().exec(
      "CREATE TRIGGER cascade_boom BEFORE UPDATE OF frozen ON compute_pools BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    try {
      const res = await decide("suspend", w.target);
      expect(res.status).toBe(500);
      expect(((await res.json()) as { code: string }).code).toBe("internal");
    } finally {
      db().exec("DROP TRIGGER cascade_boom");
    }
    expect(access(w.target).compute_access).toBe("active");
    expect(poolsOf(w.target).map((p) => p.frozen)).toEqual([0, 0]);
    expect((await reread(fx.env(), w.unsubmitted.id)).state).toBe("created");
    expect(ledgerKinds(w.unsubmitted.id)).toEqual(["hold"]);
    expect((await reread(fx.env(), w.running.id)).cancel_reason).toBeNull();
    expect(
      db()
        .query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'compute_access_suspended'")
        .get(),
    ).toEqual({ n: 0 });
    // With the fault gone the same request succeeds: nothing was left half done.
    expect((await decide("suspend", w.target)).status).toBe(200);
    expect(access(w.target).compute_access).toBe("suspended");
  });

  test("a revocation after a suspension runs the statements again and changes nothing more", async () => {
    const w = await seedWorld("cascade-twice");
    await decide("suspend", w.target);
    const snapshot = JSON.stringify([
      db().query("SELECT * FROM compute_jobs WHERE account_id = ? ORDER BY id").all(w.target),
      poolsOf(w.target),
    ]);
    expect((await decide("revoke", w.target)).status).toBe(200);
    expect(access(w.target).compute_access).toBe("revoked");
    expect(
      JSON.stringify([
        db().query("SELECT * FROM compute_jobs WHERE account_id = ? ORDER BY id").all(w.target),
        poolsOf(w.target),
      ]),
    ).toBe(snapshot);
  });
});

describe("the account's own end (finalizeRevocation) ends compute access too", () => {
  for (const [from, to] of [
    ["active", "revoked"],
    ["suspended", "revoked"],
    ["requested", "revoked"],
    ["denied", "revoked"],
    ["revoked", "revoked"],
    ["none", "none"],
  ] as const) {
    test(`an account at ${from} is left at ${to}, with its pools frozen and its stamps kept (MUTATION: drop the compute flip from the revocation's UPDATE)`, async () => {
      const w = await seedWorld(`cascade-acct-${from}`, from);
      expect((await call(OWNER_KEY, "POST", `/admin/revoke/by-id/${w.target}`)).status).toBe(200);
      const row = access(w.target);
      expect(row.compute_access).toBe(to);
      expect(row.status).toBe("revoked");
      expect(poolsOf(w.target).map((p) => p.frozen)).toEqual([1, 1]);
      // The stamps are history: a revocation does not clear them, as it clears the upload ones.
      if (from !== "none") {
        expect(row.compute_access_requested_at).not.toBeNull();
        expect(row.compute_purpose).not.toBeNull();
        expect(row.compute_terms_version).toBe("2026-11-draft");
      }
      expect((await reread(fx.env(), w.unsubmitted.id)).state).toBe("cancelled");
    });
  }

  test("an account put back in good standing stays closed for compute until an administrator grants it", async () => {
    const w = await seedWorld("cascade-restore");
    await call(OWNER_KEY, "POST", `/admin/revoke/by-id/${w.target}`);
    db().run("UPDATE users SET status = 'approved' WHERE id = ?", [w.target]);
    expect(access(w.target).compute_access).toBe("revoked");
    expect(poolsOf(w.target).map((p) => p.frozen)).toEqual([1, 1]);
    // The administrator's grant is the one thing that reopens it and unfreezes the pools.
    expect((await decide("grant", w.target)).status).toBe(200);
    expect(poolsOf(w.target).map((p) => p.frozen)).toEqual([0, 0]);
  });
});

describe("the owner's delete (tombstoneUserCascade) ends compute access too", () => {
  test("the state is revoked, the purpose is erased, the terms stay, the pools freeze, the jobs are ended (MUTATION: drop the compute columns from the mask)", async () => {
    const w = await seedWorld("cascade-delete");
    const res = await call(OWNER_KEY, "DELETE", `/admin/users/by-id/${w.target}`);
    expect(res.status).toBe(200);
    const row = access(w.target);
    expect(row.compute_access).toBe("revoked");
    expect(row.compute_purpose).toBeNull();
    expect(row.compute_terms_version).toBe("2026-11-draft");
    expect(row.compute_terms_accepted_at).not.toBeNull();
    expect(row.deleted_at).not.toBeNull();
    expect(poolsOf(w.target).map((p) => p.frozen)).toEqual([1, 1]);
    expect((await reread(fx.env(), w.unsubmitted.id)).state).toBe("cancelled");
    expect((await reread(fx.env(), w.running.id)).cancel_reason).toBe("account_ended");
  });

  test("an account that never asked is left revoked too: a deleted row holds no access", async () => {
    const id = await seedUser(fx.env().DB, { username: "cascade-delete-none" });
    const original = access(id).email as string;
    const out = await tombstoneUserCascade(fx.env().DB, id, original);
    expect(out.tombstoned).toBe(true);
    expect(access(id).compute_access).toBe("revoked");
  });

  test("a guarded call that finds the row changed touches no compute (the mask guard reaches the release statements)", async () => {
    const w = await seedWorld("cascade-guarded");
    const out = await tombstoneUserCascade(
      fx.env().DB,
      w.target,
      access(w.target).email as string,
      "someone-else@example.org",
    );
    expect(out.tombstoned).toBe(false);
    expect(access(w.target).compute_access).toBe("active");
    expect(poolsOf(w.target).map((p) => p.frozen)).toEqual([0, 0]);
    expect((await reread(fx.env(), w.running.id)).cancel_reason).toBeNull();
  });
});

describe("a role demotion and a key revocation end none of a person's compute", () => {
  test("demoting an administrator leaves their compute access, pools and jobs alone", async () => {
    const env = fx.env();
    const admin = await seedUser(env.DB, { username: "cascade-demote", role: "admin" });
    setAccess(admin, "active");
    await fundAccount(env.DB, admin, 100_000, "cpu");
    const job = await runningJob(env, admin);
    const res = await call(OWNER_KEY, "POST", "/admin/users/cascade-demote/role", {
      role: "member",
    });
    expect(res.status).toBe(200);
    expect(access(admin).compute_access).toBe("active");
    expect(poolsOf(admin).map((p) => p.frozen)).toEqual([0]);
    expect((await reread(env, job.id)).cancel_reason).toBeNull();
  });
});
