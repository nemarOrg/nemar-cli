/**
 * Publication-approval orchestrator (#904, epic #902).
 *
 * Extraction of the POST /admin/publish/:id/approve state machine from
 * routes/admin/publish.ts, behavior-preserving. This module owns the step
 * vocabulary (re-exported from shared/publication-steps.ts so the CLI's
 * progress display reads the same list) and the progress recorder that is
 * the single writer of publication_requests.{steps_completed,current_step,
 * last_error} during a run.
 */

import { PUBLICATION_STEPS, type PublicationStep } from "../../../shared/publication-steps.js";

export { PUBLICATION_STEPS };
export type { PublicationStep };

/**
 * Result of a single publication step, included in the API response.
 */
export interface StepResult {
  step: PublicationStep;
  status: "completed" | "failed" | "skipped";
  attempts: number;
  duration_ms: number;
  error?: string;
}

/**
 * Progress recorder for one approve invocation.
 *
 * `completed` and `stepResults` are in-place-mutated arrays with STABLE
 * identity: step code destructures them once and abort-response bodies
 * reference them directly, so they must never be replaced with copies.
 *
 * `currentStepStartMs` is deliberately ONE shared slot, not per-step: steps
 * that call updateProgress without a preceding startStep (the no-op steps,
 * and ci_check's skip path) inherit the previous step's start time and
 * record an elapsed-since-then duration. That is the pre-extraction
 * behavior; do not "fix" it to a per-step timer.
 */
export interface ProgressRecorder {
  startStep(step: PublicationStep): Promise<void>;
  updateProgress(step: PublicationStep, error?: string, attempts?: number): Promise<void>;
  completed: PublicationStep[];
  stepResults: StepResult[];
}

export function createProgressRecorder(
  db: D1Database,
  requestId: number,
  datasetId: string,
  initialCompleted: PublicationStep[],
): ProgressRecorder {
  const completed: PublicationStep[] = [...initialCompleted];
  const stepResults: StepResult[] = [];

  // Track step start time for duration measurement
  let currentStepStartMs = 0;

  // Helper to set current step before execution. Non-fatal on failure.
  async function startStep(step: PublicationStep) {
    currentStepStartMs = Date.now();
    try {
      await db
        .prepare(
          "UPDATE publication_requests SET current_step = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(step, requestId)
        .run();
    } catch (dbErr) {
      console.error(`[publish] Failed to set current_step to ${step}:`, dbErr);
    }
  }

  // Helper to update progress in D1. Catches its own errors to avoid
  // masking the original failure when called inside catch blocks.
  async function updateProgress(step: PublicationStep, error?: string, attempts = 1) {
    const duration_ms = currentStepStartMs > 0 ? Date.now() - currentStepStartMs : 0;
    if (!error) {
      completed.push(step);
      stepResults.push({ step, status: "completed", attempts, duration_ms });
    } else {
      stepResults.push({ step, status: "failed", attempts, duration_ms, error });
    }
    try {
      await db
        .prepare(
          `UPDATE publication_requests
           SET steps_completed = ?, current_step = ?, last_error = ?, updated_at = datetime('now')
           WHERE id = ?`,
        )
        .bind(JSON.stringify(completed), error ? step : null, error || null, requestId)
        .run();
    } catch (dbErr) {
      console.error(
        `[publish] CRITICAL: Failed to update progress for step ${step}, dataset ${datasetId}:`,
        dbErr,
      );
    }
  }

  return { startStep, updateProgress, completed, stepResults };
}
