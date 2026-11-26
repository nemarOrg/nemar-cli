/**
 * What the INI-like text-header readers (BrainVision, NIRx) share: reading a header file whole,
 * up to a byte limit, decoding it, parsing it into sections, and pairing it with its companions
 * by name.
 *
 * Pure of I/O beyond the {@link RangeSource} a reader is given. Values parsed here never leave a
 * reader except as a {@link Finding}'s shape.
 */

import type { CompanionCheck, RangeSource } from "../identifier-readers";
import { type Finding, type FindingKind, scanTextForLocalPaths, shapeOf } from "../identifier-scan";

/** A text header is read whole up to this many bytes; past it the read is `partial` (`limit`). */
export const TEXT_HEADER_MAX_BYTES = 1024 * 1024;

/** A BrainVision marker file is read whole up to this many bytes (lead ruling, phase A2). */
export const MARKER_FILE_MAX_BYTES = 16 * 1024 * 1024;

/** The limits of a text-header reader: one file of at most {@link TEXT_HEADER_MAX_BYTES}. */
export const TEXT_HEADER_LIMITS = {
  maxBytes: TEXT_HEADER_MAX_BYTES,
  maxReads: 4,
  maxInflatedBytes: 0,
  timeMs: 60_000,
} as const;

/** The limits of a BrainVision marker file: as a header's, up to {@link MARKER_FILE_MAX_BYTES}. */
export const MARKER_FILE_LIMITS = {
  ...TEXT_HEADER_LIMITS,
  maxBytes: MARKER_FILE_MAX_BYTES,
} as const;

/** A header file's bytes, and whether they are all of it. */
export interface HeaderBytes {
  bytes: Uint8Array;
  /** False when the file is longer than {@link TEXT_HEADER_MAX_BYTES}: only the start was read. */
  whole: boolean;
}

/**
 * Read a header file whole, up to `maxBytes`. A file of exactly `maxBytes` whose size the source
 * knows is whole; one that fills the budget and may go on is not.
 */
export async function readHeader(src: RangeSource, maxBytes: number): Promise<HeaderBytes> {
  const bytes = await src.read(0, maxBytes);
  const whole = bytes.length < maxBytes || src.size === bytes.length;
  return { bytes, whole };
}

/** UTF-16 without a byte-order mark: at least 90% of one byte of each pair is NUL, in the first 512. */
function utf16WithoutBom(bytes: Uint8Array): "utf-16le" | "utf-16be" | null {
  const n = Math.min(bytes.length, 512) & ~1;
  if (n < 8) return null;
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) evenNul++;
    if (bytes[i + 1] === 0) oddNul++;
  }
  const pairs = n / 2;
  if (oddNul >= 0.9 * pairs && evenNul < 0.1 * pairs) return "utf-16le";
  if (evenNul >= 0.9 * pairs && oddNul < 0.1 * pairs) return "utf-16be";
  return null;
}

/** The encoding a header's bytes say they are in, by byte-order mark or NUL pattern, if UTF-16. */
function utf16Of(bytes: Uint8Array): "utf-16le" | "utf-16be" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return utf16WithoutBom(bytes);
}

/**
 * Decode a header's text. UTF-16 (a byte-order mark, `FF FE` or `FE FF`, or a NUL in every other
 * byte) decodes as UTF-16. Anything else decodes as UTF-8 when the bytes are valid UTF-8, and as
 * Windows-1252 when they are not, whatever a `Codepage` line declares: a header that says UTF-8
 * and is not would otherwise come back as replacement characters. A byte-order mark and every NUL
 * are dropped, so a stray NUL cannot hide a section header.
 */
export function decodeHeader(bytes: Uint8Array): string {
  const utf16 = utf16Of(bytes);
  let text: string;
  if (utf16 === "utf-16le") {
    text = new TextDecoder("utf-16").decode(bytes);
  } else if (utf16 === "utf-16be") {
    // Big-endian, decoded as little-endian with each pair swapped.
    const swapped = new Uint8Array(bytes.length & ~1);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      swapped[i] = bytes[i + 1] as number;
      swapped[i + 1] = bytes[i] as number;
    }
    text = new TextDecoder("utf-16").decode(swapped);
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      text = new TextDecoder("windows-1252").decode(bytes);
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.includes("\u0000") ? text.replaceAll("\u0000", "") : text;
}

/**
 * Whether a file starts like binary data rather than text (an Analyze image header, an
 * AppleDouble file): in its first 512 bytes, more than 5% NUL bytes or more than 10% control
 * bytes other than tab, line feed, form feed and carriage return. UTF-16 text is never binary.
 */
export function startsBinary(bytes: Uint8Array): boolean {
  if (utf16Of(bytes)) return false;
  const n = Math.min(bytes.length, 512);
  if (n === 0) return false;
  let nul = 0;
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i] as number;
    if (b === 0) nul++;
    else if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d) control++;
  }
  return nul > 0.05 * n || control > 0.1 * n;
}

/** One `key=value` line of a section, with the value unquoted and trimmed. */
export interface IniEntry {
  key: string;
  value: string;
}

/** A section: its `key=value` entries in order, and every raw line (for free-text sections). */
export interface IniSection {
  entries: IniEntry[];
  lines: string[];
}

/**
 * Parse INI-like text into sections, keyed by the lowercased section name. Lines before the first
 * section belong to the section `""`. A line starting with `;` is a comment and is no entry, but
 * stays in `lines`, so a free-text section such as BrainVision's `[Comment]` is read whole.
 */
export function parseIni(text: string): Map<string, IniSection> {
  const sections = new Map<string, IniSection>();
  let current: IniSection = { entries: [], lines: [] };
  sections.set("", current);
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const header = /^\s*\[([^\]]*)\]\s*$/.exec(raw);
    if (header) {
      const name = (header[1] as string).trim().toLowerCase();
      current = sections.get(name) ?? { entries: [], lines: [] };
      sections.set(name, current);
      continue;
    }
    current.lines.push(raw);
    if (/^\s*;/.test(raw)) continue;
    const eq = raw.indexOf("=");
    if (eq <= 0) continue;
    const key = raw.slice(0, eq).trim();
    let value = raw.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).trim();
    }
    current.entries.push({ key, value });
  }
  return sections;
}

/** The value of the first entry with this key (case-insensitive) in a section, or undefined. */
export function entryValue(section: IniSection | undefined, key: string): string | undefined {
  const lower = key.toLowerCase();
  return section?.entries.find((e) => e.key.toLowerCase() === lower)?.value;
}

/** A path's directory (with its trailing `/`, or `""`) and its file name. */
export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  return { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

/** The path with its extension (matched case-insensitively) removed: `a/b.VHDR` -> `a/b`. */
export function stem(path: string, extension: string): string {
  return path.toLowerCase().endsWith(extension) ? path.slice(0, -extension.length) : path;
}

/** The sibling at `base + extension`, in the lowercase or uppercase spelling the tree has, or null. */
function sibling(base: string, extension: string, siblings: ReadonlySet<string>): string | null {
  for (const candidate of [base + extension, base + extension.toUpperCase()]) {
    if (siblings.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Pair a header with its companions by name: the files beside it that share its base name. Each
 * `required` extension that is absent is missing (named in its lowercase spelling); each present
 * one, and each present `optional` one, is claimed.
 */
export function pairByName(
  base: string,
  required: readonly string[],
  optional: readonly string[],
  siblings: ReadonlySet<string>,
): CompanionCheck {
  const claimed: string[] = [];
  const missing: string[] = [];
  for (const extension of required) {
    const found = sibling(base, extension, siblings);
    if (found) claimed.push(found);
    else missing.push(base + extension);
  }
  for (const extension of optional) {
    const found = sibling(base, extension, siblings);
    if (found) claimed.push(found);
  }
  return { claimed, missing };
}

/** How a file name a header gives for a companion relates to the companion's expected name. */
export type ReferenceCheck = "match" | "absolute" | "elsewhere" | "mismatch";

/**
 * Check a file name a header gives for a companion against the name the companion must have
 * beside the header. `absolute`: a drive letter, a UNC path or a leading slash. `elsewhere`: any
 * other directory part or `..`. `mismatch`: a bare file name that is not the expected one
 * (compared case-insensitively, after BrainVision's `$b` stands for the header's base name).
 */
export function checkReference(
  value: string,
  headerBase: string,
  expected: string,
): ReferenceCheck {
  const v = value.trim();
  if (/^[A-Za-z]:[\\/]/.test(v) || v.startsWith("/") || v.startsWith("\\")) return "absolute";
  if (/[\\/]/.test(v) || v === ".." || v === ".") return "elsewhere";
  const resolved = v.replace(/\$b/gi, headerBase);
  return resolved.toLowerCase() === expected.toLowerCase() ? "match" : "mismatch";
}

/**
 * Field names that hold a person: the list phase A4 uses for its free-text name rule (`name`,
 * `subject`, `patient`, `operator`, `experimenter`), defined here too because A4 has not merged;
 * the two must stay equal. Fields that describe the person rather than name them, and fields that
 * name a thing (the experiment, a file, a device, a montage), are excluded.
 */
export const PERSON_FIELD = /name|subject|patient|operator|experimenter/i;
const NOT_A_NAME_FIELD =
  /age|gender|sex|birth|dob|contact|info|type|history|notes|remarks|date|experiment_name|file_?name|device|study|probe|montage|paradigm|task/i;

/** True for a field that names a person (and not one that describes them). */
export const isPersonField = (key: string): boolean =>
  PERSON_FIELD.test(key) && !NOT_A_NAME_FIELD.test(key);

/**
 * The most characters of one value the free-text and name rules read. A longer value is cut to
 * this and the read is `partial` (`limit`): the rules' regular expressions then run on bounded
 * input whatever a file holds.
 */
export const FREE_TEXT_MAX_CHARS = 4096;

/** A value cut to {@link FREE_TEXT_MAX_CHARS}, and whether it was cut. */
export function capText(value: string): { text: string; cut: boolean } {
  return value.length > FREE_TEXT_MAX_CHARS
    ? { text: value.slice(0, FREE_TEXT_MAX_CHARS), cut: true }
    : { text: value, cut: false };
}

/** An email address, matched only inside a window around one `@`. */
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/u;
const EMAIL_BEFORE = 64;
const EMAIL_AFTER = 255;

/** Whether some text holds an email address, testing a bounded window around each `@`. */
function hasEmail(text: string): boolean {
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    const window = text.slice(Math.max(0, at - EMAIL_BEFORE), at + 1 + EMAIL_AFTER);
    if (EMAIL.test(window)) return true;
  }
  return false;
}

/** What says a phone number follows: a `+`, or a word that says so. */
const PHONE_CUE = /\+|\b(?:tel|telephone|phone|fon|mobile|cell)\b/gi;

/**
 * Whether some text holds a phone number: seven to fifteen digits in groups, right after a `+` or
 * after a word that says so (`tel`, `phone`, `mobile`). A bare run of grouped digits is not one,
 * because marker codes, dates and amplifier settings look the same. Each cue is followed by at
 * most 40 characters, read with one linear pass.
 */
function hasPhone(text: string): boolean {
  for (const cue of text.matchAll(PHONE_CUE)) {
    const after = text.slice(
      (cue.index ?? 0) + cue[0].length,
      (cue.index ?? 0) + cue[0].length + 40,
    );
    const number = /^[.:]?\s*([\d\s().-]*)/.exec(after)?.[1] ?? "";
    if (!/^\(?\d/.test(number)) continue;
    const digits = number.replace(/\D/g, "").length;
    if (digits >= 7 && digits <= 15) return true;
  }
  return false;
}

/** Whether some free text holds an email address or a phone number, and which (email first). */
export function contactIn(text: string): "email" | "phone" | null {
  if (hasEmail(text)) return "email";
  if (hasPhone(text)) return "phone";
  return null;
}

/**
 * The free-text rules on one value, after capping it: a home-directory path (`local-user-path`)
 * and contact details (`contactKind`, review). One finding per rule. `cut` says the value was longer
 * than {@link FREE_TEXT_MAX_CHARS}, so the reader must say `partial` (`limit`).
 */
export function freeTextFindings(
  value: string,
  contactKind: FindingKind,
  field: string,
): { findings: Finding[]; cut: boolean } {
  const { text, cut } = capText(value);
  const findings: Finding[] = [];
  const local = scanTextForLocalPaths(text);
  if (local.length > 0) findings.push({ ...(local[0] as Finding), field });
  if (contactIn(text) !== null) {
    findings.push({ kind: contactKind, severity: "review", field, shape: shapeOf(text) });
  }
  return { findings, cut };
}

/**
 * Text a reader could not place (no section it knows): every line through the free-text rules,
 * one finding per kind for the file. The caller reports the read `partial` (`unsupported-version`).
 */
export function unplacedTextFindings(text: string, contactKind: FindingKind): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.trim() === "") continue;
    for (const f of freeTextFindings(line, contactKind, "text").findings) {
      if (seen.has(f.kind)) continue;
      seen.add(f.kind);
      out.push(f);
    }
  }
  return out;
}
