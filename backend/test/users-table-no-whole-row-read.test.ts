/**
 * No code selects a whole row of `users` (ADR 0093).
 *
 * `users` carries credential columns (`password_hash`, `verification_token`, the
 * encrypted AWS pair). A query that selects the whole row hands every one of
 * them to whatever serialises the result, and `GET /admin/users/:username` did
 * exactly that for any admin until this guard's change. The fix is an explicit
 * column list; this test keeps the pattern from coming back anywhere in the
 * backend by scanning for it.
 *
 * A source scan, because the thing being forbidden is a SHAPE OF QUERY and no
 * route test can know which route will be written next. Comments are removed
 * first so a sentence explaining the rule does not trip it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "migrations" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** The code with block comments and whole-line `//` comments removed. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

// Two shapes, each a whole row of `users`:
//   1. `SELECT * FROM users`
//   2. `SELECT u.* ... FROM users u` (or JOIN), where `u` is the alias users was
//      given in that statement. Matching the alias, rather than any `x.*`, is
//      what lets `SELECT d.*, (SELECT username FROM users ...) FROM datasets d`
//      through: that reads one column of users.
const PLAIN_STAR_OF_USERS = /\bSELECT\s+(?:DISTINCT\s+)?\*\s+FROM\s+users\b/i;
const ALIAS_STAR_OF_USERS = /\b(\w+)\.\*[^;]*?\b(?:FROM|JOIN)\s+users\s+(?:AS\s+)?\1\b/i;

function readsWholeUserRow(sql: string): boolean {
  return PLAIN_STAR_OF_USERS.test(sql) || ALIAS_STAR_OF_USERS.test(sql);
}

describe("no query reads a whole row of users", () => {
  const files = sourceFiles(SRC);

  test("the scan covers the backend (guards a vacuous pass)", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith(join("routes", "admin", "users.ts")))).toBe(true);
  });

  test("the pattern catches the shapes it exists to forbid", () => {
    for (const bad of [
      "SELECT * FROM users WHERE id = ?",
      "SELECT u.* FROM users u",
      "select u.*,\n  (SELECT COUNT(*) FROM datasets) as n\n  FROM users u",
      "SELECT DISTINCT * FROM users",
      "SELECT x.* FROM datasets d JOIN users x ON x.id = d.owner_user_id",
    ]) {
      expect(readsWholeUserRow(bad), bad).toBe(true);
    }
    for (const fine of [
      "SELECT id, username FROM users",
      "SELECT COUNT(*) FROM users",
      "SELECT * FROM datasets WHERE dataset_id = ?",
      "SELECT d.*, (SELECT username FROM users WHERE id = d.owner_user_id) AS owner FROM datasets d",
      "SELECT d.* FROM datasets d JOIN users u ON u.id = d.owner_user_id",
    ]) {
      expect(readsWholeUserRow(fine), fine).toBe(false);
    }
  });

  test("no backend source file contains one", () => {
    const offenders = files.filter((file) =>
      readsWholeUserRow(withoutComments(readFileSync(file, "utf8"))),
    );
    expect(
      offenders.map((f) => f.slice(SRC.length + 1)),
      "Select the columns you need. The classification of users columns is USER_COLUMN_ROLES in services/user-search.ts.",
    ).toEqual([]);
  });
});
