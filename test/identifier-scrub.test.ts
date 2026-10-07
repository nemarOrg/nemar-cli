/**
 * Header-only scrub (`shared/identifier-scrub.ts`).
 *
 * Every case checks the property that makes the scrub safe to run on published data: the new
 * header differs from the old only inside the two rewritable fields, and what is written there
 * carries no value. Headers are built byte for byte to the EDF layout, a seeded fuzz covers
 * layouts nobody wrote a case for, and a header written by an independent EDF+ tool is scrubbed
 * and then read back by that same tool. All names and dates are invented.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDF_HEADER_BYTES, scanEdfHeader, scanJsonKeys } from "../shared/identifier-scan";
import {
  PATIENT_PLACEHOLDER,
  ScrubRefused,
  applyHeaderPatch,
  blankIdentifierJsonKeys,
  scrubEdfHeader,
  verifyScrub,
} from "../shared/identifier-scrub";
import { toolOrFail } from "./scrub/helpers/require-tools";

interface HeaderFields {
  family?: "edf" | "bdf";
  patient?: string;
  recording?: string;
  startdate?: string;
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
  put(f.recording ?? "Startdate X X X X", 88, 80);
  put(f.startdate ?? "01.01.85", 168, 8);
  return out;
}

const text = (b: Uint8Array, start: number, end: number) =>
  Array.from(b.subarray(start, end), (c) => (c === 0 ? " " : String.fromCharCode(c)))
    .join("")
    .trim();
const patientOf = (b: Uint8Array) => text(b, 8, 88);
const recordingOf = (b: Uint8Array) => text(b, 88, 168);

/** Indices at which two equal-length buffers differ. */
function differing(a: Uint8Array, b: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

describe("scrubbing a header", () => {
  test("a name in the patient field becomes the placeholder and nothing else changes", () => {
    const before = buildHeader({
      patient: "alice F 14-MAR-1993 alice hand=1",
      startdate: "14.03.23",
    });
    const result = scrubEdfHeader(before);
    expect(result.changed).toBe(true);
    expect(result.fields).toEqual(["patient"]);
    expect(patientOf(result.header)).toBe(PATIENT_PLACEHOLDER);
    expect(recordingOf(result.header)).toBe(recordingOf(before));
    const changed = differing(before, result.header);
    expect(Math.min(...changed)).toBeGreaterThanOrEqual(8);
    expect(Math.max(...changed)).toBeLessThan(88);
    expect(verifyScrub(before, result.header)).toEqual({ ok: true, reasons: [] });
    expect(scanEdfHeader(result.header).some((f) => f.kind.startsWith("edf-patient"))).toBe(false);
  });

  test("a header with nothing to remove comes back byte for byte unchanged", () => {
    for (const patient of ["X X X X", "12 X X X hand=1", "S_01 F X X weight=71 height=180", ""]) {
      const before = buildHeader({ patient });
      const result = scrubEdfHeader(before);
      expect(result.changed, patient).toBe(false);
      expect(result.fields).toEqual([]);
      expect(differing(before, result.header)).toEqual([]);
    }
  });

  test("the input is never modified", () => {
    const before = buildHeader({ patient: "alice F X alice" });
    const copy = before.slice();
    scrubEdfHeader(before);
    expect(differing(before, copy)).toEqual([]);
  });

  test("an operator name in the recording field is replaced and the acceptable date is kept", () => {
    const before = buildHeader({
      recording: "Startdate 14-MAR-2023 ADM01 Marlowe EQ1",
      startdate: "14.03.23",
    });
    const result = scrubEdfHeader(before);
    expect(result.fields).toEqual(["recording"]);
    expect(recordingOf(result.header)).toBe("Startdate 14-MAR-2023 X X X");
    expect(patientOf(result.header)).toBe(patientOf(before));
    expect(text(result.header, 168, 176)).toBe("14.03.23");
    expect(verifyScrub(before, result.header).ok).toBe(true);
  });

  test("a free-text recording identification with a name loses the name and keeps no date it cannot parse", () => {
    const result = scrubEdfHeader(buildHeader({ recording: "Hospital recording of Alice Smith" }));
    expect(recordingOf(result.header)).toBe("Startdate X X X X");
    const dated = scrubEdfHeader(buildHeader({ recording: "startdate 14-mar-2023 Marlowe X X" }));
    expect(recordingOf(dated.header)).toBe("Startdate 14-MAR-2023 X X X");
  });

  test("both fields are rewritten when both carry identifiers", () => {
    const result = scrubEdfHeader(
      buildHeader({ patient: "P01 F 14-MAR-1993 alice", recording: "Startdate X X Marlowe X" }),
    );
    expect(result.fields).toEqual(["patient", "recording"]);
  });

  test("BDF with NUL padding, as vendors write it, is scrubbed and keeps its magic", () => {
    const before = buildHeader({ family: "bdf", pad: "nul", patient: "alice F 14-MAR-1993 alice" });
    const result = scrubEdfHeader(before);
    expect(patientOf(result.header)).toBe(PATIENT_PLACEHOLDER);
    expect(result.header[0]).toBe(0xff);
    expect(text(result.header, 1, 8)).toBe("BIOSEMI");
    expect(verifyScrub(before, result.header).ok).toBe(true);
  });

  test("non-ASCII bytes and a full 80-byte field are replaced", () => {
    const nonAscii = buildHeader();
    nonAscii.set([0xe5, 0xbc, 0xa0, 0xe4, 0xbc, 0x9f], 8);
    expect(scrubEdfHeader(nonAscii).fields).toEqual(["patient"]);
    const full = buildHeader({ patient: `S_01 F 01-JAN-1990 ${"n".repeat(80 - 19)}` });
    expect(scrubEdfHeader(full).fields).toEqual(["patient"]);
    const fullResult = scrubEdfHeader(full);
    expect(patientOf(fullResult.header)).toBe(PATIENT_PLACEHOLDER);
    expect(fullResult.header[87]).toBe(0x20);
    expect(verifyScrub(full, fullResult.header).ok).toBe(true);
  });

  test("a birth date and a record number are removed; a year-only date and an age are kept", () => {
    expect(scrubEdfHeader(buildHeader({ patient: "S_01 M 14-MAR-1993 X_X" })).fields).toEqual([
      "patient",
    ]);
    expect(scrubEdfHeader(buildHeader({ patient: "MRN1234567 F X X" })).fields).toEqual([
      "patient",
    ]);
    expect(scrubEdfHeader(buildHeader({ patient: "S_01 M 01-JAN-1993 X_X" })).changed).toBe(false);
    expect(scrubEdfHeader(buildHeader({ patient: "01 M 25 X" })).changed).toBe(false);
  });

  test("scrubbing is idempotent", () => {
    const first = scrubEdfHeader(
      buildHeader({ patient: "alice F 14-MAR-1993 alice", recording: "Startdate X X Marlowe X" }),
    );
    const second = scrubEdfHeader(first.header);
    expect(second.changed).toBe(false);
    expect(differing(first.header, second.header)).toEqual([]);
  });

  test("a file that is not EDF or BDF, or is too short, is refused with a fixed reason", () => {
    const notEdf = buildHeader();
    notEdf[0] = 0x41;
    expect(() => scrubEdfHeader(notEdf)).toThrow(ScrubRefused);
    try {
      scrubEdfHeader(notEdf);
    } catch (e) {
      expect((e as ScrubRefused).reason).toBe("not-edf");
    }
    try {
      scrubEdfHeader(buildHeader().slice(0, 100));
    } catch (e) {
      expect((e as ScrubRefused).reason).toBe("header-too-short");
    }
  });
});

describe("findings the scanner added later", () => {
  test("a birth date found in the recording field is removed and the acceptable start date is kept", () => {
    const before = buildHeader({
      recording: "Startdate 14-MAR-2020 X X X dob=14-MAR-1993",
      startdate: "14.03.20",
    });
    const result = scrubEdfHeader(before);
    expect(result.fields).toEqual(["recording"]);
    expect(recordingOf(result.header)).toBe("Startdate 14-MAR-2020 X X X");
    expect(verifyScrub(before, result.header).ok).toBe(true);
    const free = scrubEdfHeader(buildHeader({ recording: "DOB 14.03.1993" }));
    expect(free.fields).toEqual(["recording"]);
    expect(recordingOf(free.header)).toBe("Startdate X X X X");
  });

  test("an age over 89 is removed from the patient field", () => {
    for (const patient of ["P01 M 95 X", "S1 M X X age=95", "M 95"]) {
      const result = scrubEdfHeader(buildHeader({ patient }));
      expect(result.fields, patient).toEqual(["patient"]);
      expect(patientOf(result.header)).toBe(PATIENT_PLACEHOLDER);
    }
    expect(scrubEdfHeader(buildHeader({ patient: "P01 M 45 X" })).changed).toBe(false);
  });
});

describe("the proof that only the two fields changed", () => {
  const before = buildHeader({ patient: "alice F 14-MAR-1993 alice" });
  const good = scrubEdfHeader(before).header;

  test("accepts the scrub", () => {
    expect(verifyScrub(before, good)).toEqual({ ok: true, reasons: [] });
  });

  test("rejects a change before the patient field", () => {
    const bad = good.slice();
    bad[3] = 0x41;
    expect(verifyScrub(before, bad).reasons).toContain("bytes-before-patient-changed");
  });

  test("rejects a change after the recording field, such as the start date or record count", () => {
    for (const index of [168, 175, 176, 236, 255]) {
      const bad = good.slice();
      bad[index] = bad[index] === 0x41 ? 0x42 : 0x41;
      expect(verifyScrub(before, bad).reasons, String(index)).toContain(
        "bytes-after-recording-changed",
      );
    }
  });

  test("rejects a header that still carries what the scrub should have removed", () => {
    expect(verifyScrub(before, before).reasons).toContain("identifying-content-remains");
    const half = before.slice();
    half.set(new TextEncoder().encode(PATIENT_PLACEHOLDER.padEnd(80)), 8);
    half.set(new TextEncoder().encode("Startdate X X Marlowe X".padEnd(80)), 88);
    expect(verifyScrub(before, half).reasons).toContain("identifying-content-remains");
  });

  test("rejects a changed file family and a short header", () => {
    const bdf = good.slice();
    bdf[0] = 0xff;
    for (let i = 0; i < 7; i++) bdf[1 + i] = "BIOSEMI".charCodeAt(i);
    const verdict = verifyScrub(before, bdf);
    expect(verdict.reasons).toContain("file-family-changed");
    expect(verifyScrub(before, good.slice(0, 10)).reasons).toEqual(["header-too-short"]);
  });

  test("the verdict names reasons and never values", () => {
    const verdict = verifyScrub(before, before);
    expect(JSON.stringify(verdict)).not.toContain("alice");
  });
});

describe("applying a patch to data", () => {
  test("only the first 256 bytes change, the rest is identical, and the input is untouched", () => {
    const data = new Uint8Array(10_000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;
    const before = buildHeader({ patient: "alice F 14-MAR-1993 alice" });
    data.set(before, 0);
    const original = data.slice();
    const patched = applyHeaderPatch(data, scrubEdfHeader(before).header);
    expect(differing(data, original)).toEqual([]);
    expect(patched.length).toBe(data.length);
    expect(differing(patched, original).every((i) => i >= 8 && i < 88)).toBe(true);
    expect(patched.subarray(EDF_HEADER_BYTES)).toEqual(original.subarray(EDF_HEADER_BYTES));
  });

  test("a patch that fails the proof is refused and nothing is written", () => {
    const data = new Uint8Array(1_000);
    data.set(buildHeader({ patient: "alice F 14-MAR-1993 alice" }), 0);
    const tampered = buildHeader({ patient: "X X X X", startdate: "02.02.22" });
    expect(() => applyHeaderPatch(data, tampered)).toThrow("header patch refused");
    expect(() => applyHeaderPatch(data, data.subarray(0, 256))).toThrow("header patch refused");
  });
});

describe("a seeded fuzz over layouts nobody wrote a case for", () => {
  // A small deterministic generator, so a failure reproduces.
  let seed = 20261004;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const words = [
    "alice",
    "Li",
    "Wu",
    "Marlowe",
    "X",
    "x",
    "S_01",
    "12",
    "hand=1",
    "right-handed",
    "Smith^Kim",
    "dob=14.03.1993",
    "14MAR1993",
    "19930314",
    "01-JAN-1990",
    "1234567",
    "MRN7654321",
    "F",
    "M",
    "unknown",
    "Unnamed",
    "émile",
    "Q",
  ];

  test("every scrubbed header verifies, is clean, is idempotent, and is identical outside the fields", () => {
    for (let n = 0; n < 400; n++) {
      const patient = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => pick(words)).join(
        " ",
      );
      const recording = `${pick(["Startdate", "startdate", "Hospital", "X"])} ${Array.from({ length: Math.floor(rand() * 5) }, () => pick(words)).join(" ")}`;
      const before = buildHeader({
        family: rand() < 0.3 ? "bdf" : "edf",
        pad: rand() < 0.3 ? "nul" : "space",
        patient: patient.slice(0, 80),
        recording: recording.slice(0, 80),
        startdate: pick(["01.01.85", "14.03.23", "31.12.99"]),
      });
      const first = scrubEdfHeader(before);
      const label = `case ${n}`;
      expect(verifyScrub(before, first.header), label).toEqual({ ok: true, reasons: [] });
      expect(
        differing(before, first.header).every((i) => i >= 8 && i < 168),
        label,
      ).toBe(true);
      expect(scrubEdfHeader(first.header).changed, label).toBe(false);
      const direct = scanEdfHeader(first.header).filter(
        (f) => f.severity === "identifier" || f.kind === "edf-patient-recordnumber",
      );
      expect(direct, label).toEqual([]);
    }
  });
});

describe("a header written by an independent EDF+ tool", () => {
  const fixture = (name: string) =>
    new Uint8Array(readFileSync(join(import.meta.dir, "fixtures/identifier-scan", name)));

  test("the flagged fixture is scrubbed to a verified, clean header and the clean fixture is untouched", () => {
    const flagged = fixture("flagged.edf");
    const result = scrubEdfHeader(flagged);
    expect(result.changed).toBe(true);
    expect(verifyScrub(flagged.subarray(0, 256), result.header).ok).toBe(true);
    expect(text(result.header, 168, 176)).toBe(text(flagged, 168, 176));
    const clean = fixture("clean.edf");
    expect(scrubEdfHeader(clean).changed).toBe(false);
  });

  // Skipped on a machine without uv, and a FAILURE where NEMAR_REQUIRE_SCRUB_TOOLS=1 (CI).
  const uvAvailable = toolOrFail("uv", spawnSync("uv", ["--version"]).status === 0);
  test.skipIf(!uvAvailable)(
    "the independent tool reads the scrubbed file back with no name and no birth date",
    () => {
      const flagged = fixture("flagged.edf");
      const patched = applyHeaderPatch(flagged, scrubEdfHeader(flagged).header);
      const dir = mkdtempSync(join(tmpdir(), "scrub-"));
      try {
        writeFileSync(join(dir, "scrubbed.edf"), patched);
        const py = [
          "import edfio, sys",
          "from edfio.edf_header import AnonymizedDateError",
          "e = edfio.read_edf(sys.argv[1])",
          "print('name', e.patient.name)",
          "try:",
          "    print('birthdate', e.patient.birthdate)",
          "except AnonymizedDateError:",
          "    print('birthdate anonymized')",
          "print('startdate', e.recording.startdate)",
          "print('signals', len(e.signals))",
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
            join(dir, "scrubbed.edf"),
          ],
          { encoding: "utf8", timeout: 120_000 },
        );
        expect(run.status, run.stderr).toBe(0);
        expect(run.stdout).toContain("name X");
        expect(run.stdout).toContain("birthdate anonymized");
        expect(run.stdout).toContain("startdate 2023-03-14");
        expect(run.stdout.toLowerCase()).not.toContain("fixturename");
        expect(run.stdout).toContain("signals 1");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

// ---------------------------------------------------------------------------------------
// JSON: blankIdentifierJsonKeys (ADR 0089, the rule of ADR 0085's history rewrite)
// ---------------------------------------------------------------------------------------

const utf8 = (s: string) => new TextEncoder().encode(s);
const fromUtf8 = (b: Uint8Array | undefined) => new TextDecoder().decode(b);

describe("blanking identifier-keyed JSON values", () => {
  test("a nested PatientName is blanked and every other byte stays", () => {
    const before = `{\n  "TaskName": "rest",\n  "Acq": {\n    "PatientName" : "alice smith",\n    "SamplingFrequency": 512\n  }\n}\n`;
    const r = blankIdentifierJsonKeys(utf8(before));
    expect(r.status).toBe("blanked");
    expect(r.blanked).toBe(1);
    expect(fromUtf8(r.bytes)).toBe(
      `{\n  "TaskName": "rest",\n  "Acq": {\n    "PatientName" : "",\n    "SamplingFrequency": 512\n  }\n}\n`,
    );
  });

  test("a document with nothing to blank is clean and no bytes are returned", () => {
    const r = blankIdentifierJsonKeys(utf8(`{"TaskName": "rest", "Name": "a study"}`));
    expect(r).toEqual({ status: "clean", blanked: 0 });
  });

  test("text that is not UTF-8 JSON is unreadable, never clean", () => {
    expect(blankIdentifierJsonKeys(utf8(`{"PatientName": "x"`)).status).toBe("unreadable");
    expect(blankIdentifierJsonKeys(new Uint8Array([0x7b, 0xff, 0x7d])).status).toBe("unreadable");
  });

  test("every value type that holds something is blanked, at any depth and inside arrays", () => {
    const before = `[{"MRN": 12345}, {"x": [{"DateOfBirth": ["1990-02-03"]}]}, {"dob": {"y": 1}}]`;
    const r = blankIdentifierJsonKeys(utf8(before));
    expect(r.blanked).toBe(3);
    expect(fromUtf8(r.bytes)).toBe(`[{"MRN": ""}, {"x": [{"DateOfBirth": ""}]}, {"dob": ""}]`);
  });

  test("an identifier key nested inside another is blanked once, with its parent", () => {
    const r = blankIdentifierJsonKeys(utf8(`{"PatientName": {"dob": "1990-02-03"}}`));
    expect(r.blanked).toBe(1);
    expect(fromUtf8(r.bytes)).toBe(`{"PatientName": ""}`);
  });

  test("a value that holds nothing is left as it is", () => {
    expect(blankIdentifierJsonKeys(utf8(`{"dob": null, "PatientName": ""}`)).status).toBe("clean");
  });

  test("a key the scanner reads at review severity (a contact) is a person's call, not blanked", () => {
    expect(blankIdentifierJsonKeys(utf8(`{"email": "a@b.c", "phone": "1"}`)).status).toBe("clean");
  });

  test("both copies of a duplicated key are judged, so the one a parser hides is blanked", () => {
    // JSON.parse keeps the LAST duplicate, which here is empty: a rule that asked the parsed
    // document which keys hold content would see none and leave the first value in the file.
    const r = blankIdentifierJsonKeys(utf8(`{"dob": "1990-02-03", "dob": ""}`));
    expect(r.blanked).toBe(1);
    expect(fromUtf8(r.bytes)).toBe(`{"dob": "", "dob": ""}`);
  });

  test("a key is matched by the scanner's own spelling, an escaped or tabbed key included", () => {
    const r = blankIdentifierJsonKeys(utf8(`{"Patient\\u004eame": "x", "Patient\\tName": "y"}`));
    expect(r.blanked).toBe(2);
    expect(fromUtf8(r.bytes)).toBe(`{"Patient\\u004eame": "", "Patient\\tName": ""}`);
  });

  test("a byte-order mark is kept", () => {
    const body = utf8(`{"PatientID": "p-77"}`);
    const r = blankIdentifierJsonKeys(new Uint8Array([0xef, 0xbb, 0xbf, ...body]));
    expect(r.status).toBe("blanked");
    expect([...(r.bytes ?? new Uint8Array()).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(fromUtf8((r.bytes ?? new Uint8Array()).subarray(3))).toBe(`{"PatientID": ""}`);
  });

  test("a string holding braces, quotes and the key's own name does not confuse the walk", () => {
    const before = `{"note": "PatientName: {\\"x\\"} ]", "PatientName": "z", "after": "dob"}`;
    const r = blankIdentifierJsonKeys(utf8(before));
    expect(r.blanked).toBe(1);
    expect(fromUtf8(r.bytes)).toBe(
      `{"note": "PatientName: {\\"x\\"} ]", "PatientName": "", "after": "dob"}`,
    );
  });

  const uvForParity = toolOrFail("uv", spawnSync("uv", ["--version"]).status === 0);
  test.skipIf(!uvForParity)(
    "gives the same bytes as the history rewrite's blank_json on the documents it was built for",
    () => {
      // ADR 0085's rewrite blanks, in each JSON blob, the keys the git plan lists for its path: the
      // identifier-severity keys `scanJsonKeys` finds in the parsed blob. Same inputs, same bytes.
      const docs = [
        `{\n  "PatientName": "alice smith",\n  "TaskName": "rest"\n}\n`,
        `{"Acq":{"patient_id":"p-1","x":[{"DateOfBirth":"1990-02-03"}]},"MRN":12}`,
        `﻿{"dob" : "1990-02-03" ,"n": 1}`,
        `[{"examDoctor": "z"}, {"ok": true}]`,
        `{"TaskName": "rest"}`,
      ];
      const cases = docs.map((d) => {
        const doc = JSON.parse(d.replace(/^﻿/, ""));
        const targets = [
          ...new Set(
            scanJsonKeys(doc)
              .filter((f) => f.severity === "identifier")
              .map((f) => f.field),
          ),
        ];
        return { content: Buffer.from(d, "utf8").toString("base64"), targets };
      });
      const py = [
        "import base64, json, sys",
        "sys.path.insert(0, sys.argv[1])",
        "from rewrite_history import blank_json",
        "out = []",
        "for c in json.load(sys.stdin):",
        "    new, status = blank_json(base64.b64decode(c['content']), frozenset(c['targets']))",
        "    out.append({'status': status, 'bytes': None if new is None else base64.b64encode(new).decode()})",
        "print(json.dumps(out))",
      ].join("\n");
      const run = spawnSync(
        "uv",
        [
          "run",
          "--quiet",
          "--with",
          "git-filter-repo==2.47.0",
          "python",
          "-c",
          py,
          join(import.meta.dir, "..", "scripts", "scrub", "git"),
        ],
        { encoding: "utf8", input: JSON.stringify(cases), timeout: 120_000 },
      );
      expect(run.status, run.stderr).toBe(0);
      const python = JSON.parse(run.stdout) as { status: string; bytes: string | null }[];
      docs.forEach((d, i) => {
        const ours = blankIdentifierJsonKeys(Buffer.from(d, "utf8"));
        const theirs = python[i] as { status: string; bytes: string | null };
        if (theirs.bytes === null) {
          expect(theirs.status).toBe("already");
          expect(ours.status).toBe("clean");
        } else {
          expect(ours.status).toBe("blanked");
          expect(Buffer.from(ours.bytes ?? new Uint8Array()).toString("base64")).toBe(theirs.bytes);
        }
      });
    },
  );
});
