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
 *  - `refused`: NEMAR answered with a 4xx (the key was revoked, the job is not yours). Retrying cannot help.
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

export const MIN_INTERVAL_MS = 5_000;
export const MAX_INTERVAL_MS = 30_000;
export const GROWTH = 1.5;

/** Reads that failed with a 5xx or no answer, running, before the wait gives up. */
export const CONSECUTIVE_FAILURE_LIMIT = 5;

export type WaitOutcome =
  | { kind: "terminal"; job: ComputeUserJob; stale: boolean; waitedMs: number }
  | { kind: "detached"; job: ComputeUserJob | null; waitedMs: number }
  | { kind: "unavailable"; job: ComputeUserJob | null; detail: string; waitedMs: number }
  | { kind: "refused"; error: ApiError; job: ComputeUserJob | null; waitedMs: number };

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
  return error.statusCode === 0 || error.statusCode >= 500;
}

export async function waitForJob(options: WaitOptions): Promise<WaitOutcome> {
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const cancel = new AbortController();
  const onSigint = () => cancel.abort();
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
      await sleep(interval, cancel.signal);
    }
  } finally {
    process.off("SIGINT", onSigint);
    outside?.removeEventListener("abort", onOutside);
  }
}
