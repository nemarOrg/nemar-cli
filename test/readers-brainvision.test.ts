/**
 * The BrainVision reader (epic #2182, phase A2): real Vision Recorder headers and marker files
 * (`test/fixtures/text-headers/`, provenance in its README), read through the registry, the page
 * cache and the screen's own `readRecordings`, with the registered readers (no stand-in reader).
 * Edits a test needs beyond the two committed edited fixtures are made in memory from a real file.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  READERS,
  bufferSource,
  cachedSource,
  formatCoverage,
  limitsFor,
  readerFor,
} from "../shared/identifier-readers";
import {
  classifyDataset,
  coverageFields,
  readRecordings,
} from "../shared/identifier-report-builder";
import { DATE_KINDS, DIRECT_KINDS, OTHER_RECORDING_EXTENSIONS } from "../shared/identifier-scan";
import { KIND_COPY, NOTE_COPY } from "../shared/identifier-screen-copy";
import { BRAINVISION_READER } from "../shared/readers/brainvision";
import {
  MARKER_FILE_MAX_BYTES,
  TEXT_HEADER_MAX_BYTES,
  decodeHeader,
} from "../shared/readers/text-header";

const DIR = join(import.meta.dir, "fixtures/text-headers/brainvision");
const fixture = (name: string) => new Uint8Array(readFileSync(join(DIR, name)));
const text = (name: string) => new TextDecoder().decode(fixture(name));
const encode = (s: string) => new TextEncoder().encode(s);

/** Scan bytes as if they were the file at `path`, under the limits the registry gives that path. */
async function scan(bytes: Uint8Array, path: string) {
  const r = BRAINVISION_READER;
  const limits = limitsFor(r, path);
  return r.scan(cachedSource(bufferSource(bytes), limits), path, limits);
}

const kinds = (result: { findings: { kind: string }[] }) => result.findings.map((f) => f.kind);

describe("the BrainVision reader is registered", () => {
  test("it reads .vhdr and .vmrk, and .vhdr left the unscreened list", () => {
    expect(READERS).toContain(BRAINVISION_READER);
    expect(readerFor("sub-01/eeg/sub-01_task-x_eeg.vhdr")?.id).toBe("brainvision");
    expect(readerFor("sub-01/eeg/sub-01_task-x_eeg.VMRK")?.id).toBe("brainvision");
    expect(readerFor("sub-01/eeg/sub-01_task-x_eeg.eeg")).toBeNull();
    expect(OTHER_RECORDING_EXTENSIONS).not.toContain(".vhdr");
  });

  test("each header is read whole up to 1 MiB, no more", () => {
    expect(TEXT_HEADER_MAX_BYTES).toBe(1024 * 1024);
    expect(BRAINVISION_READER.limits.maxBytes).toBe(TEXT_HEADER_MAX_BYTES);
  });
});

describe("clean real headers give no finding", () => {
  test("a Vision Recorder header with its full amplifier setup in [Comment]", async () => {
    const r = await scan(fixture("test.vhdr"), "sub-01/eeg/test.vhdr");
    expect(r).toEqual({ findings: [], coverage: "complete" });
  });

  test("an older layout with no Codepage line", async () => {
    const name = "test_old_layout_latin1_software_filter.vhdr";
    const r = await scan(fixture(name), `sub-01/eeg/${name}`);
    expect(r).toEqual({ findings: [], coverage: "complete" });
  });

  test("a marker file whose New Segment has no timestamp", async () => {
    // testv2.vmrk names test.eeg; scanned as test.vmrk, it names its own companion.
    const r = await scan(fixture("testv2.vmrk"), "sub-01/eeg/test.vmrk");
    expect(r).toEqual({ findings: [], coverage: "complete" });
  });
});

describe("brainvision-comment-name", () => {
  test("a made-up name in [Comment] fires, at review severity, shaped not quoted", async () => {
    const r = await scan(fixture("edited-comment-name.vhdr"), "sub-01/eeg/test.vhdr");
    expect(r.coverage).toBe("complete");
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f?.kind).toBe("brainvision-comment-name");
    expect(f?.severity).toBe("review");
    expect(f?.field).toBe("Comment");
    expect(JSON.stringify(r)).not.toContain("Quintavius");
    expect(JSON.stringify(r)).not.toContain("Hollberry");
    expect(DIRECT_KINDS.has("brainvision-comment-name")).toBe(false);
  });

  test("the same name outside [Comment] is not this rule's", async () => {
    const edited = text("test.vhdr").replace(
      "[Binary Infos]",
      "[Binary Infos]\n; Quintavius Hollberry",
    );
    const r = await scan(encode(edited), "sub-01/eeg/test.vhdr");
    expect(kinds(r)).toEqual([]);
  });

  test("a channel label of the header, an electrode label or a version string is no name", async () => {
    const edited = text("test.vhdr").replace(
      "[Comment]\n",
      "[Comment]\nReference: FCz  Ground: AFz  Firmware DSP_105.14.10.07 PyCorder actiCHamp\n",
    );
    const r = await scan(encode(edited), "sub-01/eeg/test.vhdr");
    expect(kinds(r)).toEqual([]);
  });
});

describe("brainvision-segment-date", () => {
  test("a New Segment timestamp is a date kind, one finding per file", async () => {
    const r = await scan(fixture("test.vmrk"), "sub-01/eeg/test.vmrk");
    expect(r.coverage).toBe("complete");
    expect(kinds(r)).toEqual(["brainvision-segment-date"]);
    expect(r.findings[0]?.severity).toBe("review");
    expect(DATE_KINDS.has("brainvision-segment-date")).toBe(true);
    const two = "test_old_layout_latin1_software_filter.vmrk";
    expect(kinds(await scan(fixture(two), `sub-01/eeg/${two}`))).toEqual([
      "brainvision-segment-date",
    ]);
  });

  test("a timestamp on 1 January, or one that is no date, fires nothing", async () => {
    const base = text("test.vmrk");
    for (const stamp of ["20130101000000000000", "00000000000000000000", "garbage"]) {
      const r = await scan(encode(base.replace("20131113161403794232", stamp)), "test.vmrk");
      expect(kinds(r)).toEqual([]);
    }
  });

  test("a date-only report is acceptable to the verdict (ADR 0090)", async () => {
    const r = await scan(fixture("test.vmrk"), "sub-01/eeg/test.vmrk");
    expect(
      classifyDataset({
        findings: r.findings,
        recordings: 1,
        recordingsRead: 1,
        unscreenedCount: 0,
        incompleteReasons: [],
      }),
    ).toBe("dates-only");
  });
});

const NOTE = { notes: ["companion-name-mismatch" as const] };

describe("DataFile and MarkerFile name the companion beside the header (a note, never a gap)", () => {
  test("a file name that is not the header's own base name is a note on a complete read", async () => {
    const r = await scan(fixture("testv2.vhdr"), "sub-01/eeg/testv2.vhdr");
    expect(r).toEqual({ findings: [], coverage: "complete", ...NOTE });
  });

  test("another directory or .. is a note, not a finding", async () => {
    const base = text("test.vhdr");
    for (const value of ["../test.eeg", "raw/test.eeg", "raw\\test.eeg"]) {
      const r = await scan(
        encode(base.replace("DataFile=test.eeg", `DataFile=${value}`)),
        "test.vhdr",
      );
      expect(r).toEqual({ findings: [], coverage: "complete", ...NOTE });
    }
  });

  test("an absolute or home-directory path is local-user-path, with the note", async () => {
    const base = text("test.vhdr");
    for (const value of [
      "C:\\Users\\Quintavius\\test.eeg",
      "D:\\data\\test.eeg",
      "/home/quintavius/test.eeg",
    ]) {
      const r = await scan(
        encode(base.replace("DataFile=test.eeg", `DataFile=${value}`)),
        "test.vhdr",
      );
      expect(r.coverage).toBe("complete");
      expect(r.notes).toEqual(["companion-name-mismatch"]);
      expect(r.findings.map((f) => [f.kind, f.severity, f.field])).toEqual([
        ["local-user-path", "review", "DataFile"],
      ]);
      expect(JSON.stringify(r)).not.toContain("uintavius");
    }
    const marker = text("test.vmrk").replace(
      "DataFile=test.eeg",
      "DataFile=C:\\Users\\Q\\test.eeg",
    );
    expect(kinds(await scan(encode(marker), "test.vmrk"))).toContain("local-user-path");
  });

  test("$b stands for the header's base name, and case does not matter", async () => {
    const base = text("test.vhdr")
      .replace("DataFile=test.eeg", "DataFile=$b.eeg")
      .replace("MarkerFile=test.vmrk", "MarkerFile=TEST.VMRK");
    expect(await scan(encode(base), "test.vhdr")).toEqual({ findings: [], coverage: "complete" });
  });

  test("a header with no DataFile is a note", async () => {
    const r = await scan(encode(text("test.vhdr").replace("DataFile=test.eeg\n", "")), "test.vhdr");
    expect(r).toEqual({ findings: [], coverage: "complete", ...NOTE });
  });
});

describe("marker descriptions", () => {
  const marker = (description: string) =>
    encode(
      text("test.vmrk")
        .replace("20131113161403794232", "00000000000000000000")
        .replace(/Mk2=[^\n]*/, `Mk2=Comment,${description},100,1,0`),
    );

  test("an email address or a phone number is brainvision-marker-text (review)", async () => {
    for (const description of [
      "mail q.hollberry@example.org",
      "call +1 858 555 0100",
      "Tel: 0858 555 0100",
    ]) {
      const r = await scan(marker(description), "test.vmrk");
      expect(r.findings.map((f) => [f.kind, f.severity, f.field])).toEqual([
        ["brainvision-marker-text", "review", "Marker"],
      ]);
      expect(JSON.stringify(r)).not.toContain("hollberry");
    }
  });

  test("a home-directory path is local-user-path", async () => {
    const r = await scan(marker("C:\\Users\\Quintavius\\stim.txt"), "test.vmrk");
    expect(r.findings.map((f) => [f.kind, f.field])).toEqual([["local-user-path", "Marker"]]);
  });

  test("stimulus codes, digits and words fire nothing, and no name rule runs here", async () => {
    for (const description of [
      "S  1",
      "R128",
      "1 2 3 4 5 6 7 8 9",
      "Quintavius Hollberry",
      "2019-10-02",
    ]) {
      expect(kinds(await scan(marker(description), "test.vmrk"))).toEqual([]);
    }
  });
});

describe("what is not a BrainVision file, and what is too long", () => {
  test("an AppleDouble or other non-header file is not-applicable", async () => {
    const appledouble = new Uint8Array(4096);
    appledouble.set([0x00, 0x05, 0x16, 0x07], 0);
    appledouble.set(encode("Mac OS X        "), 8);
    const r = await scan(appledouble, "sub-01/eeg/._test.vhdr");
    expect(r).toEqual({ findings: [], coverage: "not-applicable" });
  });

  test("Analyzer's Core Data Exchange header is read", async () => {
    const core = text("test.vhdr").replace(
      "Brain Vision Data Exchange Header File Version 1.0",
      "BrainVision Core Data Exchange Header File Version 1.0",
    );
    expect(await scan(encode(core), "test.vhdr")).toEqual({ findings: [], coverage: "complete" });
  });

  test("a header past 1 MiB is partial (limit) and keeps what it found", async () => {
    const edited = text("edited-comment-name.vhdr");
    const pad = `${edited}\n${"; padding\n".repeat(Math.ceil(TEXT_HEADER_MAX_BYTES / 10))}`;
    const r = await scan(encode(pad), "test.vhdr");
    expect(r.coverage).toBe("partial");
    expect(r.incomplete).toBe("limit");
    expect(kinds(r)).toEqual(["brainvision-comment-name"]);
  });

  test("a marker file is read whole up to 16 MiB, and partial past it", async () => {
    expect(MARKER_FILE_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(limitsFor(BRAINVISION_READER, "a.vmrk").maxBytes).toBe(MARKER_FILE_MAX_BYTES);
    expect(limitsFor(BRAINVISION_READER, "a.VMRK").maxBytes).toBe(MARKER_FILE_MAX_BYTES);
    expect(limitsFor(BRAINVISION_READER, "a.vhdr").maxBytes).toBe(TEXT_HEADER_MAX_BYTES);
    const head = text("test.vmrk");
    const twoMiB = `${head}\n${"; padding\n".repeat(Math.ceil((2 * TEXT_HEADER_MAX_BYTES) / 10))}`;
    const whole = await scan(encode(twoMiB), "test.vmrk");
    expect(whole.coverage).toBe("complete");
    expect(kinds(whole)).toEqual(["brainvision-segment-date"]);
    const over = `${head}\n${"; padding\n".repeat(Math.ceil(MARKER_FILE_MAX_BYTES / 10))}`;
    const r = await scan(encode(over), "test.vmrk");
    expect(r.coverage).toBe("partial");
    expect(r.incomplete).toBe("limit");
    expect(kinds(r)).toEqual(["brainvision-segment-date"]);
  });

  test("a file of exactly 1 MiB is whole", async () => {
    const head = text("test.vhdr");
    const pad = `${head}${";".repeat(TEXT_HEADER_MAX_BYTES - encode(head).length)}`;
    expect(encode(pad).length).toBe(TEXT_HEADER_MAX_BYTES);
    expect(await scan(encode(pad), "test.vhdr")).toEqual({ findings: [], coverage: "complete" });
  });

  test("a Windows-1252 header decodes, and UTF-8 is honored when declared", () => {
    const latin = new Uint8Array([...encode("Codepage=ANSI\nCh1=Fp1,,0.1,"), 0xb5, 0x56]);
    expect(decodeHeader(latin)).toContain("µV");
    const utf8 = encode("\ufeffCodepage=UTF-8\nCh1=Fp1,,0.1,µV");
    expect(decodeHeader(utf8).startsWith("Codepage")).toBe(true);
    expect(decodeHeader(utf8)).toContain("µV");
  });
});

describe("companions and coverage", () => {
  const VHDR = "sub-01/eeg/sub-01_task-rest_eeg.vhdr";
  const VMRK = "sub-01/eeg/sub-01_task-rest_eeg.vmrk";
  const EEG = "sub-01/eeg/sub-01_task-rest_eeg.eeg";
  /** The real fixture, named as a BIDS recording (its file names rewritten to match). */
  const files: Record<string, Uint8Array> = {
    [VHDR]: encode(
      text("test.vhdr")
        .replace("DataFile=test.eeg", "DataFile=sub-01_task-rest_eeg.eeg")
        .replace("MarkerFile=test.vmrk", "MarkerFile=sub-01_task-rest_eeg.vmrk"),
    ),
    [VMRK]: encode(
      text("testv2.vmrk").replace("DataFile=test.eeg", "DataFile=sub-01_task-rest_eeg.eeg"),
    ),
  };

  async function read(paths: string[]) {
    const entries = paths
      .filter((p) => readerFor(p) !== null)
      .map((path) => ({ path, size: files[path]?.length ?? 0 }));
    return readRecordings({
      entries,
      paths,
      open: (entry) => bufferSource(files[entry.path] as Uint8Array),
      concurrency: 2,
      now: () => 0,
      datasetTimeMs: 60_000,
      failureClass: () => "internal",
    });
  }

  test("a header with its .eeg and .vmrk is read complete, the .eeg claimed", async () => {
    const out = await read([VHDR, VMRK, EEG]);
    expect(out.tallies.brainvision).toEqual({ files: 2, read: 2, partial: 0, failed: 0 });
    expect(out.companionMissing).toBe(0);
    expect([...out.reasons]).toEqual([]);
    expect(formatCoverage([VHDR, VMRK, EEG])).toEqual({
      byReader: { brainvision: 2 },
      unscreened: {},
    });
  });

  test("a header naming another file is read complete: a counted note, still clean", async () => {
    // The real header as it is: it names test.eeg and test.vmrk, not this recording's names.
    files[VHDR] = fixture("test.vhdr");
    try {
      const out = await read([VHDR, VMRK, EEG]);
      expect(out.tallies.brainvision).toEqual({ files: 2, read: 2, partial: 0, failed: 0 });
      expect(out.companionNameMismatch).toBe(1);
      expect([...out.reasons]).toEqual([]);
      expect(coverageFields(out).companion_name_mismatch).toBe(1);
      const status = classifyDataset({
        findings: out.findings,
        recordings: 2,
        recordingsRead: out.tallies.brainvision.read,
        unscreenedCount: 0,
        incompleteReasons: [...out.reasons],
      });
      expect(status).toBe("clean");
    } finally {
      files[VHDR] = encode(
        text("test.vhdr")
          .replace("DataFile=test.eeg", "DataFile=sub-01_task-rest_eeg.eeg")
          .replace("MarkerFile=test.vmrk", "MarkerFile=sub-01_task-rest_eeg.vmrk"),
      );
    }
    expect(coverageFields(await read([VHDR, VMRK, EEG]))).not.toHaveProperty(
      "companion_name_mismatch",
    );
  });

  test("an AppleDouble file is unscreened under its extension, never a gap", async () => {
    files["sub-01/eeg/._x.vhdr"] = new Uint8Array(4096);
    const out = await read([VHDR, VMRK, EEG, "sub-01/eeg/._x.vhdr"]);
    expect(out.tallies.brainvision).toEqual({ files: 2, read: 2, partial: 0, failed: 0 });
    expect(out.notApplicable).toEqual({ ".vhdr": 1 });
    expect([...out.reasons]).toEqual([]);
  });

  test("a missing .eeg is companion_missing, never clean", async () => {
    const out = await read([VHDR, VMRK]);
    expect(out.companionMissing).toBe(1);
    expect(out.tallies.brainvision.partial).toBe(1);
    expect([...out.reasons]).toEqual(["companion-missing"]);
    expect(out.findings).toEqual([]);
    const status = classifyDataset({
      findings: out.findings,
      recordings: 2,
      recordingsRead: out.tallies.brainvision.read,
      unscreenedCount: 0,
      incompleteReasons: [...out.reasons],
    });
    expect(status).toBe("unchecked");
  });

  test("an orphan .vmrk is read and partial; an orphan .eeg is unscreened", async () => {
    const out = await read([VMRK]);
    expect(out.tallies.brainvision).toEqual({ files: 1, read: 0, partial: 1, failed: 0 });
    expect(out.companionMissing).toBe(1);
    expect(formatCoverage([EEG]).unscreened).toEqual({ ".eeg": 1 });
    expect(formatCoverage(["sourcedata/raw/x.eeg"]).unscreened).toEqual({ ".eeg": 1 });
  });

  test("companions pair by base name, in either letter case of the extension", () => {
    const upper = "sub-01/eeg/a.EEG";
    const check = BRAINVISION_READER.companions?.(
      "sub-01/eeg/a.vhdr",
      new Set([upper, "sub-01/eeg/a.vmrk"]),
    );
    expect(check).toEqual({ claimed: [upper, "sub-01/eeg/a.vmrk"], missing: [] });
    const elsewhere = BRAINVISION_READER.companions?.(
      "sub-01/eeg/a.vhdr",
      new Set(["sub-02/eeg/a.eeg"]),
    );
    expect(elsewhere?.missing).toEqual(["sub-01/eeg/a.eeg", "sub-01/eeg/a.vmrk"]);
  });
});

describe("every new kind has its words", () => {
  test("statement, read, remedy and anchor", () => {
    for (const kind of [
      "brainvision-comment-name",
      "brainvision-segment-date",
      "brainvision-marker-text",
    ] as const) {
      const copy = KIND_COPY[kind];
      expect(copy.statement.length).toBeGreaterThan(20);
      expect(copy.read).toContain("BrainVision");
      expect(copy.remedy.length).toBeGreaterThan(10);
      expect(copy.anchor).toBe(`kind-${kind}`);
    }
  });
});

describe("the note has its words", () => {
  test("statement, read, remedy and anchor; the remedy names the entry to correct", () => {
    const copy = NOTE_COPY["companion-name-mismatch"];
    expect(copy.statement).toContain("does not change the verdict");
    expect(copy.remedy).toContain("DataFile or MarkerFile");
    expect(copy.anchor).toBe("note-companion-name-mismatch");
  });
});
