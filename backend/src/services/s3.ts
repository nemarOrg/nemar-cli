/**
 * S3 service using aws4fetch
 *
 * Handles presigned URL generation (upload/download), version manifests,
 * S3 Object Lock, bucket policy management, object deletion, and archive
 * download URLs. Uses aws4fetch for Cloudflare Workers compatibility.
 */

import { AwsClient } from "aws4fetch";
import { isValidDatasetId } from "./datasetId.js";

interface PresignedUrlOptions {
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
 * Generate presigned GET URL for downloading a file
 */
export async function generatePresignedGetUrl(
  options: PresignedUrlOptions,
  key: string,
  expiresIn = 3600,
): Promise<string> {
  const { bucket, region } = options;
  const aws = createS3Client(options);

  // Include X-Amz-Expires in URL BEFORE signing
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${key}?X-Amz-Expires=${expiresIn}`;

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

/**
 * List all object keys under a given prefix
 */
export async function listObjectKeys(
  options: PresignedUrlOptions,
  prefix: string,
): Promise<string[]> {
  const { bucket, region } = options;
  const aws = createS3Client(options);
  const keys: string[] = [];
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

    // Parse keys from XML response
    const keyMatches = xml.matchAll(/<Key>([^<]+)<\/Key>/g);
    for (const match of keyMatches) {
      keys.push(match[1]);
    }

    // Check for continuation
    const truncated = xml.includes("<IsTruncated>true</IsTruncated>");
    if (truncated) {
      const tokenMatch = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
      continuationToken = tokenMatch?.[1];
    } else {
      continuationToken = undefined;
    }
  } while (continuationToken);

  return keys;
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

  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) {
    throw new Error(`Failed to get manifest: HTTP ${response.status}`);
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
 * Apply S3 Object Lock (Governance mode) to all objects under a dataset's
 * objects/ prefix. Uses a 100-year retention period to effectively make
 * data blobs immutable. Manifests (version/) and archives (archives/) are
 * excluded so they can be updated or regenerated if needed.
 *
 * Processes objects in batches of `batchSize` to stay within Cloudflare Workers
 * subrequest limits. Returns `hasMore` if there are remaining objects to lock.
 */
export interface ObjectLockFailure {
  key: string;
  error: string;
}

export async function applyObjectLock(
  options: PresignedUrlOptions,
  datasetId: string,
  offset = 0,
  batchSize = 40,
): Promise<{ locked: number; failed: ObjectLockFailure[]; total: number; hasMore: boolean }> {
  const { bucket, region } = options;
  const aws = createS3Client(options);

  const keys = await listObjectKeys(options, `${datasetId}/objects/`);
  const batch = keys.slice(offset, offset + batchSize);
  const failed: ObjectLockFailure[] = [];
  let locked = 0;

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

  for (const key of batch) {
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
        locked++;
      } else {
        const errorText = await res.text().catch(() => "");
        failed.push({ key, error: `HTTP ${res.status}: ${errorText}`.trim() });
      }
    } catch (err) {
      failed.push({ key, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { locked, failed, total: keys.length, hasMore: offset + batchSize < keys.length };
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
