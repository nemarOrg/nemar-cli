/**
 * The check of files the location log already records at the remote, against real
 * git-annex and a real `directory` special remote named `nemar-s3`.
 *
 * Two things keep that check honest. A recorded file whose content is not in this
 * repository cannot be asked about with `git annex copy` (it skips the path with exit 0
 * and never contacts the remote), so those go through `git annex fsck`; and the check
 * costs one request per recorded file, so a pass of it is stamped in the progress file
 * and a re-run within six hours does not repeat it. Where a test guards one particular
 * line, its first comment says which.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  RECORDED_CHECK_VALID_MS,
  type UploadProgress,
  initUploadProgress,
  isRecordedCheckFresh,
  markRecordedChecked,
  readUploadProgress,
  writeUploadProgress,
} from "../src/lib/upload-progress";
import {
  type S3CopyPlan,
  copyAnnexedToRemote,
  describeDuration,
  describeRecordedCheck,
  formatUploadSummary,
  listAnnexedPathsNotAt,
  trackDataFiles,
  transferAnnexedData,
} from "../src/lib/upload/transfer";
import { ok } from "../src/lib/upload/types";
import {
  chmodTreeWritable,
  initDirectoryRemote,
  makeScratch,
  newDatasetRepo,
  run,
  writeFile,
} from "./helpers/annex-repo";
import { installGitShim } from "./helpers/git-shim";

// Each test builds a repository and runs git-annex a few times; CI machines are slower
// than the 5 s default allows.
setDefaultTimeout(60_000);

const REMOTE = "nemar-s3";
const scratch = makeScratch("nemar-recorded-check");

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

/** Three tracked data files, a directory remote called nemar-s3, nothing copied yet. */
async function dataset(name: string, paths = ["a.edf", "b.edf", "c.edf"]) {
  const dir = await newDatasetRepo(scratch.root, name);
  const targets: Target[] = [];
  for (const path of paths) {
    writeFile(dir, path, `${path}:`.padEnd(3_000, "x"));
    targets.push({ path, size: 3_000, type: "data" });
  }
  const store = await initDirectoryRemote(scratch.root, dir, REMOTE);
  expect(
    (
      await trackDataFiles(
        dir,
        targets.map((t) => t.path),
      )
    ).success,
  ).toBe(true);
  return { dir, store, targets };
}

const step = (
  dir: string,
  addTargets: Target[],
  extra: Partial<Parameters<typeof copyAnnexedToRemote>[0]> = {},
) => copyAnnexedToRemote({ absolutePath: dir, remote: REMOTE, addTargets, jobs: 2, ...extra });

/** Remove one key's object from a directory remote behind git-annex's back. */
async function loseObject(dir: string, store: string, path: string): Promise<void> {
  const key = (await run(["git", "annex", "lookupkey", "--", path], dir)).stdout.trim();
  chmodTreeWritable(store);
  const victims = (readdirSync(store, { recursive: true }) as string[]).filter(
    (e) => e.endsWith(`/${key}`) || e.endsWith(`/${key}/${key}`),
  );
  expect(victims.length).toBeGreaterThan(0);
  for (const v of victims) rmSync(join(store, v), { recursive: true, force: true });
}

const dropLocal = async (dir: string, ...paths: string[]) =>
  expect((await run(["git", "annex", "drop", "--force", "--", ...paths], dir)).exitCode).toBe(0);

/** Run `fn` while collecting what it prints through console.log and to stderr (ora writes there). */
async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; text: string }> {
  const lines: string[] = [];
  const log = console.log;
  const write = process.stderr.write.bind(process.stderr);
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await fn(), text: lines.join("\n") };
  } finally {
    console.log = log;
    process.stderr.write = write;
  }
}

/** The records fsck or copy would print for the first `n` of `paths`, all successes. */
const successRecords = (command: "copy" | "fsck", paths: string[], n: number): string =>
  paths
    .slice(0, n)
    .map((file) =>
      JSON.stringify({ command, "error-messages": [], file, key: `K-${file}`, success: true }),
    )
    .join("\n");

describe("recorded files whose content is not in this repository", () => {
  test("a recorded file the remote lost, with no copy here, makes the step fail instead of passing", async () => {
    // Guards the fsck pass. `git annex copy --to` over a path with no local content exits 0
    // with no record and never asks the remote, so without fsck the step returns ok:
    // "already at the S3 remote" for a file S3 no longer held.
    const { dir, store, targets } = await dataset("lost-no-copy");
    expect((await step(dir, targets)).status).toBe("ok");
    await loseObject(dir, store, "b.edf");
    await dropLocal(dir, "b.edf");
    // The log has not noticed.
    expect(await listAnnexedPathsNotAt(dir, REMOTE)).toEqual(new Set());

    const outcome = await step(dir, targets);

    expect(outcome).toEqual({
      status: "incomplete",
      missing: ["b.edf"],
      total: 3,
      notLocal: ["b.edf"],
      notLocalKnown: true,
      lostAtRemote: ["b.edf"],
    });
    // fsck wrote what it found into the location log, so the next walk sees it too.
    expect(await listAnnexedPathsNotAt(dir, REMOTE)).toEqual(new Set(["b.edf"]));
  });

  test("a pointer-only clone whose remote holds everything passes, and says how it was checked", async () => {
    // Every file recorded, none with content here: the case a fresh clone is in. The
    // check has to run (fsck), report each file present, and the summary must not claim
    // that `copy` checked them.
    const { dir, targets } = await dataset("pointer-only");
    expect((await step(dir, targets)).status).toBe("ok");
    await dropLocal(dir, "a.edf", "b.edf", "c.edf");

    const plans: S3CopyPlan[] = [];
    const outcome = await step(dir, targets, {
      onPlan: (p) => {
        plans.push(p);
      },
    });

    expect(outcome).toMatchObject({
      status: "ok",
      total: 3,
      attempted: 0,
      resent: 0,
      recordedNoLocal: 3,
      recordedCheckSkipped: false,
      recordedOutput: "understood",
      remoteConfirmed: true,
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      recorded: 3,
      recordedNoLocal: 3,
      recordedCheckSkipped: false,
    });
    if (outcome.status !== "ok") throw new Error("unreachable");
    const summary = formatUploadSummary(outcome.total, outcome.attempted, outcome.confirmed, {
      sent: outcome.sent,
      resent: outcome.resent,
      recordedNoLocal: outcome.recordedNoLocal,
    });
    expect(summary).toContain("git-annex fsck");
    expect(summary).not.toContain("git-annex checked each one");
  });

  test("files with and without local content are told apart: only the one lost with no copy is missing", async () => {
    const { dir, store, targets } = await dataset("mixed");
    expect((await step(dir, targets)).status).toBe("ok");
    // a keeps its content; b has none here and is intact at the remote; c has none and is lost.
    await loseObject(dir, store, "c.edf");
    await dropLocal(dir, "b.edf", "c.edf");

    const outcome = await step(dir, targets);

    expect(outcome).toMatchObject({
      status: "incomplete",
      missing: ["c.edf"],
      lostAtRemote: ["c.edf"],
      notLocal: ["c.edf"],
    });
  });

  test("a remote fsck cannot reach is never read as holding the files", async () => {
    // Guards the post-walk check of what fsck could not ask. An unreachable remote leaves
    // the location log untouched, so the walk alone says "nothing missing" and the step
    // would pass; only the per-file failures from fsck itself show the check did not happen.
    const { dir, store, targets } = await dataset("unreachable");
    expect((await step(dir, targets)).status).toBe("ok");
    await dropLocal(dir, "a.edf", "b.edf", "c.edf");
    renameSync(store, `${store}.gone`);

    const outcome = await step(dir, targets);

    expect(outcome.status).toBe("unverifiable");
    if (outcome.status !== "unverifiable") throw new Error("unreachable");
    expect(outcome.error).toContain(
      "could not confirm that 3 recorded files with no local content",
    );
    expect(outcome.error).toContain("is not accessible");
  });

  test("a path fsck gave no record for makes the step unverifiable, not a hedged pass", async () => {
    // Guards `unanswered`. fsck exits 0 with one record for three paths: two were never
    // asked, and the log (untouched) says they are recorded, so only the missing records
    // can show the check did not happen for them.
    const { dir, targets } = await dataset("fsck-partial");
    expect((await step(dir, targets)).status).toBe("ok");
    await dropLocal(dir, "a.edf", "b.edf", "c.edf");
    const restore = installGitShim(scratch.root, [
      { match: "annex fsck", stdout: successRecords("fsck", ["a.edf", "b.edf", "c.edf"], 1) },
    ]);
    try {
      const outcome = await step(dir, targets);
      expect(outcome.status).toBe("unverifiable");
      if (outcome.status !== "unverifiable") throw new Error("unreachable");
      expect(outcome.error).toContain(
        "could not confirm that 2 recorded files with no local content",
      );
      expect(outcome.error).toContain("git-annex gave no result for it");
    } finally {
      restore();
    }
  });

  test("with content here the ordinary copy check still finds and resends a lost object", async () => {
    // The other half of the split: files WITH local content keep going through `copy`.
    const { dir, store, targets } = await dataset("with-content");
    expect((await step(dir, targets)).status).toBe("ok");
    await loseObject(dir, store, "b.edf");

    expect(await step(dir, targets)).toMatchObject({
      status: "ok",
      attempted: 0,
      resent: 1,
      recordedNoLocal: 0,
    });
  });

  test("when the walk for the hint fails, files fsck asked about are still named as having no content here", async () => {
    // Guards the fallback in the catch. A lost file has no content here by construction;
    // reading a failed second walk as "none have no content" sent the person to re-run
    // the upload, which can never fix it.
    const { dir, store, targets } = await dataset("hint-walk-fails");
    expect((await step(dir, targets)).status).toBe("ok");
    await loseObject(dir, store, "b.edf");
    await dropLocal(dir, "b.edf");
    // The first `find --not --in here` (the split before the check) passes; the second,
    // for the hint, fails.
    const restore = installGitShim(scratch.root, [
      { match: "annex find --not --in here", after: 1, message: "fatal: shim: find failed" },
    ]);
    try {
      const outcome = await step(dir, targets);
      expect(outcome).toMatchObject({
        status: "incomplete",
        missing: ["b.edf"],
        notLocal: ["b.edf"],
        notLocalKnown: false,
        lostAtRemote: ["b.edf"],
      });
    } finally {
      restore();
    }
  });
});

describe("what the step prints about files the remote lost", () => {
  const transfer = (dir: string, targets: Target[]) => {
    const progress = initUploadProgress(dir, "nm000996", targets);
    return captured(() =>
      transferAnnexedData({
        absolutePath: dir,
        progress,
        addTargets: targets,
        jobs: 2,
        openRemote: async () => ok({}),
      }),
    );
  };

  test("the loss is reported as git-annex's finding, with the way to undo a wrongful strike", async () => {
    // Guards the wording. fsck strikes a key when the remote cannot be read as well as when
    // the object is gone, so "the remote no longer holds it" is git-annex's report, not a
    // fact, and the message offers the fsck that puts back keys struck for that reason.
    const { dir, store, targets } = await dataset("lost-wording");
    expect((await step(dir, targets)).status).toBe("ok");
    await loseObject(dir, store, "b.edf");
    await dropLocal(dir, "b.edf");

    const { value, text } = await transfer(dir, targets);

    expect(value.status).toBe("fail");
    expect(text).toContain("git-annex reports that the S3 remote no longer holds 1 of them");
    expect(text).toContain("git annex fsck --fast --from nemar-s3");
    expect(text).toContain("struck only for that reason");
    expect(text).not.toContain("is gone");
    expect(text).not.toContain("corrected the location log");
  });

  test("when the walk for the hint fails the advice still points at fetching, not at re-running", async () => {
    const { dir, store, targets } = await dataset("hint-wording");
    expect((await step(dir, targets)).status).toBe("ok");
    await loseObject(dir, store, "b.edf");
    await dropLocal(dir, "b.edf");
    const restore = installGitShim(scratch.root, [
      { match: "annex find --not --in here", after: 1, message: "fatal: shim: find failed" },
    ]);
    try {
      const { text } = await transfer(dir, targets);
      expect(text).toContain("At least 1 of them has no content in this repository");
      expect(text).toContain("git annex get --not --in nemar-s3");
      expect(text).not.toContain("Re-run the same command to resume uploading.");
    } finally {
      restore();
    }
  });
});

describe("a recent passed check is not repeated", () => {
  const progressWith = (stamp: unknown, count: unknown = 3): UploadProgress =>
    ({
      dataset_id: "nm000001",
      started_at: "",
      updated_at: "",
      files: {},
      completed_steps: [],
      remote_checked_at: stamp,
      remote_checked_count: count,
    }) as unknown as UploadProgress;

  test("isRecordedCheckFresh trusts only a recent, readable, not-future timestamp over the same number of files", () => {
    const now = Date.parse("2026-10-07T12:00:00.000Z");
    const at = (msAgo: number) => new Date(now - msAgo).toISOString();

    expect(isRecordedCheckFresh(progressWith(at(0)), 3, now)).toBe(true);
    expect(isRecordedCheckFresh(progressWith(at(RECORDED_CHECK_VALID_MS - 1)), 3, now)).toBe(true);
    // Six hours exactly is already stale, and so is anything older.
    expect(isRecordedCheckFresh(progressWith(at(RECORDED_CHECK_VALID_MS)), 3, now)).toBe(false);
    expect(isRecordedCheckFresh(progressWith(at(7 * 60 * 60 * 1000)), 3, now)).toBe(false);
    // Nothing that cannot be read as a recent time may skip the check.
    expect(isRecordedCheckFresh(progressWith(undefined), 3, now)).toBe(false);
    expect(isRecordedCheckFresh(progressWith("yesterday"), 3, now)).toBe(false);
    expect(isRecordedCheckFresh(progressWith(""), 3, now)).toBe(false);
    expect(isRecordedCheckFresh(progressWith(now), 3, now)).toBe(false);
    expect(isRecordedCheckFresh(progressWith(null), 3, now)).toBe(false);
    expect(isRecordedCheckFresh(progressWith({}), 3, now)).toBe(false);
    // A stamp from the future is a clock that moved back, not proof of a recent check.
    expect(isRecordedCheckFresh(progressWith(new Date(now + 60_000).toISOString()), 3, now)).toBe(
      false,
    );
  });

  test("a different, missing or damaged count never skips the check", () => {
    // Guards the count. A collaborator's location log merged within the window changes how
    // many files are recorded; a bare timestamp would take them as already confirmed.
    const now = Date.parse("2026-10-07T12:00:00.000Z");
    const fresh = new Date(now - 60_000).toISOString();
    expect(isRecordedCheckFresh(progressWith(fresh, 3), 3, now)).toBe(true);
    expect(isRecordedCheckFresh(progressWith(fresh, 3), 4, now)).toBe(false);
    expect(isRecordedCheckFresh(progressWith(fresh, 3), 2, now)).toBe(false);
    const noCount = progressWith(fresh, 3);
    Reflect.deleteProperty(noCount, "remote_checked_count");
    expect(isRecordedCheckFresh(noCount, 3, now)).toBe(false);
    expect(isRecordedCheckFresh(progressWith(fresh, "3"), 3, now)).toBe(false);
    expect(isRecordedCheckFresh(progressWith(fresh, null), 3, now)).toBe(false);
  });

  test("a progress file with a damaged stamp or count is still a progress file", () => {
    // The stamp and count are deliberately unchecked by the progress schema: a damaged
    // value must cost one check, not the whole resume record.
    const dir = join(scratch.root, "damaged-stamp");
    const progress = initUploadProgress(dir, "nm000001", []);
    (progress as unknown as Record<string, unknown>).remote_checked_at = { not: "a time" };
    (progress as unknown as Record<string, unknown>).remote_checked_count = "many";
    expect(writeUploadProgress(dir, progress)).toBe(true);
    const read = readUploadProgress(dir);
    expect(read).not.toBeNull();
    expect(isRecordedCheckFresh(read as UploadProgress, 3)).toBe(false);
  });

  /** A resume with everything already at the store, to which a stamp can be given. */
  async function resumed(name: string, stamp?: string | number) {
    const { dir, store, targets } = await dataset(name);
    const progress = initUploadProgress(dir, "nm000996", targets);
    const first = await transferAnnexedData({
      absolutePath: dir,
      progress,
      addTargets: targets,
      jobs: 2,
      openRemote: async () => ok({}),
    });
    expect(first.status).toBe("ok");
    expect(isRecordedCheckFresh(progress, 3)).toBe(true);
    if (stamp === undefined) progress.remote_checked_at = undefined;
    else (progress as unknown as Record<string, unknown>).remote_checked_at = stamp;
    return { dir, store, targets, progress };
  }

  const resume = (r: Awaited<ReturnType<typeof resumed>>, targets = r.targets) =>
    captured(() =>
      transferAnnexedData({
        absolutePath: r.dir,
        progress: r.progress,
        addTargets: targets,
        jobs: 2,
        openRemote: async () => ok({}),
      }),
    );

  const emptyStore = (store: string) => {
    chmodTreeWritable(store);
    for (const entry of readdirSync(store)) {
      rmSync(join(store, entry), { recursive: true, force: true });
    }
  };

  test("a passed check is stamped with its time and its count, and the stamp is persisted", async () => {
    const r = await resumed("stamped");
    const onDisk = readUploadProgress(r.dir);
    expect(typeof onDisk?.remote_checked_at).toBe("string");
    expect(onDisk?.remote_checked_count).toBe(3);
  });

  test("within six hours of a passed check a resume does not ask the remote again", async () => {
    // Guards the skip. The store is emptied after the stamp was taken, so a check that ran
    // would send the three files again; the skipped run leaves the store empty, and the
    // stamp is not refreshed by a run that checked nothing.
    const stamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const r = await resumed("skip-fresh", stamp);
    emptyStore(r.store);

    const { value, text } = await resume(r);

    expect(value.status).toBe("ok");
    expect(readdirSync(r.store)).toEqual([]);
    expect(r.progress.remote_checked_at).toBe(stamp);
    expect(text).toContain("not checked again");
    expect(text).toContain("A check of this many recorded files passed within the last 6 hours");
  });

  test("a changed number of recorded files means the check runs, whatever the stamp says", async () => {
    // Guards the count. The stamp is fresh and the store has lost everything, but a fourth
    // file has since been recorded (a collaborator's location log, merged): the number no
    // longer matches, so the check runs and the lost objects come back.
    const stamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const r = await resumed("count-changes", stamp);
    emptyStore(r.store);
    writeFile(r.dir, "d.edf", "d.edf:".padEnd(3_000, "x"));
    expect((await trackDataFiles(r.dir, ["d.edf"])).success).toBe(true);
    expect(
      (await run(["git", "annex", "copy", "--to", REMOTE, "--", "d.edf"], r.dir)).exitCode,
    ).toBe(0);
    const withD = [...r.targets, { path: "d.edf", size: 3_000, type: "data" as const }];

    const { value, text } = await resume(r, withD);

    expect(value.status).toBe("ok");
    expect(text).toContain("3 were recorded but missing at the remote and were sent again");
    expect(text).not.toContain("not checked again");
  });

  test("a stamp older than six hours is checked again, and refreshed", async () => {
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const r = await resumed("stale", old);
    emptyStore(r.store);

    const { value, text } = await resume(r);

    expect(value.status).toBe("ok");
    expect(readdirSync(r.store).length).toBeGreaterThan(0);
    expect(text).toContain("3 were recorded but missing at the remote and were sent again");
    expect(r.progress.remote_checked_at).not.toBe(old);
    expect(isRecordedCheckFresh(r.progress, 3)).toBe(true);
  });

  test("a stamp that cannot be read never skips the check", async () => {
    for (const [i, bad] of ["not a time", 12345, ""].entries()) {
      const r = await resumed(`unreadable-${i}`, bad);
      emptyStore(r.store);
      const { value } = await resume(r);
      expect(value.status).toBe("ok");
      // The store was refilled: the check ran.
      expect(readdirSync(r.store).length).toBeGreaterThan(0);
    }
  });

  test("a check whose output was not understood is not stamped", async () => {
    // Guards the stamp on `remoteConfirmed`: output the step could not read proves nothing,
    // so it must not buy six hours without a check.
    const r = await resumed("unreadable-output");
    r.progress.remote_checked_at = undefined;
    const restore = installGitShim(scratch.root, [
      { match: "annex copy", stdout: "all good, nothing printed in json" },
    ]);
    try {
      const { value, text } = await resume(r);
      expect(value.status).toBe("ok");
      expect(text).toContain("was not recognized");
      expect(text).not.toContain("git-annex checked each one");
    } finally {
      restore();
    }
    expect(r.progress.remote_checked_at).toBeUndefined();
  });

  test("an answer for only some of the files is said so, is not stamped, and ends as a warning", async () => {
    // Guards the partial state and the warning. git-annex printed readable records for one
    // of three files on a clean exit: the output WAS understood, it is the answer that is
    // incomplete, so the words differ from "not recognized"; and a summary that says
    // something is unknown is not a success line.
    const r = await resumed("partial-answer");
    r.progress.remote_checked_at = undefined;
    const restore = installGitShim(scratch.root, [
      { match: "annex copy", stdout: successRecords("copy", ["a.edf", "b.edf", "c.edf"], 1) },
    ]);
    try {
      const { value, text } = await resume(r);
      expect(value.status).toBe("ok");
      expect(text).toContain("git-annex gave no result for some of them");
      expect(text).not.toContain("not recognized");
      expect(text).toContain("⚠");
      expect(text).not.toContain("✔");
    } finally {
      restore();
    }
    expect(r.progress.remote_checked_at).toBeUndefined();
  });

  test("the log walks still run when the check is skipped", async () => {
    // A skipped check must not skip the verification that every annexed file is recorded:
    // a file the log does not list is still copied.
    const { dir, targets } = await dataset("skip-walks");
    expect((await step(dir, targets)).status).toBe("ok");
    // Mark one file as not at the remote in the log only.
    const key = (await run(["git", "annex", "lookupkey", "--", "c.edf"], dir)).stdout.trim();
    const uuid = (
      await run(["git", "config", "--get", `remote.${REMOTE}.annex-uuid`], dir)
    ).stdout.trim();
    expect((await run(["git", "annex", "setpresentkey", key, uuid, "0"], dir)).exitCode).toBe(0);

    const skipped = await step(dir, targets, { skipRecordedCheck: () => true });

    expect(skipped).toMatchObject({
      status: "ok",
      attempted: 1,
      recordedCheckSkipped: true,
      remoteConfirmed: false,
    });
    expect(await listAnnexedPathsNotAt(dir, REMOTE)).toEqual(new Set());
  });

  test("a skipped check still reads the log: an unreadable log fails the step", async () => {
    const { dir, targets } = await dataset("skip-unreadable-log");
    expect((await step(dir, targets)).status).toBe("ok");
    const restore = installGitShim(scratch.root, [
      { match: "annex find --not --in nemar-s3", message: "fatal: shim: the log is unreadable" },
    ]);
    try {
      const skipped = await step(dir, targets, { skipRecordedCheck: () => true });
      expect(skipped.status).toBe("unreadable");
    } finally {
      restore();
    }
  });
});

describe("what a long check announces", () => {
  const plan = (over: Partial<S3CopyPlan>): S3CopyPlan => ({
    total: 0,
    pending: 0,
    recorded: 0,
    recordedNoLocal: 0,
    recordedCheckSkipped: false,
    smallNotAnnexed: { inGit: [], leftOut: [] },
    ...over,
  });

  test("durations are said in whole minutes and hours", () => {
    expect(describeDuration(30)).toBe("under a minute");
    expect(describeDuration(60)).toBe("about 1 minute");
    expect(describeDuration(281)).toBe("about 5 minutes");
    expect(describeDuration(3600)).toBe("about 1 hour");
    expect(describeDuration(4200)).toBe("about 1 hour 10 minutes");
    expect(describeDuration(7200)).toBe("about 2 hours");
  });

  test("above 5,000 recorded files the count and an estimate are printed", () => {
    // 15,000 files at 75 ms and four jobs is about five minutes; at one job, about 19.
    expect(describeRecordedCheck(plan({ recorded: 15_000 }), 4).join("\n")).toContain(
      "each of the 15,000 files already recorded there, one request each: about 5 minutes with 4 parallel jobs",
    );
    expect(describeRecordedCheck(plan({ recorded: 15_000 }), 1).join("\n")).toContain(
      "about 19 minutes with 1 parallel job",
    );
  });

  test("the promise of a skip on a re-run carries its condition", () => {
    // The skip is bought only by a check whose answers were understood.
    expect(describeRecordedCheck(plan({ recorded: 15_000 }), 4).join("\n")).toContain(
      "with git-annex's answers understood, lets a re-run within 6 hours skip it",
    );
  });

  test("at or below 5,000 files nothing is announced, and the estimate never offers an opt-out", () => {
    expect(describeRecordedCheck(plan({ recorded: 5_000 }), 4)).toEqual([]);
    expect(describeRecordedCheck(plan({ recorded: 0 }), 4)).toEqual([]);
    const text = describeRecordedCheck(plan({ recorded: 9_000 }), 4).join("\n");
    expect(text).not.toMatch(/--skip|--no-check|--fast/);
  });

  test("a skipped check and files checked with fsck are each said", () => {
    expect(
      describeRecordedCheck(plan({ recorded: 12, recordedCheckSkipped: true }), 4).join("\n"),
    ).toContain(
      "A check of this many recorded files passed within the last 6 hours; the remote is not asked about the 12 again",
    );
    expect(
      describeRecordedCheck(plan({ recorded: 3, recordedNoLocal: 3 }), 4).join("\n"),
    ).toContain("3 data files recorded at the S3 remote have no content in this repository");
  });
});

describe("markRecordedChecked", () => {
  test("writes an ISO time and the count, which isRecordedCheckFresh accepts", () => {
    const progress = initUploadProgress(join(scratch.root, "mark"), "nm000001", []);
    expect(progress.remote_checked_at).toBeUndefined();
    markRecordedChecked(progress, 7);
    expect(typeof progress.remote_checked_at).toBe("string");
    expect(Number.isNaN(Date.parse(progress.remote_checked_at as string))).toBe(false);
    expect(progress.remote_checked_count).toBe(7);
    expect(isRecordedCheckFresh(progress, 7)).toBe(true);
    expect(isRecordedCheckFresh(progress, 8)).toBe(false);
  });
});
