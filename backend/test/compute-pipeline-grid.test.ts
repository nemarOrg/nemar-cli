/**
 * The admin pipeline grid (ADR 0134 decision 5, epic #2324 phase 4a): `GET /admin/compute/pipeline/grid`,
 * `.../coverage` and `.../runs/:stamp`, through the REAL admin router with its authentication, admin and
 * cookie-origin middleware, over real migrations, real API keys, the Tapis stand-in and Miniflare's R2.
 * Jobs are taken to their end by the lifecycle fixture; job, stamp and report states and times are set with
 * SQL the tables accept where a case is about what the grid shows for a row in that shape.
 *
 * What is pinned: who may; every eligible dataset is a row and an ineligible one is not; what a row shows
 * (not started, waiting, running, stalled, finished, failed) and what each cell shows; a hold or a refused
 * stamp is never a row's run; the totals over the filtered set; each filter; paging by dataset id; bad
 * queries name the field and echo nothing; the routes write nothing unless `sync=1`; the page statement
 * finds a row's run by index; the run status SQL equals `pipelineRunStatus`; the drill-down; the coverage
 * card and its trend.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { pipelineRunStatus } from "../../shared/compute-checkpoints";
import { PIPELINE_STAMP_STATES, findRecipe } from "../../shared/compute-recipes";
import { COMPUTE_STATES, type ComputeState } from "../../shared/compute-state";
import {
  COMPUTE_PIPELINE_RUN_OUTCOMES,
  ComputePipelineCoverageResponseSchema,
  ComputePipelineGridResponseSchema,
  ComputePipelineRunDetailResponseSchema,
} from "../../shared/contract/compute-admin";
import { PROGRESS_FORMAT, type Progress } from "../../shared/contract/compute-progress";
import { dispatchPipelineJob, syncPipelineStamps } from "../src/services/compute-pipeline";
import { PIPELINE_GRID_PAGE_SQL } from "../src/services/compute-pipeline-grid";
import {
  PIPELINE_RUN_STATUS_SQL,
  RECONCILE_OUTCOMES,
  recordProgress,
  stampForJob,
} from "../src/services/compute-pipeline-progress";
import type { Bindings } from "../src/types/bindings";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  makeComputeApp,
  seedComputeUsers,
} from "./helpers/compute-app";
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

// biome-ignore lint/suspicious/noExplicitAny: answers are read field by field
type Loose = Record<string, any>;

let fx: LifecycleFixture;
let env: Bindings;
const handle = makeComputeApp();

beforeAll(async () => {
  fx = await startLifecycleFixture();
}, 120_000);

beforeEach(async () => {
  await fx.reset();
  env = fx.env();
  await seedComputeUsers(fx.harness.db);
  await seedPipelinesAccount(env);
  await fundPipelines(env);
});

afterAll(async () => {
  await fx?.dispose();
}, 30_000);

const floor = findRecipe("nemar-floor") as NonNullable<ReturnType<typeof findRecipe>>;
const ENGINE_VERSION = floor.engine.split("@")[1];

async function get(path: string, who: ComputeWho | null = "admin") {
  const headers: Record<string, string> = {};
  if (who) headers.Authorization = `Bearer ${COMPUTE_KEYS[who]}`;
  const res = await handle(new Request(`http://api.test/admin${path}`, { headers }), env);
  const text = await res.text();
  let body: Loose = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, body };
}

const grid = (query = "recipe=nemar-floor") => get(`/compute/pipeline/grid?${query}`);

async function dispatch(datasetId: string) {
  const r = await dispatchPipelineJob(env, {
    recipe: "nemar-floor",
    datasetId,
    actor: { kind: "admin", userId: 1 },
  });
  if (!r.ok) throw new Error(`could not dispatch: ${r.code}`);
  return { jobId: r.jobId, stampId: r.stampId, datasetId };
}

const RECORD = JSON.stringify({
  sj_version: "0.1.0",
  ...JSON.parse(
    recipeRecord({
      recipe: { id: "nemar-floor", version: floor.version },
      engine: { package: "eegprep", version: ENGINE_VERSION },
    }),
  ),
});
const TABLE = floorTable([
  ["sub-01/eeg/a.edf", "succeeded", null, null],
  ["sub-02/eeg/b.edf", "failed", "load_failed", "load"],
  ["sub-03/eeg/c.edf", "failed", "step_failed", "bad_channels"],
  ["sub-04/eeg/d.edf", "succeeded", null, null],
]);
const ALL_PASS = floorTable([
  ["sub-01/eeg/a.edf", "succeeded", null, null],
  ["sub-02/eeg/b.edf", "succeeded", null, null],
]);

/** A dispatched run taken to its end and synced, so it is reconciled. */
async function finished(datasetId: string, table = TABLE) {
  const d = await dispatch(datasetId);
  await finishAtTapis(fx, env, d.jobId, { outputs: floorOutputs(RECORD, table) });
  await syncPipelineStamps(env);
  return d;
}

const liveProgress = (total: number, imported = 1): Progress => ({
  format: PROGRESS_FORMAT,
  checkpoint: "import",
  counts: {
    import: { passed: imported, failed: 0, skipped: 0, total },
    preprocess: { passed: 0, failed: 0, skipped: 0, total },
    quality: { passed: 0, failed: 0, skipped: 0, total },
  },
  failures: [],
});

/** A dispatched run whose job runs at Tapis and has sent one accepted report. */
async function reporting(datasetId: string) {
  const d = await dispatch(datasetId);
  await env.DB.prepare("UPDATE compute_jobs SET state = 'running' WHERE id = ?1")
    .bind(d.jobId)
    .run();
  const lookup = await stampForJob(env.DB, d.jobId);
  if (!lookup.ok) throw new Error(lookup.reason);
  expect(
    await recordProgress(env.DB, {
      jobId: d.jobId,
      stamp: lookup.stamp,
      progress: liveProgress(4),
      reporter: { executor: "tapis" },
    }),
  ).toBe("accepted");
  return d;
}

const rowOf = (body: Loose, id: string) =>
  (body.rows as Loose[]).find((r) => r.dataset_id === id) as Loose;

describe("who may", () => {
  test("an administrator and an owner may read each route, a member and a stranger may not", async () => {
    for (const path of [
      "/compute/pipeline/grid?recipe=nemar-floor",
      "/compute/pipeline/coverage",
      "/compute/pipeline/runs/1",
    ]) {
      expect([path, (await get(path, "member")).status]).toEqual([path, 403]);
      expect([path, (await get(path, null)).status]).toEqual([path, 401]);
      expect([path, [200, 404].includes((await get(path, "admin")).status)]).toEqual([path, true]);
      expect([path, [200, 404].includes((await get(path, "owner")).status)]).toEqual([path, true]);
    }
  });
});

describe("what a row and its cells show", () => {
  test("every eligible dataset is a row, an ineligible one is not; with no run it is not started", async () => {
    await seedEegDataset(env, "nm000104");
    await seedEegDataset(env, "nm000105");
    await seedEegDataset(env, "nm000106", { visibility: "private" });
    const r = await grid();
    expect(r.status).toBe(200);
    expect(ComputePipelineGridResponseSchema.safeParse(r.body).success).toBe(true);
    expect(r.body.rows.map((x: Loose) => x.dataset_id)).toEqual(["nm000104", "nm000105"]);
    const row = rowOf(r.body, "nm000104");
    expect(row.status).toBe("not_started");
    expect(row.run).toBeNull();
    expect(r.body.columns).toEqual(["import", "preprocess", "quality", "stored"]);
    for (const col of r.body.columns) expect(row.cells[col].mark).toBe("not_started");
  });

  test("a dispatched run that never reported waits; a reporting run runs, with its counts and checkpoint", async () => {
    await seedEegDataset(env, "nm000104");
    await seedEegDataset(env, "nm000105");
    await dispatch("nm000104");
    await reporting("nm000105");
    const r = await grid();
    expect(rowOf(r.body, "nm000104").status).toBe("waiting");
    const live = rowOf(r.body, "nm000105");
    expect(live.status).toBe("running");
    expect(live.run.checkpoint).toBe("import");
    expect(live.run.reports).toBe(1);
    expect(live.cells.import.counts).toEqual({ passed: 1, failed: 0, skipped: 0, total: 4 });
    expect(live.cells.import.mark).toBe("running");
    expect(live.cells.stored.mark).toBe("running");
  });

  test("a silent reporting run is stalled, and so is an unreported job", async () => {
    await seedEegDataset(env, "nm000104");
    await seedEegDataset(env, "nm000105");
    const a = await reporting("nm000104");
    const b = await reporting("nm000105");
    await env.DB.prepare(
      "UPDATE compute_pipeline_progress_runs SET reported_at = datetime('now', '-600 seconds') WHERE stamp_id = ?1",
    )
      .bind(a.stampId)
      .run();
    await env.DB.prepare("UPDATE compute_jobs SET state = 'unreported' WHERE id = ?1")
      .bind(b.jobId)
      .run();
    const r = await grid();
    expect(rowOf(r.body, "nm000104").status).toBe("stalled");
    expect(rowOf(r.body, "nm000105").status).toBe("stalled");
  });

  test("a finished run shows its reconciled cells; `stored` waits for the derivative store", async () => {
    await seedEegDataset(env, "nm000104");
    await finished("nm000104");
    const r = await grid();
    const row = rowOf(r.body, "nm000104");
    expect(row.status).toBe("finished");
    expect(row.run.reconciled).toBe(true);
    expect(row.run.outcome).toBe("reconciled");
    expect(row.run.current_version).toBe(true);
    for (const col of ["import", "preprocess", "quality"]) {
      const c = row.cells[col].counts;
      expect(c.passed + c.failed + c.skipped).toBe(c.total);
      expect(row.cells[col].reconciled).toBe(true);
    }
    expect(row.cells.import.mark).toBe("failed");
    expect(row.cells.import.counts).toEqual({ passed: 3, failed: 1, skipped: 0, total: 4 });
    expect(row.cells.preprocess.mark).toBe("failed");
    expect(row.cells.quality.mark).toBe("skipped");
    expect(row.cells.stored.mark).toBe("pending");
    expect(row.cells.import.listed).toBe(1);
  });

  test("a run with every recording passed shows passed cells", async () => {
    await seedEegDataset(env, "nm000104");
    await finished("nm000104", ALL_PASS);
    const row = rowOf((await grid()).body, "nm000104");
    for (const col of ["import", "preprocess", "quality"])
      expect(row.cells[col].mark).toBe("passed");
  });

  test("a failed job with no table is a failed row whose cells have no counts", async () => {
    await seedEegDataset(env, "nm000104");
    const d = await dispatch("nm000104");
    await env.DB.prepare(
      "UPDATE compute_jobs SET state = 'failed', failure_code = 'runtime_error', ended_at = datetime('now') WHERE id = ?1",
    )
      .bind(d.jobId)
      .run();
    // Before the sync reaches it, the row already shows the job's end; its cells wait.
    const before = rowOf((await grid()).body, "nm000104");
    expect(before.status).toBe("failed");
    expect(before.cells.import.mark).toBe("pending");
    await syncPipelineStamps(env);
    const after = rowOf((await grid()).body, "nm000104");
    expect(after.status).toBe("failed");
    expect(after.run.outcome).toBe("table_missing");
    expect(after.cells.import.mark).toBe("no_counts");
  });

  test("a run that ended with no job is failed and its cells have no counts, not pending forever", async () => {
    await seedEegDataset(env, "nm000104");
    const ins = await env.DB.prepare(
      `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, input, attempt, state, refusal_code)
       VALUES ('nm000104', 'v1.0.0', 'nemar-floor', ?1, ?2, 'bids', 1, 'failed', 'create_failed')`,
    )
      .bind(floor.version, floor.engine)
      .run();
    const row = rowOf((await grid()).body, "nm000104");
    expect(row.status).toBe("failed");
    expect(row.run.job_id).toBeNull();
    for (const col of ["import", "preprocess", "quality", "stored"]) {
      expect([col, row.cells[col].mark]).toEqual([col, "no_counts"]);
    }
    const detail = await get(`/compute/pipeline/runs/${ins.meta.last_row_id}`);
    expect(detail.body.checkpoints.map((c: Loose) => c.mark)).toEqual([
      "no_counts",
      "no_counts",
      "no_counts",
      "no_counts",
    ]);
  });

  test("a hold stamp and a refused stamp are never a row's run", async () => {
    await seedEegDataset(env, "nm000104");
    const d = await finished("nm000104");
    // A hold on the tuple shares the run's job; a refusal has none. Both are newer than the run.
    await env.DB.prepare(
      `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, input, attempt, state, job_id, refusal_code)
       VALUES ('nm000104', 'v1.0.0', 'nemar-floor', '9.9.9', 'eegprep@9', 'bids', 1, 'failed', ?1, 'tuple_mismatch')`,
    )
      .bind(d.jobId)
      .run();
    await env.DB.prepare(
      `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, input, attempt, state, refusal_code)
       VALUES ('nm000104', 'v1.0.0', 'nemar-floor', ?1, ?2, 'bids', 2, 'refused', 'over_concurrency')`,
    )
      .bind(floor.version, floor.engine)
      .run();
    const row = rowOf((await grid()).body, "nm000104");
    expect(row.run.stamp_id).toBe(d.stampId);
    expect(row.status).toBe("finished");
  });

  test("the totals cover the whole filtered set and equal the rows", async () => {
    for (const id of ["nm000104", "nm000105", "nm000106"]) await seedEegDataset(env, id);
    await finished("nm000104");
    await reporting("nm000105");
    const r = await grid("recipe=nemar-floor&limit=1");
    expect(r.body.rows.length).toBe(1);
    expect(r.body.matched.total).toBe(3);
    expect(r.body.matched.by_status).toEqual({
      not_started: 1,
      waiting: 0,
      running: 1,
      stalled: 0,
      finished: 1,
      failed: 0,
    });
    expect(r.body.summary.by_status).toEqual(r.body.matched.by_status);
    expect(r.body.summary.eligible).toBe(3);
  });
});

describe("filters and paging", () => {
  test("status and dataset filter the rows; a run filter drops datasets with no matching run", async () => {
    for (const id of ["nm000104", "nm000105", "nm000106"]) await seedEegDataset(env, id);
    await finished("nm000104");
    const live = await reporting("nm000105");
    await env.DB.prepare(
      "UPDATE compute_pipeline_progress_runs SET reported_at = datetime('now', '-600 seconds') WHERE stamp_id = ?1",
    )
      .bind(live.stampId)
      .run();
    const stalled = await grid("recipe=nemar-floor&status=stalled");
    expect(stalled.body.rows.map((x: Loose) => x.dataset_id)).toEqual(["nm000105"]);
    expect(stalled.body.matched.total).toBe(1);
    const one = await grid("recipe=nemar-floor&dataset=nm000106");
    expect(one.body.rows.map((x: Loose) => x.dataset_id)).toEqual(["nm000106"]);
    const version = await grid(`recipe=nemar-floor&recipe_version=${floor.version}`);
    expect(version.body.rows.map((x: Loose) => x.dataset_id)).toEqual(["nm000104", "nm000105"]);
    const other = await grid("recipe=nemar-floor&recipe_version=9.9.9");
    expect(other.body.rows).toEqual([]);
    const tapis = await grid("recipe=nemar-floor&executor=tapis");
    expect(tapis.body.rows.map((x: Loose) => x.dataset_id)).toEqual(["nm000104", "nm000105"]);
    expect((await grid("recipe=nemar-floor&executor=runner")).body.rows).toEqual([]);
    expect(version.body.facets.recipe_versions).toEqual([floor.version]);
  });

  test("a runner filter chooses the runner's run, and the runner is a facet", async () => {
    await seedEegDataset(env, "nm000104");
    const d = await reporting("nm000104");
    const runner = `rnr_${"ab".repeat(12)}`;
    await env.DB.prepare(
      `INSERT INTO compute_runners (id, name, pool, cores, memory_mb, gpus, scratch_gb, backend, runtimes, arch,
         accounting, site, trust, secret_hash, registered_by)
       VALUES (?1, 'ws_b', 'cpu', 8, 16000, 0, 100, 'local', '["docker"]', 'amd64', 'none', 'sccn', 'lab', ?2, 1)`,
    )
      .bind(runner, "c".repeat(64))
      .run();
    await env.DB.prepare(
      "UPDATE compute_jobs SET executor = 'runner', accounting = 'none', runner_id = ?2 WHERE id = ?1",
    )
      .bind(d.jobId, runner)
      .run();
    const mine = await grid(`recipe=nemar-floor&runner=${runner}`);
    expect(mine.body.rows.map((x: Loose) => x.run.runner_name)).toEqual(["ws_b"]);
    expect(mine.body.facets.runners).toEqual([{ id: runner, name: "ws_b" }]);
    expect((await grid(`recipe=nemar-floor&runner=rnr_${"cd".repeat(12)}`)).body.rows).toEqual([]);
    const refused = await grid(`recipe=nemar-floor&executor=tapis&runner=${runner}`);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("runner");
  });

  test("a page walks every row once, in id order", async () => {
    const ids = ["nm000104", "nm000105", "nm000106", "nm000107", "nm000108"];
    for (const id of ids) await seedEegDataset(env, id);
    const seen: string[] = [];
    let after: string | null = null;
    for (let i = 0; i < 5; i++) {
      const r = await grid(`recipe=nemar-floor&limit=2${after ? `&after=${after}` : ""}`);
      seen.push(...r.body.rows.map((x: Loose) => x.dataset_id));
      after = r.body.next_after;
      if (after === null) break;
    }
    expect(seen).toEqual(ids);
  });

  test("a bad query names the field and echoes nothing; an unknown recipe is recipe_unknown", async () => {
    for (const [query, field] of [
      ["", "recipe"],
      ["recipe=nemar-floor&limit=501", "limit"],
      ["recipe=nemar-floor&status=sleeping", "status"],
      ["recipe=nemar-floor&executor=moon", "executor"],
      ["recipe=nemar-floor&runner=rnr_x", "runner"],
      ["recipe=nemar-floor&after=EVIL<script>", "after"],
      ["recipe=nemar-floor&recipe_version=a/b", "recipe_version"],
    ]) {
      const r = await grid(query);
      expect([query, r.status, r.body.code]).toEqual([query, 400, "invalid_query"]);
      expect(r.body.error).toContain(field);
      expect(r.text).not.toContain("EVIL");
      expect(r.text).not.toContain("sleeping");
    }
    const unknown = await grid("recipe=no-such-recipe");
    expect([unknown.status, unknown.body.code]).toEqual([422, "recipe_unknown"]);
    expect((await get("/compute/pipeline/coverage?days=91")).status).toBe(400);
    expect((await get("/compute/pipeline/runs/0")).status).toBe(400);
    expect((await get("/compute/pipeline/runs/abc")).status).toBe(400);
  });
});

describe("read only unless asked", () => {
  test("the grid writes nothing by default; sync=1 brings the open stamps up to date", async () => {
    await seedEegDataset(env, "nm000104");
    const d = await dispatch("nm000104");
    await finishAtTapis(fx, env, d.jobId, { outputs: floorOutputs(RECORD, TABLE) });
    const snapshot = async () =>
      JSON.stringify(
        await env.DB.prepare(
          `SELECT (SELECT json_group_array(json_object('s', state, 'u', updated_at)) FROM compute_pipeline_stamps) AS stamps,
                  (SELECT COUNT(*) FROM compute_pipeline_progress_runs) AS runs,
                  (SELECT COUNT(*) FROM compute_pipeline_progress) AS rows`,
        ).first(),
      );
    const before = await snapshot();
    await grid();
    await get("/compute/pipeline/coverage");
    await get(`/compute/pipeline/runs/${d.stampId}`);
    expect(await snapshot()).toBe(before);
    const synced = await grid("recipe=nemar-floor&sync=1");
    expect(rowOf(synced.body, "nm000104").run.stamp_state).toBe("succeeded");
    expect(await snapshot()).not.toBe(before);
  });
});

describe("the statements", () => {
  test("the page finds a row's run by index, never by scanning the stamps", () => {
    const plan = fx.harness.db
      .query(`EXPLAIN QUERY PLAN ${PIPELINE_GRID_PAGE_SQL}`)
      .all("nemar-floor", null, null, null, null, 0, null, null, 101) as { detail: string }[];
    const details = plan.map((p) => p.detail);
    expect(details.some((d) => /SCAN (x|s|compute_pipeline_stamps)\b/.test(d))).toBe(false);
    expect(details.some((d) => d.includes("compute_pipeline_stamps_attempt"))).toBe(true);
  });

  test("the outcome words are reconciliation's", () => {
    expect([...COMPUTE_PIPELINE_RUN_OUTCOMES]).toEqual([...RECONCILE_OUTCOMES]);
  });

  test("PIPELINE_RUN_STATUS_SQL equals pipelineRunStatus over every stamp state, job state and report age", () => {
    const db = new Database(":memory:");
    // The stamp, its job and its run row stand alone: one row each, joined on nothing, so every
    // combination (no stamp, no job, no run row) is a row the expression reads, as the grid's LEFT JOINs give it.
    const sql = `SELECT ${PIPELINE_RUN_STATUS_SQL} AS status
      FROM (SELECT 1 AS one) x
      LEFT JOIN (SELECT ?1 AS id, ?2 AS state) s ON ?1 IS NOT NULL
      LEFT JOIN (SELECT ?3 AS state) j ON ?3 IS NOT NULL
      LEFT JOIN (SELECT CASE WHEN ?4 IS NULL THEN NULL
                   ELSE datetime('now', '-' || ?4 || ' seconds') END AS reported_at) r ON 1`;
    const stmt = db.prepare(sql);
    let checked = 0;
    const jobs: (ComputeState | null)[] = [null, ...COMPUTE_STATES];
    for (const stampState of [null, ...PIPELINE_STAMP_STATES]) {
      for (const jobState of jobs) {
        for (const age of [null, 60, 600]) {
          const got = (
            stmt.get(stampState === null ? null : 7, stampState, jobState, age) as {
              status: string;
            }
          ).status;
          const now = Math.floor(Date.now() / 1000);
          const want =
            stampState === null
              ? "not_started"
              : pipelineRunStatus({
                  stampState,
                  jobState,
                  reportedAt: age === null ? null : now - age,
                  now,
                });
          expect([stampState, jobState, age, got]).toEqual([stampState, jobState, age, want]);
          checked++;
        }
      }
    }
    expect(checked).toBe((PIPELINE_STAMP_STATES.length + 1) * jobs.length * 3);
    db.close();
  });
});

describe("the drill-down", () => {
  test("a reconciled run lists its failures per checkpoint, with what the list leaves out", async () => {
    await seedEegDataset(env, "nm000104");
    const d = await finished("nm000104");
    const r = await get(`/compute/pipeline/runs/${d.stampId}`);
    expect(r.status).toBe(200);
    expect(ComputePipelineRunDetailResponseSchema.safeParse(r.body).success).toBe(true);
    expect(r.body.status).toBe("finished");
    const byName = Object.fromEntries(r.body.checkpoints.map((c: Loose) => [c.checkpoint, c]));
    expect(r.body.checkpoints.map((c: Loose) => c.checkpoint)).toEqual([
      "import",
      "preprocess",
      "quality",
      "stored",
    ]);
    expect(byName.import.failures).toEqual([
      { path: "sub-02/eeg/b.edf", code: "load_failed", step: "load" },
    ]);
    expect(byName.import.unlisted).toBe(0);
    expect(byName.preprocess.failures.map((f: Loose) => f.code)).toEqual(["step_failed"]);
    expect(byName.preprocess.unlisted).toBe(0);
    // Two recordings are skipped at quality, but both stopped earlier and are listed there: none is
    // quality's to list, so none is unlisted here (MUTATION: count every failed and skipped recording).
    expect(byName.quality.counts.skipped).toBe(2);
    expect(byName.quality.unlisted).toBe(0);
    expect(byName.stored.mark).toBe("pending");
    expect(r.body.listed_codes).toEqual([
      { checkpoint: "import", code: "load_failed", count: 1 },
      { checkpoint: "preprocess", code: "step_failed", count: 1 },
    ]);
  });

  test("a checkpoint with more failures than its list holds says how many it leaves out", async () => {
    await seedEegDataset(env, "nm000104");
    const many = floorTable([
      ...Array.from({ length: 12 }, (_, i) => [
        `sub-${String(i + 1).padStart(2, "0")}/eeg/x.edf`,
        "failed",
        "load_failed",
        "load",
      ]),
      ["sub-20/eeg/y.edf", "failed", "step_failed", "bad_channels"],
      ["sub-21/eeg/z.edf", "succeeded", null, null],
    ] as Parameters<typeof floorTable>[0]);
    const d = await finished("nm000104", many);
    const r = await get(`/compute/pipeline/runs/${d.stampId}`);
    const byName = Object.fromEntries(r.body.checkpoints.map((c: Loose) => [c.checkpoint, c]));
    expect([byName.import.listed, byName.import.unlisted]).toEqual([10, 2]);
    expect([byName.preprocess.listed, byName.preprocess.unlisted]).toEqual([1, 0]);
    expect([byName.quality.listed, byName.quality.unlisted]).toEqual([0, 0]);
  });

  test("a pending stored row never reads as unlisted failures, whatever its counts (MUTATION: drop the stored guard)", async () => {
    await seedEegDataset(env, "nm000104");
    const d = await finished("nm000104");
    // A pending `stored` row that says more were skipped than stopped before it: without the guard its
    // excess would read as recordings `stored` leaves out.
    await env.DB.prepare(
      "UPDATE compute_pipeline_progress SET passed = 0, failed = 0, skipped = total, reconciled = 0 WHERE stamp_id = ?1 AND checkpoint = 'stored'",
    )
      .bind(d.stampId)
      .run();
    const r = await get(`/compute/pipeline/runs/${d.stampId}`);
    const stored = r.body.checkpoints.find((c: Loose) => c.checkpoint === "stored");
    expect(stored.counts.skipped).toBe(4);
    expect(stored.reconciled).toBe(false);
    expect(stored.unlisted).toBe(0);
  });

  test("a live run counts only the recordings that stopped at each checkpoint, even when one lags (MUTATION: let the running total fall)", async () => {
    await seedEegDataset(env, "nm000104");
    const d = await reporting("nm000104");
    const set = (checkpoint: string, p: number, f: number, s2: number) =>
      env.DB.prepare(
        "UPDATE compute_pipeline_progress SET passed = ?3, failed = ?4, skipped = ?5, total = 6 WHERE stamp_id = ?1 AND checkpoint = ?2",
      )
        .bind(d.stampId, checkpoint, p, f, s2)
        .run();
    // Import has one failure it does not list; preprocess has not caught up yet (its report lags); quality
    // has the one recording skipped since it failed at import.
    await set("import", 2, 1, 0);
    await set("preprocess", 0, 0, 0);
    await set("quality", 0, 0, 1);
    const r = await get(`/compute/pipeline/runs/${d.stampId}`);
    const byName = Object.fromEntries(r.body.checkpoints.map((c: Loose) => [c.checkpoint, c]));
    expect(byName.import.reconciled).toBe(false);
    expect([byName.import.unlisted, byName.preprocess.unlisted, byName.quality.unlisted]).toEqual([
      1, 0, 0,
    ]);
  });

  test("a live run shows its last report; an unreadable list is said, not thrown", async () => {
    await seedEegDataset(env, "nm000104");
    const d = await reporting("nm000104");
    await env.DB.prepare(
      "UPDATE compute_pipeline_progress SET failures = '[x' WHERE stamp_id = ?1 AND checkpoint = 'import'",
    )
      .bind(d.stampId)
      .run();
    const r = await get(`/compute/pipeline/runs/${d.stampId}`);
    expect(r.status).toBe(200);
    const imp = r.body.checkpoints.find((c: Loose) => c.checkpoint === "import");
    expect(imp.live).toEqual({ passed: 1, failed: 0, skipped: 0, total: 4 });
    expect(imp.failures_unreadable).toBe(true);
    expect(imp.failures).toEqual([]);
    // The grid still answers: an unreadable list counts as none listed, not an error.
    const row = rowOf((await grid()).body, "nm000104");
    expect(row.cells.import.listed).toBe(0);
  });

  test("a stamp that does not exist is 404 stamp_not_found", async () => {
    const r = await get("/compute/pipeline/runs/999999");
    expect([r.status, r.body.code]).toEqual([404, "stamp_not_found"]);
  });
});

describe("coverage", () => {
  test("covered, complete and covered at any recipe version; a newer dataset version uncovers", async () => {
    for (const id of ["nm000104", "nm000105", "nm000106"]) await seedEegDataset(env, id);
    await finished("nm000104", ALL_PASS);
    await finished("nm000105", TABLE);
    const card = async () => {
      const r = await get("/compute/pipeline/coverage");
      expect(ComputePipelineCoverageResponseSchema.safeParse(r.body).success).toBe(true);
      return r.body.recipes.find((x: Loose) => x.recipe === "nemar-floor") as Loose;
    };
    const a = await card();
    expect([a.eligible, a.covered, a.complete, a.covered_any_version]).toEqual([3, 2, 1, 2]);
    // An older recipe version covers only "at any version".
    await env.DB.prepare(
      "UPDATE compute_pipeline_stamps SET recipe_version = '0.9.0' WHERE dataset_id = 'nm000105'",
    ).run();
    const b = await card();
    expect([b.covered, b.covered_any_version]).toEqual([1, 2]);
    // A newer dataset version is not covered by a run at the old one.
    await env.DB.prepare(
      "INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at) VALUES ('nm000104', '1.0.1', '10.82901/nemar.nm000104.v1.0.1', 'ezid', '2026-03-03 03:04:05')",
    ).run();
    const c = await card();
    expect([c.covered, c.complete, c.covered_any_version]).toEqual([0, 0, 1]);
  });

  test("the trend is one zero-filled point per day, failed runs out of all that ended; holds are not runs", async () => {
    for (const id of ["nm000104", "nm000105", "nm000106"]) await seedEegDataset(env, id);
    const a = await finished("nm000104");
    const b = await finished("nm000105");
    await env.DB.prepare(
      "UPDATE compute_pipeline_stamps SET state = 'failed', refusal_code = 'runtime_error', updated_at = datetime('now', '-2 days') WHERE id = ?1",
    )
      .bind(b.stampId)
      .run();
    await env.DB.prepare(
      `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, input, attempt, state, job_id, refusal_code)
       VALUES ('nm000104', 'v1.0.0', 'nemar-floor', '9.9.9', 'eegprep@9', 'bids', 1, 'failed', ?1, 'tuple_mismatch')`,
    )
      .bind(a.jobId)
      .run();
    const r = await get("/compute/pipeline/coverage?days=7");
    const card = r.body.recipes.find((x: Loose) => x.recipe === "nemar-floor") as Loose;
    expect(card.trend.length).toBe(7);
    const today = card.trend[6];
    const twoAgo = card.trend[4];
    expect([today.value, today.total]).toEqual([0, 1]);
    expect([twoAgo.value, twoAgo.total]).toEqual([1, 1]);
    expect(card.trend.reduce((n: number, p: Loose) => n + p.total, 0)).toBe(2);
    const dates = card.trend.map((p: Loose) => p.at);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(7);
    expect(r.body.days).toBe(7);
    expect((await get("/compute/pipeline/coverage")).body.recipes[0].trend.length).toBe(30);
  });
});
