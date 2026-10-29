/**
 * The re-pull's copy (ADR 0111, decision 8): every key the copy manifest copies is copied from
 * upstream's bucket into NEMAR's `<id>/objects/` at the version upstream's `.log.rmet` pinned,
 * server side (the bytes stay in AWS), through the write guard.
 *
 * For each item: an object already at the destination at the size its key declares is skipped; one
 * at another size is copied again (#967). Otherwise upstream's object is headed AT THE PIN: absent
 * is `pin-absent`, an answer that does not name the pinned version (or names none) is
 * `pin-version-mismatch`, another size than the key declares is `pin-size-mismatch`. A key that
 * declares no size is skipped only when the destination already holds the pinned object's size,
 * and is otherwise copied; the headed size is the one checked, never zero. Then one `copy-object`
 * with `--copy-source <bucket>/<object>?versionId=<v>`, `--copy-source-if-match` on that
 * version's ETag and `--tagging-directive REPLACE` (the default, COPY, reads the source's tags,
 * which upstream's bucket does not let us read: measured on 2026-10-29, every plain copy-object
 * from it answered AccessDenied, with or without the condition, while the multipart copy, which
 * carries no tags, succeeded; the copy then holds no tags), or above {@link SINGLE_COPY_MAX} a
 * multipart upload whose every part is copied
 * from the same version under the same condition (any failure aborts it). S3 must name the pinned
 * version as the one it copied from (`CopySourceVersionId`), for the copy and for every part: any
 * other answer, or none, is `pin-version-mismatch`, a single copy that already landed is deleted
 * by its version id, and a multipart upload is aborted. The destination is headed after, and must
 * be the size that was copied.
 *
 * A refusal of one item stops new items from starting; the step refuses once the ones in flight
 * have finished, so nothing is registered for a partial copy and a rerun skips what landed.
 *
 * The staging manifest (`<id>/staging/repull-<to_tag>.json`, decision 8) is written before the
 * first copy: it is what an abandoned re-pull's orphans are read from.
 */

import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AwsCliError,
  type AwsRunner,
  MAX_COPY_PART_BYTES,
  MAX_PARTS,
  failureWord,
  runPool,
} from "../../../../scripts/scrub/s3/s3-lib.js";
import {
  type CanonicalJsonValue,
  canonicalJson,
} from "../../../../shared/neurobagel/canonical-json.js";
import { annexKeyDeclaredSize } from "../../s3-server-copy.js";
import { RepullWriteRefused } from "../write-guard.js";
import type { CopyManifest } from "./synthesize.js";
import { ExecuteRefused } from "./verify-plan.js";

/** S3's single CopyObject ceiling. */
export const SINGLE_COPY_MAX = 5 * 1024 ** 3;

/** The region of upstream's bucket (`openneuro.org`). */
export const UPSTREAM_REGION = "us-east-1";

/** Copies in flight at once. */
export const COPY_CONCURRENCY = 8;

/** The staging manifest's key (ADR 0111, decision 8). */
export function stagingManifestKey(datasetId: string, toTag: string): string {
  return `${datasetId}/staging/repull-${toTag}.json`;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Every current object under `prefix`, by the part of its key after `prefix`, with its size. */
export async function listPrefixSizes(
  aws: AwsRunner,
  bucket: string,
  prefix: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const seen = new Set<string>();
  let token: string | null = null;
  for (;;) {
    const page = await aws.api("list-objects-v2", [
      "--bucket",
      bucket,
      "--prefix",
      prefix,
      "--max-keys",
      "1000",
      "--no-paginate",
      ...(token ? ["--continuation-token", token] : []),
    ]);
    const contents = page.Contents;
    if (contents !== undefined && !Array.isArray(contents)) {
      throw new AwsCliError("bad-output", "ListObjectsV2");
    }
    for (const e of (contents ?? []) as Array<Record<string, unknown>>) {
      const key = str(e.Key);
      if (key === undefined || typeof e.Size !== "number") {
        throw new AwsCliError("bad-output", "ListObjectsV2");
      }
      if (key.startsWith(prefix) && key.length > prefix.length) {
        out.set(key.slice(prefix.length), e.Size);
      }
    }
    if (page.IsTruncated !== true) return out;
    token = str(page.NextContinuationToken) ?? null;
    // A truncated page with no token, or one that does not move on, would list forever.
    if (!token || seen.has(token)) throw new AwsCliError("bad-output", "ListObjectsV2");
    seen.add(token);
  }
}

/** Write the copy manifest to its staging key, through a private temporary file. */
export async function writeStagingManifest(args: {
  aws: AwsRunner;
  bucket: string;
  key: string;
  manifest: CopyManifest;
  dir: string;
}): Promise<void> {
  const file = join(args.dir, "staging-manifest.json");
  writeFileSync(file, canonicalJson(args.manifest as unknown as CanonicalJsonValue), {
    mode: 0o600,
  });
  chmodSync(file, 0o600);
  try {
    await args.aws.api("put-object", [
      "--bucket",
      args.bucket,
      "--key",
      args.key,
      "--body",
      file,
      "--content-type",
      "application/json",
    ]);
  } finally {
    rmSync(file, { force: true });
  }
}

interface Head {
  size: number;
  etag: string;
  versionId: string | undefined;
}

/** head-object; null for a 404 only. */
async function head(
  aws: AwsRunner,
  bucket: string,
  key: string,
  versionId?: string,
): Promise<Head | null> {
  let out: Record<string, unknown>;
  try {
    out = await aws.api("head-object", [
      "--bucket",
      bucket,
      "--key",
      key,
      ...(versionId ? ["--version-id", versionId] : []),
    ]);
  } catch (err) {
    if (err instanceof AwsCliError && err.code === "not-found") return null;
    throw err;
  }
  const etag = str(out.ETag);
  if (typeof out.ContentLength !== "number" || etag === undefined) {
    throw new AwsCliError("bad-output", "HeadObject");
  }
  return { size: out.ContentLength, etag, versionId: str(out.VersionId) };
}

/** The source of a copy: upstream's object at the pinned version (the CLI encodes the path). */
function copySourceOf(item: CopyManifest["items"][number]): string {
  return `${item.bucket}/${item.object}?versionId=${item.version}`;
}

/** The size of each part of a multipart copy of `size` bytes, within S3's part-count limit. */
export function partSizeFor(size: number, partBytes: number): number {
  return Math.max(partBytes, Math.ceil(size / MAX_PARTS));
}

/** A multipart upload the abort of a failed copy could not close. */
export interface OpenUpload {
  key: string;
  uploadId: string;
}

async function copyMultipart(args: {
  aws: AwsRunner;
  source: string;
  version: string;
  etag: string;
  size: number;
  bucket: string;
  key: string;
  partBytes: number;
  open: OpenUpload[];
}): Promise<void> {
  const { aws, bucket, key } = args;
  const created = await aws.api("create-multipart-upload", ["--bucket", bucket, "--key", key]);
  const uploadId = str(created.UploadId);
  if (!uploadId) throw new AwsCliError("bad-output", "CreateMultipartUpload");
  try {
    const step = partSizeFor(args.size, args.partBytes);
    const parts: Array<{ ETag: string; PartNumber: number }> = [];
    for (let start = 0, n = 1; start < args.size; start += step, n++) {
      const end = Math.min(start + step, args.size) - 1;
      const out = await aws.api(
        "upload-part-copy",
        [
          "--bucket",
          bucket,
          "--key",
          key,
          "--upload-id",
          uploadId,
          "--part-number",
          String(n),
          "--copy-source",
          args.source,
          "--copy-source-range",
          `bytes=${start}-${end}`,
          "--copy-source-if-match",
          args.etag,
        ],
        { slow: true },
      );
      const result = out.CopyPartResult as Record<string, unknown> | undefined;
      const etag = result ? str(result.ETag) : undefined;
      if (!etag) throw new AwsCliError("bad-output", "UploadPartCopy");
      // S3 names the source version it copied this part from; unknown is not the pin.
      if (str(out.CopySourceVersionId) !== args.version) {
        throw new ExecuteRefused(
          "pin-version-mismatch",
          `S3 copied part ${n} of a multipart copy from another version than the pinned one`,
        );
      }
      parts.push({ ETag: etag, PartNumber: n });
    }
    await aws.api(
      "complete-multipart-upload",
      [
        "--bucket",
        bucket,
        "--key",
        key,
        "--upload-id",
        uploadId,
        "--multipart-upload",
        JSON.stringify({ Parts: parts }),
      ],
      { slow: true },
    );
  } catch (err) {
    try {
      await aws.api("abort-multipart-upload", [
        "--bucket",
        bucket,
        "--key",
        key,
        "--upload-id",
        uploadId,
      ]);
    } catch {
      // The upload stays open and holds billed parts: the step's refusal names it, so an operator
      // can abort it. The copy's own failure stands.
      args.open.push({ key, uploadId });
    }
    throw err;
  }
}

/** Delete a copy that landed from the wrong version, by the version id its answer names. */
async function removeLanded(
  aws: AwsRunner,
  bucket: string,
  key: string,
  out: Record<string, unknown>,
): Promise<boolean> {
  const versionId = str(out.VersionId);
  if (versionId === undefined) return false;
  try {
    await aws.api("delete-object", ["--bucket", bucket, "--key", key, "--version-id", versionId]);
    return true;
  } catch {
    return false;
  }
}

/** How a failed call of one item reads as the step's refusal. */
function refusalOf(err: unknown): ExecuteRefused {
  if (err instanceof ExecuteRefused) return err;
  if (err instanceof RepullWriteRefused) return new ExecuteRefused("write-refused", err.message);
  if (err instanceof AwsCliError) {
    if (err.op === "CopyObject" || err.op === "UploadPartCopy") {
      // The pinned version was there when it was headed: gone now, or another ETag, is upstream's.
      if (err.code === "not-found") {
        return new ExecuteRefused("pin-absent", "a pinned upstream version is no longer served");
      }
      if (err.code === "precondition-failed") {
        return new ExecuteRefused("pin-changed", "a pinned upstream version changed its ETag");
      }
    }
    return new ExecuteRefused("copy-failed", `an S3 call failed (${failureWord(err)})`);
  }
  return new ExecuteRefused(
    "copy-failed",
    `a copy failed (${err instanceof Error ? err.name : "error"})`,
  );
}

export interface CopyRunners {
  /** For upstream's bucket (its region). */
  source: AwsRunner;
  /** For NEMAR's bucket. */
  dest: AwsRunner;
}

/**
 * Copy every item of the manifest that is not already at the destination at its size. Returns
 * what this call copied and skipped, and the bytes it copied. See the module comment.
 */
export async function copyPinned(args: {
  aws: CopyRunners;
  manifest: CopyManifest;
  destBucket: string;
  prefix: string;
  existing: Map<string, number>;
  concurrency?: number;
  singleCopyMax?: number;
  partBytes?: number;
}): Promise<{ copied: number; skipped: number; bytes: number }> {
  const singleCopyMax = args.singleCopyMax ?? SINGLE_COPY_MAX;
  const partBytes = args.partBytes ?? MAX_COPY_PART_BYTES;
  let copied = 0;
  let skipped = 0;
  let bytes = 0;
  const refusals: ExecuteRefused[] = [];
  const open: OpenUpload[] = [];
  const items = args.manifest.items;
  await runPool(
    items,
    args.concurrency ?? COPY_CONCURRENCY,
    async (item) => {
      try {
        const declared = annexKeyDeclaredSize(item.key);
        const listed = args.existing.get(item.key);
        if (declared !== null && listed === declared) {
          skipped++;
          return;
        }
        const pinned = await head(args.aws.source, item.bucket, item.object, item.version);
        if (!pinned) {
          throw new ExecuteRefused("pin-absent", "a pinned upstream version is not served");
        }
        // Unknown is never success: an answer that names no version is not the pin either.
        if (pinned.versionId !== item.version) {
          throw new ExecuteRefused(
            "pin-version-mismatch",
            "upstream answered for another version than the pinned one, or for none",
          );
        }
        if (declared !== null && pinned.size !== declared) {
          throw new ExecuteRefused(
            "pin-size-mismatch",
            "a pinned upstream version is not the size its key declares",
          );
        }
        // A key that declares no size is checked against the size the pin has.
        if (declared === null && listed === pinned.size) {
          skipped++;
          return;
        }
        const key = `${args.prefix}${item.key}`;
        const source = copySourceOf(item);
        if (pinned.size <= singleCopyMax) {
          const out = await args.aws.dest.api(
            "copy-object",
            [
              "--bucket",
              args.destBucket,
              "--key",
              key,
              "--copy-source",
              source,
              "--copy-source-if-match",
              pinned.etag,
              "--tagging-directive",
              "REPLACE",
            ],
            { slow: true },
          );
          // S3 names the source version it copied from; unknown is not the pin. The copy has
          // landed, and a rerun would skip it at the declared size, so it is removed by version.
          if (str(out.CopySourceVersionId) !== item.version) {
            const removed = await removeLanded(args.aws.dest, args.destBucket, key, out);
            throw new ExecuteRefused(
              "pin-version-mismatch",
              removed
                ? "S3 copied from another version than the pinned one; the copy was removed"
                : "S3 copied from another version than the pinned one and the copy could not be removed: delete it by hand before a rerun",
            );
          }
        } else {
          await copyMultipart({
            aws: args.aws.dest,
            source,
            version: item.version,
            etag: pinned.etag,
            size: pinned.size,
            bucket: args.destBucket,
            key,
            partBytes,
            open,
          });
        }
        const landed = await head(args.aws.dest, args.destBucket, key);
        if (!landed || landed.size !== pinned.size) {
          throw new ExecuteRefused(
            "copy-size-mismatch",
            "a copied object is not the size of the version it was copied from",
          );
        }
        copied++;
        bytes += pinned.size;
      } catch (err) {
        refusals.push(refusalOf(err));
      }
    },
    () => refusals.length > 0,
  );
  if (refusals.length > 0) {
    const first = refusals[0] as ExecuteRefused;
    const left =
      open.length > 0
        ? ` ${open.length} multipart upload(s) could not be aborted and stay open (abort them with abort-multipart-upload): ${open.map((o) => o.uploadId).join(", ")}.`
        : "";
    throw new ExecuteRefused(
      first.code,
      `The copy stopped: ${first.message}; ${refusals.length} of ${items.length} item(s) refused, ${copied} copied and ${skipped} already present this run. Nothing is registered for a partial copy, and a rerun skips what landed.${left}`,
    );
  }
  return { copied, skipped, bytes };
}
