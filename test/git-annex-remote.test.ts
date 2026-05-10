/**
 * Real git-annex tests for annexRemoteExists, initOrEnableSpecialRemote,
 * and the initremote/enableremote fallback regex used by configureS3Remote.
 *
 * Validates that:
 *   - annexRemoteExists returns true only for a registered special remote
 *     and rejects the `here` alias, bare UUIDs, and annexed file paths
 *   - the fallback regex matches git-annex's wording but not S3 bucket
 *     errors that happen to contain the substring "already exists"
 *   - initOrEnableSpecialRemote falls back to enableremote on a duplicate
 *     name and surfaces real stderr otherwise
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import {
  ANNEX_REMOTE_EXISTS_RE,
  annexRemoteExists,
  getAnnexS3Remotes,
  initOrEnableSpecialRemote,
  selectAnnexS3Remote,
} from "../src/lib/git-annex";

const TMP_DIR = join(import.meta.dir, ".test-annex-remote");

async function runCmd(
  cmd: string[],
  cwd?: string,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : undefined,
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

// git-annex marks object files read-only; rm needs write+execute on dirs.
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

async function newAnnexRepo(name: string): Promise<string> {
  const dir = join(TMP_DIR, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const initGit = await runCmd(["git", "init", "-q"], dir);
  if (initGit.exitCode !== 0) {
    throw new Error(`git init failed: ${initGit.stderr}`);
  }
  await runCmd(["git", "config", "user.email", "test@test.com"], dir);
  await runCmd(["git", "config", "user.name", "Test"], dir);
  const initAnnex = await runCmd(["git", "annex", "init", "-q", "src"], dir);
  if (initAnnex.exitCode !== 0) {
    throw new Error(`git annex init failed: ${initAnnex.stderr}`);
  }
  return dir;
}

beforeAll(async () => {
  // Skip the whole suite cleanly if git-annex is not on PATH.
  const probe = await runCmd(["git", "annex", "version"]);
  if (probe.exitCode !== 0) {
    throw new Error("git-annex is required for this test file");
  }
});

afterAll(() => {
  if (existsSync(TMP_DIR)) {
    chmodTreeWritable(TMP_DIR);
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

describe("annexRemoteExists", () => {
  test("returns false in a fresh annex repo with no special remotes", async () => {
    const repo = await newAnnexRepo("empty");
    expect(await annexRemoteExists(repo, "nemar-s3")).toBe(false);
  });

  test("returns false for a name not registered in the repo", async () => {
    const repo = await newAnnexRepo("only-directory");
    const dirRemote = join(repo, ".dir-remote");
    mkdirSync(dirRemote, { recursive: true });
    const init = await runCmd(
      [
        "git",
        "annex",
        "initremote",
        "local-dir",
        "type=directory",
        `directory=${dirRemote}`,
        "encryption=none",
      ],
      repo,
    );
    expect(init.exitCode).toBe(0);
    expect(await annexRemoteExists(repo, "nemar-s3")).toBe(false);
    // Sanity: it does see the one we just registered
    expect(await annexRemoteExists(repo, "local-dir")).toBe(true);
  });

  test("returns false for the 'here' alias (local repo, not a special remote)", async () => {
    const repo = await newAnnexRepo("here-alias");
    expect(await annexRemoteExists(repo, "here")).toBe(false);
  });

  test("returns false when the name is a bare local UUID", async () => {
    const repo = await newAnnexRepo("uuid-input");
    const probe = await runCmd(["git", "annex", "info", "here", "--json"], repo);
    const uuid = JSON.parse(probe.stdout).uuid as string;
    expect(uuid.length).toBeGreaterThan(0);
    expect(await annexRemoteExists(repo, uuid)).toBe(false);
  });

  test("returns false when the name collides with an annexed file path", async () => {
    const repo = await newAnnexRepo("file-collision");
    const filePath = join(repo, "nemar-s3");
    await Bun.write(filePath, "data");
    const add = await runCmd(["git", "annex", "add", "nemar-s3", "-q"], repo);
    expect(add.exitCode).toBe(0);
    await runCmd(["git", "commit", "-qm", "add"], repo);
    expect(await annexRemoteExists(repo, "nemar-s3")).toBe(false);
  });

  test("returns false in a non-annex git repo (graceful degrade)", async () => {
    const dir = join(TMP_DIR, `plain-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    await runCmd(["git", "init", "-q"], dir);
    expect(await annexRemoteExists(dir, "nemar-s3")).toBe(false);
  });
});

describe("initremote/enableremote fallback regex", () => {
  test("matches git-annex's actual duplicate-remote wording", () => {
    const stderr =
      "initremote nemar-s3 \n" +
      'git-annex: There is already a special remote named "nemar-s3". (Use enableremote to enable an existing special remote.)\n' +
      "failed\ninitremote: 1 failed\n";
    expect(ANNEX_REMOTE_EXISTS_RE.test(stderr)).toBe(true);
  });

  test("matches the duplicate message after progress chatter on the same stream", () => {
    const stderr =
      "initremote nemar-s3 (checking bucket...) (probing remote info...) \n" +
      "(Some intermediate warning that should not interfere)\n" +
      'git-annex: There is already a special remote named "nemar-s3". (Use enableremote to enable an existing special remote.)\n';
    expect(ANNEX_REMOTE_EXISTS_RE.test(stderr)).toBe(true);
  });

  test("does not match S3 BucketAlreadyOwnedByYou message", () => {
    const stderr =
      "initremote nemar-s3 (checking bucket...) (creating bucket in us-east-2...) \n" +
      'git-annex: S3Error {s3StatusCode = Status {statusCode = 409, statusMessage = "Conflict"}, ' +
      's3ErrorCode = "BucketAlreadyOwnedByYou", s3ErrorMessage = "Your previous request to ' +
      'create the named bucket succeeded and you already own it."}\nfailed\n';
    expect(ANNEX_REMOTE_EXISTS_RE.test(stderr)).toBe(false);
  });

  test("does not match S3 BucketAlreadyExists message", () => {
    const stderr =
      "initremote nemar-s3 (checking bucket...) (creating bucket in us-east-2...) \n" +
      'git-annex: S3Error {s3StatusCode = Status {statusCode = 409, statusMessage = "Conflict"}, ' +
      's3ErrorCode = "BucketAlreadyExists", s3ErrorMessage = "The requested bucket name is ' +
      'not available."}\nfailed\n';
    expect(ANNEX_REMOTE_EXISTS_RE.test(stderr)).toBe(false);
  });

  test("does not match a generic 'key already exists' substring", () => {
    const stderr = "something failed: object key already exists in bucket\n";
    expect(ANNEX_REMOTE_EXISTS_RE.test(stderr)).toBe(false);
  });
});

describe("initOrEnableSpecialRemote (end-to-end fallback)", () => {
  // Use type=directory remotes so we can exercise the duplicate-detection
  // and enableremote fallback paths without S3 credentials.
  function dirRemoteParams(dir: string): string[] {
    return ["type=directory", `directory=${dir}`, "encryption=none"];
  }

  test("first call performs initremote and registers the remote", async () => {
    const repo = await newAnnexRepo("e2e-init");
    const remoteDir = join(repo, ".remote-store");
    mkdirSync(remoteDir, { recursive: true });
    const result = await initOrEnableSpecialRemote(
      repo,
      "first-attempt",
      dirRemoteParams(remoteDir),
      {},
    );
    expect(result.success).toBe(true);
    expect(await annexRemoteExists(repo, "first-attempt")).toBe(true);
  });

  test("second call falls back to enableremote when the remote already exists", async () => {
    const repo = await newAnnexRepo("e2e-resume");
    const remoteDir = join(repo, ".remote-store");
    mkdirSync(remoteDir, { recursive: true });

    // Simulate a prior partial run: register, then drop local enablement so
    // the local-state seam still sees the remote in git-annex branch.
    const first = await initOrEnableSpecialRemote(
      repo,
      "resume-test",
      dirRemoteParams(remoteDir),
      {},
    );
    expect(first.success).toBe(true);

    const second = await initOrEnableSpecialRemote(
      repo,
      "resume-test",
      dirRemoteParams(remoteDir),
      {},
    );
    expect(second.success).toBe(true);
    expect(second.error).toBeUndefined();
  });

  test("getAnnexS3Remotes returns nothing for a fresh annex repo with no special remotes", async () => {
    const repo = await newAnnexRepo("get-empty");
    expect(await getAnnexS3Remotes(repo)).toEqual([]);
  });

  test("getAnnexS3Remotes filters remotes with annex-ignore=true", async () => {
    // Issue #401 Bug A: OpenNeuro mirrors leave inherited s3-PUBLIC/s3-PRIVATE
    // remotes. After import we mark them annex-ignore=true; getAnnexS3Remotes
    // must skip them so push never picks them as the upload destination.
    const repo = await newAnnexRepo("get-filter-ignored");

    // Fake an "S3 remote" via git config alone — we don't need a real bucket
    // for this test, just the shape getAnnexS3Remotes inspects.
    await runCmd(["git", "remote", "add", "nemar-s3", "https://example/nemar-s3"], repo);
    await runCmd(["git", "config", "remote.nemar-s3.annex-s3", "true"], repo);
    await runCmd(["git", "config", "remote.nemar-s3.annex-uuid", crypto.randomUUID()], repo);

    await runCmd(["git", "remote", "add", "s3-PUBLIC", "https://example/openneuro"], repo);
    await runCmd(["git", "config", "remote.s3-PUBLIC.annex-s3", "true"], repo);
    await runCmd(["git", "config", "remote.s3-PUBLIC.annex-uuid", crypto.randomUUID()], repo);
    await runCmd(["git", "config", "remote.s3-PUBLIC.annex-ignore", "true"], repo);

    const remotes = await getAnnexS3Remotes(repo);
    expect(remotes).toEqual(["nemar-s3"]);
  });

  test("selectAnnexS3Remote prefers nemar-s3 over inherited remotes", async () => {
    const repo = await newAnnexRepo("select-prefer-nemar");

    // Two non-ignored S3 remotes; getAnnexS3Remotes returns both; the picker
    // must choose nemar-s3 even when it's not first in iteration order.
    await runCmd(["git", "remote", "add", "s3-PUBLIC", "https://example/openneuro"], repo);
    await runCmd(["git", "config", "remote.s3-PUBLIC.annex-s3", "true"], repo);
    await runCmd(["git", "config", "remote.s3-PUBLIC.annex-uuid", crypto.randomUUID()], repo);

    await runCmd(["git", "remote", "add", "nemar-s3", "https://example/nemar-s3"], repo);
    await runCmd(["git", "config", "remote.nemar-s3.annex-s3", "true"], repo);
    await runCmd(["git", "config", "remote.nemar-s3.annex-uuid", crypto.randomUUID()], repo);

    const remotes = await getAnnexS3Remotes(repo);
    expect(remotes).toContain("nemar-s3");
    expect(remotes).toContain("s3-PUBLIC");
    expect(await selectAnnexS3Remote(repo, remotes)).toBe("nemar-s3");
  });

  test("selectAnnexS3Remote falls back to first match when nemar-s3 is absent", async () => {
    const repo = await newAnnexRepo("select-fallback");
    await runCmd(["git", "remote", "add", "custom-s3", "https://example/custom"], repo);
    await runCmd(["git", "config", "remote.custom-s3.annex-s3", "true"], repo);
    await runCmd(["git", "config", "remote.custom-s3.annex-uuid", crypto.randomUUID()], repo);

    expect(await selectAnnexS3Remote(repo, ["custom-s3"])).toBe("custom-s3");
  });

  test("selectAnnexS3Remote returns null on empty input", async () => {
    const repo = await newAnnexRepo("select-empty");
    expect(await selectAnnexS3Remote(repo, [])).toBeNull();
  });

  test("surfaces the real stderr when initremote fails for unrelated reasons", async () => {
    const repo = await newAnnexRepo("e2e-bad-params");
    // Missing required `directory=` param -> initremote refuses and prints
    // a useful error. Must not be matched by the duplicate-remote regex.
    const result = await initOrEnableSpecialRemote(
      repo,
      "bad-remote",
      ["type=directory", "encryption=none"],
      {},
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/There is already a special remote/);
  });
});
