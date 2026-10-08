/**
 * The save step's skip of annexed content, and what keeps it from hiding anything.
 *
 * Marking a path assume-unchanged hides it from `git add -A`, `git status` and the
 * commit. That is the point (it is what stops 1.6 TB being streamed through
 * git-annex filter-process again), and it is also exactly how an edit, a deletion
 * or a crash could be lost without a word. Each guard below is a way the skip could
 * have done that, exercised against real git-annex on a real repository with the
 * production init path, and each names the line it guards.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type SkipContentCheckEntry,
  clearStaleAssumeUnchanged,
  compareRecordedStat,
  describeChangedSinceTracked,
  saveDataset,
  setAssumeUnchanged,
} from "../src/lib/git-annex/clone-push";
import { gitAnnexAdd } from "../src/lib/git-annex/init";
import { collectFileManifest } from "../src/lib/git-annex/transfer";
import {
  getFilesNeedingUpload,
  hasFileListChanged,
  initUploadProgress,
  isStepCompleted,
  markFileUploaded,
} from "../src/lib/upload-progress";
import { SAVE_SKIP_MIN_BYTES, planSaveSkip, saveDatasetStep } from "../src/lib/upload/finalize";
import { copyAnnexedToRemote, listAnnexedPaths, trackDataFiles } from "../src/lib/upload/transfer";
import {
  initDirectoryRemote,
  makeScratch,
  newDatasetRepo,
  run,
  writeFile,
} from "./helpers/annex-repo";

const scratch = makeScratch("nemar-save-skip");

beforeAll(async () => {
  const probe = await run(["git", "annex", "version"]);
  if (probe.exitCode !== 0) throw new Error("git-annex is required for this test file");
});
afterAll(() => scratch.cleanup());

const MIB = 1024 * 1024;

/** What the upload records for each tracked file. */
function recorded(dir: string, paths: string[]): SkipContentCheckEntry[] {
  return paths.map((path) => {
    const st = statSync(join(dir, path));
    return { path, size: st.size, mtimeMs: st.mtimeMs };
  });
}

/** `git ls-files -v` tags, one per path: "H" ordinary, lowercase "h" assume-unchanged. */
async function tags(dir: string, ...paths: string[]): Promise<Record<string, string>> {
  const out = await run(["git", "ls-files", "-v", "-z", "--", ...paths], dir);
  const result: Record<string, string> = {};
  for (const entry of out.stdout.split("\0").filter(Boolean)) result[entry.slice(2)] = entry[0];
  return result;
}

async function commitCount(dir: string): Promise<number> {
  return Number((await run(["git", "rev-list", "--count", "HEAD"], dir)).stdout.trim());
}

/** A repo with `files` annexed (not yet committed), as the tracking step leaves it. */
async function trackedRepo(name: string, files: Record<string, number>) {
  const dir = await newDatasetRepo(scratch.root, name);
  for (const [path, size] of Object.entries(files))
    writeFile(dir, path, `${path}:`.padEnd(size, "x"));
  expect((await gitAnnexAdd(dir, Object.keys(files))).success).toBe(true);
  return dir;
}

/** Route this repo's filter-process through `tee` so re-read content is countable. */
async function meterFilterProcess(dir: string): Promise<string> {
  const log = join(dir, "..", `${Math.random().toString(36).slice(2)}.filterlog`);
  writeFileSync(log, "");
  const set = await run(
    ["git", "config", "filter.annex.process", `sh -c 'tee -a "${log}" | git-annex filter-process'`],
    dir,
  );
  expect(set.exitCode).toBe(0);
  return log;
}

/** Make the next commit's pre-commit hook run `script` first, then git-annex's own hook. */
function prependPreCommit(dir: string, script: string): void {
  const hook = join(dir, ".git", "hooks", "pre-commit");
  const original = readFileSync(hook, "utf-8");
  writeFileSync(hook, `#!/bin/sh\n${script}\n${original.replace(/^#!.*\n/, "")}`);
  chmodSync(hook, 0o755);
}

describe("the stat guard: a changed file fails the save", () => {
  test("an edit between tracking and save fails the save, naming the file, and commits nothing", async () => {
    // Guards `check.changed.length > 0` in saveDataset. Without it the file is flagged
    // assume-unchanged, `git add -A` skips it, and the commit carries the pointer that was
    // uploaded while the tree holds different bytes.
    const dir = await trackedRepo("guard-edit", { "a.edf": 3_000, "b.edf": 3_000 });
    const entries = recorded(dir, ["a.edf", "b.edf"]);
    const before = await commitCount(dir);

    // Same size, different content, later mtime: the case size alone cannot see.
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(dir, "a.edf"), "y".repeat(3_000));

    const res = await saveDataset(dir, "upload", undefined, { skipContentCheck: entries });

    expect(res.success).toBe(false);
    expect(res.error).toContain("1 annexed file(s) changed since they were tracked");
    expect(res.error).toContain("a.edf");
    expect(res.error).not.toContain("b.edf");
    expect(res.error).toContain("Re-run the upload command to re-track them");
    expect(await commitCount(dir)).toBe(before);
    // Nothing was marked, so nothing is left behind.
    expect(await tags(dir, "a.edf", "b.edf")).toEqual({ "a.edf": "H", "b.edf": "H" });
  });

  test("a size change fails too, and a long list is cut to the first few", async () => {
    const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.edf`, 3_000]));
    const dir = await trackedRepo("guard-many", files);
    const paths = Object.keys(files);
    const entries = recorded(dir, paths);
    for (const p of paths) writeFileSync(join(dir, p), "z".repeat(3_100));

    const res = await saveDataset(dir, "upload", undefined, { skipContentCheck: entries });
    expect(res.success).toBe(false);
    expect(res.error).toContain("6 annexed file(s) changed since they were tracked");
    expect(res.error).toContain("(and 3 more)");
    expect(res.error?.match(/f\d\.edf/g)).toHaveLength(3);
  });

  test("a file that changes while the save runs fails it, and the flags are still cleared", async () => {
    // Guards the check after the commit. A pre-commit hook is a real way for a file to
    // change under a running save: it runs after the add and before the commit exists.
    const dir = await trackedRepo("guard-during", { "a.edf": 3_000, "b.edf": 3_000 });
    const entries = recorded(dir, ["a.edf", "b.edf"]);
    prependPreCommit(
      dir,
      'sleep 0.05; echo changed-during-the-save >> "$(git rev-parse --show-toplevel)/a.edf"',
    );

    const res = await saveDataset(dir, "upload", undefined, { skipContentCheck: entries });

    expect(res.success).toBe(false);
    expect(res.error).toContain("changed while the save was running");
    expect(res.error).toContain("a.edf");
    expect(await tags(dir, "a.edf", "b.edf")).toEqual({ "a.edf": "H", "b.edf": "H" });
  });

  test("the re-run the message asks for does re-track the file, and the save then passes", async () => {
    // The failure text promises that re-running re-tracks the file. That promise is made
    // of pieces that live elsewhere (the changed-list check, the upload list, the add, the
    // copy, the refreshed record), so walk them in the order a re-run does and watch the
    // commit end up with the NEW key, not the one that was uploaded first.
    const dir = await trackedRepo("rerun", { "a.edf": 3_000, "b.edf": 3_000 });
    await initDirectoryRemote(scratch.root, dir, "nemar-s3");
    const dataOf = async () =>
      (await collectFileManifest(dir)).files.filter((f) => f.type === "data");
    const first = await dataOf();
    const progress = initUploadProgress(dir, "nm000993", first);
    const copied = await copyAnnexedToRemote({
      absolutePath: dir,
      remote: "nemar-s3",
      addTargets: first,
      jobs: 1,
    });
    expect(copied.status).toBe("ok");
    if (copied.status !== "ok") throw new Error("unreachable");
    for (const f of first) markFileUploaded(progress, f.path, f);
    const oldKey = (await run(["git", "annex", "lookupkey", "a.edf"], dir)).stdout.trim();

    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(dir, "a.edf"), "e".repeat(3_000));
    const failed = await saveDatasetStep(dir, undefined, progress, {
      annexedPaths: copied.annexedPaths,
      skipMinBytes: 1,
    });
    expect(failed.status).toBe("fail");

    // The re-run: a fresh manifest sees the edit, the upload list names the file...
    const second = await dataOf();
    expect(hasFileListChanged(progress, second)).toBe(true);
    const todo = getFilesNeedingUpload(progress, second);
    expect(todo.map((f) => f.path)).toEqual(["a.edf"]);
    // ...it is re-added under a new key, copied, recorded, and the save passes.
    expect(
      (
        await trackDataFiles(
          dir,
          todo.map((f) => f.path),
        )
      ).success,
    ).toBe(true);
    const newKey = (await run(["git", "annex", "lookupkey", "a.edf"], dir)).stdout.trim();
    expect(newKey).not.toBe(oldKey);
    const again = await copyAnnexedToRemote({
      absolutePath: dir,
      remote: "nemar-s3",
      addTargets: todo,
      jobs: 1,
    });
    expect(again).toMatchObject({ status: "ok", attempted: 1 });
    if (again.status !== "ok") throw new Error("unreachable");
    for (const f of todo) markFileUploaded(progress, f.path, f);
    const saved = await saveDatasetStep(dir, undefined, progress, {
      annexedPaths: again.annexedPaths,
      skipMinBytes: 1,
    });
    expect(saved.status).toBe("ok");
    const pointer = await run(["git", "cat-file", "-p", "HEAD:a.edf"], dir);
    expect(pointer.stdout.trim()).toBe(`/annex/objects/${newKey}`);
  });

  test("compareRecordedStat sorts unchanged from changed, and leaves a deleted path out of both", async () => {
    const dir = await trackedRepo("compare", {
      "keep.edf": 3_000,
      "edit.edf": 3_000,
      "gone.edf": 3_000,
    });
    const entries = recorded(dir, ["keep.edf", "edit.edf", "gone.edf"]);
    writeFileSync(join(dir, "edit.edf"), "q".repeat(3_001));
    rmSync(join(dir, "gone.edf"));
    const out = compareRecordedStat(dir, entries);
    expect(out.unchanged.map((e) => e.path)).toEqual(["keep.edf"]);
    expect(out.changed).toEqual(["edit.edf"]);
  });

  test("an mtime moved by a second is a change even when the size and bytes match", async () => {
    const dir = await trackedRepo("mtime", { "a.edf": 3_000 });
    const entries = recorded(dir, ["a.edf"]);
    const later = new Date(entries[0].mtimeMs + 1_000);
    utimesSync(join(dir, "a.edf"), later, later);
    expect(compareRecordedStat(dir, entries).changed).toEqual(["a.edf"]);
  });

  test("describeChangedSinceTracked says what to do", () => {
    expect(describeChangedSinceTracked(["a.edf"], "before")).toBe(
      "1 annexed file(s) changed since they were tracked, so the commit would not match the tree: a.edf. Re-run the upload command to re-track them.",
    );
  });
});

describe("stale flags: an interrupted save does not hide later edits", () => {
  test("an annexed file left flagged by a killed save has its edit saved by the next one", async () => {
    // Guards clearStaleAssumeUnchanged at the entry of saveDataset. The bit lives in the
    // index, so a Ctrl-C between mark and unmark leaves it there; without the clear,
    // `git add -A` omits this file's edits from every later save, including the plain
    // `nemar dataset update` path that passes no skip at all.
    const dir = await trackedRepo("stale-edit", { "a.edf": 3_000, "b.edf": 3_000 });
    expect((await saveDataset(dir, "first")).success).toBe(true);
    expect((await setAssumeUnchanged(dir, ["a.edf", "b.edf"], true)).success).toBe(true);
    expect(await tags(dir, "a.edf", "b.edf")).toEqual({ "a.edf": "h", "b.edf": "h" });

    writeFileSync(join(dir, "a.edf"), "w".repeat(3_500));
    const res = await saveDataset(dir, "second");

    expect(res.success).toBe(true);
    expect(await tags(dir, "a.edf", "b.edf")).toEqual({ "a.edf": "H", "b.edf": "H" });
    // The edit reached the commit: the pointer for a.edf changed.
    const changed = await run(["git", "show", "--name-only", "--format=", "HEAD"], dir);
    expect(changed.stdout.split("\n").filter(Boolean)).toEqual(["a.edf"]);
  });

  test("a flagged annexed file that was deleted has its deletion saved", async () => {
    const dir = await trackedRepo("stale-delete", { "a.edf": 3_000, "b.edf": 3_000 });
    expect((await saveDataset(dir, "first")).success).toBe(true);
    expect((await setAssumeUnchanged(dir, ["b.edf"], true)).success).toBe(true);
    rmSync(join(dir, "b.edf"));

    expect((await saveDataset(dir, "second")).success).toBe(true);
    const tree = await run(["git", "ls-tree", "-r", "--name-only", "HEAD"], dir);
    expect(tree.stdout).toContain("a.edf");
    expect(tree.stdout).not.toContain("b.edf");
  });

  test("a flag on a file that is not annexed is not ours and is left alone", async () => {
    const dir = await trackedRepo("stale-foreign", { "a.edf": 3_000 });
    writeFile(dir, "notes.txt", "mine");
    expect((await saveDataset(dir, "first")).success).toBe(true);
    expect((await setAssumeUnchanged(dir, ["notes.txt"], true)).success).toBe(true);
    writeFileSync(join(dir, "notes.txt"), "mine, edited, deliberately kept out of commits");

    expect(await clearStaleAssumeUnchanged(dir)).toEqual({ cleared: 0 });
    expect((await saveDataset(dir, "second")).success).toBe(true);
    expect(await tags(dir, "notes.txt")).toEqual({ "notes.txt": "h" });
  });

  test("a locked (symlink) annexed file is recognized as annexed too", async () => {
    // The dataset repos here are unlocked, but a clone made elsewhere can hold locked
    // files, and the recognition must not depend on which kind the index holds.
    const dir = join(scratch.root, "locked-repo");
    expect((await run(["git", "init", "-q", "-b", "main", dir])).exitCode).toBe(0);
    await run(["git", "config", "user.email", "test@test.com"], dir);
    await run(["git", "config", "user.name", "Test"], dir);
    expect((await run(["git", "annex", "init"], dir)).exitCode).toBe(0);
    writeFile(dir, "sub-01/eeg/a.edf", 3_000);
    expect(
      (await run(["git", "annex", "add", "--force-large", "sub-01/eeg/a.edf"], dir)).exitCode,
    ).toBe(0);
    expect((await run(["git", "commit", "-q", "-m", "add"], dir)).exitCode).toBe(0);
    const mode = (await run(["git", "ls-files", "-s", "sub-01/eeg/a.edf"], dir)).stdout;
    expect(mode.startsWith("120000")).toBe(true);
    expect((await setAssumeUnchanged(dir, ["sub-01/eeg/a.edf"], true)).success).toBe(true);

    expect(await clearStaleAssumeUnchanged(dir)).toEqual({ cleared: 1 });
    expect(await tags(dir, "sub-01/eeg/a.edf")).toEqual({ "sub-01/eeg/a.edf": "H" });
  });

  test("a repository with no flags costs one index read and reports nothing cleared", async () => {
    const dir = await trackedRepo("stale-none", { "a.edf": 3_000 });
    expect(await clearStaleAssumeUnchanged(dir)).toEqual({ cleared: 0 });
  });

  test("a directory git cannot list reports the error instead of a clean result", async () => {
    // The scratch root is outside any repository; a directory that does not exist at all
    // makes the spawn itself fail, and neither may escape as a throw out of a save.
    for (const dir of [scratch.root, join(scratch.root, "no-such-directory")]) {
      const out = await clearStaleAssumeUnchanged(dir);
      expect(out.cleared).toBe(0);
      expect(out.error).toBeTruthy();
    }
  });
});

describe("the bits never outlive the save", () => {
  test("a save whose commit fails still clears them", async () => {
    // Guards the unmark in saveDataset's `finally`. A failing pre-commit hook is a real
    // way for the commit to fail after the paths were marked.
    const dir = await trackedRepo("finally-fail", { "a.edf": 3_000, "b.edf": 3_000 });
    const entries = recorded(dir, ["a.edf", "b.edf"]);
    prependPreCommit(dir, "exit 1");

    const res = await saveDataset(dir, "upload", undefined, { skipContentCheck: entries });

    expect(res.success).toBe(false);
    expect(await tags(dir, "a.edf", "b.edf")).toEqual({ "a.edf": "H", "b.edf": "H" });
  });

  test("a successful save clears them too", async () => {
    const dir = await trackedRepo("finally-ok", { "a.edf": 3_000, "b.edf": 3_000 });
    const entries = recorded(dir, ["a.edf", "b.edf"]);
    const res = await saveDataset(dir, "upload", undefined, { skipContentCheck: entries });
    expect(res).toEqual({ success: true });
    expect(await tags(dir, "a.edf", "b.edf")).toEqual({ "a.edf": "H", "b.edf": "H" });
  });
});

describe("a failure to mark degrades to the plain save", () => {
  test("an entry git cannot mark warns, saves everything, and leaves no flags", async () => {
    // Guards the marking branch. `untracked.edf` is on disk with a matching stat but is
    // not in the index, which makes `git update-index --assume-unchanged` fail for the
    // whole list. The save must proceed without the skip rather than refuse.
    const dir = await trackedRepo("mark-fails", { "a.edf": 3_000 });
    writeFile(dir, "untracked.edf", 3_000);
    const entries = recorded(dir, ["a.edf", "untracked.edf"]);

    const res = await saveDataset(dir, "upload", undefined, { skipContentCheck: entries });

    expect(res).toEqual({ success: true });
    const tree = await run(["git", "ls-tree", "-r", "--name-only", "HEAD"], dir);
    expect(tree.stdout).toContain("a.edf");
    expect(tree.stdout).toContain("untracked.edf");
    expect(Object.values(await tags(dir))).toEqual(["H", "H"]);
  });
});

describe("planSaveSkip and the size gate", () => {
  test("the default threshold is one gibibyte", () => {
    expect(SAVE_SKIP_MIN_BYTES).toBe(1_073_741_824);
  });

  test("below the threshold there is no plan; at it, every path with a recorded mtime is in it", async () => {
    const dir = await trackedRepo("plan", { "a.edf": 3_000, "b.edf": 5_000 });
    const manifest = await collectFileManifest(dir);
    const progress = initUploadProgress(dir, "nm000990", manifest.files);
    const annexed = await listAnnexedPaths(dir);

    expect(planSaveSkip(progress, annexed)).toBeNull();
    expect(planSaveSkip(progress, annexed, 8_001)).toBeNull();
    const plan = planSaveSkip(progress, annexed, 8_000);
    expect(plan?.map((e) => e.path).sort()).toEqual(["a.edf", "b.edf"]);
    expect(plan?.map((e) => e.size).sort()).toEqual([3_000, 5_000]);

    // A path with no recorded mtime cannot be vouched for, so it is read as before.
    progress.files["a.edf"].mtimeMs = undefined;
    expect(planSaveSkip(progress, annexed, 1)?.map((e) => e.path)).toEqual(["b.edf"]);
    // And a path the progress never saw is not skippable either.
    expect(planSaveSkip(progress, new Set(["stranger.edf"]), 0)).toEqual([]);
  });

  /** Two 2 MiB annexed recordings plus a small JSON, tracked and ready to save. */
  async function bigRepo(name: string) {
    const dir = await newDatasetRepo(scratch.root, name);
    writeFile(dir, "sub-01/eeg/a.edf", Buffer.alloc(2 * MIB, 7));
    writeFile(dir, "sub-01/eeg/b.edf", Buffer.alloc(2 * MIB, 9));
    writeFile(dir, "dataset_description.json", '{"Name":"x"}');
    expect((await gitAnnexAdd(dir, ["sub-01/eeg/a.edf", "sub-01/eeg/b.edf"])).success).toBe(true);
    const manifest = await collectFileManifest(dir);
    const progress = initUploadProgress(
      dir,
      "nm000991",
      manifest.files.filter((f) => f.type === "data"),
    );
    const log = await meterFilterProcess(dir);
    const probe = join(dir, "..", `${Math.random().toString(36).slice(2)}.flags`);
    // The pre-commit hook runs INSIDE the window, after the paths are marked and before
    // they are unmarked, so it sees exactly which paths the save chose to skip.
    prependPreCommit(dir, `git ls-files -v -z > "${probe}"`);
    return { dir, progress, log, probe, annexed: await listAnnexedPaths(dir) };
  }

  /** The paths that carried the assume-unchanged tag while the commit was being made. */
  function skippedDuringSave(probe: string): string[] {
    return readFileSync(probe, "utf-8")
      .split("\0")
      .filter((e) => /^[a-z] /.test(e))
      .map((e) => e.slice(2))
      .sort();
  }

  test("control: below the threshold the save reads the annexed content exactly as before", async () => {
    // Guards the threshold. With the default one gibibyte, a 4 MiB tree takes the plain
    // path: nothing is marked, and both files stream through the filter.
    const { dir, progress, log, probe, annexed } = await bigRepo("gate-below");
    const step = await saveDatasetStep(dir, undefined, progress, { annexedPaths: annexed });
    expect(step.status).toBe("ok");
    expect(isStepCompleted(progress, "dataset_save")).toBe(true);
    expect(skippedDuringSave(probe)).toEqual([]);
    expect(readFileSync(log).length).toBeGreaterThan(4 * MIB);
  });

  test("above the threshold the save skips the re-read and still commits the same tree", async () => {
    const { dir, progress, log, probe, annexed } = await bigRepo("gate-above");
    const step = await saveDatasetStep(dir, undefined, progress, {
      annexedPaths: annexed,
      skipMinBytes: MIB,
    });
    expect(step.status).toBe("ok");
    expect(skippedDuringSave(probe)).toEqual(["sub-01/eeg/a.edf", "sub-01/eeg/b.edf"]);
    expect(readFileSync(log).length).toBeLessThan(64 * 1024);
    const tree = await run(["git", "ls-tree", "-r", "--name-only", "HEAD"], dir);
    for (const p of ["dataset_description.json", "sub-01/eeg/a.edf", "sub-01/eeg/b.edf"]) {
      expect(tree.stdout).toContain(p);
    }
    const blob = await run(["git", "cat-file", "-p", "HEAD:sub-01/eeg/a.edf"], dir);
    expect(blob.stdout.startsWith("/annex/objects/")).toBe(true);
    expect(Object.values(await tags(dir, "sub-01/eeg/a.edf", "sub-01/eeg/b.edf"))).toEqual([
      "H",
      "H",
    ]);
  });

  test("when the S3 step handed on no annexed set, the save lists it itself", async () => {
    const { dir, progress, probe } = await bigRepo("gate-list");
    const step = await saveDatasetStep(dir, undefined, progress, { skipMinBytes: MIB });
    expect(step.status).toBe("ok");
    expect(skippedDuringSave(probe)).toEqual(["sub-01/eeg/a.edf", "sub-01/eeg/b.edf"]);
  });

  test("only the paths the S3 step handed on are skipped", async () => {
    // Guards the set being used as given: a set narrowed to this run's targets would
    // silently re-read every annexed file an earlier run left, which is what a resume has.
    const { dir, progress, probe } = await bigRepo("gate-forwarded");
    await saveDatasetStep(dir, undefined, progress, {
      annexedPaths: new Set(["sub-01/eeg/a.edf"]),
      skipMinBytes: MIB,
    });
    expect(skippedDuringSave(probe)).toEqual(["sub-01/eeg/a.edf"]);
  });

  test("below the threshold the step does not even list the annexed files", async () => {
    // Guards the cheap pre-check in saveDatasetStep. A plain git repository makes
    // `git annex find` fail, so a listing attempt is visible as the step's own notice;
    // a small tree must never attempt one.
    const notices: string[] = [];
    const original = console.log;
    const plain = join(scratch.root, "plain-git-repo");
    await run(["git", "init", "-q", "-b", "main", plain]);
    await run(["git", "config", "user.email", "test@test.com"], plain);
    await run(["git", "config", "user.name", "Test"], plain);
    writeFile(plain, "small.edf", 1_000);
    const progress = initUploadProgress(plain, "nm000992", [
      { path: "small.edf", size: 1_000, mtimeMs: 1 },
    ]);
    console.log = (...args: unknown[]) => {
      notices.push(args.join(" "));
    };
    try {
      expect((await saveDatasetStep(plain, undefined, progress)).status).toBe("ok");
      expect(notices.join("\n")).not.toContain("Could not list annexed files");

      // Control: over the threshold the same repository DOES attempt it, and says so.
      progress.completed_steps = [];
      writeFile(plain, "more.edf", 1_000);
      expect((await saveDatasetStep(plain, undefined, progress, { skipMinBytes: 1 })).status).toBe(
        "ok",
      );
      expect(notices.join("\n")).toContain("Could not list annexed files");
    } finally {
      console.log = original;
    }
  });

  test("a file edited since tracking fails the step and leaves dataset_save unstamped", async () => {
    const { dir, progress, annexed } = await bigRepo("gate-edit");
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(dir, "sub-01/eeg/a.edf"), Buffer.alloc(2 * MIB, 3));

    const step = await saveDatasetStep(dir, undefined, progress, {
      annexedPaths: annexed,
      skipMinBytes: MIB,
    });

    expect(step.status).toBe("fail");
    expect(isStepCompleted(progress, "dataset_save")).toBe(false);
  });
});
