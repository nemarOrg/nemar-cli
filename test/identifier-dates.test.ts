/**
 * The acquisition-date rule (`normalizeEdfDates`, `normalizeScansTableDates`, ADR 0091).
 *
 * Every case checks what makes the rule safe to run on a depositor's recording: the new header
 * differs from the old only in the day and month of the dates the scanner reports, the scanner then
 * reports none, and every other finding is what it was. Headers are built byte for byte to the EDF
 * layout; a header written by an independent EDF+ tool is normalized and read back by that tool.
 * All names and dates are invented.
 *
 * The golden digests at the end pin ADR 0085's scrub and the scanner to the bytes they produced
 * before this rule existed (computed from the epic tip at d149cacb), because the rule shares the
 * scanner's reading of the recording field and that reading was moved into a helper.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EDF_HEADER_BYTES,
  type FindingKind,
  acqTimeCells,
  edfAcquisitionDates,
  scanEdfHeader,
  scanScansTable,
} from "../shared/identifier-scan";
import {
  ScrubRefused,
  normalizeEdfDates,
  normalizeScansTableDates,
  scrubEdfHeader,
  verifyDateNormalization,
} from "../shared/identifier-scrub";
import { toolOrFail } from "./scrub/helpers/require-tools";

interface HeaderFields {
  family?: "edf" | "bdf";
  patient?: string;
  recording?: string;
  startdate?: string;
  starttime?: string;
  pad?: "space" | "nul";
}

function buildHeader(f: HeaderFields = {}): Uint8Array {
  const out = new Uint8Array(EDF_HEADER_BYTES).fill(0x20);
  const padByte = f.pad === "nul" ? 0x00 : 0x20;
  const put = (text: string, start: number, width: number) => {
    out.fill(padByte, start, start + width);
    for (let i = 0; i < Math.min(text.length, width); i++) out[start + i] = text.charCodeAt(i);
  };
  if ((f.family ?? "edf") === "bdf") {
    out[0] = 0xff;
    for (let i = 0; i < 7; i++) out[1 + i] = "BIOSEMI".charCodeAt(i);
  } else {
    out[0] = "0".charCodeAt(0);
  }
  put(f.patient ?? "X X X X", 8, 80);
  put(f.recording ?? "Startdate 14-MAR-2023 X X X", 88, 80);
  put(f.startdate ?? "14.03.23", 168, 8);
  put(f.starttime ?? "10.11.12", 176, 8);
  for (let i = 184; i < EDF_HEADER_BYTES; i++) out[i] = (i * 37) & 0xff;
  return out;
}

const field = (b: Uint8Array, start: number, end: number) =>
  Array.from(b.subarray(start, end), (c) => (c === 0 ? " " : String.fromCharCode(c)))
    .join("")
    .trim();
const recordingOf = (b: Uint8Array) => field(b, 88, 168);
const startdateOf = (b: Uint8Array) => field(b, 168, 176);

function differing(a: Uint8Array, b: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

/**
 * The byte-level proof: the two headers are the same size, at least one byte differs, and every
 * byte that differs is one of `allowed` (a digit already `0` or `1` in place does not change).
 */
function changedOnlyAt(
  a: Uint8Array,
  b: Uint8Array,
  allowed: readonly number[],
  label?: string,
): void {
  expect(b.length, label).toBe(a.length);
  const changed = differing(a, b);
  expect(changed.length, label).toBeGreaterThan(0);
  expect(
    changed.filter((i) => !allowed.includes(i)),
    label,
  ).toEqual([]);
}

const HEADER_DATES = new Set<FindingKind>(["edf-startdate", "edf-recording-startdate"]);
const dateFindings = (h: Uint8Array) => scanEdfHeader(h).filter((f) => HEADER_DATES.has(f.kind));
const otherFindings = (h: Uint8Array) =>
  JSON.stringify(scanEdfHeader(h).filter((f) => !HEADER_DATES.has(f.kind)));

/** Offset of the slot date in a recording field written by `buildHeader` with no leading space. */
const SLOT = 88 + "Startdate ".length;
const STARTDATE_BYTES = [168, 169, 171, 172];
const SLOT_BYTES = [SLOT, SLOT + 1, SLOT + 3, SLOT + 4, SLOT + 5];

describe("setting the acquisition dates of a header to 1 January", () => {
  test("EDF+: both dates become 1 January, and only their day and month bytes change", () => {
    const before = buildHeader();
    expect(dateFindings(before).map((f) => f.kind)).toEqual([
      "edf-recording-startdate",
      "edf-startdate",
    ]);
    const result = normalizeEdfDates(before);
    expect(result.changed).toBe(true);
    expect(result.fields).toEqual(["recording.startdate", "startdate"]);
    expect(recordingOf(result.header)).toBe("Startdate 01-JAN-2023 X X X");
    expect(startdateOf(result.header)).toBe("01.01.23");
    expect(field(result.header, 176, 184)).toBe("10.11.12");
    // The byte-level proof: only the date bytes differ, everything else is identical.
    changedOnlyAt(before, result.header, [...SLOT_BYTES, ...STARTDATE_BYTES]);
    expect(dateFindings(result.header)).toEqual([]);
    expect(otherFindings(result.header)).toBe(otherFindings(before));
    expect(verifyDateNormalization(before, result.header)).toEqual({ ok: true, reasons: [] });
  });

  test("BDF, NUL padded, is set the same way and keeps its magic", () => {
    const before = buildHeader({ family: "bdf", pad: "nul" });
    const result = normalizeEdfDates(before);
    expect(result.header[0]).toBe(0xff);
    expect(field(result.header, 1, 8)).toBe("BIOSEMI");
    expect(recordingOf(result.header)).toBe("Startdate 01-JAN-2023 X X X");
    expect(startdateOf(result.header)).toBe("01.01.23");
    changedOnlyAt(before, result.header, [...SLOT_BYTES, ...STARTDATE_BYTES]);
  });

  test("the two-digit year is never read or written, on either side of the 1985 pivot", () => {
    // EDF reads `yy` 85..99 as 1985..1999 and 00..84 as 2000..2084. The rule keeps the bytes, so
    // whatever pivot a reader applies, it reads the same year before and after.
    for (const yy of ["84", "85", "99", "00", "01"]) {
      const before = buildHeader({ startdate: `14.03.${yy}`, recording: "Startdate X X X X" });
      const result = normalizeEdfDates(before);
      expect(startdateOf(result.header), yy).toBe(`01.01.${yy}`);
      changedOnlyAt(before, result.header, STARTDATE_BYTES, yy);
    }
    // And the slot's four-digit year is kept whatever it is, the header's two digits disagreeing or not.
    const mixed = normalizeEdfDates(
      buildHeader({ startdate: "14.03.85", recording: "Startdate 14-MAR-1985 X X X" }),
    );
    expect(recordingOf(mixed.header)).toBe("Startdate 01-JAN-1985 X X X");
    expect(startdateOf(mixed.header)).toBe("01.01.85");
  });

  test("EDF+ with no date in the slot: only the header start date is set", () => {
    const before = buildHeader({ recording: "Startdate X X X X" });
    const result = normalizeEdfDates(before);
    expect(result.fields).toEqual(["startdate"]);
    changedOnlyAt(before, result.header, STARTDATE_BYTES);
  });

  test("plain EDF with a free-text recording field and no date in it: the start date is set", () => {
    const before = buildHeader({ recording: "EEG lab 3 montage A" });
    const result = normalizeEdfDates(before);
    expect(result.fields).toEqual(["startdate"]);
    changedOnlyAt(before, result.header, STARTDATE_BYTES);
  });

  test("a slot dated and a header already on 1 January: only the slot is set", () => {
    const before = buildHeader({ startdate: "01.01.23" });
    const result = normalizeEdfDates(before);
    expect(result.fields).toEqual(["recording.startdate"]);
    changedOnlyAt(before, result.header, SLOT_BYTES);
  });

  test("a header already on 1 January everywhere comes back byte for byte unchanged", () => {
    const before = buildHeader({ startdate: "01.01.23", recording: "Startdate 01-JAN-2023 X X X" });
    const result = normalizeEdfDates(before);
    expect(result).toEqual({ header: before, changed: false, fields: [] });
    expect(differing(before, result.header)).toEqual([]);
  });

  test("a start date the scanner does not read as a date is left alone", () => {
    for (const text of ["  .  .  ", "14/03/23", "00.00.00", "13.13.13", "1.3.2023", "xx.yy.zz"]) {
      const before = buildHeader({ startdate: text, recording: "Startdate X X X X" });
      const result = normalizeEdfDates(before);
      expect(result.changed, text).toBe(false);
      expect(differing(before, result.header), text).toEqual([]);
      // Still reported, under its own kind: the scanner says it is not a date.
      expect(
        scanEdfHeader(result.header).some((f) => f.kind === "edf-startdate-unparsed"),
        text,
      ).toBe(true);
    }
    // ...while a dated slot beside an unparsed start date is set, and the unparsed field kept.
    const both = buildHeader({ startdate: "14/03/23" });
    const result = normalizeEdfDates(both);
    expect(result.fields).toEqual(["recording.startdate"]);
    changedOnlyAt(both, result.header, SLOT_BYTES);
  });

  test("the month letters keep their case, and a localized month becomes JAN", () => {
    const cases: Array<[string, string]> = [
      ["14-mar-2023", "01-jan-2023"],
      ["14-Mar-2023", "01-Jan-2023"],
      ["14-OKT-2023", "01-JAN-2023"],
      ["31-dec-1999", "01-jan-1999"],
    ];
    for (const [slot, expected] of cases) {
      const before = buildHeader({ recording: `Startdate ${slot} X X X` });
      const result = normalizeEdfDates(before);
      expect(recordingOf(result.header), slot).toBe(`Startdate ${expected} X X X`);
      expect(dateFindings(result.header), slot).toEqual([]);
    }
  });

  test("a slot date in any layout but dd-MMM-yyyy leaves the whole header unchanged", () => {
    // All or nothing: setting the header date alone would leave the slot saying the day, and the
    // two disagreeing. The finding stays, and the warning of ADR 0090 is what covers it.
    for (const slot of ["14.03.2023", "2023-03-14", "1-MAR-2023", "14-MAR-23", "14MAR2023"]) {
      const before = buildHeader({ recording: `Startdate ${slot} X X X` });
      expect(
        dateFindings(before).some((f) => f.kind === "edf-recording-startdate"),
        slot,
      ).toBe(true);
      const result = normalizeEdfDates(before);
      expect(result.changed, slot).toBe(false);
      expect(differing(before, result.header), slot).toEqual([]);
    }
  });

  test("a slot with more after its date, or the EDF+ spelling in a free-text field, is unchanged", () => {
    // The rule writes only into a slot that IS the date: `14-MAR-2023,ward` is a slot holding more,
    // and a free-text field has no slot at all, whatever spelling its date has.
    for (const recording of ["Startdate 14-MAR-2023,ward X X X", "Hospital 14-MAR-2023 room 3"]) {
      const before = buildHeader({ recording });
      expect(
        dateFindings(before).some((f) => f.kind === "edf-recording-startdate"),
        recording,
      ).toBe(true);
      const result = normalizeEdfDates(before);
      expect(result.changed, recording).toBe(false);
      expect(differing(before, result.header), recording).toEqual([]);
    }
  });

  test("a date in a free-text recording field leaves the whole header unchanged", () => {
    const before = buildHeader({ recording: "Hospital 14.03.2023 room 3" });
    expect(dateFindings(before).map((f) => f.kind)).toContain("edf-recording-startdate");
    expect(normalizeEdfDates(before).changed).toBe(false);
  });

  test("a slot that is not a date the scanner reads is never touched", () => {
    // `99-ABC-2020` has the shape and is not a date: the scanner calls it free text.
    const before = buildHeader({ recording: "Startdate 99-ABC-2020 X X X" });
    const result = normalizeEdfDates(before);
    expect(recordingOf(result.header)).toBe("Startdate 99-ABC-2020 X X X");
    expect(result.fields).toEqual(["startdate"]);
  });

  test("leading spaces or NULs before the keyword do not move the bytes it writes", () => {
    for (const pad of ["space", "nul"] as const) {
      const before = buildHeader({ recording: "  startdate 14-MAR-2023 X X X", pad });
      const result = normalizeEdfDates(before);
      expect(recordingOf(result.header), pad).toBe("startdate 01-JAN-2023 X X X");
      changedOnlyAt(
        before,
        result.header,
        [...SLOT_BYTES.map((i) => i + 2), ...STARTDATE_BYTES],
        pad,
      );
    }
  });

  test("the locator reports exactly what the scanner reports", () => {
    const at = edfAcquisitionDates(buildHeader());
    expect(at).toEqual({
      startdate: true,
      recording: { start: SLOT, end: SLOT + 11, wholeSlot: true },
    });
    expect(edfAcquisitionDates(buildHeader({ startdate: "01.01.23" }))?.startdate).toBe(false);
    expect(
      edfAcquisitionDates(buildHeader({ recording: "Hospital 14.03.2023" }))?.recording?.wholeSlot,
    ).toBe(false);
    expect(edfAcquisitionDates(new Uint8Array(256))).toBeNull();
  });

  test("the rule is idempotent and never modifies its input", () => {
    const before = buildHeader();
    const copy = before.slice();
    const once = normalizeEdfDates(before);
    expect(differing(before, copy)).toEqual([]);
    expect(normalizeEdfDates(once.header).changed).toBe(false);
  });

  test("a header that is not EDF or BDF, or is too short, is refused with a fixed reason", () => {
    const notEdf = buildHeader();
    notEdf[0] = "9".charCodeAt(0);
    expect(() => normalizeEdfDates(notEdf)).toThrow(ScrubRefused);
    expect(() => normalizeEdfDates(new Uint8Array(100))).toThrow(ScrubRefused);
  });

  test("it composes with the identifier scrub: the scrub's bytes and the date bytes, nothing else", () => {
    const before = buildHeader({
      patient: "P_01 F 14-MAR-1990 Fixturename",
      recording: "Startdate 14-MAR-2023 ADM01 Opname EQ1",
    });
    const scrubbed = scrubEdfHeader(before);
    const both = normalizeEdfDates(scrubbed.header);
    expect(recordingOf(both.header)).toBe("Startdate 01-JAN-2023 X X X");
    expect(startdateOf(both.header)).toBe("01.01.23");
    expect(
      differing(before, both.header).every(
        (i) => (i >= 8 && i < 168) || STARTDATE_BYTES.includes(i),
      ),
    ).toBe(true);
    changedOnlyAt(scrubbed.header, both.header, [...SLOT_BYTES, ...STARTDATE_BYTES]);
  });
});

describe("the proof that only the dates changed", () => {
  const before = buildHeader();
  const good = normalizeEdfDates(before).header;

  test("rejects a change outside the date bytes, such as the start time", () => {
    const bad = good.slice();
    bad[176] = "9".charCodeAt(0);
    expect(verifyDateNormalization(before, bad).reasons).toContain("bytes-outside-dates-changed");
  });

  test("rejects a date bytes write that leaves a date the scanner still reports", () => {
    const bad = good.slice();
    bad[169] = "2".charCodeAt(0);
    expect(verifyDateNormalization(before, bad).reasons).toContain("acquisition-date-remains");
  });

  test("rejects date bytes that make the slot text the scanner reads as something else", () => {
    // `99-XYZ-2023` is no date at all: none remains, but a free-text finding appears in its place.
    const bad = good.slice();
    bad.set(new TextEncoder().encode("99-XYZ"), SLOT);
    expect(verifyDateNormalization(before, bad).reasons).toEqual(["other-findings-changed"]);
  });

  test("rejects a change in an identification field, a changed family and a short header", () => {
    const named = buildHeader({ patient: "P_01 F X Fixturename" });
    const touched = normalizeEdfDates(named).header.slice();
    touched.set(new TextEncoder().encode("X X X X                       "), 8);
    expect(verifyDateNormalization(named, touched).reasons).toEqual([
      "bytes-outside-dates-changed",
      "other-findings-changed",
    ]);
    const family = good.slice();
    family[0] = 0xff;
    expect(verifyDateNormalization(before, family).reasons).toContain("file-family-changed");
    expect(verifyDateNormalization(before, new Uint8Array(10)).reasons).toEqual([
      "header-too-short",
    ]);
  });

  test("the verdict names reasons and never values", () => {
    const bad = good.slice();
    bad[176] = 0x41;
    const verdict = verifyDateNormalization(before, bad);
    expect(JSON.stringify(verdict)).not.toContain("2023");
    expect(JSON.stringify(verdict)).not.toContain("MAR");
  });
});

describe("a seeded fuzz over layouts nobody wrote a case for", () => {
  let seed = 20261007;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const tokens = [
    "X",
    "14-MAR-2023",
    "14-mar-2023",
    "01-JAN-2023",
    "14-OKT-2020",
    "14.03.2023",
    "EEG",
    "room3",
    "99-ABC-2020",
    "ADM01",
  ];

  test("every result is unchanged or proven, idempotent, date-free and same-size", () => {
    let set = 0;
    for (let n = 0; n < 600; n++) {
      const before = buildHeader({
        family: rand() < 0.3 ? "bdf" : "edf",
        pad: rand() < 0.3 ? "nul" : "space",
        recording: `${pick(["Startdate", "startdate", "Hospital"])} ${Array.from({ length: Math.floor(rand() * 4) }, () => pick(tokens)).join(" ")}`,
        startdate: pick(["01.01.85", "14.03.23", "31.12.99", "00.00.00", "29.02.84"]),
      });
      const label = `case ${n}`;
      const result = normalizeEdfDates(before);
      expect(result.header.length, label).toBe(EDF_HEADER_BYTES);
      if (!result.changed) {
        expect(differing(before, result.header), label).toEqual([]);
        continue;
      }
      set++;
      expect(verifyDateNormalization(before, result.header).ok, label).toBe(true);
      expect(dateFindings(result.header), label).toEqual([]);
      expect(otherFindings(result.header), label).toBe(otherFindings(before));
      expect(normalizeEdfDates(result.header).changed, label).toBe(false);
    }
    // The corpus reaches the rule, not only its refusals.
    expect(set).toBeGreaterThan(200);
  });
});

describe("scans tables", () => {
  const utf8 = (s: string) => new TextEncoder().encode(s);

  test("a dated acq_time keeps its year, time, fraction and zone; month and day become 01-01", () => {
    const raw = utf8(
      "filename\tacq_time\nsub-01_eeg.edf\t2023-03-14T10:11:12.500000Z\nsub-02_eeg.edf\tn/a\nsub-03_eeg.edf\t 1999-12-31T23:59:59+02:00\r\n",
    );
    const result = normalizeScansTableDates(raw);
    expect(result.status).toBe("normalized");
    expect(result.values).toBe(2);
    expect(new TextDecoder().decode(result.bytes)).toBe(
      "filename\tacq_time\nsub-01_eeg.edf\t2023-01-01T10:11:12.500000Z\nsub-02_eeg.edf\tn/a\nsub-03_eeg.edf\t 1999-01-01T23:59:59+02:00\r\n",
    );
    expect(result.bytes?.length).toBe(raw.length);
    const changed = differing(raw, result.bytes as Uint8Array);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((i) => /\d/.test(String.fromCharCode(raw[i] as number)))).toBe(true);
    expect(scanScansTable(new TextDecoder().decode(result.bytes))).toEqual([]);
  });

  test("the column is found by its name wherever it is, and a byte-order mark is kept", () => {
    const raw = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...utf8("acq_time\tfilename\textra\n2020-06-07T01:02:03\tä.edf\tµ\n"),
    ]);
    const result = normalizeScansTableDates(raw);
    expect(Array.from((result.bytes as Uint8Array).subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(result.bytes)).toBe(
      "acq_time\tfilename\textra\n2020-01-01T01:02:03\tä.edf\tµ\n",
    );
    expect(result.bytes?.length).toBe(raw.length);
  });

  test("a table with nothing dated, or no acq_time column, is clean and returns no bytes", () => {
    expect(
      normalizeScansTableDates(utf8("filename\tacq_time\nx.edf\t2023-01-01T10:00:00\n")),
    ).toEqual({ status: "clean", values: 0 });
    expect(normalizeScansTableDates(utf8("filename\tdate\nx.edf\t2023-03-14\n"))).toEqual({
      status: "clean",
      values: 0,
    });
  });

  test("a value the scanner does not read as dated is left, and text that is not UTF-8 is unreadable", () => {
    const raw = utf8("filename\tacq_time\nx.edf\t14.03.2023\ny.edf\t2023-3-14\n");
    expect(normalizeScansTableDates(raw)).toEqual({ status: "clean", values: 0 });
    expect(normalizeScansTableDates(new Uint8Array([0x66, 0xff, 0xfe, 0x0a]))).toEqual({
      status: "unreadable",
      values: 0,
    });
  });

  test("a byte-order mark in the text given is not part of the header row", () => {
    // The screen decodes with a decoder that drops one mark, and the reading drops one more.
    // The final newline leaves an empty row, whose one cell is empty, as `split` gave the screen.
    expect(acqTimeCells("\uFEFFacq_time\tfilename\n2023-03-14\tx.edf\n")).toEqual([
      { index: 19, value: "2023-03-14" },
      { index: 36, value: "" },
    ]);
  });

  test("the cells are the screen's own: the same cells the screen reports, no more", () => {
    const text = "a\tacq_time\tacq_time\nx\t2023-03-14\t2023-04-15\nshort\n";
    expect(acqTimeCells(text).map((c) => c.value)).toEqual(["2023-03-14"]);
    const result = normalizeScansTableDates(utf8(text));
    // The second column of the same name is not the one the screen reads, so it is not set.
    expect(new TextDecoder().decode(result.bytes)).toBe(
      "a\tacq_time\tacq_time\nx\t2023-01-01\t2023-04-15\nshort\n",
    );
  });
});

describe("a header written by an independent EDF+ tool", () => {
  const fixture = (name: string) =>
    new Uint8Array(readFileSync(join(import.meta.dir, "fixtures/identifier-scan", name)));

  test("the dated fixture is set to 1 January and the year-only fixture is untouched", () => {
    const flagged = fixture("flagged.edf");
    const result = normalizeEdfDates(flagged);
    expect(result.fields).toEqual(["recording.startdate", "startdate"]);
    changedOnlyAt(flagged.subarray(0, 256), result.header, [...SLOT_BYTES, ...STARTDATE_BYTES]);
    expect(normalizeEdfDates(fixture("clean.edf")).changed).toBe(false);
  });

  // Skipped on a machine without uv, and a FAILURE where NEMAR_REQUIRE_SCRUB_TOOLS=1 (CI).
  const uvAvailable = toolOrFail("uv", spawnSync("uv", ["--version"]).status === 0);
  test.skipIf(!uvAvailable)(
    "the independent tool reads the same year and time, on 1 January, with the signals intact",
    () => {
      const flagged = fixture("flagged.edf");
      const scrubbed = scrubEdfHeader(flagged).header;
      const patched = flagged.slice();
      patched.set(normalizeEdfDates(scrubbed).header, 0);
      const dir = mkdtempSync(join(tmpdir(), "dates-"));
      try {
        writeFileSync(join(dir, "before.edf"), flagged);
        writeFileSync(join(dir, "after.edf"), patched);
        const py = [
          "import edfio, sys",
          "for p in sys.argv[1:]:",
          "    e = edfio.read_edf(p)",
          "    s = e.signals[0].data",
          "    print(p.rsplit('/', 1)[1], e.recording.startdate, e.starttime, len(e.signals), s.sum())",
        ].join("\n");
        const run = spawnSync(
          "uv",
          [
            "run",
            "--quiet",
            "--with",
            "edfio",
            "--with",
            "numpy",
            "python",
            "-c",
            py,
            join(dir, "before.edf"),
            join(dir, "after.edf"),
          ],
          { encoding: "utf8", timeout: 120_000 },
        );
        expect(run.status, run.stderr).toBe(0);
        const [beforeLine, afterLine] = run.stdout.trim().split("\n");
        expect(beforeLine).toContain("before.edf 2023-03-14 00:00:00 1");
        expect(afterLine).toContain("after.edf 2023-01-01 00:00:00 1");
        // The same samples: everything after the date is the same.
        expect(afterLine?.split(" ").at(-1)).toBe(beforeLine?.split(" ").at(-1));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("ADR 0085's scrub and the scanner are byte for byte what they were", () => {
  // A seeded corpus, and the digests of what the scrub and the scanner made of it at the epic tip
  // (d149cacb), before this rule and the shared date reading existed. A change to either digest is
  // a change to ADR 0085's rule or to a finding, which this phase must not make.
  function goldenCorpus(count: number): Uint8Array[] {
    let seed = 20261007;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const words = [
      "alice",
      "Li",
      "X",
      "x",
      "S_01",
      "12",
      "hand=1",
      "dob=14.03.1993",
      "14MAR1993",
      "19930314",
      "01-JAN-1990",
      "14-MAR-2023",
      "14-mar-2023",
      "14-OKT-2020",
      "14.03.2023",
      "2023-03-14",
      "MAR-2023",
      "1234567",
      "F",
      "M",
      "unknown",
      "*14.03.1990",
      "born",
      "EEG",
      "Smith^Kim",
      "99-ABC-2020",
    ];
    const starts = [
      "01.01.85",
      "14.03.23",
      "31.12.99",
      "00.00.00",
      "14/03/23",
      "29.02.84",
      "01.02.03",
    ];
    const out: Uint8Array[] = [];
    for (let n = 0; n < count; n++) {
      const h = new Uint8Array(256).fill(rand() < 0.3 ? 0 : 0x20);
      const put = (t: string, s: number, w: number) => {
        for (let i = 0; i < Math.min(t.length, w); i++) h[s + i] = t.charCodeAt(i) & 0xff;
      };
      if (rand() < 0.3) {
        h[0] = 0xff;
        put("BIOSEMI", 1, 7);
      } else put("0", 0, 8);
      put(Array.from({ length: 1 + Math.floor(rand() * 5) }, () => pick(words)).join(" "), 8, 80);
      const head = pick(["Startdate", "startdate", "Hospital", "X", ""]);
      const tail = Array.from({ length: Math.floor(rand() * 5) }, () => pick(words)).join(" ");
      put(`${pick(["", " "])}${head} ${tail}`, 88, 80);
      put(pick(starts), 168, 8);
      put("10.11.12", 176, 8);
      out.push(h);
    }
    return out;
  }

  test("the digests over 2000 seeded headers match the epic tip's", () => {
    const scrub = createHash("sha256");
    const scan = createHash("sha256");
    for (const h of goldenCorpus(2000)) {
      scrub.update(scrubEdfHeader(h).header);
      scan.update(`${JSON.stringify(scanEdfHeader(h))}\n`);
    }
    expect(scrub.digest("hex")).toBe(
      "c0e68aee3ba835f2c7bb8a40e2e07fd593308612dcca36316db877677663da9a",
    );
    expect(scan.digest("hex")).toBe(
      "e0234933266d7fb85429a7d51266065acc5c6c4a925098c9f7ae38b963c338a2",
    );
  });
});
