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
import { runCommand } from "../src/lib/git-annex";
import {
  type CopyItem,
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
// Small, public, verified 747-byte object.
const SOURCE_URL = "s3://openneuro.org/ds004395/dataset_description.json";

const hasCreds = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
const describeS3 = hasCreds ? describe : describe.skip;

describeS3("server-side S3 copy (real)", () => {
  afterAll(async () => {
    await runCommand(["aws", "s3", "rm", DEST_URI, "--region", DEST_REGION], {});
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
});
