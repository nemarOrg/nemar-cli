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
  multipartRanges,
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

  test("drops a version the log later retracts", () => {
    // `-` is git-annex unsetting the field value, not escaping it. ds006110
    // records five of these; reading the minus as part of the version id sent
    // S3 an `InvalidRequest` we first read as an upstream defect.
    expect(
      parseRmet(
        [
          "1700000000s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V +gone#ds008798/x.nii",
          "1800000000s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V -gone#ds008798/x.nii",
        ].join("\n"),
        REMOTES,
      ),
    ).toEqual([]);
  });

  test("keeps a version recorded again after being retracted", () => {
    const pins = parseRmet(
      [
        "1700000000s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V +v1#ds008798/x.nii",
        "1750000000s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V -v1#ds008798/x.nii",
        "1800000000s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V +v1#ds008798/x.nii",
      ].join("\n"),
      REMOTES,
    );
    expect(pins.map((pin) => pin.version)).toEqual(["v1"]);
  });

  test("replays out-of-order lines by their timestamp, not their position", () => {
    // The retraction is written first in the file and stamped later, so a
    // position-ordered read would keep a version git-annex has given up on.
    expect(
      parseRmet(
        [
          "1800000000s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V -v1#ds008798/x.nii",
          "1700000000s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V +v1#ds008798/x.nii",
        ].join("\n"),
        REMOTES,
      ),
    ).toEqual([]);
  });

  test("a retraction of one version leaves the others alone", () => {
    const pins = parseRmet(
      [
        "1700000000s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V +keep#ds008798/x.nii",
        "1750000000s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V +drop#ds008798/y.nii",
        "1800000000s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V -drop#ds008798/y.nii",
      ].join("\n"),
      REMOTES,
    );
    expect(pins.map((pin) => pin.version)).toEqual(["keep"]);
  });

  test("decodes a base64 value, which is how a path with a space is carried", () => {
    // Verbatim from ds008003, whose objects live under
    // `derivatives/reCleaned Cluster analysis/`. Requiring a literal `#` found
    // no pin here at all, and the >5 GB path needs one, so 11.5 GB read as
    // unrecoverable when both objects were sitting there readable.
    const encoded = Buffer.from(
      "xQd89mLbWzV9Bud1ZpOzWEC58IpYeVCP#ds008798/derivatives/reCleaned Cluster analysis/a.mat",
    ).toString("base64");
    expect(
      parseRmet(`1785850878s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V +!${encoded}`, REMOTES),
    ).toEqual([
      {
        bucket: "openneuro.org",
        object: "ds008798/derivatives/reCleaned Cluster analysis/a.mat",
        version: "xQd89mLbWzV9Bud1ZpOzWEC58IpYeVCP",
        remoteName: "s3-PUBLIC",
      },
    ]);
  });

  test("retracts an encoded value and leaves the other encoded one standing", () => {
    // Asserting only that a retracted pin disappears would pass on a parser
    // that cannot read an encoded value at all, since it finds nothing either
    // way. The surviving pin is what makes this test discriminate.
    const dropped = Buffer.from("v1#ds008798/a b.nii").toString("base64");
    const kept = Buffer.from("v2#ds008798/c d.nii").toString("base64");
    const pins = parseRmet(
      [
        `1700000000s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V +!${dropped}`,
        `1750000000s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V +!${kept}`,
        `1800000000s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V -!${dropped}`,
      ].join("\n"),
      REMOTES,
    );
    expect(pins).toEqual([
      {
        bucket: "openneuro.org",
        object: "ds008798/c d.nii",
        version: "v2",
        remoteName: "s3-PUBLIC",
      },
    ]);
  });

  test("leaves a value alone when the bang is not really base64", () => {
    // `!notbase64!` decodes to rubbish rather than throwing, so a round-trip
    // check is what separates an encoded value from one that merely starts
    // with the marker.
    expect(
      parseRmet("1700000000s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V +!v1#ds008798/x.nii", REMOTES),
    ).toEqual([
      {
        bucket: "openneuro.org",
        object: "ds008798/x.nii",
        version: "!v1",
        remoteName: "s3-PUBLIC",
      },
    ]);
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

  test("proves a multipart copy by matching the source's full-object CRC64", () => {
    // The >5 GB path. S3 refuses `--checksum-type FULL_OBJECT` for sha256, so a
    // multipart copy carries no SHA-256 to compare with the key. OpenNeuro's
    // large objects do carry a full-object CRC64 and so does our copy, and
    // equal CRCs mean the copy is the pinned version's bytes rather than merely
    // an object of the right length. Measured on ds008003's two 5.8 GB objects.
    expect(
      verifyCopy({
        key: "SHA256E-s5769335038--bc0b3d3cbaa1e0c333d099b7deeaedc1d78556831c139173ffe853cec132b66d.mat",
        origin: "pinned",
        size: 5769335038,
        crc64: "SAITOd2nxag=",
        sourceCrc64: "SAITOd2nxag=",
      }),
    ).toEqual({ ok: true, method: "crc64-of-source" });
  });

  test("rejects a multipart copy whose CRC64 differs from the source", () => {
    const verdict = verifyCopy({
      key: "SHA256E-s5769335038--bc0b3d3cbaa1e0c333d099b7deeaedc1d78556831c139173ffe853cec132b66d.mat",
      origin: "pinned",
      size: 5769335038,
      crc64: "8plWGkmxguM=",
      sourceCrc64: "SAITOd2nxag=",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.method).toBe("crc64-of-source");
  });

  test("a CRC64 match cannot rescue an object of the wrong length", () => {
    // Size is checked first and on its own: two objects can share a CRC64 only
    // by being the same bytes, but a source that is itself the wrong size for
    // the key must not pass because the copy faithfully reproduced it.
    const verdict = verifyCopy({
      key: SHA_KEY,
      origin: "pinned",
      size: 4096,
      crc64: "SAITOd2nxag=",
      sourceCrc64: "SAITOd2nxag=",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("4096");
  });

  test("falls back to size and pin when the source carries no CRC64", () => {
    expect(
      verifyCopy({ key: SHA_KEY, origin: "pinned", size: 65536, crc64: "abc=", sourceCrc64: null }),
    ).toEqual({ ok: true, method: "size-and-pin" });
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
  test("passes the path through unencoded, because the CLI encodes it", () => {
    // Measured, not assumed: `--copy-source` with `preprocessed%20data` returns
    // NoSuchVersion for an object the same request finds with a literal space.
    // The CLI percent-encodes the source, so encoding here sends `%2520`.
    expect(
      copySourceArgument({
        bucket: "openneuro.org",
        object: "ds004148/derivatives/preprocessed data/sub01_02_EC.set",
        version: "itcYgkLo.l3.tkAxcCB2nUHCNqmVtMT2",
      }),
    ).toBe(
      "openneuro.org/ds004148/derivatives/preprocessed data/sub01_02_EC.set" +
        "?versionId=itcYgkLo.l3.tkAxcCB2nUHCNqmVtMT2",
    );
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

describe("multipartRanges", () => {
  test("covers every byte exactly once, with no gap and no overlap", () => {
    // The property that matters. S3 stitches the parts in order and accepts
    // whatever it is handed, so a gap or an overlap yields an object of
    // plausible length holding the wrong bytes, and a multipart object has no
    // SHA-256 to catch it with.
    const size = 5_769_335_038;
    const ranges = multipartRanges(size, 1024 ** 3);
    expect(ranges[0].offset).toBe(0);
    expect(ranges[ranges.length - 1].end).toBe(size - 1);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].offset).toBe(ranges[i - 1].end + 1);
    }
    const covered = ranges.reduce((sum, r) => sum + (r.end - r.offset + 1), 0);
    expect(covered).toBe(size);
  });

  test("numbers parts from one, because S3 rejects a part zero", () => {
    expect(multipartRanges(10, 4).map((r) => r.part)).toEqual([1, 2, 3]);
  });

  test("gives a last part shorter than the rest rather than reading past the end", () => {
    expect(multipartRanges(10, 4)).toEqual([
      { part: 1, offset: 0, end: 3 },
      { part: 2, offset: 4, end: 7 },
      { part: 3, offset: 8, end: 9 },
    ]);
  });

  test("an exact multiple of the part size makes no trailing empty part", () => {
    const ranges = multipartRanges(8, 4);
    expect(ranges).toHaveLength(2);
    expect(ranges[1].end).toBe(7);
  });
});
