/**
 * `DELETE /compute/holds/:id` (epic #2021 phase D4, #2025; ADR 0118, the amendment of this phase), through the
 * REAL Worker over real migrated SQLite and a partner client registered by the owner's route.
 *
 * What is pinned:
 *  1. A RELEASE gives the whole hold back through the lifecycle's own release (the job `cancelled`, the ledger
 *     `release`, the person's pool as it was) and calls Tapis for nothing; it answers 200
 *     `{ job_id, hold_id, released, state }`.
 *  2. A REPEAT is the same answer: the same key (`replayed`), another key, and a reservation the reaper
 *     already expired. The hold is closed once.
 *  3. A BOUND JOB IS NOT RELEASABLE: 409 `hold_bound` for a reservation a Tapis job is reported under, in
 *     every state of the verification (`pending`, `verified`, `mismatch`) and for a job that has ended; its
 *     hold is untouched. A job that may be running is never released with no charge.
 *  4. RELEASE AND REPORT RACE: the release statement binds "no Tapis job" itself, so whichever wins, the
 *     other is refused and the books are consistent (never a hold released under a bound job).
 *  5. THE KEY: another request under it is 422; it names a hold id and not a job id; a malformed id is
 *     `job_not_found`.
 *
 * MUTATIONS (each applied, run, restored): release without the bound check; let the release statement lose
 * its "no Tapis job" term (`unsubmittedOnly`); release through the hold reaper's expiry reason.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type LifecycleFixture, startLifecycleFixture } from "./helpers/compute-lifecycle-fixture";
import {
  type PartnerPerson,
  type PartnerWorld,
  buildPartnerWorld,
  entries,
  newPartnerPerson,
  partnerCall,
  partnerLaunch,
  poolOf,
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

const del = (holdId: string, key?: string | null, who: PartnerPerson = person) =>
  partnerCall(w, "DELETE", `/compute/holds/${holdId}`, { token: who.token, key });
const kinds = (id: string) => entries(w, id).map((e) => e.kind);
const own = () => poolOf(w, "account", String(person.id)) as Record<string, number>;
const tapisCalls = () => fx.tapis.log.length;

describe("a release", () => {
  test("gives the whole hold back, calls Tapis for nothing and is answered 200", async () => {
    const hold = await reserve(w, person);
    expect(own().held_milli).toBe(4000);
    const before = tapisCalls();
    const res = await del(hold.hold_id);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.json).toEqual({
      job_id: hold.job_id,
      hold_id: hold.hold_id,
      released: true,
      state: "cancelled",
    });
    expect(tapisCalls()).toBe(before);
    expect(row(w, hold.job_id)).toMatchObject({
      state: "cancelled",
      cancel_reason: "partner_release",
      tapis_uuid: null,
      charged_milli: 0,
    });
    expect(kinds(hold.job_id)).toEqual(["hold", "release"]);
    expect(entries(w, hold.job_id)[1]?.reason).toBe("released");
    expect(own()).toMatchObject({ held_milli: 0, charged_milli: 0, granted_milli: 100_000 });
    expect((poolOf(w, "platform", "people") as Record<string, number>).held_milli).toBe(0);
    // The person's slot is free again.
    expect(row(w, hold.job_id).settled_provisional_at).not.toBeNull();
  });

  test("a repeat is the same answer: the same key says replayed, another key and an expired hold do too", async () => {
    const hold = await reserve(w, person);
    expect((await del(hold.hold_id, "release-key-1")).status).toBe(200);
    const before = [entries(w, hold.job_id).length, tapisCalls()];
    const same = await del(hold.hold_id, "release-key-1");
    expect([same.status, same.json?.replayed]).toEqual([200, true]);
    const other = await del(hold.hold_id);
    expect([other.status, other.json?.released, other.json?.state]).toEqual([200, true, "cancelled"]);
    expect([entries(w, hold.job_id).length, tapisCalls()]).toEqual(before);
    // A reservation the reaper expired answers 200 as well.
    const old = await reserve(w, person);
    w.h.db.query("UPDATE compute_jobs SET created_at = datetime('now', '-31 minutes') WHERE id = ?").run(old.job_id);
    const { reapExpiredHolds } = await import("../src/services/compute-hold-reaper");
    expect((await reapExpiredHolds(fx.env()))?.released).toBe(1);
    const late = await del(old.hold_id);
    expect([late.status, late.json?.released]).toEqual([200, true]);
    expect(kinds(old.job_id)).toEqual(["hold", "release"]);
  });
});

describe("a bound job is not released", () => {
  for (const verify of ["pending", "verified", "mismatch"] as const) {
    test(`${verify}: 409 hold_bound and the hold is untouched`, async () => {
      const hold = await reserve(w, person);
      const uuid = await partnerLaunch(w, hold, person, verify === "mismatch" ? { owner: "someone-else" } : {});
      if (verify === "pending") fx.tapis.down();
      if (verify === "mismatch") {
        // A refusal whose cancel Tapis does not take stays a bound `mismatch` row.
        fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 500, 1);
        fx.tapis.advance(uuid, "QUEUED");
        fx.tapis.advance(uuid, "RUNNING");
      }
      await partnerCall(w, "POST", `/compute/jobs/${hold.job_id}/report`, {
        token: person.token,
        json: { tapis_job_id: uuid },
      });
      fx.tapis.up();
      expect(row(w, hold.job_id).partner_state).toBe(verify);
      const res = await del(hold.hold_id);
      expect([res.status, res.json?.code]).toEqual([409, "hold_bound"]);
      expect(row(w, hold.job_id).state).not.toBe("cancelled");
      expect(kinds(hold.job_id)).toEqual(["hold"]);
      expect(own().held_milli).toBe(4000);
    });
  }

  test("a job that has ended is hold_bound too: it ran, and its hold was settled", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    await partnerCall(w, "POST", `/compute/jobs/${hold.job_id}/report`, {
      token: person.token,
      json: { tapis_job_id: uuid },
    });
    fx.tapis.advance(uuid, "QUEUED");
    fx.tapis.advance(uuid, "RUNNING");
    fx.tapis.advance(uuid, "FINISHED");
    const { runComputeAdvanceCron } = await import("../src/services/compute-advance");
    await runComputeAdvanceCron(fx.env());
    expect(row(w, hold.job_id).state).toBe("finished");
    const res = await del(hold.hold_id);
    expect([res.status, res.json?.code]).toEqual([409, "hold_bound"]);
    expect(kinds(hold.job_id)).toEqual(["hold", "charge"]);
  });
});

describe("a release and a report race", () => {
  test("whichever wins, the other is refused and the books agree: never a released hold under a bound job", async () => {
    for (let i = 0; i < 8; i++) {
      const hold = await reserve(w, person);
      const uuid = await partnerLaunch(w, hold, person);
      const calls = [
        () => del(hold.hold_id),
        () =>
          partnerCall(w, "POST", `/compute/jobs/${hold.job_id}/report`, {
            token: person.token,
            json: { tapis_job_id: uuid },
          }),
      ];
      if (i % 2 === 1) calls.reverse();
      const [first, second] = await Promise.all(calls.map((c) => c()));
      const statuses = [first?.status, second?.status];
      const job = row(w, hold.job_id);
      if (job.tapis_uuid === null) {
        // The release won: the hold is released, and the report was refused.
        expect(job.state).toBe("cancelled");
        expect(kinds(hold.job_id)).toEqual(["hold", "release"]);
        expect(statuses.filter((s) => s === 200)).toHaveLength(1);
        expect(statuses.filter((s) => s === 409)).toHaveLength(1);
      } else {
        // The report won: the hold stands, and the release was refused.
        expect(job.state).toBe("submitted");
        expect(kinds(hold.job_id)).toEqual(["hold"]);
        expect(statuses.sort()).toEqual([200, 409]);
      }
      // Whatever happened, nothing is both: no released hold under a bound job.
      expect(job.tapis_uuid !== null && kinds(hold.job_id).includes("release")).toBe(false);
    }
  });
});

describe("the key and the id", () => {
  test("another request under the key is idempotency_conflict, and a job id is not a hold id", async () => {
    const a = await reserve(w, person);
    const b = await reserve(w, person);
    expect((await del(a.hold_id, "one-key-del")).status).toBe(200);
    const conflict = await del(b.hold_id, "one-key-del");
    expect([conflict.status, conflict.json?.code]).toEqual([422, "idempotency_conflict"]);
    expect(row(w, b.job_id).state).toBe("created");
    for (const id of [b.job_id, "hold_zz", "hold_", "nope", `hold_${"A".repeat(24)}`]) {
      const res = await del(id);
      expect([id, res.status, res.json?.code]).toEqual([id, 404, "job_not_found"]);
    }
    expect(row(w, b.job_id).state).toBe("created");
  });
});
