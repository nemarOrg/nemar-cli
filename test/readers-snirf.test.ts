/**
 * The SNIRF reader (`shared/readers/snirf.ts`, card A4 of the publication-queue plan) and the one
 * mapping from the HDF5 walker's reasons to the registry's (`shared/readers/hdf5-incomplete.ts`).
 *
 * Every file read here is a real SNIRF file or a copy of one with one change, written by h5py
 * (`test/fixtures/hdf5/README.md` records each). Files are read through the registry's page cache
 * and limits, as the screen reads them.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HDF5_LIMITS, type Hdf5Entry, type Hdf5Incomplete } from "../shared/hdf5-meta";
import {
  type FormatReader,
  LimitExceeded,
  READERS,
  type RangeSource,
  ReadFailure,
  type ReaderLimits,
  bufferSource,
  cachedSource,
  readerFor,
} from "../shared/identifier-readers";
import { DATE_KINDS, DIRECT_KINDS, type Finding } from "../shared/identifier-scan";
import { INCOMPLETE_COPY, KIND_COPY } from "../shared/identifier-screen-copy";
import {
  HDF5_INCOMPLETE_REASON,
  walkForReader,
  walkLimits,
} from "../shared/readers/hdf5-incomplete";
import {
  SHORT_CODE_MAX,
  SNIRF_READER,
  readSubjectId,
  scanSnirfEntries,
  scanSubjectId,
} from "../shared/readers/snirf";

const DIR = join(import.meta.dir, "fixtures", "hdf5");
const load = (name: string) => new Uint8Array(readFileSync(join(DIR, name)));

const BIDS_PATH = "sub-07/nirs/sub-07_task-rest_nirs.snirf";

/** Scan bytes with a reader through the registry's page cache, recording every range asked. */
async function scan(
  bytes: Uint8Array,
  options: { reader?: FormatReader; path?: string; limits?: ReaderLimits; src?: RangeSource } = {},
) {
  const reader = options.reader ?? SNIRF_READER;
  const limits = options.limits ?? reader.limits;
  const cached = cachedSource(options.src ?? bufferSource(bytes), limits);
  const ranges: [number, number][] = [];
  const recorded = {
    get size() {
      return cached.size;
    },
    get limited() {
      return cached.limited;
    },
    read: (offset: number, length: number) => {
      ranges.push([offset, length]);
      return cached.read(offset, length);
    },
  };
  const result = await reader.scan(recorded, options.path ?? BIDS_PATH, limits);
  return { result, ranges, tally: cached.tally, limited: cached.limited };
}

const kinds = (findings: Finding[]) => findings.map((f) => f.kind).sort();

interface OracleEntry {
  path: string;
  kind: string;
  name: string;
  storage?: { layout: string; address: number | null; size: number | null };
}
const oracle = (name: string): OracleEntry[] =>
  JSON.parse(readFileSync(join(DIR, `${name}.oracle.json`), "utf8"));

describe("registration", () => {
  test(".snirf is read by the SNIRF reader, .nwb by none", () => {
    expect(readerFor("sub-01/nirs/sub-01_task-a_nirs.snirf")?.id).toBe("snirf");
    expect(readerFor("sub-01/NIRS/A.SNIRF")?.id).toBe("snirf");
    expect(readerFor("sub-01/ieeg/sub-01_ieeg.nwb")).toBeNull();
    expect(READERS.filter((r) => r.id === "snirf")).toHaveLength(1);
  });

  test("every new kind has its copy entry and the right policy class", () => {
    for (const k of ["snirf-subject-name", "snirf-subject-freetext", "snirf-measurement-date"]) {
      expect(KIND_COPY[k as Finding["kind"]].anchor).toBe(`kind-${k}`);
    }
    expect(DIRECT_KINDS.has("snirf-subject-name")).toBe(true);
    expect(DIRECT_KINDS.has("snirf-subject-freetext")).toBe(false);
    expect(DATE_KINDS.has("snirf-measurement-date")).toBe(true);
  });
});

describe("real SNIRF files", () => {
  test("Simple_Probe: a placeholder SubjectID fires nothing; its measurement date is the only finding", async () => {
    const { result } = await scan(load("snirf-samples-simple-probe.snirf"));
    expect(result.coverage).toBe("complete");
    expect(kinds(result.findings)).toEqual(["snirf-measurement-date"]);
    const date = result.findings[0] as Finding;
    expect(date.severity).toBe("review");
    expect(date.field).toBe("snirf.MeasurementDate");
  });

  test("Homer3: probe labels, stimulus names and units fire nothing", async () => {
    const { result } = await scan(load("homer3-neuro-run02.snirf"));
    expect(result.coverage).toBe("complete");
    expect(kinds(result.findings)).toEqual(["snirf-measurement-date"]);
  });

  test("a made-up name in SubjectID is snirf-subject-name, an identifier", async () => {
    const { result } = await scan(load("snirf-subject-name.snirf"));
    expect(result.coverage).toBe("complete");
    const name = result.findings.filter((f) => f.kind === "snirf-subject-name");
    expect(name).toHaveLength(1);
    expect(name[0]?.severity).toBe("identifier");
    expect(name[0]?.field).toBe("snirf.SubjectID");
    // The finding carries a shape, never the value.
    expect(JSON.stringify(result.findings)).not.toContain("Quillfeather");
  });

  test("two nirs groups: both are screened", async () => {
    const { result } = await scan(load("snirf-two-groups.snirf"));
    expect(result.coverage).toBe("complete");
    // Each group has its measurement date; only the copied group has the made-up SubjectID.
    expect(kinds(result.findings)).toEqual([
      "snirf-measurement-date",
      "snirf-measurement-date",
      "snirf-subject-name",
    ]);
  });
});

describe("signals are not read", () => {
  for (const name of [
    "snirf-samples-simple-probe.snirf",
    "homer3-neuro-run02.snirf",
    "snirf-two-groups.snirf",
    "snirf-subject-name.snirf",
  ]) {
    test(`${name}: no range overlaps a dataTimeSeries, and the reader asks for at most 512 KiB`, async () => {
      const signals = oracle(name).filter(
        (e) => e.name === "dataTimeSeries" && e.storage?.address != null,
      );
      expect(signals.length).toBeGreaterThan(0);
      const { ranges, tally } = await scan(load(name));
      for (const s of signals) {
        const start = s.storage?.address as number;
        const end = start + (s.storage?.size as number);
        for (const [offset, length] of ranges) {
          expect(offset + length <= start || offset >= end).toBe(true);
        }
      }
      // What the reader asks for. The page cache below rounds each miss up to 64 KiB pages, so
      // what it fetches is larger (Homer3: about 169 KB asked, 633 KB fetched in 10 reads).
      const asked = ranges.reduce((sum, [, length]) => sum + length, 0);
      expect(asked).toBeLessThanOrEqual(512 * 1024);
      expect(tally.bytes).toBeLessThanOrEqual(1024 * 1024);
    });
  }
});

describe("partial, never clean", () => {
  test("a truncated SNIRF is partial", async () => {
    const whole = load("homer3-neuro-run02.snirf");
    for (const keep of [whole.length - 1, Math.floor(whole.length / 2), 4096, 600]) {
      const { result } = await scan(whole.subarray(0, keep));
      expect(result.coverage).toBe("partial");
    }
  });

  test("bytes that are not HDF5 are partial (corrupt)", async () => {
    const { result } = await scan(new Uint8Array(4096).fill(7));
    expect(result).toEqual({ findings: [], coverage: "partial", incomplete: "corrupt" });
  });

  test("a byte budget too small is partial (limit) and keeps the findings made before it", async () => {
    const bytes = load("snirf-two-groups.snirf");
    const full = await scan(bytes);
    const fetched = full.tally.bytes;
    let sawFindings = false;
    for (const budget of [64 * 1024, 192 * 1024, 256 * 1024]) {
      const limits = { ...SNIRF_READER.limits, maxBytes: budget };
      const { result, limited } = await scan(bytes, { limits });
      expect(limited).toBe(true);
      expect(result.coverage).toBe("partial");
      expect(result.incomplete).toBe("limit");
      if (result.findings.length > 0) sawFindings = true;
    }
    expect(sawFindings).toBe(true);
    // Twin: the measured budget itself is enough, and the file is complete.
    const enough = await scan(bytes, { limits: { ...SNIRF_READER.limits, maxBytes: fetched } });
    expect(enough.result.coverage).toBe("complete");
  });

  test("a failing source fails the file: the reader throws, it never returns partial or clean", async () => {
    const bytes = load("snirf-samples-simple-probe.snirf");
    const failing: RangeSource = {
      size: bytes.length,
      read: async (offset, length) => {
        if (offset > 0) throw new ReadFailure("network", { retryable: true });
        return bytes.slice(offset, offset + length);
      },
    };
    await expect(scan(bytes, { src: failing })).rejects.toBeInstanceOf(ReadFailure);
  });
});

describe("walkForReader", () => {
  test("every walker reason but read-failed maps to a registry reason with copy", () => {
    const reasons: Exclude<Hdf5Incomplete, "read-failed">[] = [
      "limit-bytes",
      "limit-reads",
      "limit-objects",
      "limit-depth",
      "unsupported-version",
      "unsupported-filter",
      "unsupported-datatype",
      "external-link",
      "corrupt",
    ];
    expect(Object.keys(HDF5_INCOMPLETE_REASON).sort()).toEqual([...reasons].sort());
    for (const r of reasons) expect(INCOMPLETE_COPY[HDF5_INCOMPLETE_REASON[r]]).toBeDefined();
    expect(HDF5_INCOMPLETE_REASON["limit-depth"]).toBe("limit");
    expect(HDF5_INCOMPLETE_REASON["external-link"]).toBe("external-link");
  });

  test("the reader's time running out is partial (time), with what was found so far", async () => {
    const bytes = load("homer3-neuro-run02.snirf");
    let clock = 0;
    let calls = 0;
    const src: RangeSource = {
      size: bytes.length,
      read: async (offset, length) => {
        calls++;
        // Time passes with each read; the walk is stopped part-way.
        clock += 10_000;
        return bytes.slice(offset, offset + length);
      },
    };
    const limits = { ...SNIRF_READER.limits, timeMs: 50_000 };
    const { walk, incomplete } = await walkForReader(src, limits, () => clock);
    expect(incomplete).toBe("time");
    expect(calls).toBeGreaterThan(1);
    expect(walk.entries.length).toBeGreaterThan(0);
  });

  test("the walker's caps admit the largest measured public file", () => {
    // 66,500 entries and 38 MiB in 573 fetches (an OpenNeuro high-density SNIRF; PR body).
    const walker = walkLimits(SNIRF_READER.limits);
    expect(walker.maxObjects).toBeGreaterThanOrEqual(66_500);
    expect(SNIRF_READER.limits.maxBytes).toBeGreaterThanOrEqual(38 * 1024 * 1024);
    expect(SNIRF_READER.limits.maxReads).toBeGreaterThanOrEqual(573);
    // Twin: the walker's own defaults would cut that file short.
    expect(HDF5_LIMITS.maxObjects).toBeLessThan(66_500);
  });

  test("a limit error from a source that does not say it was limited is rethrown", async () => {
    const bytes = load("snirf-samples-simple-probe.snirf");
    const plain: RangeSource = {
      size: bytes.length,
      read: async () => {
        throw new LimitExceeded();
      },
    };
    await expect(walkForReader(plain, SNIRF_READER.limits)).rejects.toBeInstanceOf(LimitExceeded);
  });

  test("a limited source whose first error is not the limit rethrows that error", async () => {
    const bytes = load("snirf-samples-simple-probe.snirf");
    const flagged = {
      size: bytes.length,
      limited: true,
      read: async (offset: number, length: number) => {
        if (offset > 0) throw new ReadFailure("network");
        return bytes.slice(offset, offset + length);
      },
    };
    await expect(walkForReader(flagged, SNIRF_READER.limits)).rejects.toBeInstanceOf(ReadFailure);
  });

  test("a refusal past the limits, then nothing else read: limit", async () => {
    const bytes = load("snirf-samples-simple-probe.snirf");
    const src = cachedSource(bufferSource(bytes), { ...SNIRF_READER.limits, maxBytes: 1024 });
    const { incomplete } = await walkForReader(src, SNIRF_READER.limits);
    expect(src.limited).toBe(true);
    expect(incomplete).toBe("limit");
  });

  test("an unsupported construct maps through the table", async () => {
    const { incomplete } = await walkForReader(
      bufferSource(load("unsupported-filter.h5")),
      SNIRF_READER.limits,
    );
    expect(incomplete).toBe("unsupported-filter");
  });
});

describe("SubjectID rule", () => {
  const path = "sub-p07/nirs/sub-p07_task-a_nirs.snirf";
  const kindOf = (v: string, p = path) => scanSubjectId(v, p).map((f) => f.kind);

  test("the BIDS label, with or without sub-, fires nothing", () => {
    // Longer than a short code: only the label match keeps it quiet.
    const long = "12345678901234";
    expect(kindOf(long, `sub-${long}/nirs/a.snirf`)).toEqual([]);
    expect(kindOf(long, "sub-other/nirs/a.snirf")).toEqual(["snirf-subject-freetext"]);
    expect(kindOf("p07")).toEqual([]);
    expect(kindOf("P07")).toEqual([]);
    expect(kindOf("sub-p07")).toEqual([]);
  });

  test("short codes fire nothing; the length bound is exact", () => {
    expect(kindOf("ab12", "a.snirf")).toEqual([]);
    expect(kindOf("S_01", "a.snirf")).toEqual([]);
    expect(kindOf("default", "a.snirf")).toEqual([]);
    expect(kindOf("", "a.snirf")).toEqual([]);
    expect(kindOf("n/a", "a.snirf")).toEqual([]);
    expect(kindOf("N/A", "a.snirf")).toEqual([]);
    // Twelve characters pass, thirteen do not (the bound is stated in the PR).
    expect(SHORT_CODE_MAX).toBe(12);
    expect(kindOf("A11111111111", "a.snirf")).toEqual([]);
    expect(kindOf("A111111111111", "a.snirf")).toEqual(["snirf-subject-freetext"]);
  });

  test("a name is snirf-subject-name; other text is snirf-subject-freetext", () => {
    expect(kindOf("Marlow", "a.snirf")).toEqual(["snirf-subject-name"]);
    expect(kindOf("Quillfeather Marlow", "a.snirf")).toEqual(["snirf-subject-name"]);
    expect(kindOf("12-34/56 #7", "a.snirf")).toEqual(["snirf-subject-freetext"]);
    // Letters fused with digits are review, not a block (lead ruling): john3, a cohort code.
    expect(kindOf("john3", "a.snirf")).toEqual(["snirf-subject-freetext"]);
    expect(kindOf("Tinnitus001", "a.snirf")).toEqual(["snirf-subject-freetext"]);
    // A bare name still blocks, alone or beside a code.
    expect(kindOf("marlow", "a.snirf")).toEqual(["snirf-subject-name"]);
    expect(kindOf("Marlow 07", "a.snirf")).toEqual(["snirf-subject-name"]);
    expect(readSubjectId("Marlow", "a.snirf")).toBe("name");
    expect(readSubjectId("john3", "a.snirf")).toBe("freetext");
    expect(readSubjectId("ab12", "a.snirf")).toBe("none");
    // A label that differs from the path's is judged on its own.
    expect(kindOf("p08")).toEqual([]);
  });
});

describe("SNIRF fields", () => {
  const dataset = (path: string, value: string): Hdf5Entry => ({
    path,
    kind: "dataset",
    name: path.slice(path.lastIndexOf("/") + 1),
    dtype: "string",
    shape: [],
    value,
  });
  const kindsAt = (path: string, value: string) =>
    scanSnirfEntries([dataset(path, value)], BIDS_PATH).map((f) => `${f.kind}/${f.severity}`);

  test("stimulus and aux names and probe labels are labels: a word never fires, a home path does", () => {
    for (const path of ["/nirs/stim1/name", "/nirs2/aux3/name", "/nirs/probe/landmarkLabels"]) {
      expect(kindsAt(path, "Marlow")).toEqual([]);
      expect(kindsAt(path, "/Users/qmarlow/x")).toEqual(["hdf5-freetext/review"]);
    }
  });

  test("a user tag for a person is a person field; the same word in a device tag is not", () => {
    expect(kindsAt("/nirs/metaDataTags/OperatorName", "Marlow")).toEqual([
      "hdf5-freetext-name/identifier",
    ]);
    expect(kindsAt("/nirs/metaDataTags/ManufacturerName", "Marlow")).toEqual([]);
    expect(kindsAt("/nirs/metaDataTags/DateOfBirth", "1971-04-23")).toEqual([
      "hdf5-identifier-field/identifier",
    ]);
  });

  test("SubjectID and MeasurementDate match in any letter case", () => {
    expect(kindsAt("/nirs/metaDataTags/subjectid", "Marlow")).toEqual([
      "snirf-subject-name/identifier",
    ]);
    expect(kindsAt("/NIRS2/METADATATAGS/MEASUREMENTDATE", "2020-05-16")).toEqual([
      "snirf-measurement-date/review",
    ]);
  });

  test("MeasurementDate fires at day precision only, in any nirs group", () => {
    expect(kindsAt("/nirs3/metaDataTags/MeasurementDate", "2020-05-16")).toEqual([
      "snirf-measurement-date/review",
    ]);
    expect(kindsAt("/nirs/metaDataTags/MeasurementDate", "2020-05")).toEqual([]);
    expect(kindsAt("/nirs/metaDataTags/MeasurementDate", "unknown")).toEqual([]);
  });
});
