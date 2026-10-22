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

import { firstReadme } from "../../shared/readme-candidates";
import { SUMMARY_LIMITS } from "./pr-review-summary";

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

// ---------------------------------------------------------------------------------------------
// Distances: the minor edit of one line (design B2.1, "Minor edit")
// ---------------------------------------------------------------------------------------------

/** A string's code points: an astral character is one, a combining mark is one of its own. */
function codePoints(s: string): Int32Array {
  const out = new Int32Array(s.length);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i) as number;
    out[n++] = cp;
    if (cp > 0xffff) i++;
  }
  return out.subarray(0, n);
}

/** How many code points a string holds, without copying it. */
function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if ((s.codePointAt(i) as number) > 0xffff) i++;
    n++;
  }
  return n;
}

/**
 * The most a line may change and still be a minor edit: a tenth of the longer of the two lines,
 * rounded down and counted in code points, but never less than `minorFloor` (3) or more than
 * `minorCeiling` (20). The `Funding` typo fix measured on set A (7 in about 100 characters) is
 * within it; a rewritten sentence is not.
 */
export function minorBound(a: string, b: string): number {
  const longer = Math.max(codePointLength(a), codePointLength(b));
  return Math.min(
    ORIGINAL_LIMITS.minorCeiling,
    Math.max(ORIGINAL_LIMITS.minorFloor, Math.floor(longer / 10)),
  );
}

/**
 * The Levenshtein distance between two strings in code points when it is at most `k`, and `k + 1`
 * when it is more. Only the band of `2k + 1` diagonals around the main one is computed, and the
 * computation stops at the first row whose every cell is past `k`, so the cost is linear in the
 * length of the strings for the small `k` a minor edit allows, and a megabyte line against a short
 * one costs nothing (their lengths alone differ by more than `k`). Counting code points and not
 * UTF-16 code units is what makes an astral character one edit, as a reader counts it; a
 * combining mark is a code point of its own, and so an edit of its own.
 */
export function levenshteinWithin(a: string, b: string, k: number): number {
  if (a === b) return 0;
  const cap = k + 1;
  let x = codePoints(a);
  let y = codePoints(b);
  if (x.length > y.length) [x, y] = [y, x];
  if (y.length - x.length > k) return cap;
  // A common prefix and suffix cost nothing and are cut first.
  let start = 0;
  while (start < x.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && x[endX - 1] === y[endY - 1]) {
    endX--;
    endY--;
  }
  x = x.subarray(start, endX);
  y = y.subarray(start, endY);
  const n = x.length;
  const m = y.length;
  if (n === 0) return Math.min(m, cap);
  // Row i holds the cells of columns i - k to i + k, column j at index j - i + k.
  const width = 2 * k + 1;
  let prev = new Int32Array(width).fill(cap);
  let cur = new Int32Array(width);
  for (let j = 0; j <= Math.min(m, k); j++) prev[j + k] = j;
  for (let i = 1; i <= n; i++) {
    cur.fill(cap);
    let best = cap;
    const last = Math.min(m, i + k);
    for (let j = Math.max(0, i - k); j <= last; j++) {
      const t = j - i + k;
      let value = i; // column 0: i deletions
      if (j > 0) {
        const replace = (prev[t] as number) + (x[i - 1] === y[j - 1] ? 0 : 1);
        const remove = t + 1 < width ? (prev[t + 1] as number) + 1 : cap;
        const insert = t > 0 ? (cur[t - 1] as number) + 1 : cap;
        value = Math.min(replace, remove, insert, cap);
      }
      cur[t] = value;
      if (value < best) best = value;
    }
    // Every path to the end crosses this row, and no step lowers a distance.
    if (best > k) return cap;
    [prev, cur] = [cur, prev];
  }
  return Math.min(prev[m - n + k] as number, cap);
}

/** Whether `b` is a minor edit of `a`: their distance is within {@link minorBound}. */
export function isMinorEdit(a: string, b: string): boolean {
  const bound = minorBound(a, b);
  return levenshteinWithin(a, b, bound) <= bound;
}

// ---------------------------------------------------------------------------------------------
// Alignment: Myers' diff of two line sequences (design B2.1, item 3)
// ---------------------------------------------------------------------------------------------

/** One step of an edit script: a line kept, a line of the first side removed, or one inserted. */
export type AlignOp = "equal" | "delete" | "insert";

/** A shortest edit script and its length, the number of lines removed plus inserted. */
export interface Alignment {
  ops: AlignOp[];
  distance: number;
}

/**
 * The work an alignment did, for a test to bound: one step per diagonal tried and one per line
 * matched along a diagonal, so about one comparison each. It is added to, never reset, so one
 * meter can be passed to several calls.
 */
export interface AlignMeter {
  steps: number;
}

/**
 * The middle of an alignment by Myers' greedy algorithm ("An O(ND) Difference Algorithm and Its
 * Variations", 1986), or null when the distance is more than `maxD`. Both sides are non-empty and
 * already interned. The work is O((N + M) D) and the memory one slice of the furthest-reaching
 * frontier per distance, each holding only the diagonals of its parity: about two million numbers
 * (8 MB) at `maxD` 2,000, which is what keeps the cap a bound on memory as well as time.
 *
 * The tie-break is pinned, because it decides which lines a hunk pairs: the path goes down (an
 * insertion) iff `k == -d || (k != d && V[k - 1] < V[k + 1])`, and the backtrack repeats the same
 * rule over the stored slices, so it retraces exactly the path that was found.
 */
function myersMiddle(
  x: Int32Array,
  y: Int32Array,
  maxD: number,
  meter: AlignMeter | undefined,
): AlignOp[] | null {
  const n = x.length;
  const m = y.length;
  let steps = 0;
  try {
    // The distance is at least the difference in length, so a larger one is over the cap at once.
    if (Math.abs(n - m) > maxD) return null;
    const offset = maxD + 1;
    const v = new Int32Array(2 * maxD + 3);
    const trace: Int32Array[] = [];
    for (let d = 0; d <= maxD; d++) {
      const slice = new Int32Array(d + 1);
      for (let k = -d; k <= d; k += 2) {
        steps++;
        const down =
          k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number));
        let px = down ? (v[offset + k + 1] as number) : (v[offset + k - 1] as number) + 1;
        let py = px - k;
        while (px < n && py < m && x[px] === y[py]) {
          px++;
          py++;
          steps++;
        }
        v[offset + k] = px;
        slice[(k + d) >> 1] = px;
        if (px >= n && py >= m) {
          trace.push(slice);
          return backtrack(trace, n, m);
        }
      }
      trace.push(slice);
    }
    return null;
  } finally {
    if (meter) meter.steps += steps;
  }
}

/** The script of the path {@link myersMiddle} found, from the slices it stored, in forward order. */
function backtrack(trace: readonly Int32Array[], n: number, m: number): AlignOp[] {
  const ops: AlignOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1] as Int32Array;
    const at = (k: number): number => prev[(k + d - 1) >> 1] as number;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const moved = down ? prevX : prevX + 1;
    for (; x > moved; x--, y--) ops.push("equal");
    ops.push(down ? "insert" : "delete");
    x = prevX;
    y = prevX - prevK;
  }
  for (; x > 0; x--) ops.push("equal");
  return ops.reverse();
}

/**
 * A shortest edit script turning the lines `a` into the lines `b`, or null when it would remove
 * and insert more than `maxD` lines together. Lines are compared exactly, as interned numbers. A
 * common prefix and suffix are matched first; when nothing is left on one side the middle is pure
 * insertion or pure removal and its script is immediate and never capped, so a README that only
 * gained a long new section is never refused, however long the section. Otherwise the middle goes
 * through Myers' algorithm with the cap; `meter`, when given, counts its work.
 */
export function alignLines(
  a: readonly string[],
  b: readonly string[],
  maxD: number = ORIGINAL_LIMITS.maxEditDistance,
  meter?: AlignMeter,
): Alignment | null {
  const ids = new Map<string, number>();
  const intern = (lines: readonly string[]): Int32Array =>
    Int32Array.from(lines, (line) => {
      let id = ids.get(line);
      if (id === undefined) {
        id = ids.size;
        ids.set(line, id);
      }
      return id;
    });
  const x = intern(a);
  const y = intern(b);
  let prefix = 0;
  while (prefix < x.length && prefix < y.length && x[prefix] === y[prefix]) prefix++;
  let suffix = 0;
  while (
    prefix + suffix < x.length &&
    prefix + suffix < y.length &&
    x[x.length - 1 - suffix] === y[y.length - 1 - suffix]
  ) {
    suffix++;
  }
  const n = x.length - prefix - suffix;
  const m = y.length - prefix - suffix;
  let middle: AlignOp[] | null;
  if (n === 0) middle = new Array<AlignOp>(m).fill("insert");
  else if (m === 0) middle = new Array<AlignOp>(n).fill("delete");
  else {
    middle = myersMiddle(
      x.subarray(prefix, prefix + n),
      y.subarray(prefix, prefix + m),
      maxD,
      meter,
    );
  }
  if (middle === null) return null;
  const ops: AlignOp[] = new Array<AlignOp>(prefix).fill("equal");
  for (const op of middle) ops.push(op);
  for (let i = 0; i < suffix; i++) ops.push("equal");
  let distance = 0;
  for (const op of middle) if (op !== "equal") distance++;
  return { ops, distance };
}

// ---------------------------------------------------------------------------------------------
// Prose facts: README and CHANGES (design B2.1, items 4 and 5)
// ---------------------------------------------------------------------------------------------

/**
 * Which lines of the merge-base document are the original authors' (design B2.1, item 4), as one
 * flag per base line.
 *
 * For CHANGES, every line: its history is kept whole, and a new entry goes beside the old ones.
 * For the README, the lines that are in the anchor document, the README at the first version tag
 * that is an ancestor of the merge base: for each distinct text, the first
 * `min(anchor count, base count)` of its occurrences in the base. Which copy of a repeated line is
 * the original is not rebalanced: the first copies are, so removing a later copy that is in fact
 * the original reads as an alteration (a rare false fail, never a false pass).
 *
 * With no anchor (null) every base line is protected. That is the strict side, and every failure to
 * find an anchor (no tag, no README at the tag, an anchor document that could not be read) falls
 * back to it.
 */
export function protectedMask(
  document: DocumentKind,
  base: readonly string[],
  anchor: readonly string[] | null,
): boolean[] {
  if (document === "changes" || anchor === null) return base.map(() => true);
  const left = new Map<string, number>();
  for (const line of anchor) left.set(line, (left.get(line) ?? 0) + 1);
  return base.map((line) => {
    const count = left.get(line) ?? 0;
    if (count === 0) return false;
    left.set(line, count - 1);
    return true;
  });
}

/**
 * What a pull request did to one document, in counts and booleans (design B2.1, item 5). A line
 * here is a normalized line (see {@link normalizeProse}); "protected" is {@link protectedMask}'s.
 * The comparison pairs lines inside a hunk, a maximal run of removed and inserted lines between two
 * kept ones: the j-th removed line with the j-th inserted line, whatever either is.
 */
export interface ProseFacts {
  document: DocumentKind;
  /** Where protection came from: the first version tag's README, or every merge-base line. */
  anchor: "first_version_tag" | "merge_base";
  /**
   * Every protected line is kept verbatim and in order, with insertions only between paragraphs:
   * nothing altered, moved or minor-edited, and no line inserted inside an original paragraph.
   */
  preserved: boolean;
  /** Merge-base lines that are protected. */
  protectedLines: number;
  /** Protected lines removed, or replaced beyond a minor edit, whose text is nowhere new. */
  protectedAltered: number;
  /** Protected lines replaced by a minor edit (README only; CHANGES allows none). */
  minorEdits: number;
  /** Lines removed or replaced that are not protected: text added after the anchor. */
  laterAltered: number;
  /** Some protected line left its place and its exact text was inserted elsewhere. */
  moved: boolean;
  /** How many protected lines did so. */
  movedLines: number;
  /**
   * Runs of new lines placed between two protected lines of one original paragraph, the earlier
   * kept (verbatim or by a minor edit) and the later one not the start of a paragraph.
   */
  insertedInsideParagraph: number;
  /** Lines of the head that are not kept from the base, the new text of minor edits included. */
  insertedLines: number;
  /** Both sides have line breaks, and they are not of the same kind (LF, CRLF, CR or mixed). */
  lineEndingsChanged: boolean;
  /** A part on both sides ended without a line break at the base and ends with one at the head. */
  finalNewlineAdded: boolean;
  /** The base or the head holds a part that is not UTF-8 and was read as ISO-8859-1. */
  notUtf8: boolean;
  /** Parts at the base and at the head, binary ones included. */
  partsBefore: number;
  partsAfter: number;
  /**
   * Inserted lines, minor-edit replacements included, that hold markup able to hide what follows
   * or surrounds it: see {@link hidesText}. Wrapping original paragraphs in such markup keeps every
   * protected line verbatim, so without this fact it would read as preserved.
   */
  hidingMarkupInserted: number;
  /**
   * A protected line the platform showed at the base is kept, but in a part it no longer shows: a
   * new `README.md` beside the original `README` hides the original from every reader of the
   * shown README while the document, read whole, is preserved.
   */
  shownPartReplaced: boolean;
  /**
   * Up to `maxExamples` protected lines that were not kept, the altered ones first and then the
   * moved ones, each cut to `maxValueChars + 1` code points (so a renderer can tell it was cut)
   * without splitting a surrogate pair. Author text: for the fenced block only.
   */
  examples: string[];
}

/** Elements whose content a reader of the rendered README does not see. */
const HIDING_TAG =
  /<\/?(details|script|style|template|noscript|textarea|iframe|object)(?![A-Za-z0-9-])/i;

/** An attribute or a style inside one tag that hides the element. */
const HIDING_ATTRIBUTE = /\bhidden\b|display\s*:\s*none/i;

/**
 * Whether a line holds markup that can hide text: the start or end of an HTML comment, the opening
 * or closing tag of an element whose content is not shown (`details`, `script`, `style`,
 * `template`, `noscript`, `textarea`, `iframe`, `object`), or a tag carrying `hidden` or
 * `display: none`. A tag name must be whole, so `<s>` or `<strong>` is not `<script>` or `<style>`.
 * Inline code is not exempt: the fact is a tripwire a person clears, and a person reads code spans
 * better than a rule does. Each tag is read only up to its own `>`, so a hostile line costs one
 * pass, never a backtracking search.
 */
export function hidesText(line: string): boolean {
  if (line.includes("<!--") || line.includes("-->") || HIDING_TAG.test(line)) return true;
  // A tag runs from a `<` followed by a letter to the next `>` or `<`, or to the end of the line.
  let tag = -1;
  for (let k = 0; k <= line.length; k++) {
    const unit = k < line.length ? line.charCodeAt(k) : -1;
    if (unit !== 0x3c && unit !== 0x3e && unit !== -1) continue;
    if (tag >= 0 && HIDING_ATTRIBUTE.test(line.slice(tag, k))) return true;
    tag = unit === 0x3c && /[A-Za-z]/.test(line.charAt(k + 1)) ? k : -1;
  }
  return false;
}

/** At most `maxValueChars + 1` code points of a line, never half a surrogate pair. */
function cutExample(text: string): string {
  const max = SUMMARY_LIMITS.maxValueChars + 1;
  let end = 0;
  for (let points = 0; end < text.length && points < max; points++) {
    end += (text.codePointAt(end) as number) > 0xffff ? 2 : 1;
  }
  return text.slice(0, end);
}

/**
 * The facts of one document (design B2.1), from its parts at the merge base, at the head, and at
 * the anchor (the first version tag; null when there is none). Either side may have no part at all:
 * a README added is all insertion, one removed all removal.
 *
 * Both sides are assembled (a part unchanged between them may be binary, see
 * {@link assembleDocument}) and aligned; a refusal of either side, or an alignment over the cap, is
 * the refusal, never a partial result. The anchor matters only for the README, and an anchor
 * document that cannot be read, or has no part, protects every merge-base line instead.
 *
 * Inside each hunk the j-th removed line is paired with the j-th inserted line. A removed protected
 * line is a minor edit when its partner is within {@link isMinorEdit} (README only); otherwise it is
 * `moved` when its exact text is among the inserted lines of the document not yet taken (each taken
 * once, by the protected lines in base order, after the minor edits took theirs), and
 * `protectedAltered` when it is not. A run of extra inserted lines (past the last pair of a hunk) is
 * `insertedInsideParagraph` when the base lines on either side of it are protected, the later one
 * does not start a paragraph, and the earlier one is kept verbatim or by a minor edit.
 *
 * The part the platform shows is the first of `README_CANDIDATES` present, compared with exact
 * case as git stores names, while the document's own names are matched without regard to case: a
 * `readme.md` is in the document but is never the shown part. When no part of a side is a candidate,
 * every part of that side counts as shown, so a side with no shown README never makes the fact true
 * by itself.
 */
export function proseFacts(input: {
  document: DocumentKind;
  base: readonly DocumentPart[];
  head: readonly DocumentPart[];
  anchor: readonly DocumentPart[] | null;
}): { ok: true; facts: ProseFacts } | { ok: false; refusal: ProseRefusal } {
  const { document } = input;
  const readme = document === "readme";
  const baseOids = new Set(input.base.map((part) => part.oid));
  const skip = new Set(input.head.map((part) => part.oid).filter((oid) => baseOids.has(oid)));
  const baseRead = assembleDocument(document, input.base, skip);
  if (!baseRead.ok) return { ok: false, refusal: baseRead.refusal };
  const headRead = assembleDocument(document, input.head, skip);
  if (!headRead.ok) return { ok: false, refusal: headRead.refusal };
  let anchorLines: string[] | null = null;
  if (readme && input.anchor !== null && input.anchor.length > 0) {
    const anchorRead = assembleDocument(document, input.anchor, skip);
    if (anchorRead.ok) anchorLines = anchorRead.value.lines.map((line) => line.text);
  }
  const base = baseRead.value.lines;
  const head = headRead.value.lines;
  const isProtected = protectedMask(
    document,
    base.map((line) => line.text),
    anchorLines,
  );
  const alignment = alignLines(
    base.map((line) => line.text),
    head.map((line) => line.text),
  );
  if (alignment === null) return { ok: false, refusal: "edit_distance_cap" };

  const kept = new Array<boolean>(base.length).fill(false); // verbatim or by a minor edit
  const pairs: [number, number][] = []; // base and head index of every line kept
  const takenByMinor = new Set<number>();
  const inserted: number[] = [];
  const pending: number[] = []; // removed protected lines that are not minor edits, in base order
  let minorEdits = 0;
  let laterAltered = 0;
  let insertedInsideParagraph = 0;
  const { ops } = alignment;
  let i = 0;
  let j = 0;
  let at = 0;
  while (at < ops.length) {
    if (ops[at] === "equal") {
      kept[i] = true;
      pairs.push([i, j]);
      i++;
      j++;
      at++;
      continue;
    }
    const before = i - 1;
    const removedHere: number[] = [];
    const insertedHere: number[] = [];
    for (; at < ops.length && ops[at] !== "equal"; at++) {
      if (ops[at] === "delete") removedHere.push(i++);
      else insertedHere.push(j++);
    }
    for (const line of insertedHere) inserted.push(line);
    removedHere.forEach((removed, k) => {
      if (!isProtected[removed]) {
        laterAltered++;
        return;
      }
      const partner = insertedHere[k];
      const baseText = (base[removed] as ProseLine).text;
      if (
        readme &&
        partner !== undefined &&
        isMinorEdit(baseText, (head[partner] as ProseLine).text)
      ) {
        minorEdits++;
        kept[removed] = true;
        pairs.push([removed, partner]);
        takenByMinor.add(partner);
        return;
      }
      pending.push(removed);
    });
    if (insertedHere.length > removedHere.length) {
      const earlier =
        removedHere.length > 0 ? (removedHere[removedHere.length - 1] as number) : before;
      const after = i;
      if (
        earlier >= 0 &&
        after < base.length &&
        isProtected[earlier] &&
        isProtected[after] &&
        !(base[after] as ProseLine).paragraphStart &&
        kept[earlier]
      ) {
        insertedInsideParagraph++;
      }
    }
  }

  const pool = new Map<string, number>();
  for (const line of inserted) {
    if (takenByMinor.has(line)) continue;
    const text = (head[line] as ProseLine).text;
    pool.set(text, (pool.get(text) ?? 0) + 1);
  }
  const altered: string[] = [];
  const moved: string[] = [];
  for (const removed of pending) {
    const text = (base[removed] as ProseLine).text;
    const left = pool.get(text) ?? 0;
    if (left > 0) {
      pool.set(text, left - 1);
      moved.push(text);
    } else altered.push(text);
  }

  let shownPartReplaced = false;
  if (readme) {
    const shownBase = firstReadme(input.base.map((part) => part.name));
    const shownHead = firstReadme(input.head.map((part) => part.name));
    const shown = (name: string | null, part: string): boolean => name === null || part === name;
    shownPartReplaced = pairs.some(
      ([b, h]) =>
        isProtected[b] &&
        shown(shownBase, (base[b] as ProseLine).part) &&
        !shown(shownHead, (head[h] as ProseLine).part),
    );
  }
  let finalNewlineAdded = false;
  for (const [name, ends] of baseRead.value.finalBreak) {
    if (!ends && headRead.value.finalBreak.get(name) === true) finalNewlineAdded = true;
  }
  const beforeBreaks = baseRead.value.breaks;
  const afterBreaks = headRead.value.breaks;
  const protectedAltered = altered.length;
  const movedLines = moved.length;
  const hidingMarkupInserted = inserted.filter((line) =>
    hidesText((head[line] as ProseLine).text),
  ).length;
  return {
    ok: true,
    facts: {
      document,
      anchor: anchorLines === null ? "merge_base" : "first_version_tag",
      preserved:
        protectedAltered === 0 &&
        movedLines === 0 &&
        insertedInsideParagraph === 0 &&
        minorEdits === 0,
      protectedLines: isProtected.filter(Boolean).length,
      protectedAltered,
      minorEdits,
      laterAltered,
      moved: movedLines > 0,
      movedLines,
      insertedInsideParagraph,
      insertedLines: inserted.length,
      lineEndingsChanged:
        beforeBreaks !== "none" && afterBreaks !== "none" && beforeBreaks !== afterBreaks,
      finalNewlineAdded,
      notUtf8: baseRead.value.notUtf8 || headRead.value.notUtf8,
      partsBefore: input.base.length,
      partsAfter: input.head.length,
      hidingMarkupInserted,
      shownPartReplaced,
      examples: [...altered, ...moved].slice(0, ORIGINAL_LIMITS.maxExamples).map(cutExample),
    },
  };
}

/**
 * Whether the facts of a document are an alteration of the original authors' text: the one
 * definition of the trigger the platform fails a review on. A protected line altered or moved
 * fails either document; a line inserted inside an original paragraph fails only the README,
 * because CHANGES takes a new entry anywhere. Minor edits, later text and the tripwire facts are
 * not alterations here; the caller decides what the tripwires do.
 */
export function proseAltered(facts: ProseFacts): boolean {
  return (
    facts.protectedAltered > 0 ||
    facts.moved ||
    (facts.document === "readme" && facts.insertedInsideParagraph > 0)
  );
}
