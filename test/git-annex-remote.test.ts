/**
 * Real git-annex tests for annexRemoteExists and the initremote/enableremote
 * fallback regex used by configureS3Remote.
 *
 * Validates that:
 *   - annexRemoteExists returns true only for actually-registered remotes
 *   - the fallback regex matches git-annex's wording but not S3 bucket
 *     errors that happen to contain the substring "already exists"
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import { ANNEX_REMOTE_EXISTS_RE, annexRemoteExists } from "../src/lib/git-annex";

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

async function newAnnexRepo(name: string): Promise<string> {
  const dir = join(TMP_DIR, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  await runCmd(["git", "init", "-q"], dir);
  await runCmd(["git", "config", "user.email", "test@test.com"], dir);
  await runCmd(["git", "config", "user.name", "Test"], dir);
  await runCmd(["git", "annex", "init", "-q", "src"], dir);
  return dir;
}

afterAll(() => {
  if (existsSync(TMP_DIR)) {
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
    // A directory special remote that is NOT named "nemar-s3"
    const dirRemote = join(repo, ".dir-remote");
    mkdirSync(dirRemote, { recursive: true });
    const init = await runCmd(
      ["git", "annex", "initremote", "local-dir", "type=directory", `directory=${dirRemote}`, "encryption=none"],
      repo,
    );
    expect(init.exitCode).toBe(0);
    expect(await annexRemoteExists(repo, "nemar-s3")).toBe(false);
    // Sanity: it does see the one we just registered
    expect(await annexRemoteExists(repo, "local-dir")).toBe(true);
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
      'initremote nemar-s3 \n' +
      'git-annex: There is already a special remote named "nemar-s3". (Use enableremote to enable an existing special remote.)\n' +
      'failed\ninitremote: 1 failed\n';
    expect(ANNEX_REMOTE_EXISTS_RE.test(stderr)).toBe(true);
  });

  test("does not match S3 BucketAlreadyOwnedByYou message", () => {
    const stderr =
      'initremote nemar-s3 (checking bucket...) (creating bucket in us-east-2...) \n' +
      'git-annex: S3Error {s3StatusCode = Status {statusCode = 409, statusMessage = "Conflict"}, ' +
      's3ErrorCode = "BucketAlreadyOwnedByYou", s3ErrorMessage = "Your previous request to ' +
      'create the named bucket succeeded and you already own it."}\nfailed\n';
    expect(ANNEX_REMOTE_EXISTS_RE.test(stderr)).toBe(false);
  });

  test("does not match S3 BucketAlreadyExists message", () => {
    const stderr =
      'initremote nemar-s3 (checking bucket...) (creating bucket in us-east-2...) \n' +
      'git-annex: S3Error {s3StatusCode = Status {statusCode = 409, statusMessage = "Conflict"}, ' +
      's3ErrorCode = "BucketAlreadyExists", s3ErrorMessage = "The requested bucket name is ' +
      'not available."}\nfailed\n';
    expect(ANNEX_REMOTE_EXISTS_RE.test(stderr)).toBe(false);
  });

  test("does not match a generic 'key already exists' substring", () => {
    const stderr = 'something failed: object key already exists in bucket\n';
    expect(ANNEX_REMOTE_EXISTS_RE.test(stderr)).toBe(false);
  });
});
