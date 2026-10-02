/**
 * The canonical JSON writer (epic #1586, phase 1).
 *
 * Byte stability is the contract: the same value must always write the same
 * bytes, because an unchanged artifact is detected by comparing them.
 */

import { describe, expect, test } from "bun:test";
import { JsonFloat, canonicalJson } from "../shared/neurobagel/canonical-json";

describe("canonicalJson", () => {
  test("sorts keys at every depth and ends in one newline", () => {
    const text = canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } });
    expect(text).toBe(
      `{\n  "a": {\n    "c": null,\n    "d": [\n      3,\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n`,
    );
  });

  test("the same value written with keys in another order gives the same bytes", () => {
    expect(canonicalJson({ x: 1, y: [1, 2], z: { b: 1, a: 2 } })).toBe(
      canonicalJson({ z: { a: 2, b: 1 }, y: [1, 2], x: 1 }),
    );
  });

  test("an integral JsonFloat keeps its decimal point; plain numbers do not gain one", () => {
    expect(canonicalJson({ age: new JsonFloat(20), n: 20 })).toContain('"age": 20.0');
    expect(canonicalJson({ age: new JsonFloat(20), n: 20 })).toContain('"n": 20\n');
    expect(canonicalJson({ age: new JsonFloat(31.5) })).toContain('"age": 31.5');
  });

  test("a float prints so that JSON-LD reads it as a double", () => {
    for (const value of [0, 20, 31.083333333333332, 119.99]) {
      const text = canonicalJson({ age: new JsonFloat(value) });
      expect(text).toMatch(/\d\.\d|e[+-]?\d/);
    }
  });

  test("undefined members are left out and empty containers stay compact", () => {
    expect(canonicalJson({ a: undefined, b: [], c: {} })).toBe(`{\n  "b": [],\n  "c": {}\n}\n`);
  });

  test("a non-finite number is refused rather than written as null", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(RangeError);
    expect(() => new JsonFloat(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  test("control characters and quotes are escaped as JSON requires", () => {
    expect(canonicalJson('a"b\n\t\\')).toBe('"a\\"b\\n\\t\\\\"\n');
  });
});
