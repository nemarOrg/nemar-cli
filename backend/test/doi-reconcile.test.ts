/**
 * DOI version-mint reconcile helpers (epic #896, #900).
 *
 * The reconcile sweep itself hits EZID + D1; these pin the pure DOI-parsing
 * used to select and route candidates (prod vs sandbox shoulder, version).
 */

import { describe, expect, test } from "bun:test";
import { classifyExistingVersionDoi } from "../src/services/doi";
import {
  DOI_RECONCILE_BATCH,
  isEzidNemarDoi,
  isSandboxDoi,
  rotationOffset,
  versionFromVersionDoi,
} from "../src/services/doi-reconcile";

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

describe("classifyExistingVersionDoi (already-exists branch)", () => {
  test("public -> return early (idempotent)", () => {
    expect(classifyExistingVersionDoi("public")).toBe("return_public");
  });
  test("reserved -> complete the transition", () => {
    expect(classifyExistingVersionDoi("reserved")).toBe("complete_reserved");
  });
  test("unavailable (tombstoned) -> error, never silently resurrect", () => {
    expect(classifyExistingVersionDoi("unavailable")).toBe("error");
  });
});

describe("rotationOffset (guaranteed full coverage)", () => {
  test("zero/empty total -> offset 0", () => {
    expect(rotationOffset(0, 123456789)).toBe(0);
  });

  test("rotates through every bucket over consecutive days, covering all rows", () => {
    const total = DOI_RECONCILE_BATCH * 3 + 7; // 4 buckets
    const buckets = Math.ceil(total / DOI_RECONCILE_BATCH);
    const seen = new Set<number>();
    for (let day = 0; day < buckets; day++) {
      seen.add(rotationOffset(total, day * 86_400_000));
    }
    // Every bucket start is visited exactly once across a full cycle.
    expect(seen.size).toBe(buckets);
    expect([...seen].sort((a, b) => a - b)).toEqual(
      Array.from({ length: buckets }, (_, i) => i * DOI_RECONCILE_BATCH),
    );
    // Highest offset never exceeds the last full bucket start.
    expect(Math.max(...seen)).toBeLessThan(total);
  });

  test("single-bucket total always offset 0", () => {
    expect(rotationOffset(5, 0)).toBe(0);
    expect(rotationOffset(5, 999 * 86_400_000)).toBe(0);
  });
});
