/**
 * `createJob` (epic #2005 phase A3, #2008; ADR 0118, decision 3), against the real migrations, the
 * real ledger and Miniflare's R2 through the Worker's own bindings, on bun:sqlite and on Miniflare's
 * D1 (the engine `wrangler --local` runs, where the batch and the gate on it are D1's own).
 *
 * What is pinned: a job and its hold are ONE batch, so a refused hold leaves no job row, no ledger
 * row, no pseudonym, no pool and no object in either bucket (a balance, a platform budget, a live-job
 * limit, a frozen pool, no pool at all: each, on both engines); an accepted one leaves one of each,
 * linked by `hold_ledger_id`, with the hold's amount on the job; records are written AFTER the commit
 * and never before (the first write is seen to find the job and its hold already there); a replayed
 * `(account, idempotency key)` returns the existing job and, for another request, is refused; two
 * requests racing for the last live-job slot cannot both win, nor can two with the same key make two
 * jobs; the specification is validated before any hold exists; no identity field is in a job row or
 * in a log line, and identity is in the records bucket only; the gateway pseudonym is made once per
 * account, stored, and shared by that account's jobs.
 *
 * MUTATION (proved by hand, see the pull request): removing the EXISTS term of `JOB_INSERT_SQL` makes
 * the refused-hold cases see a job row; writing the records before the batch makes them see an object.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { COMPUTE_STATES } from "../../shared/compute-state";
import {
  DEFAULT_COMPUTE_POLICY,
  PIPELINES_TAPIS_OWNER,
  estimateSuMilli,
} from "../../shared/contract/compute";
import {
  ComputeJobError,
  type ComputeJobRow,
  GATEWAY_USER_INSERT_SQL,
  JOB_BY_ID_SQL,
  JOB_BY_KEY_SQL,
  JOB_INSERT_SQL,
  LIVE_JOBS_GUARD_SQL,
  createJob,
  getJob,
  newGatewayUser,
  newJobId,
} from "../src/services/compute-jobs";
import { placeHold } from "../src/services/compute-ledger";
import type { Bindings } from "../src/types/bindings";
import { type ComputeHarness, startComputeHarness } from "./helpers/compute-harness";
import {
  FOUR_SU,
  fundAccount,
  fundPartner,
  fundPlatform,
  hex,
  jobSpec,
  seedUser,
  setPolicy,
  sha256Hex,
  trace,
} from "./helpers/compute-seed";
import { yieldingD1 } from "./helpers/d1";

let h: ComputeHarness;
/** An owner of the Miniflare D1, which is never reset: the policy is restored to the default before each case. */
let miniflareOwner = 0;

beforeAll(async () => {
  h = await startComputeHarness({ withD1: true });
  miniflareOwner = await seedUser(h.d1 as D1Database, { role: "owner" });
}, 90_000);

beforeEach(async () => {
  await h.reset();
  await setPolicy(h.d1 as D1Database, miniflareOwner, {});
});

afterAll(async () => {
  await h?.dispose();
}, 30_000);

/** The two engines a job is created on. Miniflare's D1 is never reset, so a case reads only its own. */
interface World {
  name: string;
  d1: D1Database;
  env(over?: Partial<Bindings>): Bindings;
}
const worlds = (): World[] => [
  { name: "bun:sqlite", d1: h.env().DB, env: (over) => h.env(over) },
  { name: "Miniflare D1", d1: h.d1 as D1Database, env: (over) => h.env({ DB: h.d1, ...over }) },
];

/** Run a case on both engines; `h.reset()` has already given bun:sqlite a new database. */
function onBoth(name: string, body: (w: World) => Promise<void>) {
  for (const which of [0, 1]) {
    test(`${name} [${which === 0 ? "bun:sqlite" : "Miniflare D1"}]`, async () => {
      const w = worlds()[which] as World;
      await body(w);
    });
  }
}

/** The environment for requests that overlap. bun:sqlite answers a statement before the next one starts, so
 *  each statement waits a macrotask, as D1's network round trip does; Miniflare's D1 is asynchronous already. */
const racing = (w: World): Bindings =>
  w.name === "bun:sqlite" ? w.env({ DB: yieldingD1(w.d1) }) : w.env();

const rowOf = async (d1: D1Database, id: string) =>
  (await d1
    .prepare("SELECT * FROM compute_jobs WHERE id = ?")
    .bind(id)
    .first<ComputeJobRow>()) as ComputeJobRow;

/** A person who may spend `grant` on `shared`, with a platform budget that does not bind. */
async function person(w: World, grant = 100_000) {
  const accountId = await seedUser(w.d1);
  const poolId = await fundAccount(w.d1, accountId, grant);
  await fundPlatform(w.d1, "people", 1_000_000_000);
  return { accountId, poolId };
}

const input = (accountId: number | null, over: Record<string, unknown> = {}) => ({
  source: "cli" as const,
  accountId,
  appId: "nemar-launch",
  appVersion: "1.0.0",
  spec: jobSpec(),
  ...over,
});

async function bucketKeys(): Promise<{ records: string[]; results: string[] }> {
  return { records: await h.keys(h.records), results: await h.keys(h.results) };
}

const sha = async (key: string) => {
  const object = await h.records.get(key);
  return object ? sha256Hex(new Uint8Array(await object.arrayBuffer())) : null;
};

describe("an accepted job", () => {
  onBoth("leaves one job, one hold linked by hold_ledger_id, and the two records", async (w) => {
    const { accountId, poolId } = await person(w);
    const before = await trace(w.d1);
    const r = await createJob(w.env(), input(accountId));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.replayed).toBe(false);
    expect(r.recordsWritten).toBe(true);

    const after = await trace(w.d1);
    expect(after.jobs - before.jobs).toBe(1);
    expect(after.holds - before.holds).toBe(1);
    expect(after.ledger - before.ledger).toBe(1);

    const job = await rowOf(w.d1, r.job.id);
    expect(job.id).toMatch(/^job_[0-9a-f]{24}$/);
    expect(job).toMatchObject({
      account_id: accountId,
      source: "cli",
      kind: "batch",
      state: "created",
      app_id: "nemar-launch",
      app_version: "1.0.0",
      partition: "shared",
      pool: "cpu",
      nodes: 1,
      cores_per_node: 4,
      gpus: 0,
      minutes: 60,
      held_milli: FOUR_SU,
      charged_milli: 0,
      failure_code: null,
      flag_unreserved: 0,
      legal_hold: 0,
    });
    expect(job.held_milli).toBe(estimateSuMilli(jobSpec()));
    expect(job.webhook_nonce).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(job.gateway_user).toMatch(/^gw_[a-z2-7]{20}$/);
    expect(job.records_written_at).not.toBeNull();

    const hold = await w.d1
      .prepare("SELECT * FROM compute_ledger WHERE job_id = ?")
      .bind(job.id)
      .all<{
        id: number;
        kind: string;
        pool_id: number;
        held_delta_milli: number;
        idempotency_key: string;
      }>();
    expect(hold.results).toHaveLength(1);
    expect(hold.results[0]).toMatchObject({
      kind: "hold",
      pool_id: poolId,
      held_delta_milli: FOUR_SU,
      idempotency_key: `job:${job.id}:hold`,
    });
    expect(job.hold_ledger_id).toBe(hold.results[0]?.id as number);

    // The pool and the platform budget both carry the hold.
    const pool = await w.d1
      .prepare("SELECT held_milli FROM compute_pools WHERE id = ?")
      .bind(poolId)
      .first<{ held_milli: number }>();
    expect(pool?.held_milli).toBe(FOUR_SU);

    expect((await bucketKeys()).results).toEqual([]);
  });

  onBoth(
    "records exactly identity.json and spec.json, and the digest is of the bytes of spec.json",
    async (w) => {
      const { accountId } = await person(w);
      const before = new Set((await bucketKeys()).records);
      const r = await createJob(w.env(), input(accountId));
      if (!r.ok) throw new Error("not accepted");
      const mine = (await bucketKeys()).records.filter((k) => !before.has(k));
      expect(mine).toEqual([`records/${r.job.id}/identity.json`, `records/${r.job.id}/spec.json`]);
      expect(r.job.spec_digest).toBe(await sha(`records/${r.job.id}/spec.json`));
      const stored = JSON.parse(
        (await (await h.records.get(`records/${r.job.id}/spec.json`))?.text()) ?? "{}",
      );
      expect(stored).toEqual(JSON.parse(JSON.stringify(jobSpec())));
      expect(r.job.records_written_at).not.toBeNull();
    },
  );

  onBoth("a job with a code bundle is not marked written: finalizeBundle does that", async (w) => {
    const { accountId } = await person(w);
    const bundle = { size: 1234, sha256: hex(77) };
    const r = await createJob(
      w.env(),
      input(accountId, {
        spec: jobSpec({ recipe: undefined, entry: "run.py", bundle }),
      }),
    );
    if (!r.ok) throw new Error(`refused: ${r.code}`);
    expect(r.recordsWritten).toBe(true);
    expect(r.job.records_written_at).toBeNull();
    expect(await rowOf(w.d1, r.job.id)).toMatchObject({
      records_written_at: null,
      state: "created",
    });
    expect((await h.records.head(`records/${r.job.id}/spec.json`)) !== null).toBe(true);
    expect((await h.records.head(`records/${r.job.id}/identity.json`)) !== null).toBe(true);
  });

  onBoth("the records are written after the commit, never before", async (w) => {
    const { accountId } = await person(w);
    const seen: Array<{ key: string; jobs: number; holds: number }> = [];
    const watching = {
      put: async (key: string, value: unknown, options?: unknown) => {
        const id = /^records\/(job_[0-9a-f]{24})\//.exec(key)?.[1] ?? "";
        seen.push({
          key,
          jobs:
            (
              await w.d1
                .prepare("SELECT COUNT(*) AS n FROM compute_jobs WHERE id = ?")
                .bind(id)
                .first<{ n: number }>()
            )?.n ?? -1,
          holds:
            (
              await w.d1
                .prepare(
                  "SELECT COUNT(*) AS n FROM compute_ledger WHERE kind = 'hold' AND job_id = ?",
                )
                .bind(id)
                .first<{ n: number }>()
            )?.n ?? -1,
        });
        return h.records.put(key, value as ArrayBuffer, options as Parameters<R2Bucket["put"]>[2]);
      },
      get: (key: string) => h.records.get(key),
      head: (key: string) => h.records.head(key),
      delete: (key: string) => h.records.delete(key),
      list: (o?: Parameters<R2Bucket["list"]>[0]) => h.records.list(o),
    } as unknown as R2Bucket;
    const r = await createJob(w.env({ COMPUTE_RECORDS: watching }), input(accountId));
    expect(r.ok).toBe(true);
    expect(seen.map((s) => s.key.split("/")[2]).sort()).toEqual(["identity.json", "spec.json"]);
    for (const s of seen) expect(s).toMatchObject({ jobs: 1, holds: 1 });
  });

  onBoth(
    "the gateway pseudonym is made once per account, stored, and shared by its jobs",
    async (w) => {
      const a = await person(w);
      const b = await person(w);
      const first = await createJob(w.env(), input(a.accountId));
      const second = await createJob(w.env(), input(a.accountId));
      const other = await createJob(w.env(), input(b.accountId));
      if (!first.ok || !second.ok || !other.ok) throw new Error("not accepted");
      expect(first.job.gateway_user).toMatch(/^gw_[a-z2-7]{20}$/);
      expect(second.job.gateway_user).toBe(first.job.gateway_user);
      expect(other.job.gateway_user).not.toBe(first.job.gateway_user);
      const stored = await w.d1
        .prepare("SELECT gateway_user FROM compute_gateway_users WHERE account_id = ?")
        .bind(a.accountId)
        .all<{ gateway_user: string }>();
      expect(stored.results).toEqual([{ gateway_user: first.job.gateway_user as string }]);
    },
  );

  test("a job id and a pseudonym have the shapes the table takes, and are not repeated", () => {
    const ids = new Set(Array.from({ length: 200 }, newJobId));
    const names = new Set(Array.from({ length: 200 }, newGatewayUser));
    expect(ids.size).toBe(200);
    expect(names.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^job_[0-9a-f]{24}$/);
    for (const n of names) expect(n).toMatch(/^gw_[a-z2-7]{20}$/);
  });
});

describe("a refused hold leaves no trace", () => {
  /** Everything that may not move: rows, pools, the pseudonym table, and every object of both buckets. */
  async function snapshot(w: World) {
    return { rows: await trace(w.d1), buckets: await bucketKeys() };
  }

  async function refused(
    w: World,
    accountId: number | null,
    code: string,
    over: Record<string, unknown> = {},
  ) {
    const before = await snapshot(w);
    const r = await createJob(w.env(), input(accountId, over));
    expect(r).toMatchObject({ ok: false, code });
    expect(await snapshot(w)).toEqual(before);
  }

  onBoth("when the balance is short", async (w) => {
    const accountId = await seedUser(w.d1);
    await fundAccount(w.d1, accountId, FOUR_SU - 1);
    await fundPlatform(w.d1, "people", 1_000_000_000);
    await refused(w, accountId, "insufficient_balance");
  });

  onBoth("when the person has no pool at all, and makes none", async (w) => {
    const accountId = await seedUser(w.d1);
    await fundPlatform(w.d1, "people", 1_000_000_000);
    await refused(w, accountId, "insufficient_balance");
  });

  onBoth("when the platform budget cannot cover it", async (w) => {
    // The budget is shared by every case on a database that is never reset, so spend it down
    // exactly: a hold of everything it has left makes the next one the first to fail.
    const accountId = await seedUser(w.d1);
    await fundAccount(w.d1, accountId, 100_000);
    const budget = await w.d1
      .prepare(
        "SELECT id, granted_milli - held_milli - charged_milli AS available FROM compute_pools WHERE holder_kind = 'platform' AND holder_ref = 'people' AND pool = 'cpu'",
      )
      .first<{ id: number; available: number }>();
    expect(budget).not.toBeNull();
    // Take the budget's available down to less than the hold with a pseudo-person's own hold.
    const spare = Math.max(0, (budget?.available as number) - (FOUR_SU - 1));
    if (spare > 0) {
      const hog = await seedUser(w.d1);
      const hogPool = await fundAccount(w.d1, hog, spare);
      const held = await placeHold(w.d1, {
        poolId: hogPool,
        budgetPoolId: budget?.id as number,
        amountMilli: spare,
        jobId: newJobId(),
      });
      expect(held.ok).toBe(true);
    }
    await refused(w, accountId, "platform_budget_exhausted");
  });

  onBoth("when the pool is frozen", async (w) => {
    const { accountId, poolId } = await person(w);
    await w.d1.prepare("UPDATE compute_pools SET frozen = 1 WHERE id = ?").bind(poolId).run();
    await refused(w, accountId, "suspended");
  });

  onBoth("when the live-job limit is reached, then not once a job ends", async (w) => {
    const owner = await seedUser(w.d1, { role: "owner" });
    await setPolicy(w.d1, owner, { maxLiveJobsPerPerson: 1 });
    const { accountId } = await person(w);
    const first = await createJob(w.env(), input(accountId));
    if (!first.ok) throw new Error("not accepted");
    await refused(w, accountId, "over_concurrency");
    // Another person's jobs are not this person's.
    const other = await person(w);
    expect((await createJob(w.env(), input(other.accountId))).ok).toBe(true);
    // A job that has ended no longer counts.
    await w.d1
      .prepare("UPDATE compute_jobs SET state = 'finished' WHERE id = ?")
      .bind(first.job.id)
      .run();
    expect((await createJob(w.env(), input(accountId))).ok).toBe(true);
    await refused(w, accountId, "over_concurrency");
  });

  test("every live state counts and no terminal state does, for the limit", async () => {
    const w = worlds()[0] as World;
    const owner = await seedUser(w.d1, { role: "owner" });
    await setPolicy(w.d1, owner, { maxLiveJobsPerPerson: 1 });
    const { accountId } = await person(w);
    const first = await createJob(w.env(), input(accountId));
    if (!first.ok) throw new Error("not accepted");
    const failed = { state: "failed", failure_code: "launch_failed" };
    for (const state of COMPUTE_STATES) {
      const set = state === "failed" ? failed : { state };
      await w.d1
        .prepare("UPDATE compute_jobs SET state = ?, failure_code = ? WHERE id = ?")
        .bind(set.state, (set as { failure_code?: string }).failure_code ?? null, first.job.id)
        .run();
      const terminal = state === "finished" || state === "failed" || state === "cancelled";
      const r = await createJob(w.env(), input(accountId));
      expect([state, r.ok]).toEqual([state, terminal]);
      if (r.ok) {
        await w.d1
          .prepare("UPDATE compute_jobs SET state = 'finished' WHERE id = ?")
          .bind(r.job.id)
          .run();
      }
    }
  });

  onBoth("when the specification is over the job ceiling, before any hold exists", async (w) => {
    const { accountId } = await person(w, 5_000_000);
    for (const spec of [
      jobSpec({ cores: 65 }),
      jobSpec({ minutes: 2881 }),
      jobSpec({ nodes: 2 }),
      jobSpec({ partition: "gpu-shared", cores: 4, gpus: 4 }),
      jobSpec({ partition: "debug", minutes: 31 }),
    ]) {
      await refused(w, accountId, "over_job_limit", { spec });
    }
    // At the ceiling is not over it.
    expect(
      (await createJob(w.env(), input(accountId, { spec: jobSpec({ cores: 64, minutes: 2880 }) })))
        .ok,
    ).toBe(true);
  });

  onBoth("when the owner lowers a ceiling, the next job meets it", async (w) => {
    const owner = await seedUser(w.d1, { role: "owner" });
    const { accountId } = await person(w);
    expect((await createJob(w.env(), input(accountId, { spec: jobSpec({ cores: 32 }) }))).ok).toBe(
      true,
    );
    await setPolicy(w.d1, owner, {
      ceilings: {
        ...DEFAULT_COMPUTE_POLICY.ceilings,
        shared: { maxNodes: 1, maxCoresPerNode: 16, maxGpusPerNode: 0, maxMinutes: 60 },
      },
    });
    await refused(w, accountId, "over_job_limit", { spec: jobSpec({ cores: 32 }) });
    expect(
      (await createJob(w.env(), input(accountId, { spec: jobSpec({ cores: 16, minutes: 60 }) })))
        .ok,
    ).toBe(true);
  });

  onBoth(
    "when the partition is not offered to people (large-shared, preempt, gpu-preempt)",
    async (w) => {
      const { accountId } = await person(w);
      for (const partition of ["large-shared", "preempt"]) {
        await refused(w, accountId, "partition_not_offered", { spec: jobSpec({ partition }) });
      }
      await refused(w, accountId, "partition_not_offered", {
        spec: jobSpec({ partition: "gpu-preempt", cores: 4, gpus: 1 }),
      });
      for (const source of ["web", "partner"] as const) {
        await refused(w, accountId, "partition_not_offered", {
          source,
          spec: jobSpec({ partition: "preempt" }),
        });
      }
    },
  );

  onBoth(
    "when a dataset version has no data-plane tag, naming the field, before the hold",
    async (w) => {
      const { accountId } = await person(w);
      const spec = jobSpec({
        datasets: [
          { id: "nm000104", version: "1.0.2" },
          { id: "nm000105", version: "1.0" },
        ],
      });
      const before = await snapshot(w);
      const r = await createJob(w.env(), input(accountId, { spec }));
      expect(r).toMatchObject({ ok: false, code: "invalid_spec", field: "datasets.1.version" });
      expect(await snapshot(w)).toEqual(before);
      // A version with a tag launches: `1.0.2` is `v1.0.2`.
      expect(
        (
          await createJob(
            w.env(),
            input(accountId, {
              spec: jobSpec({ datasets: [{ id: "nm000104", version: "1.0.2" }] }),
            }),
          )
        ).ok,
      ).toBe(true);
    },
  );

  onBoth("when the specification is not a valid one, whatever the caller said", async (w) => {
    const { accountId } = await person(w);
    const before = await snapshot(w);
    const bad = { ...jobSpec(), nodes: 0 } as never;
    expect(await createJob(w.env(), input(accountId, { spec: bad }))).toMatchObject({
      ok: false,
      code: "invalid_spec",
    });
    expect(
      await createJob(w.env(), input(accountId, { spec: { extra: 1 } as never })),
    ).toMatchObject({
      ok: false,
      code: "invalid_spec",
    });
    expect(await snapshot(w)).toEqual(before);
  });

  test("when the records bucket is not bound: compute is disabled, and nothing is written", async () => {
    const w = worlds()[0] as World;
    const { accountId } = await person(w);
    const before = await snapshot(w);
    const r = await createJob(w.env({ COMPUTE_RECORDS: undefined }), input(accountId));
    expect(r).toMatchObject({ ok: false, code: "compute_disabled" });
    expect(await snapshot(w)).toEqual(before);
  });
});

describe("an idempotency key", () => {
  onBoth("returns the existing job for the same request, and makes nothing", async (w) => {
    const { accountId } = await person(w);
    const key = `key-${Math.random().toString(36).slice(2, 12)}`;
    const first = await createJob(w.env(), input(accountId, { idempotencyKey: key }));
    if (!first.ok) throw new Error("not accepted");
    const before = await trace(w.d1);
    const again = await createJob(w.env(), input(accountId, { idempotencyKey: key }));
    expect(again).toMatchObject({ ok: true, replayed: true });
    if (!again.ok) return;
    expect(again.job.id).toBe(first.job.id);
    expect(await trace(w.d1)).toEqual(before);
    const stored = await rowOf(w.d1, first.job.id);
    expect(stored.idempotency_key).toBe(key);
  });

  onBoth("is refused for another request, never answered with the first job", async (w) => {
    const { accountId } = await person(w);
    const key = `key-${Math.random().toString(36).slice(2, 12)}`;
    expect((await createJob(w.env(), input(accountId, { idempotencyKey: key }))).ok).toBe(true);
    const before = await trace(w.d1);
    const err = await createJob(
      w.env(),
      input(accountId, { idempotencyKey: key, spec: jobSpec({ cores: 8 }) }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ComputeJobError);
    expect(err.code).toBe("idempotency_conflict");
    expect(await trace(w.d1)).toEqual(before);
  });

  onBoth(
    "is scoped to the account: another person's job with the same key is their own",
    async (w) => {
      const a = await person(w);
      const b = await person(w);
      const key = `key-${Math.random().toString(36).slice(2, 12)}`;
      const first = await createJob(w.env(), input(a.accountId, { idempotencyKey: key }));
      const second = await createJob(w.env(), input(b.accountId, { idempotencyKey: key }));
      if (!first.ok || !second.ok) throw new Error("not accepted");
      expect(second.replayed).toBe(false);
      expect(second.job.id).not.toBe(first.job.id);
    },
  );

  onBoth("is optional: two requests without one are two jobs", async (w) => {
    const { accountId } = await person(w);
    const a = await createJob(w.env(), input(accountId));
    const b = await createJob(w.env(), input(accountId));
    if (!a.ok || !b.ok) throw new Error("not accepted");
    expect(a.job.id).not.toBe(b.job.id);
  });

  onBoth("two requests with one key racing make one job and one hold", async (w) => {
    const { accountId } = await person(w);
    const key = `key-${Math.random().toString(36).slice(2, 12)}`;
    const env = racing(w);
    const before = await trace(w.d1);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => createJob(env, input(accountId, { idempotencyKey: key }))),
    );
    for (const r of results) expect(r.ok).toBe(true);
    const ids = new Set(results.map((r) => (r.ok ? r.job.id : "")));
    expect(ids.size).toBe(1);
    const after = await trace(w.d1);
    expect(after.jobs - before.jobs).toBe(1);
    expect(after.holds - before.holds).toBe(1);
    expect(results.filter((r) => r.ok && !r.replayed)).toHaveLength(1);
  });
});

describe("two requests racing for the last live-job slot", () => {
  onBoth(
    "cannot both win: the limit reads rows in the statement that makes the hold",
    async (w) => {
      const owner = await seedUser(w.d1, { role: "owner" });
      await setPolicy(w.d1, owner, { maxLiveJobsPerPerson: 2 });
      const { accountId } = await person(w);
      const env = racing(w);
      const before = await trace(w.d1);
      const results = await Promise.all(
        Array.from({ length: 6 }, () => createJob(env, input(accountId))),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(2);
      expect(results.filter((r) => !r.ok && r.code === "over_concurrency")).toHaveLength(4);
      const after = await trace(w.d1);
      expect(after.jobs - before.jobs).toBe(2);
      expect(after.holds - before.holds).toBe(2);
    },
  );
});

describe("the other sources", () => {
  onBoth(
    "a pipeline job is held on the pipelines pool, counts against no person, and is NEMAR's own",
    async (w) => {
      const owner = await seedUser(w.d1, { role: "owner" });
      await setPolicy(w.d1, owner, { maxLiveJobsPerPerson: 1 });
      await fundPlatform(w.d1, "pipelines", 1_000_000);
      const before = await trace(w.d1);
      const results = [];
      for (let i = 0; i < 3; i++) {
        results.push(
          await createJob(w.env(), {
            source: "pipeline",
            accountId: null,
            appId: "nemar-launch",
            appVersion: "1.0.0",
            // A pipelines-only partition: nothing offered to people.
            spec: jobSpec({ partition: "large-shared" }),
          }),
        );
      }
      for (const r of results) expect(r.ok).toBe(true);
      const job = results[0]?.ok ? results[0].job : null;
      expect(job).toMatchObject({
        source: "pipeline",
        account_id: null,
        gateway_user: PIPELINES_TAPIS_OWNER,
        state: "created",
      });
      const hold = await w.d1
        .prepare(
          `SELECT p.holder_kind, p.holder_ref, l.budget_pool_id FROM compute_ledger l
           JOIN compute_pools p ON p.id = l.pool_id WHERE l.job_id = ? AND l.kind = 'hold'`,
        )
        .bind(job?.id)
        .first<{ holder_kind: string; holder_ref: string; budget_pool_id: number | null }>();
      expect(hold).toEqual({
        holder_kind: "platform",
        holder_ref: "pipelines",
        budget_pool_id: null,
      });
      expect((await trace(w.d1)).gateway).toBe(before.gateway);
    },
  );

  onBoth("a person's source other than the CLI is the same job with another source", async (w) => {
    const { accountId } = await person(w);
    for (const source of ["web", "partner"] as const) {
      const r = await createJob(
        w.env(),
        input(accountId, { source, clientId: source === "partner" ? "client.one" : undefined }),
      );
      if (!r.ok) throw new Error(`refused: ${r.code}`);
      expect(r.job).toMatchObject({ source, account_id: accountId });
    }
  });

  onBoth(
    "a partner job with no NEMAR account is held on the partner's own pool and has no pseudonym",
    async (w) => {
      await fundPlatform(w.d1, "people", 1_000_000_000);
      const client = `client-${Math.random().toString(36).slice(2, 10)}`;
      await fundPartner(w.d1, client, 100_000);
      const before = await trace(w.d1);
      const r = await createJob(w.env(), {
        source: "partner",
        accountId: null,
        clientId: client,
        tapisOwner: "some.tapis-user",
        appId: "nemar-launch",
        appVersion: "1.0.0",
        spec: jobSpec(),
      });
      if (!r.ok) throw new Error(`refused: ${r.code}`);
      expect(r.job).toMatchObject({
        account_id: null,
        gateway_user: null,
        client_id: client,
        tapis_owner: "some.tapis-user",
      });
      expect((await trace(w.d1)).gateway).toBe(before.gateway);
      const identity = JSON.parse(
        (await (await h.records.get(`records/${r.job.id}/identity.json`))?.text()) ?? "{}",
      );
      expect(identity).toMatchObject({
        account_id: null,
        orcid: null,
        name: null,
        email: null,
        country: null,
        affiliation: null,
        sub: null,
      });
    },
  );

  test("a job for a person needs an account, and a partner client's job needs a client", async () => {
    const w = worlds()[0] as World;
    await expect(createJob(w.env(), input(null))).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(
      createJob(w.env(), { ...input(null), source: "partner" as const }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(createJob(w.env(), input(0))).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(createJob(w.env(), input(1.5))).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(
      createJob(w.env(), { ...input(1), idempotencyKey: "has space" }),
    ).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });
});

describe("a record that could not be written", () => {
  /** A real bucket that fails its next `n` writes, as an outage of the store would. */
  const failing = (n: number): R2Bucket => {
    let left = n;
    return {
      put: async (key: string, value: unknown, options?: unknown) => {
        if (left-- > 0) throw new Error("the store is down");
        return h.records.put(key, value as ArrayBuffer, options as Parameters<R2Bucket["put"]>[2]);
      },
      get: (key: string) => h.records.get(key),
      head: (key: string) => h.records.head(key),
      delete: (key: string) => h.records.delete(key),
      list: (o?: Parameters<R2Bucket["list"]>[0]) => h.records.list(o),
    } as unknown as R2Bucket;
  };

  test("leaves the job and its hold, says so, and a replay of the key writes the records", async () => {
    const w = worlds()[0] as World;
    const { accountId } = await person(w);
    const key = `key-${Math.random().toString(36).slice(2, 12)}`;
    const down = await createJob(
      w.env({ COMPUTE_RECORDS: failing(2) }),
      input(accountId, { idempotencyKey: key }),
    );
    if (!down.ok) throw new Error("not accepted");
    expect(down.recordsWritten).toBe(false);
    expect(down.job.records_written_at).toBeNull();
    expect((await bucketKeys()).records).toEqual([]);
    expect((await trace(w.d1)).holds).toBe(1);

    const healed = await createJob(w.env(), input(accountId, { idempotencyKey: key }));
    expect(healed).toMatchObject({ ok: true, replayed: true, recordsWritten: true });
    if (!healed.ok) return;
    expect(healed.job.id).toBe(down.job.id);
    expect(healed.job.records_written_at).not.toBeNull();
    expect((await bucketKeys()).records).toEqual([
      `records/${down.job.id}/identity.json`,
      `records/${down.job.id}/spec.json`,
    ]);
    expect(healed.job.spec_digest).toBe(await sha(`records/${down.job.id}/spec.json`));
    expect((await trace(w.d1)).holds).toBe(1);
  });

  test("a replay writes only what is missing, and never rewrites a record", async () => {
    const w = worlds()[0] as World;
    const { accountId } = await person(w);
    const key = `key-${Math.random().toString(36).slice(2, 12)}`;
    // The first record lands and the second fails.
    let writes = 0;
    const flaky = {
      put: async (k: string, v: unknown, o?: unknown) => {
        if (++writes === 2) throw new Error("the store is down");
        return h.records.put(k, v as ArrayBuffer, o as Parameters<R2Bucket["put"]>[2]);
      },
      get: (k: string) => h.records.get(k),
      head: (k: string) => h.records.head(k),
      delete: (k: string) => h.records.delete(k),
      list: (o?: Parameters<R2Bucket["list"]>[0]) => h.records.list(o),
    } as unknown as R2Bucket;
    const first = await createJob(
      w.env({ COMPUTE_RECORDS: flaky }),
      input(accountId, { idempotencyKey: key }),
    );
    if (!first.ok) throw new Error("not accepted");
    expect(first.recordsWritten).toBe(false);
    const landed = (await bucketKeys()).records;
    expect(landed).toHaveLength(1);
    const kept = await (await h.records.get(landed[0] as string))?.text();
    expect(kept).toBeDefined();
    await new Promise((r) => setTimeout(r, 25));
    const second = await createJob(w.env(), input(accountId, { idempotencyKey: key }));
    expect(second).toMatchObject({ ok: true, recordsWritten: true });
    expect((await bucketKeys()).records).toEqual([
      `records/${first.job.id}/identity.json`,
      `records/${first.job.id}/spec.json`,
    ]);
    // What was written first is still what is there: a record is written once.
    expect(await (await h.records.get(landed[0] as string))?.text()).toBe(kept);
  });

  test("no log line carries an identity or a path a person chose, only the job id and fixed words", async () => {
    const w = worlds()[0] as World;
    const accountId = await seedUser(w.d1, {
      email: "zz-secret-person@example.org",
      given_name: "Zephyrine",
      family_name: "Quillfeather",
      orcid: "0000-0003-1415-9265",
      country: "Freedonia",
      affiliation: "Institute of Silly Walks",
    });
    await fundAccount(w.d1, accountId, 100_000);
    await fundPlatform(w.d1, "people", 1_000_000_000);
    const lines: string[] = [];
    const originals = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      info: console.info,
    };
    for (const level of ["log", "warn", "error", "info"] as const) {
      console[level] = (...args: unknown[]) => {
        lines.push(
          args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "),
        );
      };
    }
    let r: Awaited<ReturnType<typeof createJob>>;
    try {
      r = await createJob(
        w.env({ COMPUTE_RECORDS: failing(5) }),
        input(accountId, {
          spec: jobSpec({ name: "my private analysis of sub-secret" }),
          tapisOwner: "zz.owner",
        }),
      );
    } finally {
      Object.assign(console, originals);
    }
    expect(r.ok).toBe(true);
    const text = lines.join("\n");
    // The failure was reported (so the check below is not vacuous), by job id and by a fixed word.
    if (r.ok) expect(text).toContain(r.job.id);
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of [
      "zz-secret-person",
      "Zephyrine",
      "Quillfeather",
      "0000-0003-1415-9265",
      "Freedonia",
      "Silly Walks",
      "my private analysis",
      "sub-secret",
      "zz.owner",
    ]) {
      expect([secret, text.includes(secret)]).toEqual([secret, false]);
    }
  });
});

describe("no identity in D1", () => {
  onBoth(
    "a job row and the pseudonym table hold the account id and fixed words, never a name, email, country or ORCID iD",
    async (w) => {
      const accountId = await seedUser(w.d1, {
        email: "zz-unique-person@example.org",
        given_name: "Zephyrine",
        family_name: "Quillfeather",
        orcid: "0000-0003-1415-9265",
        country: "Freedonia",
        affiliation: "Institute of Silly Walks",
        city: "Sylvania",
        username: "zzuniqueuser",
      });
      await fundAccount(w.d1, accountId, 100_000);
      await fundPlatform(w.d1, "people", 1_000_000_000);
      const r = await createJob(
        w.env(),
        input(accountId, { spec: jobSpec({ name: "zz name of the job" }) }),
      );
      if (!r.ok) throw new Error("not accepted");
      const rows = [
        await rowOf(w.d1, r.job.id),
        ...(
          await w.d1
            .prepare("SELECT * FROM compute_gateway_users WHERE account_id = ?")
            .bind(accountId)
            .all()
        ).results,
        ...(
          await w.d1.prepare("SELECT * FROM compute_ledger WHERE job_id = ?").bind(r.job.id).all()
        ).results,
      ];
      const dump = JSON.stringify(rows);
      for (const secret of [
        "zz-unique-person",
        "Zephyrine",
        "Quillfeather",
        "0000-0003-1415-9265",
        "Freedonia",
        "Silly Walks",
        "Sylvania",
        "zzuniqueuser",
      ]) {
        expect([secret, dump.includes(secret)]).toEqual([secret, false]);
      }
      // ... and the records bucket holds the snapshot, which is where identity belongs.
      const identity = JSON.parse(
        (await (await h.records.get(`records/${r.job.id}/identity.json`))?.text()) ?? "{}",
      );
      expect(identity).toMatchObject({
        orcid: "0000-0003-1415-9265",
        name: "Zephyrine Quillfeather",
        email: "zz-unique-person@example.org",
        country: "Freedonia",
        affiliation: "Institute of Silly Walks",
        account_id: accountId,
        sub: null,
      });
    },
  );
});

describe("the statements", () => {
  test("the job insert is gated by an EXISTS on the hold, which the mutation test removes", () => {
    expect(JOB_INSERT_SQL).toMatch(/WHERE\s+EXISTS\s*\(\s*SELECT 1 FROM compute_ledger/i);
    expect(GATEWAY_USER_INSERT_SQL).toMatch(/WHERE\s+EXISTS\s*\(\s*SELECT 1 FROM compute_ledger/i);
    expect(GATEWAY_USER_INSERT_SQL).toMatch(/INSERT OR IGNORE INTO compute_gateway_users/);
  });

  test("none reads a table by scanning it: every lookup is by an index", () => {
    const db = h.db;
    for (const [name, sql] of Object.entries({
      JOB_INSERT_SQL,
      GATEWAY_USER_INSERT_SQL,
      JOB_BY_ID_SQL,
      JOB_BY_KEY_SQL,
      // A guard is an expression; as a statement it is a SELECT of it.
      LIVE_JOBS_GUARD_SQL: `SELECT ${LIVE_JOBS_GUARD_SQL}`,
    })) {
      const plan = db.query(`EXPLAIN QUERY PLAN ${sql.replace(/\?(\d*)/g, "1")}`).all() as Array<{
        detail: string;
      }>;
      const scans = plan
        .map((p) => p.detail)
        .filter((d) => /\bSCAN\b/.test(d) && /compute_(jobs|ledger)\b/.test(d));
      expect([name, scans]).toEqual([name, []]);
    }
  });

  test("the live-job guard is plain ? placeholders, as the ledger's hold takes them", () => {
    expect(LIVE_JOBS_GUARD_SQL).not.toMatch(/\?\d/);
    expect(LIVE_JOBS_GUARD_SQL.match(/\?/g)).toHaveLength(2);
  });

  test("getJob reads a job by id, and a job that is not there is null", async () => {
    const w = worlds()[0] as World;
    const { accountId } = await person(w);
    const r = await createJob(w.env(), input(accountId));
    if (!r.ok) throw new Error("not accepted");
    expect(await getJob(w.d1, r.job.id)).toEqual(r.job);
    expect(await getJob(w.d1, "job_000000000000000000000000")).toBeNull();
  });
});
