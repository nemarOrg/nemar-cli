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
import { executeDatasetSearch } from "../backend/src/services/dataset-search";
import { freshDb, realD1 } from "../backend/test/helpers/d1";

/** Minimal public/active row the search tiers will hydrate. */
function insertSearchRow(db: ReturnType<typeof freshDb>, id: string, name: string): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox)
     VALUES (?, ?, -1, 'active', 'public', 0)`,
    [id, name],
  );
}

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

// #1174 test review. D6 changed the route's default to 0.60 and left a
// SECOND hardcoded 0.65 in executeDatasetSearch's own fallback, which its
// doc advertises as "safely reusable directly". So an HTTP request got 0.60
// while a direct call silently got 0.65, and every test in the repo passed.
//
// The constant now lives in the service and the route re-exports it. This is
// a structural pin in the shape this repo already uses for the ADR index and
// the route inventory: it reads the production source and fails if a numeric
// min-score default reappears anywhere but the single definition.
describe("the min-score default exists exactly once (#1174 review)", () => {
  const FILES = [
    "../backend/src/services/dataset-search.ts",
    "../backend/src/routes/datasets/catalog.ts",
  ];

  test("no file hardcodes a min-score fallback literal", async () => {
    const offenders: string[] = [];
    for (const rel of FILES) {
      const src = await Bun.file(new URL(rel, import.meta.url)).text();
      src.split("\n").forEach((line, i) => {
        const code = line.trim();
        // Comments legitimately cite 0.65 as the PRIOR default in the
        // measurement table, so only executable lines are considered.
        if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) return;
        // The one permitted numeric assignment is the definition itself.
        if (code.startsWith("export const DEFAULT_MIN_SCORE")) return;
        if (/minScore[^\n]*[:?]\s*0\.\d+/.test(code) || /:\s*0\.6[05]\b/.test(code)) {
          offenders.push(`${rel}:${i + 1}: ${code}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test("both consumers reference the shared constant by name", async () => {
    const service = await Bun.file(
      new URL("../backend/src/services/dataset-search.ts", import.meta.url),
    ).text();
    const route = await Bun.file(
      new URL("../backend/src/routes/datasets/catalog.ts", import.meta.url),
    ).text();
    // executeDatasetSearch's own fallback, and parseMinScore's.
    expect(service).toContain("DEFAULT_MIN_SCORE");
    expect(route).toContain("DEFAULT_MIN_SCORE");
    expect(DEFAULT_MIN_SCORE).toBe(0.6);
  });
});

// #1177 cross-phase review. Until now only the CONSTANT was pinned: mutating
// DEFAULT_MIN_SCORE from 0.6 to 0.95 failed exactly two tests, both of which
// just re-read the literal. The behaviour it governs -- executeDatasetSearch
// dropping semantic rows below the floor -- had no coverage anywhere, because
// every direct caller in the suite passes an explicit minScore and the route
// tests run without AI/Vectorize bindings so they never reach the semantic
// tier. A drift would have silently changed production relevance.
//
// The AI and Vectorize bindings here are boundary fixtures, not mocks of
// business logic: they stand in for two external services at the network
// edge, the same category as the D1 fault injection used elsewhere and the
// HTTP fixtures .rules/testing.md explicitly permits. The filtering under
// test is the real `executeDatasetSearch`, against a real bun:sqlite.
describe("DEFAULT_MIN_SCORE is applied, not merely declared (#1177 review)", () => {
  function bindings(scores: Record<string, number>) {
    const ai = {
      run: async () => ({ data: [[0.1, 0.2, 0.3]] }),
    } as unknown as Ai;
    const vectorize = {
      query: async () => ({
        matches: Object.entries(scores).map(([id, score]) => ({ id, score })),
      }),
    } as unknown as VectorizeIndex;
    return { ai, vectorize };
  }

  test("a row scoring below the default floor is dropped when minScore is omitted", async () => {
    const db = freshDb();
    insertSearchRow(db, "nm960001", "Alpha Recording Collection");
    insertSearchRow(db, "nm960002", "Beta Recording Collection");
    const { ai, vectorize } = bindings({ nm960001: 0.9, nm960002: 0.3 });

    // minScore deliberately OMITTED, so the default is what decides.
    const envelope = await executeDatasetSearch(realD1(db), ai, vectorize, {
      query: "zzqqxx",
      filters: {},
      limit: 20,
      offset: 0,
    } as Parameters<typeof executeDatasetSearch>[3]);

    expect(envelope.min_score).toBe(DEFAULT_MIN_SCORE);
    const ids = envelope.results.map((r) => r.id);
    expect(ids).toContain("nm960001");
    // 0.3 is below 0.6. If the constant drifted upward, or the filter stopped
    // being applied, this is the assertion that notices.
    expect(ids).not.toContain("nm960002");
  });

  test("the same row survives when the floor is explicitly lowered", async () => {
    // Positive control: proves the exclusion above is the FLOOR doing work,
    // not the fixture simply failing to return the row.
    const db = freshDb();
    insertSearchRow(db, "nm960001", "Alpha Recording Collection");
    insertSearchRow(db, "nm960002", "Beta Recording Collection");
    const { ai, vectorize } = bindings({ nm960001: 0.9, nm960002: 0.3 });

    const envelope = await executeDatasetSearch(realD1(db), ai, vectorize, {
      query: "zzqqxx",
      filters: {},
      limit: 20,
      offset: 0,
      minScore: 0.1,
    });

    expect(envelope.results.map((r) => r.id)).toContain("nm960002");
  });
});
