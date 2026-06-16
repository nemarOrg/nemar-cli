/**
 * Tests for the pure pre-screen decision function (epic #749, Phase 4 / #753):
 *   - decidePrescreenOutcome: combine the `claude -p` verdict with the Worker's
 *     authoritative S3 presence check, symmetric in BOTH directions.
 *   - isDataShortageReason: which block reasons the S3 check can refute.
 *
 * The git-annex blind spot (#753): for symlink-stored annex content the
 * workflow's git-tree heuristic reports "0 annexed files / no binary data" and
 * blocks a dataset whose blobs ARE in S3. The Worker, holding the AWS creds,
 * must overturn that false data-shortage block.
 *
 * Pure functions, no I/O, no mocks.
 */

import { describe, expect, test } from "bun:test";
import {
  decidePrescreenOutcome,
  isDataShortageReason,
  type PrescreenS3Presence,
} from "../src/routes/webhooks";

const present: PrescreenS3Presence = { totalSize: 478_659_462_060, objectCount: 642 };
const capped: PrescreenS3Presence = { totalSize: 1_000, objectCount: undefined };
const empty: PrescreenS3Presence = { totalSize: 0, objectCount: 0 };

describe("isDataShortageReason", () => {
  test("matches the workflow's annex-blind data-shortage phrasings", () => {
    for (const r of [
      "No real data: declared data is ~0 for 58 subjects",
      "The dataset declares 0.0 MB across 0 annexed files",
      "Binary data files not found",
      "data volume implausibly small",
      "Git-annex reports 0 annexed files",
    ]) {
      expect(isDataShortageReason(r)).toBe(true);
    }
  });

  test("does NOT match README / metadata reasons the Worker cannot judge", () => {
    for (const r of [
      "README.md is missing or empty",
      "dataset_description.json is missing Authors",
      "Name field is missing",
      // bare 'storage'/'annex' substrings must not over-match (#753 review)
      "README documents only the storage layout and download steps",
      "Dataset name references an annexure not included in the description",
    ]) {
      expect(isDataShortageReason(r)).toBe(false);
    }
  });
});

describe("decidePrescreenOutcome", () => {
  test("pass + no S3 read -> not blocked, reasons unchanged", () => {
    const r = decidePrescreenOutcome("pass", [], null);
    expect(r.blocked).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  test("block + S3 read failed (null) -> trust the workflow, stays blocked", () => {
    const r = decidePrescreenOutcome("block", ["README.md is missing"], null);
    expect(r.blocked).toBe(true);
    expect(r.reasons).toEqual(["README.md is missing"]);
  });

  // The #753 fix: annex-blind data-shortage block, but S3 holds the blobs.
  test("block for ONLY data-shortage + S3 present -> downgraded to pass", () => {
    const r = decidePrescreenOutcome(
      "block",
      ["The dataset declares 0.0 MB across 0 annexed files", "Binary data files not found"],
      present,
    );
    expect(r.blocked).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  test("block for data-shortage + S3 present via page-cap (objectCount undefined) -> pass", () => {
    const r = decidePrescreenOutcome("block", ["No real data found"], capped);
    expect(r.blocked).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  test("mixed reasons + S3 present -> data reason stripped, non-data reason still blocks", () => {
    const r = decidePrescreenOutcome(
      "block",
      ["0.0 MB across 0 annexed files", "dataset_description.json is missing Authors"],
      present,
    );
    expect(r.blocked).toBe(true);
    expect(r.reasons).toEqual(["dataset_description.json is missing Authors"]);
  });

  test("block for non-data reason + S3 present -> still blocked, reasons unchanged", () => {
    const r = decidePrescreenOutcome("block", ["README is empty boilerplate"], present);
    expect(r.blocked).toBe(true);
    expect(r.reasons).toEqual(["README is empty boilerplate"]);
  });

  test("block with NO reasons + S3 present -> stays blocked (never silently unblock a reasonless block)", () => {
    const r = decidePrescreenOutcome("block", [], present);
    expect(r.blocked).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  test("block with a 'storage'/'annex' substring in a non-data reason + S3 present -> still blocked", () => {
    const r = decidePrescreenOutcome(
      "block",
      ["README documents only the storage layout and download steps"],
      present,
    );
    expect(r.blocked).toBe(true);
    expect(r.reasons).toEqual(["README documents only the storage layout and download steps"]);
  });

  test("pass + S3 empty -> blocked with a synthetic storage reason (workflow passed, blobs missing)", () => {
    const r = decidePrescreenOutcome("pass", [], empty);
    expect(r.blocked).toBe(true);
    expect(r.reasons.some((x) => /storage/i.test(x))).toBe(true);
  });

  test("block + S3 empty -> stays blocked; does not duplicate an existing data reason", () => {
    const r = decidePrescreenOutcome("block", ["No real data in storage"], empty);
    expect(r.blocked).toBe(true);
    expect(r.reasons).toEqual(["No real data in storage"]);
  });

  test("does not mutate the caller's reasons array", () => {
    const reasons = ["0 annexed files"];
    decidePrescreenOutcome("block", reasons, present);
    expect(reasons).toEqual(["0 annexed files"]);
  });
});
