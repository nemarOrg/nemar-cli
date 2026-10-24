/**
 * The importer's header patch as a result (`importHeaderPatch` in `shared/identifier-scrub.ts`).
 *
 * The importer reaches it through `patchHeader` in `src/lib/import-scrub.ts`, a wrapper that turns
 * `scrub-unverified` into its refusal; `test/import-scrub.test.ts` drives that end to end through
 * `prepareImportedTreeForCopy` and passes unedited. This file pins the result itself, which the
 * upstream re-pull's planner (ADR 0111) uses to compute what the import would leave in a header.
 *
 * Two branches have no input that reaches them, and that is by construction, not an oversight:
 * `scrub-unverified` needs a scrub that leaves a removable finding, and the scrub rewrites a whole
 * field to a placeholder the scanner reads as clean whenever the field has one; `datesUnproven`
 * needs the date rule to fault or fail its own proof, and its seeded fuzz in
 * `test/identifier-dates.test.ts` finds no layout that does. Both are defenses kept for a scanner
 * that grows a rule the scrub does not yet follow. All names and dates are invented.
 */

import { describe, expect, test } from "bun:test";
import { EDF_HEADER_BYTES } from "../shared/identifier-scan";
import { PATIENT_PLACEHOLDER, importHeaderPatch, verifyScrub } from "../shared/identifier-scrub";

interface HeaderFields {
  patient?: string;
  recording?: string;
  startdate?: string;
}

function buildHeader(f: HeaderFields = {}, length = EDF_HEADER_BYTES): Uint8Array {
  const out = new Uint8Array(length).fill(0x20);
  const put = (text: string, start: number, width: number) => {
    out.fill(0x20, start, start + width);
    for (let i = 0; i < Math.min(text.length, width); i++) out[start + i] = text.charCodeAt(i);
  };
  out[0] = "0".charCodeAt(0);
  put(f.patient ?? "X X X X", 8, 80);
  put(f.recording ?? "Startdate 14-MAR-2023 X X X", 88, 80);
  put(f.startdate ?? "14.03.23", 168, 8);
  put("10.11.12", 176, 8);
  for (let i = 184; i < length; i++) out[i] = (i * 37) & 0xff;
  return out;
}

const text = (b: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...b.subarray(start, end)).trim();
const patientOf = (b: Uint8Array) => text(b, 8, 88);
const recordingOf = (b: Uint8Array) => text(b, 88, 168);
const startdateOf = (b: Uint8Array) => text(b, 168, 176);

function differing(a: Uint8Array, b: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

const STARTDATE_BYTES = [168, 169, 171, 172];
const IDENTIFIED: HeaderFields = {
  patient: "P_01 F 14-MAR-1990 Fixturename",
  recording: "Startdate 14-MAR-2023 ADM01 Opname EQ1",
};

describe("importHeaderPatch", () => {
  test("bytes that are not an EDF or BDF header, or too few of them, are not-edf", () => {
    const notEdf = new TextEncoder().encode(
      "this is a text file named like a recording".padEnd(256),
    );
    expect(importHeaderPatch(notEdf, true)).toEqual({ ok: false, reason: "not-edf" });
    expect(importHeaderPatch(buildHeader().subarray(0, 100), true)).toEqual({
      ok: false,
      reason: "not-edf",
    });
  });

  test("a clean header with dates off comes back byte for byte, its dates reported as left", () => {
    const before = buildHeader();
    const patch = importHeaderPatch(before, false);
    if (!patch.ok) throw new Error("expected a header");
    expect(patch.change).toEqual({
      scrub: false,
      dates: false,
      datesLeft: true,
      datesUnproven: false,
    });
    expect(differing(before, patch.header)).toEqual([]);
  });

  test("a clean header with dates on gets 1 January in both places and nothing else", () => {
    const before = buildHeader();
    const patch = importHeaderPatch(before, true);
    if (!patch.ok) throw new Error("expected a header");
    expect(patch.change).toEqual({
      scrub: false,
      dates: true,
      datesLeft: false,
      datesUnproven: false,
    });
    expect(recordingOf(patch.header)).toBe("Startdate 01-JAN-2023 X X X");
    expect(startdateOf(patch.header)).toBe("01.01.23");
  });

  test("identifiers with dates on: the scrub first, then the date rule on the scrubbed header", () => {
    const before = buildHeader(IDENTIFIED);
    const patch = importHeaderPatch(before, true);
    if (!patch.ok) throw new Error("expected a header");
    expect(patch.change).toEqual({
      scrub: true,
      dates: true,
      datesLeft: false,
      datesUnproven: false,
    });
    expect(patientOf(patch.header)).toBe(PATIENT_PLACEHOLDER);
    // The slot date the scrub kept is the one the date rule then set.
    expect(recordingOf(patch.header)).toBe("Startdate 01-JAN-2023 X X X");
    expect(startdateOf(patch.header)).toBe("01.01.23");
    expect(
      differing(before, patch.header).every(
        (i) => (i >= 8 && i < 168) || STARTDATE_BYTES.includes(i),
      ),
    ).toBe(true);
  });

  test("identifiers with dates off: the scrub alone, proven, and the dates left", () => {
    const before = buildHeader(IDENTIFIED);
    const patch = importHeaderPatch(before, false);
    if (!patch.ok) throw new Error("expected a header");
    expect(patch.change).toEqual({
      scrub: true,
      dates: false,
      datesLeft: true,
      datesUnproven: false,
    });
    expect(recordingOf(patch.header)).toBe("Startdate 14-MAR-2023 X X X");
    expect(startdateOf(patch.header)).toBe("14.03.23");
    expect(verifyScrub(before, patch.header)).toEqual({ ok: true, reasons: [] });
  });

  test("a slot date in a layout the rule leaves keeps every date, reported as left, not unproven", () => {
    const before = buildHeader({ recording: "Startdate 14.03.2023 X X X" });
    const patch = importHeaderPatch(before, true);
    if (!patch.ok) throw new Error("expected a header");
    expect(patch.change).toEqual({
      scrub: false,
      dates: false,
      datesLeft: true,
      datesUnproven: false,
    });
    expect(differing(before, patch.header)).toEqual([]);
  });

  test("the result is the header only, and the input is never modified", () => {
    const before = buildHeader(IDENTIFIED, 1024);
    const copy = before.slice();
    const patch = importHeaderPatch(before, true);
    if (!patch.ok) throw new Error("expected a header");
    expect(patch.header.length).toBe(EDF_HEADER_BYTES);
    expect(differing(before, copy)).toEqual([]);
  });
});
