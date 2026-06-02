/**
 * Pure bucket-policy algebra for the public-by-default (deny-list) access model.
 *
 * History: the bucket used an *allow-list* policy that appended one
 * `Allow Principal:* s3:GetObject arn:.../<id>/*` statement per *published*
 * dataset. That hit AWS's hard 20,480-byte bucket-policy cap once ~149
 * datasets were public, blocking all further publishing (see #673).
 *
 * New model: the bucket is public-by-default via a single statement that
 * grants anonymous `s3:GetObject` on everything EXCEPT a small, explicitly
 * listed set of *private* prefixes (and the `staging/` upload area):
 *
 *   { "Sid": "PublicReadExceptPrivate", "Effect": "Allow", "Principal": "*",
 *     "Action": "s3:GetObject",
 *     "NotResource": ["arn:aws:s3:::<bucket>/staging/*",
 *                     "arn:aws:s3:::<bucket>/<privateId>/*", ...] }
 *
 * Why NotResource and not an explicit per-private `Deny`: an explicit `Deny`
 * with `Principal:*` overrides IAM identity-based Allows, which would break
 * the backend's and each user's *own* signed reads of private objects. With
 * NotResource, private prefixes simply receive no anonymous grant and remain
 * governed by the existing per-user / admin IAM identity policies — exactly
 * as before. Only the anonymous default flips from deny to allow. This policy
 * scales with the (small, short-lived) private set instead of the unbounded
 * public set.
 *
 * These functions are pure transforms over the policy document (no network),
 * so they are unit-testable. The S3 get/put wrappers live in s3.ts.
 */

export interface PolicyStatement {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Principal?: "*" | { [key: string]: string | string[] };
  Action: string | string[];
  Resource?: string | string[];
  NotResource?: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

export interface BucketPolicy {
  Version: string;
  Statement: PolicyStatement[];
}

/** Sid of the single public-read statement. */
export const PUBLIC_ACCESS_SID = "PublicReadExceptPrivate";

/** Top-level prefix used for in-flight PR upload staging (never public). */
export const STAGING_PREFIX = "staging";

/** AWS hard limit on a bucket policy document, in bytes. */
export const MAX_BUCKET_POLICY_BYTES = 20480;

const POLICY_VERSION = "2012-10-17";

function bucketArn(bucket: string, suffix: string): string {
  return `arn:aws:s3:::${bucket}/${suffix}`;
}

/** ARN pattern matching every object under a dataset (or staging) prefix. */
export function prefixArn(bucket: string, prefix: string): string {
  return bucketArn(bucket, `${prefix}/*`);
}

/** Parse a prefix id back out of a `arn:aws:s3:::<bucket>/<id>/*` resource. */
export function prefixIdFromArn(bucket: string, arn: string): string | null {
  const head = `arn:aws:s3:::${bucket}/`;
  if (!arn.startsWith(head) || !arn.endsWith("/*")) return null;
  const id = arn.slice(head.length, -"/*".length);
  if (id === "" || id.includes("/")) return null;
  return id;
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...value] : [value];
}

/**
 * Build the single public-read statement for a given set of private dataset
 * ids. The `staging/` prefix is always excluded. The private ARNs are sorted
 * for stable, diff-friendly output.
 */
export function buildPublicAccessStatement(
  bucket: string,
  privateDatasetIds: Iterable<string>,
): PolicyStatement {
  const ids = [...new Set(privateDatasetIds)].sort();
  const notResource = [
    prefixArn(bucket, STAGING_PREFIX),
    ...ids.map((id) => prefixArn(bucket, id)),
  ];
  return {
    Sid: PUBLIC_ACCESS_SID,
    Effect: "Allow",
    Principal: "*",
    Action: "s3:GetObject",
    NotResource: notResource,
  };
}

/** Build a complete public-access policy from a set of private dataset ids. */
export function buildPublicAccessPolicy(
  bucket: string,
  privateDatasetIds: Iterable<string>,
): BucketPolicy {
  return {
    Version: POLICY_VERSION,
    Statement: [buildPublicAccessStatement(bucket, privateDatasetIds)],
  };
}

/**
 * Read the set of private dataset ids out of an existing policy's public-read
 * statement. Returns an empty array if the statement is absent.
 */
export function listPrivateDatasets(policy: BucketPolicy | null, bucket: string): string[] {
  if (!policy) return [];
  const stmt = policy.Statement.find((s) => s.Sid === PUBLIC_ACCESS_SID);
  if (!stmt) return [];
  const ids: string[] = [];
  for (const arn of toArray(stmt.NotResource)) {
    const id = prefixIdFromArn(bucket, arn);
    if (id !== null && id !== STAGING_PREFIX) ids.push(id);
  }
  return ids;
}

/** True if the dataset's prefix is carved out (private) in the policy. */
export function isDatasetPrivate(
  policy: BucketPolicy | null,
  bucket: string,
  datasetId: string,
): boolean {
  return listPrivateDatasets(policy, bucket).includes(datasetId);
}

/**
 * Return a policy whose public-read statement reflects the given private set.
 * Preserves every other statement (operates only on PUBLIC_ACCESS_SID) and
 * always keeps `staging/` excluded.
 */
function withPrivateSet(
  policy: BucketPolicy | null,
  bucket: string,
  privateIds: Iterable<string>,
): BucketPolicy {
  const statement = buildPublicAccessStatement(bucket, privateIds);
  if (!policy) {
    return { Version: POLICY_VERSION, Statement: [statement] };
  }
  const others = policy.Statement.filter((s) => s.Sid !== PUBLIC_ACCESS_SID);
  return {
    Version: policy.Version || POLICY_VERSION,
    Statement: [statement, ...others],
  };
}

/**
 * Ensure the public-read statement exists (creating it with `staging/`
 * excluded if missing), without changing the private set otherwise.
 */
export function ensurePublicAccessStatement(
  policy: BucketPolicy | null,
  bucket: string,
): BucketPolicy {
  return withPrivateSet(policy, bucket, listPrivateDatasets(policy, bucket));
}

/** Add a dataset to the private carve-out (make its objects non-public). Idempotent. */
export function addPrivateDataset(
  policy: BucketPolicy | null,
  bucket: string,
  datasetId: string,
): BucketPolicy {
  const ids = new Set(listPrivateDatasets(policy, bucket));
  ids.add(datasetId);
  return withPrivateSet(policy, bucket, ids);
}

/** Remove a dataset from the private carve-out (make its objects public). Idempotent. */
export function removePrivateDataset(
  policy: BucketPolicy | null,
  bucket: string,
  datasetId: string,
): BucketPolicy {
  const ids = new Set(listPrivateDatasets(policy, bucket));
  ids.delete(datasetId);
  return withPrivateSet(policy, bucket, ids);
}

/** Serialized byte size of a policy document (UTF-8), for the 20KB cap check. */
export function policyByteSize(policy: BucketPolicy): number {
  return new TextEncoder().encode(JSON.stringify(policy)).length;
}
