/**
 * Pure tests for the fleet-revalidate target selector (epic #713, Phase 6).
 * No network, no mocks.
 */

import { describe, expect, test } from "bun:test";
import { CLI_LIVE_DATASETS, selectRevalidateTargets } from "../src/lib/fleet.js";

const ds = (dataset_id: string, visibility = "public") => ({ dataset_id, visibility });

describe("selectRevalidateTargets", () => {
  test("keeps public nm/on, sorted", () => {
    const out = selectRevalidateTargets([ds("on007139"), ds("nm000132"), ds("nm000110")], {});
    expect(out).toEqual(["nm000110", "nm000132", "on007139"]);
  });

  test("drops private datasets", () => {
    const out = selectRevalidateTargets([ds("nm000132"), ds("nm000200", "private")], {});
    expect(out).toEqual(["nm000132"]);
  });

  test("drops live datasets and the test dataset", () => {
    const out = selectRevalidateTargets(
      [ds("nm000104"), ds("nm000107"), ds("nm099999"), ds("nm000132")],
      {},
    );
    expect(out).toEqual(["nm000132"]);
    // sanity: the live set is exactly nm000103-107
    expect([...CLI_LIVE_DATASETS].sort()).toEqual([
      "nm000103",
      "nm000104",
      "nm000105",
      "nm000106",
      "nm000107",
    ]);
  });

  test("drops non nm/on prefixes (ds*, xx*)", () => {
    const out = selectRevalidateTargets([ds("ds007537"), ds("xx000001"), ds("nm000132")], {});
    expect(out).toEqual(["nm000132"]);
  });

  test("honors a prefix filter", () => {
    const out = selectRevalidateTargets([ds("nm000132"), ds("nm000200"), ds("on007139")], {
      prefix: "nm0002",
    });
    expect(out).toEqual(["nm000200"]);
  });
});
