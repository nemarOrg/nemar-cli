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
        // Internal-only: what `batch()` below actually calls. Not part of
        // the public D1PreparedStatement surface, so it is not typed on the
        // return value -- `batch()` reaches it directly on this closure.
        __execForBatch() {
          // Real D1 runs every statement in a batch as if `.all()` had been
          // called on it (Cloudflare's own documented behavior), REGARDLESS
          // of whether the statement is a read or a write -- a `D1Result`
          // always carries `results` (rows, empty for a write with no
          // RETURNING clause) alongside `meta`. bun:sqlite's `.all()` on an
          // INSERT/UPDATE/DELETE executes it exactly once (same as `.run()`
          // would) and simply returns `[]`; calling `.run()` afterward would
          // be a SECOND execution and must never happen. `changes()` /
          // `last_insert_rowid()` are read as a follow-up SQL query on the
          // same connection -- both reflect the statement that just ran,
          // for a write or a read alike, so this works uniformly for every
          // statement in a batch, not just the ones this test suite happens
          // to put first.
          const results = stmt.all(...(bound as never[]));
          const meta = db
            .query("SELECT changes() AS changes, last_insert_rowid() AS last_row_id")
            .get() as { changes: number; last_row_id: number };
          return {
            success: true,
            results,
            meta: { changes: meta.changes, last_row_id: meta.last_row_id },
          };
        },
      };
      return api;
    },
    // D1 batch = one implicit transaction; mirror that so route code using
    // db.batch() (e.g. relinkIdentity, #913; the device-auth mint pair,
    // #1281) keeps its all-or-nothing semantics AND its read-back semantics
    // (a SELECT queued alongside a write sees that write's row) under this
    // passthrough too.
    async batch(stmts: { __execForBatch(): unknown }[]) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const s of stmts) results.push(s.__execForBatch());
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Database;
}
