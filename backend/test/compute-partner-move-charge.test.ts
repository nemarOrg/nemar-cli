/**
 * Moving the charge of a job that skipped the reservation (epic #2021 phase D4, #2025; ADR 0118, the
 * amendment of this phase and item 1 of the A7 amendment): `POST /admin/compute/jobs/:id/move-charge`, the
 * ledger operation the tenant sweep promised. Through the REAL Worker and its real owner authentication, over
 * a charge the REAL tenant sweep wrote (a Tapis job the partner launched with no reservation, cancelled and
 * charged to the partner's pool).
 *
 * THE ACCOUNTING, pinned here. The unreserved entry counted the consumption against the `people` budget
 * when it was written. The move lowers the partner's pool and raises the person's by the same figure and
 * names the budget on NEITHER side: naming it on the person's side (as `adjustPool` does for a raise, which
 * there is new consumption) would count this consumption twice. The invariants, each asserted:
 *  - the two pools move by the same figure, and no stored total is negative;
 *  - the people budget is counted ONCE (its charged total is the same before and after);
 *  - the pair is ONE batch: a refusal writes nothing, and a failure of the second half leaves nothing of
 *    the first;
 *  - a repeat of the same move is a replay; another account is `already_moved`;
 *  - refused when the job was reserved, when it has no unreserved charge, when it is not over, for an
 *    account that is deleted, not in good standing or absent or without a pool of the word;
 *  - owner only (an administrator is `owner_only`); audited with the fixed reason word `charge_moved`.
 *
 * MUTATIONS (each applied, run, restored): name the budget on the person's side; drop `flag_unreserved = 1`
 * from the first statement; drop the second half's `EXISTS` of the first; drop the target's status term.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sweepTenantJobs } from "../src/services/compute-tenant-sweep";
import { moveCharge } from "../src/services/compute-ledger";
import { ADMIN_KEY } from "./helpers/oidc-harness";
import { hashApiKey } from "../src/services/token";
import { totalsDisagreements } from "./helpers/compute-ledger";
import {
  MINUTE,
  type LifecycleFixture,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { fundAccount, seedUser } from "./helpers/compute-seed";
import {
  type PartnerWorld,
  buildPartnerWorld,
  entries,
  newPartnerPerson,
  partnerLaunch,
  poolOf,
  reserve,
  row,
} from "./helpers/compute-partner-world";
import { OWNER_KEY } from "./helpers/oidc-harness";

let fx: LifecycleFixture;
let w: PartnerWorld;

beforeAll(async () => {
  fx = await startLifecycleFixture();
}, 60_000);
afterAll(async () => {
  await fx?.dispose();
}, 30_000);
beforeEach(async () => {
  await fx.reset();
  w = await buildPartnerWorld(fx);
}, 60_000);

/** A Tapis job nobody reserved, run for 30 minutes on four cores (2 SU), swept: cancelled and charged to the tenant pool. */
async function unreservedJob(): Promise<string> {
  const uuid = await partnerLaunch(w, null, null, { owner: "stranger-1", tags: [] });
  fx.tapis.advance(uuid, "QUEUED");
  fx.tapis.advance(uuid, "RUNNING");
  setTapisTimes(fx, uuid, 30 * MINUTE, null);
  await sweepTenantJobs(fx.env(), "live");
  const found = w.h.db.query("SELECT id FROM compute_jobs WHERE tapis_uuid = ?").get(uuid) as {
    id: string;
  };
  return found.id;
}

const move = (jobId: string, to: unknown, key: string | null = OWNER_KEY) =>
  w.h.call("POST", `/admin/compute/jobs/${jobId}/move-charge`, {
    key,
    body: { to_account_id: to },
  });

const count = (table: string) =>
  (w.h.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const people = () => poolOf(w, "platform", "people") as Record<string, number>;
const tenant = () =>
  (poolOf(w, "partner", "tenant") ?? { charged_milli: 0 }) as Record<string, number>;

describe("the move", () => {
  test("lowers the partner's pool and raises the person's by the same figure, and counts the people budget once", async () => {
    const job = await unreservedJob();
    const person = await newPartnerPerson(w, { grant: 50_000 });
    const charged = tenant().charged_milli as number;
    expect(charged).toBeGreaterThanOrEqual(2000);
    const budgetBefore = people().charged_milli as number;
    expect(budgetBefore).toBe(charged);

    const res = await move(job, person.id);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      job_id: job,
      to_account_id: person.id,
      pool: "cpu",
      moved_milli: charged,
      replayed: false,
    });
    expect(tenant().charged_milli).toBe(0);
    expect((poolOf(w, "account", String(person.id)) as Record<string, number>).charged_milli).toBe(
      charged,
    );
    // Counted once: the budget's consumption is what the unreserved entry made it, not twice that.
    expect(people().charged_milli).toBe(budgetBefore);
    expect(await totalsDisagreements(w.env().DB)).toEqual([]);

    // Two adjustments, no job, no budget on either side, the fixed reason word, the owner as actor.
    const moves = w.h.db
      .query("SELECT * FROM compute_ledger WHERE idempotency_key LIKE 'move:%' ORDER BY id")
      .all() as Array<Record<string, any>>;
    expect(moves.map((e) => [e.kind, e.charged_delta_milli, e.budget_pool_id, e.job_id, e.reason])).toEqual([
      ["adjust", -charged, null, null, "charge_moved"],
      ["adjust", charged, null, null, "charge_moved"],
    ]);
    expect(moves.map((e) => e.idempotency_key)).toEqual([`move:${job}:out`, `move:${job}:in`]);
    expect(moves.every((e) => e.actor_user_id === fx.ownerId)).toBe(true);
    // The audit row says what moved, with fixed words and numbers.
    const audit = w.h.db
      .query("SELECT user_id, details FROM audit_log WHERE action = 'compute.charge.move'")
      .all() as Array<{ user_id: number; details: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.user_id).toBe(fx.ownerId);
    expect(JSON.parse(audit[0]?.details as string)).toEqual({
      to_account: person.id,
      pool: "cpu",
      moved_milli: charged,
      reason: "charge_moved",
    });
  });

  test("a repeat is a replay and writes nothing; another account is already_moved and writes nothing", async () => {
    const job = await unreservedJob();
    const a = await newPartnerPerson(w);
    const b = await newPartnerPerson(w);
    expect((await move(job, a.id)).status).toBe(200);
    const before = [count("compute_ledger"), count("audit_log")];
    const again = await move(job, a.id);
    expect(again.status).toBe(200);
    expect(again.json?.replayed).toBe(true);
    const other = await move(job, b.id);
    expect([other.status, other.json?.code]).toEqual([409, "already_moved"]);
    expect([count("compute_ledger"), count("audit_log")]).toEqual(before);
  });

  test("the person's available may go negative: it is a fact that already happened", async () => {
    const job = await unreservedJob();
    const person = await newPartnerPerson(w, { grant: 500 });
    expect((await move(job, person.id)).status).toBe(200);
    const pool = poolOf(w, "account", String(person.id)) as Record<string, number>;
    expect(pool.granted_milli - pool.held_milli - pool.charged_milli).toBeLessThan(0);
  });
});

describe("what it refuses, and writes nothing for", () => {
  const unchanged = async (run: () => Promise<unknown>) => {
    const before = [count("compute_ledger"), count("audit_log"), tenant().charged_milli, people().charged_milli];
    await run();
    expect([count("compute_ledger"), count("audit_log"), tenant().charged_milli, people().charged_milli]).toEqual(before);
  };

  test("a job that was RESERVED is job_reserved, however clear whose it is", async () => {
    await unreservedJob(); // so the tenant pool exists
    const person = await newPartnerPerson(w);
    const hold = await reserve(w, person);
    await unchanged(async () => {
      const res = await move(hold.job_id, person.id);
      expect([res.status, res.json?.code]).toEqual([409, "job_reserved"]);
    });
  });

  test("a job that is reserved is refused even when an unreserved entry exists for it (the flag is its own term)", async () => {
    // The state a bug would make: the job reads as reserved while the ledger holds an unreserved entry
    // under its key. The move reads the job, not only the entry, so it still moves nothing.
    const job = await unreservedJob();
    const person = await newPartnerPerson(w);
    w.h.db.query("UPDATE compute_jobs SET flag_unreserved = 0 WHERE id = ?").run(job);
    await unchanged(async () => {
      const res = await move(job, person.id);
      expect([res.status, res.json?.code]).toEqual([409, "job_reserved"]);
    });
  });

  test("a job with no unreserved charge, and an unknown job, are refused", async () => {
    const person = await newPartnerPerson(w);
    // A swept job whose charge is 0 (it never ran): nothing to move.
    const uuid = await partnerLaunch(w, null, null, { owner: "stranger-2", tags: [] });
    await sweepTenantJobs(fx.env(), "live");
    const swept = w.h.db.query("SELECT id FROM compute_jobs WHERE tapis_uuid = ?").get(uuid) as {
      id: string;
    };
    await unchanged(async () => {
      const none = await move(swept.id, person.id);
      expect([none.status, none.json?.code]).toEqual([409, "no_unreserved_charge"]);
      const absent = await move("job_00000000000000000000beef", person.id);
      expect([absent.status, absent.json?.code]).toEqual([404, "job_not_found"]);
      const bad = await move("not-a-job", person.id);
      expect([bad.status, bad.json?.code]).toEqual([404, "job_not_found"]);
    });
  });

  test("an account that is deleted, not in good standing, absent or without a pool", async () => {
    const job = await unreservedJob();
    const deleted = await seedUser(w.env().DB, { deleted_at: "2026-01-01 00:00:00" });
    await fundAccount(w.env().DB, deleted, 10_000);
    const pending = await seedUser(w.env().DB, { status: "pending" });
    await fundAccount(w.env().DB, pending, 10_000);
    const revoked = await seedUser(w.env().DB, { status: "revoked" });
    await fundAccount(w.env().DB, revoked, 10_000);
    const poolless = await seedUser(w.env().DB, {});
    await unchanged(async () => {
      for (const id of [deleted, pending, revoked]) {
        const res = await move(job, id);
        expect([id, res.status, res.json?.code]).toEqual([id, 409, "target_not_in_good_standing"]);
      }
      const none = await move(job, poolless);
      expect([none.status, none.json?.code]).toEqual([409, "target_has_no_pool"]);
      const absent = await move(job, 987_654);
      expect([absent.status, absent.json?.code]).toEqual([404, "account_not_found"]);
    });
  });

  test("a job that is still live is not final, so its charge is not moved", async () => {
    const job = await unreservedJob();
    const person = await newPartnerPerson(w);
    w.h.db.query("UPDATE compute_jobs SET state = 'running' WHERE id = ?").run(job);
    await unchanged(async () => {
      const res = await move(job, person.id);
      expect([res.status, res.json?.code]).toEqual([409, "no_unreserved_charge"]);
    });
  });

  test("a person whose pool would pass the largest total is would_exceed_limit", async () => {
    const job = await unreservedJob();
    const person = await newPartnerPerson(w);
    // Not reachable through the ledger (a stored total never passes 2^53 - 1); set directly to prove the term.
    w.h.db.exec("DROP TRIGGER compute_pools_identity_fixed");
    w.h.db
      .query("UPDATE compute_pools SET charged_milli = 9007199254740000 WHERE holder_ref = ?")
      .run(String(person.id));
    await unchanged(async () => {
      const res = await move(job, person.id);
      expect([res.status, res.json?.code]).toEqual([409, "would_exceed_limit"]);
    });
  });

  test("owner only: an administrator and a person are refused before the body is read", async () => {
    const job = await unreservedJob();
    const person = await newPartnerPerson(w);
    w.h.db.query("INSERT INTO users (username, email, password_hash, status, role, email_verified) VALUES ('mvadmin', 'mvadmin@example.org', 'x', 'approved', 'admin', 1)").run();
    const adminId = (w.h.db.query("SELECT id FROM users WHERE username = 'mvadmin'").get() as { id: number }).id;
    w.h.db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(adminId, await hashApiKey(ADMIN_KEY), ADMIN_KEY.slice(0, 8));
    await unchanged(async () => {
      const admin = await move(job, person.id, ADMIN_KEY);
      expect([admin.status, admin.json?.code]).toEqual([403, "owner_only"]);
      const nobody = await move(job, person.id, null);
      expect(nobody.status).toBe(401);
    });
  });

  test("a body that is not exactly { to_account_id } is refused", async () => {
    const job = await unreservedJob();
    for (const body of [{}, { to_account_id: "5" }, { to_account_id: 1.5 }, { to_account_id: 0 }, { to_account_id: 2, extra: 1 }]) {
      const res = await w.h.call("POST", `/admin/compute/jobs/${job}/move-charge`, {
        key: OWNER_KEY,
        body,
      });
      expect([JSON.stringify(body), res.status, res.json?.code]).toEqual([JSON.stringify(body), 400, "invalid_body"]);
    }
  });
});

describe("the pair is one batch", () => {
  test("a failure of the second half leaves nothing of the first (the whole batch is one transaction)", async () => {
    const job = await unreservedJob();
    const person = await newPartnerPerson(w);
    const tenantBefore = tenant().charged_milli;
    w.h.db.exec(`CREATE TRIGGER test_refuse_move_in BEFORE INSERT ON compute_ledger
      WHEN NEW.idempotency_key LIKE 'move:%:in' BEGIN SELECT RAISE(ABORT, 'test: the second half refused'); END;`);
    await expect(
      moveCharge(w.env().DB, { jobId: job, toAccountId: person.id, actorUserId: fx.ownerId }),
    ).rejects.toThrow();
    w.h.db.exec("DROP TRIGGER test_refuse_move_in");
    expect(count("compute_ledger") - entries(w, job).length).toBeGreaterThan(0);
    expect(w.h.db.query("SELECT COUNT(*) AS n FROM compute_ledger WHERE idempotency_key LIKE 'move:%'").get()).toEqual({ n: 0 });
    expect(tenant().charged_milli).toBe(tenantBefore);
    expect(row(w, job).account_id).toBeNull();
    expect(await totalsDisagreements(w.env().DB)).toEqual([]);
    // And the move still works afterwards: nothing was left half done.
    expect((await move(job, person.id)).status).toBe(200);
  });
});
