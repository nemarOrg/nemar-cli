/**
 * The daily dispatcher of NEMAR's own pipelines (epic #2005 phase A6, #2011; ADR 0118; design section 10):
 * once a day, in production only, and only after the owner has turned two switches on, dispatch the
 * automatic recipes over the datasets they have not been run over, within the owner's caps.
 *
 * DARK BY DEFAULT, THREE TIMES OVER. It returns null outside exact production before it reads or writes
 * anything (the development database shares real users); it does nothing while
 * `COMPUTE_PIPELINES_DISPATCH_ENABLED` is not exactly `"1"` or compute is off (`computePipelinesDispatchEnabled`,
 * which reads both), touching no table; and it is wired only into the production-only daily block of
 * `scheduled()`, absent from `DEV_CRON_ALLOWLIST`. The two switches are absent from every table of
 * `backend/wrangler-sccn.toml`; the owner adds them in a reviewed change (`compute-switches-flag.test.ts`).
 *
 * WHAT IT DISPATCHES. Only recipes whose registry entry says `autoDispatch` (the service refuses a cron
 * that asks for another). For each, the eligible datasets whose newest version holds no live or succeeded
 * stamp for the recipe's tuple, through `dispatchPipelineJob`, so every dataset is decided again from its
 * own row. The stamps are synced first.
 *
 * THE CAPS, all the owner's, read from the policy on every run:
 *  - `policy.pipelines.dailyJobCap` minus the pipeline jobs already made today (UTC), across all recipes;
 *  - `policy.pipelines.maxLiveJobs` per pool, minus the pipeline jobs live in that pool, so a recipe never
 *    takes more of the cluster than the owner allows;
 *  - {@link CRON_DISPATCH_PER_TICK}, a bound of this file's own on one tick (below).
 * A refused hold stops the run for that pool: the next recipe of the same pool is not asked, because it
 * would be refused for the same reason. A refusal that would repeat for every pool (the switch off, no
 * image, no account) stops the run.
 *
 * REGISTRY DRIFT. A recipe whose recent success carries a version or an engine other than the registry's
 * (the stamp is rewritten from the recipe's own record) is a registry out of date: dispatching it again
 * would run the same dataset over and over, each run stamped with the version the table does not name. It
 * is not dispatched until the table is fixed, and the result says so.
 *
 * COST. The daily tick shares one subrequest allowance with every daily job. One dispatch is about 25
 * statements and calls (the dataset and version reads, the claim, the job's batch and records, the submit),
 * counting every D1 and R2 binding call as a subrequest although whether they count is UNVERIFIED, and a
 * sync costs about 4 per open stamp, at most 50. So a tick dispatches at most 10 jobs, about 250, whatever the
 * owner's daily cap says; the cap is a ceiling, and the pilot of twenty datasets takes two days. Raising
 * the bound needs a measurement first.
 *
 * NO MAIL, NO GITHUB. Nothing here imports a mail service or reaches GitHub; the only network is Tapis,
 * through the gateway's own submit.
 */

import { COMPUTE_RECIPES, type ComputeRecipe } from "../../../shared/compute-recipes.js";
import { PARTITIONS, type PartitionName } from "../../../shared/contract/compute.js";
import type { Bindings } from "../types/bindings.js";
import { LIVE_STATES_SQL } from "./compute-jobs.js";
import {
  type PipelineRefusal,
  type SyncResult,
  dispatchEligible,
  syncPipelineStamps,
} from "./compute-pipeline.js";
import { ComputePolicyUnreadable, getPolicy } from "./compute-policy.js";
import { computePipelinesDispatchEnabled } from "./compute-switches.js";
import { isExactProduction } from "./repull-switches.js";

/** The most jobs one daily tick dispatches, whatever the owner's daily cap says: see COST above. */
export const CRON_DISPATCH_PER_TICK = 10;

/** How far back a success with another version or engine counts as the registry being out of date. */
export const DRIFT_WINDOW_DAYS = 7;

/** The refusals that would repeat for every recipe and every pool: they end the run. */
const ENDS_THE_RUN: ReadonlySet<PipelineRefusal> = new Set<PipelineRefusal>([
  "compute_disabled",
  "runtime_unavailable",
  "pipelines_account_missing",
]);

export type RecipeSkip = "daily_cap" | "live_cap" | "pool_refused" | "registry_drift" | "run_ended";

export interface RecipeOutcome {
  recipe: string;
  dispatched: number;
  /** Why nothing (or less than the room) was dispatched, as a fixed word. */
  skipped: RecipeSkip | null;
  /** The refusal that stopped this recipe's run, if one did. */
  stopped_by: string | null;
}

export interface PipelineCronResult {
  /** `off`: a switch is off and nothing was read; `ran`: the dispatcher examined its recipes. */
  outcome: "off" | "ran";
  synced: SyncResult | null;
  /** Pipeline jobs made today before this run. */
  today: number;
  dispatched: number;
  recipes: RecipeOutcome[];
  /** Fixed words; never a message. */
  errors: string[];
}

const emptyResult = (outcome: PipelineCronResult["outcome"]): PipelineCronResult => ({
  outcome,
  synced: null,
  today: 0,
  dispatched: 0,
  recipes: [],
  errors: [],
});

/** Pipeline jobs made today (UTC): `created_at` is `datetime('now')`, so a day starts at `date('now')`. */
export const PIPELINE_JOBS_TODAY_SQL = `SELECT COUNT(*) AS n FROM compute_jobs
  WHERE source = 'pipeline' AND created_at >= date('now')`;

/** Pipeline jobs live in a pool (`?1`). */
export const PIPELINE_JOBS_LIVE_SQL = `SELECT COUNT(*) AS n FROM compute_jobs
  WHERE source = 'pipeline' AND pool = ?1 AND state IN (${LIVE_STATES_SQL})`;

/** A recent success whose version (`?2`) or engine (`?3`) is not the registry's, for a recipe (`?1`). */
export const REGISTRY_DRIFT_SQL = `SELECT 1 FROM compute_pipeline_stamps
  WHERE recipe = ?1 AND state = 'succeeded' AND (recipe_version <> ?2 OR engine <> ?3)
    AND updated_at >= datetime('now', ?4) LIMIT 1`;

const count = async (db: D1Database, sql: string, ...binds: unknown[]): Promise<number> =>
  (
    await db
      .prepare(sql)
      .bind(...binds)
      .first<{ n: number }>()
  )?.n ?? 0;

const poolOf = (recipe: ComputeRecipe) => PARTITIONS[recipe.partition as PartitionName].pool;

/**
 * One daily run. Null outside exact production, before anything is read or written. In production with
 * either switch off it returns `{ outcome: "off" }` and has touched nothing. Otherwise it syncs the
 * stamps and dispatches within the caps. It never throws: a failure is a fixed word in `errors`.
 */
export async function runComputePipelineDispatchCron(
  env: Bindings,
): Promise<PipelineCronResult | null> {
  if (!isExactProduction(env)) return null;
  if (!computePipelinesDispatchEnabled(env)) return emptyResult("off");

  const result = emptyResult("ran");
  const db = env.DB;
  try {
    result.synced = await syncPipelineStamps(env);
    const policy = (await getPolicy(db)).policy;
    result.today = await count(db, PIPELINE_JOBS_TODAY_SQL);
    let dailyLeft = Math.max(0, policy.pipelines.dailyJobCap - result.today);
    let tickLeft = CRON_DISPATCH_PER_TICK;
    const refusedPools = new Set<string>();
    let ended = false;

    for (const recipe of COMPUTE_RECIPES) {
      if (!recipe.autoDispatch) continue;
      const outcome: RecipeOutcome = {
        recipe: recipe.name,
        dispatched: 0,
        skipped: null,
        stopped_by: null,
      };
      result.recipes.push(outcome);
      const pool = poolOf(recipe);
      if (ended) {
        outcome.skipped = "run_ended";
        continue;
      }
      if (refusedPools.has(pool)) {
        outcome.skipped = "pool_refused";
        continue;
      }
      const drifted = await db
        .prepare(REGISTRY_DRIFT_SQL)
        .bind(recipe.name, recipe.version, recipe.engine, `-${DRIFT_WINDOW_DAYS} days`)
        .first();
      if (drifted) {
        outcome.skipped = "registry_drift";
        continue;
      }
      if (dailyLeft <= 0) {
        outcome.skipped = "daily_cap";
        continue;
      }
      const live = await count(db, PIPELINE_JOBS_LIVE_SQL, pool);
      const liveLeft = Math.max(0, policy.pipelines.maxLiveJobs[pool] - live);
      if (liveLeft <= 0) {
        outcome.skipped = "live_cap";
        continue;
      }
      const room = Math.min(dailyLeft, liveLeft, tickLeft);
      if (room <= 0) continue;

      const run = await dispatchEligible(env, {
        recipe: recipe.name,
        limit: room,
        actor: { kind: "cron" },
      });
      outcome.dispatched = run.dispatched;
      outcome.stopped_by = run.stoppedBy;
      result.dispatched += run.dispatched;
      dailyLeft -= run.dispatched;
      tickLeft -= run.dispatched;
      if (run.stoppedBy !== null) {
        if (ENDS_THE_RUN.has(run.stoppedBy)) ended = true;
        else refusedPools.add(pool);
      }
    }
  } catch (err) {
    result.errors.push(err instanceof ComputePolicyUnreadable ? "policy_unreadable" : "run_failed");
    console.error(
      `[compute-pipeline-dispatch] failed error=${err instanceof Error ? err.name : typeof err}`,
    );
  }
  return result;
}

/**
 * The one log line of a run, or null when it did nothing worth a line (off, or ran and dispatched,
 * skipped and failed nothing). Counts and fixed words: no dataset id, job id, name or path.
 */
export function pipelineDispatchLogLine(
  r: PipelineCronResult,
): { level: "info" | "warn" | "error"; line: string } | null {
  if (r.outcome === "off") return null;
  const skipped = r.recipes.filter((x) => x.skipped !== null || x.stopped_by !== null);
  if (r.dispatched === 0 && r.errors.length === 0 && skipped.length === 0) return null;
  const parts = [
    `dispatched=${r.dispatched}`,
    `today=${r.today}`,
    ...(r.synced
      ? [`synced_succeeded=${r.synced.succeeded}`, `synced_failed=${r.synced.failed}`]
      : []),
    ...r.recipes.flatMap((x) => [
      ...(x.skipped ? [`${x.recipe}_skipped=${x.skipped}`] : []),
      ...(x.stopped_by ? [`${x.recipe}_stopped_by=${x.stopped_by}`] : []),
    ]),
    ...(r.errors.length > 0 ? [`errors=${r.errors.join(",")}`] : []),
  ];
  const drift = r.recipes.some((x) => x.skipped === "registry_drift");
  const level =
    r.errors.length > 0 ? "error" : drift || r.recipes.some((x) => x.stopped_by) ? "warn" : "info";
  return { level, line: `[compute-pipeline-dispatch] ${parts.join(" ")}` };
}
