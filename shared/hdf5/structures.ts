/**
 * The file-level structures of HDF5 (specification version 3.0, sections II and III): the
 * superblock, object headers, local and global heaps, version 1 and 2 B-trees and fractal heaps.
 * Every structure is read through {@link BoundedSource} with exact lengths, every node address is
 * visited at most once per index, and every count is checked against the bytes that hold it.
 */

import { type BoundedSource, Cursor, Hdf5Problem, type Widths, encSize, log2exact } from "./io";
import { MSG } from "./messages";

const SIGNATURE = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
/** Object-header continuation chunks per object. */
const CHUNKS_MAX = 256;
/** B-tree depth, versions 1 and 2. */
const TREE_DEPTH_MAX = 32;
/** Global heap collections cached per walk. */
const GLOBAL_HEAPS_MAX = 256;

export interface Superblock extends Widths {
  version: number;
  /** Absolute offset that every address in the file is relative to. */
  base: number;
  /** End-of-file address as stored; libhdf5 compares it with the whole file's size. */
  eof: number;
  /** Absolute address of the root group's object header. */
  root: number;
  /**
   * B-tree "K" values: a symbol-table node holds 2 x `leafK` entries, a group B-tree node
   * 2 x `internalK` children and a chunk B-tree node 2 x `storeK`. Known from a version 0 or 1
   * superblock; `null` when they could be in a superblock extension (versions 2 and 3).
   */
  leafK: number | null;
  internalK: number | null;
  storeK: number | null;
}

export interface Message {
  type: number;
  flags: number;
  data: Uint8Array;
}

export class Hdf5File {
  readonly src: BoundedSource;
  readonly sb: Superblock;
  private readonly heaps = new Map<number, Map<number, Uint8Array>>();
  private readonly fractal = new Map<number, FractalHeap>();
  /**
   * Object-header addresses a group listed and the walk has yet to read. A version 1 header's
   * read is extended by the 16-byte prefix of the next header when that header starts exactly
   * where this one ends, so packed headers (MATLAB writes thousands) cost one read each, and no
   * byte outside a known header is ever read for it.
   */
  readonly announced = new Set<number>();

  constructor(src: BoundedSource, sb: Superblock) {
    this.src = src;
    this.sb = sb;
  }

  get w(): Widths {
    return this.sb;
  }

  /** Absolute file offset of a file address; `null` stays `null`. */
  abs(addr: number): number {
    const a = this.sb.base + addr;
    if (!Number.isSafeInteger(a)) throw new Hdf5Problem("corrupt");
    return a;
  }

  async cursor(absOffset: number, length: number): Promise<Cursor> {
    return new Cursor(await this.src.read(absOffset, length), this.w);
  }

  // --- Object headers ---

  private readonly prefetched = new Map<number, Message[] | Hdf5Problem>();

  /**
   * Read the headers at these absolute offsets, in this order, and keep them for
   * {@link takeHeader}. A header that does not decode is kept as its problem, raised when it is
   * taken. A limit ends the prefetch and is returned, so the caller can still list the headers
   * read before it.
   */
  async prefetchHeaders(addresses: number[]): Promise<Hdf5Problem | null> {
    for (const at of addresses) {
      if (this.prefetched.has(at)) continue;
      try {
        this.prefetched.set(at, await this.objectHeader(at));
      } catch (e) {
        if (!(e instanceof Hdf5Problem)) throw e;
        if (e.fatal) return e;
        this.prefetched.set(at, e);
      }
    }
    return null;
  }

  isPrefetched(at: number): boolean {
    return this.prefetched.has(at);
  }

  /** A prefetched header, read now if it was not prefetched. */
  async takeHeader(at: number): Promise<Message[]> {
    const got = this.prefetched.get(at);
    if (got === undefined) return this.objectHeader(at);
    this.prefetched.delete(at);
    if (got instanceof Hdf5Problem) throw got;
    return got;
  }

  /** Every message of the object header at absolute offset `at`, continuation chunks included. */
  async objectHeader(at: number): Promise<Message[]> {
    // A version 2 prefix is at most 34 bytes and a version 1 prefix is 16; read the shorter first
    // when the file is that small, and never read past the end.
    const first = await this.src.read(at, Math.min(16, this.src.size - at));
    if (first[0] === 0x4f && first[1] === 0x48 && first[2] === 0x44 && first[3] === 0x52) {
      return this.headerV2(at);
    }
    if (first[0] !== 1) throw new Hdf5Problem("unsupported-version");
    const c = new Cursor(first, this.w);
    c.skip(8);
    const size = c.u32();
    const messages: Message[] = [];
    const chunks: { at: number; length: number }[] = [{ at: at + 16, length: size }];
    const seen = new Set<number>([at]);
    for (let i = 0; i < chunks.length; i++) {
      if (i >= CHUNKS_MAX) throw new Hdf5Problem("corrupt");
      const chunk = chunks[i] as { at: number; length: number };
      const end = chunk.at + chunk.length;
      const extra = this.announced.has(end) && end + 16 <= this.src.size ? 16 : 0;
      const read = await this.src.read(chunk.at, chunk.length + extra);
      const body = new Cursor(read.subarray(0, chunk.length), this.w);
      while (body.remaining >= 8) {
        const type = body.u16();
        const length = body.u16();
        const flags = body.u8();
        body.skip(3);
        const data = body.bytes(length);
        this.collect(messages, chunks, seen, { type, flags, data });
      }
    }
    return messages;
  }

  private async headerV2(at: number): Promise<Message[]> {
    const prefix = new Cursor(await this.src.read(at, Math.min(34, this.src.size - at)), this.w);
    prefix.signature("OHDR");
    if (prefix.u8() !== 2) throw new Hdf5Problem("unsupported-version");
    const flags = prefix.u8();
    if (flags & 0x20) prefix.skip(16);
    if (flags & 0x10) prefix.skip(4);
    const size = prefix.uint(1 << (flags & 0x03));
    const ordered = (flags & 0x04) !== 0;
    const messages: Message[] = [];
    const chunks: { at: number; length: number }[] = [{ at: at + prefix.pos, length: size }];
    const seen = new Set<number>([at]);
    for (let i = 0; i < chunks.length; i++) {
      if (i >= CHUNKS_MAX) throw new Hdf5Problem("corrupt");
      const chunk = chunks[i] as { at: number; length: number };
      let body: Cursor;
      if (i === 0) {
        body = new Cursor(await this.src.read(chunk.at, chunk.length), this.w);
      } else {
        // A continuation chunk is "OCHK", its messages, and a 4-byte checksum.
        const all = new Cursor(await this.src.read(chunk.at, chunk.length), this.w);
        all.signature("OCHK");
        if (chunk.length < 8) throw new Hdf5Problem("corrupt");
        body = new Cursor(all.buf.subarray(4, chunk.length - 4), this.w);
      }
      const headerSize = ordered ? 6 : 4;
      while (body.remaining >= headerSize) {
        const type = body.u8();
        const length = body.u16();
        const mflags = body.u8();
        if (ordered) body.skip(2);
        const data = body.bytes(length);
        this.collect(messages, chunks, seen, { type, flags: mflags, data });
      }
    }
    return messages;
  }

  private collect(
    messages: Message[],
    chunks: { at: number; length: number }[],
    seen: Set<number>,
    m: Message,
  ): void {
    if (m.type === MSG.CONTINUATION) {
      const c = new Cursor(m.data, this.w);
      const addr = c.addr();
      const length = c.len();
      if (addr === null) throw new Hdf5Problem("corrupt");
      const at = this.abs(addr);
      if (seen.has(at)) throw new Hdf5Problem("corrupt");
      seen.add(at);
      chunks.push({ at, length });
      return;
    }
    if (m.type !== MSG.NIL) messages.push(m);
  }

  // --- Local heap and version 1 B-trees ---

  /** The data segment of the local heap at absolute offset `at`. */
  async localHeap(at: number): Promise<Uint8Array> {
    const { O, L } = this.w;
    const c = await this.cursor(at, 8 + 2 * L + O);
    c.signature("HEAP");
    if (c.u8() !== 0) throw new Hdf5Problem("unsupported-version");
    c.skip(3);
    const size = c.len();
    c.len(); // free list
    const data = c.addr();
    if (data === null) throw new Hdf5Problem("corrupt");
    return this.src.read(this.abs(data), size);
  }

  /**
   * Every leaf child of the version 1 B-tree at absolute offset `at`, with its key before it:
   * for a group tree (type 0) the children are symbol-table nodes; for a chunk tree (type 1),
   * chunks, keyed by size, filter mask and offsets (`rank` + 1 of them).
   */
  async btreeV1(
    at: number,
    type: 0 | 1,
    rank: number,
  ): Promise<{ key: Uint8Array; child: number }[]> {
    const { O, L } = this.w;
    const keySize = type === 0 ? L : 8 + 8 * (rank + 1);
    const k = type === 0 ? this.sb.internalK : this.sb.storeK;
    const out: { key: Uint8Array; child: number }[] = [];
    const seen = new Set<number>();
    const visit = async (
      node: number,
      depth: number,
      expectLevel: number | null,
    ): Promise<void> => {
      if (depth > TREE_DEPTH_MAX || seen.has(node)) throw new Hdf5Problem("corrupt");
      seen.add(node);
      // A node is allocated at its full size (2K children), so when K is known the whole node
      // is one read; otherwise the header says how many entries to read.
      if (k !== null)
        await this.src.read(
          node,
          Math.min(8 + 2 * O + 2 * k * O + (2 * k + 1) * keySize, this.src.size - node),
        );
      const head = await this.cursor(node, 8 + 2 * O);
      head.signature("TREE");
      if (head.u8() !== type) throw new Hdf5Problem("corrupt");
      const level = head.u8();
      const entries = head.u16();
      if (expectLevel !== null && level !== expectLevel) throw new Hdf5Problem("corrupt");
      if (k !== null && entries > 2 * k) throw new Hdf5Problem("corrupt");
      const body = await this.cursor(node + 8 + 2 * O, entries * (keySize + O) + keySize);
      for (let i = 0; i < entries; i++) {
        const key = body.bytes(keySize);
        const child = body.addr();
        if (child === null) throw new Hdf5Problem("corrupt");
        if (level === 0) out.push({ key, child: this.abs(child) });
        else await visit(this.abs(child), depth + 1, level - 1);
      }
    };
    await visit(at, 0, null);
    return out;
  }

  /** The (name offset, object address) entries of the symbol-table node at absolute `at`. */
  async symbolNode(at: number): Promise<{ nameOffset: number; address: number }[]> {
    const { O } = this.w;
    const entry = 2 * O + 24;
    const k = this.sb.leafK;
    // Allocated at its full size (2K entries): one read when K is known.
    if (k !== null) await this.src.read(at, Math.min(8 + 2 * k * entry, this.src.size - at));
    const head = await this.cursor(at, 8);
    head.signature("SNOD");
    if (head.u8() !== 1) throw new Hdf5Problem("unsupported-version");
    head.skip(1);
    const count = head.u16();
    if (k !== null && count > 2 * k) throw new Hdf5Problem("corrupt");
    const body = await this.cursor(at + 8, count * entry);
    const out: { nameOffset: number; address: number }[] = [];
    for (let i = 0; i < count; i++) {
      const nameOffset = body.uint(O);
      const address = body.addr();
      body.skip(24);
      if (address === null) throw new Hdf5Problem("corrupt");
      out.push({ nameOffset, address: this.abs(address) });
    }
    return out;
  }

  // --- Global heap ---

  /** Object `index` of the global heap collection at file address `addr`. */
  async globalObject(addr: number, index: number): Promise<Uint8Array> {
    const at = this.abs(addr);
    let objects = this.heaps.get(at);
    if (!objects) {
      if (this.heaps.size >= GLOBAL_HEAPS_MAX) throw new Hdf5Problem("corrupt");
      const { L } = this.w;
      const head = await this.cursor(at, 8 + L);
      head.signature("GCOL");
      if (head.u8() !== 1) throw new Hdf5Problem("unsupported-version");
      head.skip(3);
      const size = head.len();
      const c = await this.cursor(at, size);
      c.skip(8 + L);
      objects = new Map();
      while (c.remaining >= 8 + L) {
        const id = c.u16();
        c.skip(6);
        const length = c.len();
        if (id === 0) break;
        const data = c.bytes(length);
        c.skip(Math.min(c.remaining, (8 - (length % 8)) % 8));
        objects.set(id, data);
      }
      this.heaps.set(at, objects);
    }
    const data = objects.get(index);
    if (!data) throw new Hdf5Problem("corrupt");
    return data;
  }

  // --- Fractal heap and version 2 B-tree (dense links and attributes) ---

  async fractalHeap(addr: number): Promise<FractalHeap> {
    const at = this.abs(addr);
    let heap = this.fractal.get(at);
    if (!heap) {
      heap = await FractalHeap.open(this, at);
      this.fractal.set(at, heap);
    }
    return heap;
  }

  /** Every record of the version 2 B-tree at file address `addr`, in key order. */
  async btreeV2(addr: number, limit: number): Promise<Uint8Array[]> {
    const { O, L } = this.w;
    const at = this.abs(addr);
    const h = await this.cursor(at, 4 + 1 + 1 + 4 + 2 + 2 + 1 + 1 + O + 2 + L + 4);
    h.signature("BTHD");
    if (h.u8() !== 0) throw new Hdf5Problem("unsupported-version");
    h.u8(); // record type
    const nodeSize = h.u32();
    const recordSize = h.u16();
    const depth = h.u16();
    h.skip(2);
    const root = h.addr();
    const rootRecords = h.u16();
    const total = h.len();
    if (root === null || total === 0) return [];
    if (recordSize < 1 || depth > TREE_DEPTH_MAX || nodeSize < 10 + recordSize)
      throw new Hdf5Problem("corrupt");
    if (total > limit) throw new Hdf5Problem("limit-objects");

    // Node geometry, as libhdf5's H5B2__hdr_init derives it.
    const maxRec: number[] = [Math.floor((nodeSize - 10) / recordSize)];
    const cumMax: number[] = [maxRec[0] as number];
    const cumSize: number[] = [0];
    const nrecSize = encSize(maxRec[0] as number);
    const ptrSize = (d: number) => O + nrecSize + (d > 1 ? (cumSize[d - 1] as number) : 0);
    for (let d = 1; d <= depth; d++) {
      const m = Math.floor((nodeSize - 10 - ptrSize(d)) / (recordSize + ptrSize(d)));
      if (m < 1) throw new Hdf5Problem("corrupt");
      maxRec.push(m);
      const cum = (m + 1) * (cumMax[d - 1] as number) + m;
      if (!Number.isSafeInteger(cum)) throw new Hdf5Problem("corrupt");
      cumMax.push(cum);
      cumSize.push(encSize(cum));
    }

    const out: Uint8Array[] = [];
    const seen = new Set<number>();
    const visit = async (node: number, records: number, d: number): Promise<void> => {
      if (seen.has(node) || records > (maxRec[d] as number)) throw new Hdf5Problem("corrupt");
      seen.add(node);
      const pointers = d > 0 ? (records + 1) * ptrSize(d) : 0;
      const c = await this.cursor(node, 6 + records * recordSize + pointers);
      c.signature(d > 0 ? "BTIN" : "BTLF");
      if (c.u8() !== 0) throw new Hdf5Problem("unsupported-version");
      c.u8();
      const recs: Uint8Array[] = [];
      for (let i = 0; i < records; i++) recs.push(c.bytes(recordSize));
      if (d === 0) {
        out.push(...recs);
      } else {
        for (let i = 0; i <= records; i++) {
          const child = c.addr();
          const n = c.uint(nrecSize);
          if (d > 1) c.skip(cumSize[d - 1] as number);
          if (child === null) throw new Hdf5Problem("corrupt");
          await visit(this.abs(child), n, d - 1);
          if (i < records) out.push(recs[i] as Uint8Array);
        }
      }
      if (out.length > total) throw new Hdf5Problem("corrupt");
    };
    await visit(this.abs(root), rootRecords, depth);
    return out;
  }
}

/** A fractal heap whose managed and tiny objects can be read by heap ID. */
export class FractalHeap {
  private readonly file: Hdf5File;
  readonly idLength: number;
  private readonly width: number;
  private readonly start: number;
  private readonly maxDirect: number;
  private readonly offBytes: number;
  private readonly lenBytes: number;
  private readonly root: number | null;
  private readonly rootRows: number;
  private readonly maxDirectRows: number;
  private readonly firstRowBits: number;
  private readonly indirect = new Map<number, (number | null)[]>();

  private constructor(file: Hdf5File, fields: FractalHeapFields) {
    this.file = file;
    this.idLength = fields.idLength;
    this.width = fields.width;
    this.start = fields.start;
    this.maxDirect = fields.maxDirect;
    this.offBytes = fields.offBytes;
    this.lenBytes = fields.lenBytes;
    this.root = fields.root;
    this.rootRows = fields.rootRows;
    this.maxDirectRows = log2exact(fields.maxDirect) - log2exact(fields.start) + 2;
    this.firstRowBits = log2exact(fields.start) + log2exact(fields.width);
  }

  static async open(file: Hdf5File, at: number): Promise<FractalHeap> {
    const { O, L } = file.w;
    // The fixed fields up to the root block row count; filter information and checksum follow.
    const c = await file.cursor(at, 22 + 12 * L + 3 * O);
    c.signature("FRHP");
    if (c.u8() !== 0) throw new Hdf5Problem("unsupported-version");
    const idLength = c.u16();
    const filterLength = c.u16();
    c.u8(); // flags
    const maxManaged = c.u32();
    c.len(); // next huge object ID
    c.addr(); // huge objects B-tree
    c.len(); // free space in managed blocks
    c.addr(); // free-space manager
    c.len(); // managed space
    c.len(); // allocated managed space
    c.len(); // direct block allocation iterator offset
    c.len(); // managed objects
    c.len(); // huge objects size
    c.len(); // huge objects count
    c.len(); // tiny objects size
    c.len(); // tiny objects count
    const width = c.u16();
    const start = c.len();
    const maxDirect = c.len();
    const maxHeapBits = c.u16();
    c.u16(); // starting rows of the root indirect block
    const root = c.addr();
    const rootRows = c.u16();
    if (filterLength > 0) throw new Hdf5Problem("unsupported-filter");
    if (idLength < 1 || width < 1 || maxHeapBits < 1 || maxHeapBits > 64 || maxManaged < 1) {
      throw new Hdf5Problem("corrupt");
    }
    const offBytes = Math.ceil(maxHeapBits / 8);
    const lenBytes = Math.min(Math.ceil(log2exact(maxDirect) / 8), encSize(maxManaged));
    return new FractalHeap(file, {
      idLength,
      width,
      start,
      maxDirect,
      offBytes,
      lenBytes,
      root: root === null ? null : file.abs(root),
      rootRows,
    });
  }

  /** The bytes of the object a heap ID names. */
  async object(id: Uint8Array): Promise<Uint8Array> {
    const c = new Cursor(id, this.file.w);
    const head = c.u8();
    if (head >> 6 !== 0) throw new Hdf5Problem("unsupported-version");
    const kind = (head >> 4) & 0x03;
    if (kind === 2) {
      // Tiny: the object is in the ID itself.
      if (this.idLength <= 18) return c.bytes((head & 0x0f) + 1);
      const length = (((head & 0x0f) << 8) | c.u8()) + 1;
      return c.bytes(length);
    }
    if (kind !== 0) throw new Hdf5Problem("unsupported-version");
    const offset = c.uint(this.offBytes);
    const length = c.uint(this.lenBytes);
    if (this.root === null) throw new Hdf5Problem("corrupt");
    const block =
      this.rootRows === 0
        ? { at: this.root, start: 0, size: this.start }
        : await this.locate(offset);
    const within = offset - block.start;
    if (within < 0 || within + length > block.size) throw new Hdf5Problem("corrupt");
    return this.file.src.read(block.at + within, length);
  }

  private rowSize(row: number): number {
    return row < 2 ? this.start : this.start * 2 ** (row - 1);
  }

  /** The direct block that holds heap offset `offset`. */
  private async locate(offset: number): Promise<{ at: number; start: number; size: number }> {
    let at = this.root as number;
    let rows = this.rootRows;
    let base = 0;
    for (let depth = 0; depth <= 64; depth++) {
      const entries = await this.indirectBlock(at, rows);
      let rowStart = base;
      for (let row = 0; row < rows; row++) {
        const size = this.rowSize(row);
        const span = size * this.width;
        if (offset < rowStart + span) {
          const col = Math.floor((offset - rowStart) / size);
          const child = entries[row * this.width + col];
          const childStart = rowStart + col * size;
          if (child === null || child === undefined) throw new Hdf5Problem("corrupt");
          if (row < this.maxDirectRows) return { at: child, start: childStart, size };
          at = child;
          rows = log2exact(size) - this.firstRowBits + 1;
          base = childStart;
          break;
        }
        rowStart += span;
        if (row === rows - 1) throw new Hdf5Problem("corrupt");
      }
    }
    throw new Hdf5Problem("corrupt");
  }

  /** The child addresses of an indirect block, direct rows first. */
  private async indirectBlock(at: number, rows: number): Promise<(number | null)[]> {
    const cached = this.indirect.get(at);
    if (cached) return cached;
    if (rows < 1 || rows > 64) throw new Hdf5Problem("corrupt");
    const { O } = this.file.w;
    const count = rows * this.width;
    const c = await this.file.cursor(at, 4 + 1 + O + this.offBytes + count * O);
    c.signature("FHIB");
    if (c.u8() !== 0) throw new Hdf5Problem("unsupported-version");
    c.skip(O + this.offBytes);
    const entries: (number | null)[] = [];
    for (let i = 0; i < count; i++) {
      const a = c.addr();
      entries.push(a === null ? null : this.file.abs(a));
    }
    this.indirect.set(at, entries);
    return entries;
  }
}

interface FractalHeapFields {
  idLength: number;
  width: number;
  start: number;
  maxDirect: number;
  offBytes: number;
  lenBytes: number;
  root: number | null;
  rootRows: number;
}

/** Find and decode the superblock: at 0, then 512, 1024, 2048 and so on (a user block). */
export async function readSuperblock(src: BoundedSource): Promise<Superblock> {
  let at = 0;
  for (;;) {
    if (at + 16 > src.size) throw new Hdf5Problem("corrupt");
    const probe = await src.read(at, 16);
    if (SIGNATURE.every((b, i) => probe[i] === b)) return decodeSuperblock(src, at, probe);
    at = at === 0 ? 512 : at * 2;
  }
}

async function decodeSuperblock(
  src: BoundedSource,
  at: number,
  probe: Uint8Array,
): Promise<Superblock> {
  const version = probe[8] as number;
  if (version <= 1) {
    const O = probe[13] as number;
    const L = probe[14] as number;
    checkWidths(O, L);
    const fixed = 24 + (version === 1 ? 4 : 0);
    const c = new Cursor(await src.read(at, fixed + 4 * O + 2 * O + 24), { O, L });
    c.skip(16);
    const leafK = c.u16();
    const internalK = c.u16();
    c.skip(4); // file consistency flags
    // Version 0 has no chunk-index K; libhdf5's default is 32.
    const storeK = version === 1 ? c.u16() : 32;
    c.skip(fixed - c.pos);
    if (leafK < 1 || internalK < 1 || storeK < 1) throw new Hdf5Problem("corrupt");
    c.addr(); // base address: libhdf5 uses the superblock's own position instead
    c.addr(); // free-space info
    const eof = c.addr();
    c.addr(); // driver info
    c.addr(); // root link name offset
    const root = c.addr();
    if (eof === null || root === null) throw new Hdf5Problem("corrupt");
    return { version, O, L, base: at, eof, root: at + root, leafK, internalK, storeK };
  }
  if (version === 2 || version === 3) {
    const O = probe[9] as number;
    const L = probe[10] as number;
    checkWidths(O, L);
    const c = new Cursor(await src.read(at, 12 + 4 * O + 4), { O, L });
    c.skip(12);
    c.addr(); // base address
    c.addr(); // superblock extension: holds nothing the walker needs
    const eof = c.addr();
    const root = c.addr();
    if (eof === null || root === null) throw new Hdf5Problem("corrupt");
    return {
      version,
      O,
      L,
      base: at,
      eof,
      root: at + root,
      leafK: null,
      internalK: null,
      storeK: null,
    };
  }
  throw new Hdf5Problem("unsupported-version");
}

function checkWidths(O: number, L: number): void {
  if (![2, 4, 8].includes(O) || ![2, 4, 8].includes(L)) throw new Hdf5Problem("corrupt");
}

/** Inflate a zlib stream, refusing output longer than `expected` bytes. */
export async function inflate(raw: Uint8Array, expected: number): Promise<Uint8Array> {
  const stream = new Blob([raw as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  const out = new Uint8Array(expected);
  let filled = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (filled + value.length > expected) {
        await reader.cancel();
        throw new Hdf5Problem("corrupt");
      }
      out.set(value, filled);
      filled += value.length;
    }
  } catch (e) {
    if (e instanceof Hdf5Problem) throw e;
    throw new Hdf5Problem("corrupt", { cause: e });
  }
  if (filled !== expected) throw new Hdf5Problem("corrupt");
  return out;
}

/** Undo the shuffle filter: bytes were grouped by position within each element. */
export function unshuffle(data: Uint8Array, elementSize: number): Uint8Array {
  if (elementSize <= 1) return data;
  const n = Math.floor(data.length / elementSize);
  const out = new Uint8Array(data.length);
  for (let b = 0; b < elementSize; b++) {
    for (let i = 0; i < n; i++) out[i * elementSize + b] = data[b * n + i] as number;
  }
  out.set(data.subarray(n * elementSize), n * elementSize);
  return out;
}
