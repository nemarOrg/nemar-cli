/**
 * Upload pipeline: plan and resumability steps.
 *
 * Moved verbatim from the upload action in commands/dataset.ts (#907,
 * epic #902); the only intentional changes are import paths and the
 * step-function wrappers. Steps print their own output and never call
 * process.exit (the command sequencer owns exits).
 */

import chalk from "chalk";
import { type UploadProgress, clearUploadProgress } from "../upload-progress.js";

/**
 * Validate progress file matches current dataset (discard stale progress).
 *
 * NOTE (pre-existing behavior, preserved on purpose): the caller computes
 * `filesToUpload` from the loaded progress BEFORE this reconcile runs and
 * does not recompute it when stale progress is discarded here. Tracked for
 * a real fix (with a test) in the phase 5b follow-up issue.
 */
export function reconcileProgressWithDataset(
  absolutePath: string,
  uploadProgress: UploadProgress | null,
  datasetId: string,
): UploadProgress | null {
  if (uploadProgress && uploadProgress.dataset_id !== datasetId) {
    console.log(chalk.yellow("  Progress file is for a different dataset; starting fresh."));
    clearUploadProgress(absolutePath);
    return null;
  }
  return uploadProgress;
}
