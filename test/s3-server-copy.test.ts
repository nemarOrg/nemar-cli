/**
 * Pure unit tests for the server-side copy module (#750). No network, no AWS
 * creds — these route to the unit-pure tier (no testRequest/TEST_API_URL/runCli).
 */

import { describe, expect, test } from "bun:test";
import {
  type CopyItem,
  filterAlreadyCopied,
  keyInShard,
  parseS3Url,
  parseShardArg,
} from "../src/lib/s3-server-copy";

describe("parseS3Url", () => {
  test("s3:// URI", () => {
    expect(parseS3Url("s3://openneuro.org/ds004395/sub-1/file.edf")).toEqual({
      bucket: "openneuro.org",
      key: "ds004395/sub-1/file.edf",
    });
  });

  test("path-style, no region", () => {
    expect(parseS3Url("https://s3.amazonaws.com/openneuro.org/ds004395/x.json")).toEqual({
      bucket: "openneuro.org",
      key: "ds004395/x.json",
      region: undefined,
    });
  });

  test("path-style, regioned", () => {
    expect(parseS3Url("https://s3.us-east-1.amazonaws.com/openneuro.org/a/b.bdf")).toEqual({
      bucket: "openneuro.org",
      key: "a/b.bdf",
      region: "us-east-1",
    });
  });

  test("virtual-hosted, no region", () => {
    expect(parseS3Url("https://openneuro.org.s3.amazonaws.com/ds1/y.tsv")).toEqual({
      bucket: "openneuro.org",
      key: "ds1/y.tsv",
      region: undefined,
    });
  });

  test("virtual-hosted, regioned (dot)", () => {
    expect(parseS3Url("https://my-bucket.s3.eu-west-2.amazonaws.com/k/z.nii.gz")).toEqual({
      bucket: "my-bucket",
      key: "k/z.nii.gz",
      region: "eu-west-2",
    });
  });

  test("virtual-hosted, regioned (legacy dash)", () => {
    expect(parseS3Url("https://my-bucket.s3-us-west-1.amazonaws.com/k/z.fif")).toEqual({
      bucket: "my-bucket",
      key: "k/z.fif",
      region: "us-west-1",
    });
  });

  test("percent-encoded key is decoded; leading slash stripped", () => {
    const ref = parseS3Url("https://s3.amazonaws.com/openneuro.org/sub-01/a%20b%2Bc.edf");
    expect(ref).toEqual({ bucket: "openneuro.org", key: "sub-01/a b+c.edf", region: undefined });
  });

  test("non-S3 host returns null", () => {
    expect(parseS3Url("https://example.com/openneuro.org/x")).toBeNull();
    expect(parseS3Url("https://raw.githubusercontent.com/a/b/c.json")).toBeNull();
  });

  test("garbage / empty returns null", () => {
    expect(parseS3Url("")).toBeNull();
    expect(parseS3Url("not a url")).toBeNull();
    expect(parseS3Url("s3://bucket-only")).toBeNull();
  });
});

describe("parseShardArg", () => {
  test("valid", () => {
    expect(parseShardArg("0/8")).toEqual({ index: 0, count: 8 });
    expect(parseShardArg("7/8")).toEqual({ index: 7, count: 8 });
    expect(parseShardArg("0/1")).toEqual({ index: 0, count: 1 });
  });

  test("malformed throws", () => {
    expect(() => parseShardArg("3")).toThrow();
    expect(() => parseShardArg("x/3")).toThrow();
    expect(() => parseShardArg("1/0")).toThrow();
    expect(() => parseShardArg("8/8")).toThrow(); // index == count out of range
    expect(() => parseShardArg("-1/4")).toThrow();
  });
});

describe("keyInShard", () => {
  const keys = Array.from({ length: 50 }, (_, i) => `MD5E-s${1000 + i}--${i.toString(16)}abcdef`);

  test("deterministic across calls", () => {
    for (const k of keys) {
      expect(keyInShard(k, 0, 8)).toBe(keyInShard(k, 0, 8));
    }
  });

  test("count<=1 always true", () => {
    for (const k of keys) expect(keyInShard(k, 0, 1)).toBe(true);
  });

  test("union of shards partitions the key set exactly once", () => {
    const N = 8;
    for (const k of keys) {
      const hits = Array.from({ length: N }, (_, i) => keyInShard(k, i, N)).filter(Boolean);
      expect(hits.length).toBe(1);
    }
  });
});

describe("filterAlreadyCopied", () => {
  const mk = (key: string): CopyItem => ({
    key,
    source: { bucket: "openneuro.org", key: `ds/${key}` },
    httpUrl: null,
    destUri: `s3://nemar/on1/objects/${key}`,
  });
  const items = [mk("a"), mk("b"), mk("c")];

  test("empty existing -> everything copies", () => {
    const { toCopy, skipped } = filterAlreadyCopied(items, new Map());
    expect(toCopy.map((i) => i.key)).toEqual(["a", "b", "c"]);
    expect(skipped).toEqual([]);
  });

  test("all present, no size map -> all skipped", () => {
    const existing = new Map([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    const { toCopy, skipped } = filterAlreadyCopied(items, existing);
    expect(toCopy).toEqual([]);
    expect(skipped).toEqual(["a", "b", "c"]);
  });

  test("size mismatch re-copies just that one", () => {
    const existing = new Map([
      ["a", 10],
      ["b", 20],
      ["c", 30],
    ]);
    const expected = new Map([
      ["a", 10],
      ["b", 999], // mismatch
      ["c", 30],
    ]);
    const { toCopy, skipped } = filterAlreadyCopied(items, existing, expected);
    expect(toCopy.map((i) => i.key)).toEqual(["b"]);
    expect(skipped).toEqual(["a", "c"]);
  });

  test("partial overlap", () => {
    const existing = new Map([["b", 2]]);
    const { toCopy, skipped } = filterAlreadyCopied(items, existing);
    expect(toCopy.map((i) => i.key)).toEqual(["a", "c"]);
    expect(skipped).toEqual(["b"]);
  });

  test("present key absent from a provided expectedSizes map is still skipped", () => {
    // expectedSizes given but missing this key (e.g. added after manifest build):
    // no expected size to compare against -> presence wins, skip.
    const existing = new Map([["a", 100]]);
    const expected = new Map<string, number>(); // "a" not present
    const { toCopy, skipped } = filterAlreadyCopied([mk("a")], existing, expected);
    expect(toCopy).toEqual([]);
    expect(skipped).toEqual(["a"]);
  });
});
