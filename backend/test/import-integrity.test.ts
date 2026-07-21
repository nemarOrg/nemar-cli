/**
 * Tests for the per-key S3 integrity primitive (epic #967 Phase 2, #969):
 * annexKeyDeclaredSize / isKeyPresentAtDeclaredSize (a Workers-side port of
 * the identically-named Phase 1 CLI helpers in src/lib/s3-server-copy.ts) and
 * the pure manifest-vs-listing comparison, compareManifestToListing. No mocks
 * -- these are pure functions over plain data.
 */

import { describe, expect, test } from "bun:test";
import {
  annexKeyDeclaredSize,
  compareManifestToListing,
  isKeyPresentAtDeclaredSize,
} from "../src/services/import-integrity";

describe("annexKeyDeclaredSize", () => {
  test("extracts the declared size from an annex key", () => {
    expect(annexKeyDeclaredSize("SHA256E-s10565888--abc123.edf")).toBe(10565888);
    expect(annexKeyDeclaredSize("MD5E-s42--deadbeef.tsv")).toBe(42);
  });

  test("returns 0 (not null) for a genuinely-declared-empty file", () => {
    expect(annexKeyDeclaredSize("SHA256E-s0--abc123.json")).toBe(0);
  });

  test("returns null for a git-backed (non-annex) key", () => {
    expect(annexKeyDeclaredSize("git:abcdef1234567890")).toBeNull();
  });

  test("returns null for a key with no size pattern", () => {
    expect(annexKeyDeclaredSize("not-a-key")).toBeNull();
  });
});

describe("isKeyPresentAtDeclaredSize", () => {
  test("true when present at the exact declared size", () => {
    const existing = new Map([["SHA256E-s100--abc.edf", 100]]);
    expect(isKeyPresentAtDeclaredSize("SHA256E-s100--abc.edf", existing)).toBe(true);
  });

  test("false when absent entirely", () => {
    expect(isKeyPresentAtDeclaredSize("SHA256E-s100--abc.edf", new Map())).toBe(false);
  });

  test("false when present but 0 bytes with a nonzero declared size (the #967 bug)", () => {
    const existing = new Map([["SHA256E-s100--abc.edf", 0]]);
    expect(isKeyPresentAtDeclaredSize("SHA256E-s100--abc.edf", existing)).toBe(false);
  });

  test("false when present at the wrong (truncated) size", () => {
    const existing = new Map([["SHA256E-s100--abc.edf", 63]]);
    expect(isKeyPresentAtDeclaredSize("SHA256E-s100--abc.edf", existing)).toBe(false);
  });

  test("true for a declared-0 file present at 0 bytes (not flagged)", () => {
    const existing = new Map([["SHA256E-s0--abc.json", 0]]);
    expect(isKeyPresentAtDeclaredSize("SHA256E-s0--abc.json", existing)).toBe(true);
  });

  test("presence alone suffices for a git-backed key (no declared size)", () => {
    const existing = new Map([["git:abcdef", 512]]);
    expect(isKeyPresentAtDeclaredSize("git:abcdef", existing)).toBe(true);
  });
});

describe("compareManifestToListing", () => {
  test("expected null (no published manifest) -> conservatively not complete", () => {
    const result = compareManifestToListing(null, new Map([["a", 1]]));
    expect(result).toEqual({
      complete: false,
      missingKeys: [],
      zeroByteKeys: [],
      expectedCount: 0,
      presentCount: 1,
    });
  });

  test("everything present at declared size -> complete", () => {
    const expected = {
      "sub-01/eeg/data.edf": { key: "SHA256E-s100--aaa.edf", size: 100 },
      "dataset_description.json": { key: "git:deadbeef", size: 42 },
    };
    const existing = new Map([["SHA256E-s100--aaa.edf", 100]]);
    const result = compareManifestToListing(expected, existing);
    expect(result.complete).toBe(true);
    expect(result.missingKeys).toEqual([]);
    expect(result.zeroByteKeys).toEqual([]);
    expect(result.expectedCount).toBe(1); // git: entry excluded from the annex-expected set
    expect(result.presentCount).toBe(1);
  });

  test("a 0-byte present key with nonzero declared size is missing AND zero-byte", () => {
    const expected = { "sub-01/eeg/data.edf": { key: "SHA256E-s100--aaa.edf", size: 100 } };
    const existing = new Map([["SHA256E-s100--aaa.edf", 0]]);
    const result = compareManifestToListing(expected, existing);
    expect(result.complete).toBe(false);
    expect(result.missingKeys).toEqual(["SHA256E-s100--aaa.edf"]);
    expect(result.zeroByteKeys).toEqual(["SHA256E-s100--aaa.edf"]);
  });

  test("an absent key is missing but NOT zero-byte (never landed at all)", () => {
    const expected = { "sub-01/eeg/data.edf": { key: "SHA256E-s100--aaa.edf", size: 100 } };
    const result = compareManifestToListing(expected, new Map());
    expect(result.complete).toBe(false);
    expect(result.missingKeys).toEqual(["SHA256E-s100--aaa.edf"]);
    expect(result.zeroByteKeys).toEqual([]);
  });

  test("a wrong-size (truncated, nonzero) present key is missing but not zero-byte", () => {
    const expected = { "sub-01/eeg/data.edf": { key: "SHA256E-s100--aaa.edf", size: 100 } };
    const existing = new Map([["SHA256E-s100--aaa.edf", 63]]);
    const result = compareManifestToListing(expected, existing);
    expect(result.missingKeys).toEqual(["SHA256E-s100--aaa.edf"]);
    expect(result.zeroByteKeys).toEqual([]);
  });

  test("a declared-0 file present at 0 bytes is complete, not flagged", () => {
    const expected = { "sub-01/eeg/empty.json": { key: "SHA256E-s0--aaa.json", size: 0 } };
    const existing = new Map([["SHA256E-s0--aaa.json", 0]]);
    const result = compareManifestToListing(expected, existing);
    expect(result.complete).toBe(true);
    expect(result.missingKeys).toEqual([]);
    expect(result.zeroByteKeys).toEqual([]);
  });

  test("git:-keyed entries never appear in expectedCount/missingKeys even when 'missing'", () => {
    const expected = { "README.md": { key: "git:deadbeef", size: 12 } };
    const result = compareManifestToListing(expected, new Map());
    expect(result.expectedCount).toBe(0);
    expect(result.complete).toBe(true); // nothing annex-keyed to check
    expect(result.missingKeys).toEqual([]);
  });

  test("mixed manifest: only the missing annex keys are reported", () => {
    const expected = {
      "sub-01/eeg/a.edf": { key: "SHA256E-s10--a.edf", size: 10 },
      "sub-02/eeg/b.edf": { key: "SHA256E-s20--b.edf", size: 20 },
      "sub-03/eeg/c.edf": { key: "SHA256E-s0--c.edf", size: 0 },
      "README.md": { key: "git:cafebabe", size: 5 },
    };
    const existing = new Map([
      ["SHA256E-s10--a.edf", 10],
      ["SHA256E-s20--b.edf", 0], // corrupt leftover
      ["SHA256E-s0--c.edf", 0], // genuinely empty, fine
    ]);
    const result = compareManifestToListing(expected, existing);
    expect(result.complete).toBe(false);
    expect(result.expectedCount).toBe(3);
    expect(result.presentCount).toBe(2);
    expect(result.missingKeys).toEqual(["SHA256E-s20--b.edf"]);
    expect(result.zeroByteKeys).toEqual(["SHA256E-s20--b.edf"]);
  });
});
