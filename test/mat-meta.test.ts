/**
 * The MAT-file Level 5 walker (`shared/mat-meta.ts`, card A5 of the publication-queue plan), and
 * the HDF5 walker's MATLAB character arrays (`matlabChars`).
 *
 * Every file read here is a real public MATLAB file, or a copy with made-up values
 * (`test/fixtures/mat/README.md`). Each has what scipy (Level 5) or h5py (v7.3) reads from it
 * beside it, `<file>.oracle.json`, printed by `scripts/dev/mat-oracle.py`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { walkHdf5 } from "../shared/hdf5-meta";
import { type RangeSource, ReadFailure, bufferSource } from "../shared/identifier-readers";
import {
  MAT_HEADER_BYTES,
  MAT_LIMITS,
  type MatEntry,
  matFormat,
  walkMat,
} from "../shared/mat-meta";

const DIR = join(import.meta.dir, "fixtures", "mat");
const load = (name: string) => new Uint8Array(readFileSync(join(DIR, name)));
const oracle = (name: string) =>
  JSON.parse(readFileSync(join(DIR, `${name}.oracle.json`), "utf8")) as {
    fields: string[];
    class: string;
    dims: number[];
    value?: (string | number)[];
    skipped?: string;
  }[];

/** A source that records every range asked of it. */
function recording(bytes: Uint8Array) {
  const ranges: [number, number][] = [];
  const src: RangeSource = {
    size: bytes.length,
    async read(offset, length) {
      ranges.push([offset, length]);
      return bytes.slice(offset, Math.min(bytes.length, offset + length));
    },
  };
  return { src, ranges };
}

/** An entry as the oracle prints it. */
function asOracle(e: MatEntry) {
  return {
    fields: e.fields,
    class: e.class,
    dims: e.dims,
    ...(e.skipped === undefined ? { value: e.value } : { skipped: e.skipped }),
  };
}

const LEVEL5 = [
  "eeglab-data.set",
  "eeglab-data-edited.set",
  "sub-001_task-Rest_eeg.set",
  "homer2-simple-probe.nirs",
  "oddball-onoff.mat",
];

describe("the Level 5 walker against scipy", () => {
  for (const name of LEVEL5) {
    test(`${name}: every array, in file order, as scipy reads it`, async () => {
      const walk = await walkMat(bufferSource(load(name)));
      expect(walk.incomplete).toBeUndefined();
      expect(walk.thrown).toBeUndefined();
      // Empty numeric arrays hold nothing; scipy also reads a zero-byte element as one.
      const held = (e: { class: string; value?: unknown }) =>
        e.class === "char" || !Array.isArray(e.value) || e.value.length > 0;
      expect(walk.entries.map(asOracle).filter(held)).toEqual(oracle(name).filter(held) as never);
    });
  }

  test("formats are told apart by the header, not the extension", () => {
    expect(matFormat(load("eeglab-data.set"))).toBe("v5");
    expect(matFormat(load("eeglab-data-v73-edited.set"))).toBe("v7.3");
    expect(matFormat(new TextEncoder().encode("Brain Vision Data Exchange Header File"))).toBe(
      "other",
    );
    // A Level 4 matrix header: type 0 (little-endian double), 1 x 1, real, name "x".
    const v4 = new Uint8Array(32);
    const view = new DataView(v4.buffer);
    view.setInt32(4, 1, true);
    view.setInt32(8, 1, true);
    view.setInt32(16, 2, true);
    v4[20] = "x".charCodeAt(0);
    expect(matFormat(v4)).toBe("v4");
  });
});

describe("bounds", () => {
  test("an uncompressed .set with its signal inside: no range asked overlaps the signal", async () => {
    const bytes = load("sub-001_task-Rest_eeg.set");
    const { src, ranges } = recording(bytes);
    const walk = await walkMat(src);
    const data = walk.entries.find((e) => e.fields.join(".") === "EEG.data");
    expect(data?.skipped).toBe("size");
    const unread = data?.unread as { offset: number; bytes: number };
    // The signal is most of the file, and the walk asked for none of it.
    expect(unread.bytes).toBeGreaterThan(bytes.length * 0.9);
    for (const [offset, length] of ranges) {
      const overlaps = offset < unread.offset + unread.bytes && offset + length > unread.offset;
      expect(overlaps).toBe(false);
    }
    const asked = ranges.reduce((n, [, l]) => n + l, 0);
    expect(asked).toBeLessThan(64 * 1024);
  });

  test("a top-level compressed signal is left after its first bytes, not inflated", async () => {
    // The Homer2 file holds `d`, a compressed signal of 1,500 values, as its own variable.
    const walk = await walkMat(bufferSource(load("homer2-simple-probe.nirs")));
    const d = walk.variables.find((v) => v.name === "d");
    expect(d?.compressed).toBe(true);
    expect(walk.entries.find((e) => e.fields[0] === "d")?.skipped).toBe("size");
    // The twin: with no numeric size rule the signal is read, and far more is inflated.
    const all = await walkMat(bufferSource(load("homer2-simple-probe.nirs")), {
      limits: { numericElements: Number.MAX_SAFE_INTEGER },
    });
    expect(all.entries.find((e) => e.fields[0] === "d")?.value).not.toBeNull();
    expect(walk.inflated).toBeLessThan(all.inflated / 2);
  });

  test("inflation stops at the cap, lowered for the test: limit, with the arrays before it", async () => {
    const bytes = load("homer2-simple-probe.nirs");
    const full = await walkMat(bufferSource(bytes));
    expect(full.inflated).toBeGreaterThan(400);
    const capped = await walkMat(bufferSource(bytes), { limits: { maxInflatedBytes: 400 } });
    expect(capped.incomplete).toBe("limit");
    expect(capped.inflated).toBeLessThanOrEqual(400 + 64 * 1024);
    expect(capped.entries.length).toBeLessThan(full.entries.length);
    // The twin: at the bytes the full walk inflated, the cap is not reached.
    const enough = await walkMat(bufferSource(bytes), {
      limits: { maxInflatedBytes: full.inflated },
    });
    expect(enough.incomplete).toBeUndefined();
  });

  test("the element cap ends the walk with limit; at the count it needs, it does not", async () => {
    const bytes = load("eeglab-data.set");
    const full = await walkMat(bufferSource(bytes));
    let arrays = 0;
    // Count by walking with caps that stop at each value: the smallest that completes.
    for (const cap of [10, 1000]) {
      const w = await walkMat(bufferSource(bytes), { limits: { maxElements: cap } });
      expect(w.incomplete).toBe("limit");
      expect(w.entries.length).toBeLessThan(full.entries.length);
      arrays = cap;
    }
    expect(arrays).toBe(1000);
    const wide = await walkMat(bufferSource(bytes), { limits: { maxElements: 100_000 } });
    expect(wide.incomplete).toBeUndefined();
    expect(MAT_LIMITS.maxElements).toBe(1_000_000);
  });

  test("the depth cap ends the walk with limit", async () => {
    const w = await walkMat(bufferSource(load("eeglab-data.set")), { limits: { maxDepth: 1 } });
    expect(w.incomplete).toBe("limit");
    const ok = await walkMat(bufferSource(load("eeglab-data.set")), { limits: { maxDepth: 3 } });
    expect(ok.incomplete).toBeUndefined();
  });

  test("a character array over the size rule is listed, skipped, not read", async () => {
    const w = await walkMat(bufferSource(load("eeglab-data.set")), {
      limits: { charBytesMax: 8 },
    });
    expect(w.entries.some((e) => e.class === "char" && e.skipped === "size")).toBe(true);
    // A numeric array of at most 64 values is read; one over it is skipped (both directions).
    const narrow = await walkMat(bufferSource(load("eeglab-data.set")), {
      limits: { numericElements: 0 },
    });
    const filled = (e: MatEntry) => e.class === "double" && (e.value?.length ?? 0) > 0;
    expect(narrow.entries.some(filled)).toBe(false);
    const wide = await walkMat(bufferSource(load("eeglab-data.set")));
    expect(wide.entries.some(filled)).toBe(true);
  });
});

/** A little-endian Level 5 file built here, for constructs no fixture holds. */
function level5(...elements: Uint8Array[]): Uint8Array {
  const head = new Uint8Array(MAT_HEADER_BYTES).fill(0x20);
  head.set(new TextEncoder().encode("MATLAB 5.0 MAT-file, built by the A5 tests"));
  head[124] = 0x00;
  head[125] = 0x01;
  head[126] = "I".charCodeAt(0);
  head[127] = "M".charCodeAt(0);
  const out = new Uint8Array(head.length + elements.reduce((n, e) => n + e.length, 0));
  out.set(head);
  let at = head.length;
  for (const e of elements) {
    out.set(e, at);
    at += e.length;
  }
  return out;
}

/** A sub-element: tag and data, padded to 8 bytes. */
function sub(type: number, data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(8 + Math.ceil(data.length / 8) * 8);
  const view = new DataView(padded.buffer);
  view.setUint32(0, type, true);
  view.setUint32(4, data.length, true);
  padded.set(data, 8);
  return padded;
}

const u32 = (...n: number[]) => new Uint8Array(new Uint32Array(n).buffer);
const i32 = (...n: number[]) => new Uint8Array(new Int32Array(n).buffer);
const ascii = (s: string) => new TextEncoder().encode(s);

function matrix(...parts: Uint8Array[]): Uint8Array {
  return sub(14, level5Concat(parts));
}
function level5Concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("classes no fixture holds", () => {
  test("an opaque array (a MATLAB object) is skipped after its flags; the walk goes on", async () => {
    // Opaque layout: flags, then the variable name, the type system and the class name: no dims.
    const opaque = matrix(
      sub(6, u32(17, 0)),
      sub(1, ascii("tbl")),
      sub(1, ascii("MCOS")),
      sub(1, ascii("table")),
      matrix(sub(6, u32(9, 0)), sub(5, i32(1, 3)), sub(1, ascii("")), sub(2, new Uint8Array(3))),
    );
    const note = new Uint8Array(new Uint16Array([..."ok"].map((c) => c.charCodeAt(0))).buffer);
    const text = matrix(sub(6, u32(4, 0)), sub(5, i32(1, 2)), sub(1, ascii("note")), sub(4, note));
    const walk = await walkMat(bufferSource(level5(opaque, text)));
    expect(walk.incomplete).toBe("unsupported-datatype");
    expect(walk.entries).toEqual([
      { fields: [], class: "opaque", dims: [], value: null, skipped: "type" },
      { fields: ["note"], class: "char", dims: [1, 2], value: ["ok"] },
    ]);
  });

  test("a sparse array is skipped as unsupported, and a nested cell past the depth cap is a limit", async () => {
    const sparse = matrix(sub(6, u32(5, 0)), sub(5, i32(2, 2)), sub(1, ascii("sp")));
    expect((await walkMat(bufferSource(level5(sparse)))).incomplete).toBe("unsupported-datatype");
    // A cell inside a cell inside a cell: depth 2 below the variable.
    const leaf = matrix(
      sub(6, u32(6, 0)),
      sub(5, i32(1, 1)),
      sub(1, ascii("")),
      sub(9, new Uint8Array(8)),
    );
    const inner = matrix(sub(6, u32(1, 0)), sub(5, i32(1, 1)), sub(1, ascii("")), leaf);
    const outer = matrix(sub(6, u32(1, 0)), sub(5, i32(1, 1)), sub(1, ascii("c")), inner);
    const bytes = level5(outer);
    expect((await walkMat(bufferSource(bytes), { limits: { maxDepth: 1 } })).incomplete).toBe(
      "limit",
    );
    expect(
      (await walkMat(bufferSource(bytes), { limits: { maxDepth: 2 } })).incomplete,
    ).toBeUndefined();
  });
});

/** A struct array's header: flags, dims, name, field-name width and names. */
const structHead = (dims: number[], name: string, width: number, names: Uint8Array) => [
  sub(6, u32(2, 0)),
  sub(5, i32(...dims)),
  sub(1, ascii(name)),
  sub(5, i32(width)),
  sub(1, names),
];
const scalar = matrix(
  sub(6, u32(6, 0)),
  sub(5, i32(1, 1)),
  sub(1, ascii("")),
  sub(9, new Uint8Array(8)),
);

describe("declared counts and sizes do not drive the walk (review round 1)", () => {
  test("a 1e9 x 1e9 struct with no fields returns at once, corrupt", async () => {
    const huge = matrix(...structHead([1e9, 1e9], "X", 0, new Uint8Array(0)));
    const started = performance.now();
    const w = await walkMat(bufferSource(level5(huge)));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(w.incomplete).toBe("corrupt");
    // A real 1 x 1 struct with no fields (MATLAB's `struct()`) holds nothing and is fine, and a
    // 1e6 x 1e6 one returns at once too: no loop over a count with nothing in it.
    const none = matrix(...structHead([1, 1], "X", 32, new Uint8Array(0)));
    expect((await walkMat(bufferSource(level5(none)))).incomplete).toBeUndefined();
    const wide = matrix(...structHead([1e6, 1e6], "X", 32, new Uint8Array(0)));
    const t0 = performance.now();
    expect((await walkMat(bufferSource(level5(wide)))).incomplete).toBeUndefined();
    expect(performance.now() - t0).toBeLessThan(1000);
    // A 1e9 x 1e9 count is past 2^53 with a field width the file states: corrupt, at once.
    const past = matrix(...structHead([1e9, 1e9], "X", 32, new Uint8Array(0)));
    expect((await walkMat(bufferSource(level5(past)))).incomplete).toBe("corrupt");
    // With a field and the same count, the bytes cannot hold the members: corrupt, at once.
    const many = matrix(...structHead([1e9, 1e9], "X", 8, ascii("a".padEnd(8, "\0"))));
    const t = performance.now();
    expect((await walkMat(bufferSource(level5(many)))).incomplete).toBe("corrupt");
    expect(performance.now() - t).toBeLessThan(1000);
  });

  test("a member count the bytes cannot hold is corrupt before it is charged or walked", async () => {
    // Two million members declared, none present: corrupt, not a limit.
    const cell = matrix(sub(6, u32(1, 0)), sub(5, i32(1, 2_000_000)), sub(1, ascii("c")));
    expect((await walkMat(bufferSource(level5(cell)))).incomplete).toBe("corrupt");
  });

  test("a cell's members are charged against the element cap before any is walked", async () => {
    const cell = matrix(
      sub(6, u32(1, 0)),
      sub(5, i32(1, 3)),
      sub(1, ascii("c")),
      scalar,
      scalar,
      scalar,
    );
    expect(
      (await walkMat(bufferSource(level5(cell)), { limits: { maxElements: 3 } })).incomplete,
    ).toBe("limit");
    // The twin: the variable and its three members fit a cap of 4.
    const ok = await walkMat(bufferSource(level5(cell)), { limits: { maxElements: 4 } });
    expect(ok.incomplete).toBeUndefined();
    expect(ok.entries).toHaveLength(3);
  });

  test("a 1 x 1 double whose data tag declares 2 MB is corrupt, and no more than the cap is read", async () => {
    const big = matrix(
      sub(6, u32(6, 0)),
      sub(5, i32(1, 1)),
      sub(1, ascii("X")),
      sub(2, new Uint8Array(2_000_000)),
    );
    const { src, ranges } = recording(level5(big));
    const w = await walkMat(src);
    expect(w.incomplete).toBe("corrupt");
    expect(ranges.reduce((n, [, l]) => n + l, 0)).toBeLessThan(1024);
    // A data tag one padded slot past the array's own size is not this array's either.
    const over = matrix(
      sub(6, u32(6, 0)),
      sub(5, i32(1, 1)),
      sub(1, ascii("X")),
      sub(9, new Uint8Array(24)),
    );
    expect((await walkMat(bufferSource(level5(over)))).incomplete).toBe("corrupt");
    // The twin: a data tag of exactly one double reads.
    const one = matrix(
      sub(6, u32(6, 0)),
      sub(5, i32(1, 1)),
      sub(1, ascii("X")),
      sub(9, new Uint8Array(8)),
    );
    expect((await walkMat(bufferSource(level5(one)))).entries).toEqual([
      { fields: ["X"], class: "double", dims: [1, 1], value: [0] },
    ]);
  });

  test("bytes left in a cell or struct past its members are corrupt, at the top level too", async () => {
    const cellOf = (...members: Uint8Array[]) =>
      matrix(sub(6, u32(1, 0)), sub(5, i32(1, 1)), sub(1, ascii("c")), ...members);
    expect((await walkMat(bufferSource(level5(cellOf(scalar))))).incomplete).toBeUndefined();
    expect((await walkMat(bufferSource(level5(cellOf(scalar, scalar))))).incomplete).toBe(
      "corrupt",
    );
    // Nested below the top: a struct whose one field is a cell with a stray member.
    const nested = matrix(
      ...structHead([1, 1], "s", 8, ascii("f".padEnd(8, "\0"))),
      cellOf(scalar, scalar),
    );
    expect((await walkMat(bufferSource(level5(nested)))).incomplete).toBe("corrupt");
    // A struct with two names and one member per element: corrupt.
    const short = matrix(
      ...structHead([1, 1], "s", 8, ascii("a".padEnd(8, "\0") + "b".padEnd(8, "\0"))),
      scalar,
    );
    expect((await walkMat(bufferSource(level5(short)))).incomplete).toBe("corrupt");
    const whole = matrix(
      ...structHead([1, 1], "s", 8, ascii("a".padEnd(8, "\0") + "b".padEnd(8, "\0"))),
      scalar,
      scalar,
    );
    expect((await walkMat(bufferSource(level5(whole)))).incomplete).toBeUndefined();
  });

  test("a field-name width of 0, or names that do not fill whole slots, are corrupt", async () => {
    const zero = matrix(...structHead([1, 1], "s", 0, ascii("ab")), scalar);
    expect((await walkMat(bufferSource(level5(zero)))).incomplete).toBe("corrupt");
    // Twelve bytes of names in 8-byte slots, with two members as if there were two slots.
    const ragged = matrix(
      ...structHead([1, 1], "s", 8, ascii("a".padEnd(12, "\0"))),
      scalar,
      scalar,
    );
    expect((await walkMat(bufferSource(level5(ragged)))).incomplete).toBe("corrupt");
  });

  test("a char array whose dimensions the data cannot fill is corrupt, at once (round 2)", async () => {
    // 3e8 rows declared, two UTF-16 characters stored: no rows are produced.
    const text = (dims: number[], units: number[]) =>
      matrix(
        sub(6, u32(4, 0)),
        sub(5, i32(...dims)),
        sub(1, ascii("a")),
        sub(17, new Uint8Array(new Uint16Array(units).buffer)),
      );
    const started = performance.now();
    const w = await walkMat(bufferSource(level5(text([300_000_000, 1], [0x61, 0x62]))));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(w.incomplete).toBe("corrupt");
    expect(w.entries).toEqual([]);
    // The twin: two rows of one character each, as stored.
    const ok = await walkMat(bufferSource(level5(text([2, 1], [0x61, 0x62]))));
    expect(ok.incomplete).toBeUndefined();
    expect(ok.entries).toEqual([{ fields: ["a"], class: "char", dims: [2, 1], value: ["a", "b"] }]);
  });

  test("every top-level element counts against the element cap", async () => {
    const small = sub(1, ascii("x"));
    const many = level5(...Array.from({ length: 20 }, () => small));
    expect((await walkMat(bufferSource(many), { limits: { maxElements: 10 } })).incomplete).toBe(
      "limit",
    );
    expect(
      (await walkMat(bufferSource(many), { limits: { maxElements: 20 } })).incomplete,
    ).toBeUndefined();
  });

  test("a top-level element that runs past the end of the file is corrupt, unread", async () => {
    const bytes = level5(scalar).slice();
    // Declare 1 MiB for the variable.
    new DataView(bytes.buffer).setUint32(MAT_HEADER_BYTES + 4, 1024 * 1024, true);
    const { src, ranges } = recording(bytes);
    expect((await walkMat(src)).incomplete).toBe("corrupt");
    expect(ranges.every(([o]) => o < bytes.length)).toBe(true);
  });
});

describe("damaged input", () => {
  test("a file cut short is corrupt, keeping the arrays before the cut", async () => {
    const bytes = load("eeglab-data.set");
    const full = await walkMat(bufferSource(bytes));
    for (const at of [MAT_HEADER_BYTES + 4, 5000, bytes.length - 100]) {
      const w = await walkMat(bufferSource(bytes.subarray(0, at)));
      expect(w.incomplete).toBe("corrupt");
      expect(w.entries.length).toBeLessThan(full.entries.length);
    }
  });

  test("a compressed variable cut short is corrupt", async () => {
    const bytes = load("oddball-onoff.mat");
    const w = await walkMat(bufferSource(bytes.subarray(0, bytes.length - 40)));
    expect(w.incomplete).toBe("corrupt");
  });

  test("a top-level element skipped past the end of the file is corrupt", async () => {
    // The embedded signal is skipped unread; cut the file inside it.
    const bytes = load("sub-001_task-Rest_eeg.set");
    const w = await walkMat(bufferSource(bytes.subarray(0, 1_000_000)));
    expect(w.incomplete).toBe("corrupt");
  });

  test("a header that is not Level 5 is corrupt for the walker, with nothing read past it", async () => {
    const { src, ranges } = recording(new TextEncoder().encode("not a MAT-file".padEnd(200)));
    const w = await walkMat(src);
    expect(w.incomplete).toBe("corrupt");
    expect(ranges).toEqual([[0, MAT_HEADER_BYTES]]);
  });

  test("a failing source ends the walk with the error, never as a clean walk", async () => {
    const bytes = load("eeglab-data.set");
    const failure = new ReadFailure("network", { retryable: true });
    const src: RangeSource = {
      size: bytes.length,
      async read(offset, length) {
        if (offset > 1000) throw failure;
        return bytes.slice(offset, offset + length);
      },
    };
    const w = await walkMat(src);
    expect(w.thrown).toBe(failure);
    expect(w.incomplete).toBeUndefined();
  });

  test("a failing source inside a compressed variable is the source's error, not corrupt", async () => {
    const bytes = load("oddball-onoff.mat");
    const failure = new ReadFailure("network", { retryable: true });
    const src: RangeSource = {
      size: bytes.length,
      async read(offset, length) {
        if (offset > MAT_HEADER_BYTES + 8) throw failure;
        return bytes.slice(offset, offset + length);
      },
    };
    const w = await walkMat(src);
    expect(w.thrown).toBe(failure);
  });
});

describe("MATLAB v7.3 character arrays (HDF5 walker, matlabChars)", () => {
  const name = "eeglab-data-v73-edited.set";
  const expected = (
    JSON.parse(readFileSync(join(DIR, `${name}.oracle.json`), "utf8")) as {
      path: string;
      value: string[];
    }[]
  ).filter((e) => e.value.join("").length * 2 <= 64 * 1024);

  test("every char array reads as h5py's rows, longer ones included", async () => {
    const walk = await walkHdf5(bufferSource(load(name)), { matlabChars: true });
    const got = new Map(
      walk.entries.filter((e) => e.kind === "dataset").map((e) => [e.path, e.value]),
    );
    expect(expected.length).toBeGreaterThan(300);
    // The history, the comments and the edited fields are over the numeric rule's 64 elements.
    expect(expected.some((e) => e.path === "/EEG/history" && (e.value[0]?.length ?? 0) > 64)).toBe(
      true,
    );
    for (const e of expected) expect(got.get(e.path), e.path).toEqual(e.value);
  });

  test("without the option the walk is A3's: char arrays are numbers, or skipped by size", async () => {
    const walk = await walkHdf5(bufferSource(load(name)));
    const history = walk.entries.find((e) => e.path === "/EEG/history" && e.kind === "dataset");
    expect(history?.value).toBeNull();
    expect(history?.skipped).toBe("size");
    const subject = walk.entries.find((e) => e.path === "/EEG/subject" && e.kind === "dataset");
    expect(Array.isArray(subject?.value) && typeof subject.value[0]).toBe("number");
  });
});
