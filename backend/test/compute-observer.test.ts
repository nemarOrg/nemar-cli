/**
 * The observer, its token and the final settlement it makes possible (epic #2005 phase A7, #2012; ADR
 * 0118, decision 8). Real migrations (0118 included), the real ledger with its triggers, the real
 * compute router, Miniflare's R2 and the Tapis stand-in (nothing from which was recorded from a real
 * tenant). The observer itself is not stood in for: the tests are its client, and post what a real
 * `sacct` export would carry, in the shape the route documents. No response of the real posting service
 * was recorded.
 *
 * What is pinned, each with a test of its own:
 *  - A WRONG, AN EXPIRED, A REUSED AND AN UNKNOWN TOKEN get the same answer, byte for byte, and write
 *    nothing (MUTATION: answer a reused token differently);
 *  - an in-tolerance row settles silently; an out-of-tolerance row sets `flag_mismatch` and STILL settles
 *    to Expanse's figure (MUTATION: make the tolerance test always true; the mismatch case fails);
 *  - a row that matches no job is stored and listed; a row whose job has not ended waits and is settled
 *    by the next pass; a body that fails validation does not spend the run;
 *  - two posts racing on one token make one ingest (MUTATION: drop the `status = 'issued'` term);
 *  - the migration's checks, the mint route's audit row, and that a member cannot mint.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { COMPUTE_REFUSAL_STATUS } from "../../shared/compute-state";
import { DEFAULT_COMPUTE_POLICY } from "../../shared/contract/compute";
import { advanceComputeJob, submitComputeJob } from "../src/services/compute-lifecycle";
import {
  OBSERVER_ROWS_MAX,
  OBSERVER_TOKEN_HEADER,
  isRoutineDifference,
  mintObserverRun,
  settleObservedRows,
} from "../src/services/compute-observer";
import { listUnmatchedSacct } from "../src/services/compute-reporting";
import type { Bindings } from "../src/types/bindings";
import { COMPUTE_KEYS, makeComputeApp, seedComputeUsers } from "./helpers/compute-app";
import { endedJob as endedJobIn } from "./helpers/compute-ended";
import {
  type LifecycleFixture,
  MINUTE,
  makeJob,
  playLauncher,
  reread,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { type RoutesHandle, makeRoutesApp } from "./helpers/compute-routes-app";

let fx: LifecycleFixture;
let routes: RoutesHandle;
const adminApp = makeComputeApp();
let slurmSeq = 40_000;

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

const env = (): Bindings => fx.env();
const nextSlurm = () => String(++slurmSeq);

const endedJob = (minutes = 30, over: Parameters<typeof makeJob>[1] = {}) =>
  endedJobIn(fx, minutes, over);

const sacctRow = (slurm: string, over: Record<string, unknown> = {}) => ({
  slurm_job_id: slurm,
  partition: "shared",
  state: "COMPLETED",
  elapsed_seconds: 1800,
  alloc_nodes: 1,
  alloc_cpus: 4,
  alloc_gpus: 0,
  alloc_mem_mb: 8000,
  submit_time: "2026-11-05T10:00:00Z",
  start_time: "2026-11-05T10:01:00Z",
  end_time: "2026-11-05T10:31:00Z",
  charged_milli: null,
  ...over,
});

async function mint(): Promise<{ runId: string; token: string }> {
  const owner = fx.ownerId;
  const minted = await mintObserverRun(env(), owner);
  if (!minted.ok) throw new Error("could not mint");
  return { runId: minted.runId, token: minted.token };
}

async function post(token: string | null, body: unknown, raw?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers[OBSERVER_TOKEN_HEADER] = token;
  const res = await routes(
    new Request("http://worker.test/compute/observer", {
      method: "POST",
      headers,
      body: raw ?? JSON.stringify(body),
    }),
    env(),
  );
  return { status: res.status, text: await res.text() };
}

const empty = { snapshots: [], sacct: [] };

/** The shortest valid row, so 5,000 of them fit in 1 MiB (the bound the route documents). */
const minimalRow = (slurm: string) =>
  sacctRow(slurm, { submit_time: null, start_time: null, end_time: null, charged_milli: null });

async function counts() {
  const one = async (sql: string) =>
    ((await env().DB.prepare(sql).first<{ n: number }>())?.n ?? 0) as number;
  return {
    rows: await one("SELECT COUNT(*) AS n FROM compute_sacct_rows"),
    snaps: await one("SELECT COUNT(*) AS n FROM compute_queue_snapshots"),
    ledger: await one("SELECT COUNT(*) AS n FROM compute_ledger"),
    audit: await one("SELECT COUNT(*) AS n FROM audit_log"),
  };
}

describe("the token", () => {
  test("a wrong, an expired, a reused, an unknown, a tampered and a missing token get the same answer, and nothing is written (MUTATION: answer a reused token differently)", async () => {
    const good = await mint();
    const expired = await mint();
    // An hour has passed: the run was created before its expiry, and its expiry is behind us.
    fx.harness.db.run(
      "UPDATE compute_observer_runs SET created_at = datetime('now', '-61 minutes'), expires_at = datetime('now', '-1 minute') WHERE id = ?",
      [expired.runId],
    );
    const spent = await mint();
    expect((await post(spent.token, empty)).status).toBe(200);

    const before = await counts();
    const [runId = "", digest = ""] = good.token.split(".");
    const flipped = `${digest.slice(0, -1)}${digest.endsWith("0") ? "1" : "0"}`;
    const attempts = [
      null,
      "",
      "garbage",
      good.token.replace(".", ":"),
      `${runId}.${flipped}`,
      `11111111-2222-3333-4444-555555555555.${digest}`,
      `${runId}.${digest}.extra`,
      expired.token,
      spent.token,
    ];
    const answers = [];
    for (const token of attempts) answers.push(await post(token, empty));
    for (const a of answers) expect(a).toEqual(answers[0] as never);
    expect(answers[0]?.status).toBe(403);
    expect(JSON.parse(answers[0]?.text ?? "{}")).toEqual({
      error: "Not accepted.",
      code: "observer_refused",
    });
    // The good token was never spent by those, and the refusals wrote nothing.
    expect(await counts()).toEqual(before);
    expect((await post(good.token, empty)).status).toBe(200);
  });

  test("the token is bound to the run: another run's digest does not answer", async () => {
    const a = await mint();
    const b = await mint();
    const swapped = `${a.runId}.${b.token.split(".")[1]}`;
    expect((await post(swapped, empty)).status).toBe(403);
    expect((await post(a.token, empty)).status).toBe(200);
  });

  test("a run is spent by its one post: the second is refused", async () => {
    const run = await mint();
    expect((await post(run.token, empty)).status).toBe(200);
    expect((await post(run.token, empty)).status).toBe(403);
    const row = fx.harness.db
      .query("SELECT status FROM compute_observer_runs WHERE id = ?")
      .get(run.runId) as {
      status: string;
    };
    expect(row.status).toBe("ingested");
  });

  test("the token is checked BEFORE the body is read: a wrong or spent token with a body over 1 MiB gets the refusal, not 413 (MUTATION: accept a spent run at the door)", async () => {
    const run = await mint();
    expect((await post(run.token, empty)).status).toBe(200);
    const huge = `{"snapshots":[],"sacct":[],"pad":"${"x".repeat(1_100_000)}"}`;
    const spent = await post(run.token, null, huge);
    const wrong = await post("garbage", null, huge);
    expect(spent).toEqual(wrong);
    expect(spent.status).toBe(403);
  });

  test("two posts racing on one token make one ingest (MUTATION: drop the `status = 'issued'` term)", async () => {
    const run = await mint();
    const body = { snapshots: [], sacct: [sacctRow(nextSlurm())] };
    const [a, b] = await Promise.all([post(run.token, body), post(run.token, body)]);
    expect([a.status, b.status].sort()).toEqual([200, 403]);
    expect((await counts()).rows).toBe(1);
  });
});

describe("the body", () => {
  test("a body that fails validation does not spend the run, and names the field, never the value", async () => {
    const run = await mint();
    const bad = await post(run.token, {
      snapshots: [],
      sacct: [sacctRow("12;DROP", { partition: "Shared!" })],
    });
    expect(bad.status).toBe(400);
    expect(bad.text).not.toContain("DROP");
    expect(JSON.parse(bad.text).code).toBe("invalid_post");
    expect((await counts()).rows).toBe(0);
    // Still unspent.
    expect((await post(run.token, { snapshots: [], sacct: [sacctRow(nextSlurm())] })).status).toBe(
      200,
    );
  });

  test("an unknown key, a wrong type and a negative number are each refused", async () => {
    for (const row of [
      { ...sacctRow(nextSlurm()), extra: 1 },
      sacctRow(nextSlurm(), { elapsed_seconds: "600" }),
      sacctRow(nextSlurm(), { alloc_cpus: -1 }),
      sacctRow(nextSlurm(), { charged_milli: 1.5 }),
      sacctRow(nextSlurm(), { state: "completed" }),
    ]) {
      const run = await mint();
      expect([(await post(run.token, { snapshots: [], sacct: [row] })).status, row]).toEqual([
        400,
        row,
      ]);
    }
  });

  test("more than 5,000 rows is refused, and so is a body over 1 MiB; neither spends the run", async () => {
    const run = await mint();
    // Snapshots are small enough to count past the row bound inside the byte bound.
    const snapshot = { partition: "shared", pending: 1, running: 1 };
    const many = {
      snapshots: Array.from({ length: OBSERVER_ROWS_MAX + 1 }, () => snapshot),
      sacct: [],
    };
    const tooMany = await post(run.token, many);
    expect(tooMany.status).toBe(400);
    expect(JSON.parse(tooMany.text).fields.join(" ")).toContain("snapshots");
    // Rows of the two kinds count together.
    const mixed = {
      snapshots: Array.from({ length: OBSERVER_ROWS_MAX - 1 }, () => snapshot),
      sacct: [minimalRow("1"), minimalRow("2")],
    };
    expect((await post(run.token, mixed)).status).toBe(400);
    const huge = await post(
      run.token,
      null,
      `{"snapshots":[],"sacct":[],"pad":"${"x".repeat(1_100_000)}"}`,
    );
    expect(huge.status).toBe(413);
    expect((await counts()).rows).toBe(0);
    expect((await post(run.token, empty)).status).toBe(200);
  });

  test("exactly 5,000 rows is accepted; thousands of Slurm rows are stored; a repeated Slurm id keeps the first", async () => {
    const snapshot = { partition: "shared", pending: 1, running: 1 };
    const exact = await post((await mint()).token, {
      snapshots: Array.from({ length: OBSERVER_ROWS_MAX }, () => snapshot),
      sacct: [],
    });
    expect(exact.status).toBe(200);
    // 1 MiB admits about 4,500 of the longest rows (231 bytes each), so 4,000 is the volume tested.
    const rows = Array.from({ length: 4000 }, (_, i) =>
      minimalRow(`9${String(i).padStart(7, "0")}`),
    );
    expect((await post((await mint()).token, { snapshots: [], sacct: rows })).status).toBe(200);
    expect((await counts()).rows).toBe(4000);
    const again = await mint();
    await post(again.token, {
      snapshots: [],
      sacct: [sacctRow("90000000", { elapsed_seconds: 5 })],
    });
    const kept = fx.harness.db
      .query("SELECT elapsed_seconds FROM compute_sacct_rows WHERE slurm_job_id = '90000000'")
      .get() as { elapsed_seconds: number };
    expect(kept.elapsed_seconds).toBe(1800);
  }, 60_000);

  test("queue snapshots are stored once per partition for the run", async () => {
    const run = await mint();
    const res = await post(run.token, {
      snapshots: [
        { partition: "shared", pending: 3, running: 9 },
        { partition: "gpu-shared", pending: 0, running: 2 },
      ],
      sacct: [],
    });
    expect(res.status).toBe(200);
    const rows = fx.harness.db
      .query("SELECT partition, pending, running FROM compute_queue_snapshots ORDER BY partition")
      .all();
    expect(rows).toEqual([
      { partition: "gpu-shared", pending: 0, running: 2 },
      { partition: "shared", pending: 3, running: 9 },
    ]);
  });
});

describe("final settlement", () => {
  test("a row within tolerance settles silently to Expanse's figure and sets no flag", async () => {
    const j = await endedJob(30);
    expect(j.job.charged_milli).toBe(2000);
    const run = await mint();
    const res = await post(run.token, {
      snapshots: [],
      sacct: [sacctRow(j.job.slurm_job_id as string, { charged_milli: 2500 })],
    });
    expect(res.status).toBe(200);
    const after = await reread(j.env, j.job.id);
    expect(after.settled_final_at).not.toBeNull();
    expect(after.charged_milli).toBe(2500);
    expect(after.flag_mismatch).toBe(0);
    const kinds = (
      await j.env.DB.prepare("SELECT kind, reason FROM compute_ledger WHERE job_id = ? ORDER BY id")
        .bind(j.job.id)
        .all<{ kind: string; reason: string | null }>()
    ).results;
    expect(kinds.map((k) => k.kind)).toEqual(["hold", "charge", "adjust"]);
    expect(kinds[2]?.reason).toBe("final_settlement");
    expect(JSON.parse(res.text)).toMatchObject({ settled: 1, mismatched: 0 });
  });

  test("a row beyond tolerance sets flag_mismatch and STILL settles to Expanse's figure (MUTATION: the tolerance test always true)", async () => {
    const j = await endedJob(30);
    const run = await mint();
    await post(run.token, {
      snapshots: [],
      sacct: [sacctRow(j.job.slurm_job_id as string, { charged_milli: 6000 })],
    });
    const after = await reread(j.env, j.job.id);
    expect(after.charged_milli).toBe(6000);
    expect(after.settled_final_at).not.toBeNull();
    expect(after.flag_mismatch).toBe(1);
  });

  test("the tolerance is the policy's: milli-SU or a percentage of the provisional charge", () => {
    const settle = DEFAULT_COMPUTE_POLICY.settle;
    expect(settle).toEqual({ toleranceMilli: 1000, tolerancePercent: 5 });
    expect(isRoutineDifference(2000, 2000, settle)).toBe(true);
    expect(isRoutineDifference(3000, 2000, settle)).toBe(true);
    expect(isRoutineDifference(3001, 2000, settle)).toBe(false);
    // 5% of 100,000 is 5,000: beyond 1,000 milli-SU but within the percentage.
    expect(isRoutineDifference(105_000, 100_000, settle)).toBe(true);
    expect(isRoutineDifference(105_001, 100_000, settle)).toBe(false);
    expect(isRoutineDifference(94_999, 100_000, settle)).toBe(false);
    expect(isRoutineDifference(0, 0, settle)).toBe(true);
    expect(isRoutineDifference(1001, 0, settle)).toBe(false);
  });

  test("without a figure of its own the Worker prices the allocation the row reports", async () => {
    const j = await endedJob(30);
    const run = await mint();
    // 8 cores for an hour is 8 SU, whatever Tapis said.
    await post(run.token, {
      snapshots: [],
      sacct: [
        sacctRow(j.job.slurm_job_id as string, {
          alloc_cpus: 8,
          elapsed_seconds: 3600,
          charged_milli: null,
        }),
      ],
    });
    const after = await reread(j.env, j.job.id);
    expect(after.charged_milli).toBe(8000);
    expect(after.flag_mismatch).toBe(1);
  });

  test("a final figure below the charge lowers the person's pool and the budget together, and the totals hold", async () => {
    const j = await endedJob(30);
    const before = await j.env.DB.prepare(
      "SELECT holder_kind, holder_ref, charged_milli FROM compute_pools ORDER BY id",
    ).all<{ holder_kind: string; holder_ref: string; charged_milli: number }>();
    const run = await mint();
    await post(run.token, {
      snapshots: [],
      sacct: [sacctRow(j.job.slurm_job_id as string, { charged_milli: 1500 })],
    });
    const after = await j.env.DB.prepare(
      "SELECT holder_kind, holder_ref, charged_milli FROM compute_pools ORDER BY id",
    ).all<{ holder_kind: string; holder_ref: string; charged_milli: number }>();
    const delta = after.results.map(
      (p, i) => p.charged_milli - (before.results[i]?.charged_milli ?? 0),
    );
    // The person's pool and the people budget each fell by 500; nothing else moved.
    expect(delta.filter((d) => d !== 0).sort()).toEqual([-500, -500]);
    const sums = await j.env.DB.prepare(
      `SELECT p.id, p.charged_milli AS stored, COALESCE((SELECT SUM(l.charged_delta_milli) FROM compute_ledger l
          WHERE l.pool_id = p.id OR l.budget_pool_id = p.id), 0) AS summed FROM compute_pools p`,
    ).all<{ stored: number; summed: number }>();
    for (const s of sums.results) expect(s.stored).toBe(s.summed);
  });

  test("a row whose job has not ended waits, and the next pass settles it once the job ends", async () => {
    const made = await makeJob(fx);
    await submitComputeJob(made.env, made.job.id);
    const uuid = (await reread(made.env, made.job.id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "QUEUED");
    fx.tapis.advance(uuid, "RUNNING");
    await advanceComputeJob(made.env, made.job.id);
    const slurm = (await reread(made.env, made.job.id)).slurm_job_id as string;
    const run = await mint();
    const res = await post(run.token, {
      snapshots: [],
      sacct: [sacctRow(slurm, { charged_milli: 2000 })],
    });
    expect(JSON.parse(res.text)).toMatchObject({ matched: 1, settled: 0 });
    expect((await reread(made.env, made.job.id)).settled_final_at).toBeNull();
    // The job ends afterwards.
    await playLauncher(fx, made.env, await reread(made.env, made.job.id), uuid, {});
    fx.tapis.advance(uuid, "FINISHED");
    setTapisTimes(fx, uuid, 30 * MINUTE, 0);
    await advanceComputeJob(made.env, made.job.id);
    const pass = await settleObservedRows(made.env);
    expect(pass.settled).toBe(1);
    expect((await reread(made.env, made.job.id)).settled_final_at).not.toBeNull();
    // And it is judged once: a later pass settles nothing more.
    expect((await settleObservedRows(made.env)).settled).toBe(0);
  });

  test("a job first seen RUNNING is finalized when a later export says COMPLETED (MUTATION: keep the first row)", async () => {
    const j = await endedJob(30);
    const slurm = j.job.slurm_job_id as string;
    const first = await mint();
    await post(first.token, {
      snapshots: [],
      sacct: [sacctRow(slurm, { state: "RUNNING", elapsed_seconds: 60, charged_milli: 99_000 })],
    });
    expect((await reread(j.env, j.job.id)).settled_final_at).toBeNull();
    const second = await mint();
    const res = await post(second.token, {
      snapshots: [],
      sacct: [sacctRow(slurm, { state: "COMPLETED", charged_milli: 2300 })],
    });
    expect(JSON.parse(res.text)).toMatchObject({ settled: 1 });
    const after = await reread(j.env, j.job.id);
    expect(after.settled_final_at).not.toBeNull();
    expect(after.charged_milli).toBe(2300);
    // And a later export does not rewrite a row that is ended and applied.
    const third = await mint();
    await post(third.token, { snapshots: [], sacct: [sacctRow(slurm, { charged_milli: 9999 })] });
    expect((await reread(j.env, j.job.id)).charged_milli).toBe(2300);
  });

  test("a row for a job still pending or running at Slurm is not Expanse's figure yet", async () => {
    const j = await endedJob(30);
    const run = await mint();
    await post(run.token, {
      snapshots: [],
      sacct: [sacctRow(j.job.slurm_job_id as string, { state: "RUNNING", charged_milli: 99_000 })],
    });
    expect((await reread(j.env, j.job.id)).settled_final_at).toBeNull();
  });

  test("a job that skipped the reservation has no hold to correct: its row is matched and listed, never settled", async () => {
    const j = await endedJob(30);
    await j.env.DB.prepare("UPDATE compute_jobs SET flag_unreserved = 1 WHERE id = ?")
      .bind(j.job.id)
      .run();
    const run = await mint();
    await post(run.token, {
      snapshots: [],
      sacct: [sacctRow(j.job.slurm_job_id as string, { charged_milli: 9000 })],
    });
    const after = await reread(j.env, j.job.id);
    expect(after.settled_final_at).toBeNull();
    const row = fx.harness.db
      .query("SELECT matched_job_id, applied_at FROM compute_sacct_rows WHERE slurm_job_id = ?")
      .get(j.job.slurm_job_id) as { matched_job_id: string | null; applied_at: string | null };
    expect(row.matched_job_id).toBe(j.job.id);
    expect(row.applied_at).toBeNull();
  });

  test("an unpriceable row is flagged once and judged, so it is not tried for ever", async () => {
    const j = await endedJob(30);
    const run = await mint();
    await post(run.token, {
      snapshots: [],
      sacct: [
        sacctRow(j.job.slurm_job_id as string, {
          partition: "weird",
          alloc_cpus: 0,
          alloc_mem_mb: 0,
          charged_milli: null,
        }),
      ],
    });
    // The job's own partition prices (shared) but with no cores or memory the rate needs one: unpriceable.
    const after = await reread(j.env, j.job.id);
    expect(after.flag_mismatch).toBe(1);
    expect(after.settled_final_at).toBeNull();
    const row = fx.harness.db
      .query("SELECT applied_at FROM compute_sacct_rows WHERE slurm_job_id = ?")
      .get(j.job.slurm_job_id) as { applied_at: string | null };
    expect(row.applied_at).not.toBeNull();
  });
});

describe("rows that match no job", () => {
  test("are stored with no match and listed, with a total", async () => {
    const run = await mint();
    await post(run.token, {
      snapshots: [],
      sacct: [sacctRow("77001"), sacctRow("77002", { state: "FAILED" })],
    });
    const listed = await listUnmatchedSacct(env().DB, 50);
    expect(listed.total).toBe(2);
    expect(listed.rows.map((r) => r.slurm_job_id).sort()).toEqual(["77001", "77002"]);
    expect(JSON.parse((await post((await mint()).token, empty)).text)).toMatchObject({
      unmatched: 0,
    });
  });

  test("the admin list shows them through the route, to an administrator and to no member", async () => {
    await seedComputeUsers(fx.harness.db);
    const run = await mint();
    await post(run.token, { snapshots: [], sacct: [sacctRow("77003")] });
    const ask = (key: string) =>
      adminApp(
        new Request("http://worker.test/admin/compute/jobs?unmatched=1", {
          headers: { Authorization: `Bearer ${key}` },
        }),
        env(),
      );
    const ok = await ask(COMPUTE_KEYS.admin);
    expect(ok.status).toBe(200);
    expect(
      ((await ok.json()) as { rows: Array<{ slurm_job_id: string }> }).rows[0]?.slurm_job_id,
    ).toBe("77003");
    expect((await ask(COMPUTE_KEYS.member)).status).toBe(403);
  });
});

describe("minting", () => {
  test("an administrator mints a one-hour run, audited, and the token is shown once", async () => {
    await seedComputeUsers(fx.harness.db);
    const res = await adminApp(
      new Request("http://worker.test/admin/compute/observer-runs", {
        method: "POST",
        headers: { Authorization: `Bearer ${COMPUTE_KEYS.admin}` },
      }),
      env(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      run_id: string;
      token: string;
      expires_in_minutes: number;
    };
    expect(body.expires_in_minutes).toBe(60);
    expect(body.token.startsWith(`${body.run_id}.`)).toBe(true);
    // The token is not stored: only the run and its nonce are.
    const stored = JSON.stringify(fx.harness.db.query("SELECT * FROM compute_observer_runs").all());
    expect(stored).not.toContain(body.token.split(".")[1] as string);
    const audit = fx.harness.db
      .query("SELECT action, resource_id FROM audit_log WHERE action = 'compute.observer.mint'")
      .all() as Array<{ action: string; resource_id: string }>;
    expect(audit).toEqual([{ action: "compute.observer.mint", resource_id: body.run_id }]);
    // And the minted token posts.
    expect((await post(body.token, empty)).status).toBe(200);
  });

  test("a member cannot mint, and with no callback secret nothing is minted", async () => {
    await seedComputeUsers(fx.harness.db);
    const member = await adminApp(
      new Request("http://worker.test/admin/compute/observer-runs", {
        method: "POST",
        headers: { Authorization: `Bearer ${COMPUTE_KEYS.member}` },
      }),
      env(),
    );
    expect(member.status).toBe(403);
    const none = await mintObserverRun(
      fx.env({ PRESCREEN_CALLBACK_SECRET: undefined }),
      fx.ownerId,
    );
    expect(none).toEqual({ ok: false, code: "unconfigured" });
    expect(fx.harness.db.query("SELECT COUNT(*) AS n FROM compute_observer_runs").get()).toEqual({
      n: 0,
    });
  });
});

describe("migration 0118", () => {
  const run = (sql: string, ...params: unknown[]) => {
    try {
      fx.harness.db.run(sql, params as never);
      return null;
    } catch (err) {
      return String(err);
    }
  };

  test("the tables refuse what their words do not allow", () => {
    expect(
      run(
        "INSERT INTO compute_observer_runs (id, nonce, expires_at, status) VALUES (?, ?, datetime('now','+1 hour'), 'bogus')",
        "11111111-2222-3333-4444-555555555555",
        "11111111-2222-3333-4444-555555555556",
      ),
    ).toMatch(/CHECK constraint failed: compute_observer_runs_status/);
    expect(
      run(
        "INSERT INTO compute_legal_holds (scope, ref, reason, placed_by) VALUES ('job', 'job_zz', 'legal_request', 1)",
      ),
    ).toMatch(/CHECK constraint failed: compute_legal_holds_ref/);
    expect(
      run(
        "INSERT INTO compute_legal_holds (scope, ref, reason, placed_by) VALUES ('account', '012', 'legal_request', 1)",
      ),
    ).toMatch(/CHECK constraint failed: compute_legal_holds_ref/);
    expect(
      run(
        "INSERT INTO compute_legal_holds (scope, ref, reason, placed_by) VALUES ('team', '12', 'legal_request', 1)",
      ),
    ).toMatch(/CHECK constraint failed: compute_legal_holds_scope/);
    expect(
      run(
        "INSERT INTO compute_legal_holds (scope, ref, reason, placed_by) VALUES ('account', '12', 'Not A Word', 1)",
      ),
    ).toMatch(/CHECK constraint failed: compute_legal_holds_reason/);
  });

  test("there is at most one ACTIVE hold per target, and a released one makes room", () => {
    expect(
      run(
        "INSERT INTO compute_legal_holds (scope, ref, reason, placed_by) VALUES ('account', '12', 'legal_request', 1)",
      ),
    ).toBeNull();
    expect(
      run(
        "INSERT INTO compute_legal_holds (scope, ref, reason, placed_by) VALUES ('account', '12', 'other_reason', 1)",
      ),
    ).toMatch(/UNIQUE/);
    expect(
      run("UPDATE compute_legal_holds SET released_at = datetime('now') WHERE ref = '12'"),
    ).toBeNull();
    expect(
      run(
        "INSERT INTO compute_legal_holds (scope, ref, reason, placed_by) VALUES ('account', '12', 'other_reason', 1)",
      ),
    ).toBeNull();
  });

  test("a snapshot is one row per partition per run, and a Slurm id is one row", () => {
    const rid = "11111111-2222-3333-4444-555555555555";
    expect(
      run(
        "INSERT INTO compute_queue_snapshots (run_id, partition, pending, running) VALUES (?, 'shared', 1, 2)",
        rid,
      ),
    ).toBeNull();
    expect(
      run(
        "INSERT INTO compute_queue_snapshots (run_id, partition, pending, running) VALUES (?, 'shared', 3, 4)",
        rid,
      ),
    ).toMatch(/UNIQUE|PRIMARY/);
    expect(
      run(
        "INSERT INTO compute_queue_snapshots (run_id, partition, pending, running) VALUES (?, 'shared', -1, 4)",
        "11111111-2222-3333-4444-555555555556",
      ),
    ).toMatch(/compute_queue_snapshots_pending/);
  });

  test("the file's GLOB patterns are within D1's 50 characters, and no table names a person", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sql = readFileSync(
      join(import.meta.dir, "../src/db/migrations/0118_compute_observer.sql"),
      "utf-8",
    );
    for (const m of sql.matchAll(/GLOB '([^']*)'/g))
      expect((m[1] ?? "").length).toBeLessThanOrEqual(50);
    for (const word of ["email", "name", "orcid", "country", "affiliation"]) {
      const tables = sql.split("CREATE TABLE").slice(1).join(" ");
      expect(new RegExp(`\\b${word}\\b`, "i").test(tables.replace(/--[^\n]*/g, ""))).toBe(false);
    }
  });
});

test("the refusal is the contract's job-not-found status family (a sanity check of the shared table)", () => {
  expect(COMPUTE_REFUSAL_STATUS.job_not_found).toBe(404);
});
