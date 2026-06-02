#!/usr/bin/env bun
/**
 * One-time migration: convert the nemar bucket policy from the legacy
 * allow-list (one `Allow PublicReadDataset_<id>` per *public* dataset, which
 * hit AWS's 20,480-byte cap at ~149 datasets) to the public-by-default
 * deny-list model (a single `Allow Principal:* s3:GetObject` with a
 * NotResource carve-out for `staging/` and every *private* dataset). See #673.
 *
 * Equal access is preserved exactly:
 *   - every dataset that is publicly readable today stays public,
 *   - every dataset that is private today stays private (no anonymous grant;
 *     reads keep flowing through the existing IAM identity policies).
 *
 * Source of truth for "currently public" is the LIVE bucket policy, not D1.
 *
 * Usage:
 *   ./scripts/migrate-s3-public-policy.ts            # dry run (default)
 *   ./scripts/migrate-s3-public-policy.ts --apply    # write the new policy
 *   ./scripts/migrate-s3-public-policy.ts --bucket nemar --apply
 *
 * Requires the `aws` CLI on PATH with credentials that can get/put the bucket
 * policy and list objects (the NEMAR S3 admin credentials). Idempotent:
 * re-running after a successful migration is a no-op reconcile.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  type BucketPolicy,
  type PolicyStatement,
  buildPublicAccessStatement,
  derivePublicPrefixes,
  listPrivateDatasets,
  MAX_BUCKET_POLICY_BYTES,
  policyByteSize,
  PUBLIC_ACCESS_SID,
  STAGING_PREFIX,
  isDatasetPrivate,
} from "../backend/src/services/bucket-policy.ts";

const POLICY_VERSION = "2012-10-17";
const LEGACY_SID_PREFIX = "PublicReadDataset_";

interface Args {
  bucket: string;
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { bucket: "nemar", apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--bucket") args.bucket = argv[++i] ?? args.bucket;
    else if (a === "--help" || a === "-h") {
      console.log("Usage: migrate-s3-public-policy.ts [--bucket nemar] [--apply]");
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function aws(args: string[]): string {
  return execFileSync("aws", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function getCurrentPolicy(bucket: string): BucketPolicy | null {
  try {
    const out = aws([
      "s3api",
      "get-bucket-policy",
      "--bucket",
      bucket,
      "--query",
      "Policy",
      "--output",
      "text",
    ]);
    return JSON.parse(out.trim());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/NoSuchBucketPolicy/.test(msg)) return null;
    throw err;
  }
}

function listTopLevelPrefixes(bucket: string): string[] {
  const out = aws([
    "s3api",
    "list-objects-v2",
    "--bucket",
    bucket,
    "--delimiter",
    "/",
    "--query",
    "CommonPrefixes[].Prefix",
    "--output",
    "text",
  ]);
  return out
    .split(/\s+/)
    .map((p) => p.trim().replace(/\/$/, ""))
    .filter((p) => p.length > 0);
}

/**
 * Statements that are neither the new public-read statement nor a legacy
 * per-dataset `Allow` carve-out (e.g. an unrelated cross-account grant or a
 * Deny). The migration must preserve these verbatim rather than drop them.
 */
function basePolicyStatements(policy: BucketPolicy | null): PolicyStatement[] {
  if (!policy) return [];
  return policy.Statement.filter(
    (s) => s.Sid !== PUBLIC_ACCESS_SID && !(s.Sid?.startsWith(LEGACY_SID_PREFIX) ?? false),
  );
}

function main(): void {
  const { bucket, apply } = parseArgs(process.argv.slice(2));

  console.log(`Bucket: ${bucket}`);
  console.log(`Mode:   ${apply ? "APPLY (will write the new policy)" : "dry run"}`);
  console.log("");

  const current = getCurrentPolicy(bucket);
  const allPrefixes = listTopLevelPrefixes(bucket).sort();
  const publicSet = derivePublicPrefixes(current, bucket, allPrefixes);

  // Anything that is not currently public becomes a private carve-out. This is
  // the strict equal-access rule: anonymous callers that could not read a
  // prefix before still cannot after. `staging/` is excluded by the base
  // statement, so drop it from the per-dataset list.
  const privateIds = allPrefixes.filter((p) => p !== STAGING_PREFIX && !publicSet.has(p));

  // Preserve any unrelated statements that already exist on the live policy.
  const preserved = basePolicyStatements(current);
  const newPolicy: BucketPolicy = {
    Version: current?.Version ?? POLICY_VERSION,
    Statement: [buildPublicAccessStatement(bucket, privateIds), ...preserved],
  };
  const size = policyByteSize(newPolicy);

  console.log(`Top-level prefixes : ${allPrefixes.length}`);
  console.log(`Currently public   : ${publicSet.size}`);
  console.log(`Private carve-outs : ${privateIds.length} (+ staging)`);
  console.log(`Preserved statements: ${preserved.length}`);
  console.log(`New policy size    : ${size} / ${MAX_BUCKET_POLICY_BYTES} bytes`);
  console.log("");

  // Invariant checks: equal access preserved, size under cap.
  const violations: string[] = [];
  for (const id of publicSet) {
    if (isDatasetPrivate(newPolicy, bucket, id)) {
      violations.push(`PUBLIC->private regression: ${id}`);
    }
  }
  for (const id of privateIds) {
    if (!isDatasetPrivate(newPolicy, bucket, id)) {
      violations.push(`PRIVATE not carved out: ${id}`);
    }
  }
  if (size > MAX_BUCKET_POLICY_BYTES) {
    violations.push(`policy ${size} bytes exceeds the ${MAX_BUCKET_POLICY_BYTES}-byte cap`);
  }

  const nonStandard = privateIds.filter((p) => !/^(nm|on|xx)\d{6}$/.test(p));
  if (nonStandard.length > 0) {
    console.log(
      `Note: carving out ${nonStandard.length} non-dataset-shaped prefix(es): ${nonStandard.join(", ")}`,
    );
    console.log("");
  }

  console.log(
    `Sample private carve-outs: ${privateIds.slice(0, 10).join(", ")}${privateIds.length > 10 ? " ..." : ""}`,
  );
  console.log("");

  if (violations.length > 0) {
    console.error("INVARIANT CHECK FAILED:");
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log("Invariant check PASSED (equal access preserved, under size cap).");
  console.log("");

  if (!apply) {
    console.log("Dry run complete. Re-run with --apply to write the policy.");
    console.log("New policy preview:");
    console.log(JSON.stringify(newPolicy, null, 2));
    return;
  }

  const tmp = `/tmp/nemar-bucket-policy-${bucket}.json`;
  writeFileSync(tmp, JSON.stringify(newPolicy));
  try {
    aws(["s3api", "put-bucket-policy", "--bucket", bucket, "--policy", `file://${tmp}`]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to write the new policy to S3: ${msg}`);
    console.error(
      `The intended policy is at ${tmp}; the bucket is UNCHANGED (old policy still active).`,
    );
    process.exit(1);
  }
  console.log("Policy written. Verifying read-back...");

  const after = getCurrentPolicy(bucket);
  if (after === null) {
    console.error("VERIFY FAILED: could not read the policy back after writing (got null).");
    console.error("Check GetBucketPolicy permissions and the live policy manually.");
    process.exit(1);
  }
  const afterPrivate = new Set(listPrivateDatasets(after, bucket));
  const intended = new Set(privateIds);
  const missing = [...intended].filter((id) => !afterPrivate.has(id));
  const extra = [...afterPrivate].filter((id) => !intended.has(id));
  if (missing.length > 0 || extra.length > 0) {
    console.error("VERIFY FAILED: read-back private set does not match the intended set.");
    if (missing.length > 0) {
      console.error(`  LEAKED (expected private, not carved out): ${missing.join(", ")}`);
      console.error("  IMMEDIATE ACTION: check anonymous access to the above prefixes.");
    }
    if (extra.length > 0) {
      console.error(`  EXTRA (carved out but not intended): ${extra.join(", ")}`);
    }
    process.exit(1);
  }
  console.log(`Verified: ${afterPrivate.size} private carve-outs live. Migration complete.`);
}

main();
