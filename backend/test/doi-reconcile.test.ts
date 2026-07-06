/**
 * DOI version-mint reconcile helpers (epic #896, #900).
 *
 * The reconcile sweep itself hits EZID + D1; these pin the pure DOI-parsing
 * used to select and route candidates (prod vs sandbox shoulder, version).
 */

import { describe, expect, test } from "bun:test";
import { isEzidNemarDoi, isSandboxDoi, versionFromVersionDoi } from "../src/services/doi-reconcile";

describe("versionFromVersionDoi", () => {
  test("extracts the semver from a NEMAR version DOI", () => {
    expect(versionFromVersionDoi("10.82901/NEMAR.NM000104.V1.0.0")).toBe("1.0.0");
    expect(versionFromVersionDoi("10.5072/FK2NM000104.V2.3.4")).toBe("2.3.4");
    expect(versionFromVersionDoi("10.82901/NEMAR.NM000104.V1.0.0-rc1")).toBe("1.0.0-rc1");
  });

  test("returns null for a concept DOI (no .V suffix) or garbage", () => {
    expect(versionFromVersionDoi("10.82901/NEMAR.NM000104")).toBeNull();
    expect(versionFromVersionDoi("not-a-doi")).toBeNull();
  });
});

describe("shoulder classification", () => {
  test("isSandboxDoi", () => {
    expect(isSandboxDoi("10.5072/FK2NM000104.V1.0.0")).toBe(true);
    expect(isSandboxDoi("10.82901/NEMAR.NM000104.V1.0.0")).toBe(false);
  });

  test("isEzidNemarDoi accepts both shoulders, rejects others", () => {
    expect(isEzidNemarDoi("10.82901/NEMAR.NM000104.V1.0.0")).toBe(true);
    expect(isEzidNemarDoi("10.5072/FK2NM000104.V1.0.0")).toBe(true);
    expect(isEzidNemarDoi("10.5281/zenodo.123456")).toBe(false); // Zenodo
    expect(isEzidNemarDoi("")).toBe(false);
  });
});
