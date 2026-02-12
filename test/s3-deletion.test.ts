/**
 * S3 Deletion Tests
 *
 * Integration tests for deleteObjects, deleteDatasetObjects, and
 * deleteStagingObjects. Requires AWS credentials in environment:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_BUCKET
 *
 * Uses xx000001 prefix (sandbox) so real datasets are never touched.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  deleteDatasetObjects,
  deleteObjects,
  deleteStagingObjects,
  generatePresignedPutUrls,
  listObjectKeys,
} from "../backend/src/services/s3";

const TEST_DATASET = "xx000001";

function getS3Options() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_REGION || "us-east-2";
  const bucket = process.env.S3_BUCKET || "nemar";

  if (!accessKeyId || !secretAccessKey) {
    return null;
  }

  return { bucket, region, accessKeyId, secretAccessKey };
}

/**
 * Upload a small test object to S3 using presigned PUT URL
 */
async function uploadTestObject(key: string, content: string): Promise<void> {
  const s3 = getS3Options();
  if (!s3) throw new Error("S3 credentials not available");

  const urls = await generatePresignedPutUrls(s3, {
    prefix: "",
    files: [key],
    expiresIn: 300,
  });

  const url = urls[key];
  if (!url) throw new Error(`No presigned URL for ${key}`);

  const response = await fetch(url, {
    method: "PUT",
    body: content,
    headers: { "Content-Type": "text/plain" },
  });

  if (!response.ok) {
    throw new Error(`Upload failed: HTTP ${response.status}`);
  }
}

/**
 * Get S3 options or throw (for use inside test blocks where we know
 * credentials are available because the describe block was not skipped).
 */
function requireS3Options() {
  const opts = getS3Options();
  if (!opts) throw new Error("S3 credentials not available");
  return opts;
}

// Skip all tests if S3 credentials are not available
const s3 = getS3Options();
const describeS3 = s3 ? describe : describe.skip;

describeS3("S3 deletion - deleteObjects", () => {
  const testKeys = [
    `${TEST_DATASET}/objects/test-delete-1.txt`,
    `${TEST_DATASET}/objects/test-delete-2.txt`,
  ];

  beforeAll(async () => {
    for (const key of testKeys) {
      await uploadTestObject(key, `test content for ${key}`);
    }
  });

  test("deletes multiple objects in a single call", async () => {
    const s3Opts = requireS3Options();
    const result = await deleteObjects(s3Opts, testKeys);

    expect(result.deleted).toBe(2);
    expect(result.failed).toHaveLength(0);

    // Verify objects are gone
    const remaining = await listObjectKeys(s3Opts, `${TEST_DATASET}/objects/test-delete-`);
    expect(remaining).toHaveLength(0);
  });

  test("returns zero for empty key list", async () => {
    const s3Opts = requireS3Options();
    const result = await deleteObjects(s3Opts, []);
    expect(result.deleted).toBe(0);
    expect(result.failed).toHaveLength(0);
  });

  test("handles non-existent keys gracefully", async () => {
    const s3Opts = requireS3Options();
    const result = await deleteObjects(s3Opts, [`${TEST_DATASET}/objects/does-not-exist.txt`]);
    // S3 reports non-existent keys as successfully deleted
    expect(result.deleted).toBe(1);
    expect(result.failed).toHaveLength(0);
  });
});

describeS3("S3 deletion - deleteDatasetObjects", () => {
  const testKeys = [
    `${TEST_DATASET}/objects/ds-test-1.txt`,
    `${TEST_DATASET}/version/v99.99.99.json`,
    `${TEST_DATASET}/archives/v99.99.99.zip`,
  ];

  beforeAll(async () => {
    for (const key of testKeys) {
      await uploadTestObject(key, `test content for ${key}`);
    }
  });

  test("deletes objects across all three prefixes", async () => {
    const s3Opts = requireS3Options();
    const result = await deleteDatasetObjects(s3Opts, TEST_DATASET);

    expect(result.deleted).toBeGreaterThanOrEqual(3);
    expect(result.failed).toHaveLength(0);

    // Verify all prefixes are empty
    for (const prefix of ["objects/", "version/", "archives/"]) {
      const keys = await listObjectKeys(s3Opts, `${TEST_DATASET}/${prefix}`);
      expect(keys).toHaveLength(0);
    }
  });

  test("returns zero for dataset with no objects", async () => {
    const s3Opts = requireS3Options();
    const result = await deleteDatasetObjects(s3Opts, TEST_DATASET);
    expect(result.deleted).toBe(0);
    expect(result.failed).toHaveLength(0);
  });

  test("throws for invalid dataset ID", async () => {
    const s3Opts = requireS3Options();
    await expect(deleteDatasetObjects(s3Opts, "bad-id")).rejects.toThrow(
      'Invalid dataset ID for deletion: "bad-id"',
    );
    await expect(deleteDatasetObjects(s3Opts, "../escape")).rejects.toThrow(
      "Invalid dataset ID for deletion",
    );
  });
});

describeS3("S3 deletion - deleteStagingObjects", () => {
  const PR_NUMBER = 99999;
  const stagingKeys = [
    `staging/pr-${PR_NUMBER}/${TEST_DATASET}/objects/staged-1.txt`,
    `staging/pr-${PR_NUMBER}/${TEST_DATASET}/objects/staged-2.txt`,
  ];

  beforeAll(async () => {
    for (const key of stagingKeys) {
      await uploadTestObject(key, `staged content for ${key}`);
    }
  });

  test("deletes all staging objects for a PR", async () => {
    const s3Opts = requireS3Options();
    const result = await deleteStagingObjects(s3Opts, PR_NUMBER, TEST_DATASET);

    expect(result.deleted).toBe(2);
    expect(result.failed).toHaveLength(0);

    // Verify staging is clean
    const remaining = await listObjectKeys(s3Opts, `staging/pr-${PR_NUMBER}/${TEST_DATASET}/`);
    expect(remaining).toHaveLength(0);
  });

  test("returns zero for empty staging area", async () => {
    const s3Opts = requireS3Options();
    const result = await deleteStagingObjects(s3Opts, 88888, TEST_DATASET);
    expect(result.deleted).toBe(0);
    expect(result.failed).toHaveLength(0);
  });

  test("throws for invalid dataset ID", async () => {
    const s3Opts = requireS3Options();
    await expect(deleteStagingObjects(s3Opts, 1, "invalid")).rejects.toThrow(
      "Invalid dataset ID for staging cleanup",
    );
  });

  test("throws for invalid PR number", async () => {
    const s3Opts = requireS3Options();
    await expect(deleteStagingObjects(s3Opts, 0, TEST_DATASET)).rejects.toThrow(
      "Invalid PR number for staging cleanup",
    );
    await expect(deleteStagingObjects(s3Opts, -1, TEST_DATASET)).rejects.toThrow(
      "Invalid PR number for staging cleanup",
    );
    await expect(deleteStagingObjects(s3Opts, 1.5, TEST_DATASET)).rejects.toThrow(
      "Invalid PR number for staging cleanup",
    );
  });
});

// Cleanup: remove any leftover test objects
afterAll(async () => {
  const s3Opts = getS3Options();
  if (!s3Opts) return;

  // Best-effort cleanup of test dataset objects
  try {
    await deleteDatasetObjects(s3Opts, TEST_DATASET);
  } catch {
    // Ignore cleanup errors
  }

  // Best-effort cleanup of test staging objects
  try {
    await deleteStagingObjects(s3Opts, 99999, TEST_DATASET);
  } catch {
    // Ignore cleanup errors
  }
});
