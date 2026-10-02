/**
 * Bind a curation entry to the table it was reviewed against (epic #1586, phase 5; ADR 0083).
 *
 * The loader (curation.ts) judges the file from its text.
 * This module judges an entry against the dataset's own documents, which is where two more
 * failures can be seen:
 *
 *   stale    the participants.tsv or participants.json now being converted is not the file the
 *            entry pinned (its git blob SHA differs).
 *            The reviewer never saw these bytes, so none of the entry is applied;
 *            the transform ships its mechanical columns and the report says `curation_stale`.
 *   invalid  the bytes ARE the pinned ones and the entry still does not fit them: a curated
 *            column is not in the header, or the level map misses a value the table holds,
 *            or an age is unreadable in its declared format.
 *            Nothing is applied and the report says `curation_invalid`.
 *            A committed entry can only reach this through a mistake in the review, which the
 *            tests that bind every committed entry to its fixture exist to catch.
 *
 * Coverage is checked over EVERY row of the table, not only the participants that have data:
 * the data dictionary is also fed to `bagel pheno` and to catalog-mode nodes, which read every
 * row, and a value the dictionary does not declare makes them refuse the table.
 * The graph itself still takes values from its own participants only (transform.ts).
 *
 * Pure: no I/O.
 */

import { byCodeUnit } from "./canonical-json";
import type { CuratedColumn, CurationEntry, CurationKind } from "./curation-types";
import { contentMatchesPin } from "./git-blob";
import {
  type AgeMapping,
  STANDARD_MISSING_VALUES,
  type SexMapping,
  parseAge,
} from "./participants";
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
      levels: Map<string, VocabTerm>;
      missingValues: string[];
    }
  | {
      kind: "assessment";
      name: string;
      index: number;
      tool: VocabTerm;
      missingValues: string[];
    };

/** The columns of an entry that fit their table, grouped the way the transform uses them. */
export interface BoundCuration {
  age: Extract<BoundColumn, { kind: "age" }> | null;
  sex: Extract<BoundColumn, { kind: "sex" }> | null;
  diagnoses: Extract<BoundColumn, { kind: "diagnosis" }>[];
  assessments: Extract<BoundColumn, { kind: "assessment" }>[];
  /** Columns the entry declares, by kind. */
  declared: Record<CurationKind, number>;
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

/**
 * Check one curated column against its table.
 * Returns the bound column, or every reason it does not fit.
 */
export function bindCuratedColumn(
  column: CuratedColumn,
  table: ParsedTable,
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
              mapping: { levels: column.levels, missingValues: column.missingValues },
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
      const unreadable = new Set<string>();
      let parsed = 0;
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
            missingValues: column.missingValues,
            valueRange: { min, max },
            unitsAssumed: false,
            ageOf: (raw) => (missing.has(raw) ? null : parseAge(raw, format)),
          },
        },
      };
    }
    case "assessment": {
      // `bagel` counts a cell as a recorded item unless it is a declared missing value, so a blank
      // that is not declared would claim an assessment nobody took.
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

const emptyDeclared = (): Record<CurationKind, number> => ({
  age: 0,
  assessment: 0,
  diagnosis: 0,
  sex: 0,
});

/**
 * Bind `entry` to the documents it is being applied to.
 * `table` is `documents.participantsTsv` parsed, or null when it could not be read as a table
 * with a `participant_id` column.
 */
export async function bindCuration(
  entry: CurationEntry,
  documents: CurationDocuments,
  table: ParsedTable | null,
): Promise<BindResult> {
  const staleFiles: StaleFile[] = [];
  if (!(await contentMatchesPin(documents.participantsJson, entry.pins.participantsJson))) {
    staleFiles.push("participants_json");
  }
  if (!(await contentMatchesPin(documents.participantsTsv, entry.pins.participantsTsv))) {
    staleFiles.push("participants_tsv");
  }
  if (staleFiles.length > 0) return { status: "stale", staleFiles };
  if (table === null) {
    return {
      status: "invalid",
      problems: [
        "the pinned participants.tsv cannot be read as a table with a participant_id column",
      ],
    };
  }

  const problems: string[] = [];
  const declared = emptyDeclared();
  const bound: BoundCuration = { age: null, sex: null, diagnoses: [], assessments: [], declared };
  for (const column of entry.columns) {
    declared[column.kind]++;
    const result = bindCuratedColumn(column, table);
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
