/**
 * Curation through the transform's one entry point (epic #1586, phase 5; ADR 0083).
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
const withTable = (
  table: string,
  curation: CurationEntry | null,
  participantsJson: string | null = null,
): NeurobagelInput => ({
  ...loadFixture("nm000132"),
  participantsTsv: table,
  participantsJson,
  curation,
});

/** The committed entry of `id`, through the real loader, pinned to these (edited) documents instead. */
async function repinned(id: string, tsv: string, json: string | null): Promise<CurationEntry> {
  const file = JSON.parse(readFileSync(CURATION_PATH, "utf8")) as {
    datasets: Record<string, Json>;
  };
  const raw = clone(file.datasets[id]);
  raw.pins = {
    participants_json: json === null ? null : await gitBlobSha(json),
    participants_tsv: await gitBlobSha(tsv),
  };
  const entry = parseCuration(JSON.stringify({ datasets: { [id]: raw }, format: 1 })).entries.get(
    id,
  );
  if (entry === undefined) throw new Error("the loader dropped the entry");
  return entry;
}

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

  test("on004166 and on006801: a group column that is an intervention arm is no longer read as healthy control", async () => {
    for (const [id, controls] of [
      ["on004166", 20],
      ["on006801", 7],
    ] as const) {
      const without = await buildNeurobagelArtifacts({ ...loadFixture(id), curation: null });
      const withEntry = await buildNeurobagelArtifacts(loadFixture(id));
      // The mechanical rule reads every `Control` as healthy control.
      expect(without.files[`${id}.jsonld`].match(/ncit:C94342/g)?.length).toBe(controls);
      // The reviewed entry declares every group value missing: no participant has a diagnosis.
      expect(withEntry.files[`${id}.jsonld`]).not.toContain("ncit:C94342");
      expect(
        phenotypes(golden(id, `${id}.jsonld`)).every((s) => s.hasDiagnosis === undefined),
      ).toBe(true);
      const report = golden(id, `${id}.report.json`);
      expect((report.columns as Json).group).toMatchObject({
        status: "curated",
        counts: { mapped: 0 },
      });
      expect((report.curation as Json).participants_with).toMatchObject({ diagnosis: 0 });
      const annotations = (golden(id, `${id}_annotated.json`).group as { Annotations: Json })
        .Annotations;
      expect(annotations.Levels).toEqual({});
    }
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

describe("a curation that does not fit is skipped whole", () => {
  const id = "nm000158";
  const table = fixtureText(id, "participants.tsv");
  const json = fixtureText(id, "participants.json");
  const entry = entries.get(id) as CurationEntry;
  const stroke = {
    "acute stroke patients (1-30 days post-stroke)": {
      Label: "Cerebrovascular accident",
      TermURL: "snomed:230690007",
    },
  };

  /** The artifacts the same input gives with no entry at all. */
  async function mechanical(input: NeurobagelInput) {
    return docs(await buildNeurobagelArtifacts({ ...input, curation: null }));
  }
  /** A report with what curation adds taken away: the mechanical report. */
  const withoutCuration = (report: Json): Json => {
    const { curation: _curation, ...rest } = report;
    return { ...rest, flags: (rest.flags as string[]).filter((f) => !f.startsWith("curation_")) };
  };
  const NOTHING_WITHHELD = { age: 0, diagnosis: 0, sex: 0 };

  test("a participants.tsv that is not the pinned file: stale; the variables it does not name ship as without an entry", async () => {
    const edited = `${table}sub-99\t71\tn/a\tn/a\tn/a\tn/a\tany group at all\thomo sapiens\tn/a\n`;
    const input = { ...loadFixture(id), participantsTsv: edited };
    const got = docs(await buildNeurobagelArtifacts(input));
    const plain = await mechanical(input);
    // nm000158's mechanical group rule maps nothing (no control value), so there is nothing to withhold.
    expect(got.jsonld).toEqual(plain.jsonld);
    expect(got.dictionary).toEqual(plain.dictionary);
    expect(withoutCuration(got.report)).toEqual(plain.report);
    expect(got.report.flags as string[]).toContain("curation_stale");
    expect(got.report.flags as string[]).not.toContain("curation_withheld");
    expect(got.report.curation).toEqual({
      columns_applied: 0,
      columns_skipped: 1,
      declared: { age: 0, assessment: 0, diagnosis: 1, sex: 0 },
      review: "author",
      stale_files: ["participants_tsv"],
      status: "stale",
      withheld: NOTHING_WITHHELD,
    });
    expect(phenotypes(got.jsonld).every((s) => s.hasDiagnosis === undefined)).toBe(true);
  });

  test("a participants.json that is not the pinned file is stale too, and names that file", async () => {
    const input = {
      ...loadFixture(id),
      participantsJson: (json ?? "").replace("Unique", "Unique "),
    };
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
      curation: await entryFor(id, edited, json, { group: diagnosis(stroke) }),
    };
    const built = await buildNeurobagelArtifacts(input);
    const got = docs(built);
    const plain = await mechanical(input);
    expect(got.jsonld).toEqual(plain.jsonld);
    expect(got.dictionary).toEqual(plain.dictionary);
    expect(got.report.flags as string[]).toContain("curation_invalid");
    expect(got.report.curation).toEqual({
      columns_applied: 0,
      columns_skipped: 1,
      declared: { age: 0, assessment: 0, diagnosis: 1, sex: 0 },
      problems: 1,
      review: "author",
      status: "invalid",
      withheld: NOTHING_WITHHELD,
    });
    expect(JSON.stringify(got.report)).not.toContain("an unreviewed group");
    expect(Object.values(built.files).join("")).not.toContain("an unreviewed group");
  });

  test("a table whose ids no longer join the index: unused, the whole output is the mechanical one", async () => {
    const renamed = (table ?? "").replace(/^sub-/gm, "x-");
    const input: NeurobagelInput = {
      ...loadFixture(id),
      participantsTsv: renamed,
      curation: await entryFor(id, renamed, json, { group: diagnosis(stroke) }),
    };
    const got = docs(await buildNeurobagelArtifacts(input));
    const plain = await mechanical(input);
    expect(got.report.flags as string[]).toContain("curation_unused");
    expect(got.report.curation).toMatchObject({
      status: "unused",
      columns_applied: 0,
      columns_skipped: 1,
      withheld: NOTHING_WITHHELD,
    });
    expect(got.jsonld).toEqual(plain.jsonld);
    expect(got.dictionary).toEqual(plain.dictionary);
    expect(phenotypes(got.jsonld).every((s) => s.hasDiagnosis === undefined)).toBe(true);
  });

  test("an invalid MULTI-column entry applies none of its columns: one unseen sex spelling skips the assessment items too", async () => {
    // on006861's entry carries Gender and two UCLA items; the table gains one participant whose
    // Gender the entry never saw, and the entry is pinned to that table.
    const real = "on006861";
    const text = fixtureText(real, "participants.tsv") as string;
    const description = fixtureText(real, "participants.json");
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const header = text.split(eol)[0].split("\t");
    const row = header
      .map((h) => (h === "participant_id" ? "sub-ZZ9" : h === "Gender" ? "Other" : "n/a"))
      .join("\t");
    const edited = `${text}${text.endsWith(eol) ? "" : eol}${row}${eol}`;
    const input: NeurobagelInput = {
      ...loadFixture(real),
      participantsTsv: edited,
      curation: await repinned(real, edited, description),
    };
    const got = docs(await buildNeurobagelArtifacts(input));
    const plain = await mechanical(input);
    expect(got.report.curation).toMatchObject({
      status: "invalid",
      columns_applied: 0,
      columns_skipped: 3,
      declared: { assessment: 2, sex: 1 },
    });
    // Nothing the entry would have added is there: no sex, no assessment, the mechanical output.
    expect(got.jsonld).toEqual(plain.jsonld);
    expect(got.dictionary).toEqual(plain.dictionary);
    expect(phenotypes(got.jsonld).every((s) => s.hasAssessment === undefined)).toBe(true);
    expect(phenotypes(got.jsonld).every((s) => s.hasSex === undefined)).toBe(true);
    expect(withoutCuration(got.report)).toEqual(plain.report);
  });

  describe("an entry that exists to WITHDRAW a mechanical claim fails closed, not open", () => {
    for (const [arm, controls] of [
      ["on004166", 20],
      ["on006801", 7],
    ] as const) {
      const armTable = fixtureText(arm, "participants.tsv") as string;
      const armJson = fixtureText(arm, "participants.json");

      test(`${arm}: stale (one newline appended), the ${controls} false healthy controls stay withdrawn`, async () => {
        const input: NeurobagelInput = { ...loadFixture(arm), participantsTsv: `${armTable}\n` };
        const built = await buildNeurobagelArtifacts(input);
        // Without the entry the mechanical rule claims them; with a STALE entry it must not.
        const plain = await mechanical(input);
        expect(plain.jsonld).toBeDefined();
        const claimed = JSON.stringify(plain.jsonld).match(/ncit:C94342/g)?.length;
        expect(claimed).toBe(controls);
        expect(Object.values(built.files).join("")).not.toContain("ncit:C94342");
        const report = built.report as unknown as Json;
        expect(report.flags as string[]).toEqual(
          expect.arrayContaining(["curation_stale", "curation_withheld"]),
        );
        expect((report.curation as Json).withheld).toEqual({ age: 0, diagnosis: 1, sex: 0 });
        expect((report.columns as Json).group).toMatchObject({
          status: "withheld",
          counts: { mapped: controls },
        });
        expect(JSON.stringify(report)).not.toContain("Control");
      });

      test(`${arm}: invalid (a group value the entry never saw), the false healthy controls stay withdrawn`, async () => {
        const row = (armTable.split(/\r?\n/)[0] ?? "")
          .split("\t")
          .map((h) => (h === "participant_id" ? "sub-ZZ9" : h === "group" ? "Unseen arm" : "n/a"))
          .join("\t");
        const eol = armTable.includes("\r\n") ? "\r\n" : "\n";
        const edited = `${armTable}${armTable.endsWith(eol) ? "" : eol}${row}${eol}`;
        const input: NeurobagelInput = {
          ...loadFixture(arm),
          participantsTsv: edited,
          curation: await repinned(arm, edited, armJson),
        };
        const built = await buildNeurobagelArtifacts(input);
        expect(Object.values(built.files).join("")).not.toContain("ncit:C94342");
        const report = built.report as unknown as Json;
        expect(report.flags as string[]).toEqual(
          expect.arrayContaining(["curation_invalid", "curation_withheld"]),
        );
        expect((report.curation as Json).withheld).toEqual({ age: 0, diagnosis: 1, sex: 0 });
      });
    }

    const ids = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `sub-${String(i + 1).padStart(3, "0")}`);
    const rows = (suffix = ""): string =>
      tsv(
        "participant_id\tage\tsex\tgroup",
        ...ids(3).map(
          (s, i) =>
            `${s}\t${30 + 10 * i}\t${i % 2 ? "F" : "M"}\t${i === 2 ? "patient" : "control"}`,
        ),
      ) + suffix;
    const allThree: Record<string, Json> = {
      age: ageBlock({ Label: "decimal", TermURL: "nb:FromFloat" }, ["", "n/a"]),
      group: diagnosis({ control: HC, patient: ASD }),
      sex: sexBlock({ F: FEMALE, M: MALE }),
    };
    const claims = (jsonld: Json): { age: boolean; sex: boolean; diagnosis: boolean } => ({
      age: phenotypes(jsonld).some((s) => s.hasAge !== undefined),
      diagnosis: phenotypes(jsonld).some((s) => s.hasDiagnosis !== undefined),
      sex: phenotypes(jsonld).some((s) => s.hasSex !== undefined),
    });

    test("SYNTHETIC, three variables named: a stale entry withholds the age, the sex and the group the mechanical rules would map", async () => {
      const good = rows();
      const entry = await entryFor("nm000132", good, null, allThree);
      // The entry applies to the table it pinned...
      const applied = docs(await buildNeurobagelArtifacts(withTable(good, entry)));
      expect(claims(applied.jsonld)).toEqual({ age: true, diagnosis: true, sex: true });
      // ...and mechanical rules alone would say all three too.
      expect(claims((await mechanical(withTable(good, null))).jsonld)).toEqual({
        age: true,
        diagnosis: true,
        sex: true,
      });
      // One byte later the entry is stale and NOTHING is claimed for the three variables.
      const stale = docs(await buildNeurobagelArtifacts(withTable(rows("\n"), entry)));
      expect(claims(stale.jsonld)).toEqual({ age: false, diagnosis: false, sex: false });
      expect(Object.keys(stale.dictionary)).toEqual(["participant_id"]);
      expect(stale.report.curation).toMatchObject({
        status: "stale",
        withheld: { age: 1, diagnosis: 1, sex: 1 },
      });
      expect(stale.report.columns).toMatchObject({
        age: { status: "withheld" },
        group: { status: "withheld" },
        sex: { status: "withheld" },
      });
      expect(stale.report.flags as string[]).toContain("curation_withheld");
    });

    test("SYNTHETIC, three variables named: an invalid entry withholds them too", async () => {
      const edited = `${rows()}sub-004\t50\tM\tunseen group\n`;
      const entry = await entryFor("nm000132", edited, null, allThree);
      const got = docs(await buildNeurobagelArtifacts(withTable(edited, entry)));
      expect(got.report.curation).toMatchObject({
        status: "invalid",
        withheld: { age: 1, diagnosis: 1, sex: 1 },
      });
      expect(claims(got.jsonld)).toEqual({ age: false, diagnosis: false, sex: false });
    });

    test("SYNTHETIC: only the variables the entry names are withheld; the others ship", async () => {
      const entry = await entryFor("nm000132", rows(), null, { sex: allThree.sex });
      const stale = docs(await buildNeurobagelArtifacts(withTable(rows("\n"), entry)));
      expect(stale.report.curation).toMatchObject({
        status: "stale",
        withheld: { age: 0, diagnosis: 0, sex: 1 },
      });
      expect(claims(stale.jsonld)).toEqual({ age: true, diagnosis: true, sex: false });
    });

    test("withholding any one of the three variables raises the flag, so a writer cannot miss it", async () => {
      const age = allThree.age;
      const group = allThree.group;
      const sex = allThree.sex;
      for (const [kind, columns] of [
        ["age", { age }],
        ["diagnosis", { group }],
        ["sex", { sex }],
      ] as const) {
        const entry = await entryFor("nm000132", rows(), null, columns);
        const stale = docs(await buildNeurobagelArtifacts(withTable(rows("\n"), entry)));
        expect(stale.report.flags as string[], kind).toContain("curation_withheld");
        const counts = (stale.report.curation as Json).withheld as Record<string, number>;
        expect(counts[kind], kind).toBe(1);
        expect(
          Object.values(counts).reduce((a, b) => a + b, 0),
          kind,
        ).toBe(1);
      }
    });

    test("a variable the mechanical rule did not map has nothing to withhold, and is not counted", async () => {
      // An entry for a column the mechanical rules do not read: its absence withholds nothing.
      const table = tsv("participant_id\tgender", "sub-001\tF", "sub-002\tM");
      const entry = await entryFor("nm000132", table, null, { gender: allThree.sex });
      const stale = docs(await buildNeurobagelArtifacts(withTable(`${table}\n`, entry)));
      expect(stale.report.curation).toMatchObject({ withheld: { age: 0, diagnosis: 0, sex: 0 } });
      expect(stale.report.flags as string[]).not.toContain("curation_withheld");
    });
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

  test("an entry the loader did not make is refused, whatever terms it carries", async () => {
    const handBuilt = {
      datasetId: id,
      evidence: { source: "x", reviewer: "x", review: "author", date: "2026-10-02" },
      pins: { participantsTsv: await gitBlobSha(table ?? ""), participantsJson: null },
      columns: [
        {
          kind: "diagnosis",
          name: "group",
          levels: new Map([
            [
              "acute stroke patients (1-30 days post-stroke)",
              { identifier: "snomed:NOT-A-TERM", label: "Not a term" },
            ],
          ]),
          missingValues: [],
        },
      ],
    };
    // @ts-expect-error a hand-built entry does not satisfy the opaque CurationEntry type
    const typed: NeurobagelInput = { ...loadFixture(id), curation: handBuilt };
    expect(typed).toBeDefined();
    const forged = { ...loadFixture(id), curation: handBuilt as unknown as CurationEntry };
    await expect(buildNeurobagelArtifacts(forged)).rejects.toMatchObject({
      code: "curation_not_loaded",
    });
    // A copy of a real entry is not the real entry either: only the loader's own object counts.
    const copied = { ...loadFixture(id), curation: { ...entry } as CurationEntry };
    await expect(buildNeurobagelArtifacts(copied)).rejects.toMatchObject({
      code: "curation_not_loaded",
    });
  });

  test("a loaded entry is frozen, so it cannot be edited into something the loader never saw", () => {
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.columns)).toBe(true);
    expect(Object.isFrozen(entry.pins)).toBe(true);
    expect(Object.isFrozen(entry.evidence)).toBe(true);
    expect(() => {
      (entry as { datasetId: string }).datasetId = "nm000999";
    }).toThrow();
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
    expect((dictionary.group as { Annotations: Json }).Annotations.MissingValues).toContain(
      "patient",
    );
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

describe("a curated age gets the checks the mechanical rule gives an age", () => {
  const years = ageBlock({ Label: "decimal", TermURL: "nb:FromFloat" }, ["", "n/a"]);

  test("nm000157's ages are all 0 (a placeholder): a curated FromFloat age cannot turn no age into an age of 0 for 19 participants", async () => {
    const id = "nm000157";
    const table = fixtureText(id, "participants.tsv");
    const json = fixtureText(id, "participants.json");
    const input: NeurobagelInput = {
      ...loadFixture(id),
      curation: await entryFor(id, table, json, { age: years }),
    };
    const built = await buildNeurobagelArtifacts(input);
    const plain = await buildNeurobagelArtifacts({ ...input, curation: null });
    const got = docs(built);
    expect(phenotypes(got.jsonld).every((s) => s.hasAge === undefined)).toBe(true);
    expect(got.jsonld).toEqual(docs(plain).jsonld);
    expect(got.report.curation).toMatchObject({ status: "invalid", problems: 1 });
    expect(got.report.flags as string[]).toEqual(
      expect.arrayContaining(["curation_invalid", "age_column_needs_curation"]),
    );
    // The binder's wording quotes the table; none of it reaches the report.
    expect(JSON.stringify(got.report)).not.toContain("ages are 0");
  });

  test("an age column whose participants.json says months cannot be curated into the graph, and the graph says no age", async () => {
    const table = tsv(
      "participant_id\tage",
      ...Array.from({ length: 4 }, (_, i) => `sub-00${i + 1}\t${6 + i}`),
    );
    const months = JSON.stringify({ age: { Description: "Age", Units: "months" } });
    const input = withTable(
      table,
      await entryFor("nm000132", table, months, { age: years }),
      months,
    );
    const got = docs(await buildNeurobagelArtifacts(input));
    expect(got.report.curation).toMatchObject({ status: "invalid", problems: 1 });
    expect(phenotypes(got.jsonld).every((s) => s.hasAge === undefined)).toBe(true);
    // The mechanical rule says the same: months are left to curation, never read as years.
    expect(got.report.columns).toMatchObject({
      age: { status: "needs_curation", reason: "age_units_not_years" },
    });
    // The same ages in years are an age.
    const inYears = JSON.stringify({ age: { Description: "Age", Units: "years" } });
    const ok = withTable(
      table,
      await entryFor("nm000132", table, inYears, { age: years }),
      inYears,
    );
    const applied = docs(await buildNeurobagelArtifacts(ok));
    expect(applied.report.curation).toMatchObject({ status: "applied" });
    expect(
      phenotypes(applied.jsonld)
        .slice(0, 4)
        .map((s) => s.hasAge),
    ).toEqual([6, 7, 8, 9]);
  });

  test("the zero share is the mechanical rule's: half zeros is a placeholder, fewer is not, and a declared missing 0 does not count", async () => {
    const outcome = async (ages: number[], missing: string[] = ["", "n/a"]): Promise<string> => {
      const table = tsv(
        "participant_id\tage",
        ...ages.map((a, i) => `sub-${String(i + 1).padStart(3, "0")}\t${a}`),
      );
      const entry = await entryFor("nm000132", table, null, {
        age: ageBlock({ Label: "decimal", TermURL: "nb:FromFloat" }, missing),
      });
      const got = docs(await buildNeurobagelArtifacts(withTable(table, entry)));
      return (got.report.curation as Json).status as string;
    };
    expect(await outcome([0, 5])).toBe("invalid"); // exactly half: a placeholder
    expect(await outcome([0, 0, 5, 6])).toBe("invalid"); // exactly half again
    expect(await outcome([0, 5, 6])).toBe("applied"); // a third: newborns recorded in years
    expect(await outcome([0, 0, 0, 5])).toBe("invalid");
    expect(await outcome([0, 0, 0, 5], ["", "n/a", "0"])).toBe("applied"); // 0 is declared not recorded
  });
});
