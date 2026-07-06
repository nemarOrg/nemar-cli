/**
 * git-annex S3 remote partsize (#886, epic #896).
 *
 * Without partsize the S3 special remote does a single-part PUT per object,
 * which S3 caps at 5 GB, so any data file over 5 GB fails with EntityTooLarge.
 * buildS3RemoteArgs must always emit partsize (default 1GiB) to force multipart.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_S3_PARTSIZE, buildS3RemoteArgs } from "../src/lib/git-annex/s3-remote";

const base = { name: "nemar-s3", bucket: "nemar", prefix: "nm000276/objects", region: "us-east-2" };

describe("buildS3RemoteArgs partsize", () => {
  test("always includes partsize (default 1GiB)", () => {
    const args = buildS3RemoteArgs(base);
    expect(args).toContain(`partsize=${DEFAULT_S3_PARTSIZE}`);
    expect(DEFAULT_S3_PARTSIZE).toBe("1GiB");
  });

  test("partsize is configurable per remote", () => {
    const args = buildS3RemoteArgs({ ...base, partsize: "512MiB" });
    expect(args).toContain("partsize=512MiB");
    expect(args).not.toContain("partsize=1GiB");
  });

  test("still emits the core S3 params (regression guard)", () => {
    const args = buildS3RemoteArgs(base);
    expect(args).toContain("type=S3");
    expect(args).toContain("signature=v4");
    expect(args).toContain("bucket=nemar");
    expect(args).toContain("fileprefix=nm000276/objects/");
  });

  test("publicurl still conditional and coexists with partsize", () => {
    const withUrl = buildS3RemoteArgs({ ...base, publicUrl: "https://data.nemar.org" });
    expect(withUrl).toContain("publicurl=https://data.nemar.org");
    expect(withUrl).toContain(`partsize=${DEFAULT_S3_PARTSIZE}`);
    expect(buildS3RemoteArgs(base).some((a) => a.startsWith("publicurl="))).toBe(false);
  });
});
