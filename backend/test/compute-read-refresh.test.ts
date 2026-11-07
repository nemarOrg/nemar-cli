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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ComputeUserJobResponseSchema } from "../../shared/contract/compute-user";
import { refreshClock, refreshLimits } from "../src/routes/compute/read";
import { JOB_BY_ID_SQL } from "../src/services/compute-jobs";
import { submitComputeJob } from "../src/services/compute-lifecycle";
import { hashApiKey } from "../src/services/token";
import type { Bindings } from "../src/types/bindings";
import { endedJob } from "./helpers/compute-ended";
import {
  type LifecycleFixture,
  type MadeJob,
  makeJob,
  reread,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { type RoutesHandle, makeRoutesApp } from "./helpers/compute-routes-app";
import { realD1, wrapD1 } from "./helpers/d1";

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

async function detail(
  made: MadeJob,
  over: Parameters<LifecycleFixture["env"]>[0] = {},
  /** One bindings object for several reads: the debounce is kept per database binding, as in a Worker. */
  env: Bindings = fx.env(over),
) {
  const key = await keyFor(made.accountId);
  const res = await routes(
    new Request(`http://api.test/compute/me/jobs/${made.job.id}`, {
      headers: { Authorization: `Bearer ${key}` },
    }),
    env,
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

  test("an unexpected failure of the refresh itself (the database refuses the lifecycle's read) serves the stored record with stale: true", async () => {
    const { made } = await runningAtTapis();
    stale(made.job.id);
    const storedState = (await reread(made.env, made.job.id)).state;
    // The refresh's first statement is `advanceComputeJob`'s read of the job row (`JOB_BY_ID_SQL`); the
    // route's own statements are different text, so only the refresh meets the fault.
    const faulty = wrapD1(realD1(fx.harness.db), (sql) => {
      if (sql === JOB_BY_ID_SQL) throw new Error("the database refused");
    });
    const res = await detail(made, { DB: faulty });
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true);
    expect(res.body.job.state).toBe(storedState);
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

  test("a terminal job is not read back, and the read repairs nothing", async () => {
    const ended = await endedJob(fx, 30);
    stale(ended.job.id);
    // A finished job whose launcher files were never copied is owed that copy; `advanceComputeJob` would
    // make it, and a GET must not.
    fx.harness.db
      .query("UPDATE compute_jobs SET result_records_at = NULL WHERE id = ?")
      .run(ended.job.id);
    const before = jobReads();
    const res = await detail(ended);
    expect(res.body.job.state).toBe("finished");
    expect(res.body.stale).toBe(false);
    expect(jobReads()).toBe(before);
    expect((await reread(ended.env, ended.job.id)).result_records_at).toBeNull();
  });

  test("a job that never reached Tapis is shown as it is, and the read submits nothing", async () => {
    const made = await makeJob(fx);
    expect((await reread(made.env, made.job.id)).tapis_uuid).toBeNull();
    // Old enough that the 60-second rule alone would read it: only "no Tapis job" keeps it from being asked.
    fx.harness.db
      .query("UPDATE compute_jobs SET created_at = datetime('now', '-1 hour') WHERE id = ?")
      .run(made.job.id);
    const res = await detail(made);
    expect(res.body.job.state).toBe("created");
    expect(res.body.stale).toBe(false);
    expect(fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/submit")).toHaveLength(0);
    expect(fx.tapis.jobs.size).toBe(0);
  });
});

describe("one attempt a minute per job, whether it worked or not", () => {
  const realNow = refreshClock.now;
  const realMax = refreshLimits.attemptsMax;
  afterEach(() => {
    refreshClock.now = realNow;
    refreshLimits.attemptsMax = realMax;
  });

  test("five reads while Tapis is down make one call to Tapis, and every one says stale", async () => {
    const { made } = await runningAtTapis();
    stale(made.job.id);
    fx.tapis.fail("GET /v3/jobs/:uuid", 500, 100);
    const env = fx.env();
    const before = jobReads();
    const answers = [];
    for (let i = 0; i < 5; i++) answers.push(await detail(made, {}, env));
    expect(jobReads() - before).toBe(1);
    for (const a of answers) expect(a.body.stale).toBe(true);
    // The last GOOD read is untouched by a failed one: the lost-by-age clock runs on it.
    const row = await reread(made.env, made.job.id);
    expect(row.tapis_synced_at).not.toBeNull();
    expect(Date.parse(`${row.tapis_synced_at?.replace(" ", "T")}Z`)).toBeLessThan(
      Date.now() - 120_000,
    );
  });

  test("parallel reads of one job make one call to Tapis, and all get the refreshed record", async () => {
    const { made } = await runningAtTapis();
    stale(made.job.id);
    const env = fx.env();
    const before = jobReads();
    const answers = await Promise.all(Array.from({ length: 5 }, () => detail(made, {}, env)));
    expect(jobReads() - before).toBe(1);
    for (const a of answers) {
      expect(a.body.job.state).toBe("running");
      expect(a.body.stale).toBe(false);
    }
  });

  test("the window is 60 seconds: inside it nothing is asked, after it a healthy Tapis is asked again", async () => {
    const { made, uuid } = await runningAtTapis();
    stale(made.job.id);
    const t0 = Date.now();
    refreshClock.now = () => t0;
    const env = fx.env();
    fx.tapis.fail("GET /v3/jobs/:uuid", 500, 1);
    const before = jobReads();
    expect((await detail(made, {}, env)).body.stale).toBe(true);
    refreshClock.now = () => t0 + 59_000;
    expect((await detail(made, {}, env)).body.stale).toBe(true);
    expect(jobReads() - before).toBe(1);
    // Tapis is healthy again and the job has moved on there.
    fx.tapis.advance(uuid, "ARCHIVING");
    refreshClock.now = () => t0 + 61_000;
    const later = await detail(made, {}, env);
    expect(jobReads() - before).toBe(2);
    expect(later.body.stale).toBe(false);
    expect(later.body.job.state).toBe("archiving");
  });

  test("a different job is not held back by another's attempt", async () => {
    const a = await runningAtTapis();
    const b = await runningAtTapis();
    stale(a.made.job.id);
    stale(b.made.job.id);
    fx.tapis.fail("GET /v3/jobs/:uuid", 500, 1);
    const env = fx.env();
    const before = jobReads();
    await detail(a.made, {}, env);
    await detail(b.made, {}, env);
    expect(jobReads() - before).toBe(2);
  });

  test("an attempt that is made again is the newest: the one forgotten is the one attempted longest ago", async () => {
    refreshLimits.attemptsMax = 2;
    const [a, b, c] = [await runningAtTapis(), await runningAtTapis(), await runningAtTapis()] as [
      Awaited<ReturnType<typeof runningAtTapis>>,
      Awaited<ReturnType<typeof runningAtTapis>>,
      Awaited<ReturnType<typeof runningAtTapis>>,
    ];
    for (const j of [a, b, c]) stale(j.made.job.id);
    fx.tapis.fail("GET /v3/jobs/:uuid", 500, 100);
    const env = fx.env();
    const t0 = Date.now();
    const at = (offsetMs: number) => {
      refreshClock.now = () => t0 + offsetMs;
    };
    at(0);
    await detail(a.made, {}, env);
    at(50_000);
    await detail(b.made, {}, env);
    at(61_000); // a's window has passed: it is attempted again and is now the newest
    await detail(a.made, {}, env);
    at(62_000); // c is new; the memory is over its size and forgets b (attempted at 50 s), not a
    await detail(c.made, {}, env);
    at(63_000);
    const before = jobReads();
    await detail(a.made, {}, env); // attempted 2 s ago: held
    expect(jobReads() - before).toBe(0);
    await detail(b.made, {}, env); // attempted 13 s ago but forgotten: asked again
    expect(jobReads() - before).toBe(1);
  });

  test("the memory is bounded: the oldest attempt is forgotten first", async () => {
    refreshLimits.attemptsMax = 2;
    const jobs = [await runningAtTapis(), await runningAtTapis(), await runningAtTapis()];
    for (const j of jobs) stale(j.made.job.id);
    const env = fx.env();
    fx.tapis.fail("GET /v3/jobs/:uuid", 500, 100);
    for (const j of jobs) await detail(j.made, {}, env);
    const before = jobReads();
    // The newest two are held (nothing is asked); the first was forgotten and is asked again.
    await detail(jobs[2]?.made as MadeJob, {}, env);
    await detail(jobs[1]?.made as MadeJob, {}, env);
    expect(jobReads() - before).toBe(0);
    await detail(jobs[0]?.made as MadeJob, {}, env);
    expect(jobReads() - before).toBe(1);
  });
});
