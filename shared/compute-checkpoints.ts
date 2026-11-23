/**
 * The checkpoint counting rules of NEMAR's pipeline (ADR 0134 decisions 2 to 4, epic #2324 phase 2),
 * declared once: how a recordings-table row becomes an outcome at each checkpoint, how outcomes become
 * counts, the rules of a live progress object no schema can state, when the live counts disagree with
 * the reconciled ones, what a run shows to an operator (`stalled` included), and the neuroschema
 * `processing` and `signalJourney` entries the backend writes from the reconciled counts.
 *
 * `shared/contract/compute-progress-vectors.json` holds input rows and the outcomes and counts this
 * module gives for them; nemar-process (phase 3) replays the same vectors, so the launcher's live
 * counts and the backend's final counts differ only in transport.
 *
 * Pure: nothing here reads a clock, a database or a network. Every entry it builds is made of values
 * the registry and the counts give; no text from a job reaches one.
 */

import {
  type PipelineStampState,
  RECORD_STEP,
  type RecipeCheckpoint,
  STORED_CHECKPOINT,
} from "./compute-recipes.js";
import type { ComputeState } from "./compute-state.js";
import {
  PROGRESS_FAILURE_CODE_RE,
  PROGRESS_MAX_FAILURES,
  PROGRESS_MAX_RECORDINGS,
  PROGRESS_PATH_RE,
  PROGRESS_REPORT_SECONDS,
  PROGRESS_STALLED_CADENCES,
  PROGRESS_STEP_RE,
  type Progress,
  type ProgressCheckpointCounts,
  type ProgressFailure,
} from "./contract/compute-progress.js";

// --- The recordings table -------------------------------------------------------------------------

/** A row's status in the recordings table a recipe writes. */
export const RECORDING_STATUSES = ["succeeded", "failed", "skipped"] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

/** The columns the counting rules read; the table has more, which are ignored. */
export const RECORDINGS_TABLE_COLUMNS = ["path", "status", "code", "step"] as const;

/** The code of a recording a killed run discovered but never wrote a row for. */
export const NOT_RUN_CODE = "not_run";

/** One row of the recordings table, as the counting rules read it: `n/a` is null. */
export interface RecordingRow {
  path: string;
  status: RecordingStatus;
  code: string | null;
  step: string | null;
}

/** Why a recordings table cannot be read. */
export type TableReadProblem =
  | "empty_table"
  | "missing_column"
  | "row_width"
  | "bad_status"
  | "missing_code"
  | "too_many_rows";

export type TableRead =
  | { ok: true; rows: RecordingRow[] }
  | { ok: false; reason: TableReadProblem };

const NA = "n/a";
const naToNull = (v: string): string | null => (v === NA || v === "" ? null : v);

/**
 * Read a recordings table (tab-separated, a header row, `n/a` for an empty cell; CRLF tolerated). A
 * missing column, a row of the wrong width, a status that is not one of the three, a failed or skipped
 * row with no code, or more rows than `PROGRESS_MAX_RECORDINGS` is refused with a fixed reason.
 */
export function parseRecordingsTable(text: string): TableRead {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return { ok: false, reason: "empty_table" };
  const header = lines[0].split("\t");
  const index: Record<string, number> = {};
  for (const column of RECORDINGS_TABLE_COLUMNS) {
    const i = header.indexOf(column);
    if (i < 0) return { ok: false, reason: "missing_column" };
    index[column] = i;
  }
  if (lines.length - 1 > PROGRESS_MAX_RECORDINGS) return { ok: false, reason: "too_many_rows" };
  const rows: RecordingRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    if (cells.length !== header.length) return { ok: false, reason: "row_width" };
    const status = cells[index.status];
    if (!(RECORDING_STATUSES as readonly string[]).includes(status)) {
      return { ok: false, reason: "bad_status" };
    }
    const code = naToNull(cells[index.code]);
    if (status !== "succeeded" && code === null) return { ok: false, reason: "missing_code" };
    rows.push({
      path: cells[index.path],
      status: status as RecordingStatus,
      code: status === "succeeded" ? null : code,
      step: naToNull(cells[index.step]),
    });
  }
  return { ok: true, rows };
}

// --- Outcomes and counts --------------------------------------------------------------------------

export type CheckpointStatus = "passed" | "failed" | "skipped";

/** A recording's outcome at one checkpoint: neuroschema `processing` record-level `checkpointOutcome`. */
export interface CheckpointOutcome {
  status: CheckpointStatus;
  code: string | null;
  step: string | null;
}

/** A word that fits neuroschema's patterns, or null (a code or step the patterns refuse is not kept). */
const fit = (value: string | null, re: RegExp): string | null =>
  value !== null && re.test(value) ? value : null;

/**
 * A recording's outcome at each checkpoint the recipe declares (without `stored`), in order.
 *
 * - succeeded: passed everywhere.
 * - failed at a mapped step: passed before that step's checkpoint, failed at it, skipped after it with
 *   the same code and step.
 * - failed with no step, or a step the map does not know: failed at the first checkpoint (nothing is
 *   claimed passed that the table does not support), skipped after it.
 * - skipped with no step (or an unknown one): skipped everywhere.
 * - skipped at a mapped step: passed before that step's checkpoint, skipped from it on.
 *
 * The step `record` (the recipe writing its own record after its last step) counts against the last
 * declared checkpoint: everything before it passed.
 */
export function recordingOutcomes(
  row: RecordingRow,
  checkpoints: readonly RecipeCheckpoint[],
): CheckpointOutcome[] {
  const passed: CheckpointOutcome = { status: "passed", code: null, step: null };
  if (row.status === "succeeded") return checkpoints.map(() => ({ ...passed }));
  const at =
    row.step === null
      ? -1
      : row.step === RECORD_STEP
        ? checkpoints.length - 1
        : checkpoints.findIndex((c) => c.steps.includes(row.step ?? ""));
  const code = fit(row.code, PROGRESS_FAILURE_CODE_RE);
  const step = at >= 0 ? fit(row.step, PROGRESS_STEP_RE) : null;
  const first = row.status === "failed" ? Math.max(at, 0) : at;
  return checkpoints.map((_, i) => {
    if (first < 0 || i > first) return { status: "skipped", code, step };
    if (i < first) return { ...passed };
    return { status: row.status === "failed" ? "failed" : "skipped", code, step };
  });
}

/** The checkpoint a non-succeeded recording counts against first, or null for a succeeded one. */
export function firstCheckpointOf(
  row: RecordingRow,
  checkpoints: readonly RecipeCheckpoint[],
): string | null {
  const outcomes = recordingOutcomes(row, checkpoints);
  const i = outcomes.findIndex((o) => o.status !== "passed");
  return i < 0 ? null : checkpoints[i].checkpoint;
}

const zero = (total: number): ProgressCheckpointCounts => ({
  passed: 0,
  failed: 0,
  skipped: 0,
  total,
});

/**
 * Counts per checkpoint over the rows. `total` (at least the number of rows) is the number of
 * recordings the run discovered; a recording with no row (a killed run) is skipped at every checkpoint
 * with {@link NOT_RUN_CODE}.
 */
export function countRecordings(
  rows: readonly RecordingRow[],
  checkpoints: readonly RecipeCheckpoint[],
  total: number = rows.length,
): Record<string, ProgressCheckpointCounts> {
  const all = Math.max(total, rows.length);
  const counts: Record<string, ProgressCheckpointCounts> = {};
  for (const c of checkpoints) counts[c.checkpoint] = zero(all);
  for (const row of rows) {
    recordingOutcomes(row, checkpoints).forEach((o, i) => {
      counts[checkpoints[i].checkpoint][o.status] += 1;
    });
  }
  const missing = all - rows.length;
  for (const c of checkpoints) counts[c.checkpoint].skipped += missing;
  return counts;
}

/**
 * The first {@link PROGRESS_MAX_FAILURES} failed or skipped recordings of each checkpoint, in table
 * order, each counted against the checkpoint it first did not pass. A path the progress contract cannot
 * carry is left out.
 */
export function failuresByCheckpoint(
  rows: readonly RecordingRow[],
  checkpoints: readonly RecipeCheckpoint[],
): Record<string, ProgressFailure[]> {
  const out: Record<string, ProgressFailure[]> = {};
  for (const c of checkpoints) out[c.checkpoint] = [];
  for (const row of rows) {
    if (row.status === "succeeded" || !PROGRESS_PATH_RE.test(row.path)) continue;
    const outcomes = recordingOutcomes(row, checkpoints);
    const i = outcomes.findIndex((o) => o.status !== "passed");
    if (i < 0) continue;
    const name = checkpoints[i].checkpoint;
    const code = outcomes[i].code;
    if (code === null || out[name].length >= PROGRESS_MAX_FAILURES) continue;
    out[name].push({ path: row.path, code, step: outcomes[i].step, checkpoint: name });
  }
  return out;
}

// --- Live progress ---------------------------------------------------------------------------------

/** The words of {@link progressProblem}. */
export const PROGRESS_PROBLEMS = [
  "checkpoints_differ",
  "counts_over_total",
  "totals_differ",
  "checkpoint_unknown",
  "failure_checkpoint_differs",
  "failures_over_count",
] as const;
export type ProgressProblem = (typeof PROGRESS_PROBLEMS)[number];

/**
 * The rules of a live progress object no schema can state, against the recipe version's checkpoints:
 * the counts name exactly the declared checkpoints (without `stored`); no column counts more than its
 * total; every column has the same total; `checkpoint` is one of them; each failure names one of them;
 * and no checkpoint lists more failures than it counts as failed or skipped. Null when it holds.
 */
export function progressProblem(
  progress: Progress,
  checkpoints: readonly RecipeCheckpoint[],
): ProgressProblem | null {
  const declared: readonly string[] = checkpoints.map((c) => c.checkpoint);
  const keys = Object.keys(progress.counts);
  if (keys.length !== declared.length || !declared.every((d) => keys.includes(d))) {
    return "checkpoints_differ";
  }
  const columns = declared.map((d) => progress.counts[d]);
  if (columns.some((c) => c.passed + c.failed + c.skipped > c.total)) return "counts_over_total";
  if (columns.some((c) => c.total !== columns[0].total)) return "totals_differ";
  if (!declared.includes(progress.checkpoint)) return "checkpoint_unknown";
  if (progress.failures.some((f) => !declared.includes(f.checkpoint))) {
    return "failure_checkpoint_differs";
  }
  for (const d of declared) {
    const listed = progress.failures.filter((f) => f.checkpoint === d).length;
    const column = progress.counts[d];
    if (listed > column.failed + column.skipped) return "failures_over_count";
  }
  return null;
}

/**
 * Whether a run's last live counts disagree with its reconciled counts: the totals differ, or a live
 * count is larger than its final value. A correct reporter's last report lags (it never runs ahead),
 * so lag is not a disagreement and an excess is a broken reporter.
 */
export function liveDisagrees(
  live: ProgressCheckpointCounts,
  final: ProgressCheckpointCounts,
): boolean {
  return (
    live.total !== final.total ||
    live.passed > final.passed ||
    live.failed > final.failed ||
    live.skipped > final.skipped
  );
}

// --- What a run shows ------------------------------------------------------------------------------

/** What an operator sees for a pipeline run. */
export const PIPELINE_RUN_STATUSES = [
  "waiting",
  "running",
  "stalled",
  "finished",
  "failed",
] as const;
export type PipelineRunStatus = (typeof PIPELINE_RUN_STATUSES)[number];

/** A run with no report for this long shows as stalled: three report cadences. */
export const PIPELINE_STALLED_SECONDS = PROGRESS_STALLED_CADENCES * PROGRESS_REPORT_SECONDS;

/** The job states in which a pipeline job has not started running (`./compute-state.ts`). */
const WAITING_JOB_STATES: readonly ComputeState[] = ["created", "uploading", "submitted", "queued"];

/** The job states in which a silent run counts as stalled. */
export const STALLABLE_JOB_STATES: readonly ComputeState[] = ["submitted", "queued", "running"];

/**
 * What a run shows, from its stamp, its job and its last report. Never stored: it is worked out each time
 * it is read, and `PIPELINE_STALLED_SQL` in the backend states the same rule.
 *
 * - An ended stamp: `finished` or `failed`. A dispatched stamp whose job is terminal: the job's end.
 * - `stalled`: an `unreported` job, or a `submitted`, `queued` or `running` job whose last report is
 *   older than {@link PIPELINE_STALLED_SECONDS}. A job that never reported is never stalled (it may not
 *   follow the contract, ADR 0134 decision 8), and an `archiving` job is uploading, so `running`.
 * - `waiting`: a job that has not started and never reported; otherwise `running`.
 */
export function pipelineRunStatus(input: {
  stampState: PipelineStampState;
  jobState: ComputeState | null;
  /** Seconds since the epoch of the last report, or null. */
  reportedAt: number | null;
  /** Seconds since the epoch. */
  now: number;
}): PipelineRunStatus {
  if (input.stampState === "succeeded") return "finished";
  if (input.stampState === "failed" || input.stampState === "refused") return "failed";
  const job = input.jobState;
  if (job === "finished") return "finished";
  if (job === "failed" || job === "cancelled") return "failed";
  if (job === "unreported") return "stalled";
  if (
    job !== null &&
    STALLABLE_JOB_STATES.includes(job) &&
    input.reportedAt !== null &&
    input.now - input.reportedAt > PIPELINE_STALLED_SECONDS
  ) {
    return "stalled";
  }
  if (input.reportedAt === null && (job === null || WAITING_JOB_STATES.includes(job))) {
    return "waiting";
  }
  return "running";
}

// --- The neuroschema entries ----------------------------------------------------------------------

/** A dataset-level neuroschema `processing` entry for one recipe. */
export interface ProcessingDatasetEntry {
  recipe_version: string;
  declared_checkpoints: string[];
  counts: Record<string, ProgressCheckpointCounts>;
}

/**
 * Build the dataset-level `processing` entry of a recipe run from its reconciled counts, over the
 * declared checkpoints in order (`stored` last), or null when a declared checkpoint has no counts.
 */
export function processingDatasetEntry(input: {
  recipeVersion: string;
  declared: readonly string[];
  counts: Readonly<Record<string, ProgressCheckpointCounts | undefined>>;
}): ProcessingDatasetEntry | null {
  const counts: Record<string, ProgressCheckpointCounts> = {};
  for (const d of input.declared) {
    const c = input.counts[d];
    if (!c) return null;
    counts[d] = { passed: c.passed, failed: c.failed, skipped: c.skipped, total: c.total };
  }
  return { recipe_version: input.recipeVersion, declared_checkpoints: [...input.declared], counts };
}

/** The words of {@link processingEntryProblem}. */
export const PROCESSING_ENTRY_PROBLEMS = [
  "keys_differ",
  "sums_differ",
  "totals_differ",
  "cascade_broken",
] as const;

/**
 * The writer's rules for a reconciled `processing` entry (neuroschema docs/processing-extensions.md):
 * the counts' keys equal `declared_checkpoints`; every column sums to its total; every total is equal;
 * along the declared order no column passes more than the one before it. Null when it holds.
 */
export function processingEntryProblem(
  entry: ProcessingDatasetEntry,
): (typeof PROCESSING_ENTRY_PROBLEMS)[number] | null {
  const keys = Object.keys(entry.counts);
  if (
    keys.length !== entry.declared_checkpoints.length ||
    !entry.declared_checkpoints.every((d) => keys.includes(d))
  ) {
    return "keys_differ";
  }
  const columns = entry.declared_checkpoints.map((d) => entry.counts[d]);
  if (columns.some((c) => c.passed + c.failed + c.skipped !== c.total)) return "sums_differ";
  if (columns.some((c) => c.total !== columns[0].total)) return "totals_differ";
  for (let i = 1; i < columns.length; i++) {
    if (columns[i].passed > columns[i - 1].passed) return "cascade_broken";
  }
  return null;
}

/** The status of a link to a run's signalJourney record. */
export type SignalJourneyStatus = "in_progress" | "completed" | "failed";

/** A neuroschema `signalJourney` link for one recipe. */
export interface SignalJourneyLink {
  recipe_version: string;
  processing_status: SignalJourneyStatus;
  location: string | null;
  sha256: string | null;
  sj_version: string | null;
}

const SHA256_RE = /^[0-9a-f]{64}(?![\s\S])/;
const SJ_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?![\s\S])/;

/**
 * Build a `signalJourney` link. `in_progress` and `failed` carry no record (location, digest and
 * version null); `completed` carries all three, and a value neuroschema would refuse makes it null.
 */
export function signalJourneyLink(input: {
  recipeVersion: string;
  status: SignalJourneyStatus;
  location?: string | null;
  sha256?: string | null;
  sjVersion?: string | null;
}): SignalJourneyLink | null {
  if (input.status !== "completed") {
    return {
      recipe_version: input.recipeVersion,
      processing_status: input.status,
      location: null,
      sha256: null,
      sj_version: null,
    };
  }
  const location = input.location ?? null;
  const sha256 = input.sha256 ?? null;
  const sjVersion = input.sjVersion ?? null;
  if (
    location === null ||
    !PROGRESS_PATH_RE.test(location) ||
    sha256 === null ||
    !SHA256_RE.test(sha256) ||
    sjVersion === null ||
    !SJ_VERSION_RE.test(sjVersion)
  ) {
    return null;
  }
  return {
    recipe_version: input.recipeVersion,
    processing_status: "completed",
    location,
    sha256,
    sj_version: sjVersion,
  };
}
