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
import {
  PREFLIGHT_ACKNOWLEDGEABLE,
  parseUploaderPreflight,
} from "../shared/identifier-screen-report";
import {
  decidePreflight,
  identifierPreflightStep,
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

/** A recording: a header followed by signal bytes. */
function recording(patient?: string, family: "edf" | "bdf" = "edf"): Uint8Array {
  const out = new Uint8Array(4096);
  out.set(edfHeader(patient, family));
  return out;
}

const CLEAN_PATIENT = "P01 F X X";
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
      expect((await run({ acknowledgeIdentifierPreflight: verdict })).status).toBe("fail");
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
      expect((await run({ acknowledgeIdentifierPreflight: other })).status).toBe("fail");
    }
    const step = await run({ acknowledgeIdentifierPreflight: "not-screened" });
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
    expect((await run({ acknowledgeIdentifierPreflight: "unchecked" })).status).toBe("ok");
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

  test("a directory that cannot be listed makes the scan incomplete", async () => {
    if (process.getuid?.() === 0) return; // root lists anything; nothing to prove
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
  const all = { isTty: true, dryRun: true, no: true };
  test("clear verdicts proceed with nothing to acknowledge, whatever was passed", () => {
    for (const status of ["clean", "dates-only", "no-recordings"] as const) {
      expect(decidePreflight(status, { ...all, acknowledge: "review" })).toEqual({
        action: "proceed",
        acknowledgedVia: null,
      });
    }
  });

  test("direct identifiers are refused, whatever was passed", () => {
    for (const choices of [
      { isTty: true },
      { isTty: false, dryRun: true },
      { isTty: true, acknowledge: "direct-identifiers" },
      { isTty: true, acknowledge: "review" },
    ]) {
      expect(decidePreflight("direct-identifiers", choices)).toEqual({ action: "refuse" });
    }
  });

  test("an acknowledgeable verdict: flag, preview, decline, prompt, or stop, in that order", () => {
    for (const status of PREFLIGHT_ACKNOWLEDGEABLE) {
      expect(decidePreflight(status, { ...all, acknowledge: status })).toEqual({
        action: "proceed",
        acknowledgedVia: "flag",
      });
      const other = PREFLIGHT_ACKNOWLEDGEABLE.find((s) => s !== status);
      expect(decidePreflight(status, { ...all, acknowledge: other })).toEqual({
        action: "stop",
        why: "acknowledgment-mismatch",
      });
      expect(decidePreflight(status, all)).toEqual({ action: "preview" });
      expect(decidePreflight(status, { isTty: true, no: true })).toEqual({
        action: "stop",
        why: "declined",
      });
      expect(decidePreflight(status, { isTty: true })).toEqual({ action: "prompt" });
      expect(decidePreflight(status, { isTty: false })).toEqual({
        action: "stop",
        why: "acknowledgment-required",
      });
    }
  });
});
