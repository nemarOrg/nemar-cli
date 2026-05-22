/**
 * AWS STS Service using aws4fetch
 *
 * Generates temporary, scoped credentials for direct S3 uploads via AWS CLI.
 * Uses GetFederationToken to create short-lived credentials with policies
 * restricted to a specific dataset prefix.
 */

import { AwsClient } from "aws4fetch";

interface StsConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export interface FederationTokenResult {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
}

/**
 * Call STS GetFederationToken to create temporary credentials.
 *
 * The returned credentials are scoped to the intersection of the calling
 * IAM user's permissions and the inline policy provided here.
 */
export async function getFederationToken(
  config: StsConfig,
  options: {
    name: string;
    policy: string;
    durationSeconds?: number;
  },
): Promise<FederationTokenResult> {
  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    service: "sts",
  });

  const params = new URLSearchParams({
    Action: "GetFederationToken",
    Version: "2011-06-15",
    Name: options.name,
    Policy: options.policy,
    DurationSeconds: String(options.durationSeconds ?? 7200),
  });

  const response = await aws.fetch(
    `https://sts.${config.region}.amazonaws.com/?${params.toString()}`,
    { method: "POST" },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`STS GetFederationToken failed: ${text}`);
  }

  const text = await response.text();

  const accessKeyId = text.match(/<AccessKeyId>([^<]+)<\/AccessKeyId>/)?.[1];
  const secretAccessKey = text.match(/<SecretAccessKey>([^<]+)<\/SecretAccessKey>/)?.[1];
  const sessionToken = text.match(/<SessionToken>([^<]+)<\/SessionToken>/)?.[1];
  const expiration = text.match(/<Expiration>([^<]+)<\/Expiration>/)?.[1];

  if (!accessKeyId || !secretAccessKey || !sessionToken || !expiration) {
    const missing = [
      !accessKeyId && "AccessKeyId",
      !secretAccessKey && "SecretAccessKey",
      !sessionToken && "SessionToken",
      !expiration && "Expiration",
    ].filter(Boolean);
    throw new Error(
      `Failed to parse STS response: missing ${missing.join(", ")}. Response: ${text.slice(0, 200)}`,
    );
  }

  return { accessKeyId, secretAccessKey, sessionToken, expiration };
}

/**
 * Generate a scoped IAM policy for dataset S3 operations.
 *
 * Grants PutObject, GetObject, and HeadObject for data files, plus ListBucket
 * for bucket access. git-annex needs:
 * - GetObject/HeadObject: check whether content already exists (deduplication)
 * - ListBucket (unconditional): HeadBucket during `initremote` to verify bucket exists;
 *   AWS requires s3:ListBucket for HeadBucket with no way to scope by prefix since
 *   HeadBucket doesn't send a prefix parameter. Read/write are still scoped to the
 *   dataset prefix, so listing only reveals object names, not contents.
 */
export function generateUploadPolicy(bucket: string, datasetId: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowDatasetObjects",
        Effect: "Allow",
        Action: ["s3:PutObject", "s3:GetObject", "s3:HeadObject"],
        Resource: `arn:aws:s3:::${bucket}/${datasetId}/objects/*`,
      },
      {
        // git-annex's `initremote` always calls CreateBucket on the
        // configured S3 remote, even when the bucket already exists.
        // AWS treats CreateBucket on an existing-and-owned bucket as a
        // no-op (returns 200 with the existing bucket's location), but
        // the action still needs to be authorized on the IAM user AND
        // the federation session. Scoped to our single bucket so the
        // federated session cannot create other buckets in the account.
        Sid: "AllowBucketAccess",
        Effect: "Allow",
        Action: ["s3:ListBucket", "s3:CreateBucket", "s3:GetBucketLocation"],
        Resource: `arn:aws:s3:::${bucket}`,
      },
    ],
  });
}

/**
 * Generate a read-only IAM policy for downloading dataset files from S3.
 *
 * Grants GetObject and HeadObject for data files, plus ListBucket for
 * bucket access. git-annex needs:
 * - GetObject: download annexed content
 * - HeadObject: check whether content exists locally vs remotely
 * - ListBucket (unconditional): HeadBucket during `enableremote` to verify bucket exists;
 *   AWS requires s3:ListBucket for HeadBucket with no way to scope by prefix since
 *   HeadBucket doesn't send a prefix parameter. Read access is still scoped to the
 *   dataset prefix, so listing only reveals object names, not contents.
 */
export function generateDownloadPolicy(bucket: string, datasetId: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowDatasetRead",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:HeadObject"],
        Resource: `arn:aws:s3:::${bucket}/${datasetId}/objects/*`,
      },
      {
        Sid: "AllowBucketAccess",
        Effect: "Allow",
        Action: "s3:ListBucket",
        Resource: `arn:aws:s3:::${bucket}`,
      },
    ],
  });
}
