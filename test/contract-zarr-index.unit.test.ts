/**
 * Pure unit tests for the zarr-index v3 zod reader (issue #1293, phase 1 of
 * epic #1065's MCP server).
 *
 * Every fixture that passes the Ajv2020 compile of `shared/zarr-index.schema.json`
 * (the producer's closed contract, see `test/zarr-schema-contract.test.ts`) must
 * also pass the zod reader in `shared/contract/zarr-index.ts` -- and the same
 * three mutations that break the JSON Schema must break the zod reader too, so
 * the two never silently drift apart on what a valid index looks like.
 */

import { describe, expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020";
import { safeParseZarrIndex, zarrIndexSchema } from "../shared/contract/zarr-index.js";
import indexSchema from "../shared/zarr-index.schema.json";
import nm000329SliceFixture from "./fixtures/zarr-index-nm000329-slice.json";
import onSssSliceFixture from "./fixtures/zarr-index-on003392-meg-sss-slice.json";
import v3Fixture from "./fixtures/zarr-index-v3.json";

function ajvValidate(doc: unknown): boolean {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(indexSchema as object);
  return Boolean(validate(doc));
}

// zarr-index-multigroup.json and zarr-index-nm000111-slice.json are
// deliberately excluded here: both are format_version 1 fixtures for
// test/recording-stats.test.ts's older reader, not documents the v3 schema
// (or this v3 reader) was ever meant to accept.
const REAL_FIXTURES: Array<[string, unknown]> = [
  ["zarr-index-v3.json (on008083)", v3Fixture],
  ["zarr-index-nm000329-slice.json (live, events_parquet)", nm000329SliceFixture],
  ["zarr-index-on003392-meg-sss-slice.json (live, MEG sss)", onSssSliceFixture],
];

describe("zarrIndexSchema accepts every real index fixture", () => {
  for (const [name, fixture] of REAL_FIXTURES) {
    test(`${name} passes both Ajv and the zod reader`, () => {
      expect(ajvValidate(fixture)).toBe(true);
      const result = safeParseZarrIndex(fixture);
      expect(result.success).toBe(true);
    });
  }

  test("the MEG sss fixture's store round-trips the sss object", () => {
    const parsed = zarrIndexSchema.parse(onSssSliceFixture);
    expect(parsed.stores).toHaveLength(1);
    const store = parsed.stores[0];
    expect(store.derived).toBe(true);
    expect(store.sss).toBeDefined();
    expect(store.sss?.applied).toBe(true);
    expect(store.sss?.method).toBe("maxwell_filter");
  });

  test("the nm000329 slice keeps events_parquet and top-level doi/license/citation", () => {
    const parsed = zarrIndexSchema.parse(nm000329SliceFixture);
    expect(parsed.events_parquet).toMatch(/^https:\/\/.*events\.parquet$/);
    expect(parsed.doi).toBe("10.82901/nemar.nm000329");
    expect(parsed.license).toBeTruthy();
    expect(parsed.citation).toBeTruthy();
  });
});

describe("zarrIndexSchema rejects the same mutations Ajv rejects", () => {
  test("dropping source_commit fails both", () => {
    const { source_commit, ...withoutCommit } = v3Fixture as Record<string, unknown>;
    expect(source_commit).toBeDefined();
    expect(ajvValidate(withoutCommit)).toBe(false);
    expect(safeParseZarrIndex(withoutCommit).success).toBe(false);
  });

  test("setting format_version: 1 fails both", () => {
    const mutated = { ...(v3Fixture as Record<string, unknown>), format_version: 1 };
    expect(ajvValidate(mutated)).toBe(false);
    expect(safeParseZarrIndex(mutated).success).toBe(false);
  });

  test("a non-40-hex source_commit fails both", () => {
    const mutated = { ...(v3Fixture as Record<string, unknown>), source_commit: "not-a-sha" };
    expect(ajvValidate(mutated)).toBe(false);
    expect(safeParseZarrIndex(mutated).success).toBe(false);
  });
});

describe("zarrIndexSchema is a lower bound, unlike the closed JSON Schema", () => {
  test("an undeclared top-level field fails Ajv but passes the zod reader", () => {
    // Documents the deliberate divergence from the module doc: the JSON
    // Schema is additionalProperties:false (the producer's closed contract);
    // this reader is .passthrough() (a client-side lower bound), so an
    // additive field the producer ships before this reader knows about it
    // does not break every consumer at once.
    const mutated = { ...(v3Fixture as Record<string, unknown>), surprise: 1 };
    expect(ajvValidate(mutated)).toBe(false);
    expect(safeParseZarrIndex(mutated).success).toBe(true);
  });
});
