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
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020";
import { zarrIndexSchema } from "../shared/contract/zarr-index.js";
import indexSchema from "../shared/zarr-index.schema.json";
import manifestSchema from "../shared/zarr-manifest.schema.json";
import indexFixture from "./fixtures/zarr-index-v3.json";
import manifestFixture from "./fixtures/zarr-manifest-v1.json";

/** The converter's own bound on `units_report.unmatched_examples`, read from
 *  its source so the schemas below are checked against the producer rather
 *  than against a number restated here. */
const UNMATCHED_EXAMPLES_MAX = (() => {
  const source = readFileSync(new URL("../scripts/zarr/generate_zarr.py", import.meta.url), "utf8");
  const match = /^UNMATCHED_EXAMPLES_MAX = (\d+)$/m.exec(source);
  if (!match) throw new Error("UNMATCHED_EXAMPLES_MAX not found in generate_zarr.py");
  return Number(match[1]);
})();

/** The converter's bound on `units_report.matched_case_only_examples`
 *  (`CASE_MATCH_EXAMPLES_MAX`), read the same way. */
const CASE_MATCH_EXAMPLES_MAX = (() => {
  const source = readFileSync(new URL("../scripts/zarr/generate_zarr.py", import.meta.url), "utf8");
  const match = /^CASE_MATCH_EXAMPLES_MAX = (\d+)$/m.exec(source);
  if (!match) throw new Error("CASE_MATCH_EXAMPLES_MAX not found in generate_zarr.py");
  return Number(match[1]);
})();

/** One of the converter's integer constants for the `trial_types` key rule, read
 *  from its source for the same reason as the bounds above. */
function pythonConstant(name: string): number {
  const source = readFileSync(new URL("../scripts/zarr/generate_zarr.py", import.meta.url), "utf8");
  const match = new RegExp(`^${name} = (\\d+)$`, "m").exec(source);
  if (!match) throw new Error(`${name} not found in generate_zarr.py`);
  return Number(match[1]);
}

const examples = (n: number) => Array.from({ length: n }, (_, i) => `X${i}`);

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

  test("units_report's sidecar-join counts are declared on both sides", () => {
    // What generate_zarr.py's `sidecar_join_report` adds: which store channels
    // channels.tsv never reached. The zod schema is `.passthrough()`, so only a
    // REJECTED value proves a key is declared there (an undeclared key passes
    // with any value); each mutation below must fail both validators.
    const validate = compile(indexSchema);
    const withReport = (report: Record<string, unknown>) => {
      const doc = structuredClone(indexFixture) as { stores: Record<string, unknown>[] };
      doc.stores[0].units_report = {
        converted: 4,
        relabelled: 0,
        kept_importer_unit: 0,
        units_column_present: true,
        ...report,
      };
      return doc;
    };
    const good = withReport({
      unmatched_channels: 2,
      unmatched_raw_label: 2,
      unmatched_examples: ["T8-P8-0", "T8-P8-1"],
    });
    expect(validate(good)).toBe(true);
    expect(zarrIndexSchema.safeParse(good).success).toBe(true);
    for (const bad of [
      { unmatched_channels: -1 },
      { unmatched_case_only: 0 },
      { unmatched_raw_label: 0 },
      { unmatched_examples: examples(UNMATCHED_EXAMPLES_MAX + 1) },
      { matched_case_only: 0 },
      { matched_case_only: 1, matched_case_only_examples: [1] },
      {
        matched_case_only: CASE_MATCH_EXAMPLES_MAX + 1,
        matched_case_only_examples: examples(CASE_MATCH_EXAMPLES_MAX + 1),
      },
    ]) {
      const doc = withReport(bad);
      expect(validate(doc)).toBe(false);
      expect(zarrIndexSchema.safeParse(doc).success).toBe(false);
    }
  });

  test("unmatched_examples is bounded where the converter bounds it", () => {
    // `UNMATCHED_EXAMPLES_MAX` in generate_zarr.py is the producer's bound;
    // the JSON Schema's `maxItems` and zod's `.max()` restate it. Exactly the
    // bound passes both validators and one more fails both, so neither copy
    // can drift from the constant without this failing.
    const units = (
      indexSchema as {
        $defs: {
          store: { properties: { units_report: { properties: Record<string, unknown> } } };
        };
      }
    ).$defs.store.properties.units_report.properties;
    expect((units.unmatched_examples as { maxItems: number }).maxItems).toBe(
      UNMATCHED_EXAMPLES_MAX,
    );
    const validate = compile(indexSchema);
    const doc = (n: number) => {
      const d = structuredClone(indexFixture) as { stores: Record<string, unknown>[] };
      d.stores[0].units_report = {
        converted: 0,
        unmatched_channels: n,
        unmatched_examples: examples(n),
      };
      return d;
    };
    expect(validate(doc(UNMATCHED_EXAMPLES_MAX))).toBe(true);
    expect(zarrIndexSchema.safeParse(doc(UNMATCHED_EXAMPLES_MAX)).success).toBe(true);
    expect(validate(doc(UNMATCHED_EXAMPLES_MAX + 1))).toBe(false);
    expect(zarrIndexSchema.safeParse(doc(UNMATCHED_EXAMPLES_MAX + 1)).success).toBe(false);
  });

  test("matched_case_only_examples is bounded where the converter bounds it", () => {
    // biosigio >= 1.2.10 reports every case-only sidecar match in a
    // per-channel map; the converter publishes a count and at most
    // `CASE_MATCH_EXAMPLES_MAX` examples instead (`bound_units_report`).
    const units = (
      indexSchema as {
        $defs: {
          store: { properties: { units_report: { properties: Record<string, unknown> } } };
        };
      }
    ).$defs.store.properties.units_report.properties;
    expect((units.matched_case_only_examples as { maxItems: number }).maxItems).toBe(
      CASE_MATCH_EXAMPLES_MAX,
    );
    const validate = compile(indexSchema);
    const doc = (n: number) => {
      const d = structuredClone(indexFixture) as { stores: Record<string, unknown>[] };
      d.stores[0].units_report = {
        converted: n,
        unmatched_channels: 0,
        matched_case_only: n,
        matched_case_only_examples: examples(n).map((x) => `${x.toLowerCase()} -> ${x}`),
      };
      return d;
    };
    expect(validate(doc(CASE_MATCH_EXAMPLES_MAX))).toBe(true);
    expect(zarrIndexSchema.safeParse(doc(CASE_MATCH_EXAMPLES_MAX)).success).toBe(true);
    expect(validate(doc(CASE_MATCH_EXAMPLES_MAX + 1))).toBe(false);
    expect(zarrIndexSchema.safeParse(doc(CASE_MATCH_EXAMPLES_MAX + 1)).success).toBe(false);
  });

  test("biosigio's per-channel case-match map is refused by the published schema", () => {
    // The unbounded shape the converter must never republish. The JSON Schema
    // is the converter's pre-upload gate, so it refuses the key outright; the
    // zod mirror stays lenient (passthrough), a consumer does not reject an
    // index over it.
    const validate = compile(indexSchema);
    const d = structuredClone(indexFixture) as { stores: Record<string, unknown>[] };
    d.stores[0].units_report = {
      converted: 1,
      matched_case_insensitive: { "Fp1-F7": "FP1-F7" },
    };
    expect(validate(d)).toBe(false);
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

/**
 * The published JSON Schema and the zod contract describe the SAME document,
 * and nothing has been enforcing that.
 *
 * `shared/zarr-index.schema.json` is what the converter validates against
 * before uploading (`scripts/zarr/generate_zarr.py`) and what
 * `GET /schemas/zarr-index-v3.json` serves to third parties.
 * `shared/contract/zarr-index.ts` is what every consumer in this repo parses
 * with. The two are hand-synced, so one can be tightened or loosened without
 * the other: a field the converter is allowed to omit but a consumer requires
 * is a production 500 waiting for the first index that omits it, and the
 * reverse silently lets a document through the gate that no consumer can read.
 *
 * The equivalence below is driven off the SAME fixture both sides already
 * accept, using only public APIs -- delete one key at a time and require that
 * ajv and zod agree on whether the result is still valid. That covers
 * required-ness exactly, names the offending field when it drifts, and needs
 * no introspection of either library's internals.
 *
 * `additionalProperties: false` in the JSON Schema versus `.passthrough()` in
 * zod is a DELIBERATE asymmetry, not drift, and is asserted as such: the
 * producer's own gate refuses to publish a field it does not declare, while a
 * consumer must tolerate a field a newer producer added (ADR 0005's
 * forward-compatibility posture). So the unknown-key direction is checked to
 * DIFFER, and would fail if someone made them agree.
 */
describe("zarr-index.schema.json and contract/zarr-index.ts agree on required fields", () => {
  const ajvValid = compile(indexSchema);
  const bothAccept = (doc: unknown) => ({
    ajv: ajvValid(doc) as boolean,
    zod: zarrIndexSchema.safeParse(doc).success,
  });

  test("both accept the shared fixture to begin with", () => {
    const v = bothAccept(indexFixture);
    expect(v).toEqual({ ajv: true, zod: true });
  });

  test("deleting any top-level key makes ajv and zod agree on validity", () => {
    const disagreements: string[] = [];
    for (const key of Object.keys(indexFixture as Record<string, unknown>)) {
      const doc = structuredClone(indexFixture) as Record<string, unknown>;
      delete doc[key];
      const v = bothAccept(doc);
      if (v.ajv !== v.zod) {
        disagreements.push(
          `${key}: schema says ${v.ajv ? "valid" : "invalid"}, zod says ${v.zod ? "valid" : "invalid"}`,
        );
      }
    }
    expect(disagreements).toEqual([]);
  });

  test("deleting any store key makes ajv and zod agree on validity", () => {
    const disagreements: string[] = [];
    const storeKeys = Object.keys(
      (indexFixture as { stores: Array<Record<string, unknown>> }).stores[0],
    );
    for (const key of storeKeys) {
      const doc = structuredClone(indexFixture) as { stores: Array<Record<string, unknown>> };
      delete doc.stores[0][key];
      const v = bothAccept(doc);
      if (v.ajv !== v.zod) {
        disagreements.push(
          `stores[0].${key}: schema says ${v.ajv ? "valid" : "invalid"}, zod says ${v.zod ? "valid" : "invalid"}`,
        );
      }
    }
    expect(disagreements).toEqual([]);
  });

  test("deleting any group key makes ajv and zod agree on validity", () => {
    const disagreements: string[] = [];
    const groupKeys = Object.keys(
      (indexFixture as { stores: Array<{ groups: Array<Record<string, unknown>> }> }).stores[0]
        .groups[0],
    );
    for (const key of groupKeys) {
      const doc = structuredClone(indexFixture) as {
        stores: Array<{ groups: Array<Record<string, unknown>> }>;
      };
      delete doc.stores[0].groups[0][key];
      const v = bothAccept(doc);
      if (v.ajv !== v.zod) {
        disagreements.push(
          `groups[0].${key}: schema says ${v.ajv ? "valid" : "invalid"}, zod says ${v.zod ? "valid" : "invalid"}`,
        );
      }
    }
    expect(disagreements).toEqual([]);
  });

  test("a trial_types key of any length is accepted by both, on purpose", () => {
    // Neither the schema nor zod bounds a trial_types key. The converter keys a
    // value over 128 code points by a 28-character digest form (see
    // test_generate_zarr.py), but the live nm000229 index still carries long
    // literal keys until it republishes, and the schema is served publicly at
    // /schemas/zarr-index-v3.json, so tightening it would make that published
    // document invalid. The bound is the converter's, not the contract's.
    const doc = structuredClone(indexFixture) as { stores: Array<Record<string, unknown>> };
    doc.stores[0].n_events = 4;
    doc.stores[0].trial_types = {
      ["{'story': 'easy_money', ".padEnd(300, "x")]: 2,
      "{'story': 'ea~97ecccec881a7c": 1,
      go: 1,
    };
    expect(bothAccept(doc)).toEqual({ ajv: true, zod: true });
  });

  test("an unknown field is refused by the producer's gate and tolerated by consumers", () => {
    // The one asymmetry that is on purpose. If this test ever fails because
    // the two now agree, decide which way deliberately rather than "fixing"
    // it: making zod strict breaks every consumer the moment the converter
    // adds a field, and making the schema permissive removes the producer's
    // own typo gate.
    const doc = structuredClone(indexFixture) as Record<string, unknown>;
    doc.some_field_no_producer_declares = 1;
    expect(bothAccept(doc)).toEqual({ ajv: false, zod: true });
  });
});

/**
 * The `trial_types` key rule is stated in three places on this side (the
 * schema's field description, its stability `$comment`, and the zod contract's
 * comment) and implemented in `generate_zarr.py`. The numbers in the prose are
 * checked against the converter's constants, as the bounds above are, so a
 * change of limit or key shape that forgets one of them fails here.
 */
describe("the trial_types key rule in the contract text matches the converter", () => {
  const limit = pythonConstant("TRIAL_TYPE_KEY_MAX");
  const prefix = pythonConstant("_TRIAL_TYPE_PREFIX_CHARS");
  const digest = pythonConstant("_TRIAL_TYPE_DIGEST_CHARS");
  const keyLength = prefix + "~".length + digest;

  const schemaDescription = (() => {
    const found: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      const field = record.trial_types as { description?: string } | undefined;
      if (field && typeof field.description === "string") found.push(field.description);
      Object.values(record).forEach(walk);
    };
    walk(indexSchema);
    if (found.length !== 1)
      throw new Error(`expected one trial_types description, got ${found.length}`);
    return found[0];
  })();
  const stability = (indexSchema as { $comment: string }).$comment;
  const zodSource = readFileSync(
    new URL("../shared/contract/zarr-index.ts", import.meta.url),
    "utf8",
  );
  const zodComment = (() => {
    const end = zodSource.indexOf("trial_types: z.record");
    const start = zodSource.lastIndexOf("/**", end);
    if (end < 0 || start < 0) throw new Error("trial_types comment not found in zarr-index.ts");
    return zodSource.slice(start, end).replace(/\s*\*\s*/g, " ");
  })();

  test("the limit and the key shape are the published 128, 13, 14 and 28", () => {
    // The numbers clients hard-code. If the converter changes them on purpose,
    // this is the line to change with the contract text below.
    expect([limit, prefix, digest, keyLength]).toEqual([128, 13, 14, 28]);
  });

  test("the schema description states them", () => {
    expect(schemaDescription).toContain(`${limit} Unicode code points`);
    expect(schemaDescription).toContain(`first ${prefix} code points`);
    expect(schemaDescription).toContain(`first ${digest} hex digits`);
    expect(schemaDescription).toContain(`${keyLength} characters`);
  });

  test("the stability note states the limit and the key length", () => {
    expect(stability).toContain(`longer than ${limit} code points`);
    expect(stability).toContain(`${keyLength}-character digest form`);
  });

  test("the zod contract comment states them", () => {
    expect(zodComment).toContain(`${limit} Unicode code points`);
    expect(zodComment).toContain(`first ${prefix} code points`);
    expect(zodComment).toContain(`${digest} hex digits`);
    expect(zodComment).toContain(`(${keyLength} characters)`);
  });
});
