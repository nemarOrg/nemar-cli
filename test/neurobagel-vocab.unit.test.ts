/**
 * The pinned vocabulary, and every term the transform emits (epic #1586, phase 1).
 *
 * Two independent guards sit on the output:
 *   1. every controlled term in every golden is looked up in the committed
 *      vocabulary files (never in a list this test makes up);
 *   2. every golden validates against the JSON Schemas that Neurobagel's own
 *      pydantic models generate (scripts/neurobagel/bagel_models.py through
 *      scripts/neurobagel/generate-vocab.ts), and a perturbed copy of each fails.
 * The real Neurobagel code over the same goldens runs in
 * neurobagel-oracle.integration.test.ts and scripts/neurobagel/oracle.py.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020";
import { GOLDEN_ROOT, fixtureIds } from "../scripts/neurobagel/fixtures-io";
import {
  MAPPED_DATATYPES,
  VOCAB,
  modalityTermForDatatype,
  sexTerm,
} from "../shared/neurobagel/vocab";
import assessmentTerms from "../shared/neurobagel/vocab/assessment-terms.json";
import dataset from "../shared/neurobagel/vocab/dataset.schema.json";
import diagnosisTerms from "../shared/neurobagel/vocab/diagnosis-terms.json";
import dictionary from "../shared/neurobagel/vocab/dictionary.schema.json";

const built = fixtureIds().filter((id) => id !== "nm099998");
type Json = Record<string, unknown>;
const read = (id: string, name: string): Json =>
  JSON.parse(readFileSync(join(GOLDEN_ROOT, id, name), "utf8")) as Json;
const diagnosisSet = diagnosisTerms as Record<string, string>;
const assessmentSet = assessmentTerms as Record<string, string>;

/** Every `identifier` of a term node and every `TermURL`, found anywhere in a document. */
function termsIn(node: unknown, found: { identifier: string; key: string; kind?: string }[] = []) {
  if (Array.isArray(node)) {
    for (const item of node) termsIn(item, found);
  } else if (node !== null && typeof node === "object") {
    const record = node as Json;
    const kind = record.schemaKey as string | undefined;
    if (
      typeof record.identifier === "string" &&
      kind &&
      ["Sex", "Diagnosis", "Image", "Assessment"].includes(kind)
    ) {
      found.push({ identifier: record.identifier, key: "identifier", kind });
    }
    if (typeof record.TermURL === "string")
      found.push({ identifier: record.TermURL, key: "TermURL" });
    for (const value of Object.values(record)) termsIn(value, found);
  }
  return found;
}

/** The one rule: is this IRI a term the pinned vocabulary declares? */
function pinnedTerm(iri: string): boolean {
  const prefix = iri.slice(0, iri.indexOf(":"));
  if (!(prefix in VOCAB.namespaces)) return false;
  if (Object.values(VOCAB.sex).some((t) => t.identifier === iri)) return true;
  if (Object.values(VOCAB.imaging_modalities).some((t) => t.identifier === iri)) return true;
  if (Object.values(VOCAB.age_formats).some((t) => t.identifier === iri)) return true;
  if (Object.values(VOCAB.variables).some((t) => t.identifier === iri)) return true;
  return iri in diagnosisSet || iri in assessmentSet;
}

describe("the vocabulary snapshot", () => {
  test("is pinned to commits, with a hash for every upstream file it was built from", () => {
    for (const pin of Object.values(VOCAB.pins)) {
      expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(Object.keys(pin.files).length).toBeGreaterThan(0);
      for (const file of Object.values(pin.files)) {
        expect(file.blob_sha).toMatch(/^[0-9a-f]{40}$/);
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(file.bytes).toBeGreaterThan(0);
      }
    }
    expect(VOCAB.pins.bagel.pypi).toBe(`bagel==${VOCAB.bagel_version}`);
    expect(VOCAB.pins.communities.commit).toBe("0cbf82a4777a10e984253dac2b134902963c4095");
  });

  test("the committed term files hold as many terms as the snapshot says", () => {
    expect(Object.keys(diagnosisSet).length).toBe(VOCAB.term_files.diagnosis.terms);
    expect(Object.keys(assessmentSet).length).toBe(VOCAB.term_files.assessment.terms);
    expect(diagnosisSet["ncit:C94342"]).toBe("Healthy Control");
  });

  test("the JSON-LD context is bagel's, with the Neurobagel namespaces", () => {
    expect(VOCAB.context.nb).toBe("http://neurobagel.org/vocab/");
    expect(VOCAB.context.identifier).toBe("@id");
    expect(VOCAB.context.schemaKey).toBe("@type");
    for (const [prefix, url] of Object.entries(VOCAB.namespaces))
      expect(VOCAB.context[prefix]).toBe(url);
  });

  test("only eeg and meg are mapped, and each term agrees with its datatype", () => {
    expect([...MAPPED_DATATYPES]).toEqual(["eeg", "meg"]);
    expect(modalityTermForDatatype("eeg")?.identifier).toBe("nidm:Electroencephalography");
    expect(modalityTermForDatatype("meg")?.identifier).toBe("nidm:Magnetoencephalography");
    for (const datatype of [
      "ieeg",
      "emg",
      "nirs",
      "motion",
      "beh",
      "anat",
      "func",
      "dwi",
      "fmap",
      "perf",
      "pet",
      "T1w",
      "bold",
      "",
    ]) {
      expect(modalityTermForDatatype(datatype)).toBeNull();
    }
    // `pet` is in the pinned vocabulary and is still not mapped: NEMAR is an electrophysiology archive.
    expect(VOCAB.imaging_modalities.pet).toBeDefined();
  });

  test("sex terms are the three Neurobagel sex terms", () => {
    expect(sexTerm("male").identifier).toBe("snomed:248153007");
    expect(sexTerm("female").identifier).toBe("snomed:248152002");
    expect(sexTerm("other").identifier).toBe("snomed:32570681000036106");
    expect(Object.keys(VOCAB.sex).sort()).toEqual(["female", "male", "other"]);
  });
});

describe("every emitted term exists in the pinned vocabulary", () => {
  test("the check itself rejects what is not pinned", () => {
    expect(pinnedTerm("snomed:248153007")).toBe(true);
    expect(pinnedTerm("snomed:1")).toBe(false);
    expect(pinnedTerm("nidm:ElectroMyography")).toBe(false);
    expect(pinnedTerm("bids:eeg")).toBe(false);
    expect(pinnedTerm("ncit:C94343")).toBe(false);
  });

  const emitted = new Set<string>();
  for (const id of built) {
    test(`${id}: every term in the graph and the dictionary is pinned`, () => {
      const terms = [
        ...termsIn(read(id, `${id}.jsonld`)),
        ...termsIn(read(id, `${id}_annotated.json`)),
      ];
      for (const { identifier } of terms) {
        expect(pinnedTerm(identifier)).toBe(true);
        emitted.add(identifier);
      }
    });
  }

  test("across all goldens, exactly the terms the rules can produce appear", () => {
    const allowed = new Set([
      "nb:ParticipantID",
      "nb:Age",
      "nb:Sex",
      "nb:Diagnosis",
      "nb:FromFloat",
      "nb:FromRange",
      "snomed:248153007",
      "snomed:248152002",
      "ncit:C94342",
      "nidm:Electroencephalography",
      "nidm:Magnetoencephalography",
    ]);
    for (const iri of emitted) expect(allowed.has(iri)).toBe(true);
    for (const iri of [
      "nb:ParticipantID",
      "nb:Age",
      "nb:Sex",
      "nb:Diagnosis",
      "nb:FromFloat",
      "nb:FromRange",
      "snomed:248153007",
      "snomed:248152002",
      "ncit:C94342",
      "nidm:Electroencephalography",
      "nidm:Magnetoencephalography",
    ]) {
      expect(emitted.has(iri)).toBe(true);
    }
  });
});

describe("goldens validate against the schemas Neurobagel's own models generate", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  // ajv-formats resolves its own copy of ajv, so the two Ajv types differ although the objects are the same.
  addFormats(ajv as unknown as Parameters<typeof addFormats>[0]);
  const validateDataset = ajv.compile(dataset);
  const validateDictionary = ajv.compile(dictionary);
  const body = (id: string): Json => {
    const { "@context": _c, ...rest } = read(id, `${id}.jsonld`);
    return rest;
  };

  for (const id of built) {
    test(`${id}: the graph is a valid bagel Dataset and the dictionary a valid Neurobagel dictionary`, () => {
      expect(validateDataset(body(id))).toBe(true);
      expect(validateDictionary(read(id, `${id}_annotated.json`))).toBe(true);
    });
  }

  test("the schemas are not vacuous: perturbed copies of a golden fail them", () => {
    const good = body("nm000132");
    expect(validateDataset(good)).toBe(true);
    const clone = (): Json => JSON.parse(JSON.stringify(good)) as Json;

    const extraKey = clone();
    ((extraKey.hasSamples as Json[])[0] as Json).hasEmail = "x@example.org";
    expect(validateDataset(extraKey)).toBe(false);

    const { hasSamples: _samples, ...noSamples } = clone();
    expect(validateDataset(noSamples)).toBe(false);

    const badIdentifier = clone();
    badIdentifier.identifier = "not-a-uuid";
    expect(validateDataset(badIdentifier)).toBe(false);

    const badType = clone();
    badType.hasAccessType = "secret";
    expect(validateDataset(badType)).toBe(false);

    const wrongKey = clone();
    wrongKey.schemaKey = "Subject";
    expect(validateDataset(wrongKey)).toBe(false);

    const dict = read("nm000132", "nm000132_annotated.json");
    const age = dict.age as { Annotations: Json };
    const { VariableType: _type, ...annotations } = age.Annotations;
    expect(validateDictionary({ ...dict, age: { ...age, Annotations: annotations } })).toBe(false);
  });
});
