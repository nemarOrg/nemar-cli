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
import { OPENNEURO_UPSTREAM_MARKER } from "../src/services/import-recovery";

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
   last_error = CASE
     WHEN import_jobs.last_error LIKE '%${OPENNEURO_UPSTREAM_MARKER}%'
          AND COALESCE(excluded.last_error, '') NOT LIKE '%${OPENNEURO_UPSTREAM_MARKER}%'
     THEN import_jobs.last_error
     ELSE excluded.last_error END,
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
// Like transition() but with an explicit last_error, to exercise the sticky
// upstream-marker CASE (#808). A NULL lastError mirrors the finalizing POST,
// which carries no error_message.
function transitionErr(
  db: Database,
  id: string,
  stage: string,
  status: string,
  lastError: string | null,
): void {
  db.prepare(TRANSITION_SQL).run(
    id,
    "openneuro",
    `ds${id.slice(2)}`,
    stage,
    status,
    8,
    null,
    lastError,
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
    // in-flight statuses leave completed_at NULL (the CASE only stamps terminal)
    expect(read(db, "on000001").completed_at).toBeNull();
    transition(db, "on000001", "finalize", "finalizing");
    expect(read(db, "on000001").status).toBe("finalizing");
    expect(read(db, "on000001").completed_at).toBeNull();
    transition(db, "on000001", "finalize", "complete");
    const row = read(db, "on000001");
    expect(row.status).toBe("complete");
    expect(row.completed_at).not.toBeNull();
  });

  test("`rolled_back` is sticky: stray `failed`/`copying` can't revive it; `preparing` resets it", () => {
    preparing(db, "on000001");
    transition(db, "on000001", "copy", "failed");
    // rolled_back (what runImportRecovery does on a clean cascade)
    db.prepare("UPDATE import_jobs SET status='rolled_back' WHERE dataset_id=?").run("on000001");
    transition(db, "on000001", "copy", "failed");
    expect(read(db, "on000001").status).toBe("rolled_back");
    transition(db, "on000001", "copy", "copying");
    expect(read(db, "on000001").status).toBe("rolled_back");
    // re-import (preparing) intentionally resets even a rolled_back receipt
    preparing(db, "on000001");
    expect(read(db, "on000001").status).toBe("preparing");
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

  describe("#808 sticky upstream marker in last_error", () => {
    const marker = `${OPENNEURO_UPSTREAM_MARKER} OpenNeuro objects not anonymously readable`;

    test("a later generic `failed` POST cannot clobber the marker", () => {
      // prepare records the marker; the doomed copy/report leg then POSTs a
      // generic terminal error while the row is still non-terminal (the race
      // the async waitUntil recovery loses). The marker must survive so
      // classifyRecovery still reads it.
      preparing(db, "on000001");
      transitionErr(db, "on000001", "prepare", "failed", marker);
      expect(read(db, "on000001").last_error).toContain(OPENNEURO_UPSTREAM_MARKER);
      transitionErr(db, "on000001", "copy", "failed", "terminal: prepare=failure copy=failure");
      expect(read(db, "on000001").last_error).toContain(OPENNEURO_UPSTREAM_MARKER);
    });

    test("the finalizing POST's NULL last_error cannot erase the marker", () => {
      preparing(db, "on000001");
      transitionErr(db, "on000001", "prepare", "failed", marker);
      // "Mark import finalizing" carries no error_message -> excluded.last_error NULL
      transitionErr(db, "on000001", "finalize", "finalizing", null);
      expect(read(db, "on000001").last_error).toContain(OPENNEURO_UPSTREAM_MARKER);
    });

    test("a newer POST that also carries the marker is allowed through", () => {
      preparing(db, "on000001");
      transitionErr(db, "on000001", "prepare", "failed", marker);
      transitionErr(db, "on000001", "prepare", "failed", `${marker} (run 2)`);
      expect(read(db, "on000001").last_error).toBe(`${marker} (run 2)`);
    });

    test("stickiness is per-attempt: a `preparing` reset clears the marker", () => {
      preparing(db, "on000001");
      transitionErr(db, "on000001", "prepare", "failed", marker);
      preparing(db, "on000001");
      expect(read(db, "on000001").last_error).toBeNull();
    });

    test("a normal (no-marker) error is overwritten as before", () => {
      preparing(db, "on000001");
      transitionErr(db, "on000001", "copy", "failed", "transient copy error");
      transitionErr(db, "on000001", "copy", "failed", "later copy error");
      expect(read(db, "on000001").last_error).toBe("later copy error");
    });
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
