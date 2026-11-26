/**
 * A bounded, dependency-free MAT-file Level 5 metadata walker (publication-queue plan, card A5;
 * epic #2182). EEGLAB `.set`, Homer2 `.nirs` and generic `.mat` files saved by MATLAB `-v6` or
 * `-v7` are Level 5; `-v7.3` files are HDF5 and are read by `shared/hdf5-meta.ts` instead
 * ({@link matFormat} tells them apart).
 *
 * What it returns: one {@link MatEntry} per character or numeric array it finds, walking struct
 * and cell arrays, with the variable and struct field names that lead to it:
 * - a character array of at most {@link MAT_LIMITS}`.charBytesMax` stored bytes, as one string
 *   per row (MATLAB stores it column-major);
 * - a numeric or logical array of at most {@link MAT_LIMITS}`.numericElements` elements, as its
 *   real parts;
 * - anything larger: `value: null, skipped: "size"`, skipped by its declared byte size. An
 *   uncompressed array skipped this way is never read: only its tag, flags, dimensions and name
 *   are, so recording signals are not fetched.
 * - sparse, object, function-handle and opaque arrays (MATLAB classes such as `string` and
 *   `table`): `skipped: "type"`, and the walk records `unsupported-datatype`.
 *
 * Compressed elements (`miCOMPRESSED`, zlib) are inflated as a stream, only as far as the walk
 * needs: a top-level compressed variable that turns out to be a large numeric array is left
 * after its first bytes, without inflating the rest. Inside a compressed variable, skipping an
 * array means inflating through it; inflation is capped per file
 * ({@link MAT_LIMITS}`.maxInflatedBytes`), past which the walk ends with `limit`.
 *
 * Untrusted input: every array counts against the element cap and nesting against the depth
 * cap, and every sub-element must fit inside its parent. A cap ends the walk (`limit`); a
 * structure that does not decode ends it (`corrupt`). Entries found before either are kept. A
 * failing source read ends the walk with the error in `thrown`, for the caller to judge
 * (`shared/readers/mat-generic.ts` does it under the reader contract).
 *
 * Reference: MathWorks, "MAT-File Format", version 7, Level 5 MAT-files.
 */

import type { RangeSource } from "./hdf5-meta";

/** The fixed header of a Level 5 MAT-file. */
export const MAT_HEADER_BYTES = 128;

/** The walker's caps (card A5, decided design). */
export const MAT_LIMITS = {
  /**
   * Arrays visited, containers included. EEGLAB event tables hold one array per field per
   * event: public files measured for card A5 reach 741,000 (p50 46,000 of those over 20,000).
   */
  maxElements: 1_000_000,
  /** Struct and cell nesting below a variable. */
  maxDepth: 32,
  /** A character array's stored bytes, at most (the HDF5 walker's string rule). */
  charBytesMax: 64 * 1024,
  /** A numeric array's elements, at most (the HDF5 walker's numeric rule). */
  numericElements: 64,
  /** Bytes inflated from compressed elements, per file. */
  maxInflatedBytes: 256 * 1024 * 1024,
} as const;

export type MatLimits = { -readonly [K in keyof typeof MAT_LIMITS]: number };

/** Why a walk ended early or skipped something; the reader registry's words for the same. */
export type MatIncomplete = "limit" | "corrupt" | "unsupported-datatype";

/** What the first bytes of a `.mat`-family file are. */
export type MatFormat = "v5" | "v7.3" | "v4" | "other";

export const MAT_CLASSES = [
  "unknown",
  "cell",
  "struct",
  "object",
  "char",
  "sparse",
  "double",
  "single",
  "int8",
  "uint8",
  "int16",
  "uint16",
  "int32",
  "uint32",
  "int64",
  "uint64",
  "function",
  "opaque",
] as const;
export type MatClass = (typeof MAT_CLASSES)[number];

export interface MatEntry {
  /**
   * The variable's name, then the struct field names down to this array. A cell's members add
   * no name. These are the file's own text: rules may match on them, findings never carry them.
   */
  fields: string[];
  class: MatClass;
  dims: number[];
  /** Characters: one string per row. Numbers: the real parts, column-major. */
  value: string[] | number[] | null;
  skipped?: "size" | "type";
}

/** A variable at the top of the file: where its element lies, for callers that check ranges. */
export interface MatVariable {
  name: string;
  /** The element's tag offset in the file. */
  offset: number;
  /** The element's bytes, tag included. */
  length: number;
  compressed: boolean;
}

export interface MatWalk {
  entries: MatEntry[];
  variables: MatVariable[];
  incomplete?: MatIncomplete;
  /** Bytes inflated from compressed elements, in all. */
  inflated: number;
  /** The first error the source threw, when one ended the walk. */
  thrown?: unknown;
}

// Data types (the format's `mi*` codes).
const MI = {
  INT8: 1,
  UINT8: 2,
  INT16: 3,
  UINT16: 4,
  INT32: 5,
  UINT32: 6,
  SINGLE: 7,
  DOUBLE: 9,
  INT64: 12,
  UINT64: 13,
  MATRIX: 14,
  COMPRESSED: 15,
  UTF8: 16,
  UTF16: 17,
  UTF32: 18,
} as const;

/** Bytes per element of each numeric data type. */
const MI_SIZE: Record<number, number> = {
  [MI.INT8]: 1,
  [MI.UINT8]: 1,
  [MI.INT16]: 2,
  [MI.UINT16]: 2,
  [MI.INT32]: 4,
  [MI.UINT32]: 4,
  [MI.SINGLE]: 4,
  [MI.DOUBLE]: 8,
  [MI.INT64]: 8,
  [MI.UINT64]: 8,
  [MI.UTF8]: 1,
  [MI.UTF16]: 2,
  [MI.UTF32]: 4,
};

class MatProblem extends Error {
  readonly reason: MatIncomplete;
  constructor(reason: MatIncomplete) {
    super(reason);
    this.name = "MatProblem";
    this.reason = reason;
  }
}

/** Bytes as Latin-1 text: names in a MAT-file are ASCII. */
const latin1 = {
  decode(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  },
};
const utf8 = new TextDecoder("utf-8");

/** Is this a Level 5 header, a v7.3 (HDF5) one, a Level 4 file, or something else? */
export function matFormat(head: Uint8Array): MatFormat {
  if (head.length >= MAT_HEADER_BYTES) {
    const indicator = String.fromCharCode(head[126] as number, head[127] as number);
    if (indicator === "IM" || indicator === "MI") {
      const le = indicator === "IM";
      const version = le
        ? (head[124] as number) | ((head[125] as number) << 8)
        : ((head[124] as number) << 8) | (head[125] as number);
      if (version === 0x0100) return "v5";
      if (version === 0x0200) return "v7.3";
    }
  }
  return isLevel4(head) ? "v4" : "other";
}

/**
 * A Level 4 MAT-file starts with a matrix header: a type code `MOPT` (machine 0 to 4, O = 0,
 * precision 0 to 5, type 0 to 2), rows, columns, an imaginary flag and a name length, then the
 * name. Read in either byte order.
 */
function isLevel4(head: Uint8Array): boolean {
  if (head.length < 21) return false;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  for (const le of [true, false]) {
    const type = view.getInt32(0, le);
    const imag = view.getInt32(12, le);
    const namlen = view.getInt32(16, le);
    if (type < 0 || type > 4052) continue;
    const m = Math.floor(type / 1000);
    const o = Math.floor(type / 100) % 10;
    const p = Math.floor(type / 10) % 10;
    const t = type % 10;
    if (m > 4 || o !== 0 || p > 5 || t > 2) continue;
    if ((imag !== 0 && imag !== 1) || namlen < 2 || namlen > 64 || 20 + namlen > head.length) {
      continue;
    }
    const name = head.subarray(20, 20 + namlen - 1);
    if (head[20 + namlen - 1] === 0 && name.every((b) => b >= 0x21 && b < 0x7f)) return true;
  }
  return false;
}

const pad8 = (n: number) => (8 - (n % 8)) % 8;

/** A forward-only view of an element's bytes: direct reads of the file, or an inflated stream. */
interface Forward {
  /** Position in this stream: a file offset, or bytes inflated so far. */
  readonly pos: number;
  /** Exactly `n` bytes, or `corrupt` when the stream ends first. */
  take(n: number): Promise<Uint8Array>;
  skip(n: number): Promise<void>;
}

/** The file's bytes between two offsets, read as the walk asks for them. */
class Direct implements Forward {
  pos: number;
  constructor(
    private readonly src: RangeSource,
    start: number,
    private readonly end: number,
  ) {
    this.pos = start;
  }
  async take(n: number): Promise<Uint8Array> {
    if (this.pos + n > this.end) throw new MatProblem("corrupt");
    const bytes = await this.src.read(this.pos, n);
    if (bytes.length < n) throw new MatProblem("corrupt");
    this.pos += n;
    return bytes;
  }
  async skip(n: number): Promise<void> {
    if (this.pos + n > this.end) throw new MatProblem("corrupt");
    this.pos += n;
  }
}

/** The compressed bytes of an element are fetched this many at a time. */
const COMPRESSED_CHUNK = 64 * 1024;

/**
 * A zlib stream inflated as the walk pulls on it. Compressed bytes are fetched only as the
 * inflater asks for them; inflated bytes count against the walk's cap as they are produced.
 */
class Inflating implements Forward {
  pos = 0;
  private readonly reader: {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(): Promise<void>;
  };
  private buffered: Uint8Array[] = [];
  private bufferedBytes = 0;
  private done = false;
  /** What the source threw, if it did: that, not a corrupt stream, is why the inflater failed. */
  private sourceError: { error: unknown } | undefined;

  constructor(
    src: RangeSource,
    start: number,
    length: number,
    private readonly spend: (n: number) => void,
  ) {
    let at = start;
    const stop = start + length;
    const failed = (error: unknown) => {
      this.sourceError ??= { error };
    };
    const compressed = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (at >= stop) {
          controller.close();
          return;
        }
        const want = Math.min(COMPRESSED_CHUNK, stop - at);
        let got: Uint8Array;
        try {
          got = await src.read(at, want);
        } catch (e) {
          failed(e);
          throw e;
        }
        at += got.length;
        if (got.length > 0) controller.enqueue(got);
        // A file cut short ends the stream; the inflater then ends early or errors.
        if (got.length < want) controller.close();
      },
    });
    this.reader = compressed
      .pipeThrough(
        new DecompressionStream("deflate") as unknown as TransformStream<Uint8Array, Uint8Array>,
      )
      .getReader();
  }

  private async fill(n: number): Promise<void> {
    while (this.bufferedBytes < n) {
      if (this.done) throw new MatProblem("corrupt");
      let chunk: { done: boolean; value?: Uint8Array };
      try {
        chunk = await this.reader.read();
      } catch (e) {
        // A source failure surfaces through the stream; any other error is corrupt data.
        if (this.sourceError !== undefined) throw this.sourceError.error;
        if (e instanceof MatProblem) throw e;
        throw new MatProblem("corrupt");
      }
      if (chunk.done || chunk.value === undefined) {
        this.done = true;
        continue;
      }
      this.spend(chunk.value.length);
      this.buffered.push(chunk.value);
      this.bufferedBytes += chunk.value.length;
    }
  }

  private consume(n: number, keep: boolean): Uint8Array {
    const out = keep ? new Uint8Array(n) : new Uint8Array(0);
    let filled = 0;
    while (filled < n) {
      const head = this.buffered[0] as Uint8Array;
      const piece = Math.min(head.length, n - filled);
      if (keep) out.set(head.subarray(0, piece), filled);
      filled += piece;
      if (piece === head.length) this.buffered.shift();
      else this.buffered[0] = head.subarray(piece);
    }
    this.bufferedBytes -= n;
    this.pos += n;
    return out;
  }

  async take(n: number): Promise<Uint8Array> {
    await this.fill(n);
    return this.consume(n, true);
  }

  async skip(n: number): Promise<void> {
    // In slices, so a long skip never buffers more than one slice of inflated bytes.
    let left = n;
    while (left > 0) {
      const step = Math.min(left, 1024 * 1024);
      await this.fill(step);
      this.consume(step, false);
      left -= step;
    }
  }

  async close(): Promise<void> {
    try {
      await this.reader.cancel();
    } catch {
      // Already errored or closed: nothing left to release.
    }
  }
}

interface Tag {
  type: number;
  bytes: number;
  /** The data of a small element, packed into its tag. */
  small: Uint8Array | null;
}

const CLASS_OF: Record<number, MatClass> = {
  1: "cell",
  2: "struct",
  3: "object",
  4: "char",
  5: "sparse",
  6: "double",
  7: "single",
  8: "int8",
  9: "uint8",
  10: "int16",
  11: "uint16",
  12: "int32",
  13: "uint32",
  14: "int64",
  15: "uint64",
  16: "function",
  17: "opaque",
};

const UNSUPPORTED: ReadonlySet<MatClass> = new Set(["sparse", "object", "function", "opaque"]);

function product(dims: readonly number[]): number {
  let n = 1;
  for (const d of dims) {
    n *= d;
    if (!Number.isSafeInteger(n)) return Number.POSITIVE_INFINITY;
  }
  return n;
}

export interface MatWalkOptions {
  limits?: Partial<MatLimits>;
}

/**
 * Walk a Level 5 MAT-file. Never throws: a failing source read ends the walk with the error in
 * `thrown`, anything the format does not allow ends it with `corrupt`, and a cap with `limit`.
 */
export async function walkMat(src: RangeSource, options: MatWalkOptions = {}): Promise<MatWalk> {
  const walker = new MatWalker(src, { ...MAT_LIMITS, ...options.limits });
  await walker.run();
  return {
    entries: walker.entries,
    variables: walker.variables,
    ...(walker.incomplete === undefined ? {} : { incomplete: walker.incomplete }),
    inflated: walker.inflated,
    ...(walker.thrown === undefined ? {} : { thrown: walker.thrown }),
  };
}

class MatWalker {
  readonly entries: MatEntry[] = [];
  readonly variables: MatVariable[] = [];
  incomplete: MatIncomplete | undefined;
  thrown: unknown;
  inflated = 0;
  private elements = 0;
  private le = true;

  constructor(
    private readonly src: RangeSource,
    private readonly limits: MatLimits,
  ) {}

  private record(reason: MatIncomplete): void {
    this.incomplete ??= reason;
  }

  async run(): Promise<void> {
    try {
      const head = await this.src.read(0, MAT_HEADER_BYTES);
      if (matFormat(head) !== "v5") throw new MatProblem("corrupt");
      this.le = head[126] === 0x49; // "IM"
      await this.variablesFrom(MAT_HEADER_BYTES);
    } catch (e) {
      if (e instanceof MatProblem) this.record(e.reason);
      else this.thrown = e;
    }
  }

  /** Every top-level element, from `at` to the end of the file. */
  private async variablesFrom(at: number): Promise<void> {
    let pos = at;
    for (;;) {
      const raw = await this.src.read(pos, 8);
      if (raw.length < 8) {
        // The end of the file falls here, between elements, or inside a tag: cut short.
        if (raw.length === 0 && this.src.size === pos) return;
        if (raw.length === 0 && this.src.size === Number.POSITIVE_INFINITY) return;
        throw new MatProblem("corrupt");
      }
      const tag = this.tag(raw);
      if (tag.small !== null) {
        pos += 8;
        continue;
      }
      const length = 8 + tag.bytes;
      if (tag.type === MI.COMPRESSED) {
        const stream = new Inflating(this.src, pos + 8, tag.bytes, (n) => this.spend(n));
        try {
          await this.compressedVariable(stream, pos, length);
        } finally {
          await stream.close();
        }
        pos += length;
      } else if (tag.type === MI.MATRIX) {
        const r = new Direct(this.src, pos + 8, pos + 8 + tag.bytes);
        const name = await this.matrix(r, tag.bytes, [], 0, true);
        this.variables.push({ name, offset: pos, length, compressed: false });
        pos += length + pad8(tag.bytes);
      } else {
        pos += length + pad8(tag.bytes);
      }
      // A skipped element that ends past the end of the file: the file was cut short.
      if (pos > this.src.size) throw new MatProblem("corrupt");
    }
  }

  private async compressedVariable(r: Inflating, offset: number, length: number): Promise<void> {
    const tag = this.tag(await r.take(8));
    if (tag.type !== MI.MATRIX || tag.small !== null) throw new MatProblem("corrupt");
    const name = await this.matrix(r, tag.bytes, [], 0, true);
    this.variables.push({ name, offset, length, compressed: true });
  }

  private spend(n: number): void {
    this.inflated += n;
    if (this.inflated > this.limits.maxInflatedBytes) throw new MatProblem("limit");
  }

  private u32(b: Uint8Array, at: number): number {
    return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, this.le);
  }

  private tag(raw: Uint8Array): Tag {
    const first = this.u32(raw, 0);
    // A small element packs its byte count into the upper half of the first word.
    if (first >>> 16 !== 0) {
      const bytes = first >>> 16;
      if (bytes > 4) throw new MatProblem("corrupt");
      return { type: first & 0xffff, bytes, small: raw.subarray(4, 4 + bytes) };
    }
    return { type: first, bytes: this.u32(raw, 4), small: null };
  }

  /** A sub-element: its tag, then its data, which must end inside `end`. */
  private async element(r: Forward, end: number): Promise<{ tag: Tag; data: Uint8Array }> {
    if (r.pos + 8 > end) throw new MatProblem("corrupt");
    const tag = this.tag(await r.take(8));
    if (tag.small !== null) return { tag, data: tag.small };
    if (r.pos + tag.bytes > end) throw new MatProblem("corrupt");
    const data = await r.take(tag.bytes);
    await r.skip(Math.min(pad8(tag.bytes), end - r.pos));
    return { tag, data };
  }

  /** A sub-element's tag only; its data is the caller's to take or skip. */
  private async elementTag(r: Forward, end: number): Promise<Tag> {
    if (r.pos + 8 > end) throw new MatProblem("corrupt");
    const tag = this.tag(await r.take(8));
    if (tag.small === null && r.pos + tag.bytes > end) throw new MatProblem("corrupt");
    return tag;
  }

  private numbers(tag: Tag, data: Uint8Array): number[] {
    const size = MI_SIZE[tag.type];
    if (size === undefined || tag.type === MI.MATRIX) throw new MatProblem("corrupt");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const out: number[] = [];
    for (let at = 0; at + size <= data.length; at += size) {
      switch (tag.type) {
        case MI.INT8:
          out.push(view.getInt8(at));
          break;
        case MI.UINT8:
        case MI.UTF8:
          out.push(view.getUint8(at));
          break;
        case MI.INT16:
          out.push(view.getInt16(at, this.le));
          break;
        case MI.UINT16:
        case MI.UTF16:
          out.push(view.getUint16(at, this.le));
          break;
        case MI.INT32:
          out.push(view.getInt32(at, this.le));
          break;
        case MI.UINT32:
        case MI.UTF32:
          out.push(view.getUint32(at, this.le));
          break;
        case MI.SINGLE:
          out.push(view.getFloat32(at, this.le));
          break;
        case MI.DOUBLE:
          out.push(view.getFloat64(at, this.le));
          break;
        case MI.INT64:
          out.push(Number(view.getBigInt64(at, this.le)));
          break;
        default:
          out.push(Number(view.getBigUint64(at, this.le)));
      }
    }
    return out;
  }

  private text(tag: Tag, data: Uint8Array, dims: number[]): string[] {
    const count = product(dims);
    const rows = dims[0] ?? 0;
    if (count === 0 || rows === 0) return [];
    // UTF-8 with multi-byte characters has no fixed unit; a single row decodes whole.
    if (tag.type === MI.UTF8 && rows === 1) return [utf8.decode(data)];
    const units = this.numbers(tag, data);
    const columns = Math.floor(units.length / rows);
    const out: string[] = [];
    for (let r = 0; r < rows; r++) {
      let s = "";
      for (let c = 0; c < columns; c++) {
        const u = units[c * rows + r] as number;
        s += u <= 0xffff ? String.fromCharCode(u) : u <= 0x10ffff ? String.fromCodePoint(u) : "";
      }
      out.push(s);
    }
    return out;
  }

  /**
   * One array (an `miMATRIX` of `bytes` bytes, its tag already taken), and everything inside
   * it. Returns its name. `top`: a variable, whose stream the caller leaves; the walk does not
   * read on to its end.
   */
  private async matrix(
    r: Forward,
    bytes: number,
    fields: string[],
    depth: number,
    top = false,
  ): Promise<string> {
    const end = r.pos + bytes;
    this.elements++;
    if (this.elements > this.limits.maxElements) throw new MatProblem("limit");
    // An empty element: an empty cell member or struct field.
    if (bytes === 0) return "";
    const flags = await this.element(r, end);
    if (flags.data.length < 8) throw new MatProblem("corrupt");
    const word = this.u32(flags.data, 0);
    const cls = CLASS_OF[word & 0xff] ?? "unknown";
    if (UNSUPPORTED.has(cls) || cls === "unknown") {
      // Skipped after its flags: an opaque array (a MATLAB object) has no dimensions element,
      // and nothing in these classes is read.
      this.record("unsupported-datatype");
      this.entries.push({
        fields: top ? [] : fields,
        class: cls,
        dims: [],
        value: null,
        skipped: "type",
      });
      if (!top) await r.skip(end - r.pos);
      return "";
    }
    const dimsEl = await this.element(r, end);
    if (dimsEl.tag.type !== MI.INT32) throw new MatProblem("corrupt");
    const dims = this.numbers(dimsEl.tag, dimsEl.data);
    if (dims.some((d) => d < 0)) throw new MatProblem("corrupt");
    const nameEl = await this.element(r, end);
    const name = latin1.decode(nameEl.data).replace(/\0+$/, "");
    const path = top ? [name] : fields;
    const count = product(dims);

    if (cls === "char") {
      const data = await this.elementTag(r, end);
      if (data.bytes > this.limits.charBytesMax) {
        this.entries.push({ fields: path, class: cls, dims, value: null, skipped: "size" });
      } else {
        const raw = data.small ?? (await r.take(data.bytes));
        this.entries.push({ fields: path, class: cls, dims, value: this.text(data, raw, dims) });
      }
    } else if (cls === "cell") {
      if (depth + 1 > this.limits.maxDepth) throw new MatProblem("limit");
      for (let i = 0; i < count; i++) {
        const tag = await this.elementTag(r, end);
        if (tag.type !== MI.MATRIX || tag.small !== null) throw new MatProblem("corrupt");
        await this.matrix(r, tag.bytes, path, depth + 1);
      }
    } else if (cls === "struct") {
      if (depth + 1 > this.limits.maxDepth) throw new MatProblem("limit");
      const lengthEl = await this.element(r, end);
      const [width] = this.numbers(lengthEl.tag, lengthEl.data);
      const namesEl = await this.element(r, end);
      const names: string[] = [];
      if (width !== undefined && width > 0) {
        for (let at = 0; at + width <= namesEl.data.length; at += width) {
          names.push(latin1.decode(namesEl.data.subarray(at, at + width)).replace(/\0.*$/s, ""));
        }
      }
      // One path per field, shared by every element of a struct array.
      const paths = names.map((field) => [...path, field]);
      for (let i = 0; i < count; i++) {
        for (const fieldPath of paths) {
          const tag = await this.elementTag(r, end);
          if (tag.type !== MI.MATRIX || tag.small !== null) throw new MatProblem("corrupt");
          await this.matrix(r, tag.bytes, fieldPath, depth + 1);
        }
      }
    } else if (count > this.limits.numericElements) {
      this.entries.push({ fields: path, class: cls, dims, value: null, skipped: "size" });
    } else {
      const real = await this.element(r, end);
      this.entries.push({
        fields: path,
        class: cls,
        dims,
        value: this.numbers(real.tag, real.data),
      });
    }

    // A variable's stream is left where it is: a large array is not read (or inflated) past
    // the bytes that said what it is.
    if (top) return name;
    if (r.pos > end) throw new MatProblem("corrupt");
    await r.skip(end - r.pos);
    return name;
  }
}
