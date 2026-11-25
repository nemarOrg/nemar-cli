/**
 * `POST /compute/jobs/:id/report` (epic #2021 phase D4, #2025; ADR 0118, the amendment of this phase), through
 * the REAL Worker, a partner client registered by the owner's route, the Tapis stand-in of Epic A (the
 * partner's own job is submitted to it directly, with an owner, tags and resources of the PARTNER'S
 * choosing: the whole point) and Miniflare's R2.
 *
 * THE RULE UNDER TEST: only the bound uuid and NEMAR's own read of that Tapis job prove what ran. The
 * Tapis `owner` and the tag prove nothing alone. No path charges a person for a job NEMAR has not bound AND
 * verified; a mismatch is cancelled at Tapis, flagged, audited, and charged to the partner's pool.
 *
 * What is pinned:
 *  1. A MATCH. 200 `verified`: bound, `submitted`, NEMAR's webhook subscribed once, the hold untouched
 *     and nothing charged; then the job lives the ordinary life (the tick reads it back, a Tapis FINISHED
 *     stands without launcher documents, the person is charged what it used and not mailed results).
 *  2. A REPEAT IS A REPLAY (the same uuid, another key); a second uuid is 409 `already_bound`; a uuid bound
 *     to another reservation is 409 `tapis_job_in_use`; so is a job NEMAR itself submitted, a job owned by the
 *     NEMAR service identity, and a job that names another NEMAR job in its tags - none of them bound or
 *     cancelled on a partner's word.
 *  3. EACH MISMATCH (the owner, the application, the version, the queue, nodes, cores, minutes, memory, a
 *     price above the hold): 409 `report_mismatch` naming the word; the Tapis job is CANCELLED at the stand-in;
 *     the hold is RELEASED; what ran is an `overrun` of the partner pool `tenant`, NEVER the person's; the row
 *     is flagged `mismatch`; one audit row; the person's job view reads 0 charged and the ACCESS report owes
 *     no pseudonym. A job that never ran is released with no charge.
 *  4. TAPIS DOWN: 202 `pending`, bound, nothing charged, left alone by every generic path; the tick verifies
 *     it (or refuses it) once Tapis answers; a uuid Tapis does not have is 422 and binds nothing.
 *  5. A LATE REPORT: after a release, after the person's cancel, and after the person's compute ended.
 *  6. FILES: judged before anything is bound (traversal in any encoding, too many, too large, a bad digest);
 *     addresses to `incoming/<id>/<path>` for a verified or pending job; copied into `records/<id>/submitted/`
 *     ONLY after the match, once each, by the same report again; a mismatch and a pending job leave no object
 *     in `records/<id>/submitted/`.
 *
 * MUTATIONS (each applied, run, restored): skip the Tapis cancel on a mismatch; copy the files before the
 * verification; charge the person's pool for a mismatch; drop the owner check; drop the NEMAR-identity guard;
 * bind without the unique index's refusal; drop the price check; let `finalizeSubmittedFiles` run for an
 * unverified job.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { runComputeAdvanceCron } from "../src/services/compute-advance";
import { reapExpiredHolds } from "../src/services/compute-hold-reaper";
import { advanceComputeJob } from "../src/services/compute-lifecycle";
import {
  type LifecycleFixture,
  MINUTE,
  makeJob,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import {
  type DbRow,
  type Hold,
  type PartnerPerson,
  type PartnerWorld,
  type ReportUpload,
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

const report = (hold: Hold, body: unknown, who: PartnerPerson = person, key?: string | null) =>
  partnerCall(w, "POST", `/compute/jobs/${hold.job_id}/report`, {
    token: who.token,
    json: body,
    key,
  });

const cancels = () => fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/:uuid/cancel");
const subscriptions = () => fx.tapis.subscriptions.length;
const kinds = (id: string) => entries(w, id).map((e) => e.kind);
const count = (table: string) =>
  (w.h.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const tenant = () => poolOf(w, "partner", "tenant") as Record<string, number> | null;
const own = (p: PartnerPerson = person) =>
  poolOf(w, "account", String(p.id)) as Record<string, number>;

/** Make a partner job RUN for 30 minutes on its four cores (2 SU) at the stand-in. */
function run30(uuid: string, ended = false) {
  fx.tapis.advance(uuid, "QUEUED");
  fx.tapis.advance(uuid, "RUNNING");
  if (ended) fx.tapis.advance(uuid, "FINISHED");
  setTapisTimes(fx, uuid, 30 * MINUTE, ended ? 0 : null);
}

describe("a report that matches", () => {
  test("binds, verifies, subscribes NEMAR's webhook once and charges nothing beyond the hold", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    const res = await report(hold, { tapis_job_id: uuid });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      job_id: hold.job_id,
      verification: "verified",
      state: "submitted",
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(row(w, hold.job_id)).toMatchObject({
      tapis_uuid: uuid,
      partner_state: "verified",
      partner_flag: null,
      state: "submitted",
      tapis_status: "PENDING",
      held_milli: 4000,
      charged_milli: 0,
      flag_mismatch: 0,
    });
    expect(row(w, hold.job_id).partner_verified_at).not.toBeNull();
    expect(kinds(hold.job_id)).toEqual(["hold"]);
    expect(own()).toMatchObject({ held_milli: 4000, charged_milli: 0 });
    // NEMAR's own hint address, once; nothing was cancelled.
    expect(subscriptions()).toBe(1);
    expect(fx.tapis.subscriptions[0]?.address).toContain(`/webhooks/tapis/${hold.job_id}/`);
    expect(cancels()).toHaveLength(0);
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("PENDING");
  });

  test("then lives the ordinary life: the tick follows it, a Tapis FINISHED stands with no launcher documents, the person pays what it used", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    expect((await report(hold, { tapis_job_id: uuid })).status).toBe(200);
    run30(uuid, true);
    const tick = await runComputeAdvanceCron(fx.env());
    expect(tick?.errors).toEqual([]);
    expect(row(w, hold.job_id)).toMatchObject({
      state: "finished",
      failure_code: null,
      platform_failure: 0,
    });
    expect(kinds(hold.job_id)).toEqual(["hold", "charge"]);
    // 30 minutes of four cores is 2 SU, charged to the PERSON's pool and counted against the people budget.
    expect(row(w, hold.job_id).charged_milli).toBeGreaterThanOrEqual(2000);
    expect(row(w, hold.job_id).charged_milli).toBeLessThan(2100);
    expect(own().charged_milli).toBe(row(w, hold.job_id).charged_milli);
    expect(own().held_milli).toBe(0);
    expect(fx.mail.mails.filter((m) => /result/i.test(m.subject))).toEqual([]);
  });

  test("the report is a replay for the same uuid under another key, and subscribes nothing twice", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    expect((await report(hold, { tapis_job_id: uuid })).status).toBe(200);
    const before = [count("compute_ledger"), subscriptions()];
    const again = await report(hold, { tapis_job_id: uuid });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ verification: "verified" });
    expect(again.json?.replayed).toBeUndefined();
    // The very same request (same key) is the replay NEMAR says so for.
    const keyed = await report(hold, { tapis_job_id: uuid }, person, "fixed-report-key");
    const keyedAgain = await report(hold, { tapis_job_id: uuid }, person, "fixed-report-key");
    expect([keyed.status, keyedAgain.status]).toEqual([200, 200]);
    expect(keyedAgain.json?.replayed).toBe(true);
    expect([count("compute_ledger"), subscriptions()]).toEqual(before);
  });

  test("the same key for another uuid is 422 idempotency_conflict", async () => {
    const hold = await reserve(w, person);
    const a = await partnerLaunch(w, hold, person);
    const b = await partnerLaunch(w, hold, person);
    expect((await report(hold, { tapis_job_id: a }, person, "one-key-1")).status).toBe(200);
    const res = await report(hold, { tapis_job_id: b }, person, "one-key-1");
    expect([res.status, res.json?.code]).toEqual([422, "idempotency_conflict"]);
  });
});

describe("one Tapis job per reservation, and no Tapis job that is already accounted for", () => {
  test("a second uuid is 409 already_bound and the second Tapis job is not touched", async () => {
    const hold = await reserve(w, person);
    const first = await partnerLaunch(w, hold, person);
    const second = await partnerLaunch(w, hold, person);
    expect((await report(hold, { tapis_job_id: first })).status).toBe(200);
    const before = JSON.stringify(row(w, hold.job_id));
    const res = await report(hold, { tapis_job_id: second });
    expect([res.status, res.json?.code]).toEqual([409, "already_bound"]);
    expect(JSON.stringify(row(w, hold.job_id))).toBe(before);
    expect(cancels()).toHaveLength(0);
    expect(row(w, hold.job_id).tapis_uuid).toBe(first);
  });

  test("the same uuid on a second reservation is 409 tapis_job_in_use, whoever holds it", async () => {
    const hold = await reserve(w, person);
    const other = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    expect((await report(hold, { tapis_job_id: uuid })).status).toBe(200);
    const res = await report(other, { tapis_job_id: uuid });
    expect([res.status, res.json?.code]).toEqual([409, "tapis_job_in_use"]);
    expect(row(w, other.job_id)).toMatchObject({
      tapis_uuid: null,
      partner_state: null,
      state: "created",
    });
    expect(row(w, hold.job_id).tapis_uuid).toBe(uuid);
    expect(cancels()).toHaveLength(0);
  });

  test("two reservations racing to report ONE uuid: one binds, the other is tapis_job_in_use (the unique index decides)", async () => {
    const a = await reserve(w, person);
    const b = await reserve(w, person);
    const uuid = await partnerLaunch(w, a, person);
    const [x, y] = await Promise.all([
      report(a, { tapis_job_id: uuid }),
      report(b, { tapis_job_id: uuid }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect([x, y].find((r) => r.status === 409)?.json?.code).toBe("tapis_job_in_use");
    expect(
      (
        w.h.db.query("SELECT COUNT(*) AS n FROM compute_jobs WHERE tapis_uuid = ?").get(uuid) as {
          n: number;
        }
      ).n,
    ).toBe(1);
    expect(cancels()).toHaveLength(0);
  });

  test("a uuid bound to another reservation between the pre-check and the bind is tapis_job_in_use (the unique index is the backstop)", async () => {
    // The race a pre-check cannot close: another request binds this uuid to reservation A AFTER b's request
    // read that nobody holds it and BEFORE its bind. A trigger on b's bind plays that other request (it
    // binds A first, inside b's own statement), so the unique index is what refuses b.
    const a = await reserve(w, person);
    const b = await reserve(w, person);
    const uuid = await partnerLaunch(w, b, person);
    w.h.db.exec(`CREATE TRIGGER test_other_request BEFORE UPDATE OF tapis_uuid ON compute_jobs
      WHEN NEW.id = '${b.job_id}' AND OLD.tapis_uuid IS NULL AND NEW.tapis_uuid IS NOT NULL
      BEGIN UPDATE compute_jobs SET tapis_uuid = NEW.tapis_uuid WHERE id = '${a.job_id}'; END;`);
    const res = await report(b, { tapis_job_id: uuid });
    w.h.db.exec("DROP TRIGGER test_other_request");
    expect([res.status, res.json?.code]).toEqual([409, "tapis_job_in_use"]);
    expect(row(w, b.job_id)).toMatchObject({
      tapis_uuid: null,
      partner_state: null,
      state: "created",
    });
    expect(cancels()).toHaveLength(0);
  });

  test("a job NEMAR itself submitted is tapis_job_in_use, and is neither bound nor cancelled", async () => {
    const hold = await reserve(w, person);
    const made = await makeJob(fx, { account: { status: "approved" } });
    const advanced = await advanceComputeJob(fx.env(), made.job.id);
    const nemars = advanced.job?.tapis_uuid as string;
    expect(nemars).toBeTruthy();
    const res = await report(hold, { tapis_job_id: nemars });
    expect([res.status, res.json?.code]).toEqual([409, "tapis_job_in_use"]);
    expect(row(w, hold.job_id)).toMatchObject({ tapis_uuid: null, partner_state: null });
    expect(cancels()).toHaveLength(0);
    expect(fx.tapis.jobs.get(nemars)?.status).not.toBe("CANCELLED");
    expect(row(w, made.job.id).tapis_uuid).toBe(nemars);
  });

  test("a job owned by the NEMAR service identity, or naming another NEMAR job in its tags, is never the partner's to report", async () => {
    const hold = await reserve(w, person);
    const service = await partnerLaunch(w, null, null, { owner: fx.tapis.username, tags: [] });
    const tagged = await partnerLaunch(w, null, person, {
      tags: [hold.tag, "nemar_job:job_000000000000000000000abc"],
    });
    for (const uuid of [service, tagged]) {
      const res = await report(hold, { tapis_job_id: uuid });
      expect([uuid === service ? "service" : "tagged", res.status, res.json?.code]).toEqual([
        uuid === service ? "service" : "tagged",
        409,
        "tapis_job_in_use",
      ]);
    }
    expect(row(w, hold.job_id)).toMatchObject({ tapis_uuid: null, partner_state: null });
    expect(cancels()).toHaveLength(0);
  });

  test("a uuid Tapis does not have is 422 tapis_job_not_found and binds nothing", async () => {
    const hold = await reserve(w, person);
    const res = await report(hold, { tapis_job_id: "00000000-0000-0000-0000-000000000000-007" });
    expect([res.status, res.json?.code]).toEqual([422, "tapis_job_not_found"]);
    expect(row(w, hold.job_id)).toMatchObject({ tapis_uuid: null, partner_state: null });
  });

  test("a body that is not exactly { tapis_job_id, files? } is invalid_spec", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    for (const [body, field] of [
      [{}, "tapis_job_id"],
      [{ tapis_job_id: "a b" }, "tapis_job_id"],
      [{ tapis_job_id: uuid, extra: 1 }, "body"],
      [{ tapis_job_id: uuid, files: [] }, "files"],
      [{ tapis_job_id: uuid, files: [{ path: "a", size: 1 }] }, "files.0.sha256"],
      ["nope", "body"],
    ] as const) {
      const res = await report(hold, body);
      expect([JSON.stringify(body), res.status, res.json?.code, res.json?.field]).toEqual([
        JSON.stringify(body),
        400,
        "invalid_spec",
        field,
      ]);
    }
    expect(row(w, hold.job_id).tapis_uuid).toBeNull();
  });
});

describe("a report that does not match is cancelled, flagged and charged to the partner", () => {
  /** Each mismatch: what the partner launched, and the word NEMAR answers. */
  const CASES: Array<[string, Record<string, unknown>, string]> = [
    ["owner", { owner: `nmu_${"f".repeat(32)}` }, "owner_mismatch"],
    ["application", { appId: "another-app" }, "app_mismatch"],
    ["version", { appVersion: "9.9.9" }, "app_mismatch"],
    ["queue", { queue: "compute" }, "resources_mismatch"],
    ["nodes", { nodes: 2 }, "resources_mismatch"],
    ["cores", { cores: 8 }, "resources_mismatch"],
    ["minutes", { maxMinutes: 120 }, "resources_mismatch"],
    ["memory", { memoryMB: 64_000 }, "resources_mismatch"],
  ];

  for (const [name, launch, word] of CASES) {
    test(`${name}: ${word}, cancelled at Tapis, the hold released, nobody charged but the partner`, async () => {
      const hold = await reserve(w, person);
      const uuid = await partnerLaunch(w, hold, person, launch);
      // It has been running for 30 minutes by the time NEMAR looks.
      run30(uuid);
      const res = await report(hold, { tapis_job_id: uuid });
      expect([name, res.status, res.json?.code, res.json?.mismatch]).toEqual([
        name,
        409,
        "report_mismatch",
        word,
      ]);
      expect(res.json?.job_id).toBe(hold.job_id);
      // CANCELLED at the stand-in, once.
      expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
      expect(cancels()).toHaveLength(1);
      const job = row(w, hold.job_id);
      expect(job).toMatchObject({
        state: "cancelled",
        partner_state: "mismatch",
        partner_flag: word,
        flag_mismatch: 1,
        cancel_reason: "unreserved",
        // The person is not proven to have run it, and is charged nothing for it.
        gateway_user: null,
        charged_milli: 0,
        tapis_uuid: uuid,
      });
      expect(job.settled_provisional_at).not.toBeNull();
      // The hold was RELEASED in full; what ran is an overrun of the partner pool, counted against the budget.
      expect(kinds(hold.job_id)).toEqual(["hold", "release", "overrun"]);
      const overrun = entries(w, hold.job_id)[2] as DbRow;
      expect(overrun).toMatchObject({
        reason: "unreserved_usage",
        idempotency_key: `job:${hold.job_id}:unreserved`,
      });
      expect(overrun.charged_delta_milli).toBeGreaterThanOrEqual(1000);
      expect((tenant() as Record<string, number>).charged_milli).toBe(overrun.charged_delta_milli);
      expect(own()).toMatchObject({ held_milli: 0, charged_milli: 0 });
      expect(job.flag_overrun).toBe(1);
      // One audit row, with the word and nothing the partner sent.
      const audit = w.h.db
        .query(
          "SELECT details FROM audit_log WHERE action = 'compute.partner.mismatch' AND resource_id = ?",
        )
        .all(hold.job_id) as Array<{ details: string }>;
      expect(audit).toHaveLength(1);
      expect(JSON.parse(audit[0]?.details as string)).toEqual({
        flag: word,
        client: w.client.clientId,
        partition: "shared",
      });
    });
  }

  test("memory above what the hold PRICED is a mismatch even when the hold named no memory (the price check is its own term)", async () => {
    // The reservation names no memory, so there is no per-dimension memory bound: a partition priced by
    // memory is guarded only by pricing the record's resources against the hold.
    const hold = await reserve(w, person, { memory_mb: null });
    const uuid = await partnerLaunch(w, hold, person, { memoryMB: 64_000 });
    const res = await report(hold, { tapis_job_id: uuid });
    expect([res.status, res.json?.mismatch]).toEqual([409, "resources_mismatch"]);
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
  });

  test("an administrator is shown the partner words and the flags of a refused job", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person, { appVersion: "9.9.9" });
    await report(hold, { tapis_job_id: uuid });
    const { OWNER_KEY } = await import("./helpers/oidc-harness");
    const shown = await w.h.call("POST", `/admin/compute/jobs/${hold.job_id}/advance`, {
      key: OWNER_KEY,
      body: {},
    });
    expect(shown.status).toBe(200);
    expect((shown.json as { job: Record<string, unknown> }).job).toMatchObject({
      state: "cancelled",
      partner_state: "mismatch",
      partner_flag: "app_mismatch",
      flags: ["mismatch"],
      charged_milli: 0,
    });
    const listed = await w.h.call("GET", "/admin/compute/jobs?flag=mismatch", { key: OWNER_KEY });
    expect(JSON.stringify(listed.json)).toContain(hold.job_id);
  });

  test("a job that never ran is released with no charge at all", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person, { appId: "another-app" });
    const res = await report(hold, { tapis_job_id: uuid });
    expect([res.status, res.json?.mismatch]).toEqual([409, "app_mismatch"]);
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
    expect(kinds(hold.job_id)).toEqual(["hold", "release"]);
    expect(tenant()?.charged_milli ?? 0).toBe(0);
    expect(own()).toMatchObject({ held_milli: 0, charged_milli: 0 });
  });

  test("the refusal is repeated, not redone: the same report again is the same 409 and cancels nothing more", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person, { owner: "someone-else" });
    run30(uuid);
    const first = await report(hold, { tapis_job_id: uuid });
    const before = [count("compute_ledger"), cancels().length];
    const again = await report(hold, { tapis_job_id: uuid });
    expect([first.status, again.status]).toEqual([409, 409]);
    expect(again.json?.mismatch).toBe("owner_mismatch");
    expect([count("compute_ledger"), cancels().length]).toEqual(before);
  });

  test("a person's job view reads 0 charged for a refused job", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person, { cores: 8 });
    run30(uuid);
    await report(hold, { tapis_job_id: uuid });
    const readToken = await (await import("./helpers/compute-partner-world")).tokenFor(
      w,
      person,
      "openid compute.read",
    );
    const view = await w.h.call("GET", `/compute/me/jobs/${hold.job_id}`, { key: readToken });
    expect(view.status).toBe(200);
    expect((view.json as { job: Record<string, unknown> }).job).toMatchObject({
      state: "cancelled",
      charged_milli: 0,
    });
    const me = await w.h.call("GET", "/compute/me", { key: readToken });
    const cpu = (me.json as { pools: { cpu: { charged_milli: number; held_milli: number } } }).pools
      .cpu;
    expect([cpu.charged_milli, cpu.held_milli]).toEqual([0, 0]);
  });

  test("a mismatch is never a charge to the person, however long it ran: the partner pool takes the whole overrun", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person, { nodes: 2, cores: 8 });
    run30(uuid);
    await report(hold, { tapis_job_id: uuid });
    // Two nodes of eight cores for 30 minutes is 8 SU: above the 4 SU hold, and still the partner's.
    expect((tenant() as Record<string, number>).charged_milli).toBeGreaterThanOrEqual(8000);
    expect(own().charged_milli).toBe(0);
    const people = poolOf(w, "platform", "people") as Record<string, number>;
    expect(people.charged_milli).toBe((tenant() as Record<string, number>).charged_milli);
  });
});

describe("Tapis cannot be read at the report", () => {
  test("202 pending: bound, nothing charged, every generic path leaves it alone; the tick verifies it", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    fx.tapis.down();
    const res = await report(hold, { tapis_job_id: uuid });
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ verification: "pending", state: "created" });
    expect(row(w, hold.job_id)).toMatchObject({
      tapis_uuid: uuid,
      partner_state: "pending",
      state: "created",
    });
    expect(kinds(hold.job_id)).toEqual(["hold"]);
    expect(subscriptions()).toBe(0);
    fx.tapis.up();
    // The generic lists do not take it: the tick, an advance and the cancel sweep read nothing of it.
    run30(uuid, true);
    await runComputeAdvanceCron(fx.env());
    const advanced = await advanceComputeJob(fx.env(), hold.job_id);
    expect(advanced.outcome).toBe("nothing_to_do");
    expect(row(w, hold.job_id)).toMatchObject({
      partner_state: "pending",
      state: "created",
      charged_milli: 0,
    });
    expect(kinds(hold.job_id)).toEqual(["hold"]);
    // The hold reaper's tick verifies it.
    const reaped = await reapExpiredHolds(fx.env());
    expect(reaped).toMatchObject({ pending: 1, verified: 1, errors: [] });
    expect(row(w, hold.job_id)).toMatchObject({ partner_state: "verified", state: "submitted" });
    expect(subscriptions()).toBe(1);
    // Now it is an ordinary job: the next tick settles it.
    await runComputeAdvanceCron(fx.env());
    expect(row(w, hold.job_id)).toMatchObject({ state: "finished" });
    expect(kinds(hold.job_id)).toEqual(["hold", "charge"]);
  });

  test("the tick refuses a pending job that does not match, cancels it and charges the partner", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person, { owner: "someone-else" });
    run30(uuid);
    fx.tapis.down();
    expect((await report(hold, { tapis_job_id: uuid })).status).toBe(202);
    fx.tapis.up();
    const reaped = await reapExpiredHolds(fx.env());
    expect(reaped).toMatchObject({ pending: 1, refused: 1, ended: 1, errors: [] });
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
    expect(row(w, hold.job_id)).toMatchObject({
      state: "cancelled",
      partner_state: "mismatch",
      partner_flag: "owner_mismatch",
    });
    expect(kinds(hold.job_id)).toEqual(["hold", "release", "overrun"]);
    expect(own().charged_milli).toBe(0);
  });

  test("a refusal whose cancel Tapis does not take is KEPT and retried; nothing is released on an error", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person, { owner: "someone-else" });
    run30(uuid);
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 500, 1);
    const res = await report(hold, { tapis_job_id: uuid });
    expect([res.status, res.json?.code]).toEqual([409, "report_mismatch"]);
    // The job is still running at Tapis, so the row is kept whole: the hold stays, nothing is charged.
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("RUNNING");
    expect(row(w, hold.job_id)).toMatchObject({ state: "created", partner_state: "mismatch" });
    expect(kinds(hold.job_id)).toEqual(["hold"]);
    // The next tick asks again and finishes it.
    const reaped = await reapExpiredHolds(fx.env());
    expect(reaped?.mismatches).toBe(1);
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
    expect(row(w, hold.job_id).state).toBe("cancelled");
    expect(kinds(hold.job_id)).toEqual(["hold", "release", "overrun"]);
  });
});

describe("a late report", () => {
  test("after a release is 409 hold_released, binds nothing, and the Tapis job it names is the sweep's", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    const released = await partnerCall(w, "DELETE", `/compute/holds/${hold.hold_id}`, {
      token: person.token,
    });
    expect(released.status).toBe(200);
    const res = await report(hold, { tapis_job_id: uuid });
    expect([res.status, res.json?.code]).toEqual([409, "hold_released"]);
    expect(row(w, hold.job_id)).toMatchObject({ tapis_uuid: null, state: "cancelled" });
    expect(kinds(hold.job_id)).toEqual(["hold", "release"]);
    expect(cancels()).toHaveLength(0);
  });

  test("after the person's own cancel is 409 hold_cancelled", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    w.h.db
      .query(
        "UPDATE compute_jobs SET cancel_requested_at = datetime('now'), cancel_reason = 'user' WHERE id = ?",
      )
      .run(hold.job_id);
    const res = await report(hold, { tapis_job_id: uuid });
    expect([res.status, res.json?.code]).toEqual([409, "hold_cancelled"]);
    expect(row(w, hold.job_id).tapis_uuid).toBeNull();
  });

  test("after the person's compute ended is suspended or no_compute_access, and binds nothing", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    w.h.db.query("UPDATE users SET compute_access = 'suspended' WHERE id = ?").run(person.id);
    const paused = await report(hold, { tapis_job_id: uuid });
    expect([paused.status, paused.json?.code]).toEqual([403, "suspended"]);
    w.h.db.query("UPDATE users SET compute_access = 'revoked' WHERE id = ?").run(person.id);
    const revoked = await report(hold, { tapis_job_id: uuid });
    expect([revoked.status, revoked.json?.code]).toEqual([403, "no_compute_access"]);
    expect(row(w, hold.job_id)).toMatchObject({ tapis_uuid: null, partner_state: null });
  });

  test("the bind itself refuses a person whose compute ended after the route read it (the guard is in the statement)", async () => {
    const { BIND_REPORT_SQL } = await import("../src/services/compute-partner");
    const hold = await reserve(w, person);
    w.h.db.query("UPDATE users SET compute_access = 'suspended' WHERE id = ?").run(person.id);
    const bound = await w
      .env()
      .DB.prepare(BIND_REPORT_SQL)
      .bind(hold.job_id, "some-uuid-1", null)
      .run();
    expect(bound.meta?.changes).toBe(0);
    expect(row(w, hold.job_id).tapis_uuid).toBeNull();
  });
});

describe("a report's files", () => {
  const FILES = [
    { path: "params.json", body: '{"a":1}' },
    { path: "src/run.py", body: "print('hi')\n" },
  ];
  const declared = () =>
    FILES.map((f) => ({
      path: f.path,
      size: f.body.length,
      sha256: new Bun.CryptoHasher("sha256").update(f.body).digest("hex"),
    }));
  const submittedKeys = async (id: string) =>
    (await fx.harness.keys(fx.harness.records)).filter((k) =>
      k.startsWith(`records/${id}/submitted/`),
    );

  async function putAll(
    uploads: Array<{ path: string; url: string; headers: Record<string, string> }>,
  ) {
    for (const u of uploads) {
      const f = FILES.find((x) => x.path === u.path) as (typeof FILES)[number];
      const put = await fetch(u.url, { method: "PUT", headers: u.headers, body: f.body });
      expect([u.path, put.status]).toEqual([u.path, 200]);
    }
  }

  test("are addressed after the match, copied into the record ONLY when uploaded and the same report is sent again", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    const first = await report(hold, { tapis_job_id: uuid, files: declared() });
    expect(first.status).toBe(200);
    const files = (first.json as { files: { state: string; uploads: ReportUpload[] } }).files;
    expect(files.state).toBe("awaiting_upload");
    expect(files.uploads.map((u) => u.path)).toEqual(FILES.map((f) => f.path));
    for (const u of files.uploads) {
      expect(new URL(u.url).pathname).toContain(`/incoming/${hold.job_id}/${u.path}`);
    }
    expect(await submittedKeys(hold.job_id)).toEqual([]);
    await putAll(files.uploads);
    // Uploaded to incoming/, still not in the record.
    expect(await submittedKeys(hold.job_id)).toEqual([]);
    const second = await report(hold, { tapis_job_id: uuid, files: declared() });
    expect(second.status).toBe(200);
    expect((second.json as { files: { state: string } }).files.state).toBe("recorded");
    expect(await submittedKeys(hold.job_id)).toEqual(
      FILES.map((f) => `records/${hold.job_id}/submitted/${f.path}`).sort(),
    );
    for (const f of FILES) {
      const o = await fx.harness.records.get(`records/${hold.job_id}/submitted/${f.path}`);
      expect(await o?.text()).toBe(f.body);
    }
    expect(row(w, hold.job_id).records_written_at).not.toBeNull();
    // One server-side copy for each file, once.
    const copiesOf = () => fx.harness.standin.log.filter((r) => r.op === "CopyObject");
    expect(copiesOf()).toHaveLength(FILES.length);
    // A third time changes nothing and says recorded.
    const third = await report(hold, { tapis_job_id: uuid, files: declared() });
    expect((third.json as { files: { state: string } }).files.state).toBe("recorded");
    expect(copiesOf()).toHaveLength(FILES.length);
  });

  test("a mismatch and a job Tapis cannot be read for put NOTHING in the record, even when the files were uploaded", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    fx.tapis.down();
    const pending = await report(hold, { tapis_job_id: uuid, files: declared() });
    expect(pending.status).toBe(202);
    const files = (pending.json as { files: { state: string; uploads: ReportUpload[] } }).files;
    expect(files.state).toBe("awaiting_upload");
    await putAll(files.uploads);
    expect(await submittedKeys(hold.job_id)).toEqual([]);
    // The same report again while Tapis is still down: still nothing in the record.
    const again = await report(hold, { tapis_job_id: uuid, files: declared() });
    expect(again.status).toBe(202);
    expect(await submittedKeys(hold.job_id)).toEqual([]);

    // A mismatch: the files were uploaded, the record stays empty for ever.
    fx.tapis.up();
    const hold2 = await reserve(w, person);
    const bad = await partnerLaunch(w, hold2, person, { owner: "someone-else" });
    const refused = await report(hold2, { tapis_job_id: bad, files: declared() });
    expect([refused.status, refused.json?.code]).toEqual([409, "report_mismatch"]);
    expect(refused.json?.files).toBeUndefined();
    expect(await submittedKeys(hold2.job_id)).toEqual([]);
  });

  test("a list the limits or the path rule refuse is refused WHOLE, before anything is bound", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    const sha = "a".repeat(64);
    const bad: Array<[string, unknown, number, string, string | undefined]> = [
      ["traversal", [{ path: "../x", size: 1, sha256: sha }], 400, "invalid_spec", "files.0.path"],
      [
        "encoded traversal",
        [{ path: "%2e%2e/x", size: 1, sha256: sha }],
        400,
        "invalid_spec",
        "files.0.path",
      ],
      [
        "double-encoded traversal",
        [{ path: "%252e%252e/x", size: 1, sha256: sha }],
        400,
        "invalid_spec",
        "files.0.path",
      ],
      [
        "absolute",
        [{ path: "/etc/passwd", size: 1, sha256: sha }],
        400,
        "invalid_spec",
        "files.0.path",
      ],
      ["backslash", [{ path: "a\\b", size: 1, sha256: sha }], 400, "invalid_spec", "files.0.path"],
      [
        "empty segment",
        [{ path: "a//b", size: 1, sha256: sha }],
        400,
        "invalid_spec",
        "files.0.path",
      ],
      [
        "duplicate",
        [
          { path: "a", size: 1, sha256: sha },
          { path: "a", size: 1, sha256: sha },
        ],
        400,
        "invalid_spec",
        "files.1.path",
      ],
      [
        "oversize",
        [{ path: "big.bin", size: 26 * 1024 * 1024, sha256: sha }],
        413,
        "bundle_too_large",
        undefined,
      ],
      [
        "total over",
        Array.from({ length: 5 }, (_, i) => ({
          path: `f${i}`,
          size: 24 * 1024 * 1024,
          sha256: sha,
        })),
        413,
        "bundle_too_large",
        undefined,
      ],
      [
        "too many",
        Array.from({ length: 501 }, (_, i) => ({ path: `f${i}`, size: 1, sha256: sha })),
        400,
        "invalid_spec",
        "files",
      ],
    ];
    for (const [name, files, status, code, field] of bad) {
      const res = await report(hold, { tapis_job_id: uuid, files });
      expect([name, res.status, res.json?.code]).toEqual([name, status, code]);
      if (field !== undefined) expect([name, res.json?.field]).toEqual([name, field]);
      expect(row(w, hold.job_id)).toMatchObject({ tapis_uuid: null, partner_state: null });
    }
    expect(subscriptions()).toBe(0);
  });
});

describe("a binding withdrawn because the job is NEMAR's own", () => {
  test("a withdrawal never touches a cancel a person, an administrator or the end of an account recorded (a refusal records none of its own)", async () => {
    const { UNBIND_SQL } = await import("../src/services/compute-report-verify");
    for (const [reason, kept] of [
      ["account_ended", true],
      ["user", true],
      [null, false],
    ] as const) {
      const hold = await reserve(w, person);
      const uuid = `uuid-${reason ?? "none"}-1`.replace("_", "-");
      w.h.db
        .query(
          reason === null
            ? "UPDATE compute_jobs SET tapis_uuid = ?, partner_state = 'pending' WHERE id = ?"
            : "UPDATE compute_jobs SET tapis_uuid = ?, partner_state = 'pending', cancel_requested_at = datetime('now'), cancel_reason = ? WHERE id = ?",
        )
        .run(...(reason === null ? [uuid, hold.job_id] : [uuid, reason, hold.job_id]));
      const done = await w
        .env()
        .DB.prepare(UNBIND_SQL)
        .bind(hold.job_id, uuid, "tapis_job_in_use")
        .run();
      expect(done.meta?.changes).toBe(1);
      const job = row(w, hold.job_id);
      expect([reason, job.tapis_uuid, job.partner_state, job.partner_flag]).toEqual([
        reason,
        null,
        null,
        "tapis_job_in_use",
      ]);
      expect([reason, job.cancel_requested_at !== null]).toEqual([reason, kept]);
    }
  });
});
