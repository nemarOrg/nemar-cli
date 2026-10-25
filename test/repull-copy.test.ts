/**
 * The re-pull's pinned copy (ADR 0111, decision 8; epic #1046 phase 6, #1912), driven through the
 * REAL `aws` CLI against the S3 stand-in (`test/scrub/helpers/s3-standin.ts`), which models
 * versioning and the cross-bucket CopyObject and UploadPartCopy with `?versionId=` and
 * `x-amz-copy-source-if-match`. Every upstream object here has a NEWER version of other bytes and
 * the same size on top of the pinned one, so a copy that drops the version id copies the wrong
 * bytes, and only the bytes compare says so.
 *
 * What only the canary and the production runs can check: that real S3 answers a signed
 * cross-account copy of a public versioned object as the stand-in does, and that multipart over
 * 5 GiB and the CLI's retries behave as here.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "bun";
import { type AwsRunner, createAwsRunner } from "../scripts/scrub/s3/s3-lib";
import {
  copyPinned,
  listPrefixSizes,
  partSizeFor,
  stagingManifestKey,
  writeStagingManifest,
} from "../src/lib/repull/execute/copy";
import type { CopyManifest } from "../src/lib/repull/execute/synthesize";
import { ExecuteRefused } from "../src/lib/repull/execute/verify-plan";
import { type AwsGuardContext, guardedAws } from "../src/lib/repull/write-guard";
import { toolOrFail } from "./scrub/helpers/require-tools";
import { type S3Standin, startS3Standin } from "./scrub/helpers/s3-standin";
import { awsTestEnv, removeTempDirs } from "./scrub/s3/support";

setDefaultTimeout(120_000);

const awsInstalled = toolOrFail("aws", which("aws") !== null);

const ID = "xx099991";
const DS = "ds099999";
const PREFIX = `${ID}/objects/`;
const MIB = 1024 * 1024;

let s3: S3Standin;
let scratch: string;

const CTX: AwsGuardContext = {
  destBucket: "nemar",
  prefix: PREFIX,
  stagingKey: stagingManifestKey(ID, "1.1.0"),
  sourceBucket: "openneuro.org",
  sourcePrefix: `${DS}/`,
};

function runner(region: string): AwsRunner {
  return createAwsRunner({ region, timeoutMs: 60_000, env: awsTestEnv(s3) });
}

function runners(guarded = true): { source: AwsRunner; dest: AwsRunner } {
  const source = runner("us-east-1");
  const dest = runner("us-east-2");
  return guarded
    ? { source: guardedAws(source, CTX), dest: guardedAws(dest, CTX) }
    : { source, dest };
}

/**
 * A real runner whose answer to one operation is edited on the way back: the fault injection for an
 * endpoint that answers wrongly, over the real `aws` CLI and the stand-in's real answer.
 */
function tampered(
  inner: AwsRunner,
  op: string,
  edit: (out: Record<string, unknown>) => void,
  when: (args: readonly string[]) => boolean = () => true,
): AwsRunner {
  return {
    async api(o, args, opts) {
      const out = await inner.api(o, args, opts);
      if (o === op && when(args)) edit(out);
      return out;
    },
  };
}

function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

interface Source {
  key: string;
  object: string;
  version: string;
  bytes: Uint8Array;
}

/** A pinned upstream object under its SHA256E key, with a newer version of other bytes on top. */
function upstream(path: string, size: number, seed: number): Source {
  const bytes = noise(size, seed);
  const object = `${DS}/${path}`;
  const version = s3.putObject("openneuro.org", object, bytes);
  s3.putObject("openneuro.org", object, noise(size, seed + 1000));
  return { key: `SHA256E-s${size}--${sha256(bytes)}.edf`, object, version, bytes };
}

function manifestOf(sources: Source[]): CopyManifest {
  return {
    schema: "nemar.repull-copy",
    version: 1,
    dataset: ID,
    to_tag: "1.1.0",
    plan_digest: `sha256:${"0".repeat(64)}`,
    items: sources.map((s) => ({
      key: s.key,
      bucket: "openneuro.org",
      object: s.object,
      version: s.version,
      size: s.bytes.length,
    })),
    local: [],
  };
}

async function copy(
  sources: Source[],
  over: Partial<Parameters<typeof copyPinned>[0]> = {},
): Promise<Awaited<ReturnType<typeof copyPinned>>> {
  const aws = over.aws ?? runners();
  return copyPinned({
    aws,
    manifest: manifestOf(sources),
    destBucket: "nemar",
    prefix: PREFIX,
    existing: await listPrefixSizes(aws.dest, "nemar", PREFIX),
    ...over,
  });
}

async function refusal(p: Promise<unknown>): Promise<ExecuteRefused> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ExecuteRefused) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

function destBytes(key: string): Uint8Array | undefined {
  return s3.current("nemar", `${PREFIX}${key}`)?.data;
}

beforeAll(() => {
  s3 = startS3Standin({ region: "us-east-2" });
  scratch = mkdtempSync(join(tmpdir(), "nemar-repull-copy-"));
});

afterAll(() => {
  s3?.stop();
  rmSync(scratch, { recursive: true, force: true });
  removeTempDirs();
});

beforeEach(() => {
  s3.restore(new Map());
});

describe.skipIf(!awsInstalled)("the pinned copy", () => {
  test("copies the pinned version where the current one differs, and heads the destination", async () => {
    const a = upstream("sub-01/eeg/sub-01_task-rest_eeg.edf", 3000, 1);
    const result = await copy([a]);
    expect(result).toEqual({ copied: 1, skipped: 0, bytes: 3000 });
    // The bytes of the pinned version, not of the current one.
    expect(Buffer.from(destBytes(a.key) as Uint8Array).equals(Buffer.from(a.bytes))).toBe(true);
    const [call] = s3.calls("CopyObject");
    expect(call?.versionId).toBe(a.version);
    expect(call?.copySource).toContain(`?versionId=${a.version}`);
    // The condition is the pinned version's own ETag.
    const pinned = s3.versions("openneuro.org", a.object).find((v) => v.versionId === a.version);
    expect(call?.ifMatch).toBe(pinned?.etag);
    // Headed at the pin, then the destination after the copy.
    const heads = s3.calls("HeadObject");
    expect(heads.map((h) => [h.bucket, h.versionId ?? null])).toEqual([
      ["openneuro.org", a.version],
      ["nemar", null],
    ]);
  });

  test("the bytes compare is the property: without the version id the copy takes the newer bytes", async () => {
    // What the guard stops: an unguarded runner sent a copy source by path.
    const a = upstream("sub-01/eeg/sub-01_task-rest_eeg.edf", 2000, 2);
    const raw = runners(false);
    await raw.dest.api("copy-object", [
      "--bucket",
      "nemar",
      "--key",
      `${PREFIX}${a.key}`,
      "--copy-source",
      `openneuro.org/${a.object}`,
    ]);
    expect(Buffer.from(destBytes(a.key) as Uint8Array).equals(Buffer.from(a.bytes))).toBe(false);
    // The guard refuses that call before it is made.
    const guarded = runners();
    await expect(
      guarded.dest.api("copy-object", [
        "--bucket",
        "nemar",
        "--key",
        `${PREFIX}${a.key}`,
        "--copy-source",
        `openneuro.org/${a.object}`,
        "--copy-source-if-match",
        '"x"',
      ]),
    ).rejects.toThrow("copy-source-unversioned");
  });

  test("multipart above the single-copy bound sends the version id in every part's source and completes", async () => {
    const big = upstream("sub-02/eeg/sub-02_task-rest_eeg.edf", 12 * MIB, 3);
    const result = await copy([big], { singleCopyMax: MIB, partBytes: 5 * MIB });
    expect(result.copied).toBe(1);
    const parts = s3.calls("UploadPartCopy");
    expect(parts).toHaveLength(3);
    for (const p of parts) {
      expect(p.status).toBe(200);
      expect(p.copySource).toContain(`?versionId=${big.version}`);
      expect(p.ifMatch).toBeDefined();
    }
    expect(parts.map((p) => p.range)).toEqual([
      `bytes=0-${5 * MIB - 1}`,
      `bytes=${5 * MIB}-${10 * MIB - 1}`,
      `bytes=${10 * MIB}-${12 * MIB - 1}`,
    ]);
    expect(s3.calls("CopyObject")).toEqual([]);
    expect(Buffer.from(destBytes(big.key) as Uint8Array).equals(Buffer.from(big.bytes))).toBe(true);
    expect(s3.openUploads()).toBe(0);
  });

  test("a failed part aborts the upload", async () => {
    const big = upstream("sub-02/eeg/sub-02_task-rest_eeg.edf", 11 * MIB, 4);
    s3.inject("UploadPartCopy", { code: "InternalError", status: 500, after: 1 });
    const err = await refusal(copy([big], { singleCopyMax: MIB, partBytes: 5 * MIB }));
    expect(err.code).toBe("copy-failed");
    expect(s3.calls("AbortMultipartUpload")).toHaveLength(1);
    expect(s3.openUploads()).toBe(0);
    expect(destBytes(big.key)).toBeUndefined();
  });

  test("present at its size is skipped; present at another size is copied again", async () => {
    const a = upstream("sub-01/eeg/a.edf", 1000, 5);
    const b = upstream("sub-01/eeg/b.edf", 1000, 6);
    s3.putObject("nemar", `${PREFIX}${a.key}`, a.bytes);
    s3.putObject("nemar", `${PREFIX}${b.key}`, new Uint8Array(0));
    const result = await copy([a, b]);
    expect(result).toEqual({ copied: 1, skipped: 1, bytes: 1000 });
    expect(s3.calls("CopyObject").map((c) => c.key)).toEqual([`${PREFIX}${b.key}`]);
    expect(destBytes(b.key)?.length).toBe(1000);
  });

  test("a pinned version of another size than the key declares is pin-size-mismatch", async () => {
    const a = upstream("sub-01/eeg/a.edf", 1000, 7);
    const wrong = { ...a, key: `SHA256E-s999--${sha256(a.bytes)}.edf` };
    const err = await refusal(copy([wrong]));
    expect(err.code).toBe("pin-size-mismatch");
    expect(s3.calls("CopyObject")).toEqual([]);
  });

  test("a pinned version upstream does not serve is pin-absent, and the rest stop", async () => {
    const a = upstream("sub-01/eeg/a.edf", 1000, 8);
    const gone = { ...a, version: "standin-v-gone" };
    const err = await refusal(copy([gone], { concurrency: 1 }));
    expect(err.code).toBe("pin-absent");
    expect(err.message).toContain("1 of 1 item(s) refused");
    expect(s3.calls("CopyObject")).toEqual([]);
  });

  test("a key that declares no size is copied and its pinned size is the one checked", async () => {
    const a = upstream("sub-01/eeg/a.edf", 1500, 9);
    const unsized = { ...a, key: `SHA256E--${sha256(a.bytes)}.edf` };
    expect((await copy([unsized])).bytes).toBe(1500);
    // Now present at the pinned size: skipped, after the pin is headed.
    s3.log.length = 0;
    expect(await copy([unsized])).toEqual({ copied: 0, skipped: 1, bytes: 0 });
    expect(s3.calls("CopyObject")).toEqual([]);
  });

  test("a destination that is not the copied size after the copy refuses", async () => {
    const a = upstream("sub-01/eeg/a.edf", 1000, 10);
    // Between the copy and the destination's head (the second head of the run), the object is cut.
    s3.beforeOp(
      "HeadObject",
      () => s3.putObject("nemar", `${PREFIX}${a.key}`, a.bytes.slice(0, 10)),
      s3.opCount("HeadObject") + 2,
    );
    const err = await refusal(copy([a]));
    expect(err.code).toBe("copy-size-mismatch");
  });

  test("the staging manifest is written to its one key; the listing pages", async () => {
    const a = upstream("sub-01/eeg/a.edf", 100, 11);
    const aws = runners();
    await writeStagingManifest({
      aws: aws.dest,
      bucket: "nemar",
      key: CTX.stagingKey,
      manifest: manifestOf([a]),
      dir: scratch,
    });
    const stored = s3.current("nemar", CTX.stagingKey);
    expect(JSON.parse(new TextDecoder().decode(stored?.data)).items[0].version).toBe(a.version);
    for (let i = 0; i < 5; i++) s3.putObject("nemar", `${PREFIX}K${i}`, new Uint8Array(i));
    s3.setPageSize(2);
    try {
      const listed = await listPrefixSizes(aws.dest, "nemar", PREFIX);
      expect([...listed]).toEqual([0, 1, 2, 3, 4].map((i) => [`K${i}`, i]));
    } finally {
      s3.setPageSize(1000);
    }
  });

  test("a part count over S3's limit grows the part size", () => {
    expect(partSizeFor(12 * MIB, 5 * MIB)).toBe(5 * MIB);
    expect(partSizeFor(10_000 * 5 * MIB + 1, 5 * MIB)).toBeGreaterThan(5 * MIB);
  });

  test("S3 that copies from another version than the pinned one is refused and the copy removed", async () => {
    // An endpoint that ignores the version, says so, and ignores the condition too.
    s3.setCopySourceVersionMode("ignore");
    s3.setIgnoreIfMatch(true);
    const a = upstream("sub-01/eeg/a.edf", 2000, 20);
    const err = await refusal(copy([a]));
    expect(err.code).toBe("pin-version-mismatch");
    expect(err.message).toContain("the copy was removed");
    // The newer bytes are not at the destination: a rerun would otherwise skip them at the size.
    expect(destBytes(a.key)).toBeUndefined();
    expect(s3.calls("DeleteObject").every((d) => typeof d.versionId === "string")).toBe(true);
    expect(s3.keys("nemar", PREFIX)).toEqual([]);
  });

  test("a multipart copy whose parts S3 took from another version is refused, aborted, and lands nothing", async () => {
    s3.setCopySourceVersionMode("ignore");
    s3.setIgnoreIfMatch(true);
    const big = upstream("sub-02/eeg/b.edf", 11 * MIB, 21);
    const err = await refusal(copy([big], { singleCopyMax: MIB, partBytes: 5 * MIB }));
    expect(err.code).toBe("pin-version-mismatch");
    expect(err.message).toContain("part 1");
    expect(s3.calls("AbortMultipartUpload")).toHaveLength(1);
    expect(s3.calls("CompleteMultipartUpload")).toEqual([]);
    expect(s3.openUploads()).toBe(0);
    expect(destBytes(big.key)).toBeUndefined();
  });

  test("an endpoint that names the pinned version while copying the current one is stopped by the ETag condition", async () => {
    s3.setCopySourceVersionMode("lie");
    const a = upstream("sub-01/eeg/a.edf", 2000, 22);
    const big = upstream("sub-02/eeg/b.edf", 11 * MIB, 23);
    expect((await refusal(copy([a]))).code).toBe("pin-changed");
    expect(destBytes(a.key)).toBeUndefined();
    const multi = await refusal(copy([big], { singleCopyMax: MIB, partBytes: 5 * MIB }));
    expect(multi.code).toBe("pin-changed");
    expect(s3.openUploads()).toBe(0);
    expect(destBytes(big.key)).toBeUndefined();
  });

  test("an answer that names no source version is not the pin: refused, and the copy removed", async () => {
    const a = upstream("sub-01/eeg/a.edf", 1500, 24);
    const aws = runners();
    const err = await refusal(
      copy([a], {
        aws: {
          source: aws.source,
          dest: tampered(aws.dest, "copy-object", (out) => {
            out.CopySourceVersionId = undefined;
          }),
        },
      }),
    );
    expect(err.code).toBe("pin-version-mismatch");
    expect(destBytes(a.key)).toBeUndefined();
    // Every part must name it too.
    const big = upstream("sub-02/eeg/b.edf", 11 * MIB, 25);
    const parts = await refusal(
      copy([big], {
        aws: {
          source: aws.source,
          dest: tampered(aws.dest, "upload-part-copy", (out) => {
            out.CopySourceVersionId = undefined;
          }),
        },
        singleCopyMax: MIB,
        partBytes: 5 * MIB,
      }),
    );
    expect(parts.code).toBe("pin-version-mismatch");
    expect(s3.openUploads()).toBe(0);
  });

  test("a copy that landed and cannot be removed says so, so no rerun trusts it", async () => {
    s3.setCopySourceVersionMode("ignore");
    s3.setIgnoreIfMatch(true);
    s3.inject("DeleteObject", { code: "AccessDenied", status: 403 });
    const a = upstream("sub-01/eeg/a.edf", 2000, 26);
    const err = await refusal(copy([a]));
    expect(err.code).toBe("pin-version-mismatch");
    expect(err.message).toContain("could not be removed");
    expect(err.message).toContain("delete it by hand");
  });

  test("a head that names another version, or none, is pin-version-mismatch", async () => {
    const a = upstream("sub-01/eeg/a.edf", 1000, 27);
    const aws = runners();
    const onSource = (args: readonly string[]) => args.includes("--version-id");
    for (const edit of [
      (out: Record<string, unknown>) => {
        out.VersionId = "standin-v-other";
      },
      (out: Record<string, unknown>) => {
        out.VersionId = undefined;
      },
    ]) {
      const err = await refusal(
        copy([a], {
          aws: { source: tampered(aws.source, "head-object", edit, onSource), dest: aws.dest },
        }),
      );
      expect(err.code).toBe("pin-version-mismatch");
    }
    expect(s3.calls("CopyObject")).toEqual([]);
  });

  test("a precondition S3 refuses is pin-changed; a head with no ETag is a failed call", async () => {
    const a = upstream("sub-01/eeg/a.edf", 1000, 28);
    s3.inject("CopyObject", { code: "PreconditionFailed", status: 412 });
    expect((await refusal(copy([a]))).code).toBe("pin-changed");
    s3.clearFaults();
    const aws = runners();
    const noEtag = await refusal(
      copy([a], {
        aws: {
          source: tampered(aws.source, "head-object", (out) => {
            out.ETag = undefined;
          }),
          dest: aws.dest,
        },
      }),
    );
    expect(noEtag.code).toBe("copy-failed");
    expect(noEtag.message).toContain("HeadObject:bad-output");
  });

  test("a failed part and a failed abort leave the refusal naming the open upload", async () => {
    const big = upstream("sub-02/eeg/b.edf", 11 * MIB, 29);
    s3.inject("UploadPartCopy", { code: "InternalError", status: 500, after: 1 });
    s3.inject("AbortMultipartUpload", { code: "InternalError", status: 500 });
    const err = await refusal(copy([big], { singleCopyMax: MIB, partBytes: 5 * MIB }));
    expect(err.code).toBe("copy-failed");
    expect(s3.openUploads()).toBe(1);
    expect(err.message).toMatch(/1 multipart upload\(s\) could not be aborted and stay open/);
    expect(err.message).toMatch(/: [A-Za-z0-9._~=+/-]{8,}\.$/);
  });

  test("a key that declares no size is copied again when the destination holds it at another size", async () => {
    const a = upstream("sub-01/eeg/a.edf", 1500, 30);
    const unsized = { ...a, key: `SHA256E--${sha256(a.bytes)}.edf` };
    s3.putObject("nemar", `${PREFIX}${unsized.key}`, new Uint8Array(10));
    expect(await copy([unsized])).toEqual({ copied: 1, skipped: 0, bytes: 1500 });
    expect(destBytes(unsized.key)?.length).toBe(1500);
    expect(Buffer.from(destBytes(unsized.key) as Uint8Array).equals(Buffer.from(a.bytes))).toBe(
      true,
    );
  });

  test("after a refusal no new item starts: with two items and one at a time, the second is never headed", async () => {
    const a = upstream("sub-01/eeg/a.edf", 1000, 31);
    const b = upstream("sub-01/eeg/b.edf", 1000, 32);
    const gone = { ...a, version: "standin-v-gone" };
    const err = await refusal(copy([gone, b], { concurrency: 1 }));
    expect(err.code).toBe("pin-absent");
    expect(err.message).toContain("1 of 2 item(s) refused");
    expect(s3.calls("HeadObject").map((h) => h.key)).toEqual([a.object]);
    expect(s3.calls("CopyObject")).toEqual([]);
  });
});
