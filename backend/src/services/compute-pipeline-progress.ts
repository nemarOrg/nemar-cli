/**
 * Live progress of NEMAR's pipeline runs (ADR 0134 decisions 3 and 4, epic #2324 phase 2): one write
 * path for a report, shared by the runner heartbeat and the job-token route of a job on the supercomputer.
 *
 *   `stampForJob`      the dispatched pipeline stamp of a job and its recipe's checkpoint map, or why not
 *   `recordProgress`   one guarded batch that stores a report, or writes nothing
 *
 * THE GATE. A report is one D1 batch whose FIRST statement upserts the run row of the stamp
 * (`compute_pipeline_progress_runs`) only when, in that same statement: the job is in an accepted state
 * (and, for a runner job, still held by this runner and lease); the run is not reconciled; and the last
 * accepted report is at least `PROGRESS_MIN_INTERVAL_SECONDS` old, by D1's own clock. It sets a fresh
 * random `write_id`. Every later statement of the batch writes only where that `write_id` stands, so a
 * refused report writes nothing and two concurrent reports of one run give exactly one winner. A refusal
 * is then told apart by reading the run and the job (`too_soon` when only the clock refused it).
 *
 * Every value written is a count, a checkpoint the registry declares, a capped failure list that already
 * passed the closed schema and `progressProblem`, or a link the shared builder made from registry values;
 * no other text from a job reaches a row.
 */

import { progressProblem, signalJourneyLink } from "../../../shared/compute-checkpoints.js";
import { type RecipeCheckpoint, recipeCheckpointMap } from "../../../shared/compute-recipes.js";
import {
  PROGRESS_MIN_INTERVAL_SECONDS,
  type Progress,
} from "../../../shared/contract/compute-progress.js";

/** The job states in which a job on the supercomputer may report (its state in D1 lags Tapis). */
export const PROGRESS_TAPIS_STATES = ["submitted", "queued", "running"] as const;

/** The job states in which a runner job may report. */
export const PROGRESS_RUNNER_STATES = ["running"] as const;

const quoted = (states: readonly string[]) => states.map((s) => `'${s}'`).join(", ");

/** The dispatched pipeline stamp a job runs under, with what a report is checked against. */
export interface ProgressStamp {
  id: number;
  datasetId: string;
  recipe: string;
  recipeVersion: string;
  checkpoints: readonly RecipeCheckpoint[];
}

export type StampLookup =
  | { ok: true; stamp: ProgressStamp }
  | { ok: false; reason: "no_stamp" | "no_checkpoint_map" };

export const STAMP_FOR_JOB_SQL = `SELECT id, dataset_id, recipe, recipe_version
  FROM compute_pipeline_stamps WHERE job_id = ?1 AND state = 'dispatched'`;

/** The dispatched stamp of a job and its recipe version's checkpoint map, or why there is none. */
export async function stampForJob(db: D1Database, jobId: string): Promise<StampLookup> {
  const row = await db.prepare(STAMP_FOR_JOB_SQL).bind(jobId).first<{
    id: number;
    dataset_id: string;
    recipe: string;
    recipe_version: string;
  }>();
  if (!row) return { ok: false, reason: "no_stamp" };
  const checkpoints = recipeCheckpointMap(row.recipe, row.recipe_version);
  if (!checkpoints) return { ok: false, reason: "no_checkpoint_map" };
  return {
    ok: true,
    stamp: {
      id: row.id,
      datasetId: row.dataset_id,
      recipe: row.recipe,
      recipeVersion: row.recipe_version,
      checkpoints,
    },
  };
}

/** Who reports: a job on the supercomputer, or a runner holding the job's lease. */
export type ProgressReporter =
  | { executor: "tapis" }
  | { executor: "runner"; runnerId: string; leaseId: string };

export type RecordResult = "accepted" | "too_soon" | "bad_state" | "storage_unavailable";

const JOB_GATE_TAPIS = `j.executor = 'tapis' AND j.state IN (${quoted(PROGRESS_TAPIS_STATES)})`;
const JOB_GATE_RUNNER = `j.executor = 'runner' AND j.runner_id = ?5 AND j.lease_id = ?6
      AND j.state IN (${quoted(PROGRESS_RUNNER_STATES)})`;

/**
 * THE GATE: the run row of the stamp, inserted or updated only when the job is in an accepted state, the
 * run is not reconciled, and the last report is at least the floor old. ?1 stamp, ?2 job, ?3 current
 * checkpoint, ?4 write id, and for a runner ?5 runner and ?6 lease.
 */
export function progressGateSql(executor: ProgressReporter["executor"]): string {
  const gate = executor === "tapis" ? JOB_GATE_TAPIS : JOB_GATE_RUNNER;
  return `INSERT INTO compute_pipeline_progress_runs
      (stamp_id, job_id, checkpoint, write_id, reported_at, reports)
    SELECT ?1, ?2, ?3, ?4, datetime('now'), 1
     WHERE EXISTS (SELECT 1 FROM compute_jobs j WHERE j.id = ?2 AND ${gate})
    ON CONFLICT(stamp_id) DO UPDATE SET
      checkpoint = excluded.checkpoint,
      write_id = excluded.write_id,
      reported_at = excluded.reported_at,
      reports = compute_pipeline_progress_runs.reports + 1
     WHERE compute_pipeline_progress_runs.reconciled_at IS NULL
       AND compute_pipeline_progress_runs.job_id = excluded.job_id
       AND (compute_pipeline_progress_runs.reported_at IS NULL
         OR compute_pipeline_progress_runs.reported_at
           <= datetime('now', '-${PROGRESS_MIN_INTERVAL_SECONDS} seconds'))`;
}

/** Every statement after the gate writes only where the gate's write id stands. ?W is the write id. */
const WON = (stampParam: string, writeParam: string) => `EXISTS (SELECT 1
    FROM compute_pipeline_progress_runs r
   WHERE r.stamp_id = ${stampParam} AND r.write_id = ${writeParam} AND r.reconciled_at IS NULL)`;

/** One checkpoint's live counts and failures. ?1 stamp, ?2 checkpoint, ?3-?6 counts, ?7 failures, ?8 write id. */
export const PROGRESS_ROW_SQL = `INSERT INTO compute_pipeline_progress
    (stamp_id, checkpoint, passed, failed, skipped, total, failures, reported_at)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now') WHERE ${WON("?1", "?8")}
  ON CONFLICT(stamp_id, checkpoint) DO UPDATE SET
    passed = excluded.passed, failed = excluded.failed, skipped = excluded.skipped,
    total = excluded.total, failures = excluded.failures, reported_at = excluded.reported_at
   WHERE compute_pipeline_progress.reconciled = 0`;

/**
 * A dataset's document of one namespace and recipe, written when the stamp is at least as new as the one
 * that stands and the standing one is not final for the same stamp. ?1 dataset, ?2 namespace, ?3 recipe,
 * ?4 stamp, ?5 entry, ?6 final, ?7 write id (guarded on the gate), used by a live report.
 */
export const LIVE_DOCUMENT_SQL = `INSERT INTO compute_pipeline_documents
    (dataset_id, namespace, recipe, stamp_id, entry, final, written_at)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, datetime('now') WHERE ${WON("?4", "?7")}
  ON CONFLICT(dataset_id, namespace, recipe) DO UPDATE SET
    stamp_id = excluded.stamp_id, entry = excluded.entry, final = excluded.final,
    written_at = excluded.written_at
   WHERE excluded.stamp_id > compute_pipeline_documents.stamp_id
      OR (excluded.stamp_id = compute_pipeline_documents.stamp_id
        AND compute_pipeline_documents.final = 0)`;

function randomHex(bytes: number): string {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Store one report, or nothing. The caller has parsed the object against the closed schema and checked
 * it with `progressProblem` against `stamp.checkpoints`.
 */
export async function recordProgress(
  db: D1Database,
  input: { jobId: string; stamp: ProgressStamp; reporter: ProgressReporter; progress: Progress },
): Promise<RecordResult> {
  const { jobId, stamp, reporter, progress } = input;
  const writeId = randomHex(16);
  const gateBinds: unknown[] = [stamp.id, jobId, progress.checkpoint, writeId];
  if (reporter.executor === "runner") gateBinds.push(reporter.runnerId, reporter.leaseId);
  const statements = [db.prepare(progressGateSql(reporter.executor)).bind(...gateBinds)];
  for (const c of stamp.checkpoints) {
    const counts = progress.counts[c.checkpoint];
    const failures = progress.failures.filter((f) => f.checkpoint === c.checkpoint);
    statements.push(
      db
        .prepare(PROGRESS_ROW_SQL)
        .bind(
          stamp.id,
          c.checkpoint,
          counts.passed,
          counts.failed,
          counts.skipped,
          counts.total,
          JSON.stringify(failures),
          writeId,
        ),
    );
  }
  const link = signalJourneyLink({ recipeVersion: stamp.recipeVersion, status: "in_progress" });
  statements.push(
    db
      .prepare(LIVE_DOCUMENT_SQL)
      .bind(
        stamp.datasetId,
        "signalJourney",
        stamp.recipe,
        stamp.id,
        JSON.stringify(link),
        0,
        writeId,
      ),
  );
  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (err) {
    console.error(
      `[compute-pipeline-progress] report_failed class=${err instanceof Error ? err.name : typeof err}`,
    );
    return "storage_unavailable";
  }
  if ((results[0]?.meta?.changes ?? 0) === 1) return "accepted";
  return refusalOf(db, stamp.id, jobId, reporter);
}

/** Why the gate refused a report: the clock alone (`too_soon`), or the run or the job (`bad_state`). */
async function refusalOf(
  db: D1Database,
  stampId: number,
  jobId: string,
  reporter: ProgressReporter,
): Promise<RecordResult> {
  const gate = reporter.executor === "tapis" ? JOB_GATE_TAPIS : JOB_GATE_RUNNER;
  const binds: unknown[] = [stampId, jobId, null, null];
  if (reporter.executor === "runner") binds.push(reporter.runnerId, reporter.leaseId);
  const row = await db
    .prepare(
      `SELECT r.reconciled_at, r.job_id,
         EXISTS (SELECT 1 FROM compute_jobs j WHERE j.id = ?2 AND ${gate}) AS job_ok,
         ?3 IS NULL AND ?4 IS NULL AS unused
         FROM compute_pipeline_progress_runs r WHERE r.stamp_id = ?1`,
    )
    .bind(...binds)
    .first<{ reconciled_at: string | null; job_id: string; job_ok: number }>();
  if (!row) return "bad_state";
  if (row.reconciled_at !== null || row.job_id !== jobId || row.job_ok !== 1) return "bad_state";
  return "too_soon";
}

/**
 * The progress a heartbeat carries, stored after the lease is renewed and never at its cost: a report
 * that is too soon, does not fit the recipe, belongs to no dispatched stamp, or meets a storage fault is
 * dropped with a fixed-word log line. Only a heartbeat of phase `started` carries progress.
 */
export async function recordHeartbeatProgress(
  db: D1Database,
  input: { jobId: string; runnerId: string; leaseId: string; phase: string; progress: Progress },
): Promise<RecordResult | "ignored"> {
  try {
    if (input.phase !== "started") return "ignored";
    const lookup = await stampForJob(db, input.jobId);
    if (!lookup.ok) {
      console.log(`[compute-pipeline-progress] heartbeat_progress_dropped reason=${lookup.reason}`);
      return "ignored";
    }
    const problem = progressProblem(input.progress, lookup.stamp.checkpoints);
    if (problem !== null) {
      console.log(`[compute-pipeline-progress] heartbeat_progress_dropped reason=${problem}`);
      return "ignored";
    }
    const result = await recordProgress(db, {
      jobId: input.jobId,
      stamp: lookup.stamp,
      reporter: { executor: "runner", runnerId: input.runnerId, leaseId: input.leaseId },
      progress: input.progress,
    });
    if (result !== "accepted") {
      console.log(`[compute-pipeline-progress] heartbeat_progress_dropped reason=${result}`);
    }
    return result;
  } catch (err) {
    console.error(
      `[compute-pipeline-progress] heartbeat_progress_failed class=${err instanceof Error ? err.name : typeof err}`,
    );
    return "storage_unavailable";
  }
}

/** The SQL predicate equal to `pipelineRunStatus` saying `stalled`, for a list read (r = run row, j = job). */
export const PIPELINE_STALLED_SQL = `(j.state = 'unreported' OR (r.reported_at IS NOT NULL
    AND r.reported_at < datetime('now', '-180 seconds')))`;
