/**
 * The identifier preflight of `nemar dataset upload` (epic #1610 phase 3, ADR 0087), driven
 * through its step function against real directories on disk.
 *
 * Every dataset here is a real tree: EDF/BDF files whose 256-byte headers are laid out as the
 * format specifies, real BrainVision and EEGLAB file names, real symlinks, a real FIFO, a real
 * sparse file. The step under test runs the real walk, the real local reader, the fleet scan's
 * real `scanDatasetFromManifest` and the report contract's real parser; nothing is replaced. The
 * command-level behavior (exit codes, what is printed, that nothing is sent) is in
 * upload-identifier-preflight-cli.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InvalidArgumentError } from "commander";
import {
  type DatasetStatus,
  PREFLIGHT_ACKNOWLEDGEABLE,
  type PreflightScan,
  type UploaderPreflight,
  parsePreflightScan,
  parseUploaderPreflight,
} from "../shared/identifier-screen-report";
import {
  collectAcknowledgment,
  decidePreflight,
  identifierPreflightStep,
  preflightConditions,
  recheckIdentifierPreflight,
  scanLocalDataset,
  walkDatasetTree,
} from "../src/lib/upload/identifier-preflight";
import { version } from "../src/lib/version";

// ---------------------------------------------------------------------------------------
// Real files
// ---------------------------------------------------------------------------------------

function put(out: Uint8Array, text: string, start: number, width: number): void {
  out.fill(0x20, start, start + width);
  out.set(new TextEncoder().encode(text).subarray(0, width), start);
}

/** The 256-byte fixed header of an EDF (or BDF) file, laid out as the specification says. */
function edfHeader(patient = "P01 F X X", family: "edf" | "bdf" = "edf"): Uint8Array {
  const out = new Uint8Array(256).fill(0x20);
  if (family === "bdf") {
    out[0] = 0xff;
    out.set(new TextEncoder().encode("BIOSEMI"), 1);
  } else {
    put(out, "0", 0, 8);
  }
  put(out, patient, 8, 80);
  put(out, "Startdate X X X X", 88, 80);
  put(out, "01.01.85", 168, 8);
  put(out, "00.00.00", 176, 8);
  put(out, "256", 184, 8);
  put(out, "-1", 236, 8);
  put(out, "1", 244, 8);
  put(out, "0", 252, 4);
  return out;
}

/** A recording whose start date is `startdate` (dd.mm.yy): 1 January is year-only, any other day is a date. */
function datedRecording(startdate: string): Uint8Array {
  const out = new Uint8Array(4096);
  const header = edfHeader();
  put(header, startdate, 168, 8);
  out.set(header);
  return out;
}

/** A recording: a header followed by signal bytes. */
function recording(patient?: string, family: "edf" | "bdf" = "edf"): Uint8Array {
  const out = new Uint8Array(4096);
  out.set(edfHeader(patient, family));
  return out;
}

const CLEAN_PATIENT = "P01 F X X";
const IS_ROOT = process.getuid?.() === 0;
/** A made-up surname in the name slot of the EDF+ patient field: a direct identifier. */
const NAMED_PATIENT = "P01 F X Quillfeather";

let root: string;
const outside: string[] = [];

function write(rel: string, content: string | Uint8Array): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** A minimal BIDS tree whose one recording is the given EDF bytes. */
function bidsWith(edf: Uint8Array, rel = "sub-01/eeg/sub-01_task-rest_eeg.edf"): void {
  write("dataset_description.json", JSON.stringify({ Name: "Fixture", BIDSVersion: "1.9.0" }));
  write("participants.tsv", "participant_id\tage\nsub-01\t30\n");
  write(rel, edf);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nemar-preflight-"));
});

afterEach(() => {
  // A test that removed permissions puts them back, or the cleanup itself would fail.
  try {
    chmodSync(join(root, "locked"), 0o755);
  } catch {
    // not that test
  }
  rmSync(root, { recursive: true, force: true });
  for (const dir of outside.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 120_000); // removing the 24,000-file tree below can outlast the default hook timeout

const run = (options: Parameters<typeof identifierPreflightStep>[1] = {}) =>
  identifierPreflightStep(root, options, false);

// ---------------------------------------------------------------------------------------
// The verdicts
// ---------------------------------------------------------------------------------------

describe("a clean dataset proceeds, and its record is what will be sent", () => {
  test("clean: no acknowledgment needed, the record parses, the scanner is this CLI", async () => {
    bidsWith(recording(CLEAN_PATIENT));
    const step = await run();
    expect(step.status).toBe("ok");
    if (step.status !== "ok" || step.value === null) throw new Error("expected a record");
    expect(step.value.scan.status).toBe("clean");
    expect(step.value.acknowledged_via).toBeNull();
    expect(step.value.scanner).toBe(`nemar-cli@${version}`);
    expect(step.value.scan.files).toEqual({
      total: 3,
      edf_bdf: 1,
      header_read: 1,
      header_read_failed: 0,
    });
    // The record is exactly what the backend's door accepts.
    expect(parseUploaderPreflight(step.value)).toEqual(step.value);
  });

  test("a BDF header is read like an EDF one", async () => {
    bidsWith(recording(NAMED_PATIENT, "bdf"), "sub-01/eeg/sub-01_task-rest_eeg.bdf");
    expect((await scanLocalDataset(root)).status).toBe("direct-identifiers");
  });
});

describe("direct identifiers refuse the upload, with no way around it", () => {
  test("a name in an EDF header: refused, also under --dry-run and with a flag", async () => {
    bidsWith(recording(NAMED_PATIENT));
    expect((await scanLocalDataset(root)).status).toBe("direct-identifiers");
    expect((await run()).status).toBe("fail");
    expect((await run({ dryRun: true })).status).toBe("fail");
    for (const verdict of PREFLIGHT_ACKNOWLEDGEABLE) {
      expect((await run({ acknowledgeIdentifierPreflight: [verdict] })).status).toBe("fail");
    }
  });

  test("an identifying column in participants.tsv is a direct identifier", async () => {
    bidsWith(recording(CLEAN_PATIENT));
    write("participants.tsv", "participant_id\tfull name\tage\nsub-01\tQ\t30\n");
    const scan = await scanLocalDataset(root);
    expect(scan.status).toBe("direct-identifiers");
    expect(scan.findings_by_kind["participants-identifier-column"]).toBe(1);
    expect((await run()).status).toBe("fail");
  });

  test("an identifying key in a non-BIDS JSON export is a direct identifier", async () => {
    bidsWith(recording(CLEAN_PATIENT));
    write("sourcedata/export/session.json", JSON.stringify({ device: { PatientName: "Q" } }));
    const scan = await scanLocalDataset(root);
    expect(scan.status).toBe("direct-identifiers");
    expect(scan.findings_by_kind["json-identifier-key"]).toBe(1);
  });
});

describe("a verdict that needs a person proceeds only on an acknowledgment that names it", () => {
  /** BrainVision: the scanner does not parse its header, so the name in it is never read. */
  function brainVision(): void {
    write("dataset_description.json", JSON.stringify({ Name: "Fixture", BIDSVersion: "1.9.0" }));
    write("participants.tsv", "participant_id\nsub-01\n");
    write(
      "sub-01/eeg/sub-01_task-rest_eeg.vhdr",
      "Brain Vision Data Exchange Header File Version 1.0\n; Quillfeather\n",
    );
    write("sub-01/eeg/sub-01_task-rest_eeg.vmrk", "Brain Vision Data Exchange Marker File\n");
    write("sub-01/eeg/sub-01_task-rest_eeg.eeg", new Uint8Array(1024));
  }

  test("a format the scanner skips is not screened, never clean, whatever it holds", async () => {
    brainVision();
    const scan = await scanLocalDataset(root);
    expect(scan.status).toBe("not-screened");
    expect(scan.unscreened_formats).toEqual({ ".vhdr": 1, ".vmrk": 1, ".eeg": 1 });
    expect(scan.files.edf_bdf).toBe(0);
  });

  test("without a terminal or a flag it stops; --dry-run previews and sends nothing", async () => {
    brainVision();
    expect((await run()).status).toBe("fail");
    const preview = await run({ dryRun: true });
    expect(preview).toEqual({ status: "ok", value: null });
  });

  test("--no declines", async () => {
    brainVision();
    expect((await run({ no: true })).status).toBe("fail");
  });

  test("the flag acknowledges only the verdict it names", async () => {
    brainVision();
    for (const other of PREFLIGHT_ACKNOWLEDGEABLE.filter((s) => s !== "not-screened")) {
      expect((await run({ acknowledgeIdentifierPreflight: [other] })).status).toBe("fail");
    }
    const step = await run({ acknowledgeIdentifierPreflight: ["not-screened"] });
    if (step.status !== "ok" || step.value === null) throw new Error("expected a record");
    expect(step.value.acknowledged_via).toBe("flag");
    expect(step.value.scan.status).toBe("not-screened");
    expect(parseUploaderPreflight(step.value).acknowledged_via).toBe("flag");
  });

  test("EDF clean beside a format the scanner skips is its own verdict", async () => {
    bidsWith(recording(CLEAN_PATIENT));
    write("sub-01/eeg/sub-01_task-other_eeg.set", "MATLAB 5.0 MAT-file Quillfeather");
    expect((await scanLocalDataset(root)).status).toBe("clean-edf-only-others-unscreened");
  });

  test("a truncated recording is a header nobody read, so the scan is incomplete", async () => {
    bidsWith(edfHeader(NAMED_PATIENT).subarray(0, 100));
    const scan = await scanLocalDataset(root);
    // The name sits inside the 100 bytes that exist, and is still not reported: a header that
    // is not whole is not parsed. What matters is that it is not called clean.
    expect(scan.status).toBe("unchecked");
    expect(scan.files).toEqual({ total: 3, edf_bdf: 1, header_read: 0, header_read_failed: 1 });
    expect(scan.read_failures).toEqual({ "edf/short-body": 1 });
    expect(scan.incomplete_reasons).toEqual(["edf-headers-unread"]);
    expect((await run()).status).toBe("fail");
    expect((await run({ acknowledgeIdentifierPreflight: ["unchecked"] })).status).toBe("ok");
  });

  test("a file named .edf whose header is not EDF is a finding, not a clean header", async () => {
    bidsWith(new TextEncoder().encode(`Brain Vision Data Exchange Header File${" ".repeat(300)}`));
    const scan = await scanLocalDataset(root);
    expect(scan.status).toBe("review");
    expect(scan.findings_by_kind["edf-unreadable"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------
// What is walked, and what is never opened
// ---------------------------------------------------------------------------------------

describe("the walk screens what the upload sends, and counts what it cannot see", () => {
  test(".git and .nemar at the top, and .gitattributes anywhere, are not dataset files", async () => {
    bidsWith(recording(CLEAN_PATIENT));
    write(".git/objects/aa/sub-02_task-rest_eeg.edf", recording(NAMED_PATIENT));
    write(".nemar/stash/sub-03_task-rest_eeg.edf", recording(NAMED_PATIENT));
    write(".gitattributes", "* annex.largefiles=anything\n");
    write("sub-01/.gitattributes", "* annex.largefiles=anything\n");
    const scan = await scanLocalDataset(root);
    expect(scan.status).toBe("clean");
    expect(scan.files.total).toBe(3);
  });

  test("a .nemar below the top is dataset content, as the upload plan lists it", async () => {
    bidsWith(recording(CLEAN_PATIENT));
    write("sub-01/.nemar/sub-01_task-x_eeg.edf", recording(NAMED_PATIENT));
    expect((await scanLocalDataset(root)).status).toBe("direct-identifiers");
  });

  test("a recording reached through a link is read through it (git-annex's own layout)", async () => {
    write("dataset_description.json", JSON.stringify({ Name: "Fixture" }));
    // A resumed upload: git-annex has moved the content under .git/annex/objects and left a
    // relative link in the tree. The walk skips .git, so only the link can reach the header.
    const object = ".git/annex/objects/Xx/Yy/SHA256E-s4096--abc.edf/SHA256E-s4096--abc.edf";
    write(object, recording(NAMED_PATIENT));
    mkdirSync(join(root, "sub-01/eeg"), { recursive: true });
    symlinkSync(`../../${object}`, join(root, "sub-01/eeg/sub-01_task-rest_eeg.edf"));
    expect((await scanLocalDataset(root)).status).toBe("direct-identifiers");
  });

  test("a link to a recording outside the dataset is read too", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "nemar-preflight-outside-"));
    outside.push(elsewhere);
    writeFileSync(join(elsewhere, "rec.edf"), recording(NAMED_PATIENT));
    write("dataset_description.json", JSON.stringify({ Name: "Fixture" }));
    mkdirSync(join(root, "sub-01/eeg"), { recursive: true });
    symlinkSync(join(elsewhere, "rec.edf"), join(root, "sub-01/eeg/sub-01_task-rest_eeg.edf"));
    expect((await scanLocalDataset(root)).status).toBe("direct-identifiers");
  });

  test("a broken link is a failed read, not a skipped file", async () => {
    write("dataset_description.json", JSON.stringify({ Name: "Fixture" }));
    mkdirSync(join(root, "sub-01/eeg"), { recursive: true });
    symlinkSync("../../nowhere.edf", join(root, "sub-01/eeg/sub-01_task-rest_eeg.edf"));
    const scan = await scanLocalDataset(root);
    expect(scan.status).toBe("unchecked");
    expect(scan.read_failures).toEqual({ "edf/unreadable-entry": 1 });
    expect(scan.files.total).toBe(2);
  });

  test("a FIFO is listed and never opened (opening one would hang the upload)", async () => {
    bidsWith(recording(CLEAN_PATIENT));
    const fifo = join(root, "sub-01/eeg/sub-01_task-two_eeg.edf");
    const made = Bun.spawnSync(["mkfifo", fifo]);
    expect(made.exitCode).toBe(0);
    const scan = await scanLocalDataset(root);
    expect(scan.status).toBe("unchecked");
    expect(scan.files.edf_bdf).toBe(2);
    expect(scan.read_failures).toEqual({ "edf/unreadable-entry": 1 });
  }, 10_000);

  // Root reads anything, so there is nothing to prove as root: the test reports a skip.
  test.skipIf(IS_ROOT)("a directory that cannot be listed makes the scan incomplete", async () => {
    bidsWith(recording(CLEAN_PATIENT));
    write("locked/sub-02_task-rest_eeg.edf", recording(NAMED_PATIENT));
    chmodSync(join(root, "locked"), 0o000);
    const tree = walkDatasetTree(root);
    expect(tree.unlisted).toBe(1);
    const scan = await scanLocalDataset(root);
    expect(scan.status).toBe("unchecked");
    expect(scan.incomplete_reasons).toContain("tree-truncated");
  });

  test("file names with quotes and spaces are paths like any other", async () => {
    bidsWith(recording(NAMED_PATIENT), `sub-01/eeg/sub-01_task-"O'Brien rest"_eeg.edf`);
    const scan = await scanLocalDataset(root);
    expect(scan.status).toBe("direct-identifiers");
    expect(scan.files.header_read).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------------------

describe("large datasets", () => {
  test("a recording is read for its header only (an 8 GiB file reads 256 bytes)", async () => {
    // Sparse: it occupies no disk, but a reader that read the whole file would allocate 8 GiB,
    // and Node refuses a whole-file read past 2 GiB, so such a reader cannot pass this test.
    const path = write("sub-01/eeg/sub-01_task-rest_eeg.edf", edfHeader(CLEAN_PATIENT));
    write("dataset_description.json", JSON.stringify({ Name: "Fixture" }));
    truncateSync(path, 8 * 1024 ** 3);
    const started = performance.now();
    const scan = await scanLocalDataset(root);
    expect(scan.status).toBe("clean");
    expect(scan.files.header_read).toBe(1);
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 20_000);

  test("every header of a 24,000-file dataset is read, none sampled", async () => {
    write("dataset_description.json", JSON.stringify({ Name: "Fixture" }));
    const header = edfHeader(CLEAN_PATIENT);
    const subjects = 400;
    const runs = 15;
    for (let s = 1; s <= subjects; s++) {
      const dir = join(root, `sub-${s}`, "eeg");
      mkdirSync(dir, { recursive: true });
      for (let r = 1; r <= runs; r++) {
        writeFileSync(join(dir, `sub-${s}_task-t_run-${r}_eeg.edf`), header);
        writeFileSync(join(dir, `sub-${s}_task-t_run-${r}_events.tsv`), "onset\tduration\n");
        writeFileSync(join(dir, `sub-${s}_task-t_run-${r}_channels.tsv`), "name\ttype\n");
        writeFileSync(join(dir, `sub-${s}_task-t_run-${r}_eeg.json`), "{}");
      }
    }
    // One named header in the middle: a sampled scan would very likely miss it.
    writeFileSync(join(root, "sub-217/eeg/sub-217_task-t_run-8_eeg.edf"), edfHeader(NAMED_PATIENT));
    const started = performance.now();
    const scan = await scanLocalDataset(root);
    const seconds = (performance.now() - started) / 1000;
    expect(scan.files.total).toBe(subjects * runs * 4 + 1);
    expect(scan.files.edf_bdf).toBe(subjects * runs);
    expect(scan.files.header_read).toBe(subjects * runs);
    expect(scan.status).toBe("direct-identifiers");
    expect(scan.edf_bdf_files_flagged).toBe(1);
    expect(seconds).toBeLessThan(60);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------
// The rule on its own (a supplement: the tests above drive it through the step)
// ---------------------------------------------------------------------------------------

describe("decidePreflight", () => {
  /** A scan in the contract's shape whose counts agree with its status. */
  const scan = (status: DatasetStatus, over: Partial<PreflightScan> = {}): PreflightScan =>
    parsePreflightScan({
      scanned_at: "2026-10-06T12:00:00.000Z",
      status,
      incomplete: status === "unchecked",
      incomplete_reasons: status === "unchecked" ? ["edf-headers-unread"] : [],
      files: {
        total: 4,
        edf_bdf: 2,
        header_read: status === "unchecked" ? 1 : 2,
        header_read_failed: status === "unchecked" ? 1 : 0,
      },
      findings_by_kind:
        status === "direct-identifiers"
          ? { "edf-patient-name": 1 }
          : status === "review"
            ? { "image-or-document-file": 1 }
            : {},
      edf_bdf_files_flagged: status === "direct-identifiers" ? 1 : 0,
      unscreened_formats: status === "clean-edf-only-others-unscreened" ? { ".vhdr": 1 } : {},
      read_failures: status === "unchecked" ? { "edf/short-body": 1 } : {},
      ...over,
    });
  const all = { isTty: true, dryRun: true, no: true };

  test("clear verdicts proceed with nothing to acknowledge, whatever was passed", () => {
    for (const status of ["clean", "dates-only"] as const) {
      expect(decidePreflight(scan(status), { ...all, acknowledge: ["review"] })).toEqual({
        action: "proceed",
        acknowledgedVia: null,
      });
    }
  });

  test("direct identifiers are refused, whatever was passed", () => {
    for (const choices of [
      { isTty: true },
      { isTty: false, dryRun: true },
      { isTty: true, acknowledge: ["direct-identifiers"] },
      { isTty: true, acknowledge: [...PREFLIGHT_ACKNOWLEDGEABLE] },
    ]) {
      expect(decidePreflight(scan("direct-identifiers"), choices)).toEqual({ action: "refuse" });
    }
  });

  test("an acknowledgeable verdict: flag, preview, decline, prompt, or stop, in that order", () => {
    for (const status of ["review", "unchecked", "clean-edf-only-others-unscreened"] as const) {
      const s = scan(status);
      expect(decidePreflight(s, { ...all, acknowledge: [status] })).toEqual({
        action: "proceed",
        acknowledgedVia: "flag",
      });
      const other = PREFLIGHT_ACKNOWLEDGEABLE.find((v) => v !== status);
      expect(decidePreflight(s, { ...all, acknowledge: [other as string] })).toEqual({
        action: "stop",
        why: "acknowledgment-mismatch",
      });
      expect(decidePreflight(s, all)).toEqual({ action: "preview" });
      expect(decidePreflight(s, { isTty: true, no: true })).toEqual({
        action: "stop",
        why: "declined",
      });
      expect(decidePreflight(s, { isTty: true })).toEqual({ action: "prompt" });
      expect(decidePreflight(s, { isTty: false })).toEqual({
        action: "stop",
        why: "acknowledgment-required",
      });
    }
  });

  test("the flag must name every condition, and no more", () => {
    // `review` outranks an incomplete read and an unscreened format in the verdict, so both ride
    // under it unless the acknowledgment has to name them too.
    const hidden = scan("review", {
      incomplete: true,
      incomplete_reasons: ["edf-headers-unread"],
      files: { total: 4, edf_bdf: 2, header_read: 1, header_read_failed: 1 },
      read_failures: { "edf/unreadable-entry": 1 },
      unscreened_formats: { ".vhdr": 1 },
    });
    expect(preflightConditions(hidden)).toEqual(["not-screened", "review", "unchecked"]);
    const flag = (acknowledge: string[]) => decidePreflight(hidden, { isTty: false, acknowledge });
    expect(flag(["review"]).action).toBe("stop");
    expect(flag(["review", "unchecked"]).action).toBe("stop");
    expect(flag(["unchecked", "review", "not-screened"])).toEqual({
      action: "proceed",
      acknowledgedVia: "flag",
    });
    // Every word at once is not a standing waiver: a word for a condition not found stops it.
    expect(flag([...PREFLIGHT_ACKNOWLEDGEABLE]).action).toBe("stop");
    expect(preflightConditions(scan("clean"))).toEqual([]);
    expect(preflightConditions(scan("direct-identifiers"))).toEqual([]);
  });

  test("the option takes repeated and comma-separated verdicts, and nothing else", () => {
    expect(collectAcknowledgment("review,unchecked", undefined)).toEqual(["review", "unchecked"]);
    expect(collectAcknowledgment("not-screened", ["review"])).toEqual(["review", "not-screened"]);
    for (const bad of ["direct-identifiers", "clean", "review,Quillfeather", "", " , "]) {
      expect(() => collectAcknowledgment(bad, undefined)).toThrow(InvalidArgumentError);
    }
  });
});

// ---------------------------------------------------------------------------------------
// Review findings (PR review of #1613): each case below was a rule with no test, or a hole
// ---------------------------------------------------------------------------------------

describe("the walk, the reader and the limits, at their edges", () => {
  test("the walk is in name order, whatever order the filesystem lists in", () => {
    write("b/2.json", "{}");
    write("a/z.json", "{}");
    write("a/y/x.json", "{}");
    write("c.json", "{}");
    expect(walkDatasetTree(root).entries.map((e) => e.path)).toEqual([
      "c.json",
      "a/z.json",
      "a/y/x.json",
      "b/2.json",
    ]);
  });

  test("a DIRECTORY named .gitattributes is walked: the upload plan lists what is inside", async () => {
    bidsWith(recording(CLEAN_PATIENT));
    write(".gitattributes/sub-02_task-rest_eeg.edf", recording(NAMED_PATIENT));
    write("sub-01/.gitattributes/sub-03_task-rest_eeg.edf", recording(NAMED_PATIENT));
    const scan = await scanLocalDataset(root);
    expect(scan.status).toBe("direct-identifiers");
    expect(scan.files.edf_bdf).toBe(3);
  });

  test("a .git below the top is dataset content, as the upload plan lists it", async () => {
    bidsWith(recording(CLEAN_PATIENT));
    write("sub-01/.git/sub-01_task-x_eeg.edf", recording(NAMED_PATIENT));
    expect((await scanLocalDataset(root)).status).toBe("direct-identifiers");
  });

  test.skipIf(IS_ROOT)(
    "a file stat accepts and open refuses is a failed read, never empty",
    async () => {
      bidsWith(recording(CLEAN_PATIENT));
      write("participants.tsv", "participant_id\tfull name\nsub-01\tQ\n");
      write("sourcedata/export/session.json", JSON.stringify({ PatientName: "Q" }));
      write("sub-01/eeg/sub-01_task-two_eeg.edf", recording(NAMED_PATIENT));
      for (const rel of [
        "participants.tsv",
        "sourcedata/export/session.json",
        "sub-01/eeg/sub-01_task-two_eeg.edf",
      ]) {
        chmodSync(join(root, rel), 0o000);
      }
      const scan = await scanLocalDataset(root);
      // Each of the three holds a direct identifier, and none could be read: not clean, and not
      // reported as a finding nobody saw. Every unread file is counted by what it is.
      expect(scan.status).toBe("unchecked");
      expect(scan.incomplete_reasons).toEqual([
        "edf-headers-unread",
        "json-unread",
        "participants-unread",
      ]);
      expect(scan.read_failures).toEqual({
        "edf/unreadable-entry": 1,
        "json/unreadable-entry": 1,
        "participants/unreadable-entry": 1,
      });
    },
  );

  test("a side file is read to the publication screen's limit, not the fleet default", async () => {
    bidsWith(recording(CLEAN_PATIENT));
    // 100 KiB, the identifying key past the first 64 KiB: the fleet scan's HTTP default would
    // call it oversize; the local limit (2 MiB) reads it whole.
    const padding = "x".repeat(100 * 1024);
    write("sourcedata/export/big.json", JSON.stringify({ notes: padding, PatientName: "Q" }));
    expect((await scanLocalDataset(root)).status).toBe("direct-identifiers");
  });

  test("every side file is read, none sampled: 301 exports, the key in the last", async () => {
    bidsWith(recording(CLEAN_PATIENT));
    for (let i = 0; i < 300; i++) {
      write(`sourcedata/export/s${String(i).padStart(3, "0")}.json`, JSON.stringify({ i }));
    }
    write("sourcedata/export/s300.json", JSON.stringify({ PatientName: "Q" }));
    const scan = await scanLocalDataset(root);
    expect(scan.status).toBe("direct-identifiers");
    expect(scan.incomplete_reasons).not.toContain("json-sampled");
  });

  test("an extension nobody listed is counted as .other, so a name in it is never printed", async () => {
    bidsWith(recording(CLEAN_PATIENT));
    write("sourcedata/raw/session.quillfeather", new Uint8Array(16));
    write("sourcedata/raw/backup.dat_backup", new Uint8Array(16));
    write("sub-01/eeg/sub-01_task-rest_eeg.vhdr", "Brain Vision Data Exchange Header File\n");
    const scan = await scanLocalDataset(root);
    expect(scan.status).toBe("clean-edf-only-others-unscreened");
    expect(scan.unscreened_formats).toEqual({ ".other": 2, ".vhdr": 1 });
  });

  test("a dataset path that is not a directory is refused before anything else", async () => {
    write("not-a-dataset.edf", recording(CLEAN_PATIENT));
    // Even with the acknowledgment an unlistable tree would need: it is not a dataset at all.
    const step = await identifierPreflightStep(
      join(root, "not-a-dataset.edf"),
      { acknowledgeIdentifierPreflight: ["unchecked"] },
      false,
    );
    expect(step.status).toBe("fail");
  });

  test("a link to a directory is listed, not walked: git stores the link, not what it names", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "nemar-preflight-outside-"));
    outside.push(elsewhere);
    writeFileSync(join(elsewhere, "sub-09_task-rest_eeg.edf"), recording(NAMED_PATIENT));
    bidsWith(recording(CLEAN_PATIENT));
    symlinkSync(elsewhere, join(root, "sub-01/eeg/linked"));
    const scan = await scanLocalDataset(root);
    expect(scan.status).toBe("clean");
    expect(scan.files.total).toBe(4);
    expect(scan.files.edf_bdf).toBe(1);
  });
});

describe("a verdict hides nothing an acknowledgment must name", () => {
  test.skipIf(IS_ROOT)(
    "an image beside an unreadable header needs review AND unchecked",
    async () => {
      bidsWith(recording(CLEAN_PATIENT));
      write("sourcedata/figure.png", new Uint8Array(8));
      write("sub-01/eeg/sub-01_task-two_eeg.edf", recording(NAMED_PATIENT));
      chmodSync(join(root, "sub-01/eeg/sub-01_task-two_eeg.edf"), 0o000);
      const scan = await scanLocalDataset(root);
      expect(scan.status).toBe("review");
      expect(preflightConditions(scan)).toEqual(["review", "unchecked"]);
      expect((await run({ acknowledgeIdentifierPreflight: ["review"] })).status).toBe("fail");
      // As the command line gives it: one comma-separated value, through the option's parser.
      const step = await run({
        acknowledgeIdentifierPreflight: collectAcknowledgment("review,unchecked", undefined),
      });
      expect(step.status).toBe("ok");
    },
  );

  test("an image beside recordings it cannot parse needs review AND not-screened", async () => {
    write("dataset_description.json", JSON.stringify({ Name: "Fixture" }));
    write("sourcedata/figure.png", new Uint8Array(8));
    write("sub-01/eeg/sub-01_task-rest_eeg.vhdr", "Brain Vision Data Exchange Header File\n");
    const scan = await scanLocalDataset(root);
    expect(scan.status).toBe("review");
    expect(preflightConditions(scan)).toEqual(["not-screened", "review"]);
    expect((await run({ acknowledgeIdentifierPreflight: ["review"] })).status).toBe("fail");
    expect((await run({ acknowledgeIdentifierPreflight: ["review", "not-screened"] })).status).toBe(
      "ok",
    );
  });
});

describe("the tree is screened again right before anything is sent", () => {
  async function first(options: Parameters<typeof identifierPreflightStep>[1] = {}) {
    const step = await run(options);
    if (step.status !== "ok" || step.value === null) throw new Error("expected a record");
    return step.value;
  }

  test("unchanged: the second scan is the record, with the same acknowledgment", async () => {
    write("dataset_description.json", JSON.stringify({ Name: "Fixture" }));
    write("sub-01/eeg/sub-01_task-rest_eeg.vhdr", "Brain Vision Data Exchange Header File\n");
    const record = await first({ acknowledgeIdentifierPreflight: ["not-screened"] });
    // The CLI writes files of its own between the two scans; a LICENSE changes nothing found.
    write("LICENSE", "CC0\n");
    const again = await recheckIdentifierPreflight(root, record);
    if (again.status !== "ok") throw new Error("expected the recheck to pass");
    expect(again.value.acknowledged_via).toBe("flag");
    expect(again.value.scan.files.total).toBe(record.scan.files.total + 1);
  });

  test("a direct identifier that appeared after the first scan stops the upload", async () => {
    bidsWith(recording(CLEAN_PATIENT));
    const record = await first();
    write("sub-01/eeg/sub-01_task-rest_eeg.edf", recording(NAMED_PATIENT));
    expect((await recheckIdentifierPreflight(root, record)).status).toBe("fail");
  });

  test("a condition the acknowledgment did not name stops it too", async () => {
    bidsWith(recording(CLEAN_PATIENT));
    const record = await first();
    write("sub-01/eeg/sub-01_task-two_eeg.vhdr", "Brain Vision Data Exchange Header File\n");
    expect((await recheckIdentifierPreflight(root, record)).status).toBe("fail");
  });

  describe("the date warning (ADR 0090)", () => {
    /** What the step printed with console.log, for the duration of `body`. */
    async function printed(body: () => Promise<void>): Promise<string[]> {
      const lines: string[] = [];
      const log = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.join(" "));
      };
      try {
        await body();
      } finally {
        console.log = log;
      }
      return lines;
    }
    const warned = (lines: string[]) =>
      lines.some((line) => line.includes("Warning: acquisition dates"));

    test("a date that appeared after the first scan is warned about before it is sent", async () => {
      bidsWith(recording(CLEAN_PATIENT));
      const record = await first();
      expect(record.scan.status).toBe("clean");
      write("sub-02/eeg/sub-02_task-rest_eeg.edf", datedRecording("15.03.85"));
      let again: Awaited<ReturnType<typeof recheckIdentifierPreflight>> | undefined;
      const lines = await printed(async () => {
        again = await recheckIdentifierPreflight(root, record);
      });
      if (again?.status !== "ok") throw new Error("expected the recheck to pass");
      // No new condition: dates acknowledge nothing, so the upload goes on with its record.
      expect(again.value.scan.status).toBe("dates-only");
      expect(again.value.acknowledged_via).toBeNull();
      expect(lines.some((line) => line.includes("(1 entry)"))).toBe(true);
    });

    test("more dates than the first scan counted: warned again, with the new count", async () => {
      bidsWith(datedRecording("15.03.85"));
      const record = await first();
      write("sub-02/eeg/sub-02_task-rest_eeg.edf", datedRecording("02.11.91"));
      write("sub-03/eeg/sub-03_task-rest_eeg.edf", datedRecording("09.09.90"));
      let again: Awaited<ReturnType<typeof recheckIdentifierPreflight>> | undefined;
      const lines = await printed(async () => {
        again = await recheckIdentifierPreflight(root, record);
      });
      expect(again?.status).toBe("ok");
      expect(lines.some((line) => line.includes("(3 entries)"))).toBe(true);
    });

    test("every date gone since the first scan: told again, with the verdict and no warning", async () => {
      bidsWith(datedRecording("15.03.85"));
      const record = await first();
      write("sub-01/eeg/sub-01_task-rest_eeg.edf", recording(CLEAN_PATIENT));
      let again: Awaited<ReturnType<typeof recheckIdentifierPreflight>> | undefined;
      const lines = await printed(async () => {
        again = await recheckIdentifierPreflight(root, record);
      });
      if (again?.status !== "ok") throw new Error("expected the recheck to pass");
      // The record sent is the second scan's, and it holds no date.
      expect(again.value.scan.status).toBe("clean");
      expect(warned(lines)).toBe(false);
    });

    test("unchanged dates are not warned about twice", async () => {
      bidsWith(datedRecording("15.03.85"));
      let record: UploaderPreflight | undefined;
      const firstLines = await printed(async () => {
        record = await first();
      });
      expect(warned(firstLines)).toBe(true);
      expect(record?.scan.status).toBe("dates-only");
      let again: Awaited<ReturnType<typeof recheckIdentifierPreflight>> | undefined;
      const lines = await printed(async () => {
        again = await recheckIdentifierPreflight(root, record as UploaderPreflight);
      });
      expect(again?.status).toBe("ok");
      expect(warned(lines)).toBe(false);
    });
  });

  test("an acknowledged scan that gains a condition stops, though its record would parse", async () => {
    // The case the contract alone cannot catch: the first record carries an acknowledgment, so a
    // second record with a new condition under the same acknowledgment is still well formed.
    write("dataset_description.json", JSON.stringify({ Name: "Fixture" }));
    write("sub-01/eeg/sub-01_task-rest_eeg.vhdr", "Brain Vision Data Exchange Header File\n");
    const record = await first({ acknowledgeIdentifierPreflight: ["not-screened"] });
    write("sourcedata/figure.png", new Uint8Array(8));
    expect((await recheckIdentifierPreflight(root, record)).status).toBe("fail");
  });
});
