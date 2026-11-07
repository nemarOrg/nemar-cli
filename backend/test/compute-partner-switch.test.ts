/**
 * The partner contract's switch (epic #2021 phase D4, #2025; the second review round of PR #2077, item 7):
 * `policy.partner.tapisVisibilityConfirmed`, closed by default. Turning it off freezes every open
 * reservation (the reaper releases none on an empty search), so:
 *  (a) a policy write that drops or flips the confirmation while partner reservations are open is refused
 *      (409 `partner_reservations_open`, with the count), unless the owner sends `force_partner_off`, and
 *      then the number frozen is told; a file written before the block existed omits it, which is the same;
 *  (b) while it is off, a reservation a day past its expiry whose person's compute ended, or whose cancel
 *      was asked for, is released WITHOUT a Tapis call (never on an empty search), the rest stay frozen;
 *  (c) a repeat of an existing hold's key replays it (with its state) even when the contract is off; a new
 *      reservation is `partner_not_enabled`.
 * Through the REAL Worker, the owner's policy route and the Tapis stand-in.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_COMPUTE_POLICY } from "../../shared/contract/compute";
import { reapExpiredHolds } from "../src/services/compute-hold-reaper";
import { type LifecycleFixture, startLifecycleFixture } from "./helpers/compute-lifecycle-fixture";
import {
  PARTNER_CONFIRMED,
  type PartnerPerson,
  type PartnerWorld,
  buildPartnerWorld,
  entries,
  newPartnerPerson,
  partnerCall,
  reserve,
  row,
} from "./helpers/compute-partner-world";
import { OWNER_KEY } from "./helpers/oidc-harness";

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

const clients = () => ({
  [w.client.clientId]: { maxOpenReservations: 20, maxReservedMilliPerDay: 1e9 },
});
const policyWith = (partner: unknown) => ({
  ...DEFAULT_COMPUTE_POLICY,
  clients: clients(),
  ...(partner === undefined ? {} : { partner }),
});
const put = (policy: unknown, extra: Record<string, unknown> = {}) =>
  w.h.call("PUT", "/admin/compute/policy", { key: OWNER_KEY, body: { policy, ...extra } });
const versions = () =>
  (w.h.db.query("SELECT COUNT(*) AS n FROM compute_policy").get() as { n: number }).n;

describe("(a) a policy write that would freeze open reservations", () => {
  test("is refused when it flips the confirmation or omits the block; force_partner_off writes it and tells how many are frozen", async () => {
    await reserve(w, person);
    await reserve(w, person);
    const before = versions();
    for (const partner of [{ tapisVisibilityConfirmed: false }, undefined]) {
      const res = await put(policyWith(partner));
      expect([JSON.stringify(partner), res.status, res.json?.code, res.json?.open]).toEqual([
        JSON.stringify(partner),
        409,
        "partner_reservations_open",
        2,
      ]);
    }
    expect(versions()).toBe(before);
    const forced = await put(policyWith(undefined), { force_partner_off: true });
    expect([forced.status, forced.json?.partner_reservations_frozen]).toEqual([200, 2]);
    expect(versions()).toBe(before + 1);
  });

  test("counts only what the switch freezes: bound pending and refused rows are not counted", async () => {
    const pending = await reserve(w, person);
    const refused = await reserve(w, person);
    const open = await reserve(w, person);
    w.h.db
      .query(
        "UPDATE compute_jobs SET tapis_uuid = 'uuid-pending-1', partner_state = 'pending' WHERE id = ?",
      )
      .run(pending.job_id);
    w.h.db
      .query(
        "UPDATE compute_jobs SET tapis_uuid = 'uuid-refused-1', partner_state = 'mismatch' WHERE id = ?",
      )
      .run(refused.job_id);
    const res = await put(policyWith(undefined));
    expect([res.status, res.json?.code, res.json?.open]).toEqual([
      409,
      "partner_reservations_open",
      1,
    ]);
    // With no unbound reservation left, `open` is 0; the pending row is the BOUND count (the pin is loosened
    // by dropping the block), and the plain refused row is in neither.
    w.h.db.query("UPDATE compute_jobs SET state = 'cancelled' WHERE id = ?").run(open.job_id);
    const bound = await put(policyWith(undefined));
    expect([bound.status, bound.json?.open, bound.json?.bound]).toEqual([409, 0, 1]);
    w.h.db.query("UPDATE compute_jobs SET state = 'cancelled' WHERE id = ?").run(pending.job_id);
    expect((await put(policyWith(undefined))).status).toBe(200);
  });

  test("is not refused when nothing is open, when the confirmation stays, or when it was off already", async () => {
    // Nothing open.
    expect((await put(policyWith(undefined))).status).toBe(200);
    // Confirmed, with a reservation open: a write that keeps it is fine.
    await put(policyWith(PARTNER_CONFIRMED));
    await reserve(w, person);
    const kept = await put(
      policyWith({ ...PARTNER_CONFIRMED, allowedSchedulerArgs: ["--account=p1"] }),
    );
    expect(kept.status).toBe(200);
    expect(kept.json?.partner_reservations_frozen).toBeUndefined();
    // Already off: another write that leaves it off freezes nothing new.
    await put(policyWith(undefined), { force_partner_off: true });
    expect((await put(policyWith({ tapisVisibilityConfirmed: false }))).status).toBe(200);
  });
});

describe("(a2) a write that loosens what bound jobs are verified against (minor 2)", () => {
  const bind = async (state: "pending" | "unverifiable") => {
    const hold = await reserve(w, person);
    w.h.db
      .query(
        state === "pending"
          ? "UPDATE compute_jobs SET tapis_uuid = ?, partner_state = 'pending' WHERE id = ?"
          : "UPDATE compute_jobs SET tapis_uuid = ?, partner_state = 'mismatch', partner_flag = 'unverifiable' WHERE id = ?",
      )
      .run(`uuid-${state}-bound`, hold.job_id);
  };

  test("dropping the block, changing the execution system or the listed options is refused with the bound count named; keeping the pin is not", async () => {
    await put(policyWith(PARTNER_CONFIRMED));
    await bind("pending");
    await bind("unverifiable");
    for (const partner of [
      undefined,
      { ...PARTNER_CONFIRMED, execSystemId: "another-system" },
      { ...PARTNER_CONFIRMED, allowedSchedulerArgs: ["--account=p1"] },
    ]) {
      const res = await put(policyWith(partner));
      expect([
        JSON.stringify(partner),
        res.status,
        res.json?.code,
        res.json?.open,
        res.json?.bound,
      ]).toEqual([JSON.stringify(partner), 409, "partner_reservations_open", 0, 2]);
    }
    // The same pin again is not a change.
    expect((await put(policyWith(PARTNER_CONFIRMED))).status).toBe(200);
    // The owner's word writes it.
    expect(
      (
        await put(policyWith({ ...PARTNER_CONFIRMED, execSystemId: "another-system" }), {
          force_partner_off: true,
        })
      ).status,
    ).toBe(200);
  });

  test("with no bound row waiting a pin change is free", async () => {
    await put(policyWith(PARTNER_CONFIRMED));
    await reserve(w, person);
    expect(
      (await put(policyWith({ ...PARTNER_CONFIRMED, execSystemId: "another-system" }))).status,
    ).toBe(200);
  });
});

describe("(b) while the contract is off, a stale reservation of an ended person is released without a search", () => {
  const expiredHoursAgo = (jobId: string, hours: number) =>
    w.h.db
      .query("UPDATE compute_jobs SET partner_expires_at = datetime('now', ?) WHERE id = ?")
      .run(`-${hours} hours`, jobId);

  async function switchOff() {
    await put(policyWith(undefined), { force_partner_off: true });
  }

  test("a person whose compute ended, a day past expiry: released, no Tapis call for it; a day not yet: kept", async () => {
    const stale = await reserve(w, person);
    const recent = await reserve(w, person);
    await switchOff();
    w.h.db.query("UPDATE users SET compute_access = 'revoked' WHERE id = ?").run(person.id);
    expiredHoursAgo(stale.job_id, 25);
    expiredHoursAgo(recent.job_id, 23);
    const r = await reapExpiredHolds(fx.env());
    expect(r).toMatchObject({ releasedUnseen: 1, unconfirmed: 1, released: 0 });
    expect(row(w, stale.job_id).state).toBe("cancelled");
    expect(entries(w, stale.job_id).map((e) => e.kind)).toEqual(["hold", "release"]);
    // Not a day yet: kept, and the empty search is not acted on.
    expect(row(w, recent.job_id).state).toBe("created");
    // The stale one was never searched for; the recent one was.
    expect(fx.tapis.log.filter((q) => q.body.includes(stale.tag))).toEqual([]);
    expect(fx.tapis.log.filter((q) => q.body.includes(recent.tag)).length).toBeGreaterThan(0);
  });

  test("a cancelled reservation a day past expiry is released; a live person's reservation is NOT, however old", async () => {
    const cancelled = await reserve(w, person);
    const live = await reserve(w, person);
    await switchOff();
    w.h.db
      .query(
        "UPDATE compute_jobs SET cancel_requested_at = datetime('now'), cancel_reason = 'user' WHERE id = ?",
      )
      .run(cancelled.job_id);
    expiredHoursAgo(cancelled.job_id, 30);
    expiredHoursAgo(live.job_id, 300);
    const r = await reapExpiredHolds(fx.env());
    expect(r).toMatchObject({ releasedUnseen: 1 });
    expect(row(w, cancelled.job_id).state).toBe("cancelled");
    expect(row(w, live.job_id).state).toBe("created");
  });

  test("with the contract ON, an empty search still releases and releasedUnseen stays 0", async () => {
    const hold = await reserve(w, person);
    expiredHoursAgo(hold.job_id, 1);
    const r = await reapExpiredHolds(fx.env());
    expect(r).toMatchObject({ released: 1, releasedUnseen: 0 });
  });
});

describe("(c) a repeat of a hold replays it even when the contract is off", () => {
  test("the same key and body is the reservation again, with its state; a new key is partner_not_enabled", async () => {
    const hold = await reserve(w, person, {}, "off-key");
    await put(policyWith(undefined), { force_partner_off: true });
    const body = {
      app_id: "partner-app",
      app_version: "2.1.0",
      kind: "batch",
      partition: "shared",
      nodes: 1,
      cores: 4,
      memory_mb: 8000,
      gpus: 0,
      minutes: 60,
    };
    const again = await partnerCall(w, "POST", "/compute/holds", {
      token: person.token,
      json: body,
      key: "off-key",
    });
    expect([again.status, again.json?.job_id, again.json?.replayed, again.json?.state]).toEqual([
      201,
      hold.job_id,
      true,
      "created",
    ]);
    const fresh = await partnerCall(w, "POST", "/compute/holds", {
      token: person.token,
      json: body,
      key: "new-key",
    });
    expect([fresh.status, fresh.json?.code]).toEqual([503, "partner_not_enabled"]);
  });
});
