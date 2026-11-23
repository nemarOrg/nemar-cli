/**
 * Live progress of NEMAR's pipeline runs (ADR 0134 decisions 3 and 4, epic #2324 phase 2): one write
 * path for a report, shared by the runner heartbeat and the job-token route of a job on the supercomputer,
 * and the reconciliation that replaces live counts with final ones when a run ends.
 *
 *   `stampForJob`                 the dispatched pipeline stamp of a job and its recipe's checkpoint map
 *   `recordProgress`              one guarded batch that stores a report, or writes nothing
 *   `reconcilePipelineProgress`   ended runs reconciled from their recordings tables, `stored` resolved
 *   `liveSignalJourneyLinks`      the `in_progress` links of a dataset's reporting runs, worked out on read
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
 * NOTHING LIVE IS A DOCUMENT. `compute_pipeline_documents` holds only final entries of ended runs. A
 * running job's `in_progress` link is worked out when `metadata.json` is read, so a run that ends without a
 * link of its own never leaves one standing and a new run never erases the last completed link.
 *
 * Every value written is a count, a checkpoint the registry declares, a capped failure list that already
 * passed the closed schema and `progressProblem`, or an entry the shared builders made from registry values
 * and digests; no other text from a job reaches a row.
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
  declaredCheckpoints,
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
    OR (j.state IN ('submitted', 'queued', 'running') AND r.reported_at IS NOT NULL
      AND r.reported_at < datetime('now', '-180 seconds'))))`;

/**
 * The `in_progress` links of a dataset's runs that are reporting now: a dispatched stamp whose run has
 * reported and is not reconciled. Worked out on read; never stored.
 */
export const LIVE_LINKS_SQL = `SELECT s.recipe, s.recipe_version
  FROM compute_pipeline_stamps s
  JOIN compute_pipeline_progress_runs r ON r.stamp_id = s.id
  WHERE s.dataset_id = ?1 AND s.state = 'dispatched' AND r.reconciled_at IS NULL
  ORDER BY s.id ASC`;

export async function liveSignalJourneyLinks(
  db: D1Database,
  datasetId: string,
): Promise<Record<string, unknown>> {
  const rows = (
    await db
      .prepare(LIVE_LINKS_SQL)
      .bind(datasetId)
      .all<{ recipe: string; recipe_version: string }>()
  ).results;
  const links: Record<string, unknown> = {};
  for (const r of rows) {
    links[r.recipe] = signalJourneyLink({ recipeVersion: r.recipe_version, status: "in_progress" });
  }
  return links;
}

// --- Reconciliation ---------------------------------------------------------------------------------

/**
 * The refusal word of a hold stamp (`TUPLE_MISMATCH_WORD` of ./compute-pipeline.ts, which imports this
 * module; `compute-progress-reconcile.test.ts` holds the two equal).
 */
export const HOLD_STAMP_WORD = "tuple_mismatch";

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
export const RECONCILE_CANDIDATES_SQL = `SELECT s.id, s.dataset_id, s.recipe, s.recipe_version, s.state, s.job_id
  FROM compute_pipeline_stamps s
  LEFT JOIN compute_pipeline_progress_runs r ON r.stamp_id = s.id
  WHERE s.state IN ('succeeded', 'failed') AND s.job_id IS NOT NULL
    AND (r.stamp_id IS NULL OR r.reconciled_at IS NULL)
    AND NOT (s.refusal_code IS NOT NULL AND s.refusal_code = '${HOLD_STAMP_WORD}'
      AND EXISTS (SELECT 1 FROM compute_pipeline_stamps o WHERE o.job_id = s.job_id AND o.id <> s.id))
  ORDER BY s.updated_at ASC, s.id ASC LIMIT ?1`;

/**
 * THE RECONCILE GATE: the run row given its outcome, the recipe version and the declared checkpoints,
 * only while it has no outcome. ?1 stamp, ?2 job, ?3 write id, ?4 outcome, ?5 disagreement, ?6 recipe
 * version, ?7 declared (JSON list or null). Every later statement writes only where the write id stands.
 */
export const RECONCILE_GATE_SQL = `INSERT INTO compute_pipeline_progress_runs
    (stamp_id, job_id, write_id, reconciled_at, outcome, disagreement, recipe_version, declared)
  VALUES (?1, ?2, ?3, datetime('now'), ?4, ?5, ?6, ?7)
  ON CONFLICT(stamp_id) DO UPDATE SET
    write_id = excluded.write_id, reconciled_at = excluded.reconciled_at,
    outcome = excluded.outcome, disagreement = excluded.disagreement,
    recipe_version = excluded.recipe_version, declared = excluded.declared
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
 * A dataset's final document of one namespace and recipe, only where the write id stands: the newest
 * stamp wins, the same stamp may write again. ?1 dataset, ?2 namespace, ?3 recipe, ?4 stamp, ?5 entry,
 * ?6 write id.
 */
export const FINAL_DOCUMENT_SQL = `INSERT INTO compute_pipeline_documents
    (dataset_id, namespace, recipe, stamp_id, entry, written_at)
  SELECT ?1, ?2, ?3, ?4, ?5, datetime('now') WHERE ${BY_WRITE("?4", "?6")}
  ON CONFLICT(dataset_id, namespace, recipe) DO UPDATE SET
    stamp_id = excluded.stamp_id, entry = excluded.entry, written_at = excluded.written_at
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

/** A failed link, final: the run ended without a record NEMAR can point to. */
const failedLinkStatement = (db: D1Database, stamp: CandidateRow, writeId: string) =>
  db
    .prepare(FINAL_DOCUMENT_SQL)
    .bind(
      stamp.dataset_id,
      "signalJourney",
      stamp.recipe,
      stamp.id,
      JSON.stringify(signalJourneyLink({ recipeVersion: stamp.recipe_version, status: "failed" })),
      writeId,
    );

/** An outcome with no counts: the run row and a final failed link. */
async function outcomeOnly(
  db: D1Database,
  stamp: CandidateRow,
  outcome: ReconcileOutcome,
): Promise<{ outcome: ReconcileOutcome; won: boolean }> {
  const writeId = randomHex(16);
  const done = await db.batch([
    db
      .prepare(RECONCILE_GATE_SQL)
      .bind(stamp.id, stamp.job_id, writeId, outcome, 0, stamp.recipe_version, null),
    failedLinkStatement(db, stamp, writeId),
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
  if (!recipe) return outcomeOnly(db, stamp, "recipe_unknown");
  const checkpoints = recipeCheckpointMap(stamp.recipe, stamp.recipe_version);
  if (!checkpoints) return outcomeOnly(db, stamp, "no_checkpoint_map");
  const results = env.COMPUTE_RESULTS;
  if (!results) {
    console.log(`${LOG} reconcile_later stamp=${stamp.id} reason=results_unbound`);
    return "later";
  }
  const wanted = recipeRequiredOutputs(recipe);
  let table: TextRead;
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
  if (table.kind === "absent") return outcomeOnly(db, stamp, "table_missing");
  const parsed = table.kind === "ok" ? parseRecordingsTable(table.text) : null;
  if (!parsed || !parsed.ok) return outcomeOnly(db, stamp, "table_unreadable");
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

  // The signalJourney link: completed with the record's digest and version; failed for a failed run; for
  // a succeeded run whose link cannot be built, the last final link stands.
  if (stamp.state === "failed") {
    statements.push(failedLinkStatement(db, stamp, writeId));
  } else {
    let record: TextRead;
    try {
      record = await readBounded(
        results,
        resultsOutputKey(stamp.job_id, wanted.record),
        RECORD_READ_MAX_BYTES,
      );
    } catch {
      console.log(`${LOG} reconcile_later stamp=${stamp.id} reason=read_failed`);
      return "later";
    }
    const link =
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
      console.log(`${LOG} link_not_written stamp=${stamp.id} reason=record_unlinkable`);
    } else {
      statements.push(
        db
          .prepare(FINAL_DOCUMENT_SQL)
          .bind(
            stamp.dataset_id,
            "signalJourney",
            stamp.recipe,
            stamp.id,
            JSON.stringify(link),
            writeId,
          ),
      );
    }
  }
  if (storedFinal) {
    const entry = processingDatasetEntry({
      recipeVersion: stamp.recipe_version,
      declared,
      counts: { ...counts, [STORED_CHECKPOINT]: stored },
    });
    const problem = entry === null ? "keys_differ" : processingEntryProblem(entry);
    if (entry !== null && problem === null) {
      statements.push(
        db
          .prepare(FINAL_DOCUMENT_SQL)
          .bind(
            stamp.dataset_id,
            "processing",
            stamp.recipe,
            stamp.id,
            JSON.stringify(entry),
            writeId,
          ),
      );
    } else {
      console.log(`${LOG} processing_not_written stamp=${stamp.id} reason=${problem}`);
    }
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
      ),
  );
  const done = await db.batch(statements);
  return { outcome: "reconciled", won: (done[0]?.meta?.changes ?? 0) === 1 };
}

interface StoredPending {
  stamp_id: number;
  dataset_id: string;
  recipe: string;
  recipe_version: string | null;
  declared: string | null;
  derivative_state: string | null;
  stored_at: string | null;
}

/**
 * The pending `stored` rows whose derivative is decided, with the declared order and recipe version the
 * run recorded when it was reconciled (never the live registry), and what decided the derivative.
 */
export const STORED_PENDING_SQL = `SELECT p.stamp_id, s.dataset_id, s.recipe, r.recipe_version, r.declared,
    d.state AS derivative_state, d.stored_at
  FROM compute_pipeline_progress p
  JOIN compute_pipeline_stamps s ON s.id = p.stamp_id
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
 * Resolve one pending `stored` row from the derivative store and write its `processing` entry. A row that
 * cannot make an entry (no recorded order, a missing column, a broken rule) is still resolved, without a
 * document and with a fixed-word log line, so it never blocks the rows behind it. True when this call
 * resolved it.
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
  const storedRow = byName.get(STORED_CHECKPOINT);
  const total = storedRow?.total ?? last?.total ?? 0;
  const lastPassed = last?.passed ?? 0;
  const kept =
    p.derivative_state === "stored" || (p.derivative_state === "expired" && p.stored_at !== null);
  const lost = p.derivative_state === "failed";
  const stored: ProgressCheckpointCounts = kept
    ? { passed: lastPassed, failed: 0, skipped: total - lastPassed, total }
    : lost
      ? { passed: 0, failed: lastPassed, skipped: total - lastPassed, total }
      : { passed: 0, failed: 0, skipped: total, total };

  let reason: string | null = null;
  let entryText: string | null = null;
  if (declared === null || p.recipe_version === null) {
    reason = "no_declared_order";
  } else if (last === undefined) {
    reason = "keys_differ";
  } else {
    const counts: Record<string, ProgressCheckpointCounts | undefined> = Object.fromEntries(byName);
    counts[STORED_CHECKPOINT] = stored;
    const entry = processingDatasetEntry({ recipeVersion: p.recipe_version, declared, counts });
    reason = entry === null ? "keys_differ" : processingEntryProblem(entry);
    if (entry !== null && reason === null) entryText = JSON.stringify(entry);
  }

  const writeId = randomHex(16);
  const statements = [
    db.prepare(STORED_CLAIM_SQL).bind(p.stamp_id, writeId),
    db
      .prepare(STORED_RESOLVE_SQL)
      .bind(p.stamp_id, stored.passed, stored.failed, stored.skipped, writeId),
  ];
  if (entryText !== null) {
    statements.push(
      db
        .prepare(FINAL_DOCUMENT_SQL)
        .bind(p.dataset_id, "processing", p.recipe, p.stamp_id, entryText, writeId),
    );
  } else {
    console.log(`${LOG} processing_not_written stamp=${p.stamp_id} reason=${reason}`);
  }
  const done = await db.batch(statements);
  return (done[1]?.meta?.changes ?? 0) === 1;
}
