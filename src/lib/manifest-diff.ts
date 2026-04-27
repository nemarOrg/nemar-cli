/**
 * Manifest diff: compute added / changed / removed paths between two version
 * manifests for a dataset.
 *
 * Used by `nemar dataset download --update` to figure out which files to
 * `git annex get` after a fast-forward merge so users only pay for the delta.
 */

import type { VersionManifest } from "./api.js";

export interface ManifestDiff {
  /** Paths present in `to` but not in `from`. */
  added: string[];
  /** Paths present in both, but with a different annex key. */
  changed: string[];
  /** Paths present in `from` but not in `to`. */
  removed: string[];
}

/**
 * Diff two version manifests.
 *
 * The `key` field on each entry is the git-annex content-addressed key, so two
 * versions of the same path compare equal iff their content is identical.
 */
export function diffManifests(from: VersionManifest, to: VersionManifest): ManifestDiff {
  const fromFiles = from.files ?? {};
  const toFiles = to.files ?? {};

  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];

  for (const [path, toEntry] of Object.entries(toFiles)) {
    const fromEntry = fromFiles[path];
    if (!fromEntry) {
      added.push(path);
    } else if (fromEntry.key !== toEntry.key) {
      changed.push(path);
    }
  }

  for (const path of Object.keys(fromFiles)) {
    if (!(path in toFiles)) removed.push(path);
  }

  added.sort();
  changed.sort();
  removed.sort();

  return { added, changed, removed };
}
