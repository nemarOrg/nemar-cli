/**
 * The NIRx reader (epic #2182, phase A2): real NIRStar and NIRSport2 headers and `.inf` files
 * (`test/fixtures/text-headers/`, provenance in its README), read through the registry, the page
 * cache and the screen's own `readRecordings`, with the registered readers (no stand-in reader).
 * Edits a test needs beyond the committed edited fixture are made in memory from a real file.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  READERS,
  bufferSource,
  cachedSource,
  formatCoverage,
  readerFor,
} from "../shared/identifier-readers";
import { classifyDataset, readRecordings } from "../shared/identifier-report-builder";
import { DATE_KINDS, DIRECT_KINDS } from "../shared/identifier-scan";
import { KIND_COPY } from "../shared/identifier-screen-copy";
import { NIRX_READER } from "../shared/readers/nirx";
import { TEXT_HEADER_MAX_BYTES } from "../shared/readers/text-header";

const DIR = join(import.meta.dir, "fixtures/text-headers/nirx");
const fixture = (name: string) => new Uint8Array(readFileSync(join(DIR, name)));
const text = (name: string) => new TextDecoder().decode(fixture(name));
const encode = (s: string) => new TextEncoder().encode(s);

async function scan(bytes: Uint8Array, path: string) {
  const r = NIRX_READER;
  return r.scan(cachedSource(bufferSource(bytes), r.limits), path, r.limits);
}

const kinds = (result: { findings: { kind: string }[] }) => result.findings.map((f) => f.kind);
const HDR = "NIRS-2019-10-02_003.hdr";
const INF = "NIRS-2019-10-02_003.inf";
const CLEAN_INF = "NIRS-2020-12-02_018.inf";

describe("the NIRx reader is registered", () => {
  test("it reads .hdr and .inf, and never the signal files", () => {
    expect(READERS).toContain(NIRX_READER);
    expect(readerFor("sourcedata/sub-01/NIRS-2019-10-02_003.hdr")?.id).toBe("nirx");
    expect(readerFor("sourcedata/sub-01/NIRS-2019-10-02_003.inf")?.id).toBe("nirx");
    for (const ext of [".wl1", ".wl2", ".dat", ".evt"]) {
      expect(readerFor(`sourcedata/sub-01/NIRS-2019-10-02_003${ext}`)).toBeNull();
    }
    expect(NIRX_READER.limits.maxBytes).toBe(TEXT_HEADER_MAX_BYTES);
  });
});

describe("a clean real file gives no finding", () => {
  test("an .inf with a test label and Age=0", async () => {
    const r = await scan(fixture(CLEAN_INF), `sourcedata/sub-01/${CLEAN_INF}`);
    expect(r).toEqual({ findings: [], coverage: "complete" });
  });
});

describe("nirx-subject-name", () => {
  test("a made-up name in Name= is an identifier, shaped not quoted", async () => {
    const r = await scan(fixture("edited-name.inf"), `sourcedata/sub-01/${CLEAN_INF}`);
    expect(r.coverage).toBe("complete");
    expect(r.findings.map((f) => [f.kind, f.severity, f.field])).toEqual([
      ["nirx-subject-name", "identifier", "Name"],
    ]);
    expect(DIRECT_KINDS.has("nirx-subject-name")).toBe(true);
    expect(JSON.stringify(r)).not.toContain("Quintavius");
  });

  test("the BIDS subject label of the path, a code or nothing is no name", async () => {
    const base = text(CLEAN_INF);
    const cases: [string, string][] = [
      ["Hollberry", "sourcedata/sub-hollberry/x.inf"],
      ["sub-Hollberry", "sourcedata/sub-Hollberry/x.inf"],
      ["P07", "sourcedata/sub-01/x.inf"],
      ["", "sourcedata/sub-01/x.inf"],
      ["NIRxAllTasks-2-1", "sourcedata/sub-01/x.inf"],
    ];
    for (const [name, path] of cases) {
      const r = await scan(encode(base.replace('Name="No_saturation"', `Name="${name}"`)), path);
      expect(kinds(r)).toEqual([]);
    }
    // The same name under another subject's path is a name.
    const other = encode(base.replace('Name="No_saturation"', 'Name="Hollberry"'));
    expect(kinds(await scan(other, "sourcedata/sub-01/x.inf"))).toEqual(["nirx-subject-name"]);
  });
});

describe("nirx-demographics", () => {
  test("an Age= that is filled in is review", async () => {
    const r = await scan(fixture(INF), `sourcedata/sub-01/${INF}`);
    expect(r.findings.map((f) => [f.kind, f.severity, f.field])).toEqual([
      ["nirx-demographics", "review", "Age"],
    ]);
    expect(DIRECT_KINDS.has("nirx-demographics")).toBe(false);
  });

  test("Age= empty, 0 or a placeholder fires nothing", async () => {
    const base = text(INF);
    for (const age of ["", "0", "0.0", "n/a", "-"]) {
      const r = await scan(encode(base.replace("Age=30", `Age=${age}`)), "x.inf");
      expect(kinds(r)).toEqual([]);
    }
  });

  test("a birth date finer than the year fires; a year-only one does not", async () => {
    const base = text(CLEAN_INF);
    const dated = base.replace("Age=0", 'Age=0\nDate of Birth="14.03.1993"');
    expect(kinds(await scan(encode(dated), "x.inf"))).toEqual(["nirx-demographics"]);
    const year = base.replace("Age=0", 'Age=0\nDate of Birth="01.01.1993"');
    expect(kinds(await scan(encode(year), "x.inf"))).toEqual([]);
  });

  test("NIRSport2 keeps the subject's age in the header's experiment notes", async () => {
    const name = "2025-10-29_002_config.hdr";
    const r = await scan(fixture(name), `sourcedata/sub-01/${name}`);
    expect(r.coverage).toBe("complete");
    expect(r.findings.map((f) => [f.kind, f.field])).toEqual([
      ["nirx-header-date", "Date"],
      ["nirx-demographics", "experiment_subject_age"],
    ]);
  });
});

describe("nirx-header-date", () => {
  test("NIRStar's Date= is a date kind", async () => {
    const r = await scan(fixture(HDR), `sourcedata/sub-01/${HDR}`);
    expect(r).toMatchObject({ coverage: "complete" });
    expect(r.findings.map((f) => [f.kind, f.severity, f.field])).toEqual([
      ["nirx-header-date", "review", "Date"],
    ]);
    expect(DATE_KINDS.has("nirx-header-date")).toBe(true);
    expect(
      classifyDataset({
        findings: r.findings,
        recordings: 1,
        recordingsRead: 1,
        unscreenedCount: 0,
        incompleteReasons: [],
      }),
    ).toBe("dates-only");
  });

  test("an empty or year-only Date= fires nothing; one the scanner cannot parse does", async () => {
    const base = text(HDR);
    const date = 'Date="Wed, Oct 2, 2019"';
    expect(base).toContain(date);
    for (const value of ['Date=""', "Date=2019", 'Date="Tue, Jan 1, 2019"']) {
      expect(kinds(await scan(encode(base.replace(date, value)), HDR))).toEqual([]);
    }
    for (const value of ['Date="mer. 2 déc. 2020"', "Date=2025-10-29 11:37:52.507944"]) {
      expect(kinds(await scan(encode(base.replace(date, value)), HDR))).toEqual([
        "nirx-header-date",
      ]);
    }
  });
});

describe("FileName, companions and coverage", () => {
  test("a FileName= that is not the header's own base name is partial (companion-missing)", async () => {
    const r = await scan(fixture(HDR), "sourcedata/sub-01/sub-01_task-tap_nirs.hdr");
    expect(r.coverage).toBe("partial");
    expect(r.incomplete).toBe("companion-missing");
    expect(kinds(r)).toEqual(["nirx-header-date"]);
  });

  test("an .hdr that is not a NIRx header is partial, never clean", async () => {
    const analyze = new Uint8Array(348);
    new DataView(analyze.buffer).setInt32(0, 348, true);
    expect(await scan(analyze, "sourcedata/anat/t1.hdr")).toEqual({
      findings: [],
      coverage: "partial",
      incomplete: "unsupported-version",
    });
    expect(await scan(encode("[Other]\nx=1\n"), "x.inf")).toEqual({
      findings: [],
      coverage: "partial",
      incomplete: "unsupported-version",
    });
  });

  test("past 1 MiB the read is partial (limit) and keeps what it found", async () => {
    const big = `${text(HDR)}\n${"; padding\n".repeat(Math.ceil(TEXT_HEADER_MAX_BYTES / 10))}`;
    const r = await scan(encode(big), `sourcedata/sub-01/${HDR}`);
    expect(r.coverage).toBe("partial");
    expect(r.incomplete).toBe("limit");
    expect(kinds(r)).toEqual(["nirx-header-date"]);
  });

  const D = "sourcedata/sub-01/nirs/";
  const B = `${D}NIRS-2019-10-02_003`;
  const files: Record<string, Uint8Array> = {
    [`${B}.hdr`]: fixture(HDR),
    [`${B}.inf`]: fixture(CLEAN_INF),
  };

  async function read(paths: string[]) {
    const entries = paths
      .filter((p) => readerFor(p) !== null)
      .map((path) => ({ path, size: files[path]?.length ?? 0 }));
    return readRecordings({
      entries,
      paths,
      open: (entry) => bufferSource(files[entry.path] as Uint8Array),
      concurrency: 2,
      now: () => 0,
      datasetTimeMs: 60_000,
      failureClass: () => "internal",
    });
  }

  test("a header with .wl1 and .wl2 is read, and its .dat, .evt and .inf are claimed", async () => {
    const all = [`${B}.hdr`, `${B}.inf`, `${B}.wl1`, `${B}.wl2`, `${B}.dat`, `${B}.evt`];
    const out = await read(all);
    expect(out.tallies.nirx).toEqual({ files: 2, read: 2, partial: 0, failed: 0 });
    expect(out.companionMissing).toBe(0);
    expect(formatCoverage(all)).toEqual({ byReader: { nirx: 2 }, unscreened: {} });
  });

  test("a missing .wl2 is companion_missing, never clean", async () => {
    const out = await read([`${B}.hdr`, `${B}.inf`, `${B}.wl1`]);
    expect(out.companionMissing).toBe(1);
    expect([...out.reasons]).toEqual(["companion-missing"]);
    expect(out.tallies.nirx.partial).toBe(1);
  });

  test("a .dat no header pairs with stays unscreened", () => {
    expect(formatCoverage([`${D}other.dat`]).unscreened).toEqual({ ".dat": 1 });
    expect(formatCoverage([`${D}other.dat`, `${B}.hdr`]).unscreened).toEqual({ ".dat": 1 });
  });

  test("an orphan .inf needs its header", () => {
    expect(NIRX_READER.companions?.(`${B}.inf`, new Set([`${B}.inf`]))).toEqual({
      claimed: [],
      missing: [`${B}.hdr`],
    });
  });

  test("NIRSport2's base name drops _config", () => {
    const hdr = `${D}2025-10-29_002_config.hdr`;
    const check = NIRX_READER.companions?.(
      hdr,
      new Set([hdr, `${D}2025-10-29_002.wl1`, `${D}2025-10-29_002.wl2`]),
    );
    expect(check).toEqual({
      claimed: [`${D}2025-10-29_002.wl1`, `${D}2025-10-29_002.wl2`],
      missing: [],
    });
  });
});

describe("every new kind has its words", () => {
  test("statement, read, remedy and anchor", () => {
    for (const kind of ["nirx-subject-name", "nirx-demographics", "nirx-header-date"] as const) {
      const copy = KIND_COPY[kind];
      expect(copy.statement.length).toBeGreaterThan(20);
      expect(copy.read).toContain("NIRx");
      expect(copy.remedy.length).toBeGreaterThan(10);
      expect(copy.anchor).toBe(`kind-${kind}`);
    }
  });
});
