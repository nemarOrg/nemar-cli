/**
 * The tracking step records index stat data for large annexed files through git-annex's
 * per-file clean filter, with `filter.annex.process` out of the configuration for the
 * duration (ADR 0100, issue #1704).
 *
 * `git annex add` stages an unlocked file with zero stat data, so every later git command
 * that compares the tree with the index streams the file through filter-process to learn
 * that it is unchanged: the save's `git add -A`, the first `git status`, and the next
 * upload's own check of already-indexed paths (twice per file). Each test below is either
 * a read that must no longer happen, or a way the configuration change could hide an edit,
 * stage something, or outlive the step. All of it runs against real git-annex on
 * repositories built through the production init path; reads are counted by routing the
 * repository's filter process through `tee` (`meterFilterProcess`).
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  FILTER_PROCESS_KEY,
  FILTER_PROCESS_MARKER,
  PRIME_MIN_FILE_BYTES,
  primeIndexStat,
  restoreSuspendedFilterProcess,
} from "../src/lib/git-annex/index-prime";
import { gitAnnexAdd } from "../src/lib/git-annex/init";
import { annexRemoteExists } from "../src/lib/git-annex/s3-remote";
import { collectFileManifest } from "../src/lib/git-annex/transfer";
import {
  type UploadProgress,
  clearUploadProgress,
  isStepCompleted,
  readUploadProgress,
} from "../src/lib/upload-progress";
import { runDataSteps } from "../src/lib/upload/data-steps";
import { computeFilesToUpload, prepareUploadProgress } from "../src/lib/upload/plan";
import {
  type OpenRemote,
  S3_REMOTE_NAME,
  ensureGitignoreHasNemar,
  uploadDataToS3,
} from "../src/lib/upload/transfer";
import { type DatasetInfo, ok } from "../src/lib/upload/types";
import {
  initDirectoryRemote,
  makeScratch,
  meterFilterProcess,
  newDatasetRepo,
  run,
  trackedRepo,
  writeFile,
} from "./helpers/annex-repo";

setDefaultTimeout(60_000);

const scratch = makeScratch("nemar-index-prime");

beforeAll(async () => {
  const probe = await run(["git", "annex", "version"]);
  if (probe.exitCode !== 0) throw new Error("git-annex is required for this test file");
});
afterAll(() => scratch.cleanup());

const MIB = 1024 * 1024;
/** Far more than a pipe buffer per file, far less than one file's content. */
const NOTHING_READ = 64 * 1024;
/** Larger than any fixture here: the priming is off, as on a CLI without it. */
const NEVER = Number.MAX_SAFE_INTEGER;

const info: DatasetInfo = {
  dataset_id: "nm000997",
  ssh_url: "git@github.com:nemarDatasets/nm000997.git",
  s3_prefix: "nm000997/objects",
  github_url: "https://github.com/nemarDatasets/nm000997",
  upload_urls: {},
  s3_config: { bucket: "nemar-test", region: "us-east-2", public_url: "https://example.invalid" },
};

const A = "sub-01/eeg/sub-01_task-rest_eeg.edf";
const B = "sub-02/eeg/sub-02_task-rest_eeg.edf";
const C = "sub-03/eeg/sub-03_task-rest_eeg.edf";

/**
 * Write a data file the way an upload finds one: written well before the run. A file
 * modified in the same second git writes the index is "racily clean", and git sets its
 * recorded size to zero so a later command reads it once more whatever its stat says.
 * That is git protecting itself, not the read under test, and recordings on a real
 * upload were written long before it.
 */
function writeDataFile(dir: string, path: string, size: number, fill: number): void {
  writeFile(dir, path, Buffer.alloc(size, fill));
  const written = Date.now() / 1000 - 60;
  utimesSync(join(dir, path), written, written);
}

/** A dataset directory ready for an upload, with distinct content per file. */
async function dataset(name: string, files: Record<string, number>): Promise<string> {
  const dir = await newDatasetRepo(scratch.root, name);
  ensureGitignoreHasNemar(dir);
  let fill = 1;
  for (const [path, size] of Object.entries(files)) writeDataFile(dir, path, size, fill++);
  writeFile(dir, "dataset_description.json", '{"Name":"x","BIDSVersion":"1.9.0"}');
  return dir;
}

function directoryRemote(dir: string): OpenRemote {
  return async () => {
    if (!(await annexRemoteExists(dir, S3_REMOTE_NAME))) {
      await initDirectoryRemote(scratch.root, dir, S3_REMOTE_NAME);
    }
    return ok({ remoteIdentity: `directory:${dir}:${S3_REMOTE_NAME}` });
  };
}

async function plan(dir: string) {
  const manifest = await collectFileManifest(dir);
  const { dataFiles, uploadProgress } = prepareUploadProgress(dir, manifest, {});
  return {
    dataFiles,
    uploadProgress,
    filesToUpload: computeFilesToUpload(uploadProgress, dataFiles),
  };
}

/** Steps 9 to 11, the way the command runs them. */
async function runSteps(dir: string, deps: Parameters<typeof runDataSteps>[1]) {
  return runDataSteps(
    {
      absolutePath: dir,
      options: { jobs: "2" },
      ...(await plan(dir)),
      datasetInfo: info,
      coAuthorEnrichment: undefined,
      author: undefined,
    },
    deps,
  );
}

/** Step 9 alone: tracking and the copy, no save, so the index is as tracking left it. */
async function trackAndCopy(dir: string, deps: Parameters<typeof uploadDataToS3>[6]) {
  const p = await plan(dir);
  return uploadDataToS3(
    dir,
    { jobs: "2" },
    p.dataFiles,
    p.filesToUpload,
    p.uploadProgress,
    info,
    deps,
  );
}

/** True when the index holds stat data for `path`; `git annex add` leaves an mtime of 0:0. */
async function statRecorded(dir: string, path: string): Promise<boolean> {
  const out = await run(["git", "--literal-pathspecs", "ls-files", "--debug", "--", path], dir);
  const mtime = out.stdout.match(/mtime: (\d+):(\d+)/);
  if (!mtime) throw new Error(`no index entry for ${path}: ${out.stdout}${out.stderr}`);
  return mtime[1] !== "0" || mtime[2] !== "0";
}

/** The repository's own filter process values and git-annex's marker, as git reads them. */
async function filterConfig(dir: string): Promise<{ process: string[]; marker: string[] }> {
  const read = async (key: string) =>
    (await run(["git", "config", "--local", "--null", "--get-all", key], dir)).stdout
      .split("\0")
      .filter(Boolean);
  return { process: await read(FILTER_PROCESS_KEY), marker: await read(FILTER_PROCESS_MARKER) };
}

const bytesRead = (log: string): number => readFileSync(log).length;

describe("what the tracking step no longer reads", () => {
  test("after tracking, the save and the first git status read none of a large file", async () => {
    // Guards the call after the add in uploadDataToS3. Without it the save's `git add -A`
    // streams both 2 MiB files through filter-process (this tree is below the save's own
    // 1 GiB skip), and so would the first `git status` on a tree that took the skip.
    const dir = await dataset("after", { [A]: 2 * MIB, [B]: 2 * MIB });
    const log = await meterFilterProcess(dir);
    const configured = await filterConfig(dir);

    const result = await runSteps(dir, { openRemote: directoryRemote(dir), primeMinBytes: MIB });
    const status = await run(["git", "status", "--porcelain"], dir);

    expect(result.status).toBe("ok");
    expect(status.exitCode).toBe(0);
    expect(bytesRead(log)).toBeLessThan(NOTHING_READ);
    expect(await statRecorded(dir, A)).toBe(true);
    expect(await statRecorded(dir, B)).toBe(true);
    // The configuration is exactly what it was, metered filter process and all.
    expect(await filterConfig(dir)).toEqual(configured);
    // And the commit carries the keys git-annex computes from the bytes on disk.
    for (const path of [A, B]) {
      const key = (await run(["git", "annex", "calckey", path], dir)).stdout.trim();
      const pointer = await run(["git", "cat-file", "-p", `HEAD:${path}`], dir);
      expect(pointer.stdout.trim()).toBe(`/annex/objects/${key}`);
    }
  });

  test("the next upload's add does not re-read the large files the last one tracked", async () => {
    // Guards the call before the add. A completed upload clears its progress, so the next
    // one hands every data file to the add again, and the add's check of already-indexed
    // paths (`git diff`) reads each one twice when its entry has no stat data, which is
    // how the last upload's save leaves it on a tree that took the save's skip.
    const dir = await dataset("next", { [A]: 2 * MIB, [B]: 2 * MIB });
    const open = directoryRemote(dir);
    const first = await runSteps(dir, { openRemote: open, skipMinBytes: 1, primeMinBytes: NEVER });
    expect(first.status).toBe("ok");
    // The premise: the first upload left both entries without stat data.
    expect(await statRecorded(dir, A)).toBe(false);
    expect(await statRecorded(dir, B)).toBe(false);

    clearUploadProgress(dir);
    writeDataFile(dir, C, 2 * MIB, 9);
    const log = await meterFilterProcess(dir);
    const p = await plan(dir);
    // The premise: the files the first upload tracked are add targets again.
    expect(p.filesToUpload.map((f) => f.path).sort()).toEqual([A, B, C]);

    const result = await trackAndCopy(dir, { openRemote: open, primeMinBytes: MIB });

    expect(result.status).toBe("ok");
    expect(bytesRead(log)).toBeLessThan(NOTHING_READ);
    for (const path of [A, B, C]) expect(await statRecorded(dir, path)).toBe(true);
  });

  test("a resumed add does not re-read what the interrupted run had already added", async () => {
    // The other way an entry without stat data meets the add's check: a run that tracked
    // one batch and then died. `gitAnnexAdd` here is that finished batch.
    const dir = await dataset("resume", { [A]: 2 * MIB, [B]: 2 * MIB });
    expect((await gitAnnexAdd(dir, [A])).success).toBe(true);
    expect(await statRecorded(dir, A)).toBe(false);
    const log = await meterFilterProcess(dir);

    const result = await trackAndCopy(dir, {
      openRemote: directoryRemote(dir),
      primeMinBytes: MIB,
    });

    expect(result.status).toBe("ok");
    expect(bytesRead(log)).toBeLessThan(NOTHING_READ);
  });

  test("control: without the priming the same resume reads the added file twice", async () => {
    // Shows the counter can see the read the test above says is gone.
    const dir = await dataset("resume-control", { [A]: 2 * MIB, [B]: 2 * MIB });
    expect((await gitAnnexAdd(dir, [A])).success).toBe(true);
    const log = await meterFilterProcess(dir);

    const result = await trackAndCopy(dir, {
      openRemote: directoryRemote(dir),
      primeMinBytes: NEVER,
    });

    expect(result.status).toBe("ok");
    expect(bytesRead(log)).toBeGreaterThan(4 * MIB);
  });
});

describe("which files are primed", () => {
  test("the default threshold is one gibibyte, and a tree of smaller files is tracked as before", async () => {
    // The inverse path: below the threshold the step leaves the entries exactly as
    // `git annex add` staged them and never touches the configuration.
    expect(PRIME_MIN_FILE_BYTES).toBe(1_073_741_824);
    const dir = await dataset("default", { [A]: 2 * MIB, [B]: 2 * MIB });
    const configured = await filterConfig(dir);

    const result = await trackAndCopy(dir, { openRemote: directoryRemote(dir) });

    expect(result.status).toBe("ok");
    expect(await statRecorded(dir, A)).toBe(false);
    expect(await statRecorded(dir, B)).toBe(false);
    expect(await filterConfig(dir)).toEqual(configured);
  });

  test("only files whose recorded size reaches the threshold are primed", async () => {
    // Guards `f.size >= minBytes`: a file below it is left to filter-process, where many
    // small files are cheaper than one git-annex process each.
    const dir = await dataset("mixed", { [A]: 2 * MIB, [B]: 4 * MIB, [C]: 3 * MIB });
    const result = await trackAndCopy(dir, {
      openRemote: directoryRemote(dir),
      primeMinBytes: 3 * MIB,
    });
    expect(result.status).toBe("ok");
    expect(await statRecorded(dir, A)).toBe(false);
    expect(await statRecorded(dir, B)).toBe(true);
    expect(await statRecorded(dir, C)).toBe(true);
  });
});

describe("the priming can neither hide nor stage an edit", () => {
  /** A whole-second instant, so a file's mtime can be put back bit for bit. */
  const PINNED_S = 1_700_000_000;

  /** Two annexed files, then `a.edf` rewritten in place: same inode, same size. */
  async function editedAfterTracking(name: string, keepMtime: boolean): Promise<string> {
    const dir = await newDatasetRepo(scratch.root, name);
    writeFile(dir, "a.edf", Buffer.alloc(300_000, 1));
    writeFile(dir, "b.edf", Buffer.alloc(300_000, 2));
    for (const p of ["a.edf", "b.edf"]) utimesSync(join(dir, p), PINNED_S, PINNED_S);
    expect((await gitAnnexAdd(dir, ["a.edf", "b.edf"])).success).toBe(true);
    const fd = openSync(join(dir, "a.edf"), "r+");
    writeSync(fd, Buffer.from("EDITED IN PLACE"), 0, 15, 1_000);
    closeSync(fd);
    if (keepMtime) utimesSync(join(dir, "a.edf"), PINNED_S, PINNED_S);
    return dir;
  }

  test("a file edited after tracking keeps zero stat data, is not staged, and shows as modified", async () => {
    // Guards the choice of `git add --refresh`, which only records stat data for content
    // that cleans to the staged blob. `git update-index --refresh --stdin`, which git-annex
    // uses for its own restage, stages the edit instead.
    const dir = await editedAfterTracking("edit", false);
    const staged = (await run(["git", "ls-files", "-s"], dir)).stdout;

    const res = await primeIndexStat(dir, ["a.edf", "b.edf"]);

    expect(res).toEqual({ primed: 2 });
    expect((await run(["git", "ls-files", "-s"], dir)).stdout).toBe(staged);
    expect(await statRecorded(dir, "a.edf")).toBe(false);
    expect(await statRecorded(dir, "b.edf")).toBe(true);
    const status = await run(["git", "status", "--porcelain"], dir);
    expect(status.stdout.split("\n")).toContain("AM a.edf");
    expect(status.stdout.split("\n")).toContain("A  b.edf");
  });

  test("an edit that puts size and mtime back is missed by filter-process too: the priming hides nothing it would show", async () => {
    // A characterization, recorded because the claim in ADR 0100 rests on it. git-annex's
    // inode cache is inode, size and mtime, and both filter forms answer from it, so an
    // in-place edit that restores the mtime exactly is invisible to `git status` through
    // filter-process just as it is to the per-file filter. If git-annex ever starts hashing
    // what filter-process is sent, this fails and the ADR's equivalence no longer holds.
    const viaProcess = await editedAfterTracking("edit-kept-process", true);
    const statusViaProcess = await run(["git", "status", "--porcelain"], viaProcess);
    expect(statusViaProcess.stdout.split("\n")).toContain("A  a.edf");

    const viaPrime = await editedAfterTracking("edit-kept-prime", true);
    const staged = (await run(["git", "ls-files", "-s"], viaPrime)).stdout;
    expect(await primeIndexStat(viaPrime, ["a.edf", "b.edf"])).toEqual({ primed: 2 });
    expect((await run(["git", "ls-files", "-s"], viaPrime)).stdout).toBe(staged);
    const statusViaPrime = await run(["git", "status", "--porcelain"], viaPrime);
    expect(statusViaPrime.stdout.split("\n")).toContain("A  a.edf");
  });

  test("a path that is not in the index, or no longer on disk, does not stop the rest", async () => {
    // Guards the index filter: `git add --refresh` refuses the whole list over one path
    // that is not in the index, and git's pathspecs are literal here.
    const dir = await trackedRepo(scratch.root, "paths", {
      "gone.edf": 300_000,
      "star*.edf": 300_000,
      "starX.edf": 300_000,
    });
    writeFile(dir, "untracked.edf", 300_000);
    rmSync(join(dir, "gone.edf"));

    const res = await primeIndexStat(dir, ["untracked.edf", "gone.edf", "star*.edf"]);

    expect(res).toEqual({ primed: 2 });
    expect(await statRecorded(dir, "star*.edf")).toBe(true);
    expect(await statRecorded(dir, "starX.edf")).toBe(false);
    const status = await run(["git", "status", "--porcelain"], dir);
    expect(status.stdout.split("\n")).toContain("AD gone.edf");
  });
});

describe("the filter process never stays out of the configuration", () => {
  const runner = join(import.meta.dir, "helpers", "prime-runner.ts");

  test("SIGTERM inside the window puts it back before the process dies", async () => {
    // Guards armRestoreOnInterrupt. Nothing but the handler can restore it here: the
    // process dies by the signal before the `finally` runs.
    const dir = await trackedRepo(scratch.root, "sigterm", { "a.edf": 300_000 });
    const configured = await filterConfig(dir);
    const child = Bun.spawn(["bun", "run", runner, dir, "SIGTERM", "a.edf"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await child.exited;

    expect(child.signalCode).toBe("SIGTERM");
    expect(await filterConfig(dir)).toEqual(configured);
  });

  test("SIGKILL leaves git-annex's marker, and the next upload puts it back first", async () => {
    // Guards the restore at the start of runDataSteps. SIGKILL runs no handler, so what it
    // leaves is exactly git-annex's own interrupted-restage state.
    const dir = await dataset("sigkill", { [A]: 300_000 });
    const configured = await filterConfig(dir);
    expect((await gitAnnexAdd(dir, [A])).success).toBe(true);
    const child = Bun.spawn(["bun", "run", runner, dir, "SIGKILL", A], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    expect(await filterConfig(dir)).toEqual({ process: [], marker: configured.process });

    const result = await runSteps(dir, { openRemote: directoryRemote(dir) });

    expect(result.status).toBe("ok");
    expect(await filterConfig(dir)).toEqual(configured);
  });

  test("a configuration that cannot be put back fails the step, and the re-run puts it back", async () => {
    // Guards the `error` path: a read-only `.git` makes both the refresh and the restore
    // fail inside the window. Tracking itself finished, so its stamp stands.
    const dir = await dataset("unrestorable", { [A]: 2 * MIB });
    const configured = await filterConfig(dir);
    const gitDir = join(dir, ".git");
    let result: Awaited<ReturnType<typeof trackAndCopy>>;
    try {
      result = await trackAndCopy(dir, {
        openRemote: directoryRemote(dir),
        primeMinBytes: MIB,
        primeOnSuspended: () => chmodSync(gitDir, 0o555),
      });
    } finally {
      chmodSync(gitDir, 0o755);
    }

    expect(result.status).toBe("fail");
    const progress = readUploadProgress(dir);
    expect(progress).not.toBeNull();
    expect(isStepCompleted(progress as UploadProgress, "tracking")).toBe(true);
    expect(await filterConfig(dir)).toEqual({ process: [], marker: configured.process });

    const rerun = await runSteps(dir, { openRemote: directoryRemote(dir) });
    expect(rerun.status).toBe("ok");
    expect(await filterConfig(dir)).toEqual(configured);
  });

  test("a marker the upload cannot clear stops the upload before it tracks anything", async () => {
    // Guards the fail-closed restore at the start of runDataSteps.
    const dir = await dataset("stuck-marker", { [A]: 300_000 });
    const configured = await filterConfig(dir);
    await run(["git", "config", "--local", FILTER_PROCESS_MARKER, configured.process[0]], dir);
    await run(["git", "config", "--local", "--unset-all", FILTER_PROCESS_KEY], dir);
    const gitDir = join(dir, ".git");
    chmodSync(gitDir, 0o555);
    let result: Awaited<ReturnType<typeof runSteps>>;
    try {
      result = await runSteps(dir, { openRemote: directoryRemote(dir) });
    } finally {
      chmodSync(gitDir, 0o755);
    }
    expect(result.status).toBe("fail");
    expect((await run(["git", "ls-files", A], dir)).stdout.trim()).toBe("");
  });
});

describe("configurations the priming leaves alone", () => {
  test("with no filter process configured anywhere, it primes and adds none", async () => {
    // The issue's own workaround: the person unset filter.annex.process. Git already uses
    // the per-file filter, and the step must not put a filter process back.
    const dir = await trackedRepo(scratch.root, "none", { "a.edf": 300_000 });
    await run(["git", "config", "--local", "--unset-all", FILTER_PROCESS_KEY], dir);

    const res = await primeIndexStat(dir, ["a.edf"]);

    expect(res).toEqual({ primed: 1 });
    expect(await statRecorded(dir, "a.edf")).toBe(true);
    expect(await filterConfig(dir)).toEqual({ process: [], marker: [] });
  });

  test("a filter process set outside the repository's own file is not touched, and nothing is primed", async () => {
    // An included file stands in for any scope `git config --local --unset-all` cannot
    // reach (global, system, an include): the value is in effect and cannot be taken out
    // for one command, so the guard must leave it, and the files, alone.
    const dir = await trackedRepo(scratch.root, "included", { "a.edf": 300_000 });
    await run(["git", "config", "--local", "--unset-all", FILTER_PROCESS_KEY], dir);
    const included = join(scratch.root, `included-${Math.random().toString(36).slice(2)}`);
    writeFileSync(included, "");
    await run([
      "git",
      "config",
      "--file",
      included,
      FILTER_PROCESS_KEY,
      "git-annex filter-process",
    ]);
    await run(["git", "config", "--local", "include.path", included], dir);

    const res = await primeIndexStat(dir, ["a.edf"]);

    expect(res.primed).toBe(0);
    expect(res.skipped).toContain("outside this repository");
    expect(await statRecorded(dir, "a.edf")).toBe(false);
    expect(await filterConfig(dir)).toEqual({ process: [], marker: [] });
    const effective = await run(["git", "config", "--get-all", FILTER_PROCESS_KEY], dir);
    expect(effective.stdout.trim()).toBe("git-annex filter-process");
  });

  test("a clean filter that is not git-annex's is not relied on", async () => {
    const dir = await trackedRepo(scratch.root, "foreign-clean", { "a.edf": 300_000 });
    const configured = await filterConfig(dir);
    await run(["git", "config", "--local", "filter.annex.clean", "cat"], dir);

    const res = await primeIndexStat(dir, ["a.edf"]);

    expect(res.primed).toBe(0);
    expect(res.skipped).toContain("filter.annex.clean");
    expect(await filterConfig(dir)).toEqual(configured);
  });

  test("a marker next to a filter process that is back (git annex init sets it) is only removed", async () => {
    const dir = await trackedRepo(scratch.root, "marker-only", { "a.edf": 300_000 });
    const configured = await filterConfig(dir);
    await run(["git", "config", "--local", FILTER_PROCESS_MARKER, "something else"], dir);

    expect(await restoreSuspendedFilterProcess(dir)).toEqual({ restored: false });
    expect(await filterConfig(dir)).toEqual(configured);
  });
});
