/**
 * The invariant is the database's, not the service's (#1407, epic #1406).
 *
 * Real engine: bun:sqlite with every migration applied, including 0085's
 * triggers, which is what these assert against directly. A service-level check
 * is one a future route can forget; this one it cannot, and that is worth
 * testing at the level where the rule actually lives.
 *
 * The WRITER-side blinding is tested in `anonymity-writers.test.ts`, driven
 * through the writes themselves, and the paths to publication in
 * `anonymity-publication-paths.test.ts`. An earlier version of this file
 * asserted the blinding by seeding a row with the value the writer was meant
 * to produce, which proved only that SQLite's FTS triggers work.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OWNER_GITHUB_SQL,
  OWNER_USERNAME_SQL,
  hasEverBeenPublished,
  isAnonymous,
} from "../src/services/anonymity";
import { freshDb } from "./helpers/d1";

function seedUser(db: Database): void {
  db.prepare(
    `INSERT INTO users (id, username, email, github_username, given_name, family_name, status, role)
     VALUES (7, 'realname', 'real@example.org', 'real-gh-handle', 'Ada', 'Lovelace', 'approved', 'user')`,
  ).run();
}

function seedDataset(db: Database, id: string, over: Record<string, unknown> = {}): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, description, authors, owner_user_id, status, visibility, is_sandbox)
     VALUES (?, ?, ?, ?, 7, 'active', ?, 0)`,
  ).run(
    id,
    (over.name as string) ?? "A study of something",
    (over.description as string) ?? "description",
    (over.authors as string) ?? "Ada Lovelace; Charles Babbage",
    (over.visibility as string) ?? "public",
  );
}

describe("the invariant is the database's, not the service's", () => {
  test("an unpublished dataset can become anonymous", () => {
    const db = freshDb();
    seedUser(db);
    seedDataset(db, "nm000910");

    db.prepare("UPDATE datasets SET anonymous = 1 WHERE dataset_id = 'nm000910'").run();

    const row = db.query("SELECT anonymous FROM datasets WHERE dataset_id = 'nm000910'").get() as {
      anonymous: number;
    };
    expect(row.anonymous).toBe(1);
  });

  test("a published dataset cannot", () => {
    const db = freshDb();
    seedUser(db);
    seedDataset(db, "nm000911");
    db.prepare(
      "UPDATE datasets SET first_published_at = '2026-01-01 00:00:00' WHERE dataset_id = 'nm000911'",
    ).run();

    expect(() =>
      db.prepare("UPDATE datasets SET anonymous = 1 WHERE dataset_id = 'nm000911'").run(),
    ).toThrow(/anonymous requires first_published_at IS NULL/);
  });

  test("a row cannot be INSERTED into the forbidden state either", () => {
    // The UPDATE trigger alone would leave a door open: an import or a
    // restore that writes a complete row in one INSERT never issues an
    // UPDATE. Covered separately because a test that only UPDATEs passes with
    // the INSERT trigger's predicate broken -- which is how this gap was
    // found.
    const db = freshDb();
    seedUser(db);

    expect(() =>
      db
        .prepare(
          `INSERT INTO datasets (dataset_id, name, description, authors, owner_user_id, status,
                                 visibility, is_sandbox, anonymous, first_published_at)
           VALUES ('nm000918', 'n', 'd', 'a', 7, 'active', 'public', 0, 1, '2026-01-01 00:00:00')`,
        )
        .run(),
    ).toThrow(/anonymous requires first_published_at IS NULL/);
  });

  test("an INSERT of a legitimately anonymous row is allowed", () => {
    // The control for the test above: the trigger has to refuse the
    // combination, not the flag.
    const db = freshDb();
    seedUser(db);
    db.prepare(
      `INSERT INTO datasets (dataset_id, name, description, authors, owner_user_id, status,
                             visibility, is_sandbox, anonymous)
       VALUES ('nm000919', 'n', 'd', 'a', 7, 'active', 'public', 0, 1)`,
    ).run();
    expect(
      (
        db.query("SELECT anonymous FROM datasets WHERE dataset_id = 'nm000919'").get() as {
          anonymous: number;
        }
      ).anonymous,
    ).toBe(1);
  });

  test("publishing an anonymous dataset must clear anonymity in the same statement", () => {
    const db = freshDb();
    seedUser(db);
    seedDataset(db, "nm000912");
    db.prepare("UPDATE datasets SET anonymous = 1 WHERE dataset_id = 'nm000912'").run();

    // Stamping the date alone is refused: the row would be anonymous AND
    // published. This is why END_ANONYMITY_AT_PUBLICATION_SQL is one fragment
    // interpolated into one statement.
    expect(() =>
      db
        .prepare(
          "UPDATE datasets SET first_published_at = datetime('now') WHERE dataset_id = 'nm000912'",
        )
        .run(),
    ).toThrow(/anonymous requires first_published_at IS NULL/);

    db.prepare(
      `UPDATE datasets SET anonymous = 0, first_published_at = COALESCE(first_published_at, datetime('now'))
       WHERE dataset_id = 'nm000912'`,
    ).run();
    const row = db
      .query("SELECT anonymous, first_published_at FROM datasets WHERE dataset_id = 'nm000912'")
      .get() as { anonymous: number; first_published_at: string | null };
    expect(row.anonymous).toBe(0);
    expect(row.first_published_at).toBeTruthy();
  });
});

describe("the 0085 backfill", () => {
  /**
   * WHAT THIS CAN AND CANNOT TEST
   *
   * `freshDb()` applies every migration before any row exists, so migration
   * 0085's `UPDATE` never runs over a row a test seeded -- it has already
   * run, against nothing. A real backfill test would need a row inserted
   * between migration 0084 and 0085, which the helper cannot express today.
   *
   * So this replays the migration's own predicate, read out of the migration
   * file rather than retyped, against rows shaped like the pre-existing ones.
   * Reading the file is the point: a retyped copy would keep passing after
   * the migration changed, which is exactly the failure this pair of tests is
   * meant to catch.
   */
  const MIGRATION = new URL("../src/db/migrations/0085_anonymous_deposit.sql", import.meta.url)
    .pathname;

  function backfillStatement(): string {
    const sql = require("node:fs").readFileSync(MIGRATION, "utf8") as string;
    const start = sql.indexOf("UPDATE datasets\nSET first_published_at");
    const end = sql.indexOf(";", start);
    expect(start).toBeGreaterThan(-1);
    return sql.slice(start, end + 1);
  }

  test("a public row is recorded as published", () => {
    const db = freshDb();
    seedUser(db);
    seedDataset(db, "nm000913", { visibility: "public" });
    db.exec(backfillStatement());
    const row = db
      .query("SELECT first_published_at FROM datasets WHERE dataset_id = 'nm000913'")
      .get() as { first_published_at: string | null };
    expect(hasEverBeenPublished(row)).toBe(true);
  });

  test("a private row with a version history is recorded too", () => {
    // The arm that matters most: a dataset that was public, was reverted to
    // private, and would otherwise read as never-published and so become
    // anonymous retroactively.
    const db = freshDb();
    seedUser(db);
    seedDataset(db, "nm000917", { visibility: "private" });
    db.prepare(
      `INSERT INTO dataset_versions (dataset_id, version, doi, created_at)
       VALUES ('nm000917', '1.0.0', '10.5072/FK2test', '2021-05-05 00:00:00')`,
    ).run();
    db.exec(backfillStatement());
    const row = db
      .query("SELECT first_published_at FROM datasets WHERE dataset_id = 'nm000917'")
      .get() as { first_published_at: string | null };
    // The earliest version row, not `created_at`: the best evidence
    // available rather than a guess.
    expect(row.first_published_at).toBe("2021-05-05 00:00:00");
  });

  test("a private, DOI-less, version-less row is left alone", () => {
    // The control. Without it, a predicate that matched everything would
    // satisfy both tests above and quietly make anonymity impossible for
    // every dataset in the catalog.
    const db = freshDb();
    seedUser(db);
    seedDataset(db, "nm000915", { visibility: "private" });
    db.exec(backfillStatement());
    const row = db
      .query("SELECT first_published_at FROM datasets WHERE dataset_id = 'nm000915'")
      .get() as { first_published_at: string | null };
    expect(hasEverBeenPublished(row)).toBe(false);
  });
});

describe("the owner projection", () => {
  test("the rule withholds the joined owner fields for an anonymous row", () => {
    const db = freshDb();
    seedUser(db);
    seedDataset(db, "nm000916");
    seedDataset(db, "nm000914");
    db.prepare("UPDATE datasets SET anonymous = 1 WHERE dataset_id = 'nm000914'").run();

    // The CONSTANTS are interpolated, not a hand-copied equivalent. A copy
    // tests itself: inverting the real rule to always disclose the owner left
    // an earlier version of this test passing.
    const rows = db
      .query(
        `SELECT d.dataset_id, ${OWNER_USERNAME_SQL}, ${OWNER_GITHUB_SQL}
         FROM datasets d LEFT JOIN users u ON d.owner_user_id = u.id
         WHERE d.dataset_id IN ('nm000916','nm000914') ORDER BY d.dataset_id`,
      )
      .all() as {
      dataset_id: string;
      owner_username: string | null;
      owner_github: string | null;
    }[];

    expect(rows[0]).toEqual({
      dataset_id: "nm000914",
      owner_username: null,
      owner_github: null,
    });
    expect(rows[1]).toEqual({
      dataset_id: "nm000916",
      owner_username: "realname",
      owner_github: "real-gh-handle",
    });
  });
});

describe("predicates", () => {
  test("isAnonymous reads the column and nothing else", () => {
    expect(isAnonymous({ anonymous: 1 })).toBe(true);
    expect(isAnonymous({ anonymous: 0 })).toBe(false);
    expect(isAnonymous({ anonymous: null })).toBe(false);
    expect(isAnonymous(null)).toBe(false);
    expect(isAnonymous(undefined)).toBe(false);
  });

  test("hasEverBeenPublished is the stamp, never a re-derivation", () => {
    expect(hasEverBeenPublished({ first_published_at: "2026-01-01 00:00:00" })).toBe(true);
    expect(hasEverBeenPublished({ first_published_at: null })).toBe(false);
  });

  test("neither predicate's column is optional on its row type", () => {
    // The regression this pins: `first_published_at` used to be OPTIONAL on
    // the shared field type, so `hasEverBeenPublished(row)` accepted a row
    // whose SELECT never asked for the column and answered `false` -- the
    // direction that lets an already-published dataset be concealed. The
    // publication route did exactly that, and tsc raised nothing.
    //
    // `bun run typecheck` is what ENFORCES this; the value of stating it here
    // is that it names the reason, so a future widening back to `?:` fails
    // against an explanation rather than against a compiler line number.
    // Matched with a tolerant pattern rather than an exact formatted literal:
    // the invariant is "no question mark", not any particular indentation.
    const source = readFileSync(
      join(import.meta.dir, "..", "src", "services", "anonymity.ts"),
      "utf8",
    );
    const fieldsOf = (name: string): string => {
      const at = source.indexOf(`export interface ${name} {`);
      expect(at).toBeGreaterThan(-1);
      return source.slice(at, source.indexOf("}", at));
    };
    expect(fieldsOf("AnonymityFields")).toMatch(/\banonymous\s*:/);
    expect(fieldsOf("AnonymityFields")).not.toMatch(/\banonymous\s*\?/);
    expect(fieldsOf("PublicationStampFields")).toMatch(/\bfirst_published_at\s*:/);
    expect(fieldsOf("PublicationStampFields")).not.toMatch(/\bfirst_published_at\s*\?/);
  });
});
