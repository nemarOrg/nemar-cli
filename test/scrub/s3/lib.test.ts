/**
 * The pure rules the S3 stages share: how a new object is laid out, which byte windows verify
 * compares, what counts as a long enough lock, and how an `aws` failure is classified. These are
 * the supplement; the stages themselves are tested through the real CLI in the sibling files.
 */

import { describe, expect, test } from "bun:test";
import {
  AwsCliError,
  GIB,
  MAX_PARTS,
  MIB,
  StageError,
  classifyAwsError,
  failureWord,
  planAssembly,
  retainUntilFrom,
  retentionOk,
  sampleRanges,
} from "../../../scripts/scrub/s3/s3-lib";
import { checkPrunePrefix, isEdfOrBdf, keysOfManifest } from "../../../scripts/scrub/s3/s3-stages";

describe("planAssembly", () => {
  const sizes = [
    256,
    5 * MIB,
    5 * MIB + 1,
    13 * MIB - 1,
    13 * MIB,
    13 * MIB + 1,
    20 * MIB + 123,
    600 * GIB,
  ];

  test("every layout tiles the object exactly, with legal part sizes", () => {
    for (const size of sizes) {
      for (const max of [5 * MIB, 6 * MIB, 4 * GIB]) {
        // Too many parts is refused (below), not laid out.
        if (size / max > MAX_PARTS - 10) continue;
        const l = planAssembly(size, max);
        expect(l.uploadedBytes + l.copiedBytes, `${size}/${max}`).toBe(size);
        if (l.mode === "put") {
          expect(size).toBeLessThanOrEqual(5 * MIB);
          expect(l.parts).toEqual([]);
          continue;
        }
        expect(size).toBeGreaterThan(5 * MIB);
        let next = 0;
        l.parts.forEach((p, i) => {
          expect(p.number).toBe(i + 1);
          expect(p.start).toBe(next);
          expect(p.end).toBeGreaterThanOrEqual(p.start);
          next = p.end + 1;
          expect(p.kind).toBe(i === 0 ? "upload" : "copy");
          const len = p.end - p.start + 1;
          // S3 refuses a non-final part under 5 MiB at completion.
          if (i < l.parts.length - 1)
            expect(len, `${size}/${max}/${i}`).toBeGreaterThanOrEqual(5 * MIB);
          if (i > 0) expect(len).toBeLessThanOrEqual(max);
        });
        expect(next).toBe(size);
        expect(l.parts.length).toBeLessThanOrEqual(MAX_PARTS);
      }
    }
  });

  test("the first part is 8 MiB, or the whole object when the rest would be a runt", () => {
    expect(planAssembly(20 * MIB).parts[0]).toEqual({
      number: 1,
      kind: "upload",
      start: 0,
      end: 8 * MIB - 1,
    });
    expect(planAssembly(13 * MIB - 1).parts).toEqual([
      { number: 1, kind: "upload", start: 0, end: 13 * MIB - 2 },
    ]);
    expect(planAssembly(13 * MIB).parts.length).toBe(2);
  });

  test("refuses what it cannot lay out", () => {
    expect(() => planAssembly(255)).toThrow(StageError);
    expect(() => planAssembly(20 * MIB, 5 * MIB - 1)).toThrow(StageError);
    expect(() => planAssembly(20 * MIB, 4 * GIB + 1)).toThrow(StageError);
    // More than 10,000 parts of the smallest size.
    expect(() => planAssembly(60 * GIB, 5 * MIB)).toThrow(StageError);
  });
});

describe("sampleRanges", () => {
  test("windows start after the header, include the final bytes, and stay inside the object", () => {
    for (const size of [257, 1000, 64 * 1024 + 256, 64 * 1024 + 257, 300 * 1024, 20 * MIB + 123]) {
      const r = sampleRanges(size);
      expect(r.length, String(size)).toBeGreaterThan(0);
      for (const [a, b] of r) {
        expect(a).toBeGreaterThanOrEqual(256);
        expect(b).toBeLessThan(size);
        expect(b).toBeGreaterThanOrEqual(a);
        expect(b - a + 1).toBeLessThanOrEqual(65536);
      }
      expect(r[r.length - 1]?.[1]).toBe(size - 1);
      expect(r[0]?.[0]).toBe(256);
    }
    expect(sampleRanges(256)).toEqual([]);
  });

  test("a large object gets N evenly spaced windows plus the final one", () => {
    const r = sampleRanges(20 * MIB + 123);
    expect(r.length).toBe(9);
    const starts = r.map(([a]) => a);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    // No two windows overlap, so each compares different bytes.
    for (let i = 1; i < r.length; i++) {
      expect((r[i] as [number, number])[0]).toBeGreaterThan((r[i - 1] as [number, number])[1]);
    }
    expect(sampleRanges(20 * MIB + 123, 3).length).toBe(4);
  });
});

describe("retention", () => {
  const now = new Date("2026-10-04T12:00:00Z");

  test("GOVERNANCE for at least 99 years passes; anything weaker fails", () => {
    expect(retentionOk("GOVERNANCE", retainUntilFrom(now, 100), now)).toBe(true);
    expect(retentionOk("GOVERNANCE", retainUntilFrom(now, 99), now)).toBe(true);
    expect(retentionOk("GOVERNANCE", retainUntilFrom(now, 98), now)).toBe(false);
    expect(retentionOk("COMPLIANCE", retainUntilFrom(now, 100), now)).toBe(false);
    expect(retentionOk(undefined, retainUntilFrom(now, 100), now)).toBe(false);
    expect(retentionOk("GOVERNANCE", undefined, now)).toBe(false);
    expect(retentionOk("GOVERNANCE", "not a date", now)).toBe(false);
  });

  test("the retain-until date has the second-resolution form the CLI takes", () => {
    expect(retainUntilFrom(now, 100)).toBe("2126-10-04T12:00:00Z");
  });
});

describe("classifying an aws failure", () => {
  test("the CLI's own error line decides, and a 404 inside a URL does not", () => {
    const head = "An error occurred (404) when calling the HeadObject operation: Not Found";
    expect(classifyAwsError(head, "HeadObject").code).toBe("not-found");
    expect(classifyAwsError(head, "HeadObject").op).toBe("HeadObject");
    const url = 'Could not connect to the endpoint URL: "http://h/nm000404/objects/k"';
    expect(classifyAwsError(url, "HeadObject").code).toBe("unreachable");
    expect(classifyAwsError("something about 404 happened", "HeadObject").code).toBe("failed");
  });

  test("a 403 is access-denied, never absence", () => {
    expect(
      classifyAwsError(
        "An error occurred (403) when calling the HeadObject operation: Forbidden",
        "x",
      ).code,
    ).toBe("access-denied");
    expect(
      classifyAwsError(
        "An error occurred (AccessDenied) when calling the DeleteObject operation: Access Denied",
        "x",
      ).code,
    ).toBe("access-denied");
  });

  test("precondition, range, credentials and throttling have their own classes", () => {
    const line = (code: string) =>
      `An error occurred (${code}) when calling the GetObject operation`;
    expect(classifyAwsError(line("PreconditionFailed"), "x").code).toBe("precondition-failed");
    expect(classifyAwsError(line("InvalidRange"), "x").code).toBe("invalid-range");
    expect(classifyAwsError(line("ExpiredToken"), "x").code).toBe("credentials");
    expect(classifyAwsError(line("SlowDown"), "x").code).toBe("throttled");
    expect(classifyAwsError(line("NoSuchObjectLockConfiguration"), "x").code).toBe("not-found");
  });

  test("a failure word never carries a message", () => {
    expect(failureWord(new AwsCliError("timeout", "GetObject"))).toBe("GetObject:timeout");
    expect(failureWord(new StageError("new-key-conflict"))).toBe("new-key-conflict");
    expect(failureWord(new Error("Marigold Thistlewood"))).toBe("unexpected");
  });
});

describe("manifests and prefixes", () => {
  const key = (n: number) => `SHA256E-s${n}--${"a".repeat(64)}.edf`;

  test("EDF and BDF are recognized in any letter case, and only they", () => {
    for (const p of ["a.edf", "a.EDF", "a.bdf", "a.Bdf", "x/y/z.edf"])
      expect(isEdfOrBdf(p), p).toBe(true);
    for (const p of ["a.fif", "a.edf.gz", "a.edfx", "edf", "a.set"])
      expect(isEdfOrBdf(p), p).toBe(false);
  });

  test("a manifest yields the distinct annex keys of its EDF and BDF files, skipping git: keys", () => {
    const doc = JSON.stringify({
      dataset_id: "xx090411",
      files: {
        "a.edf": { key: key(10) },
        "b.EDF": { key: key(10) },
        "c.bdf": { key: key(20) },
        "d.edf": { key: `git:${"b".repeat(40)}` },
        "e.fif": { key: "SHA256E-s5--zz.fif" },
        "f.edf": { key: "MD5E-s5--abc.edf" },
      },
    });
    const r = keysOfManifest("xx090411", doc);
    expect([...r.keys].sort()).toEqual([key(10), key(20)].sort());
    expect(r.badKeys).toBe(1);
  });

  test("a prune prefix must be a dataset's own manifests or archives, never its objects", () => {
    expect(() => checkPrunePrefix("xx090411", "xx090411/version/")).not.toThrow();
    expect(() => checkPrunePrefix("xx090411", "xx090411/archives/")).not.toThrow();
    for (const bad of [
      "xx090411/objects/",
      "xx090411/objects/sub/",
      "xx090412/version/",
      "xx090411/version",
      "xx090411/../x/",
      "",
      "/",
    ]) {
      expect(() => checkPrunePrefix("xx090411", bad), bad).toThrow(StageError);
    }
  });
});
