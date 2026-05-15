/**
 * Version Manifest Service
 *
 * Generates JSON manifests from git-annex state at a given tag.
 * Manifests map file paths to S3 annex keys for direct access
 * without requiring a git clone (used by web frontend).
 */

import { type TreeEntry, getBlobContent, getTreeAtRef } from "./github";

export interface ManifestFile {
  key: string;
  size: number;
  checksum: string;
}

export interface VersionManifest {
  dataset_id: string;
  version: string;
  doi: string | null;
  concept_doi: string | null;
  created: string;
  files: Record<string, ManifestFile>;
}

/**
 * Parse a git-annex pointer file content to extract the annex key.
 *
 * Annex pointer files have content like:
 *   /annex/objects/SHA256E-s12345--abc123def456.edf
 *
 * The key format is: BACKEND-sNNNN--HASH.ext
 * where BACKEND is SHA256E, MD5E, etc.
 */
export function parseAnnexPointer(content: string): string | null {
  const trimmed = content.trim();
  // Match git-annex pointer format
  const match = trimmed.match(/^\/annex\/objects\/(.+)$/);
  if (match) return match[1];

  // Also match the symlink target format used in locked mode
  // e.g., .git/annex/objects/XX/YY/SHA256E-s12345--abc123.edf/SHA256E-s12345--abc123.edf
  const symlinkMatch = trimmed.match(
    /\.git\/annex\/objects\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/([^/]+)\/\1$/,
  );
  if (symlinkMatch) return symlinkMatch[1];

  return null;
}

/**
 * Extract size from an annex key.
 * Key format: SHA256E-s12345--abc123.ext
 * The -sNNNN part indicates the file size in bytes.
 */
export function extractSizeFromKey(key: string): number {
  const match = key.match(/-s(\d+)--/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

/**
 * Extract the hash algorithm prefix from an annex key.
 * Key format: SHA256E-s12345--abc123.ext
 * Returns lowercase algorithm name (e.g., "sha256", "md5").
 */
export function extractHashAlgorithm(key: string): string {
  const match = key.match(/^([A-Z0-9]+?)E?-s/);
  return match ? match[1].toLowerCase() : "sha256";
}

/**
 * Extract the hash/checksum from an annex key.
 * Key format: SHA256E-s12345--abc123def456.ext
 * The hash is between -- and the last .ext
 */
export function extractChecksumFromKey(key: string): string {
  const match = key.match(/--([a-fA-F0-9]+)/);
  return match ? match[1] : "";
}

/**
 * Generate a version manifest by traversing the git tree at a tag
 * and resolving annex pointer files to their S3 keys.
 */
export async function generateManifest(
  repo: string,
  version: string,
  pat: string,
  datasetId: string,
  doi: string | null,
  conceptDoi: string | null,
): Promise<VersionManifest> {
  const tag = version.startsWith("v") ? version : `v${version}`;

  // Get all blobs in the tree at this tag
  const entries = await getTreeAtRef(repo, tag, pat);

  // Internal git plumbing — we never expose these to the manifest.
  // The trailing `/` on `.git/` is intentional: a bare `.git` prefix would
  // also match `.gitattributes` and `.gitignore`, both of which are legit
  // BIDS-root files we DO want in the manifest. `.github/` is treated
  // separately (workflows for the dataset repo, not dataset content).
  function isInternal(entry: TreeEntry): boolean {
    return entry.path.startsWith(".git/") || entry.path.startsWith(".github/");
  }

  // Filter to potential annex pointer files (small blobs that could be pointers)
  // Annex pointers are typically < 500 bytes
  const pointerCandidates = entries.filter(
    (entry) =>
      entry.size !== undefined && entry.size < 500 && entry.size > 20 && !isInternal(entry),
  );

  const files: Record<string, ManifestFile> = {};
  // Pointer candidates whose `parseAnnexPointer` returned null — they're
  // small regular git files (README, CHANGES, dataset_description.json on
  // OpenNeuro mirrors are commonly <500 bytes), NOT annex pointers. They
  // need to flow into the regular-files loop instead of being silently
  // dropped (see nemarOrg/nemar-cli#509).
  const nonAnnexCandidates: TreeEntry[] = [];

  // Resolve annex pointer candidates in parallel batches to avoid
  // sequential N+1 GitHub API calls (Cloudflare Workers have a
  // subrequest limit, so we cap concurrency)
  const CONCURRENCY = 10;
  for (let i = 0; i < pointerCandidates.length; i += CONCURRENCY) {
    const batch = pointerCandidates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (entry) => {
        const content = await getBlobContent(repo, entry.sha, pat);
        const key = parseAnnexPointer(content);
        return { entry, key };
      }),
    );
    for (const { entry, key } of results) {
      if (key) {
        files[entry.path] = {
          key,
          size: extractSizeFromKey(key),
          checksum: `${extractHashAlgorithm(key)}:${extractChecksumFromKey(key)}`,
        };
      } else {
        nonAnnexCandidates.push(entry);
      }
    }
  }

  // Build the regular-files set: every git-tree entry that isn't internal
  // plumbing, isn't already in `files` (resolved as annex), and isn't a
  // size-range pointer candidate that actually WAS an annex pointer.
  // The `nonAnnexCandidates` we collected above are deliberately included.
  const pointerCandidatePaths = new Set(pointerCandidates.map((p) => p.path));
  const regularFiles: TreeEntry[] = [
    ...nonAnnexCandidates,
    ...entries.filter((entry) => !isInternal(entry) && !pointerCandidatePaths.has(entry.path)),
  ];

  for (const entry of regularFiles) {
    // Regular files stored in git (metadata, TSV, JSON, etc.)
    files[entry.path] = {
      key: `git:${entry.sha}`,
      size: entry.size ?? 0,
      checksum: `git:${entry.sha}`,
    };
  }

  return {
    dataset_id: datasetId,
    version: version.replace(/^v/, ""),
    doi,
    concept_doi: conceptDoi,
    created: new Date().toISOString(),
    files,
  };
}
