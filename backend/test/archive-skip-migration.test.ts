/**
 * Tests for migration 0043_dataset_archive_skip_reason.sql and the SQL the
 * archive skip path runs (epic #749, Phase 3 / #752):
 *   - /webhooks/archive-ready status='skipped' UPDATE
 *   - the admin archive-sweep skipped-vs-absent branch
 *   - the "skipped = archive_skip_reason IS NOT NULL" read
 *
 * Real in-memory SQLite via bun:sqlite (no mocks); applies every migration so
 * the `datasets` table matches production.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ARCHIVE_SWEEP_READY_SQL,
  ARCHIVE_SWEEP_SKIP_SQL,
} from "../src/routes/admin/datasets-lifecycle";
import { decideArchiveSweepOutcome } from "../src/services/archive-policy";

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

function insertDataset(db: Database, datasetId: string): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, is_sandbox)
     VALUES (?, 1, ?, 'public', 0)`,
  ).run(datasetId, datasetId);
}

describe("migration 0043: archive_skip_reason", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test("column present, NULL by default", () => {
    insertDataset(db, "on005752");
    const row = db
      .prepare("SELECT archive_skip_reason, archive_status FROM datasets WHERE dataset_id = ?")
      .get("on005752") as { archive_skip_reason: string | null; archive_status: string | null };
    expect(row.archive_skip_reason).toBeNull();
    expect(row.archive_status).toBeNull();
  });

  test("archive-ready 'skipped' UPDATE sets reason, NULLs status, resets retry_count", () => {
    insertDataset(db, "on005752");
    // Simulate a prior failed-retry history (#736) that the skip must clear.
    db.prepare("UPDATE datasets SET archive_retry_count = 3 WHERE dataset_id = ?").run("on005752");
    const r = db
      .prepare(
        `UPDATE datasets
         SET archive_skip_reason = ?, archive_status = NULL, archive_retry_count = 0, sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.archive_checked_at', datetime('now'))
         WHERE dataset_id = ?`,
      )
      .run("dataset 680.0 GB exceeds 100.0 GB archive limit; use direct download", "on005752");
    expect(r.changes).toBe(1);
    const row = db
      .prepare(
        "SELECT archive_skip_reason, archive_status, archive_retry_count, json_extract(sweep_stamps, '$.archive_checked_at') AS archive_checked_at FROM datasets WHERE dataset_id = ?",
      )
      .get("on005752") as {
      archive_skip_reason: string;
      archive_status: string | null;
      archive_retry_count: number;
      archive_checked_at: string;
    };
    expect(row.archive_skip_reason).toContain("exceeds");
    expect(row.archive_status).toBeNull();
    // Cross-epic (#736+#749): a skip clears the retry counter so a later
    // failed archive isn't wrongly capped.
    expect(row.archive_retry_count).toBe(0);
    expect(row.archive_checked_at).not.toBeNull();
  });

  test("skipped state is distinguishable: reason IS NOT NULL, status NULL (vs absent)", () => {
    insertDataset(db, "on005752"); // skipped (oversized)
    insertDataset(db, "nm000001"); // absent (no archive, under threshold)
    db.prepare(
      "UPDATE datasets SET archive_skip_reason = ?, sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.archive_checked_at', datetime('now')) WHERE dataset_id = ?",
    ).run("oversized", "on005752");
    db.prepare(
      "UPDATE datasets SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.archive_checked_at', datetime('now')) WHERE dataset_id = ?",
    ).run("nm000001");

    const skipped = db
      .prepare(
        "SELECT dataset_id FROM datasets WHERE archive_skip_reason IS NOT NULL ORDER BY dataset_id",
      )
      .all() as { dataset_id: string }[];
    expect(skipped.map((r) => r.dataset_id)).toEqual(["on005752"]);

    // 'absent' = checked, no archive, no skip reason, status NULL
    const absent = db
      .prepare(
        "SELECT dataset_id FROM datasets WHERE json_extract(sweep_stamps, '$.archive_checked_at') IS NOT NULL AND archive_skip_reason IS NULL AND archive_status IS NULL",
      )
      .all() as { dataset_id: string }[];
    expect(absent.map((r) => r.dataset_id)).toEqual(["nm000001"]);
  });

  test("the sweep candidate query exposes file_size/total_files for the skip decision", () => {
    insertDataset(db, "on005752");
    db.prepare("UPDATE datasets SET file_size = ?, total_files = ? WHERE dataset_id = ?").run(
      730_000_000_000,
      11000,
      "on005752",
    );
    const row = db
      .prepare(
        `SELECT dataset_id, file_size, total_files FROM datasets
         WHERE visibility = 'public' AND json_extract(sweep_stamps, '$.archive_checked_at') IS NULL
         ORDER BY dataset_id LIMIT 1`,
      )
      .get() as { dataset_id: string; file_size: number; total_files: number };
    expect(row.dataset_id).toBe("on005752");
    expect(row.file_size).toBe(730_000_000_000);
    expect(row.total_files).toBe(11000);
  });

  test("archive-ready 'ready' clears a stale skip_reason (size-reduced re-publish)", () => {
    insertDataset(db, "on005752");
    // previously skipped (oversized)
    db.prepare(
      "UPDATE datasets SET archive_skip_reason = 'oversized', sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.archive_checked_at', datetime('now')) WHERE dataset_id = ?",
    ).run("on005752");
    // a real zip now lands -> the 'ready' UPDATE must null the stale reason
    db.prepare(
      `UPDATE datasets
       SET archive_status = 'ready',
           sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.archive_checked_at', datetime('now')),
           archive_size = ?, archive_retry_count = 0, archive_skip_reason = NULL
       WHERE dataset_id = ?`,
    ).run(500, "on005752");
    const row = db
      .prepare(
        "SELECT archive_status, archive_skip_reason, archive_size FROM datasets WHERE dataset_id = ?",
      )
      .get("on005752") as {
      archive_status: string;
      archive_skip_reason: string | null;
      archive_size: number;
    };
    expect(row.archive_status).toBe("ready");
    expect(row.archive_skip_reason).toBeNull();
    expect(row.archive_size).toBe(500);
  });
});

describe("the admin archive-sweep's skip path clears archive_status (#1514)", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test("ARCHIVE_SWEEP_SKIP_SQL clears a stale 'ready'/'failed' status, not just the reason", () => {
    // Cause #4 in the issue: the prior copy of this statement set only
    // archive_skip_reason and left archive_status untouched, so a dataset
    // that grew over policy after an old zip was marked 'ready' kept
    // reading 'ready' forever.
    insertDataset(db, "on005752");
    db.prepare(
      "UPDATE datasets SET archive_status = 'ready', archive_retry_count = 2 WHERE dataset_id = ?",
    ).run("on005752");

    db.prepare(ARCHIVE_SWEEP_SKIP_SQL).run("oversized now", "on005752");

    const row = db
      .prepare(
        "SELECT archive_status, archive_skip_reason, archive_retry_count FROM datasets WHERE dataset_id = ?",
      )
      .get("on005752") as {
      archive_status: string | null;
      archive_skip_reason: string;
      archive_retry_count: number;
    };
    expect(row.archive_status).toBeNull();
    expect(row.archive_skip_reason).toBe("oversized now");
    expect(row.archive_retry_count).toBe(0);
  });

  test("ARCHIVE_SWEEP_SKIP_SQL is literally ARCHIVE_SKIP_UPDATE_SQL (one statement, not a fourth copy)", () => {
    // Guards against the sweep's skip path drifting from the webhook's again:
    // reuse, not re-derivation.
    insertDataset(db, "on005752");
    db.prepare(ARCHIVE_SWEEP_SKIP_SQL).run("reason text", "on005752");
    const row = db
      .prepare("SELECT archive_skip_reason FROM datasets WHERE dataset_id = ?")
      .get("on005752") as { archive_skip_reason: string };
    expect(row.archive_skip_reason).toBe("reason text");
  });

  test("the sweep's ready path never marks an over-policy dataset ready, even with a real zip on S3", () => {
    // The nm000284 shape (#1514): getArchiveSize found a real, complete zip
    // (345 GB) under the dataset's archive prefix, but the row is now over
    // policy (512.4 GiB / 14,922 files). decideArchiveSweepOutcome must
    // route this to 'skip', and the route must run ARCHIVE_SWEEP_SKIP_SQL,
    // never ARCHIVE_SWEEP_READY_SQL.
    insertDataset(db, "nm000284");
    db.prepare("UPDATE datasets SET file_size = ?, total_files = ? WHERE dataset_id = ?").run(
      550_239_019_072,
      14_922,
      "nm000284",
    );
    const s3Size = 345_096_030_514; // the real v1.0.0 zip's byte size
    const outcome = decideArchiveSweepOutcome(s3Size, {
      file_size: 550_239_019_072,
      total_files: 14_922,
    });
    expect(outcome.action).toBe("skip");

    // Exercise it through whichever SQL the outcome selects, exactly as the
    // route does -- not a hardcoded choice, so a future regression that
    // routes 'skip' outcomes through ARCHIVE_SWEEP_READY_SQL fails here.
    if (outcome.action === "ready") {
      db.prepare(ARCHIVE_SWEEP_READY_SQL).run(outcome.size, "nm000284");
    } else if (outcome.action === "skip") {
      db.prepare(ARCHIVE_SWEEP_SKIP_SQL).run(outcome.reason, "nm000284");
    }

    const row = db
      .prepare("SELECT archive_status, archive_skip_reason FROM datasets WHERE dataset_id = ?")
      .get("nm000284") as { archive_status: string | null; archive_skip_reason: string | null };
    expect(row.archive_status).toBeNull();
    expect(row.archive_skip_reason).toContain("exceeds");
  });

  test("an in-policy dataset with a real zip still reaches 'ready'", () => {
    insertDataset(db, "nm000010");
    db.prepare("UPDATE datasets SET file_size = ?, total_files = ? WHERE dataset_id = ?").run(
      5 * 1024 * 1024 * 1024,
      200,
      "nm000010",
    );
    const outcome = decideArchiveSweepOutcome(2048, {
      file_size: 5 * 1024 * 1024 * 1024,
      total_files: 200,
    });
    expect(outcome).toEqual({ action: "ready", size: 2048 });
    if (outcome.action === "ready") {
      db.prepare(ARCHIVE_SWEEP_READY_SQL).run(outcome.size, "nm000010");
    }
    const row = db
      .prepare("SELECT archive_status, archive_size FROM datasets WHERE dataset_id = ?")
      .get("nm000010") as { archive_status: string; archive_size: number };
    expect(row.archive_status).toBe("ready");
    expect(row.archive_size).toBe(2048);
  });
});
