/**
 * Update check unit tests
 *
 * Tests for normalizeVersion() and version comparison logic.
 */

import { describe, expect, test } from "bun:test";
import { compareVersions } from "../src/lib/semver";

/**
 * normalizeVersion is not exported, so we replicate its logic here
 * and test it alongside compareVersions to verify the update check behavior.
 */
function normalizeVersion(v: string): string {
  return v.replace(/-.*$/, "");
}

describe("normalizeVersion", () => {
  test("strips dev suffix", () => {
    expect(normalizeVersion("0.7.17-dev")).toBe("0.7.17");
  });

  test("strips arbitrary pre-release", () => {
    expect(normalizeVersion("1.0.0-beta.1")).toBe("1.0.0");
  });

  test("leaves stable version unchanged", () => {
    expect(normalizeVersion("0.7.17")).toBe("0.7.17");
  });

  test("strips rc suffix", () => {
    expect(normalizeVersion("2.0.0-rc.3")).toBe("2.0.0");
  });
});

describe("update check version comparison", () => {
  test("detects newer version available", () => {
    const current = normalizeVersion("0.7.17-dev");
    expect(compareVersions("0.7.18", current)).toBeGreaterThan(0);
  });

  test("no update when current is latest", () => {
    const current = normalizeVersion("0.7.17");
    expect(compareVersions("0.7.17", current)).toBe(0);
  });

  test("no update when current is newer", () => {
    const current = normalizeVersion("0.8.0");
    expect(compareVersions("0.7.17", current)).toBeLessThan(0);
  });

  test("dev version detects update to next patch", () => {
    const current = normalizeVersion("0.7.17-dev");
    // 0.7.17-dev normalizes to 0.7.17; 0.7.17 is NOT newer (equal)
    expect(compareVersions("0.7.17", current)).toBe(0);
    // But 0.7.18 IS newer
    expect(compareVersions("0.7.18", current)).toBeGreaterThan(0);
  });
});
