/**
 * Live-dataset guard (epic #713 follow-up). Pure, no network, no mocks.
 *
 * These tests pin the LIVE_DATASETS set and isLiveDataset() so the admin
 * sweep guards (ci/sync, enforce-apply, enforce/bulk) can never silently
 * drift to mutate nm000103-107 — the regression that prompted this guard.
 */

import { describe, expect, test } from "bun:test";
import { LIVE_DATASETS, isLiveDataset } from "../src/constants";

describe("LIVE_DATASETS guard", () => {
  test("covers exactly nm000103-nm000107", () => {
    expect([...LIVE_DATASETS].sort()).toEqual([
      "nm000103",
      "nm000104",
      "nm000105",
      "nm000106",
      "nm000107",
    ]);
  });

  test("isLiveDataset is true for every live id", () => {
    for (const id of ["nm000103", "nm000104", "nm000105", "nm000106", "nm000107"]) {
      expect(isLiveDataset(id)).toBe(true);
    }
  });

  test("isLiveDataset is false for non-live datasets and the test dataset", () => {
    for (const id of ["nm000108", "nm000132", "nm099999", "on007139", "nm000102", ""]) {
      expect(isLiveDataset(id)).toBe(false);
    }
  });
});
