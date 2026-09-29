/**
 * Tests for the >100GB archive skip policy (epic #749, Phase 3 / #752).
 * Pure function, no I/O, no mocks.
 */

import { describe, expect, test } from "bun:test";
import {
  ARCHIVE_MAX_BYTES,
  ARCHIVE_MAX_FILES,
  decideArchiveSweepOutcome,
  isArchiveStaleForLatestVersion,
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

describe("decideArchiveSweepOutcome (#1514)", () => {
  test("no zip, in policy -> absent", () => {
    expect(decideArchiveSweepOutcome(0, { file_size: 1 * GiB, total_files: 100 })).toEqual({
      action: "absent",
    });
  });

  test("a real zip, in policy -> ready with its size", () => {
    expect(decideArchiveSweepOutcome(2048, { file_size: 1 * GiB, total_files: 100 })).toEqual({
      action: "ready",
      size: 2048,
    });
  });

  test("no zip, over policy -> skip with a reason", () => {
    const outcome = decideArchiveSweepOutcome(0, { file_size: 680 * GiB, total_files: 11000 });
    expect(outcome.action).toBe("skip");
    expect(outcome.action === "skip" && outcome.reason).toContain("exceeds");
  });

  test("a real zip, but NOW over policy -> skip, never ready (nm000284 shape)", () => {
    // The exact bug (#1514): getArchiveSize found a zip (built before the
    // dataset grew, or before the policy existed), but the row is over
    // policy right now. Policy wins -- the sweep must not mark this ready.
    const outcome = decideArchiveSweepOutcome(345_096_030_514, {
      file_size: 550_239_019_072,
      total_files: 14_922,
    });
    expect(outcome).toEqual({
      action: "skip",
      reason: expect.stringContaining("exceeds"),
    });
  });

  test("unknown size/file count -> never skip (ADR 0012 fail-open), so absent/ready as usual", () => {
    expect(decideArchiveSweepOutcome(0, { file_size: null, total_files: null })).toEqual({
      action: "absent",
    });
    expect(decideArchiveSweepOutcome(500, { file_size: null, total_files: null })).toEqual({
      action: "ready",
      size: 500,
    });
  });
});

describe("isArchiveStaleForLatestVersion (#1514)", () => {
  test("checked before the latest version was created -> stale", () => {
    expect(isArchiveStaleForLatestVersion("2026-09-28 17:58:40", "2026-09-28 19:43:14")).toBe(true);
  });

  test("checked after the latest version was created -> not stale", () => {
    expect(isArchiveStaleForLatestVersion("2026-09-28 19:50:00", "2026-09-28 19:43:14")).toBe(
      false,
    );
  });

  test("checked at exactly the same instant -> not stale (strict less-than)", () => {
    expect(isArchiveStaleForLatestVersion("2026-09-28 19:43:14", "2026-09-28 19:43:14")).toBe(
      false,
    );
  });

  test("either timestamp missing -> can't prove staleness, trust the status", () => {
    expect(isArchiveStaleForLatestVersion(null, "2026-09-28 19:43:14")).toBe(false);
    expect(isArchiveStaleForLatestVersion(undefined, "2026-09-28 19:43:14")).toBe(false);
    expect(isArchiveStaleForLatestVersion("2026-09-28 19:43:14", null)).toBe(false);
    expect(isArchiveStaleForLatestVersion(null, null)).toBe(false);
  });
});
