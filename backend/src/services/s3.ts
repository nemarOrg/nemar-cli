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
  params: GenerateUrlsParams
): Promise<Record<string, string>> {
  const { bucket, region } = options;
  const { prefix, files, expiresIn = 3600 } = params;

  const aws = createS3Client(options);
  const urls: Record<string, string> = {};

  for (const file of files) {
    const key = `${prefix}/${file}`;
    const url = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;

    // Create presigned PUT URL
    const signedRequest = await aws.sign(url, {
      method: "PUT",
      aws: { signQuery: true },
    });

    // Add expiration to the signed URL
    const signedUrl = new URL(signedRequest.url);
    signedUrl.searchParams.set("X-Amz-Expires", expiresIn.toString());

    urls[file] = signedUrl.toString();
  }

  return urls;
}

/**
 * Generate presigned GET URL for downloading a file
 */
export async function generatePresignedGetUrl(
  options: PresignedUrlOptions,
  key: string,
  expiresIn: number = 3600
): Promise<string> {
  const { bucket, region } = options;
  const aws = createS3Client(options);

  const url = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;

  const signedRequest = await aws.sign(url, {
    method: "GET",
    aws: { signQuery: true },
  });

  const signedUrl = new URL(signedRequest.url);
  signedUrl.searchParams.set("X-Amz-Expires", expiresIn.toString());

  return signedUrl.toString();
}

/**
 * Generate presigned URLs for staging area (PR uploads)
 */
export async function generateStagingUrls(
  options: PresignedUrlOptions,
  prNumber: number,
  datasetId: string,
  files: string[]
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
  files: string[]
): Promise<Record<string, string>> {
  return generatePresignedPutUrls(options, {
    prefix: datasetId,
    files,
    expiresIn: 3600,
  });
}
