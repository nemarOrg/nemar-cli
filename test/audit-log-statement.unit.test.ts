/**
 * Behavioral test for the canonical audit_log insert (backend/src/db/audit-log.ts).
 *
 * Runs the production SQL constant + param marshaling against bun:sqlite (the
 * same approach as the user-tombstone mask test: a real SQLite driver, no
 * mocks). Pins the 5-column shape and bind order, and proves the legacy
 * 3-column insert `(action, user_id, details)` produces a row identical to
 * the helper with null resource columns — the drift-equivalence the #903
 * normalization relies on.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { AUDIT_LOG_INSERT_SQL, auditLogParams } from "../backend/src/db/audit-log";

// Verbatim from backend/src/db/migrations/0001_initial.sql.
const AUDIT_LOG_DDL = `CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  details TEXT,
  ip_address TEXT,

  FOREIGN KEY (user_id) REFERENCES users(id)
)`;

interface AuditRow {
  id: number;
  timestamp: string;
  user_id: number | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  details: string | null;
  ip_address: string | null;
}

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.run(AUDIT_LOG_DDL);
});

function lastRow(where = "1=1"): AuditRow {
  const row = db
    .query<AuditRow, []>(`SELECT * FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT 1`)
    .get();
  if (!row) throw new Error("no audit_log row inserted");
  return row;
}

function insert(params: ReturnType<typeof auditLogParams>): AuditRow {
  db.query(AUDIT_LOG_INSERT_SQL).run(...params);
  return lastRow();
}

describe("auditLogParams + AUDIT_LOG_INSERT_SQL", () => {
  test("full entry lands in the right columns (bind order)", () => {
    const row = insert(
      auditLogParams({
        userId: 42,
        action: "dataset_deleted",
        resourceType: "dataset",
        resourceId: "nm000199",
        details: JSON.stringify({ force: true }),
      }),
    );
    expect(row.user_id).toBe(42);
    expect(row.action).toBe("dataset_deleted");
    expect(row.resource_type).toBe("dataset");
    expect(row.resource_id).toBe("nm000199");
    expect(row.details).toBe('{"force":true}');
    expect(row.timestamp).toBeTruthy();
  });

  test("omitted optional fields insert as NULL", () => {
    const row = insert(auditLogParams({ userId: null, action: "bulk_delete" }));
    expect(row.user_id).toBeNull();
    expect(row.resource_type).toBeNull();
    expect(row.resource_id).toBeNull();
    expect(row.details).toBeNull();
  });

  test("matches the legacy 3-column insert shape row-for-row", () => {
    // The drifted pre-#903 shape used by two admin.ts call sites.
    db.query("INSERT INTO audit_log (action, user_id, details) VALUES (?, ?, ?)").run(
      "datasets_bulk_deleted",
      7,
      '{"count":3}',
    );
    const legacy = lastRow("id = 1");

    const helper = insert(
      auditLogParams({ userId: 7, action: "datasets_bulk_deleted", details: '{"count":3}' }),
    );

    const { id: _l, timestamp: _lt, ...legacyCols } = legacy;
    const { id: _h, timestamp: _ht, ...helperCols } = helper;
    expect(helperCols).toEqual(legacyCols);
  });
});
