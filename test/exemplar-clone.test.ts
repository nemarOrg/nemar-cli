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
  anonymousExemplar,
  findMissingCopiedKeys,
  isAnnexContentKey,
  isDesignatedAnonymous,
  parseExemplarFleet,
  planSubPrefixCopy,
  rewriteObjectKeyPrefix,
  scrubDatasetDescription,
} from "../src/lib/exemplar-clone";
// The publication gate's own predicate, imported rather than restated: the
// clone writes a placeholder and the gate decides whether it counts, so a test
// that spelled the rule twice could pass while the two disagreed.
import { isPlaceholderAuthor } from "../backend/src/services/submission-minimums";
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

  test("blinds Authors for the anonymous exemplar, because no depositor will", () => {
    // #1423: the publication request refuses an anonymous release whose
    // Authors still names anybody, and a fixture has nobody to act on that
    // instruction. Without this the fleet's anonymous deposit inherits the
    // SOURCE dataset's real names and can never complete the release that
    // gives it a public row, a version and a manifest.
    const scrubbed = scrubDatasetDescription(
      { Name: "X", Authors: ["Ada Lovelace", "Charles Babbage"] },
      { anonymous: true },
    );
    expect(scrubbed.Authors).toEqual(["Anonymous"]);
    expect(scrubbed.Name).toBe("[TEST COPY] X");
  });

  test("the placeholder it writes is one the publication gate accepts", () => {
    // The two must not be able to disagree about what counts as blinded, so
    // this asserts against the gate's own predicate rather than restating it.
    const scrubbed = scrubDatasetDescription({ Name: "X", Authors: ["Real Person"] }, {
      anonymous: true,
    });
    for (const entry of scrubbed.Authors as string[]) {
      expect(isPlaceholderAuthor(entry)).toBe(true);
    }
    // The control: the names it replaced would NOT have passed.
    expect(isPlaceholderAuthor("Real Person")).toBe(false);
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

  test("anonymous must be literally true, never false", async () => {
    // Two states, not three. An explicit `false` reads as a deliberate
    // statement about a row and would invite someone to interpret it as
    // "was anonymous, is not any more" -- which is a fact the fleet file has
    // no business carrying.
    expect(() =>
      parseExemplarFleet([
        { xx_id: "xx099900", source_id: "on000001", modality: "eeg", anonymous: false },
      ]),
    ).toThrow(/anonymous must be omitted or literally true/);
    const ok = parseExemplarFleet([
      { xx_id: "xx099900", source_id: "on000001", modality: "eeg", anonymous: true },
    ]);
    expect(ok[0].anonymous).toBe(true);
  });

  test("at most one anonymous exemplar is declared", () => {
    // "The anonymous exemplar" is how the runbooks, the tests and the fleet
    // tooling all refer to it. A second one makes that phrase ambiguous, and
    // an ambiguous referent is worse than no fixture at all.
    expect(() =>
      parseExemplarFleet([
        { xx_id: "xx099900", source_id: "on000001", modality: "eeg", anonymous: true },
        { xx_id: "xx099901", source_id: "on000002", modality: "eeg", anonymous: true },
      ]),
    ).toThrow(/declares 2 anonymous exemplars/);
  });

  test("the checked-in fleet designates a standing anonymous deposit", async () => {
    // The point of designating one: anonymity is otherwise only ever exercised
    // against rows a test just created and tore down. This is the one place
    // the pre-publication state exists continuously on staging.
    const raw = await Bun.file(`${import.meta.dir}/../scripts/exemplar-fleet.json`).json();
    const entries: ExemplarFleetEntry[] = parseExemplarFleet(raw);
    const designated = anonymousExemplar(entries);
    expect(designated).not.toBeNull();
    expect(designated?.xx_id).toBe("xx099907");
    // It has to say why it must never be published, because the failure mode
    // is silent and permanent: the 0085 triggers refuse anonymous = 1 once
    // first_published_at is stamped, so one `--publish` ends the fixture.
    expect(designated?.note).toMatch(/never published/i);
  });

  test("the designation is keyed by xx id, so --source cannot bypass it", async () => {
    // Creating this fixture is a one-off, so `exemplar create xx099907` is the
    // command that will actually be run. An earlier version of this change
    // wired only the `--all` loop, which would have produced a non-anonymous
    // row under the name of the anonymous fixture -- silently, and only
    // discoverable once a test that depends on it started passing for the
    // wrong reason.
    const entries = parseExemplarFleet([
      { xx_id: "xx099900", source_id: "on000001", modality: "eeg" },
      { xx_id: "xx099907", source_id: "on000002", modality: "eeg", anonymous: true },
    ]);
    expect(isDesignatedAnonymous(entries, "xx099907")).toBe(true);
    expect(isDesignatedAnonymous(entries, "xx099900")).toBe(false);
    expect(isDesignatedAnonymous(entries, "xx099999")).toBe(false);
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
