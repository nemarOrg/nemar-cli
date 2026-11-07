/**
 * Two submissions for the last service unit (epic #2021 phase D3, #2024): exactly one is 201, the loser
 * writes nothing and is given no upload address, and no object is left in either bucket for it.
 *
 * The database is wrapped so that every statement takes a round trip on BOTH sides (`roundTripD1`, as real
 * D1's latency is): two requests that each read the balance before either writes both see the old
 * balance, so the only thing that can separate them is the hold's own conditional statement.
 *
 * Why there is no case that presigns before the hold: `presignIncomingUploads` reads the job's row,
 * which exists only with its hold (`JOB_INSERT_SQL` waits for the hold row), so an address for a refused
 * hold cannot be made at all. What can regress is the route handing out an address it was not given, or
 * the job row outliving a refused hold; both are pinned below.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Bindings } from "../src/types/bindings";
import { roundTripD1, setPolicy, trace } from "./helpers/compute-seed";
import {
  type World,
  bundleRequest,
  call,
  makeBundle,
  newPerson,
  resetWorld,
  startWorld,
} from "./helpers/compute-submit-world";

let w: World;

beforeAll(async () => {
  w = await startWorld();
}, 120_000);

beforeEach(async () => {
  await resetWorld(w);
});

afterAll(async () => {
  await w?.fx.dispose();
}, 30_000);

const slow = (): Bindings => ({ ...w.env(), DB: roundTripD1(w.env().DB) });

describe("two submissions for the last SU", () => {
  for (const round of [1, 2, 3]) {
    test(`round ${round}: exactly one 201; the loser writes nothing, has no address and no object`, async () => {
      // 1 SU is 1000 milli: two cores for half an hour. The person holds exactly one job's worth.
      const p = await newPerson(w, { grant: 1000 });
      const a = makeBundle([{ path: "run.py", content: `a${round}` }]);
      const b = makeBundle([{ path: "run.py", content: `b${round}` }]);
      const env = slow();
      const [ra, rb] = await Promise.all([
        call(w, "POST", "/compute/jobs", { key: p.key, json: bundleRequest(a), env }),
        call(w, "POST", "/compute/jobs", { key: p.key, json: bundleRequest(b), env }),
      ]);
      const replies = [ra, rb];
      expect(replies.map((r) => r.status).sort()).toEqual([201, 409]);
      const won = replies.find((r) => r.status === 201)!;
      const lost = replies.find((r) => r.status === 409)!;
      expect(lost.body.code).toBe("insufficient_balance");
      // The loser was given nothing: no address, no job id, and no signature anywhere in its answer.
      expect(lost.body.upload).toBeUndefined();
      expect(lost.body.job_id).toBeUndefined();
      expect(lost.text).not.toContain("X-Amz");
      // One job, one hold, one pseudonym; the pool is fully held.
      const t = await trace(w.env().DB);
      expect([t.jobs, t.holds, t.gateway]).toEqual([1, 1, 1]);
      const pool = w.fx.harness.db
        .query(
          "SELECT held_milli, granted_milli FROM compute_pools WHERE holder_kind = 'account' AND holder_ref = ?",
        )
        .get(String(p.id)) as { held_milli: number; granted_milli: number };
      expect(pool.held_milli).toBe(1000);
      // Neither bucket holds anything of the loser's: the winner's two records and nothing else.
      expect(await w.fx.harness.keys(w.fx.harness.records)).toEqual([
        `records/${won.body.job_id}/identity.json`,
        `records/${won.body.job_id}/spec.json`,
      ]);
      expect(await w.fx.harness.keys(w.fx.harness.results)).toEqual([]);
    });
  }

  test("the person's live-job limit is the same kind of race: one slot, one winner, a loser with nothing", async () => {
    await setPolicy(w.env().DB, w.fx.ownerId, { maxLiveJobsPerPerson: 1 });
    const p = await newPerson(w, { grant: 100_000 });
    const env = slow();
    const [ra, rb] = await Promise.all([
      call(w, "POST", "/compute/jobs", {
        key: p.key,
        json: bundleRequest(makeBundle([{ path: "run.py", content: "x" }])),
        env,
      }),
      call(w, "POST", "/compute/jobs", {
        key: p.key,
        json: bundleRequest(makeBundle([{ path: "run.py", content: "y" }])),
        env,
      }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([201, 409]);
    const lost = ra.status === 409 ? ra : rb;
    expect(lost.body.code).toBe("over_concurrency");
    expect(lost.body.upload).toBeUndefined();
    const t = await trace(w.env().DB);
    expect([t.jobs, t.holds]).toEqual([1, 1]);
  });

  test("a refused hold leaves no job row behind to be given an address later", async () => {
    const p = await newPerson(w, { grant: 999 });
    const before = await trace(w.env().DB);
    const r = await call(w, "POST", "/compute/jobs", {
      key: p.key,
      json: bundleRequest(makeBundle()),
      env: slow(),
    });
    expect([r.status, r.body.code]).toEqual([409, "insufficient_balance"]);
    expect(await trace(w.env().DB)).toEqual(before);
    expect(await w.fx.harness.keys(w.fx.harness.records)).toEqual([]);
  });
});

describe("the same Idempotency-Key at once", () => {
  test("four parallel requests make one job and one hold, and every one is answered with it", async () => {
    const p = await newPerson(w, { grant: 100_000 });
    const bundle = makeBundle();
    const env = slow();
    const replies = await Promise.all(
      [1, 2, 3, 4].map(() =>
        call(w, "POST", "/compute/jobs", {
          key: p.key,
          json: bundleRequest(bundle),
          headers: { "Idempotency-Key": "key-race-abcdef" },
          env,
        }),
      ),
    );
    for (const r of replies) expect([r.status, r.body.state]).toEqual([201, "uploading"]);
    expect(new Set(replies.map((r) => r.body.job_id)).size).toBe(1);
    const t = await trace(w.env().DB);
    expect([t.jobs, t.holds]).toEqual([1, 1]);
    // Exactly one of the four was the original; the rest are replays of it.
    expect(replies.filter((r) => r.body.replayed === undefined).length).toBeLessThanOrEqual(1);
    for (const r of replies) expect(r.body.upload?.url).toBeDefined();
  });
});
