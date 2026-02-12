/**
 * Semver utility for dataset versioning
 *
 * Provides parsing, bumping, comparison, and validation for semantic versions.
 * Supports only stable versions (X.Y.Z) without pre-release or build metadata.
 */

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
  const match = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
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

  switch (type) {
    case "patch":
      return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
    case "minor":
      return `${parsed.major}.${parsed.minor + 1}.0`;
    case "major":
      return `${parsed.major + 1}.0.0`;
  }
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

  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}
