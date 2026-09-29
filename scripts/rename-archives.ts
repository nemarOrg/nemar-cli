#!/usr/bin/env bun
/**
 * One-time sweep (#1491): rename every existing dataset archive from the
 * pre-#1491 key `<id>/archives/v<version>.zip` to the new key
 * `<id>/archives/<id>_v<version>.zip`, so the file name in a presigned
 * download URL already matches the dataset (owner decision, #1491 --
 * deliberately NOT solved with a `response-content-disposition` header).
 *
 * Run by the LEAD, by hand, AFTER the nemar-cli and nemarDatasets/.github
 * PRs for #1491 are deployed: readers (`resolveArchiveKey` in
 * `backend/src/services/s3.ts`) already try the new name first and fall
 * back to this old one, and the archive-generation workflow already writes
 * only the new name, so nothing regresses while this sweep is in progress
 * or before it reaches a given dataset.
 *
 * Usage:
 *   bun scripts/rename-archives.ts                        # dry run (default)
 *   bun scripts/rename-archives.ts --apply                # actually rename
 *   bun scripts/rename-archives.ts --dataset nm000132     # scope to one id
 *   bun scripts/rename-archives.ts --dataset nm000132 --apply
 *   bun scripts/rename-archives.ts --bucket nemar --region us-east-2 --apply
 *   bun scripts/rename-archives.ts --apply --delete-stale-legacy
 *
 * Credentials: the ambient AWS CLI session (same convention as
 * scripts/hallu-sync.sh and scripts/migrate-s3-structure.sh), verified via
 * scripts/lib/aws-creds-guard.sh before anything else runs.
 *
 * Shells out to the `aws` CLI rather than pulling in an SDK dependency:
 * `aws s3 cp` performs a real server-side copy (bytes never leave AWS's
 * network) and manages multipart copy automatically above 5 GB, which is
 * required here -- production archives run into the hundreds of GB (up to
 * about 606 GiB).
 *
 * Tagging is a SEPARATE step from the copy. `aws s3 cp` has no equivalent
 * of `s3api copy-object`'s `--tagging-directive`/`--tagging` -- checked
 * against aws-cli 2.36.47's `aws s3 cp help`, it accepts only
 * `--copy-props`/`--metadata-directive` -- and passing the copy-object
 * flags to it is exactly what made a production run fail 88/88 copies
 * immediately with `ParamValidation: Unknown options:
 * --tagging-directive,REPLACE,--tagging,nemar-kind=archive` before anything
 * in S3 was touched. So the copy (`buildCopyArgs`) carries no tagging
 * flags at all, and every path that can leave an untagged destination
 * (a fresh copy, or a resumed run's already-copied destination) tags it
 * afterward with `s3api put-object-tagging` and reads the tag set back
 * with `get-object-tagging` to confirm `nemar-kind=archive` actually
 * landed, BEFORE the old object is deleted (`tagDestination`). The
 * #1518 lifecycle rule that expires noncurrent archive versions filters on
 * this exact tag, and the source's tag set is empty (pre-#1491 archives
 * were never tagged), so an untagged renamed archive would never be
 * covered by it.
 *
 * For each dataset (discovered by listing the bucket's top-level id
 * prefixes, or scoped to one id via --dataset), every pre-#1491 key found
 * under `<id>/archives/` is HEADed at its planned destination (in BOTH
 * dry-run and apply, so the dry-run preview is exactly what apply would
 * do) and classified into one of four actions (see `decideRenameAction`):
 *
 *   - **copy**: destination doesn't exist yet. `aws s3 cp` (content type
 *     and metadata are preserved by the default COPY directive), then
 *     verifies size, and ETag when comparable, then tags the destination
 *     and verifies the tag landed (`tagDestination`), then deletes the OLD
 *     object BY VERSION ID (never a bare `aws s3 rm`: the bucket is
 *     versioned with no noncurrent-version expiration configured before
 *     #1518's lifecycle rule, so a bare delete only adds a delete marker
 *     and frees nothing).
 *   - **already-renamed**: destination exists and verifies as an exact
 *     match of the source (a previous partial run copied it but didn't
 *     finish tagging and deleting). No copy is repeated; `tagDestination`
 *     runs again regardless (idempotent: `put-object-tagging` simply
 *     replaces the tag set), since a prior run may have died between the
 *     copy and the tag. The old object is then deleted by version id.
 *   - **skip-collision**: destination exists and does NOT match the
 *     source. NEVER overwritten -- a destination that differs is most
 *     often a fresh build the new workflow already wrote for this exact
 *     version, and that build must win. Left alone by default (both
 *     objects kept, a warning printed) unless `--delete-stale-legacy` is
 *     given AND the destination is independently confirmed as the winner
 *     (see the next bullet).
 *   - **delete-stale-legacy**: only reachable with `--delete-stale-legacy`,
 *     and only when the destination is both newer (LastModified) than the
 *     legacy source AND non-empty. Deletes ONLY the legacy source by
 *     version id; the destination is never touched -- no copy, no
 *     tagging, since it's already there and being trusted as authoritative
 *     and the new workflow already tags what it writes.
 *
 * Resumable: a key already in the new shape (found directly in the current
 * listing) is skipped as "already renamed" before this decision even
 * runs. A skip-collision is a deliberate no-op, not a failure -- it is
 * reported so a human can look, then either re-run with
 * --delete-stale-legacy once satisfied, or leave it.
 *
 * Scope: every operation is asserted to stay under `<id>/archives/` for
 * the dataset id it was planned for (planRenameKey throws otherwise); nothing
 * outside `<id>/archives/` is ever listed, copied, or deleted.
 */

import { spawnSync } from "bun";

// ---------------------------------------------------------------------------
// Pure planning logic (unit-tested in test/rename-archives.test.ts against
// real S3 list-objects-v2 shapes; no network access from here down).
// ---------------------------------------------------------------------------

export interface ArchiveObjectInfo {
  /** Full S3 key, e.g. "nm000132/archives/v1.0.0.zip". */
  key: string;
  size: number;
  /** As S3 returns it, quotes included, e.g. '"2c1d...-135"'. */
  etag: string;
  /** ISO 8601, as S3 returns it (list-objects-v2's LastModified / head-object's LastModified). */
  lastModified: string;
}

export interface RenamePlanItem {
  datasetId: string;
  oldKey: string;
  newKey: string;
  size: number;
  etag: string;
  lastModified: string;
}

export interface RenameSkip {
  datasetId: string;
  key: string;
  reason: string;
}

export interface RenamePlan {
  toRename: RenamePlanItem[];
  skipped: RenameSkip[];
}

const DATASET_ID_RE = /^(nm|on|xx)\d{6}$/;

/** True for a key already in the #1491 shape: `<id>/archives/<id>_...`. */
export function isNewFormatArchiveKey(datasetId: string, key: string): boolean {
  const prefix = `${datasetId}/archives/`;
  if (!key.startsWith(prefix)) return false;
  const filename = key.slice(prefix.length);
  return filename.startsWith(`${datasetId}_`);
}

/**
 * Compute the #1491 destination key for a pre-#1491 archive key.
 *
 * Scope guard: throws if `key` is not a direct child of
 * `<datasetId>/archives/` (not under that prefix at all, or nested another
 * level deeper), or if it is already in the new shape. Every call site
 * must let this throw propagate rather than swallow it -- a caught
 * exception here is exactly the "don't touch it" signal.
 */
export function planRenameKey(datasetId: string, key: string): string {
  const prefix = `${datasetId}/archives/`;
  if (!key.startsWith(prefix)) {
    throw new Error(`refusing to plan a rename for "${key}": not under "${prefix}"`);
  }
  const filename = key.slice(prefix.length);
  if (filename === "" || filename.includes("/")) {
    throw new Error(
      `refusing to plan a rename for "${key}": expected a single path segment under "${prefix}"`,
    );
  }
  if (filename.startsWith(`${datasetId}_`)) {
    throw new Error(`"${key}" is already in the #1491 shape`);
  }
  return `${prefix}${datasetId}_${filename}`;
}

/**
 * Build the full rename plan for one dataset's current archive objects.
 * Pure and total: never throws, every input object ends up in exactly one
 * of `toRename` or `skipped`.
 */
export function planDatasetRename(datasetId: string, objects: ArchiveObjectInfo[]): RenamePlan {
  const toRename: RenamePlanItem[] = [];
  const skipped: RenameSkip[] = [];
  const prefix = `${datasetId}/archives/`;
  for (const obj of objects) {
    if (!obj.key.startsWith(prefix)) {
      skipped.push({ datasetId, key: obj.key, reason: `out of scope (not under "${prefix}")` });
      continue;
    }
    if (!obj.key.endsWith(".zip")) {
      skipped.push({ datasetId, key: obj.key, reason: "not a .zip archive" });
      continue;
    }
    if (isNewFormatArchiveKey(datasetId, obj.key)) {
      skipped.push({ datasetId, key: obj.key, reason: "already renamed" });
      continue;
    }
    toRename.push({
      datasetId,
      oldKey: obj.key,
      newKey: planRenameKey(datasetId, obj.key),
      size: obj.size,
      etag: obj.etag,
      lastModified: obj.lastModified,
    });
  }
  return { toRename, skipped };
}

/**
 * Decide whether a copy at the destination can be trusted as complete:
 * same size, and (when comparable) the same ETag.
 *
 * A single-part upload's ETag is a plain hex MD5 of the object body and is
 * preserved exactly by a server-side copy, so it is checked. A multipart
 * upload's ETag instead encodes the part count (`<hex>-<N>`) and is NOT
 * expected to match after a copy that may use different part boundaries
 * (`aws s3 cp` picks its own), so ETag comparison is skipped -- not
 * failed -- for a multipart source, and the reason string says so
 * explicitly rather than silently passing.
 */
export function verifyRenameCopy(
  source: { size: number; etag: string },
  dest: { size: number; etag: string } | null,
): { ok: boolean; reason: string } {
  if (!dest) return { ok: false, reason: "destination object not found" };
  if (dest.size !== source.size) {
    return { ok: false, reason: `size mismatch: source ${source.size}, dest ${dest.size}` };
  }
  const sourceIsMultipart = /-\d+"$/.test(source.etag);
  if (sourceIsMultipart) {
    return {
      ok: true,
      reason: "size matches; source ETag is multipart-form, ETag comparison skipped",
    };
  }
  if (dest.etag !== source.etag) {
    return { ok: false, reason: `ETag mismatch: source ${source.etag}, dest ${dest.etag}` };
  }
  return { ok: true, reason: "size and ETag match" };
}

export type RenameAction =
  | { action: "copy" }
  | { action: "already-renamed" }
  | { action: "skip-collision"; reason: string }
  | { action: "delete-stale-legacy" };

/**
 * Decide what to do about one pre-#1491 key, given whatever (if anything)
 * already exists at its planned destination. NEVER returns an action that
 * overwrites an existing destination -- "copy" is only returned when
 * `dest` is null.
 *
 * - No destination: "copy" (the normal case).
 * - Destination exists and verifies as the same content: "already-renamed"
 *   (a prior partial run copied it; only the old object still needs
 *   deleting).
 * - Destination exists and differs: a collision. Only actionable with
 *   `allowDeleteStaleLegacy` AND the destination independently proving
 *   itself the winner (strictly newer AND non-empty) -- otherwise
 *   "skip-collision", which touches neither object.
 */
export function decideRenameAction(
  source: { size: number; etag: string; lastModified: string },
  dest: { size: number; etag: string; lastModified: string } | null,
  opts: { allowDeleteStaleLegacy: boolean },
): RenameAction {
  if (!dest) return { action: "copy" };

  const verdict = verifyRenameCopy(source, dest);
  if (verdict.ok) return { action: "already-renamed" };

  const destIsNewer =
    new Date(dest.lastModified).getTime() > new Date(source.lastModified).getTime();
  const destNonEmpty = dest.size > 0;
  if (opts.allowDeleteStaleLegacy && destIsNewer && destNonEmpty) {
    return { action: "delete-stale-legacy" };
  }
  const why = opts.allowDeleteStaleLegacy
    ? `not newer/non-empty enough to trust as the winner (destLastModified=${dest.lastModified}, destSize=${dest.size})`
    : "pass --delete-stale-legacy to remove the legacy object once you've confirmed the destination is the real latest";
  return {
    action: "skip-collision",
    reason: `destination exists and differs from source (${verdict.reason}); ${why}`,
  };
}

/**
 * Args for the server-side copy. No tagging flags: `aws s3 cp` has no
 * equivalent of `s3api copy-object`'s `--tagging-directive`/`--tagging` --
 * checked against aws-cli 2.36.47's `aws s3 cp help`, it accepts only
 * `--copy-props`/`--metadata-directive` -- and passing them here is what
 * made a production run fail 88/88 copies immediately with `ParamValidation:
 * Unknown options: --tagging-directive,REPLACE,--tagging,nemar-kind=archive`.
 * Content type and metadata are NOT touched here and are preserved by the
 * default COPY behavior. The tag is applied afterward by a separate
 * `s3api put-object-tagging` call (`buildTagArgs`) and verified with
 * `get-object-tagging` before anything is deleted -- see `tagDestination`.
 *
 * `--no-progress`: `runAws` runs this through `spawnSync` with piped
 * stdout, and a copy of a multi-hundred-GiB archive would otherwise buffer
 * `aws s3 cp`'s progress output for the whole transfer instead of
 * streaming it.
 */
export function buildCopyArgs(bucket: string, item: RenamePlanItem): string[] {
  return [
    "s3",
    "cp",
    `s3://${bucket}/${item.oldKey}`,
    `s3://${bucket}/${item.newKey}`,
    "--no-progress",
  ];
}

/**
 * Args for `s3api put-object-tagging` against the rename destination.
 * `s3api copy-object`'s `--tagging-directive`/`--tagging` is not used here
 * because the copy itself is done with `aws s3 cp` (see `buildCopyArgs`),
 * which has no tagging option at all -- so the tag is always set as its
 * own call, never folded into the copy.
 */
export function buildTagArgs(bucket: string, key: string): string[] {
  return [
    "s3api",
    "put-object-tagging",
    "--bucket",
    bucket,
    "--key",
    key,
    "--tagging",
    "TagSet=[{Key=nemar-kind,Value=archive}]",
  ];
}

/**
 * True when a `get-object-tagging` tag set already carries
 * `nemar-kind=archive`. The one check `tagDestination` requires before
 * treating a destination as safely tagged and deleting the old object --
 * exported and pure so it is unit-tested directly rather than only through
 * the AWS-CLI-shelling half of this script.
 */
export function hasArchiveTag(tagSet: Array<{ Key: string; Value: string }>): boolean {
  return tagSet.some((tag) => tag.Key === "nemar-kind" && tag.Value === "archive");
}

/** True for a bucket-listing "directory" prefix shaped like a NEMAR dataset id. */
export function isDatasetIdPrefix(prefix: string): boolean {
  if (!prefix.endsWith("/")) return false;
  return DATASET_ID_RE.test(prefix.slice(0, -1));
}

/**
 * Classify a FAILED `aws s3api head-object` invocation from its captured
 * stderr. A genuine 404/NoSuchKey/Not Found means "no such object" -- the
 * one case where treating the destination as absent is correct. Any other
 * failure (throttling, a network blip, a permissions hiccup) must NOT be
 * read the same way: `decideRenameAction` treats a null destination as
 * "copy", and copying on the strength of an unrelated error could
 * overwrite a destination that may well exist. Mirrors the idempotency
 * guard in nemarDatasets/.github's run-generate-archive.yml, which makes
 * the identical distinction against the identical CLI's stderr shape.
 */
export function classifyHeadObjectError(stderr: string): "not-found" | "error" {
  return /Not Found|404|NoSuchKey/i.test(stderr) ? "not-found" : "error";
}

// ---------------------------------------------------------------------------
// AWS CLI orchestration. Everything below this line touches the network and
// is deliberately NOT unit tested (per the PR's test plan): the pure
// functions above are what carry the planning/skip/scope-guard behavior,
// and this half is a thin, mostly-untestable shell around `aws` calls.
// ---------------------------------------------------------------------------

interface Args {
  apply: boolean;
  bucket: string;
  region: string;
  dataset: string | null;
  deleteStaleLegacy: boolean;
}

function parseArgs(argv: string[]): Args {
  let apply = false;
  let bucket = "nemar";
  let region = "us-east-2";
  let dataset: string | null = null;
  let deleteStaleLegacy = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--delete-stale-legacy") deleteStaleLegacy = true;
    else if (arg === "--bucket") bucket = argv[++i];
    else if (arg === "--region") region = argv[++i];
    else if (arg === "--dataset") dataset = argv[++i];
    else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { apply, bucket, region, dataset, deleteStaleLegacy };
}

function runAws(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(["aws", ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    ok: result.success,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function runAwsJson<T>(args: string[]): T {
  const res = runAws([...args, "--output", "json"]);
  if (!res.ok) {
    throw new Error(`aws ${args.join(" ")} failed: ${res.stderr.trim()}`);
  }
  return JSON.parse(res.stdout) as T;
}

function guardAwsCredentials(): void {
  const guardPath = new URL("./lib/aws-creds-guard.sh", import.meta.url).pathname;
  const res = spawnSync(["bash", "-c", `source '${guardPath}' && nemar_guard_aws_credentials`], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!res.success) {
    console.error("aws-creds-guard refused to proceed; see the message above.");
    process.exit(2);
  }
}

/** List every top-level "<prefix>/" that looks like a NEMAR dataset id. */
function listDatasetIds(bucket: string): string[] {
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const args = ["s3api", "list-objects-v2", "--bucket", bucket, "--delimiter", "/"];
    if (token) args.push("--continuation-token", token);
    const page = runAwsJson<{
      CommonPrefixes?: Array<{ Prefix: string }>;
      IsTruncated?: boolean;
      NextContinuationToken?: string;
    }>(args);
    for (const { Prefix } of page.CommonPrefixes ?? []) {
      if (isDatasetIdPrefix(Prefix)) ids.push(Prefix.slice(0, -1));
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return ids;
}

/** Current (non-versioned) listing of a dataset's archives/ prefix. */
function listCurrentArchiveObjects(bucket: string, datasetId: string): ArchiveObjectInfo[] {
  const prefix = `${datasetId}/archives/`;
  const objects: ArchiveObjectInfo[] = [];
  let token: string | undefined;
  do {
    const args = ["s3api", "list-objects-v2", "--bucket", bucket, "--prefix", prefix];
    if (token) args.push("--continuation-token", token);
    const page = runAwsJson<{
      Contents?: Array<{ Key: string; Size: number; ETag: string; LastModified: string }>;
      IsTruncated?: boolean;
      NextContinuationToken?: string;
    }>(args);
    for (const c of page.Contents ?? []) {
      objects.push({ key: c.Key, size: c.Size, etag: c.ETag, lastModified: c.LastModified });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return objects;
}

/** The CURRENT version id of a key, so the old object can be deleted by
 *  the exact version the copy was verified against (never a bare `aws s3
 *  rm`, which only adds a delete marker on this versioned bucket). */
function currentVersionId(bucket: string, key: string): string | null {
  const page = runAwsJson<{
    Versions?: Array<{ Key: string; VersionId: string; IsLatest: boolean }>;
  }>(["s3api", "list-object-versions", "--bucket", bucket, "--prefix", key]);
  const match = (page.Versions ?? []).find((v) => v.Key === key && v.IsLatest);
  return match?.VersionId ?? null;
}

type HeadObjectResult =
  | { status: "found"; size: number; etag: string; lastModified: string }
  | { status: "not-found" }
  | { status: "error"; detail: string };

function headObject(bucket: string, key: string): HeadObjectResult {
  const res = runAws([
    "s3api",
    "head-object",
    "--bucket",
    bucket,
    "--key",
    key,
    "--output",
    "json",
  ]);
  if (!res.ok) {
    if (classifyHeadObjectError(res.stderr) === "not-found") {
      return { status: "not-found" };
    }
    return { status: "error", detail: res.stderr.trim() };
  }
  const parsed = JSON.parse(res.stdout) as {
    ContentLength: number;
    ETag: string;
    LastModified: string;
  };
  return {
    status: "found",
    size: parsed.ContentLength,
    etag: parsed.ETag,
    lastModified: parsed.LastModified,
  };
}

/**
 * Tag the rename destination and read the tag set back to confirm
 * `nemar-kind=archive` actually landed, before the caller is allowed to
 * delete the old object. Used on BOTH the "copy" path (a fresh copy is
 * always untagged) and the "already-renamed" path (a previous run may have
 * copied the object and died before tagging it) -- `put-object-tagging`
 * replaces the whole tag set, so calling it again on an already-tagged
 * object is a safe no-op.
 */
function tagDestination(bucket: string, key: string): boolean {
  const tag = runAws(buildTagArgs(bucket, key));
  if (!tag.ok) {
    console.error(`  FAILED to tag ${key}: ${tag.stderr.trim()}`);
    console.error("  refusing to delete the old object: tagging failed.");
    return false;
  }
  let tagSet: Array<{ Key: string; Value: string }>;
  try {
    const read = runAwsJson<{ TagSet?: Array<{ Key: string; Value: string }> }>([
      "s3api",
      "get-object-tagging",
      "--bucket",
      bucket,
      "--key",
      key,
    ]);
    tagSet = read.TagSet ?? [];
  } catch (err) {
    console.error(
      `  FAILED to read back the tag set on ${key}: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error("  refusing to delete the old object: could not verify the tag.");
    return false;
  }
  if (!hasArchiveTag(tagSet)) {
    console.error(`  FAILED: ${key} has no nemar-kind=archive tag after tagging it`);
    console.error("  refusing to delete the old object: tag verification failed.");
    return false;
  }
  console.log(`  tagged and verified ${key} (nemar-kind=archive).`);
  return true;
}

function deleteOldByVersionId(bucket: string, oldKey: string): boolean {
  const versionId = currentVersionId(bucket, oldKey);
  if (!versionId) {
    console.error(`  FAILED: could not resolve a current version id for ${oldKey}`);
    return false;
  }
  const del = runAws([
    "s3api",
    "delete-object",
    "--bucket",
    bucket,
    "--key",
    oldKey,
    "--version-id",
    versionId,
  ]);
  if (!del.ok) {
    console.error(`  FAILED to delete old version ${versionId}: ${del.stderr.trim()}`);
    return false;
  }
  console.log(`  deleted old object ${oldKey} (version ${versionId}).`);
  return true;
}

/** Outcome of type-checking every one of the (up to) 4 actions in one place. */
type ActionOutcome = "renamed" | "skipped-collision" | "failed";

async function processOne(
  bucket: string,
  item: RenamePlanItem,
  apply: boolean,
  allowDeleteStaleLegacy: boolean,
): Promise<ActionOutcome> {
  console.log(`[${item.datasetId}] ${item.oldKey} -> ${item.newKey} (${item.size} bytes)`);

  // HEAD the destination in BOTH dry-run and apply, so the dry-run preview
  // is exactly what apply would do -- never inferred separately. A real
  // error (not a 404) must not be read as "no destination": stop here,
  // in both modes, rather than let decideRenameAction default to "copy"
  // on the strength of an unrelated failure.
  const destResult = headObject(bucket, item.newKey);
  if (destResult.status === "error") {
    console.error(
      `  FAILED: could not confirm whether ${item.newKey} exists (head-object error, not a 404): ${destResult.detail}`,
    );
    console.error("  refusing to guess; neither object touched.");
    return "failed";
  }
  const dest = destResult.status === "found" ? destResult : null;
  const decision = decideRenameAction(item, dest, { allowDeleteStaleLegacy });

  if (!apply) {
    console.log(
      `  [dry-run] would: ${decision.action}${"reason" in decision ? ` (${decision.reason})` : ""}`,
    );
    return decision.action === "skip-collision" ? "skipped-collision" : "renamed";
  }

  switch (decision.action) {
    case "copy": {
      console.log("  copying (server-side, aws s3 cp handles multipart above 5 GB)...");
      const copy = runAws(buildCopyArgs(bucket, item));
      if (!copy.ok) {
        console.error(`  FAILED to copy: ${copy.stderr.trim()}`);
        return "failed";
      }
      const verifiedDestResult = headObject(bucket, item.newKey);
      if (verifiedDestResult.status === "error") {
        console.error(
          `  FAILED to verify copy: could not confirm ${item.newKey} exists after copy (head-object error, not a 404): ${verifiedDestResult.detail}`,
        );
        console.error("  refusing to delete the old object: verification failed.");
        return "failed";
      }
      const verifiedDest = verifiedDestResult.status === "found" ? verifiedDestResult : null;
      const verdict = verifyRenameCopy(item, verifiedDest);
      console.log(`  verify: ${verdict.ok ? "OK" : "FAILED"} -- ${verdict.reason}`);
      if (!verdict.ok) {
        console.error("  refusing to delete the old object: verification failed.");
        return "failed";
      }
      console.log("  tagging destination (nemar-kind=archive)...");
      if (!tagDestination(bucket, item.newKey)) return "failed";
      return deleteOldByVersionId(bucket, item.oldKey) ? "renamed" : "failed";
    }
    case "already-renamed": {
      console.log(
        "  destination already present and verified (resumed run); tagging it (a prior run may have died before tagging) and deleting the stale old object.",
      );
      if (!tagDestination(bucket, item.newKey)) return "failed";
      return deleteOldByVersionId(bucket, item.oldKey) ? "renamed" : "failed";
    }
    case "delete-stale-legacy": {
      console.log(
        "  destination is newer and non-empty; trusting it as the winner and deleting only the legacy source (destination left untouched).",
      );
      return deleteOldByVersionId(bucket, item.oldKey) ? "renamed" : "failed";
    }
    case "skip-collision": {
      console.warn(`  SKIP (collision, neither object touched): ${decision.reason}`);
      return "skipped-collision";
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  guardAwsCredentials();

  if (!args.apply) {
    console.log("=== DRY RUN (pass --apply to actually rename) ===\n");
  }

  const datasetIds = args.dataset ? [args.dataset] : listDatasetIds(args.bucket);
  console.log(`Scanning ${datasetIds.length} dataset id(s) under s3://${args.bucket}/...\n`);

  let renamed = 0;
  let failed = 0;
  let skipped = 0;
  let collisions = 0;

  for (const datasetId of datasetIds) {
    const objects = listCurrentArchiveObjects(args.bucket, datasetId);
    if (objects.length === 0) continue;
    const plan = planDatasetRename(datasetId, objects);
    for (const skip of plan.skipped) {
      // "already renamed" is the steady-state case once the sweep has run
      // and is not worth a line per dataset; anything else (scope/shape
      // surprises) is.
      if (skip.reason !== "already renamed") {
        console.log(`[${skip.datasetId}] skip ${skip.key}: ${skip.reason}`);
      }
      skipped++;
    }
    for (const item of plan.toRename) {
      const outcome = await processOne(args.bucket, item, args.apply, args.deleteStaleLegacy);
      if (outcome === "renamed") renamed++;
      else if (outcome === "skipped-collision") collisions++;
      else failed++;
    }
  }

  console.log(
    `\nDone. ${args.apply ? "Renamed" : "Would rename"}: ${renamed}, skipped (already renamed / out of scope): ${skipped}, collisions (left untouched): ${collisions}, failed: ${failed}.`,
  );
  if (collisions > 0) {
    console.log(
      "Collisions need a human look: re-run with --delete-stale-legacy once you've confirmed the destination is the real latest, or leave them.",
    );
  }
  if (failed > 0) process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
