/**
 * S3 service using aws4fetch
 *
 * Handles presigned URL generation (upload/download), version manifests,
 * S3 Object Lock, bucket policy management, object deletion, and archive
 * download URLs. Uses aws4fetch for Cloudflare Workers compatibility.
 */

import { AwsClient } from "aws4fetch";
import { isValidDatasetId } from "./datasetId.js";

export interface PresignedUrlOptions {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

interface GenerateUrlsParams {
  prefix: string;
  files: string[];
  expiresIn?: number; // seconds, default 3600 (1 hour)
}

interface S3PolicyStatement {
  Sid?: string;
  Effect: string;
  Principal: string | { [key: string]: string | string[] };
  Action: string | string[];
  Resource: string | string[];
}

interface S3BucketPolicy {
  Version: string;
  Statement: S3PolicyStatement[];
}

/**
 * Create an AWS client for S3 operations
 */
function createS3Client(options: PresignedUrlOptions): AwsClient {
  return new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    region: options.region,
    service: "s3",
  });
}

/**
 * Generate presigned PUT URLs for uploading files
 */
export async function generatePresignedPutUrls(
  options: PresignedUrlOptions,
  params: GenerateUrlsParams,
): Promise<Record<string, string>> {
  const { bucket, region } = options;
  const { prefix, files, expiresIn = 3600 } = params;

  const aws = createS3Client(options);
  const urls: Record<string, string> = {};

  for (const file of files) {
    // Check both raw and URL-decoded forms to catch double-encoded traversal (e.g. %252e%252e)
    const decoded = decodeURIComponent(file);
    if (
      decoded.includes("..") ||
      decoded.startsWith("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0") ||
      file.includes("..") ||
      file.startsWith("/") ||
      file.includes("\\")
    ) {
      throw new Error(`Invalid file path: ${file}`);
    }
    const key = `${prefix}/${file}`;
    // Include X-Amz-Expires in URL BEFORE signing so it's part of the signature
    const url = `https://${bucket}.s3.${region}.amazonaws.com/${key}?X-Amz-Expires=${expiresIn}`;

    // Create presigned PUT URL with expiration included in signature
    const signedRequest = await aws.sign(url, {
      method: "PUT",
      aws: { signQuery: true },
    });

    urls[file] = signedRequest.url;
  }

  return urls;
}

/**
 * Generate presigned GET URL for downloading a file.
 *
 * `responseContentDisposition`, when set, becomes a `response-content-disposition`
 * query parameter that S3 echoes back as the `Content-Disposition` response
 * header. The value is URL-encoded and included in the SigV4 signature, so it
 * cannot be tampered with after presigning. Used by the data.nemar.org route to
 * force BIDS-shaped filenames despite content-addressed object names.
 */
export async function generatePresignedGetUrl(
  options: PresignedUrlOptions,
  key: string,
  expiresIn = 3600,
  responseContentDisposition?: string,
): Promise<string> {
  // Check both raw and URL-decoded forms to catch double-encoded traversal
  const decoded = decodeURIComponent(key);
  if (
    decoded.includes("..") ||
    decoded.startsWith("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    key.includes("..") ||
    key.startsWith("/") ||
    key.includes("\\")
  ) {
    throw new Error(`Invalid S3 key: ${key}`);
  }
  const { bucket, region } = options;
  const aws = createS3Client(options);

  // Include X-Amz-Expires (and optional response-content-disposition) in the URL
  // BEFORE signing so aws4fetch canonicalises them into the signature.
  //
  // The disposition value MUST be URL-encoded here even though aws4fetch
  // re-canonicalises searchParams later: the raw value contains `;`, `=`,
  // `"`, and (for some filenames) `&`, all of which would derail URL/query
  // parsing before aws4fetch ever sees them. The `new URL(url)` call inside
  // aws4fetch decodes one layer back to the original string, which is then
  // re-encoded for the SigV4 canonical form, so the on-wire URL and the
  // canonical-string-to-sign agree.
  const queryParts = [`X-Amz-Expires=${expiresIn}`];
  if (responseContentDisposition) {
    queryParts.push(
      `response-content-disposition=${encodeURIComponent(responseContentDisposition)}`,
    );
  }
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${key}?${queryParts.join("&")}`;

  const signedRequest = await aws.sign(url, {
    method: "GET",
    aws: { signQuery: true },
  });

  return signedRequest.url;
}

/**
 * Generate presigned URLs for staging area (PR uploads)
 */
export async function generateStagingUrls(
  options: PresignedUrlOptions,
  prNumber: number,
  datasetId: string,
  files: string[],
): Promise<{
  uploadUrls: Record<string, string>;
  stagingPrefix: string;
}> {
  const stagingPrefix = `staging/pr-${prNumber}/${datasetId}/objects`;

  const uploadUrls = await generatePresignedPutUrls(options, {
    prefix: stagingPrefix,
    files,
    expiresIn: 3600, // 1 hour for staging uploads
  });

  return { uploadUrls, stagingPrefix };
}

/**
 * Generate presigned URLs for final dataset upload
 */
export async function generateDatasetUploadUrls(
  options: PresignedUrlOptions,
  datasetId: string,
  files: string[],
): Promise<Record<string, string>> {
  return generatePresignedPutUrls(options, {
    prefix: `${datasetId}/objects`,
    files,
    expiresIn: 3600,
  });
}

// ---------------------------------------------------------------------------
// S3 ListObjectsV2 pagination helper
// ---------------------------------------------------------------------------

async function* listObjectPages(
  options: PresignedUrlOptions,
  prefix: string,
): AsyncGenerator<string> {
  const { bucket, region } = options;
  const aws = createS3Client(options);
  let continuationToken: string | undefined;

  do {
    const params = new URLSearchParams({
      "list-type": "2",
      prefix,
      ...(continuationToken ? { "continuation-token": continuationToken } : {}),
    });

    const url = `https://${bucket}.s3.${region}.amazonaws.com/?${params.toString()}`;
    const response = await aws.sign(url, { method: "GET" });
    const res = await fetch(response);

    if (!res.ok) {
      throw new Error(`Failed to list objects: HTTP ${res.status}`);
    }

    const xml = await res.text();

    if (!xml.includes("<ListBucketResult")) {
      throw new Error(`Unexpected S3 response (not ListBucketResult): ${xml.slice(0, 200)}`);
    }

    yield xml;

    const truncated = xml.includes("<IsTruncated>true</IsTruncated>");
    if (truncated) {
      const tokenMatch = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
      if (!tokenMatch?.[1]) {
        throw new Error("S3 response is truncated but no NextContinuationToken found");
      }
      continuationToken = tokenMatch[1];
    } else {
      continuationToken = undefined;
    }
  } while (continuationToken);
}

/**
 * Get total size and object count for a dataset's S3 objects.
 * Uses S3 ListObjectsV2 for real file sizes (git tree shows symlink sizes for annexed files).
 *
 * @param maxPages - If provided, stop counting after this many LIST pages and
 *   return `objectCount: undefined` to signal that the total is unknown. This
 *   caps the Cloudflare Workers subrequest cost when called from within the
 *   publish orchestrator (each LIST page = 1 subrequest). Callers that need
 *   the authoritative total should pass `undefined` (default = unlimited).
 *
 * @warning When `maxPages` is exceeded, `totalSize` reflects only the pages
 *   scanned — it is a partial sum, not the dataset's true total. Callers
 *   MUST check whether `objectCount === undefined` before relying on
 *   `totalSize` for anything that requires an accurate byte count (e.g. DOI
 *   metadata, download size display). Discard or label it clearly if capped.
 */
export async function getDatasetS3Stats(
  options: PresignedUrlOptions,
  datasetId: string,
  maxPages?: number,
): Promise<{ totalSize: number; objectCount: number | undefined }> {
  let totalSize = 0;
  let objectCount = 0;
  let pageCount = 0;

  for await (const xml of listObjectPages(options, `${datasetId}/objects/`)) {
    pageCount++;
    if (maxPages !== undefined && pageCount > maxPages) {
      // Cap exceeded: return undefined so the caller knows the count is
      // incomplete rather than silently returning a low number.
      return { totalSize, objectCount: undefined };
    }
    const contentMatches = xml.matchAll(
      /<Contents>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g,
    );
    for (const match of contentMatches) {
      totalSize += Number.parseInt(match[1], 10);
      objectCount++;
    }
  }

  return { totalSize, objectCount };
}

/**
 * List all object keys under a given prefix.
 */
export async function listObjectKeys(
  options: PresignedUrlOptions,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];

  for await (const xml of listObjectPages(options, prefix)) {
    for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      keys.push(match[1]);
    }
  }

  return keys;
}

export interface S3ListEntry {
  key: string;
  size: number;
  lastModified: string;
}

export interface S3ListResult {
  contents: S3ListEntry[];
  commonPrefixes: string[];
  truncated: boolean;
}

/**
 * One-level S3 listing with `delimiter=/`. Returns immediate-child objects in
 * `contents` and immediate-child sub-directories in `commonPrefixes` (each
 * already ends in `/`). Truncation is reported back so callers can decide
 * whether to ignore, follow continuation, or render a "listing truncated"
 * affordance.
 *
 * Unlike `listObjectPages`, this does a SINGLE round-trip — it is meant for
 * interactive directory rendering (the data.nemar.org `/qa/*` route), not
 * bulk enumeration. The route caller pages by setting `prefix` deeper.
 */
export async function listObjectsWithDelimiter(
  options: PresignedUrlOptions,
  prefix: string,
  maxKeys = 1000,
): Promise<S3ListResult> {
  const { bucket, region } = options;
  const aws = createS3Client(options);

  const params = new URLSearchParams({
    "list-type": "2",
    prefix,
    delimiter: "/",
    "max-keys": String(maxKeys),
  });
  const url = `https://${bucket}.s3.${region}.amazonaws.com/?${params.toString()}`;
  const signed = await aws.sign(url, { method: "GET" });
  const res = await fetch(signed);
  if (!res.ok) {
    throw new Error(`Failed to list objects (prefix=${prefix}): HTTP ${res.status}`);
  }
  const xml = await res.text();
  if (!xml.includes("<ListBucketResult")) {
    throw new Error(`Unexpected S3 response (not ListBucketResult): ${xml.slice(0, 200)}`);
  }

  const contents: S3ListEntry[] = [];
  const contentMatches = xml.matchAll(
    /<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<LastModified>([^<]+)<\/LastModified>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g,
  );
  for (const match of contentMatches) {
    contents.push({
      key: match[1],
      lastModified: match[2],
      size: Number.parseInt(match[3], 10),
    });
  }

  const commonPrefixes: string[] = [];
  const prefixMatches = xml.matchAll(
    /<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>\s*<\/CommonPrefixes>/g,
  );
  for (const match of prefixMatches) {
    commonPrefixes.push(match[1]);
  }

  const truncated = xml.includes("<IsTruncated>true</IsTruncated>");
  return { contents, commonPrefixes, truncated };
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(1)} KB`;
}

export function extractExtensions(paths: string[]): string[] {
  const exts = new Set<string>();
  for (const p of paths) {
    const lastDot = p.lastIndexOf(".");
    if (lastDot > 0) exts.add(p.slice(lastDot));
  }
  return [...exts].sort();
}

/**
 * Upload a JSON manifest to S3 at the dataset's version path.
 * Stored at: <datasetId>/version/v<version>.json
 */
export async function uploadManifest(
  options: PresignedUrlOptions,
  datasetId: string,
  version: string,
  manifestJson: string,
): Promise<void> {
  const { bucket, region } = options;
  const aws = createS3Client(options);
  const versionTag = version.startsWith("v") ? version : `v${version}`;
  const key = `${datasetId}/version/${versionTag}.json`;
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;

  const signed = await aws.sign(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: manifestJson,
  });

  const response = await fetch(signed);
  if (!response.ok) {
    throw new Error(`Failed to upload manifest: HTTP ${response.status}`);
  }
}

/**
 * Get a manifest from S3. Returns null if not found.
 */
export async function getManifest(
  options: PresignedUrlOptions,
  datasetId: string,
  version: string,
): Promise<string | null> {
  const { bucket, region } = options;
  const aws = createS3Client(options);
  const versionTag = version.startsWith("v") ? version : `v${version}`;
  const key = `${datasetId}/version/${versionTag}.json`;
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;

  const signed = await aws.sign(url, { method: "GET" });
  const response = await fetch(signed);

  if (response.status === 404) return null;
  if (response.status === 403) {
    // A correctly-configured backend should never see 403 on its own bucket.
    // Treat as not-found for the caller (preserves existing contract), but
    // log so a credentials regression doesn't silently turn every dataset
    // into a public 404 on data.nemar.org.
    console.error(
      `[s3] getManifest 403 (likely credentials/permissions) dataset=${datasetId} version=${version}`,
    );
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to get manifest: HTTP ${response.status}`);
  }

  return response.text();
}

/**
 * Get a summary.json sibling artifact from S3. Returns null if not found.
 *
 * Stored at: <datasetId>/version/v<version>-summary.json
 *
 * Companion to getManifest(); the central manifest-generation workflow
 * (epic #559, PR-1) writes both manifest.json and summary.json in the same
 * step. Summary is a static-passthrough artifact: the route serves whatever
 * S3 has, no per-request mutation, no validation here (the writer owns the
 * contract; the consumer-side route is shape-agnostic).
 */
export async function loadSummary(
  options: PresignedUrlOptions,
  datasetId: string,
  version: string,
): Promise<string | null> {
  const { bucket, region } = options;
  const aws = createS3Client(options);
  const versionTag = version.startsWith("v") ? version : `v${version}`;
  const key = `${datasetId}/version/${versionTag}-summary.json`;
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;

  const signed = await aws.sign(url, { method: "GET" });
  const response = await fetch(signed);

  if (response.status === 404) return null;
  if (response.status === 403) {
    // Mirror getManifest()'s 403-as-404 behavior: a correctly-configured
    // backend should never see 403 on its own bucket, but if creds drift
    // we don't want every dataset to look like a public 404 silently.
    console.error(
      `[s3] loadSummary 403 (likely credentials/permissions) dataset=${datasetId} version=${version}`,
    );
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to get summary: HTTP ${response.status}`);
  }

  return response.text();
}

/**
 * List available manifest versions for a dataset.
 * Reads from the version/ prefix under the dataset's S3 directory.
 */
export async function listManifests(
  options: PresignedUrlOptions,
  datasetId: string,
): Promise<string[]> {
  const keys = await listObjectKeys(options, `${datasetId}/version/`);
  return keys
    .filter((k) => k.endsWith(".json"))
    .map((k) => {
      const filename = k.split("/").pop() ?? "";
      return filename.replace(".json", "");
    })
    .sort();
}

/**
 * Get the latest zip archive size for a dataset from S3.
 * Scans archives/ prefix and returns the largest (latest version) zip file size in bytes.
 */
export async function getArchiveSize(
  options: PresignedUrlOptions,
  datasetId: string,
): Promise<number> {
  let maxSize = 0;
  for await (const xml of listObjectPages(options, `${datasetId}/archives/`)) {
    const matches = xml.matchAll(
      /<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g,
    );
    for (const match of matches) {
      if (match[1].endsWith(".zip")) {
        const size = Number.parseInt(match[2], 10);
        if (size > maxSize) maxSize = size;
      }
    }
  }
  return maxSize;
}

/**
 * Apply S3 Object Lock (Governance mode) to all objects under a dataset's
 * objects/ prefix. Uses a 100-year retention period to effectively make
 * data blobs immutable. Manifests (version/) and archives (archives/) are
 * excluded so they can be updated or regenerated if needed.
 *
 * Streams via S3 ListObjectsV2 continuation tokens: each invocation issues
 * exactly **one** LIST page (capped to `batchSize` keys via `max-keys`)
 * plus up to `batchSize` PutObjectRetention calls. Per-invocation
 * subrequest cost is bounded at ~`batchSize + 1` regardless of dataset
 * size — this is the load-bearing property that keeps us under
 * Cloudflare Workers' per-invocation subrequest cap on every plan tier.
 *
 * The previous offset-based approach paginated the *entire* dataset on
 * every call (full LIST plus a 40-PUT slice), which compounded across
 * batches and tripped the cap on the SCCN deployment for datasets with
 * even a few hundred objects. See #385 for the regression analysis.
 *
 * Idempotent on retry: 403 responses (already-locked objects) are
 * counted as success, so re-invoking with the same continuation token
 * after a transient failure is safe.
 */
export interface ObjectLockFailure {
  key: string;
  error: string;
}

export async function applyObjectLockBatch(
  options: PresignedUrlOptions,
  datasetId: string,
  continuationToken?: string,
  // Sized for Cloudflare Workers Paid plan (1,000 subrequests per
  // invocation). Per-invocation cost: ~7 D1 + 1 LIST + 100 PUTs +
  // ~15 hidden runtime overhead = ~123 subrequests, leaving 8× headroom
  // before the cap. Halves CLI round-trips from the previous 25-batch
  // value (e.g. nm000103: 36 batches instead of 141) and lets most
  // approvals complete in a single invocation without using the retry
  // loop. Note: this requires the deployed worker to be on Workers Paid
  // (Free plan caps at 50 subrequests, which doesn't fit 100 PUTs).
  batchSize = 100,
): Promise<{
  locked: number;
  failed: ObjectLockFailure[];
  hasMore: boolean;
  nextContinuationToken?: string;
}> {
  const { bucket, region } = options;
  const aws = createS3Client(options);

  // Single-page list with max-keys=batchSize. This is the only LIST call
  // per invocation — no full pagination here.
  const params = new URLSearchParams({
    "list-type": "2",
    prefix: `${datasetId}/objects/`,
    "max-keys": String(batchSize),
    ...(continuationToken ? { "continuation-token": continuationToken } : {}),
  });
  const listUrl = `https://${bucket}.s3.${region}.amazonaws.com/?${params.toString()}`;
  const signedList = await aws.sign(listUrl, { method: "GET" });
  const listRes = await fetch(signedList);
  if (!listRes.ok) {
    throw new Error(`Failed to list objects for lock: HTTP ${listRes.status}`);
  }
  const xml = await listRes.text();
  if (!xml.includes("<ListBucketResult")) {
    throw new Error(`Unexpected S3 response (not ListBucketResult): ${xml.slice(0, 200)}`);
  }

  const keys: string[] = [];
  for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);

  const truncated = xml.includes("<IsTruncated>true</IsTruncated>");
  const tokenMatch = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);

  // S3 contract violation guard: IsTruncated=true MUST come with a
  // NextContinuationToken. If we silently treated this as "stream done",
  // we'd mark s3_lock complete with the dataset only partially locked —
  // exactly the failure mode S3 Object Lock exists to prevent. Throw so
  // the orchestrator surfaces a 500 and the CLI retries.
  if (truncated && !tokenMatch?.[1]) {
    throw new Error(
      "S3 LIST response was truncated but NextContinuationToken is missing; aborting to avoid partial object lock",
    );
  }
  // Only honor the token when the page is genuinely truncated. AWS does
  // not emit NextContinuationToken on a non-truncated page; this guard
  // is just defensive against malformed proxies.
  const nextContinuationToken = truncated ? tokenMatch?.[1] : undefined;

  const failed: ObjectLockFailure[] = [];
  let locked = 0;

  // Empty page is allowed by the S3 contract (e.g. all matching keys on
  // this page were deleted between request and response). Preserve the
  // continuation token so the caller can advance through subsequent
  // pages instead of stopping the stream short of the dataset's tail.
  if (keys.length === 0) {
    return {
      locked: 0,
      failed,
      hasMore: !!nextContinuationToken,
      nextContinuationToken,
    };
  }

  // Retention date: 100 years from now
  const retainUntil = new Date();
  retainUntil.setFullYear(retainUntil.getFullYear() + 100);
  const retainUntilStr = retainUntil.toISOString();

  const retentionXml = `<?xml version="1.0" encoding="UTF-8"?>
<Retention xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Mode>GOVERNANCE</Mode>
  <RetainUntilDate>${retainUntilStr}</RetainUntilDate>
</Retention>`;

  // Compute Content-MD5 (required by S3 PutObjectRetention)
  const bodyBytes = new TextEncoder().encode(retentionXml);
  const contentMd5 = await computeMd5Base64(bodyBytes);

  // Parallelize the PUTs. Subrequest count is identical to a sequential
  // loop (each fetch counts once regardless of order), but wall time
  // drops from ~50ms × N to roughly the slowest individual PUT — for
  // 100 keys that's ~500ms instead of ~5s. Workers Paid gives us a 30s
  // CPU budget, so signing 100 requests in parallel is comfortable.
  // Failure ordering becomes nondeterministic; for a partial-fail
  // batch the CLI replays via the same continuation token, so order
  // doesn't affect correctness.
  const lockResults = await Promise.all(
    keys.map(async (key) => {
      // Encode each path segment individually, preserving "/" separators
      const encodedKey = key.split("/").map(encodeURIComponent).join("/");
      const url = `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}?retention`;
      try {
        const signed = await aws.sign(url, {
          method: "PUT",
          headers: {
            "Content-Type": "application/xml",
            "Content-MD5": contentMd5,
          },
          body: retentionXml,
        });

        const res = await fetch(signed);
        if (res.ok || res.status === 403) {
          // 200: newly locked; 403: already locked (object protected)
          return { ok: true as const };
        }
        const errorText = await res.text().catch(() => "");
        return {
          ok: false as const,
          failure: { key, error: `HTTP ${res.status}: ${errorText}`.trim() },
        };
      } catch (err) {
        return {
          ok: false as const,
          failure: { key, error: err instanceof Error ? err.message : String(err) },
        };
      }
    }),
  );

  for (const r of lockResults) {
    if (r.ok) locked++;
    else failed.push(r.failure);
  }

  return {
    locked,
    failed,
    hasMore: !!nextContinuationToken,
    nextContinuationToken,
  };
}

/**
 * Get the current S3 bucket policy
 * Returns null if no policy is set
 */
export async function getBucketPolicy(
  options: PresignedUrlOptions,
): Promise<S3BucketPolicy | null> {
  const { bucket, region } = options;
  const aws = createS3Client(options);
  const url = `https://${bucket}.s3.${region}.amazonaws.com/?policy`;

  const signed = await aws.sign(url, { method: "GET" });
  const response = await fetch(signed);

  if (response.status === 404) {
    return null; // No policy set
  }

  if (!response.ok) {
    throw new Error(`Failed to get bucket policy: HTTP ${response.status}`);
  }

  const policyText = await response.text();
  return JSON.parse(policyText);
}

/**
 * Add a public read statement to the bucket policy for a specific dataset
 *
 * This allows anyone to download files from the dataset prefix without authentication.
 * Creates a new statement with unique Sid for the dataset.
 *
 * Note: S3 bucket policies have a 20KB size limit (~100 datasets max)
 */
export async function addPublicReadPolicy(
  options: PresignedUrlOptions,
  datasetId: string,
): Promise<void> {
  if (!isValidDatasetId(datasetId)) {
    throw new Error(`Invalid dataset ID for bucket policy: "${datasetId}"`);
  }
  const { bucket, region } = options;
  const aws = createS3Client(options);

  // Fetch current policy or create new one
  let policy = await getBucketPolicy(options);
  if (!policy) {
    policy = {
      Version: "2012-10-17",
      Statement: [],
    };
  }

  const sid = `PublicReadDataset_${datasetId}`;

  // Check if statement already exists (idempotent)
  const existingIndex = policy.Statement.findIndex((s: { Sid?: string }) => s.Sid === sid);

  if (existingIndex >= 0) {
    // Already exists, no change needed
    return;
  }

  // Add new public read statement
  const newStatement = {
    Sid: sid,
    Effect: "Allow",
    Principal: "*",
    Action: "s3:GetObject",
    Resource: `arn:aws:s3:::${bucket}/${datasetId}/*`,
  };

  policy.Statement.push(newStatement);

  // Put updated policy
  const policyJson = JSON.stringify(policy);
  const url = `https://${bucket}.s3.${region}.amazonaws.com/?policy`;

  const signed = await aws.sign(url, {
    method: "PUT",
    body: policyJson,
    headers: {
      "Content-Type": "application/json",
    },
  });

  const response = await fetch(signed);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to update bucket policy: HTTP ${response.status} - ${errorText}`);
  }
}

/**
 * Remove public read statement from the bucket policy for a specific dataset
 *
 * This reverts a dataset to private by removing its public access statement.
 * Idempotent: returns successfully if statement doesn't exist.
 */
export async function removePublicReadPolicy(
  options: PresignedUrlOptions,
  datasetId: string,
): Promise<void> {
  if (!isValidDatasetId(datasetId)) {
    throw new Error(`Invalid dataset ID for bucket policy: "${datasetId}"`);
  }
  const { bucket, region } = options;
  const aws = createS3Client(options);

  // Fetch current policy
  const policy = await getBucketPolicy(options);
  if (!policy) {
    // No policy exists, nothing to remove
    return;
  }

  const sid = `PublicReadDataset_${datasetId}`;

  // Filter out the statement for this dataset
  const originalLength = policy.Statement.length;
  policy.Statement = policy.Statement.filter((s: { Sid?: string }) => s.Sid !== sid);

  // If no statement was removed, return early (idempotent)
  if (policy.Statement.length === originalLength) {
    return;
  }

  // Put updated policy
  const policyJson = JSON.stringify(policy);
  const url = `https://${bucket}.s3.${region}.amazonaws.com/?policy`;

  const signed = await aws.sign(url, {
    method: "PUT",
    body: policyJson,
    headers: {
      "Content-Type": "application/json",
    },
  });

  const response = await fetch(signed);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to update bucket policy: HTTP ${response.status} - ${errorText}`);
  }
}

/**
 * Check if a dataset has public read access in the bucket policy
 */
export async function hasPublicRead(
  options: PresignedUrlOptions,
  datasetId: string,
): Promise<boolean> {
  const policy = await getBucketPolicy(options);
  if (!policy) {
    return false;
  }

  const sid = `PublicReadDataset_${datasetId}`;
  return policy.Statement.some((s: { Sid?: string }) => s.Sid === sid);
}

/**
 * Get a presigned GET URL for downloading a dataset archive.
 * Archives are stored at: <datasetId>/archives/v<version>.zip
 */
export async function getArchiveUrl(
  options: PresignedUrlOptions,
  datasetId: string,
  version: string,
  expiresIn = 3600,
): Promise<string> {
  const versionTag = version.startsWith("v") ? version : `v${version}`;
  const key = `${datasetId}/archives/${versionTag}.zip`;
  return generatePresignedGetUrl(options, key, expiresIn);
}

// ---------------------------------------------------------------------------
// Object deletion
// ---------------------------------------------------------------------------

export interface DeleteResult {
  deleted: number;
  failed: Array<{ key: string; error: string }>;
}

/**
 * Compute base64-encoded MD5 digest (required by S3 Multi-Object Delete).
 * Uses Web Crypto API available in Cloudflare Workers.
 */
async function computeMd5Base64(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("MD5", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/**
 * Delete multiple S3 objects in a single request using the Multi-Object
 * Delete API (POST /?delete). Accepts up to 1000 keys per call.
 *
 * When `bypassGovernance` is true, sends the
 * `x-amz-bypass-governance-retention` header so that objects under
 * GOVERNANCE-mode Object Lock can be deleted.
 */
export async function deleteObjects(
  options: PresignedUrlOptions,
  keys: string[],
  bypassGovernance = false,
): Promise<DeleteResult> {
  if (keys.length === 0) {
    return { deleted: 0, failed: [] };
  }

  const { bucket, region } = options;
  const aws = createS3Client(options);
  const result: DeleteResult = { deleted: 0, failed: [] };

  // S3 Multi-Object Delete accepts at most 1000 keys per request
  const BATCH_SIZE = 1000;

  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batch = keys.slice(i, i + BATCH_SIZE);

    // Build XML request body
    const objectElements = batch.map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`).join("");
    const deleteXml = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>false</Quiet>${objectElements}</Delete>`;

    const bodyBytes = new TextEncoder().encode(deleteXml);
    const contentMd5 = await computeMd5Base64(bodyBytes);

    const url = `https://${bucket}.s3.${region}.amazonaws.com/?delete`;
    const headers: Record<string, string> = {
      "Content-Type": "application/xml",
      "Content-MD5": contentMd5,
    };
    if (bypassGovernance) {
      headers["x-amz-bypass-governance-retention"] = "true";
    }

    try {
      const signed = await aws.sign(url, {
        method: "POST",
        headers,
        body: deleteXml,
      });

      const res = await fetch(signed);
      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        for (const key of batch) {
          result.failed.push({ key, error: `HTTP ${res.status}: ${errorText}`.trim() });
        }
        continue;
      }

      const xml = await res.text();

      // Verify this is a valid DeleteResult response
      if (!xml.includes("<DeleteResult")) {
        for (const key of batch) {
          result.failed.push({ key, error: "Unexpected S3 response: missing DeleteResult" });
        }
        continue;
      }

      // Count successful deletions
      let batchDeleted = 0;
      const deletedMatches = xml.matchAll(/<Deleted>\s*<Key>([^<]+)<\/Key>/g);
      for (const _ of deletedMatches) {
        batchDeleted++;
      }

      // Collect failures (handle any element order within <Error>)
      let batchFailed = 0;
      const errorBlocks = xml.matchAll(/<Error>([\s\S]*?)<\/Error>/g);
      for (const block of errorBlocks) {
        const inner = block[1];
        const keyMatch = inner.match(/<Key>([^<]+)<\/Key>/);
        const codeMatch = inner.match(/<Code>([^<]+)<\/Code>/);
        const msgMatch = inner.match(/<Message>([^<]*)<\/Message>/);
        result.failed.push({
          key: keyMatch?.[1] ?? "unknown",
          error: `${codeMatch?.[1] ?? "UnknownError"}: ${msgMatch?.[1] ?? ""}`,
        });
        batchFailed++;
      }

      // Validate that parsed results account for all keys in batch
      const accounted = batchDeleted + batchFailed;
      if (accounted < batch.length) {
        const missing = batch.length - accounted;
        result.failed.push({
          key: `(${missing} unaccounted keys in batch starting at index ${i})`,
          error: "XML parsing gap: S3 response did not account for all keys",
        });
      }

      result.deleted += batchDeleted;
    } catch (err) {
      for (const key of batch) {
        result.failed.push({ key, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return result;
}

/**
 * Delete all S3 objects belonging to a dataset.
 *
 * Scans the entire `{datasetId}/` prefix rather than enumerating known
 * sub-paths, ensuring nothing is missed if the prefix structure evolves.
 *
 * Validates the dataset ID before proceeding to prevent accidental deletion
 * of unrelated S3 paths.
 */
export async function deleteDatasetObjects(
  options: PresignedUrlOptions,
  datasetId: string,
  bypassGovernance = false,
): Promise<DeleteResult> {
  if (!isValidDatasetId(datasetId)) {
    throw new Error(`Invalid dataset ID for deletion: "${datasetId}"`);
  }

  const keys = await listObjectKeys(options, `${datasetId}/`);
  if (keys.length === 0) {
    return { deleted: 0, failed: [] };
  }

  return deleteObjects(options, keys, bypassGovernance);
}

/**
 * Delete all S3 objects in a PR staging area for a dataset.
 * Stored at: staging/pr-{prNumber}/{datasetId}/
 */
export async function deleteStagingObjects(
  options: PresignedUrlOptions,
  prNumber: number,
  datasetId: string,
): Promise<DeleteResult> {
  if (!isValidDatasetId(datasetId)) {
    throw new Error(`Invalid dataset ID for staging cleanup: "${datasetId}"`);
  }
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    throw new Error(`Invalid PR number for staging cleanup: ${prNumber}`);
  }

  const prefix = `staging/pr-${prNumber}/${datasetId}/`;
  const keys = await listObjectKeys(options, prefix);

  if (keys.length === 0) {
    return { deleted: 0, failed: [] };
  }

  return deleteObjects(options, keys);
}

/**
 * Escape special XML characters in a string.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
