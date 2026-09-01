/**
 * `GET /datasets/search`'s relevance floor (epic #1144 phase 6, issue #1150,
 * D6): `DEFAULT_MIN_SCORE` moved from 0.65 to 0.60. Measured across 12
 * representative queries at six thresholds (see the constant's own doc
 * comment in `backend/src/routes/datasets/catalog.ts` for the full table):
 * 0.65 silently dropped the semantic tier for 4 of 12 single-word queries
 * (`sleep`, `motor`, `seizure`, `infant`), falling back to `text_fallback`
 * with no signal to the caller that semantic matching was even attempted.
 * 0.60 is the highest threshold at which nothing in the measured set
 * degrades.
 *
 * This pins the constant directly (not a re-implementation of it) and
 * exercises `parseMinScore`, the real function the route handler calls --
 * not a copy of its arithmetic (testing.md's "test the entry point, not the
 * piece": the route handler itself is a thin `c.req.query()` wrapper this
 * repo has no Miniflare harness for, same boundary `search-retrieval.test.ts`
 * already documents for `parseFilterQuery`/`parseSearchPagination`).
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_MIN_SCORE, parseMinScore } from "../backend/src/routes/datasets/catalog";

describe("DEFAULT_MIN_SCORE (#1150 D6)", () => {
  test("is pinned at 0.60, not the prior 0.65 -- a silent revert must fail this test", () => {
    expect(DEFAULT_MIN_SCORE).toBe(0.6);
  });
});

describe("parseMinScore", () => {
  test("with no min_score query param, defaults to DEFAULT_MIN_SCORE", () => {
    const ctx = { req: { query: () => undefined } };
    expect(parseMinScore(ctx)).toBe(DEFAULT_MIN_SCORE);
  });

  test("an explicit ?min_score=0 overrides the default (inspecting the long tail)", () => {
    const ctx = { req: { query: (name: string) => (name === "min_score" ? "0" : undefined) } };
    expect(parseMinScore(ctx)).toBe(0);
  });

  test("an explicit ?min_score=0.9 is honoured, not clamped to the default", () => {
    const ctx = { req: { query: (name: string) => (name === "min_score" ? "0.9" : undefined) } };
    expect(parseMinScore(ctx)).toBe(0.9);
  });

  test("clamps a value above 1 down to 1", () => {
    const ctx = { req: { query: (name: string) => (name === "min_score" ? "5" : undefined) } };
    expect(parseMinScore(ctx)).toBe(1);
  });

  test("clamps a negative value up to 0", () => {
    const ctx = { req: { query: (name: string) => (name === "min_score" ? "-3" : undefined) } };
    expect(parseMinScore(ctx)).toBe(0);
  });

  test("an unparseable value falls back to DEFAULT_MIN_SCORE, not NaN", () => {
    const ctx = {
      req: { query: (name: string) => (name === "min_score" ? "not-a-number" : undefined) },
    };
    expect(parseMinScore(ctx)).toBe(DEFAULT_MIN_SCORE);
  });
});
