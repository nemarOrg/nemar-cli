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
  computeProvenanceEnvelope,
  describeDatasetInputSchema,
  flagToBoolean,
  getEventsInputSchema,
  listRecordingsInputSchema,
  readWindowInputSchema,
  readWindowOutputSchema,
  renderOverviewInputSchema,
  searchDatasetsInputSchema,
  zarrCatalogEntrySchema,
  zarrCatalogSchema,
} from "../shared/contract/mcp.js";
import { zarrArrayMetadataSchema, zarrIndexSchema } from "../shared/contract/zarr-index.js";
import level0ArrayFixture from "./fixtures/zarr-array-level0.zarr.json";
import catalogSliceFixture from "./fixtures/zarr-catalog-slice.json";
import nm000329SliceFixture from "./fixtures/zarr-index-nm000329-slice.json";
import v3Fixture from "./fixtures/zarr-index-v3.json";

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
    // duration_s just over READ_WINDOW_TASTE_MAX_DURATION_S at the max channel
    // count -- neither field alone exceeds a generous sanity ceiling, so this
    // input is rejected ONLY by the combined channel-seconds check, not by an
    // incidental per-field .max(). (A prior version of this test used a
    // channels array one element over READ_WINDOW_TASTE_MAX_CHANNELS, which
    // turned out to be rejected by that field's own .max() regardless of
    // whether the channel-seconds refinement ran at all -- caught by
    // mutating the refinement out and watching every test stay green.)
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

  test("a taste result parses", () => {
    const parsed = readWindowOutputSchema.parse({
      mode: "taste",
      start_s: 0,
      duration_s: 1,
      channels: [0, 1],
      sample_rate_hz: 250,
      values: [Array(250).fill(0), Array(250).fill(0)],
      envelope,
    });
    expect(parsed.mode).toBe("taste");
  });

  test("an unknown mode, or a taste without values, is refused", () => {
    expect(readWindowOutputSchema.safeParse({ mode: "bytes", envelope }).success).toBe(false);
    expect(
      readWindowOutputSchema.safeParse({
        mode: "taste",
        start_s: 0,
        duration_s: 1,
        channels: [0],
        sample_rate_hz: 250,
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
