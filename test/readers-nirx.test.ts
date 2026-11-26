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
import { isPersonField } from "../shared/readers/person-fields";
import { TEXT_HEADER_MAX_BYTES, contactIn, decodeHeader } from "../shared/readers/text-header";

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

describe("nirx-demographics: birth dates by precision; an age alone is nothing", () => {
  const withBirth = (value: string) =>
    encode(text(CLEAN_INF).replace("Age=0", `Age=0\nDate of Birth="${value}"`));

  test("an Age= that is filled in fires nothing", async () => {
    expect(text(INF)).toContain("Age=30");
    const r = await scan(fixture(INF), `sourcedata/sub-01/${INF}`);
    expect(r).toEqual({ findings: [], coverage: "complete" });
  });

  test("a birth date to the day is an identifier, and direct", async () => {
    for (const value of ["14.03.1993", "1993-03-14", "14 Mar 1993"]) {
      const r = await scan(withBirth(value), "x.inf");
      expect(r.findings.map((f) => [f.kind, f.severity, f.field])).toEqual([
        ["nirx-demographics", "identifier", "birth date"],
      ]);
    }
    expect(DIRECT_KINDS.has("nirx-demographics")).toBe(true);
  });

  test("a year, or a year and month, is review", async () => {
    for (const value of ["1993", "01.01.1993", "1993-03", "March 1993"]) {
      const r = await scan(withBirth(value), "x.inf");
      expect(r.findings.map((f) => [f.kind, f.severity])).toEqual([
        ["nirx-demographics", "review"],
      ]);
    }
  });

  test("an empty or placeholder birth date fires nothing", async () => {
    for (const value of ["", "0", "n/a", "unknown", "00.00.0000"]) {
      expect(kinds(await scan(withBirth(value), "x.inf"))).toEqual([]);
    }
  });

  test("NIRSport2's age in the header's experiment notes fires nothing", async () => {
    const name = "2025-10-29_002_config.hdr";
    expect(text(name)).toContain("experiment_subject_age=36");
    const r = await scan(fixture(name), `sourcedata/sub-01/${name}`);
    expect(r.coverage).toBe("complete");
    expect(r.findings.map((f) => [f.kind, f.field])).toEqual([["nirx-header-date", "Date"]]);
  });
});

describe("contact and notes text", () => {
  test("an email address or a phone number in Contact Information is nirx-freetext (review)", async () => {
    for (const value of ["q.hollberry@example.org", "+1 858 555 0100", "phone: 858 555 0100"]) {
      const edited = text(CLEAN_INF).replace(
        'Contact Information=""',
        `Contact Information="${value}"`,
      );
      const r = await scan(encode(edited), "x.inf");
      expect(r.findings.map((f) => [f.kind, f.severity, f.field])).toEqual([
        ["nirx-freetext", "review", "Contact Information"],
      ]);
      expect(JSON.stringify(r)).not.toContain("hollberry");
    }
  });

  test("a home path in the header's Notes is local-user-path", async () => {
    const edited = text(HDR).replace(
      'Notes="[Type notes here]"',
      'Notes="see C:\\Users\\Quintavius\\notes.txt"',
    );
    const r = await scan(encode(edited), `sourcedata/sub-01/${HDR}`);
    expect(r.findings.map((f) => [f.kind, f.field])).toEqual([
      ["nirx-header-date", "Date"],
      ["local-user-path", "Notes"],
    ]);
  });

  test("a name in a notes field is not a person field's, so it fires nothing", async () => {
    const edited = text(CLEAN_INF).replace(
      'Additional Notes=""',
      'Additional Notes="Quintavius Hollberry"',
    );
    expect(kinds(await scan(encode(edited), "x.inf"))).toEqual([]);
  });

  test("an operator is a person field; the experiment's name is not", async () => {
    const operator = text(CLEAN_INF).replace("Age=0", 'Age=0\nOperator="Quintavius Hollberry"');
    expect(kinds(await scan(encode(operator), "x.inf"))).toEqual(["nirx-subject-name"]);
    const nirsport = text("2025-10-29_002_config.hdr");
    expect(nirsport).toContain("experiment_name=Fingertapping");
    const r = await scan(fixture("2025-10-29_002_config.hdr"), "x_config.hdr");
    expect(kinds(r)).toEqual(["nirx-header-date"]);
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
  test("a FileName= that is not the header's own base name is a note on a complete read", async () => {
    const r = await scan(fixture(HDR), "sourcedata/sub-01/sub-01_task-tap_nirs.hdr");
    expect(r.coverage).toBe("complete");
    expect(r.notes).toEqual(["companion-name-mismatch"]);
    expect(kinds(r)).toEqual(["nirx-header-date"]);
  });

  test("a real Analyze .hdr (nibabel) is not-applicable: binary, with no NIRx section", async () => {
    const analyze = new Uint8Array(readFileSync(join(DIR, "../analyze/analyze.hdr")));
    expect(analyze.length).toBe(348);
    expect(await scan(analyze, "sourcedata/anat/t1.hdr")).toEqual({
      findings: [],
      coverage: "not-applicable",
    });
  });

  test("text with no NIRx section is screened as free text and is partial, never not-applicable", async () => {
    const driver = '[Version]\nSignature="$Windows NT$"\n';
    expect(await scan(encode(driver), "x.inf")).toEqual({
      findings: [],
      coverage: "partial",
      incomplete: "unsupported-version",
    });
    const hidden = "[Info]\nContact=q.hollberry@example.org\n";
    const r = await scan(encode(hidden), "x.hdr");
    expect(r.coverage).toBe("partial");
    expect(kinds(r)).toEqual(["nirx-freetext"]);
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

  test("an Analyze .hdr is unscreened under .hdr: in no tally, no companions, never unchecked", async () => {
    const t1 = "sourcedata/anat/t1.hdr";
    files[t1] = new Uint8Array(readFileSync(join(DIR, "../analyze/analyze.hdr")));
    const out = await read([t1, "sourcedata/anat/t1.img"]);
    expect(out.tallies.nirx).toEqual({ files: 0, read: 0, partial: 0, failed: 0 });
    expect(out.notApplicable).toEqual({ ".hdr": 1 });
    expect(out.companionMissing).toBe(0);
    expect([...out.reasons]).toEqual([]);
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
    for (const kind of [
      "nirx-subject-name",
      "nirx-demographics",
      "nirx-header-date",
      "nirx-freetext",
    ] as const) {
      const copy = KIND_COPY[kind];
      expect(copy.statement.length).toBeGreaterThan(20);
      expect(copy.read).toContain("NIRx");
      expect(copy.remedy.length).toBeGreaterThan(10);
      expect(copy.anchor).toBe(`kind-${kind}`);
    }
  });
});

/** UTF-16 bytes of some text, little- or big-endian, with a byte-order mark. */
function utf16(textValue: string, endian: "le" | "be"): Uint8Array {
  const out = new Uint8Array(2 + 2 * textValue.length);
  out.set(endian === "le" ? [0xff, 0xfe] : [0xfe, 0xff], 0);
  for (let i = 0; i < textValue.length; i++) {
    const c = textValue.charCodeAt(i);
    const [lo, hi] = [c & 0xff, c >> 8];
    out.set(endian === "le" ? [lo, hi] : [hi, lo], 2 + 2 * i);
  }
  return out;
}

describe("review round 1: no not-applicable evasion, encodings, bounds", () => {
  const path = `sourcedata/sub-01/${HDR}`;

  test("a leading comment line, or [GeneralInfo] after another section, is still a header", async () => {
    for (const body of [`; exported\n${text(HDR)}`, `[Preamble]\nx=1\n${text(HDR)}`]) {
      const r = await scan(encode(body), path);
      expect(r.coverage).toBe("complete");
      expect(kinds(r)).toEqual(["nirx-header-date"]);
    }
  });

  test("a leading NUL hides nothing", async () => {
    const r = await scan(new Uint8Array([0, ...fixture(HDR)]), path);
    expect(r.coverage).toBe("complete");
    expect(kinds(r)).toEqual(["nirx-header-date"]);
    const inf = await scan(new Uint8Array([0, ...fixture("edited-name.inf")]), "x.inf");
    expect(kinds(inf)).toEqual(["nirx-subject-name"]);
  });

  test("a UTF-16 file, either byte order, is read like its UTF-8 twin", async () => {
    for (const endian of ["le", "be"] as const) {
      const r = await scan(utf16(text(HDR), endian), path);
      expect(r.coverage).toBe("complete");
      expect(kinds(r)).toEqual(["nirx-header-date"]);
      expect(kinds(await scan(utf16(text("edited-name.inf"), endian), "x.inf"))).toEqual([
        "nirx-subject-name",
      ]);
    }
  });

  test("a 1 MiB single-word contact value finishes within 1 s, partial (limit)", async () => {
    for (const word of ["a", "x@", "+1 ", "tel 1 ", "C:\\Users\\"]) {
      const value = word.repeat(Math.ceil(TEXT_HEADER_MAX_BYTES / word.length));
      const bytes = encode(
        text(CLEAN_INF).replace('Contact Information=""', `Contact Information="${value}"`),
      );
      const started = performance.now();
      const r = await scan(bytes, "x.inf");
      expect(performance.now() - started).toBeLessThan(1000);
      expect(r.coverage).toBe("partial");
      expect(r.incomplete).toBe("limit");
    }
  });

  test("a value past 4 KiB in a small file is cut, and the read says partial (limit)", async () => {
    const value = "a".repeat(5000);
    const bytes = encode(
      text(CLEAN_INF).replace('Contact Information=""', `Contact Information="${value}"`),
    );
    expect(bytes.length).toBeLessThan(TEXT_HEADER_MAX_BYTES);
    const r = await scan(bytes, "x.inf");
    expect(r).toEqual({ findings: [], coverage: "partial", incomplete: "limit" });
  });
});

describe("review round 1: the shared text helpers", () => {
  test("the email rule reads a window around each @, so a huge value stays fast", () => {
    const value = `${"a".repeat(TEXT_HEADER_MAX_BYTES)}@`;
    const started = performance.now();
    expect(contactIn(value)).toBeNull();
    expect(contactIn(`${"a".repeat(100)}@example.org`)).toBe("email");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a UTF-16 byte-order mark decodes text that is not mostly ASCII", () => {
    const words = "名前データ".repeat(200);
    for (const endian of ["le", "be"] as const) {
      expect(decodeHeader(utf16(words, endian))).toBe(words);
    }
  });
});

describe("review round 2: not-applicable needs binary bytes, no section name and no key", () => {
  const glue = (prefix: Uint8Array, body: string) => new Uint8Array([...prefix, ...encode(body)]);
  const ctrl = new Uint8Array(100).fill(1);
  const nul = new Uint8Array(600);

  test("100 control bytes before [SUBJECT DEMOGRAPHICS] with a name: the name is found", async () => {
    const r = await scan(
      glue(ctrl, "[SUBJECT DEMOGRAPHICS]\nName=Quintavius Hollberry\n"),
      "x.inf",
    );
    expect(r.coverage).toBe("complete");
    expect(kinds(r)).toEqual(["nirx-subject-name"]);
  });

  test("an .hdr with [ExperimentNotes] and no [GeneralInfo], binary start: findings, partial", async () => {
    for (const prefix of [ctrl, nul]) {
      const r = await scan(glue(prefix, "[ExperimentNotes]\nName=Quintavius Hollberry\n"), "x.hdr");
      expect(r.coverage).toBe("partial");
      expect(r.incomplete).toBe("unsupported-version");
      expect(kinds(r)).toEqual(["nirx-subject-name"]);
    }
  });

  test("a binary start with only a Name= or Contact key and no section is still scanned", async () => {
    const named = await scan(glue(nul, "Name=Quintavius Hollberry\n"), "x.inf");
    expect(named.coverage).toBe("partial");
    expect(kinds(named)).toEqual(["nirx-subject-name"]);
    const contact = await scan(glue(nul, "Contact Information=q.hollberry@example.org\n"), "x.hdr");
    expect(kinds(contact)).toEqual(["nirx-freetext"]);
  });

  test("a binary start naming any NIRx section in another case is scanned", async () => {
    const r = await scan(glue(nul, "imagingparameters\n"), "x.hdr");
    expect(r).toEqual({ findings: [], coverage: "partial", incomplete: "unsupported-version" });
  });
});

describe("one person-field rule for every reader (shared/readers/person-fields.ts)", () => {
  const withLine = (line: string) => encode(text(CLEAN_INF).replace("Age=0", `Age=0\n${line}`));

  test("a NIRx ManufacturerName is a thing's name; an ExperimenterName is a person's", async () => {
    expect(isPersonField("ManufacturerName")).toBe(false);
    expect(kinds(await scan(withLine('ManufacturerName="Quintavius Hollberry"'), "x.inf"))).toEqual(
      [],
    );
    expect(isPersonField("ExperimenterName")).toBe(true);
    expect(kinds(await scan(withLine('ExperimenterName="Quintavius Hollberry"'), "x.inf"))).toEqual(
      ["nirx-subject-name"],
    );
  });

  test("a NIRx Notes field gets the free-text rules only: a name is not a finding, a home path is", async () => {
    expect(isPersonField("Notes")).toBe(false);
    expect(kinds(await scan(withLine('Notes="Quintavius Hollberry"'), "x.inf"))).toEqual([]);
    expect(kinds(await scan(withLine('Notes="C:\\Users\\Quintavius\\x.txt"'), "x.inf"))).toEqual([
      "local-user-path",
    ]);
  });

  test("a bare Name is the subject's in NIRx demographics and an object's in HDF5", () => {
    expect(isPersonField("Name", { bareName: "person" })).toBe(true);
    expect(isPersonField("Name")).toBe(false);
  });
});
