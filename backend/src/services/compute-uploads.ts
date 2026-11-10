/**
 * The release of abandoned uploads (epic #2021 phase D3, #2024; ADR 0118, the amendment of this phase).
 *
 * A person's job with a code bundle is `uploading` from the moment its hold commits until the person
 * finalizes the upload. A job that stays there for over an hour (`COMPUTE_UPLOAD_WINDOW_SECONDS`, counted
 * from the job's creation, which is also when the upload address stops working at the latest) is failed
 * `upload_expired` and its hold released, so an abandoned upload never keeps a person's balance or a
 * live-job slot. `upload_expired` is the SUBMITTER's failure code (`SUBMITTER_FAILURE_CODES`), never the
 * platform's, and nothing is charged: the job never started.
 *
 * WHAT IT DOES NOT TOUCH. A job whose records are written (the upload was finalized and the job waits to
 * be submitted) is the 30-minute backstop's (`runComputeAdvanceCron`), which turns a job that waited past
 * the reservation wait into `submit_timeout`; a job with a Tapis job, a partner's job, and one with a
 * recorded cancel (the cancel sweep's) are left alone. The object the person uploaded stays in
 * `incoming/`, which the bucket's own rule empties after two days; nothing is deleted here.
 *
 * PRODUCTION ONLY, and deliberately NOT in `DEV_CRON_ALLOWLIST`: it moves the allocation ledger, and the
 * dev database shares real users. It refuses outside exact production by itself, reads no compute switch
 * (a hold must be released whether or not compute is on), and takes ten rows a tick (a page, in rotation
 * by the last examination, every row stamped BEFORE its step so one that cannot be ended goes to the back
 * of the line). One log line a tick, only when it changed or failed: counts and fixed words, never a job
 * id or a name. At ten rows a tick the cost is a few dozen database statements, far below the Worker's
 * subrequest allowance of 10,000 an invocation.
 */

import { COMPUTE_UPLOAD_WINDOW_SECONDS } from "../../../shared/contract/compute-submit.js";
import type { Bindings } from "../types/bindings.js";
import { type ComputeJobRow, LIVE_STATES_SQL, getJob } from "./compute-jobs.js";
import { STAMP_EXAMINED_SQL, endUploadExpired, errorClassName } from "./compute-lifecycle.js";
import { isExactProduction } from "./repull-switches.js";

/** Rows one tick takes at most. */
export const UPLOAD_EXPIRY_ROWS_PER_TICK = 10;

/** Minutes an upload may wait, from the job's creation. */
export const UPLOAD_WINDOW_MINUTES = COMPUTE_UPLOAD_WINDOW_SECONDS / 60;

/**
 * The rows to end: `uploading`, no Tapis job, records not written, no cancel recorded, not a partner's,
 * created more than the window ago; least recently examined first. The statement NAMES its index
 * (`INDEXED BY compute_jobs_examined`, the partial index of the live rows, which the state list below
 * implies): left to choose, the planner took `compute_jobs_created` or the unique index on `tapis_uuid`,
 * each of which walks rows that are not live. A live row is bounded by the owner's per-person limit, so
 * walking them is cheap. `compute-jobs-finalize.test.ts` holds the plan.
 */
export const ABANDONED_UPLOADS_SQL = `SELECT id FROM compute_jobs INDEXED BY compute_jobs_examined
  WHERE state IN (${LIVE_STATES_SQL}) AND state = 'uploading' AND tapis_uuid IS NULL
    AND records_written_at IS NULL AND cancel_requested_at IS NULL AND source <> 'partner'
    AND created_at < datetime('now', '-${UPLOAD_WINDOW_MINUTES} minutes')
  ORDER BY examined_at ASC, created_at ASC LIMIT ?1`;

/**
 * Whether the upload window of a job has closed: it is `uploading` (or still `created`) with its records
 * unwritten and was made more than {@link UPLOAD_WINDOW_MINUTES} ago. The window is the job's own clock,
 * decided from its creation time wherever it is asked (the submit's replay, the finalize), so it does
 * not depend on how often the release runs. A job whose upload was finalized is never past it.
 */
export function uploadWindowPassed(
  job: Pick<ComputeJobRow, "state" | "records_written_at" | "created_at">,
  nowMs: number = Date.now(),
): boolean {
  if (job.records_written_at !== null) return false;
  if (job.state !== "uploading" && job.state !== "created") return false;
  const raw = job.created_at.replace(" ", "T");
  const madeMs = Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(raw) ? raw : `${raw}Z`);
  return Number.isFinite(madeMs) && nowMs - madeMs > UPLOAD_WINDOW_MINUTES * 60_000;
}

export interface UploadExpiryResult {
  /** Rows taken this tick. */
  examined: number;
  /** Rows failed `upload_expired` with their holds released. */
  expired: number;
  /** Fixed words; never a message. */
  errors: string[];
  errorClass: string | null;
}

/**
 * One tick of the release. Null outside exact production, before anything is read or written. A row's
 * failure is a fixed word and the error's class and never stops the rest.
 */
export async function runUploadExpiryCron(env: Bindings): Promise<UploadExpiryResult | null> {
  if (!isExactProduction(env)) return null;
  const r: UploadExpiryResult = { examined: 0, expired: 0, errors: [], errorClass: null };
  try {
    const rows = (
      await env.DB.prepare(ABANDONED_UPLOADS_SQL).bind(UPLOAD_EXPIRY_ROWS_PER_TICK).all<{
        id: string;
      }>()
    ).results;
    r.examined = rows.length;
    for (const { id } of rows) {
      try {
        await env.DB.prepare(STAMP_EXAMINED_SQL).bind(id).run();
        const job = await getJob(env.DB, id);
        if (job && (await endUploadExpired(env, job))) r.expired++;
      } catch (err) {
        r.errors.push("row_failed");
        r.errorClass = errorClassName(err);
        console.error(`[compute-uploads] job ${id}: its release failed (${r.errorClass})`);
      }
    }
  } catch (err) {
    r.errors.push("tick_failed");
    r.errorClass = errorClassName(err);
  }
  return r;
}

/** The tick's one log line, or null when it took nothing and nothing failed. Counts and fixed words only. */
export function uploadExpiryLogLine(
  r: UploadExpiryResult,
): { level: "info" | "error"; line: string } | null {
  if (r.examined === 0 && r.errors.length === 0) return null;
  return {
    level: r.errors.length > 0 ? "error" : "info",
    line: `[compute-uploads] examined=${r.examined} expired=${r.expired} errors=${r.errors.length > 0 ? r.errors.join(",") : "none"}${r.errorClass === null ? "" : ` class=${r.errorClass}`}`,
  };
}
