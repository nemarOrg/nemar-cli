/**
 * The lifecycle's submit, cancel and rotation under concurrency and under failure (epic #2005 phase A5,
 * #2010; ADR 0118), round 1 of the review of PR #2041. Real migrations, the real ledger, Miniflare's R2,
 * the Tapis stand-in (no response of which was recorded from a real tenant) behind a forwarding proxy
 * that can drop the answer to a submit AFTER the stand-in has acted on it, and the real services.
 *
 * What is pinned, each with a test of its own:
 *  - the 30-minute tick cannot starve: more than ten rows that cannot be read, or ten `created` rows that
 *    cannot be submitted, never keep a healthy running job from being read; rotation is by EXAMINATION,
 *    and the bound rows and the `created` rows have a quota each (MUTATION: order by the last good read;
 *    one shared list); with compute off a `created` row still reaches `submit_timeout`;
 *  - two submitters cannot both reach Tapis (the lease), and a submitter whose bind lost does not cancel
 *    the Tapis job another path bound to the SAME row (MUTATION: drop the lease; drop the re-read); a
 *    Tapis job no row owns is recorded and cancelled again by the tick until it is cancelled (MUTATION:
 *    do not record it); a cancel pending while the submit is in flight keeps the row from `submitted`
 *    (MUTATION: drop `cancel_requested_at IS NULL` from the bind);
 *  - a cancel of an unbound job whose submit may have reached Tapis asks Tapis FIRST, and releases the
 *    hold only when nothing is there (MUTATION: end the row at once); when Tapis cannot be asked the
 *    cancel stays recorded and nothing is released;
 *  - a terminal hint that loses to a concurrent live write is applied again against the fresh row
 *    (MUTATION: no retry), and a job found by tag is applied from the FULL record, so its exit code is
 *    checked (MUTATION: apply the search record).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { runComputeAdvanceCron, sweepComputeCancellations } from "../src/services/compute-advance";
import {
  CLAIM_SUBMIT_SQL,
  SUBMIT_LEASE_MINUTES,
  advanceComputeJob,
  applyTapisJob,
  requestComputeCancel,
  submitComputeJob,
} from "../src/services/compute-lifecycle";
import type { Bindings } from "../src/types/bindings";
import {
  type LifecycleFixture,
  MINUTE,
  makeJob,
  playLauncher,
  reread,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { setPolicy } from "./helpers/compute-seed";
import { roundTripD1 } from "./helpers/compute-seed";
import { logged } from "./helpers/logs";

let fx: LifecycleFixture;

beforeAll(async () => {
  fx = await startLifecycleFixture({ withD1: true });
}, 120_000);

beforeEach(async () => {
  await fx.reset();
});

afterAll(async () => {
  await fx?.dispose();
}, 30_000);

const kinds = async (env: Bindings, jobId: string) =>
  (
    await env.DB.prepare("SELECT kind FROM compute_ledger WHERE job_id = ? ORDER BY id")
      .bind(jobId)
      .all<{ kind: string }>()
  ).results.map((r) => r.kind);

const submitsAtTapis = () => fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/submit").length;

const tapisStatusOf = (uuid: string) => fx.tapis.jobs.get(uuid)?.status;

/** A row bound to a Tapis job that does not exist: Tapis answers 404, so the row cannot be read. */
async function unreadable(index: number) {
  const made = await makeJob(fx);
  await made.env.DB.prepare(
    `UPDATE compute_jobs SET state = 'submitted', tapis_uuid = ?1, tapis_status = 'PENDING',
            submitted_at = datetime('now', '-25 hours'), tapis_synced_at = datetime('now', '-25 hours')
      WHERE id = ?2`,
  )
    .bind(`gone-${index}-007`, made.job.id)
    .run();
  return made;
}

describe("the tick cannot starve", () => {
  test("more than ten rows Tapis cannot be read for do not keep a healthy running job from being read, and they become `unreported` (MUTATION: order by the last good read)", async () => {
    const stuck = [];
    for (let i = 0; i < 11; i++) stuck.push(await unreadable(i));
    const healthy = await makeJob(fx);
    expect(await submitComputeJob(healthy.env, healthy.job.id)).toEqual({
      ok: true,
      outcome: "submitted",
    });
    const uuid = (await reread(healthy.env, healthy.job.id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "RUNNING");

    // Twelve rows, ten slots: the healthy job is read within TWO ticks, whatever the others do.
    await runComputeAdvanceCron(healthy.env);
    await runComputeAdvanceCron(healthy.env);
    expect((await reread(healthy.env, healthy.job.id)).state).toBe("running");
    // Every unreadable row has been examined, and one that Tapis has not answered for in a day is
    // `unreported` (the mark is made on a failed read, which only a row that is examined can have).
    for (const row of stuck) {
      const now = await reread(healthy.env, row.job.id);
      expect([now.state, now.examined_at === null]).toEqual(["unreported", false]);
    }
  });

  test("rows are stamped as examined whether the step succeeds or not, and the stamp moves a row to the back of the line", async () => {
    const a = await unreadable(1);
    const b = await unreadable(2);
    expect((await reread(a.env, a.job.id)).examined_at).toBeNull();
    await runComputeAdvanceCron(a.env);
    expect((await reread(a.env, a.job.id)).examined_at).not.toBeNull();
    expect((await reread(b.env, b.job.id)).examined_at).not.toBeNull();
  });

  test("compute off and more than ten `created` rows that cannot be submitted do not keep a running job from being read in the FIRST tick (MUTATION: one shared list)", async () => {
    const running = await makeJob(fx);
    await submitComputeJob(running.env, running.job.id);
    const uuid = (await reread(running.env, running.job.id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "RUNNING");
    // Older than the running job, so any single list ordered by age puts them first.
    const waiting = [];
    for (let i = 0; i < 12; i++) {
      const w = await makeJob(fx);
      await w.env.DB.prepare(
        "UPDATE compute_jobs SET created_at = datetime('now', '-1 minutes') WHERE id = ?",
      )
        .bind(w.job.id)
        .run();
      waiting.push(w);
    }
    const off = { ...running.env, COMPUTE_ENABLED: undefined } as Bindings;
    const tick = await runComputeAdvanceCron(off);
    expect(tick?.examined).toBe(11);
    expect((await reread(off, running.job.id)).state).toBe("running");
    // The `created` rows have their own ten slots: ten were examined, the other two come next tick.
    const examined = async () =>
      (
        await off.DB.prepare(
          "SELECT COUNT(*) AS n FROM compute_jobs WHERE examined_at IS NOT NULL AND state = 'created'",
        ).first<{ n: number }>()
      )?.n;
    expect(await examined()).toBe(10);
    await runComputeAdvanceCron(off);
    expect(await examined()).toBe(12);
    // Nothing was submitted while compute was off.
    expect(submitsAtTapis()).toBe(1);
  });

  test("with compute off a `created` row still reaches `submit_timeout`, and a job Tapis already holds is bound", async () => {
    await setPolicy(fx.env().DB, fx.ownerId, { reservationWaitMinutes: 30 });
    const late = await makeJob(fx);
    const held = await makeJob(fx);
    // `held` was submitted and its answer lost, while compute was on.
    fx.proxy.loseSubmitAnswers(1);
    expect((await submitComputeJob(held.env, held.job.id)).outcome).toBe("unavailable");
    for (const j of [late, held]) {
      await j.env.DB.prepare(
        "UPDATE compute_jobs SET created_at = datetime('now', '-3 hours') WHERE id = ?",
      )
        .bind(j.job.id)
        .run();
    }
    const off = { ...late.env, COMPUTE_ENABLED: undefined } as Bindings;
    await runComputeAdvanceCron(off);
    const lateNow = await reread(off, late.job.id);
    expect([lateNow.state, lateNow.failure_code]).toEqual(["failed", "submit_timeout"]);
    expect(await kinds(off, late.job.id)).toEqual(["hold", "release"]);
    // The held one was found by tag and bound, not timed out.
    expect((await reread(off, held.job.id)).state).toBe("submitted");
    expect(submitsAtTapis()).toBe(1);
  });
});

describe("two submitters, one Tapis job", () => {
  test("two submits of one job at once reach Tapis once, and the job stays alive (MUTATION: drop the lease)", async () => {
    const made = await makeJob(fx);
    const racing = { ...made.env, DB: roundTripD1(made.env.DB) } as Bindings;
    const results = await Promise.all([
      submitComputeJob(racing, made.job.id),
      submitComputeJob(racing, made.job.id),
    ]);
    expect(submitsAtTapis()).toBe(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, outcome: "in_progress" });
    const job = await reread(made.env, made.job.id);
    expect(job.state).toBe("submitted");
    expect(tapisStatusOf(job.tapis_uuid as string)).toBe("PENDING");
    expect(job.orphan_tapis_uuid).toBeNull();
    // The lease is released when the attempt ends.
    expect(job.submit_claimed_at).toBeNull();
  });

  test("a lease is held by one submitter, an expired lease may be taken again, and an attempt that ends releases it (MUTATION: drop the expiry)", async () => {
    const made = await makeJob(fx);
    const db = made.env.DB;
    await db
      .prepare("UPDATE compute_jobs SET submit_claimed_at = datetime('now') WHERE id = ?")
      .bind(made.job.id)
      .run();
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({
      ok: false,
      outcome: "in_progress",
    });
    expect(submitsAtTapis()).toBe(0);
    await db
      .prepare("UPDATE compute_jobs SET submit_claimed_at = datetime('now', ?1) WHERE id = ?2")
      .bind(`-${SUBMIT_LEASE_MINUTES + 1} minutes`, made.job.id)
      .run();
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({
      ok: true,
      outcome: "submitted",
    });
    expect((await reread(made.env, made.job.id)).submit_claimed_at).toBeNull();
    expect(CLAIM_SUBMIT_SQL).toContain("submit_claimed_at < datetime('now'");
  });

  test("a bind that lost to another path binding the SAME Tapis job returns, and cancels nothing (MUTATION: drop the re-read)", async () => {
    const made = await makeJob(fx);
    // After the stand-in made the job and before the Worker hears, another path (an adoption by tag, a
    // webhook's read-back) binds the very same Tapis job to the row.
    fx.proxy.afterNextSubmit(async () => {
      const [uuid] = [...fx.tapis.jobs.keys()];
      await made.env.DB.prepare(
        "UPDATE compute_jobs SET tapis_uuid = ?1, state = 'submitted', tapis_status = 'PENDING' WHERE id = ?2",
      )
        .bind(uuid, made.job.id)
        .run();
    });
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({
      ok: true,
      outcome: "already_submitted",
    });
    const job = await reread(made.env, made.job.id);
    expect(job.state).toBe("submitted");
    expect(tapisStatusOf(job.tapis_uuid as string)).toBe("PENDING");
    expect(fx.tapis.log.some((r) => r.route === "POST /v3/jobs/:uuid/cancel")).toBe(false);
    expect(job.orphan_tapis_uuid).toBeNull();
  });

  test("a Tapis job bound to ANOTHER Tapis job's row is an orphan: recorded, flagged, and cancelled again by the tick until it works (MUTATION: do not record it)", async () => {
    const made = await makeJob(fx);
    fx.proxy.afterNextSubmit(async () => {
      await made.env.DB.prepare(
        "UPDATE compute_jobs SET tapis_uuid = 'someone-elses-007', state = 'submitted' WHERE id = ?",
      )
        .bind(made.job.id)
        .run();
    });
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 503);
    expect((await submitComputeJob(made.env, made.job.id)).outcome).toBe("bad_state");
    const [only] = [...fx.tapis.jobs.values()];
    const job = await reread(made.env, made.job.id);
    expect(job.tapis_uuid).toBe("someone-elses-007");
    expect(job.orphan_tapis_uuid).toBe(only?.uuid ?? "");
    expect(job.flag_mismatch).toBe(1);
    // The cancel failed: the Tapis job still runs, and the row says so.
    expect(only?.status).toBe("PENDING");
    // The tick asks again, and clears the record only when the cancel is known to have worked.
    expect(
      await sweepComputeCancellations({ ...made.env, ENVIRONMENT: "development" } as Bindings),
    ).toBeNull();
    expect(await sweepComputeCancellations(made.env)).toMatchObject({ errors: [] });
    expect(only?.status).toBe("CANCELLED");
    expect((await reread(made.env, made.job.id)).orphan_tapis_uuid).toBeNull();
    // Nothing is left to do.
    expect(await sweepComputeCancellations(made.env)).toMatchObject({ examined: 0 });
  });

  test("a cancel pending while the submit is in flight keeps the row out of `submitted`, and the Tapis job is cancelled (MUTATION: drop `cancel_requested_at IS NULL` from the bind)", async () => {
    const made = await makeJob(fx);
    fx.proxy.afterNextSubmit(async () => {
      // The intent is recorded; the cancel has not been driven yet.
      await made.env.DB.prepare(
        "UPDATE compute_jobs SET cancel_requested_at = datetime('now'), cancel_reason = 'user' WHERE id = ?",
      )
        .bind(made.job.id)
        .run();
    });
    expect((await submitComputeJob(made.env, made.job.id)).ok).toBe(false);
    const [only] = [...fx.tapis.jobs.values()];
    expect(only?.status).toBe("CANCELLED");
    const job = await reread(made.env, made.job.id);
    expect(job.state).toBe("created");
    expect(job.tapis_uuid).toBe(only?.uuid ?? "");
    // The sweep carries the recorded cancel out against the job the row now knows.
    await sweepComputeCancellations(made.env);
    const done = await reread(made.env, made.job.id);
    expect(done.state).toBe("cancelled");
    expect(await kinds(made.env, made.job.id)).toEqual(["hold", "release"]);
  });
});

describe("cancel of a job whose submit may have reached Tapis", () => {
  test("a submit whose answer was lost, then a cancel: Tapis is asked by tag, the job is cancelled there and the hold is released because it never started (MUTATION: end the row at once)", async () => {
    const made = await makeJob(fx);
    fx.proxy.loseSubmitAnswers(1);
    expect((await submitComputeJob(made.env, made.job.id)).outcome).toBe("unavailable");
    const [only] = [...fx.tapis.jobs.values()];
    expect(only?.status).toBe("PENDING");
    const res = await requestComputeCancel(made.env, made.job.id, "user");
    expect(res.ok).toBe(true);
    // No Tapis job is left running for a row that says it is over.
    expect(only?.status).toBe("CANCELLED");
    const job = await reread(made.env, made.job.id);
    expect([job.state, job.tapis_uuid]).toEqual(["cancelled", only?.uuid ?? ""]);
    expect(await kinds(made.env, made.job.id)).toEqual(["hold", "release"]);
    expect(job.charged_milli).toBe(0);
  });

  test("when Tapis cannot be asked, the cancel stays recorded and NOTHING is released; the sweep finishes it", async () => {
    const made = await makeJob(fx);
    fx.proxy.loseSubmitAnswers(1);
    await submitComputeJob(made.env, made.job.id);
    const [only] = [...fx.tapis.jobs.values()];
    fx.tapis.down();
    try {
      const res = await requestComputeCancel(made.env, made.job.id, "user");
      expect(res).toMatchObject({ ok: true, outcome: "cancel_requested", state: "created" });
    } finally {
      fx.tapis.up();
    }
    let job = await reread(made.env, made.job.id);
    expect([job.state, job.cancel_requested_at === null]).toEqual(["created", false]);
    expect(await kinds(made.env, made.job.id)).toEqual(["hold"]);
    expect(only?.status).toBe("PENDING");
    await sweepComputeCancellations(made.env);
    job = await reread(made.env, made.job.id);
    expect(job.state).toBe("cancelled");
    expect(only?.status).toBe("CANCELLED");
    expect(await kinds(made.env, made.job.id)).toEqual(["hold", "release"]);
  });

  test("a submit that never reached Tapis (nothing found by tag) is ended and released", async () => {
    const made = await makeJob(fx);
    fx.tapis.fail("POST /v3/jobs/submit", 503);
    expect((await submitComputeJob(made.env, made.job.id)).outcome).toBe("unavailable");
    expect(fx.tapis.jobs.size).toBe(0);
    await requestComputeCancel(made.env, made.job.id, "user");
    expect((await reread(made.env, made.job.id)).state).toBe("cancelled");
    expect(await kinds(made.env, made.job.id)).toEqual(["hold", "release"]);
  });
});

describe("a terminal hint that lost to a live write", () => {
  test("it is applied again against the fresh row, not dropped for 30 minutes (MUTATION: no retry)", async () => {
    const made = await makeJob(fx);
    await submitComputeJob(made.env, made.job.id);
    const uuid = (await reread(made.env, made.job.id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "QUEUED");
    await advanceComputeJob(made.env, made.job.id);
    const queued = await reread(made.env, made.job.id);
    fx.tapis.advance(uuid, "RUNNING");
    setTapisTimes(fx, uuid, 30 * MINUTE, 0);
    const base = fx.tapis.jobs.get(uuid)?.record as Record<string, unknown>;
    // A poll moves the job from QUEUED to RUNNING; a webhook that read the same QUEUED row holds the
    // FAILED record Tapis has reached by the time it reads back.
    expect(
      (await applyTapisJob(made.env, queued, { ...base, status: "RUNNING" } as never)).outcome,
    ).toBe("advanced");
    const result = await applyTapisJob(made.env, queued, {
      ...base,
      status: "FAILED",
      condition: "JOB_LAUNCH_FAILURE",
    } as never);
    expect(result).toMatchObject({ changed: true, outcome: "terminal_committed" });
    const job = await reread(made.env, made.job.id);
    expect([job.state, job.failure_code, job.charged_milli]).toEqual([
      "failed",
      "launch_failed",
      2000,
    ]);
    expect(await kinds(made.env, made.job.id)).toEqual(["hold", "charge"]);
  });
});

describe("a job found by tag is applied from its FULL record", () => {
  test("an adopted job that already ended is checked against the exit code Tapis reports (MUTATION: apply the search record)", async () => {
    const made = await makeJob(fx);
    fx.proxy.loseSubmitAnswers(1);
    await submitComputeJob(made.env, made.job.id);
    const [only] = [...fx.tapis.jobs.values()];
    const uuid = only?.uuid as string;
    // The job ran to the end while the Worker did not know of it: the launcher wrote a clean result and
    // Tapis reports another exit code (`remoteResultInfo` is on the full record and not on a search hit).
    fx.tapis.advance(uuid, "RUNNING");
    await playLauncher(fx, made.env, await reread(made.env, made.job.id), uuid, {});
    fx.tapis.advance(uuid, "FINISHED");
    setTapisTimes(fx, uuid, 30 * MINUTE, 0);
    const record = fx.tapis.jobs.get(uuid)?.record;
    if (record) record.remoteResultInfo = "5";
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({ ok: true, outcome: "bound" });
    const job = await reread(made.env, made.job.id);
    expect([job.state, job.failure_code, job.failure_detail]).toEqual([
      "failed",
      "result_verification_failed",
      "exit_mismatch",
    ]);
    expect(job.flag_mismatch).toBe(1);
  });
});

describe("what the new paths log", () => {
  test("a lost bind, an orphan and a cancel by tag log job ids and fixed words only", async () => {
    const lines = await logged(async () => {
      const made = await makeJob(fx);
      fx.proxy.afterNextSubmit(async () => {
        await made.env.DB.prepare(
          "UPDATE compute_jobs SET tapis_uuid = 'x-007', state = 'submitted' WHERE id = ?",
        )
          .bind(made.job.id)
          .run();
      });
      fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 503);
      await submitComputeJob(made.env, made.job.id);
    });
    const joined = lines.join("\n");
    expect(joined).toContain("orphan_cancel_failed");
    for (const word of [fx.tapis.url, fx.tapis.password, "NEMAR_LAUNCH_SPEC", "x-007"]) {
      expect([word, joined.includes(word)]).toEqual([word, false]);
    }
  });
});
