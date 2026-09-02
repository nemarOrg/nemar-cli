/**
 * Unit tests for syncCitationCounts (#804).
 *
 * Runs against a real in-memory SQLite via bun:sqlite behind a thin D1 shim
 * (no mocks — every result comes from SQLite executing the real statement).
 * Covers: match by dataset_id, match by source_id alias (manifest ds-* hitting
 * an on-* row), skip rows not in the catalog, and idempotency.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  type CitationCountRow,
  syncCitationCounts,
} from "../backend/src/services/citation-counts-sync";

// Real-engine D1 shim with batch(): forwards to bun:sqlite.
function realD1(db: Database): D1Database {
  return {
    prepare(sql: string) {
      const stmt = db.query(sql);
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
      };
      return api;
    },
    batch(stmts: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(stmts.map((s) => s.run()));
    },
  } as unknown as D1Database;
}

// Minimal datasets schema with the citation columns as of migration 0073
// (#1183): only the two addends are stored (the served num_citations total
// is derived as their sum, see counts() below), and the sweep stamp lives
// under sweep_stamps -> $.citations_updated_at rather than its own column.
const SCHEMA = `
CREATE TABLE datasets (
  dataset_id TEXT NOT NULL UNIQUE,
  source_id TEXT,
  name TEXT NOT NULL,
  num_dataset_citations INTEGER NOT NULL DEFAULT 0,
  num_datapaper_citations INTEGER NOT NULL DEFAULT 0,
  sweep_stamps TEXT CHECK (sweep_stamps IS NULL OR json_valid(sweep_stamps))
);`;

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA);
  for (const [id, src] of [
    ["on005964", "ds005964"], // matches by dataset_id
    ["nm000207", null], // matches by dataset_id
    ["on007000", "ds007000"], // matched by source_id alias below
    ["ds999999", null], // legacy stored as ds-*, matches by dataset_id
  ] as const) {
    db.query("INSERT INTO datasets (dataset_id, source_id, name) VALUES (?, ?, ?)").run(
      id,
      src,
      `Dataset ${id}`,
    );
  }
});

const ROWS: CitationCountRow[] = [
  {
    dataset_id: "on005964",
    num_citations: 10,
    num_dataset_citations: 3,
    num_datapaper_citations: 7,
  },
  {
    dataset_id: "nm000207",
    num_citations: 5,
    num_dataset_citations: 1,
    num_datapaper_citations: 4,
  },
  {
    dataset_id: "ds007000",
    num_citations: 8,
    num_dataset_citations: 8,
    num_datapaper_citations: 0,
  }, // alias -> on007000
  {
    dataset_id: "ds999999",
    num_citations: 2,
    num_dataset_citations: 0,
    num_datapaper_citations: 2,
  },
  {
    dataset_id: "ds111111",
    num_citations: 99,
    num_dataset_citations: 9,
    num_datapaper_citations: 90,
  }, // not in catalog
];

function counts(id: string): Record<string, number> {
  return db
    .query(
      "SELECT (num_dataset_citations + num_datapaper_citations) AS num_citations, num_dataset_citations, num_datapaper_citations FROM datasets WHERE dataset_id = ?",
    )
    .get(id) as Record<string, number>;
}

describe("syncCitationCounts", () => {
  test("updates by dataset_id and by source_id alias; skips unknown ids", async () => {
    const res = await syncCitationCounts(realD1(db), ROWS);
    expect(res.updated).toBe(4);
    expect(res.skipped).toBe(1); // ds111111 not in catalog

    expect(counts("on005964")).toEqual({
      num_citations: 10,
      num_dataset_citations: 3,
      num_datapaper_citations: 7,
    });
    expect(counts("nm000207").num_citations).toBe(5);
    // ds007000 alias landed on the on007000 row.
    expect(counts("on007000")).toEqual({
      num_citations: 8,
      num_dataset_citations: 8,
      num_datapaper_citations: 0,
    });
    expect(counts("ds999999").num_citations).toBe(2);
  });

  test("stamps citations_updated_at on updated rows", async () => {
    // Every seeded row starts at sweep_stamps NULL (a fresh post-0073 row),
    // so this also pins the COALESCE in the production UPDATE: json_set on
    // a NULL column returns NULL and would silently discard the stamp.
    await syncCitationCounts(realD1(db), ROWS);
    const stamped = db
      .query(
        "SELECT json_extract(sweep_stamps, '$.citations_updated_at') AS at FROM datasets WHERE dataset_id = 'on005964'",
      )
      .get() as { at: string | null };
    expect(stamped.at).not.toBeNull();
  });

  test("never inserts a row for an unknown dataset", async () => {
    await syncCitationCounts(realD1(db), ROWS);
    const present = db.query("SELECT 1 FROM datasets WHERE dataset_id = 'ds111111'").get();
    expect(present).toBeNull();
  });

  test("is idempotent on re-run", async () => {
    await syncCitationCounts(realD1(db), ROWS);
    const res = await syncCitationCounts(realD1(db), ROWS);
    expect(res.updated).toBe(4);
    expect(counts("on005964").num_citations).toBe(10);
  });

  test("empty manifest is a no-op", async () => {
    const res = await syncCitationCounts(realD1(db), []);
    expect(res).toEqual({ updated: 0, skipped: 0 });
  });
});
