/**
 * The shapes a re-pull checks where it READS a value that later becomes a URL, a host, a ref, a
 * branch name, a path or an S3 call (ADR 0111; epic #1046, the round 1 review of the epic's pull
 * request, finding C5).
 *
 * Two places hand the re-pull values nobody on this machine wrote: the dataset's own `remote.log`
 * (the bucket and the region of `nemar-s3`, which the write guard then treats as the only
 * destination and the annex-uuid read builds a host from) and the plan file (the dataset ids, the
 * tags and the versions, which execution turns into a clone URL, a ref, `release/v<N.0.0>` and
 * the S3 keys of the staging manifest). The plan file is digest-checked, but a digest proves the
 * file is the one that was reviewed, not that what it says is a value a URL or a ref can carry.
 * So each value is checked against the shape it must have at the read, and a value that does not
 * have it is refused with a message that names the field and the shape, never the value.
 *
 * Pure: no I/O. The tag is the one definition the Worker, the workflow and the CLI's `--tag`
 * already share (`isOpenNeuroTag`), and the version is the one the Worker's create route holds
 * (`NEMAR_VERSION_RE`); the rest are written here.
 */

import { isOpenNeuroTag } from "../../../shared/openneuro-tag.js";
import { NEMAR_VERSION_RE } from "../../../shared/repull-state.js";

export { isOpenNeuroTag };

/** An OpenNeuro dataset id: `ds` and six digits (`ds004362`). */
export function isOpenNeuroDatasetId(value: unknown): value is string {
  return typeof value === "string" && /^ds\d{6}$/.test(value);
}

/** A NEMAR dataset id: two lowercase letters and six digits (`on004362`, `xx099991`). */
export function isNemarDatasetId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z]{2}\d{6}$/.test(value);
}

/** A NEMAR version as a re-pull records it: `N.N.N`, with no prefix and no suffix. */
export function isNemarVersion(value: unknown): value is string {
  return typeof value === "string" && NEMAR_VERSION_RE.test(value);
}

/**
 * An AWS region name as an S3 host has it: `us-east-2`, `eu-central-1`, `us-gov-west-1`. The
 * region is a label of the host `<bucket>.s3.<region>.amazonaws.com`, so a value with a dot, a
 * slash, a `#` or a `@` could name another host, and an empty one names none.
 */
export function isAwsRegion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && /^[a-z]{2}(-[a-z]+)+-\d+$/.test(value);
}

/**
 * An S3 bucket name by S3's own rule: 3 to 63 characters, lowercase letters, digits, dots and
 * hyphens, beginning and ending with a letter or a digit, with no two dots together and not
 * shaped like an IPv4 address. The bucket is a label of the same host, so the rule keeps a `/`, a
 * `#`, a `?`, an `@` and a `:` out of it.
 */
export function isS3BucketName(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 3 || value.length > 63) return false;
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value)) return false;
  return !value.includes("..") && !/^\d+\.\d+\.\d+\.\d+$/.test(value);
}

/**
 * Why the bucket or the region `remote.log` names for `nemar-s3` cannot be used, or null when
 * neither is malformed. A bucket that is absent is not malformed here: "names no single nemar-s3
 * bucket" is the callers' own refusal. The words name the fields and the rule, never the value.
 */
export function s3RemoteProblem(bucket: string | undefined, region: string): string | null {
  if (bucket !== undefined && !isS3BucketName(bucket)) {
    return "NEMAR's remote.log names a nemar-s3 bucket that is not an S3 bucket name (3 to 63 lowercase letters, digits, dots and hyphens), so it is not used.";
  }
  if (!isAwsRegion(region)) {
    return "NEMAR's remote.log names a nemar-s3 datacenter that is not an AWS region name (like us-east-2), so it is not used.";
  }
  return null;
}
