/**
 * Pure unit tests for `search-datasets.ts`'s hit-merging helper (epic
 * #1065 phase 2, issue #1294, PR #1323 review item C.5).
 *
 * `mergeHitsWithCatalog` is pure (no I/O), so the miss path -- a
 * `SearchResult` id absent from the follow-up license/zarr `Map` -- is
 * driven with a real, deliberately incomplete `Map`, not a fake D1 binding.
 */

import { describe, expect, test } from "bun:test";
import {
  SEARCH_DATASETS_NARROWING_FILTERS,
  searchDatasetsInputSchema,
} from "../../shared/contract/mcp";
import { FACETS } from "../../shared/facets";
import { searchDatasetsInputSchema4 } from "../src/mcp/schemas";
import { mergeHitsWithCatalog } from "../src/mcp/tools/search-datasets";
import type { SearchResult } from "../src/services/dataset-search";

/**
 * The MCP search surface must declare every filter the catalog can apply.
 *
 * This is the test that would have caught the drift that motivated widening
 * the tool: its input schema was hand-written and had gone stale against the
 * catalog, so the NEMAR assistant's prompt taught the model `modality_filter`,
 * a name nothing declared. Because the schema is `.passthrough()`, the server
 * accepted it and dropped it, and an unfiltered result set was presented as
 * filtered. ADR 0032 already enforces this in both directions between
 * `shared/facets.ts` and `dataset-facets.ts`; this extends the same discipline
 * to the third consumer.
 */
describe("search_datasets declares the whole filter surface", () => {
  const declared = new Set(Object.keys(searchDatasetsInputSchema.shape));

  /** The bespoke filters ADR 0032 deliberately keeps OUT of the facet table,
   *  minus `search` (spelled `query` on this surface). Hand-listed on purpose:
   *  they have irregular semantics and no declared table to derive from, so
   *  this list is the reminder to wire a new one through. It can only catch a
   *  REMOVAL, never an omission; the stronger check is an equivalence test
   *  against the HTTP route's own mapping, tracked separately. */
  const BESPOKE_FILTERS = [
    "modality",
    "task",
    "author",
    "has_doi",
    "has_hed",
    "has_zarr",
    "has_zarr_verified",
    "data_complete",
    "recent",
    "license",
    "include_unknown",
  ];

  test("every declared facet is an accepted parameter", () => {
    const missing = FACETS.map((f) => f.queryParam).filter((q) => !declared.has(q));
    expect(missing).toEqual([]);
  });

  test("every bespoke catalog filter is an accepted parameter", () => {
    const missing = BESPOKE_FILTERS.filter((name) => !declared.has(name));
    expect(missing).toEqual([]);
  });

  test("the narrowing filters the cap counts are this list minus include_unknown", () => {
    // `SEARCH_DATASETS_NARROWING_FILTERS` is `Object.keys` of the shape that
    // declares them, so it cannot omit one -- but it can quietly GAIN one, and
    // a filter that reaches the schema without reaching this hand-written list
    // is the drift this file exists to catch. `include_unknown` is the single
    // deliberate difference: it widens every active facet instead of narrowing,
    // so it is declared outside that shape and does not consume a caller's cap.
    // Compared as sorted sets: declaration order differs between the two and
    // carries no meaning (every clause is AND-ed), so ordering it would make
    // this fail on a harmless reshuffle.
    expect([...SEARCH_DATASETS_NARROWING_FILTERS].sort()).toEqual(
      BESPOKE_FILTERS.filter((name) => name !== "include_unknown").sort(),
    );
    expect(SEARCH_DATASETS_NARROWING_FILTERS.includes("include_unknown")).toBe(false);
  });

  test("the zod4 wire mirror declares the same keys as the contract", () => {
    // The mirror is what `registerTool` advertises, so it is what the model
    // reads. Both schemas are `.passthrough()`, so the existing parity tests --
    // which feed sample objects to both -- cannot see a key missing from one
    // side: it is simply passed through. Only comparing the declared shapes
    // catches it, and this is the check that would have caught the widened
    // contract failing to reach the wire.
    const contractKeys = Object.keys(searchDatasetsInputSchema.shape).sort();
    const mirrorKeys = Object.keys(searchDatasetsInputSchema4.shape).sort();
    expect(mirrorKeys).toEqual(contractKeys);
  });

  test("no facet name collides with a bespoke parameter, and the count is exact", () => {
    // Both shapes spread the generated facets AFTER the bespoke declarations
    // and before `limit`, so a facet whose queryParam matched a bespoke name
    // would silently redefine it as a plain string, and one named `limit`
    // would be dropped. Neither is visible to the two tests above: the key
    // sets stay equal and both names are still present.
    const facetParams = FACETS.map((f) => f.queryParam);
    const collisions = facetParams.filter(
      (q) => BESPOKE_FILTERS.includes(q) || q === "query" || q === "limit",
    );
    expect(collisions).toEqual([]);

    // `query` and `limit` are the two that are neither a facet nor a filter.
    expect(Object.keys(searchDatasetsInputSchema.shape).length).toBe(
      BESPOKE_FILTERS.length + 2 + FACETS.length,
    );
  });
});

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
