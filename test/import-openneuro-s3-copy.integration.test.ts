/**
 * Integration test for server-side S3 copy (#750). Does a REAL cross-region
 * server-side copy of a small public OpenNeuro object into the xx000001 sandbox
 * prefix, verifies it via list + resume-filter, then deletes it. No mocks.
 *
 * Requires AWS credentials (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) — self-
 * skips when absent, matching s3-deletion.test.ts. Run locally or in any tier
 * that provides AWS creds.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { runCommand } from "../src/lib/git-annex/run-command";
import {
  type CopyItem,
  batchServerSideCopy,
  filterAlreadyCopied,
  listExistingObjects,
  parseS3Url,
  serverSideS3Copy,
} from "../src/lib/s3-server-copy";

const BUCKET = "nemar";
const DEST_REGION = "us-east-2";
const PREFIX = "xx000001/objects/";
const TEST_NAME = "_phase1_sscopy_test";
const DEST_KEY = `${PREFIX}${TEST_NAME}`;
const DEST_URI = `s3://${BUCKET}/${DEST_KEY}`;
const BATCH_NAME = "_phase1_batch_ok";
const BATCH_URI = `s3://${BUCKET}/${PREFIX}${BATCH_NAME}`;
// Small, public, verified 747-byte object.
const SOURCE_URL = "s3://openneuro.org/ds004395/dataset_description.json";
const SOURCE_REF = {
  bucket: "openneuro.org",
  key: "ds004395/dataset_description.json",
  region: "us-east-1",
};

const hasCreds = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
const describeS3 = hasCreds ? describe : describe.skip;

describeS3("server-side S3 copy (real)", () => {
  afterAll(async () => {
    for (const uri of [DEST_URI, BATCH_URI]) {
      await runCommand(["aws", "s3", "rm", uri, "--region", DEST_REGION], {});
    }
  });

  test("copies a public OpenNeuro object server-side and resume skips it", async () => {
    const source = parseS3Url(SOURCE_URL);
    expect(source).not.toBeNull();
    if (!source) return;
    source.region = "us-east-1";

    const copy = await serverSideS3Copy(source, DEST_URI, DEST_REGION);
    expect(copy.success).toBe(true);

    const existing = await listExistingObjects(BUCKET, PREFIX, DEST_REGION);
    expect(existing.has(TEST_NAME)).toBe(true);
    expect(existing.get(TEST_NAME)).toBeGreaterThan(0);

    const item: CopyItem = { key: TEST_NAME, source, httpUrl: null, destUri: DEST_URI };
    const { toCopy, skipped } = filterAlreadyCopied([item], existing);
    expect(toCopy).toEqual([]);
    expect(skipped).toEqual([TEST_NAME]);
  });

  test("batchServerSideCopy copies a real item and reports it", async () => {
    const item: CopyItem = {
      key: BATCH_NAME,
      source: { ...SOURCE_REF },
      httpUrl: null,
      destUri: BATCH_URI,
    };
    const result = await batchServerSideCopy([item], DEST_REGION, 2);
    expect(result.copied).toBe(1);
    expect(result.fellBack).toBe(0);
    expect(result.failed).toHaveLength(0);
  });

  test("batchServerSideCopy accumulates failed[] on a bad source with no fallback", async () => {
    const item: CopyItem = {
      key: "_phase1_batch_missing",
      source: { bucket: "openneuro.org", key: "ds004395/__no_such_file__", region: "us-east-1" },
      httpUrl: null, // no curl fallback available
      destUri: `s3://${BUCKET}/${PREFIX}_phase1_batch_missing`,
    };
    // attempts=1 to fail fast (no retries, no fallback).
    const result = await batchServerSideCopy([item], DEST_REGION, 1, undefined, 1);
    expect(result.copied).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].key).toBe("_phase1_batch_missing");
  });
});
