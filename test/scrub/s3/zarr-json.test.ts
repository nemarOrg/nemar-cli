/**
 * The text editor behind the zarr stage: it cuts identifier-named members out of a zarr.json's
 * `attributes` and must change nothing else, byte for byte. The stage's own tests drive it through
 * the CLI; these pin the cases a hand-rolled JSON scanner gets wrong (first, last and adjacent
 * members, strings that look like structure, numbers that do not survive a re-serialization), and
 * check it against an independent structural deletion over random documents.
 *
 * Every key and value below is invented.
 */

import { describe, expect, test } from "bun:test";
import {
  ZarrJsonError,
  identifierKeyCount,
  removeIdentifierKeys,
} from "../../../scripts/scrub/s3/zarr-json";

const cut = (text: string) => removeIdentifierKeys(text);

describe("removeIdentifierKeys: exact text", () => {
  test("pretty-printed: the member and its line go, every other byte stays", () => {
    const text = `{
  "zarr_format": 3,
  "node_type": "group",
  "attributes": {
    "recording_metadata": {
      "patientcode": "P0042 Marigold",
      "birthdate": "03-JUL-1971",
      "startdate": "02.02.20",
      "gender": "F",
      "equipment": "BioSemi"
    }
  }
}
`;
    const expected = `{
  "zarr_format": 3,
  "node_type": "group",
  "attributes": {
    "recording_metadata": {
      "startdate": "02.02.20",
      "gender": "F",
      "equipment": "BioSemi"
    }
  }
}
`;
    const r = cut(text);
    expect(r.removed).toBe(2);
    expect(r.text).toBe(expected);
  });

  test("compact: first, middle, last, adjacent and every member of an object", () => {
    const c = (inner: string) => `{"attributes":{${inner}}}`;
    const cases: Array<[string, string, number]> = [
      [`"dob":"x","a":1,"b":2`, `"a":1,"b":2`, 1],
      [`"a":1,"dob":"x","b":2`, `"a":1,"b":2`, 1],
      [`"a":1,"b":2,"dob":"x"`, `"a":1,"b":2`, 1],
      [`"dob":"x"`, "", 1],
      [`"dob":"x","mrn":"y"`, "", 2],
      [`"a":1,"dob":"x","mrn":"y"`, `"a":1`, 2],
      [`"dob":"x","mrn":"y","a":1`, `"a":1`, 2],
      [`"a":1,"dob":"x","b":2,"mrn":"y"`, `"a":1,"b":2`, 2],
      [`"dob":"x","a":1,"mrn":"y","b":2,"ssn":"z"`, `"a":1,"b":2`, 3],
    ];
    for (const [inner, kept, n] of cases) {
      const r = cut(c(inner));
      expect(r.text, inner).toBe(c(kept));
      expect(r.removed, inner).toBe(n);
      expect(() => JSON.parse(r.text), inner).not.toThrow();
    }
  });

  test("Python-style separators and tabs survive, and nested members and arrays are searched", () => {
    const text =
      '{"zarr_format": 3, "attributes": {"channels": [{"name": "Fz", "dob": "1971-07-03"}, {"name": "Cz"}], "a": {"b": {"mrn": "12345", "keep": 1.0}}}}';
    const r = cut(text);
    expect(r.text).toBe(
      '{"zarr_format": 3, "attributes": {"channels": [{"name": "Fz"}, {"name": "Cz"}], "a": {"b": {"keep": 1.0}}}}',
    );
    expect(r.removed).toBe(2);
    const tabbed = `{\n\t"attributes": {\n\t\t"mrn": "1",\n\t\t"keep": true\n\t}\n}`;
    expect(cut(tabbed).text).toBe(`{\n\t"attributes": {\n\t\t"keep": true\n\t}\n}`);
  });

  test("a removed member takes everything it holds, once", () => {
    const text = `{"attributes":{"patientname":{"first":"a","last":"b","dob":"c"},"keep":0}}`;
    const r = cut(text);
    expect(r.text).toBe(`{"attributes":{"keep":0}}`);
    expect(r.removed).toBe(1);
  });

  test("names are matched as the scanner matches them: case, spaces, underscores, hyphens", () => {
    for (const key of ["Patient_Code", "BIRTH-DATE", "Date Of Birth", "DOB", "patientName"]) {
      const text = `{"attributes":{${JSON.stringify(key)}:"x","keep":1}}`;
      expect(cut(text).text, key).toBe(`{"attributes":{"keep":1}}`);
    }
  });

  test("what the scanner does not flag is kept: empty values, review keys, similar names", () => {
    const text = `{"attributes":{"patientcode":"","dob":null,"birthdate":[],"mrn":{},"email":"a@b.test","phone":"1","birth_year":1971,"patient":"x","startdate":"02.02.20"}}`;
    const r = cut(text);
    expect(r.removed).toBe(0);
    expect(r.text).toBe(text);
  });

  test("only `attributes` is searched: an identifier key elsewhere is left for the caller to see", () => {
    const text = `{"patientcode":"x","attributes":{"keep":1},"other":{"dob":"y"}}`;
    const r = cut(text);
    expect(r.text).toBe(text);
    expect(r.removed).toBe(0);
    // And the caller can tell: the document still has identifier keys.
    expect(identifierKeyCount(JSON.parse(r.text))).toBe(2);
  });

  test("bytes outside the cuts are the original bytes: numbers, escapes, key order, unicode", () => {
    const text =
      '{"attributes":{"z":1.0,"a":12345678901234567890,"e":1E5,"s":"caf\\u00e9 \\"q\\" {,} [x]","mrn":"1","\\u0062":-0.0,"é":"é"},"zarr_format":3}';
    const r = cut(text);
    expect(r.text).toBe(
      '{"attributes":{"z":1.0,"a":12345678901234567890,"e":1E5,"s":"caf\\u00e9 \\"q\\" {,} [x]","\\u0062":-0.0,"é":"é"},"zarr_format":3}',
    );
  });

  test("a string value that looks like structure does not confuse the scanner", () => {
    const text = `{"attributes":{"note":"},\\"mrn\\":\\"1\\",{","mrn":"1","after":"]"}}`;
    const r = cut(text);
    expect(r.text).toBe(`{"attributes":{"note":"},\\"mrn\\":\\"1\\",{","after":"]"}}`);
    expect(r.removed).toBe(1);
  });

  test("no attributes, an empty object, a clean document: unchanged", () => {
    for (const text of [
      `{"zarr_format":3}`,
      `{"attributes":{}}`,
      `{"attributes":[]}`,
      `{"attributes":{"startdate":"02.02.20"}}`,
      "{ }",
    ]) {
      expect(cut(text), text).toEqual({ text, removed: 0 });
    }
  });

  test("anything that is not a JSON object is refused with a fixed word, never echoed", () => {
    for (const text of [
      "",
      "{",
      "not json Marigold",
      "[1,2]",
      `"Marigold"`,
      "null",
      `{"a":1,}`,
      `{"attributes":{"mrn":"Marigold"`,
      "﻿{}",
    ]) {
      let err: unknown;
      try {
        cut(text);
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(text)).toBeInstanceOf(ZarrJsonError);
      expect(String((err as Error).message)).toBe("zarr-json-malformed");
    }
    // Nested past the limit: refused, not recursed into.
    const deep = `{"attributes":${"[".repeat(300)}${"]".repeat(300)}}`;
    expect(() => cut(deep)).toThrow(ZarrJsonError);
  });
});

// ---------------------------------------------------------------------------
// Random documents against an independent structural deletion.
// ---------------------------------------------------------------------------

/** A deterministic generator: xorshift32. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  const next = () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x100000000;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)] as T,
  };
}

const IDENTIFIER_SPELLINGS = [
  "patientcode",
  "Patient_Code",
  "birthdate",
  "BIRTH-DATE",
  "dob",
  "MRN",
];
const IDENTIFIER_CANON = new Set(["patientcode", "birthdate", "dob", "mrn"]);
const SAFE_KEYS = ["startdate", "gender", "equipment", "name", "label", "channels", "units", "n"];
const canon = (k: string) => k.toLowerCase().replace(/[ _-]/g, "");

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function genValue(r: ReturnType<typeof rng>, depth: number): Json {
  const t = r.int(depth > 3 ? 4 : 7);
  if (t === 0) return r.pick(["x", "café", 'q"uote', "{[,]}", "line\nbreak", ""]);
  if (t === 1) return r.pick([0, 1, -2, 3.5, 1e21, 0.1, 123456789012]);
  if (t === 2) return r.pick([true, false, null]);
  if (t === 3) return "Marigold";
  if (t <= 5) return Array.from({ length: r.int(4) }, () => genValue(r, depth + 1));
  return genObject(r, depth + 1);
}

function genObject(r: ReturnType<typeof rng>, depth: number): { [k: string]: Json } {
  const o: { [k: string]: Json } = {};
  const n = r.int(6);
  for (let i = 0; i < n; i++) {
    if (r.next() < 0.4) {
      // An identifier key: with content most of the time, empty some of it.
      const empty = r.next() < 0.25;
      o[r.pick(IDENTIFIER_SPELLINGS)] = empty ? r.pick(["", [], {}, null]) : genContent(r, depth);
    } else {
      o[`${r.pick(SAFE_KEYS)}${r.int(100)}`] = genValue(r, depth);
    }
  }
  return o;
}

/** Content the scanner counts: a non-empty string, a number, or a container holding one. */
function genContent(r: ReturnType<typeof rng>, depth: number): Json {
  const t = r.int(4);
  if (t === 0) return "P0042 Marigold";
  if (t === 1) return r.pick([7, 1971]);
  if (t === 2) return [genObject(r, depth + 1), "x"];
  return { first: "a", nested: { dob: "1971-07-03" } };
}

const hasContent = (v: Json): boolean => {
  if (v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (typeof v === "number" || typeof v === "boolean") return true;
  if (Array.isArray(v)) return v.some(hasContent);
  return Object.values(v).some(hasContent);
};

/** The expected result, built by structure: drop identifier-named members that hold content. */
function dropIdentifiers(v: Json): Json {
  if (Array.isArray(v)) return v.map(dropIdentifiers);
  if (v === null || typeof v !== "object") return v;
  const out: { [k: string]: Json } = {};
  for (const [k, val] of Object.entries(v)) {
    if (IDENTIFIER_CANON.has(canon(k)) && hasContent(val)) continue;
    out[k] = dropIdentifiers(val);
  }
  return out;
}

function pyDumps(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(", ")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.entries(v)
      .map(([k, val]) => `${JSON.stringify(k)}: ${pyDumps(val)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(v);
}

describe("removeIdentifierKeys: against a structural deletion", () => {
  test("random documents, in four layouts, come out as the same document minus the keys", () => {
    const r = rng(20261004);
    let removedTotal = 0;
    for (let n = 0; n < 400; n++) {
      const attributes = genObject(r, 0);
      const doc: Json = { zarr_format: 3, node_type: "group", attributes };
      const layouts = [
        JSON.stringify(doc),
        JSON.stringify(doc, null, 2),
        JSON.stringify(doc, null, "\t"),
        pyDumps(doc),
      ];
      const expected = {
        zarr_format: 3,
        node_type: "group",
        attributes: dropIdentifiers(attributes),
      };
      for (const text of layouts) {
        const res = removeIdentifierKeys(text);
        expect(JSON.parse(res.text), text).toEqual(expected);
        expect(identifierKeyCount(JSON.parse(res.text)), text).toBe(0);
        removedTotal += res.removed;
        if (res.removed === 0) expect(res.text).toBe(text);
        // Idempotent: nothing left to cut.
        expect(removeIdentifierKeys(res.text)).toEqual({ text: res.text, removed: 0 });
      }
    }
    // The generator really produced removals, or the loop above proved nothing.
    expect(removedTotal).toBeGreaterThan(1000);
  });
});
