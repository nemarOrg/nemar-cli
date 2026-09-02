/**
 * S3 loadSummary Tests
 *
 * Integration tests for the loadSummary helper added in Stream C of
 * epic #559 (PR-1, issue #558). Mirrors the conditional pattern from
 * `test/s3-deletion.test.ts`: skipped when AWS_* env vars are absent,
 * runs against the real `nemar` bucket (sandbox prefix `xx000001`) when
 * credentials are present. Per the repo's "no mocks" policy this is the
 * only honest way to exercise the helper.
 *
 * Required env vars:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_BUCKET
 *
 * What this file pins down:
 *  - `loadSummary(opts, id, "1.0.0")` returns the JSON bytes verbatim
 *    when `<id>/version/v1.0.0-summary.json` exists.
 *  - The `v` prefix is normalized: `loadSummary(opts, id, "v1.0.0")`
 *    returns the same bytes (no double-`v` and no miss).
 *  - Absent keys return `null` (404 -> null contract is preserved).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { deleteObjects, generatePresignedPutUrls, loadSummary } from "../backend/src/services/s3";

const TEST_DATASET = "xx000001";
const TEST_VERSION = "1.0.0";
const SUMMARY_KEY = `${TEST_DATASET}/version/v${TEST_VERSION}-summary.json`;

// Fixture payload kept tiny: the contract is "serve bytes verbatim", so
// any well-formed JSON suffices. We mirror Stream A's shape just enough
// to be recognizable in failure logs.
const FIXTURE_BODY = JSON.stringify({
  dataset_id: TEST_DATASET,
  version: TEST_VERSION,
  totals: { files: 0, bytes: 0 },
  _test: "s3-summary.test.ts fixture",
});

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

async function uploadFixture(key: string, content: string): Promise<void> {
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
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Upload failed: HTTP ${response.status}`);
  }
}

function requireS3Options() {
  const opts = getS3Options();
  if (!opts) throw new Error("S3 credentials not available");
  return opts;
}

const s3 = getS3Options();
const describeS3 = s3 ? describe : describe.skip;

describeS3("S3 loadSummary - real bucket", () => {
  beforeAll(async () => {
    await uploadFixture(SUMMARY_KEY, FIXTURE_BODY);
  });

  test("returns JSON body verbatim for an existing summary key", async () => {
    const opts = requireS3Options();
    const raw = await loadSummary(opts, TEST_DATASET, TEST_VERSION);
    expect(raw).not.toBeNull();
    expect(raw).toBe(FIXTURE_BODY);
    // Round-trip parse to confirm the bytes are valid JSON, not e.g. an
    // S3 error document we accidentally accepted.
    const parsed = JSON.parse(raw as string) as { dataset_id: string; version: string };
    expect(parsed.dataset_id).toBe(TEST_DATASET);
    expect(parsed.version).toBe(TEST_VERSION);
  });

  test("normalizes v-prefix on the version argument", async () => {
    const opts = requireS3Options();
    // Caller passes `v1.0.0`; loadSummary should not double-prefix the
    // key to `vv1.0.0-summary.json`. Both `1.0.0` and `v1.0.0` must
    // resolve to the same S3 key.
    const raw = await loadSummary(opts, TEST_DATASET, `v${TEST_VERSION}`);
    expect(raw).toBe(FIXTURE_BODY);
  });

  test("returns null for an absent version (404 contract)", async () => {
    const opts = requireS3Options();
    const raw = await loadSummary(opts, TEST_DATASET, "v9.9.9");
    expect(raw).toBeNull();
  });
});

afterAll(async () => {
  const opts = getS3Options();
  if (!opts) return;
  try {
    await deleteObjects(opts, [SUMMARY_KEY]);
  } catch {
    // best-effort
  }
});
