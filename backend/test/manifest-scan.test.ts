/**
 * The streaming manifest tokenizer (#1502) against its contract, which is
 * `JSON.parse(await response.text())` followed by `loadManifest`'s shape
 * check: every document here is judged both ways and the verdicts compared.
 *
 * Real engines only. The reference is the runtime's own `JSON.parse` and
 * `Response.text()`; the real fixture is nm000132's published v1.1.1 manifest,
 * byte for byte. The hand-written documents exist because the real manifest
 * is well-formed ASCII and so cannot reach the grammar's edges (escapes,
 * surrogates, invalid UTF-8, every malformation) that a streaming tokenizer
 * can get wrong at a chunk boundary.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FilesVisitor,
  type ManifestHeader,
  ManifestScanner,
  type ScanResult,
  defineJsonMember,
  scanManifestStream,
  scanManifestText,
} from "../src/services/manifest-scan";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures/manifest-nm000132-v1.1.1.json"));

/** Builds every entry, the way JSON.parse would have. */
class BuildAll implements FilesVisitor {
  files: Record<string, unknown> = {};
  keys: string[] = [];
  resets = 0;
  reset(): void {
    this.files = {};
    this.keys = [];
    this.resets++;
  }
  key(path: string): boolean {
    this.keys.push(path);
    return true;
  }
  value(path: string, value: unknown): void {
    defineJsonMember(this.files, path, value);
  }
}

type Verdict =
  | { kind: "malformed" }
  | { kind: "no_files" }
  | { kind: "ok"; header: Record<string, unknown>; files: Record<string, unknown> };

/** The contract: exactly what `loadManifest` decided from `JSON.parse`. */
function referenceVerdict(text: string): Verdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "malformed" };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("files" in parsed) ||
    typeof (parsed as { files: unknown }).files !== "object" ||
    (parsed as { files: unknown }).files === null
  ) {
    return { kind: "no_files" };
  }
  const p = parsed as Record<string, unknown>;
  const header: Record<string, unknown> = {};
  for (const k of ["dataset_id", "version", "doi", "concept_doi", "created"]) {
    if (Object.hasOwn(p, k)) header[k] = p[k];
  }
  return { kind: "ok", header, files: p.files as Record<string, unknown> };
}

function verdictOf(result: ScanResult, visitor: BuildAll): Verdict {
  if (result.kind === "malformed") return { kind: "malformed" };
  if (result.kind === "no_files") return { kind: "no_files" };
  return { kind: "ok", header: { ...(result.header as unknown as object) }, files: visitor.files };
}

/**
 * Compare two verdicts completely: the entries in `Object.entries` order,
 * each value deeply (with `Object.is` semantics, so -0 is not 0), and the
 * header. A files ARRAY compares by its entries, which is what every caller
 * iterates.
 */
function expectSameVerdict(actual: Verdict, expected: Verdict, label: string): void {
  expect({ label, kind: actual.kind }).toEqual({ label, kind: expected.kind });
  if (actual.kind !== "ok" || expected.kind !== "ok") return;
  expect(Object.keys(actual.header).sort()).toEqual(Object.keys(expected.header).sort());
  for (const k of Object.keys(expected.header)) {
    expect(Bun.deepEquals(actual.header[k], expected.header[k], true)).toBe(true);
  }
  const a = Object.entries(actual.files);
  const e = Object.entries(expected.files);
  expect(a.map(([k]) => k)).toEqual(e.map(([k]) => k));
  for (let i = 0; i < e.length; i++) {
    expect(sameJsonValue(a[i][1], e[i][1])).toBe(true);
  }
}

/** Deep equality that distinguishes -0 and treats own `__proto__` as data. */
function sameJsonValue(a: unknown, b: unknown): boolean {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return Object.is(a, b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.every((k) => sameJsonValue(ra[k], rb[k]));
}

function scanText(text: string): Verdict {
  const v = new BuildAll();
  return verdictOf(scanManifestText(text, v), v);
}

/** Feed the scanner the text in pieces cut at the given character offsets. */
function scanTextPieces(text: string, cuts: number[]): Verdict {
  const v = new BuildAll();
  const scanner = new ManifestScanner(v);
  let at = 0;
  try {
    for (const cut of [...cuts, text.length]) {
      scanner.write(text.slice(at, cut));
      at = cut;
    }
    scanner.end();
  } catch (err) {
    if ((err as Error).name === "ManifestSyntaxError") return { kind: "malformed" };
    throw err;
  }
  return verdictOf(scanner.result(), v);
}

/** A byte stream that hands over `bytes` in chunks of `size` (1 = byte at a time). */
function chunkedStream(bytes: Uint8Array, size: number | number[]): ReadableStream<Uint8Array> {
  const sizes = typeof size === "number" ? null : size;
  let at = 0;
  let turn = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      const n = sizes ? (sizes[turn++ % sizes.length] ?? 1) : (size as number);
      controller.enqueue(bytes.slice(at, at + n));
      at += n;
    },
  });
}

async function scanBytes(bytes: Uint8Array, size: number | number[]): Promise<Verdict> {
  const v = new BuildAll();
  return verdictOf(await scanManifestStream(chunkedStream(bytes, size), v), v);
}

/** The reference for BYTES: decode the way Response.text() does, then parse. */
async function referenceBytes(bytes: Uint8Array): Promise<Verdict> {
  return referenceVerdict(await new Response(bytes).text());
}

const manifest = (files: string, extra = "") =>
  `{"dataset_id":"nm000001","version":"1.0.0","doi":null,"concept_doi":null,"created":"2026-01-01T00:00:00Z"${extra},"files":${files}}`;

/**
 * Documents that stress the grammar. Each is judged against JSON.parse, so a
 * case here asserts nothing on its own account; the list only has to be wide.
 */
const CORPUS: Record<string, string> = {
  "empty files": manifest("{}"),
  "escaped quote and backslash in a path": manifest(
    String.raw`{"a\"b/c\\d.tsv":{"key":"git:1","size":1,"checksum":"git:1"}}`,
  ),
  "escaped slash and every short escape": manifest(
    String.raw`{"x\/y\b\f\n\r\t":{"key":"k","size":2,"checksum":"c"}}`,
  ),
  "unicode escapes, a surrogate pair and a lone surrogate": manifest(
    String.raw`{"café/😀/\uD800.txt":{"key":"kA","size":3,"checksum":"c"}}`,
  ),
  "raw multi-byte characters": manifest(
    '{"é/漢字/😀.tsv":{"key":"k","size":4,"checksum":"c"}," line":{"key":"k","size":5,"checksum":"c"}}',
  ),
  "numbers of every form": manifest(
    '{"a":{"size":0},"b":{"size":-0},"c":{"size":1.5e3},"d":{"size":-12.25E-2},"e":{"size":1e400},"f":{"size":123456789012345678901234567890},"g":{"size":0.1},"h":{"size":1E+2}}',
  ),
  "literals and nested values in an entry": manifest(
    '{"a":{"x":[true,false,null,[],{}],"y":{"z":[1,[2,[3]]]}}}',
  ),
  "duplicate entry keys keep the first position and the last value": manifest(
    '{"b":{"size":1},"a":{"size":2},"b":{"size":3}}',
  ),
  "__proto__ as a path and as a member": manifest(
    '{"__proto__":{"__proto__":{"size":1},"size":2},"x/__proto__":{"size":3}}',
  ),
  "array-index paths enumerate first": manifest(
    '{"b":{"size":1},"10":{"size":2},"2":{"size":3},"01":{"size":4},"4294967295":{"size":5},"4294967294":{"size":6}}',
  ),
  "files as an array": manifest('[{"size":1},{"size":2},null]'),
  "two files members: the last one wins": `{"files":{"a":{"size":1}},"version":"1","files":{"b":{"size":2}}}`,
  "two files members: the last is not an object": `{"files":{"a":{"size":1}},"files":5}`,
  "files first, header after it": `{"files":{"a":{"size":1}},"created":"late","version":{"n":[1]}}`,
  "a large unrelated top-level member is skipped": manifest(
    '{"a":{"size":1}}',
    `,"extra":{"deep":[${'{"x":[1,2,"three"]},'.repeat(200)}null]}`,
  ),
  "whitespace of all four kinds": ` \t\n\r{ "files" : { "a" : { "size" : 1 } } , "version" : "2" }\r\n\t `,
  "no files member": '{"version":"1.0.0"}',
  "files is null": '{"files":null}',
  "files is a string": '{"files":"x"}',
  "top level is an array": '[{"files":{}}]',
  "top level is a number": "42",
  "top level is null": "null",
  "top level is a string": '"files"',
  // Malformed, each in a different place.
  "empty document": "",
  "whitespace only": "  \n",
  "trailing garbage after the value": `${manifest("{}")} x`,
  "two top-level values": `${manifest("{}")}{}`,
  "truncated inside the files object": manifest('{"a":{"size":1}}').slice(0, -3),
  "truncated after the last entry, before the closing braces": `{"files":{"a":{"size":1}}`,
  "leading zero": manifest('{"a":{"size":01}}'),
  "bare minus": manifest('{"a":{"size":-}}'),
  "trailing dot": manifest('{"a":{"size":1.}}'),
  "leading dot": manifest('{"a":{"size":.5}}'),
  "empty exponent": manifest('{"a":{"size":1e}}'),
  "signed exponent without digits": manifest('{"a":{"size":1e+}}'),
  "leading plus": manifest('{"a":{"size":+1}}'),
  "bad literal": manifest('{"a":{"ok":tru}}'),
  "capitalized literal": manifest('{"a":{"ok":True}}'),
  "raw control character in a string": manifest('{"a\u0001":{"size":1}}'),
  "raw tab in a string": manifest('{"a\tb":{"size":1}}'),
  "bad escape": manifest(String.raw`{"a\x":{"size":1}}`),
  "short unicode escape": manifest(String.raw`{"a\u12":{"size":1}}`),
  "non-hex unicode escape": manifest(String.raw`{"a\u12g4":{"size":1}}`),
  "trailing comma in an object": manifest('{"a":{"size":1},}'),
  "trailing comma in an array": manifest('{"a":{"x":[1,]}}'),
  "missing colon": manifest('{"a" {"size":1}}'),
  "missing comma": manifest('{"a":{"size":1} "b":{"size":2}}'),
  "unquoted key": manifest("{a:{}}"),
  "single-quoted string": manifest("{'a':{}}"),
  comment: manifest('{/* no */"a":{}}'),
  "mismatched brackets": manifest('{"a":{"x":[1}}'),
  "non-breaking space as whitespace": ` ${manifest("{}")}`,
  "form feed as whitespace": `\f${manifest("{}")}`,
  "byte-order mark in the text": `﻿${manifest("{}")}`,
};

describe("scanManifestText matches JSON.parse", () => {
  for (const [label, text] of Object.entries(CORPUS)) {
    test(label, () => {
      expectSameVerdict(scanText(text), referenceVerdict(text), label);
    });
  }

  test("the corpus reaches every verdict", () => {
    const kinds = new Set(Object.values(CORPUS).map((t) => referenceVerdict(t).kind));
    expect([...kinds].sort()).toEqual(["malformed", "no_files", "ok"]);
  });

  test("the real nm000132 manifest scans to what JSON.parse builds", () => {
    const text = FIXTURE.toString("utf8");
    const verdict = scanText(text);
    expectSameVerdict(verdict, referenceVerdict(text), "nm000132");
    if (verdict.kind !== "ok") throw new Error("unreachable");
    expect(Object.keys(verdict.files)).toHaveLength(1462);
  });
});

describe("chunk boundaries", () => {
  // Every document in the corpus, cut at EVERY character offset into two
  // pieces. That puts a boundary inside every string, every escape, every
  // \u sequence, every number and every literal the corpus contains.
  test("every two-piece split of every corpus document", () => {
    for (const [label, text] of Object.entries(CORPUS)) {
      const expected = referenceVerdict(text);
      for (let cut = 1; cut < text.length; cut++) {
        expectSameVerdict(scanTextPieces(text, [cut]), expected, `${label} @${cut}`);
      }
    }
  });

  test("one character at a time", () => {
    for (const [label, text] of Object.entries(CORPUS)) {
      const cuts = Array.from({ length: Math.max(0, text.length - 1) }, (_, i) => i + 1);
      expectSameVerdict(scanTextPieces(text, cuts), referenceVerdict(text), label);
    }
  });

  // Bytes, not characters: a chunk boundary can fall INSIDE a multi-byte
  // UTF-8 sequence, which only the streaming decoder can put back together.
  test("one byte at a time through the stream, multi-byte characters included", async () => {
    for (const [label, text] of Object.entries(CORPUS)) {
      const bytes = new TextEncoder().encode(text);
      expectSameVerdict(await scanBytes(bytes, 1), await referenceBytes(bytes), label);
    }
  });

  test("a 4-byte character split at each of its three inner boundaries", async () => {
    const text = manifest('{"😀/x.tsv":{"key":"k","size":1,"checksum":"c"}}');
    const bytes = new TextEncoder().encode(text);
    const start = bytes.indexOf(0xf0);
    expect(start).toBeGreaterThan(0);
    for (const inner of [1, 2, 3]) {
      const verdict = await scanBytes(bytes, [start + inner, bytes.length]);
      expectSameVerdict(verdict, await referenceBytes(bytes), `inner ${inner}`);
      if (verdict.kind !== "ok") throw new Error("unreachable");
      expect(Object.keys(verdict.files)).toEqual(["😀/x.tsv"]);
    }
  });

  test("the real manifest in odd-sized chunks", async () => {
    const expected = await referenceBytes(FIXTURE);
    for (const sizes of [[7], [1, 2, 3, 5, 8, 13], [4096], [65536]]) {
      expectSameVerdict(await scanBytes(new Uint8Array(FIXTURE), sizes), expected, sizes.join(","));
    }
  });
});

describe("decoding matches Response.text()", () => {
  test("a leading byte-order mark is stripped from the bytes", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(manifest("{}"))]);
    const verdict = await scanBytes(bytes, 1);
    expect(verdict.kind).toBe("ok");
    expectSameVerdict(verdict, await referenceBytes(bytes), "bom");
  });

  test("invalid UTF-8 in a path becomes U+FFFD, as text() makes it", async () => {
    const [head, tail] = manifest('{"aXb":{"size":1}}').split("X");
    const enc = new TextEncoder();
    const bytes = new Uint8Array([...enc.encode(head), 0xff, 0xc3, ...enc.encode(tail)]);
    const verdict = await scanBytes(bytes, 1);
    expectSameVerdict(verdict, await referenceBytes(bytes), "invalid utf-8");
    if (verdict.kind !== "ok") throw new Error("unreachable");
    expect(Object.keys(verdict.files)).toEqual(["a��b"]);
  });

  test("an incomplete sequence at the very end is replaced, then judged", async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode(manifest("{}")), 0xe6, 0xbc]);
    expectSameVerdict(await scanBytes(bytes, 1), await referenceBytes(bytes), "tail");
  });
});

describe("what a scan keeps and when it decides", () => {
  test("a skipped entry is never built, and the visitor still sees its key", () => {
    const built: string[] = [];
    const seen: string[] = [];
    const visitor: FilesVisitor = {
      reset() {},
      key(path) {
        seen.push(path);
        return path === "b";
      },
      value(path) {
        built.push(path);
      },
    };
    const result = scanManifestText(
      manifest('{"a":{"size":1},"b":{"size":2},"c":{"size":3}}'),
      visitor,
    );
    expect(result.kind).toBe("ok");
    expect(seen).toEqual(["a", "b", "c"]);
    expect(built).toEqual(["b"]);
  });

  test("a document broken AFTER the wanted entry is malformed, not a partial answer", () => {
    const visitor = new BuildAll();
    const text = `${manifest('{"a":{"size":1},"b":{"size":2}}').slice(0, -2)}]}`;
    const result = scanManifestText(text, visitor);
    // The entry was seen and built...
    expect(Object.keys(visitor.files)).toEqual(["a", "b"]);
    // ...and still does not count, because the document is not JSON.
    expect(result.kind).toBe("malformed");
  });

  test("a second files member resets the visitor", () => {
    const visitor = new BuildAll();
    scanManifestText('{"files":{"a":{}},"files":{"b":{}}}', visitor);
    expect(visitor.resets).toBe(2);
    expect(Object.keys(visitor.files)).toEqual(["b"]);
  });

  test("the header keeps the five fields and nothing else", () => {
    const result = scanManifestText(manifest("{}", ',"extra":"dropped"'), new BuildAll());
    if (result.kind !== "ok") throw new Error("expected ok");
    const header: Partial<ManifestHeader> = result.header;
    expect(Object.keys(header).sort()).toEqual([
      "concept_doi",
      "created",
      "dataset_id",
      "doi",
      "version",
    ]);
  });

  test("a body that fails mid-read is a thrown transport error, not a verdict", async () => {
    const bytes = new TextEncoder().encode(manifest('{"a":{"size":1}}'));
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 20));
        controller.error(new Error("connection reset"));
      },
    });
    await expect(scanManifestStream(failing, new BuildAll())).rejects.toThrow("connection reset");
  });

  test("an early exit cancels the body so the upstream read stops", async () => {
    let cancelled = false;
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode(pulls === 1 ? '{"files":{} x' : "     "));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await scanManifestStream(endless, new BuildAll());
    expect(result.kind).toBe("malformed");
    expect(cancelled).toBe(true);
  });
});

describe("differential fuzz against JSON.parse", () => {
  // Seeded, so a failure is reproducible from the printed document.
  let seed = 1502;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const SCALARS = [
    "0",
    "-0",
    "1.5e3",
    "-12.25E-2",
    "1e400",
    "true",
    "false",
    "null",
    '"x"',
    String.raw`"aé😀\n\"\\/"`,
    '" é漢😀"',
  ] as const;
  const KEYS = ['"a"', '"b"', '"__proto__"', '"1"', '"0"', String.raw`"kA"`] as const;
  const PATHS = ['"a/b"', '"a"', '"a/b/c"', '"__proto__"', '"42"', String.raw`"x\/y"`, '"é/ü"'];

  function value(depth: number): string {
    const r = rnd();
    if (depth > 3 || r < 0.3) return pick(SCALARS);
    const n = Math.floor(rnd() * 4);
    if (r < 0.6) return `[${Array.from({ length: n }, () => value(depth + 1)).join(",")}]`;
    return `{${Array.from({ length: n }, () => `${pick(KEYS)}:${value(depth + 1)}`).join(",")}}`;
  }

  function document(): string {
    const members = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => {
      const key = pick(['"dataset_id"', '"version"', '"files"', '"files"', '"created"', '"x"']);
      if (key === '"files"' && rnd() < 0.8) {
        const entries = Array.from({ length: Math.floor(rnd() * 5) }, () => [
          pick(PATHS),
          value(1),
        ]);
        return rnd() < 0.15
          ? `${key}:[${entries.map(([, v]) => v).join(",")}]`
          : `${key}:{${entries.map(([k, v]) => `${k}:${v}`).join(",")}}`;
      }
      return `${key}:${value(1)}`;
    });
    let doc = rnd() < 0.1 ? value(0) : `{${members.join(pick([",", ", ", ",\n  "]))}}`;
    if (rnd() < 0.3) {
      const at = Math.floor(rnd() * doc.length);
      const op = rnd();
      if (op < 0.33) doc = doc.slice(0, at) + doc.slice(at + 1);
      else if (op < 0.66) {
        doc =
          doc.slice(0, at) +
          pick(["{", "}", "]", ",", ":", '"', "0", "-", "\u0001", "\\"]) +
          doc.slice(at);
      } else doc = doc.slice(0, at);
    }
    return doc;
  }

  test("20,000 generated documents, cut at random points", () => {
    let valid = 0;
    for (let t = 0; t < 20000; t++) {
      const doc = document();
      const cuts: number[] = [];
      for (let at = 0; ; ) {
        at += 1 + Math.floor(rnd() * 6);
        if (at >= doc.length || rnd() < 0.2) break;
        cuts.push(at);
      }
      const expected = referenceVerdict(doc);
      if (expected.kind === "ok") valid++;
      expectSameVerdict(scanTextPieces(doc, cuts), expected, JSON.stringify(doc));
    }
    // The generator has to keep producing documents worth comparing.
    expect(valid).toBeGreaterThan(2500);
  });
});
