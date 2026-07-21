import type { VersionManifest } from "./api/datasets.js";

export interface ManifestDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

/**
 * `key` is the git-annex content-addressed key: equal keys ⇒ identical content.
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
