// Apply migration files to a Miniflare D1 database: the D1 implementation
// `wrangler dev` and `wrangler d1 ... --local` run, in real workerd, rather
// than bun:sqlite.
//
// Each file is sent in ONE call, the way a migration reaches D1, with two
// changes to its text, neither of which touches a statement:
//   * full-line `--` comments are dropped, exactly as
//     `scripts/d1-migration-check.ts` drops them;
//   * `SELECT 1;` is appended, because a trailing inline comment after a
//     file's last statement otherwise reads as an empty statement and the
//     local runtime refuses the whole call.
// Miniflare runs the call as one transaction, so a failing file leaves
// nothing behind.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const MIGRATIONS_DIR = join(import.meta.dir, "../../src/db/migrations");

/** Every migration file name, in apply order. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** One migration's text as a single call Miniflare's D1 will take. */
export function migrationCall(sql: string): string {
  const body = sql
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
  return `${body}\nSELECT 1;`;
}

/** Apply the named files, in order, failing loudly on the first that D1 refuses. */
export async function applyMigrations(d1: D1Database, files: string[]): Promise<void> {
  for (const file of files) {
    try {
      await d1.prepare(migrationCall(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"))).run();
    } catch (err) {
      throw new Error(`migration ${file} failed on Miniflare D1: ${err}`);
    }
  }
}
