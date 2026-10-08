/**
 * `nemar dataset publish request` right after an upload: a CI-pending refusal.
 *
 * A publication request right after an upload is refused with block_reason
 * `bids_validation_pending` ("BIDS validation has not run yet") or
 * `bids_validation_in_progress` until the dataset's validation run concludes.
 * The refusal is recorded (the request row is `blocked`, and the blocked-request
 * sweep clears it once CI is green), but the CLI exited 1 with "re-request
 * publication", so a depositor read it as a rejection and scripted uploads
 * wrapped the command in their own retry loops (issue #1646).
 *
 * It is a pending state, not an error. The CLI says so and exits 0; it does not
 * wait or poll. Following CI is `nemar dataset ci <id>`, which already exists.
 */

import type { PublicationBlockReason } from "../../shared/contract/publication.js";
import { ApiError } from "./api/errors.js";

/** The two block reasons that mean "CI has not concluded yet", not "CI failed". */
export type CiPendingReason = Extract<
  PublicationBlockReason,
  "bids_validation_pending" | "bids_validation_in_progress"
>;

/** Block reasons that mean "CI has not concluded yet", not "CI failed". */
export const CI_PENDING_BLOCK_REASONS: ReadonlySet<string> = new Set<CiPendingReason>([
  "bids_validation_pending",
  "bids_validation_in_progress",
]);

/** True for a publication refusal that only says CI has not finished. */
export function isCiPendingBlock(
  error: unknown,
): error is ApiError & { blockReason: CiPendingReason } {
  return (
    error instanceof ApiError &&
    error.statusCode === 422 &&
    error.blockReason !== undefined &&
    CI_PENDING_BLOCK_REASONS.has(error.blockReason)
  );
}

/**
 * The first line printed for a CI-pending refusal. It tells the two reasons
 * apart in one clause: no run has been seen yet, or a run is going.
 */
export function ciPendingHeadline(reason: CiPendingReason): string {
  return reason === "bids_validation_in_progress"
    ? "Request recorded: BIDS validation is still running."
    : "Request recorded: BIDS validation has not started yet.";
}

/**
 * The lines that follow the headline. It promises no time: the server re-checks
 * blocked requests on its own schedule, and only says what it does when CI
 * passes. The second sentence is for a depositor who would rather not wait for
 * that: follow CI with the command that shows it, then ask again.
 */
export function ciPendingHint(datasetId: string): string[] {
  return [
    "  NEMAR re-checks it automatically and continues once validation passes.",
    `  To request right after CI completes instead, follow it with 'nemar dataset ci ${datasetId}',`,
    `  then run 'nemar dataset publish request ${datasetId}' again.`,
  ];
}
