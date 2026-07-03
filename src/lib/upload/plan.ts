/**
 * Upload pipeline: plan and resumability steps.
 *
 * Moved verbatim from the upload action in commands/dataset.ts (#907,
 * epic #902); the only intentional changes are import paths and the
 * step-function wrappers. Steps print their own output and never call
 * process.exit (the command sequencer owns exits).
 */

import chalk from "chalk";
import { type LocalDatasetConfig, readLocalConfig } from "../dataset-config.js";
import { formatBytes } from "../progress.js";
import {
  type UploadProgress,
  clearUploadProgress,
  getFilesNeedingUpload,
  getProgressSummary,
  readUploadProgress,
} from "../upload-progress.js";
import type { DatasetAnalysis } from "./enrich.js";
import { STOP, type StepOk, type StepStop, ok } from "./types.js";

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

/**
 * Step 4e: Read any existing local config (resume scenario), print the
 * Resume Upload / Upload Plan banner, and honor --dry-run (STOP).
 */
export function showUploadPlan(
  absolutePath: string,
  datasetName: string,
  manifest: DatasetAnalysis["manifest"],
  options: { jobs: string; dryRun?: boolean },
): StepOk<{ existingConfig: LocalDatasetConfig | null }> | StepStop {
  // Check for existing local config (resume scenario)
  const existingConfig = readLocalConfig(absolutePath);

  console.log();
  if (existingConfig) {
    console.log(chalk.bold.yellow("Resume Upload:"));
    console.log(`  Dataset ID: ${chalk.cyan(existingConfig.dataset_id)}`);
    console.log(`  Last attempt: ${existingConfig.last_upload_at || existingConfig.created_at}`);
  } else {
    console.log(chalk.bold("Upload Plan:"));
  }
  console.log(`  Name: ${datasetName}`);
  console.log(`  Path: ${absolutePath}`);
  console.log(`  Files: ${manifest.files.length}`);
  console.log(`  Size: ${formatBytes(manifest.totalSize)}`);
  console.log(`  Data files: ${manifest.dataFiles} (will be uploaded to S3)`);
  console.log(`  Metadata files: ${manifest.metadataFiles} (will be stored in git)`);
  console.log(`  Parallel jobs: ${options.jobs}`);
  console.log();

  // Dry run mode
  if (options.dryRun) {
    console.log(chalk.yellow("Dry run mode - no changes made"));
    return STOP;
  }
  return ok({ existingConfig });
}

/**
 * Step 5b: Filter data files, honor --restart, load persisted progress, and
 * compute which files still need uploading.
 */
export function prepareUploadProgress(
  absolutePath: string,
  manifest: DatasetAnalysis["manifest"],
  options: { restart?: boolean },
) {
  // Only request presigned URLs for data files
  const dataFiles = manifest.files.filter((f) => f.type === "data");

  // Handle --restart: clear any existing progress
  if (options.restart) {
    clearUploadProgress(absolutePath);
    console.log(chalk.dim("  Upload progress cleared (--restart)"));
    console.log();
  }

  // Load existing upload progress (if any)
  const uploadProgress: UploadProgress | null = options.restart
    ? null
    : readUploadProgress(absolutePath);

  if (uploadProgress) {
    const summary = getProgressSummary(uploadProgress);
    console.log(chalk.bold.cyan("Upload Progress:"));
    console.log(
      `  Files: ${summary.uploaded}/${summary.total} uploaded, ${summary.failed} failed, ${summary.pending} pending`,
    );
    if (summary.completedSteps.length > 0) {
      console.log(`  Completed steps: ${summary.completedSteps.join(", ")}`);
    }
    console.log();
  }

  // Determine which files need uploading
  const filesToUpload = uploadProgress
    ? getFilesNeedingUpload(uploadProgress, dataFiles)
    : dataFiles;
  return { dataFiles, uploadProgress, filesToUpload };
}
