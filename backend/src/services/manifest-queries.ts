/**
 * The questions the data plane asks of a version manifest, each answered from
 * a streaming scan with memory proportional to the ANSWER, not the manifest
 * (#1502). Each class is a {@link FilesVisitor} for `scanManifestStream` plus a
 * `finish` that turns what it kept into the value the route used to compute
 * from a parsed manifest.
 *
 * Every query reproduces a reference function in `data-router.ts` that runs
 * over `JSON.parse`'s output, and `manifest-queries.test.ts` compares the two
 * over the same documents:
 *
 *  - {@link ResolvePathQuery} is `resolveFile`: the file at a path, or the
 *    immediate children of a directory. Kept: the one entry, or one small
 *    record per child.
 *  - {@link ContainsPathQuery} is `Object.hasOwn(manifest.files, path)`, for
 *    the tombstone walk. Kept: one boolean.
 *  - {@link DigestQuery} is `digestManifest`, for `metadata.json`. Kept: two
 *    numbers and the BIDS index, which grows with subjects, not files. Where
 *    the stream cannot prove the totals it reports them unproven rather than
 *    reading the manifest whole.
 *  - {@link EntriesQuery} is `manifest.files` itself, for `manifest.json`,
 *    which has to name every entry; it is bounded by a count instead, and
 *    {@link EntryCountQuery} (`Object.keys(manifest.files).length`) lets the
 *    route refuse an oversized one without materializing anything.
 *
 * ORDER. A scan sees entries in document order; `Object.entries` does not
 * quite use document order. It lists array-index keys ("0", "42") first in
 * ascending numeric order, then the rest in first-insertion order, and a key
 * that appears twice keeps its first position with its last value. The
 * queries that emit an order ({@link ResolvePathQuery}'s children, which a
 * stable sort only reorders among ties) reproduce that. Nothing here assumes
 * the manifest is sorted; {@link DigestQuery} and {@link EntryCountQuery} are
 * the queries that USE sortedness, and they check it on every key.
 */

import {
  BidsIndexBuilder,
  type DirectoryEntry,
  type ManifestDigest,
  type ResolvedFile,
  SessionsCollector,
  normalizeBidsPath,
} from "./data-router";
import type { ManifestFile } from "./manifest";
import { type FilesVisitor, type ManifestHeader, defineJsonMember } from "./manifest-scan";

/** A {@link FilesVisitor} that knows what to answer once the scan is done. */
export interface ManifestQuery<T> extends FilesVisitor {
  finish(header: ManifestHeader): T;
}

/**
 * Is `key` an array index, i.e. a key ordinary objects enumerate ahead of all
 * others, in numeric order? The canonical decimal form of an integer in
 * 0 .. 2^32 - 2 (ECMA-262 "array index").
 */
export function isArrayIndexKey(key: string): boolean {
  const n = key.length;
  if (n === 0 || n > 10) return false;
  const first = key.charCodeAt(0);
  if (first === 0x30) return n === 1;
  for (let i = 0; i < n; i++) {
    const c = key.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false;
  }
  return Number(key) <= 4294967294;
}

/**
 * A direct child file's `size`, read when its entry arrives. Reading a
 * property of a parsed JSON object has no side effects, so reading it early is
 * the same as reading it where `resolveFile` did. A value that is NOT an
 * object is kept as-is and read in `finish`, so a `null` entry still throws
 * the `TypeError` it always threw, and only if it is the value that survives.
 */
type ChildRecord =
  | { kind: "dir" }
  | { kind: "file"; size: unknown }
  | { kind: "file-unread"; value: unknown };

function fileRecord(value: unknown): ChildRecord {
  if (value !== null && typeof value === "object") {
    return { kind: "file", size: (value as { size?: unknown }).size };
  }
  return { kind: "file-unread", value };
}

function toDirectoryEntry(name: string, record: ChildRecord): DirectoryEntry {
  if (record.kind === "dir") return { kind: "dir", name };
  // Property order matches resolveFile's literal: kind, name, size. It is the
  // order the JSON listing serializes in.
  const size = record.kind === "file" ? record.size : (record.value as ManifestFile).size;
  return { kind: "file", name, size: size as number };
}

/**
 * `resolveFile(manifest, rawPath)` without the manifest: the file at the
 * path, or the directory's immediate children, or `not_found`.
 */
export class ResolvePathQuery implements ManifestQuery<ResolvedFile> {
  private readonly normalized: string | null;
  private readonly prefix: string;
  private exactFound = false;
  private exactValue: unknown = undefined;
  /** Children in first-insertion order, array-index names excluded. */
  private children = new Map<string, ChildRecord>();
  /** Root-level files whose names are array indices; enumerated first. */
  private indexFiles = new Map<string, ChildRecord>();

  constructor(rawPath: string) {
    this.normalized = normalizeBidsPath(rawPath);
    this.prefix = this.normalized === null || this.normalized === "" ? "" : `${this.normalized}/`;
  }

  reset(): void {
    this.exactFound = false;
    this.exactValue = undefined;
    this.children = new Map();
    this.indexFiles = new Map();
  }

  key(path: string): boolean {
    const normalized = this.normalized;
    // An invalid path still scans the whole manifest: the route must say
    // "Version not published" for a broken manifest before it says "not found".
    if (normalized === null) return false;
    if (normalized !== "" && path === normalized) return true;
    if (!path.startsWith(this.prefix)) return false;
    const rest = path.slice(this.prefix.length);
    if (rest === "") return false;
    const slash = rest.indexOf("/");
    if (slash === -1) return true;
    const name = rest.slice(0, slash);
    if (!this.children.has(name)) this.children.set(name, { kind: "dir" });
    return false;
  }

  value(path: string, value: unknown): void {
    if (this.normalized !== "" && path === this.normalized) {
      this.exactFound = true;
      this.exactValue = value;
      return;
    }
    const rest = path.slice(this.prefix.length);
    // Only a root-level name can be an array index: every deeper path has a
    // slash, which no array index does.
    if (this.prefix === "" && isArrayIndexKey(rest)) {
      this.indexFiles.set(rest, fileRecord(value));
    } else {
      this.children.set(rest, fileRecord(value));
    }
  }

  finish(): ResolvedFile {
    const normalized = this.normalized;
    if (normalized === null) return { kind: "not_found" };
    if (this.exactFound) {
      return { kind: "file", path: normalized, file: this.exactValue as ManifestFile };
    }

    // Rebuild the insertion order `Object.entries` would have walked. An
    // array-index file is the whole of its root-level name, so a directory of
    // the same name (from "42/x") loses to it, exactly as the file's earlier
    // enumeration made `seen.has(name)` skip the directory in resolveFile.
    const seen = new Map<string, DirectoryEntry>();
    const indexNames = [...this.indexFiles.keys()].sort((a, b) => Number(a) - Number(b));
    for (const name of indexNames) {
      seen.set(name, toDirectoryEntry(name, this.indexFiles.get(name) as ChildRecord));
    }
    for (const [name, record] of this.children) {
      if (this.indexFiles.has(name)) continue;
      seen.set(name, toDirectoryEntry(name, record));
    }

    // Empty root of an empty manifest -> directory with no children, not 404.
    if (seen.size === 0 && normalized !== "") return { kind: "not_found" };

    const children = [...seen.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { kind: "directory", path: normalized, children };
  }
}

/** `Object.hasOwn(manifest.files, path)`: the tombstone walk's question. */
export class ContainsPathQuery implements ManifestQuery<boolean> {
  private found = false;

  constructor(private readonly path: string) {}

  reset(): void {
    this.found = false;
  }

  key(path: string): boolean {
    if (path === this.path) this.found = true;
    return false;
  }

  value(): void {}

  finish(): boolean {
    return this.found;
  }
}

export interface DigestAnswer {
  /**
   * `bytes` and `files` are null when the stream could not prove them (see
   * `unproven`); `sessions` and `subjects` are always exact.
   */
  digest: ManifestDigest;
  /** Why the totals are null, or null when they are exact. */
  unproven: string | null;
  /**
   * Entries whose `size` is not a non-negative safe integer. They are counted
   * in `files` and left out of `bytes`.
   */
  excludedSizes: number;
}

/**
 * `digestManifest(manifest)` without the manifest, for `metadata.json`, in
 * memory that grows with the BIDS index (subjects, sessions, tasks), never
 * with the number of files. There is no fallback that reads the manifest
 * whole: every document is answered in one streaming pass.
 *
 * The sessions and the BIDS index are sets of strings built from paths, so
 * they are exact in any order and immune to a repeated key. The totals are
 * where a stream and `Object.values` can disagree, and each way is handled
 * without holding the entries:
 *
 *  - A REPEATED KEY is one entry to `Object.values`, with its last value. A
 *    stream can only rule repeats out while every key is strictly greater than
 *    the one before it (UTF-16 code-unit order), which is how the pipeline
 *    writes manifests (git tree order is byte order, and every BIDS path is
 *    ASCII; `manifest-queries.test.ts` checks the real nm000132 manifest).
 *    Deduplicating out-of-order keys exactly would mean keeping every key, the
 *    memory #1502 removed, so once the order breaks the totals are reported as
 *    unproven (null) and the route takes them from the catalog row, as it does
 *    when a manifest cannot be read at all. Nothing is guessed.
 *  - A SIZE THAT IS NOT A NON-NEGATIVE SAFE INTEGER has no meaningful sum:
 *    `Object.values` would have concatenated a string or produced NaN. Such
 *    an entry is counted as a file, left out of `bytes`, and reported in
 *    `excludedSizes` so the route can log it.
 *  - A TOTAL PAST 2^53 cannot be added exactly, so it is unproven as well.
 *
 * With integer sizes and ascending keys, floating-point addition is exact and
 * therefore order-free, so the result equals `digestManifest`'s.
 */
export class DigestQuery implements ManifestQuery<DigestAnswer> {
  private previous: string | null = null;
  private unproven: string | null = null;
  private bytes = 0;
  private files = 0;
  private excludedSizes = 0;
  private bids = new BidsIndexBuilder();
  private sessions = new SessionsCollector();

  reset(): void {
    this.previous = null;
    this.unproven = null;
    this.bytes = 0;
    this.files = 0;
    this.excludedSizes = 0;
    this.bids = new BidsIndexBuilder();
    this.sessions = new SessionsCollector();
  }

  key(path: string): boolean {
    this.bids.add(path);
    this.sessions.add(path);
    if (this.unproven !== null) return false;
    if (this.previous !== null && !(this.previous < path)) {
      this.unproven =
        "entry keys are not in strictly ascending order, so a repeated key cannot be ruled out";
      return false;
    }
    this.previous = path;
    this.files++;
    return true;
  }

  value(_path: string, value: unknown): void {
    if (this.unproven !== null) return;
    const size =
      value !== null && typeof value === "object" ? (value as { size?: unknown }).size : undefined;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      this.excludedSizes++;
      return;
    }
    if (this.bytes + size > Number.MAX_SAFE_INTEGER) {
      this.unproven = "the sizes add up past 2^53, which cannot be summed exactly";
      return;
    }
    this.bytes += size;
  }

  finish(header: ManifestHeader): DigestAnswer {
    const exact = this.unproven === null;
    return {
      digest: {
        version: header.version,
        bytes: exact ? this.bytes : null,
        files: exact ? this.files : null,
        sessions: this.sessions.build(),
        subjects: this.bids.build(),
      },
      unproven: this.unproven,
      excludedSizes: exact ? this.excludedSizes : 0,
    };
  }
}

export type EntryCountAnswer =
  | { kind: "count"; count: number }
  /** Keys did not ascend, so a repeat cannot be ruled out without keeping them. */
  | { kind: "unordered" };

/**
 * How many entries `manifest.files` has, keeping none of them. Exact only
 * while every key is strictly greater than the one before, which rules out a
 * repeated key (a repeat is one entry to `Object.entries`); otherwise it says
 * so and counts nothing. `manifest.json` asks this first, so that refusing a
 * 100,000-entry manifest costs no more than any other lookup instead of
 * materializing {@link EntriesQuery}'s limit's worth of entries only to drop
 * them.
 */
export class EntryCountQuery implements ManifestQuery<EntryCountAnswer> {
  private previous: string | null = null;
  private count = 0;
  private unordered = false;

  reset(): void {
    this.previous = null;
    this.count = 0;
    this.unordered = false;
  }

  key(path: string): boolean {
    if (this.unordered) return false;
    if (this.previous !== null && !(this.previous < path)) {
      this.unordered = true;
      return false;
    }
    this.previous = path;
    this.count++;
    return false;
  }

  value(): void {}

  finish(): EntryCountAnswer {
    return this.unordered ? { kind: "unordered" } : { kind: "count", count: this.count };
  }
}

export type EntriesAnswer =
  | { kind: "entries"; files: Record<string, ManifestFile> }
  | { kind: "over_limit"; limit: number };

/**
 * `manifest.files`, materialized the way `JSON.parse` would have built it,
 * but only while it has at most `limit` distinct entries. Past that the
 * partial object is dropped at once and the rest of the document is only
 * tokenized, so a refusal costs no more memory than the limit.
 */
export class EntriesQuery implements ManifestQuery<EntriesAnswer> {
  private files: Record<string, unknown> | null = {};
  private count = 0;

  constructor(private readonly limit: number) {}

  reset(): void {
    this.files = {};
    this.count = 0;
  }

  key(path: string): boolean {
    const files = this.files;
    if (files === null) return false;
    if (!Object.hasOwn(files, path) && this.count >= this.limit) {
      this.files = null;
      return false;
    }
    return true;
  }

  value(path: string, value: unknown): void {
    const files = this.files;
    if (files === null) return;
    if (!Object.hasOwn(files, path)) this.count++;
    defineJsonMember(files, path, value);
  }

  finish(): EntriesAnswer {
    if (this.files === null) return { kind: "over_limit", limit: this.limit };
    return { kind: "entries", files: this.files as Record<string, ManifestFile> };
  }
}
