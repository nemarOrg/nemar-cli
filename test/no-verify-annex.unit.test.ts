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
import { printNoVerifyNotice } from "../src/lib/cli-output";
import { initDataset } from "../src/lib/git-annex/init";
import { MAX_UNAVAILABLE_SAMPLE, getDatasetData } from "../src/lib/git-annex/transfer";
import { annexKeyDeclaredSize } from "../src/lib/s3-server-copy";

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

/**
 * The same fixture shape as {@link makeRepoWithRemoteObject}, but built
 * through the REAL production path every NEMAR-created dataset goes through
 * (`initDataset`, `src/lib/git-annex/init.ts`): `git init` -> `git annex
 * init` -> an empty commit -> `git annex adjust --unlock`. That last step is
 * what makes the working tree hold REGULAR FILES instead of symlinks, which
 * is the shape the critical working-tree-cleanup fix below targets. A repo
 * built with a bare `git annex init` (as {@link makeRepoWithRemoteObject}
 * does, on purpose, to cover the locked case) never exercises that path.
 */
async function makeUnlockedRepoWithRemoteObject(
  name: string,
  content: string,
): Promise<RemoteFixture> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const repo = join(TMP_DIR, `${name}-repo-${stamp}`);
  const remoteDir = join(TMP_DIR, `${name}-remote-${stamp}`);
  mkdirSync(remoteDir, { recursive: true });

  const init = await initDataset(repo, { author: { name: "Test", email: "test@test.com" } });
  if (!init.success) throw new Error(`initDataset failed: ${init.error}`);
  // initDataset only sets GIT_AUTHOR_*/GIT_COMMITTER_* env for its own two
  // commits; later manual commits in this fixture need a persisted identity.
  await runCmd(["git", "config", "user.email", "test@test.com"], repo);
  await runCmd(["git", "config", "user.name", "Test"], repo);
  await runCmd(["git", "annex", "config", "--set", "annex.largefiles", "anything"], repo);

  const file = "data.bin";
  writeFileSync(join(repo, file), content);
  const add = await runCmd(["git", "annex", "add", file, "-q"], repo);
  if (add.exitCode !== 0) throw new Error(`git annex add failed: ${add.stderr}`);
  await runCmd(["git", "commit", "-q", "-m", "add"], repo);

  const initRemote = await runCmd(
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
  if (initRemote.exitCode !== 0) throw new Error(`initremote failed: ${initRemote.stderr}`);

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

/**
 * A clone with `count` annexed files whose content was dropped from the
 * "remote" (a plain annex repo, not a special remote) after cloning, so the
 * clone's location log still points at it but every one of them is
 * genuinely unfetchable -- the same shape test/partial-download-annex.unit
 * .test.ts's `makeClone` uses, built locally here so this file stays
 * self-contained.
 */
async function makeCloneWithAllDropped(name: string, count: number): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const remote = join(TMP_DIR, `${name}-remote-${stamp}`);
  mkdirSync(remote, { recursive: true });
  await runCmd(["git", "init", "-q"], remote);
  await runCmd(["git", "config", "user.email", "test@test.com"], remote);
  await runCmd(["git", "config", "user.name", "Test"], remote);
  await runCmd(["git", "annex", "init", "-q", "remote"], remote);
  await runCmd(["git", "annex", "config", "--set", "annex.largefiles", "anything"], remote);

  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const f = `f${String(i).padStart(2, "0")}.bin`;
    writeFileSync(join(remote, f), `${f}-`.repeat(64));
    names.push(f);
  }
  await runCmd(["git", "annex", "add", "."], remote);
  await runCmd(["git", "commit", "-q", "-m", "add"], remote);

  const local = join(TMP_DIR, `${name}-clone-${stamp}`);
  await runCmd(["git", "clone", "-q", remote, local]);
  await runCmd(["git", "config", "user.email", "test@test.com"], local);
  await runCmd(["git", "config", "user.name", "Test"], local);
  await runCmd(["git", "annex", "init", "-q", "local"], local);

  for (const f of names) {
    await runCmd(["git", "annex", "drop", "--force", f], remote);
  }
  return local;
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

describe("getDatasetData --no-verify on an unlocked branch (review: critical working-tree fix)", () => {
  test("a truncated object never leaves stale bytes in the working tree, and a normal re-run recovers", async () => {
    if (!annexAvailable) return;
    const fx = await makeUnlockedRepoWithRemoteObject("unlocked-truncate", "A".repeat(1000));
    truncateObject(fx.objectPath, 500, "C");

    const result = await getDatasetData(fx.repo, { noVerify: true });

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(result.filesDownloaded).toBe(0);
    expect(result.filesUnavailable).toBe(1);
    // The exact recovery command must be in the failure note, not just a bare
    // "unavailable" -- this is what a user (or a script) actually acts on.
    expect(result.error).toContain(
      `Recover with: rm ${fx.file} && git checkout -- ${fx.file} && git annex get ${fx.file}`,
    );

    // THE CRITICAL CASE: on an unlocked/adjusted branch the working-tree
    // entry is a regular file, typically hardlinked to the object store, so
    // `fsck --fast` quarantining the OBJECT does not by itself touch this
    // copy. Measured before this fix existed: the working file kept the
    // stale 500 corrupted bytes here, readable, indistinguishable from good
    // content by anyone who just opens it. It must now be either a pointer
    // (small, textual, git-annex's own placeholder) or simply absent --
    // never the truncated content.
    const workingPath = join(fx.repo, fx.file);
    if (existsSync(workingPath)) {
      const buf = Buffer.from(await Bun.file(workingPath).arrayBuffer());
      expect(buf.length).not.toBe(500);
      expect(buf.toString("latin1").startsWith("C".repeat(20))).toBe(false);
    }

    // Recovery: fix the "upstream" object and re-run a NORMAL (verify-on)
    // `git annex get` -- exactly what the failure note tells a user to do.
    // Before this fix, git-annex's own "don't clobber an existing unlocked
    // file" guard left the stale bytes in place even though THIS second get
    // reported `"success":true` (measured) -- so the assertion that matters
    // is the actual bytes on disk, not the result's own success flag alone.
    writeFileSync(fx.objectPath, "A".repeat(1000));
    const second = await getDatasetData(fx.repo);
    expect(second.success).toBe(true);
    expect(second.filesDownloaded).toBe(1);
    expect(await Bun.file(workingPath).text()).toBe("A".repeat(1000));
  }, 60_000);

  test("a same-size corrupted object on an unlocked branch is still accepted with --no-verify", async () => {
    // Sanity companion to the locked-tree version of this test: the
    // size-only guarantee is unchanged by lock state, only the mismatch
    // cleanup is lock-state-dependent.
    if (!annexAvailable) return;
    const fx = await makeUnlockedRepoWithRemoteObject("unlocked-swap", "A".repeat(1000));
    corruptSameSize(fx.objectPath, fx.declaredSize, "B");

    const result = await getDatasetData(fx.repo, { noVerify: true });

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("complete");
    expect(await Bun.file(join(fx.repo, fx.file)).text()).toBe("B".repeat(fx.declaredSize));
  }, 60_000);
});

describe("getDatasetData --no-verify with an unsized key (review item 2)", () => {
  test("a WORM key is retrieved but counted as unsized, not silently folded into the checked total", async () => {
    if (!annexAvailable) return;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const repo = join(TMP_DIR, `worm-repo-${stamp}`);
    const remoteDir = join(TMP_DIR, `worm-remote-${stamp}`);
    mkdirSync(repo, { recursive: true });
    mkdirSync(remoteDir, { recursive: true });
    await runCmd(["git", "init", "-q", "-b", "main"], repo);
    await runCmd(["git", "config", "user.email", "test@test.com"], repo);
    await runCmd(["git", "config", "user.name", "Test"], repo);
    const initAnnex = await runCmd(["git", "annex", "init", "-q", "repo"], repo);
    expect(initAnnex.exitCode).toBe(0);

    const file = "w.txt";
    writeFileSync(join(repo, file), "hello worm content");
    const add = await runCmd(["git", "annex", "add", "--backend=WORM", file], repo);
    expect(add.exitCode).toBe(0);
    await runCmd(["git", "commit", "-q", "-m", "add"], repo);

    const key = (await runCmd(["git", "annex", "lookupkey", file], repo)).stdout.trim();
    // Sanity: this really is the "no declared size" case being tested, the
    // same function the CLI itself uses to decide, not a re-implementation.
    expect(annexKeyDeclaredSize(key)).toBeNull();

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
    expect(init.exitCode).toBe(0);
    const copy = await runCmd(["git", "annex", "copy", "--to", "store", file], repo);
    expect(copy.exitCode).toBe(0);
    const drop = await runCmd(["git", "annex", "drop", "--force", file], repo);
    expect(drop.exitCode).toBe(0);

    const result = await getDatasetData(repo, { noVerify: true });

    expect(result.success).toBe(true);
    expect(result.filesDownloaded).toBe(1);
    expect(result.unsizedFiles).toBe(1);
  }, 60_000);
});

describe("failureNotes are capped like unavailablePaths (review item 4)", () => {
  test("a run with more failures than the sample cap still reports the total and says how many notes were omitted", async () => {
    if (!annexAvailable) return;
    const repo = await makeCloneWithAllDropped("failnotes-cap", MAX_UNAVAILABLE_SAMPLE + 2);

    const result = await getDatasetData(repo);

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(result.filesUnavailable).toBe(MAX_UNAVAILABLE_SAMPLE + 2);
    // The count is still true even though the raw notes were capped.
    expect(result.error).toContain("more failure note(s) omitted");
  }, 120_000);
});

describe("printNoVerifyNotice (review item 2: the unsized-file caveat)", () => {
  function capturePrint(fn: () => void): string[] {
    const original = console.error;
    const calls: string[] = [];
    console.error = (...args: unknown[]) => {
      calls.push(args.map(String).join(" "));
    };
    try {
      fn();
    } finally {
      console.error = original;
    }
    return calls;
  }

  test("says nothing extra when every fetched file could be size-checked", () => {
    const calls = capturePrint(() => printNoVerifyNotice(0));
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("Sizes were still checked");
    expect(calls[0]).not.toContain("declare no size");
  });

  test("states how many files could be checked by neither hash nor size", () => {
    const calls = capturePrint(() => printNoVerifyNotice(3));
    expect(calls[0]).toContain("3 of the fetched file(s)");
    expect(calls[0]).toContain("neither hash nor size");
  });
});
