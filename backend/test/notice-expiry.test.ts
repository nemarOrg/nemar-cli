/**
 * Integration test for issue #1024: notice expiry comparisons.
 *
 * Runs against a real in-memory SQLite database via bun:sqlite (no mocks).
 *
 * The bug: `getActiveNotices` filters with `expires_at > datetime('now')`.
 * Both sides are TEXT, so SQLite compares them byte-wise. `datetime('now')`
 * emits `YYYY-MM-DD HH:MM:SS` while `expires_at` was stored as RFC3339 with
 * a `T`. `T` (0x54) sorts after a space (0x20), so whenever the date halves
 * matched the ISO value always compared greater and an expired notice was
 * served as active until the next UTC day.
 *
 * Fixed by normalizing `expires_at` to the storage format on write
 * (`datetime(?)` in services/notices.ts, migration 0064 for existing rows)
 * and projecting timestamps back as explicit-UTC RFC3339.
 *
 * These tests exercise the real SQL, not a re-implementation: the queries
 * are read straight out of the built statements where practical, and the
 * comparison semantics are asserted against actual SQLite behaviour.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
// The real predicate and projection, imported rather than copied, so a
// change to the service that reintroduces the bug fails here.
import { NOTICE_ACTIVE_FILTER, NOTICE_COLUMNS } from "../src/services/notices";

/** Minimal notices table matching the schema after migration 0063. */
function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'tip'
        CHECK (level IN ('tip','announcement','maintenance','warning','critical')),
      scope TEXT NOT NULL DEFAULT 'all'
        CHECK (scope IN ('all','admins','members')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER NOT NULL,
      expires_at TEXT
    );
  `);
  return db;
}

const ACTIVE_FILTER = NOTICE_ACTIVE_FILTER;

describe("#1024 — the bug, reproduced", () => {
  // Pins the exact byte-comparison the fix exists to remove. If someone
  // "simplifies" the insert back to binding the raw ISO string, this is the
  // behaviour they would restore.
  test("a raw ISO expires_at compares greater than datetime('now') on the same day", () => {
    const db = freshDb();
    const sameDayAlreadyPast = db
      .prepare("SELECT (? > datetime('now')) AS wrong")
      .get(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`) as { wrong: number };
    // Midnight today has passed (unless the suite runs exactly at 00:00:00),
    // yet the raw ISO string still compares as "in the future".
    expect(sameDayAlreadyPast.wrong).toBe(1);
  });

  test("the same instant normalized through datetime() compares correctly", () => {
    const db = freshDb();
    const normalized = db
      .prepare("SELECT (datetime(?) > datetime('now')) AS active")
      .get(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`) as { active: number };
    expect(normalized.active).toBe(0);
  });
});

describe("#1024 — insert normalization", () => {
  let db: Database;
  const insert = (expires: string | null) =>
    db
      .prepare(
        "INSERT INTO notices (message, level, scope, created_by, expires_at) VALUES ('m','tip','all',1,datetime(?)) RETURNING expires_at",
      )
      .get(expires) as { expires_at: string | null };

  beforeEach(() => {
    db = freshDb();
  });

  test("stores a Z-suffixed value in the comparable storage format", () => {
    expect(insert("2026-10-31T00:00:00.000Z").expires_at).toBe("2026-10-31 00:00:00");
  });

  // An admin in Berlin picking 14:30 local must be stored as 12:30 UTC, not
  // as the wall-clock they typed.
  test("converts a non-UTC offset to UTC rather than dropping it", () => {
    expect(insert("2026-07-25T14:30:00+02:00").expires_at).toBe("2026-07-25 12:30:00");
  });

  test("keeps null as null (a notice that never expires)", () => {
    expect(insert(null).expires_at).toBeNull();
  });

  test("is idempotent on a value already in storage format", () => {
    expect(insert("2026-07-25 14:30:00").expires_at).toBe("2026-07-25 14:30:00");
  });
});

describe("#1024 — the active filter", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  function seed(label: string, expires: string | null): void {
    db.prepare(
      "INSERT INTO notices (message, level, scope, created_by, expires_at) VALUES (?,'tip','all',1,datetime(?))",
    ).run(label, expires);
  }

  function activeLabels(): string[] {
    return (
      db.prepare(`SELECT message FROM notices WHERE ${ACTIVE_FILTER} ORDER BY id`).all() as {
        message: string;
      }[]
    ).map((r) => r.message);
  }

  // The case the whole issue is about: "maintenance ends at 14:00 today".
  test("drops a notice that expired earlier today", () => {
    const today = new Date().toISOString().slice(0, 10);
    seed("expired-this-morning", `${today}T00:00:00.000Z`);
    seed("never", null);
    expect(activeLabels()).toEqual(["never"]);
  });

  test("keeps a notice expiring later today", () => {
    const later = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    seed("later-today", later);
    expect(activeLabels()).toEqual(["later-today"]);
  });

  test("drops a notice that expired on a previous day", () => {
    seed("old", "2020-01-01T00:00:00.000Z");
    expect(activeLabels()).toEqual([]);
  });

  test("keeps a far-future expiry and a null expiry", () => {
    seed("future", "2099-01-01T00:00:00.000Z");
    seed("never", null);
    expect(activeLabels()).toEqual(["future", "never"]);
  });
});

describe("#1024 — wire format", () => {
  // Storage is space-separated for comparability, but the API must return an
  // unambiguous instant: Date.parse("2026-07-25 14:30:00") is not ISO-8601
  // and is interpreted as LOCAL time by V8, silently shifting every consumer
  // by their own UTC offset.
  const PROJECTION = NOTICE_COLUMNS;

  test("projects both timestamps as explicit-UTC RFC3339", () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO notices (message, level, scope, created_by, created_at, expires_at) VALUES ('m','tip','all',1,'2026-07-20 08:00:00',datetime(?))",
    ).run("2026-10-31T00:00:00.000Z");
    const row = db.prepare(`SELECT ${PROJECTION} FROM notices`).get() as {
      created_at: string;
      expires_at: string;
    };
    expect(row.created_at).toBe("2026-07-20T08:00:00Z");
    expect(row.expires_at).toBe("2026-10-31T00:00:00Z");
    // The point of the Z: parsing must yield the same instant regardless of
    // the reader's timezone.
    expect(Date.parse(row.expires_at)).toBe(Date.parse("2026-10-31T00:00:00.000Z"));
  });

  test("leaves a null expiry null rather than emitting a bogus timestamp", () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO notices (message, level, scope, created_by) VALUES ('m','tip','all',1)",
    ).run();
    const row = db.prepare(`SELECT ${PROJECTION} FROM notices`).get() as {
      expires_at: string | null;
    };
    expect(row.expires_at).toBeNull();
  });
});

describe("#1024 — migration 0064 backfill", () => {
  const BACKFILL = `UPDATE notices SET expires_at = datetime(expires_at)
                     WHERE expires_at IS NOT NULL AND datetime(expires_at) IS NOT NULL`;

  test("normalizes legacy ISO rows and leaves null ones alone", () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO notices (message, level, scope, created_by, expires_at) VALUES ('iso','tip','all',1,'2026-10-31T00:00:00.000Z')",
    ).run();
    db.prepare(
      "INSERT INTO notices (message, level, scope, created_by, expires_at) VALUES ('none','tip','all',1,NULL)",
    ).run();
    db.exec(BACKFILL);
    const rows = db.prepare("SELECT message, expires_at FROM notices ORDER BY id").all() as {
      message: string;
      expires_at: string | null;
    }[];
    expect(rows).toEqual([
      { message: "iso", expires_at: "2026-10-31 00:00:00" },
      { message: "none", expires_at: null },
    ]);
  });

  // The guard that matters: datetime() returns NULL for an unparseable
  // string, and NULL means "never expires". Without the guard a malformed
  // timestamp would be silently promoted from expired to permanent — the
  // worst direction for a banner nobody can dismiss.
  test("leaves an unparseable timestamp untouched instead of nulling it", () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO notices (message, level, scope, created_by, expires_at) VALUES ('bad','tip','all',1,'not a date')",
    ).run();
    db.exec(BACKFILL);
    const row = db.prepare("SELECT expires_at FROM notices").get() as { expires_at: string | null };
    expect(row.expires_at).toBe("not a date");
  });

  test("is idempotent when re-run", () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO notices (message, level, scope, created_by, expires_at) VALUES ('iso','tip','all',1,'2026-10-31T00:00:00.000Z')",
    ).run();
    db.exec(BACKFILL);
    db.exec(BACKFILL);
    const row = db.prepare("SELECT expires_at FROM notices").get() as { expires_at: string };
    expect(row.expires_at).toBe("2026-10-31 00:00:00");
  });
});
