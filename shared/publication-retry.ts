/**
 * How the CLI paces its retries of a failed publication step, shared so the
 * backend's approval lease can be held to it (ADR 0080).
 *
 * `approvePublication` (src/lib/api/publish.ts) waits this long after a
 * retryable failure before it calls `/approve` again. The backend treats a run
 * that recorded an error as still in flight for a grace window
 * (`FAILED_RUN_GRACE_SECONDS`, backend/src/services/approval-dispatch.ts) and
 * that window has to outlast this wait: an executor launched inside it would
 * run beside the retry about to start. A test holds the two together, so
 * raising this without the grace is a red build, not a second run.
 *
 * Zero dependencies, like `publication-steps.ts`, so either side can import it.
 */
export const APPROVE_RETRY_DELAY_MS = 10_000;
