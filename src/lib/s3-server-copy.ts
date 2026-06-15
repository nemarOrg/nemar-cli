/**
 * Server-side S3 copy for OpenNeuro -> NEMAR import (Phase 1, #750).
 *
 * Replaces the old `curl '<openneuro-url>' | aws s3 cp - '<nemar-uri>'`
 * client-stream (which routed every byte through the GitHub runner and blew
 * the 6h job cap on multi-TB datasets) with `aws s3 cp s3://openneuro.org/...
 * s3://nemar/...` server-side copies that stay on AWS's backbone, plus:
 *   - resume: skip objects already present at the destination
 *   - sharding: deterministic key partitioning so one dataset's transfer
 *     parallelises across matrix jobs
 *   - per-object fallback to the old curl-stream only when a server-side copy
 *     genuinely fails (e.g. an access-restricted object)
 *
 * Verified 2026-06-15: signed cross-account read of OpenNeuro's public bucket
 * works, and `aws s3 cp` with `--source-region us-east-1 --region us-east-2`
 * does a real cross-region server-side copy (bytes never touch the runner).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./git-annex.js";

/** A parsed S3 location. `region` is undefined when the URL didn't encode one. */
export interface S3Ref {
  bucket: string;
  key: string;
  region?: string;
}

/** One file to copy: its annex key, parsed S3 source (null when the whereis URL
 *  wasn't an S3 endpoint — then only the curl fallback can copy it), the raw
 *  whereis URL (kept for the fallback), and the NEMAR destination URI. */
export interface CopyItem {
  key: string;
  source: S3Ref | null;
  httpUrl: string | null;
  destUri: string;
}

function decodeKey(key: string): string {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

/**
 * Parse an S3 HTTP(S) URL or an `s3://` URI into {bucket, key, region?}.
 * Returns null for anything that isn't an S3 endpoint so the caller can route
 * it to the curl fallback. Handles:
 *   - s3://<bucket>/<key>
 *   - https://s3.amazonaws.com/<bucket>/<key>           (path-style)
 *   - https://s3.<region>.amazonaws.com/<bucket>/<key>  (path-style, regioned)
 *   - https://<bucket>.s3.amazonaws.com/<key>           (virtual-hosted)
 *   - https://<bucket>.s3.<region>.amazonaws.com/<key>  (virtual-hosted, regioned)
 *   - https://<bucket>.s3-<region>.amazonaws.com/<key>  (legacy dash form)
 */
export function parseS3Url(url: string): S3Ref | null {
  if (!url) return null;

  if (url.startsWith("s3://")) {
    const rest = url.slice("s3://".length);
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    const bucket = rest.slice(0, slash);
    const key = rest.slice(slash + 1);
    if (!bucket || !key) return null;
    return { bucket, key: decodeKey(key) };
  }

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname;
  if (!host.endsWith(".amazonaws.com")) return null;

  const labels = host.split(".");
  const s3idx = labels.findIndex((l) => l === "s3" || l.startsWith("s3-"));
  if (s3idx === -1) return null;
  const path = u.pathname.replace(/^\//, "");

  if (s3idx === 0) {
    // path-style: s3[.<region>].amazonaws.com/<bucket>/<key>
    // labels = ["s3", "amazonaws", "com"] or ["s3", "<region>", "amazonaws", "com"]
    const region = labels.length === 4 ? labels[1] : undefined;
    const slash = path.indexOf("/");
    if (slash < 0) return null;
    const bucket = path.slice(0, slash);
    const key = path.slice(slash + 1);
    if (!bucket || !key) return null;
    return { bucket, key: decodeKey(key), region };
  }

  // virtual-hosted: <bucket>.s3[.<region>].amazonaws.com/<key>
  const bucket = labels.slice(0, s3idx).join(".");
  const s3label = labels[s3idx];
  let region: string | undefined;
  if (s3label.startsWith("s3-")) {
    region = s3label.slice("s3-".length);
  } else if (labels[s3idx + 1] && labels[s3idx + 1] !== "amazonaws") {
    region = labels[s3idx + 1];
  }
  if (!bucket || !path) return null;
  return { bucket, key: decodeKey(path), region };
}

/**
 * Server-side copy of one object: `aws s3 cp s3://src s3://dst` with explicit
 * source+dest regions (avoids a GetBucketLocation round-trip and the perms it
 * needs). Bytes flow on AWS's backbone, never through this process.
 */
export async function serverSideS3Copy(
  source: S3Ref,
  destUri: string,
  destRegion: string,
): Promise<{ success: boolean; error?: string }> {
  const sourceUri = `s3://${source.bucket}/${source.key}`;
  const result = await runCommand(
    [
      "aws",
      "s3",
      "cp",
      sourceUri,
      destUri,
      "--source-region",
      source.region ?? "us-east-1",
      "--region",
      destRegion,
      "--only-show-errors",
    ],
    {},
  );
  if (result.exitCode !== 0) {
    return { success: false, error: result.stderr.trim() || `aws exit ${result.exitCode}` };
  }
  return { success: true };
}

/**
 * Curl-stream fallback (the pre-#750 mechanism): stream from the public HTTP
 * source through this process and pipe to `aws s3 cp -`. Only used when a
 * server-side copy fails AND a raw HTTP URL is available. Routes every byte
 * through the runner, so it's a last resort.
 */
export async function curlStreamCopy(
  sourceUrl: string,
  destUri: string,
  region: string,
): Promise<{ success: boolean; error?: string }> {
  const result = await runCommand(
    ["bash", "-c", `curl -sfL '${sourceUrl}' | aws s3 cp - '${destUri}' --region '${region}'`],
    {},
  );
  if (result.exitCode !== 0) {
    return { success: false, error: result.stderr.trim() || `curl/aws exit ${result.exitCode}` };
  }
  return { success: true };
}

/**
 * Copy items in parallel batches, server-side first with bounded retry, then a
 * one-shot curl fallback per object. Collects failures and returns them (never
 * exits the process mid-stream — the caller decides). `fellBack` counts objects
 * that needed the curl path so the caller can flag unexpected access issues.
 */
export async function batchServerSideCopy(
  items: CopyItem[],
  destRegion: string,
  concurrency: number,
  onProgress?: (done: number, total: number, key: string) => void,
  attempts = 3,
): Promise<{ copied: number; fellBack: number; failed: Array<{ key: string; error: string }> }> {
  let copied = 0;
  let fellBack = 0;
  const failed: Array<{ key: string; error: string }> = [];

  const copyOne = async (item: CopyItem): Promise<"ok" | "fallback"> => {
    let lastError = "no S3 source";
    if (item.source) {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const r = await serverSideS3Copy(item.source, item.destUri, destRegion);
        if (r.success) return "ok";
        lastError = r.error ?? "unknown server-side copy error";
        if (attempt < attempts) {
          await new Promise((res) => setTimeout(res, attempt * attempt * 1000));
        }
      }
    }
    // No S3 source, or server-side exhausted: try the curl fallback once.
    if (item.httpUrl?.startsWith("http")) {
      const fb = await curlStreamCopy(item.httpUrl, item.destUri, destRegion);
      if (fb.success) return item.source ? "fallback" : "ok";
      throw new Error(`server-side failed (${lastError}); fallback failed (${fb.error})`);
    }
    throw new Error(lastError);
  };

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const results = await Promise.allSettled(batch.map((item) => copyOne(item)));
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") {
        copied++;
        if (r.value === "fallback") fellBack++;
      } else {
        failed.push({
          key: batch[j].key,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }
    onProgress?.(copied, items.length, batch[batch.length - 1].key);
  }

  return { copied, fellBack, failed };
}

/**
 * List the objects already present under `s3://<bucket>/<prefix>` (the
 * destination `objects/` prefix). Returns a Map of annex key (the part of the
 * S3 key after `<prefix>`) -> size in bytes. Drives resume: a re-run skips keys
 * that are already there. Uses the `aws` binary (the backend s3.ts lister is
 * Workers-only via aws4fetch and isn't usable in the CLI process).
 */
export async function listExistingObjects(
  bucket: string,
  prefix: string,
  region: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const result = await runCommand(
    [
      "aws",
      "s3api",
      "list-objects-v2",
      "--bucket",
      bucket,
      "--prefix",
      prefix,
      "--region",
      region,
      "--output",
      "json",
    ],
    {},
  );
  if (result.exitCode !== 0) {
    throw new Error(`list-objects-v2 failed for ${prefix}: ${result.stderr.trim()}`);
  }
  const trimmed = result.stdout.trim();
  if (!trimmed) return out;
  let parsed: { Contents?: Array<{ Key?: string; Size?: number }> };
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `list-objects-v2 returned unparseable JSON for ${prefix}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  for (const obj of parsed.Contents ?? []) {
    if (typeof obj.Key !== "string") continue;
    if (!obj.Key.startsWith(prefix)) continue;
    const key = obj.Key.slice(prefix.length);
    if (key.length === 0) continue; // the prefix "directory" placeholder
    out.set(key, typeof obj.Size === "number" ? obj.Size : 0);
  }
  return out;
}

/**
 * Pure resume filter: split items into those still needing a copy and those
 * already present at the destination. An item is skipped when its key is
 * present AND (no expected size map given, OR the present size matches the
 * expected size). Presence-only is correct for OpenNeuro's immutable
 * content-addressed blobs; the optional size check catches truncated partials.
 */
export function filterAlreadyCopied(
  items: CopyItem[],
  existing: Map<string, number>,
  expectedSizes?: Map<string, number>,
): { toCopy: CopyItem[]; skipped: string[] } {
  const toCopy: CopyItem[] = [];
  const skipped: string[] = [];
  for (const item of items) {
    if (!existing.has(item.key)) {
      toCopy.push(item);
      continue;
    }
    const expected = expectedSizes?.get(item.key);
    if (expected !== undefined && existing.get(item.key) !== expected) {
      toCopy.push(item); // present but wrong size -> re-copy
    } else {
      skipped.push(item.key);
    }
  }
  return { toCopy, skipped };
}

/** Stable 32-bit FNV-1a hash. Deterministic across runs/processes so a given
 *  annex key always lands in the same shard. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Parse a `--shard i/N` argument into {index, count}. Throws on malformed
 *  input or an out-of-range index. */
export function parseShardArg(arg: string): { index: number; count: number } {
  const m = arg.match(/^(\d+)\/(\d+)$/);
  if (!m) {
    throw new Error(`Invalid --shard "${arg}". Expected "i/N" (e.g. "0/8").`);
  }
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (count < 1) throw new Error(`Invalid shard count in "${arg}": N must be >= 1.`);
  if (index < 0 || index >= count) {
    throw new Error(`Invalid shard index in "${arg}": i must satisfy 0 <= i < N.`);
  }
  return { index, count };
}

/** True when `key` belongs to shard `index` of `count`. The union over
 *  index 0..count-1 partitions any key set exactly once. */
export function keyInShard(key: string, index: number, count: number): boolean {
  if (count <= 1) return true;
  return fnv1a(key) % count === index;
}

// ---------------------------------------------------------------------------
// Manifest + shard-report staging (S3) — passes state between the prepare,
// copy (sharded), and finalize jobs, which don't share a filesystem.
// ---------------------------------------------------------------------------

export interface ImportManifestItem {
  key: string;
  /** Raw whereis URL, kept for the curl fallback. */
  sourceUrl: string | null;
  /** Parsed S3 source, or null if the whereis URL wasn't an S3 endpoint. */
  source: S3Ref | null;
  destUri: string;
}

export interface ImportManifest {
  openneuroId: string;
  nemarId: string;
  nemarUuid: string;
  items: ImportManifestItem[];
}

function manifestUri(bucket: string, nemarId: string): string {
  return `s3://${bucket}/${nemarId}/staging/import-manifest.json`;
}

/** Write a JSON value to an S3 key via a temp file (`runCommand` has no stdin). */
async function putJson(value: unknown, uri: string, region: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nemar-staging-"));
  const file = join(dir, "payload.json");
  try {
    writeFileSync(file, JSON.stringify(value));
    const result = await runCommand(
      ["aws", "s3", "cp", file, uri, "--region", region, "--content-type", "application/json"],
      {},
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to write ${uri}: ${result.stderr.trim()}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Read a JSON value from an S3 key via `aws s3 cp - -` to stdout. */
async function getJson<T>(uri: string, region: string): Promise<T> {
  const result = await runCommand(["aws", "s3", "cp", uri, "-", "--region", region], {});
  if (result.exitCode !== 0) {
    throw new Error(`Failed to read ${uri}: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as T;
}

export async function writeManifestToS3(
  manifest: ImportManifest,
  bucket: string,
  region: string,
): Promise<void> {
  await putJson(manifest, manifestUri(bucket, manifest.nemarId), region);
}

export async function readManifestFromS3(
  nemarId: string,
  bucket: string,
  region: string,
): Promise<ImportManifest> {
  return getJson<ImportManifest>(manifestUri(bucket, nemarId), region);
}

export async function cleanupStaging(
  nemarId: string,
  bucket: string,
  region: string,
): Promise<void> {
  // Best-effort: a leftover staging prefix is harmless; don't fail the import.
  await runCommand(
    ["aws", "s3", "rm", `s3://${bucket}/${nemarId}/staging/`, "--recursive", "--region", region],
    {},
  );
}
