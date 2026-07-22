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
  isAnnexContentKey,
  parseExemplarFleet,
  rewriteObjectKeyPrefix,
  scrubDatasetDescription,
} from "../src/lib/exemplar-clone";
import {
  type CopyItem,
  expectedSizesFromItems,
  filterAlreadyCopied,
  isKeyPresentAtDeclaredSize,
} from "../src/lib/s3-server-copy";

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

  test("excludes the S3 remote's annex-uuid marker from copy and key registration", () => {
    // Regression: the first real fleet run failed finalize with "1 of 3
    // git-annex key registrations failed" because listing <src>/objects/
    // returns the remote's annex-uuid marker alongside the content blobs.
    // It is not annexed content, and copying it would also overwrite the
    // freshly-initremoted nemar-s3-dev's own identity.
    expect(isAnnexContentKey("annex-uuid")).toBe(false);
    expect(isAnnexContentKey("MD5E-s8557052--955e36bad3c90cfc4d6ebf28ea52b094.txt")).toBe(true);
    expect(isAnnexContentKey("SHA256E-s12--abc.set")).toBe(true);
  });

  test("the checked-in fleet has no unfinalized placeholder sources", async () => {
    // `nemar admin exemplar create --all` SKIPS any entry still set to the
    // nm000000 placeholder, so a stale placeholder silently shrinks the fleet
    // instead of failing (epic #923 Phase 7).
    const raw = await Bun.file(`${import.meta.dir}/../scripts/exemplar-fleet.json`).json();
    const entries: ExemplarFleetEntry[] = parseExemplarFleet(raw);
    const placeholders = entries.filter((e) => e.source_id === "nm000000");
    expect(placeholders).toEqual([]);
  });

  test("every fleet source is a distinct real dataset id", async () => {
    const raw = await Bun.file(`${import.meta.dir}/../scripts/exemplar-fleet.json`).json();
    const entries: ExemplarFleetEntry[] = parseExemplarFleet(raw);
    const sources = new Set(entries.map((e) => e.source_id));
    expect(sources.size).toBe(entries.length); // cloning one source twice is a spec bug
  });
});

describe("copy-integrity via s3-server-copy helpers (#982, same #967 bug)", () => {
  // exemplar-clone.ts's own copySubPrefix/finalizeExemplar are not directly
  // unit-testable (they touch S3/git-annex/the live backend); these tests
  // exercise the exact size-aware helpers those functions now call, shaped
  // like exemplar-clone's real usage (relative keys, s3://nemar-dev/... dest
  // URIs), mirroring test/copy-size-integrity.unit.test.ts for import-openneuro.
  const mk = (key: string): CopyItem => ({
    key,
    source: { bucket: "nemar", key: `nm000132/objects/${key}`, region: "us-east-2" },
    httpUrl: null,
    destUri: `s3://nemar-dev/xx099900/objects/${key}`,
  });

  test("copySubPrefix's resume filter re-copies a present-but-0-byte annex key", () => {
    const items = [mk("SHA256E-s10565888--abc123.edf")];
    // destExisting: the key is present at the destination but 0 bytes, e.g.
    // a corrupt leftover from a prior failed run.
    const destExisting = new Map([["SHA256E-s10565888--abc123.edf", 0]]);
    const { toCopy, skipped } = filterAlreadyCopied(
      items,
      destExisting,
      expectedSizesFromItems(items),
    );
    expect(toCopy.map((i) => i.key)).toEqual(["SHA256E-s10565888--abc123.edf"]);
    expect(skipped).toEqual([]);
  });

  test("copySubPrefix's resume filter skips a correctly-sized present key", () => {
    const items = [mk("SHA256E-s10565888--abc123.edf")];
    const destExisting = new Map([["SHA256E-s10565888--abc123.edf", 10565888]]);
    const { toCopy, skipped } = filterAlreadyCopied(
      items,
      destExisting,
      expectedSizesFromItems(items),
    );
    expect(toCopy).toEqual([]);
    expect(skipped).toEqual(["SHA256E-s10565888--abc123.edf"]);
  });

  test("finalizeExemplar's verify gate treats a present-but-0-byte annex key as missing", () => {
    const keys = ["SHA256E-s10565888--abc123.edf"];
    const existing = new Map([["SHA256E-s10565888--abc123.edf", 0]]);
    const missing = keys.filter((k) => !isKeyPresentAtDeclaredSize(k, existing));
    expect(missing).toEqual(["SHA256E-s10565888--abc123.edf"]);
  });

  test("finalizeExemplar's verify gate passes a correctly-sized present key", () => {
    const keys = ["SHA256E-s10565888--abc123.edf"];
    const existing = new Map([["SHA256E-s10565888--abc123.edf", 10565888]]);
    const missing = keys.filter((k) => !isKeyPresentAtDeclaredSize(k, existing));
    expect(missing).toEqual([]);
  });

  test("a non-annex key (no declared size) stays presence-checked, not special-cased", () => {
    const keys = ["git:deadbeef"];
    const existing = new Map([["git:deadbeef", 0]]);
    const missing = keys.filter((k) => !isKeyPresentAtDeclaredSize(k, existing));
    expect(missing).toEqual([]); // present, no declared size to check -> not missing
  });
});
