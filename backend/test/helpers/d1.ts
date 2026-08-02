// Shared real-engine test DB helpers for backend unit tests (#904).
//
// `freshDb()` applies every migration in order to an in-memory bun:sqlite
// database, so tests run against the production schema. `realD1()` is a
// thin D1-shaped passthrough over that database: not a mock — no canned
// responses; every result comes from SQLite executing the production SQL.
// Mirrors the per-file copies in hed-write.test.ts and the CLI package test/catalog-dual-write.test.ts
// (extracting those to this helper is deliberately out of scope for #904).

import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "../../src/db/migrations");

export function freshDb(): Database {
  const db = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  return db;
}

export function realD1(db: Database): D1Database {
  return {
    prepare(sql: string) {
      const stmt = db.query(sql);
      let bound: unknown[] = [];
      const api = {
        bind(...p: unknown[]) {
          bound = p;
          return api;
        },
        run() {
          const r = stmt.run(...(bound as never[]));
          return Promise.resolve({
            success: true,
            meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) },
          });
        },
        first<T>() {
          return Promise.resolve((stmt.get(...(bound as never[])) as T) ?? null);
        },
        all<T>() {
          return Promise.resolve({ results: stmt.all(...(bound as never[])) as T[] });
        },
      };
      return api;
    },
    // D1 batch = one implicit transaction; mirror that so route code using
    // db.batch() (e.g. relinkIdentity, #913) keeps its all-or-nothing
    // semantics under this passthrough too.
    async batch(stmts: { run(): Promise<unknown> }[]) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const s of stmts) results.push(await s.run());
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Database;
}
