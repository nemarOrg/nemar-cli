/**
 * The coverage contract (epic #2182 phase A1, #2185): recordings are read through a registry of
 * format readers, the report (version 2) counts per reader how each read ended, the door holds a
 * version-2 report to those counts, and every kind, state and reason has its words.
 *
 * Real code paths throughout: the fleet scan's `scanDatasetFromManifest` runs unchanged over
 * entries whose bytes come from memory (the only stand-in is where the bytes live), and the
 * readers below are registered through the scan's public `readers` option. They exist only in
 * this file; the registry itself holds EDF/BDF, BrainVision and NIRx (phase A2).
 */

import { describe, expect, test } from "bun:test";
import {
  type ManifestEntry,
  RANGE_IGNORED,
  ReadFailure,
  createContext,
  readHead,
  scanDatasetFromManifest,
} from "../scripts/identifier-fleet-lib";
import {
  finalizeScanReport,
  foldOddFailures,
  foldOddFormats,
} from "../scripts/identifier-screen-ci-lib";
import {
  DEFAULT_READER_LIMITS,
  EDF_READER,
  type FormatReader,
  LimitExceeded,
  PAGE_BYTES,
  READERS,
  READER_IDS,
  READER_INCOMPLETE_REASONS,
  type RangeSource,
  bufferSource,
  cachedSource,
  formatCoverage,
  readerFor,
} from "../shared/identifier-readers";
import { shapeOf } from "../shared/identifier-scan";
import {
  INCOMPLETE_COPY,
  KIND_COPY,
  NOTE_COPY,
  READ_FAILURE_COPY,
  SCREEN_DOCS_URL,
  STATUS_COPY,
  docsLink,
} from "../shared/identifier-screen-copy";
import { FINDING_KINDS as KINDS } from "../shared/identifier-screen-report";
import {
  DATASET_STATUSES,
  type DatasetStatus,
  INCOMPLETE_REASONS,
  READ_FAILURE_CLASSES,
  REPORT_VERSION,
  ReportError,
  type ScreenGate,
  type ScreenReport,
  describeScreen,
  parseScreenReport,
  screenGate,
} from "../shared/identifier-screen-report";

const HEAD = "a".repeat(40);
const SCANNER = "identifier-scan@abcdef1";

// ---------------------------------------------------------------------------------------
// A scan over bytes held in memory
// ---------------------------------------------------------------------------------------

/** A valid 256-byte EDF header with placeholder identification: what a clean recording holds. */
function edfHeader(): Uint8Array {
  const field = (text: string, width: number) => text.padEnd(width, " ").slice(0, width);
  const text =
    field("0", 8) +
    field("X X X X", 80) +
    field("Startdate X X X X", 80) +
    field("01.01.01", 8) +
    field("00.00.00", 8) +
    field("512", 8) +
    field("", 44) +
    field("1", 8) +
    field("1", 8) +
    field("1", 4);
  return new TextEncoder().encode(text);
}

async function scan(
  files: Record<string, Uint8Array>,
  readers: readonly FormatReader[],
  over = {},
) {
  const entries: ManifestEntry[] = Object.entries(files).map(([path, bytes]) => ({
    path,
    size: bytes.length,
    url: `mem:${path}`,
  }));
  const ctx = createContext({
    fileConcurrency: 4,
    workerConcurrency: 1,
    githubToken: async () => null,
    sleep: async () => undefined,
    readEntryHead: async (entry, n, options) => {
      const bytes = files[entry.path];
      if (!bytes) throw new ReadFailure("unreadable-entry", { status: 404 });
      const offset = options.offset ?? 0;
      const out = bytes.slice(offset, offset + n);
      if (out.length < options.minBytes) throw new ReadFailure("short-body");
      return out;
    },
    ...over,
  });
  const record = await scanDatasetFromManifest(ctx, "nm000186", null, entries, "clone", {
    readers,
  });
  // The CI's own path: fold odd names into the vocabulary, then the door.
  return {
    record,
    report: finalizeScanReport(foldOddFailures(foldOddFormats(record)), SCANNER, HEAD),
  };
}

/**
 * The registry without the real SNIRF and HDF5 readers, so a stub can stand for `.snirf` (the
 * registry picks the first reader of the longest matching extension).
 */
const WITHOUT_HDF5: readonly FormatReader[] = READERS.filter(
  (r) => r.id !== "snirf" && r.id !== "hdf5",
);

/** A reader for `.snirf` that reads its first 64 bytes and finds nothing. */
const stubReader = (over: Partial<FormatReader> = {}): FormatReader => ({
  id: "snirf",
  extensions: [".snirf"],
  limits: { ...DEFAULT_READER_LIMITS },
  version: "test-1",
  async scan(src: RangeSource) {
    await src.read(0, 64);
    return { findings: [], coverage: "complete" };
  },
  ...over,
});

const bytes = (n: number) => new Uint8Array(n).fill(7);

// ---------------------------------------------------------------------------------------
// Readers through the scan
// ---------------------------------------------------------------------------------------

describe("recordings are read through the registry", () => {
  test("a clean v2 report with no EDF and one complete other reader is accepted", async () => {
    const files = { "sub-01/nirs/sub-01_task-a_nirs.snirf": bytes(4096), README: bytes(8) };
    const { record, report } = await scan(files, [...WITHOUT_HDF5, stubReader()]);
    expect(record.status).toBe("clean");
    expect(report.version).toBe(2);
    expect(report.scan?.status).toBe("clean");
    expect(report.scan?.files?.edf_bdf).toBe(0);
    expect(report.scan?.read_by_format).toEqual({
      snirf: { files: 1, read: 1, partial: 0, failed: 0 },
    });
    expect(report.scan?.readers).toEqual({
      edf: EDF_READER.version,
      brainvision: "1",
      nirx: "1",
      snirf: "test-1",
      eeglab: "1",
      "homer-nirs": "1",
      mat: "1",
    });
    // The twin: without the reader the same file is a format nobody reads.
    const without = await scan(files, WITHOUT_HDF5);
    expect(without.report.scan?.status).toBe("not-screened");
    expect(without.report.scan?.unscreened_formats).toEqual({ ".snirf": 1 });
  });

  test("a reader that throws counts its file as failed, never as clean", async () => {
    const throwing = stubReader({
      async scan() {
        throw new TypeError("a parser bug");
      },
    });
    const { report } = await scan({ "sub-01/nirs/a.snirf": bytes(4096) }, [
      ...WITHOUT_HDF5,
      throwing,
    ]);
    expect(report.scan?.status).toBe("unchecked");
    expect(report.scan?.read_by_format?.snirf).toEqual({
      files: 1,
      read: 0,
      partial: 0,
      failed: 1,
    });
    expect(report.scan?.incomplete_reasons).toContain("recordings-unread");
    expect(Object.keys(report.scan?.read_failures ?? {})).toEqual(["snirf/error-typeerror"]);
  });

  test("a source read past the reader's limit is partial, reason limit", async () => {
    const greedy = stubReader({ limits: { ...DEFAULT_READER_LIMITS, maxBytes: 32 } });
    const { report } = await scan({ "sub-01/nirs/a.snirf": bytes(4096) }, [
      ...WITHOUT_HDF5,
      greedy,
    ]);
    expect(report.scan?.status).toBe("unchecked");
    expect(report.scan?.read_by_format?.snirf).toEqual({
      files: 1,
      read: 0,
      partial: 1,
      failed: 0,
    });
    expect(report.scan?.incomplete_reasons).toEqual(["limit"]);
    // The twin, one byte of budget more than the read needs: complete.
    const enough = stubReader({ limits: { ...DEFAULT_READER_LIMITS, maxBytes: 64 } });
    const ok = await scan({ "sub-01/nirs/a.snirf": bytes(4096) }, [...WITHOUT_HDF5, enough]);
    expect(ok.report.scan?.status).toBe("clean");
  });

  test("a reader that says partial is partial, with its own reason", async () => {
    const encrypted = stubReader({
      async scan() {
        return { findings: [], coverage: "partial", incomplete: "encrypted" };
      },
    });
    const { report } = await scan({ "a.snirf": bytes(128) }, [...WITHOUT_HDF5, encrypted]);
    expect(report.scan?.status).toBe("unchecked");
    expect(report.scan?.incomplete_reasons).toEqual(["encrypted"]);
  });

  test("a missing companion is counted, makes the recording partial, and is no finding", async () => {
    // A header that names a `.dat` beside it, as A2's readers will.
    const paired = stubReader({
      companions: (path, siblings) => {
        const dat = path.replace(/\.snirf$/, ".dat");
        return siblings.has(dat)
          ? { claimed: [dat], missing: [] }
          : { claimed: [], missing: [dat] };
      },
    });
    const lacking = await scan({ "sub-01/nirs/a.snirf": bytes(128) }, [...WITHOUT_HDF5, paired]);
    expect(lacking.report.scan?.companion_missing).toBe(1);
    expect(lacking.report.scan?.findings_by_kind).toEqual({});
    expect(lacking.report.scan?.read_by_format?.snirf?.partial).toBe(1);
    expect(lacking.report.scan?.incomplete_reasons).toEqual(["companion-missing"]);
    // Present, it is claimed: part of its recording, not an unscreened `.dat`.
    const whole = await scan(
      { "sub-01/nirs/a.snirf": bytes(128), "sub-01/nirs/a.dat": bytes(16) },
      [...WITHOUT_HDF5, paired],
    );
    expect(whole.report.scan?.status).toBe("clean");
    expect(whole.report.scan?.companion_missing).toBe(0);
    expect(whole.report.scan?.unscreened_formats).toEqual({});
    // Only a declared pairing claims a file: without the reader's pairing, `.dat` is unscreened.
    const unpaired = await scan(
      { "sub-01/nirs/a.snirf": bytes(128), "sub-01/nirs/a.dat": bytes(16) },
      [...WITHOUT_HDF5, stubReader()],
    );
    expect(unpaired.report.scan?.status).toBe("partially-screened");
    expect(unpaired.report.scan?.unscreened_formats).toEqual({ ".dat": 1 });
  });

  test("past the dataset's time budget every file still to read is partial, reason time", async () => {
    const { report } = await scan(
      { "a.snirf": bytes(128), "b.snirf": bytes(128) },
      [...WITHOUT_HDF5, stubReader()],
      { limits: { datasetTimeMs: 0 } },
    );
    expect(report.scan?.read_by_format?.snirf).toEqual({
      files: 2,
      read: 0,
      partial: 2,
      failed: 0,
    });
    expect(report.scan?.incomplete_reasons).toEqual(["time"]);
  });

  test("not-applicable (phase A2): unscreened under its extension, never read, partial or failed", async () => {
    // A reader that finds a file is not its format, with a companion it would otherwise want.
    const picky = stubReader({
      companions: (path) => ({ claimed: [], missing: [path.replace(/\.snirf$/, ".dat")] }),
      async scan() {
        return { findings: [], coverage: "not-applicable" };
      },
    });
    const { record, report } = await scan(
      { "sub-01/eeg/a.edf": edfHeader(), "sub-01/nirs/b.snirf": bytes(128) },
      [...WITHOUT_HDF5, picky],
    );
    expect(record.unscreened_formats).toEqual({ ".snirf": 1 });
    expect(report.scan?.read_by_format?.snirf).toEqual({
      files: 0,
      read: 0,
      partial: 0,
      failed: 0,
    });
    expect(report.scan?.companion_missing).toBe(0);
    expect(report.scan?.incomplete_reasons).toEqual([]);
    expect(report.scan?.status).toBe("partially-screened");
  });

  test("a note (phase A2) is counted and printed with its remedy, and never gates", async () => {
    const noting = stubReader({
      async scan(src: RangeSource) {
        await src.read(0, 64);
        return { findings: [], coverage: "complete", notes: ["companion-name-mismatch"] };
      },
    });
    const { report } = await scan({ "sub-01/nirs/a.snirf": bytes(128) }, [...WITHOUT_HDF5, noting]);
    expect(report.scan?.status).toBe("clean");
    expect(report.scan?.companion_name_mismatch).toBe(1);
    const lines = describeScreen("clean", report).lines;
    const copy = NOTE_COPY["companion-name-mismatch"];
    const at = lines.indexOf(`Note (x1): ${copy.statement}`);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toBe(`What to do: ${copy.remedy}`);
    // Without a note the key is absent, so a report reads as it did before.
    const quiet = await scan({ "sub-01/nirs/a.snirf": bytes(128) }, [
      ...WITHOUT_HDF5,
      stubReader(),
    ]);
    expect(quiet.report.scan).not.toHaveProperty("companion_name_mismatch");
  });

  test("a recording beside an unread format is partially-screened, which asks for a person", async () => {
    const { report } = await scan(
      { "sub-01/eeg/a.edf": edfHeader(), "sub-01/eeg/b.set": bytes(10) },
      READERS,
    );
    expect(report.scan?.status).toBe("partially-screened");
    expect(screenGate("partially-screened")).toBe("acknowledge");
  });
});

// ---------------------------------------------------------------------------------------
// The registry and the cache
// ---------------------------------------------------------------------------------------

describe("the registry and the page cache", () => {
  test("the longest extension wins, and only registered readers count", () => {
    const fif = stubReader({ id: "hdf5", extensions: [".gz"] });
    const fifGz = stubReader({ id: "zip", extensions: [".fif.gz"] });
    expect(readerFor("a.fif.gz", [fif, fifGz])?.id).toBe("zip");
    expect(readerFor("a.EDF")?.id).toBe("edf");
    expect(readerFor("a.edf.gz")).toBeNull();
    expect(formatCoverage(["a.edf", "b.bdf", "c.nwb"])).toEqual({
      byReader: { edf: 2 },
      unscreened: { ".nwb": 1 },
    });
  });

  test("100 adjacent 1 KiB reads reach the source at most twice", async () => {
    const data = bytes(100 * 1024);
    let calls = 0;
    const counting: RangeSource = {
      size: data.length,
      read: async (offset, length) => {
        calls++;
        return data.slice(offset, offset + length);
      },
    };
    const src = cachedSource(counting, DEFAULT_READER_LIMITS);
    for (let i = 0; i < 100; i++) {
      const got = await src.read(i * 1024, 1024);
      expect(got.length).toBe(1024);
    }
    expect(calls).toBeLessThanOrEqual(2);
    expect(src.tally).toEqual({ reads: calls, bytes: data.length });
    expect(PAGE_BYTES).toBe(64 * 1024);
  });

  test("a read past the byte or read limit is refused and fetches nothing", async () => {
    const src = cachedSource(bufferSource(bytes(4096)), {
      ...DEFAULT_READER_LIMITS,
      maxBytes: 256,
      maxReads: 1,
    });
    expect((await src.read(0, 256)).length).toBe(256);
    // Served from the page already held: no new read.
    expect((await src.read(10, 100)).length).toBe(100);
    await expect(src.read(256, 1)).rejects.toMatchObject({ name: "LimitExceeded" });
    expect(src.tally).toEqual({ reads: 1, bytes: 256 });
  });

  test("the EDF/BDF reader keeps its 256 bytes", () => {
    expect(EDF_READER.limits.maxBytes).toBe(256);
    expect(READERS.map((r) => r.id)).toEqual([
      "edf",
      "brainvision",
      "nirx",
      "snirf",
      "hdf5",
      "eeglab",
      "homer-nirs",
      "mat",
    ]);
  });
});

// ---------------------------------------------------------------------------------------
// The door
// ---------------------------------------------------------------------------------------

const v2Scan = (over: Record<string, unknown> = {}) => ({
  id: "nm000186",
  version: null,
  scanned_at: "2026-11-25T12:00:00.000Z",
  status: "clean",
  incomplete: false,
  incomplete_reasons: [],
  files: { total: 10, edf_bdf: 2, header_read: 2, header_read_failed: 0 },
  read_by_format: { edf: { files: 2, read: 2, partial: 0, failed: 0 } },
  companion_missing: 0,
  readers: { edf: "1" },
  ...over,
});
const v2 = (scanOver: Record<string, unknown> = {}) => ({
  version: 2,
  scanner: SCANNER,
  head: HEAD,
  scan: v2Scan(scanOver),
});

function refusal(input: unknown): string {
  try {
    parseScreenReport(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ReportError);
    return (error as ReportError).message;
  }
  throw new Error("accepted a report it should have refused");
}

describe("the door reads version 1 and version 2", () => {
  test("the screen writes version 2", () => {
    expect(REPORT_VERSION).toBe(2);
  });

  test("a version-1 report parses and renders as before", () => {
    const v1: ScreenReport = parseScreenReport({
      version: 1,
      scanner: SCANNER,
      head: HEAD,
      scan: {
        id: "nm000186",
        version: null,
        scanned_at: "2026-10-05T12:00:00.000Z",
        status: "clean-edf-only-others-unscreened",
        incomplete: false,
        incomplete_reasons: [],
        files: { total: 10, edf_bdf: 4, header_read: 4, header_read_failed: 0 },
        unscreened_formats: { ".set": 2 },
      },
    });
    expect(v1.version).toBe(1);
    const d = describeScreen("clean-edf-only-others-unscreened", v1);
    expect(d.headline).toBe("Identifier screen: EDF/BDF clean, other recordings NOT screened");
    expect(d.tone).toBe("warn");
    expect(d.lines).toEqual([
      "Files: 10; EDF/BDF headers read: 4 of 4.",
      "Not screened (format x files): .set x2.",
      "Not read: the contents of sidecars and tables in earlier commits.",
      `Scanner ${SCANNER}; commit ${HEAD.slice(0, 12)}.`,
    ]);
    // Version 1 never said partially-screened, and carries no version-2 field.
    const {
      read_by_format: _r,
      companion_missing: _c,
      readers: _v,
      ...v1Scan
    } = v2Scan({
      status: "partially-screened",
    });
    expect(refusal({ version: 1, scanner: SCANNER, head: HEAD, scan: v1Scan })).toBe("scan-status");
    expect(
      parseScreenReport({
        version: 1,
        scanner: SCANNER,
        head: HEAD,
        scan: { ...v1Scan, status: "clean-edf-only-others-unscreened" },
      }).scan?.status,
    ).toBe("clean-edf-only-others-unscreened");
    expect(
      refusal({
        version: 1,
        scanner: SCANNER,
        head: HEAD,
        scan: { ...v2Scan(), status: "review" },
      }),
    ).toBe("scan-key");
  });

  test("a version-2 report naming every reader, a ZIP key and every new reason parses", () => {
    const tallies = Object.fromEntries(
      READER_IDS.map((id) => [id, { files: 2, read: 1, partial: 1, failed: 0 }]),
    );
    const report = parseScreenReport(
      v2({
        status: "unchecked",
        incomplete: true,
        incomplete_reasons: [...READER_INCOMPLETE_REASONS, "recordings-unread"],
        files: { total: 30, edf_bdf: 2, header_read: 1, header_read_failed: 0 },
        read_by_format: tallies,
        readers: Object.fromEntries(READER_IDS.map((id) => [id, "1.0.0"])),
        unscreened_formats: { "zip:.snirf": 1, "zip:.edf": 2 },
        read_failures: { "snirf/limit": 1, "zip/superseded-absent": 1 },
        companion_missing: 3,
      }),
    );
    expect(Object.keys(report.scan?.read_by_format ?? {}).sort()).toEqual([...READER_IDS].sort());
    expect(report.scan?.unscreened_formats).toEqual({ "zip:.snirf": 1, "zip:.edf": 2 });
  });

  test("a version-2 clean report with an unread, partial or failed file is refused", () => {
    for (const edf of [
      { files: 2, read: 1, partial: 1, failed: 0 },
      { files: 2, read: 1, partial: 0, failed: 1 },
      { files: 2, read: 1, partial: 0, failed: 0 },
    ]) {
      const files = { total: 10, edf_bdf: 2, header_read: 1, header_read_failed: edf.failed };
      // Said clean and complete: the counts disagree.
      expect(refusal(v2({ files, read_by_format: { edf } }))).toBe("scan-status");
      // Said clean and incomplete: still too clean.
      expect(
        refusal(
          v2({ files, read_by_format: { edf }, incomplete: true, incomplete_reasons: ["limit"] }),
        ),
      ).toBe("scan-status");
    }
    // Another reader's partial file keeps the dataset from clean as well.
    expect(
      refusal(
        v2({
          read_by_format: {
            edf: { files: 2, read: 2, partial: 0, failed: 0 },
            snirf: { files: 1, read: 0, partial: 1, failed: 0 },
          },
          incomplete: true,
          incomplete_reasons: ["limit"],
        }),
      ),
    ).toBe("scan-status");
    // So do an unscreened format and a missing companion.
    expect(refusal(v2({ unscreened_formats: { ".set": 1 } }))).toBe("scan-status");
    expect(refusal(v2({ companion_missing: 1 }))).toBe("scan-status");
    // A clean v2 report with no recording at all is not clean, it is no-recordings.
    expect(
      refusal(
        v2({
          files: { total: 3, edf_bdf: 0, header_read: 0, header_read_failed: 0 },
          read_by_format: {},
        }),
      ),
    ).toBe("scan-status");
    // The twin of all of the above: the complete report is accepted.
    expect(parseScreenReport(v2()).scan?.status).toBe("clean");
  });

  test("version 2 says partially-screened, and the old word only in version 1", () => {
    expect(
      parseScreenReport(v2({ status: "partially-screened", unscreened_formats: { ".set": 1 } }))
        .scan?.status,
    ).toBe("partially-screened");
    expect(refusal(v2({ status: "clean-edf-only-others-unscreened" }))).toBe("scan-status");
  });

  test("a version-2 field outside its closed words is refused without quoting it", () => {
    expect(
      refusal(
        v2({ read_by_format: { "John Smith": { files: 1, read: 1, partial: 0, failed: 0 } } }),
      ),
    ).toBe("scan-readers");
    expect(
      refusal(v2({ read_by_format: { edf: { files: 2, read: 2, partial: 0, failed: 0, x: 1 } } })),
    ).toBe("scan-readers");
    expect(refusal(v2({ readers: { edf: "John Smith" } }))).toBe("scan-readers");
    expect(refusal(v2({ companion_missing: -1 }))).toBe("scan-count");
    expect(refusal(v2({ incomplete: true, incomplete_reasons: ["a name"] }))).toBe("scan-reasons");
  });
});

// ---------------------------------------------------------------------------------------
// The gate and the words
// ---------------------------------------------------------------------------------------

describe("the gate is unchanged, and partially-screened asks for a person", () => {
  test("every state gates as before; the new state as the one it replaces", () => {
    const expected: Record<DatasetStatus, ScreenGate> = {
      "direct-identifiers": "blocks",
      "dates-only": "clear",
      review: "acknowledge",
      clean: "clear",
      "partially-screened": "acknowledge",
      "clean-edf-only-others-unscreened": "acknowledge",
      "not-screened": "acknowledge",
      "no-recordings": "clear",
      unchecked: "acknowledge",
    };
    for (const s of DATASET_STATUSES) expect([s, screenGate(s)]).toEqual([s, expected[s]]);
    expect(screenGate("pending")).toBe("wait");
    expect(screenGate("error")).toBe("rerun");
    expect(screenGate(null)).toBe("rerun");
  });
});

describe("every kind, state and reason has its words", () => {
  const complete = (name: string, copy: { statement: string; read: string; remedy: string }) => {
    for (const part of [copy.statement, copy.read, copy.remedy]) {
      expect([name, part.trim().length > 0]).toEqual([name, true]);
    }
  };

  test("the tables cover their unions, with a docs anchor on the screen's page", () => {
    for (const k of KINDS) complete(k, KIND_COPY[k]);
    for (const s of [...DATASET_STATUSES, "pending", "error", "unreported"] as const) {
      complete(s, STATUS_COPY[s]);
    }
    for (const r of INCOMPLETE_REASONS) complete(r, INCOMPLETE_COPY[r]);
    expect(docsLink(KIND_COPY["edf-patient-name"])).toBe(
      `${SCREEN_DOCS_URL}#kind-edf-patient-name`,
    );
    const anchors = [
      ...Object.values(KIND_COPY),
      ...Object.values(STATUS_COPY),
      ...Object.values(INCOMPLETE_COPY),
    ].map((c) => c.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  test("a version-2 description follows each state, kind and reason with its remedy and link", () => {
    const report = parseScreenReport(
      v2({
        status: "review",
        findings_by_kind: { "tooling-debris": 2 },
        incomplete: true,
        incomplete_reasons: ["limit"],
        files: { total: 10, edf_bdf: 2, header_read: 1, header_read_failed: 0 },
        read_by_format: { edf: { files: 2, read: 1, partial: 1, failed: 0 } },
      }),
    );
    const lines = describeScreen("review", report).lines;
    expect(lines).toContain("Recordings read: EDF/BDF 1 of 2. Partially read: 1.");
    for (const [statement, copy] of [
      [lines.findIndex((l) => l.startsWith(STATUS_COPY.review.statement)), STATUS_COPY.review],
      [lines.findIndex((l) => l.startsWith("tooling-debris x2: ")), KIND_COPY["tooling-debris"]],
      [lines.findIndex((l) => l.startsWith("Incomplete (limit): ")), INCOMPLETE_COPY.limit],
    ] as const) {
      expect(statement).toBeGreaterThanOrEqual(0);
      expect(lines[statement + 1]).toBe(`What to do: ${copy.remedy}`);
      expect(lines[statement + 2]).toBe(`More: ${docsLink(copy)}`);
    }
    // Counts and fixed words: no value, and the kind's count is the report's.
    expect(lines.join("\n")).not.toMatch(/John|Smith/);
  });
});

// ---------------------------------------------------------------------------------------
// Review round 1
// ---------------------------------------------------------------------------------------

describe("review round 1", () => {
  test("a 200 answer to a read from a non-zero offset is refused, never taken as the range", async () => {
    const body = new Uint8Array(4096).map((_, i) => i % 251);
    // A stand-in server that ignores Range and always sends the whole file.
    const server = Bun.serve({ port: 0, fetch: () => new Response(body, { status: 200 }) });
    try {
      const url = `http://127.0.0.1:${server.port}/object`;
      await expect(readHead(url, 16, { offset: 1024 })).rejects.toMatchObject({
        cls: RANGE_IGNORED,
      });
      // The twin: from offset 0 the first bytes of the whole file are the range asked for.
      expect([...(await readHead(url, 16))]).toEqual([...body.slice(0, 16)]);
    } finally {
      server.stop(true);
    }
  });

  test("a reader that says complete after its source refused a read is partial, findings kept", async () => {
    const finding = {
      kind: "edf-patient-name" as const,
      severity: "identifier" as const,
      field: "patient.name",
      shape: shapeOf("Aaaa"),
    };
    const careless = stubReader({
      limits: { ...DEFAULT_READER_LIMITS, maxBytes: 32 },
      async scan(src) {
        try {
          await src.read(0, 64);
        } catch (error) {
          if (!(error instanceof LimitExceeded)) throw error;
        }
        return { findings: [finding], coverage: "complete" };
      },
    });
    const { report } = await scan({ "a.snirf": bytes(4096) }, [...WITHOUT_HDF5, careless]);
    expect(report.scan?.read_by_format?.snirf).toEqual({
      files: 1,
      read: 0,
      partial: 1,
      failed: 0,
    });
    expect(report.scan?.incomplete_reasons).toEqual(["limit"]);
    expect(report.scan?.findings_by_kind).toEqual({ "edf-patient-name": 1 });
    expect(report.scan?.status).toBe("direct-identifiers");
  });

  test("a byte budget of size - 1 serves every byte but the last; asking for the last is refused", async () => {
    const size = 2 * PAGE_BYTES + 100;
    const data = bytes(size);
    const tight = cachedSource(bufferSource(data), {
      ...DEFAULT_READER_LIMITS,
      maxBytes: size - 1,
    });
    expect((await tight.read(0, size - 1)).length).toBe(size - 1);
    // Nothing a reader asked for was withheld: not limited.
    expect(tight.limited).toBe(false);
    await expect(tight.read(size - 1, 1)).rejects.toBeInstanceOf(LimitExceeded);
    expect(tight.limited).toBe(true);
    expect(tight.tally.bytes).toBe(size - 1);
    // The boundary: a budget of exactly the size reads the whole file and is never limited.
    const exact = cachedSource(bufferSource(data), { ...DEFAULT_READER_LIMITS, maxBytes: size });
    expect((await exact.read(0, size)).length).toBe(size);
    expect((await exact.read(size - 1, 1)).length).toBe(1);
    expect(exact.limited).toBe(false);
    expect(exact.tally.bytes).toBe(size);
  });

  test("exactly maxReads reads reach the source, and the next is refused", async () => {
    const src = cachedSource(bufferSource(bytes(4 * PAGE_BYTES)), {
      ...DEFAULT_READER_LIMITS,
      maxReads: 3,
    });
    for (let i = 0; i < 3; i++) expect((await src.read(i * PAGE_BYTES, 1)).length).toBe(1);
    expect(src.limited).toBe(false);
    await expect(src.read(3 * PAGE_BYTES, 1)).rejects.toBeInstanceOf(LimitExceeded);
    expect(src.limited).toBe(true);
    expect(src.tally.reads).toBe(3);
  });

  test("a read inside one page fetches exactly that page", async () => {
    const data = bytes(4 * PAGE_BYTES);
    const fetched: [number, number][] = [];
    const counting = (): RangeSource => ({
      size: data.length,
      read: async (offset, length) => {
        fetched.push([offset, length]);
        return data.slice(offset, offset + length);
      },
    });
    await cachedSource(counting(), DEFAULT_READER_LIMITS).read(PAGE_BYTES - 1, 1);
    expect(fetched).toEqual([[0, PAGE_BYTES]]);
    fetched.length = 0;
    await cachedSource(counting(), DEFAULT_READER_LIMITS).read(0, PAGE_BYTES);
    expect(fetched).toEqual([[0, PAGE_BYTES]]);
  });

  test("a v2 report whose per-reader counts disagree with themselves or with files is refused", () => {
    // EDF/BDF files counted two ways that disagree.
    expect(
      refusal(
        v2({
          files: { total: 10, edf_bdf: 3, header_read: 2, header_read_failed: 0 },
          read_by_format: { edf: { files: 2, read: 2, partial: 0, failed: 0 } },
        }),
      ),
    ).toBe("scan-status");
    // More reads ended than there were files.
    expect(
      refusal(
        v2({
          status: "unchecked",
          incomplete: true,
          incomplete_reasons: ["limit"],
          read_by_format: { edf: { files: 2, read: 2, partial: 1, failed: 0 } },
        }),
      ),
    ).toBe("scan-status");
    // The twin: the same counts, agreeing, parse.
    expect(
      parseScreenReport(
        v2({
          status: "unchecked",
          incomplete: true,
          incomplete_reasons: ["limit"],
          files: { total: 10, edf_bdf: 3, header_read: 2, header_read_failed: 0 },
          read_by_format: { edf: { files: 3, read: 2, partial: 1, failed: 0 } },
        }),
      ).scan?.status,
    ).toBe("unchecked");
  });
});

describe("review round 2: read failures have words", () => {
  const failedRead = () =>
    v2({
      status: "unchecked",
      incomplete: true,
      incomplete_reasons: ["edf-headers-unread"],
      files: { total: 10, edf_bdf: 2, header_read: 1, header_read_failed: 1 },
      read_by_format: { edf: { files: 2, read: 1, partial: 0, failed: 1 } },
      read_failures: { "edf/range-ignored": 1, "edf/http-503": 2 },
    });

  test("a v2 report with a range-ignored failure passes the door, not folded to internal", () => {
    const parsed = parseScreenReport(failedRead());
    expect(parsed.scan?.read_failures).toEqual({ "edf/range-ignored": 1, "edf/http-503": 2 });
    const folded = foldOddFailures({ read_failures: { "edf/range-ignored": 1 } });
    expect(folded.read_failures).toEqual({ "edf/range-ignored": 1 });
  });

  test("each failure prints its statement, then its remedy and docs link", () => {
    const lines = describeScreen("unchecked", parseScreenReport(failedRead())).lines;
    for (const [key, n, copy] of [
      ["edf/range-ignored", 1, READ_FAILURE_COPY["range-ignored"]],
      ["edf/http-503", 2, READ_FAILURE_COPY.http],
    ] as const) {
      const at = lines.indexOf(`Read failed (${key} x${n}): ${copy.statement}`);
      expect([key, at >= 0]).toEqual([key, true]);
      expect(lines[at + 1]).toBe(`What to do: ${copy.remedy}`);
      expect(lines[at + 2]).toBe(`More: ${docsLink(copy)}`);
    }
  });

  test("every closed failure class has its words", () => {
    for (const cls of [...READ_FAILURE_CLASSES, "http"] as const) {
      const copy = READ_FAILURE_COPY[cls];
      expect([cls, copy.statement.length > 0 && copy.remedy.length > 0]).toEqual([cls, true]);
    }
  });
});
