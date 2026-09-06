/**
 * Integration test for migration 0077_identity_uniqueness.sql
 * (ADR 0043, epic #1250 phase #1254).
 *
 * Real engine, no mocks: every migration EXCEPT 0077 is applied to an
 * in-memory bun:sqlite database, rows are seeded at the pre-0077 schema, then
 * 0077 is applied and its rules are asserted against the real SQL.
 *
 * The fixture is deliberately the production shape plus the two things
 * production does not happen to contain, because a rule that only handles the
 * catalog as it stands today is a rule that breaks on the next duplicate:
 *
 *   - an ORCID duplicate where the IDENTITY-BACKED row is NOT the lowest id
 *     (production rows 42/43, whose canonical row is the higher one);
 *   - a three-row case-variant email group (the lowest id wins, and the two
 *     losers must not each pick a different survivor);
 *   - a pair that collides on BOTH identifiers at once, where the two rules
 *     could otherwise flag every row in the group and leave the identifier
 *     held by nobody;
 *   - a legacy lowercase `x` check digit, which the exact-comparison index
 *     would not otherwise see as the same iD;
 *   - clean rows and a tombstone, which must come out untouched.
 *
 * What is asserted is not just "the right rows are flagged" but the property
 * that makes the migration deploy-safe: after it runs, EVERY live group has
 * exactly one unflagged row, both indexes exist, a later duplicate INSERT is
 * refused, and a flagged row is still readable.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");
const TARGET = "0077_identity_uniqueness.sql";

const SHARED_ORCID = "0000-0002-1974-1293";
const LOWERCASE_X_ORCID = "0000-0001-5109-353x";
const UPPERCASE_X_ORCID = "0000-0001-5109-353X";
const CLEAN_ORCID = "0000-0003-1111-2222";
const BOTH_ORCID = "0000-0004-4444-5555";

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

interface SeedRow {
  email: string;
  orcid?: string | null;
  github?: string | null;
  /** Give this row the oauth_identities row for its own iD. */
  identityBacked?: boolean;
  deleted?: boolean;
}

/** Seed rows in array order so ids are predictable, and return them by email. */
function seed(db: Database, rows: SeedRow[]): Map<string, number> {
  const insert = db.prepare(
    `INSERT INTO users (email, status, signup_source, orcid, orcid_verified, github_username, deleted_at)
     VALUES (?, 'verified', 'web', ?, ?, ?, ?)`,
  );
  const ids = new Map<string, number>();
  for (const r of rows) {
    insert.run(
      r.email,
      r.orcid ?? null,
      r.orcid ? 1 : 0,
      r.github ?? null,
      r.deleted ? "2026-01-01 00:00:00" : null,
    );
    const row = db
      .query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?")
      .get(r.email);
    if (!row) throw new Error(`seed failed for ${r.email}`);
    ids.set(r.email, row.id);
    if (r.identityBacked && r.orcid) {
      db.prepare(
        "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', ?)",
      ).run(row.id, r.orcid);
    }
  }
  return ids;
}

/**
 * The fixture, seeded and migrated. Ids are assigned in the order below, so
 * "the orphan is the LOWER id" is a fact about this fixture, not a hope.
 */
function migratedFixture(): { db: Database; ids: Map<string, number> } {
  const db = dbBeforeTarget();
  const ids = seed(db, [
    // The production 42/43 shape: the orphan first (lower id), the
    // identity-backed row second (higher id).
    { email: "robert.oostenveld@donders.ru.nl", orcid: SHARED_ORCID },
    { email: "r.oostenveld@donders.ru.nl", orcid: SHARED_ORCID, identityBacked: true },
    // A three-row case-variant email group.
    { email: "Ada@Lab.org" },
    { email: "ada@lab.org" },
    { email: "ADA@LAB.ORG" },
    // Legacy lowercase check digit vs its canonical spelling.
    { email: "x-lower@example.org", orcid: LOWERCASE_X_ORCID },
    { email: "x-upper@example.org", orcid: UPPERCASE_X_ORCID },
    // Collides on BOTH: same iD (identity row on the HIGHER id, so the ORCID
    // rule flags the lower one) and the same address case-insensitively (so
    // the email rule would, on its own, flag the higher one instead).
    { email: "Both@Example.org", orcid: BOTH_ORCID },
    { email: "both@example.org", orcid: BOTH_ORCID, identityBacked: true },
    // Clean rows: an untouched account, and a tombstone whose iD duplicates it.
    { email: "clean@example.org", orcid: CLEAN_ORCID, github: "Octocat" },
    { email: "deleted+99@deleted.invalid", orcid: CLEAN_ORCID, deleted: true },
  ]);
  applyTarget(db);
  return { db, ids };
}

function flagOf(db: Database, email: string): number {
  const row = db
    .query<{ identity_conflict: number }, [string]>(
      "SELECT identity_conflict FROM users WHERE email = ?",
    )
    .get(email);
  if (!row) throw new Error(`no row for ${email}`);
  return row.identity_conflict;
}

describe("migration 0077: the flag", () => {
  test("the ORCID duplicate flags the ORPHAN, not the lowest id", () => {
    const { db, ids } = migratedFixture();
    // Guard the fixture's own premise: the identity-backed row IS the higher
    // id, so "lowest id wins" and "identity row wins" give different answers.
    expect(ids.get("r.oostenveld@donders.ru.nl")).toBeGreaterThan(
      ids.get("robert.oostenveld@donders.ru.nl") as number,
    );
    expect(flagOf(db, "robert.oostenveld@donders.ru.nl")).toBe(1);
    expect(flagOf(db, "r.oostenveld@donders.ru.nl")).toBe(0);
  });

  test("the case-variant email group keeps the lowest id and flags the rest", () => {
    const { db } = migratedFixture();
    expect(flagOf(db, "Ada@Lab.org")).toBe(0);
    expect(flagOf(db, "ada@lab.org")).toBe(1);
    expect(flagOf(db, "ADA@LAB.ORG")).toBe(1);
  });

  test("a lowercase check digit is canonicalised and then treated as the same iD", () => {
    const { db } = migratedFixture();
    const stored = db
      .query<{ orcid: string }, [string]>("SELECT orcid FROM users WHERE email = ?")
      .get("x-lower@example.org");
    expect(stored?.orcid).toBe(UPPERCASE_X_ORCID);
    // Now that the two spellings are one value, the pair is a duplicate and
    // the lower id keeps it. Without statement (2) neither would be flagged
    // and the index would compare them as different people.
    expect(flagOf(db, "x-lower@example.org")).toBe(0);
    expect(flagOf(db, "x-upper@example.org")).toBe(1);
  });

  test("clean rows and tombstones are untouched", () => {
    const { db } = migratedFixture();
    expect(flagOf(db, "clean@example.org")).toBe(0);
    // The tombstone shares the clean row's iD, and must neither be flagged
    // nor cause the clean row to be.
    expect(flagOf(db, "deleted+99@deleted.invalid")).toBe(0);
  });

  test("a pair colliding on BOTH identifiers still leaves one row holding them", () => {
    const { db } = migratedFixture();
    // The two rules disagree about which row to flag here (ORCID says the
    // lower id, email says the higher). If they were independent, both rows
    // would end up flagged and the identifier would be held by nobody.
    const lower = flagOf(db, "Both@Example.org");
    const upper = flagOf(db, "both@example.org");
    expect([lower, upper].filter((f) => f === 0)).toHaveLength(1);
    // Specifically: the ORCID rule runs first and wins, so the identity-backed
    // row survives -- the same precedence as the 42/43 case.
    expect(upper).toBe(0);
    expect(lower).toBe(1);
  });

  test("every live duplicate group ends with exactly one unflagged row", () => {
    // The whole-catalog property, asserted over the fixture rather than row by
    // row: a rule that fixes the rows a test names while leaving a group
    // behind is exactly the failure this migration exists to prevent.
    const { db } = migratedFixture();
    const orcidGroups = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM (
           SELECT orcid FROM users
            WHERE deleted_at IS NULL AND orcid IS NOT NULL AND identity_conflict = 0
            GROUP BY orcid HAVING COUNT(*) > 1)`,
      )
      .get();
    expect(orcidGroups?.n).toBe(0);
    const emailGroups = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM (
           SELECT email FROM users
            WHERE deleted_at IS NULL AND identity_conflict = 0
            GROUP BY email COLLATE NOCASE HAVING COUNT(*) > 1)`,
      )
      .get();
    expect(emailGroups?.n).toBe(0);
  });
});

describe("migration 0077: the indexes", () => {
  test("both partial unique indexes exist, with their COLLATE and predicates", () => {
    // SQLite/D1 support a partial UNIQUE index whose key carries a COLLATE.
    // Reading the stored DDL rather than just the name proves the index that
    // exists is the one intended: an index without the COLLATE would let a
    // case variant through, and one without the predicate could not have been
    // created over this fixture at all.
    const { db } = migratedFixture();
    const rows = db
      .query<{ name: string; sql: string }, []>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_users_%_live_unique'",
      )
      .all();
    const byName = new Map(rows.map((r) => [r.name, r.sql]));
    expect([...byName.keys()].sort()).toEqual([
      "idx_users_email_live_unique",
      "idx_users_orcid_live_unique",
    ]);
    const emailSql = byName.get("idx_users_email_live_unique") as string;
    expect(emailSql).toContain("UNIQUE INDEX");
    expect(emailSql).toContain("COLLATE NOCASE");
    expect(emailSql).toContain("identity_conflict = 0");
    expect(emailSql).toContain("deleted_at IS NULL");
    const orcidSql = byName.get("idx_users_orcid_live_unique") as string;
    expect(orcidSql).toContain("UNIQUE INDEX");
    expect(orcidSql).toContain("identity_conflict = 0");
    expect(orcidSql).toContain("deleted_at IS NULL");
  });

  test("a later duplicate INSERT is refused on each identifier", () => {
    const { db } = migratedFixture();
    const insert = db.prepare(
      "INSERT INTO users (email, status, signup_source, orcid) VALUES (?, 'verified', 'web', ?)",
    );
    expect(() => insert.run("someone-else@example.org", CLEAN_ORCID)).toThrow(
      /UNIQUE constraint failed: users\.orcid/,
    );
    expect(() => insert.run("CLEAN@Example.ORG", null)).toThrow(
      /UNIQUE constraint failed: users\.email/,
    );
  });

  test("a duplicate that is FLAGGED can still be inserted (that is the escape hatch)", () => {
    // This is what makes the migration deploy-safe: the flag is how a real
    // duplicate coexists with a unique index instead of failing the deploy.
    const { db } = migratedFixture();
    expect(() =>
      db
        .prepare(
          "INSERT INTO users (email, status, signup_source, orcid, identity_conflict) VALUES (?, 'verified', 'web', ?, 1)",
        )
        .run("flagged-dupe@example.org", CLEAN_ORCID),
    ).not.toThrow();
  });

  test("a flagged row is still fully readable", () => {
    // A flagged account is not quarantined: it signs in, owns datasets, and
    // appears in listings. Only its claim on the identifier is gone.
    const { db } = migratedFixture();
    const row = db
      .query<{ id: number; email: string; orcid: string; status: string }, [string]>(
        "SELECT id, email, orcid, status FROM users WHERE email = ?",
      )
      .get("robert.oostenveld@donders.ru.nl");
    expect(row?.orcid).toBe(SHARED_ORCID);
    expect(row?.status).toBe("verified");
  });

  test("multiple rows with no ORCID at all do not collide", () => {
    const { db } = migratedFixture();
    const insert = db.prepare(
      "INSERT INTO users (email, status, signup_source, orcid) VALUES (?, 'verified', 'cli', NULL)",
    );
    expect(() => {
      insert.run("no-orcid-1@example.org");
      insert.run("no-orcid-2@example.org");
    }).not.toThrow();
  });
});
