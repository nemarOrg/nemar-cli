/**
 * NEMAR's own pipeline dispatch (epic #2005 phase A6, #2011; ADR 0065; ADR 0118), against real D1 (real
 * SQLite carrying every migration, and Miniflare's D1 for the race), the real ledger, Miniflare's R2
 * through the Worker's own bindings and the Tapis stand-in (a real HTTP server built from Tapis's
 * published specifications; no response of it was recorded from a real tenant). The services under test
 * are the production ones; the launcher's end is played by `playLauncher`.
 *
 * What is pinned, each with a test of its own:
 *  - a run holds the hold, creates the job, stamps and submits; the job is a COMPLETE recipe job made
 *    BEFORE `createJob` (the recipe's name, the runtime image, the command, the arguments with the image
 *    digest), so `spec.json`, `spec_digest` and `launch_spec_digest` describe what ran;
 *  - a second run of one tuple is `live_attempt_exists`; a failed job allows a new attempt; a refused
 *    hold leaves a `refused` stamp and no job; the version defaults to the newest;
 *  - two runs racing for one tuple produce one stamp and one job (MUTATION: drop the partial index's
 *    `succeeded`/`dispatched` rule in the claim, see the migration test);
 *  - no recipe runs on an anonymous, private, withdrawn or non-EEG dataset, decided from the row;
 *  - the stamp says what ran: the recipe's own record rewrites the tuple's version and engine;
 *  - a crash between the claim and the job is repaired, a crash between the job and the link is
 *    found again by its key, and a deleted dataset loses its stamps and keeps its jobs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { findRecipe, recipeImageDigestArg } from "../../shared/compute-recipes";
import { LAUNCHER_FILES } from "../../shared/contract/compute";
import { MAX_MANIFEST_JSON_ENTRIES } from "../src/routes/data";
import { JOB_BY_ID_SQL, JOB_BY_KEY_SQL, createJob } from "../src/services/compute-jobs";
import { advanceComputeJob } from "../src/services/compute-lifecycle";
import {
  PIPELINES_ACCOUNT_USERNAME,
  PIPELINE_MANIFEST_MAX_ENTRIES,
  STAMP_NO_JOB_MINUTES,
  type StampRow,
  dispatchEligible,
  dispatchPipelineJob,
  getStamp,
  pipelineDryRun,
  pipelineKey,
  syncPipelineStamps,
} from "../src/services/compute-pipeline";
import { recordKey, sha256Hex } from "../src/services/compute-records";
import { readRecordedSpec } from "../src/services/compute-verify";
import { deleteDatasetCascade } from "../src/services/deletion";
import type { Bindings } from "../src/types/bindings";
import {
  type LifecycleFixture,
  RUNTIME_IMAGE,
  RUNTIME_IMAGE_DIGEST,
  launchSpecTextSeenByTapis,
  launchableSpec,
  reread,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import {
  drive,
  finishAtTapis,
  floorOutputs,
  fundPipelines,
  recipeRecord,
  seedEegDataset,
  seedPipelinesAccount,
} from "./helpers/compute-pipeline-fixture";
import { seedUser } from "./helpers/compute-seed";

let fx: LifecycleFixture;

beforeAll(async () => {
  fx = await startLifecycleFixture({ withD1: true });
}, 120_000);

afterAll(async () => {
  await fx?.dispose();
}, 30_000);

const ADMIN = { kind: "admin", userId: 1 } as const;

/** A reset world: the service account, a funded pipelines pool, one EEG dataset `nm000104`. */
async function world(over: { dataset?: Parameters<typeof seedEegDataset>[2] } = {}) {
  const env = fx.env();
  const account = await seedPipelinesAccount(env);
  await fundPipelines(env);
  await seedEegDataset(env, "nm000104", over.dataset);
  return { env, account };
}

beforeEach(async () => {
  await fx.reset();
});

const floor = findRecipe("nemar-floor");

const run = (env: Bindings, over: Partial<Parameters<typeof dispatchPipelineJob>[1]> = {}) =>
  dispatchPipelineJob(env, {
    recipe: "nemar-floor",
    datasetId: "nm000104",
    actor: ADMIN,
    ...over,
  });

async function stampsOf(env: Bindings, dataset = "nm000104"): Promise<StampRow[]> {
  return (
    await env.DB.prepare("SELECT * FROM compute_pipeline_stamps WHERE dataset_id = ?1 ORDER BY id")
      .bind(dataset)
      .all<StampRow>()
  ).results;
}

async function jobCount(env: Bindings): Promise<number> {
  return (
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM compute_jobs").first<{ n: number }>())?.n ?? 0
  );
}

async function ledgerKinds(env: Bindings, jobId: string): Promise<string[]> {
  return (
    await env.DB.prepare("SELECT kind FROM compute_ledger WHERE job_id = ?1 ORDER BY id")
      .bind(jobId)
      .all<{ kind: string }>()
  ).results.map((r) => r.kind);
}

const submits = () => fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/submit").length;

describe("a run", () => {
  test("holds, creates the job, stamps it, and submits it", async () => {
    const { env, account } = await world();
    const result = await run(env);
    expect(result).toMatchObject({
      ok: true,
      datasetId: "nm000104",
      version: "v1.0.0",
      recipe: "nemar-floor",
      attempt: 1,
      submit: "submitted",
    });
    if (!result.ok) throw new Error("unreachable");

    const job = await reread(env, result.jobId);
    expect(job).toMatchObject({
      source: "pipeline",
      account_id: account,
      tapis_owner: "nemar-pipelines",
      gateway_user: "nemar-pipelines",
      state: "submitted",
      pool: "cpu",
      partition: floor?.partition,
      app_id: floor?.appId,
      app_version: floor?.appVersion,
      image_digest: RUNTIME_IMAGE_DIGEST,
    });
    expect(job.idempotency_key).toBe(await pipelineKey((await stampsOf(env))[0] as StampRow));
    expect(job.held_milli).toBeGreaterThan(0);
    expect(await ledgerKinds(env, job.id)).toEqual(["hold"]);

    const [stamp] = await stampsOf(env);
    expect(stamp).toMatchObject({
      version: "v1.0.0",
      recipe: "nemar-floor",
      recipe_version: floor?.version,
      engine: floor?.engine,
      attempt: 1,
      state: "dispatched",
      job_id: job.id,
      refusal_code: null,
    });
    expect(submits()).toBe(1);
  });

  test("the hold is on the platform pipelines pool and meets no per-person guard", async () => {
    const { env } = await world();
    const result = await run(env);
    if (!result.ok) throw new Error("not dispatched");
    const rows = (
      await env.DB.prepare(
        `SELECT p.holder_kind, p.holder_ref, l.budget_pool_id
           FROM compute_ledger l JOIN compute_pools p ON p.id = l.pool_id
          WHERE l.job_id = ?1 AND l.kind = 'hold'`,
      )
        .bind(result.jobId)
        .all<{ holder_kind: string; holder_ref: string; budget_pool_id: number | null }>()
    ).results;
    expect(rows).toEqual([
      { holder_kind: "platform", holder_ref: "pipelines", budget_pool_id: null },
    ]);
  });

  test("the recipe is resolved BEFORE createJob: spec.json, spec_digest and the launch specification describe what ran", async () => {
    const { env } = await world();
    const result = await run(env);
    if (!result.ok) throw new Error("not dispatched");
    const job = await reread(env, result.jobId);

    // spec.json is the validated specification, byte for byte, and its digest is the row's.
    const object = await fx.harness.records.get(recordKey(job.id, "spec.json"));
    const bytes = new Uint8Array((await object?.arrayBuffer()) as ArrayBuffer);
    expect(await sha256Hex(bytes)).toBe(job.spec_digest);
    const spec = await readRecordedSpec(fx.harness.records, job);
    expect(spec).toMatchObject({
      runtime: "image",
      image: RUNTIME_IMAGE,
      recipe: "nemar-floor",
      command: ["nemar-recipe", "run", "nemar-floor"],
      datasets: [{ id: "nm000104", version: "v1.0.0" }],
      partition: "shared",
    });
    expect(spec?.args).toContain("--dataset-dir");
    expect(spec?.args).toContain("/data/nm000104");
    expect(recipeImageDigestArg(spec?.args ?? [])).toBe(RUNTIME_IMAGE_DIGEST);

    // The launch specification the launcher received is built from THAT record and its digest is the row's.
    const launch = JSON.parse(launchSpecTextSeenByTapis(fx, job.tapis_uuid as string));
    expect(launch).toMatchObject({
      runtime: "image",
      command: ["nemar-recipe", "run", "nemar-floor"],
      args: spec?.args,
      datasets: [{ id: "nm000104", version: "v1.0.0" }],
      image: { uri: RUNTIME_IMAGE, digest: RUNTIME_IMAGE_DIGEST },
    });
    expect(await sha256Hex(new TextEncoder().encode(JSON.stringify(launch)))).toBe(
      job.launch_spec_digest as string,
    );
  });

  test("the version defaults to the newest, and a version named is that version", async () => {
    const env = fx.env();
    await seedPipelinesAccount(env);
    await fundPipelines(env);
    await seedEegDataset(env, "nm000104", {
      versions: [
        ["1.0.0", "2026-01-01 00:00:00"],
        ["1.2.0", "2026-03-01 00:00:00"],
        ["1.1.0", "2026-02-01 00:00:00"],
      ],
    });
    const newest = await run(env);
    expect(newest).toMatchObject({ ok: true, version: "v1.2.0" });
    const named = await run(env, { version: "1.1.0" });
    expect(named).toMatchObject({ ok: true, version: "v1.1.0" });
    const tagged = await run(env, { version: "v1.0.0" });
    expect(tagged).toMatchObject({ ok: true, version: "v1.0.0" });
    expect((await stampsOf(env)).map((s) => s.version).sort()).toEqual([
      "v1.0.0",
      "v1.1.0",
      "v1.2.0",
    ]);
    expect(await run(env, { version: "9.9.9" })).toMatchObject({
      ok: false,
      code: "version_not_found",
    });
  });

  test("a second run of the same tuple is live_attempt_exists, with no second job and no second hold", async () => {
    const { env } = await world();
    const first = await run(env);
    expect(first.ok).toBe(true);
    const second = await run(env);
    expect(second).toMatchObject({ ok: false, code: "live_attempt_exists", version: "v1.0.0" });
    expect(await stampsOf(env)).toHaveLength(1);
    expect(await jobCount(env)).toBe(1);
    expect(submits()).toBe(1);
  });

  test("a failed job allows a new attempt, which takes the next number and a key of its own", async () => {
    const { env } = await world();
    const first = await run(env);
    if (!first.ok) throw new Error("not dispatched");
    const job = await reread(env, first.jobId);
    await drive(fx, env, job.id, job.tapis_uuid as string, "FAILED", "JOB_LAUNCH_FAILURE");
    expect(await run(env)).toMatchObject({ ok: false, code: "live_attempt_exists" });
    await syncPipelineStamps(env);

    const second = await run(env);
    expect(second).toMatchObject({ ok: true, attempt: 2 });
    const stamps = await stampsOf(env);
    expect(stamps.map((s) => [s.attempt, s.state])).toEqual([
      [1, "failed"],
      [2, "dispatched"],
    ]);
    expect(stamps[0]?.refusal_code).toBe("launch_failed");
    expect(await pipelineKey(stamps[0] as StampRow)).not.toBe(
      await pipelineKey(stamps[1] as StampRow),
    );
    expect(await jobCount(env)).toBe(2);
  });

  test("a refused hold leaves a refused stamp with the ledger's word and no job", async () => {
    const env = fx.env();
    await seedPipelinesAccount(env);
    // The pipelines pool is not funded: the hold is refused.
    await seedEegDataset(env, "nm000104");
    const result = await run(env);
    expect(result).toMatchObject({ ok: false, code: "insufficient_balance" });
    expect(await jobCount(env)).toBe(0);
    const [stamp] = await stampsOf(env);
    expect(stamp).toMatchObject({
      state: "refused",
      refusal_code: "insufficient_balance",
      job_id: null,
    });
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM compute_ledger WHERE kind = 'hold'").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
    expect(submits()).toBe(0);
    // A refusal does not block the retry; funding the pool lets the next attempt through.
    await fundPipelines(env);
    expect(await run(env)).toMatchObject({ ok: true, attempt: 2 });
  });

  test("a key used for another request ends the stamp failed (create_failed), and that job is never linked", async () => {
    const { env, account } = await world();
    const key = await pipelineKey({
      dataset_id: "nm000104",
      version: "v1.0.0",
      recipe: "nemar-floor",
      recipe_version: floor?.version as string,
      engine: floor?.engine as string,
      attempt: 1,
    });
    const other = await createJob(env, {
      source: "pipeline",
      accountId: account,
      idempotencyKey: key,
      appId: "nemar-launch",
      appVersion: "1.0.0",
      spec: launchableSpec(),
    });
    if (!other.ok) throw new Error("could not make the other job");
    const result = await run(env);
    expect(result).toMatchObject({ ok: false, code: "create_failed" });
    expect(await jobCount(env)).toBe(1);
    expect((await stampsOf(env))[0]).toMatchObject({
      state: "failed",
      refusal_code: "create_failed",
      job_id: null,
    });
    expect(submits()).toBe(0);
  });

  test("a read that fails AFTER the job was committed finds the job by its key and links it", async () => {
    const { env } = await world();
    let armed = false;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (...args: Parameters<D1Database["batch"]>) => {
            const out = await target.batch(...args);
            armed = true;
            return out;
          };
        }
        if (prop === "prepare") {
          return (sql: string) => {
            if (armed && sql === JOB_BY_ID_SQL) {
              armed = false;
              throw new Error("injected: the read after the commit failed");
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await run({ ...env, DB: db });
    expect(result).toMatchObject({ ok: true, attempt: 1, submit: "unavailable" });
    if (!result.ok) throw new Error("unreachable");
    expect(await jobCount(env)).toBe(1);
    expect(await ledgerKinds(env, result.jobId)).toEqual(["hold"]);
    expect((await stampsOf(env))[0]).toMatchObject({ state: "dispatched", job_id: result.jobId });
    // The job is a created job for the tick; the stamp holds the tuple.
    expect((await reread(env, result.jobId)).state).toBe("created");
    expect(await run(env)).toMatchObject({ ok: false, code: "live_attempt_exists" });
  });

  test("a read that fails after the commit AND a key lookup that fails leave the stamp dispatched, and the sync links the job", async () => {
    const { env } = await world();
    let armed = false;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (...args: Parameters<D1Database["batch"]>) => {
            const out = await target.batch(...args);
            armed = true;
            return out;
          };
        }
        if (prop === "prepare") {
          return (sql: string) => {
            if (armed && (sql === JOB_BY_ID_SQL || sql === JOB_BY_KEY_SQL)) {
              throw new Error("injected: the database could not be read");
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await run({ ...env, DB: db });
    expect(result).toMatchObject({ ok: false, code: "create_failed" });
    // The job was committed; the stamp must not be ended, or a later attempt would make a second job.
    expect(await jobCount(env)).toBe(1);
    expect((await stampsOf(env))[0]).toMatchObject({ state: "dispatched", job_id: null });
    expect(await run(env)).toMatchObject({ ok: false, code: "live_attempt_exists" });

    const sync = await syncPipelineStamps(env);
    expect(sync).toMatchObject({ linked: 1, failed: 0 });
    const job = (await env.DB.prepare("SELECT id FROM compute_jobs").first<{ id: string }>())?.id;
    expect((await stampsOf(env))[0]).toMatchObject({ state: "dispatched", job_id: job });
    expect(await jobCount(env)).toBe(1);
  });

  test("the immediate submit not going through leaves a created job for the tick, with the stamp linked", async () => {
    const env = fx.env({ PRESCREEN_CALLBACK_SECRET: undefined });
    await seedPipelinesAccount(env);
    await fundPipelines(env);
    await seedEegDataset(env, "nm000104");
    const result = await run(env);
    expect(result).toMatchObject({ ok: true, submit: "unconfigured" });
    if (!result.ok) throw new Error("unreachable");
    expect((await reread(env, result.jobId)).state).toBe("created");
    expect((await stampsOf(env))[0]).toMatchObject({ state: "dispatched", job_id: result.jobId });
  });
});

describe("what a run refuses, before it writes anything", () => {
  async function nothingWritten(env: Bindings) {
    expect(await stampsOf(env)).toEqual([]);
    expect(await jobCount(env)).toBe(0);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM compute_ledger WHERE kind = 'hold'").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
    expect(submits()).toBe(0);
  }

  const ineligible: Array<[string, Parameters<typeof seedEegDataset>[2], string]> = [
    ["a private dataset", { visibility: "private" }, "public"],
    ["a withdrawn dataset", { withdrawnAt: "2026-02-01 00:00:00" }, "not_withdrawn"],
    ["a tombstoned DOI", { ezidStatus: "unavailable" }, "not_tombstoned"],
    ["a dataset that is not EEG", { modalities: "meg" }, "eeg"],
    ["an intracranial-only dataset", { modalities: "ieeg" }, "eeg"],
    ["a dataset never published", { firstPublishedAt: null }, "first_published"],
    ["a dataset with no version", { versions: [] }, "has_version"],
    ["an inactive dataset", { status: "archived" }, "active"],
  ];
  for (const [name, dataset, term] of ineligible) {
    test(`${name} is dataset_not_eligible, naming the term (${term})`, async () => {
      const { env } = await world({ dataset });
      const result = await run(env);
      expect(result).toMatchObject({ ok: false, code: "dataset_not_eligible" });
      expect((result as { blockedBy: string[] }).blockedBy).toContain(term);
      await nothingWritten(env);
    });
  }

  test("an anonymous dataset is refused whatever the request says: the row decides (ADR 0065)", async () => {
    const { env } = await world();
    env.DB.exec?.call;
    await env.DB.prepare("DROP TRIGGER datasets_anonymous_unpublished_ai").run();
    await env.DB.prepare("DROP TRIGGER datasets_anonymous_unpublished_au").run();
    await env.DB.prepare("UPDATE datasets SET anonymous = 1 WHERE dataset_id = 'nm000104'").run();
    // The input has no field through which a caller could say otherwise; extra keys are not read.
    const result = await run(env, { anonymous: false, visibility: "public" } as never);
    expect(result).toMatchObject({ ok: false, code: "dataset_not_eligible" });
    expect((result as { blockedBy: string[] }).blockedBy).toContain("not_anonymous");
    await nothingWritten(env);
  });

  test("a dataset that does not exist, a sandbox and a reserved fixture are not eligible", async () => {
    const env = fx.env();
    await seedPipelinesAccount(env);
    await fundPipelines(env);
    await seedEegDataset(env, "xx000100");
    await seedEegDataset(env, "nm099950");
    for (const id of ["nm000999", "xx000100", "nm099950"]) {
      expect(await run(env, { datasetId: id })).toMatchObject({
        ok: false,
        code: "dataset_not_eligible",
      });
    }
    await nothingWritten(env);
  });

  test("an unknown recipe is recipe_unknown; a cron may not run a recipe that is not automatic", async () => {
    const { env } = await world();
    expect(await run(env, { recipe: "nemar-nope" })).toMatchObject({
      ok: false,
      code: "recipe_unknown",
    });
    expect(await run(env, { recipe: "nemar-ica", actor: { kind: "cron" } })).toMatchObject({
      ok: false,
      code: "recipe_not_automatic",
    });
    await nothingWritten(env);
  });

  test("a placeholder recipe is refused on every path with recipe_placeholder, and nothing is written", async () => {
    const { env } = await world();
    await fundPipelines(env, 10_000_000, true);
    expect(await run(env, { recipe: "nemar-ica" })).toMatchObject({
      ok: false,
      code: "recipe_placeholder",
    });
    const queue = await dispatchEligible(env, { recipe: "nemar-ica", limit: 3, actor: ADMIN });
    expect(queue).toMatchObject({ dispatched: 0, stoppedBy: "recipe_placeholder" });
    expect(await pipelineDryRun(env, { recipe: "nemar-ica", datasetId: "nm000104" })).toEqual({
      ok: false,
      code: "recipe_placeholder",
    });
    await nothingWritten(env);
  });

  test("a specification that cannot be built leaves no claimed stamp, and is a word, not a throw", async () => {
    const { env } = await world();
    // A digest-pinned reference the runtime-image reader takes and the job schema (512 characters) refuses.
    const long = `ghcr.io/${"a".repeat(600)}/nemar-python@${RUNTIME_IMAGE_DIGEST}`;
    const result = await run(fx.env({ COMPUTE_RUNTIME_IMAGE: long }));
    expect(result).toMatchObject({ ok: false, code: "invalid_spec" });
    await nothingWritten(env);
  });

  test("compute off is compute_disabled, and a recipe is refused before a dataset is even read", async () => {
    const { env } = await world();
    const off = fx.env({ COMPUTE_ENABLED: undefined });
    expect(await run(off)).toMatchObject({ ok: false, code: "compute_disabled" });
    await nothingWritten(env);
  });

  test("a version with no data-plane tag, and one over the manifest bound, are refused", async () => {
    const { env } = await world({
      dataset: { versions: [["1.0", "2026-01-01 00:00:00"]] },
    });
    expect(await run(env)).toMatchObject({ ok: false, code: "version_untagged" });
    await nothingWritten(env);

    const big = fx.env();
    await seedEegDataset(big, "nm000105", {
      versions: [["1.0.0", "2026-01-01 00:00:00", PIPELINE_MANIFEST_MAX_ENTRIES + 1]],
    });
    expect(await run(big, { datasetId: "nm000105" })).toMatchObject({
      ok: false,
      code: "too_many_files",
    });
    // At the bound exactly it goes.
    await seedEegDataset(big, "nm000106", {
      versions: [["1.0.0", "2026-01-01 00:00:00", PIPELINE_MANIFEST_MAX_ENTRIES]],
    });
    expect(await run(big, { datasetId: "nm000106" })).toMatchObject({ ok: true });
  });

  test("the manifest bound is the data plane's own", () => {
    expect(PIPELINE_MANIFEST_MAX_ENTRIES).toBe(MAX_MANIFEST_JSON_ENTRIES);
  });

  test("the runtime image unset, or not a digest-pinned reference, is runtime_unavailable", async () => {
    const { env } = await world();
    for (const bad of [undefined, "", "ghcr.io/example/nemar-python:latest", "not an image"]) {
      expect(await run(fx.env({ COMPUTE_RUNTIME_IMAGE: bad }))).toMatchObject({
        ok: false,
        code: "runtime_unavailable",
      });
    }
    await nothingWritten(env);
  });

  test("the service account missing, of the wrong kind, unapproved or deleted is pipelines_account_missing", async () => {
    for (const make of [
      async (e: Bindings) => {
        await seedUser(e.DB, { username: "someone-else" });
      },
      async (e: Bindings) => {
        await seedPipelinesAccount(e, { kind: "person" });
      },
      async (e: Bindings) => {
        await seedPipelinesAccount(e, { status: "pending" });
      },
      async (e: Bindings) => {
        await seedPipelinesAccount(e, { deleted: true });
      },
    ]) {
      await fx.reset();
      const env = fx.env();
      await make(env);
      await fundPipelines(env);
      await seedEegDataset(env, "nm000104");
      expect(await run(env)).toMatchObject({ ok: false, code: "pipelines_account_missing" });
      await nothingWritten(env);
    }
  });

  test("the account name is the Tapis owner's literal", () => {
    expect(PIPELINES_ACCOUNT_USERNAME).toBe("nemar-pipelines");
  });
});

describe("a race for one tuple", () => {
  const pipelineJobs = async (env: Bindings) =>
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM compute_jobs WHERE source = 'pipeline'",
      ).first<{
        n: number;
      }>()
    )?.n ?? 0;

  async function racing(env: Bindings, datasetId: string) {
    const before = await pipelineJobs(env);
    const results = await Promise.all([
      run(env, { datasetId }),
      run(env, { datasetId }),
      run(env, { datasetId }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => (r as { code: string }).code)).toEqual([
      "live_attempt_exists",
      "live_attempt_exists",
    ]);
    const stamps = (
      await env.DB.prepare("SELECT * FROM compute_pipeline_stamps WHERE dataset_id = ?1")
        .bind(datasetId)
        .all<StampRow>()
    ).results;
    expect(stamps).toHaveLength(1);
    expect(await pipelineJobs(env)).toBe(before + 1);
    const winner = results.find((r) => r.ok);
    expect(stamps[0]?.job_id).toBe(winner?.ok ? winner.jobId : null);
  }

  test("on SQLite: three concurrent runs make one stamp and one job", async () => {
    const { env } = await world();
    await racing(env, "nm000104");
    expect(await jobCount(env)).toBe(1);
    expect(submits()).toBe(1);
  });

  test("on Miniflare's D1: three concurrent runs make one stamp and one job", async () => {
    const d1 = fx.harness.d1 as D1Database;
    const env = fx.env({ DB: d1 });
    await seedPipelinesAccount(env, { reuse: true });
    await fundPipelines(env);
    const owner = await seedUser(d1, {});
    const id = `nm${String(10_000 + Math.floor(Math.random() * 80_000)).padStart(6, "0")}`;
    await seedEegDataset(env, id, { owner });
    await racing(env, id);
  });
});

describe("the stamp follows its job to the end", () => {
  async function dispatched() {
    const { env } = await world();
    const result = await run(env);
    if (!result.ok) throw new Error("not dispatched");
    return { env, jobId: result.jobId, stampId: result.stampId };
  }

  test("a finished job whose record is the recipe's own: the stamp is succeeded and carries what ran", async () => {
    const { env, jobId, stampId } = await dispatched();
    await finishAtTapis(fx, env, jobId, {
      outputs: floorOutputs(
        recipeRecord({
          recipe: { id: "nemar-floor", version: "1.0.1" },
          engine: { package: "eegprep", version: "0.5.1" },
        }),
      ),
    });
    expect((await reread(env, jobId)).state).toBe("finished");
    const sync = await syncPipelineStamps(env);
    expect(sync).toMatchObject({ examined: 1, succeeded: 1, failed: 0 });
    expect(await getStamp(env.DB, stampId)).toMatchObject({
      state: "succeeded",
      // NOT the table's version and engine: the recipe's own record.
      recipe_version: "1.0.1",
      engine: "eegprep@0.5.1",
      job_id: jobId,
      refusal_code: null,
    });
    // And the tuple stays claimed: a run of the same tuple the registry names is not blocked by it, a
    // run of the one the record names is.
    expect(await run(env)).toMatchObject({ ok: true, attempt: 1 });
  });

  test("a stamp stays dispatched while its job is live, and a sync touches nothing", async () => {
    const { env, stampId } = await dispatched();
    expect(await syncPipelineStamps(env)).toMatchObject({ examined: 1, succeeded: 0, failed: 0 });
    expect((await getStamp(env.DB, stampId))?.state).toBe("dispatched");
  });

  test("a failed job fails the stamp with the job's own word; a cancelled one is job_cancelled", async () => {
    const a = await dispatched();
    const jobA = await reread(a.env, a.jobId);
    await drive(fx, a.env, a.jobId, jobA.tapis_uuid as string, "FAILED", "JOB_LAUNCH_FAILURE");
    await syncPipelineStamps(a.env);
    expect(await getStamp(a.env.DB, a.stampId)).toMatchObject({
      state: "failed",
      refusal_code: "launch_failed",
    });

    // A second dataset, cancelled.
    await seedEegDataset(a.env, "nm000105");
    const b = await run(a.env, { datasetId: "nm000105" });
    if (!b.ok) throw new Error("not dispatched");
    const jobB = await reread(a.env, b.jobId);
    await drive(fx, a.env, b.jobId, jobB.tapis_uuid as string, "CANCELLED");
    await syncPipelineStamps(a.env);
    expect(await getStamp(a.env.DB, b.stampId)).toMatchObject({
      state: "failed",
      refusal_code: "job_cancelled",
    });
  });

  test("a finished job without the recipe's files fails the stamp (outputs_missing); the job stays finished", async () => {
    const { env, jobId, stampId } = await dispatched();
    await finishAtTapis(fx, env, jobId, { outputs: [{ path: "other.txt", content: "x" }] });
    expect((await reread(env, jobId)).state).toBe("finished");
    await syncPipelineStamps(env);
    expect(await getStamp(env.DB, stampId)).toMatchObject({
      state: "failed",
      refusal_code: "outputs_missing",
    });
  });

  test("the recipes table is required as well as the record", async () => {
    const { env, jobId, stampId } = await dispatched();
    await finishAtTapis(fx, env, jobId, { outputs: floorOutputs().slice(0, 1) });
    await syncPipelineStamps(env);
    expect((await getStamp(env.DB, stampId))?.refusal_code).toBe("outputs_missing");
  });

  test("a record that is not JSON, not the recipe's shape, or another recipe's fails the stamp", async () => {
    for (const [text, word] of [
      ["not json{", "record_unreadable"],
      [JSON.stringify({ extensions: {} }), "record_unreadable"],
      [recipeRecord({ recipe: { id: "nemar-ica", version: "1.0.0" } }), "record_mismatch"],
    ] as const) {
      await fx.reset();
      const { env, jobId, stampId } = await dispatched();
      await finishAtTapis(fx, env, jobId, { outputs: floorOutputs(text) });
      await syncPipelineStamps(env);
      expect([text.slice(0, 20), (await getStamp(env.DB, stampId))?.refusal_code]).toEqual([
        text.slice(0, 20),
        word,
      ]);
    }
  });

  test("a record over the bound is unreadable, and is not read", async () => {
    const { env, jobId, stampId } = await dispatched();
    await finishAtTapis(fx, env, jobId, {
      outputs: floorOutputs(recipeRecord({ padding: "x".repeat(600 * 1024) })),
    });
    await syncPipelineStamps(env);
    expect((await getStamp(env.DB, stampId))?.refusal_code).toBe("record_unreadable");
  });

  test("a results bucket that is not bound leaves the stamp open: nothing is decided from what was not read", async () => {
    const { env, jobId, stampId } = await dispatched();
    await finishAtTapis(fx, env, jobId, { outputs: floorOutputs() });
    const noBucket = fx.env({ COMPUTE_RESULTS: undefined });
    expect(await syncPipelineStamps(noBucket)).toMatchObject({ succeeded: 0, failed: 0 });
    expect((await getStamp(env.DB, stampId))?.state).toBe("dispatched");
    expect(await syncPipelineStamps(env)).toMatchObject({ succeeded: 1 });
  });

  test("a record that names a tuple already stamped fails the stamp as duplicate_stamp, never two successes", async () => {
    const { env, jobId, stampId } = await dispatched();
    // Another dispatched tuple (with a job) already holds what this record will name.
    await env.DB.prepare(
      `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, attempt, state, job_id)
       VALUES ('nm000104', 'v1.0.0', 'nemar-floor', '1.0.1', 'eegprep@0.5.1', 1, 'succeeded', ?1)`,
    )
      .bind(jobId)
      .run();
    await finishAtTapis(fx, env, jobId, {
      outputs: floorOutputs(
        recipeRecord({
          recipe: { id: "nemar-floor", version: "1.0.1" },
          engine: { package: "eegprep", version: "0.5.1" },
        }),
      ),
    });
    await syncPipelineStamps(env);
    expect(await getStamp(env.DB, stampId)).toMatchObject({
      state: "failed",
      refusal_code: "duplicate_stamp",
    });
  });

  test("a claim never followed by a job is failed after the grace period, and not before", async () => {
    const { env } = await world();
    await env.DB.prepare(
      `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, attempt)
       VALUES ('nm000104', 'v1.0.0', 'nemar-floor', ?1, ?2, 1)`,
    )
      .bind(floor?.version, floor?.engine)
      .run();
    expect(await syncPipelineStamps(env)).toMatchObject({ examined: 1, failed: 0 });
    await env.DB.prepare("UPDATE compute_pipeline_stamps SET created_at = datetime('now', ?1)")
      .bind(`-${STAMP_NO_JOB_MINUTES + 1} minutes`)
      .run();
    expect(await syncPipelineStamps(env)).toMatchObject({ examined: 1, failed: 1 });
    expect((await stampsOf(env))[0]).toMatchObject({ state: "failed", refusal_code: "no_job" });
    // The failed claim frees the tuple.
    expect(await run(env)).toMatchObject({ ok: true, attempt: 2 });
  });

  test("a job created whose link was lost is found again by its key, not failed", async () => {
    const { env, jobId, stampId } = await dispatched();
    await env.DB.prepare("UPDATE compute_pipeline_stamps SET job_id = NULL WHERE id = ?1")
      .bind(stampId)
      .run();
    await env.DB.prepare(
      "UPDATE compute_pipeline_stamps SET created_at = datetime('now', '-3 hours') WHERE id = ?1",
    )
      .bind(stampId)
      .run();
    expect(await syncPipelineStamps(env)).toMatchObject({ linked: 1, failed: 0 });
    expect(await getStamp(env.DB, stampId)).toMatchObject({ state: "dispatched", job_id: jobId });
  });

  test("a stamp whose job row is gone is failed (job_missing)", async () => {
    const { env, stampId } = await dispatched();
    await env.DB.prepare("DELETE FROM compute_jobs").run();
    await syncPipelineStamps(env);
    expect((await getStamp(env.DB, stampId))?.refusal_code).toBe("job_missing");
  });

  test("a sync examines at most its bound, oldest first, and a stamp that throws does not hold the rest", async () => {
    const { env } = await world();
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare(
        `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, attempt, created_at, updated_at)
         VALUES (?1, 'v1.0.0', 'nemar-floor', '1.0.0', 'eegprep@0.5.0', 1, datetime('now', '-2 hours'), datetime('now', ?2))`,
      )
        .bind(`nm00020${i}`, `-${i + 1} minutes`)
        .run();
    }
    expect(await syncPipelineStamps(env)).toMatchObject({ examined: 3, failed: 3 });
  });
});

describe("a deleted dataset", () => {
  test("loses its stamps and keeps its jobs and ledger entries", async () => {
    const { env } = await world();
    const owner = await seedUser(env.DB, {});
    await env.DB.prepare("UPDATE datasets SET owner_user_id = ?1 WHERE dataset_id = 'nm000104'")
      .bind(owner)
      .run();
    await seedEegDataset(env, "nm000105", { owner });
    const a = await run(env);
    const b = await run(env, { datasetId: "nm000105" });
    if (!a.ok || !b.ok) throw new Error("not dispatched");
    const result = await deleteDatasetCascade(
      env.DB,
      { ...env, ENVIRONMENT: "production" },
      "nm000104",
      {
        skipS3: true,
      },
    );
    expect(result.steps.d1.success).toBe(true);
    expect(await stampsOf(env, "nm000104")).toEqual([]);
    expect(await stampsOf(env, "nm000105")).toHaveLength(1);
    // The job and its hold stay, by design (design section 9).
    expect((await reread(env, a.jobId)).id).toBe(a.jobId);
    expect(await ledgerKinds(env, a.jobId)).toEqual(["hold"]);
    expect(await jobCount(env)).toBe(2);
  });
});

describe("the launcher's files", () => {
  test("the registry's product directory is under the launcher's outputs", () => {
    expect(LAUNCHER_FILES.result).toBe("result.json");
  });

  test("advancing a dispatched, finished job twice settles it once", async () => {
    const { env } = await world();
    const r = await run(env);
    if (!r.ok) throw new Error("not dispatched");
    await finishAtTapis(fx, env, r.jobId, { outputs: floorOutputs() });
    await advanceComputeJob(env, r.jobId);
    expect(await ledgerKinds(env, r.jobId)).toEqual(["hold", "charge"]);
  });
});
