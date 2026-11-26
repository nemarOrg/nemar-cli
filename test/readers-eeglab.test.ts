/**
 * The EEGLAB `.set` reader (`shared/readers/eeglab.ts`, card A5 of the publication-queue plan),
 * and the companion its content names (`ReaderResult.needs`).
 *
 * The files read here are real public `.set` files, or copies with made-up values
 * (`test/fixtures/mat/README.md`): classic with an `.fdt`, classic with the signal inside, and
 * v7.3. Rules over a single field are also checked on arrays built here, each with a twin that
 * differs in one thing. Files are read through the registry's page cache and limits.
 *
 * CI TIER: unit-pure. Offline.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LimitExceeded,
  READERS,
  type RangeSource,
  ReadFailure,
  type ReaderLimits,
  bufferSource,
  cachedSource,
  companionsOf,
  namedCompanionsMissing,
  readerFor,
} from "../shared/identifier-readers";
import { readRecordings } from "../shared/identifier-report-builder";
import { DIRECT_KINDS, type Finding } from "../shared/identifier-scan";
import { KIND_COPY } from "../shared/identifier-screen-copy";
import type { MatEntry } from "../shared/mat-meta";
import {
  EEGLAB_READER,
  fdtNamed,
  personNameIn,
  scanEeglabEntries,
  withoutPaths,
} from "../shared/readers/eeglab";
import { MAT_READER_LIMITS, matResult, walkMatForReader } from "../shared/readers/mat-generic";
import { screenLocalDataset } from "../src/lib/dataset-screen";
import { Repo, cleanScratch } from "./helpers/dataset-screen-fixture";

afterAll(cleanScratch);

const MAT = join(import.meta.dir, "fixtures", "mat");
const HDF5 = join(import.meta.dir, "fixtures", "hdf5");
const load = (dir: string, name: string) => new Uint8Array(readFileSync(join(dir, name)));
const PATH = "sub-01/eeg/sub-01_task-rest_eeg.set";

/** Scan bytes through the registry's page cache, recording every range asked. */
async function scan(bytes: Uint8Array, options: { path?: string; limits?: ReaderLimits } = {}) {
  const limits = options.limits ?? EEGLAB_READER.limits;
  const cached = cachedSource(bufferSource(bytes), limits);
  const result = await EEGLAB_READER.scan(cached, options.path ?? PATH, limits);
  return { result, cached };
}

const kinds = (findings: Finding[]) => findings.map((f) => `${f.kind}/${f.severity}`).sort();

/** One array, as the walker lists it. */
const char = (fields: string[], ...rows: string[]): MatEntry => ({
  fields,
  class: "char",
  dims: [rows.length, rows[0]?.length ?? 0],
  value: rows,
});

describe("registration", () => {
  test(".set is EEGLAB's, and claims the .fdt beside it", () => {
    expect(readerFor("sub-01/eeg/a.SET")?.id).toBe("eeglab");
    expect(READERS).toContain(EEGLAB_READER);
    const { claimed, missing } = companionsOf(["a/x.set", "a/x.fdt", "a/y.set"]);
    expect([...claimed]).toEqual(["a/x.fdt"]);
    // Whether a .set needs a .fdt is its content's to say, so no pairing by name is missing.
    expect(missing.size).toBe(0);
  });

  test("every new kind has its copy, and the identifier kinds are direct", () => {
    for (const k of [
      "eeglab-subject-name",
      "eeglab-subject-freetext",
      "eeglab-event-name",
      "eeglab-history-name",
    ] as const) {
      expect(KIND_COPY[k].anchor).toBe(`kind-${k}`);
    }
    expect(DIRECT_KINDS.has("eeglab-subject-name")).toBe(true);
    expect(DIRECT_KINDS.has("eeglab-subject-freetext")).toBe(false);
    expect(DIRECT_KINDS.has("eeglab-event-name")).toBe(false);
  });
});

describe("real files", () => {
  test("the real classic and v7.3 files are complete and hold no finding", async () => {
    for (const [dir, name] of [
      [MAT, "eeglab-data.set"],
      [MAT, "sub-001_task-Rest_eeg.set"],
      [HDF5, "eeglab-data-v73.set"],
    ] as const) {
      const { result, cached } = await scan(load(dir, name));
      expect(result.coverage, name).toBe("complete");
      expect(cached.limited).toBe(false);
      expect(result.findings, name).toEqual([]);
    }
  });

  test("a made-up name in subject fires in both formats; a home path in filepath does not", async () => {
    for (const name of ["eeglab-data-edited.set", "eeglab-data-v73-edited.set"]) {
      const { result } = await scan(load(MAT, name));
      expect(result.coverage, name).toBe("complete");
      expect(result.findings, name).toEqual([
        expect.objectContaining({
          kind: "eeglab-subject-name",
          severity: "identifier",
          field: "eeglab.subject",
        }),
      ]);
    }
  });

  test("a finding repeated across an event table is one finding with its count", async () => {
    const entries = Array.from({ length: 5 }, () => char(["event", "type"], "Quillfeather Marlow"));
    const result = matResult(scanEeglabEntries(entries, PATH), { format: "v5", entries });
    expect(result.findings).toEqual([
      expect.objectContaining({ kind: "eeglab-event-name", occurrences: 5 }),
    ]);
  });

  test("findings carry shapes and fixed field words, never a value", async () => {
    const { result } = await scan(load(MAT, "eeglab-data-edited.set"));
    const text = JSON.stringify(result);
    expect(text).not.toContain("Quillfeather");
    expect(text).not.toContain("qmarlow");
  });

  test("the .fdt the content names is needed; a set with its signal inside needs none", async () => {
    expect((await scan(load(MAT, "eeglab-data.set"))).result.needs).toEqual(["eeglab_data.fdt"]);
    expect((await scan(load(HDF5, "eeglab-data-v73.set"))).result.needs).toEqual([
      "eeglab_data.fdt",
    ]);
    expect((await scan(load(MAT, "sub-001_task-Rest_eeg.set"))).result.needs).toBeUndefined();
  });
});

describe("partial and failed reads", () => {
  test("a file cut short is partial (corrupt), never clean or failed", async () => {
    const bytes = load(MAT, "eeglab-data-edited.set");
    for (const at of [200, 5000, bytes.length - 64]) {
      const { result } = await scan(bytes.subarray(0, at));
      expect(result.coverage).toBe("partial");
      expect(result.incomplete).toBe("corrupt");
    }
  });

  test("a file that is another format is not-applicable; a MATLAB header cut short is corrupt", async () => {
    const text = new TextEncoder().encode("Brain Vision Data Exchange Header File Version 1.0\n");
    expect((await scan(text)).result.coverage).toBe("not-applicable");
    const cut = load(MAT, "eeglab-data.set").subarray(0, 60);
    expect((await scan(cut)).result).toMatchObject({ coverage: "partial", incomplete: "corrupt" });
  });

  test("past the byte limit the read is partial (limit), with the findings before it", async () => {
    const bytes = load(MAT, "eeglab-data-edited.set");
    const limits = { ...MAT_READER_LIMITS, maxBytes: 70 * 1024 };
    const { result, cached } = await scan(bytes, { limits });
    expect(cached.limited).toBe(true);
    expect(result).toMatchObject({ coverage: "partial", incomplete: "limit" });
    // The subject comes before the signal and the event tables: it was read.
    expect(kinds(result.findings)).toEqual(["eeglab-subject-name/identifier"]);
    // The twin: at the default limits the same file is complete.
    expect((await scan(bytes)).result.coverage).toBe("complete");
  });

  test("past the reader's time share the read is partial (time), with what it found", async () => {
    const bytes = load(MAT, "eeglab-data-edited.set");
    let clock = 0;
    let reads = 0;
    const src: RangeSource = {
      size: bytes.length,
      async read(offset, length) {
        reads++;
        // Time passes with each read: past the share after a few.
        clock += 30_000;
        return bytes.slice(offset, offset + length);
      },
    };
    const walk = await walkMatForReader(src, MAT_READER_LIMITS, () => clock);
    expect(walk.incomplete).toBe("time");
    expect(reads).toBeLessThan(10);
    // The twin: a clock that stands still reads the file whole.
    const still = await walkMatForReader(bufferSource(bytes), MAT_READER_LIMITS, () => 0);
    expect(still.incomplete).toBeUndefined();
  });

  test("a failing source fails the file; the registry's refusal alone is a limit", async () => {
    const bytes = load(MAT, "eeglab-data.set");
    const failure = new ReadFailure("network", { retryable: true });
    const failing: RangeSource = {
      size: bytes.length,
      async read(offset, length) {
        if (offset > 4096) throw failure;
        return bytes.slice(offset, offset + length);
      },
    };
    await expect(EEGLAB_READER.scan(failing, PATH, MAT_READER_LIMITS)).rejects.toBe(failure);
    // A LimitExceeded from a source that does not say it was limited is not a limit either.
    const refusing: RangeSource = {
      size: bytes.length,
      async read(offset, length) {
        if (offset > 4096) throw new LimitExceeded();
        return bytes.slice(offset, offset + length);
      },
    };
    await expect(EEGLAB_READER.scan(refusing, PATH, MAT_READER_LIMITS)).rejects.toBeInstanceOf(
      LimitExceeded,
    );
  });
});

describe("the EEGLAB field rules", () => {
  const path = "sub-07/eeg/sub-07_task-x_eeg.set";

  test("subject: a name is identifier, other text review; the label, a code or a placeholder nothing", () => {
    const one = (v: string) => kinds(scanEeglabEntries([char(["subject"], v)], path));
    expect(one("Quillfeather Marlow")).toEqual(["eeglab-subject-name/identifier"]);
    expect(one("Marlow")).toEqual(["eeglab-subject-name/identifier"]);
    expect(one("marlow3 cohort")).toEqual(["eeglab-subject-freetext/review"]);
    expect(one("07")).toEqual([]);
    expect(one("sub-07")).toEqual([]);
    expect(one("S07")).toEqual([]);
    expect(one("n/a")).toEqual([]);
    // Under the one-variable layout the field reads the same.
    expect(kinds(scanEeglabEntries([char(["EEG", "subject"], "Marlow")], path))).toEqual([
      "eeglab-subject-name/identifier",
    ]);
  });

  test("location fields are never scanned; the same path elsewhere is", () => {
    const home = "/Users/qmarlow/studies/";
    for (const fields of [
      ["filepath"],
      ["chaninfo", "filename"],
      ["splinefile"],
      ["icasplinefile"],
      ["dipfit", "hdmfile"],
      ["dipfit", "mrifile"],
      ["dipfit", "chanfile"],
      ["dipfit", "coordfile"],
    ]) {
      expect(scanEeglabEntries([char(fields, home)], path), fields.join(".")).toEqual([]);
    }
    expect(
      kinds(scanEeglabEntries([char(["comments"], `Original file: ${home}a.cnt`)], path)),
    ).toEqual(["mat-freetext/review"]);
    expect(kinds(scanEeglabEntries([char(["etc", "note"], home)], path))).toEqual([
      "mat-freetext/review",
    ]);
    // `dipfit` fields that are not files are text like any other.
    expect(kinds(scanEeglabEntries([char(["dipfit", "comment"], home)], path))).toEqual([
      "mat-freetext/review",
    ]);
  });

  test("event types: two capitalized name words fire as review; words, codes and numbers do not", () => {
    const types = (...v: string[]) =>
      kinds(
        scanEeglabEntries(
          v.map((t) => char(["event", "type"], t)),
          path,
        ),
      );
    expect(types("Quillfeather Marlow")).toEqual(["eeglab-event-name/review"]);
    expect(types("urevent", "x").length).toBe(0);
    expect(types("square", "rt", "boundary", "S  1", "Stimulus/S 12", "12", "Target")).toEqual([]);
    // One capitalized word beside a lowercase one is not a name.
    expect(types("Target onset", "left Hand")).toEqual([]);
    // Every column of the event tables gets the same rule, and only it (no path, no person field).
    const column = (fields: string[], v: string) =>
      kinds(scanEeglabEntries([char(fields, v)], path));
    expect(column(["urevent", "Subject"], "go")).toEqual([]);
    expect(column(["epoch", "eventhistory"], "/Users/qmarlow/x")).toEqual([]);
    expect(column(["event", "experimenter"], "Quillfeather Marlow")).toEqual([
      "eeglab-event-name/review",
    ]);
    // The twin outside the event tables: the person-field rule applies.
    expect(column(["etc", "experimenter"], "go")).toEqual(["mat-freetext-name/identifier"]);
    expect(
      kinds(scanEeglabEntries([char(["urevent", "type"], "Quillfeather Marlow")], path)),
    ).toEqual(["eeglab-event-name/review"]);
    const numeric: MatEntry = {
      fields: ["event", "type"],
      class: "double",
      dims: [1, 1],
      value: [7],
    };
    expect(scanEeglabEntries([numeric], path)).toEqual([]);
  });

  test("history: the person-name rule outside paths only, never the path rule", () => {
    const h = (line: string) => kinds(scanEeglabEntries([char(["history"], line)], path));
    expect(h("% edited by Quillfeather Marlow")).toEqual(["eeglab-history-name/review"]);
    expect(
      h("EEG = pop_loadset('filename','a.set','filepath','/Users/qmarlow/Google Drive/');"),
    ).toEqual([]);
    expect(h("EEG = pop_loadset('filepath','C:\\Users\\Quillfeather Marlow\\data');")).toEqual([]);
    expect(h("EEG = pop_epoch( EEG, { 'square' }, [-1 2]);")).toEqual([]);
  });

  test("channel labels never fire, whatever they hold", () => {
    for (const fields of [
      ["chanlocs", "labels"],
      ["urchanlocs", "labels"],
      ["chaninfo", "nodatchans", "labels"],
    ]) {
      expect(scanEeglabEntries([char(fields, "Quillfeather Marlow /Users/qm/")], path)).toEqual([]);
    }
    // The twin: a person field elsewhere in chanlocs is read.
    expect(kinds(scanEeglabEntries([char(["chanlocs", "operator"], "Marlow")], path))).toEqual([
      "mat-freetext-name/identifier",
    ]);
  });

  test("datfile is the companion and is not scanned; v7.3 cell members get the free-text rules", () => {
    expect(scanEeglabEntries([char(["datfile"], "/Users/qmarlow/a.fdt")], path)).toEqual([]);
    expect(fdtNamed([char(["datfile"], "a.fdt")])).toBe("a.fdt");
    expect(fdtNamed([char(["data"], "old.dat")])).toBe("old.dat");
    expect(fdtNamed([char(["data"], "in set file")])).toBeNull();
    const ref = char(["#refs#"], "/Users/qmarlow/x");
    expect(scanEeglabEntries([ref], path)).toEqual([
      expect.objectContaining({ kind: "mat-freetext", field: "eeglab.cell" }),
    ]);
  });

  test("EEG.BIDS mirrors the sidecars: identifier keys, paths and contacts, no person fields", () => {
    const k = (fields: string[], v: string) => kinds(scanEeglabEntries([char(fields, v)], path));
    // A person field under BIDS is a sidecar key: no person-field rule.
    expect(k(["BIDS", "tInfo", "SubjectOperator"], "Marlow")).toEqual([]);
    // The twin: the same field outside BIDS is a person's.
    expect(k(["etc", "SubjectOperator"], "Marlow")).toEqual(["mat-freetext-name/identifier"]);
    // An identifier key, a home path and contact details under BIDS are still read.
    expect(k(["BIDS", "pInfo", "DateOfBirth"], "1990-04-12")).toEqual([
      "mat-identifier-field/identifier",
    ]);
    expect(k(["BIDS", "gInfo", "README"], "see /Users/qmarlow/notes")).toEqual([
      "mat-freetext/review",
    ]);
    expect(k(["BIDS", "gInfo", "Contact"], "q.marlow@example.invalid")).toEqual([
      "mat-identifier-field/review",
    ]);
  });

  test("personNameIn and withoutPaths", () => {
    expect(personNameIn("Quillfeather Marlow")).toBe("Quillfeather Marlow");
    expect(personNameIn("Quillfeather")).toBeNull();
    expect(personNameIn("quillfeather marlow")).toBeNull();
    expect(personNameIn("/data/Quillfeather Marlow/")).toBeNull();
    expect(withoutPaths("a '/x/Y Z/' b C:\\U\\V c")).not.toMatch(/[/\\]/);
  });
});

describe("the .fdt companion", () => {
  test("namedCompanionsMissing: beside the file, by bare name only", () => {
    const paths = new Set(["sub-01/eeg/a.set", "sub-01/eeg/A.FDT", "sub-01/b.fdt"]);
    expect(namedCompanionsMissing("sub-01/eeg/a.set", ["a.fdt"], paths)).toBe(0);
    expect(namedCompanionsMissing("sub-01/eeg/a.set", ["c.fdt"], paths)).toBe(1);
    // A name with a separator or `..` is never followed, even when the file it names exists.
    expect(namedCompanionsMissing("sub-01/eeg/a.set", ["../b.fdt"], paths)).toBe(1);
    expect(namedCompanionsMissing("sub-01/eeg/a.set", ["eeg/a.fdt"], paths)).toBe(1);
    expect(namedCompanionsMissing("sub-01/eeg/a.set", ["eeg\\a.fdt"], paths)).toBe(1);
    // Even when the path it names is in the dataset.
    const nested = new Set(["sub-01/eeg/a.set", "sub-01/eeg/sub/a.fdt"]);
    expect(namedCompanionsMissing("sub-01/eeg/a.set", ["sub/a.fdt"], nested)).toBe(1);
    expect(namedCompanionsMissing("sub-01/eeg/a.set", [".."], paths)).toBe(1);
    expect(namedCompanionsMissing("sub-01/eeg/a.set", undefined, paths)).toBe(0);
  });

  /** Read one .set as the screen does, beside the paths given. */
  async function screen(bytes: Uint8Array, paths: string[]) {
    const entry = { path: "sub-01/eeg/eeglab_data.set", size: bytes.length };
    return readRecordings({
      entries: [entry],
      paths: [entry.path, ...paths],
      open: () => bufferSource(bytes),
      concurrency: 1,
      now: () => 0,
      datasetTimeMs: 60_000,
      failureClass: () => "x",
    });
  }

  test("a missing .fdt is companion-missing and partial; present, the set is read", async () => {
    const bytes = load(MAT, "eeglab-data.set");
    const missing = await screen(bytes, []);
    expect(missing.tallies.eeglab).toEqual({ files: 1, read: 0, partial: 1, failed: 0 });
    expect(missing.companionMissing).toBe(1);
    expect([...missing.reasons]).toEqual(["companion-missing"]);
    const present = await screen(bytes, ["sub-01/eeg/eeglab_data.fdt"]);
    expect(present.tallies.eeglab).toEqual({ files: 1, read: 1, partial: 0, failed: 0 });
    expect(present.companionMissing).toBe(0);
  });

  test("a datfile with a path separator is not followed: partial, though the file exists", async () => {
    const bytes = load(MAT, "eeglab-data.set").slice();
    // The .fdt's name as UTF-16 text, rewritten in place to a name of the same length with a `/`.
    const from = "eeglab_data.fdt";
    const to = "../lab_data.fdt";
    const needle = new Uint8Array(from.length * 2);
    for (let i = 0; i < from.length; i++) needle[i * 2] = from.charCodeAt(i);
    // Every copy of it: the file names its .fdt in `data` and in `datfile`.
    let copies = 0;
    for (let at = 0; at + needle.length <= bytes.length; at++) {
      if (!needle.every((b, j) => bytes[at + j] === b)) continue;
      for (let i = 0; i < to.length; i++) bytes[at + i * 2] = to.charCodeAt(i);
      copies++;
    }
    expect(copies).toBeGreaterThan(0);
    expect((await scan(bytes)).result.needs).toEqual([to]);
    const read = await screen(bytes, ["sub-01/lab_data.fdt", "sub-01/eeg/eeglab_data.fdt"]);
    expect(read.tallies.eeglab.partial).toBe(1);
    expect(read.companionMissing).toBe(1);
  });

  test("the local screen counts a .set whose .fdt is missing, and the twin with it is complete", async () => {
    const bytes = load(MAT, "eeglab-data.set");
    const description = JSON.stringify({ Name: "Fixture", BIDSVersion: "1.9.0" });
    const without = new Repo("eeglab-no-fdt");
    without.file("dataset_description.json", description);
    without.file("sub-01/eeg/eeglab_data.set", bytes).commit("data");
    const lacking = await screenLocalDataset(without.dir, { committed: true });
    expect(lacking.report.scan?.companion_missing).toBe(1);
    expect(lacking.report.scan?.incomplete).toBe(true);
    expect(lacking.report.scan?.incomplete_reasons).toContain("companion-missing");

    const withFdt = new Repo("eeglab-fdt");
    withFdt.file("dataset_description.json", description);
    withFdt.file("sub-01/eeg/eeglab_data.set", bytes);
    withFdt.file("sub-01/eeg/eeglab_data.fdt", new Uint8Array(64)).commit("data");
    const whole = await screenLocalDataset(withFdt.dir, { committed: true });
    expect(whole.report.scan?.companion_missing).toBe(0);
    expect(whole.report.scan?.incomplete).toBe(false);
    expect(whole.report.scan?.status).toBe("clean");
  });
});
