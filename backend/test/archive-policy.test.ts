/**
 * Tests for the >100GB archive skip policy (epic #749, Phase 3 / #752).
 * Pure function, no I/O, no mocks.
 */

import { describe, expect, test } from "bun:test";
import {
  ARCHIVE_MAX_BYTES,
  ARCHIVE_MAX_FILES,
  shouldSkipArchive,
} from "../src/services/archive-policy";

const GiB = 1024 * 1024 * 1024;

describe("shouldSkipArchive", () => {
  test("under both ceilings -> build (skip=false)", () => {
    expect(shouldSkipArchive({ totalBytes: 79 * GiB, totalFiles: 3265 })).toEqual({ skip: false });
  });

  test("over the byte ceiling -> skip with a GB reason", () => {
    const d = shouldSkipArchive({ totalBytes: 680 * GiB, totalFiles: 11000 });
    expect(d.skip).toBe(true);
    expect(d.reason).toContain("GB");
    expect(d.reason).toContain("archive limit");
  });

  test("byte ceiling is strict (== is NOT over)", () => {
    expect(shouldSkipArchive({ totalBytes: ARCHIVE_MAX_BYTES, totalFiles: 10 }).skip).toBe(false);
    expect(shouldSkipArchive({ totalBytes: ARCHIVE_MAX_BYTES + 1, totalFiles: 10 }).skip).toBe(
      true,
    );
  });

  test("over the file-count ceiling -> skip even when bytes are modest", () => {
    const d = shouldSkipArchive({ totalBytes: 1 * GiB, totalFiles: ARCHIVE_MAX_FILES + 1 });
    expect(d.skip).toBe(true);
    expect(d.reason).toContain("files");
  });

  test("file ceiling is strict", () => {
    expect(shouldSkipArchive({ totalBytes: 1 * GiB, totalFiles: ARCHIVE_MAX_FILES }).skip).toBe(
      false,
    );
  });

  test("unknown total bytes -> NOT skipped (don't silently suppress every archive)", () => {
    expect(shouldSkipArchive({ totalBytes: null }).skip).toBe(false);
    expect(shouldSkipArchive({ totalBytes: undefined, totalFiles: null }).skip).toBe(false);
  });
});
