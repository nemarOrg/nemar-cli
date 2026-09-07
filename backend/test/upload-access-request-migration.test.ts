/**
 * Integration test for migration 0076_upload_access_request.sql
 * (ADR 0042, epic #1250 phase #1253).
 *
 * Real engine, no mocks: every migration EXCEPT 0076 is applied to an
 * in-memory bun:sqlite database, rows are seeded at the pre-0076 schema, then
 * 0076 is applied and its effect is asserted against the real SQL.
 *
 * Two properties matter and neither is obvious from reading one ALTER TABLE:
 *  - existing rows come out of the migration having asked for NOTHING. A
 *    default or a backfill here would put the entire ~609-row catalog into the
 *    admin review queue on the day this deploys.
 *  - the column supports the three-state read the admin listing does
 *    (never asked / open / granted), so the query the route runs is exercised
 *    here against real seeded rows rather than described in a comment.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");
const TARGET = "0076_upload_access_request.sql";

/** Apply every migration up to (not including) the target. */
function dbBeforeTarget(): Database {
  const db = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f < TARGET)
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  return db;
}

function applyTarget(db: Database): void {
  db.exec(readFileSync(join(MIGRATIONS_DIR, TARGET), "utf-8"));
}

function columnNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>("PRAGMA table_info(users)")
    .all()
    .map((r) => r.name);
}

describe("migration 0076: upload_access_requested_at", () => {
  test("the column does not exist before the migration", () => {
    // Guards a vacuous pass: without this, a test asserting the column exists
    // afterwards would also pass if it had always been there.
    const db = dbBeforeTarget();
    expect(columnNames(db)).not.toContain("upload_access_requested_at");
  });

  test("adds a nullable TEXT column", () => {
    const db = dbBeforeTarget();
    applyTarget(db);

    const col = db
      .query<{ name: string; type: string; notnull: number; dflt_value: string | null }, []>(
        "PRAGMA table_info(users)",
      )
      .all()
      .find((c) => c.name === "upload_access_requested_at");
    expect(col).toBeDefined();
    expect(col?.type).toBe("TEXT");
    expect(col?.notnull).toBe(0);
    expect(col?.dflt_value).toBeNull();
  });

  test("every pre-existing account comes out having asked for nothing", () => {
    const db = dbBeforeTarget();
    const insert = db.prepare(
      "INSERT INTO users (email, status, signup_source, service_access) VALUES (?, ?, ?, ?)",
    );
    insert.run("cli-approved@example.org", "approved", "cli", 1);
    insert.run("web-verified@example.org", "verified", "web", 0);
    insert.run("web-pending@example.org", "pending", "web", 0);

    applyTarget(db);

    // A default or a backfill here would enrol the whole catalog in the review
    // queue the moment this deploys.
    const asked = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) as n FROM users WHERE upload_access_requested_at IS NOT NULL",
      )
      .get();
    expect(asked?.n).toBe(0);
  });

  test("the three request states are distinguishable by the listing's own predicate", () => {
    const db = dbBeforeTarget();
    applyTarget(db);
    const insert = db.prepare(
      `INSERT INTO users (email, status, signup_source, service_access, upload_access_requested_at)
       VALUES (?, ?, 'web', ?, ?)`,
    );
    insert.run("never@example.org", "verified", 0, null);
    insert.run("open@example.org", "verified", 0, "2026-09-05T10:00:00Z");
    insert.run("granted@example.org", "approved", 1, "2026-09-01T10:00:00Z");

    // The exact predicate GET /admin/users?awaiting_approval=1 adds.
    const open = db
      .query<{ email: string }, []>(
        `SELECT email FROM users
          WHERE upload_access_requested_at IS NOT NULL AND service_access = 0`,
      )
      .all()
      .map((r) => r.email);
    expect(open).toEqual(["open@example.org"]);

    // A granted account keeps the stamp: it is the record of WHEN they asked,
    // not a queue flag that gets cleared.
    const granted = db
      .query<{ upload_access_requested_at: string | null }, []>(
        "SELECT upload_access_requested_at FROM users WHERE email = 'granted@example.org'",
      )
      .get();
    expect(granted?.upload_access_requested_at).toBe("2026-09-01T10:00:00Z");
  });

  test("re-applying the file fails loudly rather than corrupting anything", () => {
    // SQLite has no `ADD COLUMN IF NOT EXISTS`, so wrangler's d1_migrations
    // ledger is what guarantees one application. This pins the OTHER half of
    // that claim: a hand re-run is a loud no-op, not a silent partial write --
    // there is one statement, so there is nothing to half-apply.
    const db = dbBeforeTarget();
    applyTarget(db);
    db.prepare(
      "INSERT INTO users (email, status, upload_access_requested_at) VALUES ('keep@example.org', 'verified', '2026-09-05T10:00:00Z')",
    ).run();

    expect(() => applyTarget(db)).toThrow(/duplicate column name/i);

    expect(
      db
        .query<{ upload_access_requested_at: string | null }, []>(
          "SELECT upload_access_requested_at FROM users WHERE email = 'keep@example.org'",
        )
        .get()?.upload_access_requested_at,
    ).toBe("2026-09-05T10:00:00Z");
  });
});
