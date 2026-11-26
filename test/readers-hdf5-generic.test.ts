/**
 * The generic HDF5 reader (`shared/readers/hdf5-generic.ts`, card A4 of the publication-queue
 * plan): the text rules over every string an HDF5 file holds, read through the registry's page
 * cache and limits. `identifier-fields.h5` is written by `scripts/dev/hdf5-oracle.py
 * --snirf-variants` with made-up values (README.md beside it); the other files are A3's.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hdf5Entry } from "../shared/hdf5-meta";
import { bufferSource, cachedSource, readerFor } from "../shared/identifier-readers";
import { DIRECT_KINDS, type Finding } from "../shared/identifier-scan";
import { KIND_COPY } from "../shared/identifier-screen-copy";
import {
  HDF5_GENERIC_READER,
  PERSON_FIELDS,
  isPersonField,
  scanEntryText,
  scanNumericIdentifier,
} from "../shared/readers/hdf5-generic";
import { unscannedReason } from "../shared/readers/hdf5-incomplete";

const DIR = join(import.meta.dir, "fixtures", "hdf5");
const load = (name: string) => new Uint8Array(readFileSync(join(DIR, name)));

async function scan(name: string) {
  const limits = HDF5_GENERIC_READER.limits;
  const src = cachedSource(bufferSource(load(name)), limits);
  return HDF5_GENERIC_READER.scan(src, name, limits);
}

const summary = (findings: Finding[]) =>
  findings.map((f) => `${f.kind}/${f.severity}/${f.field}`).sort();

/** A string attribute entry, as the walker lists one. */
const attr = (name: string, value: string | string[]): Hdf5Entry => ({
  path: "/meta",
  kind: "attribute",
  name,
  dtype: "vlen:string",
  shape: Array.isArray(value) ? [value.length] : [],
  value,
});
const kindsOf = (e: Hdf5Entry) =>
  scanEntryText(e, "hdf5.attribute").map((f) => `${f.kind}/${f.severity}`);

describe("registration", () => {
  test(".h5 and .hdf5 are read by the hdf5 reader; .snirf stays SNIRF's; .nwb and .mat by neither", () => {
    expect(readerFor("sourcedata/run1.h5")?.id).toBe("hdf5");
    expect(readerFor("sub-01/eeg/sub-01_eeg.HDF5")?.id).toBe("hdf5");
    expect(readerFor("a.snirf")?.id).toBe("snirf");
    expect(readerFor("a.nwb")).toBeNull();
    expect(readerFor("a.mat")).toBeNull();
  });

  test("the new kinds have copy, and the direct ones are direct", () => {
    for (const k of ["hdf5-freetext", "hdf5-freetext-name", "hdf5-identifier-field"] as const) {
      expect(KIND_COPY[k].anchor).toBe(`kind-${k}`);
    }
    expect(DIRECT_KINDS.has("hdf5-freetext-name")).toBe(true);
    expect(DIRECT_KINDS.has("hdf5-identifier-field")).toBe(true);
    expect(DIRECT_KINDS.has("hdf5-freetext")).toBe(false);
  });
});

describe("the file rules, through the reader", () => {
  test("identifier-fields.h5: each rule fires where it should, and nowhere else", async () => {
    const result = await scan("identifier-fields.h5");
    expect(result.coverage).toBe("complete");
    // ExperimenterName holds a made-up name (ManufacturerName and AppName are thing-names);
    // SourcePath is a home directory path; DateOfBirth is at day precision, dob at year-month,
    // Email is a contact. BirthDate holds "unknown" and Notes is not a person field: nothing.
    expect(summary(result.findings)).toEqual([
      "hdf5-freetext-name/identifier/hdf5.attribute",
      "hdf5-freetext/review/hdf5.attribute",
      "hdf5-identifier-field/identifier/dateofbirth",
      "hdf5-identifier-field/review/dob",
      "hdf5-identifier-field/review/email",
    ]);
    expect(JSON.stringify(result.findings)).not.toMatch(/Quillfeather|Marlow|qmarlow|example/);
  });

  test("A3's synthetic files: label-like strings fire nothing; shortfalls map to reasons", async () => {
    const dense = await scan("dense-latest.h5");
    expect(dense).toEqual({ findings: [], coverage: "complete" });
    const chunked = await scan("chunked-strings.h5");
    expect(chunked).toEqual({ findings: [], coverage: "partial", incomplete: "external-link" });
    const type = await scan("unsupported-type.h5");
    expect(type).toEqual({ findings: [], coverage: "partial", incomplete: "unsupported-datatype" });
  });

  test("a SNIRF file read as generic HDF5 fires nothing on its labels and units", async () => {
    const result = await scan("homer3-neuro-run02.snirf");
    expect(result).toEqual({ findings: [], coverage: "complete" });
  });

  test("a truncated file is partial, never clean", async () => {
    const bytes = load("identifier-fields.h5");
    const limits = HDF5_GENERIC_READER.limits;
    const src = cachedSource(bufferSource(bytes.subarray(0, 3000)), limits);
    const result = await HDF5_GENERIC_READER.scan(src, "a.h5", limits);
    expect(result.coverage).toBe("partial");
  });
});

describe("person fields", () => {
  test("each person word makes a person field", () => {
    for (const w of PERSON_FIELDS.person) {
      // Alone, except a bare `name` (an object's own name, tested below).
      if (w !== "name") expect(isPersonField(w)).toBe(true);
      expect(isPersonField(`Lead_${w.toUpperCase()}`)).toBe(true);
    }
  });

  test("a thing word suppresses a person word only as its qualifier", () => {
    expect(isPersonField("ManufacturerName")).toBe(false);
    expect(isPersonField("TaskName")).toBe(false);
    expect(isPersonField("PatientProfile")).toBe(true);
    expect(isPersonField("SubjectTask")).toBe(true);
    expect(isPersonField("subject_label")).toBe(true);
    expect(isPersonField("ExperimenterName")).toBe(true);
  });

  test("each thing word unmakes one", () => {
    for (const w of PERSON_FIELDS.thing) expect(isPersonField(`${w}Name`)).toBe(false);
    // A field called just `name` names its own object, in any spelling.
    for (const own of ["name", "Name", "NAME", " name "]) expect(isPersonField(own)).toBe(false);
    expect(PERSON_FIELDS.own).toEqual(["name"]);
    expect(isPersonField("Notes")).toBe(false);
  });

  test("a name-like word counts only in a person field", () => {
    expect(kindsOf(attr("OperatorName", "Quillfeather"))).toEqual([
      "hdf5-freetext-name/identifier",
    ]);
    expect(kindsOf(attr("Notes", "Quillfeather Marlow"))).toEqual([]);
    expect(kindsOf(attr("name", "Quillfeather"))).toEqual([]);
    // Letters fused with digits in a person field are review, not a block (lead ruling).
    expect(kindsOf(attr("SubjectCode", "john3"))).toEqual(["hdf5-freetext/review"]);
    expect(kindsOf(attr("SubjectCode", "john3 Marlow"))).toEqual(["hdf5-freetext-name/identifier"]);
    expect(kindsOf(attr("ManufacturerName", "Quillfeather Instruments"))).toEqual([]);
    expect(kindsOf(attr("CapName", "Quillfeather Cap 128"))).toEqual([]);
    // A placeholder or a code in a person field is not a name.
    expect(kindsOf(attr("SubjectName", "n/a"))).toEqual([]);
    expect(kindsOf(attr("participant", "sub-01"))).toEqual([]);
  });

  test("labels (an object's own name, probe labels) get the local-path rule only", () => {
    expect(kindsOf(attr("name", "Quillfeather"))).toEqual([]);
    expect(kindsOf(attr("sourceLabels", ["Quillfeather", "S1"]))).toEqual([]);
    expect(kindsOf(attr("name", "C:\\Users\\qmarlow\\x"))).toEqual(["hdf5-freetext/review"]);
  });
});

describe("identifier fields", () => {
  test("birth dates: day precision is an identifier, coarser is review, placeholders nothing", () => {
    expect(kindsOf(attr("DateOfBirth", "1971-04-23"))).toEqual([
      "hdf5-identifier-field/identifier",
    ]);
    expect(kindsOf(attr("date_of_birth", "23.04.1971"))).toEqual([
      "hdf5-identifier-field/identifier",
    ]);
    expect(kindsOf(attr("DOB", "1971-04"))).toEqual(["hdf5-identifier-field/review"]);
    expect(kindsOf(attr("BirthDate", "1971"))).toEqual(["hdf5-identifier-field/review"]);
    expect(kindsOf(attr("BirthDate", "1971-01-01"))).toEqual(["hdf5-identifier-field/review"]);
    for (const empty of ["", "0", "unknown", "N/A", "none"]) {
      expect(kindsOf(attr("DateOfBirth", empty))).toEqual([]);
    }
    // Text in a birth field that is not a coarse date cannot be shown to be coarse.
    expect(kindsOf(attr("dob", "born in spring"))).toEqual(["hdf5-identifier-field/identifier"]);
  });

  test("record numbers are identifiers; contacts are review", () => {
    expect(kindsOf(attr("MRN", "12345678"))).toEqual(["hdf5-identifier-field/identifier"]);
    expect(kindsOf(attr("PatientName", "Quillfeather"))).toEqual([
      "hdf5-identifier-field/identifier",
    ]);
    expect(kindsOf(attr("phone", "555 0100"))).toEqual(["hdf5-identifier-field/review"]);
    expect(kindsOf(attr("Address", ["", "1 Main St"]))).toEqual(["hdf5-identifier-field/review"]);
  });
});

describe("unscanned text is never complete (review round 1)", () => {
  test("a string over the size rules makes the file partial (limit); a large signal does not", async () => {
    const unscanned = await scan("unscanned-strings.h5");
    expect(unscanned).toEqual({ findings: [], coverage: "partial", incomplete: "limit" });
    // Twin: identifier-fields.h5 holds a 1,000-element float signal, skipped by size, and is complete.
    expect((await scan("identifier-fields.h5")).coverage).toBe("complete");
  });

  test("an identifier-named value the walker did not return makes the file partial", async () => {
    expect(await scan("skipped-identifier.h5")).toEqual({
      findings: [],
      coverage: "partial",
      incomplete: "limit",
    });
  });

  test("skipped by type: a string or an identifier name is unsupported-datatype; a number is not", () => {
    const entry = (name: string, dtype: string, skipped: "size" | "type"): Hdf5Entry => ({
      path: "/",
      kind: "dataset",
      name,
      dtype,
      shape: [2],
      value: null,
      skipped,
    });
    expect(unscannedReason([entry("notes", "vlen", "type")])).toBeNull();
    expect(unscannedReason([entry("notes", "vlen:string[2]", "type")])).toBe(
      "unsupported-datatype",
    );
    expect(unscannedReason([entry("MRN", "compound", "type")])).toBe("unsupported-datatype");
    expect(unscannedReason([entry("dob", "int64", "size")])).toBe("limit");
    expect(unscannedReason([entry("signal", "float64", "size")])).toBeNull();
    expect(unscannedReason([entry("signal", "compound", "type")])).toBeNull();
  });
});

describe("numeric identifier fields (review round 1)", () => {
  test("an int64 MRN is an identifier; an int dob at day precision too; a year is review", async () => {
    const result = await scan("numeric-identifiers.h5");
    expect(result.coverage).toBe("complete");
    expect(summary(result.findings)).toEqual([
      "hdf5-identifier-field/identifier/dob",
      "hdf5-identifier-field/identifier/mrn",
      "hdf5-identifier-field/review/birthdate",
    ]);
  });

  test("birth-date numbers: only a YYYYMMDD day is an identifier", () => {
    const num = (name: string, value: number[]): Hdf5Entry => ({
      path: "/",
      kind: "dataset",
      name,
      dtype: "int32",
      shape: [],
      value,
    });
    const sev = (name: string, value: number[]) =>
      scanNumericIdentifier(num(name, value), value).map((f) => f.severity);
    expect(sev("dob", [19710423])).toEqual(["identifier"]);
    expect(sev("dob", [19710101])).toEqual(["review"]);
    expect(sev("dob", [197104])).toEqual(["review"]);
    expect(sev("DateOfBirth", [123])).toEqual(["review"]);
    // 0 and -1 are placeholders, like an empty string; any other number is content.
    expect(sev("PatientID", [0])).toEqual([]);
    expect(sev("MRN", [-1])).toEqual([]);
    expect(sev("dob", [0, -1])).toEqual([]);
    expect(sev("PatientID", [0, 7])).toEqual(["identifier"]);
    expect(sev("PatientID", [1])).toEqual(["identifier"]);
    expect(sev("phone", [5550100])).toEqual(["review"]);
    expect(sev("count", [19710423])).toEqual([]);
  });
});
