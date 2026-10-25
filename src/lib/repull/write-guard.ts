/**
 * The write guard of a re-pull's execution (ADR 0111, decisions 2 and 8; epic #1046 phase 6).
 *
 * Every git push and every `aws s3api` call execution makes after `prepared` goes through one of
 * the two assertions here, which allow a closed list of forms and refuse everything else before the
 * process starts:
 *
 * A push goes only to `origin`, one refspec at a time, and only to:
 *  - `<sha>:refs/heads/release/v<V>` for a version `V` of this re-pull (a fast-forward or a new
 *    branch, never forced);
 *  - `<sha>:refs/heads/git-annex` (the registration commit, a fast-forward of origin's branch);
 *  - `--delete refs/heads/release/v<V>` (abandoning a re-pull's own branch);
 *  - `--force-with-lease=refs/heads/release/v<V>:<sha> <sha>:refs/heads/release/v<V>` (a release
 *    branch re-synthesized onto a moved `main`, leased on the head the record names).
 * Never `main`, never a tag, never a `+` refspec, `--force`, `--mirror`, `--all`, `--tags`, another
 * remote, `--receive-pack` or any option not listed. The source of a refspec is a commit id, never
 * a ref name, so what is pushed is exactly the commit the step chose.
 *
 * An S3 call may write only under the destination prefix (`<id>/objects/`) or to the one staging
 * key, and may copy only from the upstream bucket, under the dataset's own `ds/`, at a version id:
 * a copy source without `?versionId=` is refused, so nothing is ever copied by path. Never
 * `--bypass-governance-retention`, never a `--metadata-directive`, never a lock or ACL option:
 * every call's options are an allowlist. The canary's own calls (a scratch prefix, its copies
 * deleted again by version id, the prefix listed by version) are allowed only in canary mode.
 */

import type { AwsRunner } from "../../../scripts/scrub/s3/s3-lib.js";

/** A write the guard refused: `what` names the rule, never a path, a key or a value. */
export class RepullWriteRefused extends Error {
  constructor(readonly what: string) {
    super(`A re-pull write was refused by the write guard: ${what}.`);
    this.name = "RepullWriteRefused";
  }
}

const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

/** The versions whose release branches a push may name: N.0.0, and N.0.1 once it exists. */
export interface PushContext {
  versions: readonly string[];
}

function releaseRef(version: string): string {
  return `refs/heads/release/v${version}`;
}

/**
 * Refuse a `git push` argv (everything after `git`) unless it is one of the forms the module
 * comment lists.
 */
export function assertRepullPush(args: readonly string[], ctx: PushContext): void {
  if (!ctx.versions.every((v) => VERSION.test(v))) throw new RepullWriteRefused("bad-version");
  const branches = new Set(ctx.versions.map(releaseRef));
  if (args[0] !== "push") throw new RepullWriteRefused("not-a-push");
  const rest = args.slice(1);
  const remoteAt = rest.indexOf("origin");
  if (remoteAt < 0 || rest.lastIndexOf("origin") !== remoteAt) {
    throw new RepullWriteRefused("remote-not-origin");
  }
  const options = rest.slice(0, remoteAt);
  const after = rest.slice(remoteAt + 1);
  let lease: { ref: string; sha: string } | null = null;
  let deleting = false;
  for (const o of options) {
    if (o === "--quiet" || o === "--porcelain") continue;
    const m = /^--force-with-lease=(refs\/heads\/release\/v\d+\.\d+\.\d+):([0-9a-f]{40})$/.exec(o);
    if (m && !lease) {
      lease = { ref: m[1] as string, sha: m[2] as string };
      continue;
    }
    throw new RepullWriteRefused("option-not-allowed");
  }
  // `--delete` is the only option after the remote, and only in the deletion form.
  if (after[0] === "--delete") {
    deleting = true;
    after.shift();
  }
  if (after.length !== 1) throw new RepullWriteRefused("one-refspec-only");
  const spec = after[0] as string;
  if (deleting) {
    if (lease || !branches.has(spec)) throw new RepullWriteRefused("delete-not-a-release-branch");
    return;
  }
  const colon = spec.indexOf(":");
  const src = colon < 0 ? "" : spec.slice(0, colon);
  const dst = colon < 0 ? "" : spec.slice(colon + 1);
  if (!SHA.test(src)) throw new RepullWriteRefused("source-not-a-commit-id");
  if (lease) {
    if (dst !== lease.ref || !branches.has(dst)) throw new RepullWriteRefused("lease-mismatch");
    return;
  }
  if (branches.has(dst) || dst === "refs/heads/git-annex") return;
  throw new RepullWriteRefused("destination-not-allowed");
}

/** What the S3 calls of one execution (or one canary run) may name. */
export interface AwsGuardContext {
  /** NEMAR's bucket. */
  destBucket: string;
  /** Destination keys are under this prefix (`<id>/objects/`, or the canary's scratch prefix). */
  prefix: string;
  /** The one key a put-object may name (`<id>/staging/repull-<to_tag>.json`). */
  stagingKey: string;
  /** Upstream's bucket, the only copy source. */
  sourceBucket: string;
  /** Source keys are under this prefix (`<ds>/`). */
  sourcePrefix: string;
  /** The canary's calls: delete-object by version id under `prefix`, list-object-versions of it. */
  canary?: boolean;
}

/** S3 version ids are URL-ready; anything else is refused rather than encoded. */
const VERSION_ID = /^[A-Za-z0-9._-]{1,1024}$/;
const UPLOAD_ID = /^[A-Za-z0-9._~=+/-]{1,1024}$/;

/** `--flag value` pairs; a flag twice, a bare value or `--no-paginate` with a value is refused. */
function parseArgs(args: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] as string;
    if (!flag.startsWith("--") || flag.includes("=")) throw new RepullWriteRefused("bad-argument");
    if (out.has(flag)) throw new RepullWriteRefused("argument-repeated");
    if (flag === "--no-paginate") {
      out.set(flag, "");
      continue;
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new RepullWriteRefused("argument-without-value");
    }
    out.set(flag, value);
    i++;
  }
  return out;
}

const ALLOWED: Record<string, readonly string[]> = {
  "head-object": ["--bucket", "--key", "--version-id"],
  "copy-object": ["--bucket", "--key", "--copy-source", "--copy-source-if-match"],
  "create-multipart-upload": ["--bucket", "--key"],
  "upload-part-copy": [
    "--bucket",
    "--key",
    "--upload-id",
    "--part-number",
    "--copy-source",
    "--copy-source-range",
    "--copy-source-if-match",
  ],
  "complete-multipart-upload": ["--bucket", "--key", "--upload-id", "--multipart-upload"],
  "abort-multipart-upload": ["--bucket", "--key", "--upload-id"],
  "list-objects-v2": [
    "--bucket",
    "--prefix",
    "--max-keys",
    "--no-paginate",
    "--continuation-token",
  ],
  "put-object": ["--bucket", "--key", "--body", "--content-type"],
  "delete-object": ["--bucket", "--key", "--version-id"],
  "list-object-versions": [
    "--bucket",
    "--prefix",
    "--max-keys",
    "--no-paginate",
    "--key-marker",
    "--version-id-marker",
  ],
};

/** The operations only the canary makes. */
const CANARY_ONLY = new Set(["delete-object", "list-object-versions"]);

/** Every operation that names one destination object by `--key`. */
const DEST_KEYED = new Set([
  "copy-object",
  "create-multipart-upload",
  "upload-part-copy",
  "complete-multipart-upload",
  "abort-multipart-upload",
]);

function underPrefix(key: string | undefined, prefix: string): boolean {
  return (
    typeof key === "string" &&
    prefix.endsWith("/") &&
    key.startsWith(prefix) &&
    key.length > prefix.length
  );
}

/** `<sourceBucket>/<object>?versionId=<v>`, the object under the source prefix. */
function assertCopySource(value: string | undefined, ctx: AwsGuardContext): void {
  if (value === undefined) throw new RepullWriteRefused("copy-source-missing");
  const at = value.lastIndexOf("?versionId=");
  if (at < 0) throw new RepullWriteRefused("copy-source-unversioned");
  const path = value.slice(0, at);
  const version = value.slice(at + "?versionId=".length);
  if (!VERSION_ID.test(version)) throw new RepullWriteRefused("copy-source-version-id");
  if (!path.startsWith(`${ctx.sourceBucket}/`)) throw new RepullWriteRefused("copy-source-bucket");
  if (!underPrefix(path.slice(ctx.sourceBucket.length + 1), ctx.sourcePrefix)) {
    throw new RepullWriteRefused("copy-source-prefix");
  }
}

/**
 * Refuse an `aws s3api <op> <args>` call (the runner adds `--region` and `--output`) unless it is
 * one the module comment lists.
 */
export function assertRepullAws(op: string, args: readonly string[], ctx: AwsGuardContext): void {
  if (!ctx.prefix.endsWith("/") || !ctx.sourcePrefix.endsWith("/")) {
    throw new RepullWriteRefused("bad-context");
  }
  const allowed = ALLOWED[op];
  if (!allowed) throw new RepullWriteRefused("operation-not-allowed");
  if (CANARY_ONLY.has(op) && !ctx.canary) throw new RepullWriteRefused("operation-not-allowed");
  const a = parseArgs(args);
  for (const flag of a.keys()) {
    if (!allowed.includes(flag)) throw new RepullWriteRefused("option-not-allowed");
  }
  const bucket = a.get("--bucket");
  const key = a.get("--key");

  if (op === "head-object") {
    if (bucket === ctx.sourceBucket) {
      if (!underPrefix(key, ctx.sourcePrefix)) throw new RepullWriteRefused("source-key-prefix");
      // Upstream is read at the pinned version only.
      if (!VERSION_ID.test(a.get("--version-id") ?? "")) {
        throw new RepullWriteRefused("source-read-unversioned");
      }
      return;
    }
    if (bucket !== ctx.destBucket) throw new RepullWriteRefused("bucket-not-allowed");
    if (!underPrefix(key, ctx.prefix) && key !== ctx.stagingKey) {
      throw new RepullWriteRefused("key-outside-prefix");
    }
    return;
  }

  // Every other operation names NEMAR's bucket.
  if (bucket !== ctx.destBucket) throw new RepullWriteRefused("bucket-not-allowed");

  if (DEST_KEYED.has(op)) {
    if (!underPrefix(key, ctx.prefix)) throw new RepullWriteRefused("key-outside-prefix");
    if (op === "copy-object" || op === "upload-part-copy") {
      assertCopySource(a.get("--copy-source"), ctx);
      if (!a.get("--copy-source-if-match")) throw new RepullWriteRefused("copy-without-if-match");
    }
    if (op === "upload-part-copy") {
      const n = Number(a.get("--part-number"));
      if (!Number.isInteger(n) || n < 1 || n > 10_000) throw new RepullWriteRefused("part-number");
      if (!/^bytes=\d+-\d+$/.test(a.get("--copy-source-range") ?? "")) {
        throw new RepullWriteRefused("copy-source-range");
      }
    }
    if (op !== "copy-object" && op !== "create-multipart-upload") {
      if (!UPLOAD_ID.test(a.get("--upload-id") ?? "")) throw new RepullWriteRefused("upload-id");
    }
    return;
  }

  if (op === "list-objects-v2" || op === "list-object-versions") {
    const prefix = a.get("--prefix");
    if (prefix === undefined || !prefix.startsWith(ctx.prefix)) {
      throw new RepullWriteRefused("listing-outside-prefix");
    }
    return;
  }

  if (op === "put-object") {
    if (key !== ctx.stagingKey) throw new RepullWriteRefused("put-not-the-staging-key");
    if (!a.get("--body")) throw new RepullWriteRefused("put-without-body");
    return;
  }

  if (op === "delete-object") {
    // The canary deletes what it wrote, by version id, so no delete marker is ever left behind.
    if (!VERSION_ID.test(a.get("--version-id") ?? "")) {
      throw new RepullWriteRefused("delete-unversioned");
    }
    if (key !== ctx.stagingKey && !underPrefix(key, ctx.prefix)) {
      throw new RepullWriteRefused("key-outside-prefix");
    }
    return;
  }
  throw new RepullWriteRefused("operation-not-allowed");
}

/** A runner whose every call is checked by {@link assertRepullAws} before it is made. */
export function guardedAws(runner: AwsRunner, ctx: AwsGuardContext): AwsRunner {
  return {
    async api(op, args, opts) {
      assertRepullAws(op, args, ctx);
      return runner.api(op, args, opts);
    },
  };
}
