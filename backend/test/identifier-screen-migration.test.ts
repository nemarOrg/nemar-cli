/**
 * Migration 0091: the identifier screen's columns on `publication_requests`
 * (epic #1610, phase 4).
 *
 * Real engine only: every migration applied in order to an in-memory SQLite
 * database. What is pinned is the shape the feature relies on: every column
 * exists with the declared type, is nullable with no default (a request that
 * predates the screen reads NULL, which `screenGate` answers with "rerun" and
 * never "clear"), and the acknowledging admin carries no foreign key.
 */

import { describe, expect, test } from "bun:test";
import { freshDb } from "./helpers/d1";

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

const COLUMNS: Record<string, string> = {
  identifier_screen_status: "TEXT",
  identifier_screen_nonce: "TEXT",
  identifier_screen_dispatched_at: "TEXT",
  identifier_screen_at: "TEXT",
  identifier_screen_report: "TEXT",
  identifier_screen_emailed_at: "TEXT",
  identifier_screen_mail_claimed_at: "TEXT",
  identifier_screen_ack_by: "INTEGER",
  identifier_screen_ack_reason: "TEXT",
  identifier_screen_ack_at: "TEXT",
};

describe("0091 identifier screen columns", () => {
  const db = freshDb();
  const info = db.query("PRAGMA table_info(publication_requests)").all() as ColumnInfo[];

  for (const [name, type] of Object.entries(COLUMNS)) {
    test(`${name} is a nullable ${type} with no default`, () => {
      const c = info.find((col) => col.name === name);
      expect(c).toBeDefined();
      expect(c?.type).toBe(type);
      expect(c?.notnull).toBe(0);
      expect(c?.dflt_value).toBeNull();
    });
  }

  test("the acknowledging admin has no foreign key", () => {
    const fks = db.query("PRAGMA foreign_key_list(publication_requests)").all() as {
      from: string;
    }[];
    expect(fks.map((f) => f.from)).not.toContain("identifier_screen_ack_by");
  });

  test("a request written without them reads NULL for every one", () => {
    const fresh = freshDb();
    fresh.run(
      `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
       VALUES (1, 'owner', 'owner@example.org', 'x', 'approved', 'member', 1)`,
    );
    fresh.run(
      `INSERT INTO publication_requests (dataset_id, status, requested_by)
       VALUES ('nm000999', 'requested', 1)`,
    );
    const row = fresh
      .query<Record<string, unknown>, []>(
        `SELECT ${Object.keys(COLUMNS).join(", ")} FROM publication_requests`,
      )
      .get();
    expect(Object.values(row ?? {}).every((v) => v === null)).toBe(true);
    expect(Object.keys(row ?? {}).sort()).toEqual(Object.keys(COLUMNS).sort());
  });
});
