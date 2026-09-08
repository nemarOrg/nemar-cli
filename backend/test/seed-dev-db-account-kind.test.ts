/**
 * scripts/seed-dev-db.sql's account_kind UPDATEs (epic #1272 phase 4,
 * #1284 review; ADR 0048): a database seeded fresh AFTER migration 0082
 * ran needs the same data half migration 0082 itself only ever applies to
 * a database that predates it (account-kind-migration.test.ts covers
 * that half).
 *
 * Real engine: every migration applied to bun:sqlite (freshDb(), matching
 * every other real-engine test in this suite), then the users the seed
 * script's account-kind statements target are seeded directly here (this
 * file does not run the WHOLE seed script -- most of it needs S3/GitHub/
 * token fixtures this test has no business asserting on), then the REAL
 * statements are sliced out of scripts/seed-dev-db.sql between its
 * `ACCOUNT-KIND-SEED:BEGIN`/`:END` markers with `readFileSync` and
 * executed verbatim -- never hand-copied (.rules/testing.md).
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { freshDb } from "./helpers/d1";

const SEED_FILE = join(import.meta.dir, "../../scripts/seed-dev-db.sql");
const BEGIN_MARKER = "-- ACCOUNT-KIND-SEED:BEGIN";
const END_MARKER = "-- ACCOUNT-KIND-SEED:END";

/** Slice the real account-kind statements out of the real seed file between
 *  its marker comments, rather than retyping them (.rules/testing.md). */
function accountKindSeedSql(): string {
  const full = readFileSync(SEED_FILE, "utf-8");
  const begin = full.indexOf(BEGIN_MARKER);
  const end = full.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      "scripts/seed-dev-db.sql's ACCOUNT-KIND-SEED markers were not found; did the file change?",
    );
  }
  return full.slice(begin + BEGIN_MARKER.length, end);
}

function seedUser(db: Database, username: string): void {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES (?, ?, 'x', 'verified', 'member', 1)`,
  ).run(username, `${username}@example.org`);
}

function kindOf(db: Database, username: string): string {
  const row = db
    .query<{ account_kind: string }, [string]>("SELECT account_kind FROM users WHERE username = ?")
    .get(username);
  if (!row) throw new Error(`no row for ${username}`);
  return row.account_kind;
}

const SEEDED_USERNAMES = [
  "test-owner",
  "test-admin",
  "test-user",
  "test-pending",
  "test-verified",
  "test-revoked",
  "test-web",
];

describe("scripts/seed-dev-db.sql: account_kind", () => {
  test("test-owner/test-admin become service; the persona fixtures become test; test-web stays person", () => {
    const db = freshDb();
    for (const username of SEEDED_USERNAMES) seedUser(db, username);

    db.exec(accountKindSeedSql());

    expect(kindOf(db, "test-owner")).toBe("service");
    expect(kindOf(db, "test-admin")).toBe("service");
    expect(kindOf(db, "test-user")).toBe("test");
    expect(kindOf(db, "test-pending")).toBe("test");
    expect(kindOf(db, "test-verified")).toBe("test");
    expect(kindOf(db, "test-revoked")).toBe("test");
    expect(kindOf(db, "test-web")).toBe("person");
  });

  test("touches exactly the named rows -- an unrelated account stays person", () => {
    const db = freshDb();
    for (const username of SEEDED_USERNAMES) seedUser(db, username);
    seedUser(db, "ordinary-person");

    db.exec(accountKindSeedSql());

    expect(kindOf(db, "ordinary-person")).toBe("person");
  });

  test("idempotent: re-running the sliced statements a second time changes nothing", () => {
    const db = freshDb();
    for (const username of SEEDED_USERNAMES) seedUser(db, username);
    const sql = accountKindSeedSql();

    db.exec(sql);
    const before = db
      .query<{ username: string; account_kind: string }, []>(
        "SELECT username, account_kind FROM users WHERE username LIKE 'test-%' ORDER BY username",
      )
      .all();

    expect(() => db.exec(sql)).not.toThrow();
    const after = db
      .query<{ username: string; account_kind: string }, []>(
        "SELECT username, account_kind FROM users WHERE username LIKE 'test-%' ORDER BY username",
      )
      .all();
    expect(after).toEqual(before);
  });
});
