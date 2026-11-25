/**
 * Bounded random-access reads for the HDF5 metadata walker (`shared/hdf5-meta.ts`).
 *
 * Every byte the walker looks at comes through {@link BoundedSource}: it refuses a read that
 * leaves the file, counts reads and bytes against the walker's limits before it asks the source,
 * and serves a read that falls inside an earlier one from memory. {@link Cursor} decodes the
 * little-endian fields of one structure and refuses to step past the end of its buffer, so a
 * corrupt length can never index outside what was read.
 */

/** Random access to one file. The same shape as A1's `RangeSource` in `shared/identifier-readers.ts`. */
export interface RangeSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/**
 * Why a walk is incomplete. A closed set: the vocabulary table that describes each reason to a
 * reader is keyed by these strings.
 */
export type Hdf5Incomplete =
  | "limit-bytes"
  | "limit-reads"
  | "limit-objects"
  | "limit-depth"
  | "unsupported-version"
  | "unsupported-filter"
  | "unsupported-datatype"
  | "external-link"
  | "corrupt"
  | "read-failed";

/** Reasons that end the whole walk; every other reason skips one structure and the walk goes on. */
const FATAL: ReadonlySet<Hdf5Incomplete> = new Set([
  "limit-bytes",
  "limit-reads",
  "limit-objects",
  "read-failed",
]);

/**
 * A structure the walker could not read. The message is the reason code only: no value read from
 * the file ever goes into it.
 */
export class Hdf5Problem extends Error {
  readonly reason: Hdf5Incomplete;
  readonly fatal: boolean;
  constructor(reason: Hdf5Incomplete, options?: { cause?: unknown }) {
    super(`hdf5: ${reason}`, options);
    this.name = "Hdf5Problem";
    this.reason = reason;
    this.fatal = FATAL.has(reason);
  }
}

export interface Hdf5Limits {
  /** Bytes requested from the source, in total. */
  maxBytes: number;
  /**
   * Logical reads: calls to the source's `read`, before any page cache below it coalesces
   * them. The fetch cap that bounds the network is the source's (A1's page-cached source and the
   * reader registry's limits); this one bounds the walker's own work.
   */
  maxReads: number;
  /** Entries (groups, datasets and attributes) the walk returns. */
  maxObjects: number;
  /** Group nesting below the root. */
  maxDepth: number;
}

export const HDF5_LIMITS: Readonly<Hdf5Limits> = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxReads: 20_000,
  maxObjects: 20_000,
  maxDepth: 32,
});

export interface ReadTally {
  reads: number;
  bytes: number;
}

export class BoundedSource {
  readonly size: number;
  readonly tally: ReadTally = { reads: 0, bytes: 0 };
  private readonly src: RangeSource;
  private readonly limits: Hdf5Limits;
  // Earlier reads, kept so that a structure inside one (a heap name, a message re-read) costs
  // nothing. Their total is bounded by maxBytes, since every cached byte was counted.
  private readonly cache: { offset: number; data: Uint8Array }[] = [];

  constructor(src: RangeSource, limits: Hdf5Limits) {
    this.src = src;
    this.size = src.size;
    this.limits = limits;
  }

  /** Exactly `length` bytes at absolute offset `offset`, or a {@link Hdf5Problem}. */
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0
    ) {
      throw new Hdf5Problem("corrupt");
    }
    if (offset + length > this.size) throw new Hdf5Problem("corrupt");
    if (length === 0) return new Uint8Array(0);
    for (const c of this.cache) {
      if (offset >= c.offset && offset + length <= c.offset + c.data.length) {
        return c.data.subarray(offset - c.offset, offset - c.offset + length);
      }
    }
    if (this.tally.reads + 1 > this.limits.maxReads) throw new Hdf5Problem("limit-reads");
    if (this.tally.bytes + length > this.limits.maxBytes) throw new Hdf5Problem("limit-bytes");
    this.tally.reads += 1;
    this.tally.bytes += length;
    let data: Uint8Array;
    try {
      data = await this.src.read(offset, length);
    } catch (cause) {
      throw new Hdf5Problem("read-failed", { cause });
    }
    if (data.length !== length) throw new Hdf5Problem("corrupt");
    this.cache.push({ offset, data });
    return data;
  }
}

/** The two field widths every HDF5 structure is written in, from the superblock. */
export interface Widths {
  /** Size of offsets (addresses), in bytes. */
  O: number;
  /** Size of lengths, in bytes. */
  L: number;
}

/** Little-endian field reader over one structure's bytes. Every step is bounds-checked. */
export class Cursor {
  pos = 0;
  readonly buf: Uint8Array;
  readonly w: Widths;

  constructor(buf: Uint8Array, w: Widths, pos = 0) {
    this.buf = buf;
    this.w = w;
    this.pos = pos;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  need(n: number): void {
    if (n < 0 || this.pos + n > this.buf.length) throw new Hdf5Problem("corrupt");
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++] as number;
  }

  u16(): number {
    return this.uint(2);
  }

  u32(): number {
    return this.uint(4);
  }

  /** An unsigned little-endian integer of `n` bytes (0 to 8); above 2^53 is corrupt. */
  uint(n: number): number {
    this.need(n);
    let v = 0;
    let scale = 1;
    for (let i = 0; i < n; i++) {
      v += (this.buf[this.pos + i] as number) * scale;
      scale *= 256;
    }
    this.pos += n;
    if (!Number.isSafeInteger(v)) throw new Hdf5Problem("corrupt");
    return v;
  }

  /** An address field; `null` for the undefined address (all bits set). */
  addr(): number | null {
    this.need(this.w.O);
    let undef = true;
    for (let i = 0; i < this.w.O; i++) {
      if (this.buf[this.pos + i] !== 0xff) {
        undef = false;
        break;
      }
    }
    if (undef) {
      this.pos += this.w.O;
      return null;
    }
    return this.uint(this.w.O);
  }

  len(): number {
    return this.uint(this.w.L);
  }

  signature(sig: string): void {
    const b = this.bytes(sig.length);
    for (let i = 0; i < sig.length; i++) {
      if (b[i] !== sig.charCodeAt(i)) throw new Hdf5Problem("corrupt");
    }
  }
}

/** Bytes needed to encode `n` (at least 1): libhdf5's `H5VM_limit_enc_size`. */
export function encSize(n: number): number {
  return Math.floor(log2floor(n) / 8) + 1;
}

/** floor(log2(n)) for a positive integer, exact (no floating point). */
export function log2floor(n: number): number {
  let r = 0;
  let v = n;
  while (v >= 2) {
    v = Math.floor(v / 2);
    r += 1;
  }
  return r;
}

/** log2 of a power of two; anything else is corrupt. */
export function log2exact(n: number): number {
  const r = log2floor(n);
  if (n < 1 || 2 ** r !== n) throw new Hdf5Problem("corrupt");
  return r;
}
