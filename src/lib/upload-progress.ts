/**
 * Upload progress tracking for resume capability
 *
 * Stores per-file upload status and step completion in .nemar/upload-progress.json.
 * Enables resuming interrupted uploads without re-uploading completed files.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FileStatus = "pending" | "uploaded" | "failed";

export type UploadStep =
  | "s3_upload"
  | "url_registration"
  | "metadata_write"
  | "dataset_save"
  | "github_push"
  | "ci_deploy";

export interface FileProgress {
  status: FileStatus;
  size: number;
  updated_at: string;
  error?: string;
}

export interface UploadProgress {
  dataset_id: string;
  started_at: string;
  updated_at: string;
  files: Record<string, FileProgress>;
  completed_steps: UploadStep[];
}

const PROGRESS_DIR = ".nemar";
const PROGRESS_FILE = "upload-progress.json";

function getProgressPath(datasetPath: string): string {
  return join(datasetPath, PROGRESS_DIR, PROGRESS_FILE);
}

/**
 * Initialize upload progress for a set of files.
 * All files start as "pending".
 */
export function initUploadProgress(
  datasetPath: string,
  datasetId: string,
  files: Array<{ path: string; size: number }>,
): UploadProgress {
  const now = new Date().toISOString();
  const progress: UploadProgress = {
    dataset_id: datasetId,
    started_at: now,
    updated_at: now,
    files: {},
    completed_steps: [],
  };

  for (const file of files) {
    progress.files[file.path] = {
      status: "pending",
      size: file.size,
      updated_at: now,
    };
  }

  writeUploadProgress(datasetPath, progress);
  return progress;
}

/**
 * Read existing upload progress from disk.
 * Returns null if file doesn't exist or is invalid.
 */
export function readUploadProgress(datasetPath: string): UploadProgress | null {
  const progressPath = getProgressPath(datasetPath);
  if (!existsSync(progressPath)) {
    return null;
  }

  try {
    const content = readFileSync(progressPath, "utf-8");
    const parsed = JSON.parse(content);

    if (!isValidProgress(parsed)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Write upload progress to disk.
 */
export function writeUploadProgress(datasetPath: string, progress: UploadProgress): boolean {
  const dir = join(datasetPath, PROGRESS_DIR);
  const progressPath = getProgressPath(datasetPath);

  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    progress.updated_at = new Date().toISOString();
    writeFileSync(progressPath, JSON.stringify(progress, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Mark a file as successfully uploaded.
 */
export function markFileUploaded(progress: UploadProgress, filePath: string): void {
  if (progress.files[filePath]) {
    progress.files[filePath].status = "uploaded";
    progress.files[filePath].updated_at = new Date().toISOString();
    delete progress.files[filePath].error;
  }
}

/**
 * Mark a file as failed with an error message.
 */
export function markFileFailed(progress: UploadProgress, filePath: string, error: string): void {
  if (progress.files[filePath]) {
    progress.files[filePath].status = "failed";
    progress.files[filePath].updated_at = new Date().toISOString();
    progress.files[filePath].error = error;
  }
}

/**
 * Mark a step as completed.
 */
export function markStepCompleted(progress: UploadProgress, step: UploadStep): void {
  if (!progress.completed_steps.includes(step)) {
    progress.completed_steps.push(step);
  }
}

/**
 * Check if a step has been completed.
 */
export function isStepCompleted(progress: UploadProgress, step: UploadStep): boolean {
  return progress.completed_steps.includes(step);
}

/**
 * Get files that need uploading: pending, failed, new (not in progress), or size-changed.
 *
 * @param progress - existing progress state
 * @param currentManifest - current data files on disk
 * @returns files that need to be uploaded
 */
export function getFilesNeedingUpload(
  progress: UploadProgress,
  currentManifest: Array<{ path: string; size: number }>,
): Array<{ path: string; size: number }> {
  const needUpload: Array<{ path: string; size: number }> = [];

  for (const file of currentManifest) {
    const existing = progress.files[file.path];
    if (!existing) {
      // New file not in progress tracking
      needUpload.push(file);
    } else if (existing.status === "pending" || existing.status === "failed") {
      needUpload.push(file);
    } else if (existing.size !== file.size) {
      // File size changed since last upload
      needUpload.push(file);
    }
    // else: status === "uploaded" and size matches -- skip
  }

  return needUpload;
}

/**
 * Delete the upload progress file.
 */
export function clearUploadProgress(datasetPath: string): boolean {
  const progressPath = getProgressPath(datasetPath);
  try {
    if (existsSync(progressPath)) {
      unlinkSync(progressPath);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a summary of upload progress.
 */
export function getProgressSummary(progress: UploadProgress): {
  total: number;
  uploaded: number;
  failed: number;
  pending: number;
  completedSteps: UploadStep[];
} {
  let uploaded = 0;
  let failed = 0;
  let pending = 0;

  for (const file of Object.values(progress.files)) {
    switch (file.status) {
      case "uploaded":
        uploaded++;
        break;
      case "failed":
        failed++;
        break;
      case "pending":
        pending++;
        break;
    }
  }

  return {
    total: Object.keys(progress.files).length,
    uploaded,
    failed,
    pending,
    completedSteps: progress.completed_steps,
  };
}

function isValidProgress(data: unknown): data is UploadProgress {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.dataset_id === "string" &&
    d.dataset_id.length > 0 &&
    typeof d.started_at === "string" &&
    typeof d.updated_at === "string" &&
    typeof d.files === "object" &&
    d.files !== null &&
    Array.isArray(d.completed_steps)
  );
}
