/**
 * Turn Neurobagel's published OpenNeuro annotation of a dataset into a curation entry for
 * NEMAR's mirror of it (epic #1586, phase 5; ADR 0084).
 *
 * Source: https://github.com/neurobagel/openneuro-annotations, MIT licence (see
 * test/neurobagel/upstream/LICENSE), one `dsNNNNNN.json` per OpenNeuro dataset, each a BIDS data
 * dictionary whose columns carry the annotation tool's `Annotations` block.
 * NEMAR's mirror `onNNNNNN` is OpenNeuro's `dsNNNNNN` (backend/src/services/auto-import.ts).
 *
 * This module is the PURE half: it takes the upstream JSON and the mirror's own documents and
 * returns an entry or a reason for none.
 * It reads no file and no network; reuse-openneuro-annotations.ts does that.
 * It never trusts upstream.
 * A column is kept only if
 *   - it is about Sex, Age, Diagnosis or an assessment tool (the four kinds curation carries);
 *   - every term it uses is in the PINNED vocabulary (upstream labels are mostly blank and are
 *     rewritten from the pinned one; `nb:FromInt` is read as `nb:FromFloat`, which parses the
 *     same cells);
 *   - the loader accepts it (`curatedColumnFrom`);
 *   - the binder accepts it against the mirror's CURRENT participants.tsv (`bindCuratedColumn`):
 *     the column exists, and the annotation covers every value the table holds.
 * Whatever fails is dropped and counted, never repaired.
 * The entry pins the mirror's files, so if the mirror changes the entry goes stale; it does not
 * silently describe a table it never saw.
 *
 * Pure: no I/O.
 */

import { canonicalJson } from "../../shared/neurobagel/canonical-json";
import { CurationError, curatedColumnFrom, parseCuration } from "../../shared/neurobagel/curation";
import {
  type BoundColumn,
  bindCuratedColumn,
  bindCuration,
} from "../../shared/neurobagel/curation-bind";
import type { CuratedColumn } from "../../shared/neurobagel/curation-types";
import {
  HEALTHY_CONTROL,
  mapAgeColumn,
  mapGroupColumn,
  mapSexColumn,
} from "../../shared/neurobagel/participants";
import { parseTsv } from "../../shared/neurobagel/tsv";
import { VOCAB, type VocabTerm } from "../../shared/neurobagel/vocab";
import { assessmentTerm, diagnosisTerm } from "../../shared/neurobagel/vocab-terms";

/** The upstream repository at the commit this reuse is pinned to. */
export const UPSTREAM = {
  repo: "neurobagel/openneuro-annotations",
  commit: "116676db7114b68338c48df2d6bb804c99e8c354",
  license: "MIT",
} as const;

export interface UpstreamFile {
  /** `ds000117.json` */
  file: string;
  /** The git blob SHA-1 of the file at the pinned commit, as the repository's tree lists it. */
  blobSha: string;
}

/** The mirror's two documents, as text, and the git blob SHAs of their true bytes. */
export interface MirrorDocuments {
  participantsTsv: string;
  participantsJson: string | null;
  pins: { participantsTsv: string; participantsJson: string | null };
}

export interface ConvertOptions {
  /** `YYYY-MM-DD`, the date written into the evidence. */
  date: string;
  /** Leave out a column the mechanical rules would already map to exactly the same values. */
  skipRedundant?: boolean;
}

export type DatasetSkip =
  | "upstream_not_a_dictionary"
  | "mirror_table_unreadable"
  | "no_annotated_column"
  | "no_curatable_column"
  | "all_columns_dropped"
  | "only_redundant_columns"
  | "entry_failed_final_check";

export interface Conversion {
  /** The entry for curation.json, or null when `skip` says why there is none. */
  entry: Record<string, unknown> | null;
  skip: DatasetSkip | null;
  /** Columns kept in the entry. */
  kept: number;
  /** Of those, by kind. */
  keptByKind: Record<string, number>;
  /** Columns left out because the mechanical rules already give the same answer. */
  redundant: number;
  /** Columns dropped, by reason. */
  dropped: Record<string, number>;
  /** Things done to a kept column, by name: `age_format_int_as_float`, `missing_values_deduped`. */
  notes: Record<string, number>;
}

const SEX_BY_IDENTIFIER = new Map(Object.values(VOCAB.sex).map((t) => [t.identifier, t]));
const AGE_FORMAT_BY_IDENTIFIER = new Map(
  Object.values(VOCAB.age_formats).map((t) => [t.identifier, t]),
);
const VARIABLE_KIND = new Map<string, "age" | "assessment" | "diagnosis" | "sex">([
  ["nb:Age", "age"],
  ["nb:Assessment", "assessment"],
  ["nb:Diagnosis", "diagnosis"],
  ["nb:Sex", "sex"],
]);
const IDENTIFIER_VARIABLES = new Set(["nb:ParticipantID", "nb:SessionID"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const bump = (tally: Record<string, number>, key: string, by = 1): void => {
  tally[key] = (tally[key] ?? 0) + by;
};

/** A coarse reason for a loader or binder problem, so that dropped columns can be counted. */
function classify(problem: string): string {
  if (problem.includes("is not in the pinned")) return "term_not_pinned";
  if (problem.includes("is not an age format")) return "age_format_not_pinned";
  if (problem.includes("not in the table header")) return "column_not_in_table";
  if (problem.includes("appears") && problem.includes("times in the table header")) {
    return "column_ambiguous_in_table";
  }
  if (problem.includes("neither Levels nor MissingValues")) return "levels_do_not_cover_table";
  if (problem.includes("are not ages in")) return "age_values_unreadable";
  if (problem.includes("no cell holds an age")) return "age_has_no_value";
  if (problem.includes("would count as recorded items")) return "item_blank_not_declared_missing";
  if (problem.includes("cannot also be a missing value")) return "level_is_a_missing_value";
  if (problem.includes("Levels is empty")) return "levels_empty";
  return "annotation_malformed";
}

/** The term `identifier` names in `find`'s vocabulary, spelled with its pinned label. */
const pinnedLabelled = (
  given: unknown,
  find: (identifier: string) => VocabTerm | null,
): { TermURL: string; Label: string } | null => {
  if (!isRecord(given) || typeof given.TermURL !== "string") return null;
  const found = find(given.TermURL);
  return found === null ? null : { TermURL: found.identifier, Label: found.label };
};

/**
 * The block for one upstream column, rewritten onto the pinned vocabulary, or a reason it cannot
 * be.
 */
function blockFrom(
  annotations: Record<string, unknown>,
  kind: "age" | "assessment" | "diagnosis" | "sex",
  notes: Record<string, number>,
): { block: Record<string, unknown> } | { drop: string } {
  const missing = annotations.MissingValues;
  if (
    missing !== undefined &&
    (!Array.isArray(missing) || missing.some((m) => typeof m !== "string"))
  ) {
    return { drop: "annotation_malformed" };
  }
  const given = (missing ?? []) as string[];
  const unique = [...new Set(given)];
  if (unique.length !== given.length) bump(notes, "missing_values_deduped");
  const common = { MissingValues: unique };
  const variable =
    VOCAB.variables[
      { age: "Age", assessment: "Assessment", diagnosis: "Diagnosis", sex: "Sex" }[kind]
    ];
  const isAbout = { TermURL: variable.identifier, Label: variable.label };

  if (kind === "age") {
    const format = annotations.Format;
    if (!isRecord(format) || typeof format.TermURL !== "string")
      return { drop: "annotation_malformed" };
    let id = format.TermURL;
    if (id === "nb:FromInt") {
      id = "nb:FromFloat";
      bump(notes, "age_format_int_as_float");
    }
    const term = AGE_FORMAT_BY_IDENTIFIER.get(id);
    if (term === undefined) return { drop: "age_format_not_pinned" };
    // ValueRange is not carried: the binder computes it from the table, which is the truth.
    return {
      block: {
        Format: { Label: term.label, TermURL: term.identifier },
        IsAbout: isAbout,
        ...common,
        VariableType: "Continuous",
      },
    };
  }
  if (kind === "assessment") {
    const tool = pinnedLabelled(annotations.IsPartOf, assessmentTerm);
    if (tool === null) return { drop: "term_not_pinned" };
    return { block: { IsAbout: isAbout, IsPartOf: tool, ...common, VariableType: "Collection" } };
  }
  const levels = annotations.Levels;
  if (!isRecord(levels)) return { drop: "annotation_malformed" };
  // Upstream's empty level map says nothing was mapped; carrying it would only withdraw what the
  // mechanical rules can read (a curated sex column replaces the mechanical one).
  if (Object.keys(levels).length === 0) return { drop: "levels_empty" };
  const rewritten: Record<string, unknown> = {};
  for (const [raw, term] of Object.entries(levels)) {
    const t = pinnedLabelled(
      term,
      kind === "sex" ? (id) => SEX_BY_IDENTIFIER.get(id) ?? null : diagnosisTerm,
    );
    if (t === null) return { drop: "term_not_pinned" };
    rewritten[raw] = t;
  }
  return {
    block: { IsAbout: isAbout, Levels: rewritten, ...common, VariableType: "Categorical" },
  };
}

/** The index of the first header cell the mechanical rules would read as `wanted`. */
const mechanicalIndex = (header: string[], wanted: string): number =>
  header.findIndex((h) => h.trim().toLowerCase() === wanted);

/**
 * Whether the mechanical rules would already give every row of the table the same value as this
 * curated column: then the entry would add nothing.
 */
function redundantWithMechanical(
  column: Extract<CuratedColumn, { kind: "age" | "diagnosis" | "sex" }>,
  bound: BoundColumn,
  header: string[],
  rows: string[][],
  participantsJson: string | null,
): boolean {
  const index = header.indexOf(column.name);
  const cells = rows.map((r) => r[index]);
  if (column.kind === "sex") {
    if (mechanicalIndex(header, "sex") !== index) return false;
    const mechanical = mapSexColumn(column.name, cells);
    return cells.every(
      (c) =>
        (column.levels.get(c)?.identifier ?? null) ===
        (mechanical.status === "mapped" ? (mechanical.levels.get(c)?.identifier ?? null) : null),
    );
  }
  if (column.kind === "diagnosis") {
    if (mechanicalIndex(header, "group") !== index) return false;
    const mechanical = mapGroupColumn(column.name, cells);
    return cells.every(
      (c) =>
        (column.levels.get(c)?.identifier ?? null) ===
        (mechanical.status === "mapped" && mechanical.levels.has(c)
          ? HEALTHY_CONTROL.identifier
          : null),
    );
  }
  if (mechanicalIndex(header, "age") !== index) return false;
  let units: unknown;
  try {
    const parsed = participantsJson === null ? null : (JSON.parse(participantsJson) as unknown);
    const entry = isRecord(parsed) ? parsed[column.name] : undefined;
    units = isRecord(entry) ? entry.Units : undefined;
  } catch {
    units = undefined;
  }
  if (bound.kind !== "age") return false;
  const mechanical = mapAgeColumn(column.name, cells, units);
  const { ageOf } = bound.mapping;
  return cells.every(
    (c) => ageOf(c) === (mechanical.status === "mapped" ? mechanical.ageOf(c) : null),
  );
}

/**
 * Convert one dataset's upstream annotation.
 * `upstream` is the parsed `dsNNNNNN.json`; `mirror` is NEMAR's own copy of the table.
 */
export async function convertUpstream(
  datasetId: string,
  upstream: unknown,
  source: UpstreamFile,
  mirror: MirrorDocuments,
  options: ConvertOptions,
): Promise<Conversion> {
  const result: Conversion = {
    entry: null,
    skip: null,
    kept: 0,
    keptByKind: {},
    redundant: 0,
    dropped: {},
    notes: {},
  };
  const skip = (reason: DatasetSkip): Conversion => ({ ...result, skip: reason });
  if (!isRecord(upstream)) return skip("upstream_not_a_dictionary");
  const parsed = parseTsv(mirror.participantsTsv);
  if (!parsed.ok || !parsed.table.header.includes("participant_id")) {
    return skip("mirror_table_unreadable");
  }
  const { header, rows } = parsed.table;

  const blocks: Record<string, Record<string, unknown>> = {};
  const keptKinds = new Set<string>();
  let curatable = 0;
  let annotated = 0;
  for (const [name, definition] of Object.entries(upstream)) {
    if (!isRecord(definition) || !isRecord(definition.Annotations)) continue;
    const annotations = definition.Annotations;
    const about = isRecord(annotations.IsAbout) ? annotations.IsAbout.TermURL : undefined;
    if (typeof about === "string" && IDENTIFIER_VARIABLES.has(about)) continue;
    annotated++;
    const kind = typeof about === "string" ? VARIABLE_KIND.get(about) : undefined;
    if (kind === undefined) {
      bump(result.dropped, "unsupported_variable");
      continue;
    }
    curatable++;
    const notes: Record<string, number> = {};
    const made = blockFrom(annotations, kind, notes);
    if ("drop" in made) {
      bump(result.dropped, made.drop);
      continue;
    }
    const column = curatedColumnFrom(name, made.block);
    if ("problems" in column) {
      bump(result.dropped, classify(column.problems[0]));
      continue;
    }
    // A participant has one age and one sex; `bagel` takes the first column, and so does this.
    if ((kind === "age" || kind === "sex") && keptKinds.has(kind)) {
      bump(result.dropped, `second_${kind}_column`);
      continue;
    }
    const bound = bindCuratedColumn(column.column, { header, rows });
    if ("problems" in bound) {
      bump(result.dropped, classify(bound.problems[0]));
      continue;
    }
    if (
      options.skipRedundant &&
      column.column.kind !== "assessment" &&
      redundantWithMechanical(column.column, bound.bound, header, rows, mirror.participantsJson)
    ) {
      result.redundant++;
      keptKinds.add(kind);
      continue;
    }
    keptKinds.add(kind);
    blocks[name] = made.block;
    result.kept++;
    bump(result.keptByKind, kind);
    for (const [note, n] of Object.entries(notes)) bump(result.notes, note, n);
  }

  if (annotated === 0) return skip("no_annotated_column");
  if (curatable === 0) return skip("no_curatable_column");
  if (result.kept === 0) {
    return skip(result.redundant > 0 ? "only_redundant_columns" : "all_columns_dropped");
  }

  const entry = {
    columns: blocks,
    evidence: {
      date: options.date,
      review: "upstream_community",
      reviewer:
        "Neurobagel community annotators, upstream; NEMAR has not reviewed it beyond the loader and binder checks",
      source: `${UPSTREAM.repo}@${UPSTREAM.commit.slice(0, 7)}:${source.file} (git blob ${source.blobSha.slice(0, 7)}), ${UPSTREAM.license} licence; columns copied as annotated, terms re-labelled from the pinned vocabulary, ValueRange recomputed`,
    },
    pins: {
      participants_json: mirror.pins.participantsJson,
      participants_tsv: mirror.pins.participantsTsv,
    },
  };

  // The last word is the real loader and the real binder, over the entry exactly as it will be
  // written: a converter that is wrong cannot produce an entry the writer would then apply.
  try {
    const text = canonicalJson({ datasets: { [datasetId]: entry }, format: 1 } as never);
    const loaded = parseCuration(text).entries.get(datasetId);
    const bound =
      loaded === undefined
        ? null
        : await bindCuration(
            loaded,
            { participantsJson: mirror.participantsJson, participantsTsv: mirror.participantsTsv },
            { header, rows },
          );
    if (bound?.status !== "applied") return skip("entry_failed_final_check");
  } catch (error) {
    if (!(error instanceof CurationError)) throw error;
    return skip("entry_failed_final_check");
  }
  return { ...result, entry };
}
