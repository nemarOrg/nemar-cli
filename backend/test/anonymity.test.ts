/**
 * Anonymous deposit as a server-side state (#1407, epic #1406).
 *
 * Real engine: bun:sqlite with every migration applied, including 0085's
 * triggers, which is what several of these assert against directly. The point
 * of most of them is not that an API field is null -- that is the easy half --
 * but that the real values are NOT PRESENT to be leaked: withheld by the
 * writer rather than filtered by the reader. The FTS assertion is the sharpest
 * one, because `datasets_fts` is fed by a trigger with no visibility
 * predicate, so a read-time filter would have hidden the names from the API
 * while leaving them searchable in the index.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  ANONYMOUS_AUTHORS_LABEL,
  blindEnrichmentMetadata,
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

    // The refusal comes from migration 0085's trigger. A service-level check
    // would be a rule a future route could forget; this one it cannot.
    expect(() =>
      db.prepare("UPDATE datasets SET anonymous = 1 WHERE dataset_id = 'nm000911'").run(),
    ).toThrow(/anonymous requires first_published_at IS NULL/);
  });

  test("publishing an anonymous dataset must clear anonymity in the same statement", () => {
    const db = freshDb();
    seedUser(db);
    seedDataset(db, "nm000912");
    db.prepare("UPDATE datasets SET anonymous = 1 WHERE dataset_id = 'nm000912'").run();

    // Stamping the date alone is refused: the row would be anonymous AND
    // published. This is why `recordFirstPublication` is one UPDATE.
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

  test("the backfill records existing public datasets as published", () => {
    // Migration 0085 runs over rows that already exist, and every dataset
    // that is public today has been published at least once. Without this the
    // whole catalog would read as "never published" and could be made
    // anonymous retroactively -- the exact thing the rule forbids.
    const db = freshDb();
    seedUser(db);
    seedDataset(db, "nm000913", { visibility: "public" });
    // Rows seeded after migrations do not go through the backfill, so assert
    // the backfill's PREDICATE against a row that mimics a pre-existing one.
    db.prepare(
      `UPDATE datasets SET first_published_at = COALESCE(first_published_at, created_at)
       WHERE dataset_id = 'nm000913' AND visibility = 'public'`,
    ).run();
    const row = db
      .query("SELECT first_published_at FROM datasets WHERE dataset_id = 'nm000913'")
      .get() as { first_published_at: string | null };
    expect(row.first_published_at).toBeTruthy();
    expect(hasEverBeenPublished(row)).toBe(true);
  });
});

describe("identity is withheld by the writer, not filtered by the reader", () => {
  test("the real names never reach the full-text index", () => {
    const db = freshDb();
    seedUser(db);
    // What an enrichment run writes for an anonymous deposit: the label, not
    // the author list. The FTS trigger then indexes the label.
    seedDataset(db, "nm000914", { authors: ANONYMOUS_AUTHORS_LABEL });
    db.prepare("UPDATE datasets SET anonymous = 1 WHERE dataset_id = 'nm000914'").run();

    // fts5 is keyed by rowid, so join back to get the id.
    const hits = db
      .query(
        `SELECT d.dataset_id FROM datasets_fts f
         JOIN datasets d ON d.id = f.rowid
         WHERE datasets_fts MATCH 'Lovelace'`,
      )
      .all() as { dataset_id: string }[];

    // Not "the query filtered it out" -- the name is not in the index at all,
    // so no future query, facet or embedding pass can surface it.
    expect(hits).toEqual([]);
  });

  test("a name that was indexed before anonymity would still be found (why the writer matters)", () => {
    // The control for the test above: if `datasets.authors` holds the real
    // names, FTS has them regardless of any API-level filtering. This is the
    // failure mode that a read-time filter would have left in place.
    const db = freshDb();
    seedUser(db);
    seedDataset(db, "nm000915", { authors: "Ada Lovelace; Charles Babbage" });
    db.prepare("UPDATE datasets SET anonymous = 1 WHERE dataset_id = 'nm000915'").run();

    const hits = db
      .query(
        `SELECT d.dataset_id FROM datasets_fts f
         JOIN datasets d ON d.id = f.rowid
         WHERE datasets_fts MATCH 'Lovelace'`,
      )
      .all() as { dataset_id: string }[];

    expect(hits.map((h) => h.dataset_id)).toContain("nm000915");
  });

  test("blindEnrichmentMetadata drops attribution and keeps the description of the data", () => {
    const blinded = blindEnrichmentMetadata({
      title: "A study of something",
      description: "What the recordings contain",
      methods_description: "How they were collected",
      authors: { "Ada Lovelace": { orcid: "0000-0002-1825-0097" } },
      contributors: { "Charles Babbage": {} },
      funding_references: [{ funder_name: "A named institute", award_number: "G-1" }],
      geo_locations: [{ place: "Somewhere" }],
    });

    expect(blinded).not.toHaveProperty("authors");
    expect(blinded).not.toHaveProperty("contributors");
    expect(blinded).not.toHaveProperty("funding_references");
    // The data's own description survives: blanking it would conceal the
    // thing a reviewer is meant to read.
    expect(blinded.title).toBe("A study of something");
    expect(blinded.description).toBe("What the recordings contain");
    expect(blinded.methods_description).toBe("How they were collected");
  });

  test("the serialized document carries no trace of the names", () => {
    // `.nemar/metadata.json` is backend-written and, since #1403, publicly
    // served from the manifest -- so what matters is the bytes, not the shape.
    const serialized = JSON.stringify(
      blindEnrichmentMetadata({
        title: "t",
        authors: { "Ada Lovelace": { orcid: "0000-0002-1825-0097" } },
      }),
    );
    expect(serialized).not.toContain("Lovelace");
    expect(serialized).not.toContain("0000-0002-1825-0097");
  });
});

describe("the owner projection", () => {
  test("SQL withholds the joined owner fields for an anonymous row", () => {
    const db = freshDb();
    seedUser(db);
    seedDataset(db, "nm000916");
    seedDataset(db, "nm000917");
    db.prepare("UPDATE datasets SET anonymous = 1 WHERE dataset_id = 'nm000917'").run();

    const rows = db
      .query(
        `SELECT d.dataset_id,
                CASE WHEN d.anonymous = 1 THEN NULL ELSE u.username END AS owner_username,
                CASE WHEN d.anonymous = 1 THEN NULL ELSE u.github_username END AS owner_github
         FROM datasets d LEFT JOIN users u ON d.owner_user_id = u.id
         WHERE d.dataset_id IN ('nm000916','nm000917') ORDER BY d.dataset_id`,
      )
      .all() as {
      dataset_id: string;
      owner_username: string | null;
      owner_github: string | null;
    }[];

    expect(rows[0]).toEqual({
      dataset_id: "nm000916",
      owner_username: "realname",
      owner_github: "real-gh-handle",
    });
    expect(rows[1]).toEqual({
      dataset_id: "nm000917",
      owner_username: null,
      owner_github: null,
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
    expect(hasEverBeenPublished({})).toBe(false);
  });
});
