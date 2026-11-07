/**
 * The status refresh on `GET /compute/me/jobs/:id` (epic #2021 phase D2, #2023; design section 7), through
 * the REAL compute router, a job taken through the real lifecycle (`createJob`, `submitComputeJob`), and
 * Epic A's Tapis stand-in (no response of which was recorded from a real tenant yet).
 *
 * What is pinned:
 *  - a live job whose stored Tapis read is older than 60 seconds is read back and applied before the
 *    answer, so the person sees where the job is now;
 *  - a read newer than 60 seconds, a terminal job and a job that never reached Tapis are NOT read back,
 *    and the route never submits (that would read the compute switch from a GET);
 *  - a Tapis that answers 500 serves the stored record with `stale: true`, and the same in the read-only
 *    maintenance mode (a GET must not write while the platform is frozen);
 *  - the refresh does not depend on the compute switch.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ComputeUserJobResponseSchema } from "../../shared/contract/compute-user";
import { submitComputeJob } from "../src/services/compute-lifecycle";
import { hashApiKey } from "../src/services/token";
import { endedJob } from "./helpers/compute-ended";
import {
  type LifecycleFixture,
  type MadeJob,
  makeJob,
  reread,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { type RoutesHandle, makeRoutesApp } from "./helpers/compute-routes-app";

let fx: LifecycleFixture;
let routes: RoutesHandle;

beforeAll(async () => {
  fx = await startLifecycleFixture();
  routes = makeRoutesApp();
}, 120_000);

beforeEach(async () => {
  await fx.reset();
});

afterAll(async () => {
  await fx?.dispose();
}, 30_000);

let keySeq = 0;
async function keyFor(accountId: number): Promise<string> {
  const key = `refresh-read-key-${++keySeq}-0123456789abcdef0123456789abcdef`;
  fx.harness.db
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(accountId, await hashApiKey(key), key.slice(0, 8));
  return key;
}

async function detail(made: MadeJob, over: Parameters<LifecycleFixture["env"]>[0] = {}) {
  const key = await keyFor(made.accountId);
  const res = await routes(
    new Request(`http://api.test/compute/me/jobs/${made.job.id}`, {
      headers: { Authorization: `Bearer ${key}` },
    }),
    fx.env(over),
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** A person's job on the cluster: submitted to the stand-in, queued, then running there. */
async function runningAtTapis() {
  const made = await makeJob(fx);
  const submitted = await submitComputeJob(made.env, made.job.id);
  if (!submitted.ok) throw new Error(`could not submit: ${submitted.outcome}`);
  const uuid = (await reread(made.env, made.job.id)).tapis_uuid as string;
  fx.tapis.advance(uuid, "QUEUED");
  fx.tapis.advance(uuid, "RUNNING");
  return { made, uuid };
}

const stale = (id: string, ago = "-5 minutes") =>
  fx.harness.db
    .query("UPDATE compute_jobs SET tapis_synced_at = datetime('now', ?) WHERE id = ?")
    .run(ago, id);

const jobReads = () => fx.tapis.log.filter((r) => r.route === "GET /v3/jobs/:uuid").length;

describe("a stale live job is read back from Tapis", () => {
  test("older than 60 seconds: refreshed, and the answer carries the state Tapis reports", async () => {
    const { made } = await runningAtTapis();
    stale(made.job.id);
    expect((await reread(made.env, made.job.id)).state).not.toBe("running");
    const before = jobReads();
    const res = await detail(made);
    expect(res.status).toBe(200);
    expect(ComputeUserJobResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.job.state).toBe("running");
    expect(res.body.stale).toBe(false);
    expect(jobReads()).toBeGreaterThan(before);
    // The stored row moved too: the next reader sees it without a call.
    expect((await reread(made.env, made.job.id)).state).toBe("running");
  });

  test("the refresh does not depend on the compute switch", async () => {
    const { made } = await runningAtTapis();
    stale(made.job.id);
    const res = await detail(made, { COMPUTE_ENABLED: "0" });
    expect(res.body.job.state).toBe("running");
    expect(res.body.stale).toBe(false);
  });

  test("a Tapis that answers 500 serves the stored record with stale: true", async () => {
    const { made } = await runningAtTapis();
    stale(made.job.id);
    const storedState = (await reread(made.env, made.job.id)).state;
    fx.tapis.fail("GET /v3/jobs/:uuid", 500, 20);
    const res = await detail(made);
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true);
    expect(res.body.job.state).toBe(storedState);
    expect(res.body.job.id).toBe(made.job.id);
  });

  test("in the read-only maintenance mode nothing is written: the stored record, stale: true, no call", async () => {
    const { made } = await runningAtTapis();
    stale(made.job.id);
    const before = jobReads();
    const storedState = (await reread(made.env, made.job.id)).state;
    const res = await detail(made, { MAINTENANCE_MODE: "read-only" });
    expect(res.body.stale).toBe(true);
    expect(res.body.job.state).toBe(storedState);
    expect(jobReads()).toBe(before);
  });
});

describe("what is not read back", () => {
  test("a read newer than 60 seconds is not read again", async () => {
    const { made, uuid } = await runningAtTapis();
    stale(made.job.id, "-30 seconds");
    fx.tapis.advance(uuid, "ARCHIVING");
    const before = jobReads();
    const stored = (await reread(made.env, made.job.id)).state;
    const res = await detail(made);
    expect(res.body.stale).toBe(false);
    expect(res.body.job.state).toBe(stored);
    expect(jobReads()).toBe(before);
  });

  test("a terminal job is not read back", async () => {
    const ended = await endedJob(fx, 30);
    stale(ended.job.id);
    const before = jobReads();
    const res = await detail(ended);
    expect(res.body.job.state).toBe("finished");
    expect(res.body.stale).toBe(false);
    expect(jobReads()).toBe(before);
  });

  test("a job that never reached Tapis is shown as it is, and the read submits nothing", async () => {
    const made = await makeJob(fx);
    expect((await reread(made.env, made.job.id)).tapis_uuid).toBeNull();
    const res = await detail(made);
    expect(res.body.job.state).toBe("created");
    expect(res.body.stale).toBe(false);
    expect(fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/submit")).toHaveLength(0);
    expect(fx.tapis.jobs.size).toBe(0);
  });
});
