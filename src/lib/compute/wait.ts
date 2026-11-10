/**
 * `nemar compute submit --wait`: poll a job until it ends (epic #2021 phase D3b, #2024), shaped like
 * `pollForDeviceToken` in `device-login.ts` and with the injectable `sleep` and `now` of
 * `repull/execute/settle.ts`, so a test never waits.
 *
 * The ways it ends, each a distinct outcome (the command maps them to exit codes):
 *  - `terminal`: the job is `finished`, `failed` or `cancelled`;
 *  - `detached`: the person pressed Ctrl-C (SIGINT). THE JOB IS NOT CANCELLED. Leaving is not cancelling:
 *    the job goes on and costs what it costs, and the command says how to cancel it. Nothing in this file
 *    can cancel a job; it has no such function to call;
 *  - `unavailable`: NEMAR could not be asked {@link CONSECUTIVE_FAILURE_LIMIT} times running (a 5xx, a
 *    network failure, the maintenance banner). The job's state is unknown, not bad;
 *  - `refused`: NEMAR answered with a 4xx other than 429 (the key was revoked, the job is not yours).
 *    Retrying cannot help. A 429 is a failed read like a 5xx, and its `Retry-After` is waited out (capped);
 *  - `ceiling`: the wait has run for the job's own time limit (its `minutes` from the job view) plus a
 *    30-minute allowance, or {@link DEFAULT_CEILING_MS} while the job has not been read, and the job is still
 *    live. A job that has not ended by then is not waited for any longer; the person looks at it.
 *
 * Polling begins at once, then waits {@link MIN_INTERVAL_MS} and grows by half each time the state has not
 * changed, up to {@link MAX_INTERVAL_MS}; a change of state starts it over. A failed read backs off the
 * same way. The SIGINT handler is removed in `finally`, and a pending sleep is cut short by it.
 */

import { TERMINAL_COMPUTE_STATES } from "../../../shared/compute-state.js";
import type {
  ComputeUserJob,
  ComputeUserJobResponse,
} from "../../../shared/contract/compute-user.js";
import { ApiError, errorDetail } from "../api/errors.js";

/** The exit code of a wait that ended with the job still live (`fail.ts` has the same number). */
const EXIT_STILL_LIVE_CODE = 3;

export const MIN_INTERVAL_MS = 5_000;
export const MAX_INTERVAL_MS = 30_000;
export const GROWTH = 1.5;

/** Added to the job's own time limit to make the ceiling of the wait. */
export const CEILING_ALLOWANCE_MS = 30 * 60_000;

/** The ceiling before the job has been read: the longest a partition runs, 48 hours, and the allowance. */
export const DEFAULT_CEILING_MS = 48 * 3_600_000 + CEILING_ALLOWANCE_MS;

/** The longest a `Retry-After` is waited out. */
export const MAX_RETRY_AFTER_MS = 120_000;

/** Time allowed for one read of the job, connection and body together. */
export const READ_TIMEOUT_MS = 20_000;

/** Reads that failed with a 5xx or no answer, running, before the wait gives up. */
export const CONSECUTIVE_FAILURE_LIMIT = 5;

export type WaitOutcome =
  | { kind: "terminal"; job: ComputeUserJob; stale: boolean; waitedMs: number }
  | { kind: "detached"; job: ComputeUserJob | null; waitedMs: number }
  | { kind: "unavailable"; job: ComputeUserJob | null; detail: string; waitedMs: number }
  | { kind: "refused"; error: ApiError; job: ComputeUserJob | null; waitedMs: number }
  | { kind: "ceiling"; job: ComputeUserJob | null; waitedMs: number };

export interface WaitOptions {
  /** One read of the job (`GET /compute/me/jobs/:id`). Throws an `ApiError` on any failure. */
  fetchJob: (signal: AbortSignal) => Promise<ComputeUserJobResponse>;
  /** Called with the first read and again whenever the state or the stale flag changes. */
  onState?: (job: ComputeUserJob, stale: boolean) => void;
  /** Called when a read fails and the wait goes on. */
  onRetry?: (detail: string, failures: number) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  /** An abort from outside (a test); SIGINT is wired in here as well. */
  signal?: AbortSignal;
  /** Whether to listen for SIGINT. On unless a test says otherwise. */
  listenForSigint?: boolean;
  /** What a second SIGINT, while the wait is already detaching, does: leave at once with code 3. */
  exit?: (code: number) => never;
}

/** Resolves after `ms`, or as soon as `signal` aborts; never rejects. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const isTerminal = (state: string): boolean =>
  (TERMINAL_COMPUTE_STATES as readonly string[]).includes(state);

/** Whether an error is "could not ask" (retry) and not "was told no" (stop). */
function isTransient(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.statusCode === 0 || error.statusCode === 429 || error.statusCode >= 500;
}

/** How long a failed read asks to be waited out, capped; 0 when it asked for nothing. */
function retryAfterMs(error: unknown): number {
  if (!(error instanceof ApiError) || error.retryAfterSeconds === undefined) return 0;
  return Math.min(MAX_RETRY_AFTER_MS, Math.round(error.retryAfterSeconds * 1000));
}

/** The ceiling of the wait for this job: its time limit and the allowance. */
export function ceilingOf(job: ComputeUserJob | null): number {
  const minutes = job?.resources?.minutes;
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
    ? minutes * 60_000 + CEILING_ALLOWANCE_MS
    : DEFAULT_CEILING_MS;
}

export async function waitForJob(options: WaitOptions): Promise<WaitOutcome> {
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const cancel = new AbortController();
  const exit = options.exit ?? ((code: number): never => process.exit(code));
  const onSigint = () => {
    // A second Ctrl-C, while the first is still being carried out (a read in flight), leaves at once.
    if (cancel.signal.aborted) exit(EXIT_STILL_LIVE_CODE);
    cancel.abort();
  };
  if (options.listenForSigint !== false) process.on("SIGINT", onSigint);
  const outside = options.signal;
  const onOutside = () => cancel.abort();
  if (outside) {
    if (outside.aborted) cancel.abort();
    else outside.addEventListener("abort", onOutside, { once: true });
  }

  let last: ComputeUserJob | null = null;
  let lastStale = false;
  let failures = 0;
  let interval = MIN_INTERVAL_MS;
  const waited = () => now() - startedAt;

  try {
    while (true) {
      if (cancel.signal.aborted) return { kind: "detached", job: last, waitedMs: waited() };
      if (waited() >= ceilingOf(last)) return { kind: "ceiling", job: last, waitedMs: waited() };
      let asked = 0;
      try {
        const read = await options.fetchJob(cancel.signal);
        failures = 0;
        const stale = read.stale === true;
        const changed = last === null || read.job.state !== last.state || stale !== lastStale;
        last = read.job;
        lastStale = stale;
        if (changed) {
          options.onState?.(read.job, stale);
          interval = MIN_INTERVAL_MS;
        } else {
          interval = Math.min(MAX_INTERVAL_MS, Math.round(interval * GROWTH));
        }
        if (isTerminal(read.job.state)) {
          return { kind: "terminal", job: read.job, stale, waitedMs: waited() };
        }
      } catch (error) {
        if (cancel.signal.aborted) return { kind: "detached", job: last, waitedMs: waited() };
        if (!isTransient(error)) {
          return { kind: "refused", error: error as ApiError, job: last, waitedMs: waited() };
        }
        failures += 1;
        asked = retryAfterMs(error);
        const detail =
          error instanceof ApiError && error.statusCode !== 0
            ? `HTTP ${error.statusCode}`
            : errorDetail(error);
        if (failures >= CONSECUTIVE_FAILURE_LIMIT) {
          return { kind: "unavailable", job: last, detail, waitedMs: waited() };
        }
        options.onRetry?.(detail, failures);
        interval = Math.min(MAX_INTERVAL_MS, Math.round(interval * GROWTH));
      }
      // Never sleep past the ceiling: the next turn of the loop says so.
      const left = Math.max(0, ceilingOf(last) - waited());
      await sleep(Math.min(Math.max(interval, asked), Math.max(left, 1)), cancel.signal);
    }
  } finally {
    process.off("SIGINT", onSigint);
    outside?.removeEventListener("abort", onOutside);
  }
}
