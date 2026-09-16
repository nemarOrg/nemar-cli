/**
 * The writers, driven at the entry point (#1407, epic #1406).
 *
 * The first version of this phase's tests asserted the blinding by seeding a
 * row with the value the writer was supposed to produce, which is the shape
 * `.rules/testing.md` calls out: "its assertion is satisfied by how the
 * fixture was built, not by behaviour." A reviewer proved it by deleting both
 * blinds from `enrich-dataset.ts` and watching the entire backend suite stay
 * green. So these drive the writes themselves.
 *
 * `enrichDataset` cannot be the entry point here, and the reason is written
 * down in `enrich-doi-sync-skip.test.ts`: `manifest-small-root-files.test.ts`
 * installs a process-wide `mock.module("../src/services/github", ...)` whose
 * `getTreeAtRef` returns an empty array, `test/` and `backend/test/` share one
 * bun process, and `mock.module` is permanent -- so `enrichDataset` returns
 * "No README found" long before any blind runs. A test driving it would pass
 * alone and silently stop testing anything in a full run.
 *
 * That is why the author blind was MOVED into `writeDatasetCatalogFields`,
 * which is the one writer of `datasets.authors` in the backend and takes the
 * database directly. It is reachable, it decides from the row rather than
 * from an argument, and deleting the rule fails the first test below.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  ANONYMOUS_AUTHORS_LABEL,
  blindEnrichmentMetadata,
  isAnonymous,
  markAnonymous,
} from "../src/services/anonymity";
import { writeDatasetCatalogFields } from "../src/services/dataset-metadata-columns";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const REAL_AUTHORS = "Ada Lovelace; Charles Babbage";

function seed(db: Database, id: string, over: Record<string, unknown> = {}): void {
  db.prepare(
    `INSERT INTO users (id, username, email, github_username, status, role)
     VALUES (7, 'realname', 'real@example.org', 'real-gh', 'approved', 'user')
     ON CONFLICT(id) DO NOTHING`,
  ).run();
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, description, authors, enrichment_json,
                           owner_user_id, status, visibility, is_sandbox, anonymous)
     VALUES (?, 'A study of something', 'description', ?, ?, 7, 'active', 'public', 0, ?)`,
  ).run(
    id,
    (over.authors as string) ?? REAL_AUTHORS,
    (over.enrichment_json as string) ?? null,
    (over.anonymous as number) ?? 0,
  );
}

function ftsHits(db: Database, term: string): string[] {
  return (
    db
      .query(
        `SELECT d.dataset_id FROM datasets_fts f
         JOIN datasets d ON d.id = f.rowid
         WHERE datasets_fts MATCH ?`,
      )
      .all(term) as { dataset_id: string }[]
  ).map((r) => r.dataset_id);
}

describe("the one writer of datasets.authors withholds them", () => {
  test("an anonymous row gets the label, and the real names never reach FTS", async () => {
    const db = freshDb();
    seed(db, "nm000920", { anonymous: 1 });

    // The REAL authors are handed to the writer, exactly as the enrichment
    // pipeline hands them over: the blind is the writer's job, not the
    // caller's, so passing the real value is the case that matters.
    await writeDatasetCatalogFields(realD1(db), "nm000920", {
      name: null,
      description: null,
      authors: REAL_AUTHORS,
      license: null,
      readme: null,
      bids_version: null,
      sessions_count: null,
    });

    const row = db.query("SELECT authors FROM datasets WHERE dataset_id = 'nm000920'").get() as {
      authors: string;
    };
    expect(row.authors).toBe(ANONYMOUS_AUTHORS_LABEL);
    // Not "the query filtered it out": the name is not in the index at all,
    // so no later query, facet or embedding pass can surface it.
    expect(ftsHits(db, "Lovelace")).toEqual([]);
  });

  test("a normal row is untouched, which is what makes the test above mean something", async () => {
    // The control. If this failed the same way, the first test would be
    // passing because the writer is broken rather than because it is right.
    const db = freshDb();
    seed(db, "nm000921", { anonymous: 0 });

    await writeDatasetCatalogFields(realD1(db), "nm000921", {
      name: null,
      description: null,
      authors: REAL_AUTHORS,
      license: null,
      readme: null,
      bids_version: null,
      sessions_count: null,
    });

    const row = db.query("SELECT authors FROM datasets WHERE dataset_id = 'nm000921'").get() as {
      authors: string;
    };
    expect(row.authors).toBe(REAL_AUTHORS);
    expect(ftsHits(db, "Lovelace")).toContain("nm000921");
  });
});

describe("markAnonymous scrubs what an earlier enrichment already published", () => {
  const ENRICHED = JSON.stringify({
    version: "2.0",
    title: "A study of something",
    description: "What the recordings contain",
    authors: { "Ada Lovelace": { orcid: "0000-0002-1825-0097" } },
    contributors: { "Charles Babbage": {} },
    funding_references: [{ funder_name: "A named institute", award_number: "G-1" }],
    geo_locations: [{ place: "A named city" }],
    related_identifiers: [{ identifier: "10.1234/their-preprint" }],
  });

  test("the flag, the authors column and the cached document move together", async () => {
    const db = freshDb();
    seed(db, "nm000922", { enrichment_json: ENRICHED });

    const result = await markAnonymous({ DB: realD1(db) } as Bindings, "nm000922");

    expect(result.changed).toBe(true);
    // Enrichment runs on upload, so the repository's committed
    // `.nemar/metadata.json` still names the depositor. D1 cannot fix that,
    // and saying so is the difference between a promise and a hope.
    expect(result.repoMetadataStale).toBe(true);

    const row = db
      .query(
        "SELECT anonymous, authors, enrichment_json FROM datasets WHERE dataset_id = 'nm000922'",
      )
      .get() as { anonymous: number; authors: string; enrichment_json: string };
    expect(row.anonymous).toBe(1);
    expect(row.authors).toBe(ANONYMOUS_AUTHORS_LABEL);

    // The bytes, not the shape: `enrichment_json` is served raw by
    // `GET /datasets/:id`, so what matters is that the names are gone from it.
    expect(row.enrichment_json).not.toContain("Lovelace");
    expect(row.enrichment_json).not.toContain("0000-0002-1825-0097");
    expect(row.enrichment_json).not.toContain("Babbage");
    expect(row.enrichment_json).not.toContain("A named institute");
    expect(row.enrichment_json).not.toContain("A named city");
    expect(row.enrichment_json).not.toContain("their-preprint");
    // What the data IS survives: a reviewer still has to be able to read it.
    expect(JSON.parse(row.enrichment_json).description).toBe("What the recordings contain");

    expect(ftsHits(db, "Lovelace")).toEqual([]);
  });

  test("a malformed cached document is dropped rather than left in place", async () => {
    // `json_remove` on invalid JSON aborts the whole statement, which would
    // leave the dataset un-anonymized. The guard turns that into a removal.
    const db = freshDb();
    seed(db, "nm000923", { enrichment_json: "{not json at all" });

    const result = await markAnonymous({ DB: realD1(db) } as Bindings, "nm000923");

    expect(result.changed).toBe(true);
    const row = db
      .query("SELECT anonymous, enrichment_json FROM datasets WHERE dataset_id = 'nm000923'")
      .get() as { anonymous: number; enrichment_json: string | null };
    expect(row.anonymous).toBe(1);
    expect(row.enrichment_json).toBeNull();
  });

  test("a never-enriched dataset reports nothing stale", async () => {
    const db = freshDb();
    seed(db, "nm000924");
    const result = await markAnonymous({ DB: realD1(db) } as Bindings, "nm000924");
    expect(result).toEqual({ changed: true, repoMetadataStale: false });
  });

  test("a published dataset is refused with a sentence naming it", async () => {
    const db = freshDb();
    seed(db, "nm000925");
    db.prepare(
      "UPDATE datasets SET first_published_at = '2026-01-01 00:00:00' WHERE dataset_id = 'nm000925'",
    ).run();

    // The triggers refuse this write regardless; the service check exists to
    // turn their ABORT, which names no dataset, into something a route can
    // hand to a person.
    await expect(markAnonymous({ DB: realD1(db) } as Bindings, "nm000925")).rejects.toThrow(
      /nm000925 has been published/,
    );

    expect(
      (
        db.query("SELECT anonymous FROM datasets WHERE dataset_id = 'nm000925'").get() as {
          anonymous: number;
        }
      ).anonymous,
    ).toBe(0);
  });

  test("an id that matches no row reports changed: false rather than success", async () => {
    // A zero-row UPDATE succeeds in SQLite. Without the `meta.changes` check
    // a route would report concealment it never applied.
    const db = freshDb();
    const result = await markAnonymous({ DB: realD1(db) } as Bindings, "nm000999");
    expect(result.changed).toBe(false);
  });
});

describe("blindEnrichmentMetadata strips everything that names a person or their group", () => {
  test("attribution, funders, places and related work all go", () => {
    const blinded = blindEnrichmentMetadata({
      title: "A study of something",
      description: "What the recordings contain",
      methods_description: "How they were collected",
      authors: { "Ada Lovelace": { orcid: "0000-0002-1825-0097" } },
      contributors: { "Charles Babbage": {} },
      funding_references: [{ funder_name: "A named institute", award_number: "G-1" }],
      // A geo-location names the institution or city; a related identifier
      // typically points straight at the submitting group's own preprint.
      // Both defeat a double-blind submission as completely as an author list.
      geo_locations: [{ place: "A named city" }],
      related_identifiers: [{ identifier: "10.1234/their-preprint" }],
    });

    expect(blinded).not.toHaveProperty("authors");
    expect(blinded).not.toHaveProperty("contributors");
    expect(blinded).not.toHaveProperty("funding_references");
    expect(blinded).not.toHaveProperty("geo_locations");
    expect(blinded).not.toHaveProperty("related_identifiers");
    // The data's own description survives: blanking it would conceal the
    // thing a reviewer is meant to read.
    expect(blinded.title).toBe("A study of something");
    expect(blinded.description).toBe("What the recordings contain");
    expect(blinded.methods_description).toBe("How they were collected");
  });

  test("the serialized document carries no trace of the names", () => {
    const serialized = JSON.stringify(
      blindEnrichmentMetadata({
        title: "t",
        authors: { "Ada Lovelace": { orcid: "0000-0002-1825-0097" } },
        geo_locations: [{ place: "A named city" }],
      }),
    );
    expect(serialized).not.toContain("Lovelace");
    expect(serialized).not.toContain("0000-0002-1825-0097");
    expect(serialized).not.toContain("A named city");
  });
});
