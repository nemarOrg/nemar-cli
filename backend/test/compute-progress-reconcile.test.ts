/**
 * Reconciliation of live progress when a pipeline run ends (ADR 0134 decision 4, epic #2324 phase 2), and
 * the write gate of a report, driven through `syncPipelineStamps`, `reconcilePipelineProgress` and
 * `recordProgress` over real migrations, the Tapis stand-in and Miniflare's R2: a real `nemar-floor` job
 * dispatched and taken to its end, its recordings table written by the launcher the lifecycle fixture plays.
 * Job and stamp states, live rows and derivative decisions are set with SQL the tables accept, where a case
 * is about what the code does with a row in that shape.
 *
 * What is pinned:
 *  - a finished run is reconciled from its table (counts, failures, a pending `stored` row, a completed link
 *    with the record's digest and version); live counts that ran ahead are a disagreement, lag is not;
 *  - a failed run counts the recordings it never wrote as skipped `not_run`; its `processing` entry and a
 *    `failed` link are final; every outcome without counts writes a final `failed` link;
 *  - a succeeded run whose link cannot be built keeps the last final link (no `in_progress` left standing);
 *  - a new run's live report never erases the last completed link;
 *  - a `tuple_mismatch` hold stamp shares a job and is never reconciled: the queue moves on;
 *  - `stored` resolves from the declared order the run recorded, never the live registry; a row that cannot
 *    make an entry is resolved without one and never blocks the rows behind it; each derivative decision;
 *  - the write gates: a report for a job that left an accepted state, of another lease or runner, or for an
 *    ended stamp writes nothing; a second reconcile gate and a stale write id write nothing;
 *  - a second sync changes nothing; an older stamp never overwrites a newer document; the stalled SQL
 *    agrees with `pipelineRunStatus`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { pipelineRunStatus } from "../../shared/compute-checkpoints";
import { findRecipe, recipeRequiredOutputs } from "../../shared/compute-recipes";
import type { ComputeState } from "../../shared/compute-state";
import { resultsOutputKey } from "../../shared/contract/compute-launch";
import { PROGRESS_FORMAT, type Progress } from "../../shared/contract/compute-progress";
import {
  compileNeuroschemaValidator,
  formatAjvErrors,
} from "../../test/contract/neuroschema-validator";
import {
  TUPLE_MISMATCH_WORD,
  dispatchPipelineJob,
  syncPipelineStamps,
} from "../src/services/compute-pipeline";
import {
  FINAL_DOCUMENT_SQL,
  HOLD_STAMP_WORD,
  PIPELINE_STALLED_SQL,
  RECONCILE_GATE_SQL,
  liveSignalJourneyLinks,
  reconcilePipelineProgress,
  recordProgress,
  stampForJob,
} from "../src/services/compute-pipeline-progress";
import { pipelineExtensions } from "../src/services/data-router";
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
const ENGINE_VERSION = floor.engine.split("@")[1];
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

/** A second run of a dataset that already has one: a newer version, so a new tuple and a new stamp. */
async function dispatchFor(datasetId: string) {
  await env.DB.prepare(
    "INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at) VALUES (?1, '1.0.1', ?2, 'ezid', '2026-02-02 03:04:05')",
  )
    .bind(datasetId, `10.82901/nemar.${datasetId}.v1.0.1`)
    .run();
  const r = await dispatchPipelineJob(env, {
    recipe: "nemar-floor",
    datasetId,
    actor: { kind: "admin", userId: 1 },
  });
  if (!r.ok) throw new Error(`could not dispatch: ${r.code}`);
  return { jobId: r.jobId, stampId: r.stampId, datasetId };
}

/** A record of the registry's own version; with a signalJourney version unless `linkable` is false. */
const recordOf = (over: Record<string, unknown> = {}, linkable = true) => {
  const base = JSON.parse(
    recipeRecord({
      recipe: { id: "nemar-floor", version: floor.version },
      engine: { package: "eegprep", version: ENGINE_VERSION },
      ...over,
    }),
  );
  return JSON.stringify(linkable ? { sj_version: "0.1.0", ...base } : base);
};
const RECORD = recordOf();
const TABLE = floorTable([
  ["sub-01/eeg/a.edf", "succeeded", null, null],
  ["sub-02/eeg/b.edf", "failed", "load_failed", "load"],
  ["sub-03/eeg/c.edf", "failed", "step_failed", "bad_channels"],
  ["sub-04/eeg/d.edf", "succeeded", null, null],
]);

async function finished(table = TABLE, record = RECORD) {
  const d = await dispatched();
  await finishAtTapis(fx, env, d.jobId, { outputs: floorOutputs(record, table) });
  return d;
}

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
    "SELECT stamp_id, entry FROM compute_pipeline_documents WHERE dataset_id = ?1 AND namespace = ?2 AND recipe = 'nemar-floor'",
  )
    .bind(datasetId, namespace)
    .first<{ stamp_id: number; entry: string }>();
  return r ? { ...r, entry: JSON.parse(r.entry) } : null;
};
/** What metadata.json serves for a dataset's pipeline: the stored final documents and live links. */
const served = async (datasetId: string) =>
  pipelineExtensions(
    (
      await env.DB.prepare(
        "SELECT namespace, recipe, entry FROM compute_pipeline_documents WHERE dataset_id = ?1",
      )
        .bind(datasetId)
        .all<{ namespace: string; recipe: string; entry: string }>()
    ).results,
    await liveSignalJourneyLinks(env.DB, datasetId),
  );
const stampState = (stampId: number) =>
  env.DB.prepare("SELECT state FROM compute_pipeline_stamps WHERE id = ?1")
    .bind(stampId)
    .first<Loose>();
const anyCount = async (table: string, where = "1 = 1", ...binds: unknown[]) =>
  (
    await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
      .bind(...binds)
      .first<{ n: number }>()
  )?.n ?? 0;

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

const liveProgress = (total: number): Progress => ({
  format: PROGRESS_FORMAT,
  checkpoint: "import",
  counts: {
    import: { passed: 1, failed: 0, skipped: 0, total },
    preprocess: { passed: 0, failed: 0, skipped: 0, total },
    quality: { passed: 0, failed: 0, skipped: 0, total },
  },
  failures: [],
});

/** A dispatched run that has sent one accepted report. */
async function reportingRun(datasetId?: string) {
  const d = datasetId ? await dispatchFor(datasetId) : await dispatched();
  const lookup = await stampForJob(env.DB, d.jobId);
  if (!lookup.ok) throw new Error(lookup.reason);
  expect(
    await recordProgress(env.DB, {
      jobId: d.jobId,
      stamp: lookup.stamp,
      reporter: { executor: "tapis" },
      progress: liveProgress(3),
    }),
  ).toBe("accepted");
  return d;
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
    expect(r.preprocess).toMatchObject({ passed: 2, failed: 1, skipped: 1, total: 4 });
    expect(r.quality).toMatchObject({ passed: 2, failed: 0, skipped: 2, total: 4 });
    expect(r.stored).toMatchObject({ passed: 0, failed: 0, skipped: 2, total: 4, reconciled: 0 });
    expect(JSON.parse(r.import.failures)).toEqual([
      { path: "sub-02/eeg/b.edf", code: "load_failed", step: "load", checkpoint: "import" },
    ]);
    expect(await runRow(stampId)).toMatchObject({
      outcome: "reconciled",
      disagreement: 0,
      recipe_version: floor.version,
      declared: JSON.stringify(["import", "preprocess", "quality", "stored"]),
    });
    expect((await doc(datasetId, "signalJourney"))?.entry).toEqual({
      recipe_version: floor.version,
      processing_status: "completed",
      location: wanted.record.replace(/^product\//, ""),
      sha256: await sha256Hex(RECORD),
      sj_version: "0.1.0",
    });
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
    expect((await rows(ahead.stampId)).import).toMatchObject({ disagreement: 1, live_total: 4 });
    expect((await runRow(lag.stampId))?.disagreement).toBe(0);
  });

  test("two reconciliations racing for one run count it once (MUTATION: count reconciled without the gate's change)", async () => {
    const { stampId } = await finished();
    await syncPipelineStamps(env);
    // Undo the sync's own reconciliation, so two callers find the run unreconciled together.
    for (const table of ["compute_pipeline_progress", "compute_pipeline_progress_runs"]) {
      await env.DB.prepare(`DELETE FROM ${table} WHERE stamp_id = ?1`).bind(stampId).run();
    }
    const [a, b] = await Promise.all([
      reconcilePipelineProgress(env),
      reconcilePipelineProgress(env),
    ]);
    expect(a.reconciled + b.reconciled).toBe(1);
    expect((await runRow(stampId))?.outcome).toBe("reconciled");
  });

  test("a second sync changes nothing and counts nothing", async () => {
    const { stampId } = await finished();
    await syncPipelineStamps(env);
    const before = await rows(stampId);
    const again = await syncPipelineStamps(env);
    expect(again.reconciled).toBe(0);
    expect(await rows(stampId)).toEqual(before);
  });

  test("a succeeded run whose link cannot be built keeps the last final link and leaves no in_progress standing", async () => {
    const first = await finished();
    await syncPipelineStamps(env);
    const completed = (await doc(first.datasetId, "signalJourney"))?.entry;
    expect(completed?.processing_status).toBe("completed");
    const second = await reportingRun(first.datasetId);
    await finishAtTapis(fx, env, second.jobId, {
      outputs: floorOutputs(recordOf({}, false), TABLE),
    });
    await syncPipelineStamps(env);
    expect((await runRow(second.stampId))?.outcome).toBe("reconciled");
    expect((await served(first.datasetId)).signalJourney?.recipes["nemar-floor"]).toEqual(
      completed,
    );
  });
});

describe("live links are never documents", () => {
  test("a new run's live report does not erase the last completed link (MUTATION: store the live link)", async () => {
    const first = await finished();
    await syncPipelineStamps(env);
    const completed = await doc(first.datasetId, "signalJourney");
    expect(completed?.entry.processing_status).toBe("completed");
    await reportingRun(first.datasetId);
    expect(await doc(first.datasetId, "signalJourney")).toEqual(completed);
    expect((await served(first.datasetId)).signalJourney?.recipes["nemar-floor"]).toMatchObject({
      processing_status: "in_progress",
    });
  });

  test("a failed run with no table serves a failed link, not in_progress (reviewer repro 1)", async () => {
    const d = await reportingRun();
    await env.DB.prepare(
      "UPDATE compute_jobs SET state = 'failed', failure_code = 'runtime_error', ended_at = datetime('now') WHERE id = ?1",
    )
      .bind(d.jobId)
      .run();
    await syncPipelineStamps(env);
    expect((await runRow(d.stampId))?.outcome).toBe("table_missing");
    expect((await served(d.datasetId)).signalJourney?.recipes["nemar-floor"]).toEqual({
      recipe_version: floor.version,
      processing_status: "failed",
      location: null,
      sha256: null,
      sj_version: null,
    });
  });

  test("a succeeded run whose link cannot be built, with no earlier link, serves no link (reviewer repro 2)", async () => {
    const d = await reportingRun();
    await finishAtTapis(fx, env, d.jobId, {
      outputs: floorOutputs(
        recordOf({}, false),
        floorTable([["sub-01/eeg/a.edf", "succeeded", null, null]]),
      ),
    });
    await syncPipelineStamps(env);
    expect((await runRow(d.stampId))?.outcome).toBe("reconciled");
    expect((await served(d.datasetId)).signalJourney).toBeUndefined();
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
    const nsc = compileNeuroschemaValidator("nsc:/extensions/processing.schema.json");
    if (!nsc({ level: "dataset", recipes: { "nemar-floor": processing?.entry } })) {
      throw new Error(formatAjvErrors(nsc));
    }
    expect((await doc(d.datasetId, "signalJourney"))?.entry).toMatchObject({
      processing_status: "failed",
      location: null,
    });
  });

  test.each([
    ["no table", null, "table_missing"],
    ["a table with no step column", "path\tstatus\tcode\na\tsucceeded\tn/a\n", "table_unreadable"],
  ])(
    "%s: the outcome is %s, no counts, and a final failed link",
    async (_label, table, outcome) => {
      const d = await failedRun(table);
      await syncPipelineStamps(env);
      expect((await runRow(d.stampId))?.outcome).toBe(outcome);
      expect(await rows(d.stampId)).toEqual({});
      expect((await doc(d.datasetId, "signalJourney"))?.entry.processing_status).toBe("failed");
    },
  );

  test("a recipe version with no map, and a recipe the registry does not know, get their outcome", async () => {
    const a = await failedRun(TABLE);
    const b = await failedRun(TABLE);
    await env.DB.prepare(
      "UPDATE compute_pipeline_stamps SET recipe_version = '9.9.9' WHERE id = ?1",
    )
      .bind(a.stampId)
      .run();
    await env.DB.prepare("UPDATE compute_pipeline_stamps SET recipe = 'nemar-gone' WHERE id = ?1")
      .bind(b.stampId)
      .run();
    await syncPipelineStamps(env);
    expect((await runRow(a.stampId))?.outcome).toBe("no_checkpoint_map");
    expect((await runRow(b.stampId))?.outcome).toBe("recipe_unknown");
    expect(await rows(a.stampId)).toEqual({});
  });
});

describe("a hold stamp", () => {
  test("shares its job, is never reconciled, and the queue moves on (C1; MUTATION: drop the hold exclusion, or make the job index unique)", async () => {
    expect(HOLD_STAMP_WORD).toBe(TUPLE_MISMATCH_WORD);
    // A record of another version: the stamp is rewritten, and the claimed tuple is held by a second stamp
    // of the same job.
    // Both runs end before the sync: once the tuple is held, the registry is drifted and no run is dispatched.
    const d = await finished(TABLE, recordOf({ recipe: { id: "nemar-floor", version: "9.0.0" } }));
    const next = await finished();
    const sync = await syncPipelineStamps(env);
    const stamps = (
      await env.DB.prepare(
        "SELECT id, state, refusal_code FROM compute_pipeline_stamps WHERE job_id = ?1 ORDER BY id",
      )
        .bind(d.jobId)
        .all<Loose>()
    ).results;
    expect(stamps).toHaveLength(2);
    expect(stamps[1]).toMatchObject({ state: "failed", refusal_code: TUPLE_MISMATCH_WORD });
    expect(sync.reconcile_errored).toBe(0);
    expect((await runRow(d.stampId))?.outcome).toBe("no_checkpoint_map");
    expect(await runRow(stamps[1].id)).toBeNull();
    expect((await runRow(next.stampId))?.outcome).toBe("reconciled");
    expect((await syncPipelineStamps(env)).reconcile_errored).toBe(0);
  });
});

describe("stored", () => {
  /** A finished, reconciled run whose `stored` row is pending. */
  async function pending() {
    const d = await finished();
    await syncPipelineStamps(env);
    expect((await rows(d.stampId)).stored.reconciled).toBe(0);
    return d;
  }
  const skip = (stampId: number) =>
    env.DB.prepare(
      "INSERT INTO compute_derivative_skips (stamp_id, word) VALUES (?1, 'transient_failure')",
    )
      .bind(stampId)
      .run();
  const derivative = (
    d: { stampId: number; jobId: string; datasetId: string },
    state: string,
    storedAt: boolean,
  ) =>
    env.DB.prepare(
      `INSERT INTO compute_derivatives (key, dataset_id, version, recipe, recipe_version, engine, input, profile,
         input_digest, image_digest, job_id, stamp_id, state, failure, copied, object_count, bytes, stored_at)
       VALUES (?1, ?2, 'v1.0.0', 'nemar-floor', ?3, ?4, 'bids', 'archive', ?5, ?6, ?7, ?8, ?9, ?10, 2, 2, 100, ?11)`,
    )
      .bind(
        d.stampId.toString(16).padStart(64, "0"),
        d.datasetId,
        floor.version,
        floor.engine,
        `git:${"a".repeat(40)}`,
        `sha256:${"b".repeat(64)}`,
        d.jobId,
        d.stampId,
        state,
        state === "failed" ? "copy_failed" : null,
        storedAt ? "2026-11-20 00:00:00" : null,
      )
      .run();

  test.each([
    ["stored", true, { passed: 2, failed: 0, skipped: 2 }],
    ["failed", false, { passed: 0, failed: 2, skipped: 2 }],
    ["expired", true, { passed: 2, failed: 0, skipped: 2 }],
    ["expired", false, { passed: 0, failed: 0, skipped: 4 }],
  ] as const)(
    "derivative %s (stored_at %s) resolves stored as %o, and processing is final and valid",
    async (state, storedAt, expected) => {
      const d = await pending();
      await derivative(d, state, storedAt);
      expect((await reconcilePipelineProgress(env)).reconciled).toBe(1);
      expect((await rows(d.stampId)).stored).toMatchObject({
        ...expected,
        total: 4,
        reconciled: 1,
      });
      const processing = await doc(d.datasetId, "processing");
      expect(processing?.entry.counts.stored).toEqual({ ...expected, total: 4 });
      const nsc = compileNeuroschemaValidator("nsc:/extensions/processing.schema.json");
      if (!nsc({ level: "dataset", recipes: { "nemar-floor": processing?.entry } })) {
        throw new Error(formatAjvErrors(nsc));
      }
      expect((await reconcilePipelineProgress(env)).reconciled).toBe(0);
    },
  );

  test("resolves from the order the run recorded, after the stamp's version moved (I2; reviewer repro 3)", async () => {
    const d = await pending();
    await env.DB.prepare(
      "UPDATE compute_pipeline_stamps SET recipe_version = '9.9.9' WHERE id = ?1",
    )
      .bind(d.stampId)
      .run();
    await skip(d.stampId);
    expect((await reconcilePipelineProgress(env, 1)).reconciled).toBe(1);
    expect((await doc(d.datasetId, "processing"))?.entry).toMatchObject({
      recipe_version: floor.version,
      declared_checkpoints: ["import", "preprocess", "quality", "stored"],
    });
  });

  test("a missing middle row resolves stored without a document", async () => {
    const d = await pending();
    await env.DB.prepare(
      "DELETE FROM compute_pipeline_progress WHERE stamp_id = ?1 AND checkpoint = 'preprocess'",
    )
      .bind(d.stampId)
      .run();
    await skip(d.stampId);
    expect((await reconcilePipelineProgress(env)).reconciled).toBe(1);
    expect((await rows(d.stampId)).stored.reconciled).toBe(1);
    expect(await doc(d.datasetId, "processing")).toBeNull();
  });

  test("with a limit of 1, a bad row ahead of a good one does not block it", async () => {
    const bad = await pending();
    const good = await pending();
    expect(bad.stampId).toBeLessThan(good.stampId);
    await env.DB.prepare(
      "UPDATE compute_pipeline_progress_runs SET declared = '[\"x\"]' WHERE stamp_id = ?1",
    )
      .bind(bad.stampId)
      .run();
    await skip(bad.stampId);
    await skip(good.stampId);
    await reconcilePipelineProgress(env, 1);
    await reconcilePipelineProgress(env, 1);
    expect(
      await anyCount("compute_pipeline_progress", "checkpoint = 'stored' AND reconciled = 0"),
    ).toBe(0);
    expect(await doc(bad.datasetId, "processing")).toBeNull();
    expect((await doc(good.datasetId, "processing"))?.entry.counts.stored.total).toBe(4);
  });
});

describe("the gates", () => {
  test("a report for a job that left an accepted state after the stamp was read writes nothing (MUTATION: drop the job state term)", async () => {
    for (const state of ["archiving", "finished"] as const) {
      const d = await dispatched();
      const lookup = await stampForJob(env.DB, d.jobId);
      if (!lookup.ok) throw new Error(lookup.reason);
      await env.DB.prepare("UPDATE compute_jobs SET state = ?1 WHERE id = ?2")
        .bind(state, d.jobId)
        .run();
      const result = await recordProgress(env.DB, {
        jobId: d.jobId,
        stamp: lookup.stamp,
        reporter: { executor: "tapis" },
        progress: liveProgress(3),
      });
      expect([state, result]).toEqual([state, "bad_state"]);
      expect(await anyCount("compute_pipeline_progress", "stamp_id = ?1", d.stampId)).toBe(0);
      expect(await anyCount("compute_pipeline_progress_runs", "stamp_id = ?1", d.stampId)).toBe(0);
    }
  });

  test("a runner report with another lease or another runner writes nothing (MUTATION: drop the lease term)", async () => {
    const d = await dispatched();
    const lookup = await stampForJob(env.DB, d.jobId);
    if (!lookup.ok) throw new Error(lookup.reason);
    const RUNNER = "rnr_0123456789abcdef01234567";
    // The job seeded as a running runner job held by one runner and lease (state seeding only).
    await env.DB.prepare(
      "UPDATE compute_jobs SET executor = 'runner', accounting = 'none', state = 'running', runner_id = ?1, lease_id = ?2 WHERE id = ?3",
    )
      .bind(RUNNER, "a".repeat(32), d.jobId)
      .run();
    for (const reporter of [
      { executor: "runner" as const, runnerId: RUNNER, leaseId: "b".repeat(32) },
      {
        executor: "runner" as const,
        runnerId: "rnr_ffffffffffffffffffffffff",
        leaseId: "a".repeat(32),
      },
    ]) {
      expect(
        await recordProgress(env.DB, {
          jobId: d.jobId,
          stamp: lookup.stamp,
          reporter,
          progress: liveProgress(3),
        }),
      ).toBe("bad_state");
    }
    expect(await anyCount("compute_pipeline_progress_runs", "stamp_id = ?1", d.stampId)).toBe(0);
    expect(
      await recordProgress(env.DB, {
        jobId: d.jobId,
        stamp: lookup.stamp,
        reporter: { executor: "runner", runnerId: RUNNER, leaseId: "a".repeat(32) },
        progress: liveProgress(3),
      }),
    ).toBe("accepted");
  });

  test("a report for a stamp deleted after it was read writes nothing (M5; MUTATION: drop the stamp term)", async () => {
    const d = await dispatched();
    const lookup = await stampForJob(env.DB, d.jobId);
    if (!lookup.ok) throw new Error(lookup.reason);
    await env.DB.prepare("DELETE FROM compute_pipeline_stamps WHERE id = ?1").bind(d.stampId).run();
    expect(
      await recordProgress(env.DB, {
        jobId: d.jobId,
        stamp: lookup.stamp,
        reporter: { executor: "tapis" },
        progress: liveProgress(3),
      }),
    ).toBe("bad_state");
    expect(await anyCount("compute_pipeline_progress_runs", "stamp_id = ?1", d.stampId)).toBe(0);
  });

  test("the reconcile gate wins once, and a document with a stale write id is not written (MUTATION: drop the write-id guard)", async () => {
    const d = await failedRun(null);
    const gate = (writeId: string) =>
      env.DB.prepare(RECONCILE_GATE_SQL)
        .bind(d.stampId, d.jobId, writeId, "table_missing", 0, floor.version, null)
        .run();
    expect((await gate("1".repeat(32))).meta.changes).toBe(1);
    expect((await gate("2".repeat(32))).meta.changes).toBe(0);
    const stale = await env.DB.prepare(FINAL_DOCUMENT_SQL)
      .bind(d.datasetId, "signalJourney", "nemar-floor", d.stampId, "{}", "2".repeat(32))
      .run();
    expect(stale.meta.changes).toBe(0);
    expect(await anyCount("compute_pipeline_documents", "dataset_id = ?1", d.datasetId)).toBe(0);
  });
});

describe("documents", () => {
  test("an older stamp never overwrites a newer stamp's document (MUTATION: drop the stamp order)", async () => {
    const d = await failedRun(TABLE);
    const newer = d.stampId + 1000;
    await env.DB.prepare(
      "INSERT INTO compute_pipeline_documents (dataset_id, namespace, recipe, stamp_id, entry) VALUES (?1, 'signalJourney', 'nemar-floor', ?2, '{\"newer\":true}')",
    )
      .bind(d.datasetId, newer)
      .run();
    await syncPipelineStamps(env);
    expect(await doc(d.datasetId, "signalJourney")).toMatchObject({
      stamp_id: newer,
      entry: { newer: true },
    });
  });
});

describe("stalled", () => {
  test("the SQL predicate agrees with pipelineRunStatus over stamp and job states and report ages", async () => {
    const d = await dispatched();
    const cases: Array<[string, ComputeState, number | null]> = [
      ["dispatched", "running", 179],
      ["dispatched", "running", 181],
      ["dispatched", "queued", 181],
      ["dispatched", "submitted", 181],
      ["dispatched", "archiving", 999],
      ["dispatched", "unreported", 10],
      ["dispatched", "finished", 999],
      ["dispatched", "created", 999],
      ["dispatched", "running", null],
      ["dispatched", "queued", null],
      ["succeeded", "running", 999],
      ["failed", "unreported", 999],
    ];
    for (const [stampState, jobState, age] of cases) {
      await env.DB.prepare("DELETE FROM compute_pipeline_progress_runs").run();
      await env.DB.prepare("UPDATE compute_jobs SET state = ?1 WHERE id = ?2")
        .bind(jobState, d.jobId)
        .run();
      await env.DB.prepare(
        "UPDATE compute_pipeline_stamps SET state = ?1, refusal_code = CASE WHEN ?1 = 'failed' THEN 'x' ELSE NULL END WHERE id = ?2",
      )
        .bind(stampState, d.stampId)
        .run();
      if (age !== null) {
        await env.DB.prepare(
          `INSERT INTO compute_pipeline_progress_runs (stamp_id, job_id, reported_at, reports) VALUES (?1, ?2, datetime('now', '-${age} seconds'), 1)`,
        )
          .bind(d.stampId, d.jobId)
          .run();
      }
      const row = await env.DB.prepare(
        `SELECT ${PIPELINE_STALLED_SQL} AS stalled FROM compute_pipeline_stamps s
           JOIN compute_jobs j ON j.id = s.job_id
           LEFT JOIN compute_pipeline_progress_runs r ON r.stamp_id = s.id WHERE s.id = ?1`,
      )
        .bind(d.stampId)
        .first<{ stalled: number | null }>();
      const now = Math.floor(Date.now() / 1000);
      const status = pipelineRunStatus({
        stampState: stampState as "dispatched" | "succeeded" | "failed",
        jobState,
        reportedAt: age === null ? null : now - age,
        now,
      });
      expect([stampState, jobState, age, row?.stalled === 1]).toEqual([
        stampState,
        jobState,
        age,
        status === "stalled",
      ]);
    }
  });
});
