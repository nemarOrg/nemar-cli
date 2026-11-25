/**
 * Decoders for the object-header messages the metadata walker needs, from the HDF5 file format
 * specification version 3.0, section IV.A.2. Each decoder works on the bytes of one message,
 * already read, and throws a {@link Hdf5Problem} for anything it does not support or that does not
 * fit; it never reads the file itself.
 */

import { Cursor, Hdf5Problem, type Widths } from "./io";

export const MSG = {
  NIL: 0x0,
  DATASPACE: 0x1,
  LINK_INFO: 0x2,
  DATATYPE: 0x3,
  EXTERNAL_FILES: 0x7,
  LAYOUT: 0x8,
  FILTERS: 0xb,
  ATTRIBUTE: 0xc,
  CONTINUATION: 0x10,
  SYMBOL_TABLE: 0x11,
  LINK: 0x6,
  ATTRIBUTE_INFO: 0x15,
} as const;

// --- Datatype (0x0003) ---

export type Dtype =
  | { cls: "int"; size: number; signed: boolean; be: boolean }
  | { cls: "float"; size: number; be: boolean; vax: boolean }
  | { cls: "string"; size: number; nullterm: boolean }
  | { cls: "vstring"; size: number }
  | { cls: "vchars"; size: number }
  | { cls: "enum"; size: number; base: Dtype }
  | { cls: "array"; size: number; dims: number[]; base: Dtype }
  | { cls: "reference"; size: number }
  | { cls: "other"; size: number; name: "time" | "bitfield" | "opaque" | "compound" | "vlen" };

const ARRAY_RANK_MAX = 32;

export function parseDatatype(c: Cursor): Dtype {
  const head = c.u8();
  const cls = head & 0x0f;
  const version = head >> 4;
  // Version 5 is what libhdf5 2.x writes under libver "latest"; its encoding of every class
  // decoded here is the same as version 3.
  if (version < 1 || version > 5) throw new Hdf5Problem("unsupported-version");
  const flags = c.uint(3);
  const size = c.u32();
  // No HDF5 type stores elements of zero bytes; a zero would make every element count free.
  if (size === 0) throw new Hdf5Problem("corrupt");
  switch (cls) {
    case 0: {
      c.skip(4); // bit offset, bit precision; a width other than 1, 2, 4 or 8 is not decoded
      return { cls: "int", size, signed: (flags & 0x08) !== 0, be: (flags & 0x01) !== 0 };
    }
    case 1: {
      c.skip(12);
      // Bit 6 is VAX order, which nothing in scope writes; it is listed and never decoded.
      return { cls: "float", size, be: (flags & 0x01) !== 0, vax: (flags & 0x40) !== 0 };
    }
    case 2:
      c.skip(2);
      return { cls: "other", size, name: "time" };
    case 3:
      return { cls: "string", size, nullterm: (flags & 0x0f) === 0 };
    case 4:
      c.skip(4);
      return { cls: "other", size, name: "bitfield" };
    case 5:
      // The opaque tag runs to the end of the message; nothing after it is read.
      return { cls: "other", size, name: "opaque" };
    case 6:
      // Members are not decoded: a compound is never read, and nothing follows it in a message
      // the walker needs (an enum's base, the only type that precedes other fields, is an integer).
      return { cls: "other", size, name: "compound" };
    case 7:
      return { cls: "reference", size };
    case 8: {
      const base = parseDatatype(c);
      if (base.cls !== "int") throw new Hdf5Problem("corrupt");
      return { cls: "enum", size, base };
    }
    case 9: {
      const kind = flags & 0x0f;
      const base = parseDatatype(c);
      if (kind === 1) return { cls: "vstring", size };
      if (base.cls === "string" && base.size === 1) return { cls: "vchars", size };
      return { cls: "other", size, name: "vlen" };
    }
    case 10: {
      const rank = c.u8();
      if (rank < 1 || rank > ARRAY_RANK_MAX) throw new Hdf5Problem("corrupt");
      if (version < 3) c.skip(3);
      const dims: number[] = [];
      for (let i = 0; i < rank; i++) dims.push(c.u32());
      if (version < 3) c.skip(4 * rank); // permutation indices
      const base = parseDatatype(c);
      return { cls: "array", size, dims, base };
    }
    default:
      throw new Hdf5Problem("unsupported-datatype");
  }
}

/** The dtype string the h5py oracle prints for the same type. */
export function dtypeName(t: Dtype): string {
  switch (t.cls) {
    case "int":
      return `${t.signed ? "int" : "uint"}${t.size * 8}`;
    case "float":
      return `float${t.size * 8}`;
    case "string":
    case "vstring":
      return "string";
    case "vchars":
      return "vlen:string";
    case "enum":
      return `enum:${dtypeName(t.base)}`;
    case "array":
      return `${dtypeName(t.base)}[${t.dims.join("x")}]`;
    case "reference":
      return "reference";
    case "other":
      return t.name;
  }
}

// --- Dataspace (0x0001) ---

/** `null` is the null dataspace (no elements, no shape); `[]` is a scalar. */
export type Shape = number[] | null;

export function parseDataspace(c: Cursor): Shape {
  const version = c.u8();
  const rank = c.u8();
  const flags = c.u8();
  if (rank > ARRAY_RANK_MAX) throw new Hdf5Problem("corrupt");
  let type = rank === 0 ? 0 : 1;
  if (version === 1) {
    c.skip(5);
  } else if (version === 2) {
    type = c.u8();
  } else {
    throw new Hdf5Problem("unsupported-version");
  }
  if (type === 2) return null;
  if (type === 0) return [];
  if (type !== 1) throw new Hdf5Problem("corrupt");
  const dims: number[] = [];
  for (let i = 0; i < rank; i++) dims.push(c.len());
  if (flags & 0x01) c.skip(rank * c.w.L);
  return dims;
}

// --- Data layout (0x0008) ---

export type Layout =
  | { kind: "compact"; data: Uint8Array }
  | { kind: "contiguous"; address: number | null; size: number | null }
  | {
      kind: "chunked";
      /** Address of the version 1 B-tree that indexes the chunks (layout version 3). */
      btree: number | null;
      chunk: number[];
      /** The index is something other than a version 1 B-tree: values cannot be read. */
      unsupported: boolean;
    }
  | { kind: "virtual" };

export function parseLayout(c: Cursor): Layout {
  const version = c.u8();
  if (version === 1 || version === 2) {
    const rank = c.u8();
    const cls = c.u8();
    c.skip(5);
    const address = cls === 0 ? null : c.addr();
    const dims: number[] = [];
    for (let i = 0; i < rank; i++) dims.push(c.u32());
    if (cls === 0) {
      const size = c.u32();
      return { kind: "compact", data: c.bytes(size) };
    }
    if (cls === 1) return { kind: "contiguous", address, size: null };
    if (cls === 2)
      return { kind: "chunked", btree: address, chunk: dims.slice(0, -1), unsupported: true };
    throw new Hdf5Problem("corrupt");
  }
  if (version !== 3 && version !== 4) throw new Hdf5Problem("unsupported-version");
  const cls = c.u8();
  if (cls === 0) {
    const size = c.u16();
    return { kind: "compact", data: c.bytes(size) };
  }
  if (cls === 1) {
    const address = c.addr();
    const size = c.len();
    return { kind: "contiguous", address, size };
  }
  if (cls === 2 && version === 3) {
    const rank = c.u8();
    if (rank < 1 || rank > ARRAY_RANK_MAX + 1) throw new Hdf5Problem("corrupt");
    const btree = c.addr();
    const dims: number[] = [];
    for (let i = 0; i < rank; i++) dims.push(c.u32());
    return { kind: "chunked", btree, chunk: dims.slice(0, -1), unsupported: false };
  }
  if (cls === 2) {
    // Version 4 chunk indexes (single chunk, implicit, fixed and extensible arrays, version 2
    // B-trees) are listed but their values are not read.
    c.skip(1);
    const rank = c.u8();
    const width = c.u8();
    if (rank < 1 || rank > ARRAY_RANK_MAX + 1 || width < 1 || width > 8)
      throw new Hdf5Problem("corrupt");
    const dims: number[] = [];
    for (let i = 0; i < rank; i++) dims.push(c.uint(width));
    return { kind: "chunked", btree: null, chunk: dims.slice(0, -1), unsupported: true };
  }
  if (cls === 3) return { kind: "virtual" };
  throw new Hdf5Problem("corrupt");
}

// --- Filter pipeline (0x000B) ---

export interface Filter {
  id: number;
  client: number[];
}

const FILTERS_MAX = 32;

export function parseFilters(c: Cursor): Filter[] {
  const version = c.u8();
  const count = c.u8();
  if (count > FILTERS_MAX) throw new Hdf5Problem("corrupt");
  if (version === 1) c.skip(6);
  else if (version !== 2) throw new Hdf5Problem("unsupported-version");
  const out: Filter[] = [];
  for (let i = 0; i < count; i++) {
    const id = c.u16();
    const nameLength = version === 1 || id >= 256 ? c.u16() : 0;
    c.skip(2); // flags
    const values = c.u16();
    if (version === 1) c.skip(Math.ceil(nameLength / 8) * 8);
    else c.skip(nameLength);
    const client: number[] = [];
    for (let j = 0; j < values; j++) client.push(c.u32());
    if (version === 1 && values % 2 === 1) c.skip(4);
    out.push({ id, client });
  }
  return out;
}

// --- Attribute (0x000C) ---

export interface AttributeMessage {
  name: string;
  dtype: Dtype;
  shape: Shape;
  data: Uint8Array;
}

const utf8 = new TextDecoder("utf-8");

/** A null-terminated name; the terminator is optional at the end of the field. */
export function cName(b: Uint8Array): string {
  const end = b.indexOf(0);
  return utf8.decode(end < 0 ? b : b.subarray(0, end));
}

export function parseAttribute(c: Cursor): AttributeMessage {
  const version = c.u8();
  if (version < 1 || version > 3) throw new Hdf5Problem("unsupported-version");
  const flags = c.u8();
  if (version >= 2 && (flags & 0x03) !== 0) throw new Hdf5Problem("unsupported-datatype");
  const nameSize = c.u16();
  const typeSize = c.u16();
  const spaceSize = c.u16();
  if (version === 3) c.skip(1); // name character set
  const pad = (n: number) => (version === 1 ? Math.ceil(n / 8) * 8 : n);
  const name = cName(c.bytes(nameSize));
  c.skip(pad(nameSize) - nameSize);
  const typeBytes = c.bytes(pad(typeSize));
  const spaceBytes = c.bytes(pad(spaceSize));
  const dtype = parseDatatype(new Cursor(typeBytes.subarray(0, typeSize), c.w));
  const shape = parseDataspace(new Cursor(spaceBytes.subarray(0, spaceSize), c.w));
  return { name, dtype, shape, data: c.buf.subarray(c.pos) };
}

// --- Links (0x0006), link info (0x0002), attribute info (0x0015), symbol table (0x0011) ---

export type LinkMessage =
  | { name: string; type: "hard"; address: number }
  | { name: string; type: "soft" | "external" | "other" };

export function parseLink(c: Cursor): LinkMessage {
  const version = c.u8();
  if (version !== 1) throw new Hdf5Problem("unsupported-version");
  const flags = c.u8();
  const linkType = flags & 0x08 ? c.u8() : 0;
  if (flags & 0x04) c.skip(8);
  if (flags & 0x10) c.skip(1);
  const nameLength = c.uint(1 << (flags & 0x03));
  const name = utf8.decode(c.bytes(nameLength));
  if (linkType === 0) {
    const address = c.addr();
    if (address === null) throw new Hdf5Problem("corrupt");
    return { name, type: "hard", address };
  }
  if (linkType === 1) return { name, type: "soft" };
  if (linkType === 64) return { name, type: "external" };
  return { name, type: "other" };
}

export interface DenseIndex {
  heap: number | null;
  names: number | null;
}

export function parseLinkInfo(c: Cursor): DenseIndex {
  if (c.u8() !== 0) throw new Hdf5Problem("unsupported-version");
  const flags = c.u8();
  if (flags & 0x01) c.skip(8);
  return { heap: c.addr(), names: c.addr() };
}

export function parseAttributeInfo(c: Cursor): DenseIndex {
  if (c.u8() !== 0) throw new Hdf5Problem("unsupported-version");
  const flags = c.u8();
  if (flags & 0x01) c.skip(2);
  return { heap: c.addr(), names: c.addr() };
}

export function parseSymbolTable(c: Cursor): { btree: number | null; heap: number | null } {
  return { btree: c.addr(), heap: c.addr() };
}

/** A shared message's pointer to the object header that holds it (versions 1 to 3, type 2). */
export function parseSharedAddress(c: Cursor): number {
  const version = c.u8();
  const type = c.u8();
  if (version === 1) {
    c.skip(6);
    const a = c.addr();
    if (a === null) throw new Hdf5Problem("corrupt");
    return a;
  }
  if (version === 2 || (version === 3 && type === 2)) {
    const a = c.addr();
    if (a === null) throw new Hdf5Problem("corrupt");
    return a;
  }
  throw new Hdf5Problem("unsupported-version");
}

export type { Widths };
