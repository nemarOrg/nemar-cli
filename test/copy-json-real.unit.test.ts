/**
 * `git annex copy --json --json-error-messages`, parsed from what git-annex really
 * prints.
 *
 * Every failing record below is captured from a real failing copy against a real
 * `directory` special remote: a read-only store, which fails mid-transfer, and a
 * missing store, which git-annex declines up front. The two differ in where the
 * reason lives (`error-messages` against `note`), which is exactly what error JSON
 * written by hand cannot be trusted to get right.
 *
 * Assertions that read git-annex's own prose, or the shape of a record, rather than
 * ours are marked "version-coupled": they hold on git-annex 10.20260901 and are the
 * ones to look at first if a different git-annex build fails this file.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitAnnexAdd } from "../src/lib/git-annex/init";
import {
  copyPathsToAnnexRemote,
  copyToAnnexRemote,
  extractCopyJsonError,
  parseCopyJson,
} from "../src/lib/git-annex/transfer";
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

const scratch = makeScratch("nemar-copy-json");
// A read-only directory does not stop root, so the read-only captures cannot run as
// root; under root the test of the de-duplication (which only that failure shape
// exercises) is skipped, and removing the de-duplication goes unnoticed there.
const canBlockWrites = process.getuid?.() !== 0;

beforeAll(async () => {
  const probe = await run(["git", "annex", "version"]);
  if (probe.exitCode !== 0) throw new Error("git-annex is required for this test file");
});
afterAll(() => scratch.cleanup());

interface Capture {
  repo: string;
  store: string;
  paths: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

function copyArgs(paths: string[]): string[] {
  return [
    "git",
    "annex",
    "copy",
    "--to",
    "store",
    "-J",
    "2",
    "--json",
    "--json-error-messages",
    "--",
    ...paths,
  ];
}

/**
 * Annex `count` files, break the remote as `how`, and capture a real JSON copy.
 *
 * `read-only` first copies one file so the store has its `tmp` directory, then makes
 * the store read-only: the next object cannot create its hash directory, which is the
 * failure whose message git-annex repeats inside the record. The copy that is
 * captured covers only the files after that first one.
 */
async function captureCopy(how: "none" | "read-only" | "missing", count: number): Promise<Capture> {
  const repo = await newDatasetRepo(scratch.root, `capture-${how}`);
  const all = Array.from({ length: count + 1 }, (_, i) => `sub-${i}/eeg/run-${i}.edf`);
  for (const [i, p] of all.entries()) writeFile(repo, p, `${i}`.repeat(2_000 + i));
  expect((await gitAnnexAdd(repo, all)).success).toBe(true);
  const store = await initDirectoryRemote(scratch.root, repo, "store");
  let paths = all.slice(0, count);
  if (how === "read-only") {
    const first = await run(["git", "annex", "copy", "--to", "store", "--", all[0]], repo);
    expect(first.exitCode).toBe(0);
    paths = all.slice(1);
    chmodSync(store, 0o555);
  }
  if (how === "missing") renameSync(store, `${store}.gone`);
  const copy = await run(
    [
      "git",
      "annex",
      "copy",
      "--to",
      "store",
      "-J",
      "2",
      "--json",
      "--json-error-messages",
      "--",
      ...paths,
    ],
    repo,
  );
  return { repo, store, paths, ...copy };
}

describe("parseCopyJson against real output", () => {
  test("a successful copy yields one success record per file, and the progress note is no error", async () => {
    const cap = await captureCopy("none", 3);
    expect(cap.exitCode).toBe(0);
    const records = parseCopyJson(cap.stdout);
    expect(records.map((r) => r.file).sort()).toEqual([...cap.paths].sort());
    for (const r of records) {
      expect(r.success).toBe(true);
      expect(r.errors).toEqual([]);
      expect(r.key).toMatch(/^SHA256E-s\d+--/);
    }
  });

  test("a record says whether git-annex moved the content or found it already there", async () => {
    // Guards `transferred`. The first copy sends everything; the second finds it all
    // already at the store and moves nothing; with the store emptied behind git-annex's
    // back the third is a re-send, even though the location log still says "present".
    const cap = await captureCopy("none", 3);
    expect(parseCopyJson(cap.stdout).map((r) => r.transferred)).toEqual([true, true, true]);

    const again = await run(copyArgs(cap.paths), cap.repo);
    expect(again.exitCode).toBe(0);
    const present = parseCopyJson(again.stdout);
    expect(present).toHaveLength(3);
    expect(present.every((r) => r.success && !r.transferred)).toBe(true);

    chmodTreeWritable(cap.store);
    for (const entry of readdirSync(cap.store)) {
      rmSync(join(cap.store, entry), { recursive: true, force: true });
    }
    const resent = await run(copyArgs(cap.paths), cap.repo);
    expect(parseCopyJson(resent.stdout).every((r) => r.success && r.transferred)).toBe(true);
    // The functions built on it carry the count.
    const counted = await copyPathsToAnnexRemote(cap.repo, "store", cap.paths, 2);
    expect(counted).toMatchObject({ success: true, filesCopied: 3, filesSent: 0 });
  });

  test("a failed record that carries only the progress note has no reason to report", () => {
    // Pure on purpose: no real failure was found that puts ONLY the progress note in a
    // failed record, so this guards the filter against that shape rather than a capture.
    const stdout =
      '{"command":"copy","error-messages":[],"file":"a.edf","key":"K","note":"to store...","success":false}\n';
    expect(parseCopyJson(stdout)).toEqual([
      { file: "a.edf", key: "K", success: false, transferred: false, errors: [] },
    ]);
  });

  test("lines that are not JSON records are ignored around real ones", async () => {
    const cap = await captureCopy("none", 2);
    const noisy = `(recording state in git...)\n${cap.stdout}\n{not json\n{"command":"copy"}\n`;
    expect(parseCopyJson(noisy)).toEqual(parseCopyJson(cap.stdout));
    expect(parseCopyJson(noisy)).toHaveLength(2);
  });

  test("a record of another command is not counted as a copy", async () => {
    const cap = await captureCopy("none", 1);
    const found = await run(["git", "annex", "whereis", "--json", "--", cap.paths[0]], cap.repo);
    expect(found.exitCode).toBe(0);
    expect(found.stdout).toContain('"command":"whereis"');
    expect(parseCopyJson(found.stdout)).toEqual([]);
  });

  test.skipIf(!canBlockWrites)(
    "a transfer that failed carries its reason once per record, de-duplicated",
    async () => {
      const cap = await captureCopy("read-only", 2);
      expect(cap.exitCode).not.toBe(0);
      const raw = cap.stdout
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as { "error-messages": string[] });
      const records = parseCopyJson(cap.stdout);
      expect(records).toHaveLength(2);
      for (const [i, r] of records.entries()) {
        expect(r.success).toBe(false);
        // The premise, measured: git-annex repeats the message inside the record...
        expect(raw[i]["error-messages"].length).toBeGreaterThan(1);
        // ...and the parse keeps it once.
        expect(r.errors).toHaveLength(1);
        // Version-coupled: the OS wording. What matters is that a reason is present
        // and names the store it could not write to.
        expect(r.errors[0]).toContain(cap.store);
      }
    },
  );

  test("a remote git-annex declined up front has its reason in the note, not in error-messages", async () => {
    const cap = await captureCopy("missing", 2);
    expect(cap.exitCode).not.toBe(0);
    // Version-coupled: the shape that broke the first parse (success false,
    // error-messages empty, reason in the note). An older git-annex may put the
    // reason in error-messages, and then this premise, not the parse, is what moves.
    const raw = cap.stdout
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(raw).toHaveLength(2);
    for (const r of raw) {
      expect(r.success).toBe(false);
      expect(r["error-messages"]).toEqual([]);
    }
    const records = parseCopyJson(cap.stdout);
    for (const r of records) {
      expect(r.success).toBe(false);
      expect(r.errors).toHaveLength(1);
      // Version-coupled: git-annex's wording; the store it names is the stable part.
      expect(r.errors[0]).toContain(cap.store);
    }
  });
});

describe("a git-annex that exits 0 and says something unexpected", () => {
  test("is reported as unrecognized, so a count of zero is not read as a verdict", async () => {
    // The shim stands in for a git-annex whose output format changed. The location log
    // is still the authority on what arrived; this only keeps "confirmed 0 of N" from
    // being printed as though it measured something.
    const cap = await captureCopy("none", 2);
    const restore = installGitShim(scratch.root, [
      { match: "annex copy", stdout: "Wir haben kopiert (pretend new format)" },
    ]);
    try {
      const result = await copyPathsToAnnexRemote(cap.repo, "store", cap.paths, 2);
      expect(result).toMatchObject({
        success: true,
        filesCopied: 0,
        filesSent: 0,
        outputRecognized: false,
      });
    } finally {
      restore();
    }
  });

  test("empty output is not unrecognized: nothing to say is a valid answer", async () => {
    const cap = await captureCopy("none", 1);
    const restore = installGitShim(scratch.root, [{ match: "annex copy", stdout: "" }]);
    try {
      // printf prints a bare newline, which is whitespace and carries no content.
      const result = await copyPathsToAnnexRemote(cap.repo, "store", cap.paths, 2);
      expect(result.outputRecognized).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("extractCopyJsonError against real output", () => {
  test("names each failed file with the cause git-annex gave, for a declined remote", async () => {
    const cap = await captureCopy("missing", 2);
    const msg = extractCopyJsonError(parseCopyJson(cap.stdout), cap.stdout, cap.stderr);
    expect(msg).toContain("2 file(s) failed to copy:");
    for (const p of cap.paths) expect(msg).toContain(`${p}: `);
    expect(msg).toContain(cap.store);
    expect(msg).not.toMatch(/: failed$/m);
    // git-annex's own stderr summary is appended whatever it says.
    expect(msg).toContain(cap.stderr.trim());
  });

  test.skipIf(!canBlockWrites)(
    "names each failed file with the cause for a failed transfer",
    async () => {
      const cap = await captureCopy("read-only", 2);
      const msg = extractCopyJsonError(parseCopyJson(cap.stdout), cap.stdout, cap.stderr);
      expect(msg).toContain("2 file(s) failed to copy:");
      for (const p of cap.paths) expect(msg).toContain(`${p}: `);
      // Once per file, not twice: the duplicate inside each record is dropped.
      expect(msg.split(cap.store).length - 1).toBe(cap.paths.length);
    },
  );

  test("with no failed record it says what it knows: stderr and the exit code", async () => {
    const cap = await captureCopy("none", 1);
    expect(
      extractCopyJsonError(parseCopyJson(cap.stdout), "", "fatal: not a git repository", 128),
    ).toBe("git annex copy failed with exit code 128: fatal: not a git repository");
  });

  test("success-only output with a non-zero exit never turns a JSON line into the message", async () => {
    // Every record carries an `error-messages` key, so searching stdout for error words
    // would match a SUCCESS record and surface the raw JSON as the error.
    const cap = await captureCopy("none", 2);
    expect(cap.stdout).toContain("error-messages");
    const msg = extractCopyJsonError(parseCopyJson(cap.stdout), cap.stdout, "", 1);
    expect(msg).toBe("git annex copy failed with exit code 1 without saying why");
    expect(msg).not.toContain("{");
  });

  test("output that is not copy records is called what it is", () => {
    expect(extractCopyJsonError([], "something unexpected\n", "", 1)).toBe(
      "git annex copy failed with exit code 1; its output was not recognized as copy records",
    );
    expect(extractCopyJsonError([], "something unexpected\n", "boom", 2)).toBe(
      "git annex copy failed with exit code 2; its output was not recognized as copy records: boom",
    );
  });

  test("a killed git-annex is reported with its exit code, not as a generic failure", async () => {
    // The shim kills only `git annex copy`; everything else runs the real git.
    const cap = await captureCopy("none", 2);
    const restore = installGitShim(scratch.root, [{ match: "annex copy", kill: true }]);
    try {
      const result = await copyPathsToAnnexRemote(cap.repo, "store", cap.paths, 2);
      expect(result.success).toBe(false);
      expect(result.error).toContain("exit code 137");
      expect(result.error).not.toBe("Failed to copy to remote");
    } finally {
      restore();
    }
  });

  test("bounds a many-file failure to the last failures, and says how many it left out", async () => {
    const cap = await captureCopy("missing", 30);
    const records = parseCopyJson(cap.stdout);
    expect(records).toHaveLength(30);
    const lines = extractCopyJsonError(records, cap.stdout, cap.stderr).split("\n");
    expect(lines[0]).toBe("30 file(s) failed to copy:");
    expect(lines[1]).toContain("10 earlier failed files omitted");
    // header, omission line, the 20 kept failures, git-annex's own summary line
    expect(lines).toHaveLength(23);
  });
});

describe("the copy functions report the cause end to end", () => {
  test("copyPathsToAnnexRemote returns the declined-remote reason and counts no success", async () => {
    const cap = await captureCopy("none", 2);
    // Re-break the remote for the production function under test.
    renameSync(cap.store, `${cap.store}.gone`);
    const result = await copyPathsToAnnexRemote(cap.repo, "store", cap.paths, 2);
    expect(result.success).toBe(false);
    expect(result.filesCopied).toBe(0);
    expect(result.error).toContain(cap.store);
  });

  test("copyToAnnexRemote returns the declined-remote reason too", async () => {
    const cap = await captureCopy("none", 2);
    renameSync(cap.store, `${cap.store}.gone`);
    const result = await copyToAnnexRemote(cap.repo, "store", 2);
    expect(result.success).toBe(false);
    expect(result.error).toContain(cap.store);
  });
});
