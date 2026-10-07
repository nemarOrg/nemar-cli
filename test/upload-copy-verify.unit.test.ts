/**
 * Upload S3 step: copy accounting, the not-annexed guard, and the save step
 * that must not re-read annexed content.
 *
 * nm000358 (165 files, 1.6 TB on Ceph) logged "Uploaded 0 data files to S3"
 * although the git-annex branch recorded all 165 keys at nemar-s3 during that
 * copy, and then spent hours in "Saving dataset changes" because `git add -A`
 * streamed every freshly annexed unlocked file through git-annex
 * filter-process (their index entries carry zero stat data after
 * `git annex add`).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "bun";
import { saveDataset, setAssumeUnchanged } from "../src/lib/git-annex/clone-push";
import { configureLargefiles, gitAnnexAdd, initDataset } from "../src/lib/git-annex/init";
import {
  copyPathsToAnnexRemote,
  copyToAnnexRemote,
  extractCopyJsonError,
  parseCopyJson,
} from "../src/lib/git-annex/transfer";
import {
  findDataFilesNotAnnexed,
  formatUploadSummary,
  listAnnexedPaths,
} from "../src/lib/upload/transfer";

describe("parseCopyJson", () => {
  test("reads one record per JSON line and ignores bookkeeping text", () => {
    const stdout = [
      '{"command":"copy","error-messages":[],"file":"sub-01/a.edf","input":["."],"key":"SHA256E-s1--a.edf","success":true}',
      "(recording state in git...)",
      '{"command":"copy","error-messages":["S3 error: AccessDenied"],"file":"sub-02/b.edf","key":"SHA256E-s1--b.edf","success":false}',
      "",
      "{not json",
    ].join("\n");
    expect(parseCopyJson(stdout)).toEqual([
      { file: "sub-01/a.edf", key: "SHA256E-s1--a.edf", success: true, errors: [] },
      {
        file: "sub-02/b.edf",
        key: "SHA256E-s1--b.edf",
        success: false,
        errors: ["S3 error: AccessDenied"],
      },
    ]);
  });

  test("records of another command are not counted as copies", () => {
    const stdout = '{"command":"drop","file":"x","success":true}\n';
    expect(parseCopyJson(stdout)).toEqual([]);
  });
});

describe("extractCopyJsonError", () => {
  test("names each failed file with its git-annex error", () => {
    const records = parseCopyJson(
      '{"command":"copy","error-messages":["ExpiredToken"],"file":"sub-01/a.edf","success":false}\n',
    );
    const msg = extractCopyJsonError(records, "", "git-annex: copy: 1 failed");
    expect(msg).toContain("1 file(s) failed to copy");
    expect(msg).toContain("sub-01/a.edf: ExpiredToken");
    expect(msg).toContain("git-annex: copy: 1 failed");
  });

  test("falls back to the human-output extraction when no record failed", () => {
    expect(extractCopyJsonError([], "", "fatal: not a git repository")).toBe(
      "fatal: not a git repository",
    );
  });

  test("bounds a many-file failure", () => {
    const stdout = Array.from(
      { length: 30 },
      (_, i) => `{"command":"copy","error-messages":["x"],"file":"f${i}","success":false}`,
    ).join("\n");
    const lines = extractCopyJsonError(parseCopyJson(stdout), stdout, "").split("\n");
    expect(lines[0]).toBe("30 file(s) failed to copy:");
    expect(lines[1]).toContain("10 earlier failed files omitted");
    expect(lines).toHaveLength(22);
  });
});

describe("formatUploadSummary", () => {
  test("a resume with nothing left says so instead of 'Uploaded 0'", () => {
    expect(formatUploadSummary(165, 0, 0)).toBe(
      "All 165 data files were already on S3 (nothing to copy)",
    );
  });

  test("states sent, already-present and verified totals", () => {
    expect(formatUploadSummary(10, 4, 4)).toBe(
      "Uploaded 4 data files to S3; 6 were already there; all 10 verified at the remote",
    );
    expect(formatUploadSummary(4, 4, 0)).toBe(
      "Uploaded 4 data files to S3 (0 confirmed by git-annex, rest verified in the log); all 4 verified at the remote",
    );
  });
});

describe("findDataFilesNotAnnexed", () => {
  test("a large data file left out of the annex blocks; a small one is only reported", () => {
    const targets = [
      { path: "a.edf", size: 5_000_000 },
      { path: "b.edf", size: 5_000_000 },
      { path: "tiny.EDF", size: 2_000 },
      { path: "meta.json", size: 9_000_000, type: "metadata" },
    ];
    const out = findDataFilesNotAnnexed(targets, new Set(["a.edf"]));
    expect(out.blocking.map((f) => f.path)).toEqual(["b.edf"]);
    expect(out.small.map((f) => f.path)).toEqual(["tiny.EDF"]);
  });
});

// ---------------------------------------------------------------------------
// Real git-annex
// ---------------------------------------------------------------------------

const TMP_DIR = join(import.meta.dir, ".test-upload-copy-verify");

async function runCmd(
  cmd: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function chmodTreeWritable(dir: string): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      try {
        chmodSync(full, 0o755);
      } catch {}
      chmodTreeWritable(full);
    } else {
      try {
        chmodSync(full, 0o644);
      } catch {}
    }
  }
}

async function newDatasetRepo(name: string): Promise<string> {
  const dir = join(TMP_DIR, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const init = await initDataset(dir, { author: { name: "Test", email: "test@test.com" } });
  if (!init.success) throw new Error(`initDataset failed: ${init.error}`);
  await runCmd(["git", "config", "user.email", "test@test.com"], dir);
  await runCmd(["git", "config", "user.name", "Test"], dir);
  const largefiles = await configureLargefiles(dir);
  if (!largefiles.success) throw new Error(`configureLargefiles failed: ${largefiles.error}`);
  return dir;
}

function writeFile(dir: string, relPath: string, content: string | Buffer): void {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

async function initDirectoryRemote(dir: string, name: string): Promise<void> {
  const remoteDir = join(TMP_DIR, `${name}-store-${Date.now()}`);
  mkdirSync(remoteDir, { recursive: true });
  const init = await runCmd(
    [
      "git",
      "annex",
      "initremote",
      name,
      "type=directory",
      `directory=${remoteDir}`,
      "encryption=none",
    ],
    dir,
  );
  expect(init.exitCode).toBe(0);
}

/**
 * Route this repo's git-annex filter-process through `tee`, so every byte git
 * streams to the filter is also appended to `logFile`. Content re-read by
 * `git add -A` shows up as bytes in the log.
 */
async function meterFilterProcess(dir: string, logFile: string): Promise<void> {
  writeFileSync(logFile, "");
  const set = await runCmd(
    [
      "git",
      "config",
      "filter.annex.process",
      `sh -c 'tee -a "${logFile}" | git-annex filter-process'`,
    ],
    dir,
  );
  expect(set.exitCode).toBe(0);
}

beforeAll(async () => {
  const probe = await runCmd(["git", "annex", "version"]);
  if (probe.exitCode !== 0) throw new Error("git-annex is required for this test file");
});

afterAll(() => {
  if (existsSync(TMP_DIR)) {
    chmodTreeWritable(TMP_DIR);
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

describe("copy accounting against a real special remote", () => {
  test("filesCopied counts every file the remote now has, including a re-run", async () => {
    const dir = await newDatasetRepo("count");
    const files = ["sub-01/eeg/a.edf", "sub-01/eeg/b.edf", "sub-02/eeg/c.edf"];
    for (const f of files) writeFile(dir, f, f.repeat(500));
    expect((await gitAnnexAdd(dir, files)).success).toBe(true);
    await initDirectoryRemote(dir, "store");

    const first = await copyPathsToAnnexRemote(dir, "store", files, 2);
    expect(first).toEqual({ success: true, filesCopied: 3 });
    const again = await copyToAnnexRemote(dir, "store", 2);
    expect(again).toEqual({ success: true, filesCopied: 3 });
    expect(await listAnnexedPaths(dir, "store")).toEqual(new Set(files));
  });
});

describe("saveDataset with skipContentCheckPaths", () => {
  test("commits the staged pointers without streaming annexed content to the filter", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 7);
    const runOnce = async (skip: boolean): Promise<{ bytes: number; dir: string }> => {
      const dir = await newDatasetRepo(skip ? "save-skip" : "save-plain");
      writeFile(dir, "sub-01/eeg/a.edf", big);
      writeFile(dir, "sub-01/eeg/b.edf", Buffer.alloc(2 * 1024 * 1024, 9));
      writeFile(dir, "dataset_description.json", '{"Name":"x"}');
      expect((await gitAnnexAdd(dir, ["sub-01/eeg/a.edf", "sub-01/eeg/b.edf"])).success).toBe(true);
      const log = join(dir, "..", `${skip ? "skip" : "plain"}-${Date.now()}.filterlog`);
      await meterFilterProcess(dir, log);
      const annexed = [...(await listAnnexedPaths(dir))];
      expect(annexed.sort()).toEqual(["sub-01/eeg/a.edf", "sub-01/eeg/b.edf"]);
      const res = await saveDataset(
        dir,
        "upload",
        undefined,
        skip ? { skipContentCheckPaths: annexed } : {},
      );
      expect(res).toEqual({ success: true });
      return { bytes: readFileSync(log).length, dir };
    };

    const plain = await runOnce(false);
    const skipped = await runOnce(true);
    // Control: the plain add re-reads both 2 MiB files through the filter.
    expect(plain.bytes).toBeGreaterThan(4 * 1024 * 1024);
    // With the skip, only the small metadata file goes through it.
    expect(skipped.bytes).toBeLessThan(64 * 1024);

    // Same commit either way: two annex pointers plus the metadata file in git.
    for (const { dir } of [plain, skipped]) {
      const tree = await runCmd(["git", "ls-tree", "-r", "--name-only", "HEAD"], dir);
      const paths = tree.stdout.split("\n").filter(Boolean);
      for (const p of ["dataset_description.json", "sub-01/eeg/a.edf", "sub-01/eeg/b.edf"]) {
        expect(paths).toContain(p);
      }
      const blob = await runCmd(["git", "cat-file", "-p", "HEAD:sub-01/eeg/a.edf"], dir);
      expect(blob.stdout.startsWith("/annex/objects/")).toBe(true);
    }

    // The assume-unchanged bits are cleared afterwards (lowercase tag = set).
    const tags = await runCmd(["git", "ls-files", "-v", "sub-01/eeg"], skipped.dir);
    expect(
      tags.stdout
        .split("\n")
        .filter(Boolean)
        .every((l) => l.startsWith("H ")),
    ).toBe(true);
  });

  test("a deleted annexed path is not masked, so its removal is committed", async () => {
    const dir = await newDatasetRepo("save-delete");
    writeFile(dir, "sub-01/eeg/a.edf", "a".repeat(200_000));
    writeFile(dir, "sub-01/eeg/b.edf", "b".repeat(200_000));
    expect((await gitAnnexAdd(dir, ["sub-01/eeg/a.edf", "sub-01/eeg/b.edf"])).success).toBe(true);
    expect((await saveDataset(dir, "first")).success).toBe(true);
    rmSync(join(dir, "sub-01/eeg/b.edf"), { force: true });
    const res = await saveDataset(dir, "second", undefined, {
      skipContentCheckPaths: ["sub-01/eeg/a.edf", "sub-01/eeg/b.edf"],
    });
    expect(res.success).toBe(true);
    const tree = await runCmd(["git", "ls-tree", "-r", "--name-only", "HEAD"], dir);
    expect(tree.stdout).toContain("sub-01/eeg/a.edf");
    expect(tree.stdout).not.toContain("sub-01/eeg/b.edf");
  });

  test("setAssumeUnchanged round-trips", async () => {
    const dir = await newDatasetRepo("assume");
    writeFile(dir, "x.edf", "x".repeat(200_000));
    expect((await gitAnnexAdd(dir, ["x.edf"])).success).toBe(true);
    expect((await setAssumeUnchanged(dir, ["x.edf"], true)).success).toBe(true);
    expect((await runCmd(["git", "ls-files", "-v", "x.edf"], dir)).stdout.startsWith("h ")).toBe(
      true,
    );
    expect((await setAssumeUnchanged(dir, ["x.edf"], false)).success).toBe(true);
    expect((await runCmd(["git", "ls-files", "-v", "x.edf"], dir)).stdout.startsWith("H ")).toBe(
      true,
    );
  });
});
