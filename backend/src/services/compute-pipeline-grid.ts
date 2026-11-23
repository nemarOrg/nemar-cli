/**
 * The admin pipeline grid (ADR 0134 decision 5, epic #2324 phase 4a): datasets as rows, checkpoints as
 * columns, each cell `passed/total` with a mark, like the legacy `pipeline_status_all.csv`; a coverage card
 * per recipe with a daily failure trend; and the drill-down of one run to the failures its checkpoints list.
 *
 * Read only. Nothing here writes, syncs, reconciles or reads R2: a caller that wants the stamps brought up
 * to date first calls `syncPipelineStamps` (the route does so only when asked). What a run shows is worked
 * out in SQL by `PIPELINE_RUN_STATUS_SQL` (equal to `pipelineRunStatus`), so it can be filtered, paged and
 * counted; what a cell shows is `pipelineCellMark`.
 *
 * Which datasets: the ones the environment's eligibility predicate lets through (`pipelineEligibleSql`); a
 * dataset that left eligibility is not shown. Which run: the newest stamp of the recipe for the dataset, at
 * any of its versions, never a `refused` stamp (the pool's word, not the dataset's) and never a
 * `tuple_mismatch` hold stamp (`NOT_HOLD_STAMP_SQL`). A run filter (recipe version, executor, runner)
 * chooses the newest run that matches, and drops the datasets that have none.
 *
 * No identity: no column of `users` is read, and a runner is named by its id and its fixed name.
 */

import { z } from "zod";
import {
  PIPELINE_STALLED_SECONDS,
  type PipelineGridStatus,
  pipelineCellMark,
} from "../../../shared/compute-checkpoints.js";
import {
  COMPUTE_RECIPES,
  type ComputeRecipe,
  STANDARD_CHECKPOINTS,
  STORED_CHECKPOINT,
  declaredCheckpoints,
} from "../../../shared/compute-recipes.js";
import {
  COMPUTE_PIPELINE_GRID_STATUSES,
  type ComputePipelineCell,
  type ComputePipelineCoverageResponse,
  type ComputePipelineGridResponse,
  type ComputePipelineGridRow,
  type ComputePipelineRecipeSummary,
  type ComputePipelineRunDetailResponse,
  type ComputePipelineRunView,
} from "../../../shared/contract/compute-admin.js";
import {
  PROGRESS_MAX_FAILURES,
  ProgressFailureSchema,
} from "../../../shared/contract/compute-progress.js";
import type { Bindings } from "../types/bindings.js";
import {
  NEWEST_VERSION_SQL,
  PIPELINE_ELIGIBLE_SQL,
  PIPELINE_ELIGIBLE_SQL_NONPROD,
  VERSION_TAG_SQL,
} from "./compute-pipeline-eligibility.js";
import { NOT_HOLD_STAMP_SQL, PIPELINE_RUN_STATUS_SQL } from "./compute-pipeline-progress.js";
import { isNonProductionEnv } from "./environment.js";

// --- The statements ----------------------------------------------------------------------------------------

/**
 * The newest stamp of the recipe for the dataset `d`, as the row's run: `?1` recipe, `?3` recipe version,
 * `?4` executor, `?5` runner (each null for any). Never `refused`, never a hold.
 */
const NEWEST_STAMP_SQL = `SELECT x.id FROM compute_pipeline_stamps x
     WHERE x.dataset_id = d.dataset_id AND x.recipe = ?1 AND x.state <> 'refused'
       AND ${NOT_HOLD_STAMP_SQL("x")}
       AND (?3 IS NULL OR x.recipe_version = ?3)
       AND (?4 IS NULL OR EXISTS (SELECT 1 FROM compute_jobs xj WHERE xj.id = x.job_id AND xj.executor = ?4))
       AND (?5 IS NULL OR EXISTS (SELECT 1 FROM compute_jobs xj WHERE xj.id = x.job_id AND xj.runner_id = ?5))
     ORDER BY x.id DESC LIMIT 1`;

/**
 * Every eligible dataset with its run, over a predicate: `?1` recipe, `?2` dataset (null for all), `?3` to
 * `?5` the run filters. The status is `PIPELINE_RUN_STATUS_SQL`'s.
 */
const gridSql = (eligible: string): string => `SELECT d.dataset_id AS dataset_id,
       (${NEWEST_VERSION_SQL("d")}) AS newest_version,
       s.id AS stamp_id, s.version AS version, s.recipe_version AS recipe_version, s.engine AS engine,
       s.input AS input, s.attempt AS attempt, s.state AS stamp_state, s.refusal_code AS code,
       s.job_id AS job_id, s.created_at AS created_at, s.updated_at AS updated_at,
       CASE WHEN s.id IS NULL THEN NULL
            WHEN s.version = ${VERSION_TAG_SQL(`(${NEWEST_VERSION_SQL("d")})`)} THEN 1 ELSE 0 END
         AS current_version,
       j.state AS job_state, j.executor AS executor, j.runner_id AS runner_id, rn.name AS runner_name,
       r.checkpoint AS checkpoint, r.reported_at AS reported_at, r.reports AS reports,
       r.reconciled_at AS reconciled_at, r.outcome AS outcome, r.disagreement AS disagreement,
       ${PIPELINE_RUN_STATUS_SQL} AS status
  FROM datasets d
  LEFT JOIN compute_pipeline_stamps s ON s.id = (${NEWEST_STAMP_SQL})
  LEFT JOIN compute_jobs j ON j.id = s.job_id
  LEFT JOIN compute_runners rn ON rn.id = j.runner_id
  LEFT JOIN compute_pipeline_progress_runs r ON r.stamp_id = s.id
 WHERE ${eligible}
   AND (?2 IS NULL OR d.dataset_id = ?2)`;

/** `?6` 1 when a run filter is set (a dataset with no matching run is dropped), `?7` a status. */
const FILTERED = "(?6 = 0 OR g.stamp_id IS NOT NULL) AND (?7 IS NULL OR g.status = ?7)";

/** A page of the grid: `?8` the cursor (a dataset id, null for the first page), `?9` rows + 1. */
const pageSql = (eligible: string): string => `SELECT * FROM (${gridSql(eligible)}) g
 WHERE ${FILTERED} AND (?8 IS NULL OR g.dataset_id > ?8)
 ORDER BY g.dataset_id LIMIT ?9`;

/** The count of the filtered set by status. */
const totalsSql = (eligible: string): string => `SELECT g.status AS status, COUNT(*) AS n
  FROM (${gridSql(eligible)}) g WHERE ${FILTERED} GROUP BY g.status`;

/**
 * A recipe's coverage over the eligible datasets: `?1` recipe, `?2` the registry's recipe version, `?3`
 * the recipe's last declared checkpoint (`complete` is every recording passed there).
 */
const coverageSql = (eligible: string): string => `SELECT
    COUNT(*) AS eligible,
    COALESCE(SUM(EXISTS (SELECT 1 FROM compute_pipeline_stamps c
       WHERE c.dataset_id = d.dataset_id AND c.recipe = ?1 AND c.recipe_version = ?2
         AND c.state = 'succeeded'
         AND c.version = ${VERSION_TAG_SQL(`(${NEWEST_VERSION_SQL("d")})`)})), 0) AS covered,
    COALESCE(SUM(EXISTS (SELECT 1 FROM compute_pipeline_stamps c
       JOIN compute_pipeline_progress p ON p.stamp_id = c.id AND p.checkpoint = ?3
       WHERE c.dataset_id = d.dataset_id AND c.recipe = ?1 AND c.recipe_version = ?2
         AND c.state = 'succeeded'
         AND c.version = ${VERSION_TAG_SQL(`(${NEWEST_VERSION_SQL("d")})`)}
         AND p.reconciled = 1 AND p.total > 0 AND p.passed = p.total)), 0) AS complete,
    COALESCE(SUM(EXISTS (SELECT 1 FROM compute_pipeline_stamps c
       WHERE c.dataset_id = d.dataset_id AND c.recipe = ?1 AND c.state = 'succeeded'
         AND c.version = ${VERSION_TAG_SQL(`(${NEWEST_VERSION_SQL("d")})`)})), 0) AS covered_any_version
  FROM datasets d WHERE ${eligible}`;

interface Statements {
  page: string;
  totals: string;
  coverage: string;
}

/** Built once per predicate at module load, never at call time. */
const STATEMENTS: Readonly<Record<"prod" | "nonprod", Statements>> = {
  prod: {
    page: pageSql(PIPELINE_ELIGIBLE_SQL),
    totals: totalsSql(PIPELINE_ELIGIBLE_SQL),
    coverage: coverageSql(PIPELINE_ELIGIBLE_SQL),
  },
  nonprod: {
    page: pageSql(PIPELINE_ELIGIBLE_SQL_NONPROD),
    totals: totalsSql(PIPELINE_ELIGIBLE_SQL_NONPROD),
    coverage: coverageSql(PIPELINE_ELIGIBLE_SQL_NONPROD),
  },
};

/** The statements an environment runs: the widened predicate only outside production. */
export function gridStatements(env: Pick<Bindings, "ENVIRONMENT">): Statements {
  return isNonProductionEnv(env) ? STATEMENTS.nonprod : STATEMENTS.prod;
}

/** The production page statement, for the query-plan test. */
export const PIPELINE_GRID_PAGE_SQL = STATEMENTS.prod.page;

/** The cells of the page's runs: `?1` a JSON list of stamp ids (one bound value, whatever the page size). */
export const GRID_CELLS_SQL = `SELECT p.stamp_id, p.checkpoint, p.passed, p.failed, p.skipped, p.total,
       p.reconciled, p.disagreement,
       CASE WHEN json_valid(p.failures) THEN json_array_length(p.failures) END AS listed
  FROM compute_pipeline_progress p
 WHERE p.stamp_id IN (SELECT value FROM json_each(?1))`;

/** The recipe versions and the runners the recipe's stamps name, for the filters. */
export const GRID_RECIPE_VERSIONS_SQL = `SELECT DISTINCT recipe_version FROM compute_pipeline_stamps
 WHERE recipe = ?1 ORDER BY recipe_version`;
export const GRID_RUNNERS_SQL = `SELECT DISTINCT rn.id AS id, rn.name AS name
  FROM compute_pipeline_stamps s
  JOIN compute_jobs j ON j.id = s.job_id
  JOIN compute_runners rn ON rn.id = j.runner_id
 WHERE s.recipe = ?1 ORDER BY rn.name, rn.id`;

/**
 * Runs of the recipe that ended, by UTC day of their end (`updated_at`, which is when an ended stamp ended),
 * from `?2` (a date) on: failed and all. Holds and refusals are not runs.
 */
export const TREND_SQL = `SELECT date(s.updated_at) AS day,
       SUM(CASE WHEN s.state = 'failed' THEN 1 ELSE 0 END) AS failed, COUNT(*) AS ended
  FROM compute_pipeline_stamps s
 WHERE s.recipe = ?1 AND s.state IN ('succeeded', 'failed') AND ${NOT_HOLD_STAMP_SQL("s")}
   AND s.updated_at >= ?2
 GROUP BY date(s.updated_at)`;

/** D1's clock: the answer's `as_of` and today's date, so the trend's days are D1's, never the Worker's. */
const CLOCK_SQL = `SELECT datetime('now') AS now, date('now') AS today`;

/** One run with its job, runner and run row, and what it shows; `?1` stamp id. */
export const RUN_DETAIL_SQL = `SELECT s.id AS stamp_id, s.dataset_id AS dataset_id, s.recipe AS recipe,
       s.version AS version, s.recipe_version AS recipe_version, s.engine AS engine, s.input AS input,
       s.attempt AS attempt, s.state AS stamp_state, s.refusal_code AS code, s.job_id AS job_id,
       s.created_at AS created_at, s.updated_at AS updated_at,
       (${NEWEST_VERSION_SQL("s")}) AS newest_version,
       CASE WHEN s.version = ${VERSION_TAG_SQL(`(${NEWEST_VERSION_SQL("s")})`)} THEN 1 ELSE 0 END
         AS current_version,
       j.state AS job_state, j.executor AS executor, j.runner_id AS runner_id, rn.name AS runner_name,
       r.checkpoint AS checkpoint, r.reported_at AS reported_at, r.reports AS reports,
       r.reconciled_at AS reconciled_at, r.outcome AS outcome, r.disagreement AS disagreement,
       r.declared AS declared,
       ${PIPELINE_RUN_STATUS_SQL} AS status
  FROM compute_pipeline_stamps s
  LEFT JOIN compute_jobs j ON j.id = s.job_id
  LEFT JOIN compute_runners rn ON rn.id = j.runner_id
  LEFT JOIN compute_pipeline_progress_runs r ON r.stamp_id = s.id
 WHERE s.id = ?1`;

/** A run's progress rows; `?1` stamp id. */
export const RUN_ROWS_SQL = `SELECT checkpoint, passed, failed, skipped, total, failures, reported_at,
       live_passed, live_failed, live_skipped, live_total, reconciled, disagreement
  FROM compute_pipeline_progress WHERE stamp_id = ?1`;

// --- Reading -----------------------------------------------------------------------------------------------

/** A row of the grid statement. */
interface GridRowRead {
  dataset_id: string;
  newest_version: string | null;
  stamp_id: number | null;
  version: string | null;
  recipe_version: string | null;
  engine: string | null;
  input: string | null;
  attempt: number | null;
  stamp_state: string | null;
  code: string | null;
  job_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  current_version: number | null;
  job_state: string | null;
  executor: string | null;
  runner_id: string | null;
  runner_name: string | null;
  checkpoint: string | null;
  reported_at: string | null;
  reports: number | null;
  reconciled_at: string | null;
  outcome: string | null;
  disagreement: number | null;
  status: PipelineGridStatus;
}

interface CellRead {
  stamp_id: number;
  checkpoint: string;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  reconciled: number;
  disagreement: number;
  listed: number | null;
}

/** What the grid is filtered by. Every value is checked by the route before it is bound. */
export interface GridFilter {
  recipe: ComputeRecipe;
  recipeVersion?: string;
  executor?: string;
  runner?: string;
  status?: PipelineGridStatus;
  dataset?: string;
  after?: string;
  limit: number;
}

/** The run a row shows, as the wire carries it. */
function runView(r: GridRowRead, recipe: string): ComputePipelineRunView | null {
  if (r.stamp_id === null) return null;
  return {
    stamp_id: r.stamp_id,
    dataset_id: r.dataset_id,
    recipe,
    version: r.version ?? "",
    current_version: r.current_version === 1,
    recipe_version: r.recipe_version ?? "",
    engine: r.engine ?? "",
    input: r.input ?? "bids",
    attempt: r.attempt ?? 0,
    stamp_state: r.stamp_state ?? "",
    code: r.code,
    job_id: r.job_id,
    job_state: r.job_state,
    executor: r.executor,
    runner_id: r.runner_id,
    runner_name: r.runner_name,
    checkpoint: r.checkpoint,
    reported_at: r.reported_at,
    reports: r.reports ?? 0,
    reconciled: r.reconciled_at !== null,
    outcome: r.outcome,
    disagreement: r.disagreement === 1,
    created_at: r.created_at ?? "",
    updated_at: r.updated_at ?? "",
  };
}

/** Every grid status with a count, zero when none. */
function zeroFilled(rows: readonly { status: string; n: number }[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(
    COMPUTE_PIPELINE_GRID_STATUSES.map((s) => [s, 0]),
  );
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + r.n;
  return out;
}

/** The columns: the recipe's declared checkpoints, then any other name the cells carry, in standard order. */
export function gridColumns(recipe: ComputeRecipe, seen: Iterable<string>): string[] {
  const declared = declaredCheckpoints(recipe);
  const extra = [...new Set(seen)].filter((c) => !declared.includes(c));
  const rank = (c: string) => {
    const i = (STANDARD_CHECKPOINTS as readonly string[]).indexOf(c);
    return i === -1 ? STANDARD_CHECKPOINTS.length : i;
  };
  extra.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return [...declared, ...extra];
}

/** The recipe's last declared checkpoint before `stored`: where `complete` is read. */
const lastCheckpointOf = (recipe: ComputeRecipe): string | null =>
  recipe.checkpoints[recipe.checkpoints.length - 1]?.checkpoint ?? null;

/** A recipe's coverage, without the trend. `by_status` is the unfiltered grid's. */
export async function recipeSummary(
  env: Pick<Bindings, "DB" | "ENVIRONMENT">,
  recipe: ComputeRecipe,
): Promise<ComputePipelineRecipeSummary> {
  const st = gridStatements(env);
  const [coverage, totals] = await Promise.all([
    env.DB.prepare(st.coverage).bind(recipe.name, recipe.version, lastCheckpointOf(recipe)).first<{
      eligible: number;
      covered: number;
      complete: number;
      covered_any_version: number;
    }>(),
    env.DB.prepare(st.totals)
      .bind(recipe.name, null, null, null, null, 0, null)
      .all<{ status: string; n: number }>(),
  ]);
  return {
    recipe: recipe.name,
    recipe_version: recipe.version,
    placeholder: recipe.placeholder === true,
    auto_dispatch: recipe.autoDispatch,
    columns: declaredCheckpoints(recipe),
    eligible: coverage?.eligible ?? 0,
    covered: coverage?.covered ?? 0,
    complete: coverage?.complete ?? 0,
    covered_any_version: coverage?.covered_any_version ?? 0,
    by_status: zeroFilled(totals.results),
  };
}

/** A page of the grid, its totals over the whole filtered set, the recipe's summary and its facets. */
export async function pipelineGrid(
  env: Pick<Bindings, "DB" | "ENVIRONMENT">,
  filter: GridFilter,
): Promise<ComputePipelineGridResponse> {
  const st = gridStatements(env);
  const recipe = filter.recipe;
  const runFilter =
    filter.recipeVersion !== undefined ||
    filter.executor !== undefined ||
    filter.runner !== undefined
      ? 1
      : 0;
  const common = [
    recipe.name,
    filter.dataset ?? null,
    filter.recipeVersion ?? null,
    filter.executor ?? null,
    filter.runner ?? null,
    runFilter,
    filter.status ?? null,
  ];
  const [clock, page, totals, summary, versions, runners] = await Promise.all([
    env.DB.prepare(CLOCK_SQL).first<{ now: string; today: string }>(),
    env.DB.prepare(st.page)
      .bind(...common, filter.after ?? null, filter.limit + 1)
      .all<GridRowRead>(),
    env.DB.prepare(st.totals)
      .bind(...common)
      .all<{ status: string; n: number }>(),
    recipeSummary(env, recipe),
    env.DB.prepare(GRID_RECIPE_VERSIONS_SQL).bind(recipe.name).all<{ recipe_version: string }>(),
    env.DB.prepare(GRID_RUNNERS_SQL).bind(recipe.name).all<{ id: string; name: string }>(),
  ]);
  const more = page.results.length > filter.limit;
  const rows = more ? page.results.slice(0, filter.limit) : page.results;
  const stampIds = rows.flatMap((r) => (r.stamp_id === null ? [] : [r.stamp_id]));
  const cells =
    stampIds.length === 0
      ? []
      : (await env.DB.prepare(GRID_CELLS_SQL).bind(JSON.stringify(stampIds)).all<CellRead>())
          .results;
  const byStamp = new Map<number, Map<string, CellRead>>();
  for (const c of cells) {
    const m = byStamp.get(c.stamp_id) ?? new Map<string, CellRead>();
    m.set(c.checkpoint, c);
    byStamp.set(c.stamp_id, m);
  }
  const columns = gridColumns(
    recipe,
    cells.map((c) => c.checkpoint),
  );
  const matched = zeroFilled(totals.results);
  return {
    as_of: clock?.now ?? "",
    stalled_after_seconds: PIPELINE_STALLED_SECONDS,
    recipe: recipe.name,
    columns,
    summary,
    matched: { total: Object.values(matched).reduce((a, b) => a + b, 0), by_status: matched },
    facets: {
      recipe_versions: versions.results.map((v) => v.recipe_version),
      runners: runners.results.map((r) => ({ id: r.id, name: r.name })),
    },
    rows: rows.map((r): ComputePipelineGridRow => {
      const mine = r.stamp_id === null ? undefined : byStamp.get(r.stamp_id);
      const runReconciled = r.reconciled_at !== null;
      const rowCells: Record<string, ComputePipelineCell> = {};
      for (const col of columns) {
        const c = mine?.get(col);
        const counts = c
          ? { passed: c.passed, failed: c.failed, skipped: c.skipped, total: c.total }
          : null;
        rowCells[col] = {
          mark: pipelineCellMark({
            status: r.status,
            counts,
            cellReconciled: c?.reconciled === 1,
            runReconciled,
            hasJob: r.job_id !== null,
          }),
          counts,
          reconciled: c?.reconciled === 1,
          disagreement: c?.disagreement === 1,
          listed: c?.listed ?? 0,
        };
      }
      return {
        dataset_id: r.dataset_id,
        newest_version: r.newest_version,
        status: r.status,
        run: runView(r, recipe.name),
        cells: rowCells,
      };
    }),
    next_after: more ? (rows[rows.length - 1]?.dataset_id ?? null) : null,
  };
}

/** The UTC days from `today` back, oldest first, `days` of them (`YYYY-MM-DD`). */
export function trendDays(today: string, days: number): string[] {
  const end = Date.parse(`${today}T00:00:00Z`);
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/** Every registry recipe's coverage, with the daily failure trend over `days` (zero-filled). */
export async function pipelineCoverage(
  env: Pick<Bindings, "DB" | "ENVIRONMENT">,
  days: number,
): Promise<ComputePipelineCoverageResponse> {
  const clock = await env.DB.prepare(CLOCK_SQL).first<{ now: string; today: string }>();
  const today = clock?.today ?? new Date().toISOString().slice(0, 10);
  const span = trendDays(today, days);
  const from = span[0] ?? today;
  const recipes = await Promise.all(
    COMPUTE_RECIPES.map(async (recipe) => {
      const [summary, trend] = await Promise.all([
        recipeSummary(env, recipe),
        env.DB.prepare(TREND_SQL)
          .bind(recipe.name, from)
          .all<{ day: string; failed: number; ended: number }>(),
      ]);
      const byDay = new Map(trend.results.map((t) => [t.day, t]));
      return {
        ...summary,
        trend: span.map((at) => {
          const t = byDay.get(at);
          return { at, value: t?.failed ?? 0, total: t?.ended ?? 0 };
        }),
      };
    }),
  );
  return { as_of: clock?.now ?? "", days, recipes };
}

// --- The drill-down ----------------------------------------------------------------------------------------

const FailureListSchema = z.array(ProgressFailureSchema).max(PROGRESS_MAX_FAILURES);

interface RunDetailRead extends GridRowRead {
  recipe: string;
  declared: string | null;
}

interface RunRowRead {
  checkpoint: string;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  failures: string;
  reported_at: string;
  live_passed: number | null;
  live_failed: number | null;
  live_skipped: number | null;
  live_total: number | null;
  reconciled: number;
  disagreement: number;
}

/** A failure list as stored, or null when it cannot be read (never thrown). */
function readFailures(text: string): z.infer<typeof FailureListSchema> | null {
  try {
    const parsed = FailureListSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The declared order a run recorded, else the registry's for the recipe, else the standard order. */
function declaredOrder(declared: string | null, recipe: string): string[] {
  if (declared !== null) {
    try {
      const list = JSON.parse(declared);
      if (Array.isArray(list) && list.every((x) => typeof x === "string")) return list;
    } catch {
      /* fall through to the registry */
    }
  }
  const entry = COMPUTE_RECIPES.find((r) => r.name === recipe);
  return entry ? declaredCheckpoints(entry) : [...STANDARD_CHECKPOINTS];
}

/** One run's checkpoints and the failures each lists, or null when there is no such stamp. */
export async function pipelineRunDetail(
  db: D1Database,
  stampId: number,
): Promise<ComputePipelineRunDetailResponse | null> {
  const run = await db.prepare(RUN_DETAIL_SQL).bind(stampId).first<RunDetailRead>();
  if (!run) return null;
  const rows = (await db.prepare(RUN_ROWS_SQL).bind(stampId).all<RunRowRead>()).results;
  const byCheckpoint = new Map(rows.map((r) => [r.checkpoint, r]));
  const order = declaredOrder(run.declared, run.recipe);
  for (const r of rows) if (!order.includes(r.checkpoint)) order.push(r.checkpoint);
  const runReconciled = run.reconciled_at !== null;
  const codes = new Map<string, { checkpoint: string; code: string; count: number }>();
  // A recording is counted failed or skipped at its first non-passed checkpoint and skipped at every one
  // after it, so the recordings that FIRST stopped at a checkpoint are its failed and skipped less the
  // previous checkpoint's: those are the ones its list could name, and `unlisted` counts only them.
  let stoppedBefore = 0;
  const checkpoints = order.map((checkpoint) => {
    const r = byCheckpoint.get(checkpoint);
    const counts = r
      ? { passed: r.passed, failed: r.failed, skipped: r.skipped, total: r.total }
      : null;
    const failures = r ? readFailures(r.failures) : [];
    const listed = failures?.length ?? 0;
    for (const f of failures ?? []) {
      const key = `${checkpoint}\u0000${f.code}`;
      const seen = codes.get(key) ?? { checkpoint, code: f.code, count: 0 };
      seen.count++;
      codes.set(key, seen);
    }
    const live =
      r === undefined
        ? null
        : r.reconciled === 1
          ? r.live_total === null
            ? null
            : {
                passed: r.live_passed ?? 0,
                failed: r.live_failed ?? 0,
                skipped: r.live_skipped ?? 0,
                total: r.live_total,
              }
          : counts;
    const stoppedHere =
      counts === null ? 0 : Math.max(0, counts.failed + counts.skipped - stoppedBefore);
    if (counts !== null) stoppedBefore = counts.failed + counts.skipped;
    // An unreconciled `stored` row is the derivative store's pending row, not a list of failures.
    const pendingStored = checkpoint === STORED_CHECKPOINT && r?.reconciled !== 1;
    const unlistedHere = pendingStored ? 0 : Math.max(0, stoppedHere - listed);
    return {
      checkpoint,
      mark: pipelineCellMark({
        status: run.status,
        counts,
        cellReconciled: r?.reconciled === 1,
        runReconciled,
        hasJob: run.job_id !== null,
      }),
      counts,
      live,
      reconciled: r?.reconciled === 1,
      disagreement: r?.disagreement === 1,
      reported_at: r?.reported_at ?? null,
      failures: (failures ?? []).map((f) => ({ path: f.path, code: f.code, step: f.step })),
      listed,
      unlisted: unlistedHere,
      failures_unreadable: r !== undefined && failures === null,
    };
  });
  const view = runView(run, run.recipe) as ComputePipelineRunView;
  return {
    status: run.status,
    newest_version: run.newest_version,
    run: view,
    checkpoints,
    listed_codes: [...codes.values()],
  };
}
