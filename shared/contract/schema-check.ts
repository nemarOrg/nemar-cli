/**
 * A JSON Schema (draft 2020-12) checker for the Worker, which cannot run Ajv: Ajv compiles each schema
 * into a function with `new Function`, and the Worker refuses code generated at run time. This file
 * INTERPRETS a schema instead, over the subset of keywords the vendored neuroschema schemas use, and
 * answers what a conforming validator answers (epic #2324 phase B2, ADR 0137 decisions 6 and 7).
 *
 * WHY AN INTERPRETER AND NOT A ZOD MIRROR. A recording's views are checked against neuroschema's
 * `dataQuality`, which reaches `view.schema.json` and the kind, content and transform schemas: about
 * 110 KB of JSON Schema with 70 conditionals and 50 `contains`. A hand mirror would be thousands of
 * lines that drift with every re-vendor. Interpreting the vendored text checks exactly what neuroschema
 * states, and `test/schema-check-contract.unit.test.ts` holds the verdicts to the kinds-verdicts
 * vectors (python-jsonschema's) and to Ajv over a corpus.
 *
 * FAIL CLOSED. `SchemaSet` walks every schema it is given when it is built and throws on any keyword it
 * does not implement, so a re-vendored schema that starts using one cannot be checked by halves.
 *
 * WHAT IT ASSUMES OF AN INSTANCE. A JSON value as `readIJson` (or `JSON.parse`) gives it: objects with
 * own members only, arrays, strings, finite numbers, booleans and null. Member names are looked up with
 * `Object.hasOwn`, so `__proto__` is an ordinary name. String lengths count code points, as JSON Schema
 * does, and a pattern is compiled with the `u` flag, as Ajv compiles it.
 *
 * Pure and import-free: no clock, database or network.
 */

/** The keywords this checker evaluates. */
const APPLIED = new Set([
  "type",
  "enum",
  "const",
  "properties",
  "patternProperties",
  "additionalProperties",
  "propertyNames",
  "required",
  "minProperties",
  "maxProperties",
  "dependentRequired",
  "dependentSchemas",
  "prefixItems",
  "items",
  "contains",
  "minContains",
  "maxContains",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "$ref",
]);

/** Keywords that annotate or organize and assert nothing. */
const INERT = new Set([
  "$schema",
  "$id",
  "$defs",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

/** A schema: an object of keywords, or `true` (anything) or `false` (nothing). */
export type Schema = boolean | { readonly [keyword: string]: unknown };

export class SchemaUnsupported extends Error {
  constructor(
    readonly at: string,
    readonly keyword: string,
  ) {
    super(`schema keyword not supported: ${keyword} at ${at}`);
    this.name = "SchemaUnsupported";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const codePoints = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

/** JSON equality: numbers by value, arrays by order, objects by their members. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

function typeHolds(type: string, v: unknown): boolean {
  switch (type) {
    case "null":
      return v === null;
    case "boolean":
      return typeof v === "boolean";
    case "object":
      return isObject(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    default:
      return false;
  }
}

/** Where a check failed: the instance path and the keyword, for a log line. */
export interface SchemaFailure {
  at: string;
  keyword: string;
}

/**
 * A set of schemas, each with an absolute `$id`, that refer to each other by `$ref` (`<id>` or
 * `<id>#<JSON pointer>`). Build it once; `check` is then safe to call for any number of instances.
 */
export class SchemaSet {
  private readonly byId = new Map<string, Schema>();
  private readonly patterns = new Map<string, RegExp>();

  constructor(schemas: readonly Record<string, unknown>[]) {
    for (const s of schemas) {
      if (typeof s.$id !== "string") throw new SchemaUnsupported("(root)", "$id");
      this.byId.set(s.$id, s);
    }
    for (const s of schemas) this.walk(s, s.$id as string, s.$id as string);
  }

  /** Every keyword of every subschema is known, every pattern compiles and every `$ref` resolves. */
  private walk(schema: unknown, id: string, at: string): void {
    if (typeof schema === "boolean") return;
    if (!isObject(schema)) throw new SchemaUnsupported(at, "(not a schema)");
    for (const [keyword, value] of Object.entries(schema)) {
      if (INERT.has(keyword)) {
        if (keyword === "$defs" && isObject(value)) {
          for (const [name, sub] of Object.entries(value))
            this.walk(sub, id, `${at}/$defs/${name}`);
        }
        continue;
      }
      if (!APPLIED.has(keyword)) throw new SchemaUnsupported(at, keyword);
      const here = `${at}/${keyword}`;
      switch (keyword) {
        case "properties":
        case "patternProperties":
        case "dependentSchemas":
          if (!isObject(value)) throw new SchemaUnsupported(here, keyword);
          for (const [name, sub] of Object.entries(value)) {
            if (keyword === "patternProperties") this.regex(name);
            this.walk(sub, id, `${here}/${name}`);
          }
          break;
        case "allOf":
        case "anyOf":
        case "oneOf":
        case "prefixItems":
          if (!Array.isArray(value)) throw new SchemaUnsupported(here, keyword);
          value.forEach((sub, i) => this.walk(sub, id, `${here}/${i}`));
          break;
        case "additionalProperties":
        case "propertyNames":
        case "items":
        case "contains":
        case "not":
        case "if":
        case "then":
        case "else":
          this.walk(value, id, here);
          break;
        case "pattern":
          if (typeof value !== "string") throw new SchemaUnsupported(here, keyword);
          this.regex(value);
          break;
        case "type":
          if (
            !(
              typeof value === "string" ||
              (Array.isArray(value) && value.every((t) => typeof t === "string"))
            )
          ) {
            throw new SchemaUnsupported(here, keyword);
          }
          break;
        case "$ref":
          if (typeof value !== "string" || this.resolve(value, id) === undefined) {
            throw new SchemaUnsupported(here, `$ref ${String(value)}`);
          }
          break;
        default:
          break;
      }
    }
  }

  private regex(source: string): RegExp {
    let re = this.patterns.get(source);
    if (re === undefined) {
      re = new RegExp(source, "u");
      this.patterns.set(source, re);
    }
    return re;
  }

  /** The schema a reference names: `<id>`, `<id>#/<pointer>` or `#/<pointer>` within `base`. */
  private resolve(ref: string, base: string): Schema | undefined {
    const hash = ref.indexOf("#");
    const id = hash < 0 ? ref : ref.slice(0, hash);
    const pointer = hash < 0 ? "" : ref.slice(hash + 1);
    let node: unknown = this.byId.get(id === "" ? base : id);
    if (node === undefined) return undefined;
    if (pointer === "") return node as Schema;
    if (!pointer.startsWith("/")) return undefined;
    for (const raw of pointer.slice(1).split("/")) {
      const part = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
      if (Array.isArray(node) && /^(0|[1-9][0-9]*)$/.test(part) && Number(part) < node.length) {
        node = node[Number(part)];
      } else if (isObject(node) && Object.hasOwn(node, part)) {
        node = node[part];
      } else {
        return undefined;
      }
    }
    return typeof node === "boolean" || isObject(node) ? (node as Schema) : undefined;
  }

  /**
   * Whether `instance` is valid against the schema `ref` names (an `$id`, with an optional JSON pointer
   * fragment). An unknown reference throws: that is a programming error, never a verdict.
   */
  check(
    ref: string,
    instance: unknown,
  ): { valid: true } | { valid: false; failure: SchemaFailure } {
    const id = ref.split("#")[0] as string;
    const schema = this.resolve(ref, id);
    if (schema === undefined) throw new SchemaUnsupported(ref, "$ref");
    const failure: SchemaFailure[] = [];
    const valid = this.holds(schema, id, instance, "", failure);
    return valid
      ? { valid: true }
      : { valid: false, failure: failure[0] ?? { at: "", keyword: "(unknown)" } };
  }

  /**
   * Whether one instance holds under one schema. `base` is the id the schema sits in, for a `#` reference.
   * `out` collects the first failure of the outermost branch that decided the verdict; it is a diagnostic
   * only and no verdict depends on it.
   */
  private holds(
    schema: Schema,
    base: string,
    v: unknown,
    at: string,
    out: SchemaFailure[] | null,
  ): boolean {
    if (schema === true) return true;
    if (schema === false) {
      out?.push({ at, keyword: "false" });
      return false;
    }
    const s = schema as Record<string, unknown>;
    const fail = (keyword: string, where = at): false => {
      out?.push({ at: where, keyword });
      return false;
    };
    const sub = (child: unknown, value: unknown, where: string, keep: boolean): boolean =>
      this.holds(child as Schema, base, value, where, keep ? out : null);
    const nextBase = typeof s.$id === "string" ? s.$id : base;
    if (nextBase !== base) return this.holds(schema, nextBase, v, at, out);

    if (s.$ref !== undefined) {
      const target = this.resolve(s.$ref as string, base);
      if (target === undefined) throw new SchemaUnsupported(base, `$ref ${String(s.$ref)}`);
      const targetBase = (s.$ref as string).startsWith("#")
        ? base
        : (s.$ref as string).split("#")[0] || base;
      if (!this.holds(target, targetBase, v, at, out)) return false;
    }

    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      if (!types.some((t) => typeHolds(t, v))) return fail("type");
    }
    if (s.enum !== undefined && !(s.enum as unknown[]).some((e) => jsonEqual(e, v))) {
      return fail("enum");
    }
    if (Object.hasOwn(s, "const") && !jsonEqual(s.const, v)) return fail("const");

    if (typeof v === "string") {
      if (s.minLength !== undefined || s.maxLength !== undefined) {
        const n = codePoints(v);
        if (s.minLength !== undefined && n < (s.minLength as number)) return fail("minLength");
        if (s.maxLength !== undefined && n > (s.maxLength as number)) return fail("maxLength");
      }
      if (s.pattern !== undefined && !this.regex(s.pattern as string).test(v)) {
        return fail("pattern");
      }
    }

    if (typeof v === "number") {
      if (s.minimum !== undefined && !(v >= (s.minimum as number))) return fail("minimum");
      if (s.maximum !== undefined && !(v <= (s.maximum as number))) return fail("maximum");
      if (s.exclusiveMinimum !== undefined && !(v > (s.exclusiveMinimum as number))) {
        return fail("exclusiveMinimum");
      }
      if (s.exclusiveMaximum !== undefined && !(v < (s.exclusiveMaximum as number))) {
        return fail("exclusiveMaximum");
      }
      if (s.multipleOf !== undefined) {
        const q = v / (s.multipleOf as number);
        if (!Number.isFinite(q) || !Number.isInteger(q)) return fail("multipleOf");
      }
    }

    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < (s.minItems as number)) return fail("minItems");
      if (s.maxItems !== undefined && v.length > (s.maxItems as number)) return fail("maxItems");
      if (s.uniqueItems === true) {
        for (let i = 0; i < v.length; i++) {
          for (let j = i + 1; j < v.length; j++) {
            if (jsonEqual(v[i], v[j])) return fail("uniqueItems");
          }
        }
      }
      const prefix = (s.prefixItems as unknown[] | undefined) ?? [];
      for (let i = 0; i < Math.min(prefix.length, v.length); i++) {
        if (!sub(prefix[i], v[i], `${at}/${i}`, true)) return false;
      }
      if (s.items !== undefined) {
        for (let i = prefix.length; i < v.length; i++) {
          if (!sub(s.items, v[i], `${at}/${i}`, true)) return false;
        }
      }
      if (s.contains !== undefined) {
        let matched = 0;
        for (let i = 0; i < v.length; i++) {
          if (sub(s.contains, v[i], `${at}/${i}`, false)) matched++;
        }
        const min = (s.minContains as number | undefined) ?? 1;
        if (matched < min) return fail("contains");
        if (s.maxContains !== undefined && matched > (s.maxContains as number)) {
          return fail("maxContains");
        }
      }
    }

    if (isObject(v)) {
      const names = Object.keys(v);
      if (s.minProperties !== undefined && names.length < (s.minProperties as number)) {
        return fail("minProperties");
      }
      if (s.maxProperties !== undefined && names.length > (s.maxProperties as number)) {
        return fail("maxProperties");
      }
      for (const name of (s.required as string[] | undefined) ?? []) {
        if (!Object.hasOwn(v, name)) return fail("required", `${at}/${name}`);
      }
      if (s.dependentRequired !== undefined) {
        for (const [name, needs] of Object.entries(
          s.dependentRequired as Record<string, string[]>,
        )) {
          if (!Object.hasOwn(v, name)) continue;
          for (const need of needs) {
            if (!Object.hasOwn(v, need)) return fail("dependentRequired", `${at}/${need}`);
          }
        }
      }
      const props = (s.properties as Record<string, unknown> | undefined) ?? {};
      const patterns = (s.patternProperties as Record<string, unknown> | undefined) ?? {};
      for (const name of names) {
        const where = `${at}/${name}`;
        let evaluated = false;
        if (Object.hasOwn(props, name)) {
          evaluated = true;
          if (!sub(props[name], v[name], where, true)) return false;
        }
        for (const [pattern, child] of Object.entries(patterns)) {
          if (!this.regex(pattern).test(name)) continue;
          evaluated = true;
          if (!sub(child, v[name], where, true)) return false;
        }
        if (!evaluated && s.additionalProperties !== undefined) {
          if (!sub(s.additionalProperties, v[name], where, true)) {
            return fail("additionalProperties", where);
          }
        }
        if (s.propertyNames !== undefined && !sub(s.propertyNames, name, where, false)) {
          return fail("propertyNames", where);
        }
      }
      if (s.dependentSchemas !== undefined) {
        for (const [name, child] of Object.entries(s.dependentSchemas as Record<string, unknown>)) {
          if (Object.hasOwn(v, name) && !sub(child, v, at, true)) return false;
        }
      }
    }

    if (s.allOf !== undefined) {
      for (const child of s.allOf as unknown[]) if (!sub(child, v, at, true)) return false;
    }
    if (s.anyOf !== undefined && !(s.anyOf as unknown[]).some((c) => sub(c, v, at, false))) {
      return fail("anyOf");
    }
    if (s.oneOf !== undefined) {
      let n = 0;
      for (const child of s.oneOf as unknown[]) if (sub(child, v, at, false)) n++;
      if (n !== 1) return fail("oneOf");
    }
    if (s.not !== undefined && sub(s.not, v, at, false)) return fail("not");
    if (s.if !== undefined) {
      if (sub(s.if, v, at, false)) {
        if (s.then !== undefined && !sub(s.then, v, at, true)) return false;
      } else if (s.else !== undefined && !sub(s.else, v, at, true)) {
        return false;
      }
    }
    return true;
  }
}

/**
 * The schemas of `all` that `root` reaches through `$ref`, itself included, in the order of `all`: what a
 * `SchemaSet` for that root needs, so a keyword used only by an unrelated schema of a bundle does not stop it.
 */
export function schemasReachableFrom<T extends { $id?: unknown }>(
  all: readonly T[],
  root: string,
): T[] {
  const byId = new Map<string, T>();
  for (const s of all) if (typeof s.$id === "string") byId.set(s.$id, s);
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    const schema = byId.get(id);
    if (schema === undefined) throw new SchemaUnsupported(id, "$ref");
    seen.add(id);
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(visit);
      else if (isObject(node)) {
        for (const [k, v] of Object.entries(node)) {
          if (k === "$ref" && typeof v === "string") {
            const target = v.split("#")[0] as string;
            if (target !== "") stack.push(target);
          } else visit(v);
        }
      }
    };
    visit(schema);
  }
  return all.filter((s) => typeof s.$id === "string" && seen.has(s.$id));
}
