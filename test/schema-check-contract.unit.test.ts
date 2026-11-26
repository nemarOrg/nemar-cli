/**
 * `shared/contract/schema-check.ts`, the JSON Schema checker the Worker runs in place of Ajv (epic #2324
 * phase B2), held to two other validators over the vendored neuroschema 0.6.0 schemas `dataQuality` reaches:
 *
 *  - python-jsonschema, through the verdicts neuroschema ships (`views/vectors/kinds-verdicts.v1.json`):
 *    every case of a schema in that set must get the same verdict;
 *  - Ajv (draft 2020-12, the `u` flag on patterns), over a corpus: the verdict cases, the preset and
 *    generic-kind views, nemar-ica's real recording entry, and mutations of each (a member removed, a value
 *    replaced by null, a string, zero, a negative number, an empty array or object, an array item dropped or
 *    repeated). A checker that accepts what Ajv refuses, or refuses what it accepts, fails here.
 *
 * And it fails closed: a keyword it does not implement, or a reference it cannot resolve, throws when the
 * set is built, never at a verdict.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import {
  SchemaSet,
  SchemaUnsupported,
  jsonEqual,
  schemasReachableFrom,
} from "../shared/contract/schema-check.js";

// biome-ignore lint/suspicious/noExplicitAny: vectors and documents are read field by field
type Loose = any;

const NS = join(import.meta.dir, "../shared/contract/neuroschema");
const read = (path: string): Loose => JSON.parse(readFileSync(path, "utf8"));
const BUNDLE = read(join(NS, "dataset.bundle.json")) as { schemas: Record<string, unknown>[] };
const VERDICTS = read(join(NS, "views/vectors/kinds-verdicts.v1.json"));
const MODELS = read(join(NS, "views/vectors/kinds-models.v1.json"));
const PRESETS = read(join(NS, "views/vectors/preset-checks.v1.json"));
const RECORD = read(
  join(
    import.meta.dir,
    "fixtures/quality/ica-views/product/sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_desc-nemarica_signalJourney.json",
  ),
);

const DATA_QUALITY = "nsc:/extensions/dataQuality.schema.json";
const VIEW = "nsc:/definitions/view.schema.json#/$defs/view";
const REACHABLE = schemasReachableFrom(BUNDLE.schemas, DATA_QUALITY);
const SET = new SchemaSet(REACHABLE);

const ajv = new Ajv2020({ strict: false, allErrors: false, unicodeRegExp: true });
for (const s of BUNDLE.schemas) ajv.addSchema(s);
const ajvVerdict = (ref: string, instance: unknown): boolean => {
  const validate = ajv.getSchema(ref);
  if (!validate) throw new Error(`no schema ${ref}`);
  return validate(instance) as boolean;
};
const ours = (ref: string, instance: unknown): boolean => SET.check(ref, instance).valid;

/** The schema reference a verdict case names (the vector file's own convention). */
function refOf(schema: string): string | null {
  if (schema === "view") return VIEW;
  if (schema === "dataQuality") return DATA_QUALITY;
  if (schema.includes("/")) return null; // a schema outside dataQuality's reach (dataPaper)
  if (schema === "neuroschema.schema.json") return null;
  return `nsc:/views/${schema}`;
}

describe("the checker's set", () => {
  test("is every schema dataQuality reaches, the view, kind, content and transform schemas among them", () => {
    const ids = REACHABLE.map((s) => s.$id as string);
    expect(ids).toContain(DATA_QUALITY);
    expect(ids).toContain("nsc:/definitions/view.schema.json");
    expect(ids.filter((id) => id.startsWith("nsc:/views/kind.")).length).toBe(10);
    expect(ids.filter((id) => id.startsWith("nsc:/views/transform.")).length).toBe(2);
    expect(ids.filter((id) => id.startsWith("nsc:/views/content.")).length).toBe(2);
  });

  test("fails closed: an unknown keyword or an unresolvable reference throws when the set is built", () => {
    expect(() => new SchemaSet(BUNDLE.schemas)).toThrow(SchemaUnsupported);
    expect(() => new SchemaSet([{ $id: "nsc:/x.json", type: "string", format: "uri" }])).toThrow(
      SchemaUnsupported,
    );
    expect(() => new SchemaSet([{ $id: "nsc:/x.json", unevaluatedProperties: false }])).toThrow(
      SchemaUnsupported,
    );
    expect(() => new SchemaSet([{ $id: "nsc:/x.json", $ref: "nsc:/y.json" }])).toThrow(
      SchemaUnsupported,
    );
    expect(() => new SchemaSet([{ $id: "nsc:/x.json", $ref: "nsc:/x.json#/$defs/none" }])).toThrow(
      SchemaUnsupported,
    );
    expect(() => SET.check("nsc:/none.json", {})).toThrow(SchemaUnsupported);
  });

  test("counts string lengths in code points, as JSON Schema does", () => {
    const set = new SchemaSet([{ $id: "nsc:/s.json", type: "string", maxLength: 2 }]);
    expect(set.check("nsc:/s.json", "\u{1F600}\u{1F600}").valid).toBe(true);
    expect(set.check("nsc:/s.json", "abc").valid).toBe(false);
  });

  test("reads `__proto__` as an ordinary member name", () => {
    const set = new SchemaSet([
      { $id: "nsc:/o.json", type: "object", properties: { a: {} }, additionalProperties: false },
    ]);
    const instance = JSON.parse('{"__proto__": 1}');
    expect(set.check("nsc:/o.json", instance).valid).toBe(false);
    expect(set.check("nsc:/o.json", JSON.parse('{"a": 1}')).valid).toBe(true);
  });

  test("dependentSchemas: a montage needs template positions, and template positions need a montage (viewData)", () => {
    const ref = "nsc:/definitions/view.schema.json#/$defs/viewData";
    const base = {
      role: "positions",
      location: "sub-01/eeg/sub-01_desc-x_chanlocs.tsv",
      format: "tsv",
      size: 10,
      sha256: "a".repeat(64),
    };
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [base, true],
      [{ ...base, montage: "standard_1005" }, false],
      [{ ...base, montage: "standard_1005", position_source: "measured" }, false],
      [{ ...base, position_source: "template" }, false],
      [
        {
          ...base,
          montage: "standard_1005",
          position_source: "template",
          coordinate_system: "n/a",
        },
        true,
      ],
      [
        {
          ...base,
          montage: "standard_1005",
          position_source: "template",
          coordinate_system: "CTF",
        },
        false,
      ],
    ];
    for (const [instance, valid] of cases) {
      expect(ajvVerdict(ref, instance)).toBe(valid);
      expect(ours(ref, instance)).toBe(valid);
    }
  });

  test("JSON equality: numbers by value, objects by members, arrays by order", () => {
    expect(jsonEqual(1, 1.0)).toBe(true);
    expect(jsonEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(jsonEqual(true, 1)).toBe(false);
  });
});

describe("python-jsonschema's verdicts (kinds-verdicts.v1)", () => {
  const cases = (VERDICTS.cases as Loose[]).filter((c) => refOf(c.schema) !== null);

  test("cover the view, dataQuality and both content schemas, valid and invalid", () => {
    expect(cases.length).toBeGreaterThanOrEqual(240);
    expect(cases.some((c) => c.valid)).toBe(true);
    expect(cases.some((c) => !c.valid)).toBe(true);
  });

  for (const c of cases) {
    test(`${c.schema}: ${c.name}`, () => {
      expect(ours(refOf(c.schema) as string, c.instance)).toBe(c.valid);
    });
  }
});

/** Every variant of a document one edit away, at most `limit` of them. */
function mutations(doc: unknown, limit = 400): unknown[] {
  const out: unknown[] = [];
  const replacements: unknown[] = [null, "x", 0, -1, 1.5, [], {}, true];
  const walk = (node: unknown, edit: (fn: (v: unknown) => unknown) => unknown) => {
    if (out.length >= limit) return;
    for (const r of replacements) {
      if (out.length >= limit) return;
      out.push(edit(() => r));
    }
    if (Array.isArray(node)) {
      if (node.length > 0) {
        out.push(edit((v) => (v as unknown[]).slice(1)));
        out.push(edit((v) => [...(v as unknown[]), (v as unknown[])[0]]));
      }
      node.forEach((child, i) =>
        walk(child, (fn) =>
          edit((v) => {
            const copy = [...(v as unknown[])];
            copy[i] = fn(copy[i]);
            return copy;
          }),
        ),
      );
    } else if (typeof node === "object" && node !== null) {
      for (const k of Object.keys(node)) {
        out.push(
          edit((v) => {
            const copy = { ...(v as Record<string, unknown>) };
            delete copy[k];
            return copy;
          }),
        );
        walk((node as Record<string, unknown>)[k], (fn) =>
          edit((v) => {
            const copy = { ...(v as Record<string, unknown>) };
            copy[k] = fn(copy[k]);
            return copy;
          }),
        );
      }
    }
  };
  walk(doc, (fn) => fn(doc));
  return out;
}

describe("Ajv agrees on every document of the corpus and every one-edit mutation of it", () => {
  const corpus: Array<{ name: string; ref: string; doc: unknown }> = [];
  for (const c of VERDICTS.cases as Loose[]) {
    const ref = refOf(c.schema);
    if (ref !== null) corpus.push({ name: `verdict ${c.name}`, ref, doc: c.instance });
  }
  for (const c of PRESETS.cases as Loose[]) {
    corpus.push({ name: `preset ${c.name}`, ref: VIEW, doc: c.view });
  }
  for (const c of [...(MODELS.cases as Loose[]), ...(MODELS.refusals as Loose[])]) {
    corpus.push({ name: `model ${c.name}`, ref: VIEW, doc: c.view });
  }
  const nemar = RECORD.extensions.nemar;
  for (const view of nemar.views)
    corpus.push({ name: `nemar-ica ${view.key}`, ref: VIEW, doc: view });

  test("the corpus is large enough that a pass is not vacuous", () => {
    expect(corpus.length).toBeGreaterThan(600);
  });

  test("every document and every mutation gets Ajv's verdict", () => {
    let checked = 0;
    const disagreements: string[] = [];
    for (const { name, ref, doc } of corpus) {
      for (const instance of [doc, ...mutations(doc, 120)]) {
        checked++;
        const a = ajvVerdict(ref, instance);
        const b = ours(ref, instance);
        if (a !== b && disagreements.length < 10) {
          disagreements.push(
            `${name}: ajv ${a}, ours ${b}: ${JSON.stringify(instance).slice(0, 300)}`,
          );
        }
      }
    }
    expect(disagreements).toEqual([]);
    expect(checked).toBeGreaterThan(50_000);
  });

  test("nemar-ica's recording entry, as the route checks it, is valid, and a one-edit mutation of a view is judged as Ajv judges it", () => {
    const entry = {
      recipe_version: nemar.recipe.version,
      input_kind: "bids",
      profile: "archive",
      record_sha256: "0".repeat(64),
      metrics: {},
      views: nemar.views,
    };
    const document = { level: "record", recipes: { "nemar-ica": entry } };
    expect(ours(DATA_QUALITY, document)).toBe(true);
    expect(ajvVerdict(DATA_QUALITY, document)).toBe(true);
    let refused = 0;
    for (const view of mutations(nemar.views[4], 200)) {
      const mutated = {
        level: "record",
        recipes: { "nemar-ica": { ...entry, views: [...nemar.views.slice(0, 4), view] } },
      };
      const a = ajvVerdict(DATA_QUALITY, mutated);
      expect(ours(DATA_QUALITY, mutated)).toBe(a);
      if (!a) refused++;
    }
    expect(refused).toBeGreaterThan(100);
  });
});
