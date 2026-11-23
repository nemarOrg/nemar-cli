/**
 * The live progress contract, `nemar.progress.v1` (ADR 0134 decision 3, epic #2324 phase 2): the one
 * closed object a pipeline job reports while it runs, through the runner heartbeat (`progress`) or,
 * for a job on the supercomputer, as the body of `POST /compute/jobs/:id/progress` under its job
 * token. Every word, number and shape is declared once here.
 *
 * THE JSON SCHEMA NEXT TO THIS FILE (`compute-progress.schema.json`) IS COPIED BYTE FOR BYTE BY
 * `nemarOrg/nemar-process` (phase 3), whose launcher builds the object. `test/compute-progress-contract
 * .unit.test.ts` holds the two to each other, and holds each checkpoint's counts to neuroschema's
 * `definitions/checkpointCounts.schema.json`, so live and final counts differ only in transport.
 *
 * The object is a transport message, not metadata. It carries counts and a capped list of recent
 * failures (a relative path, a failure word, the step and the checkpoint), never samples, free text or
 * personal data. It is closed (`.strict()`), because the Worker validates it as it arrives and a
 * mistyped key is a bug to refuse. Like `./compute-runner.ts`, this file is exempted by name in
 * `test/contract-schemas.test.ts`.
 *
 * Rules no schema can state are in `progressProblem` in `../compute-checkpoints.ts`: the counts name
 * exactly the recipe version's declared checkpoints (without `stored`, which only the backend sets),
 * no column counts more than its total, every column has the same total, and each failure names a
 * declared checkpoint that counts at least as many failures as the list holds for it.
 *
 * A runner validates its progress before it attaches it to a heartbeat: a heartbeat whose `progress`
 * breaks this schema is `invalid_body` and does not renew the lease. On `invalid_body` it retries the
 * heartbeat without `progress`.
 *
 * Nothing here reads a clock, a database or a network.
 */

import { z } from "zod";

/** The format word every progress object carries; a later version is refused by name. */
export const PROGRESS_FORMAT = "nemar.progress.v1";

/** How often a launcher reports, in seconds. */
export const PROGRESS_REPORT_SECONDS = 60;

/**
 * The shortest interval the Worker accepts between two reports of one run, in seconds: a little under
 * {@link PROGRESS_REPORT_SECONDS}, so clock jitter never refuses an on-time report.
 */
export const PROGRESS_MIN_INTERVAL_SECONDS = 50;

/** A run with no report for this many cadences shows as stalled. */
export const PROGRESS_STALLED_CADENCES = 3;

/** The most checkpoints one report may count. */
export const PROGRESS_MAX_CHECKPOINTS = 8;

/** The most failures one report may list. */
export const PROGRESS_MAX_FAILURES = 10;

/** The longest relative path a failure may name. */
export const PROGRESS_PATH_MAX = 256;

/** The most recordings a count may hold. */
export const PROGRESS_MAX_RECORDINGS = 1_000_000;

/** The largest serialized progress object, in bytes (UTF-8); the largest valid object fits. */
export const PROGRESS_MAX_BYTES = 8192;

/** The largest request body the job-token progress route reads, in bytes. */
export const PROGRESS_BODY_MAX_BYTES = 16_384;

/** A checkpoint's name: neuroschema `processingTypes` `checkpointName`. */
export const PROGRESS_CHECKPOINT_RE = /^[a-z][a-z0-9_]{0,31}(?![\s\S])/;

/** A failure word: neuroschema `processingTypes` `failureCode`. */
export const PROGRESS_FAILURE_CODE_RE = /^[a-z][a-z0-9_]{0,63}(?![\s\S])/;

/** A recipe step: neuroschema `processingTypes` `stepId`. */
export const PROGRESS_STEP_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}(?![\s\S])/;

/**
 * A recording's relative path: printable ASCII without a backslash, no leading slash, no URI scheme
 * and no `..` segment (neuroschema `relativeLocation`, narrowed to ASCII so every validator counts its
 * length alike). A launcher leaves out a failure whose path it cannot write this way.
 */
export const PROGRESS_PATH_RE =
  /^(?!\/)(?![A-Za-z][A-Za-z0-9+.-]*:)(?!(?:[\s\S]*\/)?\.\.(?:\/|(?![\s\S])))[\x20-\x5B\x5D-\x7E]{1,256}(?![\s\S])/;

const count = z.number().int().min(0).max(PROGRESS_MAX_RECORDINGS);

/** One checkpoint's counts: the shape of neuroschema `checkpointCounts`. */
export const ProgressCheckpointCountsSchema = z
  .object({ passed: count, failed: count, skipped: count, total: count })
  .strict();

/** One failed or skipped recording. */
export const ProgressFailureSchema = z
  .object({
    path: z.string().max(PROGRESS_PATH_MAX).regex(PROGRESS_PATH_RE),
    code: z.string().regex(PROGRESS_FAILURE_CODE_RE),
    step: z.string().regex(PROGRESS_STEP_RE).nullable(),
    checkpoint: z.string().regex(PROGRESS_CHECKPOINT_RE),
  })
  .strict();

const countsRecord = z
  .record(z.string().regex(PROGRESS_CHECKPOINT_RE), ProgressCheckpointCountsSchema)
  .refine((o) => {
    const n = Object.keys(o).length;
    return n >= 1 && n <= PROGRESS_MAX_CHECKPOINTS;
  }, `counts holds 1 to ${PROGRESS_MAX_CHECKPOINTS} checkpoints`);

/** The live progress object: the current checkpoint, the counts per checkpoint, recent failures. */
export const ProgressSchema = z
  .object({
    format: z.literal(PROGRESS_FORMAT),
    checkpoint: z.string().regex(PROGRESS_CHECKPOINT_RE),
    counts: countsRecord,
    failures: z.array(ProgressFailureSchema).max(PROGRESS_MAX_FAILURES),
  })
  .strict();

/** The answer to an accepted report. Open, like every response. */
export const ProgressReportResponseSchema = z.object({ ok: z.literal(true) }).passthrough();

export type ProgressCheckpointCounts = z.infer<typeof ProgressCheckpointCountsSchema>;
export type ProgressFailure = z.infer<typeof ProgressFailureSchema>;
export type Progress = z.infer<typeof ProgressSchema>;
export type ProgressReportResponse = z.infer<typeof ProgressReportResponseSchema>;
