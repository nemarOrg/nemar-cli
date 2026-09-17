/**
 * The per-call filter cap counts the same filters the query builders act on.
 *
 * `activeFilterParams` decides what "a filter is set" means from the supplied
 * value alone; `buildDatasetFilterClauses` and `parseFacetFilters` decide it
 * again, independently, from truthiness guards scattered across two modules
 * (`if (opts.hasDoi)`, `opts.recent && opts.recent > 0`, the parser's
 * `raw.trim() === ""` skip, `parseLicenseTierFilter`'s empty result). If the
 * two ever disagree, the cap refuses a call over a filter the SQL was never
 * going to carry, or counts one it does. Nothing in the type system connects
 * them, so this test does -- against the real builders, in both directions.
 *
 * Real modules throughout, no D1: `buildDatasetFilterClauses` returns a SQL
 * string and pushes bound parameters into an array, both of which are the
 * observable fact being asserted.
 */

import { describe, expect, test } from "bun:test";
import {
  SEARCH_DATASETS_FILTER_PARAMS,
  SEARCH_DATASETS_MAX_FILTERS,
  SEARCH_DATASETS_NARROWING_FILTERS,
  type SearchDatasetsInput,
} from "../../shared/contract/mcp";
import { FACETS } from "../../shared/facets";
import {
  activeFilterParams,
  buildFilterOptions,
  searchDatasetsTool,
} from "../src/mcp/tools/search-datasets";
import { parseFacetFilters } from "../src/services/dataset-facets";
import { MAX_BOUND_PARAMS, buildDatasetFilterClauses } from "../src/services/dataset-filters";

/** A value that must make each bespoke filter narrow. Hand-written on purpose:
 *  it is the independent witness, and `covers every declared narrowing filter`
 *  below fails until a newly declared filter is given one. */
const BESPOKE_SET_VALUES: Record<string, unknown> = {
  modality: "eeg",
  task: "rest",
  author: "smith",
  has_hed: true,
  has_zarr: true,
  has_doi: true,
  has_zarr_verified: true,
  data_complete: true,
  recent: 30,
  license: "public",
};

/** The widest legal value for a facet, by declared kind. */
function facetSetValue(facet: (typeof FACETS)[number]): string {
  switch (facet.valueKind) {
    case "number":
      return "0..999999";
    case "bytes":
      return "0b..900tb";
    case "duration":
      return "0s..9000h";
    case "enum":
      return (facet.enumValues ?? []).join(",");
    case "text":
      return "a";
    case "version":
      return "1";
  }
}

function setValueFor(name: string): unknown {
  const facet = FACETS.find((f) => f.queryParam === name);
  return facet ? facetSetValue(facet) : BESPOKE_SET_VALUES[name];
}

/** Clauses plus bound parameters for one argument object, via the real path
 *  the tool itself takes (parse facets, map to options, build SQL). */
function build(
  args: Record<string, unknown>,
  search?: string,
): { clauses: string; params: (string | number)[] } {
  const typed = args as SearchDatasetsInput;
  const facets = parseFacetFilters((key) => {
    const raw = args[key];
    return typeof raw === "string" ? raw : undefined;
  });
  const params: (string | number)[] = [];
  // `search` is set by `executeDatasetSearch` from the tool's `query`, not by
  // `buildFilterOptions`, so the `query` branch is reproduced by setting it on
  // the options here rather than by passing another argument name.
  const options = { ...buildFilterOptions(typed, facets), ...(search ? { search } : {}) };
  const clauses = buildDatasetFilterClauses(params, options);
  return { clauses, params };
}

describe("the filter cap counts what the query builders act on", () => {
  test("covers every declared narrowing filter", () => {
    // Guards the two tables below from going stale: a bespoke filter added to
    // the contract without a value here would otherwise be skipped silently,
    // and every assertion would still pass.
    const missing = SEARCH_DATASETS_NARROWING_FILTERS.filter(
      (name) => !(name in BESPOKE_SET_VALUES),
    );
    expect(missing).toEqual([]);
    const unknown = Object.keys(BESPOKE_SET_VALUES).filter(
      (name) => !SEARCH_DATASETS_NARROWING_FILTERS.includes(name),
    );
    expect(unknown).toEqual([]);
    expect(SEARCH_DATASETS_FILTER_PARAMS.length).toBe(
      SEARCH_DATASETS_NARROWING_FILTERS.length + FACETS.length,
    );
  });

  test("a set value both counts and builds a clause, for every filter", () => {
    for (const name of SEARCH_DATASETS_FILTER_PARAMS) {
      const args = { [name]: setValueFor(name) };
      expect({ name, counted: activeFilterParams(args as SearchDatasetsInput) }).toEqual({
        name,
        counted: [name],
      });
      const { clauses } = build(args);
      expect({ name, narrowed: clauses.trim().length > 0 }).toEqual({ name, narrowed: true });
    }
  });

  test("a value that builds no clause is not counted either", () => {
    // The falsy forms a caller can actually send: `""` for any string filter
    // (the facet parser's own "not set"), and `false` for a boolean one --
    // `has_doi: false` does NOT mean "datasets without a DOI", it means no
    // clause at all, which is the asymmetry this cap must not misread.
    for (const name of SEARCH_DATASETS_FILTER_PARAMS) {
      const set = setValueFor(name);
      const empty = typeof set === "boolean" ? false : typeof set === "number" ? 0 : "";
      const args = { [name]: empty };
      expect({ name, counted: activeFilterParams(args as SearchDatasetsInput) }).toEqual({
        name,
        counted: [],
      });
      const { clauses } = build(args);
      expect({ name, narrowed: clauses.trim().length > 0 }).toEqual({ name, narrowed: false });
    }
  });

  test("an explicitly null filter is unset", () => {
    // Unreachable through the tool -- zod rejects `null` for every declared
    // filter before `searchDatasetsTool` sees the arguments -- so it is
    // asserted here, directly on the exported helper, rather than left as a
    // defensive branch no test can reach. A caller assembling arguments by
    // hand (the CLI's own `--flag` plumbing clears this way) gets the same
    // answer as one that omitted the key.
    const args = { subjects: null, has_doi: null, author: null, modality: "eeg" };
    expect(activeFilterParams(args as unknown as SearchDatasetsInput)).toEqual(["modality"]);
  });

  test("include_unknown, query and limit are not filters", () => {
    // `include_unknown` WIDENS every active facet; `query` and `limit` are not
    // filters at all. None may consume the caller's twenty.
    const args = { include_unknown: true, query: "eeg", limit: 5 };
    expect(activeFilterParams(args as SearchDatasetsInput)).toEqual([]);
    for (const name of ["include_unknown", "query", "limit"]) {
      expect(SEARCH_DATASETS_FILTER_PARAMS.includes(name)).toBe(false);
    }
  });

  test("every filter at once stays inside D1's bound-parameter ceiling", () => {
    // `assertBoundParamBudget` (dataset-filters.ts, #1193/#1195) throws above
    // MAX_BOUND_PARAMS from inside `buildDatasetFilterClauses`, so building
    // the worst case a caller can construct -- all thirty filters at their
    // widest, then the same again with the `query` branch's FTS clause -- IS
    // the assertion: an overflow fails this test by throwing. The explicit
    // bounds below pin the measured numbers so a facet that moves them is
    // visible in the diff rather than only when the ceiling is reached.
    const everything: Record<string, unknown> = {};
    for (const name of SEARCH_DATASETS_FILTER_PARAMS) everything[name] = setValueFor(name);
    const browse = build(everything);
    expect(browse.params.length).toBeLessThanOrEqual(MAX_BOUND_PARAMS);
    expect(browse.params.length).toBe(50);

    const withQuery = build(everything, "eeg");
    expect(withQuery.params.length).toBeGreaterThan(browse.params.length);
    expect(withQuery.params.length).toBeLessThanOrEqual(MAX_BOUND_PARAMS);
    expect(withQuery.params.length).toBe(53);
  });

  test("the cap holds the worst case to roughly half of what it allows", () => {
    // The cap's own claim: twenty filters, chosen to bind as many parameters
    // as possible, stay far enough under MAX_BOUND_PARAMS that the backstop is
    // unreachable through the tool. Chosen by measured cost, not by name, so
    // this keeps meaning the same thing as the vocabulary changes.
    const byCost = [...SEARCH_DATASETS_FILTER_PARAMS]
      .map((name) => ({ name, cost: build({ [name]: setValueFor(name) }).params.length }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, SEARCH_DATASETS_MAX_FILTERS);
    const worst: Record<string, unknown> = {};
    for (const { name } of byCost) worst[name] = setValueFor(name);
    const built = build(worst, "eeg");
    expect(activeFilterParams(worst as SearchDatasetsInput).length).toBe(
      SEARCH_DATASETS_MAX_FILTERS,
    );
    expect(built.params.length).toBeLessThan(MAX_BOUND_PARAMS / 2 + 10);
  });
});

/**
 * A binding that records being used and then fails.
 *
 * Not a stand-in for D1: nothing here answers a query, and no assertion below
 * depends on a result. The only fact it reports is WHETHER the tool reached
 * the database, which is the whole difference between a call the cap refused
 * and one it let through. A real D1 would answer both alike.
 */
function tripwireEnv(): { env: Parameters<typeof searchDatasetsTool>[0]; reached: () => boolean } {
  let touched = false;
  const trip = () => {
    touched = true;
    throw new Error("tripwire: the database was reached");
  };
  return {
    env: {
      DB: { prepare: trip, batch: trip } as unknown as D1Database,
      AI: {} as never,
      VECTORIZE: {} as never,
    },
    reached: () => touched,
  };
}

/** `SEARCH_DATASETS_MAX_FILTERS` names, cheapest first, so the rejection is
 *  driven by the COUNT and not by any one filter's parameter cost. */
function nFilters(n: number): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const name of SEARCH_DATASETS_FILTER_PARAMS.slice(0, n)) args[name] = setValueFor(name);
  return args;
}

describe("search_datasets refuses more filters than it can combine", () => {
  test("one over the cap is refused, and the answer names what to drop", async () => {
    const args = nFilters(SEARCH_DATASETS_MAX_FILTERS + 1);
    expect(activeFilterParams(args as SearchDatasetsInput).length).toBe(
      SEARCH_DATASETS_MAX_FILTERS + 1,
    );
    const { env, reached } = tripwireEnv();
    const outcome = await searchDatasetsTool(env, args as SearchDatasetsInput);
    expect(outcome.result.isError).toBe(true);
    const text = (outcome.result.content as { text: string }[])[0].text;
    expect(text).toContain(`${SEARCH_DATASETS_MAX_FILTERS + 1}`);
    expect(text).toContain(`at most ${SEARCH_DATASETS_MAX_FILTERS}`);
    // Every counted filter is named, so a caller can choose which to drop
    // rather than guessing at a number.
    for (const name of Object.keys(args)) expect(text).toContain(name);
    // Refused at the door: no parsing, no query, nothing billed.
    expect(reached()).toBe(false);
  });

  test("exactly the cap is allowed through to the query", async () => {
    // The paired half. Without it, a cap that refused EVERY call would pass
    // the test above. The tripwire throwing is the proof it got past the gate.
    const args = nFilters(SEARCH_DATASETS_MAX_FILTERS);
    expect(activeFilterParams(args as SearchDatasetsInput).length).toBe(
      SEARCH_DATASETS_MAX_FILTERS,
    );
    const { env, reached } = tripwireEnv();
    await expect(searchDatasetsTool(env, args as SearchDatasetsInput)).rejects.toThrow("tripwire");
    expect(reached()).toBe(true);
  });

  test("unset and widening parameters do not consume the cap", async () => {
    // The cap counts filters that narrow, so a call at the cap stays legal
    // when a caller adds `query`, `limit`, `include_unknown`, a cleared filter
    // and an explicit `false` on top of it.
    // Built from the declared facets rather than `nFilters`, so the cleared
    // bespoke names below are additions and not overwrites of counted ones.
    const base: Record<string, unknown> = {};
    for (const name of SEARCH_DATASETS_FILTER_PARAMS.slice(-SEARCH_DATASETS_MAX_FILTERS)) {
      base[name] = setValueFor(name);
    }
    const args = {
      ...base,
      query: "eeg",
      limit: 5,
      include_unknown: true,
      has_doi: false,
      author: "",
      task: undefined,
    };
    expect(activeFilterParams(args as SearchDatasetsInput).length).toBe(
      SEARCH_DATASETS_MAX_FILTERS,
    );
    // The `query` branch runs several tiers and degrades on a failing one
    // rather than propagating, so this asserts on the tripwire being reached
    // and on the outcome NOT being the cap's refusal -- never on which tier
    // happened to throw first.
    const { env, reached } = tripwireEnv();
    let text = "";
    try {
      const outcome = await searchDatasetsTool(env, args as SearchDatasetsInput);
      text = (outcome.result.content as { text: string }[])[0]?.text ?? "";
    } catch {
      // A tier that propagates instead of degrading is equally good evidence.
    }
    expect(reached()).toBe(true);
    expect(text).not.toContain("Too many filters");
  });
});
