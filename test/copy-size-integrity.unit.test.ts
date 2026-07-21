/**
 * Pure unit tests for the #967 copy-integrity fix: OpenNeuro imports must
 * never treat a 0-byte / truncated S3 object as a successfully copied file.
 * No network, no AWS creds, no live backend, no CLI subprocess -- routes to
 * the required unit-pure tier.
 *
 * Covers the three size-aware primitives added in s3-server-copy.ts:
 *   - annexKeyDeclaredSize: the size encoded in a git-annex key name
 *   - isKeyPresentAtDeclaredSize: the exact check finalizeImport now uses
 *     to gate publish (import-openneuro.ts)
 *   - filterAlreadyCopied + expectedSizesFromItems: the exact resume check
 *     copyShard now uses to decide what still needs copying
 */

import { describe, expect, test } from "bun:test";
import {
  type CopyItem,
  annexKeyDeclaredSize,
  expectedSizesFromItems,
  filterAlreadyCopied,
  isKeyPresentAtDeclaredSize,
} from "../src/lib/s3-server-copy";

describe("annexKeyDeclaredSize", () => {
  test("parses SHA256E keys", () => {
    expect(annexKeyDeclaredSize("SHA256E-s10565888--abc123def456.edf")).toBe(10565888);
  });

  test("parses MD5E keys", () => {
    expect(annexKeyDeclaredSize("MD5E-s987654--cafebabe.bdf")).toBe(987654);
  });

  test("size embedded anywhere in the string still matches (e.g. a full S3 key/URI)", () => {
    expect(annexKeyDeclaredSize("s3://nemar/on0001/objects/SHA256E-s42--ab.fif")).toBe(42);
  });

  test("returns null for non-annex git: keys", () => {
    expect(annexKeyDeclaredSize("git:abc123def456")).toBeNull();
  });

  test("returns null for garbage / no size marker", () => {
    expect(annexKeyDeclaredSize("")).toBeNull();
    expect(annexKeyDeclaredSize("not-an-annex-key")).toBeNull();
    expect(annexKeyDeclaredSize("SHA256E--abc123.edf")).toBeNull(); // missing sNNN
  });
});

describe("isKeyPresentAtDeclaredSize (finalizeImport's publish gate)", () => {
  test("correctly-sized annex key counts as present", () => {
    const existing = new Map([["SHA256E-s1000--abc.edf", 1000]]);
    expect(isKeyPresentAtDeclaredSize("SHA256E-s1000--abc.edf", existing)).toBe(true);
  });

  test("0-byte object counts as missing even though the key exists (#967)", () => {
    const existing = new Map([["SHA256E-s1000--abc.edf", 0]]);
    expect(isKeyPresentAtDeclaredSize("SHA256E-s1000--abc.edf", existing)).toBe(false);
  });

  test("size-mismatched (truncated) object counts as missing", () => {
    const existing = new Map([["SHA256E-s1000--abc.edf", 512]]);
    expect(isKeyPresentAtDeclaredSize("SHA256E-s1000--abc.edf", existing)).toBe(false);
  });

  test("absent key counts as missing", () => {
    expect(isKeyPresentAtDeclaredSize("SHA256E-s1000--abc.edf", new Map())).toBe(false);
  });

  test("non-annex git: key is presence-only (no declared size to check)", () => {
    const existing = new Map([["git:abc123", 0]]);
    expect(isKeyPresentAtDeclaredSize("git:abc123", existing)).toBe(true);
  });

  test("manifest-filter shape: mixed batch flags only the bad keys as missing", () => {
    const items = [
      { key: "SHA256E-s1000--ok.edf" },
      { key: "SHA256E-s2000--empty.edf" },
      { key: "SHA256E-s3000--truncated.edf" },
      { key: "git:deadbeef" },
    ];
    const existing = new Map([
      ["SHA256E-s1000--ok.edf", 1000],
      ["SHA256E-s2000--empty.edf", 0],
      ["SHA256E-s3000--truncated.edf", 1500],
      ["git:deadbeef", 0],
    ]);
    const missing = items.filter((it) => !isKeyPresentAtDeclaredSize(it.key, existing));
    expect(missing.map((it) => it.key)).toEqual([
      "SHA256E-s2000--empty.edf",
      "SHA256E-s3000--truncated.edf",
    ]);
  });
});

describe("expectedSizesFromItems + filterAlreadyCopied (copyShard's resume gate)", () => {
  const mk = (key: string): CopyItem => ({
    key,
    source: { bucket: "openneuro.org", key: `ds/${key}` },
    httpUrl: null,
    destUri: `s3://nemar/on1/objects/${key}`,
  });

  test("expectedSizesFromItems derives sizes only for annex keys", () => {
    const items = [mk("SHA256E-s100--a.edf"), mk("MD5E-s200--b.bdf"), mk("git:deadbeef")];
    const sizes = expectedSizesFromItems(items);
    expect(sizes.get("SHA256E-s100--a.edf")).toBe(100);
    expect(sizes.get("MD5E-s200--b.bdf")).toBe(200);
    expect(sizes.has("git:deadbeef")).toBe(false);
  });

  test("a 0-byte existing object is re-copied, not skipped", () => {
    const items = [mk("SHA256E-s1000--a.edf")];
    const existing = new Map([["SHA256E-s1000--a.edf", 0]]);
    const { toCopy, skipped } = filterAlreadyCopied(items, existing, expectedSizesFromItems(items));
    expect(toCopy.map((i) => i.key)).toEqual(["SHA256E-s1000--a.edf"]);
    expect(skipped).toEqual([]);
  });

  test("a correctly-sized existing object is skipped", () => {
    const items = [mk("SHA256E-s1000--a.edf")];
    const existing = new Map([["SHA256E-s1000--a.edf", 1000]]);
    const { toCopy, skipped } = filterAlreadyCopied(items, existing, expectedSizesFromItems(items));
    expect(toCopy).toEqual([]);
    expect(skipped).toEqual(["SHA256E-s1000--a.edf"]);
  });

  test("mixed batch: only the bad object is re-copied", () => {
    const items = [
      mk("SHA256E-s1000--good.edf"),
      mk("SHA256E-s2000--empty.edf"),
      mk("SHA256E-s3000--truncated.edf"),
    ];
    const existing = new Map([
      ["SHA256E-s1000--good.edf", 1000],
      ["SHA256E-s2000--empty.edf", 0],
      ["SHA256E-s3000--truncated.edf", 1],
    ]);
    const { toCopy, skipped } = filterAlreadyCopied(items, existing, expectedSizesFromItems(items));
    expect(toCopy.map((i) => i.key)).toEqual([
      "SHA256E-s2000--empty.edf",
      "SHA256E-s3000--truncated.edf",
    ]);
    expect(skipped).toEqual(["SHA256E-s1000--good.edf"]);
  });
});
