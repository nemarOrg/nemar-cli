/**
 * What the INI-like text-header readers (BrainVision, NIRx) share: reading a header file whole,
 * up to a byte limit, decoding it, parsing it into sections, and pairing it with its companions
 * by name.
 *
 * Pure of I/O beyond the {@link RangeSource} a reader is given. Values parsed here never leave a
 * reader except as a {@link Finding}'s shape.
 */

import type { CompanionCheck, RangeSource } from "../identifier-readers";

/** A text header is read whole up to this many bytes; past it the read is `partial` (`limit`). */
export const TEXT_HEADER_MAX_BYTES = 1024 * 1024;

/** The limits of a text-header reader: one file of at most {@link TEXT_HEADER_MAX_BYTES}. */
export const TEXT_HEADER_LIMITS = {
  maxBytes: TEXT_HEADER_MAX_BYTES,
  maxReads: 4,
  maxInflatedBytes: 0,
  timeMs: 60_000,
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

/**
 * Decode a header's text. A `Codepage` line (BrainVision) that says `UTF-8` decodes as UTF-8;
 * otherwise (`ANSI`, or no declaration, as NIRx writes) the bytes decode as UTF-8 when they are
 * valid UTF-8 and as Windows-1252 when they are not. A byte-order mark is dropped.
 */
export function decodeHeader(bytes: Uint8Array): string {
  const head = new TextDecoder("windows-1252").decode(bytes.subarray(0, 4096));
  const declared = /^\s*codepage\s*=\s*([^\s;]+)/im.exec(head)?.[1]?.toLowerCase();
  let text: string;
  if (declared === "utf-8" || declared === "utf8") {
    text = new TextDecoder("utf-8").decode(bytes);
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      text = new TextDecoder("windows-1252").decode(bytes);
    }
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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
