/**
 * Which bytes are allowed to become a dataset's content again (#1396).
 *
 * Recovery copies from an archive we do not control into an archive that will
 * then advertise the result as the dataset. Every rule about what may be copied,
 * and what counts as proof that the right thing arrived, is in these functions,
 * so they are tested on their own: the S3 calls around them are shell-outs, and
 * a rule that is only exercised through a copy is a rule nobody can read.
 */

import { describe, expect, test } from "bun:test";
import {
  copySourceArgument,
  indexUpstreamVersions,
  parseAnnexKey,
  parseRemoteLog,
  parseRmet,
  planKeyRecovery,
  verifyCopy,
} from "../src/lib/content-recovery";

/** SHA-256 of 64 zero hex digits is not meaningful; these are real key shapes. */
const SHA_KEY =
  "SHA256E-s65536--de2f256064a0af797747c2b97505dc0b9f3df0de4f489eac731c23ae9ca9cc31COR-001";
const SHA_B64 = Buffer.from(
  "de2f256064a0af797747c2b97505dc0b9f3df0de4f489eac731c23ae9ca9cc31",
  "hex",
).toString("base64");
const MD5_KEY = "MD5E-s10203248--31e00c4f48dc4e333db21b13e967f094.set";

const REMOTES = parseRemoteLog(
  [
    "9e1479f6-49e0-413b-8222-a7f8000f55a6 autoenable=true bucket=openneuro.org exporttree=yes fileprefix=ds008798/ name=s3-PUBLIC type=S3 versioning=yes",
    "ca4da2fe-2a4c-49b1-abd6-00fc9ec1ff30 bucket=nemar fileprefix=on008798/objects/ name=nemar-s3 type=S3",
    "d23d62dc-2acd-4407-ac4a-cbba92096832 externaltype=openneuro name=openneuro type=external",
  ].join("\n"),
);

describe("parseAnnexKey", () => {
  test("keeps the whole hash when the extension has no dot", () => {
    // The trap this exists for: `...cc31COR-001` is hash + a file called
    // COR-001. Splitting on "." takes seven hash characters with it, and every
    // checksum comparison then fails on content that is perfectly correct.
    const facts = parseAnnexKey(SHA_KEY);
    expect(facts?.backend).toBe("SHA256E");
    expect(facts?.size).toBe(65536);
    expect(facts?.hashHex).toBe("de2f256064a0af797747c2b97505dc0b9f3df0de4f489eac731c23ae9ca9cc31");
  });

  test("reads an MD5E key, which is half the width", () => {
    expect(parseAnnexKey(MD5_KEY)).toEqual({
      backend: "MD5E",
      size: 10203248,
      hashHex: "31e00c4f48dc4e333db21b13e967f094",
    });
  });

  test("carries no hash for a backend whose width is not known", () => {
    const facts = parseAnnexKey("URL-s1234--http://example.org/a.dat");
    expect(facts?.size).toBe(1234);
    expect(facts?.hashHex).toBeNull();
  });

  test("returns null for something that is not a key", () => {
    expect(parseAnnexKey("not-a-valid-key")).toBeNull();
  });
});

describe("parseRmet", () => {
  test("reads the version and object, and drops git-annex's escape marker", () => {
    const pins = parseRmet(
      "1789149471s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V +8AgZnitHfnyHwMejjjzCrkiAfesgba9u#ds008798/sub-P08/x.nii",
      REMOTES,
    );
    expect(pins).toEqual([
      {
        bucket: "openneuro.org",
        object: "ds008798/sub-P08/x.nii",
        version: "8AgZnitHfnyHwMejjjzCrkiAfesgba9u",
        remoteName: "s3-PUBLIC",
      },
    ]);
  });

  test("ignores a remote the branch does not describe as a bucket", () => {
    // The `openneuro` external remote has no bucket, so there is nowhere to copy
    // from even though it is the remote that claims to hold the content.
    expect(
      parseRmet("1789149471s d23d62dc-2acd-4407-ac4a-cbba92096832:V +abc#ds/x", REMOTES),
    ).toEqual([]);
  });

  test("keeps every line, newest last, so the caller can take the current one", () => {
    const pins = parseRmet(
      [
        "1700000000s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V +old#ds008798/x.nii",
        "1800000000s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V +new#ds008798/x.nii",
      ].join("\n"),
      REMOTES,
    );
    expect(pins.map((pin) => pin.version)).toEqual(["old", "new"]);
  });
});

describe("planKeyRecovery", () => {
  const upstreamIndex = (rows: Array<[string, string, number, string]>) =>
    indexUpstreamVersions(JSON.stringify(rows));

  test("prefers the source git-annex pinned, and takes the newest pin", () => {
    const entry = planKeyRecovery({
      key: SHA_KEY,
      paths: ["a/b.dat"],
      pins: parseRmet(
        [
          "1700000000s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V +old#ds008798/a/b.dat",
          "1800000000s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V +new#ds008798/a/b.dat",
        ].join("\n"),
        REMOTES,
      ),
      upstream: {
        bucket: "openneuro.org",
        prefix: "ds008798/",
        index: upstreamIndex([["ds008798/a/b.dat", "another", 65536, '"etag"']]),
      },
    });
    expect(entry.source).toMatchObject({ origin: "pinned", version: "new" });
  });

  test("takes an unpinned upstream object when exactly one has the key's size", () => {
    const entry = planKeyRecovery({
      key: SHA_KEY,
      paths: ["a/b.dat"],
      pins: [],
      upstream: {
        bucket: "openneuro.org",
        prefix: "ds008798/",
        index: upstreamIndex([
          ["ds008798/a/b.dat", "v1", 65536, '"aaa"'],
          ["ds008798/a/b.dat", "v0", 999, '"bbb"'],
        ]),
      },
    });
    expect(entry.source).toMatchObject({
      origin: "version-match",
      object: "ds008798/a/b.dat",
      version: "v1",
    });
  });

  test("treats repeated versions of identical bytes as one candidate", () => {
    // A path rewritten with the same content lists as several versions sharing
    // one ETag. Counting versions rather than distinct objects would refuse a
    // recovery that has no ambiguity at all -- 61 of on005127's keys are this.
    const entry = planKeyRecovery({
      key: SHA_KEY,
      paths: ["a/b.dat"],
      pins: [],
      upstream: {
        bucket: "openneuro.org",
        prefix: "ds008798/",
        index: upstreamIndex([
          ["ds008798/a/b.dat", "v2", 65536, '"same"'],
          ["ds008798/a/b.dat", "v1", 65536, '"same"'],
        ]),
      },
    });
    expect(entry.source).toMatchObject({ origin: "version-match" });
  });

  test("refuses when two different objects both carry the key's size", () => {
    const entry = planKeyRecovery({
      key: SHA_KEY,
      paths: ["a/b.dat"],
      pins: [],
      upstream: {
        bucket: "openneuro.org",
        prefix: "ds008798/",
        index: upstreamIndex([
          ["ds008798/a/b.dat", "v2", 65536, '"one"'],
          ["ds008798/a/b.dat", "v1", 65536, '"two"'],
        ]),
      },
    });
    expect(entry.source).toBeUndefined();
    expect(entry.reason).toContain("2 distinct upstream objects");
  });

  test("says so when upstream has nothing of that size at the path", () => {
    const entry = planKeyRecovery({
      key: SHA_KEY,
      paths: ["a/b.dat"],
      pins: [],
      upstream: {
        bucket: "openneuro.org",
        prefix: "ds008798/",
        index: upstreamIndex([["ds008798/a/b.dat", "v1", 4096, '"x"']]),
      },
    });
    expect(entry.source).toBeUndefined();
    expect(entry.reason).toContain("no upstream object");
  });

  test("says so when there is no upstream at all, as for an uploaded dataset", () => {
    // nm000232 is an upload, not an import: there is no OpenNeuro copy to look
    // in, and reporting that plainly is the whole answer for those keys.
    const entry = planKeyRecovery({ key: SHA_KEY, paths: ["a/b.dat"], pins: [] });
    expect(entry.source).toBeUndefined();
    expect(entry.reason).toBe("no upstream remote to recover from");
  });
});

describe("verifyCopy", () => {
  test("accepts a copy S3 hashed to the key's own hash", () => {
    expect(
      verifyCopy({ key: SHA_KEY, origin: "version-match", checksumSha256: SHA_B64, size: 65536 }),
    ).toEqual({ ok: true, method: "checksum" });
  });

  test("rejects a copy S3 hashed to anything else, however good the source looked", () => {
    const verdict = verifyCopy({
      key: SHA_KEY,
      origin: "pinned",
      checksumSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      size: 65536,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("the key says");
  });

  test("verifies an MD5E key by ETag, which is the MD5 for a single-part object", () => {
    expect(
      verifyCopy({
        key: MD5_KEY,
        origin: "version-match",
        etag: '"31e00c4f48dc4e333db21b13e967f094"',
        size: 10203248,
      }),
    ).toEqual({ ok: true, method: "etag" });
  });

  test("does not read a multipart ETag as an MD5", () => {
    // `<md5>-<parts>` is a hash of hashes. Comparing it to the key would fail a
    // correct copy; treating it as a match would pass a wrong one.
    const verdict = verifyCopy({
      key: MD5_KEY,
      origin: "version-match",
      etag: '"31e00c4f48dc4e333db21b13e967f094-4"',
      size: 10203248,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.method).toBe("size-and-pin");
  });

  test("rejects an object of the wrong size before anything else", () => {
    const verdict = verifyCopy({ key: SHA_KEY, origin: "pinned", size: 4096 });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("4096");
  });

  test("accepts size alone only when git-annex pinned the source", () => {
    expect(verifyCopy({ key: SHA_KEY, origin: "pinned", size: 65536 })).toEqual({
      ok: true,
      method: "size-and-pin",
    });
    expect(verifyCopy({ key: SHA_KEY, origin: "version-match", size: 65536 }).ok).toBe(false);
  });
});

describe("copySourceArgument", () => {
  test("encodes a path S3 would otherwise read as a query or a fragment", () => {
    // Real paths in these datasets: "fine-grained pattern/._0.jpg", and one that
    // ends in "#". Unencoded, the "#" truncates the source key silently.
    expect(
      copySourceArgument({
        bucket: "openneuro.org",
        object: "ds004212/sourcedata/fine-grained pattern/a#b.jpg",
        version: "v+1",
      }),
    ).toBe("openneuro.org/ds004212/sourcedata/fine-grained%20pattern/a%23b.jpg?versionId=v%2B1");
  });

  test("omits the version when there is none", () => {
    expect(copySourceArgument({ bucket: "b", object: "k/x.dat" })).toBe("b/k/x.dat");
  });
});

describe("indexUpstreamVersions", () => {
  test("groups by object and strips the quotes S3 puts around an ETag", () => {
    const index = indexUpstreamVersions(
      JSON.stringify([
        ["ds/x", "v1", 10, '"abc"'],
        ["ds/x", "v2", 20, '"def"'],
        ["ds/y", "v1", 30, '"ghi"'],
      ]),
    );
    expect(index.get("ds/x")?.map((v) => v.etag)).toEqual(["abc", "def"]);
    expect(index.get("ds/y")).toHaveLength(1);
  });

  test("an empty listing is empty, not a crash", () => {
    expect(indexUpstreamVersions("").size).toBe(0);
    expect(indexUpstreamVersions("null").size).toBe(0);
  });
});
