/**
 * Pure unit tests for `search-datasets.ts`'s hit-merging helper (epic
 * #1065 phase 2, issue #1294, PR #1323 review item C.5).
 *
 * `mergeHitsWithCatalog` is pure (no I/O), so the miss path -- a
 * `SearchResult` id absent from the follow-up license/zarr `Map` -- is
 * driven with a real, deliberately incomplete `Map`, not a fake D1 binding.
 */

import { describe, expect, test } from "bun:test";
import { mergeHitsWithCatalog } from "../src/mcp/tools/search-datasets";
import type { SearchResult } from "../src/services/dataset-search";

function searchResult(overrides: Partial<SearchResult> & { id: string }): SearchResult {
  return {
    name: "A Dataset",
    modalities: "eeg",
    participants: 10,
    doi: "10.5072/FK2abc",
    tasks: "rest",
    authors: "Someone",
    has_hed: 1,
    score: 1,
    ...overrides,
  };
}

describe("mergeHitsWithCatalog", () => {
  test("a resolved hit carries the catalog's license/zarr facts, no unresolved id", () => {
    const results = [searchResult({ id: "nm000001" })];
    const extra = new Map([
      [
        "nm000001",
        { dataset_id: "nm000001", license: "CC-BY-4.0", zarr_status: "ready", zarr_store_count: 3 },
      ],
    ]);
    const { hits, unresolvedIds } = mergeHitsWithCatalog(results, extra);
    expect(unresolvedIds).toEqual([]);
    expect(hits).toHaveLength(1);
    expect(hits[0].dataset_id).toBe("nm000001");
    expect(hits[0].license).toBe("CC-BY-4.0");
    expect(hits[0].has_zarr).toBe(true);
  });

  test("the miss path: an id absent from a real (incomplete) Map is reported unresolved, not silently 'confirmed absent'", () => {
    const results = [searchResult({ id: "nm000001" }), searchResult({ id: "nm000002" })];
    // A real Map that only knows about nm000001 -- nm000002 is genuinely
    // missing, not stubbed out; this is the exact shape a stale Vectorize
    // id or a delete race would produce.
    const extra = new Map([
      [
        "nm000001",
        { dataset_id: "nm000001", license: "CC-BY-4.0", zarr_status: "ready", zarr_store_count: 3 },
      ],
    ]);
    const { hits, unresolvedIds } = mergeHitsWithCatalog(results, extra);
    expect(unresolvedIds).toEqual(["nm000002"]);
    const missed = hits.find((h) => h.dataset_id === "nm000002");
    expect(missed?.license).toBeNull();
    expect(missed?.has_zarr).toBe(false);
  });

  test("every id missing: an empty Map reports every id unresolved", () => {
    const results = [searchResult({ id: "nm000001" }), searchResult({ id: "nm000002" })];
    const { hits, unresolvedIds } = mergeHitsWithCatalog(results, new Map());
    expect(unresolvedIds.sort()).toEqual(["nm000001", "nm000002"]);
    expect(hits.every((h) => h.license === null && h.has_zarr === false)).toBe(true);
  });

  test("has_hed reads exactly 1 as true, exactly 0 as false, anything else as null", () => {
    const results = [
      searchResult({ id: "nm000001", has_hed: 1 }),
      searchResult({ id: "nm000002", has_hed: 0 }),
      searchResult({ id: "nm000003", has_hed: null }),
      searchResult({ id: "nm000004", has_hed: undefined }),
    ];
    const { hits } = mergeHitsWithCatalog(results, new Map());
    expect(hits.find((h) => h.dataset_id === "nm000001")?.has_hed).toBe(true);
    expect(hits.find((h) => h.dataset_id === "nm000002")?.has_hed).toBe(false);
    expect(hits.find((h) => h.dataset_id === "nm000003")?.has_hed).toBeNull();
    expect(hits.find((h) => h.dataset_id === "nm000004")?.has_hed).toBeNull();
  });

  test("empty results list -> empty hits, no unresolved ids", () => {
    const { hits, unresolvedIds } = mergeHitsWithCatalog([], new Map());
    expect(hits).toEqual([]);
    expect(unresolvedIds).toEqual([]);
  });
});
