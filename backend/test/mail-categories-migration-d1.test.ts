/**
 * Migration 0146_mail_categories.sql (epic #2260 phase 1, ADR 0132).
 *
 * Real engine, no mocks: every migration EXCEPT 0146 is applied to an in-memory bun:sqlite
 * database, rows are seeded at the pre-0146 schema, then 0146 is applied and its rules are
 * asserted against the real SQL. bun:sqlite is more lenient than D1 (a green run here is not D1
 * proof), so the migration is also replayed on D1's own engine by `bun run migrations:d1-check`
 * and the seeded cases below are re-run there by hand; see the phase PR.
 *
 * What the migration must do: carry each live row's `announcements` value into `news`, `rfcs` and
 * `maintenance` explicitly, keep the retired key (0148 drops it a release later), leave every other key and every deleted row
 * alone, write ONE summary audit row, tolerate every shape the column can hold, and be safe to
 * run twice. It must also leave legacy broadcast rows readable as uncategorized and let the
 * outcome table record `skipped`.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { COMMUNITY_MAIL_CATEGORIES } from "../../shared/contract/mail-categories.js";
import { parseEmailPreferences } from "../src/services/email";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");
const TARGET = "0146_mail_categories.sql";
const TARGET_SQL = readFileSync(join(MIGRATIONS_DIR, TARGET), "utf-8");
/** The data half of the migration: everything before the schema changes, which cannot run twice. */
const DATA_HALF = TARGET_SQL.slice(0, TARGET_SQL.indexOf("ALTER TABLE broadcast_emails"));

function dbBeforeTarget(): Database {
  const db = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f < TARGET)
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  return db;
}

interface Seed {
  name: string;
  /** The raw column value: a string of JSON (or not), or null. */
  prefs: string | null;
  deleted?: boolean;
}

/** One row per shape the column can hold. `name` is the username. */
const SEEDS: Seed[] = [
  { name: "never_chose", prefs: null },
  { name: "ann_false", prefs: '{"announcements":false}' },
  { name: "ann_true", prefs: '{"announcements":true}' },
  { name: "ann_absent", prefs: '{"user_approval":false}' },
  // The other keys are somebody's real choices: the carry must not touch them.
  {
    name: "alerts_kept",
    prefs: '{"user_approval":false,"support_tickets":false,"announcements":false}',
  },
  // Only strict JSON false is an opt-out, exactly as the parser reads every key (`!== false`).
  { name: "ann_zero", prefs: '{"announcements":0}' },
  { name: "ann_string_false", prefs: '{"announcements":"false"}' },
  { name: "ann_null", prefs: '{"announcements":null}' },
  // Shapes that are not an object with a key. The parser reads all of them as "all on".
  { name: "corrupt", prefs: "{not json" },
  { name: "empty_text", prefs: "" },
  { name: "json_string", prefs: '"announcements"' },
  { name: "json_array", prefs: "[false]" },
  { name: "empty_object", prefs: "{}" },
  // A deleted row is not an account: untouched, even when its column is garbage.
  { name: "gone_corrupt", prefs: "{still not json", deleted: true },
  { name: "gone_ann_false", prefs: '{"announcements":false}', deleted: true },
];

function seed(): Database {
  const db = dbBeforeTarget();
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
    db
      .query<{ email_preferences: string | null }, [string]>(
        "SELECT email_preferences FROM users WHERE username = ?",
      )
      .get(name)?.email_preferences ?? null
  );
}

function stored(db: Database, name: string): Record<string, unknown> {
  const value = raw(db, name);
  if (value === null) throw new Error(`${name} has no stored preferences`);
  return JSON.parse(value);
}

describe("0146 carries announcements into the three categories", () => {
  const db = seed();
  // The schema's own bootstrap rows (a system account) are live users too, so count them rather
  // than assume the seeds are the only ones.
  const liveBefore = db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM users WHERE deleted_at IS NULL")
    .get()?.n;
  db.exec(TARGET_SQL);

  test("an account that opted out of announcements is opted out of all three, explicitly", () => {
    expect(stored(db, "ann_false")).toEqual({
      announcements: false,
      news: false,
      rfcs: false,
      maintenance: false,
    });
  });

  test("an account that had them on gets all three on, explicitly (the consent record)", () => {
    expect(stored(db, "ann_true")).toEqual({
      announcements: true,
      news: true,
      rfcs: true,
      maintenance: true,
    });
  });

  test("a NULL, an absent key and an empty object all become explicit all-on", () => {
    for (const name of ["never_chose", "ann_absent", "empty_object"]) {
      expect(stored(db, name)).toMatchObject({ news: true, rfcs: true, maintenance: true });
    }
  });

  test("only JSON false opts out: 0, the string 'false' and null do not", () => {
    // json_extract() returns 0 for JSON false AND for a JSON 0, so a carry written on it would
    // have turned mail off for these accounts. The parser reads `!== false`; so does the SQL.
    for (const name of ["ann_zero", "ann_string_false", "ann_null"]) {
      expect(stored(db, name)).toMatchObject({ news: true, rfcs: true, maintenance: true });
    }
  });

  test("other keys survive the carry", () => {
    expect(stored(db, "alerts_kept")).toEqual({
      user_approval: false,
      support_tickets: false,
      announcements: false,
      news: false,
      rfcs: false,
      maintenance: false,
    });
    expect(stored(db, "ann_absent")).toMatchObject({ user_approval: false });
  });

  test("the previous worker's rule still reads every opted-out row as opted out (deploy window)", () => {
    // Migrations apply seconds before the new worker deploys, and the previous worker reads
    // `announcements` (`!== false`, a missing key as ON). The migration keeps that key unchanged,
    // so a notify in the window reaches exactly the accounts it would have reached before 0146.
    // Deleting the key would make every opted-out row read as ON to that worker.
    for (const s of SEEDS.filter((x) => !x.deleted)) {
      const before = (() => {
        if (s.prefs === null || s.prefs === "") return true;
        try {
          return JSON.parse(s.prefs)?.announcements !== false;
        } catch {
          return true;
        }
      })();
      const rawValue = raw(db, s.name);
      const after = (() => {
        try {
          return JSON.parse(rawValue ?? "{}")?.announcements !== false;
        } catch {
          return true;
        }
      })();
      expect({ seed: s.name, announcementsOn: after }).toEqual({
        seed: s.name,
        announcementsOn: before,
      });
    }
    expect(stored(db, "ann_false").announcements).toBe(false);
  });

  test("a column that is not a JSON object is replaced by explicit all-on", () => {
    for (const name of ["corrupt", "empty_text", "json_string", "json_array"]) {
      expect(stored(db, name)).toEqual({ news: true, rfcs: true, maintenance: true });
    }
  });

  test("a deleted row is left exactly as it was, garbage included", () => {
    expect(raw(db, "gone_corrupt")).toBe("{still not json");
    expect(raw(db, "gone_ann_false")).toBe('{"announcements":false}');
  });

  test("the parser the code uses reads every migrated row as the same choice the SQL wrote", () => {
    // The migration and parseEmailPreferences are two implementations of one rule; this holds
    // them to each other for every live seed.
    for (const s of SEEDS.filter((x) => !x.deleted)) {
      const before = (() => {
        // What the OLD parser said announcements was for this raw value.
        if (s.prefs === null || s.prefs === "") return true;
        try {
          const parsed = JSON.parse(s.prefs);
          return parsed?.announcements !== false;
        } catch {
          return true;
        }
      })();
      const after = parseEmailPreferences(raw(db, s.name));
      for (const category of COMMUNITY_MAIL_CATEGORIES) {
        expect({ seed: s.name, category, on: after[category] }).toEqual({
          seed: s.name,
          category,
          on: before,
        });
      }
    }
  });

  test("one summary audit row records the carry, not one row per account", () => {
    const rows = db
      .query<{ user_id: number | null; resource_type: string; details: string }, []>(
        "SELECT user_id, resource_type, details FROM audit_log WHERE action = 'mail_category_changed'",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBeNull();
    expect(rows[0].resource_type).toBe("migration");
    expect(liveBefore).toBeGreaterThanOrEqual(SEEDS.filter((s) => !s.deleted).length);
    expect(JSON.parse(rows[0].details)).toEqual({
      via: "migration",
      categories: ["news", "rfcs", "maintenance"],
      carried: liveBefore,
      // ann_false and alerts_kept carry an announcements:false; the deleted row does not count.
      opted_out: 2,
    });
  });
});

describe("0146 is safe to run twice", () => {
  test("a second run does not turn a later opt-out back on, and writes no second audit row", () => {
    const db = seed();
    db.exec(TARGET_SQL);
    // After the migration a person turns news off through the app.
    db.query(
      `UPDATE users SET email_preferences = '{"news":false,"rfcs":true,"maintenance":true}' WHERE username = 'ann_true'`,
    ).run();
    db.exec(DATA_HALF);
    expect(stored(db, "ann_true")).toEqual({ news: false, rfcs: true, maintenance: true });
    const audits = db
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM audit_log WHERE action = 'mail_category_changed'",
      )
      .get();
    expect(audits?.n).toBe(1);
  });
});

describe("0146 on a database where nobody stored a preference", () => {
  test("it writes no audit row, so every fresh test database stays free of one", () => {
    // Every test database runs this migration. A summary row on an empty history would sit at the
    // head of audit_log in each of them and break any test that lists the table.
    const db = dbBeforeTarget();
    db.exec(TARGET_SQL);
    const audits = db
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM audit_log WHERE action = 'mail_category_changed'",
      )
      .get();
    expect(audits?.n).toBe(0);
  });
});

describe("0146 broadcast schema", () => {
  test("a legacy broadcast row reads as uncategorized, with nothing skipped", () => {
    const db = dbBeforeTarget();
    const sender = db
      .query(
        "INSERT INTO users (username, email, status) VALUES ('sender', 's@example.test', 'approved') RETURNING id",
      )
      .get() as { id: number };
    db.query(
      `INSERT INTO broadcast_emails (sent_by, recipient_group, subject, body_markdown, recipient_count)
       VALUES (?, 'all', 'legacy', 'body', 3)`,
    ).run(sender.id);
    db.exec(TARGET_SQL);
    const row = db
      .query<
        { category: string | null; recall_reference: string | null; skipped_count: number },
        []
      >(
        "SELECT category, recall_reference, skipped_count FROM broadcast_emails WHERE subject = 'legacy'",
      )
      .get();
    expect(row).toEqual({ category: null, recall_reference: null, skipped_count: 0 });
  });

  test("the category column accepts the four categories and refuses anything else", () => {
    const db = seed();
    db.exec(TARGET_SQL);
    const sender = db.query("SELECT id FROM users WHERE username = 'never_chose'").get() as {
      id: number;
    };
    const insert = (category: string) =>
      db
        .query(
          `INSERT INTO broadcast_emails (sent_by, recipient_group, subject, body_markdown, recipient_count, category)
           VALUES (?, 'all', 's', 'b', 0, ?)`,
        )
        .run(sender.id, category);
    for (const category of ["news", "rfcs", "maintenance", "recall"]) {
      expect(() => insert(category)).not.toThrow();
    }
    expect(() => insert("announcements")).toThrow();
  });

  test("the outcome table keeps its rows through the rebuild and now accepts 'skipped'", () => {
    const db = dbBeforeTarget();
    db.query(
      "INSERT INTO broadcast_outcomes (broadcast_id, recipient_hash, outcome) VALUES (7, 'aa', 'delivered'), (7, 'bb', 'failed')",
    ).run();
    db.exec(TARGET_SQL);
    const kept = db
      .query<{ recipient_hash: string; outcome: string }, []>(
        "SELECT recipient_hash, outcome FROM broadcast_outcomes ORDER BY recipient_hash",
      )
      .all();
    expect(kept).toEqual([
      { recipient_hash: "aa", outcome: "delivered" },
      { recipient_hash: "bb", outcome: "failed" },
    ]);
    expect(() =>
      db
        .query(
          "INSERT INTO broadcast_outcomes (broadcast_id, recipient_hash, outcome) VALUES (7, 'cc', 'skipped')",
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      db
        .query(
          "INSERT INTO broadcast_outcomes (broadcast_id, recipient_hash, outcome) VALUES (7, 'dd', 'bogus')",
        )
        .run(),
    ).toThrow();
    // The key is still the one-outcome-per-recipient guard the consumer's INSERT OR IGNORE relies on.
    expect(() =>
      db
        .query(
          "INSERT INTO broadcast_outcomes (broadcast_id, recipient_hash, outcome) VALUES (7, 'aa', 'failed')",
        )
        .run(),
    ).toThrow();
  });
});
