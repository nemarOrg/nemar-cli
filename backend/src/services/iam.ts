/**
 * Revoking the per-user IAM access NEMAR no longer provisions.
 *
 * Every user used to get an IAM user with an inline policy over their dataset
 * prefixes; that was replaced by per-request STS credentials the Worker federates
 * (`services/sts.ts`), which is why `test/iam-removal.test.ts` exists. The
 * provisioning half of this module was left behind with no call sites, including two
 * policy generators, and #1380 spent a day suspecting an identity policy that no
 * code here writes -- so it is gone rather than dormant.
 *
 * What remains is revocation, which still has work to do: accounts provisioned under
 * the old scheme carry an `aws_iam_username` in D1 and an IAM user in the account,
 * and revoking or deleting such an account has to take both away.
 */

import { AwsClient } from "aws4fetch";

interface IamConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
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
 * List all access keys for an IAM user
 */
export async function listAccessKeys(config: IamConfig, iamUsername: string): Promise<string[]> {
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
  let match: RegExpExecArray | null = regex.exec(text);

  while (match !== null) {
    accessKeyIds.push(match[1]);
    match = regex.exec(text);
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
