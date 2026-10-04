/**
 * Deterministic identifier screening for deposited datasets.
 *
 * The Data Contributor Terms require that a deposit carry no names, dates of birth,
 * acquisition dates finer than year, or record numbers, in file contents, vendor
 * headers, file names or sidecars. This module is the mechanical half of checking
 * that: pure functions over bytes and strings, no I/O, no dependencies, so the CLI
 * preflight, the publication gate and a fleet sweep all ask the same question.
 *
 * **A finding never carries a value.** It names the kind, a field name drawn from a closed
 * set (a header field, a matched column or key, never an ancestor key or a path), and the
 * SHAPE of what was there. `shapeOf` is the only way to build a {@link Shape}, and it maps
 * every letter to `a`/`A`, every digit to `9` and every character it does not recognize,
 * including all non-ASCII, to `?`, because a report that quotes a participant's name has
 * leaked it a second time.
 *
 * **Screening is a best effort and says what it did not read.** `formatCoverage` counts
 * recording files in formats this module cannot parse, so a caller can tell "nothing
 * found" from "nothing looked at"; a caller must not call a dataset clean while that
 * count is non-zero. Only the EDF/BDF identification fields are parsed here: the patient
 * identification, the recording identification and the start date and time of the
 * 256-byte header. Signal-header fields (transducer, prefilter), reserved bytes and EDF+
 * annotation channels are not read.
 *
 * Policy owned here, not by a library (make-versus-take): what counts as an identifier
 * is NEMAR's rule. A birth date is an identifier unless it is year-only (1 January, in any
 * common layout; a date that is 1 January only under one of two day-month orders is flagged).
 * An acquisition date is NOT an identifier on its own: it is reported at review severity and
 * never blocks, because it names nobody unless something else links the recording to a person.
 */

export type Severity = "identifier" | "review";

export type FindingKind =
  | "edf-unreadable"
  | "edf-patient-nonascii"
  | "edf-recording-nonascii"
  | "path-subject-label"
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

/** Findings that name a person or a clinical record: what must not stay public. */
export const DIRECT_KINDS: ReadonlySet<FindingKind> = new Set<FindingKind>([
  "edf-patient-name",
  "edf-patient-code",
  "edf-patient-freetext",
  "edf-patient-birthdate",
  "edf-patient-nonascii",
  "json-identifier-key",
  "participants-identifier-column",
]);

/**
 * Calendar dates finer than year in a header. Policy (2026-10-04): an acquisition date alone is
 * acceptable when nothing links it to an identifiable person, so these are review findings and
 * never gate a publication; a birth date, a name or a record number is what does.
 */
export const DATE_KINDS: ReadonlySet<FindingKind> = new Set<FindingKind>([
  "edf-startdate",
  "edf-recording-startdate",
]);

/** The shape of some text: produced only by {@link shapeOf}, so a raw value cannot be assigned to it. */
export type Shape = string & { readonly __brand: "Shape" };

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  /** A header field, or a matched column or key. Never an ancestor key, a path or a value. */
  field: string;
  /** Letters, digits and length only; never the value. */
  shape: Shape;
}

/** Size of the fixed EDF/BDF header, which holds the identification fields this module reads. */
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

/**
 * Words that describe a field, a group or a device, not a person. Compared
 * case-insensitively, per alphabetic part, so `right-handed` is neutral when both parts are.
 */
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
  "handedness",
  "right",
  "left",
  "ambidextrous",
  "sub",
  "subj",
  "session",
  "ses",
  "run",
  "task",
  "rest",
  "resting",
  "test",
  "pilot",
  "phantom",
  "study",
  "control",
  "healthy",
  "recording",
  "eeg",
  "emg",
  "meg",
  "ieeg",
  "birth",
  "birthdate",
  "date",
  "startdate",
  "weight",
  "height",
  "kg",
  "cm",
  "year",
  "years",
  "anonymized",
  "anonymised",
  "deidentified",
  "de",
  "identified",
  "unnamed",
  "nn",
  "hc",
  "pd",
  "ad",
  "mci",
  "and",
  "biosemi",
  "neuracle",
  "neuroscan",
  "brainvision",
  "brainproducts",
  "actichamp",
  "nihonkohden",
  "natus",
  "compumedics",
  "eego",
  "mitsar",
  "emotiv",
  "openbci",
  "gtec",
  "biopac",
  "bitbrain",
  "cognionics",
]);

/** `sub-01`, `S_01`, `subject12`, `P3`: a study code, not a person. */
const SUBJECT_LABEL = /^(sub|subj|subject|s|p|pt|participant)[-_ ]?\d+$/i;

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/**
 * The shape of some text: uppercase letters become `A`, other letters `a`, digits `9`,
 * printable ASCII punctuation and space stay, and EVERYTHING else (non-ASCII, control
 * characters, combining marks) becomes `?`. Runs of three or more collapse to `x+`.
 */
export function shapeOf(text: string): Shape {
  let out = "";
  for (const ch of text) {
    if (/\p{Lu}/u.test(ch)) out += "A";
    else if (/\p{L}/u.test(ch)) out += "a";
    else if (/\p{N}/u.test(ch)) out += "9";
    else if (/^[ -~]$/.test(ch)) out += ch;
    else out += "?";
  }
  return out.replace(/(.)\1{2,}/g, "$1+") as Shape;
}

function isPlaceholder(token: string): boolean {
  return PLACEHOLDER_WORDS.has(token.toLowerCase());
}

/** True for a token that is a study code or placeholder, so not a name. */
function isCodeLike(token: string): boolean {
  return isPlaceholder(token) || SUBJECT_LABEL.test(token) || /^\d+$/.test(token);
}

function isNeutral(word: string): boolean {
  const lower = word.toLowerCase();
  return NEUTRAL_WORDS.has(lower) || PLACEHOLDER_WORDS.has(lower);
}

/**
 * A token that could be a person's name.
 *
 * A token of letters (and `' . _ -`) only is name-like unless every alphabetic part is a
 * neutral word, so a two-letter surname is caught and `right-handed` is not. A token that
 * mixes letters with digits or symbols (`john3`, `weight=71`) is name-like only when it
 * holds an alphabetic run of four or more letters that is not a neutral word, so a study
 * code like `S_01` is not, and a short name fused to digits is a known miss.
 */
function isNameLike(token: string): boolean {
  if (token === "" || isCodeLike(token)) return false;
  if (/^[\p{L}'._-]+$/u.test(token)) {
    const parts = token.split(/['._-]+/).filter((p) => p !== "");
    return parts.length > 0 && !parts.every(isNeutral);
  }
  const runs = token.match(/\p{L}+/gu) ?? [];
  return runs.some((run) => run.length >= 4 && !isNeutral(run));
}

function hasNonAscii(bytes: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if ((bytes[i] as number) >= 0x80) return true;
  return false;
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

interface DateParts {
  day: number;
  month: number;
  year: number;
}

const validDayMonth = (day: number, month: number) =>
  month >= 1 && month <= 12 && day >= 1 && day <= 31;

/**
 * Every way a token can be read as a calendar date, or an empty list when it is not one.
 * Layouts: `14-MAR-1993` and `14-Mar-1993` (month by name), `1993-03-14` (ISO), `14.03.1993`
 * and `03/14/1993` (day-first and month-first both offered when both are possible, because
 * only the writer knows which it meant), and compact `19930314`.
 */
function dateCandidates(token: string): DateParts[] {
  let m = /^(\d{1,2})[-./ ]([A-Za-z]{3,9})[-./ ](\d{1,4})$/.exec(token);
  if (m) {
    const month = MONTHS.indexOf((m[2] as string).slice(0, 3).toUpperCase()) + 1;
    const day = Number(m[1]);
    return validDayMonth(day, month) ? [{ day, month, year: Number(m[3]) }] : [];
  }
  m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/.exec(token);
  if (m) {
    const [month, day] = [Number(m[2]), Number(m[3])];
    return validDayMonth(day, month) ? [{ day, month, year: Number(m[1]) }] : [];
  }
  m = /^(\d{1,2})[-./ ](\d{1,2})[-./ ](\d{2,4})$/.exec(token);
  if (m) {
    const [a, b, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const out: DateParts[] = [];
    if (validDayMonth(a, b)) out.push({ day: a, month: b, year });
    if (validDayMonth(b, a)) out.push({ day: b, month: a, year });
    return out;
  }
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(token);
  if (m) {
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return year >= 1900 && year <= 2100 && validDayMonth(day, month) ? [{ day, month, year }] : [];
  }
  return [];
}

/** Year-only by convention: the date is 1 January under EVERY reading of the token. */
function isYearOnly(candidates: DateParts[]): boolean {
  return candidates.length > 0 && candidates.every((c) => c.day === 1 && c.month === 1);
}

/** Parse the EDF family's `dd.mm.yy` start date field. */
function parseHeaderStartDate(text: string): { day: number; month: number } | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{2})$/.exec(text);
  if (!m) return null;
  return { day: Number(m[1]), month: Number(m[2]) };
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
    return [{ kind: "edf-unreadable", severity: "review", field: "header", shape: shapeOf("") }];
  }
  const findings: Finding[] = [];
  const add = (kind: FindingKind, severity: Severity, field: string, text: string) =>
    findings.push({ kind, severity, field, shape: shapeOf(text) });

  // Local patient identification, bytes 8..88. The specification says ASCII; a byte above
  // 0x7F cannot be a placeholder, and no rule below can read it, so it is a finding itself.
  const patient = fieldText(bytes, 8, 88);
  if (hasNonAscii(bytes, 8, 88)) add("edf-patient-nonascii", "identifier", "patient", patient);
  const tokens = patient === "" ? [] : patient.split(/\s+/);
  const sexWords = ["m", "f", "x", "male", "female"];
  const structured =
    tokens.length >= 4 &&
    sexWords.includes((tokens[1] as string).toLowerCase()) &&
    ((tokens[2] as string) === "X" || dateCandidates(tokens[2] as string).length > 0);
  const checkBirth = (token: string) => {
    const candidates = dateCandidates(token);
    if (candidates.length > 0 && !isYearOnly(candidates)) {
      add("edf-patient-birthdate", "identifier", "patient.birthdate", token);
    }
  };
  if (structured) {
    const [code, , birth, name] = tokens as [string, string, string, string];
    if (isNameLike(code)) add("edf-patient-code", "identifier", "patient.code", code);
    if (isNameLike(name)) add("edf-patient-name", "identifier", "patient.name", name);
    checkBirth(birth);
    // Additional subfields (`hand=1`, `weight=71`) are free text too.
    const extras = tokens.slice(4);
    for (const token of extras) checkBirth(token);
    if (extras.some((t) => dateCandidates(t).length === 0 && isNameLike(t))) {
      add("edf-patient-freetext", "identifier", "patient.additional", extras.join(" "));
    }
  } else {
    // A classic free-text patient field: any date is a birth date, any bare word a possible name.
    let named = false;
    for (const token of tokens) {
      if (dateCandidates(token).length > 0) checkBirth(token);
      else if (isNameLike(token)) named = true;
    }
    if (named) add("edf-patient-freetext", "identifier", "patient", patient);
  }

  // Local recording identification, bytes 88..168.
  const recording = fieldText(bytes, 88, 168);
  if (hasNonAscii(bytes, 88, 168)) add("edf-recording-nonascii", "review", "recording", recording);
  if (recording !== "" && !isPlaceholder(recording)) {
    const parts = recording.split(/\s+/);
    const keyword = (parts[0] as string).toLowerCase() === "startdate";
    // Any date in the field is an acquisition date unless it is year-only; after the
    // Startdate keyword, something that is neither X nor a date cannot be shown to be clean.
    const dated = parts.map(dateCandidates);
    if (dated.some((c) => c.length > 0 && !isYearOnly(c))) {
      add("edf-recording-startdate", "review", "recording.startdate", recording);
    } else if (keyword && parts[1] !== undefined && parts[1] !== "X" && dated[1]?.length === 0) {
      add("edf-recording-startdate", "review", "recording.startdate", parts[1]);
    }
    // Admin code, technician and equipment (or free text) that read as names.
    const rest = keyword ? parts.slice(2) : parts;
    rest.forEach((token, i) => {
      if (dateCandidates(token).length > 0 || !isNameLike(token)) return;
      const technician = keyword && i === 1;
      add(
        technician ? "edf-recording-technician" : "edf-recording-freetext",
        "review",
        technician ? "recording.technician" : "recording",
        token,
      );
    });
  }

  // Header start date, bytes 168..176.
  const startText = fieldText(bytes, 168, 176);
  const start = parseHeaderStartDate(startText);
  if (!start || !(start.day === 1 && start.month === 1)) {
    add("edf-startdate", "review", "startdate", startText);
  }
  return findings;
}

const IDENTIFIER_COLUMN =
  /^(name|first[ _-]?name|last[ _-]?name|full[ _-]?name|given[ _-]?name|surname|initials|dob|birth[ _-]?date|date[ _-]?of[ _-]?birth|birthday|e[ _-]?mail|phone|telephone|address|street|zip|post[ _-]?code|mrn|ssn|medical[ _-]?record([ _-]?(number|no|id))?|record[ _-]?number|patient[ _-]?(id|name)|national[ _-]?id)$/i;

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

/** A label that is only letters, four or more, and not a descriptive word, reads as a name. */
function labelIsNameLike(label: string): boolean {
  return /^\p{L}{4,}$/u.test(label) && !isNeutral(label);
}

/**
 * Screen the participant labels in a participants table (the first column, `sub-<label>`).
 * Review severity: BIDS labels are free alphanumerics, and an all-letter label of four or
 * more letters that is not a descriptive word may be a name.
 */
export function scanParticipantIds(tsvText: string): Finding[] {
  const out: Finding[] = [];
  const rows = tsvText
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .slice(1);
  for (const row of rows) {
    const id = (row.split("\t")[0] ?? "").trim().replace(/^sub-/i, "");
    if (labelIsNameLike(id)) {
      out.push({
        kind: "path-subject-label",
        severity: "review",
        field: "participant_id",
        shape: shapeOf(id),
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
  if (Number(m[3]) === 1 && Number(m[2]) === 1) return [];
  return [{ kind: "acq-time-dated", severity: "review", field: "acq_time", shape: shapeOf(value) }];
}

/**
 * Keys that name a person or a clinical record. Bare `name`, `first_name` and the like are
 * NOT here: citation and dataset metadata carry the authors' names by design, and a
 * pipeline config has a `name` for everything. Every alternative is a closed spelling, so a
 * matched key can be reported as the field name without carrying a value.
 */
const IDENTIFIER_KEY =
  /^(patient[ _-]?(name|id|guid)|birth[ _-]?date|date[ _-]?of[ _-]?birth|dob|exam[ _-]?doctor|diagnosis[ _-]?doctor|request[ _-]?doctor|admission[ _-]?id|bed[ _-]?number|medical[ _-]?record([ _-]?(number|no|id))?|mrn|ssn|national[ _-]?id)$/i;
/** Keys that may be an author's public contact or a participant's: a person decides. */
const REVIEW_KEY = /^(address|contact|phone|telephone|e[ _-]?mail|national)$/i;

/** True when a JSON value holds anything at all, at any depth. */
function hasContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasContent);
  if (typeof value === "object") return Object.values(value as object).some(hasContent);
  return false;
}

/**
 * Walk a parsed JSON document; flag identifier-named keys that hold content, whether a
 * string, a number, an array or an object. Only the matched key is reported as the field:
 * an ancestor key can itself be a name, so it never enters a finding.
 */
export function scanJsonKeys(doc: unknown): Finding[] {
  const out: Finding[] = [];
  if (Array.isArray(doc)) {
    for (const item of doc) out.push(...scanJsonKeys(item));
    return out;
  }
  if (doc === null || typeof doc !== "object") return out;
  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    const severity: Severity | null = IDENTIFIER_KEY.test(key)
      ? "identifier"
      : REVIEW_KEY.test(key)
        ? "review"
        : null;
    if (severity && hasContent(value)) {
      const sample = Array.isArray(value) ? "[]" : typeof value === "object" ? "{}" : String(value);
      out.push({ kind: "json-identifier-key", severity, field: key, shape: shapeOf(sample) });
      continue;
    }
    if (value !== null && typeof value === "object") out.push(...scanJsonKeys(value));
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
 * debris carries local user names and machine paths; an all-letter `sub-` label that is
 * not a descriptive word may be a name.
 */
export function scanPaths(paths: string[]): Finding[] {
  const out: Finding[] = [];
  const seenLabels = new Set<string>();
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
    for (const m of path.matchAll(/(?:^|\/)sub-([A-Za-z0-9]+)/g)) {
      const label = m[1] as string;
      if (labelIsNameLike(label) && !seenLabels.has(label)) {
        seenLabels.add(label);
        out.push({
          kind: "path-subject-label",
          severity: "review",
          field: "path",
          shape: shapeOf(label),
        });
      }
    }
  }
  return out;
}

/** A Windows `C:\Users\<name>` or a POSIX home path that is not part of a URL. */
const LOCAL_USER_PATH =
  /(?:[A-Za-z]:\\{1,2}Users\\{1,2}|(?<![A-Za-z0-9._~:/-])\/(?:Users|home)\/)([A-Za-z0-9_.-]+)/;
/** Account names that name nobody: placeholders and CI accounts. */
const GENERIC_ACCOUNTS = new Set([
  "user",
  "username",
  "name",
  "you",
  "me",
  "yourname",
  "your_name",
  "runner",
  "ubuntu",
  "vagrant",
  "node",
  "foo",
  "example",
  "dev",
  "docker",
  "root",
  "shared",
  "public",
  "default",
]);

/** Screen text for a local user path such as `C:\Users\<name>` or `/Users/<name>`. */
export function scanTextForLocalPaths(text: string): Finding[] {
  const m = LOCAL_USER_PATH.exec(text);
  if (!m || GENERIC_ACCOUNTS.has((m[1] as string).toLowerCase())) return [];
  return [{ kind: "local-user-path", severity: "review", field: "text", shape: shapeOf(m[0]) }];
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
