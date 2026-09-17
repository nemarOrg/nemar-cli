/**
 * Tests for the bounded archive auto-retry (epic #736, Phase 3 / #740):
 *   - the pure decision/parse helpers in src/services/archive-retry.ts, and
 *   - migration 0040 + the exact sweep candidate query, run against a real
 *     in-memory SQLite db (bun:sqlite, no mocks) with every migration applied so
 *     the `datasets` table matches production.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ARCHIVE_READY_UPDATE_SQL } from "../src/routes/callbacks/archive-ready";
import {
  ARCHIVE_RETRY_SWEEP_QUERY,
  MAX_ARCHIVE_RETRIES,
  decideArchiveRetry,
  resolveCurrentVersion,
  versionFromDoi,
} from "../src/services/archive-retry";

describe("decideArchiveRetry", () => {
  test("ready always resets the count and never retries", () => {
    expect(decideArchiveRetry("ready", 2, "1.0.0")).toEqual({
      retry: false,
      nextCount: 0,
      reason: "ready_reset",
    });
    // resets even when a version is absent
    expect(decideArchiveRetry("ready", 3, undefined)).toEqual({
      retry: false,
      nextCount: 0,
      reason: "ready_reset",
    });
  });

  test("failed without a version cannot retry and leaves the count untouched", () => {
    expect(decideArchiveRetry("failed", 1, undefined)).toEqual({
      retry: false,
      nextCount: 1,
      reason: "no_version",
    });
    expect(decideArchiveRetry("failed", 0, null)).toEqual({
      retry: false,
      nextCount: 0,
      reason: "no_version",
    });
  });

  test("failed under the cap retries and increments", () => {
    expect(decideArchiveRetry("failed", 0, "1.0.0")).toEqual({
      retry: true,
      nextCount: 1,
      reason: "retry",
    });
    expect(decideArchiveRetry("failed", MAX_ARCHIVE_RETRIES - 1, "1.0.0")).toEqual({
      retry: true,
      nextCount: MAX_ARCHIVE_RETRIES,
      reason: "retry",
    });
  });

  test("failed at or above the cap gives up without incrementing", () => {
    expect(decideArchiveRetry("failed", MAX_ARCHIVE_RETRIES, "1.0.0")).toEqual({
      retry: false,
      nextCount: MAX_ARCHIVE_RETRIES,
      reason: "cap_reached",
    });
    expect(decideArchiveRetry("failed", MAX_ARCHIVE_RETRIES + 5, "1.0.0").retry).toBe(false);
  });

  test("a full failure chain converges to the cap then stops", () => {
    let count = 0;
    let dispatches = 0;
    for (let i = 0; i < 10; i++) {
      const d = decideArchiveRetry("failed", count, "1.0.0");
      count = d.nextCount;
      if (d.retry) dispatches++;
    }
    expect(dispatches).toBe(MAX_ARCHIVE_RETRIES);
    expect(count).toBe(MAX_ARCHIVE_RETRIES);
  });
});

describe("versionFromDoi", () => {
  test("extracts the bare version from a version DOI", () => {
    expect(versionFromDoi("10.82901/nemar.nm000111.v1.0.1")).toBe("1.0.1");
    expect(versionFromDoi("10.82901/nemar.nm000132.v10.2.30")).toBe("10.2.30");
  });

  test("returns null for a concept DOI, malformed, or empty input", () => {
    expect(versionFromDoi("10.82901/nemar.nm000111")).toBeNull();
    expect(versionFromDoi("10.82901/nemar.nm000111.v1.0")).toBeNull();
    expect(versionFromDoi("")).toBeNull();
    expect(versionFromDoi(null)).toBeNull();
    expect(versionFromDoi(undefined)).toBeNull();
  });
});

describe("resolveCurrentVersion", () => {
  test("prefers the published version DOI", () => {
    expect(
      resolveCurrentVersion({
        latest_version_doi: "10.82901/nemar.nm000111.v1.0.1",
        recorded_version: "0.9.0",
      }),
    ).toBe("1.0.1");
  });

  test("falls back to the recorded version when no DOI is published", () => {
    // The shape an anonymous release leaves behind (#1447): a dataset_versions
    // row from the manifest callback, and latest_version_doi still NULL.
    expect(resolveCurrentVersion({ latest_version_doi: null, recorded_version: "1.0.0" })).toBe(
      "1.0.0",
    );
    // A concept DOI in the column has no .vX.Y.Z suffix, so it resolves nothing
    // and the recorded version is still the right answer.
    expect(
      resolveCurrentVersion({
        latest_version_doi: "10.82901/nemar.nm000111",
        recorded_version: "1.0.0",
      }),
    ).toBe("1.0.0");
  });

  test("returns null when neither source has a version", () => {
    expect(resolveCurrentVersion({ latest_version_doi: null, recorded_version: null })).toBeNull();
    expect(resolveCurrentVersion({})).toBeNull();
  });
});

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

function insertDataset(
  db: Database,
  d: {
    dataset_id: string;
    archive_status?: string | null;
    latest_version_doi?: string | null;
    archive_retry_count?: number;
    archive_checked_at?: string | null;
  },
): void {
  // The stamp lives in sweep_stamps -> $.archive_checked_at since migration
  // 0073 (#1183). A NULL archive_checked_at leaves sweep_stamps NULL (the
  // fresh post-0073 row shape), which the sweep must treat as never-checked.
  db.prepare(
    `INSERT INTO datasets
       (dataset_id, owner_user_id, name, visibility, is_sandbox,
        archive_status, latest_version_doi, archive_retry_count, sweep_stamps)
     VALUES (?, 1, ?, 'public', 0, ?, ?, COALESCE(?, 0),
             CASE WHEN ? IS NULL THEN NULL ELSE json_object('archive_checked_at', ?) END)`,
  ).run(
    d.dataset_id,
    d.dataset_id,
    d.archive_status ?? null,
    d.latest_version_doi ?? null,
    d.archive_retry_count ?? 0,
    d.archive_checked_at ?? null,
    d.archive_checked_at ?? null,
  );
}

/** A manifest-callback row: what a released version leaves in D1 (#1447). */
function seedVersion(
  db: Database,
  datasetId: string,
  version: string,
  doi: string,
  createdAt?: string,
): void {
  db.prepare(
    `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at)
     VALUES (?, ?, ?, 'ezid', COALESCE(?, datetime('now')))`,
  ).run(datasetId, version, doi, createdAt ?? null);
}

describe("migration 0040: archive_retry_count", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test("adds archive_retry_count NOT NULL DEFAULT 0", () => {
    insertDataset(db, { dataset_id: "nm000001" });
    const row = db
      .prepare("SELECT archive_retry_count FROM datasets WHERE dataset_id = ?")
      .get("nm000001") as { archive_retry_count: number };
    expect(row.archive_retry_count).toBe(0);
  });

  test("ready callback UPDATE resets the count to 0", () => {
    insertDataset(db, { dataset_id: "nm000001", archive_status: "failed", archive_retry_count: 2 });
    // The route's own UPDATE, imported rather than copied so this cannot
    // drift from what production runs.
    db.prepare(ARCHIVE_READY_UPDATE_SQL).run(123, null, null, null, "nm000001");
    const row = db
      .prepare("SELECT archive_status, archive_retry_count FROM datasets WHERE dataset_id = ?")
      .get("nm000001") as { archive_status: string; archive_retry_count: number };
    expect(row.archive_status).toBe("ready");
    expect(row.archive_retry_count).toBe(0);
  });
});

describe("ARCHIVE_RETRY_SWEEP_QUERY", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  interface SweptRow {
    dataset_id: string;
    latest_version_doi: string | null;
    recorded_version: string | null;
    archive_retry_count: number;
  }

  function sweepRows(): SweptRow[] {
    return db.prepare(ARCHIVE_RETRY_SWEEP_QUERY).all(MAX_ARCHIVE_RETRIES) as SweptRow[];
  }

  function sweepIds(): string[] {
    return sweepRows().map((r) => r.dataset_id);
  }

  test("selects a failed, versioned, under-cap, stale-checked dataset", () => {
    insertDataset(db, {
      dataset_id: "nm000001",
      archive_status: "failed",
      latest_version_doi: "10.82901/nemar.nm000001.v1.0.0",
      archive_retry_count: 1,
      archive_checked_at: "2020-01-01 00:00:00",
    });
    expect(sweepIds()).toEqual(["nm000001"]);
  });

  test("selects a failed dataset that was never checked (NULL checked_at)", () => {
    insertDataset(db, {
      dataset_id: "nm000002",
      archive_status: "failed",
      latest_version_doi: "10.82901/nemar.nm000002.v1.0.0",
      archive_retry_count: 0,
      archive_checked_at: null,
    });
    expect(sweepIds()).toEqual(["nm000002"]);
  });

  test("excludes ready, no-version, at-cap, and recently-checked rows", () => {
    insertDataset(db, {
      dataset_id: "nm000010",
      archive_status: "ready",
      latest_version_doi: "10.82901/nemar.nm000010.v1.0.0",
      archive_checked_at: "2020-01-01 00:00:00",
    });
    insertDataset(db, {
      dataset_id: "nm000011",
      archive_status: "failed",
      latest_version_doi: null,
      archive_checked_at: "2020-01-01 00:00:00",
    });
    insertDataset(db, {
      dataset_id: "nm000012",
      archive_status: "failed",
      latest_version_doi: "10.82901/nemar.nm000012.v1.0.0",
      archive_retry_count: MAX_ARCHIVE_RETRIES,
      archive_checked_at: "2020-01-01 00:00:00",
    });
    insertDataset(db, {
      dataset_id: "nm000013",
      archive_status: "failed",
      latest_version_doi: "10.82901/nemar.nm000013.v1.0.0",
      archive_retry_count: 0,
      archive_checked_at: "2999-01-01 00:00:00", // checked in the (far) future -> not stale
    });
    expect(sweepIds()).toEqual([]);
  });

  test("selects a released ANONYMOUS deposit: no version DOI, but a version row", () => {
    // The exact shape #1447 leaves: the release cut a tag and generated an
    // archive, the manifest callback inserted the version, and
    // latest_version_doi stays NULL because the identifier is reserved. Keying
    // off the column alone made this dataset's failed archive unreachable.
    insertDataset(db, {
      dataset_id: "nm099998",
      archive_status: "failed",
      latest_version_doi: null,
      archive_retry_count: 0,
      archive_checked_at: null,
    });
    seedVersion(db, "nm099998", "1.0.0", "10.5072/fk2nemar.nm099998.v1.0.0");
    expect(sweepRows()).toEqual([
      {
        dataset_id: "nm099998",
        latest_version_doi: null,
        recorded_version: "1.0.0",
        archive_retry_count: 0,
      },
    ]);
  });

  test("a failed dataset with neither source is still excluded", () => {
    // The budget guard: LIMIT 20 is the whole run, so a row that could never be
    // dispatched must not take a slot. This is the control for the widening --
    // it is only the version ROW that admits nm000021, not the widening itself.
    insertDataset(db, {
      dataset_id: "nm000020",
      archive_status: "failed",
      latest_version_doi: null,
      archive_checked_at: null,
    });
    insertDataset(db, {
      dataset_id: "nm000021",
      archive_status: "failed",
      latest_version_doi: null,
      archive_checked_at: null,
    });
    seedVersion(db, "nm000021", "2.1.0", "10.82901/nemar.nm000021.v2.1.0");
    expect(sweepIds()).toEqual(["nm000021"]);
  });

  test("the recorded version is the newest row, and the published DOI still wins", () => {
    insertDataset(db, {
      dataset_id: "nm000030",
      archive_status: "failed",
      latest_version_doi: null,
      archive_checked_at: null,
    });
    // Out of semver order on purpose: ORDER BY created_at DESC, not by string.
    seedVersion(db, "nm000030", "1.10.0", "10.82901/nemar.nm000030.v1.10.0", "2026-01-02 00:00:00");
    seedVersion(db, "nm000030", "1.9.0", "10.82901/nemar.nm000030.v1.9.0", "2026-01-01 00:00:00");

    insertDataset(db, {
      dataset_id: "nm000031",
      archive_status: "failed",
      latest_version_doi: "10.82901/nemar.nm000031.v3.0.0",
      archive_checked_at: null,
    });
    seedVersion(db, "nm000031", "2.0.0", "10.82901/nemar.nm000031.v2.0.0");

    const byId = new Map(sweepRows().map((r) => [r.dataset_id, r]));
    expect(byId.get("nm000030")?.recorded_version).toBe("1.10.0");
    // Both sources present: resolveCurrentVersion prefers the published one, so
    // the retry rebuilds v3.0.0 and not the stale version row.
    expect(resolveCurrentVersion(byId.get("nm000031") as SweptRow)).toBe("3.0.0");
  });
});
