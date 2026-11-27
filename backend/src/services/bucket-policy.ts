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
 * Compaction (#2497): the private set did not stay small. On 2026-11-27 the
 * live statement carried 628 entries and the policy was 20,431 of 20,480
 * bytes, so every new dataset's carve-out was refused. The carve-out list is
 * therefore written in a canonical compacted form computed from the set of
 * private ids:
 *
 *  - when all ten ids of a decade are private (`nm000540`..`nm000549`), one
 *    entry `arn:aws:s3:::<bucket>/nm00054?/*` replaces them (an S3 ARN `?`
 *    matches exactly one character);
 *  - when all ten decades of a hundred are private, one entry
 *    `.../nm0005??/*` replaces them.
 *
 * A wildcard is only ever written over ids that are themselves all private,
 * and never with `*` inside the id. Reading expands both forms back into the
 * id set, so every reader (`listPrivateDatasets`, `isDatasetPrivate`,
 * `derivePublicPrefixes`) sees a covered id as private. Every write goes
 * through `buildPublicAccessStatement`, so the first write after deploy
 * compacts the whole list. ADR 0145 records the numbers and the capacity.
 *
 * These functions are pure transforms over the policy document (no network),
 * so they are unit-testable. The S3 get/put wrappers live in s3.ts.
 */

type PolicyPrincipal = "*" | { [key: string]: string | string[] };
type PolicyCondition = Record<string, Record<string, string | string[]>>;

interface BasePolicyStatement {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Principal?: PolicyPrincipal;
  Action: string | string[];
  Condition?: PolicyCondition;
}

/**
 * A bucket-policy statement. AWS rejects a statement that sets both `Resource`
 * and `NotResource` (MalformedPolicy), so the type makes them mutually
 * exclusive: every statement carries exactly one of them.
 */
export type PolicyStatement =
  | (BasePolicyStatement & { Resource: string | string[]; NotResource?: never })
  | (BasePolicyStatement & { NotResource: string | string[]; Resource?: never });

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
 * Shape of a dataset id the compaction may group: two lowercase letters and
 * six digits (`nm000540`, `on004350`, `xx090001`). An id of any other shape is
 * still carved out, but only ever as an explicit entry.
 */
const COMPACTABLE_ID = /^[a-z]{2}\d{6}$/;
/** `nm00054?`: the ten ids `nm000540`..`nm000549`. */
const DECADE_WILDCARD = /^([a-z]{2}\d{5})\?$/;
/** `nm0005??`: the hundred ids `nm000500`..`nm000599`. */
const HUNDRED_WILDCARD = /^([a-z]{2}\d{4})\?\?$/;

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/** The carve-out of a public-read statement, read back into an id set. */
interface CarveOut {
  /** Every private dataset id, with wildcard entries expanded. */
  ids: Set<string>;
  /**
   * Entries kept verbatim because they are neither `staging` nor a dataset
   * id nor a wildcard this module writes (a hand-added ARN, another bucket's
   * ARN, a `*` pattern). Kept so a rewrite never widens public access.
   */
  opaque: string[];
}

function readCarveOut(policy: BucketPolicy | null, bucket: string): CarveOut {
  const ids = new Set<string>();
  const opaque: string[] = [];
  if (!policy) return { ids, opaque };
  const stmt = policy.Statement.find((s) => s.Sid === PUBLIC_ACCESS_SID);
  if (!stmt) return { ids, opaque };
  for (const arn of toArray(stmt.NotResource)) {
    const id = prefixIdFromArn(bucket, arn);
    if (id === STAGING_PREFIX) continue; // always re-added by the builder
    if (id === null) {
      opaque.push(arn);
      continue;
    }
    const decade = DECADE_WILDCARD.exec(id);
    if (decade) {
      for (const d of DIGITS) ids.add(`${decade[1]}${d}`);
      continue;
    }
    const hundred = HUNDRED_WILDCARD.exec(id);
    if (hundred) {
      for (const d1 of DIGITS) for (const d2 of DIGITS) ids.add(`${hundred[1]}${d1}${d2}`);
      continue;
    }
    if (id.includes("?") || id.includes("*")) {
      opaque.push(arn);
      continue;
    }
    ids.add(id);
  }
  return { ids, opaque };
}

/**
 * Compact a set of private ids into carve-out prefixes: a full decade becomes
 * `<id minus last digit>?`, ten full decades of a hundred become
 * `<id minus last two digits>??`, every other id stays explicit. Output is
 * sorted. A wildcard is emitted only when every id it matches is in `ids`.
 */
export function compactPrivateIds(ids: Iterable<string>): string[] {
  const unique = [...new Set(ids)];
  const explicit: string[] = [];
  const byDecade = new Map<string, number>();
  for (const id of unique) {
    if (COMPACTABLE_ID.test(id)) {
      const key = id.slice(0, -1);
      byDecade.set(key, (byDecade.get(key) ?? 0) + 1);
    }
  }
  const fullDecades = new Set([...byDecade].filter(([, n]) => n === 10).map(([k]) => k));
  const byHundred = new Map<string, number>();
  for (const decade of fullDecades) {
    const key = decade.slice(0, -1);
    byHundred.set(key, (byHundred.get(key) ?? 0) + 1);
  }
  const fullHundreds = new Set([...byHundred].filter(([, n]) => n === 10).map(([k]) => k));

  const out = new Set<string>();
  for (const id of unique) {
    if (!COMPACTABLE_ID.test(id)) {
      explicit.push(id);
      continue;
    }
    const decade = id.slice(0, -1);
    const hundred = id.slice(0, -2);
    if (fullHundreds.has(hundred)) out.add(`${hundred}??`);
    else if (fullDecades.has(decade)) out.add(`${decade}?`);
    else out.add(id);
  }
  for (const id of explicit) out.add(id);
  return [...out].sort();
}

/**
 * Build the single public-read statement for a given set of private dataset
 * ids, in the canonical compacted form (see the file header). The `staging/`
 * prefix is always excluded first; `opaque` entries (unrecognized ARNs read
 * from a live policy) are appended verbatim.
 */
export function buildPublicAccessStatement(
  bucket: string,
  privateDatasetIds: Iterable<string>,
  opaque: Iterable<string> = [],
): PolicyStatement {
  const notResource = [
    prefixArn(bucket, STAGING_PREFIX),
    ...compactPrivateIds(privateDatasetIds).map((id) => prefixArn(bucket, id)),
    ...[...new Set(opaque)].sort(),
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
 * statement, sorted, with wildcard entries (`nm00054?`, `nm0005??`) expanded
 * into the ids they cover. Returns an empty array if the statement is absent.
 *
 * Reads only the `NotResource` list of the `PUBLIC_ACCESS_SID` statement and
 * ignores its `Effect`/`Principal`. This is intentional and self-healing:
 * `addPrivateDataset` / `removePrivateDataset` always rewrite the statement to
 * the canonical `Allow Principal:* GetObject` form via
 * `buildPublicAccessStatement`, so a hand-edited live policy is corrected on
 * the next transition.
 */
export function listPrivateDatasets(policy: BucketPolicy | null, bucket: string): string[] {
  return [...readCarveOut(policy, bucket).ids].sort();
}

/**
 * Derive the set of prefixes that are publicly readable under a given policy,
 * used by the one-time migration to preserve equal access.
 *
 * Handles both shapes so the migration is idempotent:
 *  - an already-migrated policy (has the `PUBLIC_ACCESS_SID` NotResource
 *    statement): public = every prefix not carved out as private,
 *  - a legacy allow-list policy (per-dataset `Allow Principal:* GetObject`
 *    statements): public = the datasets named by those statements' resources.
 *
 * `null` policy means nothing is public.
 */
export function derivePublicPrefixes(
  policy: BucketPolicy | null,
  bucket: string,
  allPrefixes: string[],
): Set<string> {
  const pub = new Set<string>();
  if (!policy) return pub;

  for (const s of policy.Statement) {
    if (s.Sid === PUBLIC_ACCESS_SID) {
      // Already migrated: public = everything not carved out as private.
      const priv = new Set(listPrivateDatasets(policy, bucket));
      for (const p of allPrefixes) {
        if (p !== STAGING_PREFIX && !priv.has(p)) pub.add(p);
      }
      continue;
    }

    const principalIsPublic =
      s.Principal === "*" ||
      (typeof s.Principal === "object" &&
        s.Principal !== null &&
        Object.values(s.Principal).some((v) => v === "*" || (Array.isArray(v) && v.includes("*"))));
    const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
    if (s.Effect === "Allow" && principalIsPublic && actions.includes("s3:GetObject")) {
      for (const r of toArray(s.Resource)) {
        const id = prefixIdFromArn(bucket, r);
        if (id !== null && id !== STAGING_PREFIX) pub.add(id);
      }
    }
  }
  return pub;
}

/** True if the dataset's prefix is carved out (private) in the policy. */
export function isDatasetPrivate(
  policy: BucketPolicy | null,
  bucket: string,
  datasetId: string,
): boolean {
  return readCarveOut(policy, bucket).ids.has(datasetId);
}

/**
 * Return a policy whose public-read statement reflects the given private set,
 * compacted. Preserves every other statement (operates only on
 * PUBLIC_ACCESS_SID), the statement's opaque entries, and always keeps
 * `staging/` excluded.
 */
function withPrivateSet(
  policy: BucketPolicy | null,
  bucket: string,
  privateIds: Iterable<string>,
): BucketPolicy {
  const statement = buildPublicAccessStatement(
    bucket,
    privateIds,
    readCarveOut(policy, bucket).opaque,
  );
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

/**
 * The policy the one-time migration (`scripts/migrate-s3-public-policy.ts`)
 * writes: the public-read statement for `privateIds`, keeping the live
 * statement's opaque carve-out entries (a rewrite never widens public access),
 * followed by the `preserved` statements.
 */
export function buildMigratedPolicy(
  current: BucketPolicy | null,
  bucket: string,
  privateIds: Iterable<string>,
  preserved: PolicyStatement[],
): BucketPolicy {
  return {
    Version: current?.Version ?? POLICY_VERSION,
    Statement: [
      buildPublicAccessStatement(bucket, privateIds, readCarveOut(current, bucket).opaque),
      ...preserved,
    ],
  };
}

/** Add a dataset to the private carve-out (make its objects non-public). Idempotent. */
export function addPrivateDataset(
  policy: BucketPolicy | null,
  bucket: string,
  datasetId: string,
): BucketPolicy {
  const { ids } = readCarveOut(policy, bucket);
  ids.add(datasetId);
  return withPrivateSet(policy, bucket, ids);
}

/**
 * Remove a dataset from the private carve-out (make its objects public).
 * Idempotent. When the id is covered by a wildcard, the wildcard is expanded
 * into its ids, this one is dropped, and the rest are recompacted, so the
 * other ids of the decade stay private.
 */
export function removePrivateDataset(
  policy: BucketPolicy | null,
  bucket: string,
  datasetId: string,
): BucketPolicy {
  const { ids } = readCarveOut(policy, bucket);
  ids.delete(datasetId);
  return withPrivateSet(policy, bucket, ids);
}

/** Serialized byte size of a policy document (UTF-8), for the 20KB cap check. */
export function policyByteSize(policy: BucketPolicy): number {
  return new TextEncoder().encode(JSON.stringify(policy)).length;
}

/** Fraction of the cap above which a write logs `POLICY_NEAR_CAP_TAG`. */
export const POLICY_WARN_FRACTION = 0.8;

/** Stable log tag for a bucket policy written above `POLICY_WARN_FRACTION` of the cap. */
export const POLICY_NEAR_CAP_TAG = "[bucket-policy:near-cap]";

/** Stable log tag for a dataset creation refused because the policy is full. */
export const POLICY_FULL_TAG = "[bucket-policy:full]";

/**
 * Length of the id used to price one more carve-out: the allocator's ids are
 * two letters and six digits.
 */
const NEW_ID_LENGTH = 8;

/**
 * Whether one more private dataset fits under the cap, checked before a new
 * dataset is created (#2497). Prices the worst case, one more explicit entry
 * on top of the canonical compacted policy: a real id can only cost that much
 * or less (completing a decade makes the policy smaller). The placeholder
 * never matches the compactable id shape, so it is always explicit.
 */
export function hasHeadroomForNewDataset(
  policy: BucketPolicy | null,
  bucket: string,
): { ok: boolean; bytes: number } {
  const next = addPrivateDataset(policy, bucket, "~".repeat(NEW_ID_LENGTH));
  const bytes = policyByteSize(next);
  return { ok: bytes <= MAX_BUCKET_POLICY_BYTES, bytes };
}

/** True when a policy of `bytes` bytes is above `POLICY_WARN_FRACTION` of the cap. */
export function isPolicyNearCap(bytes: number): boolean {
  return bytes > MAX_BUCKET_POLICY_BYTES * POLICY_WARN_FRACTION;
}
