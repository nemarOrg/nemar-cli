/**
 * Local patch for nemarOrg/nemar-cli#2141 (i): a successful upload keeps the per-file records
 * and the tracking stamp, so a re-run with an unchanged data-file list runs no `git annex add`
 * and goes straight to the location-log reconcile; a changed file is still tracked again.
 * Real git-annex and a real `directory` special remote named nemar-s3 (no S3, no NEMAR API).
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { collectFileManifest } from "../src/lib/git-annex/transfer";
import {
  type UploadProgress,
  initUploadProgress,
  isStepCompleted,
  markRecordedChecked,
  markStepCompleted,
  readUploadProgress,
  retainTrackingAfterSuccess,
  writeUploadProgress,
} from "../src/lib/upload-progress";
import { runDataSteps } from "../src/lib/upload/data-steps";
import { printUploadSuccess } from "../src/lib/upload/finalize";
import { computeFilesToUpload, prepareUploadProgress } from "../src/lib/upload/plan";
import {
  type OpenRemote,
  S3_REMOTE_NAME,
  ensureGitignoreHasNemar,
  listAnnexedPaths,
} from "../src/lib/upload/transfer";
import { type DatasetInfo, ok } from "../src/lib/upload/types";
import {
  initDirectoryRemote,
  makeScratch,
  newDatasetRepo,
  run,
  writeFile,
} from "./helpers/annex-repo";
import { installGitShim } from "./helpers/git-shim";

setDefaultTimeout(120_000);
const scratch = makeScratch("nemar-2141-retain");
beforeAll(async () => {
  if ((await run(["git", "annex", "version"])).exitCode !== 0) {
    throw new Error("git-annex is required for this test file");
  }
});
afterAll(() => scratch.cleanup());

const info: DatasetInfo = {
  dataset_id: "nm000000",
  ssh_url: "git@example.invalid:nm000000.git",
  s3_prefix: "nm000000/objects",
  github_url: "https://example.invalid/nm000000",
  upload_urls: {},
  s3_config: { bucket: "b", region: "r", public_url: "https://example.invalid" },
};

function directoryRemote(dir: string): OpenRemote {
  return async () => {
    const has = await run(["git", "config", "--get", `remote.${S3_REMOTE_NAME}.annex-uuid`], dir);
    if (has.exitCode !== 0) await initDirectoryRemote(scratch.root, dir, S3_REMOTE_NAME);
    return ok({ remoteIdentity: `directory:${dir}:${S3_REMOTE_NAME}` });
  };
}

/** One run of steps 9 to 11 as the command drives them, with the `git annex add` calls logged. */
async function runOnce(dir: string, addLog: string) {
  const manifest = await collectFileManifest(dir);
  const { dataFiles, uploadProgress } = prepareUploadProgress(dir, manifest, {});
  const filesToUpload = computeFilesToUpload(uploadProgress, dataFiles);
  const restore = installGitShim(scratch.root, [
    { match: "annex add", log: addLog, stdinLog: `${addLog}.stdin` },
    // gitAnnexAdd's per-chunk index inspection: it runs whenever the tracking step runs,
    // even when every file turns out to be indexed and unchanged (0.10.33 re-run after success).
    { match: "--literal-pathspecs diff --name-only -z --", log: `${addLog}.inspect` },
  ]);
  try {
    return {
      filesToUpload,
      result: await runDataSteps(
        {
          absolutePath: dir,
          options: { jobs: "2" },
          dataFiles,
          filesToUpload,
          uploadProgress,
          datasetInfo: info,
          coAuthorEnrichment: undefined,
          author: undefined,
        },
        { openRemote: directoryRemote(dir) },
      ),
    };
  } finally {
    restore();
  }
}

function addCalls(log: string): number {
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
}

describe("#2141 (i) a re-run after success does not re-track", () => {
  test("(C) unchanged files: no git annex add on the second run; a changed file is re-added alone", async () => {
    const dir = await newDatasetRepo(scratch.root, "retain");
    ensureGitignoreHasNemar(dir);
    writeFile(dir, "dataset_description.json", '{"Name":"t","BIDSVersion":"1.9.0"}\n');
    for (const p of ["sub-01/eeg/a.edf", "sub-01/eeg/b.edf", "sub-02/eeg/c.edf"]) {
      writeFile(dir, p, `${p}:`.padEnd(5000, "x"));
    }

    const log1 = join(scratch.root, "add-1.log");
    const first = await runOnce(dir, log1);
    expect(first.result.status).toBe("ok");
    expect(first.filesToUpload).toHaveLength(3);
    expect(addCalls(log1)).toBeGreaterThan(0);
    expect(addCalls(`${log1}.inspect`)).toBeGreaterThan(0);
    printUploadSuccess(dir, info, "configured");

    // The record survives the success, with the tracking stamp and nothing else.
    const kept = readUploadProgress(dir) as UploadProgress;
    expect(kept).not.toBeNull();
    expect(kept.completed_steps).toEqual(["tracking"]);
    expect(Object.values(kept.files).every((f) => f.status === "uploaded")).toBe(true);
    expect(kept.remote_checked_at).toBeUndefined();

    const log2 = join(scratch.root, "add-2.log");
    const second = await runOnce(dir, log2);
    expect(second.result.status).toBe("ok");
    expect(second.filesToUpload).toHaveLength(0);
    expect(addCalls(log2)).toBe(0);
    // Not even the tracking step's index inspection ran: tracking was skipped outright.
    expect(addCalls(`${log2}.inspect`)).toBe(0);
    expect(await listAnnexedPaths(dir, S3_REMOTE_NAME)).toEqual(
      new Set(["sub-01/eeg/a.edf", "sub-01/eeg/b.edf", "sub-02/eeg/c.edf"]),
    );
    // Every later step ran again, as on a fresh run.
    const afterSecond = readUploadProgress(dir) as UploadProgress;
    expect(isStepCompleted(afterSecond, "s3_upload")).toBe(true);
    expect(isStepCompleted(afterSecond, "dataset_save")).toBe(true);
    printUploadSuccess(dir, info, "configured");

    // A changed file (new content, new mtime) is tracked again, alone.
    writeFile(dir, "sub-02/eeg/c.edf", "sub-02/eeg/c.edf:".padEnd(6000, "y"));
    const future = Date.now() / 1000 + 60;
    utimesSync(join(dir, "sub-02/eeg/c.edf"), future, future);
    const log3 = join(scratch.root, "add-3.log");
    const third = await runOnce(dir, log3);
    expect(third.result.status).toBe("ok");
    expect(third.filesToUpload.map((f) => f.path)).toEqual(["sub-02/eeg/c.edf"]);
    expect(addCalls(log3)).toBeGreaterThan(0);
    // `git annex add --batch` reads the paths on stdin.
    const added3 = readFileSync(`${log3}.stdin`, "utf8");
    expect(added3).toContain("sub-02/eeg/c.edf");
    expect(added3).not.toContain("sub-01/eeg/a.edf");
    expect(added3).not.toContain("sub-01/eeg/b.edf");
    const pending = await run(["git", "annex", "find", "--not", "--in", S3_REMOTE_NAME], dir);
    expect(pending.stdout.trim()).toBe("");
  });

  test("retainTrackingAfterSuccess keeps files and the tracking stamp, drops the rest", () => {
    const dir = join(scratch.root, "unit");
    mkdirSync(dir, { recursive: true });
    const p = initUploadProgress(dir, "nm000000", [{ path: "a.edf", size: 1, mtimeMs: 5 }]);
    for (const s of [
      "tracking",
      "s3_upload",
      "dataset_save",
      "github_push",
      "ci_deploy",
    ] as const) {
      markStepCompleted(p, s);
    }
    markRecordedChecked(p, 1, "f");
    writeUploadProgress(dir, p);
    expect(retainTrackingAfterSuccess(dir)).toBe(true);
    const kept = readUploadProgress(dir) as UploadProgress;
    expect(kept.completed_steps).toEqual(["tracking"]);
    expect(kept.files["a.edf"]).toMatchObject({ size: 1, mtimeMs: 5 });
    expect(kept.remote_checked_fingerprint).toBeUndefined();
  });

  test("no progress file: nothing is written", () => {
    const dir = join(scratch.root, "none");
    mkdirSync(dir, { recursive: true });
    expect(retainTrackingAfterSuccess(dir)).toBe(true);
    expect(existsSync(join(dir, ".nemar", "upload-progress.json"))).toBe(false);
  });
});
