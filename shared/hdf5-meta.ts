/**
 * A bounded, dependency-free HDF5 metadata walker (publication-queue plan, card A3; epic #2182).
 *
 * SNIRF and MATLAB v7.3 files (EEGLAB `.set`, `.mat`) are HDF5. The identifier screen runs next
 * to storage credentials, so this reader is pure TypeScript with no package dependency, and it
 * reads the file only through {@link RangeSource}'s random-access reads.
 *
 * What it returns: one {@link Hdf5Entry} per group, dataset and attribute, with the type and the
 * shape, and a value only when it is small:
 * - a string (fixed or variable length, an array of strings, or MATLAB's variable-length sequence
 *   of one-byte characters) whose stored bytes total at most 64 KiB and that has at most 4,096
 *   elements, as a `string` when the dataspace is scalar and as `string[]` otherwise;
 * - an integer, float or enum with at most 64 elements, as `number[]` (flattened, row-major);
 * - anything larger: `value: null, skipped: "size"`. A numeric dataset larger than that is never
 *   read at all, so recording signals are not fetched.
 * A small numeric stored in a chunk over 1 MiB is listed with `value: null, skipped: "size"`, and
 * the walk stays complete. A reference, compound or other type is listed with `value: null,
 * skipped: "type"`, which records `unsupported-datatype` for every such type except a reference.
 *
 * Untrusted input: every read is checked against the file's size and counted against
 * {@link HDF5_LIMITS} (bytes, reads, entries, depth); every object address is visited once, which
 * also ends cycles. A construct the walker does not support, or a structure that does not decode,
 * is skipped and recorded, the walk goes on, and `complete` is `false` with the first reason in
 * `incomplete`. A limit on bytes, reads or entries, or a failing source read, ends the walk early
 * with the entries found so far; so does any other error, recorded as `corrupt`: `walkHdf5` never
 * throws.
 *
 * External links and external storage are never followed: they are recorded as `external-link`.
 *
 * Reference: the HDF5 file format specification version 3.0. The h5py oracle that the tests
 * compare against is `scripts/dev/hdf5-oracle.py`.
 */

import {
  BoundedSource,
  Cursor,
  HDF5_LIMITS,
  type Hdf5Incomplete,
  type Hdf5Limits,
  Hdf5Problem,
  type RangeSource,
  type ReadTally,
} from "./hdf5/io";
import {
  type AttributeMessage,
  type Dtype,
  type Filter,
  type Layout,
  type LinkMessage,
  MSG,
  type Shape,
  cName,
  dtypeName,
  parseAttribute,
  parseAttributeInfo,
  parseDataspace,
  parseDatatype,
  parseFilters,
  parseLayout,
  parseLink,
  parseLinkInfo,
  parseSharedAddress,
  parseSymbolTable,
} from "./hdf5/messages";
import { Hdf5File, type Message, inflate, readSuperblock, unshuffle } from "./hdf5/structures";

export { HDF5_LIMITS, type Hdf5Incomplete, type Hdf5Limits, type RangeSource, type ReadTally };

export const STRING_BYTES_MAX = 64 * 1024;
export const STRING_ELEMENTS_MAX = 4096;
export const NUMERIC_ELEMENTS_MAX = 64;
/** A chunk larger than this, or chunks totaling more, are not inflated to read a small value. */
const CHUNK_BYTES_MAX = 1024 * 1024;
const CHUNKS_BYTES_TOTAL_MAX = 4 * 1024 * 1024;

/** A small value stored in chunks too large to inflate under the caps above: `skipped: "size"`. */
class ChunksTooLarge extends Error {}

export type Hdf5Skipped =
  /** The value is over the size rule. */
  | "size"
  /** The type is not one whose value the walker returns (reference, compound, ...). */
  | "type"
  /** The value could not be decoded; the reason is in the walk's `incomplete`. */
  | "error";

export interface Hdf5Storage {
  layout: "compact" | "contiguous" | "chunked" | "virtual";
  /** Absolute file offset of a contiguous dataset's data; `null` otherwise or when unallocated. */
  address: number | null;
  /** Bytes of a contiguous dataset's data; `null` for the other layouts. */
  size: number | null;
}

export interface Hdf5Entry {
  /** The object's path; for an attribute, the path of the object that carries it. */
  path: string;
  kind: "group" | "dataset" | "attribute";
  name: string;
  /**
   * The type as h5py's oracle spells it: `int8` to `uint64`, `float16` to `float64`, `string`,
   * `vlen:string`, `enum:<base>`, `<base>[<dims>]` for an array type, `reference`, `compound`,
   * `opaque`, `bitfield`, `time` or `vlen`. `null` for a group, or a dataset whose type did not
   * decode.
   */
  dtype: string | null;
  /** `[]` for a scalar, `null` for a group or a null dataspace. */
  shape: number[] | null;
  value: string | string[] | number[] | null;
  skipped?: Hdf5Skipped;
  /** Datasets only: where the data lives, so a caller can prove it was not read. */
  storage?: Hdf5Storage;
}

export interface Hdf5Walk {
  entries: Hdf5Entry[];
  complete: boolean;
  incomplete?: Hdf5Incomplete;
  tally: ReadTally;
}

export async function walkHdf5(
  source: RangeSource,
  options: { limits?: Partial<Hdf5Limits> } = {},
): Promise<Hdf5Walk> {
  const limits: Hdf5Limits = { ...HDF5_LIMITS, ...options.limits };
  const src = new BoundedSource(source, limits);
  const walker = new Walker(src, limits);
  await walker.run();
  return {
    entries: walker.entries,
    complete: walker.incomplete === undefined,
    ...(walker.incomplete === undefined ? {} : { incomplete: walker.incomplete }),
    tally: { ...src.tally },
  };
}

const encoder = new TextEncoder();
const utf8 = new TextDecoder("utf-8");

function compareNames(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  }
  return x.length - y.length;
}

function product(dims: readonly number[]): number {
  let n = 1;
  for (const d of dims) {
    n *= d;
    if (!Number.isSafeInteger(n)) return Number.POSITIVE_INFINITY;
  }
  return n;
}

function childPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

class Walker {
  readonly entries: Hdf5Entry[] = [];
  incomplete: Hdf5Incomplete | undefined;
  private readonly src: BoundedSource;
  private readonly limits: Hdf5Limits;
  private file: Hdf5File | undefined;
  private readonly visited = new Set<number>();

  constructor(src: BoundedSource, limits: Hdf5Limits) {
    this.src = src;
    this.limits = limits;
  }

  private record(reason: Hdf5Incomplete): void {
    if (this.incomplete === undefined) this.incomplete = reason;
  }

  /**
   * Record a non-fatal problem and carry on. A limit, a failing source, or an error that is not
   * a {@link Hdf5Problem} (input the decoders did not foresee) propagates to {@link run}, which
   * records it and ends the walk.
   */
  private absorb(e: unknown): void {
    if (e instanceof Hdf5Problem && !e.fatal) {
      this.record(e.reason);
      return;
    }
    throw e;
  }

  private push(entry: Hdf5Entry): void {
    if (this.entries.length >= this.limits.maxObjects) throw new Hdf5Problem("limit-objects");
    this.entries.push(entry);
  }

  async run(): Promise<void> {
    try {
      const sb = await readSuperblock(this.src);
      this.file = new Hdf5File(this.src, sb);
      // A file shorter than its own end-of-file address was cut short: say so first, then list
      // whatever is still inside it. libhdf5 compares the stored address with the whole file's
      // size, user block included (H5F__super_read), and so does this.
      if (sb.eof > this.src.size) this.record("corrupt");
      await this.visit(sb.root, "/", "", 0);
    } catch (e) {
      // Nothing escapes walkHdf5: an unforeseen error is recorded as corrupt, and the entries
      // found so far are kept.
      this.record(e instanceof Hdf5Problem ? e.reason : "corrupt");
    }
  }

  private get f(): Hdf5File {
    return this.file as Hdf5File;
  }

  private async visit(at: number, path: string, name: string, depth: number): Promise<void> {
    // Visited once: a second hard link to an object already listed, or a cycle, ends here.
    if (this.visited.has(at)) return;
    this.visited.add(at);
    this.f.announced.delete(at);
    let messages: Message[];
    try {
      messages = await this.f.takeHeader(at);
    } catch (e) {
      this.absorb(e);
      return;
    }
    const has = (t: number) => messages.some((m) => m.type === t);
    const isGroup = has(MSG.SYMBOL_TABLE) || has(MSG.LINK_INFO) || has(MSG.LINK);
    if (has(MSG.LAYOUT)) {
      await this.dataset(messages, path, name);
    } else if (isGroup || path === "/") {
      this.push({ path, kind: "group", name, dtype: null, shape: null, value: null });
    } else if (has(MSG.DATATYPE)) {
      return; // a committed datatype: h5py's visititems lists none either
    } else {
      this.record("corrupt");
      return;
    }
    await this.attributes(messages, path);
    if (isGroup) await this.children(messages, path, depth);
  }

  // --- Datasets ---

  private async dataset(messages: Message[], path: string, name: string): Promise<void> {
    const entry: Hdf5Entry = { path, kind: "dataset", name, dtype: null, shape: null, value: null };
    try {
      const dtype = await this.datatypeOf(messages);
      entry.dtype = dtypeName(dtype);
      const shape = parseDataspace(this.cursorOf(messages, MSG.DATASPACE));
      entry.shape = shape;
      const layout = parseLayout(this.cursorOf(messages, MSG.LAYOUT));
      entry.storage = this.storage(layout);
      const filterMessage = messages.find((m) => m.type === MSG.FILTERS);
      const filters = filterMessage ? parseFilters(new Cursor(filterMessage.data, this.f.w)) : [];
      const external = messages.some((m) => m.type === MSG.EXTERNAL_FILES);
      // value() asks for bytes only when there is a dataspace with elements, never for `null`.
      const dims = shape ?? [];
      const result = await this.value(dtype, shape, (n) =>
        this.datasetBytes(layout, filters, external, dtype, dims, n),
      );
      entry.value = result.value;
      if (result.skipped) entry.skipped = result.skipped;
    } catch (e) {
      entry.value = null;
      if (e instanceof ChunksTooLarge) {
        entry.skipped = "size";
        this.push(entry);
        return;
      }
      this.absorb(e);
      entry.skipped = "error";
    }
    this.push(entry);
  }

  private cursorOf(messages: Message[], type: number): Cursor {
    const m = messages.find((x) => x.type === type);
    if (!m) throw new Hdf5Problem("corrupt");
    return new Cursor(m.data, this.f.w);
  }

  /** The dataset's datatype, following a shared (committed) datatype to its object header. */
  private async datatypeOf(messages: Message[]): Promise<Dtype> {
    const m = messages.find((x) => x.type === MSG.DATATYPE);
    if (!m) throw new Hdf5Problem("corrupt");
    if ((m.flags & 0x02) === 0) return parseDatatype(new Cursor(m.data, this.f.w));
    const at = this.f.abs(parseSharedAddress(new Cursor(m.data, this.f.w)));
    const target = await this.f.objectHeader(at);
    const t = target.find((x) => x.type === MSG.DATATYPE);
    if (!t || (t.flags & 0x02) !== 0) throw new Hdf5Problem("corrupt");
    return parseDatatype(new Cursor(t.data, this.f.w));
  }

  private storage(layout: Layout): Hdf5Storage {
    if (layout.kind === "contiguous") {
      if (layout.address === null) return { layout: "contiguous", address: null, size: 0 };
      return { layout: "contiguous", address: this.f.abs(layout.address), size: layout.size };
    }
    return { layout: layout.kind, address: null, size: null };
  }

  /** The first `n` bytes of a dataset's data, in row-major element order. */
  private async datasetBytes(
    layout: Layout,
    filters: Filter[],
    external: boolean,
    dtype: Dtype,
    shape: number[],
    n: number,
  ): Promise<Uint8Array> {
    if (external) throw new Hdf5Problem("external-link");
    if (layout.kind === "compact") {
      if (layout.data.length < n) throw new Hdf5Problem("corrupt");
      return layout.data.subarray(0, n);
    }
    if (layout.kind === "contiguous") {
      // Never written: libhdf5 returns the fill value, zero unless one was set.
      if (layout.address === null) return new Uint8Array(n);
      if (layout.size !== null && layout.size < n) throw new Hdf5Problem("corrupt");
      return this.src.read(this.f.abs(layout.address), n);
    }
    if (layout.kind === "virtual") throw new Hdf5Problem("unsupported-version");
    if (layout.unsupported || layout.btree === null) throw new Hdf5Problem("unsupported-version");
    for (const filter of filters) {
      if (filter.id !== 1 && filter.id !== 2) throw new Hdf5Problem("unsupported-filter");
    }
    return this.chunkedBytes(
      layout.btree,
      layout.chunk,
      filters,
      this.elementSize(dtype),
      shape,
      n,
    );
  }

  private elementSize(t: Dtype): number {
    return t.cls === "vstring" || t.cls === "vchars" ? 8 + this.f.w.O : t.size;
  }

  private async chunkedBytes(
    btree: number,
    chunk: number[],
    filters: Filter[],
    element: number,
    shape: number[],
    n: number,
  ): Promise<Uint8Array> {
    const rank = shape.length;
    if (chunk.length !== rank || chunk.some((d) => d < 1)) throw new Hdf5Problem("corrupt");
    if (element < 1) throw new Hdf5Problem("corrupt");
    const chunkElements = product(chunk);
    // Bounds every per-element loop below: at most CHUNK_BYTES_MAX elements per chunk, and at
    // most CHUNKS_BYTES_TOTAL_MAX across all chunks (each element is at least one byte).
    if (chunkElements > CHUNK_BYTES_MAX) throw new ChunksTooLarge();
    const chunkBytes = chunkElements * element;
    if (chunkBytes > CHUNK_BYTES_MAX) throw new ChunksTooLarge();
    const out = new Uint8Array(n);
    const leaves = await this.f.btreeV1(this.f.abs(btree), 1, rank);
    // More chunks than can cover the dataset is corrupt; enough of them to pass the total is a
    // value too large to unpack for the few elements the rules allow.
    const covering = product(shape.map((d, i) => Math.ceil(d / (chunk[i] as number))));
    if (leaves.length > covering) throw new Hdf5Problem("corrupt");
    if (leaves.length * chunkBytes > CHUNKS_BYTES_TOTAL_MAX) throw new ChunksTooLarge();
    const strides = shape.map((_, i) => product(shape.slice(i + 1)));
    for (const { key, child } of leaves) {
      const k = new Cursor(key, this.f.w);
      const size = k.u32();
      const mask = k.u32();
      const origin: number[] = [];
      for (let i = 0; i < rank; i++) origin.push(k.uint(8));
      let data = await this.src.read(child, size);
      for (let i = filters.length - 1; i >= 0; i--) {
        if (mask & (1 << i)) continue;
        const filter = filters[i] as Filter;
        if (filter.id === 1) data = await inflate(data, chunkBytes);
        else data = unshuffle(data, filter.client[0] ?? element, element);
      }
      if (data.length !== chunkBytes) throw new Hdf5Problem("corrupt");
      const local = new Array<number>(rank).fill(0);
      for (let li = 0; li < chunkElements; li++) {
        let rem = li;
        let global = 0;
        let inside = true;
        for (let d = rank - 1; d >= 0; d--) {
          const c = chunk[d] as number;
          local[d] = rem % c;
          rem = Math.floor(rem / c);
        }
        for (let d = 0; d < rank; d++) {
          const g = (origin[d] as number) + (local[d] as number);
          if (g >= (shape[d] as number)) {
            inside = false;
            break;
          }
          global += g * (strides[d] as number);
        }
        if (!inside || (global + 1) * element > n) continue;
        out.set(data.subarray(li * element, (li + 1) * element), global * element);
      }
    }
    return out;
  }

  // --- Values ---

  private async value(
    dtype: Dtype,
    shape: Shape,
    bytes: (n: number) => Promise<Uint8Array>,
  ): Promise<{ value: Hdf5Entry["value"]; skipped?: Hdf5Skipped }> {
    if (shape === null) return { value: null };
    let base = dtype;
    let per = 1;
    while (base.cls === "array") {
      per *= product(base.dims);
      base = base.base;
    }
    const count = product(shape) * per;
    const scalar = shape.length === 0 && per === 1;
    if (base.cls === "string" || base.cls === "vstring" || base.cls === "vchars") {
      if (count > STRING_ELEMENTS_MAX) return { value: null, skipped: "size" };
      if (base.cls === "string") {
        if (count * base.size > STRING_BYTES_MAX) return { value: null, skipped: "size" };
        const raw = await bytes(count * base.size);
        const out: string[] = [];
        for (let i = 0; i < count; i++) {
          let s = raw.subarray(i * base.size, (i + 1) * base.size);
          let end = s.length;
          while (end > 0 && s[end - 1] === 0) end--;
          s = s.subarray(0, end);
          out.push(base.nullterm ? cName(s) : utf8.decode(s));
        }
        return { value: scalar ? (out[0] as string) : out };
      }
      const element = this.elementSize(base);
      const raw = new Cursor(await bytes(count * element), this.f.w);
      const refs: { length: number; heap: number | null; index: number }[] = [];
      let total = 0;
      for (let i = 0; i < count; i++) {
        const length = raw.u32();
        const heap = raw.addr();
        const index = raw.u32();
        total += length;
        refs.push({ length, heap, index });
      }
      if (total > STRING_BYTES_MAX) return { value: null, skipped: "size" };
      const out: string[] = [];
      for (const r of refs) {
        if (r.length === 0 || r.heap === null) {
          out.push("");
          continue;
        }
        const obj = await this.f.globalObject(r.heap, r.index);
        if (obj.length < r.length) throw new Hdf5Problem("corrupt");
        out.push(cName(obj.subarray(0, r.length)));
      }
      return { value: scalar ? (out[0] as string) : out };
    }
    if (base.cls === "int" || base.cls === "float" || base.cls === "enum") {
      if (count > NUMERIC_ELEMENTS_MAX) return { value: null, skipped: "size" };
      const num = base.cls === "enum" ? base.base : base;
      if (!decodable(num)) {
        this.record("unsupported-datatype");
        return { value: null, skipped: "type" };
      }
      const raw = await bytes(count * num.size);
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const out: number[] = [];
      for (let i = 0; i < count; i++) out.push(decodeNumber(view, i * num.size, num));
      return { value: out };
    }
    if (base.cls !== "reference") this.record("unsupported-datatype");
    return { value: null, skipped: "type" };
  }

  // --- Attributes ---

  private async attributes(messages: Message[], path: string): Promise<void> {
    const found: AttributeMessage[] = [];
    for (const m of messages) {
      if (m.type !== MSG.ATTRIBUTE) continue;
      try {
        found.push(parseAttribute(new Cursor(m.data, this.f.w)));
      } catch (e) {
        this.absorb(e);
      }
    }
    const info = messages.find((m) => m.type === MSG.ATTRIBUTE_INFO);
    if (info) {
      try {
        const dense = parseAttributeInfo(new Cursor(info.data, this.f.w));
        if (dense.heap !== null && dense.names !== null) {
          const heap = await this.f.fractalHeap(dense.heap);
          const records = await this.f.btreeV2(dense.names, this.limits.maxObjects);
          for (const record of records) {
            try {
              if (record.length < 9) throw new Hdf5Problem("corrupt");
              // Record type 8: heap ID (8 bytes), message flags, creation order, name hash.
              if ((record[8] as number) & 0x02) throw new Hdf5Problem("unsupported-version");
              const obj = await heap.object(record.subarray(0, 8));
              found.push(parseAttribute(new Cursor(obj, this.f.w)));
            } catch (e) {
              this.absorb(e);
            }
          }
        }
      } catch (e) {
        this.absorb(e);
      }
    }
    found.sort((a, b) => compareNames(a.name, b.name));
    for (const a of found) {
      const entry: Hdf5Entry = {
        path,
        kind: "attribute",
        name: a.name,
        dtype: dtypeName(a.dtype),
        shape: a.shape,
        value: null,
      };
      try {
        const result = await this.value(a.dtype, a.shape, async (n) => {
          if (a.data.length < n) throw new Hdf5Problem("corrupt");
          return a.data.subarray(0, n);
        });
        entry.value = result.value;
        if (result.skipped) entry.skipped = result.skipped;
      } catch (e) {
        this.absorb(e);
        entry.skipped = "error";
      }
      this.push(entry);
    }
  }

  // --- Group members ---

  private async children(messages: Message[], path: string, depth: number): Promise<void> {
    const links: LinkMessage[] = [];
    for (const m of messages) {
      try {
        if (m.type === MSG.LINK) links.push(parseLink(new Cursor(m.data, this.f.w)));
        else if (m.type === MSG.SYMBOL_TABLE) await this.symbolTable(m, links);
        else if (m.type === MSG.LINK_INFO) await this.denseLinks(m, links);
      } catch (e) {
        this.absorb(e);
      }
    }
    const hard: { name: string; at: number }[] = [];
    for (const link of links) {
      if (link.type === "hard") hard.push({ name: link.name, at: this.f.abs(link.address) });
      else if (link.type === "external") this.record("external-link");
      // A soft link names a path; the object it names is listed under its own hard link.
    }
    if (hard.length === 0) return;
    if (depth + 1 > this.limits.maxDepth) {
      this.record("limit-depth");
      return;
    }
    hard.sort((a, b) => compareNames(a.name, b.name));
    const pending = hard.filter((c) => !this.visited.has(c.at)).map((c) => c.at);
    for (const at of pending) this.f.announced.add(at);
    // Read the members' headers in address order first, so that each read can carry the prefix
    // of the next packed header; the walk below then takes them, in name order, from memory.
    const stop = await this.f.prefetchHeaders(pending.sort((a, b) => a - b));
    for (const child of hard) {
      // Past a limit, list only the members whose headers were read before it.
      if (stop && !this.f.isPrefetched(child.at)) continue;
      await this.visit(child.at, childPath(path, child.name), child.name, depth + 1);
    }
    if (stop) throw stop;
  }

  /** An old-style group: a version 1 B-tree of symbol-table nodes, names in a local heap. */
  private async symbolTable(m: Message, links: LinkMessage[]): Promise<void> {
    const table = parseSymbolTable(new Cursor(m.data, this.f.w));
    if (table.btree === null || table.heap === null) throw new Hdf5Problem("corrupt");
    const names = await this.f.localHeap(this.f.abs(table.heap));
    const nodes = await this.f.btreeV1(this.f.abs(table.btree), 0, 0);
    for (const node of nodes) {
      for (const entry of await this.f.symbolNode(node.child)) {
        if (entry.nameOffset >= names.length) throw new Hdf5Problem("corrupt");
        // symbolNode returns absolute addresses; links carry file addresses.
        links.push({
          name: cName(names.subarray(entry.nameOffset)),
          type: "hard",
          address: entry.address - this.f.sb.base,
        });
      }
    }
  }

  /** A new-style group with dense links: a fractal heap indexed by a version 2 B-tree. */
  private async denseLinks(m: Message, links: LinkMessage[]): Promise<void> {
    const dense = parseLinkInfo(new Cursor(m.data, this.f.w));
    if (dense.heap === null || dense.names === null) return; // compact: the links are messages
    const heap = await this.f.fractalHeap(dense.heap);
    const records = await this.f.btreeV2(dense.names, this.limits.maxObjects);
    for (const record of records) {
      try {
        // Record type 5: name hash (4 bytes), then the heap ID.
        const obj = await heap.object(record.subarray(4));
        links.push(parseLink(new Cursor(obj, this.f.w)));
      } catch (e) {
        this.absorb(e);
      }
    }
  }
}

type NumericDtype = Extract<Dtype, { cls: "int" | "float" }>;

function decodable(t: Dtype): t is NumericDtype {
  if (t.cls === "int") return [1, 2, 4, 8].includes(t.size);
  if (t.cls === "float") return !t.vax && [2, 4, 8].includes(t.size);
  return false;
}

function decodeNumber(v: DataView, at: number, t: NumericDtype): number {
  const le = !t.be;
  if (t.cls === "int") {
    switch (t.size) {
      case 1:
        return t.signed ? v.getInt8(at) : v.getUint8(at);
      case 2:
        return t.signed ? v.getInt16(at, le) : v.getUint16(at, le);
      case 4:
        return t.signed ? v.getInt32(at, le) : v.getUint32(at, le);
      default:
        return Number(t.signed ? v.getBigInt64(at, le) : v.getBigUint64(at, le));
    }
  }
  if (t.size === 4) return v.getFloat32(at, le);
  if (t.size === 8) return v.getFloat64(at, le);
  return half(v.getUint16(at, le));
}

function half(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 0x1f) return frac ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}
