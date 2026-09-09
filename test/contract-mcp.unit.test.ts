/**
 * Pure unit tests for the MCP server's wire contract (issue #1293, phase 1 of
 * epic #1065; ADR 0049).
 *
 * No live backend -- exercises recipe computation, envelope assembly, and the
 * tool input schemas directly against the checked-in fixtures. The route
 * behavior these contracts drive is out of scope for this phase (design +
 * contracts only); see the phase 2-4 issues (#1294-#1296).
 */

import { describe, expect, test } from "bun:test";
import {
  GET_EVENTS_DEFAULT_LIMIT,
  GET_EVENTS_MAX_LIMIT,
  LIST_RECORDINGS_DEFAULT_LIMIT,
  LIST_RECORDINGS_MAX_LIMIT,
  READ_WINDOW_TASTE_MAX_CHANNELS,
  READ_WINDOW_TASTE_MAX_CHANNEL_SECONDS,
  READ_WINDOW_TASTE_MAX_DURATION_S,
  RENDER_OVERVIEW_DEFAULT_WIDTH_PX,
  RENDER_OVERVIEW_MAX_WIDTH_PX,
  SEARCH_DATASETS_DEFAULT_LIMIT,
  SEARCH_DATASETS_MAX_LIMIT,
  buildReadRecipe,
  composeCitation,
  computeProvenanceEnvelope,
  describeDatasetInputSchema,
  eventRowSchema,
  flagToBoolean,
  getEventsInputSchema,
  getEventsOutputSchema,
  listRecordingsInputSchema,
  listRecordingsOutputSchema,
  readWindowInputSchema,
  readWindowOutputSchema,
  recordingGroupSummarySchema,
  renderOverviewInputSchema,
  renderOverviewOutputSchema,
  searchDatasetsInputSchema,
  zarrCatalogEntrySchema,
  zarrCatalogSchema,
} from "../shared/contract/mcp.js";
import {
  zarrArrayMetadataSchema,
  zarrIndexLegacySchema,
  zarrIndexSchema,
} from "../shared/contract/zarr-index.js";
import nm000329RowFixture from "./fixtures/dataset-row-nm000329.json";
import level0ArrayFixture from "./fixtures/zarr-array-level0.zarr.json";
import catalogSliceFixture from "./fixtures/zarr-catalog-slice.json";
import nm000111LegacyFixture from "./fixtures/zarr-index-nm000111-slice.json";
import nm000329SliceFixture from "./fixtures/zarr-index-nm000329-slice.json";
import v3Fixture from "./fixtures/zarr-index-v3.json";

const nm000329Row = nm000329RowFixture.dataset;

const on008083Index = zarrIndexSchema.parse(v3Fixture);
const nm000329Index = zarrIndexSchema.parse(nm000329SliceFixture);
const catalog = zarrCatalogSchema.parse(catalogSliceFixture);
const catalogRow = (id: string) => {
  const row = catalog.datasets.find((d) => d.dataset_id === id);
  if (!row) throw new Error(`catalog slice fixture has no row for ${id}`);
  return row;
};

describe("buildReadRecipe", () => {
  test("computes the level-0 array_path from layout.level0", () => {
    const store = on008083Index.stores[0];
    const recipe = buildReadRecipe({ index: on008083Index, store, groupName: "eeg_250hz" });
    expect(recipe.level).toBe("0");
    expect(recipe.array_path).toBe(
      "https://zarr.nemar.org/on008083/zarr/sub-01/eeg/a_eeg.zarr/eeg_250hz/0",
    );
    expect(recipe.zarr).toBe(store.zarr);
    expect(recipe.group).toBe("eeg_250hz");
    expect(recipe.s3_uri).toBe(on008083Index.s3_uri);
    expect(recipe.s3_anonymous).toBe(true);
  });

  test("computes the matching view path from layout.view for a given level", () => {
    const store = on008083Index.stores[0];
    const recipe = buildReadRecipe({
      index: on008083Index,
      store,
      groupName: "eeg_250hz",
      level: 1,
    });
    expect(recipe.level).toBe(1);
    expect(recipe.array_path).toBe(
      "https://zarr.nemar.org/on008083/zarr/sub-01/eeg/a_eeg.zarr/eeg_250hz/view/1",
    );
  });

  test("level 0 passed as a number normalizes to the '0' literal", () => {
    const store = on008083Index.stores[0];
    const recipe = buildReadRecipe({
      index: on008083Index,
      store,
      groupName: "eeg_250hz",
      level: 0,
    });
    expect(recipe.level).toBe("0");
  });

  test("carries chunk/shard geometry and n_channels straight from the index group", () => {
    const store = on008083Index.stores[0];
    const recipe = buildReadRecipe({ index: on008083Index, store, groupName: "eeg_250hz" });
    const group = store.groups?.[0];
    expect(recipe.chunk_samples).toBe(group?.chunk_samples ?? null);
    expect(recipe.shard_samples).toBe(group?.shard_samples ?? null);
    expect(recipe.n_channels).toBe(group?.n_channels ?? null);
  });

  test("dtype/codecs stay null/absent without an array-metadata fetch", () => {
    const store = on008083Index.stores[0];
    const bare = buildReadRecipe({ index: on008083Index, store, groupName: "eeg_250hz" });
    expect(bare.dtype).toBeNull();
    expect(bare.codecs).toBeUndefined();
  });

  test("a real level-0 zarr.json fills dtype from Zarr's data_type and carries codecs", () => {
    const store = on008083Index.stores[0];
    const arrayMetadata = zarrArrayMetadataSchema.parse(level0ArrayFixture);
    const recipe = buildReadRecipe({
      index: on008083Index,
      store,
      groupName: "eeg_250hz",
      arrayMetadata,
    });
    expect(recipe.dtype).toBe("int16");
    expect(recipe.codecs).toEqual(arrayMetadata.codecs);
  });

  test("sample_slice and channel_slice land verbatim, and a backwards range is refused", () => {
    const store = on008083Index.stores[0];
    const recipe = buildReadRecipe({
      index: on008083Index,
      store,
      groupName: "eeg_250hz",
      sampleSlice: { start: 250, end: 2750 },
      channelSlice: { start: 0, end: 8 },
    });
    expect(recipe.sample_slice).toEqual({ start: 250, end: 2750 });
    expect(recipe.channel_slice).toEqual({ start: 0, end: 8 });
    expect(() =>
      buildReadRecipe({
        index: on008083Index,
        store,
        groupName: "eeg_250hz",
        sampleSlice: { start: 2750, end: 250 },
      }),
    ).toThrow();
  });

  test("template filling is a single pass: a placeholder-looking store path is never re-scanned", () => {
    const store = {
      zarr: "sub-01/eeg/<group>.zarr",
      groups: on008083Index.stores[0].groups,
    };
    const recipe = buildReadRecipe({ index: on008083Index, store, groupName: "eeg_250hz" });
    expect(recipe.array_path).toBe(
      `${on008083Index.contract_base}sub-01/eeg/<group>.zarr/eeg_250hz/0`,
    );
  });

  test("a layout template missing a placeholder the caller needs throws instead of shipping <L>", () => {
    const index = {
      ...on008083Index,
      layout: { ...on008083Index.layout, view: "<zarr>/<group>/view/" as never },
    };
    const store = on008083Index.stores[0];
    expect(() => buildReadRecipe({ index, store, groupName: "eeg_250hz", level: 1 })).toThrow(
      /lacks <L>/,
    );
  });

  test("how_to carries a python_zarr and a zarrita snippet naming the s3 and https paths", () => {
    const store = on008083Index.stores[0];
    const recipe = buildReadRecipe({ index: on008083Index, store, groupName: "eeg_250hz" });
    expect(recipe.how_to.python_zarr).toContain(on008083Index.s3_uri);
    expect(recipe.how_to.zarrita).toContain(on008083Index.contract_base);
    expect(recipe.how_to.zarrita).toContain("new zarr.FetchStore(");
    expect(recipe.how_to.zarrita).toContain("zarr.open.v3(store");
  });

  test("throws for a group name the store does not have", () => {
    const store = on008083Index.stores[0];
    expect(() =>
      buildReadRecipe({ index: on008083Index, store, groupName: "does-not-exist" }),
    ).toThrow();
  });
});

describe("computeProvenanceEnvelope", () => {
  // The on008083 fixture carries no doi/license, so the catalog row of a
  // dataset that has both (nm000103) stands in as "a fully populated row";
  // the function never cross-checks dataset_id between the two inputs.
  const populatedCatalogRow = catalogRow("nm000103");

  test("populates every required field from the index alone", () => {
    const store = on008083Index.stores[0];
    const group = store.groups?.[0];
    const envelope = computeProvenanceEnvelope({ index: on008083Index, store, group });

    expect(envelope.dataset_id).toBe("on008083");
    expect(envelope.source_commit).toBe(on008083Index.source_commit);
    expect(envelope.engine_version).toBe(on008083Index.engine_version);
    expect(envelope.source_tree).toBe("raw");
    expect(envelope.derived).toBe(false);
    expect(envelope.lossy).toBe(true);
    expect(envelope.dtype).toBeNull();
    expect(envelope.effective_rate_hz).toBe(group?.rate ?? null);
    expect(envelope.source_rate_hz).toBe(group?.source_rate_hz ?? null);
    expect(envelope.index_etag).toBeNull();
    expect(envelope.zarr_verify_status).toBeNull();
    // Every field the schema requires must have been present for .parse() to
    // succeed inside computeProvenanceEnvelope; the assertions above cover
    // the ones a caller is most likely to get wrong.
  });

  test("a populated catalog row supplies doi/license/verify-status", () => {
    const store = on008083Index.stores[0];
    const envelope = computeProvenanceEnvelope({
      index: on008083Index,
      store,
      catalogEntry: populatedCatalogRow,
    });
    expect(envelope.doi).toBe(populatedCatalogRow.doi);
    expect(envelope.license).toBe(populatedCatalogRow.license);
    expect(envelope.zarr_verify_status).toBe("verified");
  });

  test("with no catalog row, the index's own hoisted doi/license/citation carry through", () => {
    const store = nm000329Index.stores[0];
    const envelope = computeProvenanceEnvelope({ index: nm000329Index, store });
    expect(nm000329Index.doi).toBeTruthy();
    expect(envelope.doi).toBe(nm000329Index.doi ?? null);
    expect(envelope.license).toBe(nm000329Index.license ?? null);
    expect(envelope.citation).toBe(nm000329Index.citation ?? null);
  });

  test("a catalog row's null doi/license is authoritative over the index's stale copy", () => {
    const store = nm000329Index.stores[0];
    const envelope = computeProvenanceEnvelope({
      index: nm000329Index,
      store,
      catalogEntry: { doi: null, license: null, zarr_verify_status: null },
    });
    expect(envelope.doi).toBeNull();
    expect(envelope.license).toBeNull();
    expect(envelope.zarr_verify_status).toBeNull();
  });

  test("a catalog row that omits the key falls back to the index", () => {
    const store = nm000329Index.stores[0];
    const envelope = computeProvenanceEnvelope({
      index: nm000329Index,
      store,
      catalogEntry: { zarr_verify_status: "unverifiable" },
    });
    expect(envelope.doi).toBe(nm000329Index.doi ?? null);
    expect(envelope.zarr_verify_status).toBe("unverifiable");
  });

  test("indexEtag, dtype and note are carried, never nulled", () => {
    const store = on008083Index.stores[0];
    const envelope = computeProvenanceEnvelope({
      index: on008083Index,
      store,
      indexEtag: '"abc123"',
      dtype: "int16",
      note: "3 recordings pending conversion",
    });
    expect(envelope.index_etag).toBe('"abc123"');
    expect(envelope.dtype).toBe("int16");
    expect(envelope.note).toBe("3 recordings pending conversion");
  });

  test("derived and sss must agree (ADR 0028)", () => {
    const base = { source_tree: "raw" as const, units_report: undefined };
    expect(() =>
      computeProvenanceEnvelope({ index: on008083Index, store: { ...base, derived: true } }),
    ).toThrow(/sss is absent/);
    expect(() =>
      computeProvenanceEnvelope({
        index: on008083Index,
        store: { ...base, derived: false, sss: { applied: true } },
      }),
    ).toThrow(/derived is false/);
  });

  test("sss rides the envelope when the store carries it", () => {
    const derivedStore = {
      source_tree: "raw" as const,
      derived: true,
      sss: { applied: true, method: "maxwell_filter" },
      units_report: undefined,
    };
    const envelope = computeProvenanceEnvelope({ index: on008083Index, store: derivedStore });
    expect(envelope.derived).toBe(true);
    expect(envelope.sss).toEqual({ applied: true, method: "maxwell_filter" });
  });
});

describe("readWindowInputSchema", () => {
  test("accepts the documented defaults (no taste, no explicit fields)", () => {
    const result = readWindowInputSchema.safeParse({
      dataset_id: "on008083",
      recording: "sub-01/eeg/a_eeg.zarr",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.start_s).toBe(0);
    expect(result.data.duration_s).toBe(10);
    expect(result.data.taste).toBe(false);
  });

  test("recipe mode (taste: false) is never capped by channel-seconds", () => {
    // duration_s is still bounded to READ_WINDOW_TASTE_MAX_DURATION_S by the
    // field's own .max(), but the channel-seconds refinement only applies
    // when taste is requested.
    const result = readWindowInputSchema.safeParse({
      dataset_id: "on008083",
      recording: "sub-01/eeg/a_eeg.zarr",
      duration_s: READ_WINDOW_TASTE_MAX_DURATION_S,
      channels: Array.from({ length: READ_WINDOW_TASTE_MAX_CHANNELS }, (_, i) => i),
      taste: false,
    });
    expect(result.success).toBe(true);
  });

  test("accepts a taste request exactly at the channel-second cap", () => {
    const channels = Array.from({ length: READ_WINDOW_TASTE_MAX_CHANNELS }, (_, i) => i);
    const result = readWindowInputSchema.safeParse({
      dataset_id: "on008083",
      recording: "sub-01/eeg/a_eeg.zarr",
      duration_s: READ_WINDOW_TASTE_MAX_DURATION_S,
      channels,
      taste: true,
    });
    expect(result.success).toBe(true);
    expect(READ_WINDOW_TASTE_MAX_DURATION_S * channels.length).toBe(
      READ_WINDOW_TASTE_MAX_CHANNEL_SECONDS,
    );
  });

  test("rejects a taste request over the channel-second cap (duration_s x channels)", () => {
    // NOTE ON WHAT THIS TEST NOW PROVES. It asserts the OUTCOME (a taste one
    // second past the duration cap at the maximum channel count is refused),
    // which is still correct and worth pinning. It no longer isolates the
    // combined channel-seconds check, and an earlier version of this comment
    // wrongly claimed it did: since the hard per-field caps landed, the two
    // maxima multiply to exactly READ_WINDOW_TASTE_MAX_CHANNEL_SECONDS
    // (asserted in backend/test/mcp-schema-parity.test.ts), so no input that
    // satisfies both hard caps can reach the product check at all -- and this
    // input trips the hard duration cap on its way past. Deleting the product
    // clause leaves every test green, which is expected and disclosed in
    // `.context/mcp-server-design.md`; it is kept as cheap defense for the day
    // a hard cap is raised, and the parity file's multiplication assertion is
    // what will tell whoever raises one that the relationship changed.
    const channels = Array.from({ length: READ_WINDOW_TASTE_MAX_CHANNELS }, (_, i) => i);
    const result = readWindowInputSchema.safeParse({
      dataset_id: "on008083",
      recording: "sub-01/eeg/a_eeg.zarr",
      duration_s: READ_WINDOW_TASTE_MAX_DURATION_S + 1,
      channels,
      taste: true,
    });
    expect(result.success).toBe(false);
  });

  test("a taste request with an EMPTY channels array is refused like an omitted one", () => {
    // An empty array is not `undefined`, so a guard written only against
    // `undefined` let it through -- and it clears both caps trivially
    // (`0 > 64` is false, `duration_s * 0` is always under the product cap).
    // Downstream, `Math.min(...[])` / `Math.max(...[])` are +/-Infinity, which
    // reached `readRecipeSchema.parse` and threw a raw ZodError naming a field
    // the caller never supplied, AFTER a real Range GET had already been spent.
    const result = readWindowInputSchema.safeParse({
      dataset_id: "on008083",
      recording: "sub-01/eeg/a_eeg.zarr",
      duration_s: 1,
      channels: [],
      taste: true,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain("taste requires channels");
  });

  test("a taste request that omits channels is refused: the schema cannot bound it", () => {
    // on003392's MEG store has 320 channels; "omitted means all" would let
    // 60 s x 320 = 19200 channel-seconds through a 3840 cap.
    const result = readWindowInputSchema.safeParse({
      dataset_id: "on003392",
      recording: "sub-01/meg/sub-01_task-rest_meg.zarr",
      duration_s: READ_WINDOW_TASTE_MAX_DURATION_S,
      taste: true,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(["channels"]);
    expect(result.error.issues[0]?.message).toMatch(/omit taste for a recipe/);
  });
});

describe("readWindowOutputSchema", () => {
  const store = on008083Index.stores[0];
  const envelope = computeProvenanceEnvelope({ index: on008083Index, store });
  const recipe = buildReadRecipe({ index: on008083Index, store, groupName: "eeg_250hz" });

  test("a recipe result parses", () => {
    const parsed = readWindowOutputSchema.parse({ mode: "recipe", recipe, envelope });
    expect(parsed.mode).toBe("recipe");
  });

  test("a taste result parses (phase 4: recipe, chunks_read, bytes_read, filled_ranges, note)", () => {
    const parsed = readWindowOutputSchema.parse({
      mode: "taste",
      start_s: 0,
      duration_s: 1,
      channels: [0, 1],
      sample_rate_hz: 250,
      values: [Array(250).fill(0), Array(250).fill(0)],
      recipe,
      chunks_read: 2,
      bytes_read: 4096,
      filled_ranges: [],
      note: "values are rounded to six significant digits; see recipe for the exact byte-level read",
      envelope,
    });
    expect(parsed.mode).toBe("taste");
    if (parsed.mode !== "taste") return;
    expect(parsed.chunks_read).toBe(2);
    expect(parsed.recipe.zarr).toBe(recipe.zarr);
    expect(parsed.filled_ranges).toEqual([]);
  });

  test("filled_ranges is REQUIRED, not optional: a taste that omits it is refused", () => {
    // The whole point of the field is that a caller never has to distinguish
    // "no gaps" from "this build does not report gaps", so an absent array is
    // not a valid taste result.
    const withoutFilledRanges = {
      mode: "taste",
      start_s: 0,
      duration_s: 1,
      channels: [0],
      sample_rate_hz: 250,
      values: [Array(250).fill(0)],
      recipe,
      chunks_read: 1,
      bytes_read: 1024,
      envelope,
    };
    expect(readWindowOutputSchema.safeParse(withoutFilledRanges).success).toBe(false);
  });

  test("an unknown mode, a taste without values, or a taste missing recipe/chunks_read/bytes_read is refused", () => {
    expect(readWindowOutputSchema.safeParse({ mode: "bytes", envelope }).success).toBe(false);
    expect(
      readWindowOutputSchema.safeParse({
        mode: "taste",
        start_s: 0,
        duration_s: 1,
        channels: [0],
        sample_rate_hz: 250,
        recipe,
        chunks_read: 0,
        bytes_read: 0,
        envelope,
      }).success,
    ).toBe(false);
    expect(
      readWindowOutputSchema.safeParse({
        mode: "taste",
        start_s: 0,
        duration_s: 1,
        channels: [0],
        sample_rate_hz: 250,
        values: [[0]],
        envelope,
      }).success,
    ).toBe(false);
  });
});

describe("tool input defaults and caps", () => {
  test("search_datasets: default limit, cap accepted, cap + 1 refused", () => {
    const dflt = searchDatasetsInputSchema.parse({});
    expect(dflt.limit).toBe(SEARCH_DATASETS_DEFAULT_LIMIT);
    expect(searchDatasetsInputSchema.safeParse({ limit: SEARCH_DATASETS_MAX_LIMIT }).success).toBe(
      true,
    );
    expect(
      searchDatasetsInputSchema.safeParse({ limit: SEARCH_DATASETS_MAX_LIMIT + 1 }).success,
    ).toBe(false);
  });

  test("describe_dataset: requires a well-formed dataset_id", () => {
    expect(describeDatasetInputSchema.safeParse({ dataset_id: "nm000329" }).success).toBe(true);
    expect(describeDatasetInputSchema.safeParse({ dataset_id: "xx900001x" }).success).toBe(false);
    expect(describeDatasetInputSchema.safeParse({}).success).toBe(false);
  });

  test("list_recordings: default limit, cap accepted, cap + 1 refused, offset defaults to 0", () => {
    const dflt = listRecordingsInputSchema.parse({ dataset_id: "on008083" });
    expect(dflt.limit).toBe(LIST_RECORDINGS_DEFAULT_LIMIT);
    expect(dflt.offset).toBe(0);
    expect(
      listRecordingsInputSchema.safeParse({
        dataset_id: "on008083",
        limit: LIST_RECORDINGS_MAX_LIMIT,
      }).success,
    ).toBe(true);
    expect(
      listRecordingsInputSchema.safeParse({
        dataset_id: "on008083",
        limit: LIST_RECORDINGS_MAX_LIMIT + 1,
      }).success,
    ).toBe(false);
  });

  test("get_events: recording is required", () => {
    expect(getEventsInputSchema.safeParse({ dataset_id: "nm000329" }).success).toBe(false);
    expect(
      getEventsInputSchema.safeParse({
        dataset_id: "nm000329",
        recording: "sub-1/ses-0/eeg/x.zarr",
      }).success,
    ).toBe(true);
  });

  test("render_overview: default width, cap accepted, cap + 1 refused", () => {
    const dflt = renderOverviewInputSchema.parse({ dataset_id: "on008083", recording: "a" });
    expect(dflt.width_px).toBe(RENDER_OVERVIEW_DEFAULT_WIDTH_PX);
    expect(
      renderOverviewInputSchema.safeParse({
        dataset_id: "on008083",
        recording: "a",
        width_px: RENDER_OVERVIEW_MAX_WIDTH_PX,
      }).success,
    ).toBe(true);
    expect(
      renderOverviewInputSchema.safeParse({
        dataset_id: "on008083",
        recording: "a",
        width_px: RENDER_OVERVIEW_MAX_WIDTH_PX + 1,
      }).success,
    ).toBe(false);
  });
});

describe("catalog.json contract", () => {
  test("the live catalog slice parses as a document, not just as rows", () => {
    expect(catalog.format).toBe("nemar-zarr-catalog");
    expect(catalog.count).toBe(catalog.datasets.length);
    expect(catalog.datasets.map((d) => d.dataset_id)).toEqual(["nm000103", "nm000329", "on003392"]);
  });

  test("has_hed rides the catalog as 0 | 1 | null and reaches the tools as a boolean", () => {
    expect(zarrCatalogEntrySchema.parse(catalogRow("nm000103")).has_hed).toBe(1);
    expect(flagToBoolean(catalogRow("nm000103").has_hed)).toBe(true);
    expect(flagToBoolean(catalogRow("on003392").has_hed)).toBe(false);
    expect(flagToBoolean(null)).toBeNull();
    expect(flagToBoolean(undefined)).toBeNull();
  });
});

describe("listRecordingsInputSchema", () => {
  test("include_derived defaults to false", () => {
    const result = listRecordingsInputSchema.safeParse({ dataset_id: "on008083" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.include_derived).toBe(false);
    expect(result.data.limit).toBe(50);
  });

  test("rejects a dataset_id that does not match the NEMAR id pattern", () => {
    const result = listRecordingsInputSchema.safeParse({ dataset_id: "not-an-id" });
    expect(result.success).toBe(false);
  });
});

describe("composeCitation (issue #1064 / #1294, port of dataset_citation)", () => {
  test("matches the nm000329 index fixture's citation, produced by the Python function from the same row", () => {
    // The fixture string ends in "(v1.0.7).": nm000329Row.latest_version
    // ("v1.0.7", already the canonical tag) is load-bearing here.
    expect(nm000329Row.latest_version).toBe("v1.0.7");
    expect(composeCitation(nm000329Row)).toBe(nm000329Index.citation);
  });

  test("each optional segment drops out when its input is empty", () => {
    expect(composeCitation({ name: "A Dataset" })).toBe("A Dataset. NEMAR.");
    expect(composeCitation({ name: "A Dataset", authors: "" })).toBe("A Dataset. NEMAR.");
    expect(composeCitation({ name: "A Dataset", created_at: "" })).toBe("A Dataset. NEMAR.");
    expect(composeCitation({ name: "A Dataset", latest_version: "" })).toBe("A Dataset. NEMAR.");
    expect(composeCitation({ name: "A Dataset", concept_doi: "", doi: "" })).toBe(
      "A Dataset. NEMAR.",
    );
  });

  test("a full row composes every segment, in order", () => {
    expect(
      composeCitation({
        name: "A Dataset",
        authors: "Ada Lovelace, Alan Turing",
        concept_doi: "10.5072/FK2abc123",
        latest_version: "v2.1.0",
        created_at: "2025-01-15 00:00:00",
      }),
    ).toBe(
      "Ada Lovelace, Alan Turing (2025) A Dataset (v2.1.0). NEMAR. https://doi.org/10.5072/FK2abc123",
    );
  });

  test("concept_doi wins over doi when both are present", () => {
    const citation = composeCitation({
      name: "A Dataset",
      concept_doi: "10.5072/FK2concept",
      doi: "10.5072/FK2fallback",
    });
    expect(citation).toContain("https://doi.org/10.5072/FK2concept");
    expect(citation).not.toContain("FK2fallback");
  });

  test("falls back to doi when concept_doi is absent", () => {
    const citation = composeCitation({ name: "A Dataset", doi: "10.5072/FK2fallback" });
    expect(citation).toContain("https://doi.org/10.5072/FK2fallback");
  });

  test("a whitespace-only concept_doi falls through to doi, not an empty segment", () => {
    const citation = composeCitation({
      name: "A Dataset",
      concept_doi: "   ",
      doi: "10.5072/FK2fallback",
    });
    expect(citation).toContain("https://doi.org/10.5072/FK2fallback");
  });

  test("a doi: prefix is stripped before building the doi.org URL", () => {
    const citation = composeCitation({ name: "A Dataset", concept_doi: "doi:10.5072/FK2abc" });
    expect(citation).toContain("https://doi.org/10.5072/FK2abc");
    expect(citation).not.toContain("doi:10.5072");
  });

  test("no name means null", () => {
    expect(composeCitation({ authors: "Someone" })).toBeNull();
    expect(composeCitation({ name: "" })).toBeNull();
    expect(composeCitation({ name: "   " })).toBeNull();
    expect(composeCitation(null)).toBeNull();
    expect(composeCitation(undefined)).toBeNull();
  });

  test("a non-digit or partial year is omitted rather than emitting a bogus segment", () => {
    expect(composeCitation({ name: "A Dataset", created_at: "unknown" })).toBe("A Dataset. NEMAR.");
  });

  test("a two-digit year (created_at too short) yields no year segment", () => {
    expect(composeCitation({ name: "A Dataset", created_at: "20" })).toBe("A Dataset. NEMAR.");
  });
});

// ---------------------------------------------------------------------------
// Phase 3 additions (epic #1065, issue #1295): the legacy index schema and
// the additive list_recordings/get_events/render_overview fields.
// ---------------------------------------------------------------------------

describe("zarrIndexLegacySchema", () => {
  test("parses a real v1 index slice (nm000111) with format_version 1", () => {
    const parsed = zarrIndexLegacySchema.parse(nm000111LegacyFixture);
    expect(parsed.format_version).toBe(1);
    expect(parsed.dataset_id).toBe("nm000111");
    expect(parsed.source_commit).toBe("510a05377459cf857e60b861ab377bc53b5b5b29");
    expect(parsed.stores.length).toBeGreaterThan(0);
  });

  test("accepts an empty source_commit (#1197's on008083 case) -- ANY string, no regex", () => {
    const doc = { ...nm000111LegacyFixture, source_commit: "" };
    const parsed = zarrIndexLegacySchema.parse(doc);
    expect(parsed.source_commit).toBe("");
  });

  test("a v1 store's groups reuse the shared zarrGroupSchema shape", () => {
    const parsed = zarrIndexLegacySchema.parse(nm000111LegacyFixture);
    const group = parsed.stores[0].groups?.[0];
    expect(group?.name).toBeDefined();
    expect(group?.rate).toBeGreaterThan(0);
  });

  test("a v1 store carries no source_tree/derived (v3-only concepts) -- passthrough tolerates their absence", () => {
    const parsed = zarrIndexLegacySchema.parse(nm000111LegacyFixture);
    const store = parsed.stores[0] as unknown as Record<string, unknown>;
    expect(store.source_tree).toBeUndefined();
    expect(store.derived).toBeUndefined();
  });

  test("rejects a document missing dataset_id entirely", () => {
    const { dataset_id: _dataset_id, ...rest } = nm000111LegacyFixture;
    expect(() => zarrIndexLegacySchema.parse(rest)).toThrow();
  });

  test("format_version is any int, not literal 3 -- a v2 document also parses", () => {
    const doc = { ...nm000111LegacyFixture, format_version: 2 };
    const parsed = zarrIndexLegacySchema.parse(doc);
    expect(parsed.format_version).toBe(2);
  });
});

describe("listRecordingsInputSchema / OutputSchema additive fields (phase 3)", () => {
  test("limit/offset default as documented", () => {
    const parsed = listRecordingsInputSchema.parse({ dataset_id: "nm000329" });
    expect(parsed.limit).toBe(LIST_RECORDINGS_DEFAULT_LIMIT);
    expect(parsed.offset).toBe(0);
    expect(parsed.include_derived).toBe(false);
  });

  test("source_commit is nullable (widened, phase 3)", () => {
    const parsed = listRecordingsOutputSchema.parse({
      dataset_id: "nm000111",
      source_commit: null,
      recordings: [],
      total_count: 0,
      excluded_derived_count: 0,
      limit: 50,
      offset: 0,
      index_format_version: 1,
      discovered_count: null,
      failure_count: null,
      pending_count: null,
      excluded_legacy_non_raw_count: 1,
      note: "legacy index v1: re-conversion pending; source_tree, derived and engine stamp are inferred",
    });
    expect(parsed.source_commit).toBeNull();
    expect(parsed.index_format_version).toBe(1);
  });

  test("recordingGroupSummarySchema accepts the new n_samples/view_chunk_columns fields", () => {
    const parsed = recordingGroupSummarySchema.parse({
      name: "eeg_250hz",
      n_view_levels: 5,
      n_samples: 138750,
      view_chunk_columns: 1024,
    });
    expect(parsed.n_samples).toBe(138750);
    expect(parsed.view_chunk_columns).toBe(1024);
  });
});

describe("getEventsInputSchema / OutputSchema additive fields (phase 3)", () => {
  test("limit/offset default as documented", () => {
    const parsed = getEventsInputSchema.parse({ dataset_id: "nm000329", recording: "x.zarr" });
    expect(parsed.limit).toBe(GET_EVENTS_DEFAULT_LIMIT);
    expect(parsed.offset).toBe(0);
  });

  test("limit is capped at GET_EVENTS_MAX_LIMIT", () => {
    expect(() =>
      getEventsInputSchema.parse({
        dataset_id: "nm000329",
        recording: "x.zarr",
        limit: GET_EVENTS_MAX_LIMIT + 1,
      }),
    ).toThrow();
  });

  test("output requires total_count/limit/offset/truncated", () => {
    const parsed = getEventsOutputSchema.parse({
      dataset_id: "nm000329",
      recording: "x.zarr",
      events: [],
      source: "events_tsv_fallback",
      estimated: true,
      total_count: 0,
      limit: 1000,
      offset: 0,
      truncated: false,
      note: "no events file was found next to this recording",
    });
    expect(parsed.truncated).toBe(false);
  });

  test("eventRowSchema passes through subject/session/task/run (BIDS entities)", () => {
    const parsed = eventRowSchema.parse({
      store_path: "sub-1/eeg/sub-1_task-x_eeg.zarr",
      group_name: "eeg_250hz",
      onset_s: 1.5,
      sample_index: 375,
      subject: "1",
      session: "0",
      task: "imagery",
      run: "0",
    });
    expect((parsed as unknown as Record<string, unknown>).subject).toBe("1");
  });
});

describe("renderOverviewOutputSchema additive fields (phase 3)", () => {
  test("columns_read/chunks_read/bytes_read and an optional envelope", () => {
    const parsed = renderOverviewOutputSchema.parse({
      dataset_id: "nm000329",
      recording: "x.zarr",
      group: "eeg_250hz",
      level: 5,
      width_px: 100,
      height_px: 1197,
      mime_type: "image/png",
      columns_read: 135,
      chunks_read: 1,
      bytes_read: 33379,
    });
    expect(parsed.columns_read).toBe(135);
    expect(parsed.envelope).toBeUndefined();
  });

  test("a cache-hit shape (all zero reads) is still valid", () => {
    const parsed = renderOverviewOutputSchema.parse({
      dataset_id: "nm000329",
      recording: "x.zarr",
      group: "eeg_250hz",
      level: 5,
      width_px: 100,
      height_px: 1197,
      mime_type: "image/png",
      columns_read: 0,
      chunks_read: 0,
      bytes_read: 0,
    });
    expect(parsed.chunks_read).toBe(0);
  });
});
