/**
 * The partner flow end to end (epic #2021 phase D4, #2025; the epic's definition of done): a test OPENID
 * CONNECT CLIENT, registered through the owner's route (the service `nemar admin oidc clients add` calls),
 * reserves compute time for a signed-in person, reports the Tapis job it launched and has the report
 * accepted; a report that does not match is refused, cancelled at the Tapis stand-in and flagged; a second
 * report that binds a different Tapis job to the same hold is refused; a suspended person's reserve is
 * refused with `suspended`; Tapis down at the report is 202 and the tick verifies it; a release; and the
 * reaper's five cases.
 *
 * The REAL Worker entry point (the middleware stack, the host and mount routing, the real compute router and
 * the real OpenID Connect provider) over real migrated SQLite, Miniflare's R2 through the Worker's own
 * bindings, the real local S3 interface and the Tapis stand-in of Epic A. Every credential is a real one: the
 * client from `POST /admin/oidc/clients`, a person's access token from the real authorization routes and
 * the real token endpoint. The partner's own Tapis job is submitted to the stand-in directly, with an owner,
 * tags and resources of the PARTNER's choosing. The Tapis stand-in and the S3 interface were built from
 * published specifications; no response of either was recorded from a real service, and whether the real
 * tenant lets NEMAR's service identity search other owners' jobs by tag is an owner item (the stand-in's
 * `shareJob` models the arrangement). Nothing stands in for a NEMAR decision.
 *
 * CI TIER: integration, like the other suites that start local servers.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { runComputeAdvanceCron } from "../backend/src/services/compute-advance";
import { reapExpiredHolds } from "../backend/src/services/compute-hold-reaper";
import {
  type LifecycleFixture,
  MINUTE,
  setTapisTimes,
  startLifecycleFixture,
} from "../backend/test/helpers/compute-lifecycle-fixture";
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
  tokenFor,
} from "../backend/test/helpers/compute-partner-world";
import { OWNER_KEY } from "../backend/test/helpers/oidc-harness";
import {
  COMPUTE_PARTNER_ERROR_STATUS,
  ComputePartnerHoldResponseSchema,
  ComputePartnerReleaseResponseSchema,
  ComputePartnerReportResponseSchema,
} from "../shared/contract/compute-partner";

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

const report = (jobId: string, body: unknown, who: PartnerPerson = person) =>
  partnerCall(w, "POST", `/compute/jobs/${jobId}/report`, { token: who.token, json: body });
const kinds = (id: string) => entries(w, id).map((e) => e.kind);
const own = (p: PartnerPerson = person) => poolOf(w, "account", String(p.id)) as Record<string, number>;
const age = (id: string, minutes: number) =>
  w.h.db
    .query("UPDATE compute_jobs SET created_at = datetime('now', ?) WHERE id = ?")
    .run(`-${minutes} minutes`, id);

describe("the partner's story", () => {
  test("reserves, reports and is accepted; the job runs, finishes and the person is charged what it used", async () => {
    const res = await partnerCall(w, "POST", "/compute/holds", {
      token: person.token,
      json: {
        app_id: "partner-app",
        app_version: "2.1.0",
        kind: "batch",
        partition: "shared",
        nodes: 1,
        cores: 4,
        memory_mb: 8000,
        gpus: 0,
        minutes: 60,
      },
    });
    expect(res.status).toBe(201);
    const hold = ComputePartnerHoldResponseSchema.parse(res.json);
    expect(own()).toMatchObject({ held_milli: 4000, charged_milli: 0 });

    const uuid = await partnerLaunch(w, hold as never, person);
    const reported = await report(hold.job_id, { tapis_job_id: uuid });
    expect(reported.status).toBe(200);
    expect(ComputePartnerReportResponseSchema.parse(reported.json).verification).toBe("verified");
    // Accepted: bound, verified, followed from here on by the ordinary lifecycle.
    expect(row(w, hold.job_id)).toMatchObject({
      tapis_uuid: uuid,
      partner_state: "verified",
      state: "submitted",
    });
    expect(fx.tapis.subscriptions).toHaveLength(1);

    fx.tapis.advance(uuid, "QUEUED");
    fx.tapis.advance(uuid, "RUNNING");
    fx.tapis.advance(uuid, "FINISHED");
    setTapisTimes(fx, uuid, 30 * MINUTE, 0);
    await runComputeAdvanceCron(fx.env());
    expect(row(w, hold.job_id).state).toBe("finished");
    expect(kinds(hold.job_id)).toEqual(["hold", "charge"]);
    expect(own().held_milli).toBe(0);
    expect(own().charged_milli).toBeGreaterThanOrEqual(2000);
    expect(own().charged_milli).toBeLessThan(2100);

    // The person reads it back with a compute.read token of the same client.
    const readToken = await tokenFor(w, person, "openid compute.read");
    const view = await w.h.call("GET", `/compute/me/jobs/${hold.job_id}`, { key: readToken });
    expect((view.json as { job: Record<string, unknown> }).job).toMatchObject({
      state: "finished",
      source: "partner",
    });
  });

  test("a second report that binds a different Tapis job to the same hold is refused 409 already_bound", async () => {
    const hold = await reserve(w, person);
    const first = await partnerLaunch(w, hold, person);
    const second = await partnerLaunch(w, hold, person);
    expect((await report(hold.job_id, { tapis_job_id: first })).status).toBe(200);
    const res = await report(hold.job_id, { tapis_job_id: second });
    expect([res.status, res.json?.code]).toEqual([409, "already_bound"]);
    expect(row(w, hold.job_id).tapis_uuid).toBe(first);
    expect(fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/:uuid/cancel")).toHaveLength(0);
  });

  test("a report whose owner, application or resources do not match is refused, cancelled at Tapis and flagged with an overrun", async () => {
    const wrongs: Array<[Record<string, unknown>, string]> = [
      [{ owner: "someone-else" }, "owner_mismatch"],
      [{ appId: "another-app" }, "app_mismatch"],
      [{ nodes: 3, cores: 16 }, "resources_mismatch"],
    ];
    for (const [launch, word] of wrongs) {
      const hold = await reserve(w, person);
      const uuid = await partnerLaunch(w, hold, person, launch);
      fx.tapis.advance(uuid, "QUEUED");
      fx.tapis.advance(uuid, "RUNNING");
      setTapisTimes(fx, uuid, 30 * MINUTE, null);
      const res = await report(hold.job_id, { tapis_job_id: uuid });
      expect([word, res.status, res.json?.code, res.json?.mismatch]).toEqual([
        word,
        COMPUTE_PARTNER_ERROR_STATUS.report_mismatch,
        "report_mismatch",
        word,
      ]);
      expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
      expect(row(w, hold.job_id)).toMatchObject({
        state: "cancelled",
        partner_flag: word,
        flag_mismatch: 1,
        flag_overrun: 1,
      });
      expect(kinds(hold.job_id)).toEqual(["hold", "release", "overrun"]);
    }
    // The person was charged for none of it.
    expect(own()).toMatchObject({ held_milli: 0, charged_milli: 0 });
    expect((poolOf(w, "partner", "tenant") as Record<string, number>).charged_milli).toBeGreaterThan(0);
  });

  test("a suspended person's reserve is refused with `suspended`", async () => {
    const decided = await w.h.call("POST", `/admin/compute/access/suspend/by-id/${person.id}`, {
      key: OWNER_KEY,
      body: { reason: "e2e" },
    });
    expect(decided.status).toBe(200);
    // Signing in does not need compute access, so the person has a fresh token; the reserve is refused by state.
    const token = await tokenFor(w, person, "openid compute.reserve");
    const res = await partnerCall(w, "POST", "/compute/holds", {
      token,
      json: { app_id: "partner-app", app_version: "2.1.0", kind: "batch", partition: "shared", nodes: 1, cores: 4, gpus: 0, minutes: 60 },
    });
    expect([res.status, res.json?.code]).toEqual([403, "suspended"]);
    expect(
      (w.h.db.query("SELECT COUNT(*) AS n FROM compute_jobs WHERE source = 'partner'").get() as { n: number }).n,
    ).toBe(0);
  });

  test("Tapis down at the report: 202 pending, then verified by the tick", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    fx.tapis.down();
    const res = await report(hold.job_id, { tapis_job_id: uuid });
    expect(res.status).toBe(202);
    expect(ComputePartnerReportResponseSchema.parse(res.json).verification).toBe("pending");
    expect(kinds(hold.job_id)).toEqual(["hold"]);
    fx.tapis.up();
    const tick = await reapExpiredHolds(fx.env());
    expect(tick).toMatchObject({ pending: 1, verified: 1 });
    expect(row(w, hold.job_id)).toMatchObject({ partner_state: "verified", state: "submitted" });
    const again = await report(hold.job_id, { tapis_job_id: uuid });
    expect(again.status).toBe(200);
  });

  test("DELETE releases an unreported reservation, and a bound one is hold_bound", async () => {
    const free = await reserve(w, person);
    const released = await partnerCall(w, "DELETE", `/compute/holds/${free.hold_id}`, {
      token: person.token,
    });
    expect(released.status).toBe(200);
    expect(ComputePartnerReleaseResponseSchema.parse(released.json).released).toBe(true);
    expect(kinds(free.job_id)).toEqual(["hold", "release"]);

    const bound = await reserve(w, person);
    const uuid = await partnerLaunch(w, bound, person);
    expect((await report(bound.job_id, { tapis_job_id: uuid })).status).toBe(200);
    const refused = await partnerCall(w, "DELETE", `/compute/holds/${bound.hold_id}`, {
      token: person.token,
    });
    expect([refused.status, refused.json?.code]).toEqual([409, "hold_bound"]);
  });
});

describe("the reaper's cases", () => {
  test("found: a job under the tag that is the person's and matches is bound and verified", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    age(hold.job_id, 31);
    expect(await reapExpiredHolds(fx.env())).toMatchObject({ adopted: 1, verified: 1, released: 0 });
    expect(row(w, hold.job_id)).toMatchObject({ tapis_uuid: uuid, partner_state: "verified" });
  });

  test("not found, affirmatively: released with an `expired` entry", async () => {
    const hold = await reserve(w, person);
    age(hold.job_id, 31);
    expect(await reapExpiredHolds(fx.env())).toMatchObject({ released: 1 });
    expect(entries(w, hold.job_id)[1]).toMatchObject({ kind: "release", reason: "expired" });
    expect(own().held_milli).toBe(0);
  });

  test("a Tapis 500: the hold is KEPT, nothing is released on an error", async () => {
    const hold = await reserve(w, person);
    age(hold.job_id, 31);
    fx.tapis.fail("POST /v3/jobs/search", 500, 2);
    expect(await reapExpiredHolds(fx.env())).toMatchObject({ unreachable: 1, released: 0 });
    expect(row(w, hold.job_id)).toMatchObject({ state: "created", partner_flag: "tapis_unreachable" });
    expect(kinds(hold.job_id)).toEqual(["hold"]);
  });

  test("several under one tag: `ambiguous_tag`, the hold kept", async () => {
    const hold = await reserve(w, person);
    await partnerLaunch(w, hold, person);
    await partnerLaunch(w, hold, person);
    age(hold.job_id, 31);
    expect(await reapExpiredHolds(fx.env())).toMatchObject({ ambiguous: 1, released: 0 });
    expect(row(w, hold.job_id)).toMatchObject({ partner_flag: "ambiguous_tag", state: "created" });
  });

  test("another owner: the mismatch path", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person, { owner: "someone-else" });
    age(hold.job_id, 31);
    expect(await reapExpiredHolds(fx.env())).toMatchObject({ adopted: 1, refused: 1, ended: 1 });
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
    expect(row(w, hold.job_id)).toMatchObject({ partner_flag: "owner_mismatch", state: "cancelled" });
  });
});
