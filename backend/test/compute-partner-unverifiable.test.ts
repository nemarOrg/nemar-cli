/**
 * The hostile reading of a partner's report (epic #2021 phase D4, #2025; the review round of PR #2077), through
 * the REAL Worker, a partner client registered by the owner's route, the Tapis stand-in and Miniflare's R2.
 * The partner can choose what it launches, who owns it, who it shares it with and what scheduler options it
 * sends; NEMAR trusts none of it and fails closed on what it cannot read.
 *
 * What is pinned (each was a finding of the review, with the probe that reproduced it):
 *  1. C1: A JOB NEMAR CANNOT READ is never left bound `pending` forever. A refusal of NEMAR's credential
 *     (HTTP 403) is `tapis_job_unreadable` and binds NOTHING; a Tapis that cannot answer binds `pending` (202)
 *     and the tick, after two hours of the same, refuses it as `unverifiable`: cancelled (blind when it must
 *     be), the hold released, the minimum charged to the partner's pool and never to the person, one audit
 *     row, a warn line. A cancel that does not take keeps the row.
 *  2. M2: A Tapis job id the table would refuse is `invalid_spec` before anything is written (it was a 500
 *     that left the key claimed); a record Tapis answers for under ANOTHER uuid is not a read of the job.
 *  3. m2: a request that fails its cheap checks does not claim its key (the corrected retry is not a conflict).
 *  4. m3: a reservation that ended before the job was found under it (`hold_ended`) is told `hold_cancelled`
 *     on a repeat, never an owner mismatch.
 *  5. C2 (verification): scheduler options are held to an allowlist, and the execution system is pinned.
 *  6. M4: a refused job's use is priced from the queue the record shows.
 *  7. M5/M1: a refused job owes no ACCESS report, and its Tapis output is never copied into the records or
 *     raised as an abandoned copy.
 *  8. M1 (Sonnet): the ending binds the state it read; a second writer changes nothing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { RATE_TABLE_V1 } from "../../shared/contract/compute";
import { runComputeAdvanceCron } from "../src/services/compute-advance";
import { reapExpiredHolds } from "../src/services/compute-hold-reaper";
import { COPY_ABANDONED_COUNT_SQL } from "../src/services/compute-lifecycle";
import { finishMismatch } from "../src/services/compute-report-verify";
import {
  type LifecycleFixture,
  MINUTE,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import {
  type DbRow,
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

const report = (hold: Hold, body: unknown, key?: string | null) =>
  partnerCall(w, "POST", `/compute/jobs/${hold.job_id}/report`, {
    token: person.token,
    json: body,
    key,
  });
const cancels = () => fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/:uuid/cancel");
const kinds = (id: string) => entries(w, id).map((e) => e.kind);
const tenant = () => poolOf(w, "partner", "tenant") as Record<string, number> | null;
const own = () => poolOf(w, "account", String(person.id)) as Record<string, number>;
const count = (sql: string, ...args: unknown[]) =>
  (w.h.db.query(sql).get(...(args as string[])) as { n: number }).n;

function run30(uuid: string) {
  fx.tapis.advance(uuid, "QUEUED");
  fx.tapis.advance(uuid, "RUNNING");
  setTapisTimes(fx, uuid, 30 * MINUTE, null);
}

/** Pretend the first failed read of the job was `minutes` ago (the two hours run from it). */
const firstFailedAgo = (jobId: string, minutes: number) =>
  w.h.db
    .query("UPDATE compute_jobs SET partner_first_failed_at = datetime('now', ?) WHERE id = ?")
    .run(`-${minutes} minutes`, jobId);

/**
 * A matching job the partner reported while Tapis was down (bound `pending`), whose record NEMAR may not
 * read from then on (HTTP 403) although the cancel needs only its uuid.
 */
async function unreadableJob() {
  const hold = await reserve(w, person);
  const uuid = await partnerLaunch(w, hold, person);
  run30(uuid);
  fx.tapis.down();
  expect((await report(hold, { tapis_job_id: uuid })).status).toBe(202);
  fx.tapis.up();
  fx.tapis.fail("GET /v3/jobs/:uuid", 403, 1000);
  return { hold, uuid };
}

/** The refusal as unverifiable is recorded and the tick stops before the blind cancel: no cancel is on the wire. */
async function refusedBeforeCancel(jobId: string) {
  const { verifyBoundJob } = await import("../src/services/compute-report-verify");
  const { TICK_READ } = await import("../src/services/compute-lifecycle");
  w.h.db
    .query(
      "UPDATE compute_jobs SET partner_read_failures = 2, partner_first_failed_at = datetime('now', '-130 minutes') WHERE id = ?",
    )
    .run(jobId);
  const out = await verifyBoundJob(fx.env(), jobId, { read: TICK_READ, tick: true });
  expect(out.kind).toBe("mismatch");
}

/** Three failed ticks over two hours: the third refuses the job. Returns the third tick's result. */
async function refuse3(jobId: string) {
  await reapExpiredHolds(fx.env());
  firstFailedAgo(jobId, 130);
  await reapExpiredHolds(fx.env());
  return reapExpiredHolds(fx.env());
}

describe("a job NEMAR cannot read (C1)", () => {
  test("a refusal of NEMAR's credential is 422 tapis_job_unreadable and binds nothing (the hold stays releasable)", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    fx.tapis.fail("GET /v3/jobs/:uuid", 403, 5);
    const res = await report(hold, { tapis_job_id: uuid });
    expect([res.status, res.json?.code]).toEqual([422, "tapis_job_unreadable"]);
    expect(row(w, hold.job_id)).toMatchObject({ tapis_uuid: null, partner_state: null });
    expect(cancels()).toHaveLength(0);
    // Nothing pins the hold: the partner may release it.
    const released = await partnerCall(w, "DELETE", `/compute/holds/${hold.hold_id}`, {
      token: person.token,
    });
    expect(released.status).toBe(200);
    expect(own()).toMatchObject({ held_milli: 0, charged_milli: 0 });
  });

  test("a job the tick could not read on three separate ticks over two hours is refused as unverifiable: cancelled blind, released, the whole hold charged to the partner", async () => {
    const { hold, uuid } = await unreadableJob();
    const first = await reapExpiredHolds(fx.env());
    expect(first).toMatchObject({ pending: 1, unverifiable: 0, refused: 0 });
    expect(row(w, hold.job_id)).toMatchObject({
      partner_read_failures: 1,
      partner_state: "pending",
    });
    expect(row(w, hold.job_id).partner_first_failed_at).not.toBeNull();
    // The first failure is old enough, but only two ticks have failed: still pending.
    firstFailedAgo(hold.job_id, 130);
    expect(await reapExpiredHolds(fx.env())).toMatchObject({ unverifiable: 0, refused: 0 });
    expect(row(w, hold.job_id).partner_read_failures).toBe(2);
    expect(cancels()).toHaveLength(0);

    const late = await reapExpiredHolds(fx.env());
    expect(late).toMatchObject({ pending: 1, unverifiable: 1, refused: 1, ended: 1 });
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
    expect(row(w, hold.job_id)).toMatchObject({
      state: "cancelled",
      partner_state: "mismatch",
      partner_flag: "unverifiable",
      charged_milli: 0,
      gateway_user: null,
    });
    // The person's hold is released whole and never charged; the partner's pool takes the WHOLE hold (a job
    // that cannot be shown not to have run is not billed at a minimum).
    expect(kinds(hold.job_id)).toEqual(["hold", "release", "overrun"]);
    expect(own()).toMatchObject({ held_milli: 0, charged_milli: 0 });
    expect(tenant()?.charged_milli).toBe(row(w, hold.job_id).held_milli);
    expect(tenant()?.charged_milli).toBeGreaterThan(RATE_TABLE_V1.minChargeMilli);
    const audit = w.h.db
      .query(
        "SELECT details FROM audit_log WHERE action = 'compute.partner.mismatch' AND resource_id = ?",
      )
      .all(hold.job_id) as Array<{ details: string }>;
    expect(audit).toHaveLength(1);
    expect((JSON.parse(audit[0]?.details as string) as DbRow).flag).toBe("unverifiable");
    // The partner told again is told the word.
    const again = await report(hold, { tapis_job_id: uuid });
    expect([again.status, again.json?.code, again.json?.mismatch]).toEqual([
      409,
      "report_mismatch",
      "unverifiable",
    ]);
  });

  test("the two hours are measured from the FIRST failed read: three failures spanning 119 minutes are not enough, 121 are", async () => {
    const { hold } = await unreadableJob();
    await reapExpiredHolds(fx.env());
    await reapExpiredHolds(fx.env());
    firstFailedAgo(hold.job_id, 119);
    expect(await reapExpiredHolds(fx.env())).toMatchObject({ unverifiable: 0 });
    expect(row(w, hold.job_id)).toMatchObject({
      partner_state: "pending",
      partner_read_failures: 3,
    });
    firstFailedAgo(hold.job_id, 121);
    expect(await reapExpiredHolds(fx.env())).toMatchObject({ unverifiable: 1, ended: 1 });
  });

  test("a failed read at the REPORT is not counted (only the tick counts), and a read that succeeds ends the count", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    run30(uuid);
    fx.tapis.down();
    expect((await report(hold, { tapis_job_id: uuid })).status).toBe(202);
    // A repeat of the report while Tapis is down reads again and counts nothing.
    expect((await report(hold, { tapis_job_id: uuid })).status).toBe(202);
    expect(row(w, hold.job_id)).toMatchObject({
      partner_read_failures: 0,
      partner_first_failed_at: null,
    });
    await reapExpiredHolds(fx.env());
    await reapExpiredHolds(fx.env());
    expect(row(w, hold.job_id).partner_read_failures).toBe(2);
    fx.tapis.up();
    expect(await reapExpiredHolds(fx.env())).toMatchObject({ verified: 1, unverifiable: 0 });
    expect(row(w, hold.job_id)).toMatchObject({
      partner_state: "verified",
      partner_read_failures: 0,
      partner_first_failed_at: null,
    });
  });

  test("an unverifiable job whose cancel does not take keeps the row, the hold and the slot; the next tick finishes it", async () => {
    const { hold, uuid } = await unreadableJob();
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 500, 2);
    const stuck = await refuse3(hold.job_id);
    expect(stuck).toMatchObject({ unverifiable: 1, refused: 1, ended: 0 });
    expect(row(w, hold.job_id)).toMatchObject({
      state: "created",
      partner_state: "mismatch",
      partner_flag: "unverifiable",
    });
    expect(kinds(hold.job_id)).toEqual(["hold"]);
    expect(own().held_milli).toBeGreaterThan(0);
    // Nothing was released or charged on an error; the tick asks again.
    const next = await reapExpiredHolds(fx.env());
    expect(next?.mismatches).toBe(1);
    const last = await reapExpiredHolds(fx.env());
    expect(last).toMatchObject({ mismatches: 1, ended: 1 });
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
    expect(kinds(hold.job_id)).toEqual(["hold", "release", "overrun"]);
  });

  test("a binding that stays unreadable is logged at warn by the tick's line", async () => {
    const { holdReaperLogLine } = await import("../src/services/compute-hold-reaper");
    const line = holdReaperLogLine({
      examined: 0,
      released: 0,
      adopted: 0,
      ambiguous: 0,
      unreachable: 0,
      pending: 1,
      verified: 0,
      refused: 1,
      withdrawn: 0,
      unverifiable: 1,
      recovered: 0,
      unconfirmed: 0,
      pruned: 0,
      mismatches: 0,
      ended: 0,
      errors: [],
      errorClass: null,
    });
    expect(line?.level).toBe("warn");
    expect(line?.line).toContain("unverifiable=1");
  });
});

describe("a Tapis id the contract takes must be one the table keeps (M2)", () => {
  test("a dot in the id is 400 invalid_spec, writes nothing and claims no key", async () => {
    const hold = await reserve(w, person);
    const before = count("SELECT COUNT(*) AS n FROM compute_idempotency_keys");
    const res = await report(hold, { tapis_job_id: "abc.def" }, "dot-key");
    expect([res.status, res.json?.code, res.json?.field]).toEqual([
      400,
      "invalid_spec",
      "tapis_job_id",
    ]);
    expect(count("SELECT COUNT(*) AS n FROM compute_idempotency_keys")).toBe(before);
    expect(row(w, hold.job_id)).toMatchObject({ tapis_uuid: null, partner_state: null });
  });

  test("a record Tapis answers for under another uuid is no read of the job: tapis_job_not_found, nothing bound", async () => {
    const hold = await reserve(w, person);
    const asked = await partnerLaunch(w, hold, person);
    const other = await partnerLaunch(w, null, person, { tags: [] });
    const record = fx.tapis.jobs.get(other)?.record;
    fx.tapis.respond(
      "GET /v3/jobs/:uuid",
      200,
      { result: record, status: "success", message: "", version: "", metadata: null },
      1,
    );
    const res = await report(hold, { tapis_job_id: asked });
    expect([res.status, res.json?.code]).toEqual([422, "tapis_job_not_found"]);
    expect(row(w, hold.job_id)).toMatchObject({ tapis_uuid: null, partner_state: null });
  });
});

describe("a request that fails its cheap checks does not claim its key (m2)", () => {
  test("a corrected retry under the same key is a new request, not a conflict", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    const bad = await report(
      hold,
      { tapis_job_id: uuid, files: [{ path: "../x", size: 1, sha256: "a".repeat(64) }] },
      "retry-key",
    );
    expect(bad.status).toBe(400);
    expect(
      count("SELECT COUNT(*) AS n FROM compute_idempotency_keys WHERE key = 'retry-key'"),
    ).toBe(0);
    const fixed = await report(hold, { tapis_job_id: uuid }, "retry-key");
    expect(fixed.status).toBe(200);
  });
});

describe("a reservation that ended before its job was found is told so (m3)", () => {
  test("hold_ended is hold_cancelled on a repeat, never an owner mismatch", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    // The person's cancel was recorded while the partner had not reported.
    w.h.db
      .query(
        "UPDATE compute_jobs SET cancel_requested_at = datetime('now'), cancel_reason = 'user', created_at = datetime('now', '-40 minutes'), partner_expires_at = datetime('now', '-10 minutes') WHERE id = ?",
      )
      .run(hold.job_id);
    const reaped = await reapExpiredHolds(fx.env());
    expect(reaped).toMatchObject({ adopted: 1, refused: 1 });
    expect(row(w, hold.job_id)).toMatchObject({ partner_flag: "hold_ended", state: "cancelled" });
    const res = await report(hold, { tapis_job_id: uuid });
    expect([res.status, res.json?.code, res.json?.mismatch]).toEqual([
      409,
      "hold_cancelled",
      undefined,
    ]);
  });
});

describe("what the scheduler is asked for is checked, and where the job runs is pinned (C2, verification)", () => {
  test("--gpus=1 on a one-GPU hold matches; --gpus=4 does not", async () => {
    const { fundAccount, fundPlatform } = await import("./helpers/compute-seed");
    await fundAccount(w.env().DB, person.id, 1_000_000, "gpu");
    await fundPlatform(w.env().DB, "people", 1_000_000_000, "gpu");
    const hold = await reserve(w, person, {
      partition: "gpu-shared",
      gpus: 1,
      cores: 4,
      memory_mb: 8000,
      minutes: 60,
    });
    const fair = await partnerLaunch(w, hold, person, {
      queue: "gpu-shared",
      schedulerArgs: ["--gpus=1"],
    });
    expect((await report(hold, { tapis_job_id: fair })).status).toBe(200);

    const greedy = await reserve(w, person, {
      partition: "gpu-shared",
      gpus: 1,
      cores: 4,
      memory_mb: 8000,
      minutes: 60,
    });
    const big = await partnerLaunch(w, greedy, person, {
      queue: "gpu-shared",
      schedulerArgs: ["--gpus=4"],
    });
    const res = await report(greedy, { tapis_job_id: big });
    expect([res.status, res.json?.code, res.json?.mismatch]).toEqual([
      409,
      "report_mismatch",
      "resources_mismatch",
    ]);
    expect(fx.tapis.jobs.get(big)?.status).toBe("CANCELLED");
  });

  test("any other scheduler option, a second option or an unreadable list is a resources mismatch", async () => {
    for (const args of [["--exclusive"], ["--gpus=0", "--mem=400G"], ["--mem=400G"]]) {
      const hold = await reserve(w, person);
      const uuid = await partnerLaunch(w, hold, person, { schedulerArgs: args });
      const res = await report(hold, { tapis_job_id: uuid });
      expect([args.join(" "), res.status, res.json?.mismatch]).toEqual([
        args.join(" "),
        409,
        "resources_mismatch",
      ]);
    }
  });

  test("a job on another execution system than the owner pinned is a resources mismatch", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person, { execSystemId: "somewhere-else" });
    const res = await report(hold, { tapis_job_id: uuid });
    expect([res.status, res.json?.mismatch]).toEqual([409, "resources_mismatch"]);
  });
});

describe("a refused job's use is priced from the queue the record shows (M4)", () => {
  test("a GPU job reported under a CPU hold is the gpu pool's rate, not the hold's", async () => {
    const { fundPlatform } = await import("./helpers/compute-seed");
    await fundPlatform(w.env().DB, "people", 1_000_000_000, "gpu");
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person, {
      queue: "gpu-shared",
      schedulerArgs: ["--gpus=2"],
    });
    run30(uuid);
    const res = await report(hold, { tapis_job_id: uuid });
    expect(res.json?.mismatch).toBe("resources_mismatch");
    const overrun = entries(w, hold.job_id).find((e) => e.kind === "overrun") as DbRow;
    const gpuPool = poolOf(w, "partner", "tenant", "gpu") as Record<string, number> | null;
    expect(gpuPool?.charged_milli).toBe(overrun.charged_delta_milli);
    // Two GPUs for half an hour is one SU of the gpu pool: priced from the record's queue and `--gpus=2`,
    // not from the hold (a CPU hold has no GPUs and no gpu pool).
    expect(overrun.charged_delta_milli).toBeGreaterThanOrEqual(1000);
    expect(overrun.charged_delta_milli).toBeLessThan(1100);
    expect(tenant()?.charged_milli ?? 0).toBe(0);
  });
});

describe("a refused job leaves nothing behind for the person or the records (M5, M1)", () => {
  test("no ACCESS report is owed, its Tapis output is never copied, and no abandoned copy is raised", async () => {
    const { logKey } = await import("../src/services/compute-records");
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, null, null, {
      owner: "nmu_someoneelse0000000000000000000000",
      tags: [],
    });
    run30(uuid);
    // The partner reports a job that belongs to someone else (shared with NEMAR) and has output.
    fx.tapis.setOutput(uuid, "tapisjob.out", "OUTPUT OF ANOTHER PERSON\n");
    w.h.db.query("UPDATE compute_jobs SET slurm_job_id = '777' WHERE id = ?").run(hold.job_id);
    const res = await report(hold, { tapis_job_id: uuid });
    expect(res.json?.mismatch).toBe("owner_mismatch");
    expect(row(w, hold.job_id).result_records_at).not.toBeNull();
    expect(
      count("SELECT COUNT(*) AS n FROM compute_access_reports WHERE job_id = ?", hold.job_id),
    ).toBe(0);
    await runComputeAdvanceCron(fx.env());
    expect(await fx.env().COMPUTE_RECORDS?.get(logKey(hold.job_id, "tapisjob.out"))).toBeNull();
    expect(count(COPY_ABANDONED_COUNT_SQL)).toBe(0);
  });
});

describe("the ending of a refusal binds the state it read (M1, Sonnet)", () => {
  test("a second writer of the same refusal changes nothing: one release, one overrun, one end time", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person, { owner: "someone-else" });
    run30(uuid);
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 500, 1);
    expect((await report(hold, { tapis_job_id: uuid })).status).toBe(409);
    const [a, b] = await Promise.all([
      finishMismatch(w.env(), hold.job_id),
      finishMismatch(w.env(), hold.job_id),
    ]);
    expect([a, b].filter((x) => x === "ended")).toHaveLength(1);
    const ended = row(w, hold.job_id).ended_at;
    expect(kinds(hold.job_id)).toEqual(["hold", "release", "overrun"]);
    // A third, later writer finds a finished row and changes nothing.
    expect(await finishMismatch(w.env(), hold.job_id)).toBe("skipped");
    expect(row(w, hold.job_id).ended_at).toBe(ended);
    expect(
      count(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'compute.partner.mismatch' AND resource_id = ?",
        hold.job_id,
      ),
    ).toBe(1);
  });
});

describe("an unverifiable refusal is reconsidered when NEMAR can read the job (item 3b)", () => {
  /** An unverifiable row whose cancel Tapis has not taken: it is `mismatch` and still `created`. */
  async function stuckUnverifiable() {
    const { hold, uuid } = await unreadableJob();
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 500, 1000);
    await refuse3(hold.job_id);
    expect(row(w, hold.job_id)).toMatchObject({
      state: "created",
      partner_state: "mismatch",
      partner_flag: "unverifiable",
    });
    return { hold, uuid };
  }

  test("a job that matches, read once Tapis recovers, is verified again and NOT cancelled; the person is charged only what it uses", async () => {
    const { hold, uuid } = await unreadableJob();
    // The refusal is on the record and no cancel was put on the wire (the tick stopped between the two).
    await refusedBeforeCancel(hold.job_id);
    expect(row(w, hold.job_id).partner_flag).toBe("unverifiable");
    expect(row(w, hold.job_id).partner_cancel_sent_at).toBeNull();
    // Tapis answers again; clear the injected failures but keep the job.
    fx.tapis.clearFailures();
    const subsBefore = fx.tapis.subscriptions.length;
    const tick = await reapExpiredHolds(fx.env());
    expect(tick).toMatchObject({ mismatches: 1, recovered: 1, ended: 0 });
    expect(cancels().filter((c) => c.status < 400)).toHaveLength(0);
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("RUNNING");
    expect(row(w, hold.job_id)).toMatchObject({
      state: "submitted",
      partner_state: "verified",
      partner_flag: null,
      flag_mismatch: 1,
      cancel_requested_at: null,
      cancel_reason: null,
      partner_read_failures: 0,
    });
    expect(kinds(hold.job_id)).toEqual(["hold"]);
    expect(own().held_milli).toBeGreaterThan(0);
    expect(fx.tapis.subscriptions.length).toBe(subsBefore + 1);
    expect(
      w.h.db
        .query(
          "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'compute.partner.recovered' AND resource_id = ?",
        )
        .get(hold.job_id),
    ).toEqual({ n: 1 });
    // From here it is an ordinary job: it finishes and the person pays what it used.
    fx.tapis.advance(uuid, "FINISHED");
    setTapisTimes(fx, uuid, 30 * MINUTE, 0);
    await runComputeAdvanceCron(fx.env());
    expect(row(w, hold.job_id).state).toBe("finished");
    expect(kinds(hold.job_id)).toEqual(["hold", "charge"]);
    expect(tenant()).toBeNull();
  });

  test("a job that does NOT match when it can be read is a real mismatch with its own word, cancelled and charged to the partner", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person, { owner: "someone-else" });
    run30(uuid);
    fx.tapis.down();
    expect((await report(hold, { tapis_job_id: uuid })).status).toBe(202);
    fx.tapis.up();
    fx.tapis.fail("GET /v3/jobs/:uuid", 403, 1000);
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 500, 1000);
    await refuse3(hold.job_id);
    expect(row(w, hold.job_id).partner_flag).toBe("unverifiable");
    fx.tapis.clearFailures();
    const tick = await reapExpiredHolds(fx.env());
    expect(tick).toMatchObject({ mismatches: 1, ended: 1, recovered: 0 });
    expect(row(w, hold.job_id)).toMatchObject({
      state: "cancelled",
      partner_flag: "owner_mismatch",
    });
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");
    expect(own()).toMatchObject({ held_milli: 0, charged_milli: 0 });
    expect(tenant()?.charged_milli).toBeGreaterThan(0);
  });

  test("a job that is CANCELLED when it can be read stays refused (it did not get to run)", async () => {
    const { hold, uuid } = await stuckUnverifiable();
    fx.tapis.clearFailures();
    fx.tapis.advance(uuid, "CANCELLED");
    const tick = await reapExpiredHolds(fx.env());
    expect(tick).toMatchObject({ mismatches: 1, ended: 1, recovered: 0 });
    expect(row(w, hold.job_id)).toMatchObject({ state: "cancelled", partner_flag: "unverifiable" });
    expect(own()).toMatchObject({ held_milli: 0, charged_milli: 0 });
  });
});

describe("a report whose read is not a moment's outage binds nothing (item 4)", () => {
  test("an answer that is not what Tapis's specification says, and a 400, are 422 tapis_job_unreadable", async () => {
    for (const inject of [
      () => fx.tapis.nonJson("GET /v3/jobs/:uuid", 5),
      () => fx.tapis.fail("GET /v3/jobs/:uuid", 400, 5),
    ]) {
      const hold = await reserve(w, person);
      const uuid = await partnerLaunch(w, hold, person);
      inject();
      const res = await report(hold, { tapis_job_id: uuid });
      expect([res.status, res.json?.code]).toEqual([422, "tapis_job_unreadable"]);
      expect(row(w, hold.job_id)).toMatchObject({ tapis_uuid: null, partner_state: null });
      fx.tapis.clearFailures();
    }
  });

  test("a Tapis that is down at the moment (a 503, no connection) still binds pending", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    fx.tapis.fail("GET /v3/jobs/:uuid", 503, 5);
    expect((await report(hold, { tapis_job_id: uuid })).status).toBe(202);
    expect(row(w, hold.job_id).partner_state).toBe("pending");
  });

  test("with Tapis access not configured nothing is bound", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    const res = await partnerCall(w, "POST", `/compute/jobs/${hold.job_id}/report`, {
      token: person.token,
      json: { tapis_job_id: uuid },
      env: { TAPIS_TENANT_ID: undefined } as never,
    });
    expect([res.status, res.json?.code]).toEqual([422, "tapis_job_unreadable"]);
  });
});

describe("a cancel Tapis definitively refuses ends the row (item 4)", () => {
  for (const status of [400, 403, 404]) {
    test(`HTTP ${status} on the blind cancel: the hold is released, the WHOLE hold charged to the partner, a warn line; the slot is free`, async () => {
      const { hold } = await unreadableJob();
      fx.tapis.fail("POST /v3/jobs/:uuid/cancel", status, 1000);
      const tick = await refuse3(hold.job_id);
      expect(tick).toMatchObject({ unverifiable: 1, refused: 1, ended: 1 });
      expect(row(w, hold.job_id)).toMatchObject({
        state: "cancelled",
        partner_state: "mismatch",
        partner_flag: "unverifiable",
      });
      expect(kinds(hold.job_id)).toEqual(["hold", "release", "overrun"]);
      expect(own()).toMatchObject({ held_milli: 0, charged_milli: 0 });
      expect(tenant()?.charged_milli).toBe(row(w, hold.job_id).held_milli);
    });
  }

  test("a transient failure of the cancel (a 500) still keeps the row", async () => {
    const { hold } = await unreadableJob();
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 500, 1000);
    const tick = await refuse3(hold.job_id);
    expect(tick).toMatchObject({ unverifiable: 1, ended: 0 });
    expect(row(w, hold.job_id).state).toBe("created");
  });
});
