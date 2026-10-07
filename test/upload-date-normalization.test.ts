/**
 * The upload's acquisition dates (`src/lib/upload/date-normalization.ts`, ADR 0091), driven
 * against real directories: real EDF headers laid out as the format says, real symbolic and hard
 * links, real permission bits, a real git repository and a real git-annex one. Nothing is
 * replaced. The command-level behavior (what a dry run prints, that a refused or unconfirmed run
 * changes no file, that the steps run in that order) is in upload-identifier-preflight-cli.test.ts.
 *
 * Not exercised here: a recording on another filesystem than the dataset's directory. The walk does
 * not follow a symbolic link to a directory, so only a mount point inside the dataset reaches one,
 * and neither CI nor a sandboxed run can mount a filesystem. The check is the comparison of two
 * device numbers in `planUploadDates`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeEdfDates } from "../shared/identifier-scrub";
import { runCommand } from "../src/lib/git-annex/run-command";
import {
  applyUploadDates,
  planUploadDates,
  trackedPaths,
} from "../src/lib/upload/date-normalization";
import {
  identifierPreflightStep,
  recheckIdentifierPreflight,
} from "../src/lib/upload/identifier-preflight";

function put(out: Uint8Array, text: string, start: number, width: number): void {
  out.fill(0x20, start, start + width);
  out.set(new TextEncoder().encode(text).subarray(0, width), start);
}

/** A recording: an EDF+ header with both dates, then a payload no rule may touch. */
function recording(start = "15.03.85", slot = "15-MAR-1985", seed = 1): Uint8Array {
  const out = new Uint8Array(4096);
  out.fill(0x20, 0, 256);
  put(out, "0", 0, 8);
  put(out, "X X X X", 8, 80);
  put(out, `Startdate ${slot} X X X`, 88, 80);
  put(out, start, 168, 8);
  put(out, "10.11.12", 176, 8);
  let x = seed;
  for (let i = 256; i < out.length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

/** The bytes of `recording()` the date rule may change: the day and month of each date. */
const DATE_BYTES = [98, 99, 101, 102, 103, 168, 169, 171, 172];

let root: string;

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), "nemar-upload-dates-")), "dataset");
  mkdirSync(root);
});

afterEach(() => {
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      chmodSync(full, st.isDirectory() ? 0o755 : 0o644);
      if (st.isDirectory()) walk(full);
    }
  };
  walk(dirname(root));
  rmSync(dirname(root), { recursive: true, force: true });
});

function write(rel: string, content: string | Uint8Array): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

const read = (rel: string) => new Uint8Array(readFileSync(join(root, rel)));

function differing(a: Uint8Array, b: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

async function git(args: string[], cwd = root): Promise<void> {
  const r = await runCommand(["git", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const EDF = "sub-01/eeg/sub-01_task-rest_eeg.edf";

describe("the plan reads and changes nothing", () => {
  test("a dated recording outside any repository is planned with the rule's own header", async () => {
    const path = write(EDF, recording());
    const before = statSync(path);
    const plan = await planUploadDates(root);
    expect(plan.items).toHaveLength(1);
    const [item] = plan.items;
    expect(item?.rel).toBe(EDF);
    expect(Buffer.from(item?.after ?? [])).toEqual(
      Buffer.from(normalizeEdfDates(recording()).header),
    );
    // Read-only: the same bytes and the same modification time.
    expect(Buffer.from(read(EDF))).toEqual(Buffer.from(recording()));
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(join(root, ".nemar"))).toBe(false);
  });

  test("a year-only recording, a file that is not EDF, and a short one are not planned", async () => {
    write(EDF, recording("01.01.85", "01-JAN-1985"));
    write("sub-02/eeg/sub-02_task-rest_eeg.edf", "not an EDF file at all, just text\n".repeat(20));
    write("sub-03/eeg/sub-03_task-rest_eeg.edf", recording().subarray(0, 100));
    const plan = await planUploadDates(root);
    expect(plan.items).toEqual([]);
  });

  test("a BDF recording is planned the same way", async () => {
    const bdf = recording();
    bdf[0] = 0xff;
    bdf.set(new TextEncoder().encode("BIOSEMI"), 1);
    write("sub-01/eeg/sub-01_task-rest_eeg.bdf", bdf);
    expect((await planUploadDates(root)).items).toHaveLength(1);
  });

  test("a symbolic link is left, wherever it points", async () => {
    const outside = join(dirname(root), "raw.edf");
    writeFileSync(outside, recording());
    mkdirSync(join(root, "sub-01/eeg"), { recursive: true });
    symlinkSync(outside, join(root, EDF));
    const plan = await planUploadDates(root);
    expect(plan.items).toEqual([]);
    expect(plan.left.link).toBe(1);
  });

  test("a file the uploader cannot write, or in a directory it cannot write, is left", async () => {
    const path = write(EDF, recording());
    chmodSync(path, 0o444);
    const readOnly = await planUploadDates(root);
    expect(readOnly.items).toEqual([]);
    expect(readOnly.left["not-writable"]).toBe(1);
    chmodSync(path, 0o644);
    chmodSync(dirname(path), 0o555);
    const lockedDir = await planUploadDates(root);
    expect(lockedDir.items).toEqual([]);
    expect(lockedDir.left["not-writable"]).toBe(1);
  });

  test("in a git repository, a tracked file is left and an untracked one is planned", async () => {
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@nemar.test"]);
    await git(["config", "user.name", "NEMAR Test"]);
    write(EDF, recording());
    write("sub-02/eeg/sub-02_task-rest_eeg.edf", recording("02.11.91", "02-NOV-1991", 2));
    write("sub-03/eeg/sub-03_task-rest_eeg.edf", recording("09.09.90", "09-SEP-1990", 3));
    await git(["add", EDF]);
    await git(["commit", "-qm", "one recording"]);
    // Staged and not committed is tracked too: the index is what is asked.
    await git(["add", "sub-02/eeg/sub-02_task-rest_eeg.edf"]);
    const plan = await planUploadDates(root);
    expect(plan.items.map((i) => i.rel)).toEqual(["sub-03/eeg/sub-03_task-rest_eeg.edf"]);
    expect(plan.left.tracked).toBe(2);
  });

  test("a path git spells in another case or Unicode form is still tracked", async () => {
    await git(["init", "-q", "-b", "main"]);
    write("sub-01/eeg/Café_eeg.edf", recording());
    await git(["add", "."]);
    const tracked = await trackedPaths(root);
    // Folded on both sides: NFC and lower case.
    expect(tracked?.has("sub-01/eeg/café_eeg.edf")).toBe(true);
    expect((await planUploadDates(root)).items).toEqual([]);
  });

  test("in a git-annex repository, an annexed recording is left", async () => {
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@nemar.test"]);
    await git(["config", "user.name", "NEMAR Test"]);
    await git(["annex", "init", "--quiet", "test"]);
    write(EDF, recording());
    await git(["annex", "add", "--quiet", EDF]);
    const plan = await planUploadDates(root);
    expect(plan.items).toEqual([]);
    expect(plan.left.tracked).toBe(1);
    // The annex object is intact.
    await git(["annex", "fsck", "--quiet", EDF]);
  });

  test("inside a repository where git cannot run, no file is planned", async () => {
    // A `.git` above the dataset, and no git on PATH: which files git tracks cannot be told.
    mkdirSync(join(dirname(root), ".git"));
    write(EDF, recording());
    const path = process.env.PATH;
    process.env.PATH = join(dirname(root), "no-tools");
    try {
      const plan = await planUploadDates(root);
      expect(plan.items).toEqual([]);
      expect(plan.left["tracking-unknown"]).toBe(1);
    } finally {
      process.env.PATH = path;
    }
  });
});

describe("applying the plan", () => {
  test("only the date bytes change; size, permissions and every other byte are kept", async () => {
    const path = write(EDF, recording());
    chmodSync(path, 0o640);
    const before = read(EDF);
    const plan = await planUploadDates(root);
    const result = applyUploadDates(root, plan);
    expect(result).toMatchObject({ set: 1, left: 0 });
    const after = read(EDF);
    expect(after.length).toBe(before.length);
    const changed = differing(before, after);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.filter((i) => !DATE_BYTES.includes(i))).toEqual([]);
    const header = Buffer.from(after.subarray(0, 256)).toString("latin1");
    expect(header).toContain("Startdate 01-JAN-1985 X X X");
    expect(header.slice(168, 184)).toBe("01.01.8510.11.12");
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(result.mtimes.get(EDF)).toBe(statSync(path).mtimeMs);
    // The work directory and the `.nemar/` it made are gone again.
    expect(existsSync(join(root, ".nemar"))).toBe(false);
  });

  test("another hard link to the same file keeps the original bytes", async () => {
    const path = write(EDF, recording());
    const backup = join(dirname(root), "backup.edf");
    linkSync(path, backup);
    const ino = statSync(path).ino;
    applyUploadDates(root, await planUploadDates(root));
    expect(Buffer.from(readFileSync(backup))).toEqual(Buffer.from(recording()));
    expect(statSync(path).ino).not.toBe(ino);
    expect(differing(read(EDF), recording()).length).toBeGreaterThan(0);
  });

  test("a header that changed after the plan is left, though size and times did not move", async () => {
    // A round modification time, so it can be put back exactly: what is left to tell the change
    // is the compare of the header bytes.
    const path = write(EDF, recording());
    const at = new Date(1_700_000_000_000);
    utimesSync(path, at, at);
    const plan = await planUploadDates(root);
    expect(plan.items[0]?.mtimeMs).toBe(at.getTime());
    const edited = recording();
    edited.set(new TextEncoder().encode("16"), 168);
    writeFileSync(path, edited);
    utimesSync(path, at, at);
    expect(statSync(path).mtimeMs).toBe(at.getTime());
    expect(applyUploadDates(root, plan)).toMatchObject({ set: 0, left: 1 });
    expect(Buffer.from(read(EDF))).toEqual(Buffer.from(edited));
  });

  test("a file whose modification time moved after the plan is left", async () => {
    const path = write(EDF, recording());
    const plan = await planUploadDates(root);
    utimesSync(path, new Date(), new Date(Date.now() + 60_000));
    expect(applyUploadDates(root, plan)).toMatchObject({ set: 0, left: 1 });
    expect(Buffer.from(read(EDF))).toEqual(Buffer.from(recording()));
  });

  test("a file replaced by a link after the plan is left, and its target untouched", async () => {
    const path = write(EDF, recording());
    const plan = await planUploadDates(root);
    const outside = join(dirname(root), "elsewhere.edf");
    writeFileSync(outside, recording());
    rmSync(path);
    symlinkSync(outside, path);
    expect(applyUploadDates(root, plan)).toMatchObject({ set: 0, left: 1 });
    expect(Buffer.from(readFileSync(outside))).toEqual(Buffer.from(recording()));
  });

  test("a `.nemar` that is a link sets nothing and creates nothing through it", async () => {
    write(EDF, recording());
    const elsewhere = join(dirname(root), "elsewhere-nemar");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, ".nemar"));
    const plan = await planUploadDates(root);
    expect(applyUploadDates(root, plan)).toMatchObject({ set: 0, left: 1 });
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(Buffer.from(read(EDF))).toEqual(Buffer.from(recording()));
  });

  test("a copy a crashed run left in the work directory is removed; anything else there is kept", async () => {
    write(EDF, recording());
    write(".nemar/config.json", "{}");
    write(".nemar/date-normalization/123-0123456789abcdef", "stray copy");
    write(".nemar/date-normalization/keep-me", "not ours");
    applyUploadDates(root, await planUploadDates(root));
    expect(readdirSync(join(root, ".nemar/date-normalization"))).toEqual(["keep-me"]);
    expect(existsSync(join(root, ".nemar/config.json"))).toBe(true);
  });

  test("planning again after the apply finds nothing to do", async () => {
    write(EDF, recording());
    applyUploadDates(root, await planUploadDates(root));
    const again = await planUploadDates(root);
    expect(again.items).toEqual([]);
    expect(applyUploadDates(root, again)).toEqual({ set: 0, left: 0, mtimes: new Map() });
  });
});

describe("the preflight screens the tree as it will be sent", () => {
  async function printed(body: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => {
      // Without the terminal's color codes: the words a person reads.
      lines.push(
        args.join(" ").replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), ""),
      );
    };
    try {
      await body();
    } finally {
      console.log = log;
    }
    return lines;
  }

  function dataset(): void {
    write("dataset_description.json", JSON.stringify({ Name: "Fixture", BIDSVersion: "1.9.0" }));
    write(EDF, recording());
    write("sub-02/eeg/sub-02_task-rest_eeg.edf", recording("02.11.91", "02-NOV-1991", 2));
    write(
      "sub-01/sub-01_scans.tsv",
      "filename\tacq_time\neeg/sub-01_task-rest_eeg.edf\t1985-03-15T10:00:00\n",
    );
  }

  test("planned dates are not warned about, the table's is, and the record sent holds only it", async () => {
    dataset();
    const plan = await planUploadDates(root);
    expect(plan.items).toHaveLength(2);
    let first: Awaited<ReturnType<typeof identifierPreflightStep>> | undefined;
    const firstLines = await printed(async () => {
      first = await identifierPreflightStep(root, {}, false, plan);
    });
    if (first?.status !== "ok" || first.value === null) throw new Error("expected a record");
    expect(first.value.scan.findings_by_kind).toEqual({ "acq-time-dated": 1 });
    expect(firstLines.some((l) => l.includes("(1 entry)"))).toBe(true);
    expect(firstLines.filter((l) => l.includes("set to 1 January"))).toEqual([
      "  Acquisition dates in 2 recording headers are set to 1 January of their year before upload.",
    ]);
    // Nothing changed yet.
    expect(Buffer.from(read(EDF))).toEqual(Buffer.from(recording()));

    expect(applyUploadDates(root, plan).set).toBe(2);
    let again: Awaited<ReturnType<typeof recheckIdentifierPreflight>> | undefined;
    const lines = await printed(async () => {
      again = await recheckIdentifierPreflight(root, first?.value as never);
    });
    if (again?.status !== "ok") throw new Error("expected the recheck to pass");
    // The second screen reads the files as they are: the same count, so no second warning.
    expect(again.value.scan.findings_by_kind).toEqual({ "acq-time-dated": 1 });
    expect(lines.some((l) => l.includes("Warning: acquisition dates"))).toBe(false);
  });

  test("a planned file that could not be set is warned about by the second screen", async () => {
    dataset();
    const plan = await planUploadDates(root);
    let first: Awaited<ReturnType<typeof identifierPreflightStep>> | undefined;
    await printed(async () => {
      first = await identifierPreflightStep(root, {}, false, plan);
    });
    // The file moved under the plan: it is left, with its dates.
    utimesSync(join(root, EDF), new Date(), new Date(Date.now() + 60_000));
    expect(applyUploadDates(root, plan)).toMatchObject({ set: 1, left: 1 });
    let again: Awaited<ReturnType<typeof recheckIdentifierPreflight>> | undefined;
    const lines = await printed(async () => {
      again = await recheckIdentifierPreflight(root, first?.value as never);
    });
    if (again?.status !== "ok") throw new Error("expected the recheck to pass");
    expect(again.value.scan.findings_by_kind).toEqual({
      "edf-recording-startdate": 1,
      "edf-startdate": 1,
      "acq-time-dated": 1,
    });
    expect(lines.some((l) => l.includes("(3 entries)"))).toBe(true);
  });

  test("without a plan the step screens the files as they are, as before", async () => {
    dataset();
    let first: Awaited<ReturnType<typeof identifierPreflightStep>> | undefined;
    const lines = await printed(async () => {
      first = await identifierPreflightStep(root, {}, false);
    });
    if (first?.status !== "ok" || first.value === null) throw new Error("expected a record");
    expect(first.value.scan.findings_by_kind).toEqual({
      "edf-recording-startdate": 2,
      "edf-startdate": 2,
      "acq-time-dated": 1,
    });
    expect(lines.some((l) => l.includes("set to 1 January"))).toBe(false);
  });
});
