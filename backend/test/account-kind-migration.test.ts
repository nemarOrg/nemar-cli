/**
 * Integration test for migration 0082_account_kind.sql (epic #1272 phase 4,
 * #1284; ADR 0048).
 *
 * Real engine, no mocks: every migration EXCEPT 0082 is applied to an
 * in-memory bun:sqlite database, rows are seeded at the pre-0082 schema
 * (username-keyed, matching what the migration itself keys on), then 0082 is
 * applied and its rules are asserted against the real SQL.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { OPERATIONAL_ACCOUNT_KINDS } from "../../shared/contract/user.js";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");
const TARGET = "0082_account_kind.sql";

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

const TARGET_SQL = readFileSync(join(MIGRATIONS_DIR, TARGET), "utf-8");

function applyTarget(db: Database): void {
  db.exec(TARGET_SQL);
}

/** Derived from the ONE shared source (shared/contract/user.ts, epic #1272
 *  phase 4, #1284 review) rather than hand-copied here a second time --
 *  this is what keeps the migration test honest about what the migration's
 *  OWN SQL data half must independently agree with. */
const OPERATIONAL_USERNAMES = Object.keys(OPERATIONAL_ACCOUNT_KINDS);
const SERVICE_USERNAMES = OPERATIONAL_USERNAMES.filter(
  (u) => OPERATIONAL_ACCOUNT_KINDS[u] === "service",
);
const TEST_USERNAMES = OPERATIONAL_USERNAMES.filter((u) => OPERATIONAL_ACCOUNT_KINDS[u] === "test");

const SEED_USERNAMES = [
  ...OPERATIONAL_USERNAMES,
  // Untouched: the shared web-QA account and an ordinary person.
  "test-web",
  "ordinary-person",
];

/** Seed one row per username above, exact case, all live. */
function seedAndMigrate(): Database {
  const db = dbBeforeTarget();
  const insert = db.prepare(
    `INSERT INTO users (username, email, status, signup_source, deleted_at)
     VALUES (?, ?, 'verified', 'web', ?)`,
  );
  for (const username of SEED_USERNAMES) {
    insert.run(username, `${username}@example.org`, null);
  }
  applyTarget(db);
  return db;
}

function kindOf(db: Database, username: string): string {
  const row = db
    .query<{ account_kind: string }, [string]>("SELECT account_kind FROM users WHERE username = ?")
    .get(username);
  if (!row) throw new Error(`no row for ${username}`);
  return row.account_kind;
}

describe("migration 0082: the column", () => {
  test("the CHECK constraint refuses a value outside the closed set", () => {
    const db = seedAndMigrate();
    expect(() =>
      db
        .prepare(
          "INSERT INTO users (username, email, status, signup_source, account_kind) VALUES (?, ?, 'verified', 'web', 'bogus')",
        )
        .run("bogus-kind", "bogus-kind@example.org"),
    ).toThrow(/CHECK constraint failed/);
  });

  test("a plain insert defaults to 'person'", () => {
    const db = seedAndMigrate();
    db.prepare(
      "INSERT INTO users (username, email, status, signup_source) VALUES (?, ?, 'verified', 'web')",
    ).run("brand-new-person", "brand-new-person@example.org");
    expect(kindOf(db, "brand-new-person")).toBe("person");
  });
});

describe("migration 0082: the data half", () => {
  test("named service accounts are flipped, exact case", () => {
    const db = seedAndMigrate();
    for (const username of SERVICE_USERNAMES) {
      expect(kindOf(db, username)).toBe("service");
    }
  });

  test("named test-persona accounts are flipped", () => {
    const db = seedAndMigrate();
    for (const username of TEST_USERNAMES) {
      expect(kindOf(db, username)).toBe("test");
    }
  });

  test("a service-bound username matches case-insensitively (COLLATE NOCASE)", () => {
    // A SEPARATE fixture from seedAndMigrate() on purpose: username carries
    // a case-insensitive UNIQUE index (migration 0080), so an
    // inverted-case 'NEMARADMIN' cannot coexist in the same database as
    // seedAndMigrate()'s own exact-case 'nemarAdmin' row. Proves the
    // migration's `username COLLATE NOCASE IN (...)` actually matches on
    // more than exact-case text -- every OTHER test in this file seeds the
    // migration's own exact casing, so removing `COLLATE NOCASE` from the
    // migration would not fail any of them.
    const db = dbBeforeTarget();
    db.prepare(
      `INSERT INTO users (username, email, status, signup_source)
       VALUES ('NEMARADMIN', 'nemaradmin-inverted-case@example.org', 'verified', 'web')`,
    ).run();
    applyTarget(db);
    expect(kindOf(db, "NEMARADMIN")).toBe("service");
  });

  test("test-web stays 'person' -- it is the shared web-QA account, not a persona", () => {
    const db = seedAndMigrate();
    expect(kindOf(db, "test-web")).toBe("person");
  });

  test("an unrelated account is untouched", () => {
    const db = seedAndMigrate();
    expect(kindOf(db, "ordinary-person")).toBe("person");
  });

  test("a tombstoned row using an operational username is untouched (deleted_at gate)", () => {
    // A SEPARATE fixture from seedAndMigrate() on purpose, for the same
    // unique-index reason as the case-insensitivity test above: a
    // tombstoned 'nemarAdmin' cannot coexist with seedAndMigrate()'s own
    // LIVE 'nemarAdmin'. Using the EXACT operational username (rather than
    // a fixture-only spelling like 'nemarAdmin-deleted', which the
    // migration's IN (...) list never names and so could never prove the
    // gate) is what makes this fail if `AND deleted_at IS NULL` is ever
    // dropped from the migration's UPDATE.
    const db = dbBeforeTarget();
    db.prepare(
      `INSERT INTO users (username, email, status, signup_source, deleted_at)
       VALUES ('nemarAdmin', 'nemaradmin-tombstoned@example.org', 'revoked', 'web', '2026-01-01 00:00:00')`,
    ).run();
    applyTarget(db);
    expect(kindOf(db, "nemarAdmin")).toBe("person");
  });

  test("the UPDATEs touch exactly the named rows -- nothing else moves off 'person'", () => {
    const db = seedAndMigrate();
    const nonPerson = db
      .query<{ username: string; account_kind: string }, []>(
        "SELECT username, account_kind FROM users WHERE account_kind != 'person' ORDER BY username",
      )
      .all();
    expect(nonPerson.map((r) => r.username).sort()).toEqual(
      [...SERVICE_USERNAMES, ...TEST_USERNAMES].sort(),
    );
  });

  test("idempotent: re-running the data half a second time changes nothing", () => {
    const db = seedAndMigrate();
    const snapshot = () =>
      db
        .query<{ username: string; account_kind: string }, []>(
          "SELECT username, account_kind FROM users ORDER BY username",
        )
        .all();
    const before = snapshot();

    // Only the two UPDATE statements are re-runnable (the ALTER is not,
    // matching every other column-adding migration here -- see the file's
    // own header and 0077's).
    const updatesOnly = TARGET_SQL.slice(TARGET_SQL.indexOf("UPDATE users"));
    expect(updatesOnly).toContain("account_kind = 'service'");
    expect(updatesOnly).toContain("account_kind = 'test'");
    expect(updatesOnly).not.toContain("ALTER TABLE users ADD COLUMN");

    expect(() => db.exec(updatesOnly)).not.toThrow();
    expect(snapshot()).toEqual(before);
  });
});
