/**
 * Tests for migration 0065_archive_completeness.sql and the completeness half
 * of the /webhooks/archive-ready 'ready' path (#1041):
 *   - the new columns and their CHECK domain
 *   - deriveArchiveCompleteness, the pure payload -> columns mapping
 *   - the COALESCE semantics that stop a tally-less callback from blanking a
 *     previously-recorded completeness
 *
 * Real in-memory SQLite via bun:sqlite (no mocks); applies every migration so
 * the `datasets` table matches production. Mirrors archive-skip-migration.test.ts.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deriveArchiveCompleteness } from "../src/routes/callbacks/archive-ready.js";
import {
  AVAILABILITY_REPORT_SWEEP_MAX,
  availabilityReportSweepCandidateQuery,
  availabilityReportSweepRemainingQuery,
} from "../src/services/availability-report.js";

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

/** The exact UPDATE the 'ready' branch of archive-ready.ts runs. */
const READY_SQL = `UPDATE datasets
   SET archive_status = 'ready',
       archive_checked_at = datetime('now'),
       archive_size = ?,
       archive_retry_count = 0,
       archive_skip_reason = NULL,
       archive_complete = COALESCE(?, archive_complete),
       archive_absent_files = COALESCE(?, archive_absent_files),
       archive_declared_files = COALESCE(?, archive_declared_files),
       availability_report_at = NULL
   WHERE dataset_id = ?`;

interface CompletenessRow {
  archive_complete: number | null;
  archive_absent_files: number | null;
  archive_declared_files: number | null;
  archive_status: string | null;
}

function readRow(db: Database, datasetId: string): CompletenessRow {
  return db
    .prepare(
      `SELECT archive_complete, archive_absent_files, archive_declared_files, archive_status
       FROM datasets WHERE dataset_id = ?`,
    )
    .get(datasetId) as CompletenessRow;
}

describe("migration 0065: archive completeness columns", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test("columns exist and default to NULL (not assessed, NOT incomplete)", () => {
    insertDataset(db, "on004624");
    const row = readRow(db, "on004624");
    expect(row.archive_complete).toBeNull();
    expect(row.archive_absent_files).toBeNull();
    expect(row.archive_declared_files).toBeNull();
  });

  test("archive_complete CHECK admits 0, 1 and NULL", () => {
    insertDataset(db, "on004624");
    for (const value of [0, 1, null]) {
      db.prepare("UPDATE datasets SET archive_complete = ? WHERE dataset_id = ?").run(
        value,
        "on004624",
      );
      expect(readRow(db, "on004624").archive_complete).toBe(value as number | null);
    }
  });

  test("archive_complete CHECK rejects a value outside the 0/1 domain", () => {
    insertDataset(db, "on004624");
    expect(() =>
      db
        .prepare("UPDATE datasets SET archive_complete = ? WHERE dataset_id = ?")
        .run(2, "on004624"),
    ).toThrow();
  });

  test("the completeness index exists", () => {
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_datasets_archive_complete");
    expect(idx).toBeTruthy();
  });
});

describe("deriveArchiveCompleteness", () => {
  test("counts present and zero -> complete", () => {
    expect(
      deriveArchiveCompleteness({
        dataset_id: "on004624",
        absent: 0,
        unreadable: 0,
        declared: 66427,
      }),
    ).toEqual({ complete: 1, absent: 0, declared: 66427, unreadable: 0, malformed: [] });
  });

  test("one absent file of 66k -> partial, not complete", () => {
    const got = deriveArchiveCompleteness({
      dataset_id: "on004624",
      absent: 1,
      unreadable: 0,
      declared: 66426,
    });
    expect(got.complete).toBe(0);
    expect(got.absent).toBe(1);
  });

  test("counts win over a contradictory `complete` flag", () => {
    // The flag is a convenience the workflow computes; the counts are the facts.
    const got = deriveArchiveCompleteness({
      dataset_id: "on004624",
      complete: true,
      absent: 5,
      unreadable: 0,
      declared: 100,
    });
    expect(got.complete).toBe(0);
  });

  test("a lone `complete` flag is NOT honoured without counts", () => {
    // Honouring it would write a fresh archive_complete=1 next to
    // COALESCE-preserved absent/declared counts from an older build, producing
    // a row that contradicts itself. No counts means no verdict.
    expect(
      deriveArchiveCompleteness({ dataset_id: "on004624", complete: true }).complete,
    ).toBeNull();
    expect(
      deriveArchiveCompleteness({ dataset_id: "on004624", complete: false }).complete,
    ).toBeNull();
  });

  test("an empty payload is 'not assessed', all null, nothing malformed", () => {
    expect(deriveArchiveCompleteness({ dataset_id: "on004624" })).toEqual({
      complete: null,
      absent: null,
      declared: null,
      unreadable: null,
      malformed: [],
    });
  });

  test("malformed counts are rejected rather than persisted as fact", () => {
    const got = deriveArchiveCompleteness({
      dataset_id: "on004624",
      // A payload that lost its types somewhere must not poison the columns.
      absent: "3" as unknown as number,
      unreadable: -1,
      declared: 1.5,
    });
    expect(got.absent).toBeNull();
    expect(got.unreadable).toBeNull();
    expect(got.declared).toBeNull();
    expect(got.complete).toBeNull();
  });

  test("present-but-unparseable is reported distinctly from simply absent", () => {
    // Both leave the columns null and COALESCE-preserved, so the persisted row
    // cannot distinguish them. This is the only signal that a real build's
    // tally arrived broken rather than never being sent.
    const broken = deriveArchiveCompleteness({
      dataset_id: "on004624",
      absent: "3" as unknown as number,
      unreadable: -1,
      declared: 1.5,
    });
    expect(broken.malformed.sort()).toEqual(["absent", "declared", "unreadable"]);

    const skipped = deriveArchiveCompleteness({ dataset_id: "on004624" });
    expect(skipped.malformed).toEqual([]);

    // A partially broken payload names only the offending field.
    const partial = deriveArchiveCompleteness({
      dataset_id: "on004624",
      absent: 0,
      unreadable: 0,
      declared: Number.NaN,
    });
    expect(partial.malformed).toEqual(["declared"]);
    // The two good counts still yield a verdict; only `declared` is lost.
    expect(partial.complete).toBe(1);
    expect(partial.declared).toBeNull();
  });

  test("unreadable>0 counts as not complete", () => {
    // Should be unreachable on a 'ready' callback, but if the build's
    // classification ever drifts, the archive must not read as complete.
    expect(
      deriveArchiveCompleteness({
        dataset_id: "on004624",
        absent: 0,
        unreadable: 2,
        declared: 10,
      }).complete,
    ).toBe(0);
  });
});

describe("archive-ready 'ready' UPDATE persists completeness", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
    insertDataset(db, "on004624");
  });

  test("a partial build records absent and declared and flips complete to 0", () => {
    const { complete, absent, declared } = deriveArchiveCompleteness({
      dataset_id: "on004624",
      absent: 1,
      unreadable: 0,
      declared: 66426,
    });
    db.prepare(READY_SQL).run(20720795648, complete, absent, declared, "on004624");
    const row = readRow(db, "on004624");
    expect(row.archive_status).toBe("ready");
    expect(row.archive_complete).toBe(0);
    expect(row.archive_absent_files).toBe(1);
    expect(row.archive_declared_files).toBe(66426);
  });

  test("a tally-less callback preserves a previously recorded completeness", () => {
    // First build records a partial.
    db.prepare(READY_SQL).run(1024, 0, 7, 100, "on004624");
    // The idempotent skip path re-fires the callback with no tally: the stream
    // script never ran, so it knows nothing. It must not blank what we know.
    const { complete, absent, declared } = deriveArchiveCompleteness({ dataset_id: "on004624" });
    expect(complete).toBeNull();
    db.prepare(READY_SQL).run(1024, complete, absent, declared, "on004624");
    const row = readRow(db, "on004624");
    expect(row.archive_complete).toBe(0);
    expect(row.archive_absent_files).toBe(7);
    expect(row.archive_declared_files).toBe(100);
  });

  test("a later complete rebuild clears the partial verdict", () => {
    db.prepare(READY_SQL).run(1024, 0, 7, 100, "on004624");
    const { complete, absent, declared } = deriveArchiveCompleteness({
      dataset_id: "on004624",
      absent: 0,
      unreadable: 0,
      declared: 100,
    });
    db.prepare(READY_SQL).run(2048, complete, absent, declared, "on004624");
    const row = readRow(db, "on004624");
    expect(row.archive_complete).toBe(1);
    // COALESCE takes the new 0 because 0 is not NULL -- the guard is against
    // NULL specifically, not against falsy values.
    expect(row.archive_absent_files).toBe(0);
  });

  test("'ready' marks the availability report stale so the sweep regenerates it", () => {
    // availability_report_at IS NULL is the sweep's candidacy predicate
    // (availabilityReportSweepWhere), so nulling it here is the entire enqueue.
    // Verified against that predicate below rather than just asserting NULL, so
    // this breaks if the sweep ever changes how it selects candidates.
    db.prepare("UPDATE datasets SET availability_report_at = ? WHERE dataset_id = ?").run(
      "2026-07-23 00:00:00",
      "on004624",
    );
    db.prepare(READY_SQL).run(1024, 0, 3, 100, "on004624");

    const stamp = db
      .prepare("SELECT availability_report_at FROM datasets WHERE dataset_id = ?")
      .get("on004624") as { availability_report_at: string | null };
    expect(stamp.availability_report_at).toBeNull();

    // The dataset must now actually be selected by the sweep's own predicate.
    db.prepare("UPDATE datasets SET github_repo = ? WHERE dataset_id = ?").run(
      "nemarDatasets/on004624",
      "on004624",
    );
    const candidate = db
      .prepare(
        `SELECT dataset_id FROM datasets
         WHERE github_repo IS NOT NULL
           AND (is_sandbox = 0 OR is_sandbox IS NULL)
           AND availability_report_at IS NULL`,
      )
      .all() as Array<{ dataset_id: string }>;
    expect(candidate.map((r) => r.dataset_id)).toContain("on004624");
  });

  test("enqueue and drain close the loop: stale -> candidate -> stamped -> not a candidate", () => {
    // The whole point of clearing the stamp is that the daily sweep picks the
    // row up and eventually puts it back. Exercise both halves against the
    // sweep's own exported SQL so this breaks if either side changes.
    db.prepare("UPDATE datasets SET github_repo = ? WHERE dataset_id = ?").run(
      "nemarDatasets/on004624",
      "on004624",
    );
    // Already reported at some point in the past -> not a candidate.
    db.prepare("UPDATE datasets SET availability_report_at = ? WHERE dataset_id = ?").run(
      "2026-07-23 00:00:00",
      "on004624",
    );
    const candidates = () =>
      (
        db.prepare(availabilityReportSweepCandidateQuery(false)).all(50) as Array<{
          dataset_id: string;
        }>
      ).map((r) => r.dataset_id);
    expect(candidates()).not.toContain("on004624");

    // A new archive lands -> enqueued.
    db.prepare(READY_SQL).run(1024, 0, 2, 50, "on004624");
    expect(candidates()).toContain("on004624");
    expect(
      (db.prepare(availabilityReportSweepRemainingQuery(false)).get() as { n: number }).n,
    ).toBeGreaterThan(0);

    // The sweep stamps on success -> drained, and it does not come back.
    db.prepare(
      "UPDATE datasets SET availability_report_at = datetime('now') WHERE dataset_id = ?",
    ).run("on004624");
    expect(candidates()).not.toContain("on004624");
  });

  test("the sweep cap stays low because each candidate is a GitHub commit", () => {
    // Read-only sweeps (hed, data-integrity) go to 30; this one writes to
    // GitHub per candidate, so it is deliberately lower. A silent bump here
    // would reintroduce the secondary-rate-limit burst this cap prevents.
    expect(AVAILABILITY_REPORT_SWEEP_MAX).toBe(10);
  });

  test("'ready' still clears a stale skip reason and resets the retry count", () => {
    db.prepare(
      "UPDATE datasets SET archive_skip_reason = 'too big', archive_retry_count = 3 WHERE dataset_id = ?",
    ).run("on004624");
    db.prepare(READY_SQL).run(1024, 1, 0, 10, "on004624");
    const row = db
      .prepare("SELECT archive_skip_reason, archive_retry_count FROM datasets WHERE dataset_id = ?")
      .get("on004624") as { archive_skip_reason: string | null; archive_retry_count: number };
    expect(row.archive_skip_reason).toBeNull();
    expect(row.archive_retry_count).toBe(0);
  });
});
