/**
 * The ZIP reader (publication-queue plan, card A6). A `.zip` is screened by its entry names and,
 * for small entries in a format with a registered reader, by that reader over the entry's bytes.
 *
 * Layout (PKWARE APPNOTE 6.3.10): the end of central directory record sits in the last 64 KiB
 * (a ZIP64 archive puts a locator and a ZIP64 end record before it), and names where the
 * central directory is; each directory entry names a local file header, which the entry's data
 * follows. Only those parts are read, by range: the tail, the central directory (at most
 * {@link ZIP_DIRECTORY_MAX_BYTES} and {@link ZIP_DIRECTORY_MAX_ENTRIES}; past either the read is
 * `partial`, `limit`), and the entries a reader reads. Nothing is extracted to disk.
 *
 * - **Names.** Every entry name goes through `scanPaths` as `<archive>!/<entry>`.
 * - **Inner recordings.** An entry is read when its extension has a reader, its method is stored
 *   (0) or deflate (8), its uncompressed size is at most {@link ZIP_ENTRY_MAX_BYTES} and it is
 *   not encrypted. A deflated entry is inflated lazily with `DecompressionStream("deflate-raw")`,
 *   only as far as its reader reads, and never past the size the directory declares for it (a
 *   zip bomb stops there and reads as `corrupt`). The inner reader runs under its own limits; its
 *   findings count toward the dataset and its coverage toward the archive's.
 * - **Not read.** An inner recording entry that is not read (no reader, method or size outside
 *   the rule, the reader found it is another format) is counted in `unscreened` as `zip:<ext>`.
 *   Nesting is followed one level only: a ZIP inside a ZIP is screened by name and counted
 *   `zip:.zip`. An encrypted recording entry is counted so too, and makes the archive `partial`
 *   (`encrypted`).
 * - **Complete** only when the directory was read in full and every inner entry that was read
 *   was read completely.
 *
 * What is an inner recording entry is decided by the registry's own coverage rule, as if the
 * archive's content were raw material under `sourcedata/`: an archive is raw material by nature,
 * so an entry in an unknown format counts as unscreened, and text, tables and documents do not.
 * macOS resource forks (`__MACOSX/`, `._name`) are screened by name and never read as recordings.
 *
 * Layering: like every reader, this module imports the registry only as types. The registry's
 * functions it needs are handed to {@link createZipReader} by the registry itself (a {@link ZipKit}),
 * so there is no module cycle and the inner registry excludes this reader.
 */

import type {
  CachedSource,
  FormatCoverage,
  FormatReader,
  RangeSource,
  ReaderIncompleteReason,
  ReaderLimits,
  ReaderResult,
} from "../identifier-readers";
import { type Finding, scanPaths } from "../identifier-scan";

/** The tail read for the end of central directory record. */
export const ZIP_TAIL_BYTES = 64 * 1024;
/** The most central directory read. Past it the archive is `partial` (`limit`). */
export const ZIP_DIRECTORY_MAX_BYTES = 4 * 1024 * 1024;
/** The most central directory entries read. Past it the archive is `partial` (`limit`). */
export const ZIP_DIRECTORY_MAX_ENTRIES = 50_000;
/** The largest uncompressed entry an inner reader reads. */
export const ZIP_ENTRY_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The archive's limits. Bytes: the tail and the directory, then the inner entries' reads, each at
 * least one 64 KiB page of the registry's cache. Inflated bytes: all inner entries together.
 */
export const ZIP_LIMITS: Readonly<ReaderLimits> = {
  maxBytes: 128 * 1024 * 1024,
  maxReads: 4000,
  maxInflatedBytes: 256 * 1024 * 1024,
  timeMs: 10 * 60_000,
};

/** Compressed bytes handed to the inflater at a time (deflate expands at most about 1032:1). */
const INFLATE_INPUT_BYTES = 16 * 1024;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_END = 0x06064b50;
const END_BYTES = 22;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_END_BYTES = 56;
const CENTRAL_BYTES = 46;
const LOCAL_BYTES = 30;
const MAX_COMMENT = 0xffff;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/** WinZip AES: the method field says 99 and the real method is in an extra field. */
const METHOD_AES = 99;
const FLAG_ENCRYPTED = 0x0001;

/** The registry functions the ZIP reader uses, handed over by the registry (no module cycle). */
export interface ZipKit {
  /** The readers an inner entry may be read by: the registry without the ZIP reader. */
  inner(): readonly FormatReader[];
  cachedSource(src: RangeSource, limits: ReaderLimits): CachedSource;
  limitsFor(reader: FormatReader, path: string): ReaderLimits;
  readerMatch(
    path: string,
    readers: readonly FormatReader[],
  ): { reader: FormatReader; extension: string } | null;
  companionsOf(
    paths: readonly string[],
    readers: readonly FormatReader[],
  ): { claimed: Set<string>; missing: Map<string, number> };
  formatCoverage(paths: readonly string[], readers: readonly FormatReader[]): FormatCoverage;
  /** The registry's refusal past a reader's limits. */
  limitExceeded(): Error;
  /** The page size of the registry's cache: a read that starts mid-page costs the page. */
  pageBytes: number;
}

/** One central directory entry. */
export interface ZipEntry {
  /** The entry's name with `/` separators and no leading `/` or `./`. */
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  directory: boolean;
}

/** The central directory as read, and why it was read only in part. */
export interface ZipDirectory {
  entries: ZipEntry[];
  /** Entries the end record declares. */
  declared: number;
  incomplete?: ReaderIncompleteReason;
}

// ---------------------------------------------------------------------------------------
// The central directory
// ---------------------------------------------------------------------------------------

const u16 = (b: Uint8Array, at: number) => (b[at] as number) | ((b[at + 1] as number) << 8);
const u32 = (b: Uint8Array, at: number) =>
  ((b[at] as number) |
    ((b[at + 1] as number) << 8) |
    ((b[at + 2] as number) << 16) |
    ((b[at + 3] as number) << 24)) >>>
  0;
/** A little-endian 64-bit count, or NaN past 2^53 (no archive is that large). */
const u64 = (b: Uint8Array, at: number) => {
  const value = u32(b, at) + u32(b, at + 4) * 0x1_0000_0000;
  return Number.isSafeInteger(value) ? value : Number.NaN;
};

const decoder = new TextDecoder("utf-8");

/** An entry name as a path: `/` separators, no leading `/` or `./`. */
function entryName(raw: Uint8Array): string {
  let name = decoder.decode(raw).replaceAll("\\", "/");
  while (name.startsWith("/") || name.startsWith("./")) name = name.slice(name[0] === "/" ? 1 : 2);
  return name;
}

/** The last end record in `tail` whose comment ends at the end of the file, else the last one. */
function findEnd(tail: Uint8Array, tailStart: number, size: number): number | null {
  let fallback: number | null = null;
  for (let at = tail.length - END_BYTES; at >= 0; at--) {
    if (u32(tail, at) !== SIG_END) continue;
    if (tailStart + at + END_BYTES + u16(tail, at + 20) === size) return at;
    fallback ??= at;
  }
  return fallback;
}

/**
 * Read the central directory: the end record from the tail (the last page first, the rest of the
 * last 64 KiB and a comment's length only when the record is not in it), the ZIP64 records when
 * the end record says so, then the directory itself, up to its caps.
 */
export async function readZipDirectory(src: RangeSource, pageBytes: number): Promise<ZipDirectory> {
  const size = src.size;
  // Without the file's size its end cannot be found without reading all of it.
  if (!Number.isFinite(size)) return { entries: [], declared: 0, incomplete: "limit" };
  if (size < END_BYTES) return { entries: [], declared: 0, incomplete: "corrupt" };
  // The last page first: through the page cache, a read that starts mid-page costs the page.
  let tailStart = Math.max(0, Math.floor((size - 1) / pageBytes) * pageBytes);
  if (size - tailStart < END_BYTES + ZIP64_LOCATOR_BYTES) {
    tailStart = Math.max(0, size - END_BYTES - ZIP64_LOCATOR_BYTES);
  }
  let tail = await src.read(tailStart, size - tailStart);
  if (tail.length < size - tailStart) return { entries: [], declared: 0, incomplete: "corrupt" };
  let at = findEnd(tail, tailStart, size);
  const widest = Math.max(0, size - ZIP_TAIL_BYTES);
  if (at === null && tailStart > widest) {
    tailStart = widest;
    tail = await src.read(tailStart, size - tailStart);
    if (tail.length < size - tailStart) return { entries: [], declared: 0, incomplete: "corrupt" };
    at = findEnd(tail, tailStart, size);
  }
  if (at === null) {
    // A comment longer than the tail leaves the record just before the tail.
    const longest = Math.max(0, size - END_BYTES - MAX_COMMENT);
    if (tailStart > longest) {
      const more = await src.read(longest, tailStart - longest);
      const joined = new Uint8Array(more.length + tail.length);
      joined.set(more);
      joined.set(tail, more.length);
      tailStart = longest;
      tail = joined;
      at = findEnd(tail, tailStart, size);
    }
  }
  if (at === null) return { entries: [], declared: 0, incomplete: "corrupt" };

  const endAt = tailStart + at;
  let disk = u16(tail, at + 4);
  let directoryDisk = u16(tail, at + 6);
  let onDisk = u16(tail, at + 8);
  let declared = u16(tail, at + 10);
  let directorySize = u32(tail, at + 12);
  let directoryOffset = u32(tail, at + 16);
  let directoryEnd = endAt;

  const wide =
    declared === 0xffff ||
    onDisk === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff;
  if (wide && endAt >= ZIP64_LOCATOR_BYTES) {
    const locator = await src.read(endAt - ZIP64_LOCATOR_BYTES, ZIP64_LOCATOR_BYTES);
    if (locator.length === ZIP64_LOCATOR_BYTES && u32(locator, 0) === SIG_ZIP64_LOCATOR) {
      const totalDisks = u32(locator, 16);
      const recordAt = u64(locator, 8);
      if (totalDisks > 1) return { entries: [], declared: 0, incomplete: "unsupported-version" };
      if (!Number.isSafeInteger(recordAt) || recordAt + ZIP64_END_BYTES > endAt) {
        return { entries: [], declared: 0, incomplete: "corrupt" };
      }
      const record = await src.read(recordAt, ZIP64_END_BYTES);
      if (record.length < ZIP64_END_BYTES || u32(record, 0) !== SIG_ZIP64_END) {
        return { entries: [], declared: 0, incomplete: "corrupt" };
      }
      disk = u32(record, 16);
      directoryDisk = u32(record, 20);
      onDisk = u64(record, 24);
      declared = u64(record, 32);
      directorySize = u64(record, 40);
      directoryOffset = u64(record, 48);
      directoryEnd = recordAt;
    }
  }
  // A split or spanned archive: its other parts are other files.
  if (disk !== 0 || directoryDisk !== 0 || onDisk !== declared) {
    return { entries: [], declared: 0, incomplete: "unsupported-version" };
  }
  if (
    !Number.isSafeInteger(declared) ||
    !Number.isSafeInteger(directorySize) ||
    !Number.isSafeInteger(directoryOffset) ||
    directoryOffset + directorySize > directoryEnd
  ) {
    return { entries: [], declared: 0, incomplete: "corrupt" };
  }

  let incomplete: ReaderIncompleteReason | undefined;
  const readBytes = Math.min(directorySize, ZIP_DIRECTORY_MAX_BYTES);
  if (directorySize > ZIP_DIRECTORY_MAX_BYTES || declared > ZIP_DIRECTORY_MAX_ENTRIES) {
    incomplete = "limit";
  }
  const dir = readBytes === 0 ? new Uint8Array(0) : await src.read(directoryOffset, readBytes);
  if (dir.length < readBytes) incomplete = "corrupt";
  const entries: ZipEntry[] = [];
  let p = 0;
  const wanted = Math.min(declared, ZIP_DIRECTORY_MAX_ENTRIES);
  while (entries.length < wanted) {
    if (p + CENTRAL_BYTES > dir.length) {
      // Cut off by the byte cap is a limit; anything else is a directory shorter than declared.
      if (incomplete === undefined) incomplete = "corrupt";
      break;
    }
    if (u32(dir, p) !== SIG_CENTRAL) {
      incomplete = "corrupt";
      break;
    }
    const nameLength = u16(dir, p + 28);
    const extraLength = u16(dir, p + 30);
    const commentLength = u16(dir, p + 32);
    const next = p + CENTRAL_BYTES + nameLength + extraLength + commentLength;
    if (next > dir.length) {
      if (incomplete === undefined) incomplete = "corrupt";
      break;
    }
    let compressedSize = u32(dir, p + 20);
    let uncompressedSize = u32(dir, p + 24);
    let localOffset = u32(dir, p + 42);
    // ZIP64 extended information: only the fields whose 32-bit value is all ones, in order.
    let x = p + CENTRAL_BYTES + nameLength;
    const extraEnd = x + extraLength;
    while (x + 4 <= extraEnd) {
      const id = u16(dir, x);
      const length = u16(dir, x + 2);
      if (id === 0x0001) {
        let f = x + 4;
        const fieldEnd = Math.min(extraEnd, f + length);
        if (uncompressedSize === 0xffffffff && f + 8 <= fieldEnd) {
          uncompressedSize = u64(dir, f);
          f += 8;
        }
        if (compressedSize === 0xffffffff && f + 8 <= fieldEnd) {
          compressedSize = u64(dir, f);
          f += 8;
        }
        if (localOffset === 0xffffffff && f + 8 <= fieldEnd) localOffset = u64(dir, f);
      }
      x += 4 + length;
    }
    const name = entryName(dir.subarray(p + CENTRAL_BYTES, p + CENTRAL_BYTES + nameLength));
    entries.push({
      name,
      method: u16(dir, p + 10),
      flags: u16(dir, p + 8),
      compressedSize,
      uncompressedSize,
      localOffset,
      directory: name.endsWith("/"),
    });
    p = next;
  }
  return incomplete === undefined ? { entries, declared } : { entries, declared, incomplete };
}

// ---------------------------------------------------------------------------------------
// Entry bytes
// ---------------------------------------------------------------------------------------

/** The entry's compressed data could not be inflated. */
class InflateFailed extends Error {
  constructor() {
    super("inflate");
    this.name = "InflateFailed";
  }
}

/** A read of the archive itself failed: the archive is a failed read, as any file is. */
class ArchiveReadFailed extends Error {
  constructor(readonly original: unknown) {
    super("archive-read");
    this.name = "ArchiveReadFailed";
  }
}

/** An inner read ran out of time. */
class InnerTimedOut extends Error {
  constructor() {
    super("time");
    this.name = "InnerTimedOut";
  }
}

const isNamed = (e: unknown, name: string) => e instanceof Error && e.name === name;

/** What every inflating entry of one archive shares: the inflated-bytes budget. */
interface InflateBudget {
  max: number;
  used: number;
  hit: boolean;
}

/** An entry's bytes, and whether they disagreed with the size the directory declares. */
interface EntrySource extends RangeSource {
  /** The data ran past the declared size (a zip bomb) or ended before it. */
  readonly mismatch: boolean;
  /** The inflater refused the data. */
  readonly damaged: boolean;
  close(): Promise<void>;
}

/** A stored entry: a window on the archive. */
function storedSource(
  archive: (offset: number, length: number) => Promise<Uint8Array>,
  dataAt: number,
  size: number,
): EntrySource {
  let short = false;
  return {
    size,
    async read(offset, length) {
      const want = Math.max(0, Math.min(length, size - offset));
      if (want === 0) return new Uint8Array(0);
      const got = await archive(dataAt + offset, want);
      if (got.length < want) short = true;
      return got;
    },
    get mismatch() {
      return short;
    },
    damaged: false,
    close: async () => undefined,
  };
}

/**
 * A deflated entry, inflated as far as reads ask and never past the declared size: the inflater
 * is fed {@link INFLATE_INPUT_BYTES} of compressed data at a time, only when a read needs more.
 * Output past the declared size marks the entry `mismatch` and is dropped; the inflated bytes of
 * the whole archive are capped by the budget, past which a read throws the registry's limit.
 */
function inflatingSource(
  archive: (offset: number, length: number) => Promise<Uint8Array>,
  dataAt: number,
  compressedSize: number,
  declared: number,
  budget: InflateBudget,
  limitExceeded: () => Error,
): EntrySource {
  let buffer = new Uint8Array(Math.min(declared, 64 * 1024));
  let produced = 0;
  let finished = false;
  let mismatch = false;
  let damaged = false;
  let fed = 0;
  let sourceError: unknown;

  const open = () => {
    const input = new ReadableStream<Uint8Array<ArrayBuffer>>(
      {
        async pull(controller) {
          const n = Math.min(INFLATE_INPUT_BYTES, compressedSize - fed);
          if (n <= 0) {
            controller.close();
            return;
          }
          try {
            const chunk = await archive(dataAt + fed, n);
            fed += n;
            controller.enqueue(chunk as Uint8Array<ArrayBuffer>);
            if (chunk.length < n) controller.close();
          } catch (error) {
            sourceError = error;
            controller.error(error);
          }
        },
      },
      { highWaterMark: 0 },
    );
    return input.pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  };
  let reader: ReturnType<typeof open> | null = null;

  const append = (chunk: Uint8Array) => {
    if (produced + chunk.length > buffer.length) {
      let capacity = buffer.length * 2;
      while (capacity < produced + chunk.length) capacity *= 2;
      const grown = new Uint8Array(Math.min(capacity, declared));
      grown.set(buffer.subarray(0, produced));
      buffer = grown;
    }
    buffer.set(chunk, produced);
    produced += chunk.length;
  };

  const stop = async () => {
    finished = true;
    const r = reader;
    reader = null;
    await r?.cancel().catch(() => undefined);
  };

  return {
    size: declared,
    async read(offset, length) {
      const want = Math.min(offset + length, declared);
      while (produced < want && !finished) {
        const current = reader ?? open();
        reader = current;
        let step: Awaited<ReturnType<typeof current.read>>;
        try {
          step = await current.read();
        } catch {
          finished = true;
          if (sourceError !== undefined) throw sourceError;
          damaged = true;
          throw new InflateFailed();
        }
        if (step.done) {
          finished = true;
          break;
        }
        const chunk = step.value;
        if (budget.used + chunk.length > budget.max) {
          budget.hit = true;
          await stop();
          throw limitExceeded();
        }
        budget.used += chunk.length;
        if (produced + chunk.length > declared) {
          // More data than the directory declares: keep the declared bytes, stop inflating.
          mismatch = true;
          append(chunk.subarray(0, declared - produced));
          await stop();
          break;
        }
        append(chunk);
      }
      if (produced < want && finished && !mismatch) mismatch = true;
      const end = Math.min(want, produced);
      return offset >= end ? new Uint8Array(0) : buffer.slice(offset, end);
    },
    get mismatch() {
      return mismatch;
    },
    get damaged() {
      return damaged;
    },
    close: stop,
  };
}

/** Run `work` under a timer; a late result is abandoned. */
function withTimer<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new InnerTimedOut()), Math.max(0, ms));
  });
  work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

// ---------------------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------------------

/** A resource fork macOS writes into archives: metadata, never a recording. */
const isResourceFork = (name: string) =>
  name.startsWith("__MACOSX/") || name.slice(name.lastIndexOf("/") + 1).startsWith("._");

/**
 * Where an archive's content is classified for coverage: as raw material under `sourcedata/`
 * (see the module comment).
 */
const RAW = "sourcedata/";

/** Scan one archive. */
export async function scanZip(
  src: RangeSource,
  path: string,
  limits: ReaderLimits,
  kit: ZipKit,
  now: () => number = Date.now,
): Promise<ReaderResult> {
  const started = now();
  // Stop before the registry's own timer for the archive would discard every finding.
  const deadline = started + Math.floor(limits.timeMs * 0.9);
  const reasons: ReaderIncompleteReason[] = [];
  const reason = (r: ReaderIncompleteReason) => {
    if (!reasons.includes(r)) reasons.push(r);
  };
  const unscreened: Record<string, number> = {};
  const count = (key: string) => {
    const k = `zip:${key}`;
    unscreened[k] = (unscreened[k] ?? 0) + 1;
  };
  const findings: Finding[] = [];

  const directory = await readZipDirectory(src, kit.pageBytes);
  if (directory.incomplete) reason(directory.incomplete);
  const { entries } = directory;
  for (const f of scanPaths(entries.map((e) => `${path}!/${e.name}`))) findings.push(f);

  const inner = kit.inner();
  const files = entries.filter((e) => !e.directory && !isResourceFork(e.name));
  const names = files.map((e) => e.name);
  // Entries no reader reads, by the registry's own coverage rule.
  const coverage = kit.formatCoverage(
    names.map((n) => RAW + n),
    inner,
  );
  for (const [key, n] of Object.entries(coverage.unscreened)) {
    for (let i = 0; i < n; i++) count(key);
  }
  const { missing } = kit.companionsOf(names, inner);

  const archive = async (offset: number, length: number) => {
    try {
      return await src.read(offset, length);
    } catch (error) {
      if (isNamed(error, "LimitExceeded")) throw error;
      throw new ArchiveReadFailed(error);
    }
  };
  const budget: InflateBudget = { max: limits.maxInflatedBytes, used: 0, hit: false };

  for (const entry of files) {
    const match = kit.readerMatch(entry.name, inner);
    if (!match) continue;
    const { reader, extension } = match;
    if ((entry.flags & FLAG_ENCRYPTED) !== 0 || entry.method === METHOD_AES) {
      count(extension);
      reason("encrypted");
      continue;
    }
    if (
      (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) ||
      entry.uncompressedSize > ZIP_ENTRY_MAX_BYTES ||
      !Number.isSafeInteger(entry.compressedSize) ||
      !Number.isSafeInteger(entry.localOffset)
    ) {
      count(extension);
      continue;
    }
    if (now() >= deadline || budget.hit) {
      count(extension);
      reason(budget.hit ? "limit" : "time");
      continue;
    }
    let opened: EntrySource | null = null;
    try {
      const local = await archive(entry.localOffset, LOCAL_BYTES);
      if (local.length < LOCAL_BYTES || u32(local, 0) !== SIG_LOCAL) {
        reason("corrupt");
        continue;
      }
      const dataAt = entry.localOffset + LOCAL_BYTES + u16(local, 26) + u16(local, 28);
      if (dataAt + entry.compressedSize > src.size) {
        reason("corrupt");
        continue;
      }
      if (entry.method === METHOD_STORED && entry.compressedSize !== entry.uncompressedSize) {
        reason("corrupt");
        continue;
      }
      opened =
        entry.method === METHOD_STORED
          ? storedSource(archive, dataAt, entry.uncompressedSize)
          : inflatingSource(
              archive,
              dataAt,
              entry.compressedSize,
              entry.uncompressedSize,
              budget,
              kit.limitExceeded,
            );
      const innerLimits = kit.limitsFor(reader, entry.name);
      const cached = kit.cachedSource(opened, innerLimits);
      const result = await withTimer(
        reader.scan(cached, `${path}!/${entry.name}`, innerLimits),
        Math.min(innerLimits.timeMs, deadline - now()),
      );
      // Bytes that disagree with the directory are damage, whatever the reader made of them.
      if (opened.mismatch || opened.damaged) {
        for (const f of result.findings) findings.push(f);
        reason("corrupt");
        continue;
      }
      if (result.coverage === "not-applicable") {
        count(extension);
        continue;
      }
      for (const f of result.findings) findings.push(f);
      const lacking = missing.get(entry.name) ?? 0;
      const clean =
        result.coverage === "complete" && !cached.limited && lacking === 0 && !budget.hit;
      if (clean) continue;
      if (lacking > 0) reason("companion-missing");
      if (cached.limited || budget.hit) reason("limit");
      if (result.coverage === "partial") reason(result.incomplete ?? "limit");
    } catch (error) {
      if (error instanceof ArchiveReadFailed) throw error.original;
      if (error instanceof InflateFailed) reason("corrupt");
      else if (isNamed(error, "LimitExceeded")) reason("limit");
      else if (error instanceof InnerTimedOut) reason("time");
      // The inner reader's own failed read: the entry's bytes are not its format's.
      else if (isNamed(error, "ReadFailure")) reason("corrupt");
      else throw error;
    } finally {
      await opened?.close();
    }
  }

  const out: ReaderResult = {
    findings,
    coverage: reasons.length === 0 ? "complete" : "partial",
  };
  if (reasons.length > 0) out.incomplete = reasons[0] as ReaderIncompleteReason;
  if (Object.keys(unscreened).length > 0) out.unscreened = unscreened;
  return out;
}

/** The ZIP reader, over the registry the kit hands it. */
export function createZipReader(kit: ZipKit): FormatReader {
  return {
    id: "zip",
    extensions: [".zip"],
    limits: ZIP_LIMITS,
    version: "1",
    scan: (src, path, limits) => scanZip(src, path, limits, kit),
  };
}
