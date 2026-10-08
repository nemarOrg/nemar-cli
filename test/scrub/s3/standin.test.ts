/**
 * The stand-in is the thing the other tests lean on, so its S3 semantics are tested against the
 * real `aws` CLI here: a test that passes only because the stand-in is lax would prove nothing.
 * Each case is a behavior the scrub stages rely on and that S3 has.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import {
  AwsCliError,
  completeMultipart,
  createMultipart,
  deleteVersion,
  getRetention,
  headObject,
  listKeyVersions,
  listPrefixVersions,
  putObjectIfMatch,
  readRange,
  readWholeWithMeta,
  uploadPart,
  uploadPartCopy,
} from "../../../scripts/scrub/s3/s3-lib";
import { type S3Standin, startS3Standin } from "../helpers/s3-standin";
import { BUCKET, MIB, SLOW, centuryFromNow, removeTempDirs, withCtx } from "./support";

afterAll(removeTempDirs);

let standin: S3Standin;
afterEach(() => standin?.stop());

const K = "xx090411/objects/probe.edf";
const bytes = (n: number, v = 1) => new Uint8Array(n).fill(v);

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof AwsCliError ? e.code : "other";
  }
}

describe("S3 stand-in", () => {
  test(
    "versioning: a bare delete adds a marker, a delete by id removes only that version",
    async () => {
      standin = startS3Standin();
      const v1 = standin.putObject(BUCKET, K, bytes(10, 1));
      const v2 = standin.putObject(BUCKET, K, bytes(10, 2));
      expect(v1).not.toBe(v2);
      await withCtx(standin, async (ctx) => {
        // A bare delete is what the old delete paths did: a marker, and nothing freed.
        await ctx.aws.api("delete-object", ["--bucket", BUCKET, "--key", K]);
        expect(await headObject(ctx, K)).toBeNull();
        let listing = await listKeyVersions(ctx, K);
        expect(listing.versions.map((v) => v.versionId).sort()).toEqual([v1, v2].sort());
        expect(listing.markers.length).toBe(1);
        expect(listing.markers[0]?.isLatest).toBe(true);
        expect(listing.versions.every((v) => !v.isLatest)).toBe(true);

        // Deleting the marker by id brings the newest version back.
        await deleteVersion(ctx, K, (listing.markers[0] as { versionId: string }).versionId, false);
        expect((await headObject(ctx, K))?.versionId).toBe(v2);
        // Deleting the current version by id makes the older one current again.
        await deleteVersion(ctx, K, v2, false);
        expect((await headObject(ctx, K))?.versionId).toBe(v1);
        listing = await listKeyVersions(ctx, K);
        expect(listing.versions.length).toBe(1);
        expect(listing.versions[0]?.isLatest).toBe(true);
      });
    },
    SLOW,
  );

  test(
    "object lock: a locked version needs the bypass, a marker never does, an expired lock does not",
    async () => {
      standin = startS3Standin();
      const locked = standin.putObject(BUCKET, K, bytes(10), { lockUntil: centuryFromNow() });
      const expired = standin.putObject(BUCKET, `${K}.old`, bytes(10), {
        lockUntil: new Date(Date.now() - 1000),
      });
      const marker = standin.putDeleteMarker(BUCKET, K);
      await withCtx(standin, async (ctx) => {
        expect(await code(deleteVersion(ctx, K, locked, false))).toBe("access-denied");
        expect(standin.versions(BUCKET, K).map((v) => v.versionId)).toContain(locked);

        // A locked key can still take a bare delete: it adds a marker, which is not locked.
        expect(await code(ctx.aws.api("delete-object", ["--bucket", BUCKET, "--key", K]))).toBe(
          "ok",
        );
        expect(await code(deleteVersion(ctx, K, marker, false))).toBe("ok");

        expect(await code(deleteVersion(ctx, `${K}.old`, expired, false))).toBe("ok");

        // Without the permission, the bypass header is refused too.
        standin.setDenyBypass(true);
        expect(await code(deleteVersion(ctx, K, locked, true))).toBe("access-denied");
        standin.setDenyBypass(false);
        expect(await code(deleteVersion(ctx, K, locked, true))).toBe("ok");
        expect(standin.versions(BUCKET, K).map((v) => v.versionId)).not.toContain(locked);
      });
    },
    SLOW,
  );

  test(
    "HEAD, retention, Range and If-Match behave as on S3",
    async () => {
      standin = startS3Standin();
      const until = centuryFromNow();
      const v = standin.putObject(
        BUCKET,
        K,
        new Uint8Array(1000).map((_, i) => i % 251),
        {
          lockUntil: until,
          contentType: "application/x-edf",
          sse: "AES256",
        },
      );
      const plain = standin.putObject(BUCKET, "xx090411/objects/plain", bytes(5));
      await withCtx(standin, async (ctx) => {
        const head = await headObject(ctx, K);
        expect(head?.size).toBe(1000);
        expect(head?.versionId).toBe(v);
        expect(head?.lockMode).toBe("GOVERNANCE");
        expect(Date.parse(head?.retainUntil ?? "")).toBe(until.getTime());
        expect(head?.contentType).toBe("application/x-edf");
        expect(head?.sse).toBe("AES256");
        expect(await headObject(ctx, K, "no-such-version")).toBeNull();

        const ret = await getRetention(ctx, K, v);
        expect(ret?.mode).toBe("GOVERNANCE");
        expect(Date.parse(ret?.retainUntil ?? "")).toBe(until.getTime());
        expect(await getRetention(ctx, "xx090411/objects/plain", plain)).toBeNull();

        expect(Array.from(await readRange(ctx, K, 10, 14))).toEqual([10, 11, 12, 13, 14]);
        expect(await code(readRange(ctx, K, 2000, 2010))).toBe("invalid-range");
        expect(await code(readRange(ctx, K, 0, 9, { ifMatch: head?.etag }))).toBe("ok");
        expect(await code(readRange(ctx, K, 0, 9, { ifMatch: '"not-the-etag"' }))).toBe(
          "precondition-failed",
        );
        // A version id addresses that version, not the current one.
        const v2 = standin.putObject(BUCKET, K, bytes(1000, 7));
        expect((await readRange(ctx, K, 0, 0, { versionId: v }))[0]).toBe(0);
        expect((await readRange(ctx, K, 0, 0, { versionId: v2 }))[0]).toBe(7);
      });
    },
    SLOW,
  );

  test(
    "ListObjectVersions is a prefix match, follows every page, and decodes awkward keys",
    async () => {
      standin = startS3Standin();
      standin.setPageSize(2);
      const plusKey = "xx090411/objects/SHA256E-s9--a+b.edf";
      standin.putObject(BUCKET, K, bytes(3));
      standin.putObject(BUCKET, K, bytes(4));
      standin.putDeleteMarker(BUCKET, K);
      standin.putObject(BUCKET, `${K}.bak`, bytes(5));
      standin.putObject(BUCKET, plusKey, bytes(6));
      await withCtx(standin, async (ctx) => {
        const all = await listPrefixVersions(ctx, "xx090411/objects/");
        expect(all.length).toBe(5);
        expect(all.filter((e) => e.key === K).length).toBe(3);
        expect(all.some((e) => e.key === plusKey)).toBe(true);
        // `probe.edf` is also the prefix of `probe.edf.bak`; only the exact key counts.
        const exact = await listKeyVersions(ctx, K);
        expect(exact.versions.length).toBe(2);
        expect(exact.markers.length).toBe(1);
      });
      expect(standin.calls("ListObjectVersions").length).toBe(3 + 2);
    },
    SLOW,
  );

  test(
    "multipart: part copy honors range and If-Match, and a small non-final part is refused",
    async () => {
      standin = startS3Standin();
      const src = standin.putObject(BUCKET, "xx090411/objects/src", bytes(6 * MIB, 3));
      expect(src).toBeTruthy();
      await withCtx(standin, async (ctx) => {
        const etag = (await headObject(ctx, "xx090411/objects/src"))?.etag as string;
        const body = ctx.tmp.file();
        await writeFile(body, bytes(5 * MIB, 9));
        const dest = "xx090411/objects/dest";

        // Wrong If-Match: refused with 412, and the stand-in did not store the part.
        let id = await createMultipart(ctx, dest, {}, "2126-10-04T00:00:00Z");
        const first = await uploadPart(ctx, dest, id, 1, body);
        expect(
          await code(
            uploadPartCopy(ctx, dest, id, 2, {
              key: "xx090411/objects/src",
              etag: '"stale"',
              start: 0,
              end: 99,
            }),
          ),
        ).toBe("precondition-failed");
        // A range past the end of the source is refused.
        expect(
          await code(
            uploadPartCopy(ctx, dest, id, 2, {
              key: "xx090411/objects/src",
              etag,
              start: 6 * MIB,
              end: 6 * MIB + 5,
            }),
          ),
        ).toBe("invalid-range");
        const second = await uploadPartCopy(ctx, dest, id, 2, {
          key: "xx090411/objects/src",
          etag,
          start: 10,
          end: 109,
        });
        await completeMultipart(ctx, dest, id, [
          { ETag: first, PartNumber: 1 },
          { ETag: second, PartNumber: 2 },
        ]);
        const made = standin.current(BUCKET, dest);
        expect(made?.data.length).toBe(5 * MIB + 100);
        expect(made?.etag).toMatch(/-2"$/);
        expect(made?.lock?.mode).toBe("GOVERNANCE");

        // A non-final part under 5 MiB is refused at completion, as S3 does.
        id = await createMultipart(ctx, "xx090411/objects/small", {}, "2126-10-04T00:00:00Z");
        const small = ctx.tmp.file();
        await writeFile(small, bytes(1000));
        const p1 = await uploadPart(ctx, "xx090411/objects/small", id, 1, small);
        const p2 = await uploadPart(ctx, "xx090411/objects/small", id, 2, small);
        expect(
          await code(
            completeMultipart(ctx, "xx090411/objects/small", id, [
              { ETag: p1, PartNumber: 1 },
              { ETag: p2, PartNumber: 2 },
            ]),
          ),
        ).toBe("failed");
        expect(standin.current(BUCKET, "xx090411/objects/small")).toBeUndefined();
        expect(standin.openUploads()).toBe(1);
      });
    },
    SLOW,
  );

  test(
    "a conditional put replaces the object only if its ETag is the one named",
    async () => {
      standin = startS3Standin();
      const key = "xx090411/zarr/a.zarr/zarr.json";
      standin.putObject(BUCKET, key, bytes(5, 1), {
        contentType: "application/json",
        cacheControl: "max-age=60",
      });
      await withCtx(standin, async (ctx) => {
        const first = await readWholeWithMeta(ctx, key);
        expect(first.contentType).toBe("application/json");
        expect(first.cacheControl).toBe("max-age=60");
        const body = ctx.tmp.file();
        await writeFile(body, bytes(7, 2));

        // A writer gets in after the read: the put that names the old ETag is refused, and the
        // stand-in kept their version, not ours.
        standin.putObject(BUCKET, key, bytes(6, 3));
        expect(await code(putObjectIfMatch(ctx, key, body, {}, first.etag))).toBe(
          "precondition-failed",
        );
        expect(standin.versions(BUCKET, key).length).toBe(2);
        expect(standin.current(BUCKET, key)?.data.length).toBe(6);
        expect(standin.calls("PutObject").at(-1)?.status).toBe(412);

        // Naming the current ETag succeeds, makes a new version, and carries the metadata given.
        const now = await readWholeWithMeta(ctx, key);
        const id = await putObjectIfMatch(
          ctx,
          key,
          body,
          { contentType: "text/plain", cacheControl: "no-cache" },
          now.etag,
        );
        expect(standin.versions(BUCKET, key).length).toBe(3);
        expect(standin.current(BUCKET, key)?.versionId).toBe(id);
        expect(standin.current(BUCKET, key)?.data.length).toBe(7);
        expect(standin.current(BUCKET, key)?.contentType).toBe("text/plain");
        expect(standin.current(BUCKET, key)?.cacheControl).toBe("no-cache");
        // A pinned read of an ETag that is no longer current is refused as well.
        expect(await code(readWholeWithMeta(ctx, key, first.etag))).toBe("precondition-failed");
      });
    },
    SLOW,
  );
});
