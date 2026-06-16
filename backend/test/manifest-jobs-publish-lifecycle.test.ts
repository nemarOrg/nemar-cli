/**
 * Tests for migration 0042_manifest_jobs_publish_lifecycle.sql and the exact SQL
 * the async version-DOI publish path runs (epic #749, Phase 2 / #751):
 *   - the synchronous `accepted` row insert (handleEzidVersionDoiAsync)
 *   - the accepted -> dispatched promote (dispatchCentralManifestJob promoteNonce)
 *   - the residual failure UPDATE
 *   - the dispatched -> ready transition (manifest-ready, unchanged contract)
 *   - the /webhooks/version-doi-status SELECT
 *   - the in-flight idempotency SELECT
 *
 * Runs against a real in-memory SQLite database via bun:sqlite (no mocks),
 * applying every migration in order so manifest_jobs matches production.
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

/** Mirror of the synchronous `accepted` insert in handleEzidVersionDoiAsync. */
function insertAccepted(
  db: Database,
  datasetId: string,
  version: string,
  nonce: string,
  conceptDoi: string | null,
  createdAt?: string,
): void {
  if (createdAt) {
    db.prepare(
      `INSERT INTO manifest_jobs (dataset_id, version, nonce, doi, concept_doi, doi_provider, status, request_source, created_at)
       VALUES (?, ?, ?, NULL, ?, 'ezid', 'accepted', 'webhook', ?)`,
    ).run(datasetId, version, nonce, conceptDoi, createdAt);
  } else {
    db.prepare(
      `INSERT INTO manifest_jobs (dataset_id, version, nonce, doi, concept_doi, doi_provider, status, request_source)
       VALUES (?, ?, ?, NULL, ?, 'ezid', 'accepted', 'webhook')`,
    ).run(datasetId, version, nonce, conceptDoi);
  }
}

describe("migration 0042: manifest_jobs publish lifecycle", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test("adds request_source column, NULL by default for the legacy insert path", () => {
    // The legacy (non-promote) dispatch path inserts without request_source.
    db.prepare(
      `INSERT INTO manifest_jobs (dataset_id, version, nonce, doi, concept_doi, doi_provider, status)
       VALUES ('nm000001', '1.0.0', 'n1', 'doi', 'cdoi', 'ezid', 'dispatched')`,
    ).run();
    const row = db
      .prepare("SELECT request_source, status FROM manifest_jobs WHERE nonce = 'n1'")
      .get() as Record<string, unknown>;
    expect(row.request_source).toBeNull();
    expect(row.status).toBe("dispatched");
  });

  test("accepted insert records doi=NULL, request_source, status=accepted", () => {
    insertAccepted(db, "on005385", "1.0.0", "nonce-a", "10.x/concept");
    const row = db
      .prepare(
        "SELECT doi, status, request_source, doi_provider FROM manifest_jobs WHERE nonce = 'nonce-a'",
      )
      .get() as Record<string, unknown>;
    expect(row.doi).toBeNull();
    expect(row.status).toBe("accepted");
    expect(row.request_source).toBe("webhook");
    expect(row.doi_provider).toBe("ezid");
  });

  test("promote accepted -> dispatched stamps the minted DOI; no-op when not accepted", () => {
    insertAccepted(db, "on005385", "1.0.0", "nonce-a", "10.x/concept");

    // promote (dispatchCentralManifestJob promoteNonce branch)
    const promote = db
      .prepare(
        `UPDATE manifest_jobs
         SET status = 'dispatched', doi = ?, concept_doi = ?, doi_provider = ?
         WHERE dataset_id = ? AND version = ? AND nonce = ? AND status = 'accepted'`,
      )
      .run("10.x/v1", "10.x/concept", "ezid", "on005385", "1.0.0", "nonce-a");
    expect(promote.changes).toBe(1);

    const row = db
      .prepare("SELECT status, doi FROM manifest_jobs WHERE nonce = 'nonce-a'")
      .get() as { status: string; doi: string };
    expect(row.status).toBe("dispatched");
    expect(row.doi).toBe("10.x/v1");

    // second promote is a no-op (status no longer 'accepted') — idempotent re-drive
    const again = db
      .prepare(
        `UPDATE manifest_jobs SET status = 'dispatched', doi = ?, concept_doi = ?, doi_provider = ?
         WHERE dataset_id = ? AND version = ? AND nonce = ? AND status = 'accepted'`,
      )
      .run("10.x/v1", "10.x/concept", "ezid", "on005385", "1.0.0", "nonce-a");
    expect(again.changes).toBe(0);
  });

  test("residual failure UPDATE marks accepted -> failed with error_message", () => {
    insertAccepted(db, "on005385", "1.0.0", "nonce-a", "10.x/concept");
    const fail = db
      .prepare(
        `UPDATE manifest_jobs SET status = 'failed', error_message = ?, completed_at = datetime('now')
         WHERE dataset_id = ? AND version = ? AND nonce = ?`,
      )
      .run("EZID 500", "on005385", "1.0.0", "nonce-a");
    expect(fail.changes).toBe(1);
    const row = db
      .prepare("SELECT status, error_message FROM manifest_jobs WHERE nonce = 'nonce-a'")
      .get() as { status: string; error_message: string };
    expect(row.status).toBe("failed");
    expect(row.error_message).toBe("EZID 500");
  });

  test("manifest-ready dispatched -> ready transition still matches (unchanged contract)", () => {
    insertAccepted(db, "on005385", "1.0.0", "nonce-a", "10.x/concept");
    db.prepare(
      `UPDATE manifest_jobs SET status = 'dispatched', doi = '10.x/v1'
       WHERE nonce = 'nonce-a' AND status = 'accepted'`,
    ).run();
    // manifest-ready filters status='dispatched'
    const ready = db
      .prepare(
        `UPDATE manifest_jobs SET status = 'ready', completed_at = datetime('now')
         WHERE id = (SELECT id FROM manifest_jobs WHERE dataset_id = ? AND version = ? AND status = 'dispatched' ORDER BY created_at DESC LIMIT 1)
           AND status = 'dispatched'`,
      )
      .run("on005385", "1.0.0");
    expect(ready.changes).toBe(1);
    expect(
      (db.prepare("SELECT status FROM manifest_jobs WHERE nonce = 'nonce-a'").get() as { status: string })
        .status,
    ).toBe("ready");
  });

  test("version-doi-status SELECT returns the latest row; nothing for unknown", () => {
    // Two attempts for the same (dataset, version): the newer one wins.
    insertAccepted(db, "on005385", "1.0.0", "old", "10.x/concept", "2026-06-15 10:00:00");
    db.prepare("UPDATE manifest_jobs SET status = 'failed', error_message = 'first try' WHERE nonce = 'old'").run();
    insertAccepted(db, "on005385", "1.0.0", "new", "10.x/concept", "2026-06-15 11:00:00");
    db.prepare("UPDATE manifest_jobs SET status = 'ready', doi = '10.x/v1' WHERE nonce = 'new'").run();

    const latest = db
      .prepare(
        `SELECT status, doi, error_message FROM manifest_jobs
         WHERE dataset_id = ? AND version = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get("on005385", "1.0.0") as { status: string; doi: string | null; error_message: string | null };
    expect(latest.status).toBe("ready");
    expect(latest.doi).toBe("10.x/v1");

    const unknown = db
      .prepare(
        `SELECT status FROM manifest_jobs WHERE dataset_id = ? AND version = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get("on999999", "1.0.0");
    expect(unknown).toBeNull();
  });

  test("in-flight idempotency SELECT finds accepted/dispatched, ignores terminal", () => {
    const inflightSql = `SELECT id, status FROM manifest_jobs
       WHERE dataset_id = ? AND version = ? AND status IN ('accepted', 'dispatched')
       ORDER BY created_at DESC LIMIT 1`;

    // terminal-only -> no short-circuit (re-drive allowed)
    insertAccepted(db, "on005385", "1.0.0", "done", "10.x/concept", "2026-06-15 10:00:00");
    db.prepare("UPDATE manifest_jobs SET status = 'ready' WHERE nonce = 'done'").run();
    expect(db.prepare(inflightSql).get("on005385", "1.0.0")).toBeNull();

    // an accepted attempt -> short-circuit
    insertAccepted(db, "on005385", "1.0.0", "live", "10.x/concept", "2026-06-15 11:00:00");
    const hit = db.prepare(inflightSql).get("on005385", "1.0.0") as { status: string };
    expect(hit.status).toBe("accepted");
  });
});
