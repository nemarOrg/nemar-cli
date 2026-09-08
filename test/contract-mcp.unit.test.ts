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
  READ_WINDOW_TASTE_MAX_CHANNELS,
  READ_WINDOW_TASTE_MAX_CHANNEL_SECONDS,
  READ_WINDOW_TASTE_MAX_DURATION_S,
  buildReadRecipe,
  computeProvenanceEnvelope,
  listRecordingsInputSchema,
  readWindowInputSchema,
  zarrCatalogEntrySchema,
} from "../shared/contract/mcp.js";
import { zarrIndexSchema } from "../shared/contract/zarr-index.js";
import catalogSliceFixture from "./fixtures/zarr-catalog-slice.json";
import v3Fixture from "./fixtures/zarr-index-v3.json";

const on008083Index = zarrIndexSchema.parse(v3Fixture);

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

  test("dtype/codecs stay null/absent without an array-metadata fetch, and fill in when supplied", () => {
    const store = on008083Index.stores[0];
    const bare = buildReadRecipe({ index: on008083Index, store, groupName: "eeg_250hz" });
    expect(bare.dtype).toBeNull();
    expect(bare.codecs).toBeUndefined();

    const withMeta = buildReadRecipe({
      index: on008083Index,
      store,
      groupName: "eeg_250hz",
      arrayMetadata: { dtype: "int16", codecs: [{ name: "sharding_indexed" }] },
    });
    expect(withMeta.dtype).toBe("int16");
    expect(withMeta.codecs).toHaveLength(1);
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
  const catalogSlice = catalogSliceFixture as { datasets: unknown[] };
  const on008083Catalog = catalogSlice.datasets
    .map((d) => zarrCatalogEntrySchema.parse(d))
    .find((d) => d.dataset_id === "nm000103");

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

  test("catalogEntry doi/license/verify-status override the index's own copy", () => {
    expect(on008083Catalog).toBeDefined();
    if (!on008083Catalog) throw new Error("fixture missing nm000103");
    const store = on008083Index.stores[0];
    const envelope = computeProvenanceEnvelope({
      index: on008083Index,
      store,
      catalogEntry: on008083Catalog,
    });
    expect(envelope.doi).toBe(on008083Catalog.doi);
    expect(envelope.license).toBe(on008083Catalog.license);
    expect(envelope.zarr_verify_status).toBe(on008083Catalog.zarr_verify_status ?? null);
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

  test("a taste request with no explicit channels assumes the max channel count", () => {
    // Omitting `channels` cannot be assumed cheap: the schema has no way to
    // know the recording's true channel count, so it assumes the worst case
    // (READ_WINDOW_TASTE_MAX_CHANNELS) rather than silently passing an
    // unbounded request through.
    const result = readWindowInputSchema.safeParse({
      dataset_id: "on008083",
      recording: "sub-01/eeg/a_eeg.zarr",
      duration_s: READ_WINDOW_TASTE_MAX_DURATION_S,
      taste: true,
    });
    expect(result.success).toBe(true);
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
