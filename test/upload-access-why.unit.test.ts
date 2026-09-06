/**
 * The CLI prompt's check on the upload-request why text (ADR 0042, #1253).
 *
 * Extracted from the inquirer `validate` callback so it can be exercised at
 * all: a validator that only exists as an inline arrow inside a prompt
 * definition is unreachable from a subprocess CLI test, which runs with stdin
 * ignored and never opens the prompt.
 *
 * What makes it worth testing is the relationship it has to the SERVER's rule
 * (backend/src/services/upload-access.ts): the prompt exists to stop a user
 * typing something the route will refuse, so a prompt that is laxer than the
 * route is worse than no prompt at all. Both read the bounds from
 * shared/contract, and the boundary cases below are the same ones the route
 * test pins.
 *
 * Real function, no mocks.
 */

import { describe, expect, test } from "bun:test";
import {
  UPLOAD_ACCESS_WHY_MAX_CHARS,
  UPLOAD_ACCESS_WHY_MIN_CHARS,
} from "../shared/contract/user.js";
import { validateUploadAccessWhy } from "../src/commands/auth.js";

describe("validateUploadAccessWhy", () => {
  test("the bounds are the contract's, not a local copy", () => {
    // A hand-typed 20 here (or there) is how a prompt starts accepting what the
    // route refuses.
    expect(UPLOAD_ACCESS_WHY_MIN_CHARS).toBe(20);
    expect(UPLOAD_ACCESS_WHY_MAX_CHARS).toBe(500);
  });

  test("rejects one character under the minimum and accepts the minimum", () => {
    expect(validateUploadAccessWhy("x".repeat(UPLOAD_ACCESS_WHY_MIN_CHARS - 1))).toBe(
      `Please write at least ${UPLOAD_ACCESS_WHY_MIN_CHARS} characters`,
    );
    expect(validateUploadAccessWhy("x".repeat(UPLOAD_ACCESS_WHY_MIN_CHARS))).toBe(true);
  });

  test("accepts the maximum and rejects one character over", () => {
    expect(validateUploadAccessWhy("x".repeat(UPLOAD_ACCESS_WHY_MAX_CHARS))).toBe(true);
    expect(validateUploadAccessWhy("x".repeat(UPLOAD_ACCESS_WHY_MAX_CHARS + 1))).toBe(
      `Please keep it under ${UPLOAD_ACCESS_WHY_MAX_CHARS} characters`,
    );
  });

  test("measures the TRIMMED text, as the route does", () => {
    // Otherwise 20 spaces plus a word passes here and is refused there.
    const padded = `   ${"x".repeat(UPLOAD_ACCESS_WHY_MIN_CHARS - 1)}   `;
    expect(padded.length).toBeGreaterThan(UPLOAD_ACCESS_WHY_MIN_CHARS);
    expect(validateUploadAccessWhy(padded)).toContain("at least");
  });

  test("an empty or absent answer is refused, not treated as valid", () => {
    expect(validateUploadAccessWhy("")).toContain("at least");
    expect(validateUploadAccessWhy(undefined)).toContain("at least");
  });
});
