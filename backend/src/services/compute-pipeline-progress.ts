/**
 * Live progress of NEMAR's pipeline runs (ADR 0134 decisions 3 and 4, epic #2324 phase 2): one write
 * path for a report, shared by the runner heartbeat and the job-token route of a job on the supercomputer,
 * the reconciliation that replaces live counts with final ones when a run ends, and the dataset-level
 * neuroschema entries a public page shows of the PROMOTED run.
 *
 *   `stampForJob`                 the dispatched pipeline stamp of a job and its recipe's checkpoint map
 *   `recordProgress`              one guarded batch that stores a report, or writes nothing
 *   `reconcilePipelineProgress`   ended runs reconciled from their recordings tables (counts, the run's
 *                                 link), `stored` resolved, and a succeeded run's dataset quality summary
 *                                 checked and kept
 *   `readPipelineExtensions`      a dataset's `processing`, `signalJourney` and `dataQuality`, for its pages
 *
 * THE GATE. A report is one D1 batch whose FIRST statement upserts the run row of the stamp
 * (`compute_pipeline_progress_runs`) only when, in that same statement: the stamp is still dispatched and
 * names this job; the job is in an accepted state (and, for a runner job, still held by this runner and
 * lease); the run is not reconciled; and the last accepted report is at least
 * `PROGRESS_MIN_INTERVAL_SECONDS` old, by D1's own clock. It sets a fresh random `write_id`. Every later
 * statement of the batch writes only where that `write_id` stands, so a refused report writes nothing and
 * two concurrent reports of one run give exactly one winner. A refusal is then told apart by reading the
 * run and the job (`too_soon` when only the clock refused it).
 *
 * WHAT A PUBLIC PAGE SHOWS IS THE PROMOTED RUN (ADR 0134 decision 9 as amended 2026-11-26). The dataset's
 * `processing`, `signalJourney` and `dataQuality` all describe each recipe's current public derivative
 * (ADR 0137 decision 7), built when they are read from rows kept per run: the reconciled counts, the order
 * the run declared, the link reconciliation wrote on the run row, and the quality summary. Nothing live is
 * public: a run in progress, a canary run and a failed run show nothing, and administrators see them on
 * the grid.
 *
 * Every value written is a count, a checkpoint the registry declares, a capped failure list that already
 * passed the closed schema and `progressProblem`, or an entry the shared builders made from registry values
 * and digests; no other text from a job reaches a row.
 */

import {
  PIPELINE_STALLED_SECONDS,
  type ProcessingDatasetEntry,
  type RecordingRow,
  STALLABLE_JOB_STATES,
  type StoredDecision,
  WAITING_JOB_STATES,
  countRecordings,
  failuresByCheckpoint,
  liveDisagrees,
  parseRecordingsTable,
  processingDatasetEntry,
  processingEntryProblem,
  progressProblem,
  signalJourneyLink,
  storedCounts,
} from "../../../shared/compute-checkpoints.js";
import {
  type ComputeRecipe,
  RECIPE_PRODUCT_OUTPUT_PREFIX,
  type RecipeCheckpoint,
  STORED_CHECKPOINT,
  declaredCheckpoints,
  findRecipe,
  recipeCheckpointMap,
  recipeQualityDocumentPath,
  recipeQualityPlugins,
  recipeRequiredOutputs,
} from "../../../shared/compute-recipes.js";
import { resultsOutputKey } from "../../../shared/contract/compute-launch.js";
import {
  PROGRESS_MIN_INTERVAL_SECONDS,
  type Progress,
  type ProgressCheckpointCounts,
} from "../../../shared/contract/compute-progress.js";
import { DATA_QUALITY_MAX_BYTES } from "../../../shared/contract/data-quality.js";
import { sha256HexOfBytes } from "../../../shared/contract/view-digest.js";
import type { Bindings } from "../types/bindings.js";
import { RECORD_READ_MAX_BYTES, TABLE_READ_MAX_BYTES } from "./compute-derivatives.js";
import { type PipelineExtensions, pipelineExtensions } from "./data-router.js";
import {
  CURRENT_PUBLIC_DERIVATIVE_SQL,
  CURRENT_QUALITY_DOCUMENTS_SQL,
  QUALITY_DATASET_GATE_SQL,
  checkDatasetQualityDocument,
  qualityEntriesOf,
} from "./quality-documents.js";

/** The job states in which a job on the supercomputer may report (its state in D1 lags Tapis). */
export const PROGRESS_TAPIS_STATES = ["submitted", "queued", "running"] as const;

/** The job states in which a runner job may report. */
export const PROGRESS_RUNNER_STATES = ["running"] as const;

const quoted = (states: readonly string[]) => states.map((s) => `'${s}'`).join(", ");

const LOG = "[compute-pipeline-progress]";
const errClass = (err: unknown) => (err instanceof Error ? err.name : typeof err);

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

/** The DISPATCHED stamp of a job: a hold stamp (failed, `tuple_mismatch`) shares the job and is never it. */
export const STAMP_FOR_JOB_SQL = `SELECT id, dataset_id, recipe, recipe_version
  FROM compute_pipeline_stamps WHERE job_id = ?1 AND state = 'dispatched'
  ORDER BY id DESC LIMIT 1`;

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

/** The stamp is still dispatched and still names the job (a deleted or ended stamp takes no report). */
const STAMP_GATE = `EXISTS (SELECT 1 FROM compute_pipeline_stamps s
      WHERE s.id = ?1 AND s.job_id = ?2 AND s.state = 'dispatched')`;

/**
 * THE GATE: the run row of the stamp, inserted or updated only when the stamp is dispatched and names the
 * job, the job is in an accepted state, the run is not reconciled, and the last report is at least the
 * floor old. ?1 stamp, ?2 job, ?3 current checkpoint, ?4 write id, and for a runner ?5 runner and ?6 lease.
 */
export function progressGateSql(executor: ProgressReporter["executor"]): string {
  const gate = executor === "tapis" ? JOB_GATE_TAPIS : JOB_GATE_RUNNER;
  return `INSERT INTO compute_pipeline_progress_runs
      (stamp_id, job_id, checkpoint, write_id, reported_at, reports)
    SELECT ?1, ?2, ?3, ?4, datetime('now'), 1
     WHERE EXISTS (SELECT 1 FROM compute_jobs j WHERE j.id = ?2 AND ${gate})
       AND ${STAMP_GATE}
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

/** Every statement after the gate writes only where the gate's write id stands. */
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

function randomHex(bytes: number): string {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Store one report, or nothing. The caller has parsed the object against the closed schema and checked
 * it with `progressProblem` against `stamp.checkpoints`. A database fault is `storage_unavailable`.
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
  try {
    const results = await db.batch(statements);
    if ((results[0]?.meta?.changes ?? 0) === 1) return "accepted";
    return await refusalOf(db, stamp.id, jobId, reporter);
  } catch (err) {
    console.error(`${LOG} report_failed class=${errClass(err)}`);
    return "storage_unavailable";
  }
}

/** Why the gate refused a report: the clock alone (`too_soon`), or the stamp, run or job (`bad_state`). */
async function refusalOf(
  db: D1Database,
  stampId: number,
  jobId: string,
  reporter: ProgressReporter,
): Promise<RecordResult> {
  const gate = reporter.executor === "tapis" ? JOB_GATE_TAPIS : JOB_GATE_RUNNER;
  // ?3 and ?4 keep the numbering of the gate, whose runner terms are ?5 and ?6.
  const binds: unknown[] = [stampId, jobId, 0, 0];
  if (reporter.executor === "runner") binds.push(reporter.runnerId, reporter.leaseId);
  const row = await db
    .prepare(
      `SELECT r.reconciled_at, r.job_id,
         EXISTS (SELECT 1 FROM compute_jobs j WHERE j.id = ?2 AND ${gate}) AS job_ok,
         ${STAMP_GATE} AS stamp_ok, ?3 + ?4 AS unused
         FROM compute_pipeline_progress_runs r WHERE r.stamp_id = ?1`,
    )
    .bind(...binds)
    .first<{ reconciled_at: string | null; job_id: string; job_ok: number; stamp_ok: number }>();
  if (!row) return "bad_state";
  if (
    row.reconciled_at !== null ||
    row.job_id !== jobId ||
    row.job_ok !== 1 ||
    row.stamp_ok !== 1
  ) {
    return "bad_state";
  }
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
      console.log(`${LOG} heartbeat_progress_dropped reason=${lookup.reason}`);
      return "ignored";
    }
    const problem = progressProblem(input.progress, lookup.stamp.checkpoints);
    if (problem !== null) {
      console.log(`${LOG} heartbeat_progress_dropped reason=${problem}`);
      return "ignored";
    }
    const result = await recordProgress(db, {
      jobId: input.jobId,
      stamp: lookup.stamp,
      reporter: { executor: "runner", runnerId: input.runnerId, leaseId: input.leaseId },
      progress: input.progress,
    });
    if (result !== "accepted") console.log(`${LOG} heartbeat_progress_dropped reason=${result}`);
    return result;
  } catch (err) {
    console.error(`${LOG} heartbeat_progress_failed class=${errClass(err)}`);
    return "storage_unavailable";
  }
}

/**
 * The SQL predicate equal to `pipelineRunStatus` saying `stalled`, for a list read (s = stamp, j = job,
 * r = run row): a dispatched stamp whose job is `unreported`, or `submitted`, `queued` or `running` with a
 * last report older than three minutes.
 */
export const PIPELINE_STALLED_SQL = `(s.state = 'dispatched' AND (j.state = 'unreported'
    OR (j.state IN (${quoted(STALLABLE_JOB_STATES)}) AND r.reported_at IS NOT NULL
      AND r.reported_at < datetime('now', '-${PIPELINE_STALLED_SECONDS} seconds'))))`;

/**
 * What a run shows (`pipelineRunStatus`), as a SQL expression over a stamp `s`, its job `j` and its run row
 * `r` (each may be absent: a LEFT JOIN), in exactly the order of the TypeScript rule: a missing stamp is
 * `not_started`; an ended stamp is `finished` or `failed`; a terminal job is its end; an `unreported` job,
 * or a `submitted`, `queued` or `running` job whose last report is older than {@link PIPELINE_STALLED_SECONDS},
 * is `stalled`; a job that never reported and has not started (or has no job yet) is `waiting`; anything
 * else is `running`. `compute-pipeline-grid.test.ts` holds it equal to `pipelineRunStatus` over every
 * stamp state, job state and report age.
 */
export const PIPELINE_RUN_STATUS_SQL = `(CASE
    WHEN s.id IS NULL THEN 'not_started'
    WHEN s.state = 'succeeded' THEN 'finished'
    WHEN s.state IN ('failed', 'refused') THEN 'failed'
    WHEN j.state = 'finished' THEN 'finished'
    WHEN j.state IN ('failed', 'cancelled') THEN 'failed'
    WHEN j.state = 'unreported' THEN 'stalled'
    WHEN j.state IN (${quoted(STALLABLE_JOB_STATES)}) AND r.reported_at IS NOT NULL
      AND r.reported_at < datetime('now', '-${PIPELINE_STALLED_SECONDS} seconds') THEN 'stalled'
    WHEN r.reported_at IS NULL AND (j.state IS NULL OR j.state IN (${quoted(WAITING_JOB_STATES)}))
      THEN 'waiting'
    ELSE 'running'
  END)`;

// --- What a public page shows ---------------------------------------------------------------------

/**
 * Each recipe's PROMOTED run of a dataset (`?1`): its current public derivative (ADR 0137 decision 7) of a
 * dataset that passes the quality route's gate, with the run row reconciliation left for that derivative's
 * stamp (its outcome, the recipe version and declared order it recorded, and its link). One predicate with
 * {@link PROMOTED_COUNTS_SQL} and the quality summaries, read in one batch, so the three namespaces of one
 * answer describe one run.
 */
export const PROMOTED_RUNS_SQL = `SELECT cd.recipe, cd.stamp_id, r.outcome, r.recipe_version, r.declared, r.link
  FROM compute_derivatives cd
  JOIN datasets d ON d.dataset_id = cd.dataset_id AND ${QUALITY_DATASET_GATE_SQL}
  LEFT JOIN compute_pipeline_progress_runs r ON r.stamp_id = cd.stamp_id
  WHERE cd.dataset_id = ?1 AND ${CURRENT_PUBLIC_DERIVATIVE_SQL("cd")}
  ORDER BY cd.recipe`;

/**
 * The reconciled counts of those runs (`?1` the dataset), every declared checkpoint but `stored`: a promoted
 * derivative is stored by definition, so its `stored` counts are worked out with `storedCounts("kept")`,
 * which is the rule its pending `stored` row is resolved with, and never wait for that row.
 */
export const PROMOTED_COUNTS_SQL = `SELECT p.stamp_id, p.checkpoint, p.passed, p.failed, p.skipped, p.total
  FROM compute_pipeline_progress p
  JOIN compute_derivatives cd ON cd.stamp_id = p.stamp_id
  JOIN datasets d ON d.dataset_id = cd.dataset_id AND ${QUALITY_DATASET_GATE_SQL}
  WHERE cd.dataset_id = ?1 AND ${CURRENT_PUBLIC_DERIVATIVE_SQL("cd")}
    AND p.checkpoint <> '${STORED_CHECKPOINT}' AND p.reconciled = 1`;

interface PromotedRunRow {
  recipe: string;
  stamp_id: number;
  outcome: string | null;
  recipe_version: string | null;
  declared: string | null;
  link: string | null;
}

interface PromotedCountsRow extends CountsRow {
  stamp_id: number;
}

/**
 * The dataset-level `processing` entry of a promoted run from its reconciled counts, or the word it is not
 * shown with: the run was not reconciled from a table (`not_reconciled`: an outcome without counts, or no
 * run row), its declared order cannot be read (`no_declared_order`), or the counts break the writer's rules
 * (`processingEntryProblem`'s words, `keys_differ` for a missing checkpoint).
 */
function promotedProcessingEntry(
  run: Pick<PromotedRunRow, "outcome" | "recipe_version" | "declared">,
  counts: readonly CountsRow[],
): { ok: true; entry: ProcessingDatasetEntry } | { ok: false; reason: string } {
  if (run.outcome !== "reconciled" || run.recipe_version === null) {
    return { ok: false, reason: "not_reconciled" };
  }
  const declared = declaredOf(run.declared);
  if (declared === null) return { ok: false, reason: "no_declared_order" };
  const byName: Record<string, ProgressCheckpointCounts | undefined> = Object.fromEntries(
    counts.map((c) => [
      c.checkpoint,
      { passed: c.passed, failed: c.failed, skipped: c.skipped, total: c.total },
    ]),
  );
  const last = byName[declared[declared.length - 2]];
  if (last === undefined) return { ok: false, reason: "keys_differ" };
  byName[STORED_CHECKPOINT] = storedCounts("kept", last.passed, last.total);
  const entry = processingDatasetEntry({
    recipeVersion: run.recipe_version,
    declared,
    counts: byName,
  });
  if (entry === null) return { ok: false, reason: "keys_differ" };
  const problem = processingEntryProblem(entry);
  return problem === null ? { ok: true, entry } : { ok: false, reason: problem };
}

/**
 * The pipeline's namespaces of a dataset document (`processing`, `signalJourney` and `dataQuality`), as
 * `/<id>/metadata.json` and the page bundle both serve them: one read, so the two documents cannot differ,
 * and one batch, so its three namespaces describe each recipe's one promoted run. A promoted run whose
 * counts make no entry (with a fixed-word log line), or that kept no link, shows the rest. The caller gates
 * the dataset first (public, and never a concealed deposit); the statements gate it again. A failed read
 * throws.
 */
export async function readPipelineExtensions(
  db: D1Database,
  datasetId: string,
): Promise<PipelineExtensions> {
  const [runs, counts, quality] = await db.batch([
    db.prepare(PROMOTED_RUNS_SQL).bind(datasetId),
    db.prepare(PROMOTED_COUNTS_SQL).bind(datasetId),
    db.prepare(CURRENT_QUALITY_DOCUMENTS_SQL).bind(datasetId),
  ]);
  const processing: Record<string, unknown> = {};
  const signalJourney: Record<string, unknown> = {};
  const countRows = (counts.results ?? []) as PromotedCountsRow[];
  for (const run of (runs.results ?? []) as PromotedRunRow[]) {
    const built = promotedProcessingEntry(
      run,
      countRows.filter((c) => c.stamp_id === run.stamp_id),
    );
    if (built.ok) processing[run.recipe] = built.entry;
    else if (built.reason !== "not_reconciled") {
      console.warn(
        `${LOG} processing_not_shown dataset=${datasetId} recipe=${run.recipe} reason=${built.reason}`,
      );
    }
    // The column holds a JSON object or nothing (its CHECK, migration 0154).
    if (run.link !== null) signalJourney[run.recipe] = JSON.parse(run.link);
  }
  return pipelineExtensions({
    processing,
    signalJourney,
    dataQuality: qualityEntriesOf(
      datasetId,
      (quality.results ?? []) as { recipe: string; entry: string }[],
    ),
  });
}

// --- Reconciliation ---------------------------------------------------------------------------------

/**
 * The refusal word of a hold stamp (`TUPLE_MISMATCH_WORD` of ./compute-pipeline.ts, which imports this
 * module; `compute-progress-reconcile.test.ts` holds the two equal).
 */
export const HOLD_STAMP_WORD = "tuple_mismatch";

/**
 * A stamp (by its alias) that is NOT a hold stamp: a failed `tuple_mismatch` stamp whose job belongs to
 * another stamp is a hold on a tuple, not a run of its own. Stated once, for reconciliation and the grid.
 */
export const NOT_HOLD_STAMP_SQL = (alias: string): string =>
  `NOT (${alias}.refusal_code IS NOT NULL AND ${alias}.refusal_code = '${HOLD_STAMP_WORD}'
      AND EXISTS (SELECT 1 FROM compute_pipeline_stamps o WHERE o.job_id = ${alias}.job_id AND o.id <> ${alias}.id))`;

/** How many ended runs and pending `stored` rows one call reconciles (each is bounded subrequests). */
export const RECONCILE_RUNS_PER_CALL = 10;

/** What reconciliation decides for a run that ended (the words migration 0150's CHECK allows). */
export const RECONCILE_OUTCOMES = [
  "reconciled",
  "table_missing",
  "table_unreadable",
  "no_checkpoint_map",
  "recipe_unknown",
] as const;
export type ReconcileOutcome = (typeof RECONCILE_OUTCOMES)[number];

export interface ReconcileResult {
  /** Ended runs given an outcome, and `stored` rows resolved, by this call. */
  reconciled: number;
  /** Runs left for a later call: a bucket that is not bound or did not answer. */
  later: number;
  /** Runs or `stored` rows whose reconciliation threw: left as they were. */
  errored: number;
}

/**
 * Ended stamps with a job whose run is not reconciled, oldest end first. A hold stamp (failed
 * `tuple_mismatch` whose job belongs to another stamp) is not a run of its own and is never a candidate.
 */
export const RECONCILE_CANDIDATES_SQL = `SELECT s.id, s.dataset_id, s.version, s.recipe, s.recipe_version,
    s.input, s.state, s.job_id
  FROM compute_pipeline_stamps s
  LEFT JOIN compute_pipeline_progress_runs r ON r.stamp_id = s.id
  WHERE s.state IN ('succeeded', 'failed') AND s.job_id IS NOT NULL
    AND (r.stamp_id IS NULL OR r.reconciled_at IS NULL)
    AND ${NOT_HOLD_STAMP_SQL("s")}
  ORDER BY s.updated_at ASC, s.id ASC LIMIT ?1`;

/**
 * THE RECONCILE GATE: the run row given its outcome, the recipe version, the declared checkpoints and the
 * run's link, only while it has no outcome. ?1 stamp, ?2 job, ?3 write id, ?4 outcome, ?5 disagreement, ?6
 * recipe version, ?7 declared (JSON list or null), ?8 the completed link of the run's dataset record (JSON
 * object or null, migration 0154). Every later statement writes only where the write id stands.
 */
export const RECONCILE_GATE_SQL = `INSERT INTO compute_pipeline_progress_runs
    (stamp_id, job_id, write_id, reconciled_at, outcome, disagreement, recipe_version, declared, link)
  VALUES (?1, ?2, ?3, datetime('now'), ?4, ?5, ?6, ?7, ?8)
  ON CONFLICT(stamp_id) DO UPDATE SET
    write_id = excluded.write_id, reconciled_at = excluded.reconciled_at,
    outcome = excluded.outcome, disagreement = excluded.disagreement,
    recipe_version = excluded.recipe_version, declared = excluded.declared, link = excluded.link
   WHERE compute_pipeline_progress_runs.reconciled_at IS NULL`;

const BY_WRITE = (stampParam: string, writeParam: string) => `EXISTS (SELECT 1
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
   WHERE ${BY_WRITE("?1", "?14")}
  ON CONFLICT(stamp_id, checkpoint) DO UPDATE SET
    passed = excluded.passed, failed = excluded.failed, skipped = excluded.skipped,
    total = excluded.total, failures = excluded.failures,
    live_passed = excluded.live_passed, live_failed = excluded.live_failed,
    live_skipped = excluded.live_skipped, live_total = excluded.live_total,
    reconciled = excluded.reconciled, disagreement = excluded.disagreement`;

/**
 * A succeeded run's dataset quality summary (migration 0151, ADR 0137 decision 8), kept for its stamp, only
 * where the write id stands; a stamp's summary is written once. ?1 stamp, ?2 dataset (the STAMP's), ?3
 * recipe, ?4 entry, ?5 the dataset record's digest, ?6 write id.
 */
export const QUALITY_DOCUMENT_SQL = `INSERT INTO compute_quality_documents
    (stamp_id, dataset_id, recipe, entry, record_sha256)
  SELECT ?1, ?2, ?3, ?4, ?5 WHERE ${BY_WRITE("?1", "?6")}
  ON CONFLICT(stamp_id) DO NOTHING`;

interface CandidateRow {
  id: number;
  dataset_id: string;
  /** The data-plane version tag the run was given. */
  version: string;
  recipe: string;
  recipe_version: string;
  input: "bids" | "zarr";
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

type BytesRead = { kind: "ok"; bytes: Uint8Array } | { kind: "absent" } | { kind: "too_large" };

async function readBounded(bucket: R2Bucket, key: string, max: number): Promise<BytesRead> {
  const head = await bucket.head(key);
  if (!head) return { kind: "absent" };
  if (head.size > max) return { kind: "too_large" };
  const object = await bucket.get(key);
  if (!object) return { kind: "absent" };
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength > max) return { kind: "too_large" };
  return { kind: "ok", bytes };
}

/** Text as an R2 object's `text()` reads it: UTF-8, a byte order mark dropped, a bad sequence replaced. */
const LENIENT_UTF8 = new TextDecoder();
const textOf = (bytes: Uint8Array): string => LENIENT_UTF8.decode(bytes);

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

/**
 * Reconcile the ended runs and the pending `stored` rows, at most `limit` of each, each in its own
 * try/catch. Never changes a stamp; once a run is reconciled no report moves a count. Idempotent: a second
 * caller's gate finds the run reconciled and writes nothing, and is not counted.
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
      else if (outcome.won) result.reconciled++;
    } catch (err) {
      console.error(`${LOG} reconcile_failed stamp=${stamp.id} class=${errClass(err)}`);
      result.errored++;
    }
  }
  let pending: StoredPending[] = [];
  try {
    pending = (await db.prepare(STORED_PENDING_SQL).bind(limit).all<StoredPending>()).results;
  } catch (err) {
    console.error(`${LOG} stored_read_failed class=${errClass(err)}`);
    result.errored++;
  }
  for (const p of pending) {
    try {
      if (await resolveStored(db, p)) result.reconciled++;
    } catch (err) {
      console.error(`${LOG} stored_failed stamp=${p.stamp_id} class=${errClass(err)}`);
      result.errored++;
    }
  }
  return result;
}

/**
 * The completed signalJourney link of a succeeded run's dataset record, kept on its run row (migration
 * 0154) as JSON, or null, or `later`:
 *  - a failed stamp: null (the run ended without a record NEMAR shows; a failed run is never promoted);
 *  - a succeeded stamp of a known recipe: the `completed` link built from its record, which needs no
 *    checkpoint map; a record that cannot make one keeps none (`link_not_written reason=record_unlinkable`);
 *  - a succeeded stamp of a recipe the registry does not know: nothing to read, none kept
 *    (`link_not_written reason=recipe_unknown`).
 */
async function runLink(
  env: Bindings,
  stamp: CandidateRow,
  /** The record, when the caller has read it already. */
  read?: BytesRead,
): Promise<string | null | "later"> {
  if (stamp.state === "failed") return null;
  const recipe = findRecipe(stamp.recipe);
  if (!recipe) {
    console.log(`${LOG} link_not_written stamp=${stamp.id} reason=recipe_unknown`);
    return null;
  }
  const results = env.COMPUTE_RESULTS;
  if (!results) {
    console.log(`${LOG} reconcile_later stamp=${stamp.id} reason=results_unbound`);
    return "later";
  }
  const location = recipeRequiredOutputs(recipe).record;
  let record: BytesRead;
  if (read !== undefined) {
    record = read;
  } else {
    const fresh = await readRunRecord(results, stamp, recipe);
    if (fresh === "later") return "later";
    record = fresh;
  }
  const link =
    record.kind === "ok"
      ? signalJourneyLink({
          recipeVersion: stamp.recipe_version,
          status: "completed",
          location: location.slice(RECIPE_PRODUCT_OUTPUT_PREFIX.length),
          sha256: await sha256HexOfBytes(record.bytes),
          sjVersion: sjVersionOf(textOf(record.bytes)),
        })
      : null;
  if (link === null) {
    console.log(`${LOG} link_not_written stamp=${stamp.id} reason=record_unlinkable`);
    return null;
  }
  return JSON.stringify(link);
}

/** A run's dataset record (bounded), or `later` when the results bucket did not answer. */
async function readRunRecord(
  results: R2Bucket,
  stamp: CandidateRow,
  recipe: Pick<ComputeRecipe, "name">,
): Promise<BytesRead | "later"> {
  try {
    return await readBounded(
      results,
      resultsOutputKey(stamp.job_id, recipeRequiredOutputs(recipe).record),
      RECORD_READ_MAX_BYTES,
    );
  } catch {
    console.log(`${LOG} reconcile_later stamp=${stamp.id} reason=read_failed`);
    return "later";
  }
}

/** A recordings table's own counts: its rows by status, and every row (the run's `total`). */
function statusCounts(rows: readonly RecordingRow[]): ProgressCheckpointCounts {
  const of = (status: RecordingRow["status"]) => rows.filter((r) => r.status === status).length;
  return {
    passed: of("succeeded"),
    failed: of("failed"),
    skipped: of("skipped"),
    total: rows.length,
  };
}

/**
 * The dataset quality summary of a succeeded run (ADR 0137 decision 8), or null when none is kept, or
 * `later`: the recipe's `desc-<label>_dataquality.json`, checked by `checkDatasetQualityDocument` against
 * the stamp, the digest of the dataset record read for the run's link and the recordings table read for
 * its counts. A summary that is missing or refused is not kept, with a fixed-word log line
 * (`quality_not_written reason=<word>`), and never holds the reconciliation back.
 */
async function qualityDocumentStatement(
  db: D1Database,
  results: R2Bucket,
  stamp: CandidateRow,
  recipe: ComputeRecipe,
  checkpoints: readonly RecipeCheckpoint[],
  writeId: string,
  rows: readonly RecordingRow[],
  record: BytesRead,
): Promise<D1PreparedStatement | null | "later"> {
  const notWritten = (reason: string): null => {
    console.log(`${LOG} quality_not_written stamp=${stamp.id} reason=${reason}`);
    return null;
  };
  if (record.kind === "absent") return notWritten("record_missing");
  if (record.kind === "too_large") return notWritten("record_too_large");
  let document: BytesRead;
  try {
    document = await readBounded(
      results,
      resultsOutputKey(stamp.job_id, recipeQualityDocumentPath(recipe)),
      DATA_QUALITY_MAX_BYTES,
    );
  } catch {
    console.log(`${LOG} reconcile_later stamp=${stamp.id} reason=read_failed`);
    return "later";
  }
  if (document.kind === "absent") return notWritten("document_missing");
  if (document.kind === "too_large") return notWritten("document_too_large");
  const check = checkDatasetQualityDocument(document.bytes, {
    stamp: {
      recipe: stamp.recipe,
      recipeVersion: stamp.recipe_version,
      version: stamp.version,
      input: stamp.input,
    },
    plugins: recipeQualityPlugins({ checkpoints }),
    recordSha256: await sha256HexOfBytes(record.bytes),
    counts: statusCounts(rows),
  });
  if (!check.ok) return notWritten(check.reason);
  return db
    .prepare(QUALITY_DOCUMENT_SQL)
    .bind(
      stamp.id,
      stamp.dataset_id,
      stamp.recipe,
      check.entryText,
      check.entry.record_sha256,
      writeId,
    );
}

/**
 * An outcome with no counts: the run row, with the run's link (`runLink`) when a succeeded run's record
 * makes one, so a promoted run of a version the registry no longer maps still shows its link.
 */
async function outcomeOnly(
  env: Bindings,
  stamp: CandidateRow,
  outcome: ReconcileOutcome,
): Promise<{ outcome: ReconcileOutcome; won: boolean } | "later"> {
  const db = env.DB;
  const link = await runLink(env, stamp);
  if (link === "later") return "later";
  const done = await db.batch([
    db
      .prepare(RECONCILE_GATE_SQL)
      .bind(stamp.id, stamp.job_id, randomHex(16), outcome, 0, stamp.recipe_version, null, link),
  ]);
  return { outcome, won: (done[0]?.meta?.changes ?? 0) === 1 };
}

/** Reconcile one ended run from its recordings table; `later` when the results bucket cannot be read. */
async function reconcileRun(
  env: Bindings,
  stamp: CandidateRow,
): Promise<{ outcome: ReconcileOutcome; won: boolean } | "later"> {
  const db = env.DB;
  const recipe = findRecipe(stamp.recipe);
  if (!recipe) return outcomeOnly(env, stamp, "recipe_unknown");
  const checkpoints = recipeCheckpointMap(stamp.recipe, stamp.recipe_version);
  if (!checkpoints) return outcomeOnly(env, stamp, "no_checkpoint_map");
  const results = env.COMPUTE_RESULTS;
  if (!results) {
    console.log(`${LOG} reconcile_later stamp=${stamp.id} reason=results_unbound`);
    return "later";
  }
  const wanted = recipeRequiredOutputs(recipe);
  let table: BytesRead;
  try {
    table = await readBounded(
      results,
      resultsOutputKey(stamp.job_id, wanted.table),
      TABLE_READ_MAX_BYTES,
    );
  } catch {
    console.log(`${LOG} reconcile_later stamp=${stamp.id} reason=read_failed`);
    return "later";
  }
  if (table.kind === "absent") return outcomeOnly(env, stamp, "table_missing");
  const parsed = table.kind === "ok" ? parseRecordingsTable(textOf(table.bytes)) : null;
  if (!parsed || !parsed.ok) return outcomeOnly(env, stamp, "table_unreadable");
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
  const declared = declaredCheckpoints({ checkpoints });

  // `stored`: a failed run stored nothing; a succeeded run waits for the derivative store.
  const last = counts[checkpoints[checkpoints.length - 1].checkpoint];
  const storedFinal = stamp.state === "failed";
  const stored: ProgressCheckpointCounts = storedFinal
    ? storedCounts("none", last.passed, total)
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

  // The run's link, kept on its run row: completed with the record's digest and version, or none. A
  // succeeded run's record is read once, for its link and for the digest its quality summary must name.
  let record: BytesRead | undefined;
  if (stamp.state === "succeeded") {
    const read = await readRunRecord(results, stamp, recipe);
    if (read === "later") return "later";
    record = read;
  }
  const link = await runLink(env, stamp, record);
  if (link === "later") return "later";
  if (record !== undefined) {
    const quality = await qualityDocumentStatement(
      db,
      results,
      stamp,
      recipe,
      checkpoints,
      writeId,
      rows,
      record,
    );
    if (quality === "later") return "later";
    if (quality !== null) statements.push(quality);
  }
  // The gate goes first; its disagreement is known only now, so it is built last and put in front.
  statements.unshift(
    db
      .prepare(RECONCILE_GATE_SQL)
      .bind(
        stamp.id,
        stamp.job_id,
        writeId,
        "reconciled",
        disagreement,
        stamp.recipe_version,
        JSON.stringify(declared),
        link,
      ),
  );
  const done = await db.batch(statements);
  return { outcome: "reconciled", won: (done[0]?.meta?.changes ?? 0) === 1 };
}

interface StoredPending {
  stamp_id: number;
  declared: string | null;
  derivative_state: string | null;
  stored_at: string | null;
}

/**
 * The pending `stored` rows whose derivative is decided, with the declared order the run recorded when it
 * was reconciled (never the live registry), and what decided the derivative.
 */
export const STORED_PENDING_SQL = `SELECT p.stamp_id, r.declared, d.state AS derivative_state, d.stored_at
  FROM compute_pipeline_progress p
  JOIN compute_pipeline_progress_runs r ON r.stamp_id = p.stamp_id
  LEFT JOIN compute_derivatives d ON d.stamp_id = p.stamp_id
  WHERE p.checkpoint = 'stored' AND p.reconciled = 0
    AND (d.state IN ('stored', 'failed', 'expired')
      OR EXISTS (SELECT 1 FROM compute_derivative_skips k WHERE k.stamp_id = p.stamp_id))
  ORDER BY p.stamp_id ASC LIMIT ?1`;

/** Claim a pending `stored` row for this write: ?1 stamp, ?2 write id. */
export const STORED_CLAIM_SQL = `UPDATE compute_pipeline_progress_runs SET write_id = ?2
  WHERE stamp_id = ?1 AND EXISTS (SELECT 1 FROM compute_pipeline_progress
    WHERE stamp_id = ?1 AND checkpoint = 'stored' AND reconciled = 0)`;

/** The `stored` row reconciled, where the write id stands. ?1 stamp, ?2-?4 passed, failed, skipped, ?5 write id. */
export const STORED_RESOLVE_SQL = `UPDATE compute_pipeline_progress
    SET passed = ?2, failed = ?3, skipped = ?4, reconciled = 1
  WHERE stamp_id = ?1 AND checkpoint = 'stored' AND reconciled = 0 AND ${BY_WRITE("?1", "?5")}`;

/** Read a declared list the run recorded; null when it is not a list of words. */
function declaredOf(text: string | null): string[] | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as unknown;
    if (!Array.isArray(v) || v.length < 2 || !v.every((x) => typeof x === "string")) return null;
    return v as string[];
  } catch {
    return null;
  }
}

/**
 * Resolve one pending `stored` row from the derivative store (`storedCounts`, from the passed count of the
 * last checkpoint the run declared). A row whose declared order or last checkpoint cannot be read is still
 * resolved, as if nothing passed, with a fixed-word log line, so it never blocks the rows behind it. True
 * when this call resolved it.
 */
async function resolveStored(db: D1Database, p: StoredPending): Promise<boolean> {
  const rows = (
    await db
      .prepare(
        "SELECT checkpoint, passed, failed, skipped, total FROM compute_pipeline_progress WHERE stamp_id = ?1",
      )
      .bind(p.stamp_id)
      .all<CountsRow>()
  ).results;
  const byName = new Map(rows.map((r) => [r.checkpoint, r]));
  const declared = declaredOf(p.declared);
  const lastName = declared ? declared[declared.length - 2] : undefined;
  const last = lastName === undefined ? undefined : byName.get(lastName);
  if (last === undefined) {
    console.log(
      `${LOG} stored_without_order stamp=${p.stamp_id} reason=${declared === null ? "no_declared_order" : "keys_differ"}`,
    );
  }
  const storedRow = byName.get(STORED_CHECKPOINT);
  const total = storedRow?.total ?? last?.total ?? 0;
  const decision: StoredDecision =
    p.derivative_state === "stored" || (p.derivative_state === "expired" && p.stored_at !== null)
      ? "kept"
      : p.derivative_state === "failed"
        ? "lost"
        : "none";
  const stored = storedCounts(decision, last?.passed ?? 0, total);
  const writeId = randomHex(16);
  const done = await db.batch([
    db.prepare(STORED_CLAIM_SQL).bind(p.stamp_id, writeId),
    db
      .prepare(STORED_RESOLVE_SQL)
      .bind(p.stamp_id, stored.passed, stored.failed, stored.skipped, writeId),
  ]);
  return (done[1]?.meta?.changes ?? 0) === 1;
}
