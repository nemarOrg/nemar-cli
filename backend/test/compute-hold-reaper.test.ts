/**
 * The partner's hold reaper (epic #2021 phase D4, #2025; ADR 0118, the amendment of this phase):
 * `reapExpiredHolds(env)`, over the REAL lifecycle fixture (real migrated SQLite, Miniflare's R2, the Tapis
 * stand-in of Epic A) and the REAL partner routes for the reservations it resolves. The Tapis tag search is
 * shared with the NEMAR service identity by the stand-in's `shareJob`, which is an ARRANGEMENT of the real
 * tenant that is not verified: whether the tenant credential can search other owners' jobs by tag is an owner
 * item.
 *
 * What is pinned, each with a test of its own:
 *  - FOUND: a reservation past the owner's wait, with ONE Tapis job under its tag that is the person's and
 *    matches, is bound and verified like a report (subscribed, `submitted`);
 *  - NOT FOUND, AFFIRMATIVELY: the search succeeded and found none: the hold is released with the ledger
 *    reason `expired`, and the person's pool is as it was; a reservation younger than the wait is untouched;
 *  - ERROR: any Tapis error (a 500, Tapis down, an unreadable job) KEEPS the hold and records
 *    `tapis_unreachable`; the next tick releases it. NOTHING IS RELEASED ON AN ERROR;
 *  - SEVERAL: flagged `ambiguous_tag` and kept; the tenant sweep then accounts for the jobs that skipped the
 *    reservation and the next tick releases;
 *  - ANOTHER OWNER: the mismatch path (cancelled at Tapis, the hold released, the partner pool charged);
 *  - A CANCELLED reservation and one whose person's compute ended: a job found under their tag is refused
 *    (`hold_ended`), a reservation with none is released, at any age for the first;
 *  - THE SWEEP DEFERS a partner job under a LIVE reservation (so a legitimate report is not refused), and does
 *    not defer a foreign tag, a flagged reservation or an old one;
 *  - BOUNDED: 25 reservations a tick, in rotation; PRODUCTION ONLY; reads no switch.
 *
 * MUTATIONS (each applied, run, restored): release on a Tapis 500; release on an unreadable job; take a
 * second unaccounted job as unambiguous; drop the age term; drop the cancel-intent adoption; drop the sweep's
 * deferral.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { REAPER_ROWS_PER_LIST, reapExpiredHolds } from "../src/services/compute-hold-reaper";
import { sweepTenantJobs } from "../src/services/compute-tenant-sweep";
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

/** Make a reservation `minutes` old. */
function age(hold: Hold, minutes: number) {
  w.h.db
    .query(
      `UPDATE compute_jobs SET created_at = datetime(created_at, ?1),
         partner_expires_at = datetime(partner_expires_at, ?1) WHERE id = ?2`,
    )
    .run(`-${minutes} minutes`, hold.job_id);
}
const kinds = (id: string) => entries(w, id).map((e) => e.kind);
const own = () => poolOf(w, "account", String(person.id)) as Record<string, number>;
const tenant = () => poolOf(w, "partner", "tenant") as Record<string, number> | null;
const cancels = () => fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/:uuid/cancel");
const tapisRequests = () => fx.tapis.log.filter((r) => r.route !== "POST /v3/oauth2/tokens").length;
const production = () => fx.env();

describe("a reservation past the owner's wait", () => {
  test("with one Tapis job under its tag that is the person's and matches: bound and verified like a report", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    age(hold, 31);
    const r = await reapExpiredHolds(production());
    expect(r).toMatchObject({ examined: 1, adopted: 1, verified: 1, released: 0, errors: [] });
    expect(row(w, hold.job_id)).toMatchObject({
      tapis_uuid: uuid,
      partner_state: "verified",
      state: "submitted",
      charged_milli: 0,
    });
    expect(fx.tapis.subscriptions).toHaveLength(1);
    expect(kinds(hold.job_id)).toEqual(["hold"]);
    expect(cancels()).toHaveLength(0);
  });

  test("with none, affirmatively: the hold is released with the reason `expired`, and the pool is as it was", async () => {
    const hold = await reserve(w, person);
    age(hold, 31);
    expect(own().held_milli).toBe(4000);
    const r = await reapExpiredHolds(production());
    expect(r).toMatchObject({ examined: 1, released: 1, adopted: 0, errors: [] });
    expect(row(w, hold.job_id)).toMatchObject({
      state: "cancelled",
      cancel_reason: "hold_expired",
      tapis_uuid: null,
      charged_milli: 0,
    });
    expect(kinds(hold.job_id)).toEqual(["hold", "release"]);
    expect(entries(w, hold.job_id)[1]?.reason).toBe("expired");
    expect(own()).toMatchObject({ held_milli: 0, charged_milli: 0 });
    // Tapis was ASKED first: one search by the reservation's tag.
    const searches = fx.tapis.log.filter((q) => q.route === "POST /v3/jobs/search");
    expect(searches).toHaveLength(1);
    expect(searches[0]?.body).toContain(hold.tag);
  });

  test("a reservation younger than the wait is untouched, and Tapis is not asked", async () => {
    const hold = await reserve(w, person);
    age(hold, 29);
    const before = tapisRequests();
    const r = await reapExpiredHolds(production());
    expect(r).toMatchObject({ examined: 0, released: 0 });
    expect(row(w, hold.job_id).state).toBe("created");
    expect(tapisRequests()).toBe(before);
  });

  test("the wait is the owner's policy, not a constant", async () => {
    const { setPartnerPolicy } = await import("./helpers/compute-partner-world");
    await setPartnerPolicy(w.env().DB, fx.ownerId, {
      reservationWaitMinutes: 5,
      clients: { [w.client.clientId]: { maxOpenReservations: 10, maxReservedMilliPerDay: 1e9 } },
    });
    const hold = await reserve(w, person);
    age(hold, 6);
    expect((await reapExpiredHolds(production()))?.released).toBe(1);
    expect(row(w, hold.job_id).state).toBe("cancelled");
  });
});

describe("a Tapis error keeps the hold: nothing is released on an error", () => {
  test("a 500 on the search: kept, `tapis_unreachable`, and the next tick releases", async () => {
    const hold = await reserve(w, person);
    age(hold, 31);
    fx.tapis.fail("POST /v3/jobs/search", 500, 2);
    const r = await reapExpiredHolds(production());
    expect(r).toMatchObject({ examined: 1, unreachable: 1, released: 0 });
    expect(row(w, hold.job_id)).toMatchObject({
      state: "created",
      partner_flag: "tapis_unreachable",
      tapis_uuid: null,
    });
    expect(kinds(hold.job_id)).toEqual(["hold"]);
    expect(own().held_milli).toBe(4000);
    // Tapis answers again: the next tick asks again, finds none and releases; the flag is gone.
    // The two failures were consumed (the client asks twice); Tapis answers again.
    const again = await reapExpiredHolds(production());
    expect(again).toMatchObject({ released: 1, unreachable: 0 });
    expect(row(w, hold.job_id)).toMatchObject({ state: "cancelled", partner_flag: null });
  });

  test("Tapis down is the same, for every reservation of the tick", async () => {
    const a = await reserve(w, person);
    const b = await reserve(w, person);
    age(a, 40);
    age(b, 40);
    fx.tapis.down();
    const r = await reapExpiredHolds(production());
    expect(r).toMatchObject({ examined: 2, unreachable: 2, released: 0 });
    for (const h of [a, b]) {
      expect(row(w, h.job_id)).toMatchObject({
        state: "created",
        partner_flag: "tapis_unreachable",
      });
      expect(kinds(h.job_id)).toEqual(["hold"]);
    }
    fx.tapis.up();
    expect((await reapExpiredHolds(production()))?.released).toBe(2);
  });

  test("a job found whose record cannot be read is kept, not released and not adopted", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    age(hold, 31);
    fx.tapis.fail("GET /v3/jobs/:uuid", 500, 2);
    const r = await reapExpiredHolds(production());
    expect(r).toMatchObject({ examined: 1, unreachable: 1, released: 0, adopted: 0 });
    expect(row(w, hold.job_id)).toMatchObject({ state: "created", tapis_uuid: null });
    expect(kinds(hold.job_id)).toEqual(["hold"]);
    // The failures are consumed; the next tick reads it and adopts it.
    expect((await reapExpiredHolds(production()))?.adopted).toBe(1);
    expect(row(w, hold.job_id).tapis_uuid).toBe(uuid);
  });

  test("Tapis not configured keeps the hold too", async () => {
    const hold = await reserve(w, person);
    age(hold, 31);
    const r = await reapExpiredHolds(
      fx.env({ TAPIS_USERNAME: undefined, TAPIS_PASSWORD: undefined }),
    );
    expect(r).toMatchObject({ unreachable: 1, released: 0 });
    expect(row(w, hold.job_id).state).toBe("created");
  });
});

describe("several Tapis jobs under one tag", () => {
  test("`ambiguous_tag`, kept; the sweep accounts for the jobs that skipped the reservation, and then the tick releases", async () => {
    const hold = await reserve(w, person);
    const a = await partnerLaunch(w, hold, person);
    const b = await partnerLaunch(w, hold, person);
    age(hold, 31);
    const r = await reapExpiredHolds(production());
    expect(r).toMatchObject({ examined: 1, ambiguous: 1, released: 0, adopted: 0 });
    expect(row(w, hold.job_id)).toMatchObject({
      state: "created",
      partner_flag: "ambiguous_tag",
      flag_mismatch: 1,
    });
    expect(kinds(hold.job_id)).toEqual(["hold"]);
    // The reaper cancelled nothing. The sweep indexes both as jobs that skipped the reservation, cancels
    // them and charges the PARTNER's pool.
    expect(cancels()).toHaveLength(0);
    const swept = await sweepTenantJobs(fx.env(), "live");
    expect(swept).toMatchObject({ indexed: 2 });
    for (const uuid of [a, b]) expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
    // Now nothing is unaccounted for under the tag: affirmatively none, so the hold is released.
    const again = await reapExpiredHolds(production());
    expect(again).toMatchObject({ released: 1, ambiguous: 0 });
    expect(row(w, hold.job_id).state).toBe("cancelled");
    expect(own()).toMatchObject({ held_milli: 0, charged_milli: 0 });
  });
});

describe("a job under the tag that is not the person's", () => {
  test("another owner: the mismatch path - cancelled, the hold released, the partner pool charged", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person, { owner: "someone-else" });
    fx.tapis.advance(uuid, "QUEUED");
    fx.tapis.advance(uuid, "RUNNING");
    setTapisTimes(fx, uuid, 30 * MINUTE, null);
    age(hold, 31);
    const r = await reapExpiredHolds(production());
    expect(r).toMatchObject({ adopted: 1, refused: 1, ended: 1, released: 0, errors: [] });
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
    expect(row(w, hold.job_id)).toMatchObject({
      state: "cancelled",
      partner_state: "mismatch",
      partner_flag: "owner_mismatch",
      gateway_user: null,
      charged_milli: 0,
    });
    expect(kinds(hold.job_id)).toEqual(["hold", "release", "overrun"]);
    expect((tenant() as Record<string, number>).charged_milli).toBeGreaterThanOrEqual(2000);
    expect(own()).toMatchObject({ held_milli: 0, charged_milli: 0 });
  });

  test("a NEMAR service-identity job under a partner's tag is never bound or cancelled", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, null, { owner: fx.tapis.username });
    age(hold, 31);
    const r = await reapExpiredHolds(production());
    expect(r).toMatchObject({ ambiguous: 1, adopted: 0, released: 0 });
    expect(row(w, hold.job_id)).toMatchObject({ tapis_uuid: null, partner_flag: "ambiguous_tag" });
    expect(fx.tapis.jobs.get(uuid)?.status).not.toBe("CANCELLED");
  });

  test("a Tapis job a row already accounts for does not count: the reservation is released", async () => {
    const mine = await reserve(w, person);
    const other = await reserve(w, person);
    // A job under MY tag that another row holds as its job (a row the sweep indexed, say).
    const uuid = await partnerLaunch(w, mine, person);
    w.h.db
      .query(
        "UPDATE compute_jobs SET tapis_uuid = ?, partner_state = 'verified', state = 'submitted' WHERE id = ?",
      )
      .run(uuid, other.job_id);
    age(mine, 31);
    const r = await reapExpiredHolds(production());
    expect(r).toMatchObject({ examined: 1, released: 1, adopted: 0 });
    expect(row(w, mine.job_id).state).toBe("cancelled");
    expect(row(w, other.job_id).tapis_uuid).toBe(uuid);
  });
});

describe("a cancelled reservation and one whose person's compute ended", () => {
  test("the person's cancel of a reservation is resolved at any age: none found, released; the cancel reason stays the person's", async () => {
    const hold = await reserve(w, person);
    const { requestComputeCancel } = await import("../src/services/compute-lifecycle");
    const cancelled = await requestComputeCancel(fx.env(), hold.job_id, "user");
    expect(cancelled.ok).toBe(true);
    // The generic cancel leaves a partner's reservation alone, with its hold open.
    expect(row(w, hold.job_id)).toMatchObject({ state: "created" });
    expect(row(w, hold.job_id).cancel_requested_at).not.toBeNull();
    const r = await reapExpiredHolds(production());
    expect(r).toMatchObject({ examined: 1, released: 1 });
    expect(row(w, hold.job_id)).toMatchObject({ state: "cancelled", cancel_reason: "user" });
    expect(kinds(hold.job_id)).toEqual(["hold", "release"]);
  });

  test("a job found under a CANCELLED reservation is refused (`hold_ended`), cancelled and charged to the partner", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    fx.tapis.advance(uuid, "QUEUED");
    fx.tapis.advance(uuid, "RUNNING");
    setTapisTimes(fx, uuid, 30 * MINUTE, null);
    w.h.db
      .query(
        "UPDATE compute_jobs SET cancel_requested_at = datetime('now'), cancel_reason = 'user' WHERE id = ?",
      )
      .run(hold.job_id);
    const r = await reapExpiredHolds(production());
    expect(r).toMatchObject({ adopted: 1, refused: 1, ended: 1 });
    expect(row(w, hold.job_id)).toMatchObject({
      state: "cancelled",
      partner_flag: "hold_ended",
      cancel_reason: "user",
    });
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
    expect(kinds(hold.job_id)).toEqual(["hold", "release", "overrun"]);
    expect(own().charged_milli).toBe(0);
  });

  test("a suspension leaves the reservation alone (frozen pool, hold open), and the tick then releases it; a job under it is refused", async () => {
    const quiet = await reserve(w, person);
    const busy = await reserve(w, person);
    const uuid = await partnerLaunch(w, busy, person);
    const decided = await w.h.call("POST", `/admin/compute/access/suspend/by-id/${person.id}`, {
      key: OWNER_KEY,
      body: { reason: "test" },
    });
    expect(decided.status).toBe(200);
    // A8/D1: the cascade does not touch a partner's reservation (it fails open), and freezes the pools.
    for (const h of [quiet, busy]) {
      expect(row(w, h.job_id)).toMatchObject({ state: "created", cancel_requested_at: null });
      expect(kinds(h.job_id)).toEqual(["hold"]);
    }
    expect(poolOf(w, "account", String(person.id))?.frozen).toBe(1);
    age(quiet, 31);
    age(busy, 31);
    const r = await reapExpiredHolds(production());
    expect(r).toMatchObject({ released: 1, adopted: 1, refused: 1 });
    expect(row(w, quiet.job_id)).toMatchObject({
      state: "cancelled",
      cancel_reason: "hold_expired",
    });
    expect(row(w, busy.job_id)).toMatchObject({ state: "cancelled", partner_flag: "hold_ended" });
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
    expect(own().held_milli).toBe(0);
  });
});

describe("the sweep and the reaper agree about a partner's job", () => {
  test("a partner job under a LIVE reservation is left to its report: the sweep defers, and the report is accepted", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    const swept = await sweepTenantJobs(fx.env(), "live");
    expect(swept).toMatchObject({ indexed: 0, awaitingReport: 1, cancelled: 0 });
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("PENDING");
    const res = await partnerCall(w, "POST", `/compute/jobs/${hold.job_id}/report`, {
      token: person.token,
      json: { tapis_job_id: uuid },
    });
    expect(res.status).toBe(200);
  });

  test("a foreign tag, a flagged or an old reservation is a job that skipped the reservation", async () => {
    // A tag proves nothing: another owner under a live reservation's tag is swept.
    const hold = await reserve(w, person);
    const foreign = await partnerLaunch(w, hold, person, { owner: "someone-else" });
    // An old reservation (past the wait and the grace) is no longer waited for.
    const old = await reserve(w, person);
    const late = await partnerLaunch(w, old, person);
    age(old, 100);
    // A flagged one (the reaper met several) is not waited for either.
    const flagged = await reserve(w, person);
    const many = await partnerLaunch(w, flagged, person);
    w.h.db
      .query("UPDATE compute_jobs SET partner_flag = 'ambiguous_tag' WHERE id = ?")
      .run(flagged.job_id);
    const swept = await sweepTenantJobs(fx.env(), "live");
    expect(swept).toMatchObject({ indexed: 3, awaitingReport: 0 });
    for (const uuid of [foreign, late, many])
      expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
  });
});

describe("the tick is bounded, in rotation, production only, and reads no switch", () => {
  test("25 reservations a tick, then the rest on the next, none examined twice before all", async () => {
    const { setPartnerPolicy } = await import("./helpers/compute-partner-world");
    await setPartnerPolicy(w.env().DB, fx.ownerId, {
      clients: { [w.client.clientId]: { maxOpenReservations: 100, maxReservedMilliPerDay: 1e9 } },
    });
    const holds: Hold[] = [];
    for (let i = 0; i < 30; i++) {
      const p = await newPartnerPerson(w);
      holds.push(await reserve(w, p));
    }
    for (const h of holds) age(h, 31);
    const first = await reapExpiredHolds(production());
    expect(first).toMatchObject({ examined: REAPER_ROWS_PER_LIST, released: REAPER_ROWS_PER_LIST });
    const second = await reapExpiredHolds(production());
    expect(second).toMatchObject({ examined: 5, released: 5 });
    expect(
      (
        w.h.db.query("SELECT COUNT(*) AS n FROM compute_jobs WHERE state = 'created'").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  }, 60_000);

  test("outside exact production it does nothing and asks Tapis nothing", async () => {
    const hold = await reserve(w, person);
    age(hold, 31);
    const before = tapisRequests();
    for (const environment of ["test", "staging", "development", "", undefined, "Production"]) {
      expect(await reapExpiredHolds(fx.env({ ENVIRONMENT: environment }))).toBeNull();
    }
    expect(tapisRequests()).toBe(before);
    expect(row(w, hold.job_id).state).toBe("created");
  });

  test("it reads no compute switch: with compute OFF it releases", async () => {
    const hold = await reserve(w, person);
    age(hold, 31);
    const r = await reapExpiredHolds(fx.env({ COMPUTE_ENABLED: undefined }));
    expect(r?.released).toBe(1);
  });

  test("it leaves a person's own job, the tenant's rows and a young reservation alone", async () => {
    w.h.db
      .query(
        `INSERT INTO compute_jobs (id, account_id, source, kind, state, app_id, app_version, spec_digest,
           partition, pool, nodes, cores_per_node, minutes, created_at)
         VALUES ('job_0000000000000000000000c1', ?, 'cli', 'batch', 'created', 'a', '1', ?, 'shared', 'cpu', 1, 1, 1, datetime('now', '-3 days'))`,
      )
      .run(person.id, "0".repeat(64));
    const r = await reapExpiredHolds(production());
    expect(r).toMatchObject({ examined: 0, released: 0 });
    expect(row(w, "job_0000000000000000000000c1").state).toBe("created");
  });
});

describe("the review round: visibility, ambiguity, the sweep's shelter, keys and stuck cancels (PR #2077)", () => {
  const confirmedClients = (over: Record<string, unknown> = {}) => ({
    clients: { [w.client.clientId]: { maxOpenReservations: 100, maxReservedMilliPerDay: 1e9 } },
    ...over,
  });

  test("an EMPTY search proves nothing until the owner confirms NEMAR can see the tenant: the hold is kept, counted and warned (I2, Sonnet)", async () => {
    const { setPolicy } = await import("./helpers/compute-seed");
    const { holdReaperLogLine } = await import("../src/services/compute-hold-reaper");
    const hold = await reserve(w, person);
    age(hold, 31);
    // The confirmation is withdrawn after the reservation was made.
    await setPolicy(w.env().DB, fx.ownerId, confirmedClients(), true);
    const kept = await reapExpiredHolds(production());
    expect(kept).toMatchObject({ examined: 1, released: 0, unconfirmed: 1 });
    expect(row(w, hold.job_id)).toMatchObject({ state: "created" });
    expect(kinds(hold.job_id)).toEqual(["hold"]);
    expect(holdReaperLogLine(kept as NonNullable<typeof kept>)?.level).toBe("warn");
    // The owner's word releases it on the next tick.
    const { setPartnerPolicy } = await import("./helpers/compute-partner-world");
    await setPartnerPolicy(w.env().DB, fx.ownerId, confirmedClients());
    expect(await reapExpiredHolds(production())).toMatchObject({ released: 1, unconfirmed: 0 });
    expect(row(w, hold.job_id).state).toBe("cancelled");
  });

  test("a tagged job another owner added does not make a reservation ambiguous; two of the person's do (I2, Opus)", async () => {
    const hold = await reserve(w, person);
    const foreign = await partnerLaunch(w, hold, person, { owner: "someone-else" });
    const mine = await partnerLaunch(w, hold, person);
    age(hold, 31);
    const r = await reapExpiredHolds(production());
    expect(r).toMatchObject({ ambiguous: 0, adopted: 1, verified: 1 });
    expect(row(w, hold.job_id)).toMatchObject({ tapis_uuid: mine, partner_state: "verified" });
    expect(fx.tapis.jobs.get(foreign)?.status).toBe("PENDING");

    const second = await reserve(w, person);
    await partnerLaunch(w, second, person);
    await partnerLaunch(w, second, person);
    age(second, 31);
    expect(await reapExpiredHolds(production())).toMatchObject({ ambiguous: 1, adopted: 0 });
    expect(row(w, second.job_id)).toMatchObject({
      partner_flag: "ambiguous_tag",
      state: "created",
    });
  });

  describe("what the tenant sweep shelters (I2, Opus; M2, Sonnet)", () => {
    test("only a job that is the only one under its tag, the person's, and a match", async () => {
      // Two jobs under one tag: neither is sheltered.
      const twice = await reserve(w, person);
      const t1 = await partnerLaunch(w, twice, person);
      const t2 = await partnerLaunch(w, twice, person);
      // A job under a live reservation that is the wrong application: not a match, not sheltered.
      const wrongApp = await reserve(w, person);
      const w1 = await partnerLaunch(w, wrongApp, person, { appId: "another-app" });
      // The honest one is sheltered.
      const honest = await reserve(w, person);
      const h1 = await partnerLaunch(w, honest, person);
      // Bigger than the hold: not a match.
      const big = await reserve(w, person);
      const b1 = await partnerLaunch(w, big, person, { cores: 8 });
      const swept = await sweepTenantJobs(fx.env(), "live");
      expect(swept).toMatchObject({ awaitingReport: 1 });
      expect(fx.tapis.jobs.get(h1)?.status).toBe("PENDING");
      for (const uuid of [t1, t2, w1, b1])
        expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
    });

    test("a job tagged with ANOTHER person's reservation is not sheltered, even though its owner has a reservation of their own", async () => {
      const second = await newPartnerPerson(w);
      const mine = await reserve(w, person);
      const theirs = await reserve(w, second);
      // The first person's job, carrying the second person's tag.
      const crossed = await partnerLaunch(w, theirs, person);
      const swept = await sweepTenantJobs(fx.env(), "live");
      expect(swept?.awaitingReport).toBe(0);
      expect(fx.tapis.jobs.get(crossed)?.status).toBe("CANCELLED");
      expect(row(w, mine.job_id).state).toBe("created");
    });

    test("a first attempt that FAILED and was resubmitted under the same reservation: the retry is sheltered and its report binds (item 6, probe C)", async () => {
      const hold = await reserve(w, person);
      const first = await partnerLaunch(w, hold, person);
      fx.tapis.advance(first, "FAILED");
      const retry = await partnerLaunch(w, hold, person);
      const swept = await sweepTenantJobs(fx.env(), "live");
      expect(swept?.awaitingReport).toBe(1);
      expect(fx.tapis.jobs.get(retry)?.status).toBe("PENDING");
      const res = await partnerCall(w, "POST", `/compute/jobs/${hold.job_id}/report`, {
        token: person.token,
        json: { tapis_job_id: retry },
      });
      expect([res.status, res.json?.verification]).toEqual([200, "verified"]);
    });

    test("a foreign-owned job carrying the tag does not unshelter the person's own job (item 6, probe D)", async () => {
      const hold = await reserve(w, person);
      const foreign = await partnerLaunch(w, hold, person, { owner: "someone-else" });
      const mine = await partnerLaunch(w, hold, person);
      const swept = await sweepTenantJobs(fx.env(), "live");
      expect(swept?.awaitingReport).toBe(1);
      expect(fx.tapis.jobs.get(mine)?.status).toBe("PENDING");
      // The foreign one skipped the reservation: it is cancelled, not sheltered.
      expect(fx.tapis.jobs.get(foreign)?.status).toBe("CANCELLED");
    });

    test("a job some row already accounts for does not count against the reservation's own (item 6)", async () => {
      const hold = await reserve(w, person);
      const other = await reserve(w, person);
      const accounted = await partnerLaunch(w, hold, person);
      const mine = await partnerLaunch(w, hold, person);
      w.h.db
        .query(
          "UPDATE compute_jobs SET tapis_uuid = ?, partner_state = 'verified', state = 'submitted' WHERE id = ?",
        )
        .run(accounted, other.job_id);
      const swept = await sweepTenantJobs(fx.env(), "live");
      expect(swept?.awaitingReport).toBe(1);
      expect(fx.tapis.jobs.get(mine)?.status).toBe("PENDING");
    });

    test("the reaper counts the same way: a failed first attempt and a live retry adopt the retry, not ambiguous", async () => {
      const hold = await reserve(w, person);
      const first = await partnerLaunch(w, hold, person);
      fx.tapis.advance(first, "FAILED");
      const retry = await partnerLaunch(w, hold, person);
      age(hold, 31);
      expect(await reapExpiredHolds(production())).toMatchObject({
        ambiguous: 0,
        adopted: 1,
        verified: 1,
      });
      expect(row(w, hold.job_id).tapis_uuid).toBe(retry);
    });

    test("the window is the stored expiry plus an hour: sheltered at 31 and 89 minutes old, not at 91", async () => {
      for (const [minutes, sheltered] of [
        [31, true],
        [89, true],
        [91, false],
      ] as const) {
        await fx.reset();
        w = await buildPartnerWorld(fx);
        person = await newPartnerPerson(w);
        const hold = await reserve(w, person);
        const uuid = await partnerLaunch(w, hold, person);
        age(hold, minutes);
        const swept = await sweepTenantJobs(fx.env(), "live");
        expect([minutes, swept?.awaitingReport, fx.tapis.jobs.get(uuid)?.status]).toEqual([
          minutes,
          sheltered ? 1 : 0,
          sheltered ? "PENDING" : "CANCELLED",
        ]);
      }
    });

    test("a sheltered job never uses one of the run's slots: 25 sheltered jobs and one that skipped the reservation", async () => {
      const { setPartnerPolicy } = await import("./helpers/compute-partner-world");
      await setPartnerPolicy(w.env().DB, fx.ownerId, {
        ...confirmedClients(),
        maxLiveJobsPerPerson: 100,
      });
      const rich = await newPartnerPerson(w, { grant: 10_000_000 });
      const sheltered: string[] = [];
      for (let i = 0; i < 26; i++) {
        const hold = await reserve(w, rich);
        sheltered.push(await partnerLaunch(w, hold, rich));
      }
      const rogue = await partnerLaunch(w, null, rich, { tags: [] });
      const swept = await sweepTenantJobs(fx.env(), "live");
      expect(swept).toMatchObject({ awaitingReport: 26, indexed: 1, cancelled: 1 });
      expect(fx.tapis.jobs.get(rogue)?.status).toBe("CANCELLED");
      for (const uuid of sheltered) expect(fx.tapis.jobs.get(uuid)?.status).toBe("PENDING");
    }, 120_000);

    test("a backlog the reaper has not drained extends the shelter, a tick for each 25 ahead; without one it ends at the hour", async () => {
      const { setPartnerPolicy } = await import("./helpers/compute-partner-world");
      await setPartnerPolicy(w.env().DB, fx.ownerId, {
        ...confirmedClients(),
        maxLiveJobsPerPerson: 100,
      });
      const rich = await newPartnerPerson(w, { grant: 10_000_000 });
      const target = await reserve(w, rich);
      const uuid = await partnerLaunch(w, target, rich);
      age(target, 95); // 65 minutes past its expiry: outside the hour
      expect((await sweepTenantJobs(fx.env(), "live"))?.awaitingReport).toBe(0);
      expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");

      // The same, behind 26 reservations that expired earlier and are still waiting for the reaper.
      await fx.reset();
      w = await buildPartnerWorld(fx);
      await setPartnerPolicy(w.env().DB, fx.ownerId, {
        ...confirmedClients(),
        maxLiveJobsPerPerson: 100,
      });
      const rich2 = await newPartnerPerson(w, { grant: 10_000_000 });
      for (let i = 0; i < 26; i++) age(await reserve(w, rich2), 100);
      const target2 = await reserve(w, rich2);
      const uuid2 = await partnerLaunch(w, target2, rich2);
      age(target2, 95);
      expect((await sweepTenantJobs(fx.env(), "live"))?.awaitingReport).toBe(1);
      expect(fx.tapis.jobs.get(uuid2)?.status).toBe("PENDING");
    }, 120_000);
  });

  test("idempotency keys older than seven days are deleted, a bounded batch a tick, and a fresh one stays (M3, Opus)", async () => {
    const insert = w.h.db.query(
      `INSERT INTO compute_idempotency_keys (scope, key, request_hash, job_id, created_at)
       VALUES ('client:prune', ?, ?, ?, datetime('now', ?))`,
    );
    const hash = "a".repeat(64);
    const job = `job_${"b".repeat(24)}`;
    for (let i = 0; i < 520; i++) insert.run(`old-${i}`, hash, job, "-8 days");
    insert.run("fresh", hash, job, "-6 days");
    const first = await reapExpiredHolds(production());
    expect(first?.pruned).toBe(500);
    const second = await reapExpiredHolds(production());
    expect(second?.pruned).toBe(20);
    const left = w.h.db.query("SELECT key FROM compute_idempotency_keys").all() as Array<{
      key: string;
    }>;
    expect(left.map((r) => r.key)).toEqual(["fresh"]);
  });

  test("a refusal whose cancel never takes is counted in cancel_pending_failed after an hour, and keeps its slot (M6, Sonnet)", async () => {
    const { countCancelPendingFailed } = await import("../src/services/compute-lifecycle");
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person, { owner: "someone-else" });
    fx.tapis.advance(uuid, "QUEUED");
    fx.tapis.advance(uuid, "RUNNING");
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 500, 1000);
    const res = await partnerCall(w, "POST", `/compute/jobs/${hold.job_id}/report`, {
      token: person.token,
      json: { tapis_job_id: uuid },
    });
    expect(res.json?.code).toBe("report_mismatch");
    expect(await countCancelPendingFailed(w.env().DB)).toBe(0);
    w.h.db
      .query(
        "UPDATE compute_jobs SET cancel_requested_at = datetime('now', '-61 minutes') WHERE id = ?",
      )
      .run(hold.job_id);
    expect(await countCancelPendingFailed(w.env().DB)).toBe(1);
    await reapExpiredHolds(production());
    // Still there: the slot is not released until a read shows the job over.
    expect(row(w, hold.job_id)).toMatchObject({ state: "created", partner_state: "mismatch" });
    expect(await countCancelPendingFailed(w.env().DB)).toBe(1);
    // A pending (unread) job has no cancel to carry out and is not counted.
    const second = await reserve(w, person);
    const u2 = await partnerLaunch(w, second, person);
    fx.tapis.down();
    await partnerCall(w, "POST", `/compute/jobs/${second.job_id}/report`, {
      token: person.token,
      json: { tapis_job_id: u2 },
    });
    fx.tapis.up();
    expect(await countCancelPendingFailed(w.env().DB)).toBe(1);
  });
});
