/**
 * Tests for isContentsApiShaConflict (epic #749, Phase 6 / #755): the pure
 * detector that decides whether a Contents-API update PUT failure is a
 * concurrent stale-SHA conflict (safe to refetch + retry) vs a real error.
 * Pure function, no mocks.
 */

import { describe, expect, test } from "bun:test";
import { isContentsApiShaConflict } from "../src/services/github";

describe("isContentsApiShaConflict", () => {
  test("409 is always a conflict regardless of message (the stale-sha code)", () => {
    expect(isContentsApiShaConflict(409, "")).toBe(true);
    expect(isContentsApiShaConflict(409, '{"message":"is at abc123 but expected def456"}')).toBe(
      true,
    );
  });

  test("422 with a sha / does-not-match / fast-forward message is a conflict", () => {
    expect(
      isContentsApiShaConflict(422, '{"message":"sha does not match for .nemar/metadata.json"}'),
    ).toBe(true);
    expect(isContentsApiShaConflict(422, '{"message":"Update is not a fast forward"}')).toBe(true);
  });

  test("422 message substring fallback when the body is not JSON", () => {
    expect(isContentsApiShaConflict(422, "sha mismatch")).toBe(true);
    expect(isContentsApiShaConflict(422, "totally unrelated 422 text")).toBe(false);
  });

  test("422 for an UNRELATED reason is NOT a conflict (don't retry)", () => {
    expect(isContentsApiShaConflict(422, '{"message":"committer email must be verified"}')).toBe(
      false,
    );
    expect(isContentsApiShaConflict(422, '{"message":"branch protection rule violated"}')).toBe(
      false,
    );
  });

  test("non-conflict statuses are never retried", () => {
    for (const status of [200, 201, 404, 401, 403, 500]) {
      expect(isContentsApiShaConflict(status, '{"message":"sha does not match"}')).toBe(false);
    }
  });
});
