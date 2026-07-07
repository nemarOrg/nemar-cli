/**
 * Exemplar SQL-wiring tests (epic #923, phase 4 / #927).
 *
 * The unit tests in exemplar-gate.test.ts pin the pure predicate/formatting
 * functions. These run the ACTUAL relaxed SQL against a real (bun:sqlite)
 * database with the production schema (migration 0057 included), so a wrong
 * alias, operator-precedence slip, or forgotten `is_exemplar` column is caught:
 *  - visibility predicates must ADMIT an is_exemplar=1 row (even when is_sandbox=1,
 *    the post-DOI-mint state) and still EXCLUDE a plain sandbox row (no leak),
 *  - the reindex-filter base must include exemplars,
 *  - the sandbox-cleanup cron must EXEMPT exemplars from deletion,
 *  - seedFromBids must thread the staging landing base into related identifiers.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { buildReindexFilterQuery } from "../src/services/dataset-reindex";
import { hydrateDatasetsByIds, lookupDatasetById } from "../src/services/dataset-search";
import { seedFromBids } from "../src/services/llm-enrich";
import { freshDb, realD1 } from "./helpers/d1";

const EXEMPLAR = "xx099900"; // is_exemplar=1, is_sandbox=1 (post-DOI-mint), public
const SANDBOX = "xx098765"; // plain sandbox: is_sandbox=1, is_exemplar=0, public
const NORMAL = "nm000132"; // ordinary public dataset

function insertDataset(
  db: Database,
  o: {
    id: string;
    sandbox?: number;
    exemplar?: number;
    visibility?: string;
    status?: string;
    repo?: string | null;
    ageDays?: number;
  },
): void {
  const repo = o.repo === undefined ? `nemarDatasets/${o.id}` : o.repo;
  const createdAt = o.ageDays ? `datetime('now', '-${o.ageDays} days')` : "datetime('now')";
  db.query(
    `INSERT INTO datasets
       (dataset_id, name, owner_user_id, github_repo, visibility, status, is_sandbox, is_exemplar, created_at)
     VALUES (?, ?, 100, ?, ?, ?, ?, ?, ${createdAt})`,
  ).run(
    o.id,
    `ds ${o.id}`,
    repo,
    o.visibility ?? "public",
    o.status ?? "active",
    o.sandbox ?? 0,
    o.exemplar ?? 0,
  );
}

let db: Database;

beforeEach(() => {
  db = freshDb();
});

describe("visibility predicates (real SQL)", () => {
  beforeEach(() => {
    insertDataset(db, { id: EXEMPLAR, sandbox: 1, exemplar: 1 });
    insertDataset(db, { id: SANDBOX, sandbox: 1, exemplar: 0 });
    insertDataset(db, { id: NORMAL, sandbox: 0, exemplar: 0 });
  });

  test("lookupDatasetById admits an exemplar (even with is_sandbox=1) and excludes plain sandbox", async () => {
    const d1 = realD1(db);
    expect((await lookupDatasetById(d1, EXEMPLAR))?.id).toBe(EXEMPLAR);
    expect(await lookupDatasetById(d1, SANDBOX)).toBeNull(); // no leak
    expect((await lookupDatasetById(d1, NORMAL))?.id).toBe(NORMAL);
  });

  test("hydrateDatasetsByIds returns exemplar + normal, drops plain sandbox", async () => {
    const rows = await hydrateDatasetsByIds(realD1(db), [EXEMPLAR, SANDBOX, NORMAL]);
    expect(rows.map((r) => r.id).sort()).toEqual([NORMAL, EXEMPLAR].sort());
  });
});

describe("buildReindexFilterQuery base (real SQL)", () => {
  test("admits exemplar + normal, excludes plain sandbox", () => {
    insertDataset(db, { id: EXEMPLAR, sandbox: 1, exemplar: 1 });
    insertDataset(db, { id: SANDBOX, sandbox: 1, exemplar: 0 });
    insertDataset(db, { id: NORMAL });
    const { sql } = buildReindexFilterQuery("all");
    const ids = db
      .query(sql)
      .all()
      .map((r) => (r as { dataset_id: string }).dataset_id);
    expect(ids.sort()).toEqual([NORMAL, EXEMPLAR].sort());
  });
});

describe("sandbox-cleanup cron predicate (real SQL, mirrors index.ts scheduledCleanup)", () => {
  // Kept in sync with the SELECT in backend/src/index.ts (sandbox datasets > 14 days).
  const CRON_SQL =
    "SELECT dataset_id FROM datasets WHERE dataset_id LIKE 'xx%' AND is_exemplar = 0 AND created_at < datetime('now', '-14 days') AND status = 'active' LIMIT ?";

  test("exempts an aged exemplar, still deletes an aged plain sandbox", () => {
    insertDataset(db, { id: EXEMPLAR, sandbox: 1, exemplar: 1, ageDays: 20 });
    insertDataset(db, { id: SANDBOX, sandbox: 1, exemplar: 0, ageDays: 20 });
    const candidates = db
      .query(CRON_SQL)
      .all(100)
      .map((r) => (r as { dataset_id: string }).dataset_id);
    expect(candidates).toEqual([SANDBOX]); // exemplar survives, plain sandbox is a delete candidate
  });
});

describe("seedFromBids landing-base threading", () => {
  const bids = { Name: "Test", Authors: ["Ada Lovelace"] };

  test("threads the staging base into the NEMAR IsDescribedBy related identifier", () => {
    const seeded = seedFromBids(bids, null, EXEMPLAR, [], "https://test.nemar.org");
    const ids = (seeded.related_identifiers ?? []).map((r) => r.identifier);
    expect(ids).toContain(`https://test.nemar.org/dataset/${EXEMPLAR}`);
    expect(ids).not.toContain(`https://nemar.org/dataset/${EXEMPLAR}`);
  });

  test("defaults to the prod apex when no base is passed", () => {
    const seeded = seedFromBids(bids, null, EXEMPLAR, []);
    const ids = (seeded.related_identifiers ?? []).map((r) => r.identifier);
    expect(ids).toContain(`https://nemar.org/dataset/${EXEMPLAR}`);
  });
});
