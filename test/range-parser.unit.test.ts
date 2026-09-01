/**
 * shared/range.ts -- the range-filter grammar shared by the CLI and backend
 * (epic #1144 phase 3, #1147). Pure function, no DB: every valid form, and
 * every rejection with its distinct reason, per the plan's D3/verification
 * case 1.
 *
 * The trap this file guards against: `Number.parseFloat("100xyz")` returns
 * `100` and `Number("")` returns `0`. Every test below is chosen so that
 * accidentally reintroducing either of those functions in place of the
 * anchored grammar would flip at least one assertion.
 */

import { describe, expect, test } from "bun:test";
import { RangeParseError, parseRange } from "../shared/range";

describe("parseRange: valid forms", () => {
  test("a..b is an inclusive between", () => {
    expect(parseRange("10..50", "number")).toEqual({ min: 10, max: 50 });
  });

  test("a.. is at least a (open-ended above)", () => {
    expect(parseRange("10..", "number")).toEqual({ min: 10, max: null });
  });

  test("..b is at most b (open-ended below)", () => {
    expect(parseRange("..50", "number")).toEqual({ min: null, max: 50 });
  });

  test("bare a is exact (both bounds equal)", () => {
    expect(parseRange("42", "number")).toEqual({ min: 42, max: 42 });
  });

  test("decimals are accepted (age_min holds 26.25 in production)", () => {
    expect(parseRange("26.25", "number")).toEqual({ min: 26.25, max: 26.25 });
    expect(parseRange("12.5..25", "number")).toEqual({ min: 12.5, max: 25 });
  });

  test("surrounding whitespace on each side is trimmed", () => {
    expect(parseRange(" 10 .. 50 ", "number")).toEqual({ min: 10, max: 50 });
  });

  test("empty side is unbounded (null), never zero (the Number('') trap)", () => {
    const lo = parseRange("..50", "number");
    expect(lo.min).toBeNull();
    expect(lo.min).not.toBe(0);
    const hi = parseRange("50..", "number");
    expect(hi.max).toBeNull();
    expect(hi.max).not.toBe(0);
  });

  test("zero is a valid explicit bound, distinct from unbounded", () => {
    expect(parseRange("0..10", "number")).toEqual({ min: 0, max: 10 });
    expect(parseRange("0", "number")).toEqual({ min: 0, max: 0 });
  });
});

describe("parseRange: bytes units (1024-based, bare = bytes)", () => {
  test("bare number is bytes", () => {
    expect(parseRange("100", "bytes")).toEqual({ min: 100, max: 100 });
  });

  test("B/KB/MB/GB/TB multipliers", () => {
    expect(parseRange("100B", "bytes")).toEqual({ min: 100, max: 100 });
    expect(parseRange("1KB", "bytes")).toEqual({ min: 1024, max: 1024 });
    expect(parseRange("1MB", "bytes")).toEqual({ min: 1024 ** 2, max: 1024 ** 2 });
    expect(parseRange("1GB", "bytes")).toEqual({ min: 1024 ** 3, max: 1024 ** 3 });
    expect(parseRange("1.5TB", "bytes")).toEqual({
      min: 1.5 * 1024 ** 4,
      max: 1.5 * 1024 ** 4,
    });
  });

  test("units are case-insensitive", () => {
    expect(parseRange("1tb", "bytes")).toEqual({ min: 1024 ** 4, max: 1024 ** 4 });
    expect(parseRange("1Tb", "bytes")).toEqual({ min: 1024 ** 4, max: 1024 ** 4 });
  });

  test("a duration unit is unknown for a bytes facet", () => {
    expect(() => parseRange("5s", "bytes")).toThrow(RangeParseError);
    try {
      parseRange("5s", "bytes");
      throw new Error("expected parseRange to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RangeParseError);
      expect((err as RangeParseError).reason).toBe("unknown-unit");
    }
  });
});

describe("parseRange: duration units (bare = seconds)", () => {
  test("bare number is seconds", () => {
    expect(parseRange("45", "duration")).toEqual({ min: 45, max: 45 });
  });

  test("s/m/h/d multipliers", () => {
    expect(parseRange("30s", "duration")).toEqual({ min: 30, max: 30 });
    expect(parseRange("2m", "duration")).toEqual({ min: 120, max: 120 });
    expect(parseRange("1h", "duration")).toEqual({ min: 3600, max: 3600 });
    expect(parseRange("1d", "duration")).toEqual({ min: 86400, max: 86400 });
  });

  test("a bytes unit is unknown for a duration facet", () => {
    try {
      parseRange("5MB", "duration");
      throw new Error("expected parseRange to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RangeParseError);
      expect((err as RangeParseError).reason).toBe("unknown-unit");
    }
  });
});

describe("parseRange: rejections, each with its own reason", () => {
  function reasonOf(raw: string, kind: "number" | "bytes" | "duration" = "number"): string {
    try {
      parseRange(raw, kind);
      throw new Error(`expected parseRange(${JSON.stringify(raw)}) to throw`);
    } catch (err) {
      if (!(err instanceof RangeParseError)) throw err;
      return err.reason;
    }
  }

  test("100xyz: a unit on a plain-number facet is rejected, not silently 100", () => {
    // The exact trap: Number.parseFloat("100xyz") === 100. Never must this
    // parse as anything but a rejection.
    expect(reasonOf("100xyz")).toBe("unit-not-allowed");
  });

  test("1..2..3: more than one '..' separator is rejected, not truncated", () => {
    expect(reasonOf("1..2..3")).toBe("malformed");
  });

  test("bare '..' (both sides empty) is rejected, not 'unbounded both ways'", () => {
    expect(reasonOf("..")).toBe("malformed");
  });

  test("300..100 is rejected as inverted", () => {
    expect(reasonOf("300..100")).toBe("inverted");
  });

  test("-5..10 is rejected as negative, not non-numeric", () => {
    expect(reasonOf("-5..10")).toBe("negative");
  });

  test("a bare negative value is rejected as negative", () => {
    expect(reasonOf("-5")).toBe("negative");
  });

  test("Infinity is rejected as non-numeric (never Number('Infinity') === Infinity)", () => {
    expect(reasonOf("Infinity")).toBe("non-numeric");
  });

  test("1e3 is rejected, never silently parsed as 1000", () => {
    // The other half of the Number.parseFloat trap: parseFloat("1e3") === 1000.
    expect(reasonOf("1e3")).toBe("non-numeric");
  });

  test("a value so large it overflows to Infinity is rejected as non-finite", () => {
    // Passes the anchored digit grammar (it IS all digits), so this is the
    // one case that reaches the Number.isFinite() check rather than failing
    // the regex outright.
    expect(reasonOf(`1${"0".repeat(400)}`)).toBe("non-finite");
  });

  test("garbage text is rejected as non-numeric", () => {
    expect(reasonOf("abc")).toBe("non-numeric");
  });

  test("an unrecognized unit on a bytes/duration facet is rejected as unknown-unit", () => {
    expect(reasonOf("5XB", "bytes")).toBe("unknown-unit");
    expect(reasonOf("5w", "duration")).toBe("unknown-unit");
  });
});
