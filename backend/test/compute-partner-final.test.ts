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

function sacct(slurm: string, gpus: number) {
  w.h.db
    .query(
      `INSERT INTO compute_sacct_rows (slurm_job_id, run_id, partition, state, elapsed_seconds, alloc_nodes,
         alloc_cpus, alloc_gpus, alloc_mem_mb, charged_milli)
       VALUES (?, '00000000-0000-0000-0000-000000000000', 'gpu-shared', 'COMPLETED', 3600, 1, 4, ?, 8000, NULL)`,
    )
    .run(slurm, gpus);
}

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
