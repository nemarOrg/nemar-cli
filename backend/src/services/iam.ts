/**
 * AWS IAM Service using aws4fetch
 *
 * Manages per-user IAM users and policies for scoped S3 access.
 * Regular users get an inline policy granting access only to their dataset prefixes.
 * Admin users receive a broader policy with read/write/delete access to all objects in the bucket.
 */

import { AwsClient } from "aws4fetch";

/**
 * S3 object-level actions granted to users for dataset management.
 * Does not include bucket management permissions (versioning, policies, etc.)
 */
const S3_DATASET_ACTIONS = [
  "s3:GetObject",
  "s3:PutObject",
  "s3:DeleteObject",
  "s3:GetObjectVersion",
] as const;

interface IamConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

interface CreateUserResult {
  username: string;
  arn: string;
}

interface CreateAccessKeyResult {
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Create an AWS client for IAM operations
 * Note: IAM is a global service and always uses us-east-1 for signing
 */
function createIamClient(config: IamConfig): AwsClient {
  return new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: "us-east-1", // IAM is global, always use us-east-1
    service: "iam",
  });
}

/**
 * Generate IAM username from NEMAR username
 */
export function generateIamUsername(nemarUsername: string): string {
  return `nemar-user-${nemarUsername}`;
}

/**
 * Create an IAM user for a NEMAR user
 */
export async function createIamUser(
  config: IamConfig,
  nemarUsername: string,
): Promise<CreateUserResult> {
  const aws = createIamClient(config);
  const iamUsername = generateIamUsername(nemarUsername);

  const params = new URLSearchParams({
    Action: "CreateUser",
    UserName: iamUsername,
    Version: "2010-05-08",
  });

  const response = await aws.fetch(`https://iam.amazonaws.com/?${params.toString()}`, {
    method: "POST",
  });

  if (!response.ok) {
    const text = await response.text();
    // Check if user already exists
    if (text.includes("EntityAlreadyExists")) {
      return { username: iamUsername, arn: `arn:aws:iam::*:user/${iamUsername}` };
    }
    throw new Error(`Failed to create IAM user: ${text}`);
  }

  const text = await response.text();
  // Parse ARN from response XML
  const arnMatch = text.match(/<Arn>([^<]+)<\/Arn>/);
  const arn = arnMatch ? arnMatch[1] : `arn:aws:iam::*:user/${iamUsername}`;

  return { username: iamUsername, arn };
}

/**
 * Create access keys for an IAM user
 */
export async function createAccessKey(
  config: IamConfig,
  iamUsername: string,
): Promise<CreateAccessKeyResult> {
  const aws = createIamClient(config);

  const params = new URLSearchParams({
    Action: "CreateAccessKey",
    UserName: iamUsername,
    Version: "2010-05-08",
  });

  const response = await aws.fetch(`https://iam.amazonaws.com/?${params.toString()}`, {
    method: "POST",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create access key: ${text}`);
  }

  const text = await response.text();

  // Parse access key from response XML
  const accessKeyIdMatch = text.match(/<AccessKeyId>([^<]+)<\/AccessKeyId>/);
  const secretAccessKeyMatch = text.match(/<SecretAccessKey>([^<]+)<\/SecretAccessKey>/);

  if (!accessKeyIdMatch || !secretAccessKeyMatch) {
    throw new Error("Failed to parse access key response");
  }

  return {
    accessKeyId: accessKeyIdMatch[1],
    secretAccessKey: secretAccessKeyMatch[1],
  };
}

/**
 * Generate S3 policy document for admin users with bucket-wide object access.
 *
 * Allows admins to:
 * - List all objects in the bucket
 * - Read, write, delete any object
 * - Access object versions
 *
 * Does NOT grant bucket management permissions (versioning config, policies, etc.)
 *
 * @param bucket - The S3 bucket name (without arn prefix)
 * @returns JSON-stringified IAM policy document ready for putUserPolicy
 * @throws Error if bucket name is empty
 */
export function generateAdminS3PolicyDocument(bucket: string): string {
  if (!bucket || bucket.trim() === "") {
    throw new Error("Bucket name is required for S3 policy generation");
  }

  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowListBucket",
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: `arn:aws:s3:::${bucket}`,
      },
      {
        Sid: "AllowFullBucketAccess",
        Effect: "Allow",
        Action: [...S3_DATASET_ACTIONS],
        Resource: `arn:aws:s3:::${bucket}/*`,
      },
    ],
  });
}

/**
 * Generate S3 policy document for a user's dataset prefixes
 */
export function generateS3PolicyDocument(bucket: string, prefixes: string[]): string {
  if (prefixes.length === 0) {
    // Minimal policy with explicit deny - AWS requires at least one statement
    return JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "DenyAllUntilDatasetCreated",
          Effect: "Deny",
          Action: "s3:*",
          Resource: "*",
        },
      ],
    });
  }

  const resources = prefixes.flatMap((prefix) => [
    `arn:aws:s3:::${bucket}/${prefix}`,
    `arn:aws:s3:::${bucket}/${prefix}/*`,
  ]);

  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowListBucket",
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: `arn:aws:s3:::${bucket}`,
        Condition: {
          StringLike: {
            "s3:prefix": prefixes.map((p) => `${p}/*`),
          },
        },
      },
      {
        Sid: "AllowReadWriteDatasetPrefixes",
        Effect: "Allow",
        Action: [...S3_DATASET_ACTIONS],
        Resource: resources,
      },
    ],
  });
}

/**
 * Update (put) inline policy for an IAM user
 */
export async function putUserPolicy(
  config: IamConfig,
  iamUsername: string,
  policyName: string,
  policyDocument: string,
): Promise<void> {
  const aws = createIamClient(config);

  const params = new URLSearchParams({
    Action: "PutUserPolicy",
    UserName: iamUsername,
    PolicyName: policyName,
    PolicyDocument: policyDocument,
    Version: "2010-05-08",
  });

  const response = await aws.fetch(`https://iam.amazonaws.com/?${params.toString()}`, {
    method: "POST",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to put user policy: ${text}`);
  }
}

/**
 * Delete an IAM user's access keys (for revocation)
 */
export async function deleteAccessKey(
  config: IamConfig,
  iamUsername: string,
  accessKeyId: string,
): Promise<void> {
  const aws = createIamClient(config);

  const params = new URLSearchParams({
    Action: "DeleteAccessKey",
    UserName: iamUsername,
    AccessKeyId: accessKeyId,
    Version: "2010-05-08",
  });

  const response = await aws.fetch(`https://iam.amazonaws.com/?${params.toString()}`, {
    method: "POST",
  });

  if (!response.ok) {
    const text = await response.text();
    // Ignore if key doesn't exist
    if (!text.includes("NoSuchEntity")) {
      throw new Error(`Failed to delete access key: ${text}`);
    }
  }
}

/**
 * Delete inline policy from an IAM user
 */
export async function deleteUserPolicy(
  config: IamConfig,
  iamUsername: string,
  policyName: string,
): Promise<void> {
  const aws = createIamClient(config);

  const params = new URLSearchParams({
    Action: "DeleteUserPolicy",
    UserName: iamUsername,
    PolicyName: policyName,
    Version: "2010-05-08",
  });

  const response = await aws.fetch(`https://iam.amazonaws.com/?${params.toString()}`, {
    method: "POST",
  });

  if (!response.ok) {
    const text = await response.text();
    // Ignore if policy doesn't exist
    if (!text.includes("NoSuchEntity")) {
      throw new Error(`Failed to delete user policy: ${text}`);
    }
  }
}

/**
 * Delete an IAM user (for complete revocation)
 */
export async function deleteIamUser(config: IamConfig, iamUsername: string): Promise<void> {
  const aws = createIamClient(config);

  const params = new URLSearchParams({
    Action: "DeleteUser",
    UserName: iamUsername,
    Version: "2010-05-08",
  });

  const response = await aws.fetch(`https://iam.amazonaws.com/?${params.toString()}`, {
    method: "POST",
  });

  if (!response.ok) {
    const text = await response.text();
    // Ignore if user doesn't exist
    if (!text.includes("NoSuchEntity")) {
      throw new Error(`Failed to delete IAM user: ${text}`);
    }
  }
}

/**
 * Full setup for a new NEMAR user:
 * 1. Create IAM user
 * 2. Create access keys
 * 3. Put initial empty policy
 */
export async function setupUserIamAccess(
  config: IamConfig,
  bucket: string,
  nemarUsername: string,
): Promise<{ iamUsername: string; accessKeyId: string; secretAccessKey: string }> {
  // Create IAM user
  const { username: iamUsername } = await createIamUser(config, nemarUsername);

  // Create access keys
  const { accessKeyId, secretAccessKey } = await createAccessKey(config, iamUsername);

  // Put initial empty policy (no dataset access yet)
  const policyDocument = generateS3PolicyDocument(bucket, []);
  await putUserPolicy(config, iamUsername, "nemar-s3-access", policyDocument);

  return { iamUsername, accessKeyId, secretAccessKey };
}

/**
 * Grant user access to a dataset prefix
 */
export async function grantDatasetAccess(
  config: IamConfig,
  bucket: string,
  iamUsername: string,
  currentPrefixes: string[],
  newPrefix: string,
): Promise<string[]> {
  const allPrefixes = [...new Set([...currentPrefixes, newPrefix])];
  const policyDocument = generateS3PolicyDocument(bucket, allPrefixes);
  await putUserPolicy(config, iamUsername, "nemar-s3-access", policyDocument);
  return allPrefixes;
}

/**
 * List all access keys for an IAM user
 */
async function listAccessKeys(config: IamConfig, iamUsername: string): Promise<string[]> {
  const aws = createIamClient(config);

  const params = new URLSearchParams({
    Action: "ListAccessKeys",
    UserName: iamUsername,
    Version: "2010-05-08",
  });

  const response = await aws.fetch(`https://iam.amazonaws.com/?${params.toString()}`, {
    method: "POST",
  });

  if (!response.ok) {
    const text = await response.text();
    // If user doesn't exist, return empty array
    if (text.includes("NoSuchEntity")) {
      return [];
    }
    throw new Error(`Failed to list access keys: ${text}`);
  }

  const text = await response.text();

  // Parse access key IDs from XML response
  const accessKeyIds: string[] = [];
  const regex = /<AccessKeyId>([^<]+)<\/AccessKeyId>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    accessKeyIds.push(match[1]);
  }

  return accessKeyIds;
}

/**
 * Revoke all IAM access for a user (AGGRESSIVE - uses owner credentials)
 *
 * This function uses owner-level credentials to forcefully clean up ALL IAM resources
 * for a user. It continues on errors and returns detailed results about what succeeded/failed.
 *
 * Steps:
 * 1. List ALL access keys (user might have created extras)
 * 2. Delete ALL access keys found
 * 3. Delete user policy
 * 4. Delete IAM user
 *
 * @returns Object with success status and detailed error information
 */
export async function revokeUserIamAccess(
  config: IamConfig,
  iamUsername: string,
  accessKeyId: string,
): Promise<{ success: boolean; errors: string[]; steps: string[] }> {
  const errors: string[] = [];
  const steps: string[] = [];

  // Step 1: List all access keys (not just the one we stored)
  let allAccessKeyIds: string[] = [];
  try {
    allAccessKeyIds = await listAccessKeys(config, iamUsername);
    steps.push(`Found ${allAccessKeyIds.length} access key(s) for ${iamUsername}`);

    // Make sure we include the one we know about (in case list fails partially)
    if (accessKeyId && !allAccessKeyIds.includes(accessKeyId)) {
      allAccessKeyIds.push(accessKeyId);
      steps.push(`Added known access key ${accessKeyId} to deletion list`);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    errors.push(`Failed to list access keys: ${errorMsg}`);
    steps.push("Proceeding with known access key only");
    // Fallback to the one we know about
    allAccessKeyIds = [accessKeyId];
  }

  // Step 2: Delete ALL access keys (force removal of S3 access)
  let keysDeleted = 0;
  for (const keyId of allAccessKeyIds) {
    try {
      await deleteAccessKey(config, iamUsername, keyId);
      keysDeleted++;
      steps.push(`✓ Deleted access key ${keyId}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push(`Failed to delete access key ${keyId}: ${errorMsg}`);
      steps.push(`✗ Failed to delete access key ${keyId}`);
    }
  }

  // Step 3: Delete user policy (remove S3 permissions)
  try {
    await deleteUserPolicy(config, iamUsername, "nemar-s3-access");
    steps.push("✓ Deleted user policy");
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    errors.push(`Failed to delete user policy: ${errorMsg}`);
    steps.push("✗ Failed to delete user policy");
  }

  // Step 4: Delete IAM user (complete cleanup)
  try {
    await deleteIamUser(config, iamUsername);
    steps.push("✓ Deleted IAM user");
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    errors.push(`Failed to delete IAM user: ${errorMsg}`);
    steps.push("✗ Failed to delete IAM user");
  }

  // Success if we deleted at least one access key (most critical for security)
  const success = keysDeleted > 0 || errors.length === 0;

  return { success, errors, steps };
}
