/**
 * Tests for the daily manifest-integrity sweep (#1130): the exact candidate
 * query run against a real in-memory SQLite db (bun:sqlite, no mocks) with
 * every migration applied so the schema matches production.
 *
 * The predicates are load-bearing the same way the missing-manifest doctor
 * check's are: auto-regenerating a manifest for a private or deleted dataset
 * would leak content, and a null github_repo has nothing to regenerate from.
 * The sweep adds a recency window on dataset_versions.created_at, bounding
 * the per-run S3 subrequest cost inside the shared cron invocation.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_SWEEP_QUERY, MANIFEST_SWEEP_WINDOW } from "../src/services/manifest-sweep";

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
    status?: string;
    visibility?: string;
    github_repo?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, owner_user_id, name, status, visibility, github_repo)
     VALUES (?, 1, ?, ?, ?, ?)`,
  ).run(
    d.dataset_id,
    d.dataset_id,
    d.status ?? "active",
    d.visibility ?? "public",
    d.github_repo === undefined
      ? `https://github.com/nemarDatasets/${d.dataset_id}`
      : d.github_repo,
  );
}

function insertVersion(db: Database, datasetId: string, version: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO dataset_versions (dataset_id, version, doi, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(datasetId, version, `10.82901/nemar.${datasetId}.v${version}`, createdAt);
}

function runSweepQuery(db: Database): Array<{ dataset_id: string; version: string }> {
  const rows = db.prepare(MANIFEST_SWEEP_QUERY).all(MANIFEST_SWEEP_WINDOW) as Array<{
    dataset_id: string;
    version: string;
  }>;
  return rows.map((r) => ({ dataset_id: r.dataset_id, version: r.version }));
}

describe("manifest-sweep candidate query", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  test("selects a recent version of an active public dataset with a repo", () => {
    insertDataset(db, { dataset_id: "nm000225" });
    insertVersion(db, "nm000225", "1.1.0", "2026-06-03 02:49:23");
    // Pin the window semantics with a live timestamp too: datetime('now')
    // versions must always be inside a '-30 days' window.
    insertDataset(db, { dataset_id: "nm000300" });
    db.prepare("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, ?, ?)").run(
      "nm000300",
      "1.0.0",
      "10.82901/nemar.nm000300.v1.0.0",
    );

    const rows = runSweepQuery(db);
    expect(rows.map((r) => r.dataset_id)).toContain("nm000300");
    // The June timestamp is outside the 30-day window relative to the real
    // clock, so it must NOT appear: the window is what keeps the sweep
    // bounded, and silently widening it would blow the subrequest budget.
    expect(rows.map((r) => r.dataset_id)).not.toContain("nm000225");
  });

  test("excludes versions older than the window", () => {
    insertDataset(db, { dataset_id: "nm000101" });
    db.prepare(
      `INSERT INTO dataset_versions (dataset_id, version, doi, created_at)
       VALUES (?, ?, ?, datetime('now', '-31 days'))`,
    ).run("nm000101", "1.0.0", "10.82901/nemar.nm000101.v1.0.0");
    db.prepare(
      `INSERT INTO dataset_versions (dataset_id, version, doi, created_at)
       VALUES (?, ?, ?, datetime('now', '-29 days'))`,
    ).run("nm000101", "1.0.1", "10.82901/nemar.nm000101.v1.0.1");

    const rows = runSweepQuery(db);
    expect(rows).toEqual([{ dataset_id: "nm000101", version: "1.0.1" }]);
  });

  test("excludes private, deleted, and repo-less datasets", () => {
    insertDataset(db, { dataset_id: "nm000201", visibility: "private" });
    insertDataset(db, { dataset_id: "nm000202", status: "deleted" });
    insertDataset(db, { dataset_id: "nm000203", github_repo: null });
    insertDataset(db, { dataset_id: "nm000204" });
    for (const id of ["nm000201", "nm000202", "nm000203", "nm000204"]) {
      db.prepare(
        `INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)`,
      ).run(id, `10.82901/nemar.${id}.v1.0.0`);
    }

    const rows = runSweepQuery(db);
    expect(rows).toEqual([{ dataset_id: "nm000204", version: "1.0.0" }]);
  });

  test("returns newest versions first and carries the fix() inputs", () => {
    insertDataset(db, { dataset_id: "nm000210" });
    db.prepare(
      `INSERT INTO dataset_versions (dataset_id, version, doi, created_at)
       VALUES (?, '1.0.0', ?, datetime('now', '-2 days')),
              (?, '1.1.0', ?, datetime('now', '-1 days'))`,
    ).run(
      "nm000210",
      "10.82901/nemar.nm000210.v1.0.0",
      "nm000210",
      "10.82901/nemar.nm000210.v1.1.0",
    );

    const rows = db.prepare(MANIFEST_SWEEP_QUERY).all(MANIFEST_SWEEP_WINDOW) as Array<
      Record<string, unknown>
    >;
    expect(rows.map((r) => r.version)).toEqual(["1.1.0", "1.0.0"]);
    // The Finding.details bag the doctor fix() reads back must be complete.
    expect(rows[0]).toHaveProperty("doi", "10.82901/nemar.nm000210.v1.1.0");
    expect(rows[0]).toHaveProperty("github_repo", "https://github.com/nemarDatasets/nm000210");
    expect(rows[0]).toHaveProperty("concept_doi");
  });

  test("is bounded: LIMIT 50 is part of the pinned SQL", () => {
    // The bound is what keeps the daily cron inside the shared Workers
    // subrequest budget (one S3 GET per candidate). Pin it textually so a
    // refactor cannot silently unbound the sweep.
    expect(MANIFEST_SWEEP_QUERY).toMatch(/LIMIT 50\s*$/);
    expect(MANIFEST_SWEEP_WINDOW).toBe("-30 days");
  });
});
