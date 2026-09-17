/**
 * Unit tests for the pure helpers in src/lib/exemplar-clone.ts (epic #923,
 * Phase 5). The orchestration functions (prepareExemplar/copyExemplarData/
 * finalizeExemplar/cloneExemplar) touch git, S3, and the live backend and can
 * only be exercised end-to-end on staging (no-mocks policy) — what's tested
 * here are the pure decision/transform helpers.
 */

import { describe, expect, test } from "bun:test";
// The publication gate's own predicate, imported rather than restated: the
// clone writes a placeholder and the gate decides whether it counts, so a test
// that spelled the rule twice could pass while the two disagreed.
import { isPlaceholderAuthor } from "../backend/src/services/submission-minimums";
import {
  type ExemplarFleetEntry,
  findMissingCopiedKeys,
  isAnnexContentKey,
  parseExemplarFleet,
  planSubPrefixCopy,
  rewriteObjectKeyPrefix,
  scrubDatasetDescription,
} from "../src/lib/exemplar-clone";
import type { CopyItem } from "../src/lib/s3-server-copy";

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

  test("leaves Authors alone by default, which is the depositor's business", () => {
    // NEMAR does not scrub a depositor's own files. An ordinary exemplar is a
    // copy of a published dataset and keeps its real author list.
    const scrubbed = scrubDatasetDescription({ Name: "X", Authors: ["Ada Lovelace"] });
    expect(scrubbed.Authors).toEqual(["Ada Lovelace"]);
  });

  test("does NOT blind Authors, and the gate would refuse what it leaves", () => {
    // Withdrawn in #1433. The blind was added (#1423) because the fleet's
    // anonymous deposit had no depositor to follow the instruction that a
    // depositor gets: blind `dataset_description.json` yourself. The real fix
    // was to stop keeping that fixture in the exemplar fleet at all, so the
    // clone tool goes back to scrubbing only what is unsafe to copy.
    const scrubbed = scrubDatasetDescription({
      Name: "X",
      Authors: ["Ada Lovelace", "Charles Babbage"],
    });
    expect(scrubbed.Authors).toEqual(["Ada Lovelace", "Charles Babbage"]);
    expect(scrubbed.Name).toBe("[TEST COPY] X");
    expect(scrubbed.DatasetDOI).toBeUndefined();

    // And the consequence is stated rather than assumed: what the clone leaves
    // behind would NOT satisfy the anonymous-release gate. That is correct now
    // -- an exemplar has no anonymous release to take -- and it is the fact
    // that makes re-adding a blind here the wrong instinct: the standing
    // anonymous deposit is uploaded from a tree an operator blinded by hand,
    // which is exactly what a real anonymous depositor does.
    for (const entry of scrubbed.Authors as string[]) {
      expect(isPlaceholderAuthor(entry)).toBe(false);
    }
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

  test("an anonymous entry is REFUSED, in either spelling", () => {
    // Withdrawn in #1433, and refused rather than ignored. The fleet declared a
    // standing anonymous deposit at xx099907 until this epic; the placement was
    // the mistake, because `xx` publishes only through the exemplar exception
    // while an anonymous deposit's defining event is an anonymous RELEASE. A
    // silent ignore would let someone re-add the key and get a fixture that
    // looks right and cannot do its job -- which is exactly what happened the
    // first time.
    for (const anonymous of [true, false]) {
      expect(() =>
        parseExemplarFleet([
          { xx_id: "xx099900", source_id: "on000001", modality: "eeg", anonymous },
        ]),
      ).toThrow(/no longer declares an anonymous deposit/);
    }
  });

  test("the refusal names where the anonymous deposit went", () => {
    // A refusal that does not say what to do instead gets worked around.
    let message = "";
    try {
      parseExemplarFleet([
        { xx_id: "xx099900", source_id: "on000001", modality: "eeg", anonymous: true },
      ]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/reserved nm id/);
    expect(message).toMatch(/ADR 0068/);
  });

  test("the checked-in fleet declares no anonymous deposit", async () => {
    // The file itself, not a constructed entry: this is what would fail if
    // xx099907 were restored to it.
    const raw = await Bun.file(`${import.meta.dir}/../scripts/exemplar-fleet.json`).json();
    const entries: ExemplarFleetEntry[] = parseExemplarFleet(raw);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).not.toHaveProperty("anonymous");
      expect(entry.xx_id).not.toBe("xx099907");
    }
  });

  test("every fleet source is a distinct real dataset id", async () => {
    const raw = await Bun.file(`${import.meta.dir}/../scripts/exemplar-fleet.json`).json();
    const entries: ExemplarFleetEntry[] = parseExemplarFleet(raw);
    const sources = new Set(entries.map((e) => e.source_id));
    expect(sources.size).toBe(entries.length); // cloning one source twice is a spec bug
  });
});

describe("planSubPrefixCopy / findMissingCopiedKeys (#982, same #967 bug)", () => {
  // These are the exact functions copySubPrefix and finalizeExemplar call
  // (exported from exemplar-clone.ts itself, not the raw s3-server-copy
  // helpers), so a future revert of either call site back to presence-only
  // matching would fail these tests. Shaped like exemplar-clone's real usage
  // (relative keys, s3://nemar-dev/... dest URIs), mirroring
  // test/copy-size-integrity.unit.test.ts for import-openneuro.
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
    const { toCopy, skipped } = planSubPrefixCopy(items, destExisting);
    expect(toCopy.map((i) => i.key)).toEqual(["SHA256E-s10565888--abc123.edf"]);
    expect(skipped).toEqual([]);
  });

  test("copySubPrefix's resume filter skips a correctly-sized present key", () => {
    const items = [mk("SHA256E-s10565888--abc123.edf")];
    const destExisting = new Map([["SHA256E-s10565888--abc123.edf", 10565888]]);
    const { toCopy, skipped } = planSubPrefixCopy(items, destExisting);
    expect(toCopy).toEqual([]);
    expect(skipped).toEqual(["SHA256E-s10565888--abc123.edf"]);
  });

  test("finalizeExemplar's verify gate treats a present-but-0-byte annex key as missing", () => {
    const keys = ["SHA256E-s10565888--abc123.edf"];
    const existing = new Map([["SHA256E-s10565888--abc123.edf", 0]]);
    const missing = findMissingCopiedKeys(keys, existing);
    expect(missing).toEqual(["SHA256E-s10565888--abc123.edf"]);
  });

  test("finalizeExemplar's verify gate passes a correctly-sized present key", () => {
    const keys = ["SHA256E-s10565888--abc123.edf"];
    const existing = new Map([["SHA256E-s10565888--abc123.edf", 10565888]]);
    const missing = findMissingCopiedKeys(keys, existing);
    expect(missing).toEqual([]);
  });

  test("a non-annex key (no declared size) stays presence-checked, not special-cased", () => {
    const keys = ["git:deadbeef"];
    const existing = new Map([["git:deadbeef", 0]]);
    const missing = findMissingCopiedKeys(keys, existing);
    expect(missing).toEqual([]); // present, no declared size to check -> not missing
  });
});
