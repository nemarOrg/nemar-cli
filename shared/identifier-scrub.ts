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
 */

import {
  EDF_HEADER_BYTES,
  type Finding,
  detectEdfFamily,
  edfIdentificationText,
  scanEdfHeader,
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
