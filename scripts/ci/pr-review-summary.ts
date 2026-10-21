/**
 * The mechanical change summary of a dataset pull request: strict parsers, value rendering and the
 * closed vocabulary they share (ADR 0092, ADR 0107; design `.context/plans/pr-review-change-summary.md`).
 *
 * **This module is pure.** No git, no file system, no clock, and no import from the other
 * `pr-review-*` modules, so everything here can be tested on bytes and strings alone and cannot
 * reach the pull request's repository. The model is shown a summary of a change instead of every
 * diff, and that is only safe if the summary loses nothing; the coverage argument (design section
 * 6.2) therefore starts from two promises made here, and every function below is written to keep
 * one of them.
 *
 * 1. **A parse loses no byte.** A table is accepted only when serializing the parse gives the input
 *    back byte for byte ({@link parseTsv}), and a JSON document only when it is plain RFC 8259 with
 *    no key repeated and every number kept as written ({@link parseJson}). Two readers can then not
 *    disagree about what the file says, and a difference the summary does not show is a difference
 *    the files do not have.
 * 2. **Anything ambiguous is a refusal, never a guess.** A file the parsers cannot read exactly
 *    stays on the raw-diff path as it is today; a refusal is one of the closed words in
 *    {@link SUMMARY_REFUSALS}, because the word is printed in a public log and an error built from a
 *    path or a message would put a contributor's text there.
 *
 * What the model is shown of a value goes through {@link renderValue}, which escapes everything a
 * reader cannot see or tell apart, so a value cannot forge the platform's own markers.
 */

/**
 * The bounds of the summary. Every cap is a refusal or a cut, never a silent truncation: a file
 * over a per-file cap is refused, a class that does not fit is not rendered, and a cut makes what
 * was cut incomplete (design sections 5.2 to 5.4). Later phases use the rest of the object.
 */
export const SUMMARY_LIMITS = {
  maxBlobBytes: 8 * 1024 * 1024, // per file side
  maxRows: 200_000, // per table
  maxJsonDepth: 64,
  maxJsonNodes: 200_000,
  maxKeyChars: 128, // longer keys get no relabel rule
  maxRuns: 24,
  maxTotalBytes: 256 * 1024 * 1024, // all blobs the summary reads in one run
  maxSummaryChars: 30_000, // the fenced block
  maxClasses: 120, // classes rendered
  maxPairsPerClass: 12, // distinct value pairs rendered per class
  maxValueChars: 300, // per rendered value
  samplesPerClass: 2,
  timeReserveMs: 40_000, // stop summarizing when less than this is left of the content pass
} as const;

/**
 * Why a file was not summarized. A closed list, in the order the parsers can raise them: the first
 * five are about the bytes, the next six about a table's shape, the next four about a JSON
 * document, and the last two about the platform's own reading (`blob_missing` is a git object that
 * could not be read, `internal_mismatch` is the bucket count of design section 6.2 not adding up).
 */
export const SUMMARY_REFUSALS = [
  "too_large",
  "nul_byte",
  "invalid_utf8",
  "bare_cr",
  "empty",
  "empty_column_name",
  "duplicate_column",
  "ragged_row",
  "quoted_cell",
  "too_many_rows",
  "no_round_trip",
  "not_json",
  "duplicate_key",
  "too_deep",
  "too_many_nodes",
  "blob_missing",
  "internal_mismatch",
] as const;
export type SummaryRefusal = (typeof SUMMARY_REFUSALS)[number];

/** How a text file is laid out, apart from its content: what a `format` change is made of. */
export interface TextFormat {
  /** A leading U+FEFF, removed before parsing and put back by the serializer. */
  bom: boolean;
  /**
   * The line endings of the terminated lines: `lf` when every one is LF, `crlf` when every one is
   * CRLF, `mixed` otherwise, and `none` when no line is terminated.
   */
  eol: "lf" | "crlf" | "mixed" | "none";
  /** The text ends with a line break. */
  finalNewline: boolean;
}

/** A parsed tab-separated table, with everything {@link serializeTsv} needs to write it back exactly. */
export interface Table {
  format: TextFormat;
  /**
   * Per line (the header first), whether it ended in CR before its LF, so a file with mixed
   * endings round-trips. One entry per line; an unterminated last line has `false`.
   */
  crByLine: readonly boolean[];
  header: readonly string[];
  rows: readonly (readonly string[])[];
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; refusal: SummaryRefusal };

/**
 * A parsed JSON document. Numbers are the text the file wrote (`1.0`, `1`, `1e400` and `-0` are
 * four different values here, because a platform that normalized them would hide a change); an
 * object keeps its keys in source order. A key named `__proto__` is an ordinary key, held in a
 * `Map` that has no prototype lookup.
 */
export type JsonValue =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "num"; v: string }
  | { t: "str"; v: string }
  | { t: "arr"; v: readonly JsonValue[] }
  | { t: "obj"; keys: readonly string[]; v: ReadonlyMap<string, JsonValue> };

// ---------------------------------------------------------------------------------------------
// Paths and values
// ---------------------------------------------------------------------------------------------

/**
 * A path with every BIDS entity value replaced by `*`, in every segment, so the same edit in 125
 * subjects has one shape: the file name `sub-001_ses-01_task-sleep_run-01_channels.tsv` becomes
 * `sub-*_ses-*_task-*_run-*_channels.tsv`, and the directories `sub-001` and `ses-01` above it
 * become `sub-*` and `ses-*` the same way. An entity is a letters-only label, a hyphen and an
 * alphanumeric value that is followed by a separator (a slash, an underscore or a dot), so a name
 * without that shape (`dataset_description.json`, a final `sub-001` with nothing after it) is left
 * alone.
 */
export function entityPattern(path: string): string {
  return path.replace(/(^|[/_])([a-zA-Z]+)-[a-zA-Z0-9]+(?=[/_.])/g, "$1$2-*");
}

/** Every character a reader cannot see or tell apart from another: control, format, separator, unassigned. */
const UNSEEN = /[\p{C}\p{Z}]/gu;

/** The marker that a value was cut. It goes after the closing quote, where a value cannot write it. */
const CUT_MARKER = "...(cut)";

/**
 * A value as the model is shown it: quoted, with nothing in it that could be mistaken for the
 * platform's own text, and cut at `max` characters.
 *
 * The order is deliberate. The value is first cut to `max` CODE POINTS (an astral character is one,
 * so a cut never splits a surrogate pair). The kept text then goes through `JSON.stringify`, which
 * doubles every backslash and escapes quotes, line breaks and the other control characters, so no
 * value can imitate an escape the platform writes after it. Only then is every character that
 * survives and is unseen (`\p{C}` or `\p{Z}`: zero-width and bidi controls, no-break and other
 * spaces, the soft hyphen, private-use and unassigned code points) replaced by `\u{HEX}`, which is
 * safe because a literal `\u{200B}` in the value was already doubled to `\\u{200B}`. Only U+0020 is
 * left alone. A lone surrogate is escaped by `JSON.stringify` itself (well-formed since ES2019).
 * When the value was cut, `...(cut)` is appended AFTER the closing quote; a value that merely ends
 * in that text is not cut and is quoted like any other, so the marker cannot be forged.
 */
export function renderValue(
  v: string,
  max: number = SUMMARY_LIMITS.maxValueChars,
): { text: string; cut: boolean } {
  let end = 0;
  let points = 0;
  while (end < v.length && points < max) {
    end += (v.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
    points++;
  }
  const cut = end < v.length;
  const quoted = JSON.stringify(v.slice(0, end)).replace(UNSEEN, (ch) =>
    ch === " " ? ch : `\\u{${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`,
  );
  return { text: cut ? `${quoted}${CUT_MARKER}` : quoted, cut };
}

/** A code point as the notes print it: `U+` and at least four uppercase hex digits. */
function codePointLabel(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Where two strings that may look the same first differ, for the line that must say so: null when
 * they are equal, otherwise `first difference at character k: U+XXXX to U+YYYY`. `k` is 1-based and
 * counted in code points; a side that has ended is the word `end`. Computed on the raw values, one
 * code point at a time and without copying either string, because a value can be megabytes long.
 */
export function firstDifference(a: string, b: string): string | null {
  if (a === b) return null;
  let i = 0;
  let j = 0;
  let k = 0;
  for (;;) {
    k++;
    const ca = i < a.length ? a.codePointAt(i) : undefined;
    const cb = j < b.length ? b.codePointAt(j) : undefined;
    if (ca !== cb) {
      const left = ca === undefined ? "end" : codePointLabel(ca);
      const right = cb === undefined ? "end" : codePointLabel(cb);
      return `first difference at character ${k}: ${left} to ${right}`;
    }
    if (ca === undefined) return null;
    const width = ca > 0xffff ? 2 : 1;
    i += width;
    j += width;
  }
}
