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
 * scripts/lib/aws-creds-guard.sh before anything else runs. `--region`
 * (default us-east-2) is handed to EVERY `aws` call, the guard's identity
 * probe included, so the run never depends on a default region being
 * configured.
 *
 * Shells out to the `aws` CLI rather than pulling in an SDK dependency:
 * `aws s3 cp` performs a real server-side copy (bytes never leave AWS's
 * network) and copies anything from 8 MiB up as a multipart upload
 * (UploadPartCopy), which a single CopyObject could not do above 5 GB anyway.
 * That is required here -- production archives run into the hundreds of GB
 * (up to about 606 GiB). A multipart copy also reads the SOURCE's tag set, so
 * the credentials need `s3:GetObjectTagging` on the legacy key as well as
 * `s3:PutObjectTagging` on the destination.
 *
 * Tagging is a SEPARATE step from the copy. `aws s3 cp` has no equivalent
 * of `s3api copy-object`'s `--tagging-directive`/`--tagging` -- checked
 * against aws-cli 2.36.47's `aws s3 cp help`, it accepts only
 * `--copy-props`/`--metadata-directive` -- and passing the copy-object
 * flags to it is exactly what made a production run fail 88/88 copies
 * immediately with `ParamValidation: Unknown options:
 * --tagging-directive,REPLACE,--tagging,nemar-kind=archive` before anything
 * in S3 was touched. So the copy (`buildCopyArgs`) carries no tagging
 * flags at all, and every path that ends in a delete tags the destination
 * first (`tagDestination`): it reads the destination's tags, merges
 * `nemar-kind=archive` into them (a put replaces the whole set, so tags are
 * never written blind and other tags are kept), skips the write when the tag
 * is already there, and reads the tag set back to confirm the tag actually
 * landed, BEFORE the old object is deleted. The #1518 lifecycle rule that
 * expires noncurrent archive versions filters on this exact tag, and the
 * source's tag set is empty (pre-#1491 archives were never tagged), so an
 * untagged renamed archive would never be covered by it.
 *
 * The delete is the one step that cannot be undone, so it is checked twice.
 * Before it, the legacy key's versions are listed (`list-object-versions
 * --prefix` is a PREFIX match, so only entries for the exact key count) and
 * its current version must still have the ETag and Size the plan was made
 * against; if the key was rebuilt or replaced in the meantime, nothing is
 * deleted. After it, the same key is listed again: any version or delete
 * marker still there (deleting the current version lets the next one down
 * become current again, so the legacy key can reappear holding an older
 * build) is reported in a WARNING and counted in the summary. Leftovers are
 * never deleted by this script.
 *
 * For each dataset (discovered by listing the bucket's top-level id
 * prefixes, or scoped to one id via --dataset), every pre-#1491 key found
 * under `<id>/archives/` is HEADed at its planned destination (in BOTH
 * dry-run and apply, so the dry-run preview is exactly what apply would
 * do) and classified into one of four actions (see `decideRenameAction`):
 *
 *   - **copy**: destination doesn't exist yet. `aws s3 cp` (content type
 *     and metadata are preserved by the default COPY directive), then
 *     verifies size, and ETag when comparable (`verifyRenameCopy`), then tags
 *     the destination and verifies the tag landed, then deletes the OLD
 *     object BY VERSION ID (never a bare `aws s3 rm`: the bucket is
 *     versioned with no noncurrent-version expiration configured before
 *     #1518's lifecycle rule, so a bare delete only adds a delete marker
 *     and frees nothing).
 *   - **already-renamed**: destination exists and verifies as an exact
 *     match of the source (a previous partial run copied it but didn't
 *     finish tagging and deleting). No copy is repeated; the destination is
 *     tagged if it is not already (a prior run may have died between the
 *     copy and the tag). The old object is then deleted by version id.
 *   - **skip-collision**: destination exists and does NOT match the
 *     source. NEVER overwritten -- a destination that differs is most
 *     often a fresh build the new workflow already wrote for this exact
 *     version, and that build must win. Left alone by default (both
 *     objects kept, a warning printed) unless `--delete-stale-legacy` is
 *     given AND the destination is independently confirmed as the winner
 *     (see the next bullet).
 *   - **delete-stale-legacy**: only reachable with `--delete-stale-legacy`,
 *     and only when the destination is newer (LastModified) than the
 *     legacy source, non-empty, AND at least as large as it (a truncated or
 *     partial destination is never trusted as the winner). No copy is
 *     performed and the destination's content is never touched, but it IS
 *     tagged if it is not already (verified rather than assumed, other tags
 *     kept), and then ONLY the legacy source is deleted by version id.
 *
 * Resumable: a key already in the new shape (found directly in the current
 * listing) is skipped as "already renamed" before this decision even
 * runs. A skip-collision changes nothing in S3, but it means the sweep is not
 * finished: it is reported so a human can look. Inspect the destination first
 * (size, ETag, LastModified against the legacy object), and only if it is the
 * real latest re-run with --delete-stale-legacy; otherwise leave it.
 *
 * Exit status: nonzero when any item failed OR any collision was left
 * untouched (dry runs included: a dry run that predicts a collision says so).
 * Leftover versions are warnings, not failures.
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

/** True for a multipart-form ETag, `"<hex>-<parts>"`, as the CLI prints it. */
function isMultipartEtag(etag: string): boolean {
  return /-\d+"$/.test(etag);
}

/**
 * Decide whether a copy at the destination can be trusted as complete:
 * same size, and (when comparable) the same ETag.
 *
 * A single-part upload's ETag is a plain hex MD5 of the object body and is
 * preserved exactly by a single-call server-side copy, so it is checked. A
 * multipart upload's ETag instead encodes the part count (`<hex>-<N>`) and is
 * NOT expected to match a copy that used different part boundaries (`aws s3
 * cp` picks its own, and copies anything from 8 MiB up as a multipart upload).
 * That goes for EITHER side: a plain-MD5 source above the multipart threshold
 * is copied multipart and comes out with a multipart-form ETag, so the pair
 * can never match even though the bytes are identical. ETag comparison is
 * therefore skipped -- not failed -- when either ETag is multipart-form, and
 * the reason string says so explicitly rather than silently passing. The size
 * must still match exactly in every case.
 */
export function verifyRenameCopy(
  source: { size: number; etag: string },
  dest: { size: number; etag: string } | null,
): { ok: boolean; reason: string } {
  if (!dest) return { ok: false, reason: "destination object not found" };
  if (dest.size !== source.size) {
    return { ok: false, reason: `size mismatch: source ${source.size}, dest ${dest.size}` };
  }
  if (isMultipartEtag(source.etag) || isMultipartEtag(dest.etag)) {
    return {
      ok: true,
      reason: "size matches; an ETag is multipart-form, ETag comparison skipped",
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
 *   tagging and deleting).
 * - Destination exists and differs: a collision. Only actionable with
 *   `allowDeleteStaleLegacy` AND the destination independently proving
 *   itself the winner: strictly newer, non-empty AND at least as large as
 *   the source. The size floor is what stops a truncated or partial
 *   destination (a copy that died part-way, or one that came out short)
 *   from being trusted as the winner and the only intact copy from being
 *   deleted -- a fresh build of the same version is never smaller than the
 *   archive it replaces. Otherwise "skip-collision", which touches neither
 *   object.
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
  const destNotSmaller = dest.size >= source.size;
  if (opts.allowDeleteStaleLegacy && destIsNewer && destNonEmpty && destNotSmaller) {
    return { action: "delete-stale-legacy" };
  }
  const why = opts.allowDeleteStaleLegacy
    ? `not newer, non-empty and at least as large as the source, so not trusted as the winner (destLastModified=${dest.lastModified}, destSize=${dest.size}, sourceSize=${source.size})`
    : "inspect the destination first (size, ETag and LastModified against the legacy object); only if it is the real latest, re-run with --delete-stale-legacy to remove the legacy object";
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
 * `--no-progress` only keeps the captured stdout to the single `copy:` line.
 * Without it the CLI writes `\r`-separated `Completed X/Y (rate)` updates into
 * the piped stdout (measured against a 20 MiB, three-part copy: 279 bytes with
 * progress, 85 without), at most one ~90-byte update per part, so even a
 * multi-hundred-GiB copy is a few megabytes at worst. That is noise in output
 * this script discards on success, not a memory hazard. The flag does NOT make
 * a long copy visible: nothing is printed until the copy finishes, which is
 * why `processOne` announces the size before it starts.
 *
 * Note for whoever runs it: a multipart copy (anything from 8 MiB up) also
 * makes the CLI read the SOURCE object's tag set (`GetObjectTagging`) so it
 * can carry the tags over, so the credentials need `s3:GetObjectTagging` on the
 * legacy key as well as `s3:PutObjectTagging` on the destination.
 *
 * Deliberately no `--no-overwrite`: how a server-side copy honors that flag
 * has not been verified, and `decideRenameAction` already never plans a copy
 * onto an existing destination.
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

export interface Tag {
  Key: string;
  Value: string;
}

const ARCHIVE_TAG_KEY = "nemar-kind";
const ARCHIVE_TAG_VALUE = "archive";

/**
 * True when a `get-object-tagging` tag set already carries
 * `nemar-kind=archive`. The one check `tagDestination` requires before
 * treating a destination as safely tagged and deleting the old object --
 * exported and pure so it is unit-tested directly rather than only through
 * the AWS-CLI-shelling half of this script.
 */
export function hasArchiveTag(tagSet: Tag[]): boolean {
  return tagSet.some((tag) => tag.Key === ARCHIVE_TAG_KEY && tag.Value === ARCHIVE_TAG_VALUE);
}

/**
 * `tagSet` with `nemar-kind=archive` added, every other tag kept. A
 * `put-object-tagging` REPLACES the whole tag set, so writing just the one
 * tag would silently drop whatever the destination already carried (a fresh
 * build the workflow tagged, or tags copied over from a legacy object by a
 * multipart copy). A `nemar-kind` tag holding some other value is
 * overwritten, since the lifecycle rule keys on exactly `archive`.
 */
export function mergeArchiveTag(tagSet: Tag[]): Tag[] {
  const others = tagSet.filter((tag) => tag.Key !== ARCHIVE_TAG_KEY);
  return [...others, { Key: ARCHIVE_TAG_KEY, Value: ARCHIVE_TAG_VALUE }];
}

/**
 * Args for `s3api put-object-tagging` against the rename destination, writing
 * the given (already merged) tag set. JSON rather than the CLI's shorthand
 * because a preserved tag may hold commas, brackets or `=`, which shorthand
 * cannot quote. `s3api copy-object`'s `--tagging-directive`/`--tagging` is not
 * used because the copy itself is done with `aws s3 cp` (see
 * `buildCopyArgs`), which has no tagging option at all.
 */
export function buildTagArgs(bucket: string, key: string, tagSet: Tag[]): string[] {
  return [
    "s3api",
    "put-object-tagging",
    "--bucket",
    bucket,
    "--key",
    key,
    "--tagging",
    JSON.stringify({ TagSet: tagSet }),
  ];
}

/** One entry of `list-object-versions`' `Versions` or `DeleteMarkers` array. */
export interface ObjectVersionInfo {
  Key: string;
  VersionId: string;
  IsLatest: boolean;
  ETag?: string;
  Size?: number;
}

/**
 * Which version of `key` may be deleted, or why none may. Pure.
 *
 * `list-object-versions --prefix <key>` is a PREFIX match, so it also returns
 * every other key that merely starts with this one (`v1.0.1.zip` also matches
 * `v1.0.1.zip.bak`); only entries whose Key is exactly `key` count. The one to
 * delete is that key's current (IsLatest) real version, and it must still be
 * the object the plan was made against: same ETag and same Size as the item
 * that was listed, copied and verified. If the legacy key was rebuilt or
 * replaced between the plan and this delete, the version now current is NOT
 * the one whose copy was verified, and deleting it would destroy content that
 * exists nowhere else. A delete marker on top means there is no current
 * version to delete at all.
 */
export function selectVersionToDelete(
  key: string,
  versions: ObjectVersionInfo[],
  planned: { size: number; etag: string },
): { ok: true; versionId: string } | { ok: false; reason: string } {
  const current = versions.find((v) => v.Key === key && v.IsLatest);
  if (!current) {
    return {
      ok: false,
      reason: `no current version of ${key} to delete (it is gone, or a delete marker is on top)`,
    };
  }
  if (current.ETag !== planned.etag || current.Size !== planned.size) {
    return {
      ok: false,
      reason: `the current version ${current.VersionId} of ${key} is not the object that was planned and verified (planned size ${planned.size} ETag ${planned.etag}; found size ${current.Size} ETag ${current.ETag})`,
    };
  }
  return { ok: true, versionId: current.VersionId };
}

export interface LeftoverVersion {
  kind: "version" | "delete-marker";
  versionId: string;
}

/**
 * What still exists under EXACTLY `key` after its current version was deleted:
 * older (noncurrent) versions and delete markers. Deleting the current version
 * lets the next one down become current again, so a leftover version means the
 * legacy key can reappear holding an older build, and it is storage the delete
 * did not free. Pure; other keys the prefix listing dragged in never count.
 */
export function findLeftoverVersions(
  key: string,
  versions: ObjectVersionInfo[],
  deleteMarkers: ObjectVersionInfo[],
): LeftoverVersion[] {
  return [
    ...versions
      .filter((v) => v.Key === key)
      .map((v) => ({ kind: "version" as const, versionId: v.VersionId })),
    ...deleteMarkers
      .filter((v) => v.Key === key)
      .map((v) => ({ kind: "delete-marker" as const, versionId: v.VersionId })),
  ];
}

/** `args` with the region this run was told to use, as the CLI's own flag. */
export function withRegion(args: string[], region: string): string[] {
  return [...args, "--region", region];
}

/** A byte count as GiB / MiB / KiB / bytes, for progress lines. */
export function formatBytes(bytes: number): string {
  const GiB = 1024 ** 3;
  const MiB = 1024 ** 2;
  const KiB = 1024;
  if (bytes >= GiB) return `${(bytes / GiB).toFixed(2)} GiB`;
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(1)} MiB`;
  if (bytes >= KiB) return `${(bytes / KiB).toFixed(1)} KiB`;
  return `${bytes} bytes`;
}

/** True for a bucket-listing "directory" prefix shaped like a NEMAR dataset id. */
export function isDatasetIdPrefix(prefix: string): boolean {
  if (!prefix.endsWith("/")) return false;
  return DATASET_ID_RE.test(prefix.slice(0, -1));
}

/**
 * Classify a FAILED `aws s3api head-object` invocation from its captured
 * stderr. A genuine 404/NoSuchKey/NotFound means "no such object" -- the
 * one case where treating the destination as absent is correct. Any other
 * failure (throttling, a network blip, a permissions hiccup) must NOT be
 * read the same way: `decideRenameAction` treats a null destination as
 * "copy", and copying on the strength of an unrelated error could
 * overwrite a destination that may well exist.
 *
 * The match is anchored on the CLI's own error line, `An error occurred
 * (404) when calling the HeadObject operation: Not Found`. A bare `404`
 * anywhere in stderr is NOT a not-found signal: the CLI's connection-error
 * text embeds the request URL, and the URL embeds the key
 * (`Could not connect to the endpoint URL: ".../nm000404_v1.0.0.zip"`), so a
 * dataset id containing 404 would have read a dropped connection as "the
 * destination does not exist" and copied over one that does.
 */
export function classifyHeadObjectError(stderr: string): "not-found" | "error" {
  return /An error occurred \((404|NoSuchKey|NotFound)\)/i.test(stderr) ? "not-found" : "error";
}

// ---------------------------------------------------------------------------
// AWS CLI orchestration. Everything below this line shells out to `aws`. It is
// exercised through the script's real entry point, with the real `aws` binary
// against a local S3 stand-in, in test/rename-archives-tagging.test.ts and
// test/rename-archives-copy.test.ts (the pure functions above carry the
// planning, verification and selection rules and are unit-tested directly).
// ---------------------------------------------------------------------------

interface Args {
  apply: boolean;
  bucket: string;
  region: string;
  dataset: string | null;
  deleteStaleLegacy: boolean;
}

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d+$/;

function parseArgs(argv: string[]): Args {
  let apply = false;
  let bucket = "nemar";
  let region = "us-east-2";
  let dataset: string | null = null;
  let deleteStaleLegacy = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--apply") apply = true;
    else if (arg === "--delete-stale-legacy") deleteStaleLegacy = true;
    else if (arg === "--bucket") bucket = value();
    else if (arg === "--region") region = value();
    else if (arg === "--dataset") dataset = value();
    else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!REGION_RE.test(region)) throw new Error(`--region "${region}" is not an AWS region name`);
  return { apply, bucket, region, dataset, deleteStaleLegacy };
}

/** The region every `aws` call in this run is given; set once by `main`. */
let awsRegion = "us-east-2";

function runAws(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(["aws", ...withRegion(args, awsRegion)], {
    stdout: "pipe",
    stderr: "pipe",
  });
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function guardAwsCredentials(region: string): void {
  const guardPath = new URL("./lib/aws-creds-guard.sh", import.meta.url).pathname;
  // Path and region reach bash as positional parameters, never interpolated
  // into the command string.
  const res = spawnSync(
    [
      "bash",
      "-c",
      'source "$1" && nemar_guard_aws_credentials "$2"',
      "aws-creds-guard",
      guardPath,
      region,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
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

/**
 * Every version and delete marker under the PREFIX `key` (so also under any
 * other key that merely starts with it; `selectVersionToDelete` and
 * `findLeftoverVersions` filter to the exact key). THROWS on a CLI error --
 * every caller decides what a failed listing means for its own item.
 */
function listKeyVersions(
  bucket: string,
  key: string,
): { versions: ObjectVersionInfo[]; deleteMarkers: ObjectVersionInfo[] } {
  const page = runAwsJson<{ Versions?: ObjectVersionInfo[]; DeleteMarkers?: ObjectVersionInfo[] }>([
    "s3api",
    "list-object-versions",
    "--bucket",
    bucket,
    "--prefix",
    key,
  ]);
  return { versions: page.Versions ?? [], deleteMarkers: page.DeleteMarkers ?? [] };
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

/** The key's current tag set. THROWS on a CLI error. */
function readTagSet(bucket: string, key: string): Tag[] {
  const read = runAwsJson<{ TagSet?: Tag[] }>([
    "s3api",
    "get-object-tagging",
    "--bucket",
    bucket,
    "--key",
    key,
  ]);
  return read.TagSet ?? [];
}

/**
 * Make sure the rename destination carries `nemar-kind=archive`, and confirm
 * it does, before the caller is allowed to delete the old object. Used on the
 * "copy" path (a fresh copy is untagged), the "already-renamed" path (a
 * previous run may have copied the object and died before tagging it) and the
 * "delete-stale-legacy" path (the winner is normally already tagged by the
 * workflow that wrote it, and is verified rather than assumed).
 *
 * `put-object-tagging` REPLACES the whole tag set, so this reads the existing
 * tags first and writes them back with `nemar-kind=archive` merged in. If the
 * tag is already there the write is skipped (nothing to do, and nothing to
 * clobber). If the existing tags cannot be read, nothing is written: a blind
 * put could erase tags this script never saw. After a write the tag set is
 * read back and the tag must actually be in it -- a write S3 acknowledged but
 * did not keep is not a tagged object.
 */
function tagDestination(bucket: string, key: string): boolean {
  let existing: Tag[];
  try {
    existing = readTagSet(bucket, key);
  } catch (err) {
    console.error(`  FAILED to read the existing tag set on ${key}: ${errorMessage(err)}`);
    console.error(
      "  refusing to tag blind (a put replaces the whole tag set) and refusing to delete the old object.",
    );
    return false;
  }
  if (hasArchiveTag(existing)) {
    console.log(`  ${key} already carries nemar-kind=archive; no tag write needed.`);
    return true;
  }
  const tag = runAws(buildTagArgs(bucket, key, mergeArchiveTag(existing)));
  if (!tag.ok) {
    console.error(`  FAILED to tag ${key}: ${tag.stderr.trim()}`);
    console.error("  refusing to delete the old object: tagging failed.");
    return false;
  }
  let tagSet: Tag[];
  try {
    tagSet = readTagSet(bucket, key);
  } catch (err) {
    console.error(`  FAILED to read back the tag set on ${key}: ${errorMessage(err)}`);
    console.error("  refusing to delete the old object: could not verify the tag.");
    return false;
  }
  if (!hasArchiveTag(tagSet)) {
    console.error(`  FAILED: ${key} has no nemar-kind=archive tag after tagging it`);
    console.error("  refusing to delete the old object: tag verification failed.");
    return false;
  }
  console.log(
    `  tagged and verified ${key} (nemar-kind=archive, ${existing.length} other tag(s) kept).`,
  );
  return true;
}

/** Whether versions/markers were still left under the legacy key after its delete. */
type Leftover = "none" | "found" | "unchecked";

/**
 * Delete the legacy object's CURRENT version, by version id, after checking
 * that it is still the object the plan verified (same ETag and Size), then
 * list what is left under exactly that key. Never a bare `aws s3 rm`: the
 * bucket is versioned, so that only adds a delete marker and frees nothing.
 *
 * A failed listing is a failed ITEM, not a failed run: nothing has been
 * deleted yet, and a re-run resumes here (the destination verifies, so the
 * item is "already-renamed"). Leftover versions and markers are reported and
 * counted but never deleted: they may be someone's older builds, and deleting
 * the current version already made the newest of them current again.
 */
function deleteOldByVersionId(
  bucket: string,
  item: RenamePlanItem,
): { ok: boolean; leftover: Leftover } {
  const oldKey = item.oldKey;
  let before: ReturnType<typeof listKeyVersions>;
  try {
    before = listKeyVersions(bucket, oldKey);
  } catch (err) {
    console.error(`  FAILED: could not list the versions of ${oldKey}: ${errorMessage(err)}`);
    console.error("  refusing to delete the old object; nothing deleted, a re-run resumes here.");
    return { ok: false, leftover: "none" };
  }
  const pick = selectVersionToDelete(oldKey, before.versions, item);
  if (!pick.ok) {
    console.error(`  FAILED: ${pick.reason}`);
    console.error("  refusing to delete the old object.");
    return { ok: false, leftover: "none" };
  }
  const versionId = pick.versionId;
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
    return { ok: false, leftover: "none" };
  }
  console.log(`  deleted old object ${oldKey} (version ${versionId}).`);

  try {
    const after = listKeyVersions(bucket, oldKey);
    const leftovers = findLeftoverVersions(oldKey, after.versions, after.deleteMarkers);
    if (leftovers.length === 0) return { ok: true, leftover: "none" };
    const named = leftovers.map((l) => `${l.kind} ${l.versionId}`).join(", ");
    console.warn(
      `  WARNING: ${oldKey} still has ${leftovers.length} other version(s)/marker(s) after the delete: ${named}. Deleting the current version lets the newest of these become current again, so the legacy key may now hold an older build. NOT deleted; look at them by hand.`,
    );
    return { ok: true, leftover: "found" };
  } catch (err) {
    console.warn(
      `  WARNING: deleted ${oldKey}, but could not re-list its versions to check for leftovers (${errorMessage(err)}). Leftover check did NOT run for this key.`,
    );
    return { ok: true, leftover: "unchecked" };
  }
}

/** Outcome of type-checking every one of the (up to) 4 actions in one place. */
type ActionOutcome = "renamed" | "skipped-collision" | "failed";

interface ProcessResult {
  outcome: ActionOutcome;
  leftover: Leftover;
}

const done = (outcome: ActionOutcome, leftover: Leftover = "none"): ProcessResult => ({
  outcome,
  leftover,
});

async function processOne(
  bucket: string,
  item: RenamePlanItem,
  apply: boolean,
  allowDeleteStaleLegacy: boolean,
): Promise<ProcessResult> {
  console.log(
    `[${item.datasetId}] ${item.oldKey} -> ${item.newKey} (${item.size} bytes, ${formatBytes(item.size)})`,
  );

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
    return done("failed");
  }
  const dest = destResult.status === "found" ? destResult : null;
  const decision = decideRenameAction(item, dest, { allowDeleteStaleLegacy });

  if (!apply) {
    console.log(
      `  [dry-run] would: ${decision.action}${"reason" in decision ? ` (${decision.reason})` : ""}`,
    );
    return done(decision.action === "skip-collision" ? "skipped-collision" : "renamed");
  }

  switch (decision.action) {
    case "copy": {
      console.log(
        `  copying ${formatBytes(item.size)} server-side (aws s3 cp; multipart from 8 MiB up). Nothing more is printed until the copy finishes, which for a large archive takes a while...`,
      );
      const copy = runAws(buildCopyArgs(bucket, item));
      if (!copy.ok) {
        console.error(`  FAILED to copy: ${copy.stderr.trim()}`);
        return done("failed");
      }
      const verifiedDestResult = headObject(bucket, item.newKey);
      if (verifiedDestResult.status === "error") {
        console.error(
          `  FAILED to verify copy: could not confirm ${item.newKey} exists after copy (head-object error, not a 404): ${verifiedDestResult.detail}`,
        );
        console.error("  refusing to delete the old object: verification failed.");
        return done("failed");
      }
      const verifiedDest = verifiedDestResult.status === "found" ? verifiedDestResult : null;
      const verdict = verifyRenameCopy(item, verifiedDest);
      console.log(`  verify: ${verdict.ok ? "OK" : "FAILED"} -- ${verdict.reason}`);
      if (!verdict.ok) {
        console.error("  refusing to delete the old object: verification failed.");
        return done("failed");
      }
      console.log("  tagging destination (nemar-kind=archive)...");
      if (!tagDestination(bucket, item.newKey)) return done("failed");
      const del = deleteOldByVersionId(bucket, item);
      return done(del.ok ? "renamed" : "failed", del.leftover);
    }
    case "already-renamed": {
      console.log(
        "  destination already present and verified (resumed run); tagging it (a prior run may have died before tagging) and deleting the stale old object.",
      );
      if (!tagDestination(bucket, item.newKey)) return done("failed");
      const del = deleteOldByVersionId(bucket, item);
      return done(del.ok ? "renamed" : "failed", del.leftover);
    }
    case "delete-stale-legacy": {
      console.log(
        "  destination is newer, non-empty and at least as large; trusting it as the winner. Making sure it is tagged (nemar-kind=archive, other tags kept), then deleting only the legacy source.",
      );
      if (!tagDestination(bucket, item.newKey)) return done("failed");
      const del = deleteOldByVersionId(bucket, item);
      return done(del.ok ? "renamed" : "failed", del.leftover);
    }
    case "skip-collision": {
      console.warn(`  SKIP (collision, neither object touched): ${decision.reason}`);
      return done("skipped-collision");
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  awsRegion = args.region;
  guardAwsCredentials(args.region);

  if (!args.apply) {
    console.log("=== DRY RUN (pass --apply to actually rename) ===\n");
  }

  const datasetIds = args.dataset ? [args.dataset] : listDatasetIds(args.bucket);
  console.log(`Scanning ${datasetIds.length} dataset id(s) under s3://${args.bucket}/...\n`);

  let renamed = 0;
  let failed = 0;
  let skipped = 0;
  let collisions = 0;
  let leftoverKeys = 0;
  let leftoverUnchecked = 0;

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
      const result = await processOne(args.bucket, item, args.apply, args.deleteStaleLegacy);
      if (result.outcome === "renamed") renamed++;
      else if (result.outcome === "skipped-collision") collisions++;
      else failed++;
      if (result.leftover === "found") leftoverKeys++;
      else if (result.leftover === "unchecked") leftoverUnchecked++;
    }
  }

  console.log(
    `\nDone. ${args.apply ? "Renamed" : "Would rename"}: ${renamed}, skipped (already renamed / out of scope): ${skipped}, collisions (left untouched): ${collisions}, failed: ${failed}, legacy keys with leftover versions: ${leftoverKeys}, leftover check did not run: ${leftoverUnchecked}.`,
  );
  if (collisions > 0) {
    console.log(
      "Collisions need a human look. For each, inspect the destination first (head-object: size, ETag and LastModified against the legacy object), and only if it is the real latest re-run with --delete-stale-legacy; otherwise leave them.",
    );
  }
  if (leftoverKeys > 0 || leftoverUnchecked > 0) {
    console.log(
      "Some legacy keys still have other versions or delete markers (see the WARNING lines above), or could not be checked. They were NOT deleted; the newest remaining version of a key may now be current again.",
    );
  }
  // A collision is a deliberate no-op, not a rename, and a failure is a
  // failure: either way the sweep is not finished, so the exit status says so.
  if (failed > 0 || collisions > 0) process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
