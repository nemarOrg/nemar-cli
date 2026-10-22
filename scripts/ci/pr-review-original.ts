/**
 * Part B of the change summary: the facts about what a dataset pull request changed of the content
 * its original authors published (ADR 0109; design `.context/plans/pr-review-change-summary.md`,
 * Part B, sections B1 to B7).
 *
 * The owner's rule is that a contributor may add to what the original authors wrote but may not
 * alter or remove it; the account of a change belongs in CHANGES. The model used to read a README
 * diff and be told about "deletions" that were only line endings or a final newline. This module
 * computes the facts the rule is decided on, mechanically and in closed words, so the platform can
 * act on them and the model is told what they are instead of guessing from a diff.
 *
 * **This module is pure.** No git, no file system and no clock: it reads the bytes its caller has
 * already fetched and returns counts, booleans and closed words, so every rule here is tested on
 * bytes alone and none of it can reach a repository. Which blobs are read, at which commit, and what
 * a fact does to the review are the caller's.
 *
 * Two rules run through it, as through the summary it extends:
 *
 * 1. **What cannot be decided is said, never guessed.** A document the module will not read is one
 *    of the closed words in {@link PROSE_REFUSALS}, which the caller turns into "unknown" (a person
 *    looks), never into "clean". The words are printed in a public log, so none is built from a path
 *    or a contributor's text.
 * 2. **Where a reading is doubtful, the reading that flags is the one taken.** Protection falls back
 *    to the stricter side, duplicate lines are matched without rebalancing, and a choice the rules
 *    leave open goes the way that reports more, never the way that could call an alteration clean.
 */

// ---------------------------------------------------------------------------------------------
// Limits and closed words
// ---------------------------------------------------------------------------------------------

/**
 * The bounds of Part B. Each is a refusal, never a silent truncation: a document over a bound is
 * not compared, and the caller reports the comparison as unknown. Set A at its largest is a README
 * of 54 KB, 128 lines and a longest line of 2,207 bytes, so every bound is far above real input and
 * exists for hostile input only. The last two are read by later sections of this module.
 */
export const ORIGINAL_LIMITS = {
  maxDocumentBytes: 4 * 1024 * 1024, // one side of a document, every part together
  maxDocumentParts: 16, // root files in one document, per side
  maxDocumentLines: 20_000, // one side, counted after normalization (blank lines are not lines)
  // Lines removed plus lines inserted past which two sides are not aligned at all.
  maxEditDistance: 2_000,
  // The minor-edit bound of one line is a tenth of the longer line, in code points, kept between
  // these two (design B2.1).
  minorFloor: 3,
  minorCeiling: 20,
  maxExamples: 3, // removed original lines kept for the fenced block
  pointerMaxBytes: 1_023, // an unlocked annex pointer is a regular blob shorter than 1 KiB
  maxTagsTried: 32, // version tags tried for an ancestor of the merge base
} as const;

/**
 * Why a document was not compared. A closed list: the first three are the bounds of
 * {@link ORIGINAL_LIMITS}, the next three are about a part's bytes or mode, and the last is the
 * alignment's cap.
 *
 * - `too_large`: one side's parts hold more than `maxDocumentBytes` together.
 * - `too_many_parts`: one side has more than `maxDocumentParts` parts.
 * - `too_many_lines`: one side has more than `maxDocumentLines` lines once normalized.
 * - `binary`: a part holds a NUL byte and is not the same blob on both sides.
 * - `not_regular`: a part is not a regular file (a symbolic link, a submodule).
 * - `unreadable`: the caller could not read a part's bytes.
 * - `edit_distance_cap`: the two sides differ by more than `maxEditDistance` lines.
 */
export const PROSE_REFUSALS = [
  "too_large",
  "too_many_parts",
  "too_many_lines",
  "binary",
  "not_regular",
  "unreadable",
  "edit_distance_cap",
] as const;
export type ProseRefusal = (typeof PROSE_REFUSALS)[number];

/** A result that is either read or refused in one of the closed words above. */
export type ProseRead<T> = { ok: true; value: T } | { ok: false; refusal: ProseRefusal };

// ---------------------------------------------------------------------------------------------
// Documents: names, bytes to text, normalization (design B2.1, items 1 and 2)
// ---------------------------------------------------------------------------------------------

/** The two prose documents Part B compares. */
export type DocumentKind = "readme" | "changes";

/**
 * The root file names that make up each document, compared without regard to case. The README is
 * every root `README` with at most one alphanumeric extension; CHANGES is `CHANGES` or `CHANGELOG`,
 * bare or with `.md`, `.txt` or `.rst`. One document across names is what makes `README` renamed
 * to `README.md`, or `README.md` to `README.rst`, with the same text a preserved document rather
 * than one file removed and another added.
 */
export const DOCUMENT_NAME: Readonly<Record<DocumentKind, RegExp>> = {
  readme: /^readme(\.[A-Za-z0-9]+)?$/i,
  changes: /^(changes|changelog)(\.(md|txt|rst))?$/i,
};

/** Whether `path` is a part of the document: a root file (no `/` at all) whose name matches. */
export function isDocumentName(document: DocumentKind, path: string): boolean {
  return !path.includes("/") && DOCUMENT_NAME[document].test(path);
}

/** One root file of a document, as the caller read it at one commit. */
export interface DocumentPart {
  /** The root path, which {@link isDocumentName} accepts for the document. */
  name: string;
  /** The git mode as `ls-tree` writes it: `100644` and `100755` are regular files. */
  mode: string;
  /** The blob id. Two parts with one id hold the same bytes. */
  oid: string;
  /** The blob's bytes, or `unreadable` when the caller could not read them. */
  content: Uint8Array | "unreadable";
}

/** The kind of line breaks a text holds: one kind throughout, several (`mixed`), or none at all. */
export type LineBreaks = "none" | "lf" | "crlf" | "cr" | "mixed";

/**
 * A text as one part's bytes say it. A leading UTF-8 byte order mark is dropped first. The rest is
 * strict UTF-8 when it decodes as such (a malformed sequence is never replaced by U+FFFD, which
 * would make two different texts one); otherwise it is ISO-8859-1, every byte the code point of its
 * value, and `notUtf8` says so. ISO-8859-1 is decoded here by hand because the WHATWG decoder
 * labeled `latin1` is windows-1252, which maps the bytes 0x80 to 0x9F to other characters.
 */
export function decodeProse(bytes: Uint8Array): { text: string; notUtf8: boolean } {
  const body =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    // `ignoreBOM: true` keeps a second U+FEFF as text: the one byte order mark was removed above.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    return { text, notUtf8: false };
  } catch {
    let text = "";
    for (let i = 0; i < body.length; i += 0x2000) {
      text += String.fromCharCode(...body.subarray(i, i + 0x2000));
    }
    return { text, notUtf8: true };
  }
}

/** A text's lines once normalized, with what normalization removed that the facts still report. */
export interface NormalizedText {
  /**
   * The lines that are not blank, without their trailing spaces and tabs. `paragraphStart` is set
   * on the first line of the text and on every line that followed a blank one.
   */
  lines: { text: string; paragraphStart: boolean }[];
  breaks: LineBreaks;
  /** The text is not empty and its last character is a line break. */
  endsWithBreak: boolean;
}

/** Whether a UTF-16 code unit is a space or a tab, the only characters stripped from a line's end. */
function isTrailingBlank(unit: number): boolean {
  return unit === 0x20 || unit === 0x09;
}

/**
 * Normalize one part's text for comparison (design B2.1, item 2). A line ends at a CRLF, an LF or a
 * lone CR (a lone CR is a line break, as CommonMark reads it). Trailing spaces and tabs are removed
 * from every line; a line left empty is blank, sets `paragraphStart` on the next line kept, and is
 * dropped. The paragraph flags are therefore decided BEFORE the blank lines are gone, which is the
 * only way they can be decided. Nothing else changes: case, inner whitespace, leading indentation
 * and a no-break space are all significant.
 *
 * This removes exactly the two artifacts measured on set A (a final newline added and CRLF turned
 * into LF) and the trailing whitespace a mass cleanup touches; `breaks` and `endsWithBreak` keep
 * what was removed so the caller can say it.
 *
 * Trailing blanks are stripped by a loop from the end, not by a regular expression: `/[ \t]+$/`
 * backtracks over every run of spaces that is not at the end, which is quadratic in a hostile line.
 */
export function normalizeProse(text: string): NormalizedText {
  const lines: { text: string; paragraphStart: boolean }[] = [];
  let paragraphStart = true;
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  const keep = (from: number, to: number): void => {
    let end = to;
    while (end > from && isTrailingBlank(text.charCodeAt(end - 1))) end--;
    if (end === from) {
      paragraphStart = true;
      return;
    }
    lines.push({ text: text.slice(from, end), paragraphStart });
    paragraphStart = false;
  };
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit !== 0x0a && unit !== 0x0d) continue;
    keep(start, i);
    if (unit === 0x0a) lf++;
    else if (text.charCodeAt(i + 1) === 0x0a) {
      crlf++;
      i++;
    } else cr++;
    start = i + 1;
  }
  keep(start, text.length);
  const kinds = (lf > 0 ? 1 : 0) + (crlf > 0 ? 1 : 0) + (cr > 0 ? 1 : 0);
  const breaks: LineBreaks =
    kinds === 0 ? "none" : kinds > 1 ? "mixed" : lf > 0 ? "lf" : crlf > 0 ? "crlf" : "cr";
  const last = text.charCodeAt(text.length - 1);
  return { lines, breaks, endsWithBreak: last === 0x0a || last === 0x0d };
}

/** One normalized line of a document, with the part it came from. */
export interface ProseLine {
  text: string;
  /** The line follows a blank line, or is the first line of its part. */
  paragraphStart: boolean;
  /** The name of the part the line is in. */
  part: string;
}

/** One side of a document, read and normalized. */
export interface ProseDocument {
  /** Every part's lines, the parts in code-unit order of their names. */
  lines: readonly ProseLine[];
  /** The line breaks of every part read, together. */
  breaks: LineBreaks;
  /** A part read was not UTF-8 and was decoded as ISO-8859-1. */
  notUtf8: boolean;
  /** For each part read that is not empty, whether its text ends with a line break. */
  finalBreak: ReadonlyMap<string, boolean>;
}

/** One git mode a regular file can have. */
const REGULAR_MODE = /^100(644|755)$/;

/** The line breaks of two texts read as one. */
function joinBreaks(a: LineBreaks, b: LineBreaks): LineBreaks {
  if (a === "none" || a === b) return b;
  if (b === "none") return a;
  return "mixed";
}

/**
 * One side of a document from its parts (design B2.1, item 1): the parts in code-unit order of
 * their names (the order `ls-tree` lists them, and not a locale's), each decoded with
 * {@link decodeProse} and normalized with {@link normalizeProse}, their lines concatenated. The
 * first line of every part starts a paragraph, so the end of one file and the start of the next are
 * never one paragraph.
 *
 * The checks run in this order, each over every part before the next, so the word a side gets
 * depends on what its parts are and never on the order they are listed: more than
 * `maxDocumentParts` parts is `too_many_parts`; a part that is not a regular file `not_regular`; a
 * part the caller could not read `unreadable`; more than `maxDocumentBytes` over every part
 * `too_large`; a NUL byte `binary`; more than `maxDocumentLines` lines `too_many_lines`.
 *
 * A part that holds a NUL byte is skipped instead of refused when its blob id is in `skip`, the ids
 * the caller found on BOTH sides of the comparison. A binary part that did not change says nothing
 * about the text, and refusing it would make every edit of a README unknown for as long as a
 * `README.pdf` sat beside it; one that did change is `binary`, and the comparison is unknown.
 *
 * A part whose name is not one of the document's, or a name given twice, is a defect in the caller
 * and throws: it is not a property of the pull request, so it has no refusal word.
 */
export function assembleDocument(
  document: DocumentKind,
  parts: readonly DocumentPart[],
  skip: ReadonlySet<string>,
): ProseRead<ProseDocument> {
  const names = new Set<string>();
  for (const part of parts) {
    if (!isDocumentName(document, part.name) || names.has(part.name)) {
      throw new Error(`assembleDocument: not one ${document} part per name`);
    }
    names.add(part.name);
  }
  if (parts.length > ORIGINAL_LIMITS.maxDocumentParts) {
    return { ok: false, refusal: "too_many_parts" };
  }
  const sorted = [...parts].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (sorted.some((part) => !REGULAR_MODE.test(part.mode))) {
    return { ok: false, refusal: "not_regular" };
  }
  const read: { name: string; oid: string; content: Uint8Array }[] = [];
  let bytes = 0;
  for (const part of sorted) {
    if (part.content === "unreadable") return { ok: false, refusal: "unreadable" };
    read.push({ name: part.name, oid: part.oid, content: part.content });
    bytes += part.content.length;
  }
  if (bytes > ORIGINAL_LIMITS.maxDocumentBytes) return { ok: false, refusal: "too_large" };
  const kept = read.filter(({ oid, content }) => !(content.includes(0) && skip.has(oid)));
  if (kept.some(({ content }) => content.includes(0))) return { ok: false, refusal: "binary" };
  const lines: ProseLine[] = [];
  const finalBreak = new Map<string, boolean>();
  let breaks: LineBreaks = "none";
  let notUtf8 = false;
  for (const { name, content } of kept) {
    const decoded = decodeProse(content);
    const normalized = normalizeProse(decoded.text);
    notUtf8 ||= decoded.notUtf8;
    breaks = joinBreaks(breaks, normalized.breaks);
    if (decoded.text.length > 0) finalBreak.set(name, normalized.endsWithBreak);
    for (const line of normalized.lines) lines.push({ ...line, part: name });
    if (lines.length > ORIGINAL_LIMITS.maxDocumentLines) {
      return { ok: false, refusal: "too_many_lines" };
    }
  }
  return { ok: true, value: { lines, breaks, notUtf8, finalBreak } };
}
