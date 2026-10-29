/**
 * What a version number may say on a mirror (ADR 0006, ADR 0111 decision 5): a major version of an
 * OpenNeuro mirror means an upstream re-pull, so NEMAR's own changes to a mirror take minor and
 * patch, and a major is made only by `nemar admin repull`.
 *
 * The rule is the CLI's: `nemar dataset release` (every spelling that reaches a higher major:
 * `--type major`, `--version`, the interactive `major` and `custom version`) and
 * `nemar dataset update --bump major` ask it after the new version is settled and before anything
 * is cloned, changed or pushed. The dataset repositories' `version-check` workflow does not read it,
 * so a major merged outside NEMAR's CLI is not stopped (ADR 0020: a workflow change reaches every
 * dataset repository at once).
 */

import { parseVersion } from "./semver.js";

/** A mirror: an `on` id, or a dataset row recorded as imported from OpenNeuro. */
export function isMirror(datasetId: string, source: string | null | undefined): boolean {
  return datasetId.startsWith("on") || source === "openneuro";
}

/**
 * Why `next` may not follow `current` for this dataset, or null when it may: a higher major on a
 * mirror. On a mirror, a version either side cannot read (empty, `none`, `1.0`, a prerelease) is
 * refused too: whether it is a major is then not known, and unknown is never a pass.
 */
export function refuseMirrorMajor(args: {
  datasetId: string;
  source: string | null | undefined;
  current: string;
  next: string;
}): string | null {
  if (!isMirror(args.datasetId, args.source)) return null;
  const current = parseVersion(args.current);
  const next = parseVersion(args.next);
  if (!current || !next) {
    return `${args.datasetId} is a mirror, and its version ${JSON.stringify(args.current)} -> ${JSON.stringify(args.next)} cannot be read as two releases, so whether it is a major (an upstream re-pull, ADR 0111) is not known; it is not released by hand. A version is of the form X.Y.Z (three numbers, such as 1.2.0, with no prerelease): give one with --version X.Y.Z, or correct the dataset's Version to that form first.`;
  }
  if (next.major <= current.major) return null;
  return `A major version of a mirror means an upstream re-pull (ADR 0006, ADR 0111): ${args.datasetId} ${args.current} -> ${args.next} is not released by hand. Plan one with: nemar admin repull plan ${args.datasetId}`;
}
