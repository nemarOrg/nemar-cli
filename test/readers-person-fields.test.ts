/**
 * The shared person-field rule (`shared/readers/person-fields.ts`): the qualified-`name` rule and
 * the `description` describing word (lead ruling on card A5). The rest of the rule is tested with
 * the HDF5 reader (`readers-hdf5-generic.test.ts`), which introduced it.
 *
 * CI TIER: unit-pure.
 */

import { describe, expect, test } from "bun:test";
import { PERSON_FIELDS, isPersonField } from "../shared/readers/person-fields";

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
