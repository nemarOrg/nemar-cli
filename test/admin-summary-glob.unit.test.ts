/**
 * Unit tests for the `--match <glob>` filter on `nemar admin summary check`.
 *
 * `globToRegExp` is the only branchy piece — the dispatch loop is exercised
 * by integration. Pin the glob semantics so a future "let me use regex
 * directly" or "let me support brace expansion" refactor can't silently
 * change matching behavior under operators' feet.
 */

import { describe, expect, test } from "bun:test";
import { globToRegExp } from "../src/commands/admin";

function match(glob: string, id: string): boolean {
  return globToRegExp(glob).test(id);
}

describe("globToRegExp", () => {
  test("`*` matches a run of any chars", () => {
    expect(match("on*", "on007315")).toBe(true);
    expect(match("on*", "on002778")).toBe(true);
    expect(match("on*", "nm000103")).toBe(false);
  });

  test("`*` matches the empty string too (zero or more)", () => {
    // `nm*` should accept the literal "nm" (degenerate, but consistent).
    expect(match("nm*", "nm")).toBe(true);
    expect(match("nm*", "nm000103")).toBe(true);
  });

  test("`?` matches exactly one char", () => {
    expect(match("nm00010?", "nm000103")).toBe(true);
    expect(match("nm00010?", "nm000109")).toBe(true);
    expect(match("nm00010?", "nm000110")).toBe(false); // 2 chars where ? expects 1
    expect(match("nm00010?", "nm00010")).toBe(false); // 0 chars where ? expects 1
  });

  test("anchored: matches the whole string, not a prefix or substring", () => {
    // `on` (no `*`) is a literal exact match, NOT a prefix.
    expect(match("on", "on")).toBe(true);
    expect(match("on", "on007315")).toBe(false);
    // `*99999` matches only ids ending in 99999, not containing it mid-string.
    expect(match("*99999", "nm099999")).toBe(true);
    expect(match("*99999", "nm099999v1")).toBe(false);
  });

  test("literal `.` is escaped, not treated as `any char`", () => {
    // If `.` were unescaped, "on7315" would match "on.315". Pin that it doesn't.
    expect(match("on.315", "on7315")).toBe(false);
    expect(match("on.315", "on.315")).toBe(true);
  });

  test("other regex metacharacters are escaped", () => {
    // Pins that `(`, `)`, `+`, `^`, `$`, `|` etc. are treated as literals.
    // None of these should be valid in a real dataset id, but the helper
    // shouldn't crash or misbehave if an operator typos one in.
    expect(() => globToRegExp("on(007)")).not.toThrow();
    expect(match("on(007)", "on(007)")).toBe(true);
    expect(match("on(007)", "on007")).toBe(false);
  });

  test("a glob with no metacharacters is a literal exact match", () => {
    expect(match("nm099999", "nm099999")).toBe(true);
    expect(match("nm099999", "nm099998")).toBe(false);
  });

  test("`*` in the middle still matches arbitrary chars", () => {
    expect(match("nm*999", "nm099999")).toBe(true);
    expect(match("nm*999", "nm111999")).toBe(true);
    expect(match("nm*999", "nm999")).toBe(true); // `*` matches empty here too
  });
});
