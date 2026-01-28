/**
 * S3 Presigned URL service using aws4fetch
 *
 * Generates presigned URLs for uploading data files to S3.
 * Uses aws4fetch which is compatible with Cloudflare Workers.
 */

import { AwsClient } from "aws4fetch";

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
  const stagingPrefix = `staging/pr-${prNumber}/${datasetId}`;

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
    prefix: datasetId,
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
 * Upload a JSON manifest to S3 at the dataset's manifest path.
 * Stored at: <datasetId>/manifests/v<version>.json
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
  const key = `${datasetId}/manifests/${versionTag}.json`;
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
  const key = `${datasetId}/manifests/${versionTag}.json`;
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
 */
export async function listManifests(
  options: PresignedUrlOptions,
  datasetId: string,
): Promise<string[]> {
  const keys = await listObjectKeys(options, `${datasetId}/manifests/`);
  return keys
    .filter((k) => k.endsWith(".json"))
    .map((k) => {
      const filename = k.split("/").pop() ?? "";
      return filename.replace(".json", "");
    })
    .sort();
}

/**
 * Apply S3 Object Lock (Governance mode) to all objects under a dataset prefix.
 * Uses a 100-year retention period to effectively make objects immutable.
 */
export async function applyObjectLock(
  options: PresignedUrlOptions,
  datasetId: string,
): Promise<{ locked: number; failed: string[] }> {
  const { bucket, region } = options;
  const aws = createS3Client(options);

  const keys = await listObjectKeys(options, `${datasetId}/`);
  const failed: string[] = [];
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
  const md5Digest = await crypto.subtle.digest("MD5", bodyBytes);
  const contentMd5 = btoa(String.fromCharCode(...new Uint8Array(md5Digest)));

  for (const key of keys) {
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
      if (res.ok) {
        locked++;
      } else if (res.status === 403) {
        // 403 on PutObjectRetention means object is already locked
        locked++;
      } else {
        failed.push(key);
      }
    } catch {
      failed.push(key);
    }
  }

  return { locked, failed };
}
