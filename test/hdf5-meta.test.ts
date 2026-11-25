/**
 * The HDF5 metadata walker (`shared/hdf5-meta.ts`, card A3 of the publication-queue plan).
 *
 * Every fixture in `test/fixtures/hdf5/` is a real HDF5 file (README.md there records source,
 * license and size), and each has the entry list h5py printed for it beside it
 * (`<file>.oracle.json`, from `scripts/dev/hdf5-oracle.py`). The walker's output must equal the
 * oracle's, so a parser that only agrees with itself cannot pass.
 *
 * The bounds tests change only the source (a shorter file, a patched address, a failing read)
 * or the limits, and go through the same entry point.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Hdf5Entry, type Hdf5Walk, type RangeSource, walkHdf5 } from "../shared/hdf5-meta";

const DIR = join(import.meta.dir, "fixtures", "hdf5");

function load(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(DIR, name)));
}

/** An in-memory source that records every range it is asked for. */
function source(
  bytes: Uint8Array,
  size = bytes.length,
): RangeSource & { ranges: [number, number][] } {
  const ranges: [number, number][] = [];
  return {
    size,
    ranges,
    read: async (offset, length) => {
      ranges.push([offset, length]);
      return bytes.slice(offset, Math.min(size, offset + length));
    },
  };
}

/**
 * Per-walk time bound in the fuzz tests. A walk on these inputs takes a few milliseconds; 200 ms
 * leaves room for a loaded machine and still fails a walk that loops on hostile bytes.
 */
const FUZZ_WALK_MS = 200;

/** A seeded generator (mulberry32), so a failing fuzz seed can be replayed. */
function prng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return (r ^ (r >>> 14)) >>> 0;
  };
}

/** JSON's spelling of the oracle: non-finite numbers are strings, object keys sorted. */
function canonical(v: unknown): unknown {
  if (typeof v === "number" && !Number.isFinite(v)) {
    if (Number.isNaN(v)) return "NaN";
    return v > 0 ? "Infinity" : "-Infinity";
  }
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, x]) => [k, canonical(x)]),
    );
  }
  return v;
}

function sorted(entries: readonly Hdf5Entry[]): unknown[] {
  const key = (e: Hdf5Entry) => [e.path, e.kind, e.name];
  return [...entries]
    .sort((a, b) => {
      const x = key(a);
      const y = key(b);
      for (let i = 0; i < 3; i++)
        if (x[i] !== y[i]) return (x[i] as string) < (y[i] as string) ? -1 : 1;
      return 0;
    })
    .map(canonical);
}

function oracle(name: string): unknown[] {
  return (JSON.parse(readFileSync(join(DIR, `${name}.oracle.json`), "utf8")) as unknown[]).map(
    canonical,
  );
}

async function walk(name: string, limits?: Parameters<typeof walkHdf5>[1]): Promise<Hdf5Walk> {
  return walkHdf5(source(load(name)), limits);
}

function find(
  w: Hdf5Walk,
  path: string,
  kind: Hdf5Entry["kind"] = "dataset",
  name?: string,
): Hdf5Entry {
  const e = w.entries.find(
    (x) => x.path === path && x.kind === kind && (name === undefined || x.name === name),
  );
  if (!e) throw new Error(`no ${kind} ${path} ${name ?? ""}`);
  return e;
}

describe("entries equal h5py's", () => {
  test("SNIRF written by EasyH5/JSNIRFY (snirf-samples Simple_Probe)", async () => {
    const w = await walk("snirf-samples-simple-probe.snirf");
    expect(sorted(w.entries)).toEqual(oracle("snirf-samples-simple-probe.snirf"));
    expect(w.complete).toBe(true);
  });

  test("SNIRF exported by Homer3", async () => {
    const w = await walk("homer3-neuro-run02.snirf");
    expect(sorted(w.entries)).toEqual(oracle("homer3-neuro-run02.snirf"));
    expect(w.complete).toBe(true);
  });

  test("MATLAB v7.3 EEGLAB .set: user block, references, MATLAB_fields, compact layout", async () => {
    // Its 1,558 object headers take about 2,060 exact reads, inside the 20,000 default.
    const w = await walk("eeglab-data-v73.set");
    expect(sorted(w.entries)).toEqual(oracle("eeglab-data-v73.set"));
    expect(w.complete).toBe(true);
    // A reference is listed and not read, and it does not make the walk incomplete.
    const refs = w.entries.filter((e) => e.dtype === "reference");
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((e) => e.value === null && e.skipped === "type")).toBe(true);
    // MATLAB writes struct field names as a variable-length sequence of one-byte strings.
    expect(find(w, "/EEG", "attribute", "MATLAB_fields").value).toContain("setname");
  });

  test("libver latest: superblock 3, object header 2, dense links and dense attributes", async () => {
    const bytes = load("dense-latest.h5");
    expect(bytes[8]).toBe(3);
    const w = await walkHdf5(source(bytes));
    expect(sorted(w.entries)).toEqual(oracle("dense-latest.h5"));
    expect(w.complete).toBe(true);
    expect(
      w.entries.filter((e) => e.path.startsWith("/dense/member_") && e.kind === "group"),
    ).toHaveLength(12);
    expect(find(w, "/dense", "attribute", "too_many")).toMatchObject({
      value: null,
      skipped: "size",
      shape: [100],
    });
    // The soft link is not an object: the dataset it names is listed once, under its hard link.
    expect(w.entries.some((e) => e.path === "/compact/soft")).toBe(false);
  });

  test("chunked, deflate-compressed strings; a shuffled numeric; an external link recorded", async () => {
    const w = await walk("chunked-strings.h5");
    expect(sorted(w.entries)).toEqual(oracle("chunked-strings.h5"));
    expect(find(w, "/labels").value).toHaveLength(40);
    expect(find(w, "/shuffled").value).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(w.complete).toBe(false);
    expect(w.incomplete).toBe("external-link");
  });
});

describe("value rules", () => {
  test("a string over 64 KiB, or over 4,096 elements, is listed with skipped size", async () => {
    const w = await walk("chunked-strings.h5");
    expect(find(w, "/long_text")).toMatchObject({
      dtype: "string",
      shape: [1],
      value: null,
      skipped: "size",
    });
    expect(find(w, "/many_labels")).toMatchObject({
      dtype: "string",
      shape: [5000],
      value: null,
      skipped: "size",
    });
  });

  test("a small value in a chunk over 1 MiB is not inflated, and is not an error", async () => {
    const w = await walk("chunked-strings.h5");
    expect(find(w, "/huge_chunk")).toMatchObject({ shape: [4], value: null, skipped: "size" });
    expect(w.incomplete).toBe("external-link");
  });

  test("a numeric over 64 elements is skipped; at 64 it is read", async () => {
    const w = await walk("eeglab-data-v73.set");
    const numeric = w.entries.filter(
      (e) => e.kind === "dataset" && /^(u?int|float)/.test(e.dtype ?? ""),
    );
    for (const e of numeric) {
      const n = (e.shape ?? []).reduce((a, b) => a * b, 1);
      if (n > 64) expect(e).toMatchObject({ value: null, skipped: "size" });
      else expect((e.value as number[]).length).toBe(n);
    }
    expect(numeric.some((e) => (e.shape ?? []).reduce((a, b) => a * b, 1) > 64)).toBe(true);
  });

  test("an unsupported datatype is listed, skipped and recorded", async () => {
    const w = await walk("unsupported-type.h5");
    expect(sorted(w.entries)).toEqual(oracle("unsupported-type.h5"));
    expect(find(w, "/complex")).toMatchObject({ dtype: "compound", value: null, skipped: "type" });
    expect(find(w, "/ok").value).toEqual([0, 1, 2]);
    expect(w.incomplete).toBe("unsupported-datatype");
  });

  test("an unsupported filter leaves the value unread and is recorded", async () => {
    const w = await walk("unsupported-filter.h5");
    expect(find(w, "/checksummed")).toMatchObject({ value: null, skipped: "error", shape: [8] });
    // Everything else equals h5py's, which reads the value the walker refuses to.
    const expected = oracle("unsupported-filter.h5").filter(
      (e) => (e as Hdf5Entry).path !== "/checksummed",
    );
    expect(sorted(w.entries).filter((e) => (e as Hdf5Entry).path !== "/checksummed")).toEqual(
      expected,
    );
    expect(w.incomplete).toBe("unsupported-filter");
  });
});

describe("bounds", () => {
  test("signals are not read: no read overlaps /nirs/data1/dataTimeSeries, at most 512 KiB", async () => {
    const src = source(load("snirf-samples-simple-probe.snirf"));
    const w = await walkHdf5(src);
    const storage = find(w, "/nirs/data1/dataTimeSeries").storage;
    expect(storage?.layout).toBe("contiguous");
    const start = storage?.address as number;
    const end = start + (storage?.size as number);
    expect(end - start).toBeGreaterThan(64 * 8);
    expect(src.ranges.length).toBe(w.tally.reads);
    for (const [o, l] of src.ranges) expect(o + l <= start || o >= end).toBe(true);
    expect(w.tally.bytes).toBeLessThanOrEqual(512 * 1024);
  });

  test("a file cut to half its size is corrupt, without throwing, and keeps what it read", async () => {
    const bytes = load("homer3-neuro-run02.snirf");
    const half = Math.floor(bytes.length / 2);
    const src = source(bytes, half);
    const w = await walkHdf5(src);
    expect(w.complete).toBe(false);
    expect(w.incomplete).toBe("corrupt");
    expect(w.entries.length).toBeGreaterThan(0);
    // A structure that would end past the file is refused before the source is asked for it.
    for (const [o, l] of src.ranges) expect(o + l).toBeLessThanOrEqual(half);
  });

  test("the end-of-file address is checked against the source's size", async () => {
    // Cut only bytes the walk never reads: every entry is still listed, and only the
    // superblock's end-of-file address shows the file is short.
    const bytes = load("snirf-samples-simple-probe.snirf");
    const full = source(bytes);
    await walkHdf5(full);
    const lastRead = Math.max(...full.ranges.map(([o, l]) => o + l));
    expect(lastRead).toBeLessThan(bytes.length);
    const w = await walkHdf5(source(bytes, lastRead));
    expect(sorted(w.entries)).toEqual(oracle("snirf-samples-simple-probe.snirf"));
    expect(w.incomplete).toBe("corrupt");
  });

  test("a 4 KiB byte limit ends the walk with limit-bytes", async () => {
    const w = await walk("homer3-neuro-run02.snirf", { limits: { maxBytes: 4096 } });
    expect(w.incomplete).toBe("limit-bytes");
    expect(w.tally.bytes).toBeLessThanOrEqual(4096);
    expect(w.entries.length).toBeGreaterThan(0);
  });

  test("a low read limit stops the v7.3 .set partway, with what it listed", async () => {
    const w = await walk("eeglab-data-v73.set", { limits: { maxReads: 2000 } });
    expect(w.incomplete).toBe("limit-reads");
    expect(w.tally.reads).toBe(2000);
    const all = oracle("eeglab-data-v73.set");
    expect(w.entries.length).toBeGreaterThan(all.length / 2);
    expect(w.entries.length).toBeLessThan(all.length);
  });

  test("the object limit ends the walk with limit-objects, at exactly that many entries", async () => {
    const w = await walk("snirf-samples-simple-probe.snirf", { limits: { maxObjects: 10 } });
    expect(w.incomplete).toBe("limit-objects");
    expect(w.entries).toHaveLength(10);
  });

  test("a dense group with more members than the object limit is refused before it is listed", async () => {
    // Homer3 writes /nirs/data1 with link creation order, so its members are dense links.
    const w = await walk("homer3-neuro-run02.snirf", { limits: { maxObjects: 10 } });
    expect(w.incomplete).toBe("limit-objects");
    expect(w.entries.some((e) => e.path.startsWith("/nirs/data1/"))).toBe(false);
  });

  test("the depth limit skips deeper groups and the walk goes on", async () => {
    const w = await walk("homer3-neuro-run02.snirf", { limits: { maxDepth: 1 } });
    expect(w.incomplete).toBe("limit-depth");
    expect(w.entries.some((e) => e.path === "/formatVersion")).toBe(true);
    expect(w.entries.some((e) => e.path === "/nirs")).toBe(true);
    expect(w.entries.some((e) => e.path.startsWith("/nirs/"))).toBe(false);
  });

  test("a group member patched to point at the root is visited once, and the walk ends", async () => {
    const bytes = load("snirf-samples-simple-probe.snirf");
    expect(bytes[8]).toBe(0); // superblock version 0: the root entry's header address is at 64
    const root = bytes.slice(64, 72);
    // The first symbol-table node is the root group's: point its first member at the root.
    const snod = Buffer.from(bytes).indexOf("SNOD");
    expect(snod).toBeGreaterThan(0);
    const patched = bytes.slice();
    patched.set(root, snod + 8 + 8);
    const w = await walkHdf5(source(patched));
    expect(w.complete).toBe(true);
    expect(w.entries.filter((e) => e.kind === "group" && e.path === "/")).toHaveLength(1);
    expect(w.entries.length).toBeLessThan(oracle("snirf-samples-simple-probe.snirf").length);
  });

  test("a failing source read ends the walk with read-failed and keeps the entries", async () => {
    const bytes = load("homer3-neuro-run02.snirf");
    let calls = 0;
    const w = await walkHdf5({
      size: bytes.length,
      read: async (o, l) => {
        calls += 1;
        if (calls > 40) throw new Error("connection reset");
        return bytes.slice(o, o + l);
      },
    });
    expect(w.incomplete).toBe("read-failed");
    expect(w.entries.length).toBeGreaterThan(0);
  });

  test("random bytes behind a valid signature: the walk always returns, never throws", async () => {
    const signature = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let seed = 1; seed <= 300; seed++) {
      const next = prng(seed);
      // Random bytes of the requested length at every offset; the first 8 are the signature, so
      // the decoders run on random superblocks, headers, B-trees and heaps.
      const started = performance.now();
      const w = await walkHdf5({
        size: 64 * 1024,
        read: async (offset, length) => {
          const out = new Uint8Array(length);
          for (let i = 0; i < length; i++) {
            const at = offset + i;
            out[i] = at < 8 ? (signature[at] as number) : next() & 0xff;
          }
          return out;
        },
      });
      expect(w.complete).toBe(false);
      expect(performance.now() - started).toBeLessThan(FUZZ_WALK_MS);
    }
  });

  test("random byte flips in a real SNIRF: the walk always returns, never throws", async () => {
    const bytes = load("snirf-samples-simple-probe.snirf");
    for (let seed = 1; seed <= 200; seed++) {
      const next = prng(seed);
      const flipped = bytes.slice();
      for (let i = 0; i < 64; i++) flipped[next() % 40_000] = next() & 0xff;
      const started = performance.now();
      const w = await walkHdf5(source(flipped));
      expect(Array.isArray(w.entries)).toBe(true);
      expect(performance.now() - started).toBeLessThan(FUZZ_WALK_MS);
    }
  });

  test("a shuffle filter whose element size disagrees with the type is corrupt, at once", async () => {
    const bytes = load("chunked-strings.h5");
    // Filter pipeline version 1: id, name length, flags, value count, the padded name, values.
    const name = Buffer.from(bytes).indexOf("shuffle\0");
    expect(name).toBeGreaterThan(8);
    const nameLength = (bytes[name - 6] as number) | ((bytes[name - 5] as number) << 8);
    const client = name + Math.ceil(nameLength / 8) * 8;
    expect(Array.from(bytes.slice(client, client + 4))).toEqual([4, 0, 0, 0]);
    const patched = bytes.slice();
    patched.set([0xff, 0xff, 0xff, 0xff], client);
    const started = performance.now();
    const w = await walkHdf5(source(patched));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(find(w, "/shuffled")).toMatchObject({ value: null, skipped: "error" });
    expect(find(w, "/labels").value).toHaveLength(40);
  });

  test("a datatype of zero bytes is corrupt", async () => {
    const bytes = load("chunked-strings.h5");
    // /shuffled's type: fixed-point, little-endian, signed, 4 bytes, offset 0, precision 32.
    const int32 = [0x10, 0x08, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00];
    const at = Buffer.from(bytes).indexOf(Buffer.from(int32));
    expect(at).toBeGreaterThan(0);
    const patched = bytes.slice();
    patched.set([0, 0, 0, 0], at + 4);
    const w = await walkHdf5(source(patched));
    expect(find(w, "/shuffled")).toMatchObject({ dtype: null, value: null, skipped: "error" });
  });

  test("an error no decoder foresaw is recorded as corrupt, with the entries so far", async () => {
    // A source that breaks its contract (no bytes at all) after 40 reads: the TypeError that
    // follows is not an Hdf5Problem, and it must still not escape walkHdf5.
    const bytes = load("homer3-neuro-run02.snirf");
    let calls = 0;
    const w = await walkHdf5({
      size: bytes.length,
      read: async (o, l) => {
        calls += 1;
        return (calls > 40 ? undefined : bytes.slice(o, o + l)) as Uint8Array;
      },
    });
    expect(w.incomplete).toBe("corrupt");
    expect(w.entries.length).toBeGreaterThan(0);
  });

  test("a file that is not HDF5 is corrupt, not a throw", async () => {
    const w = await walkHdf5(
      source(new TextEncoder().encode("not an hdf5 file at all, just text")),
    );
    expect(w).toMatchObject({ entries: [], complete: false, incomplete: "corrupt" });
  });
});
