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

import {
  countRecordings,
  failuresByCheckpoint,
  liveDisagrees,
  parseRecordingsTable,
  processingDatasetEntry,
  processingEntryProblem,
  progressProblem,
  signalJourneyLink,
} from "../../../shared/compute-checkpoints.js";
import {
  RECIPE_PRODUCT_OUTPUT_PREFIX,
  type RecipeCheckpoint,
  STORED_CHECKPOINT,
  findRecipe,
  recipeCheckpointMap,
  recipeRequiredOutputs,
} from "../../../shared/compute-recipes.js";
import { resultsOutputKey } from "../../../shared/contract/compute-launch.js";
import {
  PROGRESS_MIN_INTERVAL_SECONDS,
  type Progress,
  type ProgressCheckpointCounts,
} from "../../../shared/contract/compute-progress.js";
import type { Bindings } from "../types/bindings.js";
import { RECORD_READ_MAX_BYTES, TABLE_READ_MAX_BYTES } from "./compute-derivatives.js";

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

// --- Reconciliation ---------------------------------------------------------------------------------

/** How many ended runs and pending `stored` rows one call reconciles (each is bounded subrequests). */
export const RECONCILE_RUNS_PER_CALL = 10;

/** What reconciliation decided for a run that ended. */
export type ReconcileOutcome =
  | "reconciled"
  | "table_missing"
  | "table_unreadable"
  | "no_checkpoint_map"
  | "recipe_unknown";

export interface ReconcileResult {
  /** Ended runs given an outcome, and `stored` rows resolved. */
  reconciled: number;
  /** Runs left for a later call: a bucket that is not bound or did not answer. */
  later: number;
  /** Runs whose reconciliation threw: left as they were. */
  errored: number;
}

/** Ended stamps with a job whose run is not reconciled, oldest end first. */
export const RECONCILE_CANDIDATES_SQL = `SELECT s.id, s.dataset_id, s.recipe, s.recipe_version, s.state, s.job_id
  FROM compute_pipeline_stamps s
  LEFT JOIN compute_pipeline_progress_runs r ON r.stamp_id = s.id
  WHERE s.state IN ('succeeded', 'failed') AND s.job_id IS NOT NULL
    AND (r.stamp_id IS NULL OR r.reconciled_at IS NULL)
  ORDER BY s.updated_at ASC, s.id ASC LIMIT ?1`;

/**
 * THE RECONCILE GATE: the run row given its outcome, only while it has none. ?1 stamp, ?2 job, ?3 write id,
 * ?4 outcome, ?5 disagreement. Every later statement of the batch writes only where the write id stands.
 */
export const RECONCILE_GATE_SQL = `INSERT INTO compute_pipeline_progress_runs
    (stamp_id, job_id, write_id, reconciled_at, outcome, disagreement)
  VALUES (?1, ?2, ?3, datetime('now'), ?4, ?5)
  ON CONFLICT(stamp_id) DO UPDATE SET
    write_id = excluded.write_id, reconciled_at = excluded.reconciled_at,
    outcome = excluded.outcome, disagreement = excluded.disagreement
   WHERE compute_pipeline_progress_runs.reconciled_at IS NULL`;

const RECONCILE_WON = (stampParam: string, writeParam: string) => `EXISTS (SELECT 1
    FROM compute_pipeline_progress_runs r
   WHERE r.stamp_id = ${stampParam} AND r.write_id = ${writeParam})`;

/**
 * One checkpoint's reconciled row. ?1 stamp, ?2 checkpoint, ?3-?6 counts, ?7 failures, ?8-?11 the last live
 * counts (or nulls), ?12 reconciled, ?13 disagreement, ?14 write id. The time of the last report is kept.
 */
export const RECONCILE_ROW_SQL = `INSERT INTO compute_pipeline_progress
    (stamp_id, checkpoint, passed, failed, skipped, total, failures, reported_at,
     live_passed, live_failed, live_skipped, live_total, reconciled, disagreement)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'), ?8, ?9, ?10, ?11, ?12, ?13
   WHERE ${RECONCILE_WON("?1", "?14")}
  ON CONFLICT(stamp_id, checkpoint) DO UPDATE SET
    passed = excluded.passed, failed = excluded.failed, skipped = excluded.skipped,
    total = excluded.total, failures = excluded.failures,
    live_passed = excluded.live_passed, live_failed = excluded.live_failed,
    live_skipped = excluded.live_skipped, live_total = excluded.live_total,
    reconciled = excluded.reconciled, disagreement = excluded.disagreement`;

/**
 * A dataset's final document of one namespace and recipe: the newest stamp wins, the same stamp may write
 * again. ?1 dataset, ?2 namespace, ?3 recipe, ?4 stamp, ?5 entry, ?6 final, ?7 write id.
 */
export const RECONCILE_DOCUMENT_SQL = `INSERT INTO compute_pipeline_documents
    (dataset_id, namespace, recipe, stamp_id, entry, final, written_at)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, datetime('now') WHERE ${RECONCILE_WON("?4", "?7")}
  ON CONFLICT(dataset_id, namespace, recipe) DO UPDATE SET
    stamp_id = excluded.stamp_id, entry = excluded.entry, final = excluded.final,
    written_at = excluded.written_at
   WHERE excluded.stamp_id >= compute_pipeline_documents.stamp_id`;

interface CandidateRow {
  id: number;
  dataset_id: string;
  recipe: string;
  recipe_version: string;
  state: "succeeded" | "failed";
  job_id: string;
}

interface CountsRow {
  checkpoint: string;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

type TextRead = { kind: "ok"; text: string } | { kind: "absent" } | { kind: "too_large" };

async function readBounded(bucket: R2Bucket, key: string, max: number): Promise<TextRead> {
  const head = await bucket.head(key);
  if (!head) return { kind: "absent" };
  if (head.size > max) return { kind: "too_large" };
  const object = await bucket.get(key);
  if (!object) return { kind: "absent" };
  return { kind: "ok", text: await object.text() };
}

async function sha256HexOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The `sj_version` at the top of a signalJourney record, or null. */
function sjVersionOf(text: string): string | null {
  try {
    const doc = JSON.parse(text) as unknown;
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
    const v = (doc as Record<string, unknown>).sj_version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

const gateOnly = (db: D1Database, stamp: CandidateRow, outcome: ReconcileOutcome) =>
  db.prepare(RECONCILE_GATE_SQL).bind(stamp.id, stamp.job_id, randomHex(16), outcome, 0).run();

/**
 * Reconcile the ended runs and the pending `stored` rows, at most {@link RECONCILE_RUNS_PER_CALL} of
 * each. Never changes a stamp; once a run is reconciled no report moves a count. Idempotent: a second
 * caller's gate finds the run reconciled and writes nothing.
 */
export async function reconcilePipelineProgress(
  env: Bindings,
  limit: number = RECONCILE_RUNS_PER_CALL,
): Promise<ReconcileResult> {
  const result: ReconcileResult = { reconciled: 0, later: 0, errored: 0 };
  const db = env.DB;
  const candidates = (await db.prepare(RECONCILE_CANDIDATES_SQL).bind(limit).all<CandidateRow>())
    .results;
  for (const stamp of candidates) {
    try {
      const outcome = await reconcileRun(env, stamp);
      if (outcome === "later") result.later++;
      else result.reconciled++;
    } catch (err) {
      console.error(
        `[compute-pipeline-progress] reconcile_failed stamp=${stamp.id} class=${err instanceof Error ? err.name : typeof err}`,
      );
      result.errored++;
    }
  }
  try {
    result.reconciled += await resolveStored(db, limit);
  } catch (err) {
    console.error(
      `[compute-pipeline-progress] stored_failed class=${err instanceof Error ? err.name : typeof err}`,
    );
    result.errored++;
  }
  return result;
}

/** Reconcile one ended run from its recordings table; `later` when the results bucket cannot be read. */
async function reconcileRun(
  env: Bindings,
  stamp: CandidateRow,
): Promise<ReconcileOutcome | "later"> {
  const db = env.DB;
  const recipe = findRecipe(stamp.recipe);
  if (!recipe) {
    await gateOnly(db, stamp, "recipe_unknown");
    return "recipe_unknown";
  }
  const checkpoints = recipeCheckpointMap(stamp.recipe, stamp.recipe_version);
  if (!checkpoints) {
    await gateOnly(db, stamp, "no_checkpoint_map");
    return "no_checkpoint_map";
  }
  const results = env.COMPUTE_RESULTS;
  if (!results) return "later";
  const wanted = recipeRequiredOutputs(recipe);
  let table: TextRead;
  try {
    table = await readBounded(
      results,
      resultsOutputKey(stamp.job_id, wanted.table),
      TABLE_READ_MAX_BYTES,
    );
  } catch {
    return "later";
  }
  if (table.kind === "absent") {
    await gateOnly(db, stamp, "table_missing");
    return "table_missing";
  }
  const parsed = table.kind === "ok" ? parseRecordingsTable(table.text) : null;
  if (!parsed || !parsed.ok) {
    await gateOnly(db, stamp, "table_unreadable");
    return "table_unreadable";
  }
  const rows = parsed.rows;

  // The last live counts, kept beside the reconciled ones.
  const liveRows = (
    await db
      .prepare(
        "SELECT checkpoint, passed, failed, skipped, total FROM compute_pipeline_progress WHERE stamp_id = ?1",
      )
      .bind(stamp.id)
      .all<CountsRow>()
  ).results;
  const live = new Map(liveRows.map((r) => [r.checkpoint, r]));
  const liveTotal = liveRows.reduce((m, r) => Math.max(m, r.total), 0);
  const total = stamp.state === "succeeded" ? rows.length : Math.max(rows.length, liveTotal);
  const counts = countRecordings(rows, checkpoints, total);
  const failures = failuresByCheckpoint(rows, checkpoints);

  // `stored`: a failed run stored nothing; a succeeded run waits for the derivative store.
  const last = counts[checkpoints[checkpoints.length - 1].checkpoint];
  const storedFinal = stamp.state === "failed";
  const stored: ProgressCheckpointCounts = storedFinal
    ? { passed: 0, failed: 0, skipped: total, total }
    : { passed: 0, failed: 0, skipped: total - last.passed, total };

  let disagreement = 0;
  const writeId = randomHex(16);
  const statements: D1PreparedStatement[] = [];
  const rowStatement = (
    checkpoint: string,
    c: ProgressCheckpointCounts,
    reconciled: 0 | 1,
    list: readonly unknown[],
  ) => {
    const l = live.get(checkpoint);
    const disagrees = l !== undefined && liveDisagrees(l, c) ? 1 : 0;
    if (disagrees) disagreement = 1;
    return db
      .prepare(RECONCILE_ROW_SQL)
      .bind(
        stamp.id,
        checkpoint,
        c.passed,
        c.failed,
        c.skipped,
        c.total,
        JSON.stringify(list),
        l?.passed ?? null,
        l?.failed ?? null,
        l?.skipped ?? null,
        l?.total ?? null,
        reconciled,
        disagrees,
        writeId,
      );
  };
  for (const c of checkpoints) {
    statements.push(rowStatement(c.checkpoint, counts[c.checkpoint], 1, failures[c.checkpoint]));
  }
  statements.push(rowStatement(STORED_CHECKPOINT, stored, storedFinal ? 1 : 0, []));

  // The signalJourney link: completed with the record's digest and version, or failed with none.
  let link = signalJourneyLink({ recipeVersion: stamp.recipe_version, status: "failed" });
  if (stamp.state === "succeeded") {
    let record: TextRead;
    try {
      record = await readBounded(
        results,
        resultsOutputKey(stamp.job_id, wanted.record),
        RECORD_READ_MAX_BYTES,
      );
    } catch {
      return "later";
    }
    link =
      record.kind === "ok"
        ? signalJourneyLink({
            recipeVersion: stamp.recipe_version,
            status: "completed",
            location: wanted.record.slice(RECIPE_PRODUCT_OUTPUT_PREFIX.length),
            sha256: await sha256HexOf(record.text),
            sjVersion: sjVersionOf(record.text),
          })
        : null;
    if (link === null) {
      console.log(`[compute-pipeline-progress] link_not_written stamp=${stamp.id} reason=record`);
    }
  }
  if (link !== null) {
    statements.push(
      db
        .prepare(RECONCILE_DOCUMENT_SQL)
        .bind(
          stamp.dataset_id,
          "signalJourney",
          stamp.recipe,
          stamp.id,
          JSON.stringify(link),
          1,
          writeId,
        ),
    );
  }
  if (storedFinal) {
    const entry = processingDatasetEntry({
      recipeVersion: stamp.recipe_version,
      checkpoints,
      counts: { ...counts, [STORED_CHECKPOINT]: stored },
    });
    if (processingEntryProblem(entry) === null) {
      statements.push(
        db
          .prepare(RECONCILE_DOCUMENT_SQL)
          .bind(
            stamp.dataset_id,
            "processing",
            stamp.recipe,
            stamp.id,
            JSON.stringify(entry),
            1,
            writeId,
          ),
      );
    }
  }
  // The gate goes first; its disagreement is known only now, so it is built last and put in front.
  statements.unshift(
    db
      .prepare(RECONCILE_GATE_SQL)
      .bind(stamp.id, stamp.job_id, writeId, "reconciled", disagreement),
  );
  await db.batch(statements);
  return "reconciled";
}

/** The pending `stored` rows whose derivative is decided, with what decided it. */
export const STORED_PENDING_SQL = `SELECT p.stamp_id, s.dataset_id, s.recipe, s.recipe_version,
    d.state AS derivative_state, d.stored_at,
    EXISTS (SELECT 1 FROM compute_derivative_skips k WHERE k.stamp_id = p.stamp_id) AS skipped
  FROM compute_pipeline_progress p
  JOIN compute_pipeline_stamps s ON s.id = p.stamp_id
  LEFT JOIN compute_derivatives d ON d.stamp_id = p.stamp_id
  WHERE p.checkpoint = 'stored' AND p.reconciled = 0
    AND (d.state IN ('stored', 'failed', 'expired')
      OR EXISTS (SELECT 1 FROM compute_derivative_skips k WHERE k.stamp_id = p.stamp_id))
  ORDER BY p.stamp_id ASC LIMIT ?1`;

/** The `stored` row reconciled, only while it is pending. ?1 stamp, ?2-?4 passed, failed, skipped. */
export const STORED_RESOLVE_SQL = `UPDATE compute_pipeline_progress
    SET passed = ?2, failed = ?3, skipped = ?4, reconciled = 1
  WHERE stamp_id = ?1 AND checkpoint = 'stored' AND reconciled = 0`;

/** The `processing` entry of a stamp, written once its `stored` row is reconciled. */
export const STORED_DOCUMENT_SQL = `INSERT INTO compute_pipeline_documents
    (dataset_id, namespace, recipe, stamp_id, entry, final, written_at)
  SELECT ?1, 'processing', ?2, ?3, ?4, 1, datetime('now')
   WHERE EXISTS (SELECT 1 FROM compute_pipeline_progress
     WHERE stamp_id = ?3 AND checkpoint = 'stored' AND reconciled = 1)
  ON CONFLICT(dataset_id, namespace, recipe) DO UPDATE SET
    stamp_id = excluded.stamp_id, entry = excluded.entry, final = excluded.final,
    written_at = excluded.written_at
   WHERE excluded.stamp_id >= compute_pipeline_documents.stamp_id`;

/** Resolve the pending `stored` rows from the derivative store, and write their `processing` entries. */
async function resolveStored(db: D1Database, limit: number): Promise<number> {
  const pending = (
    await db.prepare(STORED_PENDING_SQL).bind(limit).all<{
      stamp_id: number;
      dataset_id: string;
      recipe: string;
      recipe_version: string;
      derivative_state: string | null;
      stored_at: string | null;
      skipped: number;
    }>()
  ).results;
  let resolved = 0;
  for (const p of pending) {
    const checkpoints = recipeCheckpointMap(p.recipe, p.recipe_version);
    if (!checkpoints) continue;
    const rows = (
      await db
        .prepare(
          "SELECT checkpoint, passed, failed, skipped, total FROM compute_pipeline_progress WHERE stamp_id = ?1",
        )
        .bind(p.stamp_id)
        .all<CountsRow>()
    ).results;
    const byName = new Map(rows.map((r) => [r.checkpoint, r]));
    const last = byName.get(checkpoints[checkpoints.length - 1].checkpoint);
    if (!last) continue;
    const total = last.total;
    const kept =
      p.derivative_state === "stored" || (p.derivative_state === "expired" && p.stored_at !== null);
    const lost = p.derivative_state === "failed";
    const stored: ProgressCheckpointCounts = kept
      ? { passed: last.passed, failed: 0, skipped: total - last.passed, total }
      : lost
        ? { passed: 0, failed: last.passed, skipped: total - last.passed, total }
        : { passed: 0, failed: 0, skipped: total, total };
    const counts: Record<string, ProgressCheckpointCounts> = {};
    for (const c of checkpoints) {
      const r = byName.get(c.checkpoint);
      if (!r) break;
      counts[c.checkpoint] = r;
    }
    counts[STORED_CHECKPOINT] = stored;
    const entry = processingDatasetEntry({ recipeVersion: p.recipe_version, checkpoints, counts });
    const problem = processingEntryProblem(entry);
    const statements = [
      db.prepare(STORED_RESOLVE_SQL).bind(p.stamp_id, stored.passed, stored.failed, stored.skipped),
    ];
    if (problem === null) {
      statements.push(
        db
          .prepare(STORED_DOCUMENT_SQL)
          .bind(p.dataset_id, p.recipe, p.stamp_id, JSON.stringify(entry)),
      );
    } else {
      console.log(
        `[compute-pipeline-progress] processing_not_written stamp=${p.stamp_id} reason=${problem}`,
      );
    }
    const done = await db.batch(statements);
    if ((done[0]?.meta?.changes ?? 0) === 1) resolved++;
  }
  return resolved;
}
