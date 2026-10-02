/**
 * Curation through the transform's one entry point (epic #1586, phase 5; ADR 0084).
 *
 * `buildNeurobagelArtifacts` is driven exactly as the writer will drive it: the documents of a
 * real fixture, plus the entry `parseCuration` returns for the dataset.
 * What a curated dataset must do (apply, only to the graph's participants, in the dictionary and
 * the graph, byte-stable) and what a curation that does not fit must NOT do (change a byte of
 * the mechanical output, leak a cell or a reviewer's words, outlive an anonymity refusal) are
 * both asserted.
 * Tests marked SYNTHETIC build the table by hand over a real fixture's metadata, because no
 * dataset in the catalog exercises the rule; the entry still goes through the real loader.
 * The curated goldens are compared with Neurobagel's own `bagel pheno` by
 * neurobagel-oracle.unit.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CURATION_PATH,
  FIXTURE_ROOT,
  GOLDEN_ROOT,
  fixtureIds,
  loadCuration,
  loadFixture,
} from "../scripts/neurobagel/fixtures-io";
import { parseCuration } from "../shared/neurobagel/curation";
import type { CurationEntry } from "../shared/neurobagel/curation-types";
import { gitBlobSha } from "../shared/neurobagel/git-blob";
import {
  type NeurobagelArtifacts,
  type NeurobagelInput,
  NeurobagelRefusal,
  artifactFileNames,
  buildNeurobagelArtifacts,
} from "../shared/neurobagel/index";

type Json = Record<string, unknown>;
const parse = (text: string): Json => JSON.parse(text) as Json;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const golden = (id: string, name: string): Json =>
  parse(readFileSync(join(GOLDEN_ROOT, id, name), "utf8"));
const fixtureText = (id: string, name: string): string =>
  readFileSync(join(FIXTURE_ROOT, id, name), "utf8");
const entries = loadCuration().entries;
const curatedIds = [...entries.keys()];

interface Session {
  schemaKey: string;
  hasAge?: number;
  hasSex?: { identifier: string };
  hasDiagnosis?: { identifier: string; schemaKey?: string }[];
  hasAssessment?: { identifier: string; schemaKey?: string }[];
}
interface Subject {
  hasLabel: string;
  hasSession: Session[];
}
const phenotypes = (jsonld: Json): Session[] =>
  (jsonld.hasSamples as Subject[]).map((s) => {
    const found = s.hasSession.filter((x) => x.schemaKey === "PhenotypicSession");
    expect(found.length).toBe(1);
    return found[0];
  });
const docs = (a: NeurobagelArtifacts) => {
  const names = artifactFileNames(a.datasetId);
  return {
    jsonld: parse(a.files[names.jsonld]),
    dictionary: parse(a.files[names.dictionary]),
    report: a.report as unknown as Json,
  };
};

const PANAS = { TermURL: "snomed:304755000", Label: "Positive and negative affect schedule" };
const WECHSLER = { TermURL: "snomed:273921009", Label: "Wechsler memory scale" };
const HC = { TermURL: "ncit:C94342", Label: "Healthy Control" };
const MALE = { TermURL: "snomed:248153007", Label: "Male" };
const FEMALE = { TermURL: "snomed:248152002", Label: "Female" };
const ASD = { TermURL: "snomed:35919005", Label: "Autism spectrum disorder" };

const diagnosis = (levels: Record<string, Json>, missing: string[] = []): Json => ({
  IsAbout: { Label: "Diagnosis", TermURL: "nb:Diagnosis" },
  Levels: levels,
  MissingValues: missing,
  VariableType: "Categorical",
});
const sexBlock = (levels: Record<string, Json>, missing: string[] = []): Json => ({
  IsAbout: { Label: "Sex", TermURL: "nb:Sex" },
  Levels: levels,
  MissingValues: missing,
  VariableType: "Categorical",
});
const ageBlock = (format: Json, missing: string[] = []): Json => ({
  Format: format,
  IsAbout: { Label: "Age", TermURL: "nb:Age" },
  MissingValues: missing,
  VariableType: "Continuous",
});
const itemBlock = (tool: Json, missing: string[] = []): Json => ({
  IsAbout: { Label: "Assessment Tool", TermURL: "nb:Assessment" },
  IsPartOf: tool,
  MissingValues: missing,
  VariableType: "Collection",
});

/** An entry for `id`, pinned to the given documents, through the real loader. */
async function entryFor(
  id: string,
  tsv: string,
  json: string | null,
  columns: Record<string, Json>,
): Promise<CurationEntry> {
  const text = JSON.stringify({
    datasets: {
      [id]: {
        columns,
        evidence: {
          date: "2026-10-02",
          review: "author",
          reviewer: "a test",
          source: "a test table",
        },
        pins: {
          participants_json: json === null ? null : await gitBlobSha(json),
          participants_tsv: await gitBlobSha(tsv),
        },
      },
    },
    format: 1,
  });
  const entry = parseCuration(text).entries.get(id);
  if (entry === undefined) throw new Error("the loader dropped the entry");
  return entry;
}

const tsv = (...lines: string[]): string => `${lines.join("\n")}\n`;
/** The real nm000132 subjects (sub-001 to sub-040) with a table the test writes. */
const withTable = (table: string, curation: CurationEntry | null): NeurobagelInput => ({
  ...loadFixture("nm000132"),
  participantsTsv: table,
  participantsJson: null,
  curation,
});

describe("the committed curation, applied to its real fixtures", () => {
  for (const id of curatedIds) {
    test(`${id}: the golden says the entry was applied, in full, with nothing skipped`, () => {
      const report = golden(id, `${id}.report.json`);
      const curation = report.curation as Json;
      expect(curation.status).toBe("applied");
      expect(curation.columns_skipped).toBe(0);
      expect(curation.columns_applied).toBe(entries.get(id)?.columns.length);
      expect(report.flags as string[]).not.toContain("curation_stale");
      expect(report.flags as string[]).not.toContain("curation_invalid");
      expect(curation.review).toBe(entries.get(id)?.evidence.review);
    });
  }

  test("a dataset without an entry has no curation section at all", () => {
    for (const id of fixtureIds().filter((i) => i !== "nm099998" && !curatedIds.includes(i))) {
      expect("curation" in golden(id, `${id}.report.json`)).toBe(false);
    }
  });

  test("nm000158: every participant who has data carries the stroke diagnosis, from the group column", () => {
    const { jsonld, dictionary, report } = docs({
      datasetId: "nm000158",
      files: Object.fromEntries(
        [
          "nm000158.jsonld",
          "nm000158_annotated.json",
          "nm000158_dataset_description.json",
          "nm000158.report.json",
        ].map((n) => [n, readFileSync(join(GOLDEN_ROOT, "nm000158", n), "utf8")]),
      ),
      report: golden("nm000158", "nm000158.report.json") as never,
    });
    const sessions = phenotypes(jsonld);
    expect(sessions.length).toBe(50);
    for (const s of sessions) {
      expect(s.hasDiagnosis).toEqual([{ identifier: "snomed:230690007", schemaKey: "Diagnosis" }]);
    }
    const annotations = (dictionary.group as { Annotations: Json }).Annotations;
    expect((annotations.IsAbout as Json).TermURL).toBe("nb:Diagnosis");
    expect(Object.keys(annotations.Levels as Json)).toEqual([
      "acute stroke patients (1-30 days post-stroke)",
    ]);
    expect((report.columns as Json).group).toMatchObject({ status: "curated" });
    expect((report.curation as Json).participants_with).toEqual({
      age: 0,
      assessment: 0,
      diagnosis: 50,
      sex: 0,
    });
    // The mechanical rules still ship what they can: ages are read as before.
    expect(sessions.every((s) => s.hasAge === 71)).toBe(true);
  });

  test("nm000154: the gender column is the sex column, and the gender flag is gone", () => {
    const jsonld = golden("nm000154", "nm000154.jsonld");
    const sexes = phenotypes(jsonld).map((s) => s.hasSex?.identifier);
    expect(sexes.filter((s) => s === "snomed:248153007").length).toBe(12);
    expect(sexes.filter((s) => s === "snomed:248152002").length).toBe(12);
    const report = golden("nm000154", "nm000154.report.json");
    expect(report.flags as string[]).not.toContain("gender_column_needs_curation");
    expect((report.columns as Json).sex).toMatchObject({ status: "curated" });
    const dictionary = golden("nm000154", "nm000154_annotated.json");
    expect(Object.keys(dictionary).sort()).toEqual(["age", "gender", "participant_id"]);
  });

  test("nm000119: free text meaning able-bodied is healthy control, which no mechanical spelling covers", () => {
    const sessions = phenotypes(golden("nm000119", "nm000119.jsonld"));
    expect(sessions.length).toBe(11);
    for (const s of sessions)
      expect(s.hasDiagnosis?.map((d) => d.identifier)).toEqual(["ncit:C94342"]);
  });

  test("nm000149 and nm000210: the curated diagnosis arrives next to mechanical columns that still ship", () => {
    const sci = phenotypes(golden("nm000149", "nm000149.jsonld"));
    expect(sci.every((s) => s.hasDiagnosis?.[0].identifier === "snomed:90584004")).toBe(true);
    // nm000149's ages are the year 2018: no rule maps them, and curation did not invent one.
    expect(sci.every((s) => s.hasAge === undefined)).toBe(true);
    expect(golden("nm000149", "nm000149.report.json").flags).toContain("age_column_needs_curation");
    const asd = phenotypes(golden("nm000210", "nm000210.jsonld"));
    expect(asd.every((s) => s.hasDiagnosis?.[0].identifier === "snomed:35919005")).toBe(true);
    expect(
      asd.every((s) => s.hasSex?.identifier === "snomed:248153007" && s.hasAge === 22.17),
    ).toBe(true);
  });

  test("no evidence text, reviewer text or entry key reaches any output file", () => {
    for (const id of curatedIds) {
      const entry = entries.get(id) as CurationEntry;
      for (const name of [
        `${id}.jsonld`,
        `${id}_annotated.json`,
        `${id}_dataset_description.json`,
        `${id}.report.json`,
      ]) {
        const text = readFileSync(join(GOLDEN_ROOT, id, name), "utf8");
        expect(text).not.toContain(entry.evidence.source);
        expect(text).not.toContain(entry.evidence.reviewer);
        expect(text).not.toContain(entry.pins.participantsTsv);
      }
    }
  });

  test("the file, read with every object's keys in the opposite order, gives the same bytes", async () => {
    const reverse = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverse);
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Json)
            .reverse()
            .map(([k, v]) => [k, reverse(v)]),
        );
      }
      return value;
    };
    const reordered = parseCuration(
      JSON.stringify(reverse(parse(readFileSync(CURATION_PATH, "utf8")))),
    );
    for (const id of curatedIds) {
      const input = loadFixture(id);
      const first = await buildNeurobagelArtifacts(input);
      const second = await buildNeurobagelArtifacts({
        ...input,
        curation: reordered.entries.get(id),
      });
      expect(second.files).toEqual(first.files);
    }
  });
});

describe("a curation that does not fit changes nothing mechanical", () => {
  const id = "nm000158";
  const table = fixtureText(id, "participants.tsv");
  const json = fixtureText(id, "participants.json");
  const entry = entries.get(id) as CurationEntry;

  /** The three artifacts a node reads, and the report without what curation adds. */
  async function mechanical(input: NeurobagelInput) {
    const a = await buildNeurobagelArtifacts({ ...input, curation: null });
    return docs(a);
  }
  const withoutCuration = (report: Json): Json => {
    const { curation: _curation, ...rest } = report;
    return { ...rest, flags: (rest.flags as string[]).filter((f) => !f.startsWith("curation_")) };
  };

  test("a participants.tsv that is not the pinned file: stale, mechanical output intact, skipped columns counted", async () => {
    const edited = `${table}sub-99\t71\tn/a\tn/a\tn/a\tn/a\tany group at all\thomo sapiens\tn/a\n`;
    const input = { ...loadFixture(id), participantsTsv: edited };
    const built = await buildNeurobagelArtifacts(input);
    const plain = await mechanical(input);
    const got = docs(built);
    expect(got.jsonld).toEqual(plain.jsonld);
    expect(got.dictionary).toEqual(plain.dictionary);
    expect(withoutCuration(got.report)).toEqual(plain.report);
    expect(got.report.flags as string[]).toContain("curation_stale");
    expect(got.report.curation).toEqual({
      columns_applied: 0,
      columns_skipped: 1,
      declared: { age: 0, assessment: 0, diagnosis: 1, sex: 0 },
      participants_with: { age: 0, assessment: 0, diagnosis: 0, sex: 0 },
      problems: 0,
      review: "author",
      stale_files: ["participants_tsv"],
      status: "stale",
    });
    // The curated diagnosis is absent, and nothing else was lost.
    expect(phenotypes(got.jsonld).every((s) => s.hasDiagnosis === undefined)).toBe(true);
  });

  test("a participants.json that is not the pinned file is stale too, and names that file", async () => {
    const input = { ...loadFixture(id), participantsJson: json.replace("Unique", "Unique ") };
    const got = docs(await buildNeurobagelArtifacts(input));
    expect((got.report.curation as Json).stale_files).toEqual(["participants_json"]);
    expect(got.report.flags as string[]).toContain("curation_stale");
  });

  test("a participants.json that has since vanished is stale", async () => {
    const got = docs(
      await buildNeurobagelArtifacts({ ...loadFixture(id), participantsJson: null }),
    );
    expect((got.report.curation as Json).stale_files).toEqual(["participants_json"]);
  });

  test("a table with a value the entry never saw, under pins that match it: invalid, and no cell in the report", async () => {
    const edited = `${table}sub-99\t71\tn/a\tn/a\tn/a\tn/a\tan unreviewed group\thomo sapiens\tn/a\n`;
    const input: NeurobagelInput = {
      ...loadFixture(id),
      participantsTsv: edited,
      curation: await entryFor(id, edited, json, {
        group: diagnosis({
          "acute stroke patients (1-30 days post-stroke)": {
            Label: "Cerebrovascular accident",
            TermURL: "snomed:230690007",
          },
        }),
      }),
    };
    const built = await buildNeurobagelArtifacts(input);
    const got = docs(built);
    const plain = await mechanical(input);
    expect(got.jsonld).toEqual(plain.jsonld);
    expect(got.dictionary).toEqual(plain.dictionary);
    expect(got.report.flags as string[]).toContain("curation_invalid");
    expect(got.report.curation).toMatchObject({
      status: "invalid",
      problems: 1,
      columns_applied: 0,
      columns_skipped: 1,
    });
    expect(JSON.stringify(got.report)).not.toContain("an unreviewed group");
    expect(Object.values(built.files).join("")).not.toContain("an unreviewed group");
  });

  test("a table whose ids no longer join the index: unused, and nothing is attached to the wrong subject", async () => {
    const renamed = table.replace(/^sub-/gm, "x-");
    const input: NeurobagelInput = {
      ...loadFixture(id),
      participantsTsv: renamed,
      curation: await entryFor(id, renamed, json, {
        group: diagnosis({
          "acute stroke patients (1-30 days post-stroke)": {
            Label: "Cerebrovascular accident",
            TermURL: "snomed:230690007",
          },
        }),
      }),
    };
    const got = docs(await buildNeurobagelArtifacts(input));
    expect(got.report.flags as string[]).toContain("curation_unused");
    expect(got.report.curation).toMatchObject({
      status: "unused",
      columns_applied: 0,
      columns_skipped: 1,
    });
    expect(phenotypes(got.jsonld).every((s) => s.hasDiagnosis === undefined)).toBe(true);
  });

  test("an entry for another dataset is refused, and the anonymity refusal still comes first", async () => {
    const other = { ...loadFixture("nm000157"), curation: entry };
    await expect(buildNeurobagelArtifacts(other)).rejects.toMatchObject({
      code: "curation_dataset_mismatch",
    });
    const control = { ...loadFixture("nm099998"), curation: entry };
    await expect(buildNeurobagelArtifacts(control)).rejects.toMatchObject({
      code: "anonymous_not_false",
    });
    const anonymous = {
      ...loadFixture(id),
      metadata: { ...(loadFixture(id).metadata as Json), anonymous: true },
    };
    await expect(buildNeurobagelArtifacts(anonymous)).rejects.toBeInstanceOf(NeurobagelRefusal);
    const missing = {
      ...loadFixture(id),
      metadata: { ...(loadFixture(id).metadata as Json), anonymous: undefined },
    };
    await expect(buildNeurobagelArtifacts(missing)).rejects.toMatchObject({
      code: "anonymous_not_false",
    });
  });
});

describe("curation applies to the participants of the graph only", () => {
  test("rows for participants with no data are covered by the entry, counted as table-only, and never given a diagnosis", async () => {
    const id = "nm000158";
    const table = `${fixtureText(id, "participants.tsv")}sub-91\t71\tn/a\tn/a\tn/a\tn/a\tacute stroke patients (1-30 days post-stroke)\thomo sapiens\tn/a\nsub-92\t71\tn/a\tn/a\tn/a\tn/a\tacute stroke patients (1-30 days post-stroke)\thomo sapiens\tn/a\n`;
    const json = fixtureText(id, "participants.json");
    const input: NeurobagelInput = {
      ...loadFixture(id),
      participantsTsv: table,
      curation: await entryFor(id, table, json, {
        group: diagnosis({
          "acute stroke patients (1-30 days post-stroke)": {
            Label: "Cerebrovascular accident",
            TermURL: "snomed:230690007",
          },
        }),
      }),
    };
    const { jsonld, report } = docs(await buildNeurobagelArtifacts(input));
    expect(report.subjects).toMatchObject({ graph: 50, table_only: 2 });
    expect(phenotypes(jsonld).length).toBe(50);
    expect((report.curation as Json).participants_with).toMatchObject({ diagnosis: 50 });
    const labels = (jsonld.hasSamples as Subject[]).map((s) => s.hasLabel);
    expect(labels).not.toContain("sub-91");
  });
});

describe("SYNTHETIC: what a real entry can say that the committed ones do not", () => {
  const ids = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `sub-${String(i + 1).padStart(3, "0")}`);

  test("a curated sex column replaces the mechanical one, and the other column is not also about sex", async () => {
    // `sex` says M for everyone; `gender` says F. The reviewer says gender is the sex column.
    const table = tsv("participant_id\tsex\tgender", ...ids(4).map((s) => `${s}\tM\tF`));
    const entry = await entryFor("nm000132", table, null, {
      gender: sexBlock({ F: FEMALE, M: MALE }),
    });
    const { jsonld, dictionary, report } = docs(
      await buildNeurobagelArtifacts(withTable(table, entry)),
    );
    const sexes = phenotypes(jsonld).map((s) => s.hasSex?.identifier);
    expect(sexes.slice(0, 4)).toEqual(Array(4).fill("snomed:248152002"));
    expect(Object.keys(dictionary).sort()).toEqual(["gender", "participant_id"]);
    expect((report.columns as Json).sex).toMatchObject({ status: "curated" });
  });

  test("a curated age column replaces the mechanical one: European decimal, with its own missing value", async () => {
    const table = tsv(
      "participant_id\tage\tage_eu",
      "sub-001\t99\t31,5",
      "sub-002\t99\t7",
      "sub-003\t99\tunknown",
    );
    const entry = await entryFor("nm000132", table, null, {
      age_eu: ageBlock({ Label: "European decimal", TermURL: "nb:FromEuro" }, ["unknown"]),
    });
    const { jsonld, dictionary } = docs(await buildNeurobagelArtifacts(withTable(table, entry)));
    const ages = phenotypes(jsonld).map((s) => s.hasAge);
    expect(ages.slice(0, 4)).toEqual([31.5, 7, undefined, undefined]);
    const annotations = (dictionary.age_eu as { Annotations: Json }).Annotations;
    expect(annotations.Format).toEqual({ Label: "European decimal", TermURL: "nb:FromEuro" });
    expect(annotations.ValueRange).toEqual({ Max: 31.5, Min: 7 });
    expect(Object.keys(dictionary)).not.toContain("age");
  });

  test("a placeholder-zero age column is usable once a reviewer declares the zero a missing value", async () => {
    const table = tsv(
      "participant_id\tage",
      "sub-001\t0",
      "sub-002\t0",
      "sub-003\t0",
      "sub-004\t30",
    );
    const plain = docs(await buildNeurobagelArtifacts(withTable(table, null)));
    expect(plain.report.columns).toMatchObject({
      age: { status: "needs_curation", reason: "age_zero_placeholder" },
    });
    expect(plain.report.flags as string[]).toContain("age_column_needs_curation");
    const entry = await entryFor("nm000132", table, null, {
      age: ageBlock({ Label: "decimal", TermURL: "nb:FromFloat" }, ["0"]),
    });
    const { jsonld, report } = docs(await buildNeurobagelArtifacts(withTable(table, entry)));
    expect(
      phenotypes(jsonld)
        .slice(0, 4)
        .map((s) => s.hasAge),
    ).toEqual([undefined, undefined, undefined, 30]);
    expect(report.columns).toMatchObject({ age: { status: "curated" } });
    expect(report.flags as string[]).not.toContain("age_column_needs_curation");
  });

  test("assessments: a tool is on the participant when any of its items is recorded, once, in identifier order", async () => {
    const table = tsv(
      "participant_id\tpanas_a\tpanas_b\twms",
      "sub-001\t3\t\t",
      "sub-002\t\t\t5",
      "sub-003\t\t\t",
      "sub-004\t2\t4\t6",
    );
    const entry = await entryFor("nm000132", table, null, {
      panas_a: itemBlock(PANAS, [""]),
      panas_b: itemBlock(PANAS, [""]),
      wms: itemBlock(WECHSLER, [""]),
    });
    const { jsonld, dictionary, report } = docs(
      await buildNeurobagelArtifacts(withTable(table, entry)),
    );
    const tools = phenotypes(jsonld)
      .slice(0, 4)
      .map((s) => s.hasAssessment?.map((a) => a.identifier));
    expect(tools).toEqual([
      ["snomed:304755000"],
      ["snomed:273921009"],
      undefined,
      ["snomed:273921009", "snomed:304755000"],
    ]);
    expect(dictionary.panas_a).toEqual({
      Annotations: {
        IsAbout: { Label: "Assessment Tool", TermURL: "nb:Assessment" },
        IsPartOf: { Label: PANAS.Label, TermURL: PANAS.TermURL },
        MissingValues: [""],
        VariableType: "Collection",
      },
      Description:
        "Item of an assessment tool; only whether it was recorded is used, as mapped by a reviewed curation entry.",
    });
    expect((report.curation as Json).participants_with).toMatchObject({ assessment: 3 });
    expect((report.curation as Json).declared).toMatchObject({ assessment: 3 });
  });

  test("two diagnosis columns: the mechanical group column and a curated one, with a repeated term said once", async () => {
    const table = tsv(
      "participant_id\tgroup\tdx",
      "sub-001\tcontrol\thealthy",
      "sub-002\tpatient\tASD",
      "sub-003\tcontrol\tASD",
      "sub-004\tpatient\tnone",
    );
    const entry = await entryFor("nm000132", table, null, {
      dx: diagnosis({ ASD, healthy: HC }, ["none"]),
    });
    const { jsonld, dictionary } = docs(await buildNeurobagelArtifacts(withTable(table, entry)));
    const diagnoses = phenotypes(jsonld)
      .slice(0, 4)
      .map((s) => s.hasDiagnosis?.map((d) => d.identifier));
    expect(diagnoses).toEqual([
      ["ncit:C94342"],
      ["snomed:35919005"],
      // Columns are read in name order (`dx` before `group`), so the order is the same every run.
      ["snomed:35919005", "ncit:C94342"],
      undefined,
    ]);
    expect(Object.keys(dictionary).sort()).toEqual(["dx", "group", "participant_id"]);
    // The reviewer's missing values are the dictionary's, and the mechanical column keeps its own.
    expect((dictionary.dx as { Annotations: Json }).Annotations.MissingValues).toEqual(["none"]);
    expect((dictionary.group as { Annotations: Json }).Annotations.MissingValues).toContain("patient");
  });

  test("a curated group column takes over from the mechanical group rule, control spellings included", async () => {
    const table = tsv("participant_id\tgroup", "sub-001\tcontrol", "sub-002\tASD", "sub-003\tn/a");
    // The reviewer maps ASD and says control is not a diagnosis here (declared missing).
    const entry = await entryFor("nm000132", table, null, {
      group: diagnosis({ ASD }, ["control", "n/a"]),
    });
    const { jsonld, report } = docs(await buildNeurobagelArtifacts(withTable(table, entry)));
    const diagnoses = phenotypes(jsonld)
      .slice(0, 3)
      .map((s) => s.hasDiagnosis?.map((d) => d.identifier));
    expect(diagnoses).toEqual([undefined, ["snomed:35919005"], undefined]);
    expect((report.columns as Json).group).toMatchObject({ status: "curated" });
  });

  test("the same input builds the same bytes twice, with an entry", async () => {
    const table = tsv(
      "participant_id\tgender",
      ...ids(5).map((s, i) => `${s}\t${i % 2 ? "F" : "M"}`),
    );
    const entry = await entryFor("nm000132", table, null, {
      gender: sexBlock({ F: FEMALE, M: MALE }),
    });
    const a = await buildNeurobagelArtifacts(withTable(table, entry));
    const again = await entryFor("nm000132", table, null, {
      gender: sexBlock({ F: FEMALE, M: MALE }),
    });
    const b = await buildNeurobagelArtifacts(withTable(table, again));
    expect(b.files).toEqual(a.files);
  });

  test("an entry of a table that has only part of the participants still covers every row it has", async () => {
    const table = tsv("participant_id\tgender", "sub-001\tF", "sub-002\tM", "sub-003\tX");
    const entry = await entryFor("nm000132", table, null, {
      gender: sexBlock({ F: FEMALE, M: MALE }),
    });
    const { report } = docs(await buildNeurobagelArtifacts(withTable(table, entry)));
    // `X` is in no level and no missing list: the entry does not fit the table it pinned.
    expect(report.curation).toMatchObject({ status: "invalid" });
  });
});
