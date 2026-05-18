/**
 * Unit tests for the doctor framework's registry surface.
 *
 * The IO-heavy parts of each check (S3 head, GitHub tree fetch, manifest
 * upload) are validated end-to-end against production-shaped data via the
 * /admin/doctor/scan + /admin/doctor/fix routes after deploy -- that's the
 * "no mocks" testing path. What this file pins is:
 *
 *   - the registry actually contains every check we expect (lookup by name
 *     works, listChecks enumerates them)
 *   - each check declares the required shape (name, description, scan, fix)
 *
 * If a check is accidentally removed from the registry array, or someone
 * renames it without updating call sites, this test fails loudly.
 */

import { describe, expect, test } from "bun:test";
import { DOCTOR_CHECKS, getCheck, listChecks } from "../backend/src/services/doctor/registry";

describe("doctor registry", () => {
  test("contains missing-manifest check", () => {
    const check = getCheck("missing-manifest");
    expect(check).toBeDefined();
    expect(check?.name).toBe("missing-manifest");
    expect(check?.description).toMatch(/dataset_versions.*S3.*manifest/i);
  });

  test("getCheck returns undefined for unknown names (not a stub)", () => {
    expect(getCheck("nonexistent-check")).toBeUndefined();
    expect(getCheck("")).toBeUndefined();
  });

  test("listChecks exposes name+description pairs", () => {
    const list = listChecks();
    expect(list.length).toBe(DOCTOR_CHECKS.length);
    for (const item of list) {
      expect(typeof item.name).toBe("string");
      expect(item.name.length).toBeGreaterThan(0);
      expect(typeof item.description).toBe("string");
      expect(item.description.length).toBeGreaterThan(0);
    }
  });

  test("every registered check declares scan and fix as functions", () => {
    for (const check of DOCTOR_CHECKS) {
      expect(typeof check.scan).toBe("function");
      expect(typeof check.fix).toBe("function");
    }
  });

  test("check names are unique (registry can't have collisions)", () => {
    const names = DOCTOR_CHECKS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
