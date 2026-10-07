/**
 * Header-only scrub of identifying fields in EDF, EDF+ and BDF files.
 *
 * The scrub rewrites at most two fields of the 256-byte header, the local patient
 * identification (bytes 8..88) and the local recording identification (bytes 88..168), and
 * touches nothing else: the magic, the start date and time (acquisition dates are acceptable
 * by policy), the record count and every byte after offset 256 stay identical. That is what
 * makes it provable: {@link verifyScrub} checks equal length, byte identity outside the two
 * fields, and that the scanner finds nothing direct in the result.
 *
 * Minimal by design. A field the scanner finds nothing wrong with is left exactly as it is, so
 * a study code such as `12 X X X` survives; a field that carries a name, a birth date, a record
 * number or non-ASCII bytes is replaced with a placeholder. The recording field keeps its
 * `Startdate dd-MMM-yyyy` token when it has one, because that date is acceptable and the EDF+
 * header must keep agreeing with it.
 *
 * Pure functions over bytes, no I/O, no dependencies beyond the scanner it is proven against.
 *
 * {@link blankIdentifierJsonKeys} is the JSON half, for a caller that edits one document at a time
 * (the importer, ADR 0089): the rule ADR 0085's history rewrite applies to every commit
 * (`scripts/scrub/git/rewrite_history.py`, `blank_json`), applied to one document.
 */

import {
  EDF_HEADER_BYTES,
  type Finding,
  detectEdfFamily,
  edfIdentificationText,
  hasContent,
  scanEdfHeader,
  scanJsonKeys,
} from "./identifier-scan";

/** Byte ranges of the two fields this module may rewrite. Everything else is preserved. */
export const PATIENT_FIELD = { start: 8, end: 88 } as const;
export const RECORDING_FIELD = { start: 88, end: 168 } as const;

/** The EDF+ spelling of "not entered": code, sex, birth date and name all unknown. */
export const PATIENT_PLACEHOLDER = "X X X X";

/** Thrown when a file cannot be scrubbed safely, with a fixed reason and never a value. */
export class ScrubRefused extends Error {
  constructor(readonly reason: "not-edf" | "header-too-short") {
    super(`scrub refused: ${reason}`);
    this.name = "ScrubRefused";
  }
}

export interface ScrubResult {
  /** The new 256-byte header. Equal to the input header when nothing needed to change. */
  header: Uint8Array;
  changed: boolean;
  /** Which fields were rewritten. Names only. */
  fields: ("patient" | "recording")[];
}

/** Finding kinds, in the patient field, that make it unfit to keep. */
const PATIENT_DIRTY = new Set([
  "edf-patient-name",
  "edf-patient-code",
  "edf-patient-recordnumber",
  "edf-patient-freetext",
  "edf-patient-birthdate",
  "edf-patient-nonascii",
  "edf-patient-age",
]);

/**
 * Finding kinds, in the recording field, that make it unfit to keep. An acquisition date is
 * acceptable and absent here; a birth date found in the recording field is not.
 */
const RECORDING_DIRTY = new Set([
  "edf-recording-freetext",
  "edf-recording-technician",
  "edf-recording-nonascii",
  "edf-patient-birthdate",
]);

/** Whether a finding is one this module removes: a patient finding in the patient field, a recording finding in the recording field. */
function isRemovable(f: Finding): boolean {
  return (
    (f.field.startsWith("patient") && PATIENT_DIRTY.has(f.kind)) ||
    (f.field.startsWith("recording") && RECORDING_DIRTY.has(f.kind))
  );
}

function writeField(out: Uint8Array, field: { start: number; end: number }, text: string): void {
  const width = field.end - field.start;
  out.fill(0x20, field.start, field.end);
  for (let i = 0; i < Math.min(text.length, width); i++) {
    out[field.start + i] = text.charCodeAt(i);
  }
}

/** `Startdate dd-MMM-yyyy` if the current recording field carries a valid one, else `Startdate X`. */
function recordingPlaceholder(current: string): string {
  const m = /^startdate\s+(\d{2}-[A-Za-z]{3}-\d{4})(?=\s|$)/i.exec(current);
  return `Startdate ${m ? (m[1] as string).toUpperCase() : "X"} X X X`;
}

export function scrubEdfHeader(bytes: Uint8Array): ScrubResult {
  if (bytes.length < EDF_HEADER_BYTES) throw new ScrubRefused("header-too-short");
  if (!detectEdfFamily(bytes)) throw new ScrubRefused("not-edf");
  const header = bytes.slice(0, EDF_HEADER_BYTES);
  const findings = scanEdfHeader(header);
  const fields: ScrubResult["fields"] = [];
  if (findings.some((f) => f.field.startsWith("patient") && PATIENT_DIRTY.has(f.kind))) {
    writeField(header, PATIENT_FIELD, PATIENT_PLACEHOLDER);
    fields.push("patient");
  }
  if (findings.some((f) => f.field.startsWith("recording") && RECORDING_DIRTY.has(f.kind))) {
    const { recording } = edfIdentificationText(header);
    writeField(header, RECORDING_FIELD, recordingPlaceholder(recording));
    fields.push("recording");
  }
  return { header, changed: fields.length > 0, fields };
}

export interface ScrubVerdict {
  ok: boolean;
  /** Fixed reason words, never values. Empty when ok. */
  reasons: string[];
}

/**
 * The proof that a scrubbed header differs from the original only where it may, and is clean.
 * Pass the first 256 bytes of each. It checks equal length, byte identity of [0,8) and
 * [168,256), that the two rewritable fields hold only what the scanner accepts, and that the
 * result still reads as the same file family. It never returns a value.
 */
export function verifyScrub(before: Uint8Array, after: Uint8Array): ScrubVerdict {
  const reasons: string[] = [];
  if (before.length < EDF_HEADER_BYTES || after.length < EDF_HEADER_BYTES) {
    return { ok: false, reasons: ["header-too-short"] };
  }
  const same = (a: number, b: number) => {
    for (let i = a; i < b; i++) if (before[i] !== after[i]) return false;
    return true;
  };
  if (!same(0, PATIENT_FIELD.start)) reasons.push("bytes-before-patient-changed");
  if (!same(RECORDING_FIELD.end, EDF_HEADER_BYTES)) reasons.push("bytes-after-recording-changed");
  if (detectEdfFamily(before) !== detectEdfFamily(after)) reasons.push("file-family-changed");
  const direct = scanEdfHeader(after).filter(isRemovable);
  if (direct.length > 0) reasons.push("identifying-content-remains");
  return { ok: reasons.length === 0, reasons };
}

/**
 * Overwrite the first 256 bytes of a buffer with a scrubbed header, after proving the change.
 * Throws {@link ScrubRefused}-free `Error` with a fixed message when the proof fails, so a bad
 * patch can never be applied to data.
 */
export function applyHeaderPatch(data: Uint8Array, header: Uint8Array): Uint8Array {
  const verdict = verifyScrub(data.subarray(0, EDF_HEADER_BYTES), header);
  if (!verdict.ok) throw new Error(`header patch refused: ${verdict.reasons.join(",")}`);
  const out = data.slice();
  out.set(header.subarray(0, EDF_HEADER_BYTES), 0);
  return out;
}

// ---------------------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------------------

/** What {@link blankIdentifierJsonKeys} did. Counts and a fixed word; never a key or a value. */
export interface JsonBlankResult {
  /**
   * `blanked`: values were replaced and `bytes` holds the new document. `clean`: nothing to blank.
   * `unreadable`: not UTF-8 JSON, so nothing can be said about it and nothing was changed.
   */
  status: "blanked" | "clean" | "unreadable";
  /** The new document; set only when `status` is `blanked`. */
  bytes?: Uint8Array;
  /** Values replaced by `""`. */
  blanked: number;
}

/** Thrown when a blank cannot be proven, with a fixed reason and never a value. */
export class JsonBlankUnverified extends Error {
  constructor() {
    super("json blank unverified");
    this.name = "JsonBlankUnverified";
  }
}

/** The scanner's own answer to "does this key name an identifier", asked of one key at a time. */
function isIdentifierKey(name: string): boolean {
  return scanJsonKeys({ [name]: "x" }).some((f) => f.severity === "identifier");
}

interface KeyValueSpan {
  /** The key as written, decoded. */
  key: string;
  /** Where the value starts and ends in the text. */
  start: number;
  end: number;
}

/**
 * Every key/value pair of the document, in text order and at any depth, without descending into a
 * value the caller marks as consumed. Throws on text that is not JSON; the caller has already parsed
 * it, so a throw here is a walker fault and the caller treats it as unreadable.
 */
function walkPairs(text: string, consume: (pair: KeyValueSpan) => boolean): void {
  const ws = (i: number): number => {
    let j = i;
    while (j < text.length && " \t\n\r".includes(text[j] as string)) j++;
    return j;
  };
  const str = (i: number): number => {
    let j = i + 1;
    while (text[j] !== '"') {
      if (j >= text.length) throw new Error("string");
      j += text[j] === "\\" ? 2 : 1;
    }
    return j + 1;
  };
  const value = (i: number): number => {
    const c = text[i];
    if (c === "{") {
      let j = ws(i + 1);
      if (text[j] === "}") return j + 1;
      for (;;) {
        if (text[j] !== '"') throw new Error("key");
        const keyEnd = str(j);
        const key = JSON.parse(text.slice(j, keyEnd)) as string;
        j = ws(keyEnd);
        if (text[j] !== ":") throw new Error("colon");
        const start = ws(j + 1);
        // The value's extent is found without looking inside it first, so a consumed value is
        // never walked: whatever it holds goes with it.
        const end = skip(start);
        if (!consume({ key, start, end })) value(start);
        j = ws(end);
        if (text[j] === ",") {
          j = ws(j + 1);
          continue;
        }
        if (text[j] !== "}") throw new Error("object");
        return j + 1;
      }
    }
    if (c === "[") {
      let j = ws(i + 1);
      if (text[j] === "]") return j + 1;
      for (;;) {
        j = ws(value(j));
        if (text[j] === ",") {
          j = ws(j + 1);
          continue;
        }
        if (text[j] !== "]") throw new Error("array");
        return j + 1;
      }
    }
    return skip(i);
  };
  // The end of the value starting at `i`, by bracket depth alone (strings skipped whole).
  const skip = (i: number): number => {
    const c = text[i];
    if (c === '"') return str(i);
    if (c === "{" || c === "[") {
      let depth = 0;
      let j = i;
      while (j < text.length) {
        const ch = text[j];
        if (ch === '"') {
          j = str(j);
          continue;
        }
        if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") {
          depth--;
          if (depth === 0) return j + 1;
        }
        j++;
      }
      throw new Error("unterminated");
    }
    let j = i;
    while (j < text.length && !",]} \t\n\r".includes(text[j] as string)) j++;
    if (j === i) throw new Error("scalar");
    return j;
  };
  const end = ws(value(ws(0)));
  if (end !== text.length) throw new Error("trailing");
}

/** Spans of every value under an identifier key that holds content, outermost only. */
function identifierValueSpans(text: string): KeyValueSpan[] {
  const spans: KeyValueSpan[] = [];
  walkPairs(text, (pair) => {
    if (!isIdentifierKey(pair.key)) return false;
    if (!hasContent(JSON.parse(text.slice(pair.start, pair.end)))) return false;
    spans.push(pair);
    return true;
  });
  return spans;
}

/**
 * Replace by `""` every value, at any depth, held under a key the scanner calls an identifier
 * (`scanJsonKeys`, identifier severity), editing the TEXT: key order, indentation, spacing and every
 * byte outside the replaced values stay as they were, and a leading byte-order mark is kept.
 *
 * The rule is ADR 0085's history rewrite (`blank_json` in `rewrite_history.py`) for one document,
 * and gives the same bytes on the documents that rewrite was built for. It differs in three edge
 * cases, each so that nothing the scanner calls an identifier survives: the key is matched by the
 * scanner's own canonical spelling (the rewrite drops only spaces, underscores and hyphens, so a key
 * with a tab in it is flagged by the scanner and left by the rewrite); every occurrence of a
 * duplicated key is judged on its own content (the rewrite's targets come from a parse, which keeps
 * only the last duplicate); and a value that holds nothing (`null`, `[]`) is left as it is rather
 * than turned into `""`.
 *
 * The result is proven before it is returned: it parses, no identifier key in it holds content, and
 * the scanner finds no identifier-severity key in it. A blank that cannot be proven throws
 * {@link JsonBlankUnverified} rather than return bytes nobody checked.
 */
export function blankIdentifierJsonKeys(raw: Uint8Array): JsonBlankResult {
  const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  let text: string;
  let spans: KeyValueSpan[];
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bom ? raw.subarray(3) : raw,
    );
    JSON.parse(text);
    spans = identifierValueSpans(text);
  } catch {
    return { status: "unreadable", blanked: 0 };
  }
  if (spans.length === 0) return { status: "clean", blanked: 0 };
  let out = text;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, s.start)}""${out.slice(s.end)}`;
  }
  // The proof: what a reader of the new document would find.
  let remaining: number;
  try {
    const doc = JSON.parse(out);
    remaining =
      identifierValueSpans(out).length +
      scanJsonKeys(doc).filter((f) => f.severity === "identifier").length;
  } catch {
    throw new JsonBlankUnverified();
  }
  if (remaining !== 0) throw new JsonBlankUnverified();
  const body = new TextEncoder().encode(out);
  const bytes = bom ? new Uint8Array([0xef, 0xbb, 0xbf, ...body]) : body;
  return { status: "blanked", bytes, blanked: spans.length };
}
