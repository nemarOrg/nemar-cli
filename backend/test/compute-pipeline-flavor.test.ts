/**
 * `nemar-ica` on a runner over the Zarr serving copy (portable compute card Q1z; plan D12; ADR 0137 decisions 5
 * and 9), against NEMAR's REAL routes and services: the admin router behind its real authentication, over a real
 * migrated database (bun:sqlite behind `realD1`), Miniflare's R2 through the Worker's own bindings, and one real
 * loopback server for the two EXTERNAL services the Zarr source check reads (GitHub, and the serving copy's
 * index). Nothing of NEMAR is stood in for.
 *
 * There is ONE runtime image for every recipe, the CUDA image `COMPUTE_RUNTIME_IMAGE` pins (owner, 2026-11-27):
 * here it holds the reference of nemar-process v0.1.2's CUDA image, the one `test/fixtures/nemar-recipe-version.json`
 * describes (an assembled version output, whose `provenance` says how it was made). What is pinned, each with the
 * mutation that kills it named in its test:
 *  - a runner dispatch of `nemar-ica` over `zarr` records a job of that image, one GPU as a ceiling, 16384 MB, the
 *    command `nemar-recipe run nemar-ica --input zarr` and no `--ica-*` argument, so the recipe's own defaults hold;
 *  - with no image configured it is refused `runtime_unavailable` and nothing is written;
 *  - `bids` on a runner and `zarr` on Tapis are still refused `invalid_spec` naming `input`, writing nothing;
 *  - `nemar-floor`'s runner dispatch is what it was.
 * The claim by a runner with a GPU, and the refusal of one without, are `compute-runner-queue.test.ts`'s.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { findRecipe } from "../../shared/compute-recipes";
import { type StampRow, dispatchPipelineJob } from "../src/services/compute-pipeline";
import { submitMemoryForQueue } from "../src/services/compute-queues";
import { recordKey } from "../src/services/compute-records";
import type { Bindings } from "../src/types/bindings";
import { COMPUTE_KEYS, makeComputeApp, seedComputeUsers } from "./helpers/compute-app";
import { type LifecycleFixture, startLifecycleFixture } from "./helpers/compute-lifecycle-fixture";
import {
  fundPipelines,
  seedEegDataset,
  seedPipelinesAccount,
} from "./helpers/compute-pipeline-fixture";
import {
  type GithubCompareStandin,
  startGithubCompareStandin,
} from "./helpers/github-compare-standin";
import { CUDA_DIGEST, CUDA_REF } from "./helpers/recipe-version-fixture";

let fx: LifecycleFixture;
const handle = makeComputeApp();
let github: GithubCompareStandin;
const seams = globalThis as { NEMAR_GITHUB_API_URL?: string; NEMAR_ZARR_INDEX_BASE?: string };
const previousSeams = { github: seams.NEMAR_GITHUB_API_URL, index: seams.NEMAR_ZARR_INDEX_BASE };

beforeAll(async () => {
  fx = await startLifecycleFixture({ withD1: true });
  github = startGithubCompareStandin();
  seams.NEMAR_GITHUB_API_URL = github.url;
  seams.NEMAR_ZARR_INDEX_BASE = github.indexBase;
}, 120_000);

beforeEach(async () => {
  github?.reset();
  await fx.reset();
  await seedComputeUsers(fx.harness.db);
  // The service account a pipeline job is made under; a runner job needs no funding.
  await seedPipelinesAccount(envOf());
});

afterAll(async () => {
  github?.stop();
  seams.NEMAR_GITHUB_API_URL = previousSeams.github;
  seams.NEMAR_ZARR_INDEX_BASE = previousSeams.index;
  await fx?.dispose();
}, 30_000);

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ADMIN = { kind: "admin", userId: 1 } as const;

/** Development, with the runners on and the CUDA image configured, unless a case says otherwise. */
const envOf = (over: Partial<Bindings> = {}): Bindings =>
  fx.env({
    ENVIRONMENT: "development",
    COMPUTE_RUNNERS_ENABLED: "1",
    COMPUTE_RUNTIME_IMAGE: CUDA_REF,
    ...over,
  });

let seq = 0;
/** A public EEG dataset whose Zarr copy is ready and whose tag and index name `COMMIT`. */
async function dataset(): Promise<string> {
  const id = `nm${String(40_000 + ++seq).padStart(6, "0")}`;
  const env = envOf();
  await seedEegDataset(env, id);
  github.tag(id, "v1.0.0", COMMIT);
  github.index(id, { source_commit: COMMIT, store_count: 3 });
  await env.DB.prepare(
    "UPDATE datasets SET zarr_source_commit = ?1, zarr_status = 'ready', zarr_store_count = 3 WHERE dataset_id = ?2",
  )
    .bind(COMMIT, id)
    .run();
  return id;
}

const count = async (table: string, where = "1 = 1") =>
  (
    await envOf()
      .DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
      .first<{ n: number }>()
  )?.n ?? 0;

/** What a refused dispatch must not have changed: stamps, jobs, claims and the ledger. */
const snapshot = async () => ({
  stamps: await count("compute_pipeline_stamps"),
  jobs: await count("compute_jobs"),
  claims: await count("compute_jobs", "runner_id IS NOT NULL"),
  ledger: await count("compute_ledger"),
});

async function stampOf(id: string): Promise<StampRow> {
  const stamp = await envOf()
    .DB.prepare("SELECT * FROM compute_pipeline_stamps WHERE dataset_id = ?1")
    .bind(id)
    .first<StampRow>();
  if (stamp === null) throw new Error("no stamp");
  return stamp;
}

/** The job's RECORDED specification: what the launch specification is built from at the claim. */
async function recordedSpec(jobId: string): Promise<Record<string, unknown>> {
  const object = await fx.harness.records.get(recordKey(jobId, "spec.json"));
  if (object === null) throw new Error("no recorded specification");
  return JSON.parse(await object.text());
}

async function route(env: Bindings, body: Record<string, unknown>) {
  const res = await handle(
    new Request("http://api.test/admin/compute/pipeline/run", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${COMPUTE_KEYS.admin}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The sizes a job row records, as the Tapis submission reads them. */
interface JobSize {
  executor: string;
  partition: string;
  cores_per_node: number;
  memory_mb: number;
  gpus: number;
}

describe("nemar-ica on a runner over the Zarr serving copy", () => {
  test("a runner dispatch records a job of the CUDA image, one GPU, 16384 MB and the recipe's own defaults (MUTATION: gpus 0; memoryMb removed; an --ica-max-iter argument)", async () => {
    const id = await dataset();
    const r = await route(envOf(), {
      recipe: "nemar-ica",
      dataset: id,
      executor: "runner",
      input: "zarr",
    });
    expect([r.status, r.body.ok]).toEqual([201, true]);
    const stamp = await stampOf(id);
    expect([stamp.recipe, stamp.input, stamp.state]).toEqual(["nemar-ica", "zarr", "dispatched"]);
    const job = await envOf()
      .DB.prepare(
        "SELECT executor, accounting, partition, pool, gpus, memory_mb, image_digest FROM compute_jobs WHERE id = ?1",
      )
      .bind(stamp.job_id)
      .first<Record<string, unknown>>();
    expect(job).toEqual({
      executor: "runner",
      accounting: "none",
      partition: "gpu-shared",
      pool: "gpu",
      gpus: 1,
      memory_mb: 16384,
      image_digest: CUDA_DIGEST,
    });
    const spec = await recordedSpec(stamp.job_id as string);
    expect(spec).toMatchObject({
      image: CUDA_REF,
      recipe: "nemar-ica",
      command: ["nemar-recipe", "run", "nemar-ica", "--input", "zarr"],
      datasets: [],
      gpus: 1,
      memory_mb: 16384,
    });
    const args = spec.args as string[];
    // No ICA option: pAMICA, 4000 iterations with AMICA's stops, device auto and one thread are the recipe's.
    expect(args.filter((a) => a.startsWith("--ica-"))).toEqual([]);
    // The image digest the run records is the CUDA image's.
    expect(args[args.indexOf("--image-digest") + 1]).toBe(CUDA_DIGEST);
  });

  test("with no runtime image it is refused runtime_unavailable, and writes no stamp, job or claim (MUTATION: drop the image check)", async () => {
    const id = await dataset();
    const before = await snapshot();
    const off = envOf({ COMPUTE_RUNTIME_IMAGE: undefined });
    expect(
      await dispatchPipelineJob(off, {
        recipe: "nemar-ica",
        datasetId: id,
        actor: ADMIN,
        executor: "runner",
        input: "zarr",
      }),
    ).toMatchObject({ ok: false, code: "runtime_unavailable" });
    expect(await snapshot()).toEqual(before);
  });

  test("bids on a runner and zarr on Tapis are still invalid_spec naming input, writing nothing (MUTATION: allow bids on a runner)", async () => {
    await fundPipelines(envOf(), 100_000_000, true);
    const id = await dataset();
    const before = await snapshot();
    for (const body of [
      { executor: "runner", input: "bids" },
      { executor: "tapis", input: "zarr" },
      { input: "zarr" },
    ]) {
      const r = await route(envOf(), { recipe: "nemar-ica", dataset: id, ...body });
      expect([body, r.status, r.body.code, r.body.field]).toEqual([
        body,
        400,
        "invalid_spec",
        "input",
      ]);
    }
    expect(await snapshot()).toEqual(before);
  });

  test("its registry memory is recipe-wide: a BIDS job on Tapis is submitted to gpu-shared with 16384 MB, not the gpus x 94208 default (MUTATION: memoryMb removed)", async () => {
    await fundPipelines(envOf(), 100_000_000, true);
    const id = await dataset();
    const r = await route(envOf(), { recipe: "nemar-ica", dataset: id });
    expect([r.status, r.body.ok]).toEqual([201, true]);
    const stamp = await stampOf(id);
    expect([stamp.input, stamp.state]).toEqual(["bids", "dispatched"]);
    const job = (await envOf()
      .DB.prepare(
        "SELECT executor, partition, cores_per_node, memory_mb, gpus FROM compute_jobs WHERE id = ?1",
      )
      .bind(stamp.job_id)
      .first<JobSize>()) as JobSize;
    expect(job).toEqual({
      executor: "tapis",
      partition: "gpu-shared",
      cores_per_node: 10,
      memory_mb: 16384,
      gpus: 1,
    });
    expect(
      submitMemoryForQueue("gpu-shared", {
        cores: job.cores_per_node,
        memory_mb: job.memory_mb,
        gpus: job.gpus,
      }),
    ).toBe(16384);
    expect(submitMemoryForQueue("gpu-shared", { cores: 10, memory_mb: 16384, gpus: 1 })).toBe(
      16384,
    );
  });

  test("nemar-floor's runner dispatch is unchanged: no GPU, its own memory and command, on the same image", async () => {
    const id = await dataset();
    const r = await dispatchPipelineJob(envOf(), {
      recipe: "nemar-floor",
      datasetId: id,
      actor: ADMIN,
      executor: "runner",
    });
    if (!r.ok) throw new Error(`not dispatched: ${r.code}`);
    const spec = await recordedSpec(r.jobId);
    const floor = findRecipe("nemar-floor") as NonNullable<ReturnType<typeof findRecipe>>;
    expect(spec).toMatchObject({
      image: CUDA_REF,
      recipe: "nemar-floor",
      command: ["nemar-recipe", "run", "nemar-floor", "--input", "zarr"],
      partition: "shared",
      gpus: 0,
      cores: floor.cores,
      memory_mb: floor.memoryMb,
    });
  });
});
