/**
 * Reuse of Neurobagel's published OpenNeuro annotations (epic #1586, phase 5; ADR 0083).
 *
 * Upstream is https://github.com/neurobagel/openneuro-annotations, MIT licence.
 * The converter (scripts/neurobagel/upstream-annotations.ts) is pure; here it is driven with the
 * real upstream files kept under test/neurobagel/upstream/<commit>/ (with the licence and where
 * each came from) and the real mirror documents kept as fixtures.
 * The strongest claim is the first: the entries committed to curation.json are what the converter
 * produces, byte for byte, from those files, so the sample is not hand-edited and the command
 * that wrote it reproduces it.
 * The rest each take a real input, spoil one thing, and show the converter drops that one thing
 * and says so instead of passing it on.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIXTURE_ROOT,
  NEUROBAGEL_TEST_ROOT,
  loadCuration,
} from "../scripts/neurobagel/fixtures-io";
import { parseArgs, planMerge } from "../scripts/neurobagel/reuse-openneuro-annotations";
import {
  type Conversion,
  MergeRefusal,
  type MirrorDocuments,
  UPSTREAM,
  type UpstreamFile,
  convertUpstream,
  mergeEntries,
  sexReadingDrop,
} from "../scripts/neurobagel/upstream-annotations";
import { canonicalJson } from "../shared/neurobagel/canonical-json";
import { gitBlobShaOfBytes } from "../shared/neurobagel/git-blob";

type Json = Record<string, unknown>;
const UPSTREAM_DIR = join(NEUROBAGEL_TEST_ROOT, "upstream", UPSTREAM.commit.slice(0, 7));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const provenance = JSON.parse(readFileSync(join(UPSTREAM_DIR, "provenance.json"), "utf8")) as {
  commit: string;
  license: string;
  repo: string;
  files: Record<string, { blob_sha: string; bytes: number; sha256: string; url: string }>;
};

const reused = [...loadCuration().entries.values()].filter(
  (e) => e.evidence.review === "upstream_community",
);
const upstreamOf = (id: string): Json =>
  JSON.parse(readFileSync(join(UPSTREAM_DIR, `ds${id.slice(2)}.json`), "utf8")) as Json;
const sourceOf = (id: string): UpstreamFile => {
  const file = `ds${id.slice(2)}.json`;
  return { file, blobSha: provenance.files[file].blob_sha };
};

/** The mirror's documents exactly as captured, with the git blob SHAs of their true bytes. */
async function mirrorOf(
  id: string,
  change: (tsv: string, json: string | null) => [string, string | null] = (t, j) => [t, j],
): Promise<MirrorDocuments> {
  const dir = join(FIXTURE_ROOT, id);
  const read = (name: string): Uint8Array | null =>
    existsSync(join(dir, name)) ? new Uint8Array(readFileSync(join(dir, name))) : null;
  const tsvBytes = read("participants.tsv") as Uint8Array;
  const jsonBytes = read("participants.json");
  const [participantsTsv, participantsJson] = change(
    new TextDecoder().decode(tsvBytes),
    jsonBytes === null ? null : new TextDecoder().decode(jsonBytes),
  );
  return {
    participantsTsv,
    participantsJson,
    pins: {
      participantsTsv: await gitBlobShaOfBytes(new TextEncoder().encode(participantsTsv)),
      participantsJson:
        participantsJson === null
          ? null
          : await gitBlobShaOfBytes(new TextEncoder().encode(participantsJson)),
    },
  };
}

/** The table with one more row, in the table's own line ending (the real ones end in either, or in none). */
const withRow = (tsv: string, row: string): string => {
  const eol = tsv.includes("\r\n") ? "\r\n" : "\n";
  return `${tsv}${tsv.endsWith("\n") ? "" : eol}${row}${eol}`;
};

const convert = async (
  id: string,
  options: { date?: string; keepRedundant?: boolean } = {},
  upstream: unknown = upstreamOf(id),
  mirror?: MirrorDocuments,
): Promise<Conversion> =>
  convertUpstream(id, upstream, sourceOf(id), mirror ?? (await mirrorOf(id)), {
    date: options.date ?? "2026-10-02",
    keepRedundant: options.keepRedundant ?? false,
  });

describe("the upstream files kept as fixtures", () => {
  test("are the files upstream's pinned commit lists: size, sha256 and git blob SHA", async () => {
    expect(provenance.commit).toBe(UPSTREAM.commit);
    expect(provenance.repo).toBe(UPSTREAM.repo);
    for (const [name, doc] of Object.entries(provenance.files)) {
      const bytes = new Uint8Array(readFileSync(join(UPSTREAM_DIR, name)));
      expect(bytes.length).toBe(doc.bytes);
      expect(sha256(bytes)).toBe(doc.sha256);
      expect(await gitBlobShaOfBytes(bytes)).toBe(doc.blob_sha);
      expect(doc.url).toBe(
        `https://raw.githubusercontent.com/${UPSTREAM.repo}/${UPSTREAM.commit}/${name}`,
      );
    }
  });

  test("come with upstream's licence, which is the MIT licence and asks that its notice travel with the files", () => {
    expect(provenance.license).toBe("MIT");
    const licence = readFileSync(join(UPSTREAM_DIR, "LICENSE"), "utf8");
    expect(licence).toContain("MIT License");
    expect(licence).toContain("Neurobagel Project, Origami Lab, McGill University");
    expect(licence).toContain("copyright notice and this permission notice shall be included");
    // The notice for the entries derived from them sits beside the entries.
    const notice = readFileSync(
      join(NEUROBAGEL_TEST_ROOT, "../../shared/neurobagel/NOTICE-openneuro-annotations.txt"),
      "utf8",
    );
    expect(notice).toContain(
      "Copyright (c) 2022 - Neurobagel Project, Origami Lab, McGill University.",
    );
    expect(notice).toContain(UPSTREAM.commit);
  });

  test("hold the real annotation tool's shape: whole dictionaries, blank labels, FromInt", () => {
    for (const e of reused) expect(Object.keys(upstreamOf(e.datasetId)).length).toBeGreaterThan(1);
    const texts = reused.map((e) => JSON.stringify(upstreamOf(e.datasetId)));
    expect(texts.some((t) => t.includes('"Label":""'))).toBe(true);
    expect(texts.some((t) => t.includes("nb:FromInt"))).toBe(true);
  });
});

describe("the sample committed to curation.json", () => {
  test("has between 5 and 10 reused entries, each of them for a mirror with a captured fixture", () => {
    expect(reused.length).toBeGreaterThanOrEqual(5);
    expect(reused.length).toBeLessThanOrEqual(10);
    for (const e of reused) expect(e.datasetId).toMatch(/^on\d{6}$/);
  });

  test("covers every kind of column the reuse can carry", () => {
    const kinds = new Set(reused.flatMap((e) => e.columns.map((c) => c.kind)));
    expect([...kinds].sort()).toEqual(["age", "assessment", "diagnosis", "sex"]);
  });

  for (const entry of reused) {
    test(`${entry.datasetId}: is what the converter writes from the committed upstream file and mirror fixture, byte for byte`, async () => {
      const out = await convert(entry.datasetId, { date: entry.evidence.date });
      expect(out.skip).toBeNull();
      const committed = JSON.parse(
        readFileSync(join(NEUROBAGEL_TEST_ROOT, "../../shared/neurobagel/curation.json"), "utf8"),
      ) as { datasets: Record<string, unknown> };
      expect(canonicalJson(out.entry as never)).toBe(
        canonicalJson(committed.datasets[entry.datasetId] as never),
      );
    });

    test(`${entry.datasetId}: says it is upstream's annotation, not NEMAR's review, and names the file and its blob`, () => {
      expect(entry.evidence.review).toBe("upstream_community");
      expect(entry.evidence.source).toContain(`${UPSTREAM.repo}@${UPSTREAM.commit.slice(0, 7)}`);
      expect(entry.evidence.source).toContain(`ds${entry.datasetId.slice(2)}.json`);
      expect(entry.evidence.source).toContain(sourceOf(entry.datasetId).blobSha.slice(0, 7));
      expect(entry.evidence.source).toContain("MIT licence");
      expect(entry.evidence.reviewer).toContain("not reviewed");
    });
  }

  test("converting twice gives the same bytes", async () => {
    const a = await convert("on003568");
    const b = await convert("on003568");
    expect(canonicalJson(a.entry as never)).toBe(canonicalJson(b.entry as never));
  });
});

describe("the converter keeps only what fits, and counts what it drops", () => {
  test("a value the annotation never saw: that column is dropped, the other columns of the dataset stay", async () => {
    // on003568 annotates group (diagnosis) and participant_age.
    const mirror = await mirrorOf("on003568", (tsv, json) => [
      withRow(tsv, "sub-99999\t20\tMALE\tNEW GROUP"),
      json,
    ]);
    const out = await convert("on003568", {}, undefined, mirror);
    expect(out.dropped).toEqual({ levels_do_not_cover_table: 1 });
    expect(Object.keys((out.entry?.columns as Json) ?? {})).toEqual(["participant_age"]);
  });

  test("a column the table does not have", async () => {
    // on003474 annotates sex, BDI and STAI.
    const mirror = await mirrorOf("on003474", (tsv, json) => [
      tsv.replace("sex", "SEX_AT_BIRTH"),
      json,
    ]);
    const out = await convert("on003474", {}, undefined, mirror);
    expect(out.dropped).toEqual({ column_not_in_table: 1 });
    expect(Object.keys((out.entry?.columns as Json) ?? {}).sort()).toEqual(["BDI", "STAI"]);
  });

  test("a term upstream uses that the pinned vocabulary does not have", async () => {
    const upstream = JSON.parse(
      JSON.stringify(upstreamOf("on003568")).replace("snomed:370143000", "snomed:1"),
    );
    const out = await convert("on003568", {}, upstream);
    expect(out.dropped).toEqual({ term_not_pinned: 1 });
    expect(Object.keys((out.entry?.columns as Json) ?? {})).toEqual(["participant_age"]);
  });

  test("an assessment tool that is not in the pinned vocabulary", async () => {
    const upstream = JSON.parse(
      JSON.stringify(upstreamOf("on003474")).replaceAll("snomed:273306008", "snomed:2"),
    );
    const out = await convert("on003474", {}, upstream);
    expect(out.dropped).toEqual({ term_not_pinned: 1 });
    expect(Object.keys((out.entry?.columns as Json) ?? {}).sort()).toEqual(["STAI", "sex"]);
  });

  test("labels are the pinned ones, whatever upstream wrote", async () => {
    const upstream = JSON.parse(
      JSON.stringify(upstreamOf("on003568")).replaceAll('"Label": ""', '"Label": "whatever"'),
    );
    const out = await convert("on003568", {}, upstream);
    const expected = await convert("on003568");
    expect(canonicalJson(out.entry as never)).toBe(canonicalJson(expected.entry as never));
  });

  test("an age written nb:FromInt is read as nb:FromFloat, and the entry says FromFloat", async () => {
    const withInt = reused.find((e) =>
      JSON.stringify(upstreamOf(e.datasetId)).includes("nb:FromInt"),
    );
    expect(withInt).toBeDefined();
    if (withInt === undefined) return;
    const out = await convert(withInt.datasetId, { keepRedundant: true });
    expect(out.notes.age_format_int_as_float).toBeGreaterThan(0);
    expect(JSON.stringify(out.entry)).not.toContain("FromInt");
  });

  test("a repeated missing value is said once", async () => {
    const upstream = JSON.parse(JSON.stringify(upstreamOf("on003568")));
    upstream.participant_age.Annotations.MissingValues = ["", "n/a", "n/a", " "];
    const out = await convert("on003568", {}, upstream);
    expect(out.notes.missing_values_deduped).toBe(1);
    const age = (out.entry?.columns as Json).participant_age as Json;
    expect(age.MissingValues).toEqual(["", "n/a", " "]);
  });

  test("ValueRange is not carried: the table, not upstream, says what the range is", async () => {
    const upstream = JSON.parse(JSON.stringify(upstreamOf("on003568")));
    upstream.participant_age.Annotations.ValueRange = { Min: 1, Max: 2 };
    const out = await convert("on003568", {}, upstream);
    // The column is kept (upstream's range is not what the table has, and is not carried), and
    // nothing of the range reaches the entry.
    expect(Object.keys((out.entry?.columns as Json) ?? {})).toContain("participant_age");
    expect(JSON.stringify(out.entry?.columns)).not.toContain("ValueRange");
  });

  test("a second sex column is dropped: a participant has one sex, as bagel takes the first", async () => {
    const upstream = JSON.parse(JSON.stringify(upstreamOf("on004635")));
    upstream.Gender2 = { ...upstream.Gender };
    const mirror = await mirrorOf("on004635", (tsv, json) => [
      tsv
        .split("\n")
        .map((l, i) => (l === "" ? l : `${l}\t${i === 0 ? "Gender2" : l.split("\t")[2]}`))
        .join("\n"),
      json,
    ]);
    const out = await convert("on004635", {}, upstream, mirror);
    expect(out.dropped.second_sex_column).toBe(1);
  });

  test("a column that is not about sex, age, diagnosis or an assessment tool is not carried", async () => {
    const upstream = JSON.parse(JSON.stringify(upstreamOf("on004635")));
    upstream.Gender2 = {
      Annotations: {
        IsAbout: { TermURL: "nb:SubjectGroup", Label: "" },
        Levels: {},
        VariableType: "Categorical",
      },
    };
    const out = await convert("on004635", {}, upstream);
    expect(out.dropped.unsupported_variable).toBe(1);
  });

  test("a dataset with nothing curatable, or with every column dropped, has no entry and says why", async () => {
    expect((await convert("on003568", {}, [])).skip).toBe("upstream_not_a_dictionary");
    expect((await convert("on003568", {}, { participant_id: { Description: "x" } })).skip).toBe(
      "no_annotated_column",
    );
    const identifiers = {
      participant_id: {
        Annotations: {
          IsAbout: { TermURL: "nb:ParticipantID", Label: "" },
          VariableType: "Identifier",
        },
      },
    };
    expect((await convert("on003568", {}, identifiers)).skip).toBe("no_annotated_column");
    const other = {
      ...identifiers,
      g: {
        Annotations: {
          IsAbout: { TermURL: "nb:SubjectGroup", Label: "" },
          Levels: {},
          VariableType: "Categorical",
        },
      },
    };
    expect((await convert("on003568", {}, other)).skip).toBe("no_curatable_column");
    const emptyLevels = {
      sex: {
        Annotations: {
          IsAbout: { TermURL: "nb:Sex", Label: "" },
          Levels: {},
          VariableType: "Categorical",
        },
      },
    };
    const dropped = await convert("on003568", {}, emptyLevels);
    expect(dropped.skip).toBe("all_columns_dropped");
    expect(dropped.dropped).toEqual({ levels_empty: 1 });
  });

  test("a mirror table that cannot be read gives no entry", async () => {
    const mirror = await mirrorOf("on003568", () => ['"unterminated\n', null]);
    expect((await convert("on003568", {}, undefined, mirror)).skip).toBe("mirror_table_unreadable");
  });

  test("columns the mechanical rules already map to the same values are left out, and counted, when asked", async () => {
    // on003568's `sex` column holds MALE and FEMALE, which the mechanical rule maps; upstream annotates it too.
    const all = await convert("on003568", { keepRedundant: true });
    const lean = await convert("on003568");
    expect(all.redundant).toBe(0);
    expect(lean.redundant).toBeGreaterThan(0);
    expect(all.kept).toBe(lean.kept + lean.redundant);
    expect(Object.keys((all.entry?.columns as Json) ?? {})).toContain("sex");
    expect(Object.keys((lean.entry?.columns as Json) ?? {})).not.toContain("sex");
  });

  test("pins that are not those of the documents handed over fail the converter's last check", async () => {
    const mirror = await mirrorOf("on003568");
    const wrong: MirrorDocuments = {
      ...mirror,
      pins: { ...mirror.pins, participantsTsv: "0".repeat(40) },
    };
    const out = await convert("on003568", {}, undefined, wrong);
    expect(out.skip).toBe("entry_failed_final_check");
    expect(out.entry).toBeNull();
  });

  test("a mirror whose table changed gets an entry pinned to the NEW table, so the old one is not reused for it", async () => {
    const now = await mirrorOf("on003568");
    const later = await mirrorOf("on003568", (tsv, json) => [
      withRow(tsv, "sub-99998\t30\tMALE\tHV"),
      json,
    ]);
    const a = await convert("on003568", {}, undefined, now);
    const b = await convert("on003568", {}, undefined, later);
    expect((a.entry?.pins as Json).participants_tsv).not.toBe(
      (b.entry?.pins as Json).participants_tsv,
    );
    expect((b.entry?.pins as Json).participants_tsv).toBe(later.pins.participantsTsv);
  });
});

describe("an age column gets the mechanical rule's checks before it is reused", () => {
  test("on004635's Age is in months (its participants.json says so, for 48 infants): dropped, and the real Gender stays", async () => {
    const out = await convert("on004635");
    expect(out.dropped).toEqual({ age_units_not_years: 1 });
    expect(Object.keys((out.entry?.columns as Json) ?? {})).toEqual(["Gender"]);
    expect(readFileSync(join(FIXTURE_ROOT, "on004635", "participants.json"), "utf8")).toContain(
      "months",
    );
  });

  test("an age whose participants.json declares weeks, days or months is dropped; years, or nothing declared, is kept", async () => {
    // on003568 annotates `participant_age` and has no participants.json of its own.
    const withUnits = async (units: string | null) => {
      const json = units === null ? null : JSON.stringify({ participant_age: { Units: units } });
      const mirror = await mirrorOf("on003568", (tsv) => [tsv, json]);
      return convert("on003568", {}, undefined, mirror);
    };
    for (const units of ["weeks", "days", "months"]) {
      const out = await withUnits(units);
      expect(out.dropped).toEqual({ age_units_not_years: 1 });
      expect(Object.keys((out.entry?.columns as Json) ?? {})).toEqual(["group"]);
    }
    for (const units of ["years", null]) {
      const out = await withUnits(units);
      expect(out.dropped).toEqual({});
      expect(Object.keys((out.entry?.columns as Json) ?? {}).sort()).toEqual([
        "group",
        "participant_age",
      ]);
    }
  });

  test("an age column that is mostly zeros is dropped, like the mechanical rule's placeholder", async () => {
    const mirror = await mirrorOf("on003568", (tsv, json) => [
      tsv.replace(/^(sub-\d+\t)\d+(\t)/gm, "$10$2"),
      json,
    ]);
    const out = await convert("on003568", {}, undefined, mirror);
    expect(out.dropped).toEqual({ age_zero_placeholder: 1 });
    expect(Object.keys((out.entry?.columns as Json) ?? {})).toEqual(["group"]);
  });
});

describe("an empty upstream level map never becomes a column", () => {
  test("a diagnosis column with Levels {} and every value missing would withdraw the mechanical healthy control from unreviewed data, so it is dropped", async () => {
    const upstream = JSON.parse(JSON.stringify(upstreamOf("on003568")));
    upstream.group.Annotations.Levels = {};
    upstream.group.Annotations.MissingValues = ["HV", "MDD"];
    const out = await convert("on003568", {}, upstream);
    expect(out.dropped).toEqual({ levels_empty: 1 });
    expect(Object.keys((out.entry?.columns as Json) ?? {})).toEqual(["participant_age"]);
    // And alone, it leaves no entry at all.
    const only = {
      group: upstream.group,
    };
    const none = await convert("on003568", {}, only);
    expect(none.skip).toBe("all_columns_dropped");
    expect(none.entry).toBeNull();
  });
});

/**
 * The owner's rule (2026-10-02, ADR 0083 amendment): Neurobagel's term is sex, not gender, so a
 * column NOT named `sex` is read as sex only when the dataset's own participants.json describes it
 * as sex.
 * Every case here is a real document: the descriptions are the four real ones of on001787,
 * on004635, on004574 and on006861, and each variation changes one thing in a real participants.json.
 */
describe("a sex column not named sex is read as sex only when its own description says sex", () => {
  const descriptionIn = (id: string, column: string): string | null => {
    const path = join(FIXTURE_ROOT, id, "participants.json");
    if (!existsSync(path)) return null;
    const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, Json | undefined>;
    return (doc[column]?.Description as string | undefined) ?? null;
  };
  /** The real participants.json of `id` with the Description of `column` replaced (undefined removes it). */
  const redescribed = (id: string, column: string, description: string | undefined) =>
    mirrorOf(id, (tsv, json) => {
      const doc = JSON.parse(json ?? "{}") as Record<string, Json>;
      if (description === undefined) {
        const { Description: _removed, ...rest } = doc[column];
        doc[column] = rest;
      } else {
        doc[column] = { ...doc[column], Description: description };
      }
      return [tsv, JSON.stringify(doc)];
    });
  const columnsOf = (out: Conversion): string[] =>
    Object.keys((out.entry?.columns as Json) ?? {}).sort();

  const REAL = [
    { id: "on001787", column: "gender", says: "sex of the participant", kept: true },
    {
      id: "on004635",
      column: "Gender",
      says: "Participant biological sex assigned at birth",
      kept: true,
    },
    { id: "on004574", column: "GENDER", says: "Gender of the participant", kept: false },
    {
      id: "on006861",
      column: "Gender",
      says: "Participant gender. Values: Female or Male.",
      kept: false,
    },
  ] as const;

  describe("the four real descriptions", () => {
    for (const { id, column, says, kept } of REAL) {
      test(`${id} ${column}: participants.json says "${says}", so the column is ${kept ? "read as sex" : "left out"}`, async () => {
        expect(descriptionIn(id, column)).toBe(says);
        expect(sexReadingDrop(column, says)).toBe(kept ? null : "sex_described_as_gender");
        const out = await convert(id);
        expect(columnsOf(out).includes(column)).toBe(kept);
        expect<number | undefined>(out.dropped.sex_described_as_gender).toBe(kept ? undefined : 1);
        expect(out.dropped.sex_not_described_as_sex).toBeUndefined();
        expect(out.kept).toBe(columnsOf(out).length);
      });
    }

    test("a column left out costs the entry that column and nothing else", async () => {
      expect(columnsOf(await convert("on004574"))).toEqual(["MOCA", "UPDRS"]);
      expect(columnsOf(await convert("on006861"))).toEqual(["UCLA_R", "UCLA_R_screening"]);
      expect(columnsOf(await convert("on001787"))).toEqual(["gender"]);
      expect(columnsOf(await convert("on004635"))).toEqual(["Gender"]);
      // The other drop reasons of the same datasets are untouched.
      expect((await convert("on004635")).dropped).toEqual({ age_units_not_years: 1 });
    });

    test("a dataset left with no column to keep because its gender column was left out has no entry, and says why", async () => {
      const out = await convert(
        "on001787",
        {},
        undefined,
        await redescribed("on001787", "gender", "gender of the participant"),
      );
      // The only other annotated column, age, is one the mechanical rules already read.
      expect(out.skip).toBe("only_redundant_columns");
      expect(out.entry).toBeNull();
      expect(out.dropped).toEqual({ sex_described_as_gender: 1 });
    });
  });

  describe("one change to a real participants.json, case by case", () => {
    test("the description says sex: a gender column is kept, and the evidence quotes the words", async () => {
      const mirror = await redescribed("on004574", "GENDER", "Sex of the participant");
      const out = await convert("on004574", {}, undefined, mirror);
      expect(columnsOf(out)).toEqual(["GENDER", "MOCA", "UPDRS"]);
      expect(out.dropped).toEqual({});
      expect(JSON.stringify(out.entry)).toContain(
        'GENDER is read as Sex (participants.json says: \\"Sex of the participant\\")',
      );
    });

    test("the description says gender: left out, whatever the values and Levels look like", async () => {
      // The real Levels of on004574's GENDER are Female and Male, and still do not make it sex.
      const mirror = await redescribed("on004574", "GENDER", "Gender identity of the participant");
      const out = await convert("on004574", {}, undefined, mirror);
      expect(columnsOf(out)).toEqual(["MOCA", "UPDRS"]);
      expect(out.dropped).toEqual({ sex_described_as_gender: 1 });
    });

    test("the description is absent: left out, because nothing in the sidecar supports sex", async () => {
      const noDescription = await redescribed("on004574", "GENDER", undefined);
      const out = await convert("on004574", {}, undefined, noDescription);
      expect(columnsOf(out)).toEqual(["MOCA", "UPDRS"]);
      expect(out.dropped).toEqual({ sex_not_described_as_sex: 1 });
      // The column is not in participants.json at all.
      const noColumn = await mirrorOf("on004574", (tsv, json) => {
        const doc = JSON.parse(json ?? "{}") as Record<string, Json>;
        const { GENDER: _removed, ...rest } = doc;
        return [tsv, JSON.stringify(rest)];
      });
      const bare = await convert("on004574", {}, undefined, noColumn);
      expect(columnsOf(bare)).toEqual(["MOCA", "UPDRS"]);
      expect(bare.dropped).toEqual({ sex_not_described_as_sex: 1 });
    });

    test("participants.json is absent: left out, the other columns stay and pin the file as absent", async () => {
      const mirror = await mirrorOf("on004574", (tsv) => [tsv, null]);
      const out = await convert("on004574", {}, undefined, mirror);
      expect(columnsOf(out)).toEqual(["MOCA", "UPDRS"]);
      expect(out.dropped).toEqual({ sex_not_described_as_sex: 1 });
      expect((out.entry?.pins as Json).participants_json).toBeNull();
    });

    test("a description that says neither word leaves the column out, and the words are whole words", async () => {
      for (const description of [
        "Participant category",
        "Sexual maturity of the participant",
        "Essex of residence",
        "",
      ]) {
        const mirror = await redescribed("on004574", "GENDER", description);
        const out = await convert("on004574", {}, undefined, mirror);
        expect(out.dropped).toEqual({ sex_not_described_as_sex: 1 });
        expect(columnsOf(out)).toEqual(["MOCA", "UPDRS"]);
      }
    });

    test("a description that names both says gender: left out", async () => {
      for (const description of ["Sex or gender of the participant", "Gender (sex at birth)"]) {
        const mirror = await redescribed("on004574", "GENDER", description);
        const out = await convert("on004574", {}, undefined, mirror);
        expect(out.dropped).toEqual({ sex_described_as_gender: 1 });
        expect(columnsOf(out)).toEqual(["MOCA", "UPDRS"]);
      }
    });

    test("the match ignores case, and gender is found inside a longer word", async () => {
      const upper = await redescribed("on004574", "GENDER", "SEX OF THE PARTICIPANT");
      expect(columnsOf(await convert("on004574", {}, undefined, upper))).toContain("GENDER");
      const shouted = await redescribed("on004574", "GENDER", "GENDER OF THE PARTICIPANT");
      expect((await convert("on004574", {}, undefined, shouted)).dropped).toEqual({
        sex_described_as_gender: 1,
      });
      const longer = await redescribed("on004574", "GENDER", "Sex, including transgender status");
      expect((await convert("on004574", {}, undefined, longer)).dropped).toEqual({
        sex_described_as_gender: 1,
      });
    });

    test("the sex a column's own Description names is the only evidence: a Levels text does not count", async () => {
      // on004574's real Levels say Female and Male; give the Description nothing and put sex in a Levels text.
      const mirror = await mirrorOf("on004574", (tsv, json) => {
        const doc = JSON.parse(json ?? "{}") as Record<string, Json>;
        doc.GENDER = { Levels: { F: "female sex", M: "male sex" } };
        return [tsv, JSON.stringify(doc)];
      });
      const out = await convert("on004574", {}, undefined, mirror);
      expect(out.dropped).toEqual({ sex_not_described_as_sex: 1 });
    });
  });

  describe("a column literally named sex is unchanged by the rule", () => {
    test("on003474's sex column stays with its real description, with a description that says gender, and with none", async () => {
      expect(descriptionIn("on003474", "sex")).toBe("sex of the participant");
      for (const description of [
        "sex of the participant",
        "gender of the participant",
        undefined,
      ]) {
        const mirror = await redescribed("on003474", "sex", description);
        const out = await convert("on003474", {}, undefined, mirror);
        expect(columnsOf(out)).toEqual(["BDI", "STAI", "sex"]);
        expect(out.dropped).toEqual({});
      }
      const absent = await mirrorOf("on003474", (tsv) => [tsv, null]);
      expect(columnsOf(await convert("on003474", {}, undefined, absent))).toContain("sex");
    });

    test("the name is matched as the mechanical rule matches it: any case, padding ignored", () => {
      for (const name of ["sex", "Sex", "SEX", " sex ", "\tSex"]) {
        expect(sexReadingDrop(name, null)).toBeNull();
        expect(sexReadingDrop(name, "gender of the participant")).toBeNull();
      }
      for (const name of ["gender", "Gender", "GENDER", "sex_at_birth", "biological_sex", "sexe"]) {
        expect(sexReadingDrop(name, null)).toBe("sex_not_described_as_sex");
      }
    });

    test("a sex column the mechanical rules already read is still kept on request, with no participants.json at all", async () => {
      // on003568 has a `sex` column of MALE and FEMALE and no participants.json.
      const out = await convert("on003568", { keepRedundant: true });
      expect(columnsOf(out)).toContain("sex");
      expect(out.dropped).toEqual({});
    });
  });

  describe("a dataset with both a sex and a gender column maps each by its own description", () => {
    /** on003474 with a `gender` column of F and M, annotated as sex, ahead of the real `sex` column. */
    const bothColumns = async (description: string) => {
      const upstream = JSON.parse(JSON.stringify(upstreamOf("on003474"))) as Json;
      const gender = (upstreamOf("on001787") as Json).gender;
      const ordered = { gender, ...upstream };
      const mirror = await mirrorOf("on003474", (tsv, json) => {
        const eol = tsv.includes("\r\n") ? "\r\n" : "\n";
        const lines = tsv.split(eol);
        const withColumn = lines.map((line, i) =>
          line === "" ? line : `${line}\t${i === 0 ? "gender" : i % 2 === 0 ? "F" : "M"}`,
        );
        const doc = JSON.parse(json ?? "{}") as Record<string, Json>;
        doc.gender = { Description: description };
        return [withColumn.join(eol), JSON.stringify(doc)];
      });
      return convert("on003474", {}, ordered, mirror);
    };

    test("gender described as gender is left out and the real sex column still takes the sex slot", async () => {
      const out = await bothColumns("gender of the participant");
      expect(columnsOf(out)).toEqual(["BDI", "STAI", "sex"]);
      // Not `second_sex_column`: a column left out never claimed the slot.
      expect(out.dropped).toEqual({ sex_described_as_gender: 1 });
      expect(out.keptByKind).toEqual({ assessment: 2, sex: 1 });
    });

    test("gender described as sex ahead of the sex column is the one sex column, as bagel takes the first", async () => {
      const out = await bothColumns("sex of the participant");
      expect(columnsOf(out)).toEqual(["BDI", "STAI", "gender"]);
      expect(out.dropped).toEqual({ second_sex_column: 1 });
    });

    test("gender with no description at all is left out too", async () => {
      const out = await bothColumns("");
      expect(columnsOf(out)).toEqual(["BDI", "STAI", "sex"]);
      expect(out.dropped).toEqual({ sex_not_described_as_sex: 1 });
    });
  });

  describe("the committed sample", () => {
    test("every reused entry's sex column not named sex has a description saying sex in its own fixture", () => {
      let checked = 0;
      for (const e of reused) {
        for (const c of e.columns) {
          if (c.kind !== "sex" || c.name.trim().toLowerCase() === "sex") continue;
          expect(sexReadingDrop(c.name, descriptionIn(e.datasetId, c.name))).toBeNull();
          checked++;
        }
      }
      // on001787's gender and on004635's Gender.
      expect(checked).toBe(2);
    });

    test("on004574 and on006861 keep their assessment items and no sex column", () => {
      const names = (id: string) =>
        (loadCuration().entries.get(id)?.columns ?? []).map((c) => c.name);
      expect(names("on004574").sort()).toEqual(["MOCA", "UPDRS"]);
      expect(names("on006861").sort()).toEqual(["UCLA_R", "UCLA_R_screening"]);
    });
  });
});

describe("the evidence of a reused entry carries what a spot-check needs", () => {
  const sourceOfEntry = (id: string): string =>
    loadCuration().entries.get(id)?.evidence.source ?? "";

  test("a gender column read as sex says so, with what participants.json says about it", () => {
    for (const id of ["on004635", "on001787"]) {
      expect(sourceOfEntry(id)).toMatch(/is read as Sex \(participants\.json says: "/);
    }
    expect(sourceOfEntry("on004635")).toContain(
      'Gender is read as Sex (participants.json says: "Participant biological sex assigned at birth")',
    );
    expect(sourceOfEntry("on001787")).toContain(
      'gender is read as Sex (participants.json says: "sex of the participant")',
    );
  });

  test("a gender column that is NOT read as sex leaves no such claim behind in the evidence", () => {
    for (const id of ["on004574", "on006861"]) {
      expect(sourceOfEntry(id)).not.toContain("is read as Sex");
    }
  });

  test("numeric sex codes say whether participants.json confirms them, and they do for on003474", async () => {
    expect(sourceOfEntry("on003474")).toContain(
      "numeric sex codes are confirmed by the Levels of participants.json",
    );
    // The same documents with the Levels describing the codes the other way round: not confirmed.
    const swapped = await mirrorOf("on003474", (tsv, json) => [
      tsv,
      (json ?? "")
        .replace('"one": "female"', '"one": "male"')
        .replace('"two": "male"', '"two": "female"'),
    ]);
    const out = await convert("on003474", {}, undefined, swapped);
    expect(out.entry && JSON.stringify(out.entry)).toContain(
      "are NOT confirmed by participants.json",
    );
    // And with no Levels at all.
    const none = await mirrorOf("on003474", (tsv, json) => [
      tsv,
      JSON.stringify({ ...(JSON.parse(json ?? "{}") as Json), sex: { Description: "sex" } }),
    ]);
    const bare = await convert("on003474", {}, undefined, none);
    expect(JSON.stringify(bare.entry)).toContain("are NOT confirmed by participants.json");
  });

  test("numeric codes are confirmed only if EVERY code is: one code the Levels do not describe is not confirmed", async () => {
    const half = await mirrorOf("on003474", (tsv, json) => [
      tsv,
      (json ?? "").replace('"two": "male"', '"two": "unknown"'),
    ]);
    const out = await convert("on003474", {}, undefined, half);
    expect(JSON.stringify(out.entry)).toContain("are NOT confirmed by participants.json");
    expect(JSON.stringify(out.entry)).not.toContain("are confirmed by the Levels");
  });

  test('"female" does not confirm a code mapped to Male: the sex is matched as a whole word', async () => {
    // The dataset says one is female and two is male. Upstream maps BOTH codes to Male, so code 1
    // contradicts its own description, and the word `male` inside `female` must not hide that.
    const upstream = JSON.parse(JSON.stringify(upstreamOf("on003474")));
    const male = { TermURL: "snomed:248153007", Label: "" };
    upstream.sex.Annotations.Levels = { "1": male, "2": male };
    const out = await convert("on003474", {}, upstream);
    expect(JSON.stringify(out.entry)).toContain("are NOT confirmed by participants.json");
    // The same documents with the codes mapped as the dataset describes them are confirmed.
    const fine = await convert("on003474");
    expect(JSON.stringify(fine.entry)).toContain("are confirmed by the Levels");
  });

  test("an age column says which units participants.json declares, or that years are assumed", async () => {
    expect(sourceOfEntry("on003568")).toContain(
      "participant_age age units: none declared, years assumed",
    );
    const mirror = await mirrorOf("on003568", (tsv) => [
      tsv,
      JSON.stringify({ participant_age: { Units: "years" } }),
    ]);
    const out = await convert("on003568", {}, undefined, mirror);
    expect(JSON.stringify(out.entry)).toContain(
      'participant_age age units: \\"years\\" in participants.json',
    );
  });
});

describe("a regeneration never overwrites what a person wrote", () => {
  const committed = JSON.parse(
    readFileSync(join(NEUROBAGEL_TEST_ROOT, "../../shared/neurobagel/curation.json"), "utf8"),
  ) as { datasets: Record<string, Json>; format: number };
  const authored = Object.entries(committed.datasets)
    .filter(([, e]) => (e.evidence as Json).review !== "upstream_community")
    .map(([id]) => id);

  test("a merge into an entry of review `author` is refused, naming the entry and the review", () => {
    expect(() => mergeEntries(committed, { on004166: { columns: {} } })).toThrow(MergeRefusal);
    try {
      mergeEntries(committed, { on004166: { columns: {} } });
    } catch (error) {
      expect((error as MergeRefusal).entries).toEqual([
        { datasetId: "on004166", review: "author" },
      ]);
      expect((error as Error).message).toContain("on004166 (author)");
      expect((error as Error).message).toContain("--skip-authored");
    }
    // domain_expert is a person's review too.
    const expert = {
      ...committed,
      datasets: {
        ...committed.datasets,
        on003568: { ...committed.datasets.on003568, evidence: { review: "domain_expert" } },
      },
    };
    expect(() => mergeEntries(expert, { on003568: { columns: {} } })).toThrow(MergeRefusal);
  });

  test("the refusal names EVERY entry in the way, not only the first", () => {
    const generated = Object.fromEntries(authored.map((id) => [id, { marker: id }]));
    expect(authored.length).toBeGreaterThan(5);
    try {
      mergeEntries(committed, generated);
      throw new Error("the merge was not refused");
    } catch (error) {
      expect(error).toBeInstanceOf(MergeRefusal);
      const message = (error as Error).message;
      expect(message).toContain(`${authored.length} existing entries were not reviewed`);
      for (const id of authored) expect(message).toContain(`${id} (author)`);
    }
  });

  test("an entry whose review cannot be read is refused, not overwritten", () => {
    const odd = { ...committed, datasets: { ...committed.datasets, on003568: "not an entry" } };
    expect(() => mergeEntries(odd, { on003568: {} })).toThrow("on003568 ((unreadable))");
  });

  test("--skip-authored leaves every authored entry alone, merges the rest, and says what it skipped", () => {
    const fresh = { marker: "fresh" };
    const generated: Record<string, unknown> = { on003568: fresh, on009999: fresh };
    for (const id of authored) generated[id] = { marker: "would overwrite" };
    const result = mergeEntries(committed, generated, { skipAuthored: true });
    expect(result.skipped.map((e) => e.datasetId).sort()).toEqual([...authored].sort());
    expect(result.replaced).toEqual(["on003568"]);
    expect(result.added).toEqual(["on009999"]);
    for (const id of authored) expect(result.file.datasets[id]).toBe(committed.datasets[id]);
    expect(result.file.datasets.on003568).toBe(fresh);
    expect(result.file.datasets.on009999).toBe(fresh);
  });

  test("a reused entry is refreshed, a new id is added, and every other entry is left exactly as it is", () => {
    const fresh = { marker: "fresh" };
    const merged = mergeEntries(committed, { on003568: fresh, on009999: fresh });
    expect(merged.skipped).toEqual([]);
    expect(merged.file.datasets.on003568).toBe(fresh);
    expect(merged.file.datasets.on009999).toBe(fresh);
    for (const id of Object.keys(committed.datasets)) {
      if (id !== "on003568") expect(merged.file.datasets[id]).toBe(committed.datasets[id]);
    }
    expect(committed.datasets.on003568).not.toBe(fresh);
    expect(merged.file.format).toBe(1);
  });

  test("planMerge reads the real file and writes nothing; the refusal and the skip both hold there", () => {
    const dir = mkdtempSync(join(tmpdir(), "nemar-merge-"));
    try {
      const path = join(dir, "curation.json");
      const text = readFileSync(
        join(NEUROBAGEL_TEST_ROOT, "../../shared/neurobagel/curation.json"),
        "utf8",
      );
      writeFileSync(path, text);
      const generated = { on004166: { marker: "x" }, on003568: { marker: "y" } };
      expect(() => planMerge(path, generated)).toThrow(MergeRefusal);
      const planned = planMerge(path, generated, { skipAuthored: true });
      expect(planned.skipped).toEqual([{ datasetId: "on004166", review: "author" }]);
      expect(planned.replaced).toEqual(["on003568"]);
      // Planning never writes.
      expect(readFileSync(path, "utf8")).toBe(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the command line leaves redundant columns out by default, and --keep-redundant opts out", () => {
    expect(parseArgs(["on003568"]).keepRedundant).toBe(false);
    expect(parseArgs(["--keep-redundant", "on003568"]).keepRedundant).toBe(true);
    expect(parseArgs(["on003568"]).skipAuthored).toBe(false);
    expect(parseArgs(["--skip-authored", "--merge-into", "x.json", "on003568"]).skipAuthored).toBe(
      true,
    );
    expect(parseArgs(["--merge-into", "x.json", "on003568"]).ids).toEqual(["on003568"]);
  });
});
