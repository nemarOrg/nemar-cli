/**
 * Integration test for migration 0089_private_site_sessions.sql (ADR 0079).
 *
 * Real engines, no mocks. Every migration BEFORE 0089 is applied, then
 * `web_sessions` is seeded at the 0088 schema with the row shapes production
 * holds (app and docs, live, revoked, remember-me, expired, a gap left by a
 * hard delete, and a sequence ahead of the highest surviving id), then 0089 is
 * applied and the table is compared with what was there before.
 *
 * The migration is a table REBUILD (SQLite cannot alter a CHECK), so the
 * property that matters most is the boring one: nothing about an existing
 * session changes. A dropped column, a reordered copy or a lost index would
 * all leave every other test in the suite green, because `freshDb()` builds
 * an empty table and never sees a row cross the rebuild.
 *
 * TWO ENGINES, FOR TWO DIFFERENT QUESTIONS.
 *   * bun:sqlite, with 0089 applied ONE STATEMENT AT A TIME. bun's
 *     multi-statement `exec()` returns without throwing when a statement fails
 *     and runs the rest (checked on bun 1.3.10), so feeding it the whole file
 *     would let a failing guard be ignored and a DROP run anyway. One statement
 *     at a time is also the shape a runner that is NOT transactional would
 *     give the file, which is exactly what the guard is for: it must stop the
 *     DROP by itself, with no rollback to lean on.
 *   * Miniflare's D1, the implementation `wrangler --local` runs, with the file
 *     in one call, the way a migration reaches D1. There a failing guard
 *     aborts the call and everything rolls back.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import {
  MIGRATIONS_DIR,
  applyMigrations,
  migrationCall,
  migrationFiles,
} from "./helpers/miniflare-d1";

const TARGET = "0089_private_site_sessions.sql";
const TARGET_SQL = readFileSync(join(MIGRATIONS_DIR, TARGET), "utf-8");
const BEFORE_TARGET = migrationFiles().filter((f) => f < TARGET);

/** The file's statements, in order. Full-line comments dropped first (0089
 *  has no inline ones and no semicolon inside a statement, which the count
 *  test below pins). */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Insert `extra` immediately before the first guard statement. */
function withInjection(sql: string, extra: string): string {
  const marker = "INSERT INTO _rebuild_guard";
  const at = sql.indexOf(marker);
  if (at < 0) throw new Error("no guard statement to inject before");
  return `${sql.slice(0, at)}${extra}\n${sql.slice(at)}`;
}

/** Apply 0089 (or a variant) statement by statement; throws on the first failure. */
function applyByStatement(db: Database, sql = TARGET_SQL): void {
  for (const statement of statements(sql)) db.run(statement);
}

function dbBeforeTarget(): Database {
  const db = new Database(":memory:");
  for (const file of BEFORE_TARGET) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  return db;
}

// --------------------------------------------------------------------------
// Seeding, shared by both engines as plain SQL
// --------------------------------------------------------------------------

const SEED_USERS = [
  `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified)
   VALUES ('mig-a', 'mig-a@nemar.test', 'x', 'approved', 'admin', 'web', 1)`,
  `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified)
   VALUES ('mig-b', 'mig-b@nemar.test', 'x', 'approved', 'admin', 'web', 1)`,
];

// [user, hash, remember, expires_at, revoked_at, auth_method, scope]. Every
// column is set explicitly, defaults included, so a copy that fell back to a
// default instead of the stored value is visible.
const SHAPES: [string, string, number, string, string | null, string | null, string][] = [
  ["mig-a", "h-app-live", 0, "2099-01-01 00:00:00", null, "orcid", "app"],
  ["mig-a", "h-app-remember", 1, "2099-02-01 00:00:00", null, "email_code", "app"],
  ["mig-b", "h-app-revoked", 0, "2099-03-01 00:00:00", "2026-09-03 11:00:00", "orcid", "app"],
  // Expired, and with no auth_method: a row written before migration 0050.
  ["mig-b", "h-app-expired", 0, "2020-01-01 00:00:00", null, null, "app"],
  ["mig-b", "h-gap", 0, "2099-01-01 00:00:00", null, "orcid", "app"],
  ["mig-a", "h-docs-live", 0, "2099-04-01 00:00:00", null, "orcid", "docs"],
  // Revoked, minted by the CLI docs path.
  ["mig-b", "h-docs-revoked", 0, "2099-05-01 00:00:00", "2026-09-05 11:00:00", "api_key", "docs"],
  ["mig-a", "h-app-after-gap", 1, "2099-06-01 00:00:00", null, "email_code", "app"],
  // Two tail rows, hard-deleted below, so the AUTOINCREMENT sequence sits
  // ahead of the highest surviving id and the reseed is observable.
  ["mig-a", "h-tail-1", 0, "2099-07-01 00:00:00", null, "orcid", "app"],
  ["mig-a", "h-tail-2", 0, "2099-07-02 00:00:00", null, "orcid", "app"],
];

function lit(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value}'`;
}

function seedStatements(): string[] {
  const rows = SHAPES.map(([user, hash, remember, expires, revoked, method, scope], i) => {
    const day = String(i + 1).padStart(2, "0");
    return `INSERT INTO web_sessions
       (user_id, cookie_id_hash, remember, expires_at, last_used_at, user_agent, ip_hash,
        revoked_at, created_at, auth_method, scope)
     VALUES ((SELECT id FROM users WHERE username = '${user}'), ${lit(hash)}, ${remember},
       ${lit(expires)}, '2026-09-${day} 10:00:00', ${lit(i % 2 ? null : `ua-${i}`)},
       ${lit(i % 3 ? `ip-${i}` : null)}, ${lit(revoked)}, '2026-09-${day} 09:00:00',
       ${lit(method)}, ${lit(scope)})`;
  });
  return [
    ...SEED_USERS,
    ...rows,
    // A gap in the ids, as a hard user delete leaves one, and the tail.
    "DELETE FROM web_sessions WHERE cookie_id_hash IN ('h-gap', 'h-tail-1', 'h-tail-2')",
  ];
}

// --------------------------------------------------------------------------
// Catalog readers
// --------------------------------------------------------------------------

function allRows(db: Database): unknown[] {
  return db.query("SELECT * FROM web_sessions ORDER BY id").all();
}

function columns(db: Database, table: string): unknown[] {
  return db.query(`PRAGMA table_info(${table})`).all();
}

function storedSql(db: Database, name: string): string | null {
  return (
    db
      .query<{ sql: string | null }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?")
      .get(name)?.sql ?? null
  );
}

/** Every index on a table as SQLite describes it: name, unique, origin,
 *  partial, and each one's full column list (`index_xinfo`). */
function indexes(db: Database, table: string) {
  const list = db
    .query<{ name: string; unique: number; origin: string; partial: number }, []>(
      `PRAGMA index_list(${table})`,
    )
    .all()
    .map(({ name, unique, origin, partial }) => ({
      name,
      unique,
      origin,
      partial,
      columns: db.query(`PRAGMA index_xinfo(${name})`).all(),
    }));
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

function sequence(db: Database): number | null {
  return (
    db
      .query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name = 'web_sessions'")
      .get()?.seq ?? null
  );
}

interface Snapshot {
  rows: unknown[];
  columns: unknown[];
  indexes: ReturnType<typeof indexes>;
  indexSql: Record<string, string | null>;
  sequence: number | null;
  maxId: number;
}

function snapshot(db: Database): Snapshot {
  const idx = indexes(db, "web_sessions");
  return {
    rows: allRows(db),
    columns: columns(db, "web_sessions"),
    indexes: idx,
    indexSql: Object.fromEntries(idx.map((i) => [i.name, storedSql(db, i.name)])),
    sequence: sequence(db),
    maxId: db.query<{ m: number }, []>("SELECT MAX(id) AS m FROM web_sessions").get()?.m ?? 0,
  };
}

function seeded(): Database {
  const db = dbBeforeTarget();
  for (const statement of seedStatements()) db.run(statement);
  return db;
}

function migrated(): { db: Database; before: Snapshot } {
  const db = seeded();
  const before = snapshot(db);
  // D1 enforces foreign keys, so the rebuild runs with them on here too: the
  // DROP and RENAME must hold up under the same rules production applies.
  db.run("PRAGMA foreign_keys = ON");
  applyByStatement(db);
  return { db, before };
}

function firstUserId(db: Database): number {
  return db.query<{ id: number }, []>("SELECT id FROM users ORDER BY id LIMIT 1").get()?.id ?? 0;
}

// --------------------------------------------------------------------------
// bun:sqlite, one statement at a time
// --------------------------------------------------------------------------

describe("migration 0089: the file itself", () => {
  test("the splitter sees every statement, so the per-statement runs below run all of it", () => {
    expect(statements(TARGET_SQL)).toHaveLength(14);
  });
});

describe("migration 0089: the rebuild changes no existing session", () => {
  test("every row survives with every column value, ids included", () => {
    const { db, before } = migrated();
    expect(before.rows).toHaveLength(7);
    expect(allRows(db)).toEqual(before.rows);
  });

  test("the columns keep their order, types, defaults and nullability", () => {
    const { db, before } = migrated();
    expect(columns(db, "web_sessions")).toEqual(before.columns);
  });

  test("the table is still AUTOINCREMENT, with the same key and constraints", () => {
    const { db } = migrated();
    const sql = storedSql(db, "web_sessions") ?? "";
    expect(sql).toMatch(/id INTEGER PRIMARY KEY AUTOINCREMENT/);
    expect(sql).toMatch(/cookie_id_hash TEXT NOT NULL UNIQUE/);
  });

  test("every pre-existing index survives, identical in shape and stored SQL", () => {
    // `index_list` (unique, origin, partial) and `index_xinfo` (every column,
    // key or not, with its collation and order) for each index, plus the
    // stored CREATE text byte for byte. The new private-scope index is the only
    // addition allowed.
    const { db, before } = migrated();
    const after = snapshot(db);
    const added = after.indexes.filter((i) => !before.indexes.some((b) => b.name === i.name));
    expect(added.map((i) => i.name)).toEqual(["idx_web_sessions_private_scope"]);
    expect(after.indexes.filter((i) => i.name !== "idx_web_sessions_private_scope")).toEqual(
      before.indexes,
    );
    for (const [name, sql] of Object.entries(before.indexSql)) {
      expect({ name, sql: after.indexSql[name] }).toEqual({ name, sql });
    }
    expect(before.indexes.map((i) => i.name)).toEqual([
      "idx_web_sessions_docs_scope",
      "idx_web_sessions_user_active",
      "sqlite_autoindex_web_sessions_1",
    ]);
  });

  test("the foreign key to users, with its cascade, is kept", () => {
    const { db } = migrated();
    expect(db.query("PRAGMA foreign_key_list(web_sessions)").all()).toMatchObject([
      { table: "users", from: "user_id", to: "id", on_delete: "CASCADE" },
    ]);
  });

  test("cookie_id_hash is still unique", () => {
    const { db } = migrated();
    expect(() =>
      db.run(
        "INSERT INTO web_sessions (user_id, cookie_id_hash, expires_at) VALUES (?, 'h-app-live', '2099-01-01 00:00:00')",
        [firstUserId(db)],
      ),
    ).toThrow(/UNIQUE/);
  });

  test("the sequence is reseeded at the highest surviving id, as the header documents", () => {
    const { db, before } = migrated();
    // The seed left the sequence two ahead of the surviving rows...
    expect(before.sequence).toBe(before.maxId + 2);
    // ...and the copy reseeds it at the highest copied id.
    expect(sequence(db)).toBe(before.maxId);
    db.run(
      "INSERT INTO web_sessions (user_id, cookie_id_hash, expires_at) VALUES (?, 'h-new', '2099-01-01 00:00:00')",
      [firstUserId(db)],
    );
    const fresh = db
      .query<{ id: number }, []>("SELECT id FROM web_sessions WHERE cookie_id_hash = 'h-new'")
      .get();
    expect(fresh?.id).toBe(before.maxId + 1);
  });

  test("the scratch objects are gone", () => {
    const { db } = migrated();
    const leftovers = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE name IN ('web_sessions_new', '_rebuild_guard')",
      )
      .all();
    expect(leftovers).toEqual([]);
  });
});

describe("migration 0089: the guard stops the DROP on its own", () => {
  // No transaction to fall back on here: each statement lands as it runs, the
  // way a non-transactional runner would apply the file.
  for (const [what, injection] of [
    [
      "short (a row missing)",
      "DELETE FROM web_sessions_new WHERE cookie_id_hash = 'h-app-revoked';",
    ],
    [
      "altered (same count, one value changed)",
      "UPDATE web_sessions_new SET revoked_at = NULL WHERE cookie_id_hash = 'h-app-revoked';",
    ],
  ] as const) {
    test(`a copy that is ${what} fails the guard before the DROP`, () => {
      const db = seeded();
      const before = allRows(db);
      db.run("PRAGMA foreign_keys = ON");
      expect(() => applyByStatement(db, withInjection(TARGET_SQL, injection))).toThrow(
        /CHECK constraint failed/,
      );
      // The live table was never dropped, and every row in it is as it was.
      expect(allRows(db)).toEqual(before);
      expect(storedSql(db, "web_sessions_new")).not.toBeNull();
    });
  }
});

describe("migration 0089: the new scope", () => {
  test("the CHECK admits app, docs and private, and nothing else", () => {
    const { db } = migrated();
    const insert = (scope: string) =>
      db.run(
        "INSERT INTO web_sessions (user_id, cookie_id_hash, expires_at, scope) VALUES (?, ?, '2099-01-01 00:00:00', ?)",
        [firstUserId(db), `h-probe-${scope}`, scope],
      );
    for (const scope of ["app", "docs", "private"]) expect(() => insert(scope)).not.toThrow();
    for (const scope of ["admin", "bogus", ""]) expect(() => insert(scope)).toThrow(/CHECK/);
  });

  test("an unspecified scope still defaults to 'app'", () => {
    const { db } = migrated();
    db.run(
      "INSERT INTO web_sessions (user_id, cookie_id_hash, expires_at) VALUES (?, 'h-default', '2099-01-01 00:00:00')",
      [firstUserId(db)],
    );
    const row = db
      .query<{ scope: string }, []>(
        "SELECT scope FROM web_sessions WHERE cookie_id_hash = 'h-default'",
      )
      .get();
    expect(row?.scope).toBe("app");
  });

  test("the private-scope partial index is exactly as declared", () => {
    const { db } = migrated();
    expect(storedSql(db, "idx_web_sessions_private_scope")).toBe(
      "CREATE INDEX idx_web_sessions_private_scope\n  ON web_sessions(user_id, expires_at) WHERE scope = 'private'",
    );
    const entry = indexes(db, "web_sessions").find(
      (i) => i.name === "idx_web_sessions_private_scope",
    );
    expect(entry).toMatchObject({ unique: 0, origin: "c", partial: 1 });
  });
});

describe("migration 0089: private_grants", () => {
  test("is shaped like docs_grants", () => {
    const { db } = migrated();
    expect(columns(db, "private_grants")).toEqual(columns(db, "docs_grants"));
    expect(db.query("PRAGMA foreign_key_list(private_grants)").all()).toEqual(
      db.query("PRAGMA foreign_key_list(docs_grants)").all(),
    );
  });

  test("has its expiry index for the prune, exactly as declared", () => {
    const { db } = migrated();
    expect(storedSql(db, "idx_private_grants_expires")).toBe(
      "CREATE INDEX idx_private_grants_expires ON private_grants(expires_at)",
    );
  });

  test("a grant dies with its user row", () => {
    const { db } = migrated();
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified)
       VALUES ('mig-grant', 'mig-grant@nemar.test', 'x', 'approved', 'member', 'web', 1)`,
    );
    const id =
      db.query<{ id: number }, []>("SELECT id FROM users WHERE username = 'mig-grant'").get()?.id ??
      0;
    db.run(
      "INSERT INTO private_grants (code_hash, user_id, expires_at) VALUES ('c1', ?, '2099-01-01 00:00:00')",
      [id],
    );
    db.run("DELETE FROM users WHERE id = ?", [id]);
    const n = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM private_grants").get()?.n;
    expect(n).toBe(0);
  });
});

// --------------------------------------------------------------------------
// Miniflare D1, the file in one call
// --------------------------------------------------------------------------

describe("migration 0089 on Miniflare D1", () => {
  let mf: Miniflare;

  /** A fresh database per test, migrated to 0088 and seeded. */
  let counter = 0;
  async function seededD1(): Promise<D1Database> {
    counter += 1;
    const d1 = (await mf.getD1Database(`DB${counter}`)) as unknown as D1Database;
    await applyMigrations(d1, BEFORE_TARGET);
    for (const statement of seedStatements()) await d1.prepare(statement).run();
    return d1;
  }

  async function rows(d1: D1Database): Promise<unknown[]> {
    return (await d1.prepare("SELECT * FROM web_sessions ORDER BY id").all()).results;
  }

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
      compatibilityDate: "2024-12-01",
      d1Databases: ["DB1", "DB2", "DB3"],
    });
  });

  afterAll(async () => {
    await mf?.dispose();
  });

  for (const [what, injection] of [
    ["a short", "DELETE FROM web_sessions_new WHERE cookie_id_hash = 'h-app-revoked';"],
    [
      "an altered",
      "UPDATE web_sessions_new SET revoked_at = NULL WHERE cookie_id_hash = 'h-app-revoked';",
    ],
  ] as const) {
    test(`${what} copy fails the file with the guard's CHECK, and web_sessions is untouched`, async () => {
      const d1 = await seededD1();
      const before = await rows(d1);
      await expect(
        d1.prepare(migrationCall(withInjection(TARGET_SQL, injection))).run(),
      ).rejects.toThrow(/CHECK constraint failed/);
      expect(await rows(d1)).toEqual(before);
      // The whole call rolled back: not even the scratch tables remain.
      const scratch = await d1
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('web_sessions_new', '_rebuild_guard', 'private_grants')",
        )
        .all();
      expect(scratch.results).toEqual([]);
    });
  }

  test("the unaltered file applies and every row survives", async () => {
    const d1 = await seededD1();
    const before = await rows(d1);
    expect(before).toHaveLength(7);
    await d1.prepare(migrationCall(TARGET_SQL)).run();
    expect(await rows(d1)).toEqual(before);
  });
});
