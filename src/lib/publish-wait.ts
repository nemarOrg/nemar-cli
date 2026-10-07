/**
 * `nemar dataset publish request --wait`: ride out a BIDS-validation run that
 * has not finished yet instead of failing.
 *
 * A publication request right after an upload is refused with block_reason
 * `bids_validation_pending` ("BIDS validation has not run yet") or
 * `bids_validation_in_progress` until the dataset's validation run concludes.
 * The refusal is recorded (the request row is `blocked`, and a daily sweep
 * clears it once CI is green), but the CLI exited 1 with "re-request
 * publication", so scripted uploads had to wrap the request in their own retry
 * loop (the iEEG campaign's lanes did). With --wait the CLI re-requests on an
 * interval until CI has concluded or the wait runs out. Re-requesting is safe:
 * the server updates the one blocked row rather than adding requests, and
 * admins are only notified once a request is accepted.
 */

import { ApiError } from "./api/errors.js";

/** Block reasons that mean "CI has not concluded yet", not "CI failed". */
export const CI_PENDING_BLOCK_REASONS: ReadonlySet<string> = new Set([
  "bids_validation_pending",
  "bids_validation_in_progress",
]);

export const DEFAULT_WAIT_MINUTES = 30;
export const MAX_WAIT_MINUTES = 24 * 60;
export const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;

/** True for a publication refusal that only says CI has not finished. */
export function isCiPendingBlock(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.statusCode === 422 &&
    error.blockReason !== undefined &&
    CI_PENDING_BLOCK_REASONS.has(error.blockReason)
  );
}

/**
 * Minutes to wait from the `--wait [minutes]` option: absent -> null (do not
 * wait), bare flag -> the default, a number -> that number (1..24 h). Throws on
 * anything else so a typo is not silently a 30-minute wait.
 */
export function parseWaitOption(value: boolean | string | undefined): number | null {
  if (value === undefined || value === false) return null;
  if (value === true) return DEFAULT_WAIT_MINUTES;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`--wait expects a number of minutes, got "${value}"`);
  }
  return Math.min(MAX_WAIT_MINUTES, minutes);
}

export interface WaitForCiOptions<T> {
  request: () => Promise<T>;
  waitMs: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called before each sleep with the block reason and the time waited so far. */
  onPending?: (blockReason: string, waitedMs: number) => void;
}

/**
 * Call `request` until it is not refused for pending CI, or until `waitMs` has
 * passed. Any other error, and the last CI-pending refusal after the wait,
 * is rethrown unchanged so the caller's normal error printing applies.
 */
export async function requestWaitingForCi<T>(opts: WaitForCiOptions<T>): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const start = now();
  for (;;) {
    try {
      return await opts.request();
    } catch (error) {
      if (!isCiPendingBlock(error)) throw error;
      const waited = now() - start;
      if (waited + interval > opts.waitMs) throw error;
      opts.onPending?.(error.blockReason as string, waited);
      await sleep(interval);
    }
  }
}

/** The hint printed when a request is refused only because CI is not done. */
export function ciPendingHint(datasetId: string, waited: boolean): string[] {
  return [
    waited
      ? "  BIDS validation still had not concluded when the wait ran out."
      : "  BIDS validation has not concluded yet; nothing is wrong with the request.",
    "  The request is recorded as blocked and is re-checked automatically once CI passes.",
    `  To be notified sooner: nemar dataset publish request ${datasetId} --wait [minutes]`,
    `  CI status: nemar dataset ci ${datasetId}`,
  ];
}
