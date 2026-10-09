/**
 * Migration 0093_clear_password_hashes.sql (ADR 0095).
 *
 * Real engine, no mocks: bun:sqlite with every migration before 0093 applied,
 * `users` seeded at that schema with the row shapes production holds (a live
 * password-era account, a web account that never had a password, a soft-deleted
 * tombstone, an account with a key), then 0093 applied and the table compared
 * with what was there before.
 *
 * The migration does one thing, so the properties worth pinning are the two
 * ways it could do too much or too little: a hash left behind, and a column
 * other than `password_hash` touched. A third is that the column itself is
 * still there and still nullable, because dropping it is deliberately not part
 * of this change.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");
const TARGET = "0093_clear_password_hashes.sql";
const HASH = "$2b$10$JmaHDE03Q2pjaBgWB4jeN.mgLCp9WdSWRpicN4J5gAiJ/YZBRPWIi";

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

function seed(db: Database): void {
  // A password-era CLI account, its login still valid on the old code.
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role,
                        signup_source, email_verified, description, city, country)
     VALUES ('legacy', 'legacy@example.org', ?, 'legacy-gh', 'approved', 'member',
             'cli', 1, 'a description worth keeping', 'San Diego', 'USA')`,
    [HASH],
  );
  // A web account: never had a password, the column is already NULL.
  db.run(
    `INSERT INTO users (username, email, github_username, status, role, signup_source, email_verified)
     VALUES (NULL, 'web@example.org', NULL, 'verified', 'member', 'web', 1)`,
  );
  // A soft-deleted row that somehow still carries a hash.
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role,
                        signup_source, email_verified, deleted_at)
     VALUES (NULL, 'deleted+9@deleted.invalid', ?, NULL, 'revoked', 'member',
             'cli', 1, '2026-01-01 00:00:00')`,
    [HASH],
  );
}

function everythingButHash(db: Database): unknown[] {
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(users)")
    .all()
    .map((c) => c.name)
    .filter((n) => n !== "password_hash" && n !== "updated_at");
  return db.query(`SELECT ${cols.join(", ")} FROM users ORDER BY id`).all();
}

describe("0093_clear_password_hashes", () => {
  test("no row keeps a hash, whatever its state", () => {
    const db = dbBeforeTarget();
    seed(db);
    expect(
      db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL")
        .get()?.n,
    ).toBe(2);

    applyTarget(db);

    expect(
      db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL")
        .get()?.n,
    ).toBe(0);
  });

  test("nothing but the hash changes", () => {
    const db = dbBeforeTarget();
    seed(db);
    const before = everythingButHash(db);
    // The three seeded rows plus the internal system account (id -1, migration
    // 0029), which every database carries.
    expect(before.length).toBe(4);

    applyTarget(db);

    expect(everythingButHash(db)).toEqual(before);
  });

  test("it can be applied twice and the second run changes nothing", () => {
    const db = dbBeforeTarget();
    seed(db);
    applyTarget(db);
    const after = db.query("SELECT * FROM users ORDER BY id").all();

    applyTarget(db);

    expect(db.query("SELECT * FROM users ORDER BY id").all()).toEqual(after);
  });

  test("the column survives and stays nullable", () => {
    const db = dbBeforeTarget();
    applyTarget(db);
    const col = db
      .query<{ name: string; notnull: number }, []>("PRAGMA table_info(users)")
      .all()
      .find((c) => c.name === "password_hash");
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(0);
  });
});
