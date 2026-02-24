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
 * for prefix enumeration. git-annex needs:
 * - GetObject/HeadObject: check whether content already exists (deduplication)
 * - ListBucket (unconditional): HeadBucket during `initremote` to verify bucket exists
 * - ListBucket (prefix-scoped): enumerate objects within the dataset prefix
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
        Sid: "AllowBucketAccess",
        Effect: "Allow",
        Action: "s3:ListBucket",
        Resource: `arn:aws:s3:::${bucket}`,
      },
    ],
  });
}
