/**
 * Live progress on the runner heartbeat (ADR 0134 decision 3, epic #2324 phase 2), through NEMAR's REAL
 * routes over a real loopback port and a real migrated database, as in compute-runner-queue.test.ts: a
 * runner dispatched a real `nemar-floor` job, claims it, and sends heartbeats that carry
 * `nemar.progress.v1`.
 *
 * What is pinned: an accepted report stores one row per declared checkpoint, the run row and the
 * `in_progress` signalJourney link; a second report within the floor renews the lease and stores nothing;
 * a report after the floor is stored; a report that does not fit the recipe renews the lease and stores
 * nothing; a progress that breaks its schema is `invalid_body` and renews nothing; an `uploading`
 * heartbeat's progress is ignored; a heartbeat of another runner stores nothing; the heartbeat's body may
 * carry the largest progress object.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  PROGRESS_FORMAT,
  PROGRESS_MAX_FAILURES,
  type Progress,
} from "../../shared/contract/compute-progress";
import { RUNNER_PROTOCOL, RunnerClaimResponseSchema } from "../../shared/contract/compute-runner";
import { computeRunnerRoutes } from "../src/routes/compute-runners";
import { dispatchPipelineJob } from "../src/services/compute-pipeline";
import {
  exchangeRunnerSecret,
  registerRunner,
  resolveRunnerAccess,
} from "../src/services/compute-runners";
import type { Bindings, Variables } from "../src/types/bindings";
import { type COMPUTE_KEYS, seedComputeUsers } from "./helpers/compute-app";
import { type LifecycleFixture, startLifecycleFixture } from "./helpers/compute-lifecycle-fixture";
import { seedEegDataset, seedPipelinesAccount } from "./helpers/compute-pipeline-fixture";
import {
  type GithubCompareStandin,
  startGithubCompareStandin,
} from "./helpers/github-compare-standin";

let fx: LifecycleFixture;
let ids: Record<keyof typeof COMPUTE_KEYS, number>;
let env: Bindings;
let base = "";
let server: ReturnType<typeof Bun.serve>;
let github: GithubCompareStandin;
const seams = globalThis as { NEMAR_GITHUB_API_URL?: string; NEMAR_ZARR_INDEX_BASE?: string };
const previousSeams = { github: seams.NEMAR_GITHUB_API_URL, index: seams.NEMAR_ZARR_INDEX_BASE };

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
app.route("/compute/runners", computeRunnerRoutes);

beforeAll(async () => {
  fx = await startLifecycleFixture({ withD1: true });
  github = startGithubCompareStandin();
  seams.NEMAR_GITHUB_API_URL = github.url;
  seams.NEMAR_ZARR_INDEX_BASE = github.indexBase;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) =>
      app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      } as unknown as ExecutionContext),
  });
  base = `http://127.0.0.1:${server.port}`;
}, 120_000);

beforeEach(async () => {
  github?.reset();
  await fx.reset();
  ids = await seedComputeUsers(fx.harness.db);
  env = fx.env({ ENVIRONMENT: "development", COMPUTE_RUNNERS_ENABLED: "1", API_BASE_URL: base });
  await seedPipelinesAccount(env);
});

afterAll(async () => {
  server?.stop(true);
  github?.stop();
  seams.NEMAR_GITHUB_API_URL = previousSeams.github;
  seams.NEMAR_ZARR_INDEX_BASE = previousSeams.index;
  await fx?.dispose();
}, 30_000);

// biome-ignore lint/suspicious/noExplicitAny: rows and bodies are read field by field
type Loose = Record<string, any>;

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
let seq = 0;

async function dataset(): Promise<string> {
  const id = `nm${String(5000 + ++seq).padStart(6, "0")}`;
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

async function runner(): Promise<{ id: string; token: string }> {
  const { runnerId } = await registerRunner(env.DB, ids.owner, {
    name: `runner_${++seq}`,
    pool: "cpu",
    cores: 16,
    memory_mb: 64_000,
    gpus: 0,
    scratch_gb: 500,
    backend: "local",
    runtimes: ["docker"],
    arch: "amd64",
    accounting: "none",
    site: "lab_a",
    trust: "lab",
  } as Parameters<typeof registerRunner>[2]);
  const issued = await exchangeRunnerSecret(env.DB, runnerId, "0.1.0");
  if (!issued) throw new Error("no token");
  const access = await resolveRunnerAccess(env.DB, issued.accessToken);
  if (access.kind !== "ok") throw new Error("no access");
  return { id: runnerId, token: issued.accessToken };
}

async function post(
  path: string,
  token: string,
  body: unknown,
): Promise<{ status: number; body: Loose }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: {} };
  }
}

/** A dispatched floor job on the Zarr input, claimed by a fresh runner. */
async function claimed() {
  const r = await runner();
  const datasetId = await dataset();
  const d = await dispatchPipelineJob(env, {
    recipe: "nemar-floor",
    datasetId,
    actor: { kind: "admin", userId: ids.admin },
    executor: "runner",
  });
  if (!d.ok) throw new Error(`could not dispatch: ${d.code}`);
  const res = await post("/compute/runners/claim", r.token, {
    protocol: RUNNER_PROTOCOL,
    free_slots: 1,
    runtimes: ["docker"],
    arch: "amd64",
    runner_version: "0.1.0",
  });
  const entry = RunnerClaimResponseSchema.parse(res.body).jobs[0];
  if (!entry) throw new Error("nothing claimed");
  const stamp = await env.DB.prepare("SELECT id FROM compute_pipeline_stamps WHERE job_id = ?1")
    .bind(d.jobId)
    .first<{ id: number }>();
  return { r, jobId: d.jobId, leaseId: entry.lease_id, datasetId, stampId: stamp?.id as number };
}

const progress = (over: Partial<Progress> = {}): Progress => ({
  format: PROGRESS_FORMAT,
  checkpoint: "preprocess",
  counts: {
    import: { passed: 3, failed: 1, skipped: 0, total: 6 },
    preprocess: { passed: 2, failed: 0, skipped: 1, total: 6 },
    quality: { passed: 1, failed: 0, skipped: 1, total: 6 },
  },
  failures: [{ path: "sub-02/eeg/b.set", code: "load_failed", step: "load", checkpoint: "import" }],
  ...over,
});

const beat = (
  r: { token: string },
  jobId: string,
  leaseId: string,
  phase: "started" | "uploading",
  p?: unknown,
) =>
  post("/compute/runners/heartbeat", r.token, {
    job_id: jobId,
    lease_id: leaseId,
    phase,
    ...(p === undefined ? {} : { progress: p }),
  });

const rows = (stampId: number) =>
  env.DB.prepare(
    "SELECT checkpoint, passed, failed, skipped, total, failures FROM compute_pipeline_progress WHERE stamp_id = ?1 ORDER BY checkpoint",
  )
    .bind(stampId)
    .all<Loose>()
    .then((r) => r.results);
const run = (stampId: number) =>
  env.DB.prepare("SELECT * FROM compute_pipeline_progress_runs WHERE stamp_id = ?1")
    .bind(stampId)
    .first<Loose>();
const leaseOf = (jobId: string) =>
  env.DB.prepare("SELECT lease_expires_at FROM compute_jobs WHERE id = ?1")
    .bind(jobId)
    .first<{ lease_expires_at: string }>()
    .then((r) => r?.lease_expires_at);
const ageLease = (jobId: string) =>
  env.DB.prepare(
    "UPDATE compute_jobs SET lease_expires_at = datetime('now', '+1 seconds') WHERE id = ?1",
  )
    .bind(jobId)
    .run();
const ageReport = (stampId: number, seconds: number) =>
  env.DB.prepare(
    `UPDATE compute_pipeline_progress_runs SET reported_at = datetime('now', '-${seconds} seconds') WHERE stamp_id = ?1`,
  )
    .bind(stampId)
    .run();

describe("progress on the heartbeat", () => {
  test("an accepted report stores each declared checkpoint, the run row and an in_progress link (MUTATION: drop the per-checkpoint upsert)", async () => {
    const { r, jobId, leaseId, stampId, datasetId } = await claimed();
    const res = await beat(r, jobId, leaseId, "started", progress());
    expect(res.status).toBe(200);
    expect(await rows(stampId)).toEqual([
      {
        checkpoint: "import",
        passed: 3,
        failed: 1,
        skipped: 0,
        total: 6,
        failures: JSON.stringify(progress().failures),
      },
      { checkpoint: "preprocess", passed: 2, failed: 0, skipped: 1, total: 6, failures: "[]" },
      { checkpoint: "quality", passed: 1, failed: 0, skipped: 1, total: 6, failures: "[]" },
    ]);
    expect(await run(stampId)).toMatchObject({
      job_id: jobId,
      checkpoint: "preprocess",
      reports: 1,
      reconciled_at: null,
    });
    const link = await env.DB.prepare(
      "SELECT entry, final FROM compute_pipeline_documents WHERE dataset_id = ?1 AND namespace = 'signalJourney' AND recipe = 'nemar-floor'",
    )
      .bind(datasetId)
      .first<{ entry: string; final: number }>();
    expect(link?.final).toBe(0);
    expect(JSON.parse(link?.entry ?? "{}")).toMatchObject({
      processing_status: "in_progress",
      location: null,
    });
  });

  test("a second report within the floor renews the lease and stores nothing; after the floor it is stored (MUTATION: drop the reported_at floor)", async () => {
    const { r, jobId, leaseId, stampId } = await claimed();
    expect((await beat(r, jobId, leaseId, "started", progress())).status).toBe(200);
    await ageLease(jobId);
    const before = await leaseOf(jobId);
    const again = progress({
      counts: { ...progress().counts, quality: { passed: 2, failed: 0, skipped: 1, total: 6 } },
    });
    const res = await beat(r, jobId, leaseId, "started", again);
    expect(res.status).toBe(200);
    expect(await leaseOf(jobId)).not.toBe(before);
    expect((await run(stampId))?.reports).toBe(1);
    expect((await rows(stampId)).find((x) => x.checkpoint === "quality")?.passed).toBe(1);
    await ageReport(stampId, 60);
    expect((await beat(r, jobId, leaseId, "started", again)).status).toBe(200);
    expect((await run(stampId))?.reports).toBe(2);
    expect((await rows(stampId)).find((x) => x.checkpoint === "quality")?.passed).toBe(2);
  });

  test("a report that does not fit the recipe renews the lease and stores nothing (MUTATION: skip progressProblem)", async () => {
    const { r, jobId, leaseId, stampId } = await claimed();
    for (const bad of [
      progress({ counts: { import: progress().counts.import } }),
      progress({ checkpoint: "ica" }),
      progress({
        counts: { ...progress().counts, import: { passed: 7, failed: 0, skipped: 0, total: 6 } },
      }),
    ]) {
      await ageLease(jobId);
      const before = await leaseOf(jobId);
      expect((await beat(r, jobId, leaseId, "started", bad)).status).toBe(200);
      expect(await leaseOf(jobId)).not.toBe(before);
    }
    expect(await rows(stampId)).toEqual([]);
    expect(await run(stampId)).toBeNull();
  });

  test("a progress that breaks its schema is invalid_body and renews nothing", async () => {
    const { r, jobId, leaseId, stampId } = await claimed();
    expect((await beat(r, jobId, leaseId, "started")).status).toBe(200);
    await ageLease(jobId);
    const before = await leaseOf(jobId);
    const res = await beat(r, jobId, leaseId, "started", { ...progress(), extra: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(await leaseOf(jobId)).toBe(before);
    expect(await rows(stampId)).toEqual([]);
  });

  test("an uploading heartbeat's progress is ignored (MUTATION: accept progress in any phase)", async () => {
    const { r, jobId, leaseId, stampId } = await claimed();
    expect((await beat(r, jobId, leaseId, "started")).status).toBe(200);
    expect((await beat(r, jobId, leaseId, "uploading", progress())).status).toBe(200);
    expect(await rows(stampId)).toEqual([]);
  });

  test("another runner's heartbeat with this job's lease stores nothing", async () => {
    const { r, jobId, leaseId, stampId } = await claimed();
    expect((await beat(r, jobId, leaseId, "started")).status).toBe(200);
    const other = await runner();
    const res = await beat(other, jobId, leaseId, "started", progress());
    expect(res.body.error).toBe("lease_lost");
    expect(await rows(stampId)).toEqual([]);
  });

  test("the heartbeat body may carry the largest progress object, and no more than 16 KiB", async () => {
    const { r, jobId, leaseId, stampId } = await claimed();
    const failures = Array.from({ length: PROGRESS_MAX_FAILURES }, (_, i) => ({
      path: `${"a".repeat(250)}${i}.set`.slice(-256),
      code: "load_failed",
      step: "load",
      checkpoint: "import",
    }));
    const big = progress({
      counts: {
        ...progress().counts,
        import: { passed: 0, failed: 10, skipped: 0, total: 10 },
        preprocess: { passed: 0, failed: 0, skipped: 10, total: 10 },
        quality: { passed: 0, failed: 0, skipped: 10, total: 10 },
      },
      failures,
    });
    const body = JSON.stringify({
      job_id: jobId,
      lease_id: leaseId,
      phase: "started",
      progress: big,
    });
    expect(body.length).toBeGreaterThan(2500);
    expect((await post("/compute/runners/heartbeat", r.token, body)).status).toBe(200);
    expect((await rows(stampId)).find((x) => x.checkpoint === "import")?.failed).toBe(10);
    const tooBig = JSON.stringify({
      job_id: jobId,
      lease_id: leaseId,
      phase: "started",
      pad: "x".repeat(17_000),
    });
    expect((await post("/compute/runners/heartbeat", r.token, tooBig)).body.error).toBe(
      "invalid_body",
    );
  });
});
