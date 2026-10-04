/**
 * Identifier screening (`shared/identifier-scan.ts`).
 *
 * Headers are built to the EDF/BDF layout byte for byte, and one real EDF from
 * `test/fixtures/bids-minimal` goes through the same entry point, so a parser that
 * only agrees with its own builder cannot pass. Every "flagged" case has a clean twin
 * differing in exactly one field, because a checker that flags everything also passes
 * a flagged-case test.
 *
 * The values in these headers are invented. What the tests protect is that a finding
 * carries a SHAPE and never the value: each flagged case asserts the serialized
 * findings do not contain the injected text.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EDF_HEADER_BYTES,
  countByKind,
  detectEdfFamily,
  formatCoverage,
  scanAcqTime,
  scanEdfHeader,
  scanJsonKeys,
  scanParticipantIds,
  scanPaths,
  scanTableColumns,
  scanTextForLocalPaths,
  shapeOf,
} from "../shared/identifier-scan";

interface HeaderFields {
  family?: "edf" | "bdf";
  patient?: string;
  recording?: string;
  startdate?: string;
  /** BDF files from some vendors pad with NUL rather than spaces. */
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

const kinds = (bytes: Uint8Array) => scanEdfHeader(bytes).map((x) => x.kind);

describe("EDF/BDF header: clean headers", () => {
  test("all placeholders and the clipping date produce no findings", () => {
    expect(scanEdfHeader(buildHeader())).toEqual([]);
  });

  test("an MNE-style study code with X placeholders is clean", () => {
    expect(kinds(buildHeader({ patient: "12 X X X hand=1" }))).toEqual([]);
    expect(kinds(buildHeader({ patient: "S_01 M X X_X weight=71.5 hand=1" }))).toEqual([]);
  });

  test("a birth date reduced to year only is clean; any other day is not", () => {
    expect(kinds(buildHeader({ patient: "S_01 M 01-JAN-1990 X_X" }))).toEqual([]);
    expect(kinds(buildHeader({ patient: "S_01 M 02-JAN-1990 X_X" }))).toEqual([
      "edf-patient-birthdate",
    ]);
    expect(kinds(buildHeader({ patient: "S_01 M 01-FEB-1990 X_X" }))).toEqual([
      "edf-patient-birthdate",
    ]);
  });

  test("a start date on 1 January is year-only and clean; the 2nd is not", () => {
    expect(kinds(buildHeader({ startdate: "01.01.23" }))).toEqual([]);
    expect(kinds(buildHeader({ startdate: "02.01.23" }))).toEqual(["edf-startdate"]);
    expect(kinds(buildHeader({ startdate: "01.02.23" }))).toEqual(["edf-startdate"]);
  });

  test("a subject label in the name position is a code, not a name", () => {
    expect(kinds(buildHeader({ patient: "S_01 F X sub-01" }))).toEqual([]);
  });

  test("a blank patient field is clean", () => {
    expect(kinds(buildHeader({ patient: "" }))).toEqual([]);
  });

  test("month case and year width vary by writer and do not change the verdict", () => {
    expect(kinds(buildHeader({ patient: "S_01 M 01-Jan-1993 X_X" }))).toEqual([]);
    expect(kinds(buildHeader({ patient: "S_01 M 14-Mar-1993 X_X" }))).toEqual([
      "edf-patient-birthdate",
    ]);
  });

  test("descriptive words are not names: sex, handedness, group labels, 'Unknown'", () => {
    expect(kinds(buildHeader({ patient: "Subject 01 Female" }))).toEqual([]);
    expect(kinds(buildHeader({ patient: "sub-01 right handed" }))).toEqual([]);
    expect(kinds(buildHeader({ patient: "S_01 F X Unknown" }))).toEqual([]);
  });

  test("sex and a date with no name: clean when year-only, a birth date otherwise", () => {
    expect(kinds(buildHeader({ patient: "M 01-JAN-1990" }))).toEqual([]);
    expect(kinds(buildHeader({ patient: "M 14-MAR-1990" }))).toEqual(["edf-patient-birthdate"]);
  });
});

describe("EDF/BDF header: identifying headers", () => {
  const alice = "alice";

  test("a name-like code and name are flagged and never quoted", () => {
    const bytes = buildHeader({ patient: `${alice} F 01-JAN-1990 ${alice}` });
    const findings = scanEdfHeader(bytes);
    expect(findings.map((f) => f.kind).sort()).toEqual(["edf-patient-code", "edf-patient-name"]);
    expect(findings.every((f) => f.severity === "identifier")).toBe(true);
    expect(JSON.stringify(findings).toLowerCase()).not.toContain(alice);
  });

  test("the same name with a study code in front flags only the name", () => {
    expect(kinds(buildHeader({ patient: `S_01 F 01-JAN-1990 ${alice}` }))).toEqual([
      "edf-patient-name",
    ]);
  });

  test("a real birth date is flagged and its digits are not quoted", () => {
    const findings = scanEdfHeader(buildHeader({ patient: "S_01 M 14-MAR-1993 X_X" }));
    expect(findings.map((f) => f.kind)).toEqual(["edf-patient-birthdate"]);
    expect(JSON.stringify(findings)).not.toContain("1993");
    expect(JSON.stringify(findings)).not.toContain("MAR");
  });

  test("a real header start date and recording start date are each flagged", () => {
    const bytes = buildHeader({
      startdate: "14.03.23",
      recording: "Startdate 14-MAR-2023 X X X",
    });
    expect(kinds(bytes).sort()).toEqual(["edf-recording-startdate", "edf-startdate"]);
    expect(JSON.stringify(scanEdfHeader(bytes))).not.toContain("2023");
  });

  test("a classic free-text patient field is flagged", () => {
    const findings = scanEdfHeader(buildHeader({ patient: "John Smith" }));
    expect(findings.map((f) => f.kind)).toEqual(["edf-patient-freetext"]);
    expect(JSON.stringify(findings).toLowerCase()).not.toContain("smith");
  });

  test("an operator name in the technician slot is a review finding", () => {
    const findings = scanEdfHeader(buildHeader({ recording: "Startdate X X bob X" }));
    expect(findings).toEqual([
      {
        kind: "edf-recording-technician",
        severity: "review",
        field: "recording.technician",
        shape: "a+",
      },
    ]);
  });

  test("BDF with NUL padding, the form some vendors write, is read the same way", () => {
    const flagged = buildHeader({
      family: "bdf",
      pad: "nul",
      patient: `${alice} F 01-JAN-1990 ${alice}`,
    });
    expect(detectEdfFamily(flagged)).toBe("bdf");
    expect(kinds(flagged).sort()).toEqual(["edf-patient-code", "edf-patient-name"]);
    expect(kinds(buildHeader({ family: "bdf", pad: "nul" }))).toEqual([]);
  });
});

describe("EDF/BDF header: a file that could not be read is never clean", () => {
  test("a truncated header is a review finding, not an empty list", () => {
    const findings = scanEdfHeader(buildHeader().slice(0, 100));
    expect(findings).toEqual([
      { kind: "edf-unreadable", severity: "review", field: "header", shape: "" },
    ]);
  });

  test("a file with another magic is unreadable, not clean", () => {
    const bytes = buildHeader();
    bytes[0] = "A".charCodeAt(0);
    expect(kinds(bytes)).toEqual(["edf-unreadable"]);
  });
});

describe("EDF/BDF header: a real EDF through the same entry point", () => {
  test("the repository's real EDF fixture has no patient or recording identifiers", () => {
    const real = readFileSync(
      join(import.meta.dir, "fixtures/bids-minimal/sub-01/eeg/sub-01_task-rest_eeg.edf"),
    ).subarray(0, EDF_HEADER_BYTES);
    expect(detectEdfFamily(real)).toBe("edf");
    const found = kinds(real);
    expect(found.filter((k) => k !== "edf-startdate" && k !== "edf-recording-startdate")).toEqual(
      [],
    );
  });
});

describe("tables, JSON and paths", () => {
  test("identifier-named columns are flagged; participant_id and age are not", () => {
    expect(scanTableColumns("participant_id\tage\tsex\thand")).toEqual([]);
    const found = scanTableColumns("\uFEFFparticipant_id\tname\tDate_Of_Birth\temail");
    expect(found.map((f) => f.field)).toEqual(["name", "Date_Of_Birth", "email"]);
  });

  test("a populated identifier key is flagged by shape; an empty one is not", () => {
    const doc = {
      PatientName: "carol",
      PatientID: "carol",
      Address: "",
      Nested: { BirthDate: "1990-01-01T00:00:00", DeviceName: "EEG-1" },
      DataFileInformations: [{ ExamDoctor: "" }, { Contact: "555-0100" }],
    };
    const found = scanJsonKeys(doc);
    expect(found.map((f) => f.field).sort()).toEqual([
      "BirthDate",
      "Contact",
      "PatientID",
      "PatientName",
    ]);
    expect(JSON.stringify(found).toLowerCase()).not.toContain("carol");
    expect(scanJsonKeys({ Address: "", Contact: "", DeviceName: "EEG-1" })).toEqual([]);
  });

  test("author, license and tool names in metadata JSON are not participant identifiers", () => {
    const metadata = {
      authors: [{ name: "Dr A", first_name: "A", full_name: "A B", affiliations: [{ name: "U" }] }],
      license: { name: "CC0" },
      GeneratedBy: [{ Name: "moabb" }],
    };
    expect(scanJsonKeys(metadata)).toEqual([]);
  });

  test("ambiguous contact keys are review findings, patient keys are identifiers", () => {
    const found = scanJsonKeys({ Contact: "555-0100", PatientName: "dan" });
    expect(Object.fromEntries(found.map((f) => [f.field, f.severity]))).toEqual({
      Contact: "review",
      PatientName: "identifier",
    });
  });

  test("acq_time: a calendar date is a review finding; year-only and n/a are not", () => {
    expect(scanAcqTime("2023-03-14T10:12:00.000000Z").map((f) => f.kind)).toEqual([
      "acq-time-dated",
    ]);
    expect(scanAcqTime("n/a")).toEqual([]);
    expect(scanAcqTime("1900-01-01T00:00:00")).toEqual([]);
  });

  test("images and documents are flagged unless they follow the BIDS photo suffix", () => {
    const found = scanPaths([
      "sourcedata/sub-01/ses-01/eeg/someone.jpg",
      "sub-01/eeg/sub-01_photo.jpg",
      "sourcedata/consent.pdf",
      "sourcedata/code/.idea/misc.xml",
      "code/__pycache__/x.cpython-37.pyc",
      "sub-01/eeg/sub-01_task-rest_eeg.edf",
      "README.md",
    ]);
    expect(found.map((f) => f.kind).sort()).toEqual([
      "image-or-document-file",
      "image-or-document-file",
      "tooling-debris",
      "tooling-debris",
    ]);
    expect(JSON.stringify(found)).not.toContain("someone");
  });

  test("local user paths are found without being quoted", () => {
    const found = scanTextForLocalPaths('open("C:\\\\Users\\\\dave\\\\data.csv")');
    expect(found.map((f) => f.kind)).toEqual(["local-user-path"]);
    expect(JSON.stringify(found)).not.toContain("dave");
    expect(scanTextForLocalPaths("/Users/erin/work/x.py").length).toBe(1);
    expect(scanTextForLocalPaths("relative/path/x.py")).toEqual([]);
  });
});

describe("coverage and summaries", () => {
  test("recording formats this module cannot read are counted, never silently skipped", () => {
    const cov = formatCoverage([
      "sub-01/eeg/a.edf",
      "sub-01/eeg/b.BDF",
      "sub-02/eeg/c.set",
      "sub-02/eeg/c.fdt",
      "sub-03/meg/d.fif.gz",
      "sub-03/anat/t1.nii.gz",
      "participants.tsv",
    ]);
    expect(cov.screened).toBe(2);
    expect(cov.unscreened).toEqual({ ".set": 1, ".fdt": 1, ".fif.gz": 1, ".nii.gz": 1 });
  });

  test("summaries carry counts, and shapes carry no letters or digits", () => {
    const findings = scanEdfHeader(buildHeader({ patient: "alice F 14-MAR-1993 alice" }));
    expect(countByKind(findings)).toEqual({
      "edf-patient-code": 1,
      "edf-patient-name": 1,
      "edf-patient-birthdate": 1,
    });
    expect(shapeOf("Alice 14-MAR-1993")).toBe("Aa+ 99-A+-9+");
    for (const f of findings) expect(f.shape).toMatch(/^[aA9+\-_ .=]*$/);
  });
});

describe("a finding never carries a value (non-ASCII, ancestors, arrays)", () => {
  const safeShape = /^[aA9 !-/:-@[-`{-~?+]*$/;

  test("shapeOf maps letters of any script to a or A and every other non-ASCII character to ?", () => {
    expect(shapeOf("Jos\u00e9")).toBe("Aa+");
    expect(shapeOf("\u5f20\u4f1f")).toBe("aa");
    expect(shapeOf("\u0418\u0432\u0430\u043d")).toBe("Aa+");
    expect(shapeOf("a\u0301")).toBe("a?");
    expect(shapeOf("\u0001\u007f")).toBe("??");
    expect(shapeOf("")).toBe("");
  });

  test("a CJK or accented value under an identifier key leaves no letter behind", () => {
    const found = scanJsonKeys({ PatientName: "\u5f20\u4f1f", Contact: "Jos\u00e9 Garc\u00eda" });
    expect(found.length).toBe(2);
    for (const f of found) expect(f.shape).toMatch(safeShape);
    expect(JSON.stringify(found)).not.toContain("\u5f20");
    expect(JSON.stringify(found)).not.toContain("Garc");
  });

  test("a path with a non-ASCII image name reports a shape, not the name", () => {
    const found = scanPaths(["sourcedata/\u5f20\u4f1f.jpg"]);
    expect(found.map((f) => f.kind)).toEqual(["image-or-document-file"]);
    expect(JSON.stringify(found)).not.toContain("\u5f20");
  });

  test("only the matched key is reported; an ancestor key that is a name never enters a finding", () => {
    const found = scanJsonKeys({
      janedoe: { PatientName: "x" },
      rows: [{ smithfamily: { dob: "1990" } }],
    });
    expect(found.map((f) => f.field).sort()).toEqual(["PatientName", "dob"]);
    expect(JSON.stringify(found)).not.toContain("janedoe");
    expect(JSON.stringify(found)).not.toContain("smithfamily");
  });

  test("identifier keys holding arrays or objects are flagged; empty containers are not", () => {
    expect(scanJsonKeys({ PatientName: ["dan"] }).map((f) => f.kind)).toEqual([
      "json-identifier-key",
    ]);
    expect(scanJsonKeys({ BirthDate: { y: "1990" } }).map((f) => f.kind)).toEqual([
      "json-identifier-key",
    ]);
    expect(scanJsonKeys({ PatientName: [], BirthDate: {}, Contact: [""] })).toEqual([]);
  });

  test("a non-ASCII byte in the patient field is a finding, whatever it spells", () => {
    const latin1 = buildHeader({ patient: "S_01 F X Jos\u00e9" });
    expect(kinds(latin1)).toContain("edf-patient-nonascii");
    const utf8 = buildHeader();
    utf8.set([0xe5, 0xbc, 0xa0, 0xe4, 0xbc, 0x9f], 8); // a two-character CJK name as UTF-8 bytes
    const found = scanEdfHeader(utf8);
    expect(found.map((f) => f.kind)).toContain("edf-patient-nonascii");
    for (const f of found) expect(f.shape).toMatch(safeShape);
    expect(kinds(buildHeader({ patient: "S_01 F X X" }))).not.toContain("edf-patient-nonascii");
  });

  test("a non-ASCII byte in the recording field is a review finding", () => {
    const bytes = buildHeader();
    bytes.set([0xc3, 0xa9], 100);
    expect(scanEdfHeader(bytes).find((f) => f.kind === "edf-recording-nonascii")?.severity).toBe(
      "review",
    );
  });
});

describe("header rules: names fused to digits, extras, dates, descriptive words", () => {
  test("a name fused to digits is a name; a study code is not", () => {
    expect(kinds(buildHeader({ patient: "alice7 F 01-JAN-1990 X_X" }))).toEqual([
      "edf-patient-code",
    ]);
    expect(kinds(buildHeader({ patient: "S_01 F 01-JAN-1990 john3" }))).toEqual([
      "edf-patient-name",
    ]);
    expect(kinds(buildHeader({ patient: "S01 F 01-JAN-1990 P7" }))).toEqual([]);
  });

  test("a two-letter name is caught, and a neutral hyphenated phrase is not", () => {
    expect(kinds(buildHeader({ patient: "S_01 F X Li" }))).toEqual(["edf-patient-name"]);
    expect(kinds(buildHeader({ patient: "sub-01 right-handed years anonymized" }))).toEqual([]);
    expect(kinds(buildHeader({ patient: "S_01 F X Unnamed" }))).toEqual([]);
    expect(kinds(buildHeader({ patient: "S_01 F X HC" }))).toEqual([]);
  });

  test("additional subfields: key=value metadata is clean, a bare name is not", () => {
    expect(kinds(buildHeader({ patient: "S_01 M X X hand=1 weight=71.5 height=180" }))).toEqual([]);
    expect(kinds(buildHeader({ patient: "S_01 M X X hand=1 Smith" }))).toEqual([
      "edf-patient-freetext",
    ]);
    expect(kinds(buildHeader({ patient: "S_01 M X X 14-MAR-1993" }))).toEqual([
      "edf-patient-birthdate",
    ]);
  });

  test("birth dates in ISO, US, European and compact layouts are judged the same way", () => {
    const flagged = ["1993-03-14", "03/14/1993", "14.03.1993", "19930314", "02/01/1993"];
    for (const date of flagged) {
      expect(kinds(buildHeader({ patient: `S_01 M ${date} X_X` }))).toEqual([
        "edf-patient-birthdate",
      ]);
    }
    const yearOnly = ["1993-01-01", "01/01/1993", "01.01.1993", "19930101"];
    for (const date of yearOnly) {
      expect(kinds(buildHeader({ patient: `S_01 M ${date} X_X` }))).toEqual([]);
    }
  });

  test("a date with an impossible reading is not a date", () => {
    expect(kinds(buildHeader({ patient: "S_01 M 31/31/1993 X_X" }))).toEqual([]);
  });

  test("a three-token field is read as free text, not as a short structured field", () => {
    expect(kinds(buildHeader({ patient: "S_01 M 14-MAR-1993" }))).toEqual([
      "edf-patient-birthdate",
    ]);
    expect(kinds(buildHeader({ patient: "X X 01-JAN-1993" }))).toEqual([]);
  });

  test("a lowercase X in the sex position still makes the field structured", () => {
    expect(kinds(buildHeader({ patient: "alice x X alice" })).sort()).toEqual([
      "edf-patient-code",
      "edf-patient-name",
    ]);
  });

  test("the BDF magic must start with 0xFF; the same bytes with another first byte are unreadable", () => {
    const ok = buildHeader({ family: "bdf" });
    expect(detectEdfFamily(ok)).toBe("bdf");
    const bad = buildHeader({ family: "bdf" });
    bad[0] = 0x41;
    expect(detectEdfFamily(bad)).toBeNull();
    expect(kinds(bad)).toEqual(["edf-unreadable"]);
  });

  test("a patient field filling all 80 bytes is read in full", () => {
    const patient = `S_01 F 01-JAN-1990 ${"n".repeat(80 - "S_01 F 01-JAN-1990 ".length)}`;
    expect(patient.length).toBe(80);
    expect(kinds(buildHeader({ patient }))).toEqual(["edf-patient-name"]);
  });

  test("recording dates: lowercase keyword, bare date, ISO date and year-only are judged correctly", () => {
    expect(kinds(buildHeader({ recording: "startdate 14-MAR-2023 X X X" }))).toEqual([
      "edf-recording-startdate",
    ]);
    expect(kinds(buildHeader({ recording: "2023-03-14 session" }))).toEqual([
      "edf-recording-startdate",
    ]);
    expect(kinds(buildHeader({ recording: "Startdate 01-JAN-2023 X X X" }))).toEqual([]);
    expect(kinds(buildHeader({ recording: "Startdate notadate X X X" }))).toEqual([
      "edf-recording-startdate",
    ]);
  });

  test("an admin code or equipment string that reads as a name is a review finding", () => {
    const found = scanEdfHeader(buildHeader({ recording: "Startdate X Marlowe X X" }));
    expect(found.map((f) => [f.kind, f.severity])).toEqual([["edf-recording-freetext", "review"]]);
  });
});

describe("participant labels and local paths", () => {
  test("a name-like sub- label in a path or a participants table is a review finding", () => {
    expect(scanPaths(["sub-johnny/eeg/x.edf"]).map((f) => f.kind)).toEqual(["path-subject-label"]);
    expect(
      scanPaths(["sub-01/eeg/x.edf", "sub-control/eeg/x.edf", "sub-NDARINV123/x.edf"]),
    ).toEqual([]);
    const table = "participant_id\tage\nsub-johnny\t20\nsub-01\t21\nsub-control\t22\n";
    const found = scanParticipantIds(table);
    expect(found.map((f) => f.kind)).toEqual(["path-subject-label"]);
    expect(JSON.stringify(found)).not.toContain("johnny");
    expect(scanParticipantIds("participant_id\tage\nsub-01\t21\n")).toEqual([]);
  });

  test("a home path inside a URL, and a generic account, are not a local user path", () => {
    expect(scanTextForLocalPaths("see https://example.org/home/page for details")).toEqual([]);
    expect(scanTextForLocalPaths("cd /home/user/project")).toEqual([]);
    expect(scanTextForLocalPaths("C:\\Users\\runner\\work")).toEqual([]);
    expect(scanTextForLocalPaths("cd /home/erin/project").length).toBe(1);
    expect(scanTextForLocalPaths("x = '/Users/dana/data.csv'").length).toBe(1);
  });
});

describe("headers written by an independent EDF+ writer (edfio)", () => {
  const read = (name: string) =>
    new Uint8Array(
      readFileSync(join(import.meta.dir, "fixtures/identifier-scan", name)).subarray(
        0,
        EDF_HEADER_BYTES,
      ),
    );

  test("an EDF+ header with a name, birth date, acquisition date and operator is flagged field by field", () => {
    const found = scanEdfHeader(read("flagged.edf"));
    expect(found.map((f) => f.kind).sort()).toEqual([
      "edf-patient-birthdate",
      "edf-patient-name",
      "edf-recording-startdate",
      "edf-recording-technician",
      "edf-startdate",
    ]);
    expect(JSON.stringify(found).toLowerCase()).not.toContain("fixturename");
    expect(JSON.stringify(found)).not.toContain("Opname");
  });

  test("the clean twin written by the same tool has no findings", () => {
    expect(scanEdfHeader(read("clean.edf"))).toEqual([]);
  });
});
