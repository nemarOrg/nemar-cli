/**
 * The identifier screen's format readers: one registry, one read contract, one coverage count.
 *
 * A recording is screened by the reader registered for its extension. A reader sees the file only
 * through a {@link RangeSource}, wrapped by {@link cachedSource} so that it cannot read past the
 * limits the registry declares for it: a reader that asks for more gets a {@link LimitExceeded},
 * and the file counts as read only partly (`limit`), never as clean.
 *
 * **Coverage is counted here.** {@link formatCoverage} sorts every path into "a registered reader
 * reads it" (`byReader`) and "recording data nobody reads" (`unscreened`), so a caller can tell
 * "nothing found" from "nothing looked at". A file a reader claims as the companion of a header it
 * reads (`.eeg` beside `.vhdr`) counts with that recording, not as unscreened.
 *
 * Layering: this module imports the scanner's pure parsers (`identifier-scan.ts`) and the scanner
 * never imports the registry, so there is no module cycle. Dependency-free, like the scanner: the
 * screen workflow runs it under Bun with no package registry.
 */

import {
  DIRECTORY_FORMATS,
  EDF_HEADER_BYTES,
  type Finding,
  OTHER_RECORDING_EXTENSIONS,
  scanEdfHeader,
} from "./identifier-scan";
import { BRAINVISION_READER } from "./readers/brainvision";
import { NIRX_READER } from "./readers/nirx";

// ---------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------

/**
 * Every reader the screen may name. Closed: the report's door accepts exactly these, so a later
 * reader changes no vocabulary. `edf`, `brainvision` and `nirx` have readers today.
 */
export const READER_IDS = [
  "edf",
  "brainvision",
  "nirx",
  "snirf",
  "hdf5",
  "eeglab",
  "homer-nirs",
  "mat",
  "zip",
] as const;
export type ReaderId = (typeof READER_IDS)[number];

/** Why a reader read a file only partly. Each has its entry in the copy table. */
export const READER_INCOMPLETE_REASONS = [
  "limit",
  "time",
  "companion-missing",
  "encrypted",
  "corrupt",
  "unsupported-version",
  "unsupported-filter",
  "unsupported-datatype",
  "external-link",
  "content-absent",
] as const;
export type ReaderIncompleteReason = (typeof READER_INCOMPLETE_REASONS)[number];

// ---------------------------------------------------------------------------------------
// Reading bytes
// ---------------------------------------------------------------------------------------

/**
 * A file's bytes, by range. `read` returns exactly `length` bytes, or fewer only at the end of
 * the file, and throws on a read that failed. `size` is `Infinity` when nobody knows it.
 */
export interface RangeSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** A failed read, classed by a fixed word or an HTTP status. Never carries a value. */
export class ReadFailure extends Error {
  readonly cls: string;
  readonly status: number | undefined;
  readonly retryable: boolean;
  /** How long the server asked us to wait (Retry-After), when it said. */
  readonly retryAfterMs: number | undefined;
  constructor(
    cls: string,
    options: { status?: number; retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(cls);
    this.name = "ReadFailure";
    this.cls = cls;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** A reader asked for more than its limits allow. The file is `partial` with reason `limit`. */
export class LimitExceeded extends Error {
  readonly reason = "limit" as const;
  constructor() {
    super("limit");
    this.name = "LimitExceeded";
  }
}

/** What a reader may spend on one file. */
export interface ReaderLimits {
  /** Bytes fetched from the source, in all. */
  maxBytes: number;
  /** Reads made of the source (cache misses), in all. */
  maxReads: number;
  /** Bytes a reader may inflate from compressed content, in all. */
  maxInflatedBytes: number;
  /** Wall time for the file. Past it the file is `partial` with reason `time`. */
  timeMs: number;
}

/** The limits of a reader that does not declare its own. */
export const DEFAULT_READER_LIMITS: Readonly<ReaderLimits> = {
  maxBytes: 8 * 1024 * 1024,
  maxReads: 2000,
  maxInflatedBytes: 256 * 1024 * 1024,
  timeMs: 60_000,
};

/** The time one dataset's recordings may take; past it every remaining file is `partial` (`time`). */
export const DEFAULT_DATASET_TIME_MS = 20 * 60 * 1000;

/** The page size of {@link cachedSource}. */
export const PAGE_BYTES = 64 * 1024;

/** What a source has been asked for: reads that reached it, and the bytes they returned. */
export interface ReadTally {
  reads: number;
  bytes: number;
}

export interface CachedSource extends RangeSource {
  readonly tally: Readonly<ReadTally>;
  /** True once a read was refused past the limits, whatever the reader did about it. */
  readonly limited: boolean;
}

/** An in-memory file. */
export function bufferSource(bytes: Uint8Array): RangeSource {
  return {
    size: bytes.length,
    read: async (offset, length) => bytes.slice(offset, Math.min(bytes.length, offset + length)),
  };
}

/**
 * A page cache in front of a source, under a reader's limits. Reads are served from 64 KiB pages;
 * the missing pages of one read are fetched in one source read, and a page is fetched only as far
 * as the byte budget allows, so a 256-byte budget reads 256 bytes and not a page. A read the
 * source answers short marks the end of the file; the declared size alone never shortens a read. A read that
 * would take the source past `maxBytes` or `maxReads` throws {@link LimitExceeded} and fetches
 * nothing.
 */
export function cachedSource(src: RangeSource, limits: ReaderLimits): CachedSource {
  const pages = new Map<number, Uint8Array>();
  const tally: ReadTally = { reads: 0, bytes: 0 };
  let limited = false;
  // The end of the file, once a read has come back short. The declared size is not trusted to
  // shorten a read (a manifest can be wrong, and a store's answer to a read past the end is
  // itself the failure to count), so until a read comes back short the end is unknown.
  let end = Number.POSITIVE_INFINITY;

  const pageLength = (index: number) => Math.max(0, Math.min(PAGE_BYTES, end - index * PAGE_BYTES));
  /** The page holds the bytes a read needs up to `upto`, or every byte the page can hold. */
  const covers = (index: number, upto: number) => {
    const page = pages.get(index);
    if (!page) return false;
    return page.length >= Math.min(upto - index * PAGE_BYTES, pageLength(index));
  };

  async function fetchRun(first: number, last: number, need: number): Promise<void> {
    const start = first * PAGE_BYTES;
    const stop = Math.min((last + 1) * PAGE_BYTES, end);
    const budget = limits.maxBytes - tally.bytes;
    if (need - start > budget || tally.reads >= limits.maxReads) {
      limited = true;
      throw new LimitExceeded();
    }
    const want = Math.min(stop - start, budget);
    const got = await src.read(start, want);
    tally.reads++;
    tally.bytes += got.length;
    if (got.length < want) end = start + got.length;
    for (let i = first; i <= last; i++) {
      const from = (i - first) * PAGE_BYTES;
      if (from >= got.length) break;
      pages.set(i, got.subarray(from, Math.min(got.length, from + PAGE_BYTES)));
    }
  }

  async function read(offset: number, length: number): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0
    ) {
      throw new RangeError("range");
    }
    const stop = Math.min(offset + length, end);
    if (stop <= offset) return new Uint8Array(0);
    const first = Math.floor(offset / PAGE_BYTES);
    const last = Math.floor((stop - 1) / PAGE_BYTES);
    // Coalesce adjacent missing pages into one source read each.
    let run: number | null = null;
    for (let i = first; i <= last + 1; i++) {
      const missing = i <= last && !covers(i, stop);
      if (missing && run === null) run = i;
      if (!missing && run !== null) {
        await fetchRun(run, i - 1, Math.min(stop, i * PAGE_BYTES));
        run = null;
      }
    }
    const out = new Uint8Array(Math.max(0, Math.min(stop, end) - offset));
    let at = offset;
    while (at < offset + out.length) {
      const index = Math.floor(at / PAGE_BYTES);
      const page = pages.get(index);
      const from = at - index * PAGE_BYTES;
      if (!page || from >= page.length) break;
      const piece = page.subarray(from, Math.min(page.length, from + offset + out.length - at));
      out.set(piece, at - offset);
      at += piece.length;
    }
    return out.subarray(0, at - offset);
  }

  return {
    get size() {
      return Math.min(src.size, end);
    },
    read,
    tally,
    get limited() {
      return limited;
    },
  };
}

// ---------------------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------------------

/** Sibling paths a reader claims as part of a recording, and the ones its header needs and lacks. */
export interface CompanionCheck {
  claimed: string[];
  missing: string[];
}

/**
 * Something a reader noticed that is neither a finding nor a coverage gap: counted and printed
 * with its remedy, never gating and never changing completeness. Each has its entry in the copy
 * table (`NOTE_COPY`).
 */
export const READER_NOTES = ["companion-name-mismatch"] as const;
export type ReaderNote = (typeof READER_NOTES)[number];

export interface ReaderResult {
  findings: Finding[];
  /**
   * `not-applicable`: the file's content shows it is another format than the reader's (an Analyze
   * `.hdr` beside NIRx's). It is counted as unscreened under its extension, never as read, partial
   * or failed, and its companions are not looked for. Never for a decode, limit or parse failure.
   */
  coverage: "complete" | "partial" | "not-applicable";
  incomplete?: ReaderIncompleteReason;
  /** Informational notes, one per kind per file (see {@link READER_NOTES}). */
  notes?: ReaderNote[];
}

/**
 * A format's reader. The contract:
 *
 * - It reads only through the {@link RangeSource} it is given, which refuses past `limits` with
 *   {@link LimitExceeded}.
 * - A reader that hits a limit or runs short of time catches it and returns `partial`, with the
 *   findings it has made so far and the reason (`limit`, `time`, or its own). A `complete` result
 *   from a source that refused a read is counted `partial` (`limit`) all the same.
 * - A thrown {@link LimitExceeded}, or a read that outlives `limits.timeMs`, counts as `partial`
 *   (`limit` or `time`) with NO findings, so catching is how a reader keeps what it found.
 * - Any other throw is a failed read of that file, never a clean one.
 * - A file with the reader's extension that is not its format returns `not-applicable` (phase A2):
 *   it is counted as unscreened under its extension, so it never makes a dataset `unchecked`.
 *   The decision is made from the file's content alone, and only when that content shows it is
 *   another format (binary bytes where the reader's format is text, with none of the format's
 *   structure anywhere). It is never returned for a failed decode, a limit or a parse that went
 *   wrong: those are `failed` or `partial`. Content that is not recognizably another format is
 *   screened with what rules still apply, and is `partial`.
 * - A note (`notes`) is informational: counted and printed, never gating.
 */
export interface FormatReader {
  id: ReaderId;
  /** Lowercase extensions, with the dot (`.edf`, `.fif.gz`). */
  extensions: readonly string[];
  limits: ReaderLimits;
  /**
   * Limits for some of its extensions, in place of `limits` (BrainVision marker files may be far
   * longer than their headers). Keyed by an entry of `extensions`.
   */
  extensionLimits?: Readonly<Record<string, ReaderLimits>>;
  /** Recorded in the report beside the reader's id, so a verdict names the code that made it. */
  version: string;
  companions?: (path: string, siblings: ReadonlySet<string>) => CompanionCheck;
  /** Throwing is a failed read of that file, never a clean one. */
  scan(src: RangeSource, path: string, limits: ReaderLimits): Promise<ReaderResult>;
}

/**
 * EDF, EDF+ and BDF: the 256-byte fixed header, as `scanEdfHeader` reads it. A file shorter than
 * the header is a failed read (`short-body`), as it always was; a header that does not parse is
 * the finding `edf-unreadable`.
 */
export const EDF_READER: FormatReader = {
  id: "edf",
  extensions: [".edf", ".bdf"],
  limits: { maxBytes: 256, maxReads: 1, maxInflatedBytes: 0, timeMs: 5 * 60_000 },
  version: "1",
  async scan(src) {
    const head = await src.read(0, EDF_HEADER_BYTES);
    if (head.length < EDF_HEADER_BYTES) throw new ReadFailure("short-body");
    return { findings: scanEdfHeader(head), coverage: "complete" };
  },
};

/** The registry. A reader registered here is what makes its extension screened. */
export const READERS: readonly FormatReader[] = [EDF_READER, BRAINVISION_READER, NIRX_READER];

/** The limits a reader reads one path under: its extension's own, else the reader's. */
export function limitsFor(reader: FormatReader, path: string): ReaderLimits {
  if (!reader.extensionLimits) return reader.limits;
  const match = readerMatch(path, [reader]);
  return (match && reader.extensionLimits[match.extension]) ?? reader.limits;
}

/** The reader whose extension the path ends with, longest extension first; null when none. */
export function readerFor(
  path: string,
  readers: readonly FormatReader[] = READERS,
): FormatReader | null {
  const match = readerMatch(path, readers);
  return match ? match.reader : null;
}

/** The reader for a path and the extension it matched on. */
export function readerMatch(
  path: string,
  readers: readonly FormatReader[] = READERS,
): { reader: FormatReader; extension: string } | null {
  const lower = path.toLowerCase();
  let best: { reader: FormatReader; extension: string } | null = null;
  for (const reader of readers) {
    for (const extension of reader.extensions) {
      if (lower.endsWith(extension) && (!best || extension.length > best.extension.length)) {
        best = { reader, extension };
      }
    }
  }
  return best;
}

/** The registered reader with this id, or null. */
export function readerById(
  id: ReaderId,
  readers: readonly FormatReader[] = READERS,
): FormatReader | null {
  return readers.find((r) => r.id === id) ?? null;
}

/**
 * Every companion pairing in a path list: the paths some header's reader claims, and the count
 * of companions a header needs and the list lacks, by header path. Only a reader's declared
 * pairing claims a file.
 */
export function companionsOf(
  paths: readonly string[],
  readers: readonly FormatReader[] = READERS,
): { claimed: Set<string>; missing: Map<string, number> } {
  const siblings = new Set(paths);
  const claimed = new Set<string>();
  const missing = new Map<string, number>();
  for (const path of paths) {
    const reader = readerFor(path, readers);
    if (!reader?.companions) continue;
    const check = reader.companions(path, siblings);
    for (const c of check.claimed) if (siblings.has(c)) claimed.add(c);
    if (check.missing.length > 0) missing.set(path, check.missing.length);
  }
  return { claimed, missing };
}

// ---------------------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------------------

export interface FormatCoverage {
  /** Files a registered reader reads, by reader. Companions it claims are not counted. */
  byReader: Partial<Record<ReaderId, number>>;
  /**
   * Recording data no reader parses, counted by format: `.set`, `.hdf5`, `.edf.gz`, and directory
   * formats as `.ds/`, `.mff/`, `.mefd/`, `.zarr/` (one per directory).
   */
  unscreened: Record<string, number>;
}

/** A BIDS data file: `..._<suffix>.<extension>`, with a one- or two-part extension. */
const BIDS_DATA_FILE = /_(eeg|ieeg|meg|emg|nirs|physio|motion)\.([a-z0-9+]+(?:\.[a-z0-9]+)?)$/;

/**
 * Under `sourcedata/` anything that is not one of these is raw material of unknown format and is
 * counted as unscreened. Text, tables, code and documents are read by other rules or carry no signal.
 */
const SOURCEDATA_HARMLESS = new Set([
  "json",
  "tsv",
  "csv",
  "txt",
  "md",
  "yml",
  "yaml",
  "xml",
  "iml",
  "py",
  "pyc",
  "m",
  "r",
  "rmd",
  "ipynb",
  "gitignore",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "pdf",
  "svg",
  "tex",
  "bib",
  "rst",
  "cfg",
  "ini",
  "toml",
  "docx",
  "doc",
  "xlsx",
  "xls",
  "pptx",
  "ppt",
  "odt",
  "ods",
  "rtf",
  "html",
  "htm",
  "log",
  "sh",
  "bat",
  "ps1",
  "js",
  "ts",
  "css",
  "lock",
  "gitkeep",
  "ds_store",
]);

/** Base names that are documentation or housekeeping, with or without an extension. */
const HARMLESS_BASENAME =
  /^(readme|license|licence|changes|citation|authors|notice|thumbs\.db|\.ds_store|\.gitkeep)/;

/**
 * Count recording data by whether a registered reader reads it. The question it answers is "what
 * is here that nobody looked at", so it counts by what a file IS (a BIDS data file in any format
 * but JSON or TSV; a directory format; a known signal extension) rather than by a short list of
 * formats someone remembered. A path with a registered reader is that reader's, whatever else it
 * looks like.
 */
export function formatCoverage(
  paths: readonly string[],
  readers: readonly FormatReader[] = READERS,
): FormatCoverage {
  const byReader: Partial<Record<ReaderId, number>> = {};
  const unscreened: Record<string, number> = {};
  const directories = new Set<string>();
  const { claimed } = companionsOf(paths, readers);
  const count = (key: string) => {
    unscreened[key] = (unscreened[key] ?? 0) + 1;
  };
  for (const raw of paths) {
    const reader = readerFor(raw, readers);
    if (reader) {
      byReader[reader.id] = (byReader[reader.id] ?? 0) + 1;
      continue;
    }
    if (claimed.has(raw)) continue;
    const path = raw.toLowerCase();
    const segments = path.split("/");
    const dirIndex = segments.findIndex(
      (s, i) => i < segments.length - 1 && DIRECTORY_FORMATS.some((e) => s.endsWith(e)),
    );
    if (dirIndex >= 0) {
      const dir = segments.slice(0, dirIndex + 1).join("/");
      if (!directories.has(dir)) {
        directories.add(dir);
        const ext = DIRECTORY_FORMATS.find((e) => (segments[dirIndex] as string).endsWith(e));
        count(`${ext}/`);
      }
      continue;
    }
    const bids = BIDS_DATA_FILE.exec(path);
    if (bids) {
      const ext = bids[2] as string;
      if (ext !== "json" && ext !== "tsv") count(`.${ext}`);
      continue;
    }
    const hit = OTHER_RECORDING_EXTENSIONS.filter((e) => path.endsWith(e)).sort(
      (a, b) => b.length - a.length,
    )[0];
    if (hit) {
      count(hit);
      continue;
    }
    // Raw material under sourcedata/ in a format not listed above is still unread.
    if (path.startsWith("sourcedata/")) {
      const base = segments[segments.length - 1] as string;
      const dot = base.lastIndexOf(".");
      const ext = dot > 0 ? base.slice(dot + 1) : dot === 0 ? base.slice(1) : "";
      if (!SOURCEDATA_HARMLESS.has(ext) && !HARMLESS_BASENAME.test(base)) {
        count(ext === "" ? "(no extension)" : `.${ext}`);
      }
    }
  }
  return { byReader, unscreened };
}
