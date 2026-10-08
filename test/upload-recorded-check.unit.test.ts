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

describe("recorded files whose content is not in this repository", () => {
  test("a recorded file the remote lost, with no copy here, makes the step fail instead of passing", async () => {
    // Guards the fsck pass. `git annex copy --to` over a path with no local content exits 0
    // with no record and never asks the remote, so the old check saw nothing wrong and the
    // step returned ok: "already at the S3 remote" for a file S3 no longer held.
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
      recordedOutputRecognized: true,
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

  test("some files with content and some without are each asked the right way", async () => {
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
});

describe("a recent passed check is not repeated", () => {
  test("isRecordedCheckFresh trusts only a recent, readable, not-future timestamp", () => {
    const now = Date.parse("2026-10-07T12:00:00.000Z");
    const progress = (stamp: unknown): UploadProgress =>
      ({
        dataset_id: "nm000001",
        started_at: "",
        updated_at: "",
        files: {},
        completed_steps: [],
        remote_checked_at: stamp,
      }) as unknown as UploadProgress;
    const at = (msAgo: number) => new Date(now - msAgo).toISOString();

    expect(isRecordedCheckFresh(progress(at(0)), now)).toBe(true);
    expect(isRecordedCheckFresh(progress(at(RECORDED_CHECK_VALID_MS - 1)), now)).toBe(true);
    // Six hours exactly is already stale, and so is anything older.
    expect(isRecordedCheckFresh(progress(at(RECORDED_CHECK_VALID_MS)), now)).toBe(false);
    expect(isRecordedCheckFresh(progress(at(7 * 60 * 60 * 1000)), now)).toBe(false);
    // Nothing that cannot be read as a recent time may skip the check.
    expect(isRecordedCheckFresh(progress(undefined), now)).toBe(false);
    expect(isRecordedCheckFresh(progress("yesterday"), now)).toBe(false);
    expect(isRecordedCheckFresh(progress(""), now)).toBe(false);
    expect(isRecordedCheckFresh(progress(now), now)).toBe(false);
    expect(isRecordedCheckFresh(progress(null), now)).toBe(false);
    expect(isRecordedCheckFresh(progress({}), now)).toBe(false);
    // A stamp from the future is a clock that moved back, not proof of a recent check.
    expect(isRecordedCheckFresh(progress(new Date(now + 60_000).toISOString()), now)).toBe(false);
  });

  test("a progress file with a damaged stamp is still a progress file", () => {
    // The stamp is deliberately unchecked by the progress schema: a damaged value must
    // cost one check, not the whole resume record.
    const dir = join(scratch.root, "damaged-stamp");
    const progress = initUploadProgress(dir, "nm000001", []);
    (progress as unknown as Record<string, unknown>).remote_checked_at = { not: "a time" };
    expect(writeUploadProgress(dir, progress)).toBe(true);
    const read = readUploadProgress(dir);
    expect(read).not.toBeNull();
    expect(isRecordedCheckFresh(read as UploadProgress)).toBe(false);
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
    expect(isRecordedCheckFresh(progress)).toBe(true);
    if (stamp === undefined) progress.remote_checked_at = undefined;
    else (progress as unknown as Record<string, unknown>).remote_checked_at = stamp;
    return { dir, store, targets, progress };
  }

  const resume = (r: Awaited<ReturnType<typeof resumed>>) =>
    captured(() =>
      transferAnnexedData({
        absolutePath: r.dir,
        progress: r.progress,
        addTargets: r.targets,
        jobs: 2,
        openRemote: async () => ok({}),
      }),
    );

  test("a passed check is stamped and persisted", async () => {
    const r = await resumed("stamped", new Date().toISOString());
    const onDisk = readUploadProgress(r.dir);
    expect(typeof onDisk?.remote_checked_at).toBe("string");
  });

  test("within six hours of a passed check a resume does not ask the remote again", async () => {
    // Guards the skip. The store is emptied after the stamp was taken, so a check that ran
    // would send the three files again; the skipped run leaves the store empty, and the
    // stamp is not refreshed by a run that checked nothing.
    const stamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const r = await resumed("skip-fresh", stamp);
    chmodTreeWritable(r.store);
    for (const entry of readdirSync(r.store)) {
      rmSync(join(r.store, entry), { recursive: true, force: true });
    }

    const { value, text } = await resume(r);

    expect(value.status).toBe("ok");
    expect(readdirSync(r.store)).toEqual([]);
    expect(r.progress.remote_checked_at).toBe(stamp);
    expect(text).toContain("not checked again");
    expect(text).toContain("confirmed there in the last 6 hours");
  });

  test("a stamp older than six hours is checked again, and refreshed", async () => {
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const r = await resumed("stale", old);
    chmodTreeWritable(r.store);
    for (const entry of readdirSync(r.store)) {
      rmSync(join(r.store, entry), { recursive: true, force: true });
    }

    const { value, text } = await resume(r);

    expect(value.status).toBe("ok");
    expect(readdirSync(r.store).length).toBeGreaterThan(0);
    expect(text).toContain("3 were recorded but missing at the remote and were sent again");
    expect(r.progress.remote_checked_at).not.toBe(old);
    expect(isRecordedCheckFresh(r.progress)).toBe(true);
  });

  test("a stamp that cannot be read never skips the check", async () => {
    for (const [i, bad] of ["not a time", 12345, ""].entries()) {
      const r = await resumed(`unreadable-${i}`, bad);
      chmodTreeWritable(r.store);
      for (const entry of readdirSync(r.store)) {
        rmSync(join(r.store, entry), { recursive: true, force: true });
      }
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

  test("the log walks still run when the check is skipped", async () => {
    // A skipped check must not skip the verification that every annexed file is recorded:
    // a file the log does not list is copied and an unreachable log still fails the step.
    const { dir, targets } = await dataset("skip-walks");
    expect((await step(dir, targets)).status).toBe("ok");
    // Mark one file as not at the remote in the log only.
    const key = (await run(["git", "annex", "lookupkey", "--", "c.edf"], dir)).stdout.trim();
    const uuid = (
      await run(["git", "config", "--get", `remote.${REMOTE}.annex-uuid`], dir)
    ).stdout.trim();
    expect((await run(["git", "annex", "setpresentkey", key, uuid, "0"], dir)).exitCode).toBe(0);

    const skipped = await step(dir, targets, { skipRecordedCheck: true });

    expect(skipped).toMatchObject({
      status: "ok",
      attempted: 1,
      recordedCheckSkipped: true,
      remoteConfirmed: false,
    });
    expect(await listAnnexedPathsNotAt(dir, REMOTE)).toEqual(new Set());
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
      "12 data files already recorded at the S3 remote were confirmed there in the last 6 hours",
    );
    expect(
      describeRecordedCheck(plan({ recorded: 3, recordedNoLocal: 3 }), 4).join("\n"),
    ).toContain("3 data files recorded at the S3 remote have no content in this repository");
  });
});

describe("markRecordedChecked", () => {
  test("writes an ISO time that isRecordedCheckFresh accepts", () => {
    const progress = initUploadProgress(join(scratch.root, "mark"), "nm000001", []);
    expect(progress.remote_checked_at).toBeUndefined();
    markRecordedChecked(progress);
    expect(typeof progress.remote_checked_at).toBe("string");
    expect(Number.isNaN(Date.parse(progress.remote_checked_at as string))).toBe(false);
    expect(isRecordedCheckFresh(progress)).toBe(true);
  });
});
