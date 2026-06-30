/**
 * End-to-end test for the GET /datasets `?has_hed=1` filter clause (#869 phase 4).
 *
 * Real bun:sqlite + the ACTUAL migration 0056. Proves `AND d.has_hed = 1` selects
 * ONLY classified-HED rows, excluding both 0 (checked, no HED) and NULL (not
 * classified yet) -- the property that makes the website's "Has HED" filter
 * correct after this epic (no more false positives like on007058). No mocks.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDatasetFilterClauses } from "../backend/src/routes/datasets";

const M0056 = readFileSync(
  join(import.meta.dir, "..", "backend/src/db/migrations/0056_hed_columns.sql"),
  "utf8",
);

// Minimal pre-0056 slices; dataset_versions must exist for 0056's ALTER TABLE.
const BASE_SCHEMA = `
CREATE TABLE datasets (dataset_id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE dataset_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT, version TEXT, doi TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`;

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(BASE_SCHEMA);
  db.exec(M0056);
  const ins = db.query("INSERT INTO datasets (dataset_id, name, has_hed) VALUES (?,?,?)");
  ins.run("nm000001", "has hed", 1);
  ins.run("nm000002", "has hed too", 1);
  ins.run("nm000003", "checked, no hed", 0);
  ins.run("nm000004", "not classified", null);
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

describe("?has_hed=1 filter end-to-end", () => {
  test("selects only has_hed=1 rows (excludes 0 and NULL)", () => {
    const db = freshDb();
    const params: (string | number)[] = [];
    const clause = buildDatasetFilterClauses(params, { hasHed: true });
    expect(clause).toContain("d.has_hed = 1");
    expect(select(db, clause, params)).toEqual(["nm000001", "nm000002"]);
    db.close();
  });

  test("no has_hed filter returns every row (including 0 and NULL)", () => {
    const db = freshDb();
    const params: (string | number)[] = [];
    const clause = buildDatasetFilterClauses(params, {});
    expect(select(db, clause, params)).toEqual(["nm000001", "nm000002", "nm000003", "nm000004"]);
    db.close();
  });
});
