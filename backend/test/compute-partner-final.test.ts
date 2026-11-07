/**
 * What a partner's job can cost a person at the END, and what a person may read of it (epic #2021 phase D4,
 * #2025; the review round of PR #2077).
 *
 *  C2. The partner chooses the scheduler options, and the verification cannot see everything Expanse
 *      allocates. The observer's final settlement therefore CAPS a partner job's charge to the person at the
 *      hold the person made; what Expanse says it consumed beyond that is the partner's, an `overrun` of the
 *      pool `tenant`, flagged `resources_mismatch` and audited, once. A job that used no more than the hold
 *      is settled exactly as before.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { runComputeAdvanceCron } from "../src/services/compute-advance";
import { settleObservedRows } from "../src/services/compute-observer";
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
import { fundAccount, fundPlatform } from "./helpers/compute-seed";

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

const report = (hold: Hold, uuid: string) =>
  partnerCall(w, "POST", `/compute/jobs/${hold.job_id}/report`, {
    token: person.token,
    json: { tapis_job_id: uuid },
  });

/** A finished one-GPU hour, verified and settled provisionally, with Expanse's accounting row not yet in. */
async function finishedGpuJob(): Promise<{ hold: Hold; slurm: string }> {
  await fundAccount(w.env().DB, person.id, 1_000_000, "gpu");
  await fundPlatform(w.env().DB, "people", 1_000_000_000, "gpu");
  const hold = await reserve(w, person, {
    partition: "gpu-shared",
    gpus: 1,
    cores: 4,
    memory_mb: 8000,
    minutes: 60,
  });
  const uuid = await partnerLaunch(w, hold, person, { queue: "gpu-shared" });
  fx.tapis.advance(uuid, "QUEUED");
  fx.tapis.advance(uuid, "RUNNING");
  fx.tapis.advance(uuid, "FINISHED");
  setTapisTimes(fx, uuid, 60 * MINUTE, 0);
  expect((await report(hold, uuid)).status).toBe(200);
  await runComputeAdvanceCron(fx.env());
  const slurm = "424242";
  w.h.db.query("UPDATE compute_jobs SET slurm_job_id = ? WHERE id = ?").run(slurm, hold.job_id);
  return { hold, slurm };
}

function sacct(slurm: string, gpus: number, chargedMilli: number | null = null) {
  w.h.db
    .query(
      `INSERT INTO compute_sacct_rows (slurm_job_id, run_id, partition, state, elapsed_seconds, alloc_nodes,
         alloc_cpus, alloc_gpus, alloc_mem_mb, charged_milli)
       VALUES (?, '00000000-0000-0000-0000-000000000000', 'gpu-shared', 'COMPLETED', 3600, 1, 4, ?, 8000, ?)`,
    )
    .run(slurm, gpus, chargedMilli);
}

describe("the cap is flagged only when the difference is not routine (item 9)", () => {
  test("Expanse says 1.5 SU for a 1 SU hold (inside the owner's tolerance): capped and charged to the partner, no flag word, no audit row", async () => {
    const { hold, slurm } = await finishedGpuJob();
    sacct(slurm, 1, 1500);
    expect((await settleObservedRows(fx.env())).settled).toBe(1);
    const job = row(w, hold.job_id);
    expect(job).toMatchObject({ charged_milli: 1000, partner_flag: null, flag_overrun: 1 });
    expect((poolOf(w, "partner", "tenant", "gpu") as Record<string, number>).charged_milli).toBe(
      500,
    );
    expect(
      w.h.db
        .query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'compute.partner.final_capped'")
        .get(),
    ).toEqual({ n: 0 });
  });
});

/** A verified partner job Tapis let run three hours on a one-hour hold, found FINISHED by the tick. */
async function threeHourJob(options: { slurm: boolean }) {
  const hold = await reserve(w, person);
  const uuid = await partnerLaunch(w, hold, person);
  fx.tapis.advance(uuid, "QUEUED");
  fx.tapis.advance(uuid, "RUNNING");
  fx.tapis.advance(uuid, "FINISHED");
  setTapisTimes(fx, uuid, 180 * MINUTE, 0);
  if (!options.slurm) {
    (fx.tapis.jobs.get(uuid)?.record as Record<string, unknown>).remoteJobId = null;
  }
  expect((await report(hold, uuid)).status).toBe(200);
  return { hold, uuid };
}

const sacctCpu = (slurm: string, seconds: number) =>
  w.h.db
    .query(
      `INSERT INTO compute_sacct_rows (slurm_job_id, run_id, partition, state, elapsed_seconds, alloc_nodes,
         alloc_cpus, alloc_gpus, alloc_mem_mb, charged_milli)
       VALUES (?, '00000000-0000-0000-0000-000000000000', 'shared', 'COMPLETED', ?, 1, 4, 0, 8000, NULL)`,
    )
    .run(slurm, seconds);

describe("the provisional settlement is capped at the hold, and who writes the excess (M3)", () => {
  test("a job with NO Slurm id has nothing to correct its excess: the provisional settlement puts it on the partner", async () => {
    const { hold } = await threeHourJob({ slurm: false });
    await runComputeAdvanceCron(fx.env());
    const job = row(w, hold.job_id);
    expect(job).toMatchObject({
      state: "finished",
      held_milli: 4000,
      charged_milli: 4000,
      flag_overrun: 1,
      slurm_job_id: null,
    });
    expect(job.partner_flag).toBe("resources_mismatch");
    expect(entries(w, hold.job_id).map((e) => [e.kind, e.charged_delta_milli])).toEqual([
      ["hold", 0],
      ["charge", 4000],
      ["overrun", expect.any(Number)],
    ]);
    expect(poolOf(w, "account", String(person.id)) as Record<string, number>).toMatchObject({
      charged_milli: 4000,
      held_milli: 0,
    });
    expect(
      (poolOf(w, "partner", "tenant") as Record<string, number>).charged_milli,
    ).toBeGreaterThan(7000);
    expect(
      w.h.db
        .query(
          "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'compute.partner.final_capped' AND resource_id = ?",
        )
        .get(hold.job_id),
    ).toEqual({ n: 1 });
  });

  test("a job that reaches accounting: the provisional settlement only caps the person; Expanse's figure makes the partner's excess", async () => {
    const { hold } = await threeHourJob({ slurm: true });
    await runComputeAdvanceCron(fx.env());
    const slurm = row(w, hold.job_id).slurm_job_id as string;
    expect(slurm).not.toBeNull();
    // Capped for the person; NO guess of the partner's bill from Tapis's times.
    expect(row(w, hold.job_id)).toMatchObject({ charged_milli: 4000, partner_flag: null });
    expect(entries(w, hold.job_id).map((e) => e.kind)).toEqual(["hold", "charge"]);
    expect(poolOf(w, "partner", "tenant")).toBeNull();
    // Expanse says 1.25 hours (5 SU): the partner's excess is 1 SU, not the 8 SU Tapis's times implied.
    sacctCpu(slurm, 4500);
    expect((await settleObservedRows(fx.env())).settled).toBe(1);
    expect(row(w, hold.job_id).charged_milli).toBe(4000);
    expect((poolOf(w, "partner", "tenant") as Record<string, number>).charged_milli).toBe(1000);
    expect((poolOf(w, "platform", "people") as Record<string, number>).charged_milli).toBe(
      4000 + 1000,
    );
    expect(entries(w, hold.job_id).filter((e) => e.kind === "overrun")).toHaveLength(1);
  });

  test("the excess is gated on the person having been charged exactly the hold", async () => {
    const { partnerExcessStatements } = await import("../src/services/compute-partner-excess");
    const { hold } = await threeHourJob({ slurm: true });
    await runComputeAdvanceCron(fx.env());
    // A statement built for a DIFFERENT hold figure writes nothing: the person's charge is not that.
    const wrong = await partnerExcessStatements(fx.env().DB, {
      jobId: hold.job_id,
      pool: "cpu",
      client: null,
      excessMilli: 500,
      routine: true,
      heldMilli: 3999,
    });
    await fx.env().DB.batch(wrong);
    expect(entries(w, hold.job_id).filter((e) => e.kind === "overrun")).toHaveLength(0);
    const right = await partnerExcessStatements(fx.env().DB, {
      jobId: hold.job_id,
      pool: "cpu",
      client: null,
      excessMilli: 500,
      routine: true,
      heldMilli: 4000,
    });
    await fx.env().DB.batch(right);
    expect(entries(w, hold.job_id).filter((e) => e.kind === "overrun")).toHaveLength(1);
  });
});

describe("the repair of an unsettled terminal row caps a partner job too", () => {
  test("a verified partner job with no Slurm id, found over and unsettled, is settled at the hold, the rest on the partner", async () => {
    const { advanceComputeJob } = await import("../src/services/compute-lifecycle");
    const { hold } = await threeHourJob({ slurm: false });
    // The row is over but its first batch never settled it.
    w.h.db
      .query("UPDATE compute_jobs SET state = 'finished', ended_at = datetime('now') WHERE id = ?")
      .run(hold.job_id);
    await advanceComputeJob(fx.env(), hold.job_id);
    expect(row(w, hold.job_id)).toMatchObject({ charged_milli: 4000 });
    expect(row(w, hold.job_id).settled_provisional_at).not.toBeNull();
    expect(poolOf(w, "account", String(person.id)) as Record<string, number>).toMatchObject({
      charged_milli: 4000,
    });
    expect(
      (poolOf(w, "partner", "tenant") as Record<string, number>).charged_milli,
    ).toBeGreaterThan(7000);
  });
});

describe("the repair path leaves a job with a Slurm id to the final settlement", () => {
  test("capped for the person, nothing written for the partner yet", async () => {
    const { advanceComputeJob } = await import("../src/services/compute-lifecycle");
    const { hold } = await threeHourJob({ slurm: true });
    w.h.db
      .query(
        "UPDATE compute_jobs SET state = 'finished', ended_at = datetime('now'), slurm_job_id = '616161' WHERE id = ?",
      )
      .run(hold.job_id);
    await advanceComputeJob(fx.env(), hold.job_id);
    expect(row(w, hold.job_id)).toMatchObject({ charged_milli: 4000 });
    expect(poolOf(w, "partner", "tenant")).toBeNull();
  });
});

describe("the person is never charged beyond the hold at the final settlement (C2)", () => {
  test("Expanse says four GPUs for a one-GPU hold: the person pays the hold, the partner pays the rest, flagged and audited", async () => {
    const { hold, slurm } = await finishedGpuJob();
    expect(row(w, hold.job_id)).toMatchObject({ state: "finished", held_milli: 1000 });
    sacct(slurm, 4);
    const pass = await settleObservedRows(fx.env());
    expect(pass.settled).toBe(1);
    const job = row(w, hold.job_id);
    // 4 GPUs for an hour is 4000 milli-SU; the person's share is capped at the 1000 they held.
    expect(job.charged_milli).toBe(1000);
    expect(job).toMatchObject({ partner_flag: "resources_mismatch", flag_mismatch: 1 });
    const person_pool = poolOf(w, "account", String(person.id), "gpu") as Record<string, number>;
    expect(person_pool.charged_milli).toBe(1000);
    const tenant = poolOf(w, "partner", "tenant", "gpu") as Record<string, number>;
    expect(tenant.charged_milli).toBe(3000);
    const overrun = entries(w, hold.job_id).find((e) => e.kind === "overrun") as DbRow;
    expect(overrun).toMatchObject({
      charged_delta_milli: 3000,
      idempotency_key: `job:${hold.job_id}:unreserved`,
    });
    const audit = w.h.db
      .query(
        "SELECT details FROM audit_log WHERE action = 'compute.partner.final_capped' AND resource_id = ?",
      )
      .all(hold.job_id) as Array<{ details: string }>;
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.details as string)).toEqual({
      flag: "resources_mismatch",
      client: w.client.clientId,
    });
    // A second pass settles nothing again.
    await settleObservedRows(fx.env());
    expect(
      entries(w, hold.job_id).filter(
        (e) => e.kind === "overrun" || e.reason === "final_settlement",
      ),
    ).toHaveLength(2);
  });

  test("a job that used what the hold covers settles exactly as before: no overrun, no flag", async () => {
    const { hold, slurm } = await finishedGpuJob();
    sacct(slurm, 1);
    expect((await settleObservedRows(fx.env())).settled).toBe(1);
    expect(row(w, hold.job_id)).toMatchObject({ charged_milli: 1000, partner_flag: null });
    expect(entries(w, hold.job_id).some((e) => e.kind === "overrun")).toBe(false);
    expect(poolOf(w, "partner", "tenant", "gpu")).toBeNull();
  });
});
