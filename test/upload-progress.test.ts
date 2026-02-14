import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearUploadProgress,
  getFilesNeedingUpload,
  getProgressSummary,
  initUploadProgress,
  isStepCompleted,
  markFileFailed,
  markFileUploaded,
  markStepCompleted,
  readUploadProgress,
  writeUploadProgress,
} from "../src/lib/upload-progress";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `nemar-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

const testFiles = [
  { path: "sub-01/eeg/sub-01_eeg.edf", size: 1024000 },
  { path: "sub-01/eeg/sub-01_events.tsv", size: 5000 },
  { path: "sub-02/eeg/sub-02_eeg.edf", size: 2048000 },
];

describe("initUploadProgress", () => {
  test("creates progress file with all files as pending", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);

    expect(progress.dataset_id).toBe("nm000123");
    expect(Object.keys(progress.files)).toHaveLength(3);
    expect(progress.completed_steps).toEqual([]);

    for (const file of testFiles) {
      expect(progress.files[file.path].status).toBe("pending");
      expect(progress.files[file.path].size).toBe(file.size);
    }

    // Verify file was written to disk
    expect(existsSync(join(testDir, ".nemar", "upload-progress.json"))).toBe(true);
  });

  test("creates .nemar directory if it does not exist", () => {
    expect(existsSync(join(testDir, ".nemar"))).toBe(false);
    initUploadProgress(testDir, "nm000123", testFiles);
    expect(existsSync(join(testDir, ".nemar"))).toBe(true);
  });
});

describe("readUploadProgress", () => {
  test("returns null when no progress file exists", () => {
    expect(readUploadProgress(testDir)).toBeNull();
  });

  test("round-trips init -> read", () => {
    initUploadProgress(testDir, "nm000123", testFiles);
    const read = readUploadProgress(testDir);

    expect(read).not.toBeNull();
    expect(read!.dataset_id).toBe("nm000123");
    expect(Object.keys(read!.files)).toHaveLength(3);
  });

  test("returns null for invalid JSON", () => {
    const dir = join(testDir, ".nemar");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "upload-progress.json"), "not valid json{{{");

    expect(readUploadProgress(testDir)).toBeNull();
  });

  test("returns null for valid JSON with missing required fields", () => {
    const dir = join(testDir, ".nemar");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "upload-progress.json"), JSON.stringify({ foo: "bar" }));

    expect(readUploadProgress(testDir)).toBeNull();
  });
});

describe("writeUploadProgress", () => {
  test("writes and reads back progress", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    progress.files[testFiles[0].path].status = "uploaded";

    const written = writeUploadProgress(testDir, progress);
    expect(written).toBe(true);

    const read = readUploadProgress(testDir);
    expect(read!.files[testFiles[0].path].status).toBe("uploaded");
  });
});

describe("markFileUploaded / markFileFailed", () => {
  test("marks file as uploaded", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markFileUploaded(progress, testFiles[0].path);

    expect(progress.files[testFiles[0].path].status).toBe("uploaded");
    expect(progress.files[testFiles[0].path].error).toBeUndefined();
  });

  test("marks file as failed with error", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markFileFailed(progress, testFiles[0].path, "Connection timeout");

    expect(progress.files[testFiles[0].path].status).toBe("failed");
    expect(progress.files[testFiles[0].path].error).toBe("Connection timeout");
  });

  test("clears error when re-marking as uploaded", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markFileFailed(progress, testFiles[0].path, "Connection timeout");
    markFileUploaded(progress, testFiles[0].path);

    expect(progress.files[testFiles[0].path].status).toBe("uploaded");
    expect(progress.files[testFiles[0].path].error).toBeUndefined();
  });

  test("no-ops for unknown file paths", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markFileUploaded(progress, "nonexistent/file.edf");
    markFileFailed(progress, "nonexistent/file.edf", "error");

    expect(progress.files["nonexistent/file.edf"]).toBeUndefined();
  });
});

describe("step completion", () => {
  test("tracks step completion", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);

    expect(isStepCompleted(progress, "s3_upload")).toBe(false);
    markStepCompleted(progress, "s3_upload");
    expect(isStepCompleted(progress, "s3_upload")).toBe(true);
  });

  test("does not duplicate steps", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markStepCompleted(progress, "s3_upload");
    markStepCompleted(progress, "s3_upload");

    expect(progress.completed_steps.filter((s) => s === "s3_upload")).toHaveLength(1);
  });

  test("tracks multiple steps independently", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markStepCompleted(progress, "s3_upload");
    markStepCompleted(progress, "url_registration");

    expect(isStepCompleted(progress, "s3_upload")).toBe(true);
    expect(isStepCompleted(progress, "url_registration")).toBe(true);
    expect(isStepCompleted(progress, "github_push")).toBe(false);
  });
});

describe("getFilesNeedingUpload", () => {
  test("returns all files when none are uploaded", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    const needing = getFilesNeedingUpload(progress, testFiles);

    expect(needing).toHaveLength(3);
  });

  test("excludes uploaded files", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markFileUploaded(progress, testFiles[0].path);

    const needing = getFilesNeedingUpload(progress, testFiles);
    expect(needing).toHaveLength(2);
    expect(needing.find((f) => f.path === testFiles[0].path)).toBeUndefined();
  });

  test("includes failed files", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markFileFailed(progress, testFiles[0].path, "timeout");

    const needing = getFilesNeedingUpload(progress, testFiles);
    expect(needing).toHaveLength(3); // pending + failed
    expect(needing.find((f) => f.path === testFiles[0].path)).toBeDefined();
  });

  test("includes new files not in progress", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles.slice(0, 2));
    markFileUploaded(progress, testFiles[0].path);
    markFileUploaded(progress, testFiles[1].path);

    const needing = getFilesNeedingUpload(progress, testFiles);
    expect(needing).toHaveLength(1);
    expect(needing[0].path).toBe(testFiles[2].path);
  });

  test("includes files whose size changed", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markFileUploaded(progress, testFiles[0].path);

    const changedManifest = testFiles.map((f) =>
      f.path === testFiles[0].path ? { ...f, size: f.size + 100 } : f,
    );

    const needing = getFilesNeedingUpload(progress, changedManifest);
    expect(needing.find((f) => f.path === testFiles[0].path)).toBeDefined();
  });
});

describe("clearUploadProgress", () => {
  test("deletes the progress file", () => {
    initUploadProgress(testDir, "nm000123", testFiles);
    expect(existsSync(join(testDir, ".nemar", "upload-progress.json"))).toBe(true);

    const result = clearUploadProgress(testDir);
    expect(result).toBe(true);
    expect(existsSync(join(testDir, ".nemar", "upload-progress.json"))).toBe(false);
  });

  test("returns true when no progress file exists", () => {
    expect(clearUploadProgress(testDir)).toBe(true);
  });
});

describe("getProgressSummary", () => {
  test("counts files by status", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markFileUploaded(progress, testFiles[0].path);
    markFileFailed(progress, testFiles[1].path, "error");

    const summary = getProgressSummary(progress);
    expect(summary.total).toBe(3);
    expect(summary.uploaded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.pending).toBe(1);
  });

  test("includes completed steps", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markStepCompleted(progress, "s3_upload");
    markStepCompleted(progress, "github_push");

    const summary = getProgressSummary(progress);
    expect(summary.completedSteps).toEqual(["s3_upload", "github_push"]);
  });
});
