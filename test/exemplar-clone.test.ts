/**
 * Unit tests for the pure helpers in src/lib/exemplar-clone.ts (epic #923,
 * Phase 5). The orchestration functions (prepareExemplar/copyExemplarData/
 * finalizeExemplar/cloneExemplar) touch git, S3, and the live backend and can
 * only be exercised end-to-end on staging (no-mocks policy) — what's tested
 * here are the pure decision/transform helpers.
 */

import { describe, expect, test } from "bun:test";
import {
  type ExemplarFleetEntry,
  parseExemplarFleet,
  rewriteObjectKeyPrefix,
  scrubDatasetDescription,
} from "../src/lib/exemplar-clone";

describe("scrubDatasetDescription", () => {
  test("prefixes Name with [TEST COPY] and drops DatasetDOI", () => {
    const scrubbed = scrubDatasetDescription({
      Name: "My Real Dataset",
      DatasetDOI: "10.18112/openneuro.ds000001.v1.0.0",
      BIDSVersion: "1.8.0",
    });
    expect(scrubbed.Name).toBe("[TEST COPY] My Real Dataset");
    expect(scrubbed.DatasetDOI).toBeUndefined();
    expect(scrubbed.BIDSVersion).toBe("1.8.0");
  });

  test("missing Name still gets prefixed (empty original)", () => {
    const scrubbed = scrubDatasetDescription({ BIDSVersion: "1.8.0" });
    expect(scrubbed.Name).toBe("[TEST COPY] ");
  });

  test("does not mutate the input object", () => {
    const original = { Name: "Original", DatasetDOI: "10.1/x" };
    const originalCopy = { ...original };
    scrubDatasetDescription(original);
    expect(original).toEqual(originalCopy);
  });

  test("preserves other fields untouched", () => {
    const scrubbed = scrubDatasetDescription({
      Name: "X",
      Authors: ["A", "B"],
      License: "CC0",
    });
    expect(scrubbed.Authors).toEqual(["A", "B"]);
    expect(scrubbed.License).toBe("CC0");
  });
});

describe("rewriteObjectKeyPrefix", () => {
  test("rewrites the leading dataset id segment", () => {
    expect(
      rewriteObjectKeyPrefix("nm000132/objects/9f/3a/SHA256E-s1--ab.edf", "nm000132", "xx099900"),
    ).toBe("xx099900/objects/9f/3a/SHA256E-s1--ab.edf");
  });

  test("works for non-objects/ sub-prefixes (zarr, archives, version)", () => {
    expect(rewriteObjectKeyPrefix("on007262/zarr/sub-01_eeg.zarr", "on007262", "xx099901")).toBe(
      "xx099901/zarr/sub-01_eeg.zarr",
    );
    expect(rewriteObjectKeyPrefix("nm000104/archives/v1.0.0.zip", "nm000104", "xx099902")).toBe(
      "xx099902/archives/v1.0.0.zip",
    );
    expect(
      rewriteObjectKeyPrefix("nm000104/version/v1.0.0-records.json", "nm000104", "xx099902"),
    ).toBe("xx099902/version/v1.0.0-records.json");
  });

  test("throws when the key does not start with the source prefix", () => {
    expect(() =>
      rewriteObjectKeyPrefix("other000001/objects/a.edf", "nm000132", "xx099900"),
    ).toThrow(/does not start with expected source prefix/);
  });

  test("throws on a bare id without the trailing slash boundary", () => {
    // "nm0001320/objects/a.edf" must NOT match prefix "nm000132/" — guards
    // against accidental substring-prefix collisions between similar ids.
    expect(() =>
      rewriteObjectKeyPrefix("nm0001320/objects/a.edf", "nm000132", "xx099900"),
    ).toThrow();
  });
});

describe("parseExemplarFleet", () => {
  const valid: unknown = [
    { xx_id: "xx099900", source_id: "nm000132", modality: "eeg" },
    { xx_id: "xx099901", source_id: "on007262", modality: "meg", note: "smallest MEG" },
  ];

  test("accepts a well-formed fleet array", () => {
    const parsed = parseExemplarFleet(valid);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ xx_id: "xx099900", source_id: "nm000132", modality: "eeg" });
    expect(parsed[1]).toEqual({
      xx_id: "xx099901",
      source_id: "on007262",
      modality: "meg",
      note: "smallest MEG",
    });
  });

  test("rejects a non-array payload", () => {
    expect(() => parseExemplarFleet({ not: "an array" })).toThrow(/must be a JSON array/);
  });

  test("rejects an entry with a malformed xx_id", () => {
    const bad = [{ xx_id: "xx000001", source_id: "nm000132", modality: "eeg" }];
    expect(() => parseExemplarFleet(bad)).toThrow(/xx099900-xx099999/);
  });

  test("rejects an entry with a malformed source_id", () => {
    const bad = [{ xx_id: "xx099900", source_id: "ds007262", modality: "eeg" }];
    expect(() => parseExemplarFleet(bad)).toThrow(/must be an nm\/on dataset id/);
  });

  test("rejects an entry missing modality", () => {
    const bad = [{ xx_id: "xx099900", source_id: "nm000132" }];
    expect(() => parseExemplarFleet(bad)).toThrow(/modality is required/);
  });

  test("rejects a non-string note", () => {
    const bad = [{ xx_id: "xx099900", source_id: "nm000132", modality: "eeg", note: 42 }];
    expect(() => parseExemplarFleet(bad)).toThrow(/note must be a string/);
  });

  test("rejects a non-object entry", () => {
    expect(() => parseExemplarFleet(["not an object"])).toThrow(/is not an object/);
  });

  test("the repo's checked-in fleet file parses and validates", async () => {
    const raw = await Bun.file(`${import.meta.dir}/../scripts/exemplar-fleet.json`).json();
    const entries: ExemplarFleetEntry[] = parseExemplarFleet(raw);
    expect(entries.length).toBeGreaterThan(0);
    const ids = new Set(entries.map((e) => e.xx_id));
    expect(ids.size).toBe(entries.length); // no duplicate xx_id
  });
});
