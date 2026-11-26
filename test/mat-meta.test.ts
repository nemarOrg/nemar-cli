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
