/**
 * Migration 0131_compute_access.sql (epic #2021 phase D1, #2022; ADR 0118, the compute-access
 * addendum), on two engines: bun:sqlite, which every other suite uses, and Miniflare's D1, the
 * implementation `wrangler --local` runs. bun:sqlite is more permissive than the SQLite D1 ships
 * (a GLOB that D1 calls too complex, a construct it compiles differently), so a CHECK or an index
 * proven only on the first is not proven.
 *
 * What is pinned: a row that existed before the migration reads `none` with every stamp NULL (the
 * migration is applied to a database that already holds users); the state CHECK takes exactly the
 * six words of `shared/compute-access-state.ts` and refuses `granted` and the others; the purpose
 * is NULL or 20 to 1000 characters (a 19-character one and a 1001-character one are refused); the
 * terms version is NULL or 1 to 32 characters of letters, digits and `. _ -`; the partial index
 * covers exactly the open requests.
 *
 * MUTATIONS (each applied to the migration text, run, and restored): widen the state CHECK with
 * `'granted'`; change the purpose minimum from 20 to 19; drop the terms-version GLOB; drop the
 * partial index's WHERE.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { COMPUTE_ACCESS_STATES } from "../../shared/compute-access-state";
import { COMPUTE_TERMS_VERSION } from "../../shared/contract/compute-terms";
import { MIGRATIONS_DIR, applyMigrations, migrationFiles } from "./helpers/miniflare-d1";

const FILE = "0131_compute_access.sql";
const SQL = readFileSync(join(MIGRATIONS_DIR, FILE), "utf-8");

interface Engine {
  name: string;
  run(sql: string, ...binds: unknown[]): Promise<string | null>;
  all<T>(sql: string, ...binds: unknown[]): Promise<T[]>;
  reset(): Promise<void>;
}

const BEFORE = migrationFiles().filter((f) => f < FILE);

/** bun:sqlite with every migration BELOW this one applied, a user inserted, then this one. */
function sqliteEngine(): Engine {
  const db = new Database(":memory:");
  for (const f of BEFORE) db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
  db.run(
    "INSERT INTO users (username, email, password_hash, status, role) VALUES ('before', 'before@example.org', 'x', 'verified', 'member')",
  );
  db.exec(SQL);
  for (const f of migrationFiles().filter((n) => n > FILE)) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
  }
  return {
    name: "bun:sqlite",
    async run(sql, ...binds) {
      try {
        db.prepare(sql).run(...(binds as never[]));
        return null;
      } catch (err) {
        return String(err);
      }
    },
    async all<T>(sql: string, ...binds: unknown[]) {
      return db.prepare(sql).all(...(binds as never[])) as T[];
    },
    async reset() {
      db.exec("DELETE FROM users WHERE username <> 'before'");
    },
  };
}

const ENGINES: Engine[] = [];
let mf: Miniflare;
let d1: D1Database;

beforeAll(async () => {
  ENGINES.push(sqliteEngine());
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
    compatibilityDate: "2024-12-01",
    d1Databases: ["DB"],
  });
  d1 = await mf.getD1Database("DB");
  await applyMigrations(d1, BEFORE);
  await d1
    .prepare(
      "INSERT INTO users (username, email, password_hash, status, role) VALUES ('before', 'before@example.org', 'x', 'verified', 'member')",
    )
    .run();
  await applyMigrations(d1, [FILE]);
  await applyMigrations(
    d1,
    migrationFiles().filter((n) => n > FILE),
  );
  ENGINES.push({
    name: "Miniflare D1",
    async run(sql, ...binds) {
      try {
        await d1
          .prepare(sql)
          .bind(...binds)
          .run();
        return null;
      } catch (err) {
        return String(err);
      }
    },
    async all<T>(sql: string, ...binds: unknown[]) {
      return (
        await d1
          .prepare(sql)
          .bind(...binds)
          .all<T>()
      ).results;
    },
    async reset() {
      await d1.prepare("DELETE FROM users WHERE username <> 'before'").run();
    },
  });
});

afterAll(async () => {
  await mf?.dispose();
});

function onEveryEngine(name: string, body: (e: Engine) => Promise<void>) {
  test(name, async () => {
    expect(ENGINES).toHaveLength(2);
    for (const e of ENGINES) {
      await e.reset();
      try {
        await body(e);
      } catch (err) {
        throw new Error(`${e.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
}

const CHECK = /CHECK constraint failed/;
let seq = 0;

/** Insert a user carrying the given compute columns; null on success, the engine's error otherwise. */
function insertUser(e: Engine, columns: Record<string, unknown> = {}): Promise<string | null> {
  seq += 1;
  const row: Record<string, unknown> = {
    username: `cu${seq}`,
    email: `cu${seq}@example.org`,
    password_hash: "x",
    status: "verified",
    role: "member",
    ...columns,
  };
  const names = Object.keys(row);
  return e.run(
    `INSERT INTO users (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    ...names.map((n) => row[n]),
  );
}

describe("the file says the shared words", () => {
  test("the state CHECK lists exactly the six states", () => {
    const m = /compute_access TEXT NOT NULL DEFAULT 'none'\s+CHECK \(compute_access IN \(([^)]*)\)\)/.exec(
      SQL,
    );
    const words = [...(m?.[1] ?? "").matchAll(/'([a-z]+)'/g)].map((x) => x[1] as string);
    expect(words.sort()).toEqual([...COMPUTE_ACCESS_STATES].sort());
  });

  test("the current terms version fits the version column's own CHECK", () => {
    expect(COMPUTE_TERMS_VERSION).toMatch(/^[0-9A-Za-z._-]{1,32}$/);
  });

  test("every GLOB pattern is within D1's 50 characters, and the file is the next number", () => {
    for (const m of SQL.matchAll(/GLOB '([^']*)'/g)) {
      expect((m[1] as string).length).toBeLessThanOrEqual(50);
    }
    const numbers = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => Number.parseInt(f.slice(0, 4), 10));
    expect(numbers).toContain(131);
    // 0125 to 0129 stay unused: a number below an applied one is a hazard (deploy applies by name).
    for (const n of [125, 126, 127, 128, 129]) expect(numbers).not.toContain(n);
  });
});

describe("the migration leaves every existing account as it was", () => {
  onEveryEngine("a row that predates it reads none, with every stamp NULL", async (e) => {
    const rows = await e.all<Record<string, unknown>>(
      `SELECT compute_access, compute_access_requested_at, compute_access_notified_at,
              compute_access_granted_at, compute_access_granted_by, compute_purpose,
              compute_terms_version, compute_terms_accepted_at
         FROM users WHERE username = 'before'`,
    );
    expect(rows).toEqual([
      {
        compute_access: "none",
        compute_access_requested_at: null,
        compute_access_notified_at: null,
        compute_access_granted_at: null,
        compute_access_granted_by: null,
        compute_purpose: null,
        compute_terms_version: null,
        compute_terms_accepted_at: null,
      },
    ]);
  });

  onEveryEngine("a new row with no compute column reads none", async (e) => {
    expect(await insertUser(e)).toBeNull();
    const [row] = await e.all<{ compute_access: string }>(
      "SELECT compute_access FROM users WHERE username = ?",
      `cu${seq}`,
    );
    expect(row?.compute_access).toBe("none");
  });
});

describe("the state CHECK", () => {
  onEveryEngine("takes each of the six states", async (e) => {
    for (const state of COMPUTE_ACCESS_STATES) {
      expect([state, await insertUser(e, { compute_access: state })]).toEqual([state, null]);
    }
  });

  onEveryEngine("refuses granted and every word that is not a state", async (e) => {
    for (const bad of ["granted", "approved", "Active", "ACTIVE", "", " active", "active "]) {
      expect([bad, await insertUser(e, { compute_access: bad })]).toEqual([
        bad,
        expect.stringMatching(CHECK),
      ]);
    }
  });

  onEveryEngine("refuses NULL: the column is NOT NULL", async (e) => {
    expect(await insertUser(e, { compute_access: null })).toMatch(/NOT NULL constraint failed/);
  });
});

describe("the purpose", () => {
  onEveryEngine("takes NULL, 20 characters and 1000 characters", async (e) => {
    expect(await insertUser(e, { compute_purpose: null })).toBeNull();
    expect(await insertUser(e, { compute_purpose: "x".repeat(20) })).toBeNull();
    expect(await insertUser(e, { compute_purpose: "x".repeat(1000) })).toBeNull();
  });

  onEveryEngine("refuses 19 characters, 1001 characters and the empty text", async (e) => {
    for (const bad of ["x".repeat(19), "x".repeat(1001), ""]) {
      expect([bad.length, await insertUser(e, { compute_purpose: bad })]).toEqual([
        bad.length,
        expect.stringMatching(CHECK),
      ]);
    }
  });
});

describe("the terms version", () => {
  onEveryEngine("takes a short word of letters, digits and . _ -", async (e) => {
    for (const ok of [COMPUTE_TERMS_VERSION, "1", "v2.0_a-b", "A".repeat(32)]) {
      expect([ok, await insertUser(e, { compute_terms_version: ok })]).toEqual([ok, null]);
    }
  });

  onEveryEngine("refuses 33 characters, the empty text and anything else", async (e) => {
    for (const bad of ["A".repeat(33), "", "a b", "a/b", "a;b", "été", "a\nb"]) {
      expect([bad, await insertUser(e, { compute_terms_version: bad })]).toEqual([
        bad,
        expect.stringMatching(CHECK),
      ]);
    }
  });
});

describe("the open-request index", () => {
  onEveryEngine("exists, is partial, and covers exactly the requested rows", async (e) => {
    const [index] = await e.all<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_compute_access_requested'",
    );
    expect(index?.sql).toContain("WHERE compute_access = 'requested'");
    expect(index?.sql).toContain("compute_access_requested_at");
  });
});
