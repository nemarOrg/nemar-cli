/**
 * Upload steps 9 to 11 driven as the command drives them: `runDataSteps` for the
 * three together, `uploadDataToS3` for the copy on its own, both against real git-annex
 * and a real `directory` special remote called `nemar-s3`.
 *
 * The only thing replaced is how the remote is opened (`deps.openRemote`): production
 * asks the backend for STS credentials and configures an S3 remote, which a test
 * cannot do. Everything downstream of it, including the outcome switch that marks files
 * uploaded, clears credentials and recovers a blocked upload, is the production code.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { annexRemoteExists, configureS3Remote } from "../src/lib/git-annex/s3-remote";
import { collectFileManifest } from "../src/lib/git-annex/transfer";
import {
  type UploadProgress,
  initUploadProgress,
  isStepCompleted,
  markFileUploaded,
  markStepCompleted,
  writeUploadProgress,
} from "../src/lib/upload-progress";
import { runDataSteps } from "../src/lib/upload/data-steps";
import { saveDatasetStep } from "../src/lib/upload/finalize";
import { computeFilesToUpload, prepareUploadProgress } from "../src/lib/upload/plan";
import {
  type OpenRemote,
  S3_REMOTE_NAME,
  ensureGitignoreHasNemar,
  listAnnexedPaths,
  trackDataFiles,
  uploadDataToS3,
} from "../src/lib/upload/transfer";
import { type DatasetInfo, FAIL, ok } from "../src/lib/upload/types";
import {
  annexedSet,
  initDirectoryRemote,
  makeScratch,
  newDatasetRepo,
  run,
  writeFile,
} from "./helpers/annex-repo";
import { installGitShim } from "./helpers/git-shim";

setDefaultTimeout(60_000);

const scratch = makeScratch("nemar-data-steps");

beforeAll(async () => {
  const probe = await run(["git", "annex", "version"]);
  if (probe.exitCode !== 0) throw new Error("git-annex is required for this test file");
});
afterAll(() => scratch.cleanup());

const MIB = 1024 * 1024;
/** A local port nothing listens on: a connection to it is refused at once. */
const DEAD_PROXY = "http://127.0.0.1:1";

// A leak guard. A proxy variable left set in this process would redirect every later
// `fetch` of the whole test run (Bun retains it), failing unrelated files.
const PROXY_VARIABLES = [
  "https_proxy",
  "HTTPS_PROXY",
  "http_proxy",
  "HTTP_PROXY",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;
const proxyAtLoad = Object.fromEntries(PROXY_VARIABLES.map((name) => [name, process.env[name]]));
afterAll(() => {
  for (const name of PROXY_VARIABLES) {
    if (process.env[name] !== proxyAtLoad[name]) {
      throw new Error(`${name} was changed in-process and not restored`);
    }
  }
});
const info: DatasetInfo = {
  dataset_id: "nm000996",
  ssh_url: "git@github.com:nemarDatasets/nm000996.git",
  s3_prefix: "nm000996/objects",
  github_url: "https://github.com/nemarDatasets/nm000996",
  upload_urls: {},
  s3_config: { bucket: "nemar-test", region: "us-east-2", public_url: "https://example.invalid" },
};

/** A dataset directory ready for an upload: a repo, `.nemar/` ignored, files written. */
async function dataset(name: string, files: Record<string, number | Buffer>): Promise<string> {
  const dir = await newDatasetRepo(scratch.root, name);
  ensureGitignoreHasNemar(dir);
  // Distinct content per file: identical bytes give identical hashes, and on a
  // case-insensitive filesystem a.edf and A.EDF then share one object path in the store.
  for (const [path, content] of Object.entries(files)) {
    writeFile(dir, path, typeof content === "number" ? `${path}:`.padEnd(content, "x") : content);
  }
  return dir;
}

/** An OpenRemote that registers the directory remote once and counts how often it is asked. */
function directoryRemote(dir: string): OpenRemote & { calls: number } {
  const open = async () => {
    open.calls += 1;
    if (!(await annexRemoteExists(dir, S3_REMOTE_NAME))) {
      await initDirectoryRemote(scratch.root, dir, S3_REMOTE_NAME);
    }
    return ok({});
  };
  open.calls = 0;
  return open;
}

/** What the command does between the manifest and step 9, for one run. */
async function plan(dir: string) {
  const manifest = await collectFileManifest(dir);
  const { dataFiles, uploadProgress } = prepareUploadProgress(dir, manifest, {});
  return {
    dataFiles,
    uploadProgress,
    filesToUpload: computeFilesToUpload(uploadProgress, dataFiles),
  };
}

/** Run steps 9 to 11 once, the way the command does. */
async function runSteps(dir: string, deps: Parameters<typeof runDataSteps>[1]) {
  const p = await plan(dir);
  return runDataSteps(
    {
      absolutePath: dir,
      options: { jobs: "2" },
      ...p,
      datasetInfo: info,
      coAuthorEnrichment: undefined,
      author: undefined,
    },
    deps,
  );
}

function progressOf(dir: string): UploadProgress {
  return JSON.parse(readFileSync(join(dir, ".nemar", "upload-progress.json"), "utf-8"));
}

describe("a whole run of steps 9 to 11", () => {
  test("uploads, tracks case variants, saves, and records every file as uploaded", async () => {
    // Guards trackDataFiles being what step 9 tracks with: the large uppercase-suffix
    // motion file is excluded by git-annex's own globs, so a plain `git annex add` leaves
    // it in git and the run is refused.
    const dir = await dataset("whole", {
      "sub-01/eeg/a.edf": 3_000,
      "sub-01/eeg/small_UPPER.EDF": 3_000,
      "sub-03/motion/sub-03_task-walk_tracksys-imu_MOTION.tsv": 200_000,
      "dataset_description.json": 100,
    });
    const open = directoryRemote(dir);

    const result = await runSteps(dir, { openRemote: open });

    expect(result.status).toBe("ok");
    expect(open.calls).toBe(1);
    const data = [
      "sub-01/eeg/a.edf",
      "sub-01/eeg/small_UPPER.EDF",
      "sub-03/motion/sub-03_task-walk_tracksys-imu_MOTION.tsv",
    ];
    expect(await annexedSet(dir)).toEqual(new Set(data));
    expect(await listAnnexedPaths(dir, S3_REMOTE_NAME)).toEqual(new Set(data));
    const progress = progressOf(dir);
    for (const p of data) expect(progress.files[p].status).toBe("uploaded");
    for (const step of ["tracking", "s3_upload", "dataset_save"] as const) {
      expect(isStepCompleted(progress, step)).toBe(true);
    }
    const pointer = await run(["git", "cat-file", "-p", `HEAD:${data[2]}`], dir);
    expect(pointer.stdout.startsWith("/annex/objects/")).toBe(true);
  });

  test("hands the save the annexed set the copy listed, and the remote to check against", async () => {
    // Guards the handoff between steps 9 and 11. The wrapper only observes: it calls the
    // real save with exactly what it was given.
    const dir = await dataset("handoff", { "a.edf": 3_000, "b.edf": 3_000 });
    const seen: Array<Parameters<typeof saveDatasetStep>[3]> = [];
    const result = await runSteps(dir, {
      openRemote: directoryRemote(dir),
      saveStep: (...args) => {
        seen.push(args[3]);
        return saveDatasetStep(...args);
      },
    });
    expect(result.status).toBe("ok");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.annexedPaths).toEqual(new Set(["a.edf", "b.edf"]));
    expect(seen[0]?.verifyRemote).toBe(S3_REMOTE_NAME);
  });

  test("the re-run a failed save asks for re-tracks the changed file, and the commit gets the NEW key", async () => {
    // The save's failure text promises that re-running re-tracks the file. That promise is
    // made of steps in other modules (the changed-list check, the upload list, the add, the
    // copy, the refreshed record), so drive the whole thing twice, the way the command does.
    // The wrapper edits the file in the window between the copy and the save, the real
    // window the stat guard exists for, and then calls the real save.
    const dir = await dataset("rerun", { "a.edf": 3_000, "b.edf": 3_000 });
    const open = directoryRemote(dir);
    let oldKey = "";
    const result = await runSteps(dir, {
      openRemote: open,
      skipMinBytes: 1,
      saveStep: async (...args) => {
        oldKey = (await run(["git", "annex", "lookupkey", "a.edf"], dir)).stdout.trim();
        writeFileSync(join(dir, "a.edf"), "e".repeat(3_000));
        const later = ((args[2].files["a.edf"].mtimeMs as number) + 5_000) / 1000;
        utimesSync(join(dir, "a.edf"), later, later);
        return saveDatasetStep(...args);
      },
    });
    expect(result.status).toBe("fail");
    expect(isStepCompleted(progressOf(dir), "dataset_save")).toBe(false);

    // The re-run: a fresh manifest sees the edit and the file goes round again.
    const second = await runSteps(dir, { openRemote: open, skipMinBytes: 1 });

    expect(second.status).toBe("ok");
    const newKey = (await run(["git", "annex", "lookupkey", "a.edf"], dir)).stdout.trim();
    expect(newKey).not.toBe(oldKey);
    const pointer = await run(["git", "cat-file", "-p", "HEAD:a.edf"], dir);
    expect(pointer.stdout.trim()).toBe(`/annex/objects/${newKey}`);
    expect(await listAnnexedPaths(dir, S3_REMOTE_NAME)).toEqual(new Set(["a.edf", "b.edf"]));
  });

  test("a dataset with no data files never opens the remote", async () => {
    const dir = await dataset("no-data", { "dataset_description.json": 100, README: 100 });
    const open = directoryRemote(dir);
    const result = await runSteps(dir, { openRemote: open });
    expect(result.status).toBe("ok");
    expect(open.calls).toBe(0);
    expect(isStepCompleted(progressOf(dir), "s3_upload")).toBe(true);
  });
});

describe("what the copy step does with each outcome", () => {
  test("a blocked file is recovered: unstaged, the stamp cleared, and nothing marked uploaded", async () => {
    // Guards the `blocked` branch. A large data file an inherited .gitattributes keeps in
    // git fails the step; the recovery has to leave a state the re-run can use.
    const dir = await dataset("blocked", { "ok.edf": 3_000 });
    writeFile(dir, ".gitattributes", "big*.edf annex.largefiles=nothing\n");
    writeFile(dir, "big.edf", 200_000);
    const open = directoryRemote(dir);

    const p = await plan(dir);
    const result = await uploadDataToS3(
      dir,
      { jobs: "2" },
      p.dataFiles,
      p.filesToUpload,
      p.uploadProgress,
      info,
      { openRemote: open },
    );

    expect(result.status).toBe("fail");
    const progress = progressOf(dir);
    expect(isStepCompleted(progress, "tracking")).toBe(false);
    expect(isStepCompleted(progress, "s3_upload")).toBe(false);
    expect(progress.files["ok.edf"].status).toBe("pending");
    expect(progress.files["big.edf"].status).toBe("pending");
    const tracked = (await run(["git", "ls-files"], dir)).stdout.split("\n");
    expect(tracked).not.toContain("big.edf");
    expect(existsSync(join(dir, "big.edf"))).toBe(true);
  });

  test("a copy that fails marks nothing uploaded and leaves s3_upload open", async () => {
    // Guards markFileUploaded coming after the outcome switch, not before it.
    const dir = await dataset("copy-fails", { "a.edf": 3_000, "b.edf": 3_000 });
    const open: OpenRemote = async () => {
      const store = await initDirectoryRemote(scratch.root, dir, S3_REMOTE_NAME);
      renameSync(store, `${store}.gone`);
      return ok({});
    };

    const p = await plan(dir);
    const result = await uploadDataToS3(
      dir,
      { jobs: "2" },
      p.dataFiles,
      p.filesToUpload,
      p.uploadProgress,
      info,
      { openRemote: open },
    );

    expect(result.status).toBe("fail");
    const progress = progressOf(dir);
    expect(progress.files["a.edf"].status).toBe("pending");
    expect(progress.files["b.edf"].status).toBe("pending");
    expect(isStepCompleted(progress, "s3_upload")).toBe(false);
  });

  test("cached credentials are removed after a copy that fails", async () => {
    const dir = await dataset("creds-copy-fails", { "a.edf": 3_000 });
    const open: OpenRemote = async () => {
      const store = await initDirectoryRemote(scratch.root, dir, S3_REMOTE_NAME);
      renameSync(store, `${store}.gone`);
      // What git-annex caches when it initializes an S3 remote with keys.
      mkdirSync(join(dir, ".git", "annex", "creds"), { recursive: true });
      writeFileSync(join(dir, ".git", "annex", "creds", "cached"), "AKIAFAKE\nsecret\n");
      return ok({});
    };
    const p = await plan(dir);
    const result = await uploadDataToS3(
      dir,
      { jobs: "2" },
      p.dataFiles,
      p.filesToUpload,
      p.uploadProgress,
      info,
      { openRemote: open },
    );
    expect(result.status).toBe("fail");
    expect(readdirSync(join(dir, ".git", "annex", "creds"))).toEqual([]);
  });

  test("cached credentials are removed after an S3 remote that failed to initialize", async () => {
    // Guards the credentials cleanup living in a `finally` around opening the remote too.
    // A failed `initremote` has already written the keys (mode 600) when it fails, and
    // the step used to return before clearing them. This runs the real configureS3Remote
    // against a closed local port: no traffic leaves the machine, so the failure is a
    // refused connection, and the keys in the file are made up.
    const dir = await dataset("creds-initremote-fails", { "a.edf": 3_000 });
    await run(["git", "config", "annex.security.allowed-ip-addresses", "all"], dir);
    // The dead proxy goes to git-annex's initremote ONLY, through the shim. Setting it on
    // process.env would also route every later `fetch` of this test run through it:
    // Bun keeps the proxy setting after the variable is restored, and test/openneuro.test.ts
    // then fails with ConnectionRefused when the files run in the same process.
    const restore = installGitShim(scratch.root, [
      {
        match: "annex initremote",
        env: { https_proxy: DEAD_PROXY, HTTPS_PROXY: DEAD_PROXY },
      },
    ]);
    const open: OpenRemote = async () => {
      const configured = await configureS3Remote(
        dir,
        {
          name: S3_REMOTE_NAME,
          bucket: "no-such-bucket",
          prefix: "nm000996/objects",
          region: "us-east-2",
        },
        { accessKeyId: "AKIAFAKE", secretAccessKey: "fake", sessionToken: "fake" },
      );
      expect(configured.success).toBe(false);
      // The premise: the failed initremote really did leave the keys behind.
      expect(readdirSync(join(dir, ".git", "annex", "creds")).length).toBeGreaterThan(0);
      return FAIL;
    };
    try {
      const p = await plan(dir);
      const result = await uploadDataToS3(
        dir,
        { jobs: "2" },
        p.dataFiles,
        p.filesToUpload,
        p.uploadProgress,
        info,
        { openRemote: open },
      );
      expect(result.status).toBe("fail");
    } finally {
      restore();
    }
    expect(readdirSync(join(dir, ".git", "annex", "creds"))).toEqual([]);
  });
});

describe("the location log decides, not the add targets", () => {
  /** A dataset whose progress file says everything is uploaded while one file never was. */
  async function claimedUploaded(name: string) {
    const dir = await dataset(name, { "a.edf": 3_000, "b.edf": 3_000 });
    expect((await trackDataFiles(dir, ["a.edf", "b.edf"])).success).toBe(true);
    const manifest = await collectFileManifest(dir);
    const data = manifest.files.filter((f) => f.type === "data");
    const progress = initUploadProgress(dir, info.dataset_id, data);
    for (const f of data) markFileUploaded(progress, f.path, f);
    for (const step of ["tracking", "s3_upload", "dataset_save", "github_push"] as const) {
      markStepCompleted(progress, step);
    }
    writeUploadProgress(dir, progress);
    // Only a.edf ever reached the remote.
    const open = directoryRemote(dir);
    await open();
    expect(
      (await run(["git", "annex", "copy", "--to", S3_REMOTE_NAME, "--", "a.edf"], dir)).exitCode,
    ).toBe(0);
    open.calls = 0;
    return { dir, open };
  }

  test("a file tracked but never copied is copied on a run with nothing to add", async () => {
    // Guards `listPendingAtRemote` being asked BEFORE the empty-add-targets gate. With no
    // add targets the step used to print "No data files to upload to S3" and stamp itself
    // complete, whatever the log said.
    const { dir, open } = await claimedUploaded("never-copied");
    const p = await plan(dir);
    expect(p.filesToUpload).toEqual([]);

    const result = await uploadDataToS3(
      dir,
      { jobs: "2" },
      p.dataFiles,
      p.filesToUpload,
      p.uploadProgress,
      info,
      { openRemote: open },
    );

    expect(result.status).toBe("ok");
    expect(open.calls).toBe(1);
    expect(await listAnnexedPaths(dir, S3_REMOTE_NAME)).toEqual(new Set(["a.edf", "b.edf"]));
    // A completed stamp is reopened, and the finalize steps with it.
    const progress = progressOf(dir);
    expect(isStepCompleted(progress, "s3_upload")).toBe(true);
    expect(isStepCompleted(progress, "dataset_save")).toBe(false);
    expect(isStepCompleted(progress, "github_push")).toBe(false);
  });

  test("when everything is recorded the stamp is honored and the remote is never opened", async () => {
    const { dir, open } = await claimedUploaded("all-recorded");
    expect(
      (await run(["git", "annex", "copy", "--to", S3_REMOTE_NAME, "--", "b.edf"], dir)).exitCode,
    ).toBe(0);
    const p = await plan(dir);
    const result = await uploadDataToS3(
      dir,
      { jobs: "2" },
      p.dataFiles,
      p.filesToUpload,
      p.uploadProgress,
      info,
      { openRemote: open },
    );
    expect(result.status).toBe("ok");
    expect(open.calls).toBe(0);
    expect(isStepCompleted(progressOf(dir), "dataset_save")).toBe(true);
  });

  test("a file the save itself annexed fails the run, and a re-run uploads it", async () => {
    // Characterizes the gap recorded in ADR 0031. The CLI folds case, so it calls an
    // uppercase BIG.JSON metadata and never hands it to `git annex add`; git-annex's
    // case-sensitive `exclude=*.json` misses it, so the save's `git add -A` annexes it by
    // size AFTER the copy. Its content is then only here. The run used to end in
    // "Upload complete" with that pointer on its way to GitHub.
    const dir = await dataset("big-json", { "ok.edf": 3_000, "BIG.JSON": 200_000 });
    const open = directoryRemote(dir);

    const first = await runSteps(dir, { openRemote: open });

    expect(first.status).toBe("fail");
    // The commit exists, and holds a pointer for BIG.JSON that the remote cannot resolve.
    const pointer = await run(["git", "cat-file", "-p", "HEAD:BIG.JSON"], dir);
    expect(pointer.stdout.startsWith("/annex/objects/")).toBe(true);
    expect(await listAnnexedPaths(dir, S3_REMOTE_NAME)).toEqual(new Set(["ok.edf"]));
    const stuck = progressOf(dir);
    expect(isStepCompleted(stuck, "s3_upload")).toBe(false);
    expect(isStepCompleted(stuck, "dataset_save")).toBe(false);

    // The re-run has no add targets at all; the log is what tells it BIG.JSON is missing.
    const second = await runSteps(dir, { openRemote: open });

    expect(second.status).toBe("ok");
    expect(await listAnnexedPaths(dir, S3_REMOTE_NAME)).toEqual(new Set(["ok.edf", "BIG.JSON"]));
    const done = progressOf(dir);
    expect(isStepCompleted(done, "s3_upload")).toBe(true);
    expect(isStepCompleted(done, "dataset_save")).toBe(true);
  });
});
