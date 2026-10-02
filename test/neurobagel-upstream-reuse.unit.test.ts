/**
 * Reuse of Neurobagel's published OpenNeuro annotations (epic #1586, phase 5; ADR 0084).
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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FIXTURE_ROOT,
  NEUROBAGEL_TEST_ROOT,
  loadCuration,
} from "../scripts/neurobagel/fixtures-io";
import {
  type Conversion,
  type MirrorDocuments,
  UPSTREAM,
  type UpstreamFile,
  convertUpstream,
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
  options: { date?: string; skipRedundant?: boolean } = {},
  upstream: unknown = upstreamOf(id),
  mirror?: MirrorDocuments,
): Promise<Conversion> =>
  convertUpstream(id, upstream, sourceOf(id), mirror ?? (await mirrorOf(id)), {
    date: options.date ?? "2026-10-02",
    skipRedundant: options.skipRedundant ?? true,
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
    const mirror = await mirrorOf("on004635", (tsv, json) => [
      tsv.replace("Gender", "Sex_at_birth"),
      json,
    ]);
    const out = await convert("on004635", {}, undefined, mirror);
    expect(out.dropped).toEqual({ column_not_in_table: 1 });
    expect(Object.keys((out.entry?.columns as Json) ?? {})).toEqual(["Age"]);
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
    const out = await convert(withInt.datasetId, { skipRedundant: false });
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
    const all = await convert("on003568", { skipRedundant: false });
    const lean = await convert("on003568", { skipRedundant: true });
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
