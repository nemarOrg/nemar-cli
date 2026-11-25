/**
 * Migration 0148_drop_announcements_key.sql (ADR 0132).
 *
 * Real engine, no mocks: every migration before 0148 is applied to an in-memory bun:sqlite
 * database, rows are seeded in every shape the column can hold, then 0148 is applied. bun:sqlite
 * is more lenient than D1, so `bun run migrations:d1-check` replays it on D1's engine too.
 *
 * What the migration must do: remove `announcements` from every row that holds it, keep every
 * other key byte-for-byte in meaning, leave non-object and corrupt values alone, change no
 * parsed preference, and be safe to run twice.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseEmailPreferences } from "../src/services/email";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");
const TARGET = "0148_drop_announcements_key.sql";
const TARGET_SQL = readFileSync(join(MIGRATIONS_DIR, TARGET), "utf-8");

const SEEDS: { name: string; prefs: string | null; deleted?: boolean }[] = [
  {
    name: "carried_off",
    prefs: '{"announcements":false,"news":false,"rfcs":false,"maintenance":false}',
  },
  {
    name: "carried_on",
    prefs: '{"announcements":true,"news":true,"rfcs":true,"maintenance":true}',
  },
  {
    name: "mixed",
    prefs:
      '{"user_approval":false,"announcements":false,"news":false,"rfcs":true,"maintenance":false}',
  },
  // Any value counts as holding the key: json_type answers "null", "text" or "integer" for these, not SQL NULL.
  { name: "ann_json_null", prefs: '{"announcements":null,"news":false}' },
  { name: "ann_string", prefs: '{"announcements":"false","news":true}' },
  { name: "ann_zero", prefs: '{"announcements":0,"news":true}' },
  { name: "no_key", prefs: '{"news":false,"support_tickets":false}' },
  { name: "never_chose", prefs: null },
  { name: "corrupt", prefs: "{not json" },
  { name: "empty_text", prefs: "" },
  { name: "json_string", prefs: '"announcements"' },
  { name: "json_array", prefs: '[{"announcements":false}]' },
  { name: "gone", prefs: '{"announcements":false,"news":false}', deleted: true },
];

function seeded(): Database {
  const db = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f < TARGET)
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  const insert = db.prepare(
    `INSERT INTO users (username, email, status, email_verified, email_preferences, deleted_at)
     VALUES (?, ?, 'approved', 1, ?, ?)`,
  );
  for (const s of SEEDS) {
    insert.run(s.name, `${s.name}@example.test`, s.prefs, s.deleted ? "2026-01-01 00:00:00" : null);
  }
  return db;
}

function raw(db: Database, name: string): string | null {
  return (
    db.prepare("SELECT email_preferences AS p FROM users WHERE username = ?").get(name) as {
      p: string | null;
    }
  ).p;
}

describe("0148 drops the retired announcements key", () => {
  test("no row holds the key afterwards, and every other key keeps its value", () => {
    const db = seeded();
    db.exec(TARGET_SQL);
    for (const s of SEEDS) {
      const before = s.prefs;
      const after = raw(db, s.name);
      let parsedBefore: unknown;
      try {
        parsedBefore = before === null ? null : JSON.parse(before);
      } catch {
        parsedBefore = undefined;
      }
      if (parsedBefore && typeof parsedBefore === "object" && !Array.isArray(parsedBefore)) {
        const { announcements: _dropped, ...rest } = parsedBefore as Record<string, unknown>;
        expect({ seed: s.name, value: JSON.parse(after ?? "null") }).toEqual({
          seed: s.name,
          value: rest,
        });
      } else {
        // NULL, corrupt text and non-object JSON are not touched at all.
        expect({ seed: s.name, value: after }).toEqual({ seed: s.name, value: before });
      }
    }
  });

  test("the other keys still parse to the same preferences (the parser itself ignores the dropped key)", () => {
    const db = seeded();
    const before = SEEDS.map((s) => parseEmailPreferences(raw(db, s.name)));
    db.exec(TARGET_SQL);
    const after = SEEDS.map((s) => parseEmailPreferences(raw(db, s.name)));
    expect(after).toEqual(before);
  });

  test("a second run changes nothing", () => {
    const db = seeded();
    db.exec(TARGET_SQL);
    const once = SEEDS.map((s) => raw(db, s.name));
    db.exec(TARGET_SQL);
    expect(SEEDS.map((s) => raw(db, s.name))).toEqual(once);
  });

  test("the rewritten rows are exactly the object rows that held the key", () => {
    const db = seeded();
    db.exec("CREATE TEMP TABLE changed (name TEXT)");
    db.exec(
      "CREATE TEMP TRIGGER t AFTER UPDATE OF email_preferences ON users BEGIN INSERT INTO changed VALUES (NEW.username); END",
    );
    db.exec(TARGET_SQL);
    const names = (
      db.prepare("SELECT name FROM changed ORDER BY name").all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual([
      "ann_json_null",
      "ann_string",
      "ann_zero",
      "carried_off",
      "carried_on",
      "gone",
      "mixed",
    ]);
  });
});
