/**
 * The transform's own output validators (epic #1586, phase 1).
 *
 * `buildNeurobagelArtifacts` runs these on everything it returns and throws
 * `output_invalid` on a problem.
 * Almost no input can make the transform write an invalid document (that is the
 * point of the check: it catches a BUG in the transform); the one that can, an
 * empty subject id in the bids index, is tested at the entry point in
 * neurobagel-transform.unit.test.ts.
 * The failure paths of each rule are not reachable that way, so these tests call the
 * validators directly on perturbed copies of a real golden.
 * They are a supplement, not coverage of the transform: the real Neurobagel
 * models validate the same goldens in neurobagel-vocab.unit.test.ts (JSON
 * Schemas generated from them) and oracle.py (the models themselves).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GOLDEN_ROOT } from "../scripts/neurobagel/fixtures-io";
import type { CanonicalJsonValue } from "../shared/neurobagel/canonical-json";
import {
  validateDatasetDescription,
  validateDictionary,
  validateGraphDocument,
} from "../shared/neurobagel/validate-output";

type Json = Record<string, unknown>;
const read = (name: string): Json =>
  JSON.parse(readFileSync(join(GOLDEN_ROOT, "nm000132", name), "utf8")) as Json;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const asValue = (value: unknown): CanonicalJsonValue => value as CanonicalJsonValue;

const graph = read("nm000132.jsonld");
const subjectsOf = (doc: Json): Json[] => doc.hasSamples as Json[];

describe("validateGraphDocument", () => {
  test("accepts a real golden", () => {
    expect(validateGraphDocument(asValue(graph))).toEqual([]);
  });

  const perturbations: [string, (doc: Json) => void][] = [
    [
      "an unknown property on a node",
      (d) => {
        subjectsOf(d)[0].hasEmail = "x@example.org";
      },
    ],
    [
      "a term that is not in the pinned vocabulary",
      (d) => {
        const session = (subjectsOf(d)[0].hasSession as Json[])[0];
        session.hasSex = { identifier: "snomed:1", schemaKey: "Sex" };
      },
    ],
    [
      "an imaging modality NEMAR does not map",
      (d) => {
        const imaging = (subjectsOf(d)[0].hasSession as Json[])[1];
        ((imaging.hasAcquisition as Json[])[0].hasContrastType as Json).identifier =
          "nidm:T1Weighted";
      },
    ],
    [
      "an age outside 0 to 120",
      (d) => {
        ((subjectsOf(d)[0].hasSession as Json[])[0] as Json).hasAge = 130;
      },
    ],
    [
      "a subject with no session",
      (d) => {
        subjectsOf(d)[0].hasSession = [];
      },
    ],
    [
      "an identifier that is not nb: plus a uuid",
      (d) => {
        subjectsOf(d)[0].identifier = "sub-001";
      },
    ],
    [
      "the same identifier on two nodes",
      (d) => {
        subjectsOf(d)[1].identifier = subjectsOf(d)[0].identifier;
      },
    ],
    [
      "two subjects with one label",
      (d) => {
        subjectsOf(d)[1].hasLabel = subjectsOf(d)[0].hasLabel;
      },
    ],
    [
      "an access type other than public",
      (d) => {
        d.hasAccessType = "restricted";
      },
    ],
    [
      "an access email",
      (d) => {
        d.hasAccessEmail = "someone@example.org";
      },
    ],
    [
      "a repository URL that is not http(s)",
      (d) => {
        d.hasRepositoryURL = "ftp://example.org/x";
      },
    ],
    [
      "a dataset without subjects",
      (d) => {
        d.hasSamples = [];
      },
    ],
    [
      "a context that is not the pinned one",
      (d) => {
        (d["@context"] as Json).hasAge = { "@id": "nb:somethingElse" };
      },
    ],
    [
      "a diagnosis term that is not healthy control",
      (d) => {
        const session = (subjectsOf(d)[0].hasSession as Json[])[0];
        session.hasDiagnosis = [{ identifier: "snomed:406506008", schemaKey: "Diagnosis" }];
      },
    ],
  ];
  for (const [label, perturb] of perturbations) {
    test(`rejects ${label}`, () => {
      const doc = clone(graph);
      perturb(doc);
      expect(validateGraphDocument(asValue(doc)).length).toBeGreaterThan(0);
    });
  }
});

describe("validateDictionary", () => {
  const dictionary = read("nm000132_annotated.json");

  test("accepts a real golden", () => {
    expect(validateDictionary(asValue(dictionary))).toEqual([]);
  });

  const perturbations: [string, (d: Json) => void][] = [
    [
      "no participant id column",
      (d) => {
        d.participant_id = undefined;
      },
    ],
    [
      "two age columns",
      (d) => {
        d.age2 = clone(d.age);
      },
    ],
    [
      "a column about an unknown variable",
      (d) => {
        ((d.age as Json).Annotations as Json).IsAbout = { Label: "x", TermURL: "nb:Height" };
      },
    ],
    [
      "an age format that is not pinned",
      (d) => {
        (((d.age as Json).Annotations as Json).Format as Json).TermURL = "nb:FromSomething";
      },
    ],
    [
      "missing values that repeat",
      (d) => {
        ((d.age as Json).Annotations as Json).MissingValues = ["", ""];
      },
    ],
    [
      "a level that is also a missing value",
      (d) => {
        ((d.sex as Json).Annotations as Json).MissingValues = ["", "n/a", "M"];
      },
    ],
    [
      "a BIDS level the annotation does not cover",
      (d) => {
        (d.sex as Json).Levels = { M: "Male", X: "Mystery" };
      },
    ],
    [
      "a sex level mapped to a term outside the sex vocabulary",
      (d) => {
        const levels = ((d.sex as Json).Annotations as Json).Levels as Json;
        (levels.M as Json).TermURL = "ncit:C94342";
      },
    ],
    [
      "a column description that is null",
      (d) => {
        (d.age as Json).Description = null;
      },
    ],
  ];
  for (const [label, perturb] of perturbations) {
    test(`rejects ${label}`, () => {
      const doc = clone(dictionary);
      perturb(doc);
      expect(validateDictionary(asValue(doc)).length).toBeGreaterThan(0);
    });
  }
});

describe("validateDatasetDescription", () => {
  const description = read("nm000132_dataset_description.json");

  test("accepts a real golden", () => {
    expect(validateDatasetDescription(asValue(description))).toEqual([]);
  });

  const perturbations: [string, (d: Json) => void][] = [
    [
      "a blank name",
      (d) => {
        d.Name = "   ";
      },
    ],
    [
      "a participant count of zero",
      (d) => {
        d.ParticipantCount = 0;
      },
    ],
    [
      "an access email",
      (d) => {
        d.AccessEmail = "someone@example.org";
      },
    ],
    [
      "no links",
      (d) => {
        d.ReferencesAndLinks = [];
      },
    ],
  ];
  for (const [label, perturb] of perturbations) {
    test(`rejects ${label}`, () => {
      const doc = clone(description);
      perturb(doc);
      expect(validateDatasetDescription(asValue(doc)).length).toBeGreaterThan(0);
    });
  }
});
