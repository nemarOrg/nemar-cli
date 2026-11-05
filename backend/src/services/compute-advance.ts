/**
 * The compute gateway's 30-minute tick (epic #2005 phase A5, #2010; ADR 0118): every 30 minutes, in
 * production only, take each live job one step on, retry what is owed to a finished one, and retry the
 * Tapis cancellations that people asked for.
 *
 *   `runComputeAdvanceCron`        the backstop for the webhook hints. For each live row it reads the
 *                                  job back from Tapis and applies it (`advanceComputeJob`), which
 *                                  submits a `created` job, follows a submitted one, marks one whose
 *                                  last good read is more than a day old `unreported`, and repairs a
 *                                  terminal row whose settlement or copy of its files is owed. It also
 *                                  clears the webhook nonce one day after a job is terminal, so the
 *                                  address a token in a URL belongs to stops working.
 *   `sweepComputeCancellations`    every live row with a recorded cancel is cancelled at Tapis, again
 *                                  and again until Tapis says it is over (a network call never runs
 *                                  inside a batch, so the batch records the intent and this retries).
 *
 * PRODUCTION ONLY, twice over: both are called only from the 30-minute tick's production block of
 * `scheduled()` and are absent from `DEV_CRON_ALLOWLIST`, and each refuses outside exact production by
 * itself (the dev database shares real users and the GitHub org, and development advances a job by its
 * webhook, by a read and by an administrator's command). Neither reads a switch, so a job that is
 * live is never stranded by turning compute off; the switch is read only where a job is submitted.
 * A database read of the live rows comes first: a Worker with no Tapis configuration and no jobs does
 * nothing at all.
 *
 * TEN ROWS A TICK in each of four lists (the live rows Tapis has accepted, the `created` rows still to
 * be submitted, the terminal rows owed a settlement, and those owed a copy of their files), each in
 * its own try and catch that records only a fixed word and the error's class, and one log line a tick
 * (counts and fixed words: no job output, token, name or path).
 *
 * THE ROTATION IS BY EXAMINATION, NOT BY SUCCESS. The two live lists are ordered by `examined_at`
 * (never-examined first), and every row a tick takes is stamped BEFORE its step runs, so a row that
 * cannot make progress (a job Tapis cannot be read for, a `created` job that cannot be submitted while
 * compute is off) goes to the back of the line like any other and never holds a slot for good. Ordered
 * by the last good read (`tapis_synced_at`), as the first version was, such rows kept the ten slots
 * and a healthy running job was never read. The two live lists do not share their quota, for the same
 * reason the terminal lists do not: no kind of row can starve another.
 *
 * COST. Each row costs about one Tapis read (a `created` row, a tag search and at most one submit)
 * with at most two attempts of at most ten seconds each (`TICK_READ`), plus bucket and database calls;
 * four lists of ten rows are well within the subrequest allowance this tick shares with the other jobs
 * on it. The Worker's reads on behalf of a request are one attempt of at most eight seconds.
 */

import { LIVE_COMPUTE_STATES } from "../../../shared/compute-state.js";
import type { Bindings } from "../types/bindings.js";
import {
  CLEAR_NONCES_SQL,
  STAMP_EXAMINED_SQL,
  TICK_READ,
  UNCOPIED_TERMINAL_SQL,
  UNSETTLED_TERMINAL_SQL,
  advanceComputeJob,
  driveCancel,
  errorClassName,
  retryOrphanCancel,
} from "./compute-lifecycle.js";
import { isExactProduction } from "./repull-switches.js";

/** Rows of each list one tick examines at most. */
export const ADVANCE_ROWS_PER_TICK = 10;

const LIVE_SQL = LIVE_COMPUTE_STATES.map((s) => `'${s}'`).join(", ");

/**
 * The live rows Tapis has accepted (a `tapis_uuid`), least recently EXAMINED first (a row never
 * examined comes first): NEMAR's own jobs, and a partner's once Tapis has accepted it.
 */
export const BOUND_ROWS_SQL = `SELECT id FROM compute_jobs
  WHERE state IN (${LIVE_SQL}) AND tapis_uuid IS NOT NULL
  ORDER BY COALESCE(examined_at, '') ASC, created_at ASC LIMIT ?1`;

/**
 * The `created` and `uploading` rows with no Tapis job, least recently examined first: the ones to be
 * submitted. A partner's reservation that has no Tapis job yet is the partner contract's, not this
 * tick's.
 */
export const CREATED_ROWS_SQL = `SELECT id FROM compute_jobs
  WHERE state IN ('created', 'uploading') AND tapis_uuid IS NULL AND source <> 'partner'
  ORDER BY COALESCE(examined_at, '') ASC, created_at ASC LIMIT ?1`;

/** Rows with a Tapis job NEMAR made that no row owns, whose cancel is still owed. */
export const ORPHAN_ROWS_SQL = `SELECT id FROM compute_jobs
  WHERE orphan_tapis_uuid IS NOT NULL ORDER BY COALESCE(examined_at, '') ASC LIMIT ?1`;

/** Live rows with a cancel recorded, oldest request first. */
export const CANCEL_ROWS_SQL = `SELECT id FROM compute_jobs
  WHERE state IN (${LIVE_SQL}) AND cancel_requested_at IS NOT NULL
  ORDER BY cancel_requested_at ASC LIMIT ?1`;

export interface ComputeTickResult {
  /** Live rows examined: the bound ones and the `created` ones. */
  examined: number;
  submitted: number;
  /** Rows that moved, were refreshed or ended. */
  advanced: number;
  /** Rows whose submit is waiting on something (a configuration, an upload, Tapis). */
  waiting: number;
  /** Rows Tapis could not be read for. */
  unreachable: number;
  /** Terminal rows whose settlement or copy was repaired. */
  repaired: number;
  /** Webhook nonces cleared. */
  cleared: number;
  /** Fixed words; never a message. */
  errors: string[];
  errorClass: string | null;
}

const emptyResult = (): ComputeTickResult => ({
  examined: 0,
  submitted: 0,
  advanced: 0,
  waiting: 0,
  unreachable: 0,
  repaired: 0,
  cleared: 0,
  errors: [],
  errorClass: null,
});

function tally(r: ComputeTickResult, outcome: string): void {
  switch (outcome) {
    case "submitted":
      r.submitted++;
      break;
    case "waiting":
      r.waiting++;
      break;
    case "unreachable":
      r.unreachable++;
      break;
    case "terminal":
      r.repaired++;
      break;
    case "advanced":
    case "refreshed":
    case "terminal_committed":
      r.advanced++;
      break;
    default:
      break;
  }
}

/**
 * One tick of the backstop. Null outside exact production, before anything is read or written. In
 * production it reads the live rows first and returns at once, having touched neither Tapis nor a
 * bucket, when there is nothing to do.
 */
export async function runComputeAdvanceCron(env: Bindings): Promise<ComputeTickResult | null> {
  if (!isExactProduction(env)) return null;
  const r = emptyResult();
  try {
    const bound = (
      await env.DB.prepare(BOUND_ROWS_SQL).bind(ADVANCE_ROWS_PER_TICK).all<{ id: string }>()
    ).results;
    const created = (
      await env.DB.prepare(CREATED_ROWS_SQL).bind(ADVANCE_ROWS_PER_TICK).all<{ id: string }>()
    ).results;
    const unsettled = (
      await env.DB.prepare(UNSETTLED_TERMINAL_SQL).bind(ADVANCE_ROWS_PER_TICK).all<{ id: string }>()
    ).results;
    const uncopied = (
      await env.DB.prepare(UNCOPIED_TERMINAL_SQL).bind(ADVANCE_ROWS_PER_TICK).all<{ id: string }>()
    ).results;
    const cleared = await env.DB.prepare(CLEAR_NONCES_SQL).run();
    r.cleared = cleared.meta?.changes ?? 0;

    // Every live row taken is stamped BEFORE its step: whatever the step does (a read that fails, a
    // submit that cannot go, an exception) the row has had its turn and goes to the back of the line.
    const live = [...bound, ...created];
    r.examined = live.length;
    if (live.length > 0) {
      await env.DB.batch(live.map((row) => env.DB.prepare(STAMP_EXAMINED_SQL).bind(row.id)));
    }
    const ids = [...new Set([...live, ...unsettled, ...uncopied].map((row) => row.id))];
    for (const id of ids) {
      try {
        const answer = await advanceComputeJob(env, id, { read: TICK_READ });
        tally(r, answer.outcome);
      } catch (err) {
        // The job by its id, the failure by its class: never its message.
        r.errors.push("row_failed");
        r.errorClass = errorClassName(err);
        console.error(`[compute-advance] job ${id}: its step failed (${r.errorClass})`);
      }
    }
  } catch (err) {
    r.errors.push("tick_failed");
    r.errorClass = errorClassName(err);
  }
  return r;
}

/**
 * The tick's one log line, or null when it changed nothing and nothing failed, so a tick that found
 * the same jobs waiting says nothing. Counts and fixed words only. Error level when anything failed.
 */
export function computeAdvanceLogLine(
  r: ComputeTickResult,
): { level: "info" | "error"; line: string } | null {
  const failed = r.errors.length > 0;
  const acted = r.submitted + r.advanced + r.repaired + r.cleared;
  if (!failed && acted === 0) return null;
  const line = [
    "[compute-advance]",
    `examined=${r.examined}`,
    `submitted=${r.submitted}`,
    `advanced=${r.advanced}`,
    `waiting=${r.waiting}`,
    `unreachable=${r.unreachable}`,
    `repaired=${r.repaired}`,
    `nonces_cleared=${r.cleared}`,
    `errors=${r.errors.length > 0 ? r.errors.join(",") : "none"}`,
    r.errorClass === null ? "" : `class=${r.errorClass}`,
  ]
    .filter((part) => part !== "")
    .join(" ");
  return { level: failed ? "error" : "info", line };
}

export interface CancelSweepResult {
  /** Rows with a recorded cancel, and rows with an orphaned Tapis job, taken this tick. */
  examined: number;
  errors: string[];
  errorClass: string | null;
}

/**
 * Carry out every recorded cancel as far as Tapis allows, ten rows a tick. A job that never reached
 * Tapis is ended and its hold released; one that did is cancelled at Tapis and read back, and becomes
 * `cancelled` when Tapis says so. Null outside exact production, before anything is read.
 */
export async function sweepComputeCancellations(env: Bindings): Promise<CancelSweepResult | null> {
  if (!isExactProduction(env)) return null;
  const r: CancelSweepResult = { examined: 0, errors: [], errorClass: null };
  try {
    const rows = (
      await env.DB.prepare(CANCEL_ROWS_SQL).bind(ADVANCE_ROWS_PER_TICK).all<{ id: string }>()
    ).results;
    r.examined = rows.length;
    for (const { id } of rows) {
      try {
        await driveCancel(env, id, TICK_READ);
      } catch (err) {
        r.errors.push("row_failed");
        r.errorClass = errorClassName(err);
        console.error(`[compute-cancel] job ${id}: its cancel failed (${r.errorClass})`);
      }
    }
    // A Tapis job NEMAR made that no row owns, whose cancel failed when it was made: asked again.
    const orphans = (
      await env.DB.prepare(ORPHAN_ROWS_SQL).bind(ADVANCE_ROWS_PER_TICK).all<{ id: string }>()
    ).results;
    r.examined += orphans.length;
    for (const { id } of orphans) {
      try {
        await retryOrphanCancel(env, id, TICK_READ);
      } catch (err) {
        r.errors.push("orphan_failed");
        r.errorClass = errorClassName(err);
        console.error(`[compute-cancel] job ${id}: its orphan cancel failed (${r.errorClass})`);
      }
    }
  } catch (err) {
    r.errors.push("sweep_failed");
    r.errorClass = errorClassName(err);
  }
  return r;
}

/** The cancel sweep's one log line, or null when there was nothing to do and nothing failed. */
export function cancellationsLogLine(
  r: CancelSweepResult,
): { level: "info" | "error"; line: string } | null {
  if (r.examined === 0 && r.errors.length === 0) return null;
  return {
    level: r.errors.length > 0 ? "error" : "info",
    line: `[compute-cancel] examined=${r.examined} errors=${r.errors.length > 0 ? r.errors.join(",") : "none"}${r.errorClass === null ? "" : ` class=${r.errorClass}`}`,
  };
}
