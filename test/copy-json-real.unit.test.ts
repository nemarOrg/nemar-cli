/**
 * `git annex copy --json --json-error-messages`, parsed from what git-annex really
 * prints.
 *
 * The first version of these tests fed `parseCopyJson` error JSON written by hand
 * (`"error-messages":["S3 error: AccessDenied"]`), and that hid a bug: when git-annex
 * declines to use a remote before trying (its store directory is gone) the record has
 * EMPTY `error-messages` and the reason in `note`, so the message came out as
 * "file: failed" with no cause. Every failing record below is captured from a real
 * failing copy against a real `directory` special remote: a read-only store, which
 * fails mid-transfer, and a missing store, which is declined up front.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, renameSync } from "node:fs";
import { gitAnnexAdd } from "../src/lib/git-annex/init";
import {
  copyPathsToAnnexRemote,
  copyToAnnexRemote,
  extractCopyJsonError,
  parseCopyJson,
} from "../src/lib/git-annex/transfer";
import {
  initDirectoryRemote,
  makeScratch,
  newDatasetRepo,
  run,
  writeFile,
} from "./helpers/annex-repo";

const scratch = makeScratch("nemar-copy-json");
// A read-only directory does not stop root, so that capture cannot run as root.
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
        expect(r.errors[0]).toContain("permission denied");
      }
    },
  );

  test("a remote git-annex declined up front has its reason in the note, not in error-messages", async () => {
    const cap = await captureCopy("missing", 2);
    expect(cap.exitCode).not.toBe(0);
    // The shape that broke the first parse: success false, error-messages empty.
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
      expect(r.errors[0]).toContain("is not accessible");
    }
  });
});

describe("extractCopyJsonError against real output", () => {
  test("names each failed file with the cause git-annex gave, for a declined remote", async () => {
    const cap = await captureCopy("missing", 2);
    const msg = extractCopyJsonError(parseCopyJson(cap.stdout), cap.stdout, cap.stderr);
    expect(msg).toContain("2 file(s) failed to copy:");
    for (const p of cap.paths) expect(msg).toContain(`${p}: directory`);
    expect(msg).toContain("is not accessible");
    expect(msg).not.toMatch(/: failed$/m);
    expect(msg).toContain("copy: 2 failed");
  });

  test.skipIf(!canBlockWrites)(
    "names each failed file with the cause for a failed transfer",
    async () => {
      const cap = await captureCopy("read-only", 2);
      const msg = extractCopyJsonError(parseCopyJson(cap.stdout), cap.stdout, cap.stderr);
      expect(msg).toContain("2 file(s) failed to copy:");
      for (const p of cap.paths) expect(msg).toContain(`${p}: `);
      expect(msg).toContain("permission denied");
      // Once per file, not twice: the duplicate inside each record is dropped.
      expect(msg.match(/permission denied/g)).toHaveLength(2);
    },
  );

  test("falls back to the human-output extraction when no record failed", async () => {
    const cap = await captureCopy("none", 1);
    expect(extractCopyJsonError(parseCopyJson(cap.stdout), "", "fatal: not a git repository")).toBe(
      "fatal: not a git repository",
    );
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
    expect(result.error).toContain("is not accessible");
  });

  test("copyToAnnexRemote returns the declined-remote reason too", async () => {
    const cap = await captureCopy("none", 2);
    renameSync(cap.store, `${cap.store}.gone`);
    const result = await copyToAnnexRemote(cap.repo, "store", 2);
    expect(result.success).toBe(false);
    expect(result.error).toContain("is not accessible");
  });
});
