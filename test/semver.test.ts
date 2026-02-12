import { describe, expect, test } from "bun:test";
import {
  bumpVersion,
  compareVersions,
  isValidStableVersion,
  parseVersion,
} from "../src/lib/semver";

describe("parseVersion", () => {
  test("parses standard semver", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  test("parses with v prefix", () => {
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  test("parses zero version", () => {
    expect(parseVersion("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0 });
  });

  test("returns null for pre-release", () => {
    expect(parseVersion("1.0.0-dev")).toBeNull();
  });

  test("returns null for build metadata", () => {
    expect(parseVersion("1.0.0+build")).toBeNull();
  });

  test("returns null for incomplete version", () => {
    expect(parseVersion("1.0")).toBeNull();
    expect(parseVersion("1")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseVersion("")).toBeNull();
  });

  test("returns null for non-numeric", () => {
    expect(parseVersion("a.b.c")).toBeNull();
  });
});

describe("bumpVersion", () => {
  test("bumps patch", () => {
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
  });

  test("bumps minor", () => {
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
  });

  test("bumps major", () => {
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
  });

  test("bumps from v-prefixed version", () => {
    expect(bumpVersion("v1.0.0", "patch")).toBe("1.0.1");
  });

  test("throws on invalid version", () => {
    expect(() => bumpVersion("invalid", "patch")).toThrow("Invalid version");
  });
});

describe("isValidStableVersion", () => {
  test("accepts standard semver", () => {
    expect(isValidStableVersion("1.0.0")).toBe(true);
    expect(isValidStableVersion("0.1.0")).toBe(true);
    expect(isValidStableVersion("10.20.30")).toBe(true);
  });

  test("accepts v-prefixed", () => {
    expect(isValidStableVersion("v1.0.0")).toBe(true);
  });

  test("rejects pre-release", () => {
    expect(isValidStableVersion("1.0.0-dev")).toBe(false);
  });

  test("rejects incomplete", () => {
    expect(isValidStableVersion("1.0")).toBe(false);
  });

  test("rejects empty", () => {
    expect(isValidStableVersion("")).toBe(false);
  });
});

describe("compareVersions", () => {
  test("equal versions", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  test("major difference", () => {
    expect(compareVersions("2.0.0", "1.0.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "2.0.0")).toBeLessThan(0);
  });

  test("minor difference", () => {
    expect(compareVersions("1.2.0", "1.1.0")).toBeGreaterThan(0);
    expect(compareVersions("1.1.0", "1.2.0")).toBeLessThan(0);
  });

  test("patch difference", () => {
    expect(compareVersions("1.0.2", "1.0.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.1", "1.0.2")).toBeLessThan(0);
  });

  test("handles v prefix", () => {
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });

  test("throws on invalid version", () => {
    expect(() => compareVersions("invalid", "1.0.0")).toThrow("Invalid version");
  });
});
