/**
 * Deterministic identifier screening for deposited datasets.
 *
 * The Data Contributor Terms require that a deposit carry no names, dates of birth,
 * acquisition dates finer than year, or record numbers, in file contents, vendor
 * headers, file names or sidecars. This module is the mechanical half of checking
 * that: pure functions over bytes and strings, no I/O, no dependencies, so the CLI
 * preflight, the publication review and a fleet sweep all ask the same question.
 *
 * **A finding never carries a value.** It names the kind, the field, and the SHAPE of
 * what was there (letters become `a`/`A`, digits `9`), because a report that quotes a
 * participant's name has leaked it a second time. `shapeOf` is the only thing that
 * touches field text on its way into a finding.
 *
 * **Screening is a best effort and says what it did not read.** `formatCoverage`
 * counts recording files in formats this module cannot parse, so "no findings" is
 * never mistaken for "nothing there": only the EDF/BDF header layout (fixed, public,
 * and the format behind the report that prompted this) is parsed here.
 *
 * Policy owned here, not by a library (make-versus-take): what counts as an identifier
 * is NEMAR's rule. The year-only allowance follows HIPAA Safe Harbor, which permits the
 * year of a date. `01.01.YY` / `01-JAN-YYYY` is therefore clean and any other day is not.
 */

export type Severity = "identifier" | "review";

export type FindingKind =
  | "edf-unreadable"
  | "edf-patient-name"
  | "edf-patient-code"
  | "edf-patient-freetext"
  | "edf-patient-birthdate"
  | "edf-recording-startdate"
  | "edf-recording-freetext"
  | "edf-recording-technician"
  | "edf-startdate"
  | "participants-identifier-column"
  | "json-identifier-key"
  | "acq-time-dated"
  | "image-or-document-file"
  | "tooling-debris"
  | "local-user-path";

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  /** Where in the file or table: a header field name, a column, a JSON key. */
  field: string;
  /** Letters, digits and length only. Never the value. */
  shape: string;
}

/** Size of the fixed EDF/BDF header, which holds every identification field. */
export const EDF_HEADER_BYTES = 256;

/** Tokens that mean "nothing was entered". Compared case-insensitively. */
const PLACEHOLDER_WORDS = new Set([
  "x",
  "x_x",
  "xx",
  "unknown",
  "anonymous",
  "anon",
  "n/a",
  "na",
  "none",
  "null",
  "default",
  "noname",
  "no_name",
  "patient",
  "subject",
  "participant",
  "-",
]);

/** Words that describe a field or a group, not a person. Compared case-insensitively. */
const NEUTRAL_WORDS = new Set([
  "m",
  "f",
  "male",
  "female",
  "sex",
  "age",
  "id",
  "name",
  "hand",
  "handed",
  "right",
  "left",
  "sub",
  "subj",
  "session",
  "ses",
  "run",
  "task",
  "rest",
  "resting",
  "test",
  "study",
  "control",
  "healthy",
  "recording",
  "eeg",
  "birth",
  "birthdate",
  "date",
  "startdate",
]);

/** `sub-01`, `S_01`, `subject12`, `P3`: a study code, not a person. */
const SUBJECT_LABEL = /^(sub|subj|subject|s|p|pt|participant)[-_ ]?\d+$/i;

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Letters to `a`/`A`, digits to `9`, runs of three or more collapsed to `x+`. */
export function shapeOf(text: string): string {
  return text
    .replace(/[A-Z]/g, "A")
    .replace(/[a-z]/g, "a")
    .replace(/[0-9]/g, "9")
    .replace(/(.)\1{2,}/g, "$1+");
}

function isPlaceholder(token: string): boolean {
  return PLACEHOLDER_WORDS.has(token.toLowerCase());
}

/** True for a token that is a study code or placeholder, so not a name. */
function isCodeLike(token: string): boolean {
  return isPlaceholder(token) || SUBJECT_LABEL.test(token) || /^\d+$/.test(token);
}

/** A word made only of letters (and `' . _ -`): the shape of a name, with no digit to make it a code. */
function isNameLike(token: string): boolean {
  return (
    /^\p{L}[\p{L}'._-]+$/u.test(token) &&
    !isCodeLike(token) &&
    !NEUTRAL_WORDS.has(token.toLowerCase())
  );
}

function fieldText(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) {
    const b = bytes[i] as number;
    out += b === 0 ? " " : String.fromCharCode(b);
  }
  return out.trim();
}

/**
 * A day-month-year token: `14-MAR-1993`, `14-Mar-1993`, `14.03.1993`. Writers vary in month
 * case and year width, so both are accepted; null when it is not a date at all.
 */
function parseLooseDate(token: string): { day: number; month: number; year: number } | null {
  const m = /^(\d{1,2})[-./ ]([A-Za-z]{3}|\d{1,2})[-./ ](\d{1,4})$/.exec(token);
  if (!m) return null;
  const monthText = m[2] as string;
  const month = /^\d+$/.test(monthText)
    ? Number(monthText)
    : MONTHS.indexOf(monthText.toUpperCase()) + 1;
  if (month < 1 || month > 12) return null;
  return { day: Number(m[1]), month, year: Number(m[3]) };
}

/** True when a date is year-only by convention: the first of January. */
function isYearOnly(day: number, month: number): boolean {
  return day === 1 && month === 1;
}

/** Parse the EDF family's `dd.mm.yy` start date field. */
function parseHeaderStartDate(text: string): { day: number; month: number } | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{2})$/.exec(text);
  if (!m) return null;
  return { day: Number(m[1]), month: Number(m[2]) };
}

/**
 * The raw identification text of an EDF/BDF header, for CALLERS THAT ONLY COUNT (for example
 * distinct values per dataset). It returns values: never log it, serialize it, or put it in a
 * finding. Offsets are the single source of truth for this module's own scan.
 */
export function edfIdentificationText(bytes: Uint8Array): {
  patient: string;
  recording: string;
  startdate: string;
} {
  return {
    patient: fieldText(bytes, 8, 88),
    recording: fieldText(bytes, 88, 168),
    startdate: fieldText(bytes, 168, 176),
  };
}

export function detectEdfFamily(bytes: Uint8Array): "edf" | "bdf" | null {
  if (bytes.length < EDF_HEADER_BYTES) return null;
  if (bytes[0] === 0xff && fieldText(bytes, 1, 8) === "BIOSEMI") return "bdf";
  if (fieldText(bytes, 0, 8) === "0") return "edf";
  return null;
}

/**
 * Screen the 256-byte header of an EDF, EDF+ or BDF file.
 *
 * An unreadable header is itself a finding (`edf-unreadable`, severity review) and never
 * an empty list: a caller that could not look must not read the result as clean.
 */
export function scanEdfHeader(bytes: Uint8Array): Finding[] {
  if (!detectEdfFamily(bytes)) {
    return [{ kind: "edf-unreadable", severity: "review", field: "header", shape: "" }];
  }
  const findings: Finding[] = [];
  const add = (kind: FindingKind, severity: Severity, field: string, text: string) =>
    findings.push({ kind, severity, field, shape: shapeOf(text) });

  // Local patient identification, bytes 8..88.
  const patient = fieldText(bytes, 8, 88);
  const tokens = patient === "" ? [] : patient.split(/\s+/);
  const sexWords = ["m", "f", "x", "male", "female"];
  const structured =
    tokens.length >= 4 &&
    sexWords.includes((tokens[1] as string).toLowerCase()) &&
    ((tokens[2] as string) === "X" || parseLooseDate(tokens[2] as string) !== null);
  const checkBirth = (token: string) => {
    const date = parseLooseDate(token);
    if (date && !isYearOnly(date.day, date.month)) {
      add("edf-patient-birthdate", "identifier", "patient.birthdate", token);
    }
  };
  if (structured) {
    const [code, , birth, name] = tokens as [string, string, string, string];
    if (isNameLike(code)) add("edf-patient-code", "identifier", "patient.code", code);
    if (isNameLike(name)) add("edf-patient-name", "identifier", "patient.name", name);
    checkBirth(birth);
  } else {
    // A classic free-text patient field: any date is a birth date, any bare word a possible name.
    let named = false;
    for (const token of tokens) {
      if (parseLooseDate(token)) checkBirth(token);
      else if (isNameLike(token)) named = true;
    }
    if (named) add("edf-patient-freetext", "identifier", "patient", patient);
  }

  // Local recording identification, bytes 88..168.
  const recording = fieldText(bytes, 88, 168);
  if (recording !== "" && !isPlaceholder(recording)) {
    const parts = recording.split(/\s+/);
    if (parts[0] === "Startdate") {
      const startToken = parts[1] ?? "";
      const date = parseLooseDate(startToken);
      if (startToken !== "X" && (!date || !isYearOnly(date.day, date.month))) {
        add("edf-recording-startdate", "identifier", "recording.startdate", startToken);
      }
      const technician = parts[3] ?? "X";
      if (isNameLike(technician)) {
        add("edf-recording-technician", "review", "recording.technician", technician);
      }
    } else if (parts.some((t) => isNameLike(t) && !parseLooseDate(t))) {
      add("edf-recording-freetext", "review", "recording", recording);
    }
  }

  // Header start date, bytes 168..176.
  const startText = fieldText(bytes, 168, 176);
  const start = parseHeaderStartDate(startText);
  if (!start || !isYearOnly(start.day, start.month)) {
    add("edf-startdate", "identifier", "startdate", startText);
  }
  return findings;
}

const IDENTIFIER_COLUMN =
  /^(name|first[ _-]?name|last[ _-]?name|full[ _-]?name|given[ _-]?name|surname|initials|dob|birth[ _-]?date|date[ _-]?of[ _-]?birth|birthday|e[ _-]?mail|phone|telephone|address|street|zip|post[ _-]?code|mrn|ssn|medical[ _-]?record.*|record[ _-]?number|patient[ _-]?(id|name)|national[ _-]?id)$/i;

/** Screen the header row of a participants/scans table (tab-separated). */
export function scanTableColumns(headerRow: string): Finding[] {
  const out: Finding[] = [];
  for (const raw of headerRow.replace(/^\uFEFF/, "").split("\t")) {
    const column = raw.trim();
    if (column !== "" && IDENTIFIER_COLUMN.test(column)) {
      out.push({
        kind: "participants-identifier-column",
        severity: "identifier",
        field: column,
        shape: shapeOf(column),
      });
    }
  }
  return out;
}

/**
 * Screen one `acq_time` value from a scans table.
 *
 * BIDS allows shifted dates and `n/a`, and a shifted date looks like a date, so this is
 * review severity: it marks "a calendar date finer than year is present", which the
 * Contributor Terms bar, and leaves the call to a person.
 */
export function scanAcqTime(value: string): Finding[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return [];
  if (isYearOnly(Number(m[3]), Number(m[2]))) return [];
  return [{ kind: "acq-time-dated", severity: "review", field: "acq_time", shape: shapeOf(value) }];
}

/**
 * Keys that name a person or a clinical record. Bare `name`, `first_name` and the like are
 * NOT here: citation and dataset metadata carry the authors' names by design, and a
 * pipeline config has a `name` for everything.
 */
const IDENTIFIER_KEY =
  /^(patient[ _-]?(name|id|guid)|birth[ _-]?date|date[ _-]?of[ _-]?birth|dob|exam[ _-]?doctor|diagnosis[ _-]?doctor|request[ _-]?doctor|admission[ _-]?id|bed[ _-]?number|medical[ _-]?record.*|mrn|ssn|national[ _-]?id)$/i;
/** Keys that may be an author's public contact or a participant's: a person decides. */
const REVIEW_KEY = /^(address|contact|phone|telephone|e[ _-]?mail|national)$/i;

/** Walk a parsed JSON document; flag identifier-named keys that hold a non-empty value. */
export function scanJsonKeys(doc: unknown, path = ""): Finding[] {
  const out: Finding[] = [];
  if (Array.isArray(doc)) {
    for (const item of doc) out.push(...scanJsonKeys(item, path));
    return out;
  }
  if (doc === null || typeof doc !== "object") return out;
  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    if (value !== null && typeof value === "object") {
      out.push(...scanJsonKeys(value, path ? `${path}.${key}` : key));
      continue;
    }
    const text = value === null || value === undefined ? "" : String(value).trim();
    const severity: Severity | null =
      text === ""
        ? null
        : IDENTIFIER_KEY.test(key)
          ? "identifier"
          : REVIEW_KEY.test(key)
            ? "review"
            : null;
    if (severity) {
      out.push({
        kind: "json-identifier-key",
        severity,
        field: path ? `${path}.${key}` : key,
        shape: shapeOf(text),
      });
    }
  }
  return out;
}

const IMAGE_OR_DOCUMENT = /\.(jpe?g|png|gif|bmp|tiff?|webp|pdf|docx?|xlsx?|pptx?|rtf|odt)$/i;
/** BIDS photo suffixes (electrode and head photographs) are an accepted image use. */
const BIDS_PHOTO = /_photo\.(jpe?g|png|tiff?)$/i;
const TOOLING_DEBRIS =
  /(^|\/)(\.idea|\.vscode|__pycache__|\.ipynb_checkpoints|\.DS_Store|Thumbs\.db)(\/|$)|\.pyc$/;

/**
 * Screen a list of dataset-relative paths. Images and documents outside the BIDS photo
 * convention can show a name on screen or be a consent form; editor and interpreter
 * debris carries local user names and machine paths.
 */
export function scanPaths(paths: string[]): Finding[] {
  const out: Finding[] = [];
  for (const path of paths) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (TOOLING_DEBRIS.test(path)) {
      out.push({ kind: "tooling-debris", severity: "review", field: "path", shape: shapeOf(base) });
    } else if (IMAGE_OR_DOCUMENT.test(base) && !BIDS_PHOTO.test(base)) {
      out.push({
        kind: "image-or-document-file",
        severity: "review",
        field: "path",
        shape: shapeOf(base),
      });
    }
  }
  return out;
}

const LOCAL_USER_PATH = /(?:[A-Za-z]:\\{1,2}Users\\{1,2}|\/Users\/|\/home\/)[A-Za-z0-9_.-]+/;

/** Screen text for a local user path such as `C:\Users\<name>` or `/Users/<name>`. */
export function scanTextForLocalPaths(text: string): Finding[] {
  const m = LOCAL_USER_PATH.exec(text);
  return m
    ? [{ kind: "local-user-path", severity: "review", field: "text", shape: shapeOf(m[0]) }]
    : [];
}

/** Recording formats this module parses, and formats it knows exist but does not read. */
const SCREENED_EXTENSIONS = [".edf", ".bdf"];
const UNSCREENED_EXTENSIONS = [
  ".vhdr",
  ".set",
  ".fdt",
  ".fif",
  ".fif.gz",
  ".ds",
  ".nwb",
  ".snirf",
  ".xdf",
  ".cnt",
  ".mff",
  ".gdf",
  ".con",
  ".sqd",
  ".mefd",
  ".nii",
  ".nii.gz",
];

export interface FormatCoverage {
  screened: number;
  /** Count of recording files in formats this module cannot parse, by extension. */
  unscreened: Record<string, number>;
}

export function formatCoverage(paths: string[]): FormatCoverage {
  const unscreened: Record<string, number> = {};
  let screened = 0;
  for (const raw of paths) {
    const path = raw.toLowerCase();
    if (SCREENED_EXTENSIONS.some((e) => path.endsWith(e))) {
      screened++;
      continue;
    }
    const hit = UNSCREENED_EXTENSIONS.filter((e) => path.endsWith(e)).sort(
      (a, b) => b.length - a.length,
    )[0];
    if (hit) unscreened[hit] = (unscreened[hit] ?? 0) + 1;
  }
  return { screened, unscreened };
}

/** Count findings by kind. Values never enter a summary, only counts. */
export function countByKind(findings: Finding[]): Partial<Record<FindingKind, number>> {
  const counts: Partial<Record<FindingKind, number>> = {};
  for (const f of findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  return counts;
}
