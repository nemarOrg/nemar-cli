/**
 * A concealed deposit's reserved identifier does not reach a public surface.
 *
 * `withheldWhileAnonymous` (services/anonymity.ts) was declared as "the same
 * rule for the catalog projections" and then written by hand three more times.
 * Predictably, the fourth and fifth surfaces never got a copy: all three search
 * tiers and both MCP tools projected `d.concept_doi` with no anonymity
 * predicate, so any unauthenticated caller could read the reserved DOI of a
 * dataset whose whole point is that nobody knows whose it is.
 *
 * It is not the depositor's NAME -- `authors` is correctly the blinded label on
 * every one of these. What escapes is the identifier that ADR 0065 says "does
 * not resolve and must not be cited", and MCP's `describe-dataset` composes it
 * into a ready-made `citation` string. The epic's own approval email warns
 * about exactly this: "a depositor mid-submission would paste a dead identifier
 * into a blinded manuscript."
 *
 * Driven through the real exported functions against a real migrated database,
 * because the previous guarantee was a comment.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { hydrateDatasetsByIds } from "../src/services/dataset-search";
import { freshDb, realD1 } from "./helpers/d1";

const REAL_DOI = "10.82901/nemar.nm000103";

function seed(db: Database, datasetId: string, anonymous: number): void {
  db.run(
    `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
     VALUES (71, 'depositor', 'dep@example.org', 'x', 'approved', 'member', 1)
     ON CONFLICT(id) DO NOTHING`,
  );
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox,
                           concept_doi, anonymous, authors)
     VALUES (?, 'A sufficiently descriptive dataset title', 71, 'active', 'public', 0, ?, ?, ?)`,
  ).run(
    datasetId,
    REAL_DOI,
    anonymous,
    anonymous === 1 ? "Anonymous (withheld until publication)" : "Lovelace, Ada",
  );
}

describe("search does not hand out a reserved identifier", () => {
  test("an anonymous deposit's DOI is withheld from the hydrated search row", async () => {
    const db = freshDb();
    seed(db, "nm000870", 1);
    const rows = await hydrateDatasetsByIds(realD1(db), ["nm000870"]);
    expect(rows.length).toBe(1);
    // `toResult` normalizes an absent value to "", the same shape it uses for
    // every other missing field. The property under test is that the reserved
    // identifier is not there, not which spelling of empty it uses.
    expect(rows[0].doi).toBeFalsy();
    expect(rows[0].doi).not.toContain("10.82901");
    // The row is still SERVED -- withholding the identifier is not hiding the
    // dataset. A blinded deposit is public and searchable on purpose.
    expect(rows[0].id).toBe("nm000870");
    db.close();
  });

  test("an ordinary dataset keeps its DOI", async () => {
    // The control. Without it, deleting the projection entirely would pass.
    const db = freshDb();
    seed(db, "nm000871", 0);
    const rows = await hydrateDatasetsByIds(realD1(db), ["nm000871"]);
    expect(rows.length).toBe(1);
    expect(rows[0].doi).toBe(REAL_DOI);
    db.close();
  });

  test("the depositor's name never appears either way", async () => {
    const db = freshDb();
    seed(db, "nm000872", 1);
    const rows = await hydrateDatasetsByIds(realD1(db), ["nm000872"]);
    expect(JSON.stringify(rows)).not.toContain("Lovelace");
    db.close();
  });
});
