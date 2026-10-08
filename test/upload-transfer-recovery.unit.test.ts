/**
 * Upload step 9 around its edges: a blocked tracking recovered in one re-run, what a
 * failed read says, how file names and the remote's configuration are handled, and what
 * is cleaned up before the remote is opened. All against real git-annex and a real
 * `directory` special remote named `nemar-s3`. Where a test guards one particular line,
 * its first comment says which.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initUploadProgress, isStepCompleted, markStepCompleted } from "../src/lib/upload-progress";
import {
  type UploadFileEntry,
  describeBlockedTracking,
  displayName,
  listAnnexedPaths,
  listAnnexedPathsNotAt,
  listPendingAtRemote,
  listTrackedPaths,
  specialRemoteConfigured,
  trackDataFiles,
  transferAnnexedData,
  uploadDataToS3,
} from "../src/lib/upload/transfer";
import { FAIL, ok } from "../src/lib/upload/types";
import {
  annexedSet,
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
const scratch = makeScratch("nemar-transfer-recovery");

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

/** A dataset with the named files written and a directory remote called nemar-s3. */
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

const transfer = (
  dir: string,
  targets: Target[],
  progress = initUploadProgress(dir, "nm000996", targets),
  openRemote: Parameters<typeof transferAnnexedData>[0]["openRemote"] = async () => ok({}),
) =>
  captured(() =>
    transferAnnexedData({ absolutePath: dir, progress, addTargets: targets, jobs: 2, openRemote }),
  );

describe("a blocked tracking is recovered and retried in the same run", () => {
  /** big.edf is over the threshold but an inherited `annex.largefiles=nothing` keeps it in git. */
  async function blocked(name: string) {
    const ds = await dataset(name, { "ok.edf": 3_000 });
    writeFile(ds.dir, ".gitattributes", "big*.edf annex.largefiles=nothing\n");
    writeFile(ds.dir, "big.edf", 200_000);
    const targets: Target[] = [...ds.targets, { path: "big.edf", size: 200_000, type: "data" }];
    expect(
      (
        await trackDataFiles(
          ds.dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    const progress = initUploadProgress(ds.dir, "nm000996", targets);
    markStepCompleted(progress, "tracking");
    // The blob is staged, as a run that was refused leaves it.
    expect((await run(["git", "ls-files", "--", "big.edf"], ds.dir)).stdout.trim()).toBe("big.edf");
    expect((await annexedSet(ds.dir)).has("big.edf")).toBe(false);
    return { ...ds, targets, progress };
  }

  test("a cause fixed since the run that staged the blob takes effect on this run, not the next", async () => {
    // Guards the retry. `git annex add` is a no-op on a staged blob, so a run that finds
    // the file blocked can only unstage it; unless it then adds it again the person has to
    // run the upload a third time for a cause they fixed before the second.
    const { dir, store, targets, progress } = await blocked("fixed-cause");
    rmSync(join(dir, ".gitattributes"));

    const { value, text } = await transfer(dir, targets, progress);

    expect(value.status).toBe("ok");
    expect((await annexedSet(dir)).has("big.edf")).toBe(true);
    expect(await listAnnexedPathsNotAt(dir, REMOTE)).toEqual(new Set());
    expect(readdirSync(store, { recursive: true }).length).toBeGreaterThan(0);
    expect(text).toContain("1 data file git-annex had declined was unstaged and added again");
    // The recovery cleared the tracking stamp and the add that followed completed the step.
    expect(isStepCompleted(progress, "tracking")).toBe(true);
  });

  test("a cause that is still there fails with the reason, the blob unstaged and the stamp cleared", async () => {
    const { dir, targets, progress } = await blocked("standing-cause");

    const { value, text } = await transfer(dir, targets, progress);

    expect(value.status).toBe("fail");
    expect(text).toContain("1 data file over 100,000 bytes was not added to git-annex");
    expect(text).toContain("1 of them were unstaged");
    // The retry added it again and the second verdict unstaged it a second time.
    expect((await run(["git", "ls-files", "--", "big.edf"], dir)).stdout.trim()).toBe("");
    expect(isStepCompleted(progress, "tracking")).toBe(false);
    // Nothing was sent.
    expect(await listAnnexedPaths(dir, REMOTE)).toEqual(new Set());
  });

  test("when unstaging fails the add is not retried, and the command to run is printed", async () => {
    const { dir, targets, progress } = await blocked("unstage-fails");
    const adds = join(scratch.root, `adds-${Math.random().toString(36).slice(2)}.log`);
    const restore = installGitShim(scratch.root, [
      { match: "rm --cached" },
      { match: "annex add", log: adds },
    ]);
    try {
      const { value, text } = await transfer(dir, targets, progress);
      expect(value.status).toBe("fail");
      expect(text).toContain("git --literal-pathspecs rm --cached");
      expect(text).toContain("Could not finish making the next run able to annex them");
    } finally {
      restore();
    }
    // Guards the break on `unstaged === null`: no `git annex add` ran against a recovery
    // that failed, and the blob is still staged.
    expect(existsSync(adds)).toBe(false);
    expect((await run(["git", "ls-files", "--", "big.edf"], dir)).stdout.trim()).toBe("big.edf");
    expect(isStepCompleted(progress, "tracking")).toBe(false);
  });
});

describe("a failed read of git says how it ended", () => {
  test("a killed git annex find reports its exit status, not only that it failed", async () => {
    // Guards `commandFailure`. A call killed by a signal prints nothing, so "git annex find
    // failed" was all the person could be told about a walk that had been killed.
    const { dir } = await dataset("killed-find", { "a.edf": 3_000 });
    expect((await trackDataFiles(dir, ["a.edf"])).success).toBe(true);
    const restore = installGitShim(scratch.root, [{ match: "annex find", kill: true }]);
    try {
      const error = await listAnnexedPaths(dir).then(
        () => "",
        (e: Error) => e.message,
      );
      expect(error).toMatch(/git annex find failed \(exit status \d+\)/);
      expect(error).not.toMatch(/exit status 0\b/);
    } finally {
      restore();
    }
  });

  test("a failure with a message keeps the message and adds the status", async () => {
    const { dir } = await dataset("failed-find", { "a.edf": 3_000 });
    const restore = installGitShim(scratch.root, [
      { match: "annex find", message: "fatal: shim: no good", exit: 3 },
    ]);
    try {
      const error = await listAnnexedPathsNotAt(dir, REMOTE).then(
        () => "",
        (e: Error) => e.message,
      );
      expect(error).toBe("fatal: shim: no good (git annex find exited 3)");
    } finally {
      restore();
    }
  });

  test("the index read says it too", async () => {
    const { dir } = await dataset("failed-ls-files", { "a.edf": 3_000 });
    const restore = installGitShim(scratch.root, [{ match: "ls-files -z", exit: 5 }]);
    try {
      const error = await listTrackedPaths(dir).then(
        () => "",
        (e: Error) => e.message,
      );
      expect(error).toContain("git ls-files exited 5");
    } finally {
      restore();
    }
  });
});

describe("the remote's configuration", () => {
  test("an empty annex-uuid counts as not configured, and every annexed file is pending", async () => {
    // Guards the non-empty test. `git config --get` exits 0 for an empty value, and
    // git-annex then fails every call naming the remote with an internal trace that no
    // retry repairs.
    const { dir } = await dataset("empty-uuid", { "a.edf": 3_000, "b.edf": 3_000 });
    expect((await trackDataFiles(dir, ["a.edf", "b.edf"])).success).toBe(true);
    expect(await specialRemoteConfigured(dir, REMOTE)).toBe(true);

    expect((await run(["git", "config", `remote.${REMOTE}.annex-uuid`, ""], dir)).exitCode).toBe(0);

    expect(await specialRemoteConfigured(dir, REMOTE)).toBe(false);
    expect(await listPendingAtRemote(dir, REMOTE)).toEqual(["a.edf", "b.edf"]);
  });

  test("a remote that was never configured is not configured", async () => {
    const dir = await newDatasetRepo(scratch.root, "no-remote");
    expect(await specialRemoteConfigured(dir, REMOTE)).toBe(false);
  });

  test("a resume on a clone without the remote says that, not that files are unrecorded", async () => {
    // Guards the reopen message. With the remote not set up, every annexed file counts as
    // not recorded there, and "N annexed data files are not recorded at the S3 remote"
    // blames the files for what is a missing configuration.
    const dir = await newDatasetRepo(scratch.root, "clone-no-remote");
    const files: UploadFileEntry[] = [];
    for (const path of ["a.edf", "b.edf"]) {
      writeFile(dir, path, `${path}:`.padEnd(3_000, "x"));
      files.push({ path, size: 3_000, type: "data", mtimeMs: 1 });
    }
    expect(
      (
        await trackDataFiles(
          dir,
          files.map((f) => f.path),
        )
      ).success,
    ).toBe(true);
    const progress = initUploadProgress(dir, "nm000996", files);
    markStepCompleted(progress, "tracking");
    markStepCompleted(progress, "s3_upload");
    const datasetInfo = {
      dataset_id: "nm000996",
      ssh_url: "git@github.com:nemarDatasets/nm000996.git",
      s3_prefix: "nm000996/objects",
      github_url: "https://github.com/nemarDatasets/nm000996",
      upload_urls: {},
      s3_config: {
        bucket: "nemar-test",
        region: "us-east-2",
        public_url: "https://example.invalid",
      },
    };

    const { value, text } = await captured(() =>
      uploadDataToS3(dir, { jobs: "2" }, files, [], progress, datasetInfo, {
        openRemote: async () => {
          await initDirectoryRemote(scratch.root, dir, REMOTE);
          return ok({});
        },
      }),
    );

    expect(value.status).toBe("ok");
    expect(text).toContain("The S3 remote is not set up in this repository");
    expect(text).not.toContain("are not recorded at the S3 remote despite");
    expect(await listAnnexedPathsNotAt(dir, REMOTE)).toEqual(new Set());
  });
});

describe("file names that are printed", () => {
  test("displayName writes control characters out and leaves every other name alone", () => {
    expect(displayName("a\nb")).toBe("a\\nb");
    expect(displayName("a\rb\tc")).toBe("a\\rb\\tc");
    expect(displayName("esc\x1b[31mred")).toBe("esc\\x1b[31mred");
    expect(displayName("nul\x00end")).toBe("nul\\x00end");
    expect(displayName("del\x7fend")).toBe("del\\x7fend");
    // C1 controls: 0x85 is NEXT LINE, which several terminals honor.
    expect(displayName("c1\u0085end")).toBe("c1\\x85end");
    // Line separators and a right-to-left override reorder or split what is shown.
    expect(displayName("ls ps end")).toBe("ls\\u2028ps\\u2029end");
    expect(displayName("rtl‮exe.txt")).toBe("rtl\\u202eexe.txt");
    // Ordinary names, including non-ASCII ones, a backslash and a space, are untouched.
    for (const plain of [
      "sub-01/eeg/a b.edf",
      "café/日本語.edf",
      "back\\slash.edf",
      "emoji-😀.edf",
    ]) {
      expect(displayName(plain)).toBe(plain);
    }
  });

  /** Two files that were never copied and whose content is dropped, so the step is incomplete. */
  async function stranded(name: string, paths: string[]) {
    const files: Record<string, number> = {};
    for (const p of paths) files[p] = 3_000;
    const ds = await dataset(name, files);
    expect(
      (
        await trackDataFiles(
          ds.dir,
          ds.targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    expect((await run(["git", "annex", "drop", "--force", "--", ...paths], ds.dir)).exitCode).toBe(
      0,
    );
    return ds;
  }

  test("a newline or an escape in a name cannot split a bullet or reach the terminal", async () => {
    // Guards displayName in the list. Printed raw, "new\nline.edf" is two lines, one of
    // them not a bullet, and the ESCAPE starts a terminal control sequence.
    const names = ["new\nline.edf", "esc\x1b[2Jscreen.edf"];
    const { dir, targets } = await stranded("hostile-names", names);

    const { value, text } = await transfer(dir, targets);

    expect(value.status).toBe("fail");
    expect(text).toContain("  - new\\nline.edf");
    expect(text).toContain("  - esc\\x1b[2Jscreen.edf");
    expect(text).not.toContain("\x1b[2J");
    expect(text).not.toContain("new\nline");
  });

  test("the get hint for several files is the command that means exactly them", async () => {
    // Several files, and the hint names a command rather than a path: `get --not --in` is
    // the set of files whose content is absent here and absent at the remote.
    const { dir, targets } = await stranded("get-hint-many", ["a.edf", "b.edf"]);
    const { text } = await transfer(dir, targets);
    expect(text).toContain(
      "2 of them have no content in this repository, so they cannot be uploaded from here",
    );
    expect(text).toContain("Fetch them with `git annex get --not --in nemar-s3`, then re-run");
    // And that command really selects those two files and no other.
    const wanted = await run(
      ["git", "annex", "find", "--not", "--in", REMOTE, "--not", "--in", "here"],
      dir,
    );
    expect(wanted.stdout.split("\n").filter(Boolean).sort()).toEqual(["a.edf", "b.edf"]);
  });

  test("the get hint for one file quotes its name for a shell and uses the singular", async () => {
    const { dir, targets } = await stranded("get-hint-one", ["it's a file.edf"]);
    const { text } = await transfer(dir, targets);
    expect(text).toContain(
      "1 of them has no content in this repository, so it cannot be uploaded from here",
    );
    expect(text).toContain("Fetch it with `git annex get -- 'it'\\''s a file.edf'`, then re-run");
  });

  test("the get hint for one file whose name has a control character names no path", async () => {
    const { dir, targets } = await stranded("get-hint-ctrl", ["one\ttab.edf"]);
    const { text } = await transfer(dir, targets);
    expect(text).toContain("Fetch it with `git annex get --not --in nemar-s3`, then re-run");
    expect(text).not.toContain("one\ttab");
  });

  test("the printed unstage command is withheld for a name with a control character", async () => {
    const text = describeBlockedTracking([{ path: "big\ttab.edf", size: 200_000 }], {
      unstaged: null,
      staged: ["big\ttab.edf"],
      error: "boom",
    }).join("\n");
    expect(text).not.toContain("git --literal-pathspecs rm");
    expect(text).toContain("A name has a character that cannot go in a command");
    expect(text).toContain("big\\ttab.edf");
  });
});

describe("what the step says while it works", () => {
  test("one recorded file is checked with a spinner that counts it correctly", async () => {
    // Guards the wording: "Checking that 1 data file are at ..." was ungrammatical for one.
    const { dir, targets } = await dataset("one-file", { "a.edf": 3_000 });
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    expect((await transfer(dir, targets)).value.status).toBe("ok");

    const { value, text } = await transfer(dir, targets);

    expect(value.status).toBe("ok");
    expect(text).toContain("Checking the S3 remote for 1 data file...");
    expect(text).not.toContain("1 data file are");
  });

  test("with nothing annexed there is no spinner at all", async () => {
    const { dir } = await dataset("nothing-annexed", {});
    const { value, text } = await transfer(dir, []);
    expect(value.status).toBe("ok");
    expect(text).not.toContain("Checking");
    expect(text).not.toContain("Uploading");
    expect(text).toContain("No annexed data files, so nothing was copied to S3");
  });
});

describe("credentials from an earlier run", () => {
  test("cached credentials are gone before the remote is opened", async () => {
    // Guards the clear at the START. A run killed by a signal mid-copy never reaches its
    // `finally`, and the STS keys git-annex cached stay in `.git/annex/creds` until the
    // next run; that run must not even open the remote with them lying there.
    const { dir, targets } = await dataset("stale-creds", { "a.edf": 3_000 });
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    const credsDir = join(dir, ".git", "annex", "creds");
    mkdirSync(credsDir, { recursive: true });
    writeFileSync(join(credsDir, "leftover-uuid"), "AKIAFAKE\nSECRETFAKE\n");

    let presentWhenOpened: string[] = ["not opened"];
    const { value } = await transfer(dir, targets, undefined, async () => {
      presentWhenOpened = existsSync(credsDir) ? readdirSync(credsDir) : [];
      return ok({});
    });

    expect(value.status).toBe("ok");
    expect(presentWhenOpened).toEqual([]);
  });

  test("a remote that fails to open still leaves no credentials behind", async () => {
    const { dir, targets } = await dataset("failed-open", { "a.edf": 3_000 });
    const credsDir = join(dir, ".git", "annex", "creds");
    const { value } = await transfer(dir, targets, undefined, async () => {
      mkdirSync(credsDir, { recursive: true });
      writeFileSync(join(credsDir, "written-by-failed-initremote"), "KEYS\n");
      return FAIL;
    });
    expect(value.status).toBe("fail");
    expect(readdirSync(credsDir)).toEqual([]);
  });
});
