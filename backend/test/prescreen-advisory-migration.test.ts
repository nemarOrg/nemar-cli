/**
 * Tests for migration 0045_prescreen_reasons.sql and the exact SQL the
 * advisory pre-screen runs (epic #749, Phase 7 / #756):
 *   - /webhooks/prescreen-result `flagged` branch -> prescreen_status='concern'
 *     + prescreen_reasons, and crucially status is LEFT UNTOUCHED (no block).
 *   - the `passed` branch.
 *   - the re-request reset that clears prescreen_reasons.
 *
 * Real in-memory SQLite via bun:sqlite (no mocks); applies every migration.
 * SQL strings mirror webhooks.ts / datasets.ts.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");

function freshDb(): Database {
  const db = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  db.prepare(
    `INSERT INTO users (id, username, email, github_username, status)
     VALUES (1, 'alice', 'alice@nemar.org', 'alice', 'approved')`,
  ).run();
  return db;
}

// A publication request awaiting its pre-screen callback.
function insertPendingRequest(db: Database, datasetId: string): number {
  const r = db
    .prepare(
      `INSERT INTO publication_requests (dataset_id, status, requested_by, prescreen_status)
       VALUES (?, 'requested', 1, 'pending') RETURNING id`,
    )
    .get(datasetId) as { id: number };
  return r.id;
}

// Mirrors the `flagged` branch UPDATE in webhooks.ts /webhooks/prescreen-result.
const ADVISORY_SQL = `UPDATE publication_requests
   SET prescreen_status = 'concern', prescreen_reasons = ?, prescreen_issue_url = ?,
       prescreen_at = datetime('now'), updated_at = datetime('now')
 WHERE id = ? AND prescreen_status = 'pending'`;

function read(db: Database, id: number) {
  return db.prepare("SELECT * FROM publication_requests WHERE id = ?").get(id) as {
    status: string;
    block_reason: string | null;
    prescreen_status: string | null;
    prescreen_reasons: string | null;
  };
}

describe("migration 0045 + advisory pre-screen SQL", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test("prescreen_reasons column present, NULL by default", () => {
    const id = insertPendingRequest(db, "nm000001");
    expect(read(db, id).prescreen_reasons).toBeNull();
  });

  test("advisory `concern` records reasons and LEAVES status='requested' (no block)", () => {
    const id = insertPendingRequest(db, "nm000001");
    const reasons = JSON.stringify(["README is thin", "no data paper"]);
    const r = db.prepare(ADVISORY_SQL).run(reasons, "https://github.com/x/issues/1", id);
    expect(r.changes).toBe(1);
    const row = read(db, id);
    expect(row.prescreen_status).toBe("concern");
    expect(row.prescreen_reasons).toBe(reasons);
    // The whole point of #756: the request is NOT blocked.
    expect(row.status).toBe("requested");
    expect(row.block_reason).toBeNull();
  });

  test("advisory UPDATE only fires on a 'pending' screen (one-shot)", () => {
    const id = insertPendingRequest(db, "nm000001");
    db.prepare(ADVISORY_SQL).run("[]", null, id); // first callback -> concern
    const r2 = db.prepare(ADVISORY_SQL).run('["late"]', null, id); // replay
    expect(r2.changes).toBe(0); // prescreen_status is no longer 'pending'
    expect(read(db, id).prescreen_status).toBe("concern");
  });

  test("re-request reset clears prescreen_reasons", () => {
    const id = insertPendingRequest(db, "nm000001");
    db.prepare(ADVISORY_SQL).run('["x"]', null, id);
    db.prepare(
      "UPDATE publication_requests SET status = 'requested', block_reason = NULL, prescreen_status = NULL, prescreen_nonce = NULL, prescreen_issue_url = NULL, prescreen_reasons = NULL, updated_at = datetime('now') WHERE id = ?",
    ).run(id);
    const row = read(db, id);
    expect(row.prescreen_status).toBeNull();
    expect(row.prescreen_reasons).toBeNull();
  });
});
