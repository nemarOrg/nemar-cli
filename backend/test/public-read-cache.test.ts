/**
 * `isDatasetExcludedFromPublicRead` (#1522): the per-isolate, short-TTL read
 * of the bucket policy's `PublicReadExceptPrivate` carve-out that
 * `manifest.json` uses to decide unsigned vs. presigned URLs.
 *
 * Real engine: a local HTTP server stands in for the bucket
 * (`helpers/s3-manifest-standin.ts`, extended for #1522 to answer
 * `GET /?policy`), and `getBucketPolicy` reads it through the same
 * `endpointUrl` override every other S3 read in this suite uses. No mocked
 * business logic anywhere: the module under test calls the real
 * `getBucketPolicy` against a real server.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { addPrivateDataset, buildPublicAccessPolicy } from "../src/services/bucket-policy";
import {
  PUBLIC_READ_DECISION_TTL_MS,
  __resetPublicReadCacheForTests,
  __seedPublicReadCacheForTests,
  isDatasetExcludedFromPublicRead,
} from "../src/services/public-read-cache";
import { type S3ManifestStandin, startS3ManifestStandin } from "./helpers/s3-manifest-standin";

const BUCKET = "nemar";

let s3: S3ManifestStandin;

beforeAll(() => {
  s3 = startS3ManifestStandin();
});

afterAll(() => {
  s3.stop();
});

beforeEach(() => {
  s3.setBucketPolicy(null);
  s3.log.length = 0;
  __resetPublicReadCacheForTests();
});

function s3Options() {
  return {
    bucket: BUCKET,
    region: "us-east-2",
    accessKeyId: "AKIATEST",
    secretAccessKey: "secret",
    endpointUrl: s3.url,
  };
}

describe("isDatasetExcludedFromPublicRead", () => {
  test("no policy at all: nothing is excluded", async () => {
    expect(await isDatasetExcludedFromPublicRead(s3Options(), "nm000111")).toBe(false);
  });

  test("a dataset in NotResource is excluded; one not in it is not", async () => {
    s3.setBucketPolicy(addPrivateDataset(buildPublicAccessPolicy(BUCKET, []), BUCKET, "nm000111"));
    expect(await isDatasetExcludedFromPublicRead(s3Options(), "nm000111")).toBe(true);
    expect(await isDatasetExcludedFromPublicRead(s3Options(), "nm000112")).toBe(false);
  });

  test("the policy is read once for several datasets within the TTL", async () => {
    s3.setBucketPolicy(buildPublicAccessPolicy(BUCKET, []));
    await isDatasetExcludedFromPublicRead(s3Options(), "nm000111");
    await isDatasetExcludedFromPublicRead(s3Options(), "nm000112");
    await isDatasetExcludedFromPublicRead(s3Options(), "nm000113");
    const policyReads = s3.log.filter((r) => r.path === "/" && r.method === "GET");
    expect(policyReads).toHaveLength(1);
  });

  test("a flip is invisible before the TTL and visible once it is seeded past", async () => {
    s3.setBucketPolicy(buildPublicAccessPolicy(BUCKET, [])); // nothing excluded
    expect(await isDatasetExcludedFromPublicRead(s3Options(), "nm000111")).toBe(false);

    // The bucket policy just flipped, but the cached decision has not
    // expired: still answers the stale (fast) reading.
    s3.setBucketPolicy(addPrivateDataset(buildPublicAccessPolicy(BUCKET, []), BUCKET, "nm000111"));
    expect(await isDatasetExcludedFromPublicRead(s3Options(), "nm000111")).toBe(false);

    // Seed the cache as already expired (equivalent to the TTL having
    // passed) without a real sleep: the next call re-reads and sees the flip.
    __seedPublicReadCacheForTests(s3Options(), [], Date.now() - 1);
    expect(await isDatasetExcludedFromPublicRead(s3Options(), "nm000111")).toBe(true);
  });

  test("a read failure answers excluded (the safe direction) and does not poison the cache", async () => {
    // No endpointUrl override reaches a real host and fails fast enough for
    // a unit test: point at a closed local port instead, a real connection
    // refusal rather than a simulated one.
    const closed = { ...s3Options(), endpointUrl: "http://127.0.0.1:1" };
    expect(await isDatasetExcludedFromPublicRead(closed, "nm000111")).toBe(true);
    // The failure was not cached: the very next call against a healthy
    // endpoint reads the real (empty) policy rather than reusing a stale
    // "excluded" verdict.
    s3.setBucketPolicy(buildPublicAccessPolicy(BUCKET, []));
    expect(await isDatasetExcludedFromPublicRead(s3Options(), "nm000111")).toBe(false);
  });

  test("the TTL is 60 seconds", () => {
    expect(PUBLIC_READ_DECISION_TTL_MS).toBe(60_000);
  });
});
