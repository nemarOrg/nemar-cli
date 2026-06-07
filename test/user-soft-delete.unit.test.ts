/**
 * Real behavioral test for the user tombstone (soft delete), epic #695.
 *
 * Like catalog-fold-migration.test.ts, this applies the ACTUAL migration file
 * (0037) against an in-memory SQLite seeded to mirror the post-0026 users shape,
 * then runs the SHARED masking statement the endpoint uses (USER_TOMBSTONE_MASK_SQL
 * from backend/src/db/user-tombstone.ts — no drift) plus the cascade statements,
 * and asserts the load-bearing security properties:
 *   - PII is masked + credentials revoked
 *   - the original email/username/github are freed for re-signup (UNIQUE-safe)
 *   - the auth chokepoint predicates (`u.deleted_at IS NULL`) exclude the row
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { USER_TOMBSTONE_MASK_SQL, maskedDeletedEmail } from "../backend/src/db/user-tombstone";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "backend/src/db/migrations");
const M0037 = readFileSync(join(MIGRATIONS_DIR, "0037_user_soft_delete.sql"), "utf8");

// Post-0026 schema slice the tombstone + auth queries touch (users without the
// 0037 column, plus tokens + web_sessions for the cascade/auth assertions).
const BASE_SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  github_username TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','verified','approved','revoked')),
  email_verified INTEGER NOT NULL DEFAULT 0,
  verification_token TEXT,
  verification_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  revoked_at TEXT,
  aws_access_key_id_encrypted TEXT,
  aws_secret_access_key_encrypted TEXT,
  aws_iam_username TEXT,
  orcid TEXT,
  role TEXT DEFAULT 'member',
  email_preferences TEXT DEFAULT NULL,
  description TEXT,
  signup_source TEXT NOT NULL DEFAULT 'cli'
);
CREATE TABLE tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  api_key_hash TEXT NOT NULL,
  revoked_at TEXT,
  expires_at TEXT
);
CREATE TABLE web_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  cookie_id_hash TEXT NOT NULL,
  revoked_at TEXT,
  expires_at TEXT NOT NULL DEFAULT (datetime('now', '+30 days'))
);
`;

function seed(db: Database) {
  db.run(
    `INSERT INTO users (id, username, email, password_hash, github_username, status, email_verified, role, orcid, description, aws_iam_username, aws_access_key_id_encrypted)
     VALUES (42, 'testuser', 'real@example.com', 'argon2hash', 'ghuser', 'approved', 1, 'member', '0000-0001', 'a bio', 'iam-user', 'enc-key')`,
  );
  db.run("INSERT INTO tokens (user_id, api_key_hash, revoked_at) VALUES (42, 'tokenhash', NULL)");
  db.run(
    "INSERT INTO web_sessions (user_id, cookie_id_hash, revoked_at) VALUES (42, 'cookiehash', NULL)",
  );
}

function tombstone(db: Database, id: number) {
  db.query(USER_TOMBSTONE_MASK_SQL).run(maskedDeletedEmail(id), id);
  db.query(
    "UPDATE tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
  ).run(id);
  db.query(
    "UPDATE web_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
  ).run(id);
}

describe("user tombstone (soft delete)", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(BASE_SCHEMA);
    db.exec(M0037); // real migration: ALTER TABLE users ADD COLUMN deleted_at TEXT + index
    seed(db);
  });

  test("migration 0037 adds a queryable deleted_at column", () => {
    const cols = db.query("PRAGMA table_info(users)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "deleted_at")).toBe(true);
  });

  test("masks PII, zeroes email_verified, stamps deleted_at, revokes creds", () => {
    tombstone(db, 42);
    const row = db
      .query(
        "SELECT email, username, github_username, password_hash, orcid, description, email_preferences, email_verified, aws_iam_username, aws_access_key_id_encrypted, status, deleted_at, revoked_at FROM users WHERE id = 42",
      )
      .get() as Record<string, unknown>;
    expect(row.email).toBe("deleted+42@deleted.invalid");
    expect(row.username).toBeNull();
    expect(row.github_username).toBeNull();
    expect(row.password_hash).toBeNull();
    expect(row.orcid).toBeNull();
    expect(row.description).toBeNull();
    expect(row.email_preferences).toBeNull();
    expect(row.email_verified).toBe(0);
    expect(row.aws_iam_username).toBeNull();
    expect(row.aws_access_key_id_encrypted).toBeNull();
    expect(row.status).toBe("revoked");
    expect(row.deleted_at).not.toBeNull();
    expect(row.revoked_at).not.toBeNull();

    const tok = db.query("SELECT revoked_at FROM tokens WHERE user_id = 42").get() as {
      revoked_at: string | null;
    };
    const sess = db.query("SELECT revoked_at FROM web_sessions WHERE user_id = 42").get() as {
      revoked_at: string | null;
    };
    expect(tok.revoked_at).not.toBeNull();
    expect(sess.revoked_at).not.toBeNull();
  });

  test("frees the original email/username/github for re-signup (UNIQUE-safe)", () => {
    tombstone(db, 42);
    // A fresh signup reusing the deleted user's identifiers must not 409.
    expect(() =>
      db.run(
        "INSERT INTO users (username, email, github_username, status) VALUES ('testuser', 'real@example.com', 'ghuser', 'pending')",
      ),
    ).not.toThrow();
  });

  test("re-running the mask is idempotent (matches 0 rows, no error)", () => {
    tombstone(db, 42);
    const before = db.query("SELECT deleted_at FROM users WHERE id = 42").get() as {
      deleted_at: string;
    };
    // The `AND deleted_at IS NULL` guard means the second mask updates nothing.
    db.query(USER_TOMBSTONE_MASK_SQL).run(maskedDeletedEmail(42), 42);
    const after = db.query("SELECT deleted_at FROM users WHERE id = 42").get() as {
      deleted_at: string;
    };
    expect(after.deleted_at).toBe(before.deleted_at);
  });

  test("bearer-token auth predicate excludes the tombstoned user", () => {
    tombstone(db, 42);
    // Mirrors middleware/auth.ts authMiddleware: token JOIN users with the new
    // `AND u.deleted_at IS NULL` guard. Returns no row even though we query the
    // (revoked) token directly — independent of token cleanup.
    const row = db
      .query(
        `SELECT u.id FROM tokens t JOIN users u ON t.user_id = u.id
         WHERE t.api_key_hash = 'tokenhash' AND u.deleted_at IS NULL`,
      )
      .get();
    expect(row).toBeNull();
  });

  test("cookie-session auth predicate excludes the tombstoned user", () => {
    tombstone(db, 42);
    // Mirrors resolveCookieUser / findSessionByCookieId with `AND u.deleted_at IS NULL`.
    const row = db
      .query(
        `SELECT u.id FROM web_sessions ws JOIN users u ON u.id = ws.user_id
         WHERE ws.cookie_id_hash = 'cookiehash' AND u.deleted_at IS NULL`,
      )
      .get();
    expect(row).toBeNull();
  });

  test("admin list/stats predicate hides the tombstone but a live user remains", () => {
    db.run(
      "INSERT INTO users (id, username, email, status) VALUES (43, 'live', 'live@example.com', 'approved')",
    );
    tombstone(db, 42);
    const approved = db
      .query("SELECT COUNT(*) AS n FROM users WHERE status = 'approved' AND deleted_at IS NULL")
      .get() as { n: number };
    expect(approved.n).toBe(1); // only the live user, not the tombstoned one
  });
});
