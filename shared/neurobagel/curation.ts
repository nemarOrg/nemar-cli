/**
 * The curation loader (epic #1586, phase 5; ADR 0083).
 *
 * `shared/neurobagel/curation.json` holds the annotations a table cannot yield mechanically:
 * which diagnosis a free-text group value means, which column is the sex column, which
 * assessment tool a column is an item of, how an age column is written.
 * A person (or the annotation tool) writes them, a reviewer reads them, and this module
 * decides whether the file is fit to be believed.
 * It fails CLOSED: one problem anywhere and the whole file is rejected with every problem it
 * found, because a public index that carries a half-checked claim is worse than one that
 * carries none.
 *
 * What the loader rejects, from the text alone:
 *   - text that is not JSON, a key that appears twice (JSON.parse would keep the last), and
 *     `__proto__` anywhere;
 *   - an unknown key at any level (a typo must never be silently ignored);
 *   - a term that is not in the PINNED vocabulary, or whose label is not the pinned label;
 *   - a level map with no level, a level that is also a missing value, a column that is not
 *     one of the four curatable kinds, a second sex or age column, a column named `age`, `sex`
 *     or `group` that is about something else, a dataset id outside `nm` and `on` or inside the
 *     reserved fixture band (ADR 0068);
 *   - a pin that is not 40 lowercase hex digits, evidence that is blank, a date that is not a
 *     calendar date.
 * What it cannot reject from the text alone, because it depends on the table, is done by
 * `bindCuration` (curation-bind.ts): the pins, whether the level maps cover every value the table
 * holds, and an age column's units and placeholder zeros.
 *
 * "Every problem" is per stage: key problems (duplicates, `__proto__`) are reported first, and
 * only if there are none is the SHAPE checked (unknown keys, wrong types), and only if the shape
 * is sound is the MEANING checked (terms, labels, levels, pins' use, dates).
 * Fix one stage and run again to see the next; within a stage everything found is listed.
 *
 * What the loader returns is opaque: an entry is registered (curation-loaded.ts) and the
 * transform and the binder accept nothing else, because here is where its terms were checked
 * against the full pinned vocabulary.
 *
 * An entry has the shape of the Neurobagel annotation tool's export: each column maps to the
 * tool's `Annotations` block, pasted as exported.
 *
 * Imports the full diagnosis and assessment vocabularies, which the transform does not.
 *
 * Pure: takes text, returns values, throws `CurationError`.
 */

import { z } from "zod";
import { byCodeUnit } from "./canonical-json";
import { markLoaded } from "./curation-loaded";
import {
  CURATION_REVIEWS,
  type CuratedColumn,
  type CurationEntry,
  type CurationFile,
  type CurationKind,
} from "./curation-types";
import { scanKeys } from "./json-keys";
import { AGE_FORMAT_IDS, AGE_MAX_YEARS, AGE_MIN_YEARS, type AgeFormatId } from "./participants";
import { VOCAB, type VocabTerm, variableTerm } from "./vocab";
import { assessmentTerm, diagnosisTerm } from "./vocab-terms";

/** The loader refused the file; `problems` lists everything wrong with it, not only the first. */
export class CurationError extends Error {
  constructor(readonly problems: string[]) {
    const shown = problems.slice(0, 12).join("; ");
    const more = problems.length > 12 ? `; and ${problems.length - 12} more` : "";
    super(`curation rejected, ${problems.length} problem(s): ${shown}${more}`);
    this.name = "CurationError";
  }
}

const term = z.object({ TermURL: z.string(), Label: z.string() }).strict();
// Uniqueness is checked by hand below, for a message that names the repeated value.
const missingValues = z.array(z.string()).default([]);

const categoricalBlock = z
  .object({
    IsAbout: term,
    Levels: z.record(z.string(), term),
    MissingValues: missingValues,
    VariableType: z.literal("Categorical"),
  })
  .strict();
const continuousBlock = z
  .object({
    IsAbout: term,
    Format: term,
    MissingValues: missingValues,
    ValueRange: z.object({ Min: z.number(), Max: z.number() }).strict().optional(),
    VariableType: z.literal("Continuous"),
  })
  .strict();
const collectionBlock = z
  .object({
    IsAbout: term,
    IsPartOf: term,
    MissingValues: missingValues,
    VariableType: z.literal("Collection"),
  })
  .strict();
const annotationBlock = z.discriminatedUnion("VariableType", [
  categoricalBlock,
  continuousBlock,
  collectionBlock,
]);
type AnnotationBlock = z.infer<typeof annotationBlock>;

const notBlank = (value: string): boolean => value.trim() !== "";
const gitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "must be 40 lowercase hex digits (a git blob SHA-1)");

const entrySchema = z
  .object({
    evidence: z
      .object({
        source: z.string().refine(notBlank, "must not be blank"),
        reviewer: z.string().refine(notBlank, "must not be blank"),
        review: z.enum(CURATION_REVIEWS),
        date: z.string(),
      })
      .strict(),
    pins: z.object({ participants_tsv: gitSha, participants_json: gitSha.nullable() }).strict(),
    columns: z.record(z.string(), annotationBlock),
  })
  .strict();
const fileSchema = z
  .object({ format: z.literal(1), datasets: z.record(z.string(), entrySchema) })
  .strict();

function issueMessage(issue: z.ZodIssue): string {
  if (issue.code === "unrecognized_keys") {
    return `unknown key ${issue.keys.map((k) => JSON.stringify(k)).join(", ")}`;
  }
  if (issue.code === "invalid_union_discriminator") {
    return "VariableType must be Categorical, Continuous or Collection";
  }
  return issue.message;
}

const describeIssue = (issue: z.ZodIssue): string =>
  `${issue.path.length === 0 ? "(file)" : issue.path.join(".")}: ${issueMessage(issue)}`;

/** What each curatable `IsAbout` term means: its kind, its pinned variable and its variable type. */
const ABOUT = new Map<
  string,
  { kind: CurationKind; variable: VocabTerm; variableType: AnnotationBlock["VariableType"] }
>([
  [
    variableTerm("Age").identifier,
    { kind: "age", variable: variableTerm("Age"), variableType: "Continuous" },
  ],
  [
    variableTerm("Assessment").identifier,
    { kind: "assessment", variable: variableTerm("Assessment"), variableType: "Collection" },
  ],
  [
    variableTerm("Diagnosis").identifier,
    { kind: "diagnosis", variable: variableTerm("Diagnosis"), variableType: "Categorical" },
  ],
  [
    variableTerm("Sex").identifier,
    { kind: "sex", variable: variableTerm("Sex"), variableType: "Categorical" },
  ],
]);

/**
 * Columns the mechanical rules read by name (`age`, `sex`, `group`, in any case).
 * A curated column with one of those names must be about the same thing, so that a curated
 * column and a mechanical one can only meet over the same variable.
 */
const MECHANICAL_NAMES = new Map<string, CurationKind>([
  ["age", "age"],
  ["group", "diagnosis"],
  ["sex", "sex"],
]);

const SEX_BY_IDENTIFIER = new Map(Object.values(VOCAB.sex).map((t) => [t.identifier, t]));
const FORMAT_BY_IDENTIFIER = new Map<string, { id: AgeFormatId; term: VocabTerm }>(
  AGE_FORMAT_IDS.map((id) => {
    const t = VOCAB.age_formats[id];
    if (t === undefined) throw new Error(`pinned Neurobagel vocabulary has no age format "${id}"`);
    return [t.identifier, { id, term: t }];
  }),
);

const quote = (value: string): string => JSON.stringify(value);

/** `identifier` as a term of `vocabulary`, or a problem saying why not. */
function pinnedTerm(
  where: string,
  given: { TermURL: string; Label: string },
  find: (identifier: string) => VocabTerm | null,
  vocabulary: string,
  problems: string[],
): VocabTerm | null {
  const found = find(given.TermURL);
  if (found === null) {
    problems.push(`${where}: ${given.TermURL} is not in the pinned ${vocabulary} vocabulary`);
    return null;
  }
  if (given.Label !== found.label) {
    problems.push(
      `${where}: the label of ${given.TermURL} must be ${quote(found.label)}, the pinned label, not ${quote(given.Label)}`,
    );
    return null;
  }
  return found;
}

function duplicatesOf(values: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) repeated.add(v);
    seen.add(v);
  }
  return [...repeated].sort(byCodeUnit);
}

/**
 * Turn one annotation block, as the annotation tool exports it, into a curated column.
 * `block` is raw (parsed JSON, unchecked) so that the generator for upstream annotations and the
 * file loader judge a column by the same code.
 */
export function curatedColumnFrom(
  name: string,
  block: unknown,
): { column: CuratedColumn } | { problems: string[] } {
  const where = `column ${quote(name)}`;
  const problems: string[] = [];

  const shaped = annotationBlock.safeParse(block);
  if (!shaped.success) {
    return {
      problems: shaped.error.issues.map((issue) => {
        const path = issue.path.length === 0 ? "" : `.${issue.path.join(".")}`;
        return `${where}${path}: ${issueMessage(issue)}`;
      }),
    };
  }
  const annotation = shaped.data;

  if (name === "") problems.push("a column name must not be empty");
  if (name === "participant_id") {
    problems.push(`${where}: the participant id column is always mapped by the transform`);
  }

  const about = ABOUT.get(annotation.IsAbout.TermURL);
  if (about === undefined) {
    return {
      problems: [
        ...problems,
        `${where}: IsAbout ${annotation.IsAbout.TermURL} is not curatable (curation carries ${[...ABOUT.keys()].join(", ")} columns)`,
      ],
    };
  }
  if (annotation.IsAbout.Label !== about.variable.label) {
    problems.push(
      `${where}: the label of ${about.variable.identifier} must be ${quote(about.variable.label)}`,
    );
  }
  if (annotation.VariableType !== about.variableType) {
    problems.push(
      `${where}: a column about ${about.variable.identifier} has VariableType ${about.variableType}, not ${annotation.VariableType}`,
    );
  }
  const reserved = MECHANICAL_NAMES.get(name.trim().toLowerCase());
  if (reserved !== undefined && reserved !== about.kind) {
    problems.push(
      `${where}: a column named like the ${reserved} column the transform reads must be about ${reserved}, not ${about.kind}`,
    );
  }
  const repeated = duplicatesOf(annotation.MissingValues);
  if (repeated.length > 0) {
    problems.push(`${where}: MissingValues repeats ${repeated.map(quote).join(", ")}`);
  }
  if (problems.length > 0 || annotation.VariableType !== about.variableType) return { problems };

  const base = { name, missingValues: [...annotation.MissingValues].sort(byCodeUnit) };
  switch (annotation.VariableType) {
    case "Categorical": {
      const levels = new Map<string, VocabTerm>();
      const entries = Object.entries(annotation.Levels).sort(([a], [b]) => byCodeUnit(a, b));
      // A diagnosis column may map no value at all, if it says what its values are instead
      // (they are all missing): that is how a reviewer withdraws the mechanical healthy control
      // mapping from a group column that is an intervention arm. Nothing else may be empty.
      const mapsNothing = entries.length === 0;
      if (mapsNothing && !(about.kind === "diagnosis" && annotation.MissingValues.length > 0)) {
        problems.push(
          `${where}: Levels is empty, so the column maps no value to a term (only a diagnosis column that lists its values as MissingValues may)`,
        );
      }
      for (const [raw, given] of entries) {
        const levelWhere = `${where} Levels[${quote(raw)}]`;
        const found =
          about.kind === "sex"
            ? pinnedTerm(
                levelWhere,
                given,
                (id) => SEX_BY_IDENTIFIER.get(id) ?? null,
                "sex",
                problems,
              )
            : pinnedTerm(levelWhere, given, diagnosisTerm, "diagnosis", problems);
        if (found !== null) levels.set(raw, found);
        if (annotation.MissingValues.includes(raw)) {
          problems.push(`${levelWhere}: a level cannot also be a missing value`);
        }
      }
      if (problems.length > 0) return { problems };
      return { column: { ...base, kind: about.kind as "sex" | "diagnosis", levels } };
    }
    case "Continuous": {
      const given = annotation.Format;
      const format = FORMAT_BY_IDENTIFIER.get(given.TermURL);
      if (format === undefined) {
        problems.push(
          given.TermURL === "nb:FromInt"
            ? `${where}: Format nb:FromInt is not in the pinned vocabulary; nb:FromFloat reads the same values`
            : `${where}: Format ${given.TermURL} is not an age format of the pinned vocabulary`,
        );
      } else if (given.Label !== format.term.label) {
        problems.push(
          `${where}: the label of ${given.TermURL} must be ${quote(format.term.label)}, the pinned label`,
        );
      }
      const range = annotation.ValueRange;
      if (range !== undefined) {
        if (range.Min > range.Max) problems.push(`${where}: ValueRange Min is above Max`);
        if (range.Min < AGE_MIN_YEARS || range.Max > AGE_MAX_YEARS) {
          problems.push(
            `${where}: ValueRange must lie within ${AGE_MIN_YEARS} to ${AGE_MAX_YEARS} years`,
          );
        }
      }
      if (problems.length > 0 || format === undefined) return { problems };
      return {
        column: {
          ...base,
          kind: "age",
          format: format.id,
          formatTerm: format.term,
          valueRange: range === undefined ? null : { min: range.Min, max: range.Max },
        },
      };
    }
    case "Collection": {
      const tool = pinnedTerm(
        `${where} IsPartOf`,
        annotation.IsPartOf,
        assessmentTerm,
        "assessment",
        problems,
      );
      if (problems.length > 0 || tool === null) return { problems };
      return { column: { ...base, kind: "assessment", tool } };
    }
  }
}

/** Whether `YYYY-MM-DD` names a day that exists. */
function isCalendarDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m === null) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return month >= 1 && month <= 12 && day >= 1 && day <= days;
}

/** The first dataset id of the reserved fixture band, `nm099900` (ADR 0068). */
const FIRST_RESERVED_NM_NUMBER = 99900;

function datasetIdProblem(id: string): string | null {
  const m = /^(nm|on)(\d{6})$/.exec(id);
  if (m === null) {
    return `${quote(id)} is not a dataset id curation may name (nm or on, then six digits)`;
  }
  if (m[1] === "nm" && Number(m[2]) >= FIRST_RESERVED_NM_NUMBER) {
    return `${id} is in the reserved fixture band and is never curated`;
  }
  return null;
}

export interface ParseOptions {
  /**
   * Today's date, `YYYY-MM-DD`, from the caller's clock (this module has none).
   * When given, an `evidence.date` after it is rejected: a review cannot have happened yet.
   */
  today?: string;
}

/**
 * Parse and check the text of `curation.json`.
 * Returns the entries by dataset id, or throws a `CurationError` listing the problems of the first
 * stage that has any (see the header).
 */
export function parseCuration(text: string, options: ParseOptions = {}): CurationFile {
  if (options.today !== undefined && !isCalendarDate(options.today)) {
    throw new Error(`parseCuration: today must be a YYYY-MM-DD date, not ${quote(options.today)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CurationError([
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  const keys = scanKeys(text);
  const keyProblems = [
    ...keys.duplicates.map((path) => `${path}: this key appears more than once`),
    ...keys.protoKeys.map((path) => `${path}: __proto__ is not allowed as a key`),
  ];
  if (keyProblems.length > 0) throw new CurationError(keyProblems);

  const shaped = fileSchema.safeParse(parsed);
  if (!shaped.success) throw new CurationError(shaped.error.issues.map(describeIssue));

  const problems: string[] = [];
  const entries = new Map<string, CurationEntry>();
  for (const id of Object.keys(shaped.data.datasets).sort(byCodeUnit)) {
    const raw = shaped.data.datasets[id];
    const here = `datasets.${id}`;
    const idProblem = datasetIdProblem(id);
    if (idProblem !== null) problems.push(`${here}: ${idProblem}`);
    if (!isCalendarDate(raw.evidence.date)) {
      problems.push(`${here}.evidence.date: ${quote(raw.evidence.date)} is not a YYYY-MM-DD date`);
    } else if (options.today !== undefined && raw.evidence.date > options.today) {
      problems.push(
        `${here}.evidence.date: ${raw.evidence.date} is after today, ${options.today}; a review cannot have happened yet`,
      );
    }
    const names = Object.keys(raw.columns).sort(byCodeUnit);
    if (names.length === 0) problems.push(`${here}.columns: an entry must curate a column`);

    const columns: CuratedColumn[] = [];
    for (const name of names) {
      const made = curatedColumnFrom(name, raw.columns[name]);
      if ("problems" in made) problems.push(...made.problems.map((p) => `${here}: ${p}`));
      else columns.push(made.column);
    }
    for (const kind of ["age", "sex"] as const) {
      const of = columns.filter((c) => c.kind === kind).map((c) => quote(c.name));
      if (of.length > 1) {
        problems.push(
          `${here}: more than one ${kind} column (${of.join(", ")}); a participant has one ${kind}`,
        );
      }
    }
    entries.set(
      id,
      markLoaded({
        datasetId: id,
        evidence: { ...raw.evidence },
        pins: {
          participantsTsv: raw.pins.participants_tsv,
          participantsJson: raw.pins.participants_json,
        },
        columns,
      }),
    );
  }
  if (problems.length > 0) throw new CurationError(problems);
  return { entries };
}
