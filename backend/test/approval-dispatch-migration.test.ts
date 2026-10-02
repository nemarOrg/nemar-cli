/**
 * Migration 0090: the two columns a web-launched approval needs (ADR 0080).
 *
 * Real engine only: every migration applied in order to an in-memory SQLite
 * database, so the assertions read the production schema. What is pinned is the
 * shape the rest of the feature relies on: both columns exist, are nullable with
 * no default (a request that predates web dispatch reads NULL, which is the
 * truth for it and is how the orchestrator tells a direct CLI approval from a
 * web-queued one), and neither carries a foreign key, so ending an approver's
 * account is never blocked by a request that already published.
 */

import { describe, expect, test } from "bun:test";
import { freshDb } from "./helpers/d1";

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

function column(name: string): ColumnInfo {
  const db = freshDb();
  const found = (db.query("PRAGMA table_info(publication_requests)").all() as ColumnInfo[]).find(
    (c) => c.name === name,
  );
  if (!found) throw new Error(`publication_requests has no column ${name}`);
  return found;
}

describe("0090 approval dispatch columns", () => {
  test("approval_requested_by is a nullable integer with no default", () => {
    const c = column("approval_requested_by");
    expect(c.type).toBe("INTEGER");
    expect(c.notnull).toBe(0);
    expect(c.dflt_value).toBeNull();
  });

  test("approval_dispatched_at is a nullable text with no default", () => {
    const c = column("approval_dispatched_at");
    expect(c.type).toBe("TEXT");
    expect(c.notnull).toBe(0);
    expect(c.dflt_value).toBeNull();
  });

  test("neither column has a foreign key", () => {
    const db = freshDb();
    const fks = db.query("PRAGMA foreign_key_list(publication_requests)").all() as {
      from: string;
    }[];
    expect(fks.map((f) => f.from)).not.toContain("approval_requested_by");
    expect(fks.map((f) => f.from)).not.toContain("approval_dispatched_at");
  });

  test("a request written without them reads NULL for both", () => {
    const db = freshDb();
    db.run(
      `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
       VALUES (1, 'owner', 'owner@example.org', 'x', 'approved', 'member', 1)`,
    );
    db.run(
      `INSERT INTO publication_requests (dataset_id, status, requested_by)
       VALUES ('nm000999', 'requested', 1)`,
    );
    const row = db
      .query<{ approval_requested_by: number | null; approval_dispatched_at: string | null }, []>(
        "SELECT approval_requested_by, approval_dispatched_at FROM publication_requests",
      )
      .get();
    expect(row).toEqual({ approval_requested_by: null, approval_dispatched_at: null });
  });
});
