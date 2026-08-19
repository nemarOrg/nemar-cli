/**
 * Upload progress tracking for resume capability
 *
 * Stores per-file upload status and step completion in .nemar/upload-progress.json.
 * Enables resuming interrupted uploads without re-uploading completed files.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FileStatus = "pending" | "uploaded" | "failed";

const VALID_STATUSES = new Set<string>(["pending", "uploaded", "failed"]);

export type UploadStep =
  | "tracking"
  | "s3_upload"
  | "url_registration"
  | "metadata_write"
  | "dataset_save"
  | "github_push"
  | "ci_deploy";

const VALID_STEPS = new Set<string>([
  "tracking",
  "s3_upload",
  "url_registration",
  "metadata_write",
  "dataset_save",
  "github_push",
  "ci_deploy",
]);

export interface FileProgress {
  status: FileStatus;
  size: number;
  /** Working-tree mtime when recorded; absent in pre-#884 progress files. */
  mtimeMs?: number;
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

/** All files start as "pending". Writes progress to disk. */
export function initUploadProgress(
  datasetPath: string,
  datasetId: string,
  files: Array<{ path: string; size: number; mtimeMs?: number }>,
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
      mtimeMs: file.mtimeMs,
      updated_at: now,
    };
  }

  writeUploadProgress(datasetPath, progress);
  return progress;
}

/**
 * Read existing upload progress from disk.
 * Returns null if file doesn't exist or is invalid.
 * Logs a warning if the file exists but cannot be parsed.
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
      console.warn(`Warning: Upload progress file is invalid or corrupted (${progressPath})`);
      console.warn("  Use --restart to clear progress and start fresh.");
      return null;
    }

    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: Could not read upload progress (${progressPath}): ${detail}`);
    console.warn("  Use --restart to clear progress and start fresh.");
    return null;
  }
}

/**
 * Write upload progress to disk.
 * Mutates progress.updated_at to the current timestamp before writing.
 * Logs a warning on failure.
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
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: Could not save upload progress (${progressPath}): ${detail}`);
    console.warn("  If the upload is interrupted, resume may not work correctly.");
    return false;
  }
}

/**
 * Mark a file as successfully uploaded.
 * No-ops silently if filePath is not tracked in progress.
 *
 * When `fileInfo` is given, the recorded size/mtime are refreshed to the
 * just-uploaded working-tree state, so a file that was re-uploaded after a
 * content change stops registering as changed on subsequent runs (#884).
 */
export function markFileUploaded(
  progress: UploadProgress,
  filePath: string,
  fileInfo?: { size: number; mtimeMs?: number },
): void {
  const entry = progress.files[filePath];
  if (entry) {
    entry.status = "uploaded";
    entry.updated_at = new Date().toISOString();
    entry.error = undefined;
    if (fileInfo) {
      entry.size = fileInfo.size;
      if (fileInfo.mtimeMs !== undefined) {
        entry.mtimeMs = fileInfo.mtimeMs;
      }
    }
  }
}

/**
 * Mark a file as failed with an error message.
 * No-ops silently if filePath is not tracked in progress.
 */
export function markFileFailed(progress: UploadProgress, filePath: string, error: string): void {
  const entry = progress.files[filePath];
  if (entry) {
    entry.status = "failed";
    entry.updated_at = new Date().toISOString();
    entry.error = error;
  }
}

export function markStepCompleted(progress: UploadProgress, step: UploadStep): void {
  if (!progress.completed_steps.includes(step)) {
    progress.completed_steps.push(step);
  }
}

export function isStepCompleted(progress: UploadProgress, step: UploadStep): boolean {
  return progress.completed_steps.includes(step);
}

/**
 * Un-complete a step so it re-runs on the next attempt. Used when a later
 * discovery invalidates earlier work (e.g. the data-file list changed after
 * git-annex tracking was marked complete, #884). No-op if not completed.
 */
export function clearStepCompleted(progress: UploadProgress, step: UploadStep): void {
  progress.completed_steps = progress.completed_steps.filter((s) => s !== step);
}

/**
 * Whether the current manifest carries data files the progress has not seen
 * (new path) or that changed size or mtime since they were recorded (see
 * fileEntryChanged; removals never invalidate). Drives the invalidation of
 * the completed "tracking" step on resume (#884): unchanged lists skip the
 * multi-hour git-annex re-add entirely.
 */
export function hasFileListChanged(
  progress: UploadProgress,
  currentManifest: Array<{ path: string; size: number; mtimeMs?: number }>,
): boolean {
  return currentManifest.some((file) => fileEntryChanged(progress.files[file.path], file));
}

/**
 * Whether a manifest file differs from its recorded progress entry: new
 * path, size change, or mtime change. Same-size content rewrites (e.g.
 * re-anonymization) move the mtime, so size alone misses them (#884
 * review). A record without a stored mtime (pre-#884 progress file) is
 * treated as changed when the manifest carries one -- failing toward a
 * harmless content-addressed re-add. Manifests without mtimes fall back to
 * size-only comparison.
 */
function fileEntryChanged(
  existing: FileProgress | undefined,
  file: { size: number; mtimeMs?: number },
): boolean {
  if (!existing) return true;
  if (existing.size !== file.size) return true;
  if (file.mtimeMs !== undefined && existing.mtimeMs !== file.mtimeMs) return true;
  return false;
}

/**
 * Get files that need uploading: pending, failed, new (not in progress),
 * size-changed, or mtime-changed (see fileEntryChanged).
 *
 * @param progress - existing progress state
 * @param currentManifest - current data files from the upload manifest
 * @returns files that need to be uploaded
 */
export function getFilesNeedingUpload<T extends { path: string; size: number; mtimeMs?: number }>(
  progress: UploadProgress,
  currentManifest: T[],
): T[] {
  return currentManifest.filter((file) => {
    const existing = progress.files[file.path];
    // Skip only if previously uploaded and unchanged since
    return !existing || existing.status !== "uploaded" || fileEntryChanged(existing, file);
  });
}

/**
 * Delete the upload progress file. The .nemar/ directory is preserved.
 * Logs a warning on failure.
 */
export function clearUploadProgress(datasetPath: string): boolean {
  const progressPath = getProgressPath(datasetPath);
  try {
    if (existsSync(progressPath)) {
      unlinkSync(progressPath);
    }
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: Could not clear upload progress (${progressPath}): ${detail}`);
    return false;
  }
}

export function getProgressSummary(progress: UploadProgress): {
  total: number;
  uploaded: number;
  failed: number;
  pending: number;
  completedSteps: UploadStep[];
} {
  const entries = Object.values(progress.files);
  let uploaded = 0;
  let failed = 0;
  let pending = 0;

  for (const file of entries) {
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
    total: entries.length,
    uploaded,
    failed,
    pending,
    completedSteps: progress.completed_steps,
  };
}

/**
 * Validates the structure of a parsed progress file, including individual
 * file entries and step values.
 */
function isValidProgress(data: unknown): data is UploadProgress {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (
    typeof d.dataset_id !== "string" ||
    d.dataset_id.length === 0 ||
    typeof d.started_at !== "string" ||
    typeof d.updated_at !== "string" ||
    typeof d.files !== "object" ||
    d.files === null ||
    !Array.isArray(d.completed_steps)
  ) {
    return false;
  }

  // Validate individual file entries
  for (const entry of Object.values(d.files as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.status !== "string" || !VALID_STATUSES.has(e.status)) return false;
    if (typeof e.size !== "number" || e.size < 0) return false;
    // mtimeMs is optional (absent in pre-#884 progress files)
    if (e.mtimeMs !== undefined && (typeof e.mtimeMs !== "number" || e.mtimeMs < 0)) return false;
  }

  // Validate step values
  for (const step of d.completed_steps as unknown[]) {
    if (typeof step !== "string" || !VALID_STEPS.has(step)) return false;
  }

  return true;
}
