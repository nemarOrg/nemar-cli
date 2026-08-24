/**
 * Search retrieval correctness (#1145, epic #1144 phase 1).
 *
 * Real bun:sqlite + the ACTUAL migrations 0031 (FTS5 external-content index)
 * and 0056 (has_hed columns). No mocks (.rules/testing.md); mirrors the
 * harness style of test/data-complete-filter.test.ts and
 * test/has-hed-filter.test.ts.
 *
 * Scope note: this exercises the SQL-layer retrieval functions
 * (ftsSearch, hydrateDatasetsByIds, lookupDatasetById, countSearchMatches,
 * parseSearchPagination) directly rather than the GET /datasets/search HTTP
 * handler. The handler also depends on the AI/Vectorize Worker bindings for
 * its semantic tier, which this repo has no Miniflare/Worker-runtime harness
 * for and which cannot be exercised without faking business logic (the NO
 * MOCKS policy) -- has-hed-filter.test.ts and data-complete-filter.test.ts
 * note the same boundary for the HTTP-layer query-string parse. Every
 * function tested here is real production code the handler calls unmodified;
 * the "text"/"exact_id" methods it exercises are two of the five preserved
 * `method` values (the other three -- "semantic", "text_fallback",
 * "unavailable" -- need the AI/Vectorize bindings or a dropped FTS table).
 *
 * Harness gotcha (0031 is FTS5 external-content, content='datasets',
 * content_rowid='id'): the base schema must declare `datasets` with an
 * integer `id` plus all seven columns migration 0031 populates from
 * (name, description, authors, tasks, modalities, readme) BEFORE the
 * migration applies, and rows must be inserted AFTER so the AFTER INSERT
 * trigger (not the migration's one-time populate, which would see an empty
 * table) fires and keeps the index in sync.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSearchPagination } from "../backend/src/routes/datasets/catalog";
import {
  SEARCH_CANDIDATE_CEILING,
  SEMANTIC_TOPK,
  buildFtsMatch,
  countSearchMatches,
  ftsSearch,
  hydrateDatasetsByIds,
  lookupDatasetById,
} from "../backend/src/services/dataset-search";

const MIG = join(import.meta.dir, "..", "backend/src/db/migrations");
const sql = (f: string) => readFileSync(join(MIG, f), "utf8");

// Base schema: everything 0031's FTS5 populate/triggers and 0056's ALTER
// TABLE need to already exist. Columns beyond that (status/visibility/
// is_sandbox/is_exemplar/source_id/subject_count/concept_doi) are what every
// retrieval function's WHERE clause reads.
const BASE_SCHEMA = `
CREATE TABLE datasets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL UNIQUE,
  source_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  authors TEXT,
  tasks TEXT,
  modalities TEXT,
  readme TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  visibility TEXT NOT NULL DEFAULT 'public',
  is_sandbox INTEGER NOT NULL DEFAULT 0,
  is_exemplar INTEGER NOT NULL DEFAULT 0,
  subject_count INTEGER,
  concept_doi TEXT,
  -- lookupDatasetById orders managed rows (owner != -1, the legacy-catalog
  -- sentinel) ahead of a shadow row on a tie; every seeded row here is a
  -- normal managed row.
  owner_user_id INTEGER NOT NULL DEFAULT 10,
  embedding_dirty INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE dataset_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT, version TEXT, doi TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`;

interface SeedRow {
  dataset_id: string;
  name: string;
  description?: string | null;
  modalities?: string | null;
  has_hed?: number | null;
  source_id?: string | null;
}

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(BASE_SCHEMA);
  db.exec(sql("0031_datasets_fts.sql"));
  db.exec(sql("0056_hed_columns.sql"));
  return db;
}

function insertRow(db: Database, row: SeedRow): void {
  db.query(
    `INSERT INTO datasets (dataset_id, name, description, modalities, has_hed, source_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.dataset_id,
    row.name,
    row.description ?? null,
    row.modalities ?? null,
    row.has_hed ?? null,
    row.source_id ?? null,
  );
}

/** Minimal D1Database shim over bun:sqlite, matching the pattern used by
 *  test/license-tier.test.ts's realD1 -- a real prepared statement underneath,
 *  not a mock of query behavior. */
function realD1(db: Database): D1Database {
  return {
    prepare(q: string) {
      const stmt = db.query(q);
      let bound: unknown[] = [];
      const api = {
        bind(...p: unknown[]) {
          bound = p;
          return api;
        },
        run() {
          const r = stmt.run(...(bound as never[]));
          return Promise.resolve({ success: true, meta: { changes: r.changes } });
        },
        first<T>() {
          return Promise.resolve((stmt.get(...(bound as never[])) as T) ?? null);
        },
        all<T>() {
          return Promise.resolve({ results: stmt.all(...(bound as never[])) as T[] });
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

// --- EEG regression fixture: 30 rows all matched by the FTS query "eeg", ---
// --- split 12/9/9 across has_hed = 1/0/NULL. -------------------------------
const HAS_HED_MATCH_COUNT = 12;
const EEG_ROW_COUNT = 30;

function eegRows(): SeedRow[] {
  return Array.from({ length: EEG_ROW_COUNT }, (_, i) => {
    const n = i + 1;
    const hasHed = n <= 12 ? 1 : n <= 21 ? 0 : null;
    return {
      dataset_id: `nm${String(100000 + n).padStart(6, "0")}`,
      name: `EEG study ${n}`,
      // Vary repetition count per row so bm25 scores are distinct (avoids
      // order ties across repeated identical queries, which would make the
      // paging test's row-for-row comparison flaky).
      description: `An EEG recording dataset. ${"eeg ".repeat((n % 6) + 1)}`,
      modalities: "eeg",
      has_hed: hasHed,
    };
  });
}

function seedEegFixture(db: Database): void {
  for (const row of eegRows()) insertRow(db, row);
}

describe("setup sanity: datasets_fts is actually populated", () => {
  test("a seeded row is found via FTS MATCH (a silently empty index would make every count test pass for the wrong reason)", () => {
    const db = freshDb();
    seedEegFixture(db);
    const match = buildFtsMatch("eeg");
    expect(match).not.toBeNull();
    const rows = db
      .query("SELECT rowid FROM datasets_fts WHERE datasets_fts MATCH ?")
      .all(match as string) as Array<{ rowid: number }>;
    expect(rows.length).toBe(EEG_ROW_COUNT);
    db.close();
  });
});

describe("count is stable across limit (the regression this epic fixes)", () => {
  test("countSearchMatches for q=eeg&has_hed=1 is identical at limit 5/10/20/50/100", async () => {
    const db = freshDb();
    seedEegFixture(db);
    const d1 = realD1(db);
    const match = buildFtsMatch("eeg");

    // Fetch the candidate window ONCE, exactly like the handler does -- the
    // window is fixed (SEARCH_CANDIDATE_CEILING), not derived from `limit`.
    const lexical = await ftsSearch(d1, "eeg", SEARCH_CANDIDATE_CEILING, { hasHed: true });
    // Sanity: the candidate window actually contains every matching row, so
    // it's the fixed ceiling -- not a lucky limit -- making the rest hold.
    expect(lexical.length).toBe(HAS_HED_MATCH_COUNT);

    for (const limitRaw of ["5", "10", "20", "50", "100"]) {
      const { limit, offset } = parseSearchPagination(limitRaw, undefined);
      const count = await countSearchMatches(d1, match, [], { hasHed: true });
      const returned = lexical.slice(offset, offset + limit).length;

      // The fix: `count` (the true total) never moves...
      expect(count).toBe(HAS_HED_MATCH_COUNT);
      // ...while `returned` (the page) tracks `limit`, exactly as the old,
      // buggy code conflated the two (`count: filtered.length` WAS the page
      // size). At limit=5/10 the page is smaller than the true total; from
      // limit=20 on the whole match set fits on one page.
      expect(returned).toBe(Math.min(limit, HAS_HED_MATCH_COUNT));
    }
    db.close();
  });
});

describe("count is exact", () => {
  test("countSearchMatches equals a direct SELECT COUNT(*) over the same predicate", async () => {
    const db = freshDb();
    seedEegFixture(db);
    const d1 = realD1(db);
    const match = buildFtsMatch("eeg");

    const count = await countSearchMatches(d1, match, [], { hasHed: true });

    const direct = db
      .query(
        `SELECT COUNT(*) AS total FROM datasets d
         WHERE d.status = 'active' AND d.visibility = 'public'
           AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR d.is_exemplar = 1)
           AND (d.id IN (SELECT rowid FROM datasets_fts WHERE datasets_fts MATCH ?))
           AND d.has_hed = 1`,
      )
      .get(match as string) as { total: number };

    expect(count).toBe(direct.total);
    expect(count).toBe(HAS_HED_MATCH_COUNT);
    db.close();
  });

  test("countSearchMatches is 0 when both the FTS match and semantic ids are empty", async () => {
    const db = freshDb();
    seedEegFixture(db);
    const d1 = realD1(db);
    // Punctuation-only query -> buildFtsMatch returns null -> no FTS disjunct.
    expect(buildFtsMatch("!!")).toBeNull();
    const count = await countSearchMatches(d1, null, [], {});
    expect(count).toBe(0);
    db.close();
  });
});

describe("paging: page1 + page2 equals one double-width page", () => {
  async function fetchPage(
    db: D1Database,
    query: string,
    limitRaw: string | undefined,
    offsetRaw: string | undefined,
  ) {
    const { limit, offset } = parseSearchPagination(limitRaw, offsetRaw);
    const candidates = await ftsSearch(db, query, SEARCH_CANDIDATE_CEILING, {});
    return candidates.slice(offset, offset + limit).map((r) => r.id);
  }

  test("no duplicates, no gaps, across two half-width pages vs one double-width page", async () => {
    const db = freshDb();
    seedEegFixture(db);
    const d1 = realD1(db);

    const page1 = await fetchPage(d1, "eeg", "10", "0");
    const page2 = await fetchPage(d1, "eeg", "10", "10");
    const doubleWide = await fetchPage(d1, "eeg", "20", "0");

    expect(page1.length).toBe(10);
    expect(page2.length).toBe(10);
    expect(doubleWide.length).toBe(20);
    expect([...page1, ...page2]).toEqual(doubleWide);
    // No duplicates within the combined pages.
    expect(new Set([...page1, ...page2]).size).toBe(20);
    db.close();
  });

  test("paging past the true match count yields an empty page, not an error", async () => {
    const db = freshDb();
    seedEegFixture(db);
    const d1 = realD1(db);
    const page = await fetchPage(d1, "eeg", "10", "9999");
    expect(page).toEqual([]);
    db.close();
  });
});

describe("parseSearchPagination clamping", () => {
  test("limit: negative, zero, non-numeric, huge, and absent", () => {
    expect(parseSearchPagination("-5", undefined).limit).toBe(1);
    expect(parseSearchPagination("0", undefined).limit).toBe(1);
    expect(parseSearchPagination("abc", undefined).limit).toBe(20);
    expect(parseSearchPagination("99999", undefined).limit).toBe(100);
    expect(parseSearchPagination(undefined, undefined).limit).toBe(20);
  });

  test("offset: negative, non-numeric, and absent", () => {
    expect(parseSearchPagination(undefined, "-1").offset).toBe(0);
    expect(parseSearchPagination(undefined, "abc").offset).toBe(0);
    expect(parseSearchPagination(undefined, undefined).offset).toBe(0);
  });

  test("valid limit/offset pass through clamped to their own bounds only", () => {
    expect(parseSearchPagination("42", "7")).toEqual({ limit: 42, offset: 7 });
    expect(parseSearchPagination("100", "0")).toEqual({ limit: 100, offset: 0 });
  });

  // Regression fixed by this phase: the old inline parse did
  // `Math.min(Number.parseInt(limit || "20", 10), 100)` with no lower bound
  // and no NaN guard, so `limit=-5` fell through to `results.slice(0, -5)`
  // (silently dropping the last five rows) and `limit=abc` produced
  // `slice(0, NaN)` (an empty list either way).
  test("negative and NaN limits no longer produce slice(0, negative) or slice(0, NaN)", () => {
    const negative = parseSearchPagination("-5", undefined);
    expect(negative.limit).toBeGreaterThan(0);
    const nan = parseSearchPagination("abc", undefined);
    expect(Number.isNaN(nan.limit)).toBe(false);
  });
});

// Real modality vocabulary from the catalog (#1145 plan). Includes a
// deliberate substring collision (ieeg contains eeg) to prove the SQL clause
// preserves the OLD JS `.includes()` semantics rather than fixing it --
// that quirk is out of scope for this phase.
const MODALITY_VOCAB = [
  "eeg",
  "anat",
  "ieeg",
  "beh",
  "meg",
  "func",
  "nirs",
  "fmap",
  "emg",
  "dwi",
  "motion",
  "perf",
];

describe("SQL modality filter matches the old JS substring semantics", () => {
  const rowId = (i: number) => `nm${String(200000 + i).padStart(6, "0")}`;
  const allIds = MODALITY_VOCAB.map((_, i) => rowId(i));

  function seedModalityFixture(db: Database): void {
    MODALITY_VOCAB.forEach((mod, i) => {
      insertRow(db, { dataset_id: rowId(i), name: `${mod} dataset`, modalities: mod });
    });
  }

  // The old handler filtered with `r.modalities.toLowerCase().includes(mod)`
  // in JS; the SQL clause is `LOWER(COALESCE(d.modalities,'')) LIKE '%mod%'`.
  // Both are substring matches, so this is expected to reproduce the same
  // quirk (e.g. filtering "eeg" also matches a row whose modality is "ieeg")
  // rather than fix it -- fixing it is out of scope for this phase.
  const jsSubstringMatch = (filterMod: string): Set<string> =>
    new Set(
      MODALITY_VOCAB.map((rowMod, i) => ({ rowMod, i }))
        .filter(({ rowMod }) => rowMod.toLowerCase().includes(filterMod.toLowerCase()))
        .map(({ i }) => rowId(i)),
    );

  test("every filter term across the vocabulary agrees with `.toLowerCase().includes()`", async () => {
    const db = freshDb();
    seedModalityFixture(db);
    const d1 = realD1(db);

    for (const filterMod of MODALITY_VOCAB) {
      // Exercise via hydrateDatasetsByIds, the same SQL-filtering path the
      // search endpoint's semantic/exact-id tiers use.
      const hydrated = await hydrateDatasetsByIds(d1, allIds, { modality: filterMod });
      expect(new Set(hydrated.map((r) => r.id))).toEqual(jsSubstringMatch(filterMod));
    }
    db.close();
  });

  test("the ieeg/eeg substring collision is preserved (not a regression to fix here)", async () => {
    const db = freshDb();
    seedModalityFixture(db);
    const d1 = realD1(db);
    const hydrated = await hydrateDatasetsByIds(d1, allIds, { modality: "eeg" });
    // Row 0 is "eeg" itself, row 2 is "ieeg" (contains "eeg" as a substring).
    expect(new Set(hydrated.map((r) => r.id))).toEqual(new Set([rowId(0), rowId(2)]));
    db.close();
  });
});

describe("hasHed excludes both 0 and NULL through the search retrieval path", () => {
  test("ftsSearch with { hasHed: true } returns only has_hed = 1 rows", async () => {
    const db = freshDb();
    seedEegFixture(db);
    const d1 = realD1(db);
    const results = await ftsSearch(d1, "eeg", SEARCH_CANDIDATE_CEILING, { hasHed: true });
    expect(results.length).toBe(HAS_HED_MATCH_COUNT);
    for (const r of results) {
      expect(r.has_hed).toBe(1);
    }
    db.close();
  });

  test("ftsSearch with no hasHed filter returns every matching row (has_hed 1, 0, and NULL)", async () => {
    const db = freshDb();
    seedEegFixture(db);
    const d1 = realD1(db);
    const results = await ftsSearch(d1, "eeg", SEARCH_CANDIDATE_CEILING, {});
    expect(results.length).toBe(EEG_ROW_COUNT);
    db.close();
  });
});

describe("exact-id tier respects filters (#1145 behaviour change)", () => {
  function seedExactIdFixture(db: Database): void {
    insertRow(db, { dataset_id: "nm000111", name: "MEG study", modalities: "meg" });
  }

  test("lookupDatasetById returns the hit when it matches the filter", async () => {
    const db = freshDb();
    seedExactIdFixture(db);
    const d1 = realD1(db);
    const hit = await lookupDatasetById(d1, "nm000111", { modality: "meg" });
    expect(hit).not.toBeNull();
    expect(hit?.id).toBe("nm000111");
    db.close();
  });

  test("lookupDatasetById returns null when the hit fails the filter (old behaviour: returned regardless)", async () => {
    const db = freshDb();
    seedExactIdFixture(db);
    const d1 = realD1(db);
    const hit = await lookupDatasetById(d1, "nm000111", { modality: "eeg" });
    expect(hit).toBeNull();
    db.close();
  });

  test("lookupDatasetById with no filters still finds the row (unfiltered behaviour unchanged)", async () => {
    const db = freshDb();
    seedExactIdFixture(db);
    const d1 = realD1(db);
    const hit = await lookupDatasetById(d1, "nm000111", {});
    expect(hit).not.toBeNull();
    db.close();
  });

  test("lookupDatasetById respects hasHed too", async () => {
    const db = freshDb();
    db.query(
      "INSERT INTO datasets (dataset_id, name, modalities, has_hed) VALUES (?, ?, ?, ?)",
    ).run("nm000112", "HED-annotated study", "eeg", 1);
    const d1 = realD1(db);
    expect((await lookupDatasetById(d1, "nm000112", { hasHed: true }))?.id).toBe("nm000112");
    expect(await lookupDatasetById(d1, "nm000112", { hasHed: false })).not.toBeNull();
    db.close();
  });
});

describe("SEMANTIC_TOPK stays within buildInPlaceholders' hard ceiling", () => {
  test("SEMANTIC_TOPK is a valid buildInPlaceholders bound (<= 100)", () => {
    expect(SEMANTIC_TOPK).toBeLessThanOrEqual(100);
    expect(SEMANTIC_TOPK).toBeGreaterThan(0);
  });

  test("SEARCH_CANDIDATE_CEILING is a positive, sane SQL LIMIT", () => {
    expect(SEARCH_CANDIDATE_CEILING).toBeGreaterThan(0);
  });
});
