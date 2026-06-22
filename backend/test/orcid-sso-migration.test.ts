/**
 * Integration test for migration 0050_orcid_sso.sql (#832).
 *
 * Runs against a real in-memory SQLite database via bun:sqlite (no mocks),
 * applying every migration in order so the schema matches production, then
 * asserting the ORCID SSO additions:
 *
 *   1. oauth_identities has the expected columns.
 *   2. UNIQUE(provider, provider_subject) rejects a duplicate iD.
 *   3. provider CHECK rejects a non-'orcid' provider.
 *   4. users.orcid_verified exists and defaults to 0.
 *   5. web_sessions.auth_method exists, is nullable, and accepts 'orcid'.
 *   6. FK cascade deletes a user's oauth_identities rows.
 *   7. idx_oauth_identities_user exists.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");

function getMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function freshDb(opts: { foreignKeys?: boolean } = {}): Database {
  const db = new Database(":memory:");
  for (const file of getMigrationFiles()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  if (opts.foreignKeys) db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

function insertUser(db: Database, email: string): number {
  const row = db
    .prepare("INSERT INTO users (email, status) VALUES (?, 'approved') RETURNING id")
    .get(email) as { id: number };
  return row.id;
}

describe("migration 0050_orcid_sso", () => {
  test("oauth_identities has the expected columns", () => {
    const db = freshDb();
    const cols = (
      db.prepare("PRAGMA table_info(oauth_identities)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "user_id",
        "provider",
        "provider_subject",
        "provider_email",
        "display_name",
        "connected_at",
        "last_login_at",
      ]),
    );
    db.close();
  });

  test("UNIQUE(provider, provider_subject) rejects a duplicate iD across users", () => {
    const db = freshDb();
    const u1 = insertUser(db, "a@nemar.test");
    const u2 = insertUser(db, "b@nemar.test");
    db.prepare(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', '0000-0001-2345-6789')",
    ).run(u1);
    expect(() =>
      db
        .prepare(
          "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', '0000-0001-2345-6789')",
        )
        .run(u2),
    ).toThrow();
    db.close();
  });

  test("UNIQUE(provider, provider_subject) also rejects a same-user double insert", () => {
    const db = freshDb();
    const u = insertUser(db, "g@nemar.test");
    db.prepare(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', '0000-0003-1111-2222')",
    ).run(u);
    expect(() =>
      db
        .prepare(
          "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', '0000-0003-1111-2222')",
        )
        .run(u),
    ).toThrow();
    db.close();
  });

  test("provider CHECK rejects a non-'orcid' provider", () => {
    const db = freshDb();
    const u1 = insertUser(db, "c@nemar.test");
    expect(() =>
      db
        .prepare(
          "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'github', 'octocat')",
        )
        .run(u1),
    ).toThrow();
    db.close();
  });

  test("users.orcid_verified exists and defaults to 0", () => {
    const db = freshDb();
    const id = insertUser(db, "d@nemar.test");
    const row = db.prepare("SELECT orcid_verified FROM users WHERE id = ?").get(id) as {
      orcid_verified: number;
    };
    expect(row.orcid_verified).toBe(0);
    db.close();
  });

  test("web_sessions.auth_method is nullable and accepts 'orcid'", () => {
    const db = freshDb();
    const id = insertUser(db, "e@nemar.test");
    // Nullable: insert without auth_method.
    db.prepare(
      "INSERT INTO web_sessions (user_id, cookie_id_hash, expires_at) VALUES (?, 'hash-null', datetime('now','+1 day'))",
    ).run(id);
    const nullRow = db
      .prepare("SELECT auth_method FROM web_sessions WHERE cookie_id_hash = 'hash-null'")
      .get() as { auth_method: string | null };
    expect(nullRow.auth_method).toBeNull();

    db.prepare(
      "INSERT INTO web_sessions (user_id, cookie_id_hash, expires_at, auth_method) VALUES (?, 'hash-orcid', datetime('now','+1 day'), 'orcid')",
    ).run(id);
    const orcidRow = db
      .prepare("SELECT auth_method FROM web_sessions WHERE cookie_id_hash = 'hash-orcid'")
      .get() as { auth_method: string | null };
    expect(orcidRow.auth_method).toBe("orcid");
    db.close();
  });

  test("FK cascade deletes a user's oauth_identities rows", () => {
    const db = freshDb({ foreignKeys: true });
    const id = insertUser(db, "f@nemar.test");
    db.prepare(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', '0000-0002-1111-2222')",
    ).run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM oauth_identities WHERE user_id = ?")
      .get(id) as { n: number };
    expect(remaining.n).toBe(0);
    db.close();
  });

  test("idx_oauth_identities_user index exists", () => {
    const db = freshDb();
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_oauth_identities_user") as { name: string } | null;
    expect(idx?.name).toBe("idx_oauth_identities_user");
    db.close();
  });
});
