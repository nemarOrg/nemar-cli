/**
 * Tests for migration 0044_import_jobs.sql and the exact upsert SQL the
 * /webhooks/import-state handler runs (epic #749, Phase 5 / #754):
 *   - the `preparing` unconditional reset upsert (re-import self-heal)
 *   - the monotonic transition upsert (terminal states are sticky; `failed`
 *     may upgrade an in-flight row)
 *
 * Real in-memory SQLite via bun:sqlite (no mocks); applies every migration so
 * the schema matches production. The SQL strings mirror webhooks.ts.
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
  return db;
}

// Mirrors the `status === 'preparing'` branch in webhooks.ts /import-state.
const PREPARING_SQL = `INSERT INTO import_jobs
   (dataset_id, source, source_id, stage, status, shards_total, workflow_run_url,
    last_error, completed_at, created_at, updated_at)
 VALUES (?, ?, ?, ?, 'preparing', ?, ?, NULL, NULL, datetime('now'), datetime('now'))
 ON CONFLICT(dataset_id) DO UPDATE SET
   source = excluded.source, source_id = excluded.source_id,
   stage = excluded.stage, status = 'preparing',
   shards_total = COALESCE(excluded.shards_total, import_jobs.shards_total),
   workflow_run_url = COALESCE(excluded.workflow_run_url, import_jobs.workflow_run_url),
   last_error = NULL, completed_at = NULL, updated_at = datetime('now')`;

// Mirrors the monotonic (non-preparing) branch in webhooks.ts /import-state.
const TRANSITION_SQL = `INSERT INTO import_jobs
   (dataset_id, source, source_id, stage, status, shards_total, workflow_run_url,
    last_error, completed_at, created_at, updated_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?,
         CASE WHEN ? IN ('complete','failed','quarantined','rolled_back')
              THEN datetime('now') ELSE NULL END,
         datetime('now'), datetime('now'))
 ON CONFLICT(dataset_id) DO UPDATE SET
   stage = excluded.stage, status = excluded.status,
   shards_total = COALESCE(excluded.shards_total, import_jobs.shards_total),
   workflow_run_url = COALESCE(excluded.workflow_run_url, import_jobs.workflow_run_url),
   last_error = excluded.last_error,
   completed_at = CASE WHEN excluded.status IN ('complete','failed','quarantined','rolled_back')
                       THEN datetime('now') ELSE import_jobs.completed_at END,
   updated_at = datetime('now')
 WHERE import_jobs.status NOT IN ('complete','rolled_back','quarantined')`;

function preparing(db: Database, id: string): void {
  db.prepare(PREPARING_SQL).run(id, "openneuro", `ds${id.slice(2)}`, "prepare", 8, null);
}
function transition(db: Database, id: string, stage: string, status: string): void {
  db.prepare(TRANSITION_SQL).run(
    id,
    "openneuro",
    `ds${id.slice(2)}`,
    stage,
    status,
    8,
    null,
    status === "failed" ? "boom" : null,
    status,
  );
}
function read(db: Database, id: string) {
  return db.prepare("SELECT * FROM import_jobs WHERE dataset_id = ?").get(id) as {
    status: string;
    stage: string;
    last_error: string | null;
    completed_at: string | null;
  };
}

describe("migration 0044: import_jobs", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test("table + indexes present, all 7 statuses accepted (no CHECK)", () => {
    const cols = (db.prepare("PRAGMA table_info(import_jobs)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(
      expect.arrayContaining([
        "dataset_id",
        "source",
        "source_id",
        "stage",
        "status",
        "last_error",
        "resume_cursor",
        "shards_total",
        "workflow_run_url",
        "created_at",
        "updated_at",
        "completed_at",
      ]),
    );
    const idx = (db.prepare("PRAGMA index_list(import_jobs)").all() as { name: string }[]).map(
      (i) => i.name,
    );
    expect(idx.some((n) => n.includes("status"))).toBe(true);
    expect(idx.some((n) => n.includes("updated_at"))).toBe(true);
    for (const s of [
      "preparing",
      "copying",
      "finalizing",
      "complete",
      "failed",
      "quarantined",
      "rolled_back",
    ]) {
      db.prepare(
        "INSERT INTO import_jobs (dataset_id, source, source_id, stage, status) VALUES (?, 'openneuro', 'ds', 'prepare', ?)",
      ).run(`on0000${s.length}${s[0]}`, s);
    }
  });

  test("UNIQUE(dataset_id) rejects a second row for the same dataset", () => {
    db.prepare(
      "INSERT INTO import_jobs (dataset_id, source, source_id, stage, status) VALUES ('on000001','openneuro','ds1','prepare','preparing')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO import_jobs (dataset_id, source, source_id, stage, status) VALUES ('on000001','openneuro','ds1','copy','copying')",
        )
        .run(),
    ).toThrow();
  });

  test("happy path: preparing -> copying -> finalizing -> complete", () => {
    preparing(db, "on000001");
    expect(read(db, "on000001").status).toBe("preparing");
    transition(db, "on000001", "copy", "copying");
    expect(read(db, "on000001").status).toBe("copying");
    transition(db, "on000001", "finalize", "finalizing");
    expect(read(db, "on000001").status).toBe("finalizing");
    transition(db, "on000001", "finalize", "complete");
    const row = read(db, "on000001");
    expect(row.status).toBe("complete");
    expect(row.completed_at).not.toBeNull();
  });

  test("terminal `complete` is sticky: a later `failed` cannot regress it", () => {
    preparing(db, "on000001");
    transition(db, "on000001", "finalize", "complete");
    transition(db, "on000001", "copy", "failed");
    expect(read(db, "on000001").status).toBe("complete");
  });

  test("`failed` upgrades an in-flight `copying` row", () => {
    preparing(db, "on000001");
    transition(db, "on000001", "copy", "copying");
    transition(db, "on000001", "copy", "failed");
    const row = read(db, "on000001");
    expect(row.status).toBe("failed");
    expect(row.last_error).toBe("boom");
    expect(row.completed_at).not.toBeNull();
  });

  test("quarantined is sticky vs a stray transition, but a `preparing` reset re-imports", () => {
    preparing(db, "on000001");
    transition(db, "on000001", "copy", "failed");
    // quarantine (what runImportRecovery does)
    db.prepare("UPDATE import_jobs SET status='quarantined' WHERE dataset_id=?").run("on000001");
    // a stray monotonic transition must NOT revive it
    transition(db, "on000001", "copy", "copying");
    expect(read(db, "on000001").status).toBe("quarantined");
    // but a fresh import attempt (preparing) resets the row
    preparing(db, "on000001");
    const row = read(db, "on000001");
    expect(row.status).toBe("preparing");
    expect(row.last_error).toBeNull();
    expect(row.completed_at).toBeNull();
  });
});
