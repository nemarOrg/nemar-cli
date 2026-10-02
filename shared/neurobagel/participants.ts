/**
 * Column rules: what participants.tsv may say about age, sex and group.
 *
 * Each rule has one job, to decide, from a column's header, its cells and the
 * optional participants.json description, whether the column maps mechanically
 * to a Neurobagel variable, and if so how.
 * Anything the rules do not recognise is NOT guessed at: it is reported as
 * needing curation and left out.
 * A missing fact is better than a wrong one in a public index (the epic's
 * missing-data rule), so every rule fails towards "unknown".
 *
 * The cell-level behaviour follows `bagel pheno` (the oracle): a cell listed in
 * the dictionary's `MissingValues` is skipped, a categorical value must be
 * declared in `Levels` or `MissingValues`, an age is transformed by its
 * declared format.
 * Because the dictionary this module drives is also fed to real `bagel pheno`,
 * a value the rules cannot map is declared a missing value (counted in the
 * report) rather than left undeclared, which would make the oracle refuse the
 * table.
 *
 * Pure: no I/O.
 */

import { byCodeUnit } from "./canonical-json";
import { VOCAB, type VocabTerm, ageFormatTerm, sexTerm } from "./vocab";

/** Cell values that mean "not recorded" in every column. Fixed order, part of the output. */
export const STANDARD_MISSING_VALUES: readonly string[] = ["", "n/a", "N/A", "NA"];

/**
 * A column with more than this share of its non-missing cells unmappable is
 * not mapped at all: the column is more likely misunderstood than dirty.
 */
const UNMAPPABLE_SHARE_LIMIT = 0.1;

/**
 * An age column in which zeros are at least this share of the parsed ages is not
 * mapped: a column of zeros is a placeholder for "not recorded", and a graph that
 * answered "age 0" for a participant of unknown age would match every infant query.
 * A few zeros among real ages (newborns recorded in years) stay ages.
 */
export const ZERO_PLACEHOLDER_SHARE = 0.5;

/** Plausible ages in years. A cell outside it is unparseable, which also catches months and days. */
export const AGE_MIN_YEARS = 0;
export const AGE_MAX_YEARS = 120;

/**
 * Every age format the pinned vocabulary declares.
 * The mechanical rule detects only the first four (a column is never guessed to be European
 * decimal); `FromEuro` is reachable through a reviewed curation entry.
 */
export const AGE_FORMAT_IDS = [
  "FromFloat",
  "FromRange",
  "FromBounded",
  "FromISO8601",
  "FromEuro",
] as const;
export type AgeFormatId = (typeof AGE_FORMAT_IDS)[number];

// A type alias, not an interface: only an alias is assignable to canonicalJson's object type.
export type ColumnCounts = {
  /** Cells in the column. */
  cells: number;
  /** Cells listed as missing by the standard list. */
  missing: number;
  /** Non-missing cells the rule could not map (declared missing values in the dictionary). */
  unmappable: number;
  /** Cells that became a value in the graph. */
  mapped: number;
  /** Age columns only: parsed ages equal to 0 (see {@link ZERO_PLACEHOLDER_SHARE}). */
  zero_ages?: number;
};

export type ColumnOutcome<T> =
  | { status: "absent" }
  | { status: "all_missing"; column: string }
  | { status: "curation"; column: string; reason: string; counts: ColumnCounts }
  | ({ status: "mapped"; column: string; counts: ColumnCounts } & T);

export interface AgeMapping {
  format: AgeFormatId;
  formatTerm: VocabTerm;
  missingValues: string[];
  valueRange: { min: number; max: number };
  /** True when no participants.json unit was declared and years were assumed. */
  unitsAssumed: boolean;
  /** The age in years for a raw cell, or null when the cell is missing or unparseable. */
  ageOf: (raw: string) => number | null;
}

export interface SexMapping {
  /** Raw cell value to the sex term it maps to. */
  levels: ReadonlyMap<string, VocabTerm>;
  missingValues: readonly string[];
}

export interface GroupMapping {
  /** Raw cell values that mean healthy control. */
  levels: Set<string>;
  missingValues: string[];
}

const FLOAT_RE = /^ *\d+(?:\.\d+)? *$/;
const RANGE_RE = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/;
const BOUNDED_RE = /^(\d+(?:\.\d+)?)\+$/;
// ISO 8601 durations restricted to years and months: `P31Y6M`, `31Y6M`, `P6M`, `31Y`.
// Weeks and days are not accepted: the pinned `bagel` raises on them.
const ISO_RE = /^P?(?:(\d+)Y)?(?:(\d+)M)?$/;
// European decimal: a comma is the decimal separator, as `float(value.replace(",", "."))` reads it.
const EURO_RE = /^ *\d+(?:,\d+)? *$/;

const inRange = (age: number): boolean => age >= AGE_MIN_YEARS && age <= AGE_MAX_YEARS;

/**
 * The age in years a cell means under one of the four formats, or null.
 * Mirrors `bagel.utilities.pheno_utils.transform_age` for the cells it
 * accepts, and accepts a strict subset of what that function accepts.
 */
export function parseAge(raw: string, format: AgeFormatId): number | null {
  let age: number | null = null;
  switch (format) {
    case "FromFloat": {
      // Python's float() tolerates surrounding spaces, so `float("        10")` is 10.0.
      if (FLOAT_RE.test(raw)) age = Number(raw.trim());
      break;
    }
    case "FromEuro": {
      if (EURO_RE.test(raw)) age = Number(raw.trim().replace(",", "."));
      break;
    }
    case "FromRange": {
      const m = RANGE_RE.exec(raw);
      if (m) {
        const low = Number(m[1]);
        const high = Number(m[2]);
        if (low <= high && inRange(low) && inRange(high)) age = (low + high) / 2;
      }
      break;
    }
    case "FromBounded": {
      const m = BOUNDED_RE.exec(raw);
      if (m) age = Number(m[1]);
      break;
    }
    case "FromISO8601": {
      const m = ISO_RE.exec(raw);
      if (m && (m[1] !== undefined || m[2] !== undefined)) {
        const years = Number(m[1] ?? 0);
        const months = Number(m[2] ?? 0);
        // `P0Y` parses to a timedelta in the oracle and raises; never emit it.
        if (years + months > 0) age = years + months / 12;
      }
      break;
    }
  }
  return age !== null && inRange(age) ? age : null;
}

const AGE_FORMAT_PRIORITY: AgeFormatId[] = ["FromFloat", "FromRange", "FromBounded", "FromISO8601"];

const YEARS_UNIT_RE = /^\(?\s*(?:years?|yrs?|y|years? old)\s*\)?$/i;

/** True when a participants.json `Units` value says years. */
function unitsAreYears(units: string): boolean {
  return YEARS_UNIT_RE.test(units.trim());
}

/**
 * True when participants.json DECLARES units for the age column and they are not years.
 * An absent `Units` (or `null`) is not a declaration: years are assumed, as everywhere.
 * Neurobagel has no age format for months, weeks or days, so such a column cannot reach the
 * graph, mechanically or through curation.
 */
export function ageUnitsAreNotYears(units: unknown): boolean {
  return (
    units !== undefined && units !== null && (typeof units !== "string" || !unitsAreYears(units))
  );
}

/** The `Units` participants.json declares for `column`, or undefined (also when it is unreadable). */
export function ageUnitsIn(
  participantsJson: Record<string, unknown> | null,
  column: string,
): unknown {
  if (participantsJson === null) return undefined;
  const entry = participantsJson[column];
  if (entry === null || typeof entry !== "object") return undefined;
  return (entry as Record<string, unknown>).Units;
}

function distinctSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(byCodeUnit);
}

/** The standard missing values followed by any extra declared ones, in a fixed order. */
function missingValuesWith(extra: Iterable<string>): string[] {
  const standard = new Set(STANDARD_MISSING_VALUES);
  return [...STANDARD_MISSING_VALUES, ...distinctSorted(extra).filter((v) => !standard.has(v))];
}

const isMissing = (raw: string): boolean => STANDARD_MISSING_VALUES.includes(raw);

function counts(cells: string[], unmappable: number, mapped: number): ColumnCounts {
  return {
    cells: cells.length,
    missing: cells.filter(isMissing).length,
    unmappable,
    mapped,
  };
}

/**
 * Age.
 * `units` is the age column's participants.json `Units` (undefined when the
 * file or the key is absent, which means years are assumed).
 */
export function mapAgeColumn(
  column: string,
  cells: string[],
  units: unknown,
): ColumnOutcome<AgeMapping> {
  const present = cells.filter((c) => !isMissing(c));
  if (present.length === 0) return { status: "all_missing", column };

  const declared = units === undefined || units === null ? undefined : units;
  if (ageUnitsAreNotYears(declared)) {
    return {
      status: "curation",
      column,
      reason: "age_units_not_years",
      counts: counts(cells, present.length, 0),
    };
  }

  // One format per column: the one the most cells are written in.
  const tally = new Map<AgeFormatId, number>();
  for (const format of AGE_FORMAT_PRIORITY) {
    tally.set(format, present.filter((c) => parseAge(c, format) !== null).length);
  }
  let format: AgeFormatId = "FromFloat";
  for (const candidate of AGE_FORMAT_PRIORITY) {
    if ((tally.get(candidate) ?? 0) > (tally.get(format) ?? 0)) format = candidate;
  }

  const ages = present.map((c) => parseAge(c, format)).filter((a): a is number => a !== null);
  const unmappable = present.length - ages.length;
  if (ages.length === 0 || unmappable / present.length > UNMAPPABLE_SHARE_LIMIT) {
    return {
      status: "curation",
      column,
      reason: "age_unparseable",
      counts: counts(cells, unmappable, ages.length),
    };
  }

  // Plain loops: `Math.min(...ages)` throws a RangeError once a column has about 125,000 cells.
  let zeros = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const age of ages) {
    if (age === 0) zeros++;
    if (age < min) min = age;
    if (age > max) max = age;
  }
  if (zeros / ages.length >= ZERO_PLACEHOLDER_SHARE) {
    return {
      status: "curation",
      column,
      reason: "age_zero_placeholder",
      counts: { ...counts(cells, unmappable, 0), zero_ages: zeros },
    };
  }

  const bad = present.filter((c) => parseAge(c, format) === null);
  const missingValues = missingValuesWith(bad);
  return {
    status: "mapped",
    column,
    counts: { ...counts(cells, unmappable, ages.length), zero_ages: zeros },
    format,
    formatTerm: ageFormatTerm(format),
    missingValues,
    valueRange: { min, max },
    unitsAssumed: declared === undefined,
    ageOf: (raw) => (missingValues.includes(raw) ? null : parseAge(raw, format)),
  };
}

// A Map, not an object: a cell reading `constructor` must not find a prototype member.
const SEX_BY_TOKEN = new Map<string, "male" | "female" | "other">([
  ["m", "male"],
  ["male", "male"],
  ["f", "female"],
  ["female", "female"],
  ["o", "other"],
  ["other", "other"],
]);

/**
 * Sex.
 * Only a column named `sex` reaches here; `gender` is a different construct and
 * is left to curation.
 * Numeric codes (`1`, `2`) are not mapped: their meaning differs between
 * datasets and nothing in the table says which convention applies.
 */
export function mapSexColumn(column: string, cells: string[]): ColumnOutcome<SexMapping> {
  const present = cells.filter((c) => !isMissing(c));
  if (present.length === 0) return { status: "all_missing", column };

  const levels = new Map<string, VocabTerm>();
  const unmappable: string[] = [];
  let mapped = 0;
  for (const cell of present) {
    const token = SEX_BY_TOKEN.get(cell.toLowerCase());
    if (token === undefined) {
      unmappable.push(cell);
      continue;
    }
    levels.set(cell, sexTerm(token));
    mapped++;
  }
  if (mapped === 0 || unmappable.length / present.length > UNMAPPABLE_SHARE_LIMIT) {
    return {
      status: "curation",
      column,
      reason: "sex_unmappable",
      counts: counts(cells, unmappable.length, mapped),
    };
  }
  return {
    status: "mapped",
    column,
    counts: counts(cells, unmappable.length, mapped),
    levels,
    missingValues: missingValuesWith(unmappable),
  };
}

const CONTROL_TOKENS = new Set([
  "healthy",
  "healthy control",
  "healthy controls",
  "control",
  "controls",
  "hc",
  "ctl",
  "ctrl",
]);

/** `Healthy_Control`, `healthy-control` and `Healthy  Control` are one token. */
const controlToken = (cell: string): string =>
  cell
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");

/**
 * Group.
 * Only healthy-control spellings map, to `ncit:C94342` as a DIAGNOSIS term:
 * that is how Neurobagel's own OpenNeuro annotations record controls and how
 * the node API's diagnosis filter finds them.
 * Every other group value (a patient group, a condition, a site) is declared
 * a missing value, so a participant in it carries no diagnosis term, which is
 * true to what is known; deciding what those groups mean is curation.
 * A group column with no control value maps nothing.
 */
export function mapGroupColumn(column: string, cells: string[]): ColumnOutcome<GroupMapping> {
  const present = cells.filter((c) => !isMissing(c));
  if (present.length === 0) return { status: "all_missing", column };

  const controls = new Set<string>();
  const others: string[] = [];
  for (const cell of present) {
    if (CONTROL_TOKENS.has(controlToken(cell))) controls.add(cell);
    else others.push(cell);
  }
  const mapped = present.length - others.length;
  if (controls.size === 0) {
    return {
      status: "curation",
      column,
      reason: "group_has_no_control_value",
      counts: counts(cells, others.length, 0),
    };
  }
  return {
    status: "mapped",
    column,
    counts: counts(cells, others.length, mapped),
    levels: controls,
    missingValues: missingValuesWith(others),
  };
}

/** The healthy control term, from the pinned vocabulary. */
export const HEALTHY_CONTROL: VocabTerm = VOCAB.healthy_control;
