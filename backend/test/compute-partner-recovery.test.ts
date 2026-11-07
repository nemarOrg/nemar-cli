/**
 * What survives the recovery of a job refused as `unverifiable` (epic #2021, the epic-level review of
 * phase D4; ADR 0118 items 34 to 38), through the REAL Worker, the real lifecycle fixture, the Tapis
 * stand-in and Miniflare's R2.
 *
 *  C1. A refusal records NO cancel intent of its own (`partner_refused_at` is its clock), so a cancel a
 *      person, an administrator or the end of an account records AFTER it can never be mistaken for the
 *      refusal's and cleared by the recovery: the job stays refused and is ended, charged to the partner.
 *      A recovery also needs the person's compute `active` in its own statement.
 *  I1. A report that triggers the recovery is answered 200 verified, not the stale refusal.
 *  M1. The failed-read counters do not carry over between bindings.
 *  M2. A blind cancel is stamped BEFORE it is sent and a recovery needs the stamp NULL; the request path
 *      sends no blind cancel.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { reapExpiredHolds } from "../src/services/compute-hold-reaper";
import { requestComputeCancel } from "../src/services/compute-lifecycle";
import { TICK_READ } from "../src/services/compute-lifecycle";
import { computeReleaseStatements } from "../src/services/compute-release";
import { UNBIND_SQL, finishMismatch, verifyBoundJob } from "../src/services/compute-report-verify";
import {
  type LifecycleFixture,
  MINUTE,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import {
  type Hold,
  type PartnerPerson,
  type PartnerWorld,
  buildPartnerWorld,
  entries,
  newPartnerPerson,
  partnerCall,
  partnerLaunch,
  poolOf,
  raceAfterRead,
  reserve,
  row,
} from "./helpers/compute-partner-world";

let fx: LifecycleFixture;
let w: PartnerWorld;
let person: PartnerPerson;

beforeAll(async () => {
  fx = await startLifecycleFixture();
}, 60_000);
afterAll(async () => {
  await fx?.dispose();
}, 30_000);
beforeEach(async () => {
  await fx.reset();
  w = await buildPartnerWorld(fx);
  person = await newPartnerPerson(w);
}, 60_000);

const report = (hold: Hold, uuid: string, key?: string) =>
  partnerCall(w, "POST", `/compute/jobs/${hold.job_id}/report`, {
    token: person.token,
    json: { tapis_job_id: uuid },
    key,
  });
const cancels = () =>
  fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/:uuid/cancel" && r.status < 400);
const tenant = () => poolOf(w, "partner", "tenant") as Record<string, number> | null;
const kinds = (id: string) => entries(w, id).map((e) => e.kind);

/** A matching job reported during an outage, unreadable for hours, refused as unverifiable, its cancel not taken. */
async function stuckUnverifiable() {
  const hold = await reserve(w, person);
  const uuid = await partnerLaunch(w, hold, person);
  fx.tapis.advance(uuid, "QUEUED");
  fx.tapis.advance(uuid, "RUNNING");
  setTapisTimes(fx, uuid, 30 * MINUTE, null);
  fx.tapis.down();
  expect((await report(hold, uuid)).status).toBe(202);
  fx.tapis.up();
  fx.tapis.fail("GET /v3/jobs/:uuid", 403, 1000);
  fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 500, 1000);
  await reapExpiredHolds(fx.env());
  w.h.db
    .query(
      "UPDATE compute_jobs SET partner_first_failed_at = datetime('now', '-130 minutes') WHERE id = ?",
    )
    .run(hold.job_id);
  await reapExpiredHolds(fx.env());
  await reapExpiredHolds(fx.env());
  expect(row(w, hold.job_id)).toMatchObject({
    partner_state: "mismatch",
    partner_flag: "unverifiable",
    state: "created",
  });
  return { hold, uuid };
}

/** The refusal as unverifiable is on the record and the tick stopped before the blind cancel: no cancel is on the wire. */
async function refusedBeforeCancel() {
  const hold = await reserve(w, person);
  const uuid = await partnerLaunch(w, hold, person);
  fx.tapis.advance(uuid, "QUEUED");
  fx.tapis.advance(uuid, "RUNNING");
  setTapisTimes(fx, uuid, 30 * MINUTE, null);
  fx.tapis.down();
  expect((await report(hold, uuid)).status).toBe(202);
  fx.tapis.up();
  fx.tapis.fail("GET /v3/jobs/:uuid", 403, 1000);
  w.h.db
    .query(
      "UPDATE compute_jobs SET partner_read_failures = 2, partner_first_failed_at = datetime('now', '-130 minutes') WHERE id = ?",
    )
    .run(hold.job_id);
  const out = await verifyBoundJob(fx.env(), hold.job_id, { read: TICK_READ, tick: true });
  expect(out.kind).toBe("mismatch");
  expect(row(w, hold.job_id)).toMatchObject({
    partner_state: "mismatch",
    partner_flag: "unverifiable",
    state: "created",
    partner_cancel_sent_at: null,
  });
  return { hold, uuid };
}

/** The job stays refused: ended, cancelled at Tapis, the hold released, the use the partner's. */
function expectEndedRefused(hold: Hold, uuid: string, reason: string) {
  const after = row(w, hold.job_id);
  expect(after).toMatchObject({
    state: "cancelled",
    partner_state: "mismatch",
    cancel_reason: reason,
  });
  expect(after.cancel_requested_at).not.toBeNull();
  expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
  expect(kinds(hold.job_id)).toEqual(["hold", "release", "overrun"]);
  expect(tenant()?.charged_milli).toBeGreaterThan(0);
}

describe("a refusal records no cancel intent of its own (C1)", () => {
  test("the refusal leaves cancel_requested_at and cancel_reason empty, and counts its own clock", async () => {
    const { hold } = await refusedBeforeCancel();
    const r = row(w, hold.job_id);
    expect([r.cancel_requested_at, r.cancel_reason]).toEqual([null, null]);
    expect(r.partner_refused_at).not.toBeNull();
  });

  test("a person's cancel recorded after a refusal whose blind cancel is on the wire is ended as well", async () => {
    const { hold, uuid } = await stuckUnverifiable();
    expect((await requestComputeCancel(fx.env(), hold.job_id, "user")).ok).toBe(true);
    fx.tapis.clearFailures();
    expect(await reapExpiredHolds(fx.env())).toMatchObject({ recovered: 0, ended: 1 });
    expectEndedRefused(hold, uuid, "user");
  });

  test("a person's cancel recorded AFTER the refusal survives the recovery: the job stays refused and is ended", async () => {
    const { hold, uuid } = await refusedBeforeCancel();
    const res = await requestComputeCancel(fx.env(), hold.job_id, "user");
    expect(res.ok).toBe(true);
    fx.tapis.clearFailures();
    const tick = await reapExpiredHolds(fx.env());
    expect(tick).toMatchObject({ recovered: 0, ended: 1 });
    expectEndedRefused(hold, uuid, "user");
    expect(own()).toMatchObject({ held_milli: 0, charged_milli: 0 });
  });

  for (const status of ["suspended", "revoked"] as const) {
    test(`the cascade of an account ${status} AFTER the refusal survives the recovery`, async () => {
      const { hold, uuid } = await refusedBeforeCancel();
      await fx.env().DB.batch(
        computeReleaseStatements(person.id).map((s) =>
          fx
            .env()
            .DB.prepare(s.sql)
            .bind(...s.binds),
        ),
      );
      w.h.db.query("UPDATE users SET compute_access = ? WHERE id = ?").run(status, person.id);
      fx.tapis.clearFailures();
      const tick = await reapExpiredHolds(fx.env());
      expect(tick).toMatchObject({ recovered: 0, ended: 1 });
      expectEndedRefused(hold, uuid, "account_ended");
    });
  }

  test("a deleted account's cascade survives the recovery", async () => {
    const { hold, uuid } = await refusedBeforeCancel();
    await fx.env().DB.batch(
      computeReleaseStatements(person.id).map((s) =>
        fx
          .env()
          .DB.prepare(s.sql)
          .bind(...s.binds),
      ),
    );
    w.h.db.query("UPDATE users SET deleted_at = datetime('now') WHERE id = ?").run(person.id);
    fx.tapis.clearFailures();
    expect(await reapExpiredHolds(fx.env())).toMatchObject({ recovered: 0 });
    expectEndedRefused(hold, uuid, "account_ended");
  });

  test("a person whose compute ended with NO cascade recorded cannot be recovered into a live job (the statement re-checks standing)", async () => {
    const { hold, uuid } = await refusedBeforeCancel();
    w.h.db.query("UPDATE users SET compute_access = 'revoked' WHERE id = ?").run(person.id);
    fx.tapis.clearFailures();
    const tick = await reapExpiredHolds(fx.env());
    expect(tick).toMatchObject({ recovered: 0, ended: 1 });
    expect(row(w, hold.job_id).state).toBe("cancelled");
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
  });

  test("an unbound refusal does not clear a later cancel: UNBIND, then the person's cancel, then a re-bind is refused", async () => {
    const hold = await reserve(w, person);
    const first = await partnerLaunch(w, hold, person);
    fx.tapis.down();
    expect((await report(hold, first)).status).toBe(202);
    fx.tapis.up();
    // NEMAR withdraws the binding (the job turned out to be its own), then the person cancels.
    await w.env().DB.prepare(UNBIND_SQL).bind(hold.job_id, first, "tapis_job_in_use").run();
    expect(row(w, hold.job_id)).toMatchObject({ tapis_uuid: null, partner_state: null });
    expect((await requestComputeCancel(fx.env(), hold.job_id, "user")).ok).toBe(true);
    const second = await partnerLaunch(w, hold, person);
    const again = await report(hold, second);
    expect([again.status, again.json?.code]).toEqual([409, "hold_cancelled"]);
    expect(row(w, hold.job_id)).toMatchObject({ tapis_uuid: null, cancel_reason: "user" });
  });
});

/** A matching job reported during an outage: bound `pending`, Tapis up again. */
async function pendingJob() {
  const hold = await reserve(w, person);
  const uuid = await partnerLaunch(w, hold, person);
  fx.tapis.advance(uuid, "QUEUED");
  fx.tapis.advance(uuid, "RUNNING");
  setTapisTimes(fx, uuid, 30 * MINUTE, null);
  fx.tapis.down();
  expect((await report(hold, uuid)).status).toBe(202);
  fx.tapis.up();
  return { hold, uuid };
}

describe("the person is told NEMAR is cancelling a refused job (minor 8)", () => {
  async function personKey() {
    const { hashApiKey } = await import("../src/services/token");
    const key = `${"nemar"}_${"v".repeat(8)}${"0123456789abcdef".repeat(2)}`;
    w.h.db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(person.id, await hashApiKey(key), key.slice(0, 8));
    return key;
  }

  test("cancel_requested reads true while a refused job is not yet ended, and the admin view agrees; once ended it reads as the row says", async () => {
    const { jobView } = await import("../src/services/compute-lifecycle");
    const { getJob } = await import("../src/services/compute-jobs");
    const key = await personKey();
    const { hold } = await refusedBeforeCancel();
    const before = await w.h.call("GET", `/compute/me/jobs/${hold.job_id}`, { key });
    expect([before.status, before.json?.job?.cancel_requested]).toEqual([200, true]);
    const admin = jobView((await getJob(fx.env().DB, hold.job_id)) as never);
    expect(admin.cancel_requested).toBe(true);
    // The cancel completes: the job has ended.
    fx.tapis.clearFailures();
    fx.tapis.fail("GET /v3/jobs/:uuid", 403, 1000);
    await reapExpiredHolds(fx.env());
    const after = await w.h.call("GET", `/compute/me/jobs/${hold.job_id}`, { key });
    expect(after.json?.job).toMatchObject({ state: "cancelled", cancel_requested: false });
  });

  test("a reservation that was never refused reads false", async () => {
    const key = await personKey();
    const hold = await reserve(w, person);
    const res = await w.h.call("GET", `/compute/me/jobs/${hold.job_id}`, { key });
    expect(res.json?.job?.cancel_requested).toBe(false);
  });
});

describe("a pending job the person cancelled is not verified into a live one (M-a)", () => {
  function expectRefusedAndStopped(hold: Hold, uuid: string, reason: string) {
    expect(row(w, hold.job_id)).toMatchObject({
      state: "cancelled",
      partner_state: "mismatch",
      partner_flag: "hold_ended",
      cancel_reason: reason,
    });
    // The Tapis job was actually cancelled, the hold released, the use the partner's; the person pays nothing.
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
    expect(kinds(hold.job_id)).toEqual(["hold", "release", "overrun"]);
    expect(own()).toMatchObject({ held_milli: 0, charged_milli: 0 });
    expect(tenant()?.charged_milli).toBeGreaterThan(0);
  }

  test("the person cancels while it is pending: the tick refuses it as hold_ended and cancels it at Tapis", async () => {
    const { hold, uuid } = await pendingJob();
    expect((await requestComputeCancel(fx.env(), hold.job_id, "user")).ok).toBe(true);
    expect(cancels()).toHaveLength(0);
    const tick = await reapExpiredHolds(fx.env());
    expect(tick).toMatchObject({ verified: 0, refused: 1, ended: 1 });
    expectRefusedAndStopped(hold, uuid, "user");
  });

  test("an account suspended and granted again before the tick: the cascade's cancel stands", async () => {
    const { hold, uuid } = await pendingJob();
    await fx.env().DB.batch(
      computeReleaseStatements(person.id).map((s) =>
        fx
          .env()
          .DB.prepare(s.sql)
          .bind(...s.binds),
      ),
    );
    // Granted again: the person is `active` once more when the tick reads the job.
    w.h.db.query("UPDATE users SET compute_access = 'active' WHERE id = ?").run(person.id);
    const tick = await reapExpiredHolds(fx.env());
    expect(tick).toMatchObject({ verified: 0, refused: 1, ended: 1 });
    expectRefusedAndStopped(hold, uuid, "account_ended");
  });

  test("the report that finds a cancel recorded is told hold_cancelled and the job is stopped", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    fx.tapis.advance(uuid, "QUEUED");
    fx.tapis.advance(uuid, "RUNNING");
    setTapisTimes(fx, uuid, 30 * MINUTE, null);
    const cancel = async () => {
      w.h.db
        .query(
          "UPDATE compute_jobs SET cancel_requested_at = datetime('now'), cancel_reason = 'user' WHERE id = ?",
        )
        .run(hold.job_id);
    };
    const res = await partnerCall(w, "POST", `/compute/jobs/${hold.job_id}/report`, {
      token: person.token,
      json: { tapis_job_id: uuid },
      env: { DB: raceAfterRead(w.env().DB, "FROM compute_jobs WHERE id = ?1", cancel, 2) } as never,
    });
    expect([res.status, res.json?.code]).toEqual([409, "hold_cancelled"]);
    expectRefusedAndStopped(hold, uuid, "user");
  });
});

describe("the verifying statement re-checks the person and the cancel itself (minor 4)", () => {
  /** Run one verification whose read of the account is followed by `during`; the statement must refuse. */
  async function raced(during: (id: string) => void) {
    const { hold } = await pendingJob();
    const hooked = raceAfterRead(
      fx.env().DB,
      "SELECT 1 AS ok FROM users",
      async () => during(hold.job_id),
      1,
    );
    const out = await verifyBoundJob(fx.env({ DB: hooked }), hold.job_id, {
      read: TICK_READ,
      tick: true,
    });
    return { hold, out };
  }

  test("a person revoked after the up-front check is not verified by the statement", async () => {
    const { hold, out } = await raced(() =>
      w.h.db.query("UPDATE users SET compute_access = 'revoked' WHERE id = ?").run(person.id),
    );
    expect(out.kind).toBe("skipped");
    expect(row(w, hold.job_id)).toMatchObject({ partner_state: "pending", state: "created" });
    // The next tick refuses and ends it.
    expect(await reapExpiredHolds(fx.env())).toMatchObject({ verified: 0, ended: 1 });
  });

  test("a cancel recorded after the up-front check is not verified by the statement", async () => {
    const { hold, out } = await raced((id) =>
      w.h.db
        .query(
          "UPDATE compute_jobs SET cancel_requested_at = datetime('now'), cancel_reason = 'user' WHERE id = ?",
        )
        .run(id),
    );
    expect(out.kind).toBe("skipped");
    expect(row(w, hold.job_id)).toMatchObject({ partner_state: "pending", state: "created" });
    expect(await reapExpiredHolds(fx.env())).toMatchObject({ verified: 0, ended: 1 });
  });
});

describe("a pending job is not verified into a live one for a person whose compute ended", () => {
  test("revoked with no cascade recorded: the tick refuses it as hold_ended and ends it, the use is the partner's", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    fx.tapis.advance(uuid, "QUEUED");
    fx.tapis.advance(uuid, "RUNNING");
    setTapisTimes(fx, uuid, 30 * MINUTE, null);
    fx.tapis.down();
    expect((await report(hold, uuid)).status).toBe(202);
    fx.tapis.up();
    w.h.db.query("UPDATE users SET compute_access = 'revoked' WHERE id = ?").run(person.id);
    const tick = await reapExpiredHolds(fx.env());
    expect(tick).toMatchObject({ verified: 0, refused: 1, ended: 1 });
    expect(row(w, hold.job_id)).toMatchObject({ state: "cancelled", partner_flag: "hold_ended" });
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
    expect(kinds(hold.job_id)).toEqual(["hold", "release", "overrun"]);
  });

  test("a person revoked between the bind and the read-back is told hold_cancelled at the report", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    // The second read of the job row is the one right after the bind (the first is the ownership check).
    const revoke = async () => {
      w.h.db.query("UPDATE users SET compute_access = 'revoked' WHERE id = ?").run(person.id);
    };
    const res = await partnerCall(w, "POST", `/compute/jobs/${hold.job_id}/report`, {
      token: person.token,
      json: { tapis_job_id: uuid },
      env: {
        DB: raceAfterRead(w.env().DB, "FROM compute_jobs WHERE id = ?1", revoke, 2),
      } as never,
    });
    expect([res.status, res.json?.code]).toEqual([409, "hold_cancelled"]);
    expect(row(w, hold.job_id)).toMatchObject({
      partner_state: "mismatch",
      partner_flag: "hold_ended",
    });
  });
});

describe("the counters are zero at every binding, whichever statement binds (M1)", () => {
  const dirty = (id: string) =>
    w.h.db
      .query(
        "UPDATE compute_jobs SET partner_read_failures = 2, partner_first_failed_at = datetime('now', '-200 minutes'), partner_refused_at = datetime('now', '-100 minutes'), partner_cancel_sent_at = datetime('now', '-90 minutes') WHERE id = ?",
      )
      .run(id);
  const zero = (id: string) => {
    const r = row(w, id);
    return [
      r.partner_read_failures,
      r.partner_first_failed_at,
      r.partner_refused_at,
      r.partner_cancel_sent_at,
    ];
  };

  test("the report's bind", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    dirty(hold.job_id);
    fx.tapis.down();
    expect((await report(hold, uuid)).status).toBe(202);
    expect(zero(hold.job_id)).toEqual([0, null, null, null]);
  });

  test("the reaper's adoption of a job found under the tag", async () => {
    const hold = await reserve(w, person);
    await partnerLaunch(w, hold, person, { owner: "someone-else" });
    dirty(hold.job_id);
    w.h.db
      .query(
        "UPDATE compute_jobs SET created_at = datetime('now', '-40 minutes'), partner_expires_at = datetime('now', '-10 minutes') WHERE id = ?",
      )
      .run(hold.job_id);
    // The adopted job is another owner's: it is refused at once, and what is left on the row is the
    // refusal's own clock, not the old binding's.
    expect(await reapExpiredHolds(fx.env())).toMatchObject({ adopted: 1, refused: 1 });
    const r = zero(hold.job_id);
    expect([r[0], r[1], r[3]]).toEqual([0, null, null]);
  });

  test("the withdrawal of a binding NEMAR cannot keep", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    fx.tapis.down();
    expect((await report(hold, uuid)).status).toBe(202);
    fx.tapis.up();
    dirty(hold.job_id);
    await w.env().DB.prepare(UNBIND_SQL).bind(hold.job_id, uuid, "tapis_job_in_use").run();
    expect(zero(hold.job_id)).toEqual([0, null, null, null]);
  });
});

describe("a report that triggers the recovery is answered with the recovered job (I1)", () => {
  test("200 verified, the row is submitted and verified, and nothing was cancelled", async () => {
    const { hold, uuid } = await refusedBeforeCancel();
    fx.tapis.clearFailures();
    const rep = await report(hold, uuid, "a-new-report-key");
    expect([rep.status, rep.json?.verification, rep.json?.state]).toEqual([
      200,
      "verified",
      "submitted",
    ]);
    expect(row(w, hold.job_id)).toMatchObject({ partner_state: "verified", state: "submitted" });
    expect(cancels()).toHaveLength(0);
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("RUNNING");
  });

  test("with a cancel recorded the same report is still the refusal (409 report_mismatch)", async () => {
    const { hold, uuid } = await stuckUnverifiable();
    await requestComputeCancel(fx.env(), hold.job_id, "user");
    fx.tapis.clearFailures();
    const rep = await report(hold, uuid, "another-report-key");
    expect([rep.status, rep.json?.code]).toEqual([409, "report_mismatch"]);
  });
});

describe("the failed-read counters do not carry over between bindings (M1)", () => {
  test("two failures, a long 404, a withdrawal, a new binding: one failed tick does not refuse it", async () => {
    const hold = await reserve(w, person);
    const first = await partnerLaunch(w, hold, person);
    fx.tapis.down();
    expect((await report(hold, first)).status).toBe(202);
    fx.tapis.up();
    fx.tapis.fail("GET /v3/jobs/:uuid", 503, 1000);
    await reapExpiredHolds(fx.env());
    await reapExpiredHolds(fx.env());
    expect(row(w, hold.job_id).partner_read_failures).toBe(2);
    fx.tapis.clearFailures();
    fx.tapis.fail("GET /v3/jobs/:uuid", 404, 1000);
    w.h.db
      .query(
        "UPDATE compute_jobs SET submitted_at = datetime('now', '-300 minutes'), partner_first_failed_at = datetime('now', '-300 minutes') WHERE id = ?",
      )
      .run(hold.job_id);
    await reapExpiredHolds(fx.env());
    expect(row(w, hold.job_id)).toMatchObject({
      partner_state: null,
      tapis_uuid: null,
      partner_read_failures: 0,
      partner_first_failed_at: null,
    });
    fx.tapis.clearFailures();
    const second = await partnerLaunch(w, hold, person);
    fx.tapis.down();
    expect((await report(hold, second, "second-report-key")).status).toBe(202);
    fx.tapis.up();
    expect(row(w, hold.job_id)).toMatchObject({
      partner_state: "pending",
      partner_read_failures: 0,
      partner_first_failed_at: null,
    });
    fx.tapis.fail("GET /v3/jobs/:uuid", 503, 1000);
    const t = await reapExpiredHolds(fx.env());
    expect(t).toMatchObject({ unverifiable: 0, refused: 0 });
    expect(row(w, hold.job_id)).toMatchObject({
      partner_state: "pending",
      partner_read_failures: 1,
    });
  });

  test("the reaper's own binding of a job found under a CANCELLED reservation starts from zero (the adoption's reset, not a verification's)", async () => {
    const hold = await reserve(w, person);
    w.h.db
      .query(
        "UPDATE compute_jobs SET partner_read_failures = 2, partner_first_failed_at = datetime('now', '-200 minutes'), partner_cancel_sent_at = datetime('now', '-90 minutes'), cancel_requested_at = datetime('now'), cancel_reason = 'user' WHERE id = ?",
      )
      .run(hold.job_id);
    const uuid = await partnerLaunch(w, hold, person);
    // Refused as hold_ended on adoption: a verification (which would reset the counters itself) never runs.
    const tick = await reapExpiredHolds(fx.env());
    expect(tick).toMatchObject({ adopted: 1, refused: 1, verified: 0 });
    expect(row(w, hold.job_id)).toMatchObject({
      tapis_uuid: uuid,
      partner_flag: "hold_ended",
      partner_read_failures: 0,
      partner_first_failed_at: null,
      partner_cancel_sent_at: null,
    });
  });
});

describe("a recovery and a blind cancel cannot both win (M2)", () => {
  test("a blind cancel is stamped before it is sent; with the stamp down a readable matching job is NOT recovered", async () => {
    const { hold, uuid } = await stuckUnverifiable();
    w.h.db
      .query("UPDATE compute_jobs SET partner_cancel_sent_at = datetime('now') WHERE id = ?")
      .run(hold.job_id);
    fx.tapis.clearFailures();
    const tick = await reapExpiredHolds(fx.env());
    expect(tick).toMatchObject({ recovered: 0, ended: 1 });
    expect(row(w, hold.job_id).state).toBe("cancelled");
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
  });

  test("a blind cancel that fails (its outcome is unknown) keeps the stamp, so the readable job is not recovered afterwards", async () => {
    const { hold } = await stuckUnverifiable();
    // The tick's blind cancel failed with a 500 in the setup: it may have gone out, the stamp stands.
    expect(row(w, hold.job_id).partner_cancel_sent_at).not.toBeNull();
    fx.tapis.clearFailures();
    expect(await reapExpiredHolds(fx.env())).toMatchObject({ recovered: 0, ended: 1 });
    expect(row(w, hold.job_id).state).toBe("cancelled");
  });

  test("a refusal whose cancel was never sent is recovered once the job can be read", async () => {
    const { hold } = await refusedBeforeCancel();
    fx.tapis.clearFailures();
    expect(await reapExpiredHolds(fx.env())).toMatchObject({ recovered: 1, ended: 0 });
    expect(row(w, hold.job_id)).toMatchObject({ partner_state: "verified", state: "submitted" });
    expect(cancels()).toHaveLength(0);
  });

  test("a recovery that committed between the read of the row and the blind cancel sends no cancel", async () => {
    const { hold, uuid } = await refusedBeforeCancel();
    // Another call recovers the job after this one read the row (the first read of the row).
    const recover = async () => {
      w.h.db
        .query(
          "UPDATE compute_jobs SET partner_state = 'verified', partner_flag = NULL, state = 'submitted' WHERE id = ?",
        )
        .run(hold.job_id);
    };
    const before = fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/:uuid/cancel").length;
    const out = await finishMismatch(
      fx.env({ DB: raceAfterRead(fx.env().DB, "FROM compute_jobs WHERE id = ?1", recover, 1) }),
      hold.job_id,
    );
    expect(out).toBe("skipped");
    expect(fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/:uuid/cancel").length).toBe(
      before,
    );
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("RUNNING");
    expect(row(w, hold.job_id).partner_cancel_sent_at).toBeNull();
  });

  test("the READABLE cancel of an unverifiable row is stamped too, and a recovery landing first sends none (minor 3)", async () => {
    const { hold } = await refusedBeforeCancel();
    // A cancel is recorded, so the readable job is cancelled rather than recovered; its cancel fails.
    expect((await requestComputeCancel(fx.env(), hold.job_id, "user")).ok).toBe(true);
    fx.tapis.clearFailures();
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 500, 1000);
    await reapExpiredHolds(fx.env());
    expect(row(w, hold.job_id)).toMatchObject({ state: "created", partner_state: "mismatch" });
    expect(row(w, hold.job_id).partner_cancel_sent_at).not.toBeNull();

    // Another call recovered the job after this one re-read the row (the second read) and before its stamp: nothing is sent.
    const second = await refusedBeforeCancel();
    expect((await requestComputeCancel(fx.env(), second.hold.job_id, "user")).ok).toBe(true);
    fx.tapis.clearFailures();
    const before = fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/:uuid/cancel").length;
    const recover = async () => {
      w.h.db
        .query(
          "UPDATE compute_jobs SET partner_state = 'verified', partner_flag = NULL, state = 'submitted' WHERE id = ?",
        )
        .run(second.hold.job_id);
    };
    const out = await finishMismatch(
      fx.env({ DB: raceAfterRead(fx.env().DB, "FROM compute_jobs WHERE id = ?1", recover, 2) }),
      second.hold.job_id,
    );
    expect(out).toBe("skipped");
    expect(fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/:uuid/cancel").length).toBe(
      before,
    );
  });

  test("the request path sends no blind cancel: a report for an unverifiable row it cannot read cancels nothing", async () => {
    const { hold, uuid } = await refusedBeforeCancel();
    const before = fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/:uuid/cancel").length;
    const rep = await report(hold, uuid, "request-key-1");
    expect([rep.status, rep.json?.code]).toEqual([409, "report_mismatch"]);
    expect(fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/:uuid/cancel").length).toBe(
      before,
    );
    expect(row(w, hold.job_id).partner_cancel_sent_at).toBeNull();
  });
});

const own = () => poolOf(w, "account", String(person.id)) as Record<string, number>;
