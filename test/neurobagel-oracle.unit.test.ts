/**
 * The transform agrees with Neurobagel's own CLI, recorded (epic #1586, phase 1).
 *
 * `uv run scripts/neurobagel/oracle.py` runs the pinned real `bagel` over every
 * golden: `bagel pheno` on the fixture's participants.tsv with the golden
 * dictionary and dataset description, and `bagel bids` on a table built from the
 * fixture's bids index.
 * It writes what bagel produced, with identifiers set aside, to
 * test/neurobagel/oracle/<id>.json.
 * This file compares the committed goldens to those recordings, so the check
 * runs everywhere without Python, and it refuses a recording that no longer
 * describes the golden next to it (the recording stores the sha256 of every
 * input it was made from).
 * neurobagel-oracle.integration.test.ts re-runs bagel itself, which is what
 * proves the recordings are truthful.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FIXTURE_ROOT,
  GOLDEN_ROOT,
  NEUROBAGEL_TEST_ROOT,
  fixtureIds,
} from "../scripts/neurobagel/fixtures-io";

type Json = Record<string, unknown>;
interface Recording {
  status: "compared" | "refused" | "skipped";
  reason: string | null;
  bagel: string;
  inputs?: Record<string, string>;
  dataset?: Json;
  subjects?: Record<string, Phenotype>;
  imaging: { modalities: Record<string, string[]> } | null;
  transform_only_subjects?: number;
  bagel_only_subjects?: number;
}
interface Phenotype {
  age: number | null;
  sex: string | null;
  diagnoses: string[];
}
interface Session {
  schemaKey: string;
  hasAge?: number;
  hasSex?: { identifier: string };
  hasDiagnosis?: { identifier: string }[];
  hasAcquisition?: { hasContrastType: { identifier: string } }[];
}
interface Subject {
  hasLabel: string;
  hasSession: Session[];
}

const sha256 = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");
const normalizeLabel = (label: string): string =>
  label.startsWith("sub-") ? label : `sub-${label}`;
const recordingOf = (id: string): Recording =>
  JSON.parse(readFileSync(join(NEUROBAGEL_TEST_ROOT, "oracle", `${id}.json`), "utf8")) as Recording;
const goldenJson = (id: string, name: string): Json =>
  JSON.parse(readFileSync(join(GOLDEN_ROOT, id, name), "utf8")) as Json;

/** The phenotype of every subject's phenotypic session, read from the transform's own JSON-LD. */
function phenotypeView(jsonld: Json): Record<string, Phenotype> {
  const view: Record<string, Phenotype> = {};
  for (const subject of jsonld.hasSamples as Subject[]) {
    const sessions = subject.hasSession.filter((s) => s.schemaKey === "PhenotypicSession");
    expect(sessions.length).toBe(1);
    view[normalizeLabel(subject.hasLabel)] = {
      age: sessions[0].hasAge ?? null,
      sex: sessions[0].hasSex?.identifier ?? null,
      diagnoses: (sessions[0].hasDiagnosis ?? []).map((d) => d.identifier).sort(),
    };
  }
  return view;
}

function modalityView(jsonld: Json): Record<string, string[]> {
  const view: Record<string, string[]> = {};
  for (const subject of jsonld.hasSamples as Subject[]) {
    const found = new Set<string>();
    for (const session of subject.hasSession) {
      if (session.schemaKey !== "ImagingSession") continue;
      for (const a of session.hasAcquisition ?? []) found.add(a.hasContrastType.identifier);
    }
    if (found.size > 0) view[normalizeLabel(subject.hasLabel)] = [...found].sort();
  }
  return view;
}

/** Disagreements between the transform's phenotype and bagel's, as readable strings. */
function phenotypeDisagreements(
  mine: Record<string, Phenotype>,
  oracle: Record<string, Phenotype>,
): string[] {
  const problems: string[] = [];
  for (const [label, expected] of Object.entries(oracle)) {
    const actual = mine[label];
    if (actual === undefined) problems.push(`${label} missing from the transform's graph`);
    else if (
      actual.age !== expected.age ||
      actual.sex !== expected.sex ||
      actual.diagnoses.join() !== expected.diagnoses.join()
    ) {
      problems.push(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
    }
  }
  return problems;
}

/** What bagel pheno saw: the table with a byte order mark dropped and every line ending made LF. */
function bagelInputTable(id: string): string {
  let text = readFileSync(join(FIXTURE_ROOT, id, "participants.tsv"), "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

const built = fixtureIds().filter((id) => id !== "nm099998");

describe("recordings of the real bagel CLI", () => {
  test("every golden has a recording, and the anonymous control has neither", () => {
    for (const id of built)
      expect(existsSync(join(NEUROBAGEL_TEST_ROOT, "oracle", `${id}.json`))).toBe(true);
    expect(existsSync(join(NEUROBAGEL_TEST_ROOT, "oracle", "nm099998.json"))).toBe(false);
  });

  test("the comparison can fail: a changed age, a dropped subject and a changed term are all caught", () => {
    const mine = phenotypeView(goldenJson("nm000132", "nm000132.jsonld"));
    const oracle = recordingOf("nm000132").subjects as Record<string, Phenotype>;
    expect(phenotypeDisagreements(mine, oracle)).toEqual([]);
    const aged = { ...mine, "sub-001": { ...mine["sub-001"], age: 21 } };
    expect(phenotypeDisagreements(aged, oracle).length).toBe(1);
    const { "sub-002": _dropped, ...fewer } = mine;
    expect(phenotypeDisagreements(fewer, oracle)).toEqual([
      "sub-002 missing from the transform's graph",
    ]);
    const otherSex =
      mine["sub-003"].sex === "snomed:248153007" ? "snomed:248152002" : "snomed:248153007";
    const flipped = { ...mine, "sub-003": { ...mine["sub-003"], sex: otherSex } };
    expect(phenotypeDisagreements(flipped, oracle).length).toBe(1);
  });

  for (const id of built) {
    describe(id, () => {
      const recording = recordingOf(id);
      const jsonld = goldenJson(id, `${id}.jsonld`);
      const report = goldenJson(id, `${id}.report.json`);

      test("was recorded with the pinned bagel release", () => {
        expect(recording.bagel).toBe("0.11.6");
      });

      test("is a recording of THESE goldens: every input hash still matches", () => {
        if (recording.inputs === undefined) return;
        expect(recording.inputs["annotated.json"]).toBe(
          sha256(readFileSync(join(GOLDEN_ROOT, id, `${id}_annotated.json`))),
        );
        expect(recording.inputs["dataset_description.json"]).toBe(
          sha256(readFileSync(join(GOLDEN_ROOT, id, `${id}_dataset_description.json`))),
        );
        expect(recording.inputs["participants.tsv"]).toBe(sha256(bagelInputTable(id)));
      });

      if (recording.status === "compared") {
        test("bagel pheno describes the same phenotype for every participant it saw", () => {
          const mine = phenotypeView(jsonld);
          const all = recording.subjects as Record<string, Phenotype>;
          expect(Object.keys(all).length).toBeGreaterThan(0);
          // Subjects bagel makes from table rows that the graph leaves out are checked below.
          const theirs = Object.fromEntries(Object.entries(all).filter(([label]) => label in mine));
          expect(Object.keys(theirs).length).toBeGreaterThan(0);
          expect(phenotypeDisagreements(mine, theirs)).toEqual([]);
        });

        test("subjects only the transform knows (from the bids index) carry no phenotype", () => {
          const mine = phenotypeView(jsonld);
          const theirs = recording.subjects as Record<string, Phenotype>;
          const extra = Object.keys(mine).filter((label) => !(label in theirs));
          expect(extra.length).toBe(recording.transform_only_subjects as number);
          for (const label of extra)
            expect(mine[label]).toEqual({ age: null, sex: null, diagnoses: [] });
        });

        test("the subjects bagel makes from table rows and the graph leaves out are exactly the table-only rows the report counts", () => {
          const mine = phenotypeView(jsonld);
          const theirs = recording.subjects as Record<string, Phenotype>;
          const absent = Object.keys(theirs).filter((label) => !(label in mine));
          expect(absent.length).toBe(recording.bagel_only_subjects as number);
          expect(absent.length).toBe((report.subjects as Json).table_only as number);
        });

        test("the dataset-level fields equal what bagel wrote from the same description", () => {
          for (const [key, value] of Object.entries(recording.dataset as Json)) {
            expect(jsonld[key]).toEqual(value);
          }
        });

        test("bagel bids finds the same imaging modalities for every subject it can attach them to", () => {
          const mine = modalityView(jsonld);
          for (const [label, found] of Object.entries(recording.imaging?.modalities ?? {})) {
            expect(mine[label]).toEqual(found);
          }
        });
      } else if (recording.status === "refused") {
        test("bagel refuses the table for a reason the report already names", () => {
          const flags = report.flags as string[];
          if (recording.reason === "duplicate_ids")
            expect(flags).toContain("duplicate_participant_ids");
          else if (recording.reason === "empty_ids") {
            expect((report.participants_tsv as Json).rows_without_id).toBeGreaterThan(0);
          } else throw new Error(`undocumented bagel refusal: ${recording.reason}`);
        });
      } else {
        test("bagel pheno was not run because the report says there is no usable table", () => {
          const status = (report.participants_tsv as Json).status;
          expect(recording.reason).toBe(`table_${status}`);
          expect(["absent", "ids_do_not_join", "malformed", "no_participant_id"]).toContain(
            status as string,
          );
        });
      }
    });
  }

  test("across the goldens, bagel pheno compared real phenotypes, not just empty tables", () => {
    let withAge = 0;
    let withSex = 0;
    let withControl = 0;
    for (const id of built) {
      const recording = recordingOf(id);
      if (recording.status !== "compared") continue;
      for (const p of Object.values(recording.subjects as Record<string, Phenotype>)) {
        if (p.age !== null) withAge++;
        if (p.sex !== null) withSex++;
        if (p.diagnoses.length > 0) withControl++;
      }
    }
    expect(withAge).toBeGreaterThan(500);
    expect(withSex).toBeGreaterThan(400);
    expect(withControl).toBeGreaterThan(5);
  });
});
