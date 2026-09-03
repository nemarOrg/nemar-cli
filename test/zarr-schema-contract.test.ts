/**
 * The two published Zarr JSON Schemas, compiled and exercised on this side of
 * the wire (issue #1181 review, B2/X1).
 *
 * `shared/zarr-index.schema.json` and `shared/zarr-manifest.schema.json` are
 * SERVED by `GET /schemas/:name` and are what `scripts/zarr/generate_zarr.py`
 * validates every document against before uploading it. Until now nothing on
 * the TypeScript side ever compiled them: `backend/test/schemas-route.test.ts`
 * checks that the route serves the bytes, and `test_generate_zarr.py` checks
 * documents against them in Python. So a schema edit that made the DOCUMENT
 * invalid as a schema -- a typo'd keyword, a `$ref` to a `$defs` entry that no
 * longer exists, a `required` naming a property that was renamed -- broke the
 * converter's pre-upload gate at the next Hallu run, with every TS test green.
 *
 * Two things are asserted here, and the second is what makes the first mean
 * something:
 *
 *  1. Both files COMPILE as draft 2020-12 (the dialect they declare).
 *  2. Real documents in the shape the converter publishes VALIDATE against
 *     them, and a one-field mutation of each FAILS. A schema that accepts
 *     everything compiles perfectly well.
 *
 * The fixtures are the checked-in ones under `test/fixtures/`, which
 * `backend/test/zarr-index-v3.test.ts` also builds its consumer-side fixture
 * from -- so a fixture that drifts out of schema fails here rather than
 * quietly testing the consumer against a document the producer could never
 * publish.
 */

import { describe, expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020";
import indexSchema from "../shared/zarr-index.schema.json";
import manifestSchema from "../shared/zarr-manifest.schema.json";
import indexFixture from "./fixtures/zarr-index-v3.json";
import manifestFixture from "./fixtures/zarr-manifest-v1.json";

/** A fresh compiler per test: Ajv caches by `$id`, and the mutation tests
 *  deliberately compile altered copies of the same documents. */
function compile(schema: unknown) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  return ajv.compile(schema as object);
}

describe("shared/zarr-index.schema.json", () => {
  test("compiles as a draft 2020-12 schema", () => {
    expect(() => compile(indexSchema)).not.toThrow();
  });

  test("declares the dialect it is compiled as", () => {
    // If this ever changes, the compiler above has to change with it -- an
    // Ajv2020 instance silently accepts a document declaring an older dialect
    // while applying 2020-12 semantics to it.
    expect((indexSchema as { $schema: string }).$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
  });

  test("accepts a real v3 index", () => {
    const validate = compile(indexSchema);
    const ok = validate(indexFixture);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  test("rejects a v3 index missing a required field", () => {
    // The proof that acceptance above means something. `layout` is the field
    // #1064 added so an MCP recipe is computable without probing; a schema that
    // stopped requiring it would let the converter publish an index no client
    // can read positions out of.
    const validate = compile(indexSchema);
    const { layout, ...withoutLayout } = indexFixture as Record<string, unknown>;
    expect(layout).toBeDefined();
    expect(validate(withoutLayout)).toBe(false);
  });

  test("rejects a pending entry whose reason is outside the enum", () => {
    // The closed set `generate_zarr.py`'s PendingReason mirrors.
    const validate = compile(indexSchema);
    const doc = structuredClone(indexFixture) as {
      pending: { reason: string }[];
    };
    doc.pending[0].reason = "vibes";
    expect(validate(doc)).toBe(false);
  });

  test("rejects an undeclared top-level field", () => {
    // additionalProperties:false is load-bearing: the index is a published
    // contract, and a field the schema does not know is a field no consumer
    // was told about.
    const validate = compile(indexSchema);
    expect(validate({ ...indexFixture, surprise: 1 })).toBe(false);
  });

  test("a schema whose $ref dangles fails to compile, not to validate", () => {
    // The failure mode this file exists for: the schema document itself
    // breaking. Ajv raises at COMPILE time, which is why compilation is
    // asserted separately from validation above.
    const broken = structuredClone(indexSchema) as {
      properties: { stores: { items: { $ref: string } } };
    };
    broken.properties.stores.items.$ref = "#/$defs/doesNotExist";
    expect(() => compile(broken)).toThrow();
  });
});

describe("shared/zarr-manifest.schema.json", () => {
  test("compiles and accepts a real manifest", () => {
    const validate = compile(manifestSchema);
    const ok = validate(manifestFixture);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  test("rejects a store entry whose zarr path is not a .zarr", () => {
    const validate = compile(manifestSchema);
    const doc = structuredClone(manifestFixture) as { stores: { zarr: string }[] };
    doc.stores[0].zarr = "sub-01/eeg/a_eeg.edf";
    expect(validate(doc)).toBe(false);
  });

  test("rejects a files[] entry naming an object other than events.parquet", () => {
    // The enum is deliberately single-member: index.json and manifest.json
    // describe themselves, so the events file is the only object that needs an
    // entry (#1060).
    const validate = compile(manifestSchema);
    const doc = structuredClone(manifestFixture) as { files: { name: string }[] };
    doc.files[0].name = "index.json";
    expect(validate(doc)).toBe(false);
  });
});
