import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startLifecycleFixture, type LifecycleFixture } from "./helpers/compute-lifecycle-fixture";
import {
  type PartnerWorld,
  buildPartnerWorld,
  entries,
  newPartnerPerson,
  partnerCall,
  partnerLaunch,
  reserve,
  row,
} from "./helpers/compute-partner-world";

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

describe("smoke", () => {
  test("reserve then report", async () => {
    const p = await newPartnerPerson(w);
    const hold = await reserve(w, p);
    console.log(hold, row(w, hold.job_id).state, entries(w, hold.job_id).map((e) => e.kind));
    const uuid = await partnerLaunch(w, hold, p);
    const res = await partnerCall(w, "POST", `/compute/jobs/${hold.job_id}/report`, {
      token: p.token,
      json: { tapis_job_id: uuid },
    });
    console.log(res.status, res.text);
    console.log(row(w, hold.job_id));
    expect(res.status).toBe(200);
  }, 60_000);
});
