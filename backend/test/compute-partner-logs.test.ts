/**
 * The logs route reads a partner job's Tapis output only for a job NEMAR has VERIFIED (epic #2021 phase D4,
 * #2025; the review round of PR #2077, finding I1): a job a partner reported and NEMAR refused (or has not
 * matched) may be another owner's, and its output is not the person's to read.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { hashApiKey } from "../src/services/token";
import {
  type LifecycleFixture,
  MINUTE,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import {
  type PartnerPerson,
  type PartnerWorld,
  buildPartnerWorld,
  newPartnerPerson,
  partnerCall,
  partnerLaunch,
  reserve,
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

describe("the logs route reads a partner job's Tapis output only once NEMAR verified it (I1)", () => {
  async function personKey(): Promise<string> {
    const key = `${"nemar"}_${"p".repeat(8)}${"0123456789abcdef".repeat(2)}`;
    w.h.db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(person.id, await hashApiKey(key), key.slice(0, 8));
    return key;
  }

  test("a refused job whose owner is someone else: logs_not_available, and nothing of its output is returned", async () => {
    const key = await personKey();
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, null, null, {
      owner: "nmu_someoneelse0000000000000000000000",
      tags: [],
    });
    fx.tapis.advance(uuid, "QUEUED");
    fx.tapis.advance(uuid, "RUNNING");
    setTapisTimes(fx, uuid, 30 * MINUTE, null);
    fx.tapis.setOutput(uuid, "tapisjob.out", "OUTPUT OF ANOTHER PERSON\n");
    const res = await partnerCall(w, "POST", `/compute/jobs/${hold.job_id}/report`, {
      token: person.token,
      json: { tapis_job_id: uuid },
    });
    expect(res.json?.code).toBe("report_mismatch");
    const logs = await w.h.call("GET", `/compute/jobs/${hold.job_id}/logs`, { key });
    expect(logs.status).toBe(404);
    expect(logs.text).not.toContain("OUTPUT OF ANOTHER PERSON");
    expect(logs.json?.code).toBe("logs_not_available");
  });

  test("a job still pending (Tapis could not be read) is not read either; a verified one is", async () => {
    const key = await personKey();
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    fx.tapis.advance(uuid, "QUEUED");
    fx.tapis.advance(uuid, "RUNNING");
    setTapisTimes(fx, uuid, 30 * MINUTE, null);
    fx.tapis.setOutput(uuid, "tapisjob.out", "MY OWN OUTPUT\n");
    fx.tapis.down();
    expect(
      (
        await partnerCall(w, "POST", `/compute/jobs/${hold.job_id}/report`, {
          token: person.token,
          json: { tapis_job_id: uuid },
        })
      ).status,
    ).toBe(202);
    fx.tapis.up();
    const pending = await w.h.call("GET", `/compute/jobs/${hold.job_id}/logs`, { key });
    expect([pending.status, pending.json?.code]).toEqual([404, "logs_not_available"]);
    const { reapExpiredHolds } = await import("../src/services/compute-hold-reaper");
    expect((await reapExpiredHolds(fx.env()))?.verified).toBe(1);
    const verified = await w.h.call("GET", `/compute/jobs/${hold.job_id}/logs`, { key });
    expect(verified.status).toBe(200);
    expect(verified.text).toBe("MY OWN OUTPUT\n");
  });
});
