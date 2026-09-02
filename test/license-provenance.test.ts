/**
 * Unit tests for license detection/validation and provenance compatibility.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RECOMMENDED_LICENSES,
  detectLicense,
  ensureLicenseFile,
  generateLicenseText,
  isResearchCompatible,
  updateLicenseInDescription,
} from "../src/lib/license";
import { validateLicenseCompatibility } from "../src/lib/provenance";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "nemar-license-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeDesc(fields: Record<string, unknown>) {
  writeFileSync(join(tmpDir, "dataset_description.json"), JSON.stringify(fields, null, 2));
}

// ---------------------------------------------------------------------------
// detectLicense
// ---------------------------------------------------------------------------

describe("detectLicense", () => {
  test("returns none when dataset_description.json has no License field", () => {
    writeDesc({ Name: "Test" });
    // No License field and no LICENSE file -> falls through to "none"
    const result = detectLicense(tmpDir);
    expect(result.source).toBe("none");
    expect(result.spdxId).toBeUndefined();
  });

  test("detects license from dataset_description.json", () => {
    writeDesc({ Name: "Test", License: "CC-BY-4.0" });
    const result = detectLicense(tmpDir);
    expect(result.spdxId).toBe("CC-BY-4.0");
    expect(result.source).toBe("dataset_description");
  });

  test("returns none when dataset_description.json is absent", () => {
    const result = detectLicense(tmpDir);
    expect(result.source).toBe("none");
    expect(result.spdxId).toBeUndefined();
  });

  test("detects CC0 from LICENSE file content", () => {
    writeDesc({ Name: "Test" });
    writeFileSync(join(tmpDir, "LICENSE"), "CC0 Public Domain Dedication");
    const result = detectLicense(tmpDir);
    expect(result.spdxId).toBe("CC0-1.0");
    expect(result.source).toBe("license_file");
  });

  test("detects CC-BY-4.0 from LICENSE file content", () => {
    writeDesc({ Name: "Test" });
    writeFileSync(join(tmpDir, "LICENSE"), "Creative Commons Attribution creativecommons");
    const result = detectLicense(tmpDir);
    expect(result.spdxId).toBe("CC-BY-4.0");
    expect(result.source).toBe("license_file");
  });

  test("prefers dataset_description.json over LICENSE file", () => {
    writeDesc({ Name: "Test", License: "MIT" });
    writeFileSync(join(tmpDir, "LICENSE"), "CC0 public domain dedication");
    const result = detectLicense(tmpDir);
    expect(result.spdxId).toBe("MIT");
    expect(result.source).toBe("dataset_description");
  });

  test("handles unrecognized LICENSE file (returns undefined spdxId with source=license_file)", () => {
    writeDesc({ Name: "Test" });
    writeFileSync(join(tmpDir, "LICENSE"), "Custom proprietary terms apply.");
    const result = detectLicense(tmpDir);
    expect(result.source).toBe("license_file");
    expect(result.spdxId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isResearchCompatible
// ---------------------------------------------------------------------------

describe("isResearchCompatible", () => {
  test("CC0-1.0 is research compatible", () => {
    expect(isResearchCompatible("CC0-1.0")).toBe(true);
  });

  test("CC-BY-4.0 is research compatible", () => {
    expect(isResearchCompatible("CC-BY-4.0")).toBe(true);
  });

  test("CC-BY-NC-4.0 is research compatible", () => {
    expect(isResearchCompatible("CC-BY-NC-4.0")).toBe(true);
  });

  test("MIT is research compatible", () => {
    expect(isResearchCompatible("MIT")).toBe(true);
  });

  test("all recommended licenses are research compatible", () => {
    for (const lic of RECOMMENDED_LICENSES) {
      expect(isResearchCompatible(lic.spdxId)).toBe(true);
    }
  });

  test("unknown license is not in the compatible list", () => {
    expect(isResearchCompatible("CUSTOM-PROPRIETARY-1.0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ensureLicenseFile
// ---------------------------------------------------------------------------

describe("ensureLicenseFile", () => {
  test("creates LICENSE file if missing", () => {
    const created = ensureLicenseFile(tmpDir, "CC0-1.0");
    expect(created).toBe(true);
    const licensePath = join(tmpDir, "LICENSE");
    expect(existsSync(licensePath)).toBe(true);
  });

  test("does not overwrite existing LICENSE file", () => {
    const originalContent = "My custom license text.";
    writeFileSync(join(tmpDir, "LICENSE"), originalContent);
    const created = ensureLicenseFile(tmpDir, "CC-BY-4.0");
    expect(created).toBe(false);
    expect(readFileSync(join(tmpDir, "LICENSE"), "utf-8")).toBe(originalContent);
  });
});

// ---------------------------------------------------------------------------
// generateLicenseText
// ---------------------------------------------------------------------------

describe("generateLicenseText", () => {
  test("generates text referencing the canonical URL for known licenses", () => {
    const text = generateLicenseText("CC0-1.0");
    expect(text).toContain("creativecommons.org/publicdomain/zero/1.0/");
  });

  test("generates SPDX fallback for unknown license", () => {
    const text = generateLicenseText("MIT");
    expect(text).toContain("SPDX-License-Identifier: MIT");
  });
});

// ---------------------------------------------------------------------------
// updateLicenseInDescription
// ---------------------------------------------------------------------------

describe("updateLicenseInDescription", () => {
  test("sets License field in dataset_description.json", () => {
    writeDesc({ Name: "Test", License: "CC0-1.0" });
    updateLicenseInDescription(tmpDir, "CC-BY-4.0");
    const updated = JSON.parse(
      readFileSync(join(tmpDir, "dataset_description.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(updated.License).toBe("CC-BY-4.0");
  });

  test("adds License field when not present", () => {
    writeDesc({ Name: "Test" });
    updateLicenseInDescription(tmpDir, "CC-BY-4.0");
    const updated = JSON.parse(
      readFileSync(join(tmpDir, "dataset_description.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(updated.License).toBe("CC-BY-4.0");
  });

  test("no-ops if dataset_description.json is missing", () => {
    // Should not throw
    expect(() => updateLicenseInDescription(tmpDir, "CC-BY-4.0")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateLicenseCompatibility
// ---------------------------------------------------------------------------

describe("validateLicenseCompatibility", () => {
  test("CC0 source is compatible with any target", () => {
    expect(validateLicenseCompatibility("CC0-1.0", "CC-BY-4.0").compatible).toBe(true);
    expect(validateLicenseCompatibility("CC0-1.0", "MIT").compatible).toBe(true);
    expect(validateLicenseCompatibility("CC0-1.0", "CC0-1.0").compatible).toBe(true);
  });

  test("CC-BY-4.0 source allows any target", () => {
    expect(validateLicenseCompatibility("CC-BY-4.0", "CC0-1.0").compatible).toBe(true);
    expect(validateLicenseCompatibility("CC-BY-4.0", "CC-BY-NC-4.0").compatible).toBe(true);
  });

  test("CC-BY-SA-4.0 source requires same license", () => {
    const same = validateLicenseCompatibility("CC-BY-SA-4.0", "CC-BY-SA-4.0");
    expect(same.compatible).toBe(true);

    const other = validateLicenseCompatibility("CC-BY-SA-4.0", "CC-BY-4.0");
    expect(other.compatible).toBe(false);
    expect(other.reason).toContain("CC-BY-SA-4.0");
  });

  test("CC-BY-NC-4.0 source disallows fully-open target", () => {
    const result = validateLicenseCompatibility("CC-BY-NC-4.0", "CC-BY-4.0");
    expect(result.compatible).toBe(false);
  });

  test("CC-BY-NC-4.0 source allows NC targets", () => {
    expect(validateLicenseCompatibility("CC-BY-NC-4.0", "CC-BY-NC-4.0").compatible).toBe(true);
    expect(validateLicenseCompatibility("CC-BY-NC-4.0", "CC-BY-NC-SA-4.0").compatible).toBe(true);
  });

  test("ODbL-1.0 source requires ODbL-1.0 target", () => {
    const same = validateLicenseCompatibility("ODbL-1.0", "ODbL-1.0");
    expect(same.compatible).toBe(true);

    const other = validateLicenseCompatibility("ODbL-1.0", "CC0-1.0");
    expect(other.compatible).toBe(false);
  });

  test("unknown source license passes with warning", () => {
    const result = validateLicenseCompatibility("CUSTOM-1.0", "CC-BY-4.0");
    expect(result.compatible).toBe(true);
    expect(result.reason).toContain("not in the compatibility table");
  });
});
