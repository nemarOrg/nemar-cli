/**
 * Entry-point tests for the archive-rename sweep's copy-then-tag flow (#1491,
 * #1518). They run the REAL `scripts/rename-archives.ts` as a subprocess with
 * the REAL `aws` CLI, pointed at a local S3/STS stand-in
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
 * `s3api put-object-tagging` call that MERGES into the existing tags, then
 * read the tags back before deleting the old object by version id) by
 * running the real script against the real `aws` binary and inspecting
 * exactly what it sent. The copy, verify, delete and version-handling
 * scenarios (multipart, short copies, multi-version keys, prefix
 * collisions, ...) are in test/rename-archives-safety.test.ts.
 *
 * Isolation from the developer's AWS setup, and why the child is spawned
 * async, are documented in `test/helpers/rename-archives-run.ts`.
 *
 * Each scenario spawns the real `bun` binary, which in turn spawns the
 * real `aws` CLI (a Python-backed process) up to about a dozen times. On the
 * CI runner one scenario takes 4-6s (measured on a real run), past `bun
 * test`'s 5s default when run without `--timeout` (the required `unit-pure`
 * tier's own invocation) -- hence the explicit per-test timeout below.
 *
 * Skipped when `aws` is not on PATH.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { which } from "bun";
import { runRenameScript } from "./helpers/rename-archives-run";
import { type RenameS3Standin, startRenameS3Standin } from "./helpers/s3-rename-standin";

const BUCKET = "nemar";
const DATASET = "nm000132";
const OLD_KEY = `${DATASET}/archives/v1.0.0.zip`;
const NEW_KEY = `${DATASET}/archives/${DATASET}_v1.0.0.zip`;
const LAST_MODIFIED = "2026-03-01T00:00:00.000Z";
const LATER = "2026-04-01T00:00:00.000Z";
const APPLY = ["--apply", "--dataset", DATASET, "--bucket", BUCKET];

const awsInstalled = which("aws") !== null;

// Passed to every test() as its third argument. A describe-level
// `{ timeout }` option is NOT honored by Bun 1.4.2 (the version CI runs):
// measured, a describe({ timeout: 20000 }) test still died at 5000ms.
const TEST_TIMEOUT_MS = 60000;

const legacy = { size: 500, etag: '"abc123"', lastModified: LAST_MODIFIED };

describe.skipIf(!awsInstalled)("rename-archives.ts tagging (real aws CLI, stand-in S3)", () => {
  let standin: RenameS3Standin;

  beforeEach(() => {
    standin = startRenameS3Standin();
  });

  afterEach(() => {
    standin.stop();
  });

  const ops = (op: string) => standin.log.filter((e) => e.op === op);

  test(
    "copies the legacy archive, tags the destination, then deletes the old object by version id",
    async () => {
      const oldVersionId = standin.putObject(BUCKET, OLD_KEY, legacy);

      const run = await runRenameScript(standin, APPLY);
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
        expect(deleteEntry.versionId).toBe(oldVersionId);
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
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a PutObjectTagging failure leaves the old object undeleted and the run reports failure",
    async () => {
      standin.putObject(BUCKET, OLD_KEY, legacy);
      standin.failNextPutTagging(BUCKET, NEW_KEY);

      const run = await runRenameScript(standin, APPLY);
      expect(run.exitCode).not.toBe(0);
      // The operator is told the real cause (the failed write, with S3's own
      // error), not just that a later read-back came up empty.
      expect(run.stderr).toContain("FAILED to tag");
      expect(run.stderr).toContain("AccessDenied");

      // The copy itself succeeded (that is what made tagging reachable)...
      expect(standin.log.some((e) => e.op === "CopyObject" && e.destKey === NEW_KEY)).toBe(true);
      // ...tagging was attempted and failed...
      const failedTag = standin.log.find(
        (e) => e.op === "PutObjectTagging" && e.key === NEW_KEY && e.status === 403,
      );
      expect(failedTag).toBeDefined();
      // ...and NEITHER object was deleted.
      expect(ops("DeleteObject")).toEqual([]);
      expect(standin.has(BUCKET, OLD_KEY)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a tag write S3 acknowledges but does not keep is caught by the read-back, and nothing is deleted",
    async () => {
      // PutObjectTagging answers 200 and applies nothing. The put's own
      // status says success; only reading the tags back reveals it.
      standin.putObject(BUCKET, OLD_KEY, legacy);
      standin.ignoreNextPutTagging(BUCKET, NEW_KEY);

      const run = await runRenameScript(standin, APPLY);
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toContain("tag verification failed");

      expect(
        standin.log.some(
          (e) => e.op === "PutObjectTagging" && e.key === NEW_KEY && e.status === 200,
        ),
      ).toBe(true);
      expect(ops("DeleteObject")).toEqual([]);
      expect(standin.has(BUCKET, OLD_KEY)).toBe(true);
      expect(standin.getObject(BUCKET, NEW_KEY)?.tags["nemar-kind"]).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "if the existing tags cannot be read, nothing is written and nothing is deleted",
    async () => {
      // A blind put would REPLACE the tag set and could erase tags the
      // script never saw, so an unreadable tag set is a refusal.
      standin.putObject(BUCKET, OLD_KEY, legacy);
      standin.inject("GetObjectTagging", { code: "AccessDenied", status: 403, key: NEW_KEY });

      const run = await runRenameScript(standin, APPLY);
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toContain("refusing to tag blind");

      expect(ops("PutObjectTagging")).toEqual([]);
      expect(ops("DeleteObject")).toEqual([]);
      expect(standin.has(BUCKET, OLD_KEY)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the already-renamed path tags the (previously untagged) destination before deleting the old object",
    async () => {
      // Simulates a prior run that copied the object and died before tagging
      // it: both keys exist, matching size/ETag, destination untagged.
      standin.putObject(BUCKET, OLD_KEY, legacy);
      standin.putObject(BUCKET, NEW_KEY, legacy);
      expect(standin.getObject(BUCKET, NEW_KEY)?.tags["nemar-kind"]).toBeUndefined();

      const run = await runRenameScript(standin, APPLY);
      expect(run.exitCode).toBe(0);

      // No copy on the resumed path -- the destination was already there.
      expect(ops("CopyObject")).toEqual([]);

      const tagEntry = standin.log.find((e) => e.op === "PutObjectTagging" && e.key === NEW_KEY);
      const deleteEntry = standin.log.find((e) => e.op === "DeleteObject" && e.key === OLD_KEY);
      expect(tagEntry).toBeDefined();
      expect(deleteEntry).toBeDefined();
      if (tagEntry && deleteEntry) {
        expect(standin.log.indexOf(tagEntry)).toBeLessThan(standin.log.indexOf(deleteEntry));
      }

      expect(standin.getObject(BUCKET, NEW_KEY)?.tags["nemar-kind"]).toBe("archive");
      expect(standin.has(BUCKET, OLD_KEY)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "tagging MERGES into the destination's existing tags instead of replacing them",
    async () => {
      standin.putObject(BUCKET, OLD_KEY, legacy);
      standin.putObject(BUCKET, NEW_KEY, { ...legacy, tags: { keep: "me", owner: "a,b [c]=d" } });

      const run = await runRenameScript(standin, APPLY);
      expect(run.exitCode).toBe(0);

      expect(standin.getObject(BUCKET, NEW_KEY)?.tags).toEqual({
        keep: "me",
        owner: "a,b [c]=d",
        "nemar-kind": "archive",
      });
      expect(standin.has(BUCKET, OLD_KEY)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a destination that already carries the tag gets no tag write at all, and the old object is still deleted",
    async () => {
      standin.putObject(BUCKET, OLD_KEY, legacy);
      standin.putObject(BUCKET, NEW_KEY, {
        ...legacy,
        tags: { "nemar-kind": "archive", keep: "me" },
      });

      const run = await runRenameScript(standin, APPLY);
      expect(run.exitCode).toBe(0);

      expect(ops("PutObjectTagging")).toEqual([]);
      expect(standin.getObject(BUCKET, NEW_KEY)?.tags).toEqual({
        "nemar-kind": "archive",
        keep: "me",
      });
      expect(standin.has(BUCKET, OLD_KEY)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "--delete-stale-legacy tags the winning destination too, keeps its other tags, then deletes only the legacy object",
    async () => {
      // A destination that differs from the legacy object but is newer and
      // at least as large: the fresh build the new workflow wrote.
      const oldVersionId = standin.putObject(BUCKET, OLD_KEY, legacy);
      standin.putObject(BUCKET, NEW_KEY, {
        size: 900,
        etag: '"fresh-build"',
        lastModified: LATER,
        tags: { keep: "me" },
      });

      const run = await runRenameScript(standin, [...APPLY, "--delete-stale-legacy"]);
      expect(run.exitCode).toBe(0);

      const tagEntry = standin.log.find((e) => e.op === "PutObjectTagging" && e.key === NEW_KEY);
      const deleteEntry = standin.log.find((e) => e.op === "DeleteObject");
      expect(tagEntry).toBeDefined();
      expect(deleteEntry).toBeDefined();
      if (tagEntry && deleteEntry) {
        expect(standin.log.indexOf(tagEntry)).toBeLessThan(standin.log.indexOf(deleteEntry));
      }
      if (deleteEntry?.op === "DeleteObject") {
        expect(deleteEntry.key).toBe(OLD_KEY);
        expect(deleteEntry.versionId).toBe(oldVersionId);
      }
      expect(ops("CopyObject")).toEqual([]);
      // The winner itself is untouched apart from the merged tag.
      const dest = standin.getObject(BUCKET, NEW_KEY);
      expect(dest?.size).toBe(900);
      expect(dest?.etag).toBe('"fresh-build"');
      expect(dest?.tags).toEqual({ keep: "me", "nemar-kind": "archive" });
      expect(standin.has(BUCKET, OLD_KEY)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "--delete-stale-legacy does not delete when the winner cannot be tagged",
    async () => {
      standin.putObject(BUCKET, OLD_KEY, legacy);
      standin.putObject(BUCKET, NEW_KEY, { size: 900, etag: '"fresh-build"', lastModified: LATER });
      standin.failNextPutTagging(BUCKET, NEW_KEY);

      const run = await runRenameScript(standin, [...APPLY, "--delete-stale-legacy"]);
      expect(run.exitCode).not.toBe(0);
      expect(ops("DeleteObject")).toEqual([]);
      expect(standin.has(BUCKET, OLD_KEY)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a dry run makes no Copy, PutObjectTagging or Delete requests",
    async () => {
      standin.putObject(BUCKET, OLD_KEY, legacy);

      const run = await runRenameScript(standin, ["--dataset", DATASET, "--bucket", BUCKET]);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain("DRY RUN");

      const writeOps = standin.log.filter(
        (e) =>
          e.op === "CopyObject" ||
          e.op === "CreateMultipartUpload" ||
          e.op === "PutObjectTagging" ||
          e.op === "DeleteObject",
      );
      expect(writeOps).toEqual([]);
      expect(standin.has(BUCKET, OLD_KEY)).toBe(true);
      expect(standin.has(BUCKET, NEW_KEY)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
