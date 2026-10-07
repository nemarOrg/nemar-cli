/**
 * `deleteVersionBatch` and `deleteVersions`: many versions removed in one `DeleteObjects` request.
 *
 * The REAL `aws` CLI runs against the local stand-in, so what is asserted is what the CLI sent
 * and what a 200 with a per-item `Errors` list does to the library's answer. The point of each
 * case is the one way the batch could report a version gone that is not: a locked version in a
 * 200, an item the answer never mentions, a request that failed as a whole.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import {
  type AwsRunner,
  DELETE_BATCH_MAX,
  type S3Ctx,
  StageError,
  TempArea,
  type VersionRef,
  createAwsRunner,
  deleteVersionBatch,
  deleteVersions,
} from "../../../scripts/scrub/s3/s3-lib";
import { type S3Standin, startS3Standin } from "../helpers/s3-standin";
import { BUCKET, SLOW, awsTestEnv, centuryFromNow, removeTempDirs, withCtx } from "./support";

afterAll(removeTempDirs);

let standin: S3Standin;
afterEach(() => standin?.stop());

const P = "xx090411/zarr/";

/** The real runner, with the delete-objects requests counted: what the library asked, not what S3 saw. */
function counting(ctx: S3Ctx): { ctx: S3Ctx; requests: () => number } {
  let n = 0;
  const aws: AwsRunner = {
    api(op, args, opts) {
      if (op === "delete-objects") n += 1;
      return ctx.aws.api(op, args, opts);
    },
  };
  return { ctx: { ...ctx, aws }, requests: () => n };
}
const data = (v = 1) => new Uint8Array(8).fill(v);
const left = (key: string) => standin.versions(BUCKET, key).map((v) => v.versionId);

/** `n` keys, each with an old version under a newer one; returns the OLD versions as refs. */
function oldVersions(n: number, prefix = P): VersionRef[] {
  const refs: VersionRef[] = [];
  for (let i = 0; i < n; i++) {
    const key = `${prefix}k${String(i).padStart(5, "0")}`;
    refs.push({ key, versionId: standin.putObject(BUCKET, key, data(1)) });
    standin.putObject(BUCKET, key, data(2));
  }
  return refs;
}

describe("deleteVersionBatch", () => {
  test(
    "removes each named version, a delete marker among them, and nothing else",
    async () => {
      standin = startS3Standin();
      const [a, b] = oldVersions(2);
      const marker = standin.putDeleteMarker(BUCKET, `${P}k00000`);
      const keep = standin.putObject(BUCKET, `${P}untouched`, data(9));
      await withCtx(standin, async (ctx) => {
        const items = [a as VersionRef, b as VersionRef, { key: `${P}k00000`, versionId: marker }];
        expect(await deleteVersionBatch(ctx, items, false)).toEqual([]);
      });
      expect(left(`${P}k00000`)).toHaveLength(1);
      expect(left(`${P}k00000`)).not.toContain((a as VersionRef).versionId);
      expect(left(`${P}k00001`)).not.toContain((b as VersionRef).versionId);
      expect(left(`${P}untouched`)).toEqual([keep]);
      const calls = standin.calls("DeleteObjects");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.items).toEqual([
        { key: (a as VersionRef).key, versionId: (a as VersionRef).versionId },
        { key: (b as VersionRef).key, versionId: (b as VersionRef).versionId },
        { key: `${P}k00000`, versionId: marker },
      ]);
      expect(standin.calls("DeleteObject")).toHaveLength(0);
    },
    SLOW,
  );

  test(
    "a locked version in a 200 is reported refused, not deleted, and the others still go",
    async () => {
      standin = startS3Standin();
      const [plain] = oldVersions(1);
      const lockedKey = `${P}locked`;
      const locked = standin.putObject(BUCKET, lockedKey, data(3), { lockUntil: centuryFromNow() });
      await withCtx(standin, async (ctx) => {
        const items = [plain as VersionRef, { key: lockedKey, versionId: locked }];
        expect(await deleteVersionBatch(ctx, items, false)).toEqual([
          "DeleteObjects:access-denied",
        ]);
        expect(left(lockedKey)).toEqual([locked]);
        expect(left((plain as VersionRef).key)).not.toContain((plain as VersionRef).versionId);
        expect(standin.calls("DeleteObjects").map((c) => c.status)).toEqual([200]);
        expect(standin.calls("DeleteObjects")[0]?.bypass).toBe(false);

        // With the bypass the same item goes, and the request says it asked.
        expect(
          await deleteVersionBatch(ctx, [{ key: lockedKey, versionId: locked }], true),
        ).toEqual([]);
        expect(left(lockedKey)).toEqual([]);
        expect(standin.calls("DeleteObjects")[1]?.bypass).toBe(true);
      });
    },
    SLOW,
  );

  test(
    "two versions of one key, one locked: the deleted one never vouches for the refused one",
    async () => {
      standin = startS3Standin();
      const key = `${P}shared`;
      const locked = standin.putObject(BUCKET, key, data(1), { lockUntil: centuryFromNow() });
      const free = standin.putObject(BUCKET, key, data(2));
      standin.putObject(BUCKET, key, data(3));
      await withCtx(standin, async (ctx) => {
        const items = [
          { key, versionId: locked },
          { key, versionId: free },
        ];
        expect(await deleteVersionBatch(ctx, items, false)).toEqual([
          "DeleteObjects:access-denied",
        ]);
      });
      expect(left(key)).toContain(locked);
      expect(left(key)).not.toContain(free);
    },
    SLOW,
  );

  test(
    "an operator without the bypass permission gets a word per locked item, and nothing is deleted",
    async () => {
      standin = startS3Standin();
      const refs: VersionRef[] = [];
      for (let i = 0; i < 3; i++) {
        const key = `${P}locked${i}`;
        refs.push({
          key,
          versionId: standin.putObject(BUCKET, key, data(), { lockUntil: centuryFromNow() }),
        });
      }
      standin.setDenyBypass(true);
      await withCtx(standin, async (ctx) => {
        expect(await deleteVersionBatch(ctx, refs, true)).toEqual([
          "DeleteObjects:access-denied",
          "DeleteObjects:access-denied",
          "DeleteObjects:access-denied",
        ]);
      });
      for (const r of refs) expect(left(r.key)).toEqual([r.versionId]);
    },
    SLOW,
  );

  test(
    "an item the answer never mentions is bad-output, not deleted",
    async () => {
      standin = startS3Standin();
      const refs = oldVersions(3);
      standin.inject("DeleteObjectsItem", {
        code: "x",
        status: 200,
        key: refs[1]?.key,
        omit: true,
      });
      await withCtx(standin, async (ctx) => {
        expect(await deleteVersionBatch(ctx, refs, false)).toEqual(["DeleteObjects:bad-output"]);
      });
      expect(left((refs[1] as VersionRef).key)).toContain((refs[1] as VersionRef).versionId);
      expect(left((refs[0] as VersionRef).key)).not.toContain((refs[0] as VersionRef).versionId);
    },
    SLOW,
  );

  test(
    "an item S3 asked to be retried is sent again alone and then goes",
    async () => {
      standin = startS3Standin();
      const refs = oldVersions(3);
      standin.inject("DeleteObjectsItem", {
        code: "SlowDown",
        status: 200,
        key: refs[2]?.key,
        times: 1,
      });
      await withCtx(standin, async (ctx) => {
        expect(await deleteVersionBatch(ctx, refs, false, { backoffMs: 1 })).toEqual([]);
      });
      const calls = standin.calls("DeleteObjects");
      expect(calls.map((c) => c.items?.length)).toEqual([3, 1]);
      expect(calls[1]?.items?.[0]?.key).toBe((refs[2] as VersionRef).key);
      for (const r of refs) expect(left(r.key)).not.toContain(r.versionId);
    },
    SLOW,
  );

  test(
    "an item that stays throttled is given up after the fifth request and reported",
    async () => {
      standin = startS3Standin();
      const refs = oldVersions(2);
      standin.inject("DeleteObjectsItem", { code: "SlowDown", status: 200, key: refs[0]?.key });
      await withCtx(standin, async (ctx) => {
        expect(await deleteVersionBatch(ctx, refs, false, { backoffMs: 1 })).toEqual([
          "DeleteObjects:throttled",
        ]);
      });
      expect(standin.calls("DeleteObjects").map((c) => c.items?.length)).toEqual([2, 1, 1, 1, 1]);
      expect(left((refs[0] as VersionRef).key)).toContain((refs[0] as VersionRef).versionId);
      expect(left((refs[1] as VersionRef).key)).not.toContain((refs[1] as VersionRef).versionId);
    },
    SLOW,
  );

  test(
    "a refusal is final: AccessDenied for an item is not sent again",
    async () => {
      standin = startS3Standin();
      const refs = oldVersions(2);
      standin.inject("DeleteObjectsItem", { code: "AccessDenied", status: 200, key: refs[0]?.key });
      await withCtx(standin, async (ctx) => {
        expect(await deleteVersionBatch(ctx, refs, false, { backoffMs: 1 })).toEqual([
          "DeleteObjects:access-denied",
        ]);
      });
      expect(standin.calls("DeleteObjects")).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "a request that fails as a whole gives every item the same word and deletes nothing",
    async () => {
      standin = startS3Standin();
      const refs = oldVersions(4);
      standin.inject("DeleteObjects", { code: "AccessDenied", status: 403 });
      await withCtx(standin, async (ctx) => {
        const words = await deleteVersionBatch(ctx, refs, false, { backoffMs: 1 });
        expect(words).toEqual(Array(4).fill("DeleteObjects:access-denied"));
      });
      for (const r of refs) expect(left(r.key)).toContain(r.versionId);
    },
    SLOW,
  );

  test(
    "an internal error of S3 for the whole request is every item's word and never read as success",
    async () => {
      standin = startS3Standin();
      const refs = oldVersions(2);
      standin.inject("DeleteObjects", { code: "InternalError", status: 500 });
      await withCtx(standin, async (ctx) => {
        // The CLI retries a 500 itself, and the library does not resend on it (S3 may have acted
        // on part of it); what matters is that the library never says "deleted".
        const words = await deleteVersionBatch(ctx, refs, false, { backoffMs: 1 });
        expect(words).toEqual(Array(2).fill("DeleteObjects:failed"));
      });
      for (const r of refs) expect(left(r.key)).toContain(r.versionId);
    },
    SLOW,
  );

  test(
    "a request that fails as a whole with throttling is sent again, whole, and then goes",
    async () => {
      standin = startS3Standin();
      const refs = oldVersions(3);
      // Three whole-request refusals in a row, then S3 recovers (the tests run the CLI with its
      // own retries off, so each refusal reaches the library).
      standin.inject("DeleteObjects", { code: "SlowDown", status: 503, times: 3 });
      await withCtx(standin, async (ctx) => {
        const counted = counting(ctx);
        expect(await deleteVersionBatch(counted.ctx, refs, false, { backoffMs: 1 })).toEqual([]);
        expect(counted.requests()).toBe(4);
        expect(readdirSync(ctx.tmp.dir)).toEqual([]);
      });
      expect(standin.calls("DeleteObjects").map((c) => c.status)).toEqual([503, 503, 503, 200]);
      // Each resend named the same whole batch.
      expect(standin.calls("DeleteObjects").every((c) => c.items?.length === 3)).toBe(true);
      for (const r of refs) expect(left(r.key)).not.toContain(r.versionId);
    },
    SLOW,
  );

  test(
    "a request that stays throttled is given up after `attempts` requests, every item reported",
    async () => {
      standin = startS3Standin();
      const refs = oldVersions(2);
      standin.inject("DeleteObjects", { code: "SlowDown", status: 503 });
      await withCtx(standin, async (ctx) => {
        const counted = counting(ctx);
        const words = await deleteVersionBatch(counted.ctx, refs, false, {
          attempts: 2,
          backoffMs: 1,
        });
        expect(words).toEqual(Array(2).fill("DeleteObjects:throttled"));
        expect(counted.requests()).toBe(2);
        expect(readdirSync(ctx.tmp.dir)).toEqual([]);
      });
      for (const r of refs) expect(left(r.key)).toContain(r.versionId);
    },
    SLOW,
  );

  test(
    "a request that times out is sent again, and the body file is gone before the pause",
    async () => {
      standin = startS3Standin();
      const refs = oldVersions(2);
      // One hung answer: the first request outlives the 2 s the library allows (5 x 400 ms).
      standin.stallNext("POST", 8_000, 1);
      await withCtx(
        standin,
        async (ctx) => {
          const counted = counting(ctx);
          expect(await deleteVersionBatch(counted.ctx, refs, false, { backoffMs: 1 })).toEqual([]);
          expect(counted.requests()).toBe(2);
          expect(readdirSync(ctx.tmp.dir)).toEqual([]);
        },
        BUCKET,
        400,
      );
      for (const r of refs) expect(left(r.key)).not.toContain(r.versionId);
    },
    SLOW,
  );

  test(
    "an endpoint that cannot be reached is retried, then every item gets the unreachable word",
    async () => {
      // A port nothing listens on: start a stand-in, take its address, stop it.
      const gone = startS3Standin();
      const deadUrl = gone.url;
      gone.stop();
      standin = startS3Standin();
      const refs = oldVersions(2);
      const tmp = await TempArea.create();
      try {
        const aws = createAwsRunner({
          region: "us-east-2",
          endpointUrl: deadUrl,
          timeoutMs: 60_000,
          env: awsTestEnv(standin),
        });
        const counted = counting({ aws, bucket: BUCKET, tmp });
        const words = await deleteVersionBatch(counted.ctx, refs, false, {
          attempts: 2,
          backoffMs: 1,
        });
        expect(words).toEqual(Array(2).fill("DeleteObjects:unreachable"));
        expect(counted.requests()).toBe(2);
        expect(readdirSync(tmp.dir)).toEqual([]);
      } finally {
        await tmp.dispose();
      }
    },
    SLOW,
  );

  test(
    "the request carries a checksum header, which S3 requires",
    async () => {
      standin = startS3Standin();
      const refs = oldVersions(1);
      await withCtx(standin, async (ctx) => {
        expect(await deleteVersionBatch(ctx, refs, false)).toEqual([]);
      });
      expect(standin.calls("DeleteObjects").map((c) => c.checksum)).toEqual([true]);
    },
    SLOW,
  );

  test(
    "an item with no version id is refused before any request, because it would add a marker",
    async () => {
      standin = startS3Standin();
      const refs = oldVersions(1);
      await withCtx(standin, async (ctx) => {
        const bad = [...refs, { key: `${P}k00000`, versionId: "" }];
        await expect(deleteVersionBatch(ctx, bad, false)).rejects.toMatchObject({
          word: "delete-without-version-id",
        });
        await expect(deleteVersionBatch(ctx, bad, false)).rejects.toBeInstanceOf(StageError);
      });
      expect(standin.opCount("DeleteObjects")).toBe(0);
      expect(standin.versions(BUCKET, `${P}k00000`).some((v) => v.deleteMarker)).toBe(false);
    },
    SLOW,
  );

  test(
    "more than S3 takes in one request is refused before any request",
    async () => {
      standin = startS3Standin();
      const refs = oldVersions(DELETE_BATCH_MAX + 1);
      await withCtx(standin, async (ctx) => {
        await expect(deleteVersionBatch(ctx, refs, false)).rejects.toMatchObject({
          word: "delete-batch-too-large",
        });
      });
      expect(standin.opCount("DeleteObjects")).toBe(0);
    },
    SLOW,
  );

  test(
    "no request body is left on disk, on success or on failure",
    async () => {
      standin = startS3Standin();
      const refs = oldVersions(2);
      await withCtx(standin, async (ctx) => {
        await deleteVersionBatch(ctx, refs, false);
        expect(readdirSync(ctx.tmp.dir)).toEqual([]);
        standin.inject("DeleteObjects", { code: "AccessDenied", status: 403 });
        await deleteVersionBatch(ctx, oldVersions(1, "xx090411/other/"), false);
        expect(readdirSync(ctx.tmp.dir)).toEqual([]);
      });
    },
    SLOW,
  );
});

describe("deleteVersions", () => {
  test(
    "one bad item anywhere refuses the whole call before the first request",
    async () => {
      standin = startS3Standin();
      const refs = oldVersions(1500);
      await withCtx(standin, async (ctx) => {
        // The bad item is in the SECOND batch, one request at a time: without the upfront check the
        // first batch would already be gone when the second is refused.
        const noId = [...refs.slice(0, 1200), { key: `${P}k00000`, versionId: "" }];
        await expect(deleteVersions(ctx, noId, false, 1)).rejects.toMatchObject({
          word: "delete-without-version-id",
        });
        // An undefined id (a cast) would be dropped by JSON.stringify and add a marker.
        const undef = [...refs.slice(0, 1200), { key: `${P}k00000` } as unknown as VersionRef];
        await expect(deleteVersions(ctx, undef, false, 1)).rejects.toMatchObject({
          word: "delete-without-version-id",
        });
        const noKey = [...refs.slice(0, 1200), { key: "", versionId: "v" }];
        await expect(deleteVersions(ctx, noKey, false, 1)).rejects.toMatchObject({
          word: "delete-without-key",
        });
      });
      expect(standin.opCount("DeleteObjects")).toBe(0);
      expect(standin.keys(BUCKET, P).every((k) => left(k).length === 2)).toBe(true);
    },
    SLOW,
  );

  test(
    "splits at the S3 limit: 2,500 versions are three requests, all gone",
    async () => {
      standin = startS3Standin();
      const refs = oldVersions(2500);
      const progress: number[] = [];
      await withCtx(
        standin,
        async (ctx) => {
          const words = await deleteVersions(ctx, refs, false, 2, (p) => progress.push(p.done));
          expect(words).toEqual([]);
        },
        BUCKET,
        120_000,
      );
      const sizes = standin
        .calls("DeleteObjects")
        .map((c) => c.items?.length as number)
        .sort((x, y) => x - y);
      expect(sizes).toEqual([500, 1000, 1000]);
      expect(progress.at(-1)).toBe(2500);
      for (const r of refs) expect(left(r.key)).not.toContain(r.versionId);
      // Each key still has its newer version: only the named ones went.
      expect(standin.keys(BUCKET, P)).toHaveLength(2500);
      expect(standin.keys(BUCKET, P).every((k) => left(k).length === 1)).toBe(true);
    },
    SLOW,
  );

  test(
    "a duplicate is sent once, and the count says so",
    async () => {
      standin = startS3Standin();
      const refs = oldVersions(2);
      await withCtx(standin, async (ctx) => {
        const words = await deleteVersions(
          ctx,
          [...refs, ...refs, refs[0] as VersionRef],
          false,
          4,
        );
        expect(words).toEqual([]);
      });
      expect(standin.calls("DeleteObjects").map((c) => c.items?.length)).toEqual([2]);
    },
    SLOW,
  );

  test(
    "refusals across batches are all counted, with the progress they leave behind",
    async () => {
      standin = startS3Standin();
      const refs = oldVersions(1500);
      // One locked version in each of the two batches.
      for (const i of [10, 1200]) {
        standin.setLock(
          BUCKET,
          (refs[i] as VersionRef).key,
          (refs[i] as VersionRef).versionId,
          "GOVERNANCE",
          centuryFromNow(),
        );
      }
      const seen: Array<{ done: number; total: number; failed: number }> = [];
      await withCtx(
        standin,
        async (ctx) => {
          const words = await deleteVersions(ctx, refs, false, 1, (p) => seen.push(p));
          expect(words).toEqual(Array(2).fill("DeleteObjects:access-denied"));
        },
        BUCKET,
        120_000,
      );
      expect(seen.map((p) => p.total)).toEqual([1500, 1500]);
      expect(seen.at(-1)).toEqual({ done: 1500, total: 1500, failed: 2 });
      expect(left((refs[10] as VersionRef).key)).toContain((refs[10] as VersionRef).versionId);
      expect(left((refs[0] as VersionRef).key)).not.toContain((refs[0] as VersionRef).versionId);
    },
    SLOW,
  );
});
