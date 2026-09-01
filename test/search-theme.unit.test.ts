/**
 * `src/lib/theme.ts` -- D5 (a named semantic palette) and D7 (presentation
 * must never fail a command: if resolving a colour throws, fall back to
 * plain text) of epic #1144 phase 6 / issue #1150.
 *
 * `safe()` is exported specifically so this can drive a deliberately-
 * throwing colour function directly, without needing to reach into chalk's
 * internals to make a *real* chalk function throw -- every `theme.*` export
 * is built from exactly this one wrapper, so testing it once covers all six.
 */

import { describe, expect, test } from "bun:test";
import { safe, theme } from "../src/lib/theme";

describe("theme (#1150 D5)", () => {
  test("all six semantic roles are present and callable", () => {
    for (const key of ["id", "metric", "label", "warn", "muted", "match"] as const) {
      expect(typeof theme[key]).toBe("function");
      expect(() => theme[key]("x")).not.toThrow();
    }
  });

  test("each role returns text that still contains the original content", () => {
    for (const key of ["id", "metric", "label", "warn", "muted", "match"] as const) {
      expect(theme[key]("marker-text")).toContain("marker-text");
    }
  });
});

describe("safe() (#1150 D7: presentation must never fail a command)", () => {
  test("a colour function that throws falls back to the plain, uncoloured text", () => {
    const throwing = (_text: string): string => {
      throw new Error("simulated colour-resolution failure");
    };
    const wrapped = safe(throwing);
    expect(() => wrapped("hello")).not.toThrow();
    expect(wrapped("hello")).toBe("hello");
  });

  test("a colour function that behaves normally is unaffected by the wrapper", () => {
    const wrapped = safe((text: string) => `[[${text}]]`);
    expect(wrapped("hello")).toBe("[[hello]]");
  });
});
