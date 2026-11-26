/**
 * The generic HDF5 reader (`.h5`, `.hdf5`; publication-queue plan, card A4) and the text rules it
 * shares with the SNIRF reader.
 *
 * Every string the HDF5 walker (`shared/hdf5-meta.ts`) returns, attribute or dataset, goes through
 * three rules, and nothing else is read (signals are skipped by size):
 *
 * - **Identifier fields.** A field whose canonical name is in the scanner's identifier-key set
 *   (the JSON key rule's: a name, a birth date, a record number, a contact) and that holds a value
 *   is `hdf5-identifier-field`. A birth-date field is `identifier` at day precision and `review`
 *   at year or year-month precision; a contact field is `review`; a placeholder fires nothing.
 * - **Person fields.** In a field whose canonical name names a person ({@link PERSON_FIELDS}),
 *   a name-like word is `hdf5-freetext-name` (identifier).
 * - **Everywhere.** A path into someone's home directory is `hdf5-freetext` (review). A name-like
 *   word outside a person field is not a finding: units, condition names and device names are
 *   all name-like to the scanner's word test, which was built for slots that should hold a code.
 *
 * A finding's `field` is a fixed word or a canonical key from a closed set, never an HDF5 name,
 * which is arbitrary text and could itself be a name.
 */

import type { Hdf5Entry } from "../hdf5-meta";
import type { FormatReader, ReaderLimits, ReaderResult } from "../identifier-readers";
import {
  BIRTH_KEYS,
  type Finding,
  type FindingKind,
  type Severity,
  canonical,
  datePrecision,
  identifierKeySeverity,
  isNameLike,
  scanTextForLocalPaths,
  shapeOf,
} from "../identifier-scan";
import { walkForReader } from "./hdf5-incomplete";
import { isPersonField } from "./person-fields";
import { capText, contactIn } from "./text-header";

export { PERSON_FIELDS, isPersonField } from "./person-fields";

/** Values that mean "nothing was entered" in an identifier field or a SubjectID. */
export const EMPTY_VALUES: ReadonlySet<string> = new Set([
  "",
  "0",
  "unknown",
  "n/a",
  "na",
  "none",
  "null",
  "undefined",
  "x",
]);

/** The strings an entry holds, uncut. */
export function rawStringsOf(entry: Hdf5Entry): string[] {
  if (typeof entry.value === "string") return [entry.value];
  if (Array.isArray(entry.value)) {
    return (entry.value as unknown[]).filter((v): v is string => typeof v === "string");
  }
  return [];
}

/**
 * The strings an entry holds, each cut to the text rules' bound (`capText`, shared with the text
 * header readers). A cut value makes the read `partial` (`limit`): `walkForReader` says so.
 */
export function stringsOf(entry: Hdf5Entry): string[] {
  return rawStringsOf(entry).map((v) => capText(v).text);
}

/** A whitespace token of letters only (and the `' . -` a name may hold). */
const ALL_LETTERS = /^[\p{L}'.-]+$/u;

/**
 * How a person field's text reads: `name` when a token of letters only is name-like (`Marlow`),
 * `freetext` when a name-like token mixes letters and digits (`john3`, a cohort code), `none`
 * otherwise. The same split as the SubjectID rule (lead ruling, 2026-11-25).
 */
export function readPersonText(text: string): "name" | "freetext" | "none" {
  const tokens = text.split(/\s+/).filter((t) => t !== "" && isNameLike(t));
  if (tokens.some((t) => ALL_LETTERS.test(t))) return "name";
  return tokens.length > 0 ? "freetext" : "none";
}

/**
 * The text rules over one entry. `field` is the fixed word findings carry (`hdf5.attribute`,
 * `snirf.stim-name`, ...); the entry's own name decides only which rules apply.
 */
export function scanEntryText(entry: Hdf5Entry, field: string): Finding[] {
  const numbers = numbersOf(entry);
  if (numbers.length > 0) return scanNumericIdentifier(entry, numbers);
  const values = stringsOf(entry);
  if (values.length === 0) return [];
  const out: Finding[] = [];
  const add = (kind: FindingKind, severity: Severity, at: string, text: string) =>
    out.push({ kind, severity, field: at, shape: shapeOf(text) });
  const key = canonical(entry.name);
  const filled = values.filter((v) => !EMPTY_VALUES.has(v.trim().toLowerCase()));

  const keySeverity = identifierKeySeverity(key);
  if (keySeverity && filled.length > 0) {
    let severity: Severity = keySeverity;
    if (BIRTH_KEYS.has(key)) {
      const coarse = filled.every((v) => {
        const p = datePrecision(v);
        return p === "year" || p === "month";
      });
      severity = coarse ? "review" : "identifier";
    }
    // The canonical key is from the scanner's closed set, so it may stand as the field.
    add("hdf5-identifier-field", severity, key, filled[0] as string);
  } else if (isPersonField(entry.name)) {
    const name = filled.find((v) => readPersonText(v) === "name");
    const other = filled.find((v) => readPersonText(v) === "freetext");
    if (name !== undefined) add("hdf5-freetext-name", "identifier", field, name);
    else if (other !== undefined) add("hdf5-freetext", "review", field, other);
  }
  // A home-directory path or contact details (the text header readers' rules), once per entry.
  for (const v of values) {
    // One finding per entry for its text: an identifier field already says it holds a value.
    if (out.some((f) => f.kind === "hdf5-freetext" || f.kind === "hdf5-identifier-field")) break;
    if (scanTextForLocalPaths(v).length > 0 || contactIn(v) !== null) {
      add("hdf5-freetext", "review", field, v);
      break;
    }
  }
  return out;
}

/** Numbers that mean "nothing was entered" in an identifier field. */
const NUMERIC_PLACEHOLDERS: ReadonlySet<number> = new Set([0, -1]);

/** The numbers an entry holds, or none. */
function numbersOf(entry: Hdf5Entry): number[] {
  if (!Array.isArray(entry.value)) return [];
  const values = entry.value as unknown[];
  return values.length > 0 && values.every((v) => typeof v === "number")
    ? (values as number[])
    : [];
}

/**
 * An identifier-key field that holds numbers (lead ruling, review round 1): a number other than
 * the placeholders 0 and -1 is content.
 * A record number or ID is `identifier`; a birth-date field is `identifier` when a number is a
 * `YYYYMMDD` date at day precision and `review` for any other number (a year, a year and month, or
 * a number that is not a date). Numbers under any other name are not text and fire nothing.
 */
export function scanNumericIdentifier(entry: Hdf5Entry, numbers: readonly number[]): Finding[] {
  const key = canonical(entry.name);
  const keySeverity = identifierKeySeverity(key);
  if (keySeverity === null) return [];
  // 0 and -1 mean "nothing was entered", as an empty string does (lead ruling).
  const filled = numbers.filter((n) => !NUMERIC_PLACEHOLDERS.has(n));
  if (filled.length === 0) return [];
  let severity: Severity = keySeverity;
  let shown = filled[0] as number;
  if (BIRTH_KEYS.has(key)) {
    const dated = filled.find(
      (n) => Number.isInteger(n) && /^\d{8}$/.test(String(n)) && datePrecision(String(n)) === "day",
    );
    severity = dated === undefined ? "review" : "identifier";
    if (dated !== undefined) shown = dated;
  }
  return [{ kind: "hdf5-identifier-field", severity, field: key, shape: shapeOf(String(shown)) }];
}

/** The fixed field word of a generic entry. */
const genericField = (entry: Hdf5Entry) =>
  entry.kind === "attribute" ? "hdf5.attribute" : "hdf5.dataset";

/** The text rules over every entry of a walk. */
export function scanHdf5Entries(entries: readonly Hdf5Entry[]): Finding[] {
  return entries.flatMap((e) => scanEntryText(e, genericField(e)));
}

/**
 * The limits of the HDF5-based readers. They admit the largest public SNIRF files measured for
 * card A4 (the numbers are in `test/fixtures/hdf5/README.md`); past them the file is `partial`
 * (`limit`), never clean.
 */
export const HDF5_READER_LIMITS: ReaderLimits = {
  maxBytes: 48 * 1024 * 1024,
  maxReads: 1000,
  // The walker inflates at most 4 MiB of chunks for one small value (`hdf5-meta.ts`).
  maxInflatedBytes: 4 * 1024 * 1024,
  timeMs: 180_000,
};

/** Build a reader result from a walk's findings and shortfall. */
export function readerResult(
  findings: Finding[],
  incomplete: ReaderResult["incomplete"],
): ReaderResult {
  return incomplete === undefined
    ? { findings, coverage: "complete" }
    : { findings, coverage: "partial", incomplete };
}

export const HDF5_GENERIC_READER: FormatReader = {
  id: "hdf5",
  extensions: [".h5", ".hdf5"],
  limits: HDF5_READER_LIMITS,
  version: "1",
  async scan(src, _path, limits) {
    const { walk, incomplete } = await walkForReader(src, limits);
    return readerResult(scanHdf5Entries(walk.entries), incomplete);
  },
};
