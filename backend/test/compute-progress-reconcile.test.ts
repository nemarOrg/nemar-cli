/**
 * Reconciliation of live progress when a pipeline run ends (ADR 0134 decision 4, epic #2324 phase 2),
 * driven through `syncPipelineStamps` over real migrations, the Tapis stand-in and Miniflare's R2: a real
 * `nemar-floor` job dispatched and taken to its end, its recordings table written by the launcher the
 * lifecycle fixture plays. Job and stamp states, live rows and derivative decisions are set with SQL the
 * tables accept, where a case is about what reconciliation does with a row in that shape.
 *
 * What is pinned: a finished run is reconciled from its table (counts, failures, a pending `stored` row,
 * a completed link with the record's digest and version); live counts that ran ahead are a disagreement
 * and live counts that lag are not; a failed run with a partial table counts the recordings it never
 * wrote as skipped `not_run` and its `processing` entry is final; a missing or unreadable table, a recipe
 * version with no map and an unknown recipe each get their outcome and no counts; a second sync changes
 * nothing; reconciliation never changes a stamp; an older stamp never overwrites a newer document; a
 * pending `stored` row resolves from the derivative store and the `processing` entry validates against the
 * vendored neuroschema; the stalled SQL agrees with `pipelineRunStatus`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { pipelineRunStatus } from "../../shared/compute-checkpoints";
import { findRecipe, recipeRequiredOutputs } from "../../shared/compute-recipes";
import { resultsOutputKey } from "../../shared/contract/compute-launch";
import {
  compileNeuroschemaValidator,
  formatAjvErrors,
} from "../../test/contract/neuroschema-validator";
import { dispatchPipelineJob, syncPipelineStamps } from "../src/services/compute-pipeline";
import {
  PIPELINE_STALLED_SQL,
  reconcilePipelineProgress,
} from "../src/services/compute-pipeline-progress";
import type { Bindings } from "../src/types/bindings";
import { type LifecycleFixture, startLifecycleFixture } from "./helpers/compute-lifecycle-fixture";
import {
  finishAtTapis,
  floorOutputs,
  floorTable,
  fundPipelines,
  recipeRecord,
  seedEegDataset,
  seedPipelinesAccount,
} from "./helpers/compute-pipeline-fixture";

let fx: LifecycleFixture;
let env: Bindings;

beforeAll(async () => {
  fx = await startLifecycleFixture();
}, 120_000);

beforeEach(async () => {
  await fx.reset();
  env = fx.env();
  await seedPipelinesAccount(env);
  await fundPipelines(env);
});

afterAll(async () => {
  await fx?.dispose();
}, 30_000);

// biome-ignore lint/suspicious/noExplicitAny: rows are read field by field
type Loose = Record<string, any>;

const floor = findRecipe("nemar-floor") as NonNullable<ReturnType<typeof findRecipe>>;
const wanted = recipeRequiredOutputs(floor);
let seq = 0;

async function dispatched() {
  const datasetId = `nm${String(8000 + ++seq).padStart(6, "0")}`;
  await seedEegDataset(env, datasetId);
  const r = await dispatchPipelineJob(env, {
    recipe: "nemar-floor",
    datasetId,
    actor: { kind: "admin", userId: 1 },
  });
  if (!r.ok) throw new Error(`could not dispatch: ${r.code}`);
  return { jobId: r.jobId, stampId: r.stampId, datasetId };
}

const RECORD = JSON.stringify({ sj_version: "0.1.0", ...JSON.parse(recipeRecord()) });
const TABLE = floorTable([
  ["sub-01/eeg/a.edf", "succeeded", null, null],
  ["sub-02/eeg/b.edf", "failed", "load_failed", "load"],
  ["sub-03/eeg/c.edf", "failed", "step_failed", "bad_channels"],
  ["sub-04/eeg/d.edf", "succeeded", null, null],
]);

/** A run that finished with the given product, and the sync that ends its stamp and reconciles it. */
async function finished(table = TABLE, record = RECORD) {
  const d = await dispatched();
  await finishAtTapis(fx, env, d.jobId, { outputs: floorOutputs(record, table) });
  return d;
}

/** A run that failed; its table (if any) is the one the launcher uploaded before it ended. */
async function failedRun(table: string | null) {
  const d = await dispatched();
  if (table !== null) {
    await fx.harness.results.put(resultsOutputKey(d.jobId, wanted.table), table);
  }
  await env.DB.prepare(
    "UPDATE compute_jobs SET state = 'failed', failure_code = 'runtime_error', ended_at = datetime('now') WHERE id = ?1",
  )
    .bind(d.jobId)
    .run();
  return d;
}

const rows = async (stampId: number) =>
  Object.fromEntries(
    (
      await env.DB.prepare(
        "SELECT checkpoint, passed, failed, skipped, total, failures, reconciled, disagreement, live_total FROM compute_pipeline_progress WHERE stamp_id = ?1",
      )
        .bind(stampId)
        .all<Loose>()
    ).results.map((r) => [r.checkpoint, r]),
  );
const runRow = (stampId: number) =>
  env.DB.prepare("SELECT * FROM compute_pipeline_progress_runs WHERE stamp_id = ?1")
    .bind(stampId)
    .first<Loose>();
const doc = async (datasetId: string, namespace: string) => {
  const r = await env.DB.prepare(
    "SELECT stamp_id, entry, final FROM compute_pipeline_documents WHERE dataset_id = ?1 AND namespace = ?2 AND recipe = 'nemar-floor'",
  )
    .bind(datasetId, namespace)
    .first<{ stamp_id: number; entry: string; final: number }>();
  return r ? { ...r, entry: JSON.parse(r.entry) } : null;
};
const stampState = (stampId: number) =>
  env.DB.prepare("SELECT state, recipe_version FROM compute_pipeline_stamps WHERE id = ?1")
    .bind(stampId)
    .first<Loose>();

/** Live rows as a run's reports left them (seeded with SQL the tables accept). */
async function seedLive(
  stampId: number,
  jobId: string,
  live: Record<string, [number, number, number, number]>,
) {
  await env.DB.prepare(
    "INSERT INTO compute_pipeline_progress_runs (stamp_id, job_id, checkpoint, reported_at, reports) VALUES (?1, ?2, 'import', datetime('now', '-30 seconds'), 3)",
  )
    .bind(stampId, jobId)
    .run();
  for (const [checkpoint, [p, f, s, t]] of Object.entries(live)) {
    await env.DB.prepare(
      "INSERT INTO compute_pipeline_progress (stamp_id, checkpoint, passed, failed, skipped, total, reported_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now', '-30 seconds'))",
    )
      .bind(stampId, checkpoint, p, f, s, t)
      .run();
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("a finished run", () => {
  test("is reconciled from its table: counts, failures, a pending stored row and a completed link (MUTATION: count from live rows)", async () => {
    const { stampId, datasetId } = await finished();
    const sync = await syncPipelineStamps(env);
    expect(sync).toMatchObject({ succeeded: 1, reconciled: 1, reconcile_errored: 0 });
    expect((await stampState(stampId))?.state).toBe("succeeded");
    const r = await rows(stampId);
    expect(r.import).toMatchObject({ passed: 3, failed: 1, skipped: 0, total: 4, reconciled: 1 });
    expect(r.preprocess).toMatchObject({
      passed: 2,
      failed: 1,
      skipped: 1,
      total: 4,
      reconciled: 1,
    });
    expect(r.quality).toMatchObject({ passed: 2, failed: 0, skipped: 2, total: 4, reconciled: 1 });
    expect(r.stored).toMatchObject({ passed: 0, failed: 0, skipped: 2, total: 4, reconciled: 0 });
    expect(JSON.parse(r.import.failures)).toEqual([
      { path: "sub-02/eeg/b.edf", code: "load_failed", step: "load", checkpoint: "import" },
    ]);
    expect(await runRow(stampId)).toMatchObject({ outcome: "reconciled", disagreement: 0 });
    const link = await doc(datasetId, "signalJourney");
    expect(link).toMatchObject({ stamp_id: stampId, final: 1 });
    expect(link?.entry).toEqual({
      recipe_version: floor.version,
      processing_status: "completed",
      location: wanted.record.replace(/^product\//, ""),
      sha256: await sha256Hex(RECORD),
      sj_version: "0.1.0",
    });
    // The processing entry waits for `stored`.
    expect(await doc(datasetId, "processing")).toBeNull();
  });

  test("live counts that ran ahead are a disagreement; live counts that lag are not (MUTATION: compare totals only)", async () => {
    const ahead = await dispatched();
    await seedLive(ahead.stampId, ahead.jobId, {
      import: [4, 0, 0, 4],
      preprocess: [1, 0, 0, 4],
      quality: [0, 0, 0, 4],
    });
    await finishAtTapis(fx, env, ahead.jobId, { outputs: floorOutputs(RECORD, TABLE) });
    const lag = await dispatched();
    await seedLive(lag.stampId, lag.jobId, {
      import: [2, 1, 0, 4],
      preprocess: [1, 0, 0, 4],
      quality: [0, 0, 0, 4],
    });
    await finishAtTapis(fx, env, lag.jobId, { outputs: floorOutputs(RECORD, TABLE) });
    await syncPipelineStamps(env);
    expect((await runRow(ahead.stampId))?.disagreement).toBe(1);
    expect((await rows(ahead.stampId)).import).toMatchObject({
      disagreement: 1,
      live_total: 4,
      passed: 3,
    });
    expect((await runRow(lag.stampId))?.disagreement).toBe(0);
  });

  test("a second sync changes nothing, and no report moves a reconciled count", async () => {
    const { stampId } = await finished();
    await syncPipelineStamps(env);
    const before = await rows(stampId);
    const again = await syncPipelineStamps(env);
    expect(again.reconciled).toBe(0);
    expect(await rows(stampId)).toEqual(before);
  });

  test("a record with no sj_version writes no link and is still reconciled", async () => {
    const { stampId, datasetId } = await finished(TABLE, recipeRecord());
    await syncPipelineStamps(env);
    expect((await runRow(stampId))?.outcome).toBe("reconciled");
    expect(await doc(datasetId, "signalJourney")).toBeNull();
  });
});

describe("a failed run", () => {
  test("with a partial table: unwritten recordings are skipped not_run, stored is all skipped, and processing is final", async () => {
    const d = await failedRun(floorTable([["sub-01/eeg/a.edf", "succeeded", null, null]]));
    await seedLive(d.stampId, d.jobId, {
      import: [1, 0, 0, 3],
      preprocess: [1, 0, 0, 3],
      quality: [0, 0, 0, 3],
    });
    await syncPipelineStamps(env);
    expect((await stampState(d.stampId))?.state).toBe("failed");
    const r = await rows(d.stampId);
    expect(r.import).toMatchObject({ passed: 1, failed: 0, skipped: 2, total: 3 });
    expect(r.stored).toMatchObject({ passed: 0, failed: 0, skipped: 3, total: 3, reconciled: 1 });
    const processing = await doc(d.datasetId, "processing");
    expect(processing?.final).toBe(1);
    const nsc = compileNeuroschemaValidator("nsc:/extensions/processing.schema.json");
    const document = { level: "dataset", recipes: { "nemar-floor": processing?.entry } };
    if (!nsc(document)) throw new Error(formatAjvErrors(nsc));
    expect((await doc(d.datasetId, "signalJourney"))?.entry).toMatchObject({
      processing_status: "failed",
      location: null,
      sha256: null,
      sj_version: null,
    });
  });

  test.each([
    ["no table", null, "table_missing"],
    ["a table with no step column", "path\tstatus\tcode\na\tsucceeded\tn/a\n", "table_unreadable"],
  ])("%s: the outcome is %s and no counts are written", async (_label, table, outcome) => {
    const d = await failedRun(table);
    await syncPipelineStamps(env);
    expect((await runRow(d.stampId))?.outcome).toBe(outcome);
    expect(await rows(d.stampId)).toEqual({});
  });

  test("a recipe version with no map, and a recipe the registry does not know, get their outcome", async () => {
    const a = await failedRun(TABLE);
    const b = await failedRun(TABLE);
    await syncPipelineStamps(env);
    // Reset the two runs and point their stamps elsewhere, as a registry change would.
    for (const id of [a.stampId, b.stampId]) {
      await env.DB.prepare("DELETE FROM compute_pipeline_progress WHERE stamp_id = ?1")
        .bind(id)
        .run();
      await env.DB.prepare("DELETE FROM compute_pipeline_progress_runs WHERE stamp_id = ?1")
        .bind(id)
        .run();
    }
    await env.DB.prepare(
      "UPDATE compute_pipeline_stamps SET recipe_version = '9.9.9' WHERE id = ?1",
    )
      .bind(a.stampId)
      .run();
    await env.DB.prepare("UPDATE compute_pipeline_stamps SET recipe = 'nemar-gone' WHERE id = ?1")
      .bind(b.stampId)
      .run();
    await reconcilePipelineProgress(env);
    expect((await runRow(a.stampId))?.outcome).toBe("no_checkpoint_map");
    expect((await runRow(b.stampId))?.outcome).toBe("recipe_unknown");
    expect(await rows(a.stampId)).toEqual({});
  });
});

describe("documents and stored", () => {
  test("an older stamp never overwrites a newer stamp's document (MUTATION: drop the stamp order)", async () => {
    const d = await failedRun(TABLE);
    const newer = d.stampId + 1000;
    await env.DB.prepare(
      "INSERT INTO compute_pipeline_documents (dataset_id, namespace, recipe, stamp_id, entry, final) VALUES (?1, 'signalJourney', 'nemar-floor', ?2, '{\"newer\":true}', 0)",
    )
      .bind(d.datasetId, newer)
      .run();
    await syncPipelineStamps(env);
    expect(await doc(d.datasetId, "signalJourney")).toMatchObject({
      stamp_id: newer,
      entry: { newer: true },
    });
  });

  test("a pending stored row resolves from the derivative store's decision, and processing is written and valid", async () => {
    const { stampId, datasetId } = await finished();
    await syncPipelineStamps(env);
    expect((await rows(stampId)).stored.reconciled).toBe(0);
    await env.DB.prepare(
      "INSERT INTO compute_derivative_skips (stamp_id, word) VALUES (?1, 'transient_failure')",
    )
      .bind(stampId)
      .run();
    const r = await reconcilePipelineProgress(env);
    expect(r.reconciled).toBe(1);
    expect((await rows(stampId)).stored).toMatchObject({
      passed: 0,
      failed: 0,
      skipped: 4,
      total: 4,
      reconciled: 1,
    });
    const processing = await doc(datasetId, "processing");
    expect(processing?.final).toBe(1);
    expect(processing?.entry.declared_checkpoints).toEqual([
      "import",
      "preprocess",
      "quality",
      "stored",
    ]);
    const nsc = compileNeuroschemaValidator("nsc:/extensions/processing.schema.json");
    const document = { level: "dataset", recipes: { "nemar-floor": processing?.entry } };
    if (!nsc(document)) throw new Error(formatAjvErrors(nsc));
    expect((await reconcilePipelineProgress(env)).reconciled).toBe(0);
  });
});

describe("stalled", () => {
  test("the SQL predicate agrees with pipelineRunStatus at 179 s, 181 s, unreported and never reported", async () => {
    const d = await dispatched();
    const cases: Array<[string, number | null]> = [
      ["running", 179],
      ["running", 181],
      ["unreported", 10],
      ["running", null],
      ["queued", null],
    ];
    for (const [jobState, age] of cases) {
      await env.DB.prepare("DELETE FROM compute_pipeline_progress_runs").run();
      await env.DB.prepare("UPDATE compute_jobs SET state = ?1 WHERE id = ?2")
        .bind(jobState, d.jobId)
        .run();
      if (age !== null) {
        await env.DB.prepare(
          `INSERT INTO compute_pipeline_progress_runs (stamp_id, job_id, reported_at, reports) VALUES (?1, ?2, datetime('now', '-${age} seconds'), 1)`,
        )
          .bind(d.stampId, d.jobId)
          .run();
      }
      const row = await env.DB.prepare(
        `SELECT ${PIPELINE_STALLED_SQL} AS stalled FROM compute_jobs j LEFT JOIN compute_pipeline_progress_runs r ON r.job_id = j.id WHERE j.id = ?1`,
      )
        .bind(d.jobId)
        .first<{ stalled: number | null }>();
      const now = Math.floor(Date.now() / 1000);
      const status = pipelineRunStatus({
        stampState: "dispatched",
        jobState,
        reportedAt: age === null ? null : now - age,
        now,
      });
      expect([jobState, age, row?.stalled === 1]).toEqual([jobState, age, status === "stalled"]);
    }
  });
});
