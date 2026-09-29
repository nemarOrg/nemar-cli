/**
 * Unit tests for the pure planning logic in scripts/rename-archives.ts
 * (#1491's one-time rename sweep). Pure functions, no network, no AWS --
 * per the PR's test plan, the AWS-CLI-shelling half of that script is
 * exercised manually by the lead in dry-run mode, never in CI or here.
 *
 * Sample shapes are drawn from a real `aws s3api list-objects-v2
 * --bucket nemar --prefix nm000132/archives/` read (2026-09-28):
 * `{"Key":"nm000132/archives/v1.1.1.zip","ETag":"\"2c1d...-135\"","Size":14055633023}`
 * -- a genuine multipart upload's ETag, which is why the multipart-ETag
 * branch below is tested against that exact shape rather than a
 * hand-invented one.
 */

import { describe, expect, test } from "bun:test";
import {
  type ArchiveObjectInfo,
  buildCopyArgs,
  buildTagArgs,
  classifyHeadObjectError,
  decideRenameAction,
  hasArchiveTag,
  isDatasetIdPrefix,
  isNewFormatArchiveKey,
  planDatasetRename,
  planRenameKey,
  verifyRenameCopy,
} from "../scripts/rename-archives";

const T1 = "2026-03-01T00:00:00.000Z";
const T2 = "2026-04-01T00:00:00.000Z"; // strictly after T1

describe("isNewFormatArchiveKey", () => {
  test("pre-#1491 key is not new-format", () => {
    expect(isNewFormatArchiveKey("nm000132", "nm000132/archives/v1.1.1.zip")).toBe(false);
  });

  test("#1491 key is new-format", () => {
    expect(isNewFormatArchiveKey("nm000132", "nm000132/archives/nm000132_v1.1.1.zip")).toBe(true);
  });

  test("a key under a different dataset's prefix is never new-format for this id", () => {
    expect(isNewFormatArchiveKey("nm000132", "on002718/archives/on002718_v1.0.0.zip")).toBe(false);
  });
});

describe("planRenameKey", () => {
  test("maps the pre-#1491 shape to the #1491 shape", () => {
    expect(planRenameKey("on002718", "on002718/archives/v1.0.0.zip")).toBe(
      "on002718/archives/on002718_v1.0.0.zip",
    );
  });

  test("throws for a key outside <id>/archives/ (scope guard)", () => {
    expect(() => planRenameKey("nm000132", "nm000132/objects/SHA256E-s1--ab.edf")).toThrow(
      /not under/,
    );
    expect(() => planRenameKey("nm000132", "on002718/archives/v1.0.0.zip")).toThrow(/not under/);
  });

  test("throws for a nested path under archives/", () => {
    expect(() => planRenameKey("nm000132", "nm000132/archives/sub/v1.0.0.zip")).toThrow(
      /single path segment/,
    );
  });

  test("throws when already in the #1491 shape", () => {
    expect(() => planRenameKey("nm000132", "nm000132/archives/nm000132_v1.0.0.zip")).toThrow(
      /already in the #1491 shape/,
    );
  });
});

describe("planDatasetRename", () => {
  test("real-shaped single old-format archive: plans exactly one rename", () => {
    const objects: ArchiveObjectInfo[] = [
      {
        key: "nm000132/archives/v1.1.1.zip",
        size: 14055633023,
        etag: '"2c1d15926e49b48a596ce36dc3799a1e-135"',
        lastModified: T1,
      },
    ];
    const plan = planDatasetRename("nm000132", objects);
    expect(plan.toRename).toEqual([
      {
        datasetId: "nm000132",
        oldKey: "nm000132/archives/v1.1.1.zip",
        newKey: "nm000132/archives/nm000132_v1.1.1.zip",
        size: 14055633023,
        etag: '"2c1d15926e49b48a596ce36dc3799a1e-135"',
        lastModified: T1,
      },
    ]);
    expect(plan.skipped).toEqual([]);
  });

  test("nm000180-shaped case: multiple current old-format zips for one dataset, all planned", () => {
    // The real nm000180 has v1.1.0 through v1.1.3 zips simultaneously
    // (#1518's inventory flagged it as newer than any dataset_versions
    // row; the sweep still renames whatever it finds, deletion decisions
    // are #1518's, not #1491's).
    const objects: ArchiveObjectInfo[] = ["1.1.0", "1.1.1", "1.1.2", "1.1.3"].map((v) => ({
      key: `nm000180/archives/v${v}.zip`,
      size: 1000,
      etag: '"deadbeef"',
      lastModified: T1,
    }));
    const plan = planDatasetRename("nm000180", objects);
    expect(plan.toRename).toHaveLength(4);
    expect(plan.toRename.map((r) => r.newKey)).toEqual([
      "nm000180/archives/nm000180_v1.1.0.zip",
      "nm000180/archives/nm000180_v1.1.1.zip",
      "nm000180/archives/nm000180_v1.1.2.zip",
      "nm000180/archives/nm000180_v1.1.3.zip",
    ]);
  });

  test("already-renamed key is skipped, not re-planned", () => {
    const objects: ArchiveObjectInfo[] = [
      {
        key: "on002718/archives/on002718_v1.0.0.zip",
        size: 500,
        etag: '"x"',
        lastModified: T1,
      },
    ];
    const plan = planDatasetRename("on002718", objects);
    expect(plan.toRename).toEqual([]);
    expect(plan.skipped).toEqual([
      {
        datasetId: "on002718",
        key: "on002718/archives/on002718_v1.0.0.zip",
        reason: "already renamed",
      },
    ]);
  });

  test("a non-.zip object under archives/ is skipped, never planned for rename", () => {
    const objects: ArchiveObjectInfo[] = [
      { key: "nm000132/archives/README.txt", size: 10, etag: '"x"', lastModified: T1 },
    ];
    const plan = planDatasetRename("nm000132", objects);
    expect(plan.toRename).toEqual([]);
    expect(plan.skipped[0].reason).toBe("not a .zip archive");
  });

  test("a key outside <id>/archives/ never reaches planRenameKey and is skipped instead of thrown", () => {
    const objects: ArchiveObjectInfo[] = [
      { key: "nm000132/objects/SHA256E-s1--ab.edf", size: 1, etag: '"x"', lastModified: T1 },
    ];
    // planDatasetRename must not propagate planRenameKey's throw for an
    // out-of-scope key -- it is meant to be reported as skipped, not to
    // crash the whole sweep on one unexpected listing entry.
    expect(() => planDatasetRename("nm000132", objects)).not.toThrow();
    const plan = planDatasetRename("nm000132", objects);
    expect(plan.toRename).toEqual([]);
    expect(plan.skipped[0].reason).toContain("out of scope");
  });

  test("mixed batch: rename, skip-already-renamed, and skip-non-zip together", () => {
    const objects: ArchiveObjectInfo[] = [
      { key: "nm000200/archives/v1.0.0.zip", size: 100, etag: '"a"', lastModified: T1 },
      { key: "nm000200/archives/nm000200_v0.9.0.zip", size: 90, etag: '"b"', lastModified: T1 },
      { key: "nm000200/archives/notes.txt", size: 5, etag: '"c"', lastModified: T1 },
    ];
    const plan = planDatasetRename("nm000200", objects);
    expect(plan.toRename).toHaveLength(1);
    expect(plan.toRename[0].oldKey).toBe("nm000200/archives/v1.0.0.zip");
    expect(plan.skipped).toHaveLength(2);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["already renamed", "not a .zip archive"]);
  });
});

describe("verifyRenameCopy", () => {
  test("real multipart ETag: size match is sufficient, ETag comparison explicitly skipped", () => {
    const source = { size: 14055633023, etag: '"2c1d15926e49b48a596ce36dc3799a1e-135"' };
    // A copy through a different part-size policy produces a DIFFERENT
    // multipart ETag even though the bytes are identical -- this is
    // expected, not a bug, which is exactly why multipart ETags aren't compared.
    const dest = { size: 14055633023, etag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-9"' };
    const verdict = verifyRenameCopy(source, dest);
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toContain("skipped");
  });

  test("single-part ETag: must match exactly", () => {
    const source = { size: 500, etag: '"abc123"' };
    expect(verifyRenameCopy(source, { size: 500, etag: '"abc123"' }).ok).toBe(true);
    const mismatch = verifyRenameCopy(source, { size: 500, etag: '"different"' });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toContain("ETag mismatch");
  });

  test("size mismatch fails regardless of ETag shape", () => {
    const source = { size: 500, etag: '"abc123-4"' };
    const verdict = verifyRenameCopy(source, { size: 499, etag: '"abc123-4"' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("size mismatch");
  });

  test("missing destination fails", () => {
    const verdict = verifyRenameCopy({ size: 500, etag: '"x"' }, null);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("destination object not found");
  });
});

describe("decideRenameAction (PR review finding: never overwrite an existing destination)", () => {
  const source = { size: 500, etag: '"abc123"', lastModified: T1 };

  test("no destination -> copy", () => {
    expect(decideRenameAction(source, null, { allowDeleteStaleLegacy: false })).toEqual({
      action: "copy",
    });
  });

  test("destination matches source -> already-renamed (a resumed run), never re-copied", () => {
    const dest = { size: 500, etag: '"abc123"', lastModified: T2 };
    expect(decideRenameAction(source, dest, { allowDeleteStaleLegacy: false })).toEqual({
      action: "already-renamed",
    });
  });

  test("destination differs, --delete-stale-legacy NOT passed -> skip-collision, never copy or delete", () => {
    const dest = { size: 999, etag: '"different"', lastModified: T2 };
    const decision = decideRenameAction(source, dest, { allowDeleteStaleLegacy: false });
    expect(decision.action).toBe("skip-collision");
    if (decision.action === "skip-collision") {
      expect(decision.reason).toContain("--delete-stale-legacy");
    }
  });

  test("destination differs, --delete-stale-legacy passed but destination is OLDER -> still skip-collision", () => {
    const dest = { size: 999, etag: '"different"', lastModified: T1 }; // same time, not strictly newer
    const decision = decideRenameAction(source, dest, { allowDeleteStaleLegacy: true });
    expect(decision.action).toBe("skip-collision");
  });

  test("destination differs, --delete-stale-legacy passed but destination is EMPTY -> still skip-collision", () => {
    const dest = { size: 0, etag: '"different"', lastModified: T2 };
    const decision = decideRenameAction(source, dest, { allowDeleteStaleLegacy: true });
    expect(decision.action).toBe("skip-collision");
  });

  test("destination differs, newer AND non-empty, --delete-stale-legacy passed -> delete-stale-legacy", () => {
    const dest = { size: 999, etag: '"different"', lastModified: T2 };
    expect(decideRenameAction(source, dest, { allowDeleteStaleLegacy: true })).toEqual({
      action: "delete-stale-legacy",
    });
  });

  // Mutation-relevant: every branch other than "no destination" must never
  // return "copy" -- that is the one thing this function must never do to
  // an existing object.
  test("never returns copy when a destination exists, regardless of options", () => {
    const differing = { size: 999, etag: '"different"', lastModified: T2 };
    const matching = { size: 500, etag: '"abc123"', lastModified: T2 };
    for (const dest of [differing, matching]) {
      for (const allowDeleteStaleLegacy of [true, false]) {
        expect(decideRenameAction(source, dest, { allowDeleteStaleLegacy }).action).not.toBe(
          "copy",
        );
      }
    }
  });
});

describe("buildCopyArgs (bug: aws s3 cp has no --tagging-directive/--tagging)", () => {
  test("is a plain s3 cp with --no-progress, no tagging flags", () => {
    const item = {
      datasetId: "on002718",
      oldKey: "on002718/archives/v1.0.0.zip",
      newKey: "on002718/archives/on002718_v1.0.0.zip",
      size: 500,
      etag: '"x"',
      lastModified: T1,
    };
    const args = buildCopyArgs("nemar", item);
    expect(args).toEqual([
      "s3",
      "cp",
      "s3://nemar/on002718/archives/v1.0.0.zip",
      "s3://nemar/on002718/archives/on002718_v1.0.0.zip",
      "--no-progress",
    ]);
  });

  // This is the exact bug (#1491/#1518 sweep, measured against production):
  // `aws s3 cp` rejects `s3api copy-object`'s tagging flags outright with a
  // ParamValidation error, so buildCopyArgs must never emit them again.
  test("never includes --tagging-directive or --tagging (that combination belongs to s3api copy-object)", () => {
    const item = {
      datasetId: "nm000132",
      oldKey: "nm000132/archives/v1.1.1.zip",
      newKey: "nm000132/archives/nm000132_v1.1.1.zip",
      size: 14055633023,
      etag: '"2c1d15926e49b48a596ce36dc3799a1e-135"',
      lastModified: T1,
    };
    const args = buildCopyArgs("nemar", item);
    expect(args).not.toContain("--tagging-directive");
    expect(args).not.toContain("--tagging");
    expect(args).not.toContain("--metadata-directive");
    expect(args).not.toContain("--content-type");
  });
});

describe("buildTagArgs", () => {
  test("builds an s3api put-object-tagging call carrying nemar-kind=archive", () => {
    expect(buildTagArgs("nemar", "on002718/archives/on002718_v1.0.0.zip")).toEqual([
      "s3api",
      "put-object-tagging",
      "--bucket",
      "nemar",
      "--key",
      "on002718/archives/on002718_v1.0.0.zip",
      "--tagging",
      "TagSet=[{Key=nemar-kind,Value=archive}]",
    ]);
  });
});

describe("hasArchiveTag", () => {
  test("true when the tag set carries nemar-kind=archive", () => {
    expect(hasArchiveTag([{ Key: "nemar-kind", Value: "archive" }])).toBe(true);
  });

  test("true when it is one of several tags", () => {
    expect(
      hasArchiveTag([
        { Key: "other", Value: "thing" },
        { Key: "nemar-kind", Value: "archive" },
      ]),
    ).toBe(true);
  });

  test("false for an empty tag set", () => {
    expect(hasArchiveTag([])).toBe(false);
  });

  test("false when the key is present with a different value", () => {
    expect(hasArchiveTag([{ Key: "nemar-kind", Value: "something-else" }])).toBe(false);
  });

  test("false when unrelated tags are present but not nemar-kind", () => {
    expect(hasArchiveTag([{ Key: "other", Value: "thing" }])).toBe(false);
  });
});

describe("isDatasetIdPrefix", () => {
  test("accepts real dataset id shapes", () => {
    expect(isDatasetIdPrefix("nm000132/")).toBe(true);
    expect(isDatasetIdPrefix("on002718/")).toBe(true);
    expect(isDatasetIdPrefix("xx099900/")).toBe(true);
  });

  test("rejects non-dataset top-level prefixes (e.g. staging/)", () => {
    expect(isDatasetIdPrefix("staging/")).toBe(false);
  });

  test("rejects a prefix with no trailing slash", () => {
    expect(isDatasetIdPrefix("nm000132")).toBe(false);
  });
});

describe("classifyHeadObjectError (a transient error is not a 404)", () => {
  // Every stderr below is REAL: captured from the actual aws-cli 2.36.47
  // against a local S3 stand-in (or a closed port), with the dataset id
  // nm000404 wherever a key appears, because a URL embeds the key and the key
  // can contain "404".
  const key = "nm000404/archives/nm000404_v1.0.0.zip";

  test("the real head-object 404 classifies as not-found", () => {
    expect(
      classifyHeadObjectError(
        "\naws: [ERROR]: An error occurred (404) when calling the HeadObject operation: Not Found\n",
      ),
    ).toBe("not-found");
  });

  test("the same 404 with the CLI's retry annotation still classifies as not-found", () => {
    expect(
      classifyHeadObjectError(
        "\naws: [ERROR]: An error occurred (404) when calling the HeadObject operation (reached max retries: 0): Not Found\n",
      ),
    ).toBe("not-found");
  });

  test("a NoSuchKey / NotFound error line classifies as not-found", () => {
    expect(
      classifyHeadObjectError(
        "An error occurred (NoSuchKey) when calling the HeadObject operation: The specified key does not exist.",
      ),
    ).toBe("not-found");
    expect(
      classifyHeadObjectError("An error occurred (NotFound) when calling the HeadObject operation"),
    ).toBe("not-found");
  });

  test("a refused connection whose URL contains 404 is an error, never a silent not-found", () => {
    const stderr = `\naws: [ERROR]: Could not connect to the endpoint URL: "http://127.0.0.1:9/nemar/${key}"\n`;
    expect(stderr).toContain("404");
    expect(classifyHeadObjectError(stderr)).toBe("error");
  });

  test("a dropped connection whose URL contains 404 is an error, never a silent not-found", () => {
    const stderr = `\naws: [ERROR]: Connection was closed before we received a valid response from endpoint URL: "http://127.0.0.1:55561/nemar/${key}".\n`;
    expect(stderr).toContain("404");
    expect(classifyHeadObjectError(stderr)).toBe("error");
  });

  test("a real 403 is an error, never a silent not-found", () => {
    expect(
      classifyHeadObjectError(
        "\naws: [ERROR]: An error occurred (403) when calling the HeadObject operation: Forbidden\n",
      ),
    ).toBe("error");
  });

  test("a real 503 is an error, never a silent not-found", () => {
    expect(
      classifyHeadObjectError(
        "\naws: [ERROR]: An error occurred (503) when calling the HeadObject operation (reached max retries: 0): Service Unavailable\n",
      ),
    ).toBe("error");
  });

  test("throttling is an error, never a silent not-found", () => {
    expect(
      classifyHeadObjectError(
        "An error occurred (SlowDown) when calling the HeadObject operation: Please reduce your request rate.",
      ),
    ).toBe("error");
  });

  test("bare not-found words outside the CLI's error line are not a signal", () => {
    expect(classifyHeadObjectError("not found")).toBe("error");
    expect(classifyHeadObjectError("nosuchkey")).toBe("error");
  });

  test("empty stderr (e.g. a non-2xx with no body) is an error, never a silent not-found", () => {
    expect(classifyHeadObjectError("")).toBe("error");
  });
});
