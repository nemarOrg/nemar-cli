/**
 * The ZIP reader (`shared/readers/zip.ts`, card A6 of the publication-queue plan).
 *
 * The archives in `test/fixtures/zip/` were built with Info-ZIP `zip` from the repository's own
 * EDF fixtures (`test/fixtures/zip/README.md` records each command). Archives a stock tool cannot
 * make (a compression method it does not write, a split archive, tens of thousands of entries)
 * are built here by {@link buildZip}, byte for byte per PKWARE APPNOTE 6.3.10. Every archive is
 * read through the registry's page cache and limits, as the screen reads it, and its inner
 * entries through the registry's real readers.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EDF_READER,
  type FormatReader,
  LimitExceeded,
  PAGE_BYTES,
  READERS,
  type RangeSource,
  type ReaderLimits,
  ZIP_READER,
  bufferSource,
  cachedSource,
  companionsOf,
  formatCoverage,
  limitsFor,
  readerFor,
  readerMatch,
} from "../shared/identifier-readers";
import { readRecordings } from "../shared/identifier-report-builder";
import type { Finding } from "../shared/identifier-scan";
import { type ZipKit, createZipReader, readZipDirectory, scanZip } from "../shared/readers/zip";

const ZIPS = join(import.meta.dir, "fixtures", "zip");
const EDFS = join(import.meta.dir, "fixtures", "identifier-scan");
const BRAINVISION = join(import.meta.dir, "fixtures", "text-headers", "brainvision");
const load = (dir: string, name: string) => new Uint8Array(readFileSync(join(dir, name)));
const zip = (name: string) => load(ZIPS, name);
const FLAGGED = load(EDFS, "flagged.edf");

const ARCHIVE = "sourcedata/raw.zip";
const kinds = (findings: readonly Finding[]): string[] => findings.map((f) => f.kind).sort();
const has = (findings: readonly Finding[], kind: string) => findings.some((f) => f.kind === kind);

/** Read an archive as the screen does: the registry's ZIP reader over its page cache. */
async function scan(
  bytes: Uint8Array,
  options: { limits?: ReaderLimits; reader?: FormatReader; src?: RangeSource } = {},
) {
  const reader = options.reader ?? ZIP_READER;
  const limits = options.limits ?? reader.limits;
  const src = cachedSource(options.src ?? bufferSource(bytes), limits);
  const result = await reader.scan(src, ARCHIVE, limits);
  return { result, tally: src.tally, limited: src.limited };
}

/** The real registry's kit, with the inner registry replaced (to watch the paths it is handed). */
const kitWith = (inner: readonly FormatReader[]): ZipKit => ({
  inner: () => inner,
  cachedSource,
  limitsFor,
  readerMatch,
  companionsOf,
  formatCoverage,
  limitExceeded: () => new LimitExceeded(),
  pageBytes: PAGE_BYTES,
});
const INNER = READERS.filter((r) => r.id !== "zip");

/** The EDF findings the registry's EDF reader makes of these bytes, read directly. */
async function edfKinds(bytes: Uint8Array): Promise<string[]> {
  const src = cachedSource(bufferSource(bytes), EDF_READER.limits);
  return kinds((await EDF_READER.scan(src, "x.edf", EDF_READER.limits)).findings);
}

// ---------------------------------------------------------------------------------------
// A ZIP writer for archives a stock tool does not make
// ---------------------------------------------------------------------------------------

interface Spec {
  name: string;
  data?: Uint8Array;
  /** 0 stored (default), 8 deflate (compressed here), or any other method (data kept as is). */
  method?: number;
  flags?: number;
  /** The uncompressed size the headers declare, when it is not the data's. */
  declared?: number;
  /** Extra fields of the central directory entry (a ZIP64 field, say). */
  extra?: Uint8Array;
}

const enc = new TextEncoder();

/** An archive per APPNOTE 6.3.10: local headers and data, the central directory, the end record. */
function buildZip(
  specs: readonly Spec[],
  options: {
    disk?: number;
    /** The end record's entry counts (on this disk, in all), when they are not the real count. */
    count?: number;
    onDisk?: number;
    /** The end record's directory size, when it is not the real size. */
    size?: number;
    /** Bytes between the directory and the end record. */
    gap?: Uint8Array;
    /** Added to the directory offset the end record declares. */
    shift?: number;
  } = {},
): { bytes: Uint8Array; directoryOffset: number; directorySize: number } {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const spec of specs) {
    const name = enc.encode(spec.name);
    const data = spec.data ?? new Uint8Array(0);
    const method = spec.method ?? 0;
    const body = method === 8 ? Bun.deflateSync(data as Uint8Array<ArrayBuffer>) : data;
    const crc = Bun.hash.crc32(data);
    const declared = spec.declared ?? data.length;
    const flags = spec.flags ?? 0;
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, flags, true);
    l.setUint16(8, method, true);
    l.setUint16(12, 0x21, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, body.length, true);
    l.setUint32(22, declared, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);
    const extra = spec.extra ?? new Uint8Array(0);
    const entry = new Uint8Array(46 + name.length + extra.length);
    const c = new DataView(entry.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 0x031e, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, flags, true);
    c.setUint16(10, method, true);
    c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, body.length, true);
    c.setUint32(24, declared, true);
    c.setUint16(28, name.length, true);
    c.setUint16(30, extra.length, true);
    c.setUint32(42, offset, true);
    entry.set(name, 46);
    entry.set(extra, 46 + name.length);
    parts.push(local, body);
    central.push(entry);
    offset += local.length + body.length;
  }
  const directoryOffset = offset;
  const directorySize = central.reduce((n, e) => n + e.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(4, options.disk ?? 0, true);
  e.setUint16(6, options.disk ?? 0, true);
  e.setUint16(8, options.onDisk ?? options.count ?? specs.length, true);
  e.setUint16(10, options.count ?? specs.length, true);
  e.setUint32(12, options.size ?? directorySize, true);
  e.setUint32(16, directoryOffset + (options.shift ?? 0), true);
  const all = [...parts, ...central, options.gap ?? new Uint8Array(0), end];
  const bytes = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    bytes.set(p, at);
    at += p.length;
  }
  return { bytes, directoryOffset, directorySize };
}

// ---------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------

describe("registration", () => {
  test("a .zip is the ZIP reader's, and counts as a recording it reads, not as unscreened", () => {
    expect(readerFor("sourcedata/raw.zip")?.id).toBe("zip");
    expect(formatCoverage(["sourcedata/raw.zip"])).toEqual({
      byReader: { zip: 1 },
      unscreened: {},
    });
  });
});

// ---------------------------------------------------------------------------------------
// Real archives (Info-ZIP)
// ---------------------------------------------------------------------------------------

describe("archives built with Info-ZIP", () => {
  test("an inner EDF is read and its findings surface; an inner .xdf is counted zip:.xdf", async () => {
    const { result } = await scan(zip("edf-and-xdf.zip"));
    expect(result.coverage).toBe("complete");
    expect(result.unscreened).toEqual({ "zip:.xdf": 1 });
    // Every finding the EDF reader makes of the flagged header, read directly, is here.
    const direct = await edfKinds(FLAGGED);
    expect(direct).toContain("edf-patient-name");
    for (const kind of direct) expect(kinds(result.findings)).toContain(kind);
    expect(result.findings.filter((f) => f.severity === "identifier").length).toBeGreaterThan(0);
  });

  test("inner entries are named <archive>!/<entry>, for the path rules and the inner reader", async () => {
    const seen: string[] = [];
    const watched: FormatReader = {
      ...EDF_READER,
      scan: (src, path, limits) => {
        seen.push(path);
        return EDF_READER.scan(src, path, limits);
      },
    };
    const reader = createZipReader(kitWith([watched, ...INNER.filter((r) => r.id !== "edf")]));
    const { result } = await scan(zip("edf-and-xdf.zip"), { reader });
    expect(seen.sort()).toEqual([
      `${ARCHIVE}!/sub-02/eeg/sub-02_task-rest_eeg.edf`,
      `${ARCHIVE}!/sub-Marlow/eeg/sub-Marlow_task-rest_eeg.edf`,
    ]);
    // The name-like subject label inside the archive is a path finding.
    expect(has(result.findings, "path-subject-label")).toBe(true);
  });

  test("a stored entry is read as well as a deflated one", async () => {
    const { bytes } = buildZip([{ name: "a.edf", data: FLAGGED, method: 0 }]);
    const stored = await scan(bytes);
    expect(stored.result.coverage).toBe("complete");
    expect(kinds(stored.result.findings)).toEqual(await edfKinds(FLAGGED));
    const deflated = await scan(buildZip([{ name: "a.edf", data: FLAGGED, method: 8 }]).bytes);
    expect(kinds(deflated.result.findings)).toEqual(await edfKinds(FLAGGED));
  });

  test("a ZIP inside a ZIP is listed by name and counted zip:.zip, never opened", async () => {
    const { result } = await scan(zip("nested.zip"));
    expect(result.coverage).toBe("complete");
    expect(result.unscreened).toEqual({ "zip:.zip": 1 });
    // The inner archive holds the flagged header; one level only, so none of its findings.
    expect(has(result.findings, "edf-patient-name")).toBe(false);
  });

  test("a ZIP64 archive (zip -fz) is read through its ZIP64 end record", async () => {
    const bytes = zip("zip64.zip");
    const directory = await readZipDirectory(bufferSource(bytes), PAGE_BYTES);
    expect(directory.incomplete).toBeUndefined();
    expect(directory.entries.map((e) => e.name)).toEqual([
      "sub-Marlow/eeg/sub-Marlow_task-rest_eeg.edf",
    ]);
    const { result } = await scan(bytes);
    expect(result.coverage).toBe("complete");
    expect(has(result.findings, "edf-patient-name")).toBe(true);
  });

  test("an encrypted entry is partial (encrypted) and counted unscreened; its name is screened", async () => {
    const { result } = await scan(zip("encrypted.zip"));
    expect(result.coverage).toBe("partial");
    expect(result.incomplete).toBe("encrypted");
    expect(result.unscreened).toEqual({ "zip:.edf": 1 });
    expect(has(result.findings, "edf-patient-name")).toBe(false);
    expect(has(result.findings, "path-subject-label")).toBe(true);
  });

  test("a truncated archive is partial (corrupt), never complete", async () => {
    const bytes = zip("edf-and-xdf.zip");
    for (const cut of [bytes.length - 10, Math.floor(bytes.length / 2), 21]) {
      const { result } = await scan(bytes.subarray(0, cut));
      expect(result.coverage, String(cut)).toBe("partial");
      expect(result.incomplete, String(cut)).toBe("corrupt");
    }
  });

  test("a zip bomb (declares 1 KiB, inflates to 100 MiB) stops at the declared size: corrupt", async () => {
    // A budget of 1 MiB: if inflation ran past the declared size it would hit it, as `limit`.
    const limits = { ...ZIP_READER.limits, maxInflatedBytes: 1024 * 1024 };
    const { result, tally } = await scan(zip("bomb.zip"), { limits });
    expect(result.coverage).toBe("partial");
    expect(result.incomplete).toBe("corrupt");
    expect(tally.bytes).toBeLessThanOrEqual(zip("bomb.zip").length);
  });
});

// ---------------------------------------------------------------------------------------
// Which inner entries are read
// ---------------------------------------------------------------------------------------

describe("which inner entries are read", () => {
  test("a method other than stored or deflate is not read: counted zip:.edf, archive complete", async () => {
    const { result } = await scan(buildZip([{ name: "a.edf", data: FLAGGED, method: 12 }]).bytes);
    expect(result.coverage).toBe("complete");
    expect(result.unscreened).toEqual({ "zip:.edf": 1 });
    expect(has(result.findings, "edf-patient-name")).toBe(false);
  });

  test("an entry declaring more than 64 MiB is not read; exactly 64 MiB is", async () => {
    const MIB64 = 64 * 1024 * 1024;
    const at = (declared: number) =>
      scan(buildZip([{ name: "a.edf", data: FLAGGED, method: 8, declared }]).bytes);
    const over = await at(MIB64 + 1);
    expect(over.result.unscreened).toEqual({ "zip:.edf": 1 });
    expect(has(over.result.findings, "edf-patient-name")).toBe(false);
    const cap = await at(MIB64);
    expect(cap.result.unscreened).toBeUndefined();
    expect(has(cap.result.findings, "edf-patient-name")).toBe(true);
  });

  test("an inner reader's not-applicable counts the entry as zip:<ext>", async () => {
    const binary = new Uint8Array(2048);
    const { result } = await scan(
      buildZip([
        { name: "a.vhdr", data: binary },
        { name: "a.eeg", data: binary },
        { name: "a.vmrk", data: binary },
      ]).bytes,
    );
    expect(result.unscreened?.["zip:.vhdr"]).toBe(1);
    expect(result.coverage).toBe("complete");
  });

  test("an inner partial read makes the archive partial (a BrainVision header without its .eeg)", async () => {
    const vhdr = load(BRAINVISION, "test.vhdr");
    const vmrk = load(BRAINVISION, "test.vmrk");
    const lacking = await scan(
      buildZip([
        { name: "test.vhdr", data: vhdr, method: 8 },
        { name: "test.vmrk", data: vmrk, method: 8 },
      ]).bytes,
    );
    expect(lacking.result.coverage).toBe("partial");
    expect(lacking.result.incomplete).toBe("companion-missing");
    // Twin: with its signal file beside it, the pair is read completely.
    const whole = await scan(
      buildZip([
        { name: "test.vhdr", data: vhdr, method: 8 },
        { name: "test.vmrk", data: vmrk, method: 8 },
        { name: "test.eeg", data: new Uint8Array(64) },
      ]).bytes,
    );
    expect(whole.result.coverage).toBe("complete");
    expect(whole.result.unscreened).toBeUndefined();
    expect(has(whole.result.findings, "brainvision-segment-date")).toBe(true);
  });

  test("an inner reader's own partial read makes the archive partial, with its reason", async () => {
    // Not HDF5: the HDF5 reader reads it and returns partial (as at the top level).
    const notHdf5 = enc.encode("not an HDF5 file at all");
    const { result } = await scan(buildZip([{ name: "sub-01_eeg.hdf5", data: notHdf5 }]).bytes);
    const hdf5 = readerFor("x.hdf5") as FormatReader;
    const limits = limitsFor(hdf5, "x.hdf5");
    const direct = await hdf5.scan(cachedSource(bufferSource(notHdf5), limits), "x.hdf5", limits);
    expect(direct.coverage).toBe("partial");
    expect(result.coverage).toBe("partial");
    expect(result.incomplete).toBe(direct.incomplete);
  });

  test("a damaged deflate stream is partial (corrupt)", async () => {
    const good = buildZip([{ name: "a.edf", data: FLAGGED, method: 8 }]).bytes;
    const bad = good.slice();
    // The deflate data starts after the 30-byte local header and the 5-byte name.
    bad.fill(0xff, 35, 45);
    const { result } = await scan(bad);
    expect(result.coverage).toBe("partial");
    expect(result.incomplete).toBe("corrupt");
  });

  test("path rules inside an archive give one finding per kind, with the entries it stands for", async () => {
    const { result } = await scan(
      buildZip([
        ...Array.from({ length: 5 }, (_, i) => ({ name: `figures/fig${i}.png` })),
        { name: "notes/consent.pdf" },
        { name: "code/.DS_Store" },
        { name: "code/__pycache__/a.pyc" },
        { name: "sub-Marlow/a.txt" },
        { name: "sub-Quintavius/a.txt" },
      ]).bytes,
    );
    const path = result.findings.map((f) => [f.kind, f.entries]);
    expect(path).toEqual([
      ["image-or-document-file", 6],
      ["tooling-debris", 2],
      ["path-subject-label", 2],
    ]);
    // A count only: no entry name rides in a finding.
    expect(JSON.stringify(result)).not.toContain("consent");
    expect(JSON.stringify(result)).not.toContain("Marlow");
  });

  /** A ZIP64 extended-information field holding these 64-bit values. */
  const zip64Field = (...values: bigint[]) => {
    const field = new Uint8Array(4 + 8 * values.length);
    const v = new DataView(field.buffer);
    v.setUint16(0, 0x0001, true);
    v.setUint16(2, 8 * values.length, true);
    values.forEach((x, i) => v.setBigUint64(4 + 8 * i, x, true));
    return field;
  };

  test("a size of 0xFFFFFFFF whose ZIP64 value is 2^64-1 is corrupt and never reaches the inflater", async () => {
    // The EDF reader is watched: the entry must stop at the gate, before any inner read.
    const seen: string[] = [];
    const watched: FormatReader = {
      ...EDF_READER,
      scan: (src, path, limits) => {
        seen.push(path);
        return EDF_READER.scan(src, path, limits);
      },
    };
    const reader = createZipReader(kitWith([watched, ...INNER.filter((r) => r.id !== "edf")]));
    const { result } = await scan(
      buildZip([
        {
          name: "a.edf",
          data: FLAGGED,
          method: 8,
          declared: 0xffffffff,
          extra: zip64Field(0xffffffffffffffffn),
        },
      ]).bytes,
      { reader },
    );
    expect(seen).toEqual([]);
    expect(result.coverage).toBe("partial");
    expect(result.incomplete).toBe("corrupt");
    expect(result.unscreened).toBeUndefined();
  }, 2000);

  test("a 0xFFFFFFFF size with no ZIP64 field, or one too short, is corrupt, not a cap skip", async () => {
    const short = new Uint8Array([0x01, 0x00, 0x04, 0x00, 0, 0, 0, 0]);
    for (const extra of [undefined, short]) {
      const { result } = await scan(
        buildZip([{ name: "a.edf", data: FLAGGED, method: 8, declared: 0xffffffff, extra }]).bytes,
      );
      expect(result.coverage, String(extra?.length)).toBe("partial");
      expect(result.incomplete, String(extra?.length)).toBe("corrupt");
      expect(result.unscreened, String(extra?.length)).toBeUndefined();
    }
    // Twin: a ZIP64 field with the real size is read.
    const resolved = await scan(
      buildZip([
        {
          name: "a.edf",
          data: FLAGGED,
          method: 8,
          declared: 0xffffffff,
          extra: zip64Field(BigInt(FLAGGED.length)),
        },
      ]).bytes,
    );
    expect(resolved.result.coverage).toBe("complete");
    expect(has(resolved.result.findings, "edf-patient-name")).toBe(true);
  });

  test("macOS resource forks are screened by name and never read as recordings", async () => {
    const { result } = await scan(
      buildZip([{ name: "__MACOSX/sub-01/._sub-01_eeg.edf", data: new Uint8Array(300) }]).bytes,
    );
    expect(result.coverage).toBe("complete");
    expect(has(result.findings, "edf-unreadable")).toBe(false);
    expect(result.unscreened).toBeUndefined();
  });

  test("text, tables and documents in an archive are not unscreened; unknown raw files are", async () => {
    const { result } = await scan(
      buildZip([
        { name: "README.txt", data: enc.encode("x") },
        { name: "events.tsv", data: enc.encode("x") },
        { name: "raw/run1.cnt", data: enc.encode("x") },
        { name: "raw/run1.foo", data: enc.encode("x") },
      ]).bytes,
    );
    expect(result.unscreened).toEqual({ "zip:.cnt": 1, "zip:.foo": 1 });
  });

  test("the inflated bytes of an archive are capped: past the budget the archive is partial (limit)", async () => {
    const bytes = buildZip([
      { name: "a.edf", data: FLAGGED, method: 8 },
      { name: "b.edf", data: FLAGGED, method: 8 },
    ]).bytes;
    const limits = { ...ZIP_READER.limits, maxInflatedBytes: 600 };
    const { result } = await scan(bytes, { limits });
    expect(result.coverage).toBe("partial");
    expect(result.incomplete).toBe("limit");
    // Twin: under the default budget both are read.
    expect((await scan(bytes)).result.coverage).toBe("complete");
  });

  test("past the archive's time, the entries left are counted unscreened and the read is partial (time)", async () => {
    const bytes = buildZip([
      { name: "a.edf", data: FLAGGED },
      { name: "b.edf", data: FLAGGED },
    ]).bytes;
    let t = 0;
    const now = () => {
      const at = t;
      t += ZIP_READER.limits.timeMs;
      return at;
    };
    const src = cachedSource(bufferSource(bytes), ZIP_READER.limits);
    const result = await scanZip(src, ARCHIVE, ZIP_READER.limits, kitWith(INNER), now);
    expect(result.coverage).toBe("partial");
    expect(result.incomplete).toBe("time");
    expect(result.unscreened).toEqual({ "zip:.edf": 2 });
  });
});

// ---------------------------------------------------------------------------------------
// The central directory
// ---------------------------------------------------------------------------------------

describe("the central directory", () => {
  test("an archive whose entries all lack a reader costs at most its directory plus 64 KiB", async () => {
    const payload = new Uint8Array(1024).fill(7);
    const specs = Array.from({ length: 2000 }, (_, i) => ({
      name: `raw/run${i}.xdf`,
      data: payload,
    }));
    const { bytes, directorySize } = buildZip(specs);
    expect(bytes.length).toBeGreaterThan(directorySize + 3 * PAGE_BYTES);
    const { result, tally } = await scan(bytes);
    expect(result.coverage).toBe("complete");
    expect(result.unscreened).toEqual({ "zip:.xdf": 2000 });
    // The end record (22 bytes) rides on the last page with the directory's tail.
    expect(tally.bytes).toBeLessThanOrEqual(directorySize + 64 * 1024 + 22);
    // A small directory at the end of a large archive: the tail costs its last page only.
    const few = buildZip(
      Array.from({ length: 3 }, (_, i) => ({
        name: `raw/run${i}.xdf`,
        data: new Uint8Array(300 * 1024 + 7 * i),
      })),
    );
    const small = await scan(few.bytes);
    expect(small.result.unscreened).toEqual({ "zip:.xdf": 3 });
    expect(small.tally.bytes).toBeLessThanOrEqual(few.directorySize + 64 * 1024 + 22);
  });

  // The caps are the card's numbers, written out: a test that read them from the module would
  // move with them.
  test("more than 50,000 entries: partial (limit), the first ones still screened", async () => {
    const make = (n: number) =>
      buildZip(Array.from({ length: n }, (_, i) => ({ name: `sub-Marlow/f${i}.txt` }))).bytes;
    const over = await scan(make(50_001));
    expect(over.result.coverage).toBe("partial");
    expect(over.result.incomplete).toBe("limit");
    expect(has(over.result.findings, "path-subject-label")).toBe(true);
    const at = await scan(make(50_000));
    expect(at.result.coverage).toBe("complete");
  });

  test("a directory over 4 MiB: partial (limit)", async () => {
    const MIB4 = 4 * 1024 * 1024;
    const long = "x".repeat(200);
    const make = (n: number) =>
      buildZip(Array.from({ length: n }, (_, i) => ({ name: `${long}/f${i}.txt` })));
    const big = make(Math.ceil(MIB4 / 250) + 10);
    expect(big.directorySize).toBeGreaterThan(MIB4);
    expect(big.directorySize).toBeLessThan(MIB4 * 1.1);
    const over = await scan(big.bytes);
    expect(over.result.coverage).toBe("partial");
    expect(over.result.incomplete).toBe("limit");
    const small = make(Math.floor(MIB4 / 260));
    expect((await scan(small.bytes)).result.coverage).toBe("complete");
  });

  // Review round 1 of #2392: an end record that declares fewer entries than the directory holds
  // hides the rest. The hidden entry is a deflated EDF with identifier findings.
  test("entries the end record hides make the archive corrupt, never complete", async () => {
    const hidden: Spec[] = [
      { name: "README.txt", data: enc.encode("x") },
      { name: "sourcedata/a.edf", data: FLAGGED, method: 8 },
    ];
    const real = buildZip(hidden);
    expect((await scan(real.bytes)).result.coverage).toBe("complete");
    // Counts of 0, and of 1 of 2, with the real directory size: bytes left in the directory.
    for (const count of [0, 1]) {
      const { result } = await scan(buildZip(hidden, { count }).bytes);
      expect(result.coverage, String(count)).toBe("partial");
      expect(result.incomplete, String(count)).toBe("corrupt");
    }
    // A count of 1 and a size that covers only the first entry: a directory entry follows it.
    const first = 46 + "README.txt".length;
    const shrunk = await scan(buildZip(hidden, { count: 1, size: first }).bytes);
    expect(shrunk.result.coverage).toBe("partial");
    expect(shrunk.result.incomplete).toBe("corrupt");
  });

  // Review round 2 of #2392: the directory must end where its end record begins.
  test("the directory meets its end record exactly, or across a digital-signature record", async () => {
    const specs: Spec[] = [{ name: "sourcedata/a.edf", data: FLAGGED, method: 8 }];
    const junk = new Uint8Array(16).fill(0xab);
    const gapped = await scan(buildZip(specs, { gap: junk }).bytes);
    expect(gapped.result.coverage).toBe("partial");
    expect(gapped.result.incomplete).toBe("corrupt");
    // A directory placed before its declared offset (the end record points past its start).
    const size = buildZip(specs).directorySize;
    const before = await scan(buildZip(specs, { gap: junk, shift: junk.length, size }).bytes);
    expect(before.result.coverage).toBe("partial");
    expect(before.result.incomplete).toBe("corrupt");
    // Twin: a digital-signature record of its declared length is tolerated.
    const signature = new Uint8Array([0x50, 0x4b, 0x05, 0x05, 4, 0, 1, 2, 3, 4]);
    const signed = await scan(buildZip(specs, { gap: signature }).bytes);
    expect(signed.result.coverage).toBe("complete");
    expect(has(signed.result.findings, "edf-patient-name")).toBe(true);
    // A signature record whose declared length does not span the gap is junk.
    const short = new Uint8Array([0x50, 0x4b, 0x05, 0x05, 2, 0, 1, 2, 3, 4]);
    expect((await scan(buildZip(specs, { gap: short }).bytes)).result.incomplete).toBe("corrupt");
  });

  test("an end record whose entries-on-this-disk differs from the total is a split archive", async () => {
    const specs = [{ name: "a.edf", data: FLAGGED }];
    const { result } = await scan(buildZip(specs, { onDisk: 0 }).bytes);
    expect(result.coverage).toBe("partial");
    expect(result.incomplete).toBe("unsupported-version");
  });

  test("a split archive is partial (unsupported-version)", async () => {
    const { result } = await scan(buildZip([{ name: "a.edf", data: FLAGGED }], { disk: 1 }).bytes);
    expect(result.coverage).toBe("partial");
    expect(result.incomplete).toBe("unsupported-version");
  });

  test("an archive of unknown size is partial (limit): its end cannot be found", async () => {
    const bytes = zip("edf-and-xdf.zip");
    const unsized: RangeSource = { size: Number.POSITIVE_INFINITY, read: bufferSource(bytes).read };
    const { result } = await scan(bytes, { src: unsized });
    expect(result.coverage).toBe("partial");
    expect(result.incomplete).toBe("limit");
  });

  test("an empty archive is complete, with nothing found", async () => {
    const { result } = await scan(buildZip([]).bytes);
    expect(result).toEqual({ findings: [], coverage: "complete" });
  });
});

// ---------------------------------------------------------------------------------------
// Through the screen's own read
// ---------------------------------------------------------------------------------------

describe("through readRecordings", () => {
  const read = (bytes: Uint8Array | (() => RangeSource)) =>
    readRecordings({
      entries: [{ path: ARCHIVE, size: bytes instanceof Uint8Array ? bytes.length : 0 }],
      open: () => (bytes instanceof Uint8Array ? bufferSource(bytes) : bytes()),
      concurrency: 1,
      now: () => 0,
      datasetTimeMs: 60_000,
      failureClass: (e) => (e instanceof Error ? e.name : "unknown"),
    });

  test("the archive is a zip recording read; its unread entries are counted for the caller", async () => {
    const outcome = await read(zip("edf-and-xdf.zip"));
    expect(outcome.tallies.zip).toEqual({ files: 1, read: 1, partial: 0, failed: 0 });
    expect(outcome.notApplicable).toEqual({ "zip:.xdf": 1 });
    expect(has(outcome.findings, "edf-patient-name")).toBe(true);
  });

  test("an encrypted archive is a partial read with reason encrypted", async () => {
    const outcome = await read(zip("encrypted.zip"));
    expect(outcome.tallies.zip).toEqual({ files: 1, read: 0, partial: 1, failed: 0 });
    expect([...outcome.reasons]).toEqual(["encrypted"]);
  });

  test("a failed read of the archive itself is a failed read, never a clean one", async () => {
    // The EDF's data on the first page, the directory pages later: the tail reads, the entry fails.
    const { bytes } = buildZip([
      { name: "a.edf", data: FLAGGED },
      { name: "padding.xdf", data: new Uint8Array(3 * PAGE_BYTES) },
    ]);
    const inner = bufferSource(bytes);
    const failing = (): RangeSource => ({
      size: bytes.length,
      read: async (offset, length) => {
        if (offset < PAGE_BYTES) throw new Error("network");
        return inner.read(offset, length);
      },
    });
    const outcome = await read(failing);
    expect(outcome.tallies.zip).toEqual({ files: 1, read: 0, partial: 0, failed: 1 });
    // The archive's own read failure, by its own class.
    expect(outcome.failures).toEqual({ "zip/Error": 1 });
    // Twin: the same archive whole is read, with the EDF's findings.
    const whole = await read(bytes);
    expect(whole.tallies.zip.read).toBe(1);
    expect(has(whole.findings, "edf-patient-name")).toBe(true);
  });
});
