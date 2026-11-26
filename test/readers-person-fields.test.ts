/**
 * The shared person-field rule (`shared/readers/person-fields.ts`): the qualified-`name` rule and
 * the `description` describing word (lead ruling on card A5). The rest of the rule is tested with
 * the HDF5 reader (`readers-hdf5-generic.test.ts`), which introduced it.
 *
 * CI TIER: unit-pure.
 */

import { describe, expect, test } from "bun:test";
import { PERSON_FIELDS, isLocationField, isPersonField } from "../shared/readers/person-fields";

describe("a qualified name is a thing's", () => {
  test("name after a word that is neither a person nor a describing word names a thing", () => {
    for (const f of [
      "LongName",
      "DepartmentName",
      "InstitutionalDepartmentName",
      "sensorLayoutName",
      "trialName",
      "long_name",
    ]) {
      expect(isPersonField(f), f).toBe(false);
    }
  });

  test("name after a person word stays the person's", () => {
    for (const f of [
      "ExperimenterName",
      "SubjectName",
      "PatientName",
      "ParticipantName",
      "operator_name",
    ]) {
      expect(isPersonField(f), f).toBe(true);
    }
    // A person word elsewhere in the field still makes it a person's.
    expect(isPersonField("SubjectLongName")).toBe(true);
  });

  test("description is a describing word", () => {
    expect(PERSON_FIELDS.describing).toContain("description");
    expect(isPersonField("SubjectArtefactDescription")).toBe(false);
    // The twin without it.
    expect(isPersonField("SubjectArtefact")).toBe(true);
  });
});

describe("location fields", () => {
  test("a last word of path, filepath, file, filename, dir or folder, or an original_ prefix", () => {
    for (const f of [
      "filepath",
      "filename",
      "SDfilepath",
      "chanfile",
      "hdmfile",
      "splinefile",
      "data_dir",
      "datadir",
      "OutputFolder",
      "save_path",
      "original_mff",
    ]) {
      expect(isLocationField(f), f).toBe(true);
    }
  });

  test("other fields are not, words that only end alike included", () => {
    for (const f of [
      "comments",
      "PatientProfile",
      "profile",
      "setname",
      "path_length_m",
      "fileCount",
      "originality",
    ]) {
      expect(isLocationField(f), f).toBe(false);
    }
  });
});
