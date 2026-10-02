/**
 * Bind a curation entry to the documents it was reviewed against (epic #1586, phase 5; ADR 0083).
 *
 * The loader (curation.ts) judges the file from its text.
 * This module judges an entry against the dataset's own documents, which is where more failures
 * can be seen:
 *
 *   stale    the participants.tsv or participants.json now being converted is not the file the
 *            entry pinned (its git blob hash, SHA-1 of the bytes with git's header, differs).
 *            The reviewer never saw these bytes, so none of the entry is applied.
 *   invalid  the bytes ARE the pinned ones and the entry still does not fit them: a curated
 *            column is not in the header, or the level map misses a value the table holds,
 *            or an age is unreadable in its declared format, declared in units other than
 *            years, or a placeholder.
 *            Nothing is applied.
 *            A committed entry can only reach this through a mistake in the review, which the
 *            tests that bind every committed entry to its fixture exist to catch.
 * What the transform then does about each (the mechanical columns, the variables the entry names,
 * the report) is in transform.ts.
 *
 * Coverage is checked over EVERY row of the table, not only the participants that have data:
 * the data dictionary is also fed to `bagel pheno` and to catalog-mode nodes, which read every
 * row, and a value the dictionary does not declare makes them refuse the table.
 * The graph itself still takes values from its own participants only (transform.ts).
 *
 * An age column gets the checks the mechanical rule gives one (participants.ts), because a
 * reviewer who curates the column has not seen those facts in the table and a wrong age is a false
 * claim in a public index:
 *   - participants.json must not declare units other than years: Neurobagel has no age format
 *     for months, weeks or days, so such a column cannot be curated into the graph, and a
 *     dictionary that says "years" over months would make 6-month-olds match an age search of
 *     5 to 10 years;
 *   - at least half of the parsed ages must not be 0, unless 0 is declared a missing value:
 *     a column of zeros is a placeholder for "not recorded".
 *
 * Pure: no I/O.
 */

import { byCodeUnit } from "./canonical-json";
import { isLoaded } from "./curation-loaded";
import {
  type CuratedColumn,
  type CurationEntry,
  type CurationKind,
  kindCounts,
} from "./curation-types";
import { contentMatchesPin } from "./git-blob";
import {
  type AgeMapping,
  STANDARD_MISSING_VALUES,
  type SexMapping,
  ZERO_PLACEHOLDER_SHARE,
  ageUnitsAreNotYears,
  ageUnitsIn,
  parseAge,
} from "./participants";
import { parseTsv } from "./tsv";
import type { VocabTerm } from "./vocab";

/** A parsed participants.tsv: its header and every row, padded to the header's width. */
export interface ParsedTable {
  header: string[];
  rows: string[][];
}

/** The text of the two documents, `null` where the data plane has none (HTTP 404). */
export interface CurationDocuments {
  participantsTsv: string | null;
  participantsJson: string | null;
}

export type StaleFile = "participants_json" | "participants_tsv";

export type BoundColumn =
  | { kind: "age"; name: string; index: number; mapping: AgeMapping }
  | { kind: "sex"; name: string; index: number; mapping: SexMapping }
  | {
      kind: "diagnosis";
      name: string;
      index: number;
      levels: ReadonlyMap<string, VocabTerm>;
      missingValues: readonly string[];
    }
  | {
      kind: "assessment";
      name: string;
      index: number;
      tool: VocabTerm;
      missingValues: readonly string[];
    };

/** The columns of an entry that fit their table, grouped the way the transform uses them. */
export interface BoundCuration {
  age: Extract<BoundColumn, { kind: "age" }> | null;
  sex: Extract<BoundColumn, { kind: "sex" }> | null;
  diagnoses: Extract<BoundColumn, { kind: "diagnosis" }>[];
  assessments: Extract<BoundColumn, { kind: "assessment" }>[];
}

export type BindResult =
  | { status: "stale"; staleFiles: StaleFile[] }
  /** `problems` quote cell values from the table: for a developer, never for a report. */
  | { status: "invalid"; problems: string[] }
  | { status: "applied"; bound: BoundCuration };

/** Up to three values, sorted and quoted, for a message. */
function examplesOf(values: Set<string>): string {
  const sorted = [...values].sort(byCodeUnit);
  const shown = sorted.slice(0, 3).map((v) => JSON.stringify(v));
  return sorted.length > 3 ? `${shown.join(", ")} and ${sorted.length - 3} more` : shown.join(", ");
}

/** participants.json as an object keyed by column, or null when it is absent or unreadable. */
export function readParticipantsJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Check one curated column against its table.
 * `participantsJson` is the dataset's column descriptions (null when it has none), read only for an
 * age column's declared units.
 * Returns the bound column, or every reason it does not fit.
 */
export function bindCuratedColumn(
  column: CuratedColumn,
  table: ParsedTable,
  participantsJson: Record<string, unknown> | null = null,
): { bound: BoundColumn } | { problems: string[] } {
  const where = `column ${JSON.stringify(column.name)}`;
  const found = table.header.flatMap((h, i) => (h === column.name ? [i] : []));
  if (found.length === 0) return { problems: [`${where} is not in the table header`] };
  if (found.length > 1) {
    return { problems: [`${where} appears ${found.length} times in the table header`] };
  }
  const index = found[0];
  const missing = new Set(column.missingValues);
  const problems: string[] = [];

  switch (column.kind) {
    case "sex":
    case "diagnosis": {
      const uncovered = new Set<string>();
      for (const row of table.rows) {
        const cell = row[index];
        if (!column.levels.has(cell) && !missing.has(cell)) uncovered.add(cell);
      }
      if (uncovered.size > 0) {
        problems.push(
          `${where}: ${uncovered.size} value(s) are in neither Levels nor MissingValues: ${examplesOf(uncovered)}`,
        );
        return { problems };
      }
      return column.kind === "sex"
        ? {
            bound: {
              kind: "sex",
              name: column.name,
              index,
              mapping: { levels: column.levels, missingValues: [...column.missingValues] },
            },
          }
        : {
            bound: {
              kind: "diagnosis",
              name: column.name,
              index,
              levels: column.levels,
              missingValues: column.missingValues,
            },
          };
    }
    case "age": {
      const units = ageUnitsIn(participantsJson, column.name);
      if (ageUnitsAreNotYears(units)) {
        problems.push(
          `${where}: participants.json declares Units ${JSON.stringify(units)}, not years; Neurobagel has no age format for months, weeks or days, so this column cannot be curated into the graph`,
        );
      }
      const unreadable = new Set<string>();
      let parsed = 0;
      let zeros = 0;
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const row of table.rows) {
        const cell = row[index];
        if (missing.has(cell)) continue;
        const age = parseAge(cell, column.format);
        if (age === null) {
          unreadable.add(cell);
          continue;
        }
        parsed++;
        if (age === 0) zeros++;
        if (age < min) min = age;
        if (age > max) max = age;
      }
      if (unreadable.size > 0) {
        problems.push(
          `${where}: ${unreadable.size} value(s) are not ages in ${column.formatTerm.identifier} and are not MissingValues: ${examplesOf(unreadable)}`,
        );
      }
      if (parsed === 0) {
        problems.push(`${where}: no cell holds an age, so the column carries nothing`);
      }
      // The same rule as the mechanical one: a column that is mostly zeros says "not recorded".
      if (parsed > 0 && zeros / parsed >= ZERO_PLACEHOLDER_SHARE) {
        problems.push(
          `${where}: ${zeros} of ${parsed} ages are 0, a placeholder for "not recorded"; declare 0 a missing value if it is one`,
        );
      }
      if (
        parsed > 0 &&
        column.valueRange !== null &&
        (column.valueRange.min !== min || column.valueRange.max !== max)
      ) {
        problems.push(
          `${where}: ValueRange ${column.valueRange.min} to ${column.valueRange.max} is not the table's ${min} to ${max}`,
        );
      }
      if (problems.length > 0) return { problems };
      const { format } = column;
      return {
        bound: {
          kind: "age",
          name: column.name,
          index,
          mapping: {
            format,
            formatTerm: column.formatTerm,
            missingValues: [...column.missingValues],
            valueRange: { min, max },
            unitsAssumed: units === undefined || units === null,
            ageOf: (raw) => (missing.has(raw) ? null : parseAge(raw, format)),
          },
        },
      };
    }
    case "assessment": {
      // `bagel` counts a cell as a recorded item unless it is a declared missing value, so a blank
      // that is not declared missing would claim an assessment nobody took.
      const undeclared = new Set<string>();
      for (const row of table.rows) {
        const cell = row[index];
        if (STANDARD_MISSING_VALUES.includes(cell) && !missing.has(cell)) undeclared.add(cell);
      }
      if (undeclared.size > 0) {
        problems.push(
          `${where}: ${examplesOf(undeclared)} appear in the table but are not MissingValues, so they would count as recorded items`,
        );
        return { problems };
      }
      return {
        bound: {
          kind: "assessment",
          name: column.name,
          index,
          tool: column.tool,
          missingValues: column.missingValues,
        },
      };
    }
  }
}

/** The kinds of variable an entry names, in the report's order. */
export const kindsOf = (entry: CurationEntry): CurationKind[] => {
  const named = kindCounts();
  for (const column of entry.columns) named[column.kind]++;
  return (Object.keys(named) as CurationKind[]).filter((kind) => named[kind] > 0);
};

/**
 * Bind `entry` to the documents it is being applied to.
 * The table is read from the text here, so it cannot disagree with the text the pins were
 * computed from.
 * `entry` must be one the loader made (curation-loaded.ts).
 */
export async function bindCuration(
  entry: CurationEntry,
  documents: CurationDocuments,
): Promise<BindResult> {
  if (!isLoaded(entry)) {
    throw new Error("bindCuration takes an entry from parseCuration, not a hand-built object");
  }
  const staleFiles: StaleFile[] = [];
  if (!(await contentMatchesPin(documents.participantsJson, entry.pins.participantsJson))) {
    staleFiles.push("participants_json");
  }
  if (!(await contentMatchesPin(documents.participantsTsv, entry.pins.participantsTsv))) {
    staleFiles.push("participants_tsv");
  }
  if (staleFiles.length > 0) return { status: "stale", staleFiles };

  const parsed = documents.participantsTsv === null ? null : parseTsv(documents.participantsTsv);
  if (parsed === null || !parsed.ok || !parsed.table.header.includes("participant_id")) {
    return {
      status: "invalid",
      problems: [
        "the pinned participants.tsv cannot be read as a table with a participant_id column",
      ],
    };
  }
  const table: ParsedTable = parsed.table;
  const participantsJson = readParticipantsJson(documents.participantsJson);

  const problems: string[] = [];
  const bound: BoundCuration = { age: null, sex: null, diagnoses: [], assessments: [] };
  for (const column of entry.columns) {
    const result = bindCuratedColumn(column, table, participantsJson);
    if ("problems" in result) {
      problems.push(...result.problems);
      continue;
    }
    const made = result.bound;
    switch (made.kind) {
      case "age":
        if (bound.age !== null)
          problems.push("more than one age column; a participant has one age");
        bound.age = made;
        break;
      case "sex":
        if (bound.sex !== null)
          problems.push("more than one sex column; a participant has one sex");
        bound.sex = made;
        break;
      case "diagnosis":
        bound.diagnoses.push(made);
        break;
      case "assessment":
        bound.assessments.push(made);
        break;
    }
  }
  if (problems.length > 0) return { status: "invalid", problems };
  return { status: "applied", bound };
}
