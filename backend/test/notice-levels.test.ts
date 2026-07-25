/**
 * Integration test for D1 migration 0063_notice_level_vocabulary.sql (#1025).
 *
 * Runs against a real in-memory SQLite database via bun:sqlite (no mocks),
 * mirroring migrations.test.ts: apply migrations 0001-0062 to build a valid
 * schema, insert representative `notices` rows under the OLD three-value
 * vocabulary, then apply 0063 and assert the invariants.
 *
 * Invariants verified:
 *  1. Existing rows survive the table rebuild verbatim (ids, message, scope,
 *     created_at, created_by, expires_at unchanged).
 *  2. 'info' rows are renamed to 'tip'; 'warning'/'critical' are untouched.
 *  3. The widened CHECK accepts all five new levels.
 *  4. The widened CHECK still rejects unknown levels, including the now-retired
 *     'info' (the API normalizes it before insert rather than storing it).
 *  5. AUTOINCREMENT continues above the max pre-migration id.
 *  6. Both indexes survive the RENAME.
 *  7. The urgency ORDER BY built from NOTICE_LEVELS stacks correctly.
 *
 * Note (inherited from migrations.test.ts): bun:sqlite's exec() silently
 * swallows CHECK violations when the SQL has leading whitespace. INSERTs here
 * go through prepare().run() so constraint errors always surface.
 */

import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NOTICE_LEVELS } from "../src/services/notices";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");

function migrationsUpTo(max: number): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => {
      const num = Number.parseInt(f.split("_")[0], 10);
      return num >= 1 && num <= max;
    });
}

function applyMigration(db: Database, file: string): void {
  db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
}

/** Rebuilds the ORDER BY fragment the service generates, to test the ranking. */
const LEVEL_ORDER = `CASE level ${NOTICE_LEVELS.map(
  (level, index) => `WHEN '${level}' THEN ${index}`,
).join(" ")} ELSE ${NOTICE_LEVELS.length} END`;

type NoticeRow = {
  id: number;
  message: string;
  level: string;
  scope: string;
  created_at: string;
  created_by: number;
  expires_at: string | null;
};

const FIXTURES: Omit<NoticeRow, "id">[] = [
  {
    message: "Welcome to NEMAR.",
    level: "info",
    scope: "all",
    created_at: "2026-01-01 10:00:00",
    created_by: 1,
    expires_at: null,
  },
  {
    message: "Search reindexing in progress.",
    level: "warning",
    scope: "all",
    created_at: "2026-02-01 10:00:00",
    created_by: 1,
    expires_at: "2026-03-01T00:00:00.000Z",
  },
  {
    message: "Uploads are down.",
    level: "critical",
    scope: "members",
    created_at: "2026-03-01 10:00:00",
    created_by: 1,
    expires_at: null,
  },
  {
    message: "Admin-only note.",
    level: "info",
    scope: "admins",
    created_at: "2026-04-01 10:00:00",
    created_by: 1,
    expires_at: null,
  },
];

describe("0063_notice_level_vocabulary", () => {
  let db: Database;
  let before: NoticeRow[];

  beforeAll(() => {
    db = new Database(":memory:");
    for (const file of migrationsUpTo(62)) applyMigration(db, file);

    // A user row to satisfy the created_by foreign key.
    db.prepare(
      "INSERT INTO users (id, username, email, status) VALUES (1, 'admin', 'admin@nemar.org', 'approved')",
    ).run();

    for (const row of FIXTURES) {
      db.prepare(
        "INSERT INTO notices (message, level, scope, created_at, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(row.message, row.level, row.scope, row.created_at, row.created_by, row.expires_at);
    }
    before = db.prepare("SELECT * FROM notices ORDER BY id").all() as NoticeRow[];

    applyMigration(db, "0063_notice_level_vocabulary.sql");
  });

  test("preserves every row through the table rebuild", () => {
    const after = db.prepare("SELECT * FROM notices ORDER BY id").all() as NoticeRow[];
    expect(after).toHaveLength(before.length);
    for (const [i, row] of after.entries()) {
      expect(row.id).toBe(before[i].id);
      expect(row.message).toBe(before[i].message);
      expect(row.scope).toBe(before[i].scope);
      expect(row.created_at).toBe(before[i].created_at);
      expect(row.created_by).toBe(before[i].created_by);
      expect(row.expires_at).toBe(before[i].expires_at);
    }
  });

  test("renames info to tip and leaves warning/critical alone", () => {
    const levels = (
      db.prepare("SELECT id, level FROM notices ORDER BY id").all() as NoticeRow[]
    ).map((r) => r.level);
    expect(levels).toEqual(["tip", "warning", "critical", "tip"]);
    const leftoverInfo = db
      .prepare("SELECT COUNT(*) AS n FROM notices WHERE level = 'info'")
      .get() as {
      n: number;
    };
    expect(leftoverInfo.n).toBe(0);
  });

  test("accepts every level in the new vocabulary", () => {
    for (const level of NOTICE_LEVELS) {
      expect(() =>
        db
          .prepare(
            "INSERT INTO notices (message, level, scope, created_by) VALUES (?, ?, 'all', 1)",
          )
          .run(`probe ${level}`, level),
      ).not.toThrow();
    }
  });

  // 'info' is deliberately NOT storable: the admin route normalizes it to
  // 'tip' before insert, so anything reaching the DB as 'info' is a bug the
  // constraint should catch.
  test("rejects retired and unknown levels", () => {
    for (const level of ["info", "urgent", "", "TIP"]) {
      expect(() =>
        db
          .prepare(
            "INSERT INTO notices (message, level, scope, created_by) VALUES (?, ?, 'all', 1)",
          )
          .run("bad level", level),
      ).toThrow();
    }
  });

  test("continues AUTOINCREMENT above the pre-migration max id", () => {
    const maxBefore = Math.max(...before.map((r) => r.id));
    db.prepare(
      "INSERT INTO notices (message, level, scope, created_by) VALUES ('fresh', 'tip', 'all', 1)",
    ).run();
    const fresh = db.prepare("SELECT id FROM notices WHERE message = 'fresh'").get() as {
      id: number;
    };
    expect(fresh.id).toBeGreaterThan(maxBefore);
  });

  test("keeps both indexes after the rename", () => {
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notices'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).toContain("idx_notices_scope");
    expect(indexes).toContain("idx_notices_expires");
  });

  test("stacks levels most urgent first", () => {
    const fresh = new Database(":memory:");
    for (const file of migrationsUpTo(63)) applyMigration(fresh, file);
    fresh
      .prepare(
        "INSERT INTO users (id, username, email, status) VALUES (1, 'a', 'a@nemar.org', 'approved')",
      )
      .run();
    // Inserted in reverse urgency so a passing result can't come from insertion order.
    for (const level of [...NOTICE_LEVELS].reverse()) {
      fresh
        .prepare("INSERT INTO notices (message, level, scope, created_by) VALUES (?, ?, 'all', 1)")
        .run(`m-${level}`, level);
    }
    const ordered = (
      fresh.prepare(`SELECT level FROM notices ORDER BY ${LEVEL_ORDER}, created_at DESC`).all() as {
        level: string;
      }[]
    ).map((r) => r.level);
    expect(ordered).toEqual([...NOTICE_LEVELS]);
  });
});
