/**
 * Real git-annex coverage for `--no-verify` (#1523): what `annex.verify=false`
 * actually skips on `git annex get`, and the CLI-side size check that fills
 * the gap it leaves.
 *
 * No mocks and no network: a directory special remote holds the "upstream"
 * object (the same trick test/git-annex-remote.test.ts and
 * test/partial-download-annex.unit.test.ts use to avoid needing S3
 * credentials), and the test corrupts that object's bytes on disk before the
 * clone fetches it -- reproducing a swapped or truncated transfer without a
 * real network.
 *
 * Measured on git-annex 10.20260901, empirically, before writing this file:
 * with `-c annex.verify=false`, `git annex get` accepts BOTH a same-size
 * content-swapped object and a truncated one -- neither the hash nor the
 * declared size is checked at receipt. `getDatasetData`'s post-transfer size
 * check exists to close the second gap; these tests pin both halves of that
 * finding, plus the guarantee that verify=false is never written to git
 * config.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "bun";
import { getDatasetData } from "../src/lib/git-annex/transfer";

const TMP_DIR = join(import.meta.dir, ".test-no-verify-annex");
let annexAvailable = true;

// git-annex marks object files (and their containing hash directory) read-only;
// removal needs write+execute back on every directory first.
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

/** The one file under `remoteDir` matching `key`, regardless of hashdir scheme. */
async function findObjectFile(remoteDir: string, key: string): Promise<string> {
  const result = await runCmd(["find", remoteDir, "-name", key, "-type", "f"]);
  const path = result.stdout.trim().split("\n")[0];
  if (!path) throw new Error(`could not find annex object ${key} under ${remoteDir}`);
  return path;
}

interface RemoteFixture {
  repo: string;
  remoteDir: string;
  file: string;
  key: string;
  declaredSize: number;
  objectPath: string;
}

/**
 * A repo with one annexed file copied to a directory special remote and then
 * dropped locally, so `getDatasetData` must fetch it from the remote -- the
 * exact shape a real S3-backed NEMAR clone is in after `dataset clone` and
 * before `dataset get`.
 */
async function makeRepoWithRemoteObject(name: string, content: string): Promise<RemoteFixture> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const repo = join(TMP_DIR, `${name}-repo-${stamp}`);
  const remoteDir = join(TMP_DIR, `${name}-remote-${stamp}`);
  mkdirSync(repo, { recursive: true });
  mkdirSync(remoteDir, { recursive: true });

  await runCmd(["git", "init", "-q", "-b", "main"], repo);
  await runCmd(["git", "config", "user.email", "test@test.com"], repo);
  await runCmd(["git", "config", "user.name", "Test"], repo);
  const initAnnex = await runCmd(["git", "annex", "init", "-q", "repo"], repo);
  if (initAnnex.exitCode !== 0) throw new Error(`git annex init failed: ${initAnnex.stderr}`);
  await runCmd(["git", "annex", "config", "--set", "annex.largefiles", "anything"], repo);

  const file = "data.bin";
  writeFileSync(join(repo, file), content);
  const add = await runCmd(["git", "annex", "add", file, "-q"], repo);
  if (add.exitCode !== 0) throw new Error(`git annex add failed: ${add.stderr}`);
  await runCmd(["git", "commit", "-q", "-m", "add"], repo);

  const init = await runCmd(
    [
      "git",
      "annex",
      "initremote",
      "store",
      "type=directory",
      `directory=${remoteDir}`,
      "encryption=none",
    ],
    repo,
  );
  if (init.exitCode !== 0) throw new Error(`initremote failed: ${init.stderr}`);

  const copy = await runCmd(["git", "annex", "copy", "--to", "store", file], repo);
  if (copy.exitCode !== 0) throw new Error(`copy --to store failed: ${copy.stderr}`);

  const drop = await runCmd(["git", "annex", "drop", "--force", file], repo);
  if (drop.exitCode !== 0) throw new Error(`drop failed: ${drop.stderr}`);

  const keyResult = await runCmd(["git", "annex", "lookupkey", file], repo);
  const key = keyResult.stdout.trim();
  const sizeMatch = key.match(/-s(\d+)--/);
  if (!sizeMatch) throw new Error(`key ${key} does not embed a size`);
  const declaredSize = Number.parseInt(sizeMatch[1], 10);

  const objectPath = await findObjectFile(remoteDir, key);

  return { repo, remoteDir, file, key, declaredSize, objectPath };
}

/** Overwrite the remote object's bytes in place, keeping its length unchanged. */
function corruptSameSize(objectPath: string, size: number, fill: string): void {
  chmodSync(dirname(objectPath), 0o755);
  chmodSync(objectPath, 0o644);
  writeFileSync(objectPath, Buffer.alloc(size, fill));
}

/** Overwrite the remote object with fewer bytes than its key declares. */
function truncateObject(objectPath: string, newSize: number, fill: string): void {
  chmodSync(dirname(objectPath), 0o755);
  chmodSync(objectPath, 0o644);
  writeFileSync(objectPath, Buffer.alloc(newSize, fill));
}

beforeAll(async () => {
  mkdirSync(TMP_DIR, { recursive: true });
  annexAvailable = (await runCmd(["git", "annex", "version"])).exitCode === 0;
});

afterAll(() => {
  if (existsSync(TMP_DIR)) {
    chmodTreeWritable(TMP_DIR);
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

describe("getDatasetData --no-verify (#1523)", () => {
  test("a same-size corrupted object is rejected by default (verify stays on)", async () => {
    if (!annexAvailable) return;
    const fx = await makeRepoWithRemoteObject("default-swap", "A".repeat(1000));
    corruptSameSize(fx.objectPath, fx.declaredSize, "B");

    const result = await getDatasetData(fx.repo);

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(result.filesDownloaded).toBe(0);
    expect(result.filesUnavailable).toBe(1);
  }, 60_000);

  test("the same corrupted object is accepted with --no-verify (content is not hashed)", async () => {
    if (!annexAvailable) return;
    const fx = await makeRepoWithRemoteObject("noverify-swap", "A".repeat(1000));
    corruptSameSize(fx.objectPath, fx.declaredSize, "B");

    const result = await getDatasetData(fx.repo, { noVerify: true });

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("complete");
    expect(result.filesDownloaded).toBe(1);
    expect(result.filesUnavailable).toBe(0);
    // Prove it is really the corrupted content that landed, not a lucky pass.
    const written = await Bun.file(join(fx.repo, fx.file)).text();
    expect(written).toBe("B".repeat(fx.declaredSize));
  }, 60_000);

  test("a truncated object is rejected by default (verify stays on)", async () => {
    if (!annexAvailable) return;
    const fx = await makeRepoWithRemoteObject("default-truncate", "C".repeat(1000));
    truncateObject(fx.objectPath, 500, "C");

    const result = await getDatasetData(fx.repo);

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(result.filesDownloaded).toBe(0);
    expect(result.filesUnavailable).toBe(1);
  }, 60_000);

  test("a truncated object is REJECTED even with --no-verify, by the CLI's own size check", async () => {
    if (!annexAvailable) return;
    const fx = await makeRepoWithRemoteObject("noverify-truncate", "C".repeat(1000));
    truncateObject(fx.objectPath, 500, "C");

    const result = await getDatasetData(fx.repo, { noVerify: true });

    // git-annex's own exit code and JSON would call this a success (measured);
    // the post-transfer size check in getDatasetData must downgrade it.
    expect(result.success).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(result.filesDownloaded).toBe(0);
    expect(result.filesUnavailable).toBe(1);
    expect(result.error).toContain("--no-verify accepted");
    expect(result.error).toContain(`declares ${fx.declaredSize}`);

    // The quarantine ran: git-annex's own location log no longer claims "here"
    // has the content (fsck --fast moved the bad object to .git/annex/bad).
    const whereis = await runCmd(["git", "annex", "whereis", "--json", fx.file], fx.repo);
    const parsed = JSON.parse(whereis.stdout.trim().split("\n").pop() ?? "{}") as {
      whereis?: Array<{ here?: boolean }>;
    };
    expect((parsed.whereis ?? []).some((loc) => loc.here === true)).toBe(false);
  }, 60_000);

  test("--no-verify never writes annex.verify to the repo's git config", async () => {
    if (!annexAvailable) return;
    const fx = await makeRepoWithRemoteObject("noverify-config", "D".repeat(2000));

    const result = await getDatasetData(fx.repo, { noVerify: true });
    expect(result.success).toBe(true);
    expect(result.filesDownloaded).toBe(1);

    const configRead = await runCmd(["git", "config", "--get", "annex.verify"], fx.repo);
    // Unset: `git config --get` on a key that was never written exits non-zero
    // and prints nothing.
    expect(configRead.exitCode).not.toBe(0);
    expect(configRead.stdout.trim()).toBe("");
  }, 60_000);

  test("--no-verify still downloads an uncorrupted file correctly (no false positives)", async () => {
    if (!annexAvailable) return;
    const fx = await makeRepoWithRemoteObject("noverify-clean", "E".repeat(4096));

    const result = await getDatasetData(fx.repo, { noVerify: true });

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("complete");
    expect(result.filesDownloaded).toBe(1);
    expect(result.filesUnavailable).toBe(0);
    const written = await Bun.file(join(fx.repo, fx.file)).text();
    expect(written).toBe("E".repeat(4096));
  }, 60_000);
});
