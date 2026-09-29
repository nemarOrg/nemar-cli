/**
 * Entry-point test for the #1491/#1518 archive-rename sweep's copy-then-tag
 * bug (#1491, #1518). This runs the REAL `scripts/rename-archives.ts` as a
 * subprocess with the REAL `aws` CLI, pointed at a local S3/STS stand-in
 * (`test/helpers/s3-rename-standin.ts`) via `AWS_ENDPOINT_URL_S3` /
 * `AWS_ENDPOINT_URL_STS` -- not a mock of `aws`, and not a call into the
 * script's exported functions. `bun scripts/rename-archives.ts --apply
 * --dataset <id> --bucket <b>` is exactly the command that was run against
 * production and failed 88/88 copies with:
 *
 *   aws: [ERROR]: An error occurred (ParamValidation): Unknown options:
 *   --tagging-directive,REPLACE,--tagging,nemar-kind=archive
 *
 * `buildCopyArgs` passed those `s3api copy-object` flags to `aws s3 cp`,
 * which does not accept them (checked against aws-cli 2.36.47's `aws s3 cp
 * help`: it has only `--copy-props`/`--metadata-directive`). Because the
 * copy failed, nothing else in the script ran -- no verify, no tag, no
 * delete -- so no object in S3 was ever touched by that run. This file
 * proves the fix (copy with plain `aws s3 cp`, then tag with a separate
 * `s3api put-object-tagging` call, then verify the tag with
 * `get-object-tagging` before deleting the old object by version id) by
 * running the real script against the real `aws` binary and inspecting
 * exactly what it sent.
 *
 * Isolated from the developer's real AWS setup: dummy credentials (an
 * `ASIA*` access key id, so `scripts/lib/aws-creds-guard.sh`'s env-var
 * check warns rather than refuses), `AWS_CONFIG_FILE`/
 * `AWS_SHARED_CREDENTIALS_FILE` pointed at empty temp files so the CLI
 * never reads `~/.aws/*`, `AWS_EC2_METADATA_DISABLED=true`, `AWS_PROFILE`
 * left unset, and `HOME` pointed at the same temp directory (Bun's `spawn`
 * `env` option REPLACES the environment rather than merging it, confirmed
 * empirically while writing this file, so nothing of the real environment
 * reaches the subprocess unless listed here).
 *
 * The guard also probes `sts get-caller-identity`
 * (`scripts/lib/aws-creds-guard.sh`), so the stand-in serves STS too, via
 * `AWS_ENDPOINT_URL_STS` on a second local port.
 *
 * Skipped when `aws` is not on PATH.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, which } from "bun";
import { type RenameS3Standin, startRenameS3Standin } from "./helpers/s3-rename-standin";

const SCRIPT_PATH = path.join(import.meta.dir, "..", "scripts", "rename-archives.ts");
const REPO_ROOT = path.join(import.meta.dir, "..");
const BUCKET = "nemar";
const DATASET = "nm000132";
const OLD_KEY = `${DATASET}/archives/v1.0.0.zip`;
const NEW_KEY = `${DATASET}/archives/${DATASET}_v1.0.0.zip`;
const LAST_MODIFIED = "2026-03-01T00:00:00.000Z";

const awsInstalled = which("aws") !== null;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// spawn ASYNC, never spawnSync: the S3/STS stand-in is a Bun.serve instance
// running on this SAME process's event loop. spawnSync blocks that loop
// until the child exits, and the child (the real `aws` CLI) needs the loop
// running to get an HTTP response back from the stand-in -- a synchronous
// spawn here deadlocks every test until bun:test's timeout kills it
// (measured while writing this file: every test hung at exactly 5000ms).
async function runScript(standin: RenameS3Standin, args: string[]): Promise<RunResult> {
  const tmp = mkdtempSync(path.join(tmpdir(), "rename-archives-aws-"));
  const configFile = path.join(tmp, "config");
  const credsFile = path.join(tmp, "credentials");
  writeFileSync(configFile, "");
  writeFileSync(credsFile, "");

  const proc = spawn({
    cmd: ["bun", SCRIPT_PATH, ...args],
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: tmp,
      // ASIA* (short-lived STS shape): aws-creds-guard.sh warns but
      // proceeds on this prefix. AKIA* is refused outright, and anything
      // else is refused as an unrecognized prefix -- ASIA* is the only
      // shape a dummy key can take here.
      AWS_ACCESS_KEY_ID: "ASIATESTDUMMY000001",
      AWS_SECRET_ACCESS_KEY: "dummySecretAccessKeyForRenameArchivesTest",
      AWS_DEFAULT_REGION: "us-east-2",
      AWS_CONFIG_FILE: configFile,
      AWS_SHARED_CREDENTIALS_FILE: credsFile,
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_ENDPOINT_URL_S3: standin.s3Url,
      AWS_ENDPOINT_URL_STS: standin.stsUrl,
      // AWS_PROFILE deliberately not set.
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
}

describe.skipIf(!awsInstalled)("rename-archives.ts entry point (real aws CLI, stand-in S3)", () => {
  let standin: RenameS3Standin;

  beforeEach(() => {
    standin = startRenameS3Standin();
  });

  afterEach(() => {
    standin.stop();
  });

  test("copies the legacy archive, tags the destination, then deletes the old object by version id", async () => {
    standin.putObject(BUCKET, OLD_KEY, {
      size: 500,
      etag: '"abc123"',
      lastModified: LAST_MODIFIED,
    });
    const oldVersionId = standin.getObject(BUCKET, OLD_KEY)?.versionId;
    expect(oldVersionId).toBeTruthy();

    const run = await runScript(standin, ["--apply", "--dataset", DATASET, "--bucket", BUCKET]);
    expect(run.exitCode).toBe(0);

    // Old key gone, new key present under the #1491 shape.
    expect(standin.has(BUCKET, OLD_KEY)).toBe(false);
    expect(standin.has(BUCKET, NEW_KEY)).toBe(true);
    expect(standin.getObject(BUCKET, NEW_KEY)?.tags["nemar-kind"]).toBe("archive");

    const copyEntry = standin.log.find((e) => e.op === "CopyObject" && e.destKey === NEW_KEY);
    expect(copyEntry).toBeDefined();

    const tagEntry = standin.log.find((e) => e.op === "PutObjectTagging" && e.key === NEW_KEY);
    expect(tagEntry).toBeDefined();
    if (tagEntry?.op === "PutObjectTagging") {
      expect(tagEntry.body).toContain("nemar-kind");
      expect(tagEntry.body).toContain("archive");
    }

    const deleteEntry = standin.log.find((e) => e.op === "DeleteObject" && e.key === OLD_KEY);
    expect(deleteEntry).toBeDefined();
    if (deleteEntry?.op === "DeleteObject") {
      expect(deleteEntry.versionId).toBe(oldVersionId ?? null);
      expect(deleteEntry.status).toBe(204);
    }

    // Order matters: copy, then tag, then delete.
    if (copyEntry && tagEntry && deleteEntry) {
      const copyIdx = standin.log.indexOf(copyEntry);
      const tagIdx = standin.log.indexOf(tagEntry);
      const deleteIdx = standin.log.indexOf(deleteEntry);
      expect(copyIdx).toBeLessThan(tagIdx);
      expect(tagIdx).toBeLessThan(deleteIdx);
    }
  });

  test("a PutObjectTagging failure leaves the old object undeleted and the run reports failure", async () => {
    standin.putObject(BUCKET, OLD_KEY, {
      size: 500,
      etag: '"abc123"',
      lastModified: LAST_MODIFIED,
    });
    standin.failNextPutTagging(BUCKET, NEW_KEY);

    const run = await runScript(standin, ["--apply", "--dataset", DATASET, "--bucket", BUCKET]);
    expect(run.exitCode).not.toBe(0);

    // The copy itself succeeded (that is what made tagging reachable)...
    expect(standin.log.some((e) => e.op === "CopyObject" && e.destKey === NEW_KEY)).toBe(true);
    // ...tagging was attempted and failed...
    const failedTag = standin.log.find(
      (e) => e.op === "PutObjectTagging" && e.key === NEW_KEY && e.status === 403,
    );
    expect(failedTag).toBeDefined();
    // ...and NEITHER object was deleted.
    expect(standin.log.some((e) => e.op === "DeleteObject")).toBe(false);
    expect(standin.has(BUCKET, OLD_KEY)).toBe(true);
  });

  test("the already-renamed path tags the (previously untagged) destination before deleting the old object", async () => {
    // Simulates a prior run that copied the object and died before tagging
    // it: both keys exist, matching size/ETag, destination untagged.
    standin.putObject(BUCKET, OLD_KEY, {
      size: 500,
      etag: '"abc123"',
      lastModified: LAST_MODIFIED,
    });
    standin.putObject(BUCKET, NEW_KEY, {
      size: 500,
      etag: '"abc123"',
      lastModified: LAST_MODIFIED,
    });
    expect(standin.getObject(BUCKET, NEW_KEY)?.tags["nemar-kind"]).toBeUndefined();

    const run = await runScript(standin, ["--apply", "--dataset", DATASET, "--bucket", BUCKET]);
    expect(run.exitCode).toBe(0);

    // No copy on the resumed path -- the destination was already there.
    expect(standin.log.some((e) => e.op === "CopyObject")).toBe(false);

    const tagEntry = standin.log.find((e) => e.op === "PutObjectTagging" && e.key === NEW_KEY);
    const deleteEntry = standin.log.find((e) => e.op === "DeleteObject" && e.key === OLD_KEY);
    expect(tagEntry).toBeDefined();
    expect(deleteEntry).toBeDefined();
    if (tagEntry && deleteEntry) {
      expect(standin.log.indexOf(tagEntry)).toBeLessThan(standin.log.indexOf(deleteEntry));
    }

    expect(standin.getObject(BUCKET, NEW_KEY)?.tags["nemar-kind"]).toBe("archive");
    expect(standin.has(BUCKET, OLD_KEY)).toBe(false);
  });

  test("a dry run makes no Copy, PutObjectTagging or Delete requests", async () => {
    standin.putObject(BUCKET, OLD_KEY, {
      size: 500,
      etag: '"abc123"',
      lastModified: LAST_MODIFIED,
    });

    const run = await runScript(standin, ["--dataset", DATASET, "--bucket", BUCKET]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("DRY RUN");

    const writeOps = standin.log.filter(
      (e) => e.op === "CopyObject" || e.op === "PutObjectTagging" || e.op === "DeleteObject",
    );
    expect(writeOps).toEqual([]);
    expect(standin.has(BUCKET, OLD_KEY)).toBe(true);
    expect(standin.has(BUCKET, NEW_KEY)).toBe(false);
  });
});
