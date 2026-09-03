/**
 * Semver utility for dataset versioning
 *
 * Provides parsing, bumping, comparison, and validation for semantic versions.
 * Supports only stable versions (X.Y.Z) without pre-release or build metadata.
 *
 * Backed by the `semver` package. Two edge cases were measured against the
 * hand-rolled regex this replaced (epic #1225 phase 6) and are handled
 * explicitly below: a leading-zero component (e.g. "01.2.3") is a narrowing
 * (the old regex accepted it; semver correctly rejects it as invalid semver),
 * and surrounding whitespace (e.g. " 1.2.3 ") is a widening semver's parser
 * would otherwise introduce (it trims and accepts) that this module refuses
 * to keep, since a whitespace-padded version would flow into a git tag name.
 */

import semver from "semver";

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse a version string into components.
 * Accepts optional leading "v" prefix.
 * Returns null if the string is not a valid stable semver.
 */
export function parseVersion(v: string): ParsedVersion | null {
  // Reject whitespace-padded input explicitly: semver's parser trims
  // surrounding whitespace and would accept " 1.2.3 ", but this module must
  // not widen what the old strict regex accepted, since the result flows
  // into a git tag name.
  if (v !== v.trim()) return null;

  const parsed = semver.parse(v);
  if (!parsed) return null;

  // Stable dataset versions only: semver.parse() happily returns a parsed
  // object for "1.2.3-dev0" or "1.2.3+build"; this module must not.
  if (parsed.prerelease.length > 0 || parsed.build.length > 0) return null;

  return { major: parsed.major, minor: parsed.minor, patch: parsed.patch };
}

/**
 * Bump a version string by the given type.
 * Returns the new version without a "v" prefix.
 */
export function bumpVersion(current: string, type: "patch" | "minor" | "major"): string {
  const parsed = parseVersion(current);
  if (!parsed) {
    throw new Error(`Invalid version: ${current}`);
  }

  const bumped = semver.inc(`${parsed.major}.${parsed.minor}.${parsed.patch}`, type);
  if (!bumped) {
    throw new Error(`Invalid version: ${current}`);
  }
  return bumped;
}

/**
 * Check if a string is a valid stable semver (X.Y.Z, no pre-release).
 * Accepts optional leading "v" prefix.
 */
export function isValidStableVersion(v: string): boolean {
  return parseVersion(v) !== null;
}

/**
 * Compare two version strings.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) {
    throw new Error(`Invalid version(s): ${a}, ${b}`);
  }

  return semver.compare(
    `${pa.major}.${pa.minor}.${pa.patch}`,
    `${pb.major}.${pb.minor}.${pb.patch}`,
  );
}
