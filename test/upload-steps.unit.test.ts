/**
 * Unit tests for the extracted dataset-upload step functions (#907).
 * Real fixtures + tmp dirs, no mocks. Pure CI tier (no CLI spawn, no network).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initUploadProgress, readUploadProgress } from "../src/lib/upload-progress";
import { reconcileProgressWithDataset } from "../src/lib/upload/plan";
import { ensureGitignoreHasNemar, parseRepoFullName } from "../src/lib/upload/transfer";

const scratchDirs: string[] = [];
function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseRepoFullName", () => {
  test("standard https URL", () => {
    expect(parseRepoFullName("https://github.com/nemarDatasets/nm000123")).toBe(
      "nemarDatasets/nm000123",
    );
  });

  test(".git suffix is stripped", () => {
    expect(parseRepoFullName("https://github.com/nemarDatasets/nm000123.git")).toBe(
      "nemarDatasets/nm000123",
    );
  });

  test("ssh form is NOT matched (documents current behavior: colon, no slash)", () => {
    expect(parseRepoFullName("git@github.com:nemarDatasets/nm000123.git")).toBeNull();
  });

  test("garbage, empty, and undefined return null", () => {
    expect(parseRepoFullName("not a url")).toBeNull();
    expect(parseRepoFullName("")).toBeNull();
    expect(parseRepoFullName(undefined)).toBeNull();
  });
});

describe("ensureGitignoreHasNemar", () => {
  test("creates .gitignore with .nemar/ when absent", () => {
    const dir = scratchDir("nemar-gitignore-absent-");
    ensureGitignoreHasNemar(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toBe(".nemar/\n");
  });

  test("appends to an existing .gitignore without clobbering", () => {
    const dir = scratchDir("nemar-gitignore-append-");
    writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\n\n");
    ensureGitignoreHasNemar(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toBe("node_modules/\ndist/\n.nemar/\n");
  });

  test("idempotent when .nemar/ already present", () => {
    const dir = scratchDir("nemar-gitignore-idem-");
    const content = "node_modules/\n.nemar/\n";
    writeFileSync(join(dir, ".gitignore"), content);
    ensureGitignoreHasNemar(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toBe(content);
  });
});

describe("reconcileProgressWithDataset", () => {
  const files = [{ path: "sub-01/eeg/sub-01_task-rest_eeg.edf", size: 1024 }];

  test("matching dataset id: progress returned, file intact", () => {
    const dir = scratchDir("nemar-progress-match-");
    const progress = initUploadProgress(dir, "nm000001", files);
    const result = reconcileProgressWithDataset(dir, progress, "nm000001");
    expect(result).toBe(progress);
    expect(readUploadProgress(dir)?.dataset_id).toBe("nm000001");
  });

  test("mismatched dataset id: returns null and deletes the progress file", () => {
    const dir = scratchDir("nemar-progress-stale-");
    const progress = initUploadProgress(dir, "nm000001", files);
    expect(existsSync(join(dir, ".nemar", "upload-progress.json"))).toBe(true);
    const result = reconcileProgressWithDataset(dir, progress, "nm000002");
    expect(result).toBeNull();
    expect(readUploadProgress(dir)).toBeNull();
  });

  test("null progress passes through", () => {
    const dir = scratchDir("nemar-progress-null-");
    expect(reconcileProgressWithDataset(dir, null, "nm000001")).toBeNull();
  });
});
