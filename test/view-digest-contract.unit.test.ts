/**
 * `nemar.view-digest.v1` and its I-JSON reader (`shared/contract/view-digest.ts`; ADR 0137 decision 9 and
 * its amendment, epic #2324 phase B1, #2341): the backend's RFC 8785 canonical form replays every case of
 * neuroschema 0.6.0's `views/vectors/view-digest.v1.json` (the canonical bytes and their SHA-256, the float
 * cases `computed_view` and `numbers` among them), and refuses every one of its fourteen refusals, by
 * reading the refusal's text with `readIJson` and canonicalizing what it reads.
 *
 * Mutations each case below is held by (each one fails at least one case): accepting a duplicate member
 * name; comparing names before their escapes are decoded; leaving out the noncharacter check, or the lone
 * surrogate check; a depth limit of 65; printing numbers with `toFixed` or with a trailing `.0`; sorting
 * names by code point; escaping `/` or U+2028; reading `__proto__` through the prototype setter; letting a
 * byte order mark through.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  I_JSON_MAX_DEPTH,
  canonicalJson,
  readIJson,
  viewDigest,
} from "../shared/contract/view-digest";

interface Vectors {
  format: string;
  cases: { name: string; declaration: unknown; canonical: string; sha256: string }[];
  refusals: { name: string; json: string }[];
}

const VECTORS = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../shared/contract/neuroschema/views/vectors/view-digest.v1.json"),
    "utf8",
  ),
) as Vectors;

/** The digest of a declaration's text, read as the backend reads a record: I-JSON, then canonical. */
async function digestOfText(text: string): Promise<string> {
  const read = readIJson(text);
  if (!read.ok) throw new RangeError(read.reason);
  return viewDigest(read.value);
}

describe("nemar.view-digest.v1 vectors", () => {
  test("the vectors file is the format this module implements, with nine cases and fourteen refusals", () => {
    expect(VECTORS.format).toBe("nemar.view-digest.v1");
    expect(VECTORS.cases).toHaveLength(9);
    expect(VECTORS.refusals).toHaveLength(14);
    expect(VECTORS.cases.map((c) => c.name)).toContain("computed_view");
    expect(VECTORS.cases.map((c) => c.name)).toContain("numbers");
  });

  for (const c of VECTORS.cases) {
    test(`case ${c.name}: canonical bytes and digest`, async () => {
      // As the spec says: parsed with a standard parser (the vectors file), then canonicalized.
      expect(canonicalJson(c.declaration)).toBe(c.canonical);
      expect(await viewDigest(c.declaration)).toBe(c.sha256);
      // And read from its own text by the I-JSON reader, which must read the same value.
      expect(await digestOfText(JSON.stringify(c.declaration))).toBe(c.sha256);
      expect(await digestOfText(c.canonical)).toBe(c.sha256);
    });
  }

  for (const r of VECTORS.refusals) {
    test(`refusal ${r.name}: no digest`, async () => {
      await expect(digestOfText(r.json)).rejects.toThrow(RangeError);
    });
  }

  test("each refusal is refused for its own reason", () => {
    const reasons = Object.fromEntries(
      VECTORS.refusals.map((r) => {
        const read = readIJson(r.json);
        return [r.name, read.ok ? "read" : read.reason];
      }),
    );
    expect(reasons).toEqual({
      lone_surrogate: "lone_surrogate",
      lone_surrogate_in_key: "lone_surrogate",
      not_finite: "not_finite",
      integer_beyond_binary64: "not_finite",
      // The reader reads an array; the digest refuses it as not an object.
      not_an_object: "read",
      duplicate_member_name: "duplicate_member",
      nan_literal: "not_json",
      noncharacter: "noncharacter",
      noncharacter_in_key: "noncharacter",
      noncharacter_astral: "noncharacter",
      noncharacter_raw: "noncharacter",
      escaped_duplicate_member_name: "duplicate_member",
      escaped_duplicate_nested: "duplicate_member",
      nested_65: "too_deep",
    });
  });
});

describe("canonicalJson refuses what JSON.stringify would write", () => {
  test("a lone surrogate, a noncharacter, a number that is not finite, nesting past 64", () => {
    expect(() => canonicalJson({ a: "\ud800" })).toThrow("lone_surrogate");
    expect(() => canonicalJson({ "\udc00": 1 })).toThrow("lone_surrogate");
    expect(() => canonicalJson({ a: "\ufdd0" })).toThrow("noncharacter");
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow("not_finite");
    expect(() => canonicalJson({ a: Number.NaN })).toThrow("not_finite");
    let deep: unknown = 1;
    for (let i = 0; i < I_JSON_MAX_DEPTH; i++) deep = [deep];
    expect(() => canonicalJson(deep)).not.toThrow();
    expect(() => canonicalJson([deep])).toThrow("too_deep");
  });

  test("a value that is not JSON (undefined, a function, a bigint) has no canonical form", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow("not_json");
    expect(() => canonicalJson(10n)).toThrow("not_json");
  });

  test("a declaration that is not an object has no digest", async () => {
    await expect(viewDigest([1, 2])).rejects.toThrow("not_an_object");
    await expect(viewDigest(null)).rejects.toThrow("not_an_object");
  });
});

describe("readIJson", () => {
  test("reads numbers as JSON.parse does, and flags an integer literal beyond 2^53 - 1", () => {
    const read = readIJson('{"a":9007199254740993,"b":1.5e3,"c":-0}');
    expect(read).toEqual({
      ok: true,
      value: { a: 9007199254740992, b: 1500, c: -0 },
      unsafeInteger: true,
    });
    expect(readIJson("[9007199254740991, -9007199254740991, 1e300]")).toMatchObject({
      ok: true,
      unsafeInteger: false,
    });
    expect(readIJson("[-9007199254740992]")).toMatchObject({ ok: true, unsafeInteger: true });
  });

  test("a member named __proto__ is an own member, and the object keeps its prototype", () => {
    const read = readIJson('{"__proto__":{"polluted":true},"a":1}');
    if (!read.ok) throw new Error(read.reason);
    const value = read.value as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(["__proto__", "a"]);
    expect((value as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(canonicalJson(value)).toBe('{"__proto__":{"polluted":true},"a":1}');
  });

  test("refuses a byte order mark, trailing text, a raw control character and a bad escape", () => {
    expect(readIJson('\ufeff{"a":1}')).toEqual({ ok: false, reason: "not_json" });
    expect(readIJson('{"a":1} x')).toEqual({ ok: false, reason: "not_json" });
    expect(readIJson('{"a":"x\ny"}')).toEqual({ ok: false, reason: "not_json" });
    expect(readIJson('{"a":"\\x"}')).toEqual({ ok: false, reason: "not_json" });
    expect(readIJson('{"a":"\\u12"}')).toEqual({ ok: false, reason: "not_json" });
    expect(readIJson("01")).toEqual({ ok: false, reason: "not_json" });
    expect(readIJson("")).toEqual({ ok: false, reason: "not_json" });
    expect(readIJson('{"a":1,}')).toEqual({ ok: false, reason: "not_json" });
    expect(readIJson("[1,]")).toEqual({ ok: false, reason: "not_json" });
  });

  test("agrees with JSON.parse on every text JSON.parse reads that is I-JSON", () => {
    for (const text of [
      ' { "a" : [ 1 , 2.5 , -3e-2 , true , false , null , "x\\"y\\\\z\\/\\b\\f\\n\\r\\t\\u00e9" ] } ',
      '"\\ud83d\\ude00"',
      "[]",
      "{}",
      "0",
      '{"nested":{"deeper":[{"k":"v"}]}}',
    ]) {
      const read = readIJson(text);
      expect(read.ok, text).toBe(true);
      if (read.ok) expect(read.value).toEqual(JSON.parse(text));
    }
  });
});
