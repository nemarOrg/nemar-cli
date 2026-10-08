/**
 * Upload step 9, driven through its decisions against real git-annex and a real
 * `directory` special remote named `nemar-s3`.
 *
 * `copyAnnexedToRemote` is the function `uploadDataToS3` calls between configuring
 * the remote and printing the result: what to copy comes from the location log, a
 * large data file git-annex refused fails before any byte moves, and EVERY annexed
 * file has to end up recorded at the remote. The earlier tests of this step only
 * exercised pure helpers, so reverting `[...annexedPaths].filter(...)` to
 * `addTargets.filter(...)` left them all green. Each test below names the line it
 * guards; the mutation table in the PR says which revert turned which one red.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitAnnexAdd } from "../src/lib/git-annex/init";
import {
  type UploadProgress,
  initUploadProgress,
  isStepCompleted,
  markStepCompleted,
} from "../src/lib/upload-progress";
import {
  copyAnnexedToRemote,
  describeBlockedTracking,
  formatUploadSummary,
  listAnnexedPaths,
  recoverBlockedTracking,
  trackDataFiles,
} from "../src/lib/upload/transfer";
import {
  annexedSet,
  initDirectoryRemote,
  makeScratch,
  newDatasetRepo,
  run,
  writeFile,
} from "./helpers/annex-repo";

const REMOTE = "nemar-s3";
const scratch = makeScratch("nemar-s3-step");

beforeAll(async () => {
  const probe = await run(["git", "annex", "version"]);
  if (probe.exitCode !== 0) throw new Error("git-annex is required for this test file");
});
afterAll(() => scratch.cleanup());

interface Target {
  path: string;
  size: number;
  type: "data";
}

/** A dataset with the named files written, and a directory remote called nemar-s3. */
async function dataset(name: string, files: Record<string, number>) {
  const dir = await newDatasetRepo(scratch.root, name);
  const targets: Target[] = [];
  for (const [path, size] of Object.entries(files)) {
    writeFile(dir, path, `${path}:`.padEnd(size, "x"));
    targets.push({ path, size, type: "data" });
  }
  const store = await initDirectoryRemote(scratch.root, dir, REMOTE);
  return { dir, store, targets };
}

const step = (
  dir: string,
  addTargets: Target[],
  onPlan?: Parameters<typeof copyAnnexedToRemote>[0]["onPlan"],
) => copyAnnexedToRemote({ absolutePath: dir, remote: REMOTE, addTargets, jobs: 2, onPlan });

describe("copyAnnexedToRemote: what is copied", () => {
  test("a fresh upload copies every annexed file and records each at the remote", async () => {
    const { dir, targets } = await dataset("fresh", {
      "sub-01/eeg/a.edf": 3_000,
      "sub-01/eeg/b.edf": 3_000,
      "sub-02/eeg/c.edf": 3_000,
    });
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);

    const plans: Array<{ total: number; pending: number }> = [];
    const outcome = await step(dir, targets, (p) => {
      plans.push({ total: p.total, pending: p.pending });
    });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome).toMatchObject({ total: 3, attempted: 3, confirmed: 3 });
    expect(outcome.annexedPaths).toEqual(new Set(targets.map((t) => t.path)));
    expect(plans).toEqual([{ total: 3, pending: 3 }]);
    expect(await listAnnexedPaths(dir, REMOTE)).toEqual(new Set(targets.map((t) => t.path)));
  });

  test("a resume copies exactly the remainder, and a second run copies nothing", async () => {
    const { dir, targets } = await dataset("resume", {
      "a.edf": 3_000,
      "b.edf": 3_000,
      "c.edf": 3_000,
    });
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    // An earlier run got a and b to the remote before it died.
    expect(
      (await run(["git", "annex", "copy", "--to", REMOTE, "--", "a.edf", "b.edf"], dir)).exitCode,
    ).toBe(0);

    const first = await step(dir, targets);
    expect(first).toMatchObject({ status: "ok", total: 3, attempted: 1, confirmed: 1 });

    const second = await step(dir, targets);
    expect(second).toMatchObject({ status: "ok", total: 3, attempted: 0, confirmed: 0 });
  });

  test("an annexed file from an earlier run that never reached the remote is copied too", async () => {
    // Guards `pending` being the location log's remainder, not this run's add targets.
    // Reverting it to the targets leaves `old.edf` behind, and the verify-all check then
    // reports the step incomplete instead of ok.
    const { dir } = await dataset("left-behind", { "old.edf": 3_000, "new.edf": 3_000 });
    expect((await trackDataFiles(dir, ["old.edf"])).success).toBe(true);
    // The earlier run died after tracking `old.edf` and before copying it. This run only
    // adds `new.edf`.
    expect((await trackDataFiles(dir, ["new.edf"])).success).toBe(true);
    const thisRunsTargets: Target[] = [{ path: "new.edf", size: 3_000, type: "data" }];

    const outcome = await step(dir, thisRunsTargets);
    expect(outcome).toMatchObject({ status: "ok", total: 2, attempted: 2 });
    expect(await listAnnexedPaths(dir, REMOTE)).toEqual(new Set(["old.edf", "new.edf"]));
  });
});

describe("copyAnnexedToRemote: every annexed file must be recorded at the remote", () => {
  test("a file annexed after the plan was made is not copied, and the step says so", async () => {
    // Guards the post-copy check being "every annexed file", not "this run's targets".
    // A file annexed between the plan and the copy is not in `pending`, so the copy
    // leaves it; only the dataset-wide check can see that. `onPlan` is the production
    // callback the progress line hangs off, used here to land a real `git annex add`
    // at exactly that moment.
    const { dir, targets } = await dataset("late", { "a.edf": 3_000, "b.edf": 3_000 });
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);

    const outcome = await step(dir, targets, async () => {
      writeFile(dir, "late.edf", 3_000);
      expect((await gitAnnexAdd(dir, ["late.edf"])).success).toBe(true);
    });

    expect(outcome).toEqual({ status: "incomplete", missing: ["late.edf"], total: 3 });
    // The two planned files did arrive; only the late one is missing.
    expect(await listAnnexedPaths(dir, REMOTE)).toEqual(new Set(["a.edf", "b.edf"]));
  });

  test("a copy that fails reports git-annex's reason and leaves the log honest", async () => {
    const { dir, store, targets } = await dataset("copy-fails", { "a.edf": 3_000, "b.edf": 3_000 });
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    renameSync(store, `${store}.gone`);

    const outcome = await step(dir, targets);
    expect(outcome.status).toBe("copy_failed");
    if (outcome.status !== "copy_failed") throw new Error("unreachable");
    expect(outcome.error).toContain("is not accessible");
    expect(await listAnnexedPaths(dir, REMOTE)).toEqual(new Set());
  });

  test("a repository git cannot list is reported, not read as an empty dataset", async () => {
    const notARepo = join(scratch.root, "not-a-repo");
    writeFile(notARepo, "x.edf", 100);
    const outcome = await step(notARepo, []);
    expect(outcome.status).toBe("unreadable");
  });

  test("a dataset with no annexed files is ok with nothing to say", async () => {
    const { dir } = await dataset("empty", {});
    const outcome = await step(dir, []);
    expect(outcome).toMatchObject({ status: "ok", total: 0, attempted: 0 });
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(formatUploadSummary(outcome.total, outcome.attempted, outcome.confirmed)).toBe(
      "No annexed data files, so nothing was copied to S3",
    );
  });
});

describe("copyAnnexedToRemote: a data file git-annex refused", () => {
  /** big.edf is over the threshold, but an inherited `annex.largefiles=nothing` keeps it in git. */
  async function overridden(name: string) {
    const ds = await dataset(name, { "sub-01/eeg/ok.edf": 3_000 });
    writeFile(ds.dir, ".gitattributes", "big*.edf annex.largefiles=nothing\n");
    writeFile(ds.dir, "sub-01/eeg/big.edf", 200_000);
    const big: Target = { path: "sub-01/eeg/big.edf", size: 200_000, type: "data" };
    const targets = [...ds.targets, big];
    expect(
      (
        await trackDataFiles(
          ds.dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    return { ...ds, big, targets };
  }

  test("fails before copying anything, and names the file", async () => {
    // Guards the not-annexed check. Remove it and `big.edf` sails through: it is not
    // annexed, so the verify-all check never looks at it, and it is committed to git.
    const { dir, targets } = await overridden("blocked");
    expect((await annexedSet(dir)).has("sub-01/eeg/big.edf")).toBe(false);

    let planned = false;
    const outcome = await step(dir, targets, () => {
      planned = true;
    });

    expect(outcome).toEqual({
      status: "blocked",
      blocking: [{ path: "sub-01/eeg/big.edf", size: 200_000 }],
    });
    expect(planned).toBe(false);
    // Nothing was sent: the small file that WAS annexed is not at the remote either.
    expect(await listAnnexedPaths(dir, REMOTE)).toEqual(new Set());
  });

  test("a small file git-annex kept in git is reported and does not block", async () => {
    const { dir, targets } = await dataset("small", {
      "ok.edf": 3_000,
      "UPPER-small.edf": 3_000,
    });
    writeFile(dir, ".gitattributes", "UPPER-*.edf annex.largefiles=nothing\n");
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);

    const outcome = await step(dir, targets);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.smallNotAnnexed).toEqual(["UPPER-small.edf"]);
    expect(outcome.annexedPaths).toEqual(new Set(["ok.edf"]));
  });

  test("a metadata file in the targets is never held to the annexed standard", async () => {
    const { dir, targets } = await dataset("metadata", { "ok.edf": 3_000 });
    writeFile(dir, "participants.tsv", 400_000);
    expect((await trackDataFiles(dir, ["ok.edf"])).success).toBe(true);
    const withMeta = [
      ...targets,
      { path: "participants.tsv", size: 400_000, type: "metadata" as unknown as "data" },
    ];
    expect((await step(dir, withMeta)).status).toBe("ok");
  });
});

describe("recoverBlockedTracking: a blocked upload can be re-run", () => {
  async function blockedByAttributes(name: string) {
    const { dir, targets } = await dataset(name, { "ok.edf": 3_000 });
    writeFile(dir, ".gitattributes", "big*.edf annex.largefiles=nothing\n");
    writeFile(dir, "big.edf", 200_000);
    const all: Target[] = [...targets, { path: "big.edf", size: 200_000, type: "data" }];
    expect(
      (
        await trackDataFiles(
          dir,
          all.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    const progress: UploadProgress = initUploadProgress(dir, "nm000999", all);
    markStepCompleted(progress, "tracking");
    const outcome = await step(dir, all);
    expect(outcome.status).toBe("blocked");
    return { dir, all, progress };
  }

  test("control: fixing the cause alone does not help, because the blob is still staged", async () => {
    // The premise of the recovery (ADR 0060): `git annex add` is a no-op on a staged,
    // unmodified file. If git-annex ever changes that, this fails and the recovery is
    // dead weight.
    const { dir, all } = await blockedByAttributes("control");
    rmSync(join(dir, ".gitattributes"));
    expect(
      (
        await trackDataFiles(
          dir,
          all.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    expect((await annexedSet(dir)).has("big.edf")).toBe(false);
    expect((await step(dir, all)).status).toBe("blocked");
  });

  test("after recovery and a fix, the re-run annexes the file and the step passes", async () => {
    const { dir, all, progress } = await blockedByAttributes("recover");
    const before = readFileSync(join(dir, "big.edf"));

    expect(await recoverBlockedTracking(dir, progress, ["big.edf"])).toBe(1);

    // The blob is out of the index, the stamp is cleared, and the file is untouched.
    const tracked = (await run(["git", "ls-files", "--", "big.edf"], dir)).stdout;
    expect(tracked).toBe("");
    expect(isStepCompleted(progress, "tracking")).toBe(false);
    expect(readFileSync(join(dir, "big.edf")).equals(before)).toBe(true);

    rmSync(join(dir, ".gitattributes"));
    expect(
      (
        await trackDataFiles(
          dir,
          all.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    expect((await annexedSet(dir)).has("big.edf")).toBe(true);
    expect(await step(dir, all)).toMatchObject({ status: "ok", total: 2 });
  });

  test("a file .gitignore hides is never staged, and the re-run works once the pattern is fixed", async () => {
    const { dir, targets } = await dataset("ignored", { "ok.edf": 3_000 });
    writeFile(dir, ".gitignore", "big.edf\n");
    writeFile(dir, "big.edf", 200_000);
    const all: Target[] = [...targets, { path: "big.edf", size: 200_000, type: "data" }];
    expect(
      (
        await trackDataFiles(
          dir,
          all.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    const progress = initUploadProgress(dir, "nm000998", all);
    markStepCompleted(progress, "tracking");

    // git-annex skipped it without a word, so the step is blocked on a file that was
    // never staged: nothing to unstage, but the stamp still has to be cleared.
    expect((await step(dir, all)).status).toBe("blocked");
    expect(await recoverBlockedTracking(dir, progress, ["big.edf"])).toBe(0);
    expect(isStepCompleted(progress, "tracking")).toBe(false);

    rmSync(join(dir, ".gitignore"));
    expect(
      (
        await trackDataFiles(
          dir,
          all.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    expect(await step(dir, all)).toMatchObject({ status: "ok", total: 2 });
  });
});

describe("what the step says", () => {
  test("the blocked message names both causes, the threshold, and what was done", () => {
    const lines = describeBlockedTracking(
      Array.from({ length: 7 }, (_, i) => ({ path: `sub-0${i}/eeg/big.edf`, size: 200_000 })),
      7,
    );
    const text = lines.join("\n");
    expect(text).toContain("7 data files over 100,000 bytes were not added to git-annex");
    expect(text).toContain(".gitattributes");
    expect(text).toContain("annex.largefiles");
    expect(text).toContain(".gitignore");
    expect(text).toContain("7 of them were unstaged");
    expect(text).toContain("... and 2 more");
    expect(text).toContain("re-run `nemar dataset upload`");
  });

  test("when unstaging failed it prints the exact command instead of claiming it was done", () => {
    const text = describeBlockedTracking([{ path: "big.edf", size: 200_000 }], null).join("\n");
    expect(text).toContain("1 data file over 100,000 bytes was not added");
    expect(text).toContain("Could not unstage them. Run: git rm --cached -- big.edf");
    expect(text).not.toContain("were unstaged");
  });

  test("when nothing was staged it says so", () => {
    const text = describeBlockedTracking([{ path: "big.edf", size: 200_000 }], 0).join("\n");
    expect(text).toContain("None of them was staged");
  });

  test("the summary covers every relation between sent, confirmed and total", () => {
    expect(formatUploadSummary(0, 0, 0)).toBe("No annexed data files, so nothing was copied to S3");
    expect(formatUploadSummary(1, 0, 0)).toBe(
      "All 1 data file was already recorded at the S3 remote (nothing to copy)",
    );
    expect(formatUploadSummary(165, 0, 0)).toBe(
      "All 165 data files were already recorded at the S3 remote (nothing to copy)",
    );
    // confirmed == attempted: nothing to qualify.
    expect(formatUploadSummary(10, 4, 4)).toBe(
      "Uploaded 4 data files to S3; 6 already there; all 10 recorded at the remote",
    );
    expect(formatUploadSummary(1, 1, 1)).toBe(
      "Uploaded 1 data file to S3; all 1 recorded at the remote",
    );
    // confirmed < attempted: git-annex confirmed fewer than the log shows.
    expect(formatUploadSummary(4, 4, 0)).toBe(
      "Uploaded 4 data files to S3 (git-annex confirmed 0 of 4; the rest are recorded in the location log); all 4 recorded at the remote",
    );
    // confirmed > attempted: never claim more than was sent.
    expect(formatUploadSummary(3, 2, 3)).toBe(
      "Uploaded 2 data files to S3 (git-annex reported 3 successful copies for 2 files); 1 already there; all 3 recorded at the remote",
    );
    // The word "verified" claims a bucket HEAD this step does not make.
    for (const [t, a, c] of [
      [10, 4, 4],
      [4, 4, 0],
      [3, 2, 3],
      [165, 0, 0],
    ] as const) {
      expect(formatUploadSummary(t, a, c)).not.toContain("verified");
    }
  });
});
