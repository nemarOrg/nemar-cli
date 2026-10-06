/**
 * Runs the REAL `scripts/rename-archives.ts` as a subprocess against a
 * `RenameS3Standin`, with the REAL `aws` CLI, isolated from the developer's
 * own AWS setup. Shared by the rename-archives entry-point test files.
 *
 * Isolation: dummy credentials (an `ASIA*` access key id, so
 * `scripts/lib/aws-creds-guard.sh`'s env-var check warns rather than
 * refuses: `AKIA*` is refused outright and anything else is refused as an
 * unrecognized prefix), `AWS_CONFIG_FILE`/`AWS_SHARED_CREDENTIALS_FILE`
 * pointed at temp files so the CLI never reads `~/.aws/*`,
 * `AWS_EC2_METADATA_DISABLED=true`, `AWS_PROFILE` left unset, and `HOME`
 * pointed at the same temp directory. Bun's `spawn` `env` option REPLACES
 * the environment rather than merging it (confirmed empirically), so
 * nothing of the real environment reaches the subprocess unless listed here.
 *
 * Deliberately NOT set: `AWS_DEFAULT_REGION`. The script must hand the region
 * to every `aws` call itself (`--region`), so a missing default region is what
 * proves it does. `AWS_MAX_ATTEMPTS=1` keeps an injected 5xx from being
 * retried for seconds.
 *
 * The child is spawned ASYNC, never with spawnSync: the stand-in is a
 * Bun.serve instance on THIS process's event loop, spawnSync blocks that loop
 * until the child exits, and the child (the real `aws` CLI) needs the loop
 * running to get an HTTP answer back. A synchronous spawn deadlocks every
 * scenario until bun:test's timeout kills it (measured: every test hung at
 * exactly 5000ms).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "bun";
import type { RenameS3Standin } from "./s3-rename-standin";

const SCRIPT_PATH = path.join(import.meta.dir, "..", "..", "scripts", "rename-archives.ts");
const REPO_ROOT = path.join(import.meta.dir, "..", "..");

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Contents of the AWS config file the CLI is pointed at (default: empty). */
  awsConfig?: string;
}

export async function runRenameScript(
  standin: RenameS3Standin,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const tmp = mkdtempSync(path.join(tmpdir(), "rename-archives-aws-"));
  const configFile = path.join(tmp, "config");
  const credsFile = path.join(tmp, "credentials");
  writeFileSync(configFile, opts.awsConfig ?? "");
  writeFileSync(credsFile, "");

  try {
    const proc = spawn({
      cmd: ["bun", SCRIPT_PATH, ...args],
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: tmp,
        AWS_ACCESS_KEY_ID: "ASIATESTDUMMY000001",
        AWS_SECRET_ACCESS_KEY: "dummySecretAccessKeyForRenameArchivesTest",
        AWS_CONFIG_FILE: configFile,
        AWS_SHARED_CREDENTIALS_FILE: credsFile,
        AWS_EC2_METADATA_DISABLED: "true",
        AWS_MAX_ATTEMPTS: "1",
        AWS_ENDPOINT_URL_S3: standin.s3Url,
        AWS_ENDPOINT_URL_STS: standin.stsUrl,
        // AWS_PROFILE and AWS_DEFAULT_REGION deliberately not set.
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    // The private HOME and config of this one run.
    rmSync(tmp, { recursive: true, force: true });
  }
}
