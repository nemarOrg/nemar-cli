/**
 * End-to-end test for the GET /datasets `?data_complete=1` filter clause
 * (epic #967 Phase 3, #970).
 *
 * Real bun:sqlite + the ACTUAL migration 0059. Proves `AND d.data_complete = 1`
 * selects ONLY verified-complete rows, excluding both 0 (checked, incomplete --
 * the #967 signature) and NULL (not audited yet) -- mirrors
 * test/has-hed-filter.test.ts for has_hed. No mocks.
 *
 * Scope note: this covers the SQL clause builder + execution. The query-string
 * parse (`data_complete=1` OR `data_complete=true` -> dataComplete) lives at the
 * HTTP handler layer and is intentionally NOT exercised here (no Miniflare/HTTP-
 * layer unit test in this repo; the project avoids mocking the Worker runtime).
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDatasetFilterClauses } from "../backend/src/routes/datasets/catalog";

const M0059 = readFileSync(
  join(import.meta.dir, "..", "backend/src/db/migrations/0059_data_complete_columns.sql"),
  "utf8",
);

// Minimal pre-0059 slices; dataset_versions must exist for 0059's ALTER TABLE.
const BASE_SCHEMA = `
CREATE TABLE datasets (dataset_id TEXT PRIMARY KEY, name TEXT, concept_doi TEXT);
CREATE TABLE dataset_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT, version TEXT, doi TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`;

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(BASE_SCHEMA);
  db.exec(M0059);
  const ins = db.query(
    "INSERT INTO datasets (dataset_id, name, data_complete, concept_doi) VALUES (?,?,?,?)",
  );
  ins.run("nm000001", "complete + doi", 1, "doi:10.x/nm000001");
  ins.run("nm000002", "complete, no doi", 1, null);
  ins.run("nm000003", "checked, incomplete", 0, "doi:10.x/nm000003");
  ins.run("nm000004", "not audited", null, null);
  return db;
}

const select = (db: Database, clause: string, params: (string | number)[]) =>
  (
    db
      .query(`SELECT d.dataset_id FROM datasets d WHERE 1=1${clause}`)
      .all(...(params as never[])) as Array<{ dataset_id: string }>
  )
    .map((r) => r.dataset_id)
    .sort();

describe("?data_complete=1 filter end-to-end", () => {
  test("selects only data_complete=1 rows (excludes 0 and NULL)", () => {
    const db = freshDb();
    const params: (string | number)[] = [];
    const clause = buildDatasetFilterClauses(params, { dataComplete: true });
    expect(clause).toContain("d.data_complete = 1");
    expect(select(db, clause, params)).toEqual(["nm000001", "nm000002"]);
    db.close();
  });

  test("no data_complete filter returns every row (including 0 and NULL)", () => {
    const db = freshDb();
    const params: (string | number)[] = [];
    const clause = buildDatasetFilterClauses(params, {});
    expect(select(db, clause, params)).toEqual(["nm000001", "nm000002", "nm000003", "nm000004"]);
    db.close();
  });

  test("dataComplete stacks with hasDoi (both literal clauses apply in real SQL)", () => {
    const db = freshDb();
    const params: (string | number)[] = [];
    const clause = buildDatasetFilterClauses(params, { dataComplete: true, hasDoi: true });
    // nm000002 is complete but has no DOI; nm000003 has a DOI but is incomplete
    // -> both excluded.
    expect(select(db, clause, params)).toEqual(["nm000001"]);
    db.close();
  });
});
