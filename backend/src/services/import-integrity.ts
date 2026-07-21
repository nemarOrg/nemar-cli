/**
 * Import S3 integrity primitive (epic #967 Phase 2, issue #969).
 *
 * Cheap, Worker-side per-key verification: does every annex-keyed file in a
 * dataset's published version manifest actually exist in S3 at its declared
 * size? This is the general check behind two callers:
 *   - the retry engine's reclassification sweep, which walks `complete`
 *     import_jobs rows looking for the #967 bug (a failed curl fallback left
 *     a 0-byte object behind, so the import silently under-delivered), and
 *   - the retry engine's "verify current state first" step before deciding
 *     whether to blocklist or re-dispatch an incomplete/failed/quarantined row.
 *
 * `annexKeyDeclaredSize`/`isKeyPresentAtDeclaredSize` below are a Workers-side
 * port of the identically-named Phase 1 helpers in `src/lib/s3-server-copy.ts`
 * (CLI code; not importable into a Workers bundle -- it pulls in node:fs at
 * module scope via git-annex/run-command.js). Keep the regex and null-vs-0
 * semantics in sync if either changes.
 */

import type { Bindings } from "../types/bindings.js";
import { versionFromDoi } from "./archive-retry.js";
import { type PresignedUrlOptions, getManifest, listObjectSizes } from "./s3.js";

/**
 * Declared size (bytes) encoded in a git-annex key, e.g.
 * `SHA256E-s10565888--abc123.edf` -> 10565888. Returns null for a `git:`-keyed
 * (non-annex) manifest entry or anything that doesn't match the pattern, so
 * callers can tell "no declared size" apart from "0 bytes claimed".
 */
export function annexKeyDeclaredSize(key: string): number | null {
  const match = key.match(/-s(\d+)--/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * True when `key` is present in `existing` (a key -> byte-size map from
 * {@link import("./s3.js").listObjectSizes}) at its correct size. An annex
 * key's declared size must match exactly -- a 0-byte or truncated object
 * counts as absent even though the key exists (the #967 bug). A key with no
 * declared size (shouldn't reach here; git:-keyed entries are filtered out
 * before this is called) is treated as present-if-listed.
 */
export function isKeyPresentAtDeclaredSize(key: string, existing: Map<string, number>): boolean {
  const actual = existing.get(key);
  if (actual === undefined) return false;
  const declared = annexKeyDeclaredSize(key);
  if (declared === null) return true;
  return actual === declared;
}

/** The subset of VersionManifest (services/manifest.ts) this check needs. */
export interface ExpectedManifestFile {
  key: string;
  size: number;
}

export interface ImportIntegrityResult {
  complete: boolean;
  missingKeys: string[];
  zeroByteKeys: string[];
  expectedCount: number;
  presentCount: number;
}

/**
 * Pure comparison: the manifest's expected annex-keyed files vs. the live
 * `<id>/objects/` listing. `expected` is null when there is no published
 * manifest to compare against (the import never reached finalize/publish) --
 * conservatively `complete: false`, since completeness cannot be claimed
 * without an expected key set. `git:`-keyed entries (regular files stored in
 * GitHub, never copied to S3) are excluded from the expected set entirely.
 *
 * `zeroByteKeys` is the subset of `missingKeys` that IS present in `existing`
 * but at 0 bytes with a nonzero declared size -- the specific "corrupt
 * leftover from a failed copy" signature (#967), distinct from a key that
 * never landed at all. A key whose declared size is genuinely 0 (a real empty
 * file) is never flagged as missing or zero-byte.
 */
export function compareManifestToListing(
  expected: Record<string, ExpectedManifestFile> | null,
  existing: Map<string, number>,
): ImportIntegrityResult {
  if (expected === null) {
    return {
      complete: false,
      missingKeys: [],
      zeroByteKeys: [],
      expectedCount: 0,
      presentCount: existing.size,
    };
  }

  const annexEntries = Object.values(expected).filter((f) => !f.key.startsWith("git:"));
  const missingKeys: string[] = [];
  const zeroByteKeys: string[] = [];
  for (const entry of annexEntries) {
    if (isKeyPresentAtDeclaredSize(entry.key, existing)) continue;
    missingKeys.push(entry.key);
    const declared = annexKeyDeclaredSize(entry.key);
    if (existing.get(entry.key) === 0 && declared !== 0) zeroByteKeys.push(entry.key);
  }

  return {
    complete: missingKeys.length === 0,
    missingKeys,
    zeroByteKeys,
    expectedCount: annexEntries.length,
    presentCount: annexEntries.length - missingKeys.length,
  };
}

interface VersionManifestLike {
  files?: Record<string, ExpectedManifestFile>;
}

/**
 * Parse a version manifest JSON string into its files map, or null when the
 * JSON is unparseable OR parses but carries no `files` key. A manifest with
 * no `files` key is malformed, not "zero expected files" -- returning `{}`
 * there would make {@link compareManifestToListing} report complete:true
 * regardless of what's actually in S3, defeating the conservative-by-default
 * invariant this whole check exists to uphold. Pure; exported for testing.
 */
export function parseManifestFiles(
  manifestJson: string,
): Record<string, ExpectedManifestFile> | null {
  try {
    const parsed = JSON.parse(manifestJson) as VersionManifestLike;
    return parsed.files ?? null;
  } catch {
    return null;
  }
}

/**
 * I/O wrapper: resolve the dataset's latest published version manifest (if
 * any) and the live `<id>/objects/` listing, then run the pure comparison.
 * No manifest (import never finalized), an unparseable one, or one missing
 * `files` all fall back to the `expected: null` path in
 * {@link compareManifestToListing}.
 */
export async function verifyImportS3(
  env: Pick<
    Bindings,
    "DB" | "S3_BUCKET" | "AWS_REGION" | "AWS_ACCESS_KEY_ID" | "AWS_SECRET_ACCESS_KEY"
  >,
  datasetId: string,
): Promise<ImportIntegrityResult> {
  const options: PresignedUrlOptions = {
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  };

  const row = await env.DB.prepare("SELECT latest_version_doi FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ latest_version_doi: string | null }>();
  const version = versionFromDoi(row?.latest_version_doi ?? null);

  let expected: Record<string, ExpectedManifestFile> | null = null;
  if (version) {
    const manifestJson = await getManifest(options, datasetId, version);
    if (manifestJson) {
      const parsedFiles = parseManifestFiles(manifestJson);
      if (parsedFiles) {
        expected = parsedFiles;
      } else {
        console.error(
          `[import-integrity] manifest for ${datasetId}@${version} is unparseable or missing "files"`,
        );
      }
    }
  }

  const existing = await listObjectSizes(options, `${datasetId}/objects/`);
  return compareManifestToListing(expected, existing);
}
