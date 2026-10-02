/**
 * The Neurobagel transform against real data-plane documents (epic #1586, phase 1).
 *
 * Every fixture under test/neurobagel/fixtures/ is a set of documents captured
 * byte for byte from data.nemar.org (the anonymous negative control from
 * data-test.nemar.org), with provenance next to it (see
 * neurobagel-fixtures.unit.test.ts).
 * The transform is driven through its one public entry point,
 * `buildNeurobagelArtifacts`, exactly as the writer will drive it.
 *
 * Goldens (test/neurobagel/golden/) are the committed output for each fixture;
 * regenerate them with `bun run scripts/neurobagel/regenerate-goldens.ts` only
 * when the output should change, and read the diff.
 *
 * Tests marked SYNTHETIC build a document from a real fixture's metadata and a
 * hand-written participants.tsv, because no dataset in the public catalog
 * exercises the rule (real data cannot falsify it, so a synthetic fixture is the
 * only thing standing between a changed rule and silent corruption).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FIXTURE_ROOT,
  GOLDEN_ROOT,
  fixtureIds,
  loadFixture,
} from "../scripts/neurobagel/fixtures-io";
import {
  type NeurobagelArtifacts,
  type NeurobagelInput,
  NeurobagelRefusal,
  artifactFileNames,
  buildNeurobagelArtifacts,
} from "../shared/neurobagel";

const ids = fixtureIds();
const REFUSED = ["nm099998"];
const built = ids.filter((id) => !REFUSED.includes(id));

type Json = Record<string, unknown>;
const parse = (text: string): Json => JSON.parse(text) as Json;
const golden = (id: string, name: string): string =>
  readFileSync(join(GOLDEN_ROOT, id, name), "utf8");
const rawTsv = (id: string): string =>
  readFileSync(join(FIXTURE_ROOT, id, "participants.tsv"), "utf8");

interface Session {
  schemaKey: string;
  hasLabel: string;
  hasAge?: number;
  hasSex?: { identifier: string };
  hasDiagnosis?: { identifier: string }[];
  hasAcquisition?: { hasContrastType: { identifier: string } }[];
}
interface Subject {
  hasLabel: string;
  hasSession: Session[];
}
/** The graph without its `@context`, which names every property whether or not the graph uses it. */
const bodyOf = (id: string): string => {
  const { "@context": _context, ...rest } = parse(golden(id, `${id}.jsonld`));
  return JSON.stringify(rest);
};
const subjectsOf = (id: string): Subject[] =>
  parse(golden(id, `${id}.jsonld`)).hasSamples as Subject[];
const reportOf = (id: string): Json => parse(golden(id, `${id}.report.json`));
const flagsOf = (id: string): string[] => reportOf(id).flags as string[];
const dictionaryOf = (id: string): Json => parse(golden(id, `${id}_annotated.json`));
const phenotypic = (s: Subject): Session => {
  const found = s.hasSession.filter((x) => x.schemaKey === "PhenotypicSession");
  expect(found.length).toBe(1);
  return found[0];
};
const imaging = (s: Subject): Session[] =>
  s.hasSession.filter((x) => x.schemaKey === "ImagingSession");

/** Build a document from a real fixture's metadata and a replacement table. */
function withTable(
  id: string,
  participantsTsv: string | null,
  participantsJson: string | null = null,
): NeurobagelInput {
  return { ...loadFixture(id), participantsTsv, participantsJson };
}

/** The four documents of a build, parsed, for assertions. */
function docs(artifacts: NeurobagelArtifacts) {
  const names = artifactFileNames(artifacts.datasetId);
  return {
    jsonld: parse(artifacts.files[names.jsonld]),
    dictionary: parse(artifacts.files[names.dictionary]),
    description: parse(artifacts.files[names.datasetDescription]),
    report: artifacts.report as unknown as Json,
  };
}

describe("goldens and determinism", () => {
  for (const id of built) {
    test(`${id}: every artifact equals its golden, byte for byte`, async () => {
      const artifacts = await buildNeurobagelArtifacts(loadFixture(id));
      expect(Object.keys(artifacts.files).sort()).toEqual([
        `${id}.jsonld`,
        `${id}.report.json`,
        `${id}_annotated.json`,
        `${id}_dataset_description.json`,
      ]);
      for (const [name, text] of Object.entries(artifacts.files)) {
        expect(existsSync(join(GOLDEN_ROOT, id, name))).toBe(true);
        expect(text).toBe(golden(id, name));
      }
    });

    test(`${id}: building twice gives identical bytes`, async () => {
      const first = await buildNeurobagelArtifacts(loadFixture(id));
      const second = await buildNeurobagelArtifacts(loadFixture(id));
      expect(second.files).toEqual(first.files);
    });
  }

  test("the same documents with every JSON object's keys in another order give the same bytes", async () => {
    const input = loadFixture("nm000132");
    const reorder = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reorder);
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Json)
            .reverse()
            .map(([k, v]) => [k, reorder(v)]),
        );
      }
      return value;
    };
    const shuffled = { ...input, metadata: reorder(input.metadata) };
    expect((await buildNeurobagelArtifacts(shuffled)).files).toEqual(
      (await buildNeurobagelArtifacts(input)).files,
    );
  });

  test("identifiers are unique across every dataset, so two graphs never collide on a node", () => {
    const seen = new Map<string, string>();
    for (const id of built) {
      for (const match of golden(id, `${id}.jsonld`).matchAll(
        /"identifier": "(nb:[0-9a-f-]{36})"/g,
      )) {
        const owner = seen.get(match[1]);
        // A term node never carries an nb: identifier, so any repeat is a collision.
        expect(owner === undefined || owner === id).toBe(true);
        seen.set(match[1], id);
      }
    }
    expect(seen.size).toBeGreaterThan(1000);
  });

  test("a report never contains a participant id or a participant's value", () => {
    for (const id of built) {
      const text = golden(id, `${id}.report.json`);
      expect(text).not.toMatch(/sub-[A-Za-z0-9]/);
      if (existsSync(join(FIXTURE_ROOT, id, "participants.tsv"))) {
        const [, ...rows] = rawTsv(id)
          .trim()
          .split(/\r\n|\n|\r/);
        for (const row of rows.slice(0, 5)) {
          const participant = row.split("\t")[0].replace(/^﻿/, "");
          if (participant.length > 3) expect(text).not.toContain(participant);
        }
      }
    }
  });
});

describe("the anonymity backstop", () => {
  test("the anonymous negative control (nm099998, dev data host) is refused with complete inputs", async () => {
    // The control is the dev-owned standing anonymous deposit; only its public, blinded
    // metadata.json is in this repository (its depositor files are not, see gather.ts).
    // The other two documents are borrowed from a named dataset so the inputs are complete:
    // a refusal that only happens because a file is missing would prove nothing.
    const control = loadFixture("nm099998");
    const borrowed = loadFixture("nm000132");
    expect(control.participantsTsv).toBeNull();
    expect((control.metadata as Json).anonymous).toBe(true);
    const input = {
      ...control,
      participantsTsv: borrowed.participantsTsv,
      participantsJson: borrowed.participantsJson,
    };
    expect(input.participantsTsv).not.toBeNull();
    expect(input.participantsJson).not.toBeNull();
    const error = await buildNeurobagelArtifacts(input).catch((e) => e);
    expect(error).toBeInstanceOf(NeurobagelRefusal);
    expect((error as NeurobagelRefusal).code).toBe("anonymous_not_false");
    expect(existsSync(join(GOLDEN_ROOT, "nm099998"))).toBe(false);
  });

  // `anonymous` must be EXACTLY false. Real metadata, with only that one field changed.
  const variants: [string, unknown][] = [
    ["true", true],
    ["null", null],
    ['the string "false"', "false"],
    ["0", 0],
    ["undefined (the field is missing)", undefined],
  ];
  for (const [label, value] of variants) {
    test(`a real dataset's metadata with anonymous = ${label} is refused`, async () => {
      const input = loadFixture("nm000132");
      const { anonymous: _original, ...withoutField } = input.metadata as Json;
      const metadata = value === undefined ? withoutField : { ...withoutField, anonymous: value };
      const error = await buildNeurobagelArtifacts({ ...input, metadata }).catch((e) => e);
      expect(error).toBeInstanceOf(NeurobagelRefusal);
      expect((error as NeurobagelRefusal).code).toBe("anonymous_not_false");
    });
  }

  test("a document that is not an object is refused for the same reason", async () => {
    for (const metadata of [null, "text", 42, []]) {
      const error = await buildNeurobagelArtifacts({
        expectedDatasetId: "nm000132",
        metadata,
        participantsTsv: null,
        participantsJson: null,
      }).catch((e) => e);
      expect((error as NeurobagelRefusal).code).toBe("anonymous_not_false");
    }
  });

  test("the refusal happens before parsing: a malformed anonymous document is still an anonymity refusal", async () => {
    const error = await buildNeurobagelArtifacts({
      expectedDatasetId: "nm000132",
      metadata: { anonymous: true, dataset_id: 12 },
      participantsTsv: null,
      participantsJson: null,
    }).catch((e) => e);
    expect((error as NeurobagelRefusal).code).toBe("anonymous_not_false");
  });
});

describe("refusals that are not about anonymity", () => {
  test("a metadata document for another dataset than the caller expected", async () => {
    const error = await buildNeurobagelArtifacts({
      ...loadFixture("nm000132"),
      expectedDatasetId: "nm000103",
    }).catch((e) => e);
    expect((error as NeurobagelRefusal).code).toBe("dataset_id_mismatch");
  });

  test("the expected dataset id is required: a caller that leaves it out is refused, not trusted", async () => {
    const { expectedDatasetId: _omitted, ...withoutExpected } = loadFixture("nm000132");
    const error = await buildNeurobagelArtifacts(withoutExpected as NeurobagelInput).catch(
      (e) => e,
    );
    expect((error as NeurobagelRefusal).code).toBe("dataset_id_mismatch");
  });

  test("a metadata document that is not a neuroschema dataset", async () => {
    const metadata = { ...(loadFixture("nm000132").metadata as Json), dataset_id: "not-an-id" };
    const error = await buildNeurobagelArtifacts({
      expectedDatasetId: "nm000132",
      metadata,
      participantsTsv: null,
      participantsJson: null,
    }).catch((e) => e);
    expect((error as NeurobagelRefusal).code).toBe("invalid_metadata");
  });

  test("a document that would make the transform write an invalid graph is refused as output_invalid, never emitted", async () => {
    // The data plane never writes an empty subject id, so this is as near to an internal fault
    // as an input can get: the subject's label would be empty, which Neurobagel's model rejects,
    // and the transform's own validation catches it before anything is returned.
    const input = loadFixture("nm000270");
    const metadata = parse(JSON.stringify(input.metadata));
    const bids = (metadata.extensions as { nemar: { bids_index: { subjects: Json } } }).nemar
      .bids_index;
    bids.subjects[""] = bids.subjects["sub-1"] as Json;
    const error = await buildNeurobagelArtifacts({ ...input, metadata }).catch((e) => e);
    expect(error).toBeInstanceOf(NeurobagelRefusal);
    expect((error as NeurobagelRefusal).code).toBe("output_invalid");
  });

  test("a dataset with no subject in any input has nothing to describe", async () => {
    const input = loadFixture("nm000270");
    const metadata = parse(JSON.stringify(input.metadata));
    (
      metadata.extensions as { nemar: { bids_index: { subjects: Json } } }
    ).nemar.bids_index.subjects = {};
    const error = await buildNeurobagelArtifacts({ ...input, metadata }).catch((e) => e);
    expect((error as NeurobagelRefusal).code).toBe("no_subjects");
  });
});

describe("identity comes only from metadata.json", () => {
  test("a participants.json and a participants.tsv full of identity-looking fields change nothing", async () => {
    const input = loadFixture("nm000132");
    const baseline = await buildNeurobagelArtifacts(input);
    const hostile = await buildNeurobagelArtifacts({
      ...input,
      participantsJson: JSON.stringify({
        Name: "Not the name",
        Authors: ["Someone Else"],
        Keywords: ["injected"],
        DatasetDOI: "10.1234/injected",
        ReferencesAndLinks: ["https://example.invalid/"],
        AccessEmail: "who@example.invalid",
        age: { Name: "also not the name", Description: "Authors: nobody" },
      }),
    });
    expect(hostile.files).toEqual(baseline.files);

    const extraColumns = (input.participantsTsv as string)
      .split("\n")
      .map((line, i) => (line === "" ? line : i === 0 ? `${line}\tname\tauthors` : `${line}\tX\tY`))
      .join("\n");
    const withColumns = await buildNeurobagelArtifacts({ ...input, participantsTsv: extraColumns });
    expect(withColumns.files["nm000132.jsonld"]).toBe(baseline.files["nm000132.jsonld"]);
  });

  test("the dataset description carries exactly what metadata.json says, and never an email", async () => {
    const input = loadFixture("nm000132");
    const description = parse(golden("nm000132", "nm000132_dataset_description.json"));
    const metadata = input.metadata as {
      name: string;
      authors: { name: string }[];
      keywords: { term: string }[];
      external_links: { dataset_doi: string };
    };
    expect(description.Name).toBe(metadata.name);
    expect(description.Authors).toEqual(metadata.authors.map((a) => a.name));
    expect(description.Keywords).toEqual(metadata.keywords.map((k) => k.term));
    expect((description.ReferencesAndLinks as string[])[0]).toBe(
      "https://nemar.org/dataset/nm000132",
    );
    expect((description.ReferencesAndLinks as string[])[1]).toBe(
      `https://doi.org/${metadata.external_links.dataset_doi}`,
    );
    expect(description.RepositoryURL).toBe("https://data.nemar.org/nm000132/");
    expect(description.AccessType).toBe("public");
    expect(Object.keys(description)).not.toContain("AccessEmail");
    for (const id of built) {
      expect(bodyOf(id)).not.toContain("hasAccessEmail");
      expect(golden(id, `${id}_dataset_description.json`)).not.toContain("AccessEmail");
    }
  });

  test("a blank dataset name falls back to the dataset id and says so", async () => {
    const input = loadFixture("nm000132");
    const metadata = { ...(input.metadata as Json), name: "  " };
    const artifacts = await buildNeurobagelArtifacts({ ...input, metadata });
    expect(docs(artifacts).description.Name).toBe("nm000132");
    expect(docs(artifacts).report.flags).toContain("name_fell_back_to_dataset_id");
  });
});

describe("edge classes measured on the live catalog", () => {
  test("nm000132 (clean EEG): every subject has an age, a sex and one EEG acquisition", () => {
    const subjects = subjectsOf("nm000132");
    expect(subjects.length).toBe(40);
    for (const s of subjects) {
      const p = phenotypic(s);
      expect(typeof p.hasAge).toBe("number");
      expect(["snomed:248152002", "snomed:248153007"]).toContain(p.hasSex?.identifier as string);
      expect(imaging(s).length).toBe(1);
      expect(imaging(s)[0].hasAcquisition?.map((a) => a.hasContrastType.identifier)).toEqual([
        "nidm:Electroencephalography",
      ]);
    }
  });

  test("nm000103 (float ages, assessment columns): ages parse as decimals, assessments are left to curation", () => {
    const dictionary = dictionaryOf("nm000103");
    expect(Object.keys(dictionary).sort()).toEqual(["age", "participant_id", "sex"]);
    expect(JSON.stringify(dictionary)).toContain("nb:FromFloat");
    expect(bodyOf("nm000103")).not.toContain("hasAssessment");
    const ages = subjectsOf("nm000103").map((s) => phenotypic(s).hasAge as number);
    expect(ages.every((a) => a >= 0 && a <= 120)).toBe(true);
    expect(ages.some((a) => !Number.isInteger(a))).toBe(true);
    const range = (dictionary.age as { Annotations: { ValueRange: { Min: number; Max: number } } })
      .Annotations.ValueRange;
    expect(range.Min).toBe(Math.min(...ages));
    expect(range.Max).toBe(Math.max(...ages));
  });

  test("nm000104 (EMG, all-n/a placeholders): no phenotype, no modality term, EMG counted, never mapped to EEG", () => {
    const report = reportOf("nm000104");
    expect((report.imaging as Json).datatypes_dropped_subjects).toEqual({ emg: 108 });
    expect((report.imaging as Json).datatypes_mapped_subjects).toEqual({});
    expect((report.graph as Json).acquisitions).toBe(0);
    expect((report.graph as Json).imaging_sessions).toBe(0);
    expect(flagsOf("nm000104")).toEqual(
      expect.arrayContaining(["no_mapped_datatypes", "participants_tsv_placeholder"]),
    );
    const text = bodyOf("nm000104");
    expect(text).not.toContain("Electroencephalography");
    expect(text).not.toContain("hasAge");
    expect(text).not.toContain("hasSex");
    expect(Object.keys(dictionaryOf("nm000104"))).toEqual(["participant_id"]);
    for (const s of subjectsOf("nm000104")) expect(s.hasSession.length).toBe(1);
  });

  test("nm000109 (no participants.json, byte order mark): the table is still read and the mark is reported", () => {
    expect(rawTsv("nm000109").charCodeAt(0)).toBe(0xfeff);
    expect(flagsOf("nm000109")).toEqual(
      expect.arrayContaining([
        "participants_json_absent",
        "bom_stripped",
        "age_units_assumed_years",
      ]),
    );
    expect(Object.keys(dictionaryOf("nm000109"))).toContain("participant_id");
    expect(subjectsOf("nm000109").length).toBe(36);
  });

  test("nm000270 (no participants.tsv): subjects come from the bids index, with imaging and an empty phenotypic session", () => {
    expect(flagsOf("nm000270")).toEqual(
      expect.arrayContaining(["participants_tsv_absent", "participants_json_absent"]),
    );
    const subjects = subjectsOf("nm000270");
    expect(subjects.length).toBe(27);
    for (const s of subjects) {
      const p = phenotypic(s);
      expect(p.hasAge).toBeUndefined();
      expect(p.hasSex).toBeUndefined();
      expect(imaging(s).length).toBe(1);
    }
    expect(Object.keys(dictionaryOf("nm000270"))).toEqual(["participant_id"]);
    expect((reportOf("nm000270").participant_count as Json).declared).toBe(27);
  });

  test("nm000147 (annexed documents): the fixture really was a redirect, and the transform reads it like any other", () => {
    const provenance = parse(
      readFileSync(join(FIXTURE_ROOT, "nm000147", "provenance.json"), "utf8"),
    );
    const docs = provenance.documents as Record<string, { redirected: boolean }>;
    expect(docs["participants.tsv"].redirected).toBe(true);
    expect(docs["participants.json"].redirected).toBe(true);
    expect(docs["metadata.json"].redirected).toBe(false);
    expect(subjectsOf("nm000147").length).toBe(43);
    expect(flagsOf("nm000147")).toContain("session_pairing_unknown");
  });

  test("an iEEG dataset (nm000182, nm000276): no modality term is emitted, the datatype is counted", () => {
    for (const id of ["nm000182", "nm000276"]) {
      expect((reportOf(id).imaging as Json).datatypes_dropped_subjects).toEqual({
        ieeg: (reportOf(id).graph as Json).subjects,
      });
      expect(bodyOf(id)).not.toMatch(/nidm:/);
      expect(flagsOf(id)).toContain("no_mapped_datatypes");
    }
  });

  test("an MEG dataset (nm000229): the MEG term, session labels kept only where the pairing is not in doubt", () => {
    const subjects = subjectsOf("nm000229");
    const labels = new Set<string>();
    for (const s of subjects) {
      for (const session of imaging(s)) {
        labels.add(session.hasLabel);
        expect(session.hasAcquisition?.map((a) => a.hasContrastType.identifier)).toEqual([
          "nidm:Magnetoencephalography",
        ]);
      }
    }
    expect(bodyOf("nm000229")).not.toContain("Electroencephalography");
    // MEG-MASC has two sessions per subject: the index cannot say which holds the MEG, so the
    // datatype goes on one unnamed session instead of being claimed for both.
    const metadata = loadFixture("nm000229").metadata as {
      extensions: { nemar: { bids_index: { subjects: Record<string, { sessions: string[] }> } } };
    };
    const multi = Object.values(metadata.extensions.nemar.bids_index.subjects).filter(
      (s) => s.sessions.length >= 2,
    ).length;
    expect(multi).toBeGreaterThan(0);
    expect(((reportOf("nm000229").imaging as Json).session_pairing_subjects as Json).unknown).toBe(
      multi,
    );
  });

  test("an OpenNeuro mirror (on000117): other datatypes are dropped and counted, MEG is mapped", () => {
    const imagingReport = reportOf("on000117").imaging as Json;
    expect(imagingReport.datatypes_mapped_subjects).toEqual({ meg: 17 });
    expect(Object.keys(imagingReport.datatypes_dropped_subjects as Json).sort()).toEqual([
      "anat",
      "beh",
      "dwi",
      "fmap",
      "func",
    ]);
    expect(
      parse(golden("on000117", "on000117_dataset_description.json")).ReferencesAndLinks,
    ).toEqual(["https://nemar.org/dataset/on000117", "https://doi.org/10.82901/nemar.on000117"]);
  });

  test("nm000118 (group column): healthy maps to the healthy control term as a diagnosis", () => {
    const subjects = subjectsOf("nm000118");
    const [, ...rows] = rawTsv("nm000118").trim().split("\n");
    const healthy = rows.filter((r) => r.split("\t")[6] === "healthy").length;
    expect(healthy).toBe(9);
    const withTerm = subjects.filter((s) =>
      phenotypic(s).hasDiagnosis?.some((d) => d.identifier === "ncit:C94342"),
    );
    expect(withTerm.length).toBe(healthy);
    expect(bodyOf("nm000118")).not.toContain("isSubjectGroup");
    expect(JSON.stringify(dictionaryOf("nm000118").group)).toContain("nb:Diagnosis");
  });

  test("nm000290 (age ranges): FromRange, each age the midpoint of its range", () => {
    expect(JSON.stringify(dictionaryOf("nm000290").age)).toContain("nb:FromRange");
    const ages = subjectsOf("nm000290").map((s) => phenotypic(s).hasAge);
    expect(new Set(ages)).toEqual(new Set([23.5, 37]));
  });

  test("on002712 (participant ids share nothing with the bids index): the table is not joined, and the subject count is not doubled", () => {
    expect(flagsOf("on002712")).toContain("participant_ids_do_not_join_bids_index");
    expect((reportOf("on002712").participants_tsv as Json).status).toBe("ids_do_not_join");
    expect(subjectsOf("on002712").length).toBe(25);
    expect(bodyOf("on002712")).not.toContain("hasAge");
  });

  test("on004019 (space-padded ages, a Gender column): padded decimals parse, gender is left to curation", () => {
    expect(rawTsv("on004019")).toMatch(/\t {5,}10\t/);
    const ages = subjectsOf("on004019")
      .map((s) => phenotypic(s).hasAge)
      .filter((a) => a !== undefined);
    // 62 subjects have data; 61 of them have a table row, and one row names a participant
    // the index does not (and one subject has no row): ids left over on both sides.
    expect(ages.length).toBe(61);
    expect(reportOf("on004019").subjects).toEqual({
      graph: 62,
      index_without_row: 1,
      joined: 61,
      source: "bids_index",
      table_only: 1,
    });
    expect(flagsOf("on004019")).toEqual(
      expect.arrayContaining(["gender_column_needs_curation", "partial_join"]),
    );
    expect(bodyOf("on004019")).not.toContain("hasSex");
  });

  test("on003194 (sex coded 0 and 1): numeric codes are not guessed at", () => {
    expect(flagsOf("on003194")).toContain("sex_column_needs_curation");
    expect(bodyOf("on003194")).not.toContain("hasSex");
    expect(Object.keys(dictionaryOf("on003194"))).toEqual(["participant_id"]);
  });

  test("on001787 (a group column with no control value): nothing is mapped from it", () => {
    expect(flagsOf("on001787")).toEqual(
      expect.arrayContaining(["group_column_needs_curation", "gender_column_needs_curation"]),
    );
    expect(bodyOf("on001787")).not.toContain("hasDiagnosis");
  });

  test("nm000157 (every age is 0 beside n/a sex and weight): placeholder zeros are not ages", () => {
    expect(rawTsv("nm000157")).toMatch(/sub-1\t0\tn\/a/);
    expect(bodyOf("nm000157")).not.toContain("hasAge");
    expect(reportOf("nm000157").columns).toMatchObject({
      age: { status: "needs_curation", reason: "age_zero_placeholder", counts: { zero_ages: 19 } },
    });
    expect(Object.keys(dictionaryOf("nm000157"))).not.toContain("age");
    expect(flagsOf("nm000157")).toContain("age_column_needs_curation");
  });

  test("nm000200 (12 of 13 ages are 0): the majority rule sends the column to curation", () => {
    expect(bodyOf("nm000200")).not.toContain("hasAge");
    expect(reportOf("nm000200").columns).toMatchObject({
      age: { status: "needs_curation", reason: "age_zero_placeholder", counts: { zero_ages: 12 } },
    });
  });

  test("on006434 (24 of 66 ages are 0, sex U): below half, so the ages are kept, and the report counts the zeros", () => {
    // Known limit of the 50 percent rule, recorded rather than hidden: these zeros look like
    // placeholders but are not a majority. A curator, not the rule, can tell them apart.
    const ages = subjectsOf("on006434").map((s) => phenotypic(s).hasAge);
    expect(ages.filter((a) => a === 0).length).toBe(24);
    expect(reportOf("on006434").columns).toMatchObject({
      age: { status: "mapped", counts: { zero_ages: 24 } },
    });
  });

  test("on003751 (a participant listed twice, identically; 14 rows for participants with no data): one subject, and the table-only rows are counted, not graphed", () => {
    const tsv = reportOf("on003751").participants_tsv as Json;
    expect(tsv.duplicate_ids).toBe(1);
    expect(tsv.conflicting_ids).toBe(0);
    expect(flagsOf("on003751")).toContain("duplicate_participant_ids");
    expect(flagsOf("on003751")).not.toContain("conflicting_duplicate_participant_ids");
    const labels = subjectsOf("on003751").map((s) => s.hasLabel);
    expect(new Set(labels).size).toBe(labels.length);
    // The graph holds the 40 subjects of the index; the table names 54 participants.
    expect(labels.length).toBe(40);
    expect(reportOf("on003751").subjects).toEqual({
      graph: 40,
      index_without_row: 0,
      joined: 40,
      source: "bids_index",
      table_only: 14,
    });
    // The duplicated participant kept one row, and so one phenotype.
    const duplicated = subjectsOf("on003751").find((s) => s.hasLabel === "sub-mit081") as Subject;
    expect(phenotypic(duplicated).hasAge).toBeDefined();
    // The graph's subjects are exactly the index's, and none of the table-only rows is in it.
    const index = (
      loadFixture("on003751").metadata as {
        extensions: { nemar: { bids_index: { subjects: Json } } };
      }
    ).extensions.nemar.bids_index.subjects;
    expect(new Set(labels)).toEqual(new Set(Object.keys(index)));
    const tableIds = new Set(
      rawTsv("on003751")
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => line.split("\t")[0]),
    );
    const tableOnly = [...tableIds].filter((id) => !(id in index));
    expect(tableOnly.length).toBe(14);
    for (const id of tableOnly) expect(labels).not.toContain(id);
  });
});

describe("SYNTHETIC tables over real metadata: rules no public dataset reaches", () => {
  const tsv = (...lines: string[]): string => `${lines.join("\n")}\n`;
  const ageOf = async (cells: string[], units?: string) => {
    const lines = [
      "participant_id\tage",
      ...cells.map((c, i) => `sub-${String(i + 1).padStart(3, "0")}\t${c}`),
    ];
    const input = withTable(
      "nm000132",
      tsv(...lines),
      units === undefined ? null : JSON.stringify({ age: { Units: units } }),
    );
    const artifacts = await buildNeurobagelArtifacts(input);
    const subjects = docs(artifacts).jsonld.hasSamples as Subject[];
    return {
      report: docs(artifacts).report,
      dictionary: docs(artifacts).dictionary,
      ages: subjects.map(
        (s) => s.hasSession.find((x) => x.schemaKey === "PhenotypicSession")?.hasAge,
      ),
    };
  };

  test("a column mixing plain and bounded ages takes the common grammar; the odd cell is a declared missing value", async () => {
    const { ages, dictionary } = await ageOf([
      "30",
      "45",
      "90+",
      "60",
      "20",
      "33",
      "41",
      "52",
      "71",
      "28",
    ]);
    expect(JSON.stringify(dictionary.age)).toContain("nb:FromFloat");
    expect(
      (dictionary.age as { Annotations: { MissingValues: string[] } }).Annotations.MissingValues,
    ).toContain("90+");
    expect(ages.filter((a) => a !== undefined).length).toBe(9);
    expect(ages[2]).toBeUndefined();
  });

  test("a column of lower-bounded ages (90+) uses FromBounded and reads each as its bound", async () => {
    const { ages, dictionary } = await ageOf(["90+", "85+"]);
    expect(JSON.stringify(dictionary.age)).toContain("nb:FromBounded");
    expect(ages).toEqual([90, 85]);
  });

  test("ISO 8601 ages in years and months (31Y6M) use FromISO8601", async () => {
    const { ages, dictionary } = await ageOf(["31Y6M", "P25Y", "P40Y3M"]);
    expect(JSON.stringify(dictionary.age)).toContain("nb:FromISO8601");
    expect(ages).toEqual([31.5, 25, 40.25]);
  });

  test("an ISO 8601 duration of zero is never emitted (the pinned bagel raises on it)", async () => {
    const { report } = await ageOf(["P0Y", "P0Y"]);
    expect(((report.columns as Json).age as Json).status).toBe("needs_curation");
  });

  test("a participants.json that declares months sends the column to curation", async () => {
    const { report, dictionary, ages } = await ageOf(["24", "36", "48"], "months");
    expect(((report.columns as Json).age as Json).reason).toBe("age_units_not_years");
    expect(Object.keys(dictionary)).toEqual(["participant_id"]);
    expect(ages).toEqual([undefined, undefined, undefined]);
  });

  test("units that say years in several spellings are accepted", async () => {
    for (const units of ["years", "Years", "year", "years old", "(years)"]) {
      const { report } = await ageOf(["24", "36"], units);
      expect(((report.columns as Json).age as Json).status).toBe("mapped");
      expect(report.flags).not.toContain("age_units_assumed_years");
    }
  });

  test("units that are not years, in any spelling, are not guessed at", async () => {
    for (const units of ["n/a", "weeks", "days", "months"]) {
      const { report } = await ageOf(["24", "36"], units);
      expect(((report.columns as Json).age as Json).status).toBe("needs_curation");
    }
  });

  test("a birth year in the age column (values above 120) goes to curation, not to the graph", async () => {
    const { report, ages } = await ageOf(["1988", "1990", "1975"]);
    expect(((report.columns as Json).age as Json).reason).toBe("age_unparseable");
    expect(ages.every((a) => a === undefined)).toBe(true);
  });

  test("up to 10% unparseable ages become declared missing values; above that the column goes to curation", async () => {
    const ok = await ageOf(["20", "21", "22", "23", "24", "25", "26", "27", "28", "x"]);
    expect(((ok.report.columns as Json).age as Json).status).toBe("mapped");
    expect(JSON.stringify(ok.dictionary.age)).toContain('"x"');
    expect(ok.ages.filter((a) => a !== undefined).length).toBe(9);
    const bad = await ageOf(["20", "21", "22", "23", "24", "25", "26", "27", "x", "y"]);
    expect(((bad.report.columns as Json).age as Json).status).toBe("needs_curation");
  });

  test("NaN, negative, signed and exponent values are never turned into ages", async () => {
    const { ages } = await ageOf([
      "NaN",
      "-5",
      "+5",
      "1e1",
      "20",
      "21",
      "22",
      "23",
      "24",
      "25",
      "26",
      "27",
      "28",
      "29",
      "30",
      "31",
      "32",
      "33",
      "34",
      "35",
      "36",
      "37",
      "38",
      "39",
      "40",
      "41",
      "42",
      "43",
      "44",
      "45",
      "46",
      "47",
      "48",
      "49",
      "50",
      "51",
      "52",
      "53",
      "54",
      "55",
      "56",
      "57",
      "58",
      "59",
      "60",
      "61",
      "62",
      "63",
      "64",
      "65",
      "66",
      "67",
      "68",
      "69",
      "70",
      "71",
      "72",
      "73",
      "74",
      "75",
      "76",
      "77",
      "78",
      "79",
      "80",
      "81",
      "82",
      "83",
      "84",
      "85",
      "86",
      "87",
      "88",
      "89",
      "90",
      "91",
      "92",
      "93",
      "94",
      "95",
      "96",
      "97",
      "98",
      "99",
    ]);
    expect(ages.slice(0, 4)).toEqual([undefined, undefined, undefined, undefined]);
  });

  test("a few zero ages among real ages (newborns recorded in years) stay ages", async () => {
    const { ages, report } = await ageOf(["0", "0", "0", "1", "1", "2", "2", "3", "3", "4"]);
    expect(ages).toEqual([0, 0, 0, 1, 1, 2, 2, 3, 3, 4]);
    const age = (report.columns as Json).age as { status: string; counts: Json };
    expect(age.status).toBe("mapped");
    expect(age.counts.zero_ages).toBe(3);
  });

  test("zeros that are at least half of the parsed ages are a placeholder: the column goes to curation, with the zero count", async () => {
    // Exactly 50 percent (2 of 4) is already a placeholder; just under it (2 of 5, 1 of 4) is not.
    const exactly = await ageOf(["0", "0", "30", "40"]);
    const column = (exactly.report.columns as Json).age as Json;
    expect(column).toMatchObject({ status: "needs_curation", reason: "age_zero_placeholder" });
    expect((column.counts as Json).zero_ages).toBe(2);
    expect(exactly.ages.every((a) => a === undefined)).toBe(true);
    expect(Object.keys(exactly.dictionary)).toEqual(["participant_id"]);
    expect(exactly.report.flags).toContain("age_column_needs_curation");

    for (const cells of [
      ["0", "0", "30", "40", "50"],
      ["0", "30", "40", "50"],
    ]) {
      const under = await ageOf(cells);
      expect(((under.report.columns as Json).age as Json).status).toBe("mapped");
      expect(under.ages.filter((a) => a === 0).length).toBe(cells.filter((c) => c === "0").length);
    }
    const majority = await ageOf(["0", "0", "0", "30", "40"]);
    expect(((majority.report.columns as Json).age as Json).status).toBe("needs_curation");
  });

  test("a column that is entirely zeros is a placeholder, however the zero is written", async () => {
    for (const cells of [
      ["0", "0", "0"],
      ["0.0", "00", "0"],
      [" 0", "0 ", "0"],
    ]) {
      const { report, ages } = await ageOf(cells);
      expect(((report.columns as Json).age as Json).reason).toBe("age_zero_placeholder");
      expect(ages.every((a) => a === undefined)).toBe(true);
    }
    // A range of 0-0 is zero as well.
    const range = await ageOf(["0-0", "0-0", "20-30"]);
    expect(((range.report.columns as Json).age as Json).reason).toBe("age_zero_placeholder");
  });

  test("the zero rule counts parsed ages only: missing and unparseable cells are not in the denominator", async () => {
    // 2 zeros, 2 real ages, 3 n/a: half of the 4 parsed ages, so a placeholder.
    const { report } = await ageOf(["0", "0", "30", "40", "n/a", "n/a", "n/a"]);
    expect(((report.columns as Json).age as Json).reason).toBe("age_zero_placeholder");
    // 1 zero, 2 real ages, 4 n/a: a third, so real.
    const real = await ageOf(["0", "30", "40", "n/a", "n/a", "n/a", "n/a"]);
    expect(((real.report.columns as Json).age as Json).status).toBe("mapped");
  });

  test("sex: m, f, male, female, o, other in any case map; codes and unknowns do not", async () => {
    const lines = ["participant_id\tsex"];
    const values = ["M", "f", "Male", "FEMALE", "o", "Other", "U", "1"];
    values.forEach((v, i) => lines.push(`sub-${String(i + 1).padStart(3, "0")}\t${v}`));
    // 2 of 8 unmappable is above the 10% limit: the column is not mapped at all.
    const art = await buildNeurobagelArtifacts(withTable("nm000132", tsv(...lines)));
    expect(((docs(art).report.columns as Json).sex as Json).reason).toBe("sex_unmappable");

    const clean = ["participant_id\tsex"];
    ["M", "f", "Male", "FEMALE", "o", "Other"].forEach((v, i) =>
      clean.push(`sub-${String(i + 1).padStart(3, "0")}\t${v}`),
    );
    const ok = await buildNeurobagelArtifacts(withTable("nm000132", tsv(...clean)));
    const sexes = (docs(ok).jsonld.hasSamples as Subject[]).map(
      (s) => s.hasSession.find((x) => x.schemaKey === "PhenotypicSession")?.hasSex?.identifier,
    );
    expect(sexes).toEqual([
      "snomed:248153007",
      "snomed:248152002",
      "snomed:248153007",
      "snomed:248152002",
      "snomed:32570681000036106",
      "snomed:32570681000036106",
    ]);
  });

  test("a cell that reads like a JavaScript object member is just an unmappable value", async () => {
    const rows = [
      "participant_id\tsex",
      ...Array.from(
        { length: 30 },
        (_, i) => `sub-${String(i + 1).padStart(3, "0")}\t${i === 0 ? "constructor" : "M"}`,
      ),
    ];
    const art = await buildNeurobagelArtifacts(withTable("nm000132", tsv(...rows)));
    expect(((docs(art).report.columns as Json).sex as Json).status).toBe("mapped");
    expect(
      (docs(art).report.columns as { sex: { counts: { unmappable: number } } }).sex.counts
        .unmappable,
    ).toBe(1);
  });

  test("group: control spellings map; every other group value is a declared missing value", async () => {
    const values = [
      "Healthy Control",
      "healthy_control",
      "CTRL",
      "HC",
      "control",
      "patient",
      "ADHD",
    ];
    const rows = [
      "participant_id\tgroup",
      ...values.map((v, i) => `sub-${String(i + 1).padStart(3, "0")}\t${v}`),
    ];
    const art = await buildNeurobagelArtifacts(withTable("nm000132", tsv(...rows)));
    const subjects = docs(art).jsonld.hasSamples as Subject[];
    const flagged = subjects.map(
      (s) =>
        s.hasSession.find((x) => x.schemaKey === "PhenotypicSession")?.hasDiagnosis?.[0]
          ?.identifier,
    );
    expect(flagged).toEqual([
      "ncit:C94342",
      "ncit:C94342",
      "ncit:C94342",
      "ncit:C94342",
      "ncit:C94342",
      undefined,
      undefined,
    ]);
    const annotations = (docs(art).dictionary.group as { Annotations: { MissingValues: string[] } })
      .Annotations;
    expect(annotations.MissingValues).toEqual(["", "n/a", "N/A", "NA", "ADHD", "patient"]);
  });

  test("a participant id without the sub- prefix is prefixed so it joins the bids index", async () => {
    const input = loadFixture("nm000132");
    const rows = ["participant_id\tage"];
    for (let i = 1; i <= 40; i++) rows.push(`${String(i).padStart(3, "0")}\t${20 + (i % 10)}`);
    const art = await buildNeurobagelArtifacts({ ...input, participantsTsv: tsv(...rows) });
    const report = docs(art).report;
    expect((report.participants_tsv as Json).ids_prefixed).toBe(40);
    expect((report.graph as Json).subjects).toBe(40);
    expect(report.flags).toContain("participant_ids_prefixed");
  });

  test("a participant listed twice with identical rows is one participant; with rows that disagree they carry no phenotype", async () => {
    // on003751 lists a participant twice with identical rows, so only a synthetic table can
    // tell "keep one" from "pick one": sub-001 is repeated identically, sub-002 is repeated
    // with another age, and neither first nor last may be taken as the truth.
    const rows = [
      "participant_id\tage",
      "sub-001\t20",
      "sub-002\t30",
      "sub-001\t20",
      "sub-002\t99",
      "sub-003\t25",
    ];
    const art = await buildNeurobagelArtifacts(withTable("nm000132", tsv(...rows)));
    const subjects = docs(art).jsonld.hasSamples as Subject[];
    const ageOf = (label: string) =>
      (subjects.find((s) => s.hasLabel === label) as Subject).hasSession.find(
        (x) => x.schemaKey === "PhenotypicSession",
      )?.hasAge;
    expect(ageOf("sub-001")).toBe(20);
    expect(ageOf("sub-002")).toBeUndefined();
    expect(ageOf("sub-003")).toBe(25);
    const report = docs(art).report;
    expect(report.participants_tsv).toMatchObject({ duplicate_ids: 2, conflicting_ids: 1 });
    expect(report.flags).toEqual(
      expect.arrayContaining([
        "duplicate_participant_ids",
        "conflicting_duplicate_participant_ids",
      ]),
    );
    // The conflicting rows inform nothing: the 99 is not in the dictionary's range.
    const range = (docs(art).dictionary.age as { Annotations: { ValueRange: { Max: number } } })
      .Annotations.ValueRange;
    expect(range.Max).toBe(25);
  });

  test("a table that cannot be read is treated as absent, with a flag, and the subjects still come from the index", async () => {
    const ragged = tsv("participant_id\tage", "sub-001\t20\textra\tmore");
    const art = await buildNeurobagelArtifacts(withTable("nm000132", ragged));
    const report = docs(art).report;
    expect((report.participants_tsv as Json).status).toBe("malformed");
    expect((report.graph as Json).subjects).toBe(40);
    const unterminated = await buildNeurobagelArtifacts(
      withTable("nm000132", 'participant_id\tage\n"sub-001\t20\n'),
    );
    expect((docs(unterminated).report.participants_tsv as Json).status).toBe("malformed");
  });

  test("a table with no participant_id column is not joined", async () => {
    const art = await buildNeurobagelArtifacts(
      withTable("nm000132", tsv("id\tage", "sub-001\t20")),
    );
    expect((docs(art).report.participants_tsv as Json).status).toBe("no_participant_id");
    expect(docs(art).jsonld).not.toHaveProperty("hasSamples.0.hasSession.0.hasAge");
  });

  test("a participants.json that is not an object is reported and ignored", async () => {
    const art = await buildNeurobagelArtifacts({
      ...loadFixture("nm000132"),
      participantsJson: JSON.stringify(["not", "an", "object"]),
    });
    expect((docs(art).report.participants_json as Json).status).toBe("unreadable");
    const notJson = await buildNeurobagelArtifacts({
      ...loadFixture("nm000132"),
      participantsJson: "{ this is not json",
    });
    expect((docs(notJson).report.participants_json as Json).status).toBe("unreadable");
  });
});

describe("SYNTHETIC session_modalities over real metadata: the pairing the bids index records (phase 2)", () => {
  // The data plane serves `session_modalities` from the phase 2 deploy on, so no captured
  // fixture carries it yet. Real metadata (nm000229, MEG-MASC: two sessions, "0" and "1", per
  // subject) is given the field here, one subject at a time, as the data plane documents it:
  // session label (or "no-session") to the datatypes found there.
  type Node = {
    sessions: string[];
    modalities: Record<string, unknown>;
    session_modalities?: unknown;
  };
  const withSessionModalities = async (set: (subjects: Record<string, Node>) => void) => {
    const input = loadFixture("nm000229");
    const metadata = JSON.parse(JSON.stringify(input.metadata)) as {
      extensions: { nemar: { bids_index: { subjects: Record<string, Node> } } };
    };
    const subjects = metadata.extensions.nemar.bids_index.subjects;
    set(subjects);
    const artifacts = await buildNeurobagelArtifacts({ ...input, metadata });
    const graph = docs(artifacts).jsonld.hasSamples as Subject[];
    return {
      report: docs(artifacts).report,
      subject: (label: string) => graph.find((x) => x.hasLabel === label) as Subject,
    };
  };
  const onlyMeg = (subjects: Record<string, Node>): [string, Node][] =>
    Object.entries(subjects).filter(
      ([, n]) => Object.keys(n.modalities).join() === "meg" && n.sessions.join() === "0,1",
    );

  test("each session that holds the datatype becomes its own imaging session, keeping its label", async () => {
    const { subject, report } = await withSessionModalities((subjects) => {
      for (const [, node] of onlyMeg(subjects))
        node.session_modalities = { "0": ["meg"], "1": ["meg"] };
    });
    const label = "sub-02";
    const sessions = imaging(subject(label));
    expect(sessions.map((x) => x.hasLabel)).toEqual(["ses-0", "ses-1"]);
    for (const session of sessions) {
      expect(session.hasAcquisition?.map((a) => a.hasContrastType.identifier)).toEqual([
        "nidm:Magnetoencephalography",
      ]);
    }
    const basis = (report.imaging as Json).session_pairing_subjects as Json;
    expect(basis.recorded).toBeGreaterThan(0);
  });

  test("a session without the datatype gets no imaging session, so the pairing is not widened", async () => {
    const { subject } = await withSessionModalities((subjects) => {
      for (const [, node] of onlyMeg(subjects)) node.session_modalities = { "0": [], "1": ["meg"] };
    });
    const labels = imaging(subject("sub-02")).map((x) => x.hasLabel);
    expect(labels).toEqual(["ses-1"]);
  });

  test("a datatype outside every session directory (no-session) goes in ses-unnamed", async () => {
    const { subject } = await withSessionModalities((subjects) => {
      for (const [, node] of onlyMeg(subjects)) {
        node.sessions = [];
        node.session_modalities = { "no-session": ["meg"] };
      }
    });
    expect(imaging(subject("sub-02")).map((x) => x.hasLabel)).toEqual(["ses-unnamed"]);
  });

  test("a real session literally named unnamed and the no-session bucket share ses-unnamed without a collision", async () => {
    const { subject } = await withSessionModalities((subjects) => {
      for (const [, node] of onlyMeg(subjects)) {
        node.sessions = ["unnamed"];
        // Different datatypes in the two buckets, so merging them is visible.
        node.modalities = { eeg: {}, meg: {} };
        node.session_modalities = { unnamed: ["meg"], "no-session": ["eeg"] };
      }
    });
    const sessions = imaging(subject("sub-02"));
    expect(sessions.length).toBe(1);
    expect(sessions[0].hasLabel).toBe("ses-unnamed");
    expect(sessions[0].hasAcquisition?.map((a) => a.hasContrastType.identifier)).toEqual([
      "nidm:Electroencephalography",
      "nidm:Magnetoencephalography",
    ]);
  });

  test("a session holding only a datatype NEMAR does not map (anat) gets no imaging session", async () => {
    const mixed = (subjects: Record<string, Node>) =>
      Object.entries(subjects).find(
        ([, n]) => Object.keys(n.modalities).sort().join() === "anat,meg",
      ) as [string, Node];
    const label = mixed(
      (
        loadFixture("nm000229").metadata as {
          extensions: { nemar: { bids_index: { subjects: Record<string, Node> } } };
        }
      ).extensions.nemar.bids_index.subjects,
    )[0];
    const { subject } = await withSessionModalities((subjects) => {
      mixed(subjects)[1].session_modalities = { "0": ["anat"], "1": ["meg"] };
    });
    expect(imaging(subject(label)).map((x) => x.hasLabel)).toEqual(["ses-1"]);
  });

  test("an empty map is the whole truth for a subject with no datatype, and a contradiction for one that has some", async () => {
    const { report } = await withSessionModalities((subjects) => {
      for (const [, node] of onlyMeg(subjects)) node.session_modalities = {};
    });
    expect(report.flags).toContain("session_modalities_inconsistent");
    expect(
      ((report.imaging as Json).session_pairing_subjects as Json).inconsistent,
    ).toBeGreaterThan(0);
  });

  test("a session_modalities that names other datatypes than the subject has is not trusted", async () => {
    const { subject, report } = await withSessionModalities((subjects) => {
      for (const [, node] of onlyMeg(subjects))
        node.session_modalities = { "0": ["eeg"], "1": ["eeg"] };
    });
    expect(report.flags).toContain("session_modalities_inconsistent");
    // Falls back to the absent-field rule: two sessions, pairing unknown, one unnamed session, MEG.
    const sessions = imaging(subject("sub-02"));
    expect(sessions.map((x) => x.hasLabel)).toEqual(["ses-unnamed"]);
    expect(sessions[0].hasAcquisition?.[0].hasContrastType.identifier).toBe(
      "nidm:Magnetoencephalography",
    );
  });

  test("a malformed session_modalities is reported and the subject falls back", async () => {
    for (const malformed of ["oops", ["0", "1"], { "0": "meg" }, { "0": [1] }, null]) {
      const { report } = await withSessionModalities((subjects) => {
        for (const [, node] of onlyMeg(subjects)) node.session_modalities = malformed;
      });
      expect(report.flags).toContain("session_modalities_unreadable");
    }
  });

  test("a directory that is not a session (ses-pre-op) is a datatype of that name, dropped and counted, and breaks nothing", async () => {
    // The data plane's index only reads ses-<alphanumeric> as a session, so `ses-pre-op` shows up
    // as a datatype of that name (shared/contract/dataset.ts). It must not become a session
    // label, a modality or a report key.
    const { subject, report } = await withSessionModalities((subjects) => {
      for (const [, node] of onlyMeg(subjects)) {
        node.modalities = { meg: {}, "ses-pre-op": {} };
        node.session_modalities = { "0": ["meg"], "1": ["meg", "ses-pre-op"] };
      }
    });
    const sessions = imaging(subject("sub-02"));
    expect(sessions.map((x) => x.hasLabel)).toEqual(["ses-0", "ses-1"]);
    expect(JSON.stringify(subject("sub-02"))).not.toContain("pre-op");
    const imagingReport = report.imaging as Json;
    expect(((imagingReport.datatypes_dropped_subjects as Json).other as number) > 0).toBe(true);
    expect(JSON.stringify(report)).not.toContain("pre-op");
    expect(report.flags).not.toContain("session_modalities_inconsistent");
  });

  test("datatype names that are also Object members (__proto__, constructor) cannot break the output or the counts", async () => {
    const { subject, report } = await withSessionModalities((subjects) => {
      // JSON.parse makes `__proto__` an OWN key, as it is in a real response.
      const hostile = JSON.parse(
        '{"sessions":["0","1"],"modalities":{"meg":{"tasks":{}},"__proto__":{"tasks":{}},"constructor":{"tasks":{}}},' +
          '"session_modalities":{"0":["meg","__proto__"],"1":["constructor","meg"]}}',
      ) as Node;
      for (const [label] of onlyMeg(subjects)) subjects[label] = hostile;
    });
    expect(imaging(subject("sub-02")).map((x) => x.hasLabel)).toEqual(["ses-0", "ses-1"]);
    const dropped = (report.imaging as Json).datatypes_dropped_subjects as Record<string, unknown>;
    expect(typeof dropped.constructor).toBe("number");
    expect(Object.keys(dropped)).not.toContain("__proto__");
    expect(report.flags).not.toContain("session_modalities_inconsistent");
    expect(({} as Json).tasks).toBeUndefined();
  });

  test("absent is unknown: the same metadata without the field gives the cautious single session", async () => {
    const { subject, report } = await withSessionModalities(() => {});
    expect(imaging(subject("sub-02")).map((x) => x.hasLabel)).toEqual(["ses-unnamed"]);
    expect(report.flags).toContain("session_pairing_unknown");
    expect(report.flags).not.toContain("session_modalities_unreadable");
  });
});

describe("SYNTHETIC subjects and the bids index: the graph holds the subjects that have data", () => {
  // nm000132 has 40 subjects in its index, sub-001 to sub-040; its real metadata is used with
  // tables written here, because no public dataset has each of these shapes.
  const tsv = (...lines: string[]): string => `${lines.join("\n")}\n`;
  const subjectIds = (from: number, to: number): string[] =>
    Array.from({ length: to - from + 1 }, (_, i) => `sub-${String(from + i).padStart(3, "0")}`);
  const build = async (rows: string[], edit?: (metadata: Json) => void) => {
    const input = loadFixture("nm000132");
    const metadata = JSON.parse(JSON.stringify(input.metadata)) as Json;
    edit?.(metadata);
    const artifacts = await buildNeurobagelArtifacts({
      ...input,
      metadata,
      participantsTsv: tsv("participant_id\tage", ...rows),
    });
    return docs(artifacts);
  };

  test("rows for participants with no data are left out of the graph, counted, and do not shape the dictionary", async () => {
    const withData = subjectIds(1, 40).map((id, i) => `${id}\t${20 + (i % 20)}`);
    // Fifty rows of junk for participants the index does not list: more than 10% of the table.
    const noData = subjectIds(901, 950).map((id) => `${id}\tx`);
    const d = await build([...withData, ...noData]);
    expect(d.report.subjects).toEqual({
      graph: 40,
      index_without_row: 0,
      joined: 40,
      source: "bids_index",
      table_only: 50,
    });
    expect((d.jsonld.hasSamples as Subject[]).length).toBe(40);
    // The junk would have sent the age column to curation (more than 10% unparseable) and put
    // `x` in its missing values; neither happens because only the graph's subjects inform it.
    const age = (d.report.columns as Json).age as Json;
    expect(age.status).toBe("mapped");
    const annotations = (
      d.dictionary.age as { Annotations: { MissingValues: string[]; ValueRange: Json } }
    ).Annotations;
    expect(annotations.MissingValues).not.toContain("x");
    expect(annotations.ValueRange).toEqual({ Max: 39, Min: 20 });
    expect(d.report.flags).not.toContain("partial_join");
  });

  test("subjects with data but no table row stay, with no phenotype, and that alone is not a partial join", async () => {
    const d = await build(subjectIds(1, 30).map((id) => `${id}\t30`));
    expect(d.report.subjects).toMatchObject({
      graph: 40,
      index_without_row: 10,
      joined: 30,
      table_only: 0,
    });
    expect(d.report.flags).not.toContain("partial_join");
  });

  test("ids left over on BOTH sides are flagged partial_join with the counts, and nothing is joined by guesswork", async () => {
    // sub-001 to sub-038 join; sub-039 and sub-040 have data and no row; sub-41 and sub-901 have
    // a row and no data. `sub-41` looks like a mistyped `sub-041`; it is NOT joined to anything.
    const rows = [...subjectIds(1, 38), "sub-41", "sub-901"].map((id) => `${id}\t30`);
    const d = await build(rows);
    expect(d.report.flags).toContain("partial_join");
    expect(d.report.subjects).toEqual({
      graph: 40,
      index_without_row: 2,
      joined: 38,
      source: "bids_index",
      table_only: 2,
    });
    const subjects = d.jsonld.hasSamples as Subject[];
    const aged = subjects.filter(
      (s) => s.hasSession.find((x) => x.schemaKey === "PhenotypicSession")?.hasAge !== undefined,
    );
    expect(aged.length).toBe(38);
  });

  test("ids that share nothing with the index are not joined at all", async () => {
    const d = await build(subjectIds(901, 910).map((id) => `${id}\t30`));
    expect(d.report.participants_tsv).toMatchObject({ status: "ids_do_not_join" });
    expect(d.report.flags).toContain("participant_ids_do_not_join_bids_index");
    expect(d.report.flags).not.toContain("partial_join");
    expect(d.report.subjects).toMatchObject({ graph: 40, joined: 0, table_only: 10 });
  });

  test("with an empty index the table's participants are the subjects, and the report says so", async () => {
    const rows = subjectIds(1, 12).map((id) => `${id}\t30`);
    for (const edit of [
      (m: Json) => {
        ((m.extensions as Json).nemar as Json).bids_index = {
          version: "v1.1.1",
          subjects: {},
        };
      },
      (m: Json) => {
        (m.extensions as Json).nemar = {};
      },
      (m: Json) => {
        m.extensions = undefined;
      },
    ]) {
      const d = await build(rows, edit);
      expect(d.report.flags).toContain("bids_index_empty_fell_back_to_table");
      expect(d.report.subjects).toEqual({
        graph: 12,
        index_without_row: 0,
        joined: 12,
        source: "participants_tsv",
        table_only: 0,
      });
      expect((d.jsonld.hasSamples as Subject[]).length).toBe(12);
      expect(d.report.graph).toMatchObject({ subjects: 12, imaging_sessions: 0 });
    }
  });

  test("ParticipantCount and the reported source agree: declared, else the index, else the table", async () => {
    const rows = subjectIds(1, 40).map((id) => `${id}\t30`);
    const declared = await build(rows);
    expect(declared.report.participant_count).toMatchObject({
      declared: 40,
      used: 40,
      used_from: "demographics",
    });
    expect(declared.description.ParticipantCount).toBe(40);

    const noDemographics = await build(rows, (m) => {
      m.demographics = null;
    });
    expect(noDemographics.report.participant_count).toMatchObject({
      declared: null,
      used: 40,
      used_from: "bids_index",
    });
    expect(noDemographics.description.ParticipantCount).toBe(40);

    // A declared count of 0 is not a count: it is not used.
    const zero = await build(rows, (m) => {
      m.demographics = { subjects_count: 0 };
    });
    expect(zero.report.participant_count).toMatchObject({
      declared: 0,
      used: 40,
      used_from: "bids_index",
    });
    expect(zero.description.ParticipantCount).toBe(40);

    const tableOnly = await build(
      subjectIds(1, 12).map((id) => `${id}\t30`),
      (m) => {
        m.demographics = null;
        m.extensions = undefined;
      },
    );
    expect(tableOnly.report.participant_count).toMatchObject({
      used: 12,
      used_from: "participants_tsv",
    });
    expect(tableOnly.description.ParticipantCount).toBe(12);

    // A declared count that disagrees with the graph is used as declared, and flagged.
    const disagree = await build(rows, (m) => {
      m.demographics = { subjects_count: 45 };
    });
    expect(disagree.description.ParticipantCount).toBe(45);
    expect(disagree.report.flags).toContain("participant_count_disagrees");
  });
});

describe("SYNTHETIC boundaries of the age, group and identity rules", () => {
  const tsv = (...lines: string[]): string => `${lines.join("\n")}\n`;
  const idOf = (i: number): string => `sub-${String(i + 1).padStart(3, "0")}`;
  const phenotypeOf = (artifacts: NeurobagelArtifacts, label: string): Session | undefined =>
    (
      (docs(artifacts).jsonld.hasSamples as Subject[]).find((s) => s.hasLabel === label) as Subject
    ).hasSession.find((x) => x.schemaKey === "PhenotypicSession");
  const withColumn = async (column: string, cells: string[], units?: string) =>
    buildNeurobagelArtifacts(
      withTable(
        "nm000132",
        tsv(`participant_id\t${column}`, ...cells.map((c, i) => `${idOf(i)}\t${c}`)),
        units === undefined ? null : JSON.stringify({ [column]: { Units: units } }),
      ),
    );
  const agesOf = async (cells: string[], units?: string) => {
    const art = await withColumn("age", cells, units);
    return {
      art,
      ages: cells.map((_, i) => phenotypeOf(art, idOf(i))?.hasAge),
      column: (docs(art).report.columns as Json).age as Json,
    };
  };
  const filler = (n: number, from = 20): string[] =>
    Array.from({ length: n }, (_, i) => String(from + i));

  test("120 years is the oldest age, inclusive; 121 is not an age (decimal, range, bound and ISO 8601)", async () => {
    const edge = await agesOf(["120", ...filler(9)]);
    expect(edge.ages[0]).toBe(120);
    expect((edge.column.counts as Json).unmappable).toBe(0);

    const over = await agesOf(["121", ...filler(9)]);
    expect(over.ages[0]).toBeUndefined();
    expect((over.column.counts as Json).unmappable).toBe(1);
    expect(JSON.stringify(docs(over.art).dictionary.age)).toContain('"121"');

    // Each of the other grammars, as the only one in its column.
    expect((await agesOf(["100-120", "20-30"])).ages).toEqual([110, 25]);
    expect((await agesOf(["100-121", "20-30"])).ages[0]).toBeUndefined();
    expect((await agesOf(["120+", "90+"])).ages).toEqual([120, 90]);
    expect((await agesOf(["121+", "122+"])).column.status).toBe("needs_curation");
    expect((await agesOf(["P120Y", "P30Y"])).ages).toEqual([120, 30]);
    expect((await agesOf(["P121Y", "P122Y"])).column.status).toBe("needs_curation");
    expect(await agesOf(["0", "1", "2"])).toMatchObject({ ages: [0, 1, 2] });
  });

  test("a reversed range (30-20) is unparseable, not the midpoint of its bounds", async () => {
    const { ages, art } = await agesOf([
      "30-20",
      "20-30",
      "25-35",
      "30-40",
      "40-50",
      "50-60",
      "60-70",
      "35-45",
      "45-55",
      "55-65",
    ]);
    expect(ages[0]).toBeUndefined();
    expect(ages[1]).toBe(25);
    expect(JSON.stringify(docs(art).dictionary.age)).toContain('"30-20"');
  });

  test("floats with surrounding spaces parse; a space inside a number does not", async () => {
    const { ages } = await agesOf([
      "25 ",
      " 26",
      "  27.5  ",
      "28",
      "29",
      "30",
      "31",
      "32",
      "33",
      "2 5",
    ]);
    expect(ages.slice(0, 4)).toEqual([25, 26, 27.5, 28]);
    expect(ages[9]).toBeUndefined();
  });

  test("units yrs, yr, y and YEARS say years", async () => {
    for (const units of ["yrs", "yr", "y", "YEARS", " Years "]) {
      const { column } = await agesOf(["24", "36"], units);
      expect(column.status).toBe("mapped");
    }
    for (const units of ["yearly", "yrs old?", "ys", ""]) {
      const { column } = await agesOf(["24", "36"], units);
      expect(column.status).toBe("needs_curation");
    }
  });

  test("healthy control spellings: ctl, ctrl, hc, healthy-control, Healthy  Control, controls", async () => {
    const controls = [
      "ctl",
      "Ctrl",
      "HC",
      "healthy-control",
      "Healthy  Control",
      "controls",
      "healthy",
      "Healthy Controls",
    ];
    const others = ["normal", "control group", "C", "cont"];
    const values = [...controls, ...others];
    const art = await withColumn("group", values);
    const diagnoses = values.map(
      (_, i) => phenotypeOf(art, idOf(i))?.hasDiagnosis?.[0]?.identifier,
    );
    expect(diagnoses.slice(0, controls.length).every((d) => d === "ncit:C94342")).toBe(true);
    expect(diagnoses.slice(controls.length).every((d) => d === undefined)).toBe(true);
  });

  test("a table that is all N/A, NA, n/a or empty is a placeholder, whichever spelling it uses", async () => {
    for (const missing of ["N/A", "NA", "n/a", ""]) {
      const input = withTable(
        "nm000132",
        tsv(
          "participant_id\tage\tsex",
          ...Array.from({ length: 5 }, (_, i) => `${idOf(i)}\t${missing}\t${missing}`),
        ),
      );
      const art = await buildNeurobagelArtifacts(input);
      expect(docs(art).report.flags).toContain("participants_tsv_placeholder");
    }
    // One real cell anywhere and it is not a placeholder.
    const real = await buildNeurobagelArtifacts(
      withTable(
        "nm000132",
        tsv("participant_id\tage\tsex", "sub-001\tn/a\tn/a", "sub-002\t30\tn/a"),
      ),
    );
    expect(docs(real).report.flags).not.toContain("participants_tsv_placeholder");
  });

  test("a dataset DOI that is not a DOI is flagged and not linked; a padded one is trimmed; none is no flag", async () => {
    const build = async (doi: unknown) => {
      const input = loadFixture("nm000132");
      const metadata = JSON.parse(JSON.stringify(input.metadata)) as Json;
      (metadata.external_links as Json).dataset_doi = doi;
      return docs(await buildNeurobagelArtifacts({ ...input, metadata }));
    };
    const bad = await build("not a doi");
    expect(bad.report.flags).toContain("dataset_doi_unusable");
    expect(bad.description.ReferencesAndLinks).toEqual(["https://nemar.org/dataset/nm000132"]);

    const padded = await build("  10.82901/nemar.nm000132  ");
    expect(padded.report.flags).not.toContain("dataset_doi_unusable");
    expect(padded.description.ReferencesAndLinks).toEqual([
      "https://nemar.org/dataset/nm000132",
      "https://doi.org/10.82901/nemar.nm000132",
    ]);

    for (const none of [null, "", "   "]) {
      const absent = await build(none);
      expect(absent.report.flags).not.toContain("dataset_doi_unusable");
      expect(absent.description.ReferencesAndLinks).toEqual(["https://nemar.org/dataset/nm000132"]);
    }
  });

  test("keywords are trimmed, de-duplicated in order, and blanks dropped; authors are trimmed", async () => {
    const input = loadFixture("nm000132");
    const metadata = JSON.parse(JSON.stringify(input.metadata)) as Json;
    metadata.keywords = ["EEG", "EEG", " EEG ", "P3", "", "  ", "P3", "N170"].map((term) => ({
      term,
    }));
    metadata.authors = [{ name: "  Ada Lovelace " }, { name: "" }, { name: "Grace Hopper" }];
    const d = docs(await buildNeurobagelArtifacts({ ...input, metadata }));
    expect(d.description.Keywords).toEqual(["EEG", "P3", "N170"]);
    expect(d.jsonld.hasKeywords).toEqual(["EEG", "P3", "N170"]);
    expect(d.description.Authors).toEqual(["Ada Lovelace", "Grace Hopper"]);
  });

  test("a datatype directory named with free text never reaches the report", async () => {
    const input = loadFixture("nm000229");
    const metadata = JSON.parse(JSON.stringify(input.metadata)) as {
      extensions: { nemar: { bids_index: { subjects: Record<string, { modalities: Json }> } } };
    };
    const secret = "Jane Doe's scans (private)";
    metadata.extensions.nemar.bids_index.subjects["sub-02"].modalities[secret] = {};
    const art = await buildNeurobagelArtifacts({ ...input, metadata });
    expect(JSON.stringify(art.report)).not.toContain("Jane");
    expect(Object.values(art.files).join("\n")).not.toContain("Jane");
    expect(((art.report.imaging.datatypes_dropped_subjects as Json).other as number) > 0).toBe(
      true,
    );
  });
});
