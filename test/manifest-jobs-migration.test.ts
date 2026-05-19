/**
 * Structural assertions on migration 0025 (manifest_jobs table for the
 * centralized manifest workflow, #557 Stream B).
 *
 * The Bun unit harness can't run real D1, but the SQL file itself is
 * load-bearing in ways that have historically regressed in other
 * migrations (missing UNIQUE constraint, missing IF NOT EXISTS on
 * indexes, drift between the doc and the schema). Pin the contract
 * surface here; D1 application is verified post-deploy via the
 * /webhooks/manifest-ready handler at e2e time.
 *
 * Note: Runtime replay semantics (second callback with same nonce → 401)
 * require live D1 + handler dispatch. Deferred to epic E2E (#559
 * acceptance). This file pins the schema contract only.
 *
 * Pairs with `manifest-callback-token.test.ts` (HMAC contract) and the
 * webhook handler integration in `backend/src/routes/webhooks.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_PATH = join(
  import.meta.dir,
  "..",
  "backend/src/db/migrations/0025_manifest_jobs.sql",
);
const sql = readFileSync(MIGRATION_PATH, "utf8");

describe("migration 0025: manifest_jobs structure", () => {
  test("creates the manifest_jobs table with IF NOT EXISTS (idempotent re-apply)", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS manifest_jobs");
  });

  test("primary key is an autoincrement INTEGER -- not a UUID column", () => {
    // Autoincrement matters because we look up the row by id in the
    // /webhooks/manifest-ready handler to do the status flip. A change
    // to ROWID-only or to UUID-pk would break that handler silently.
    expect(sql).toMatch(/id INTEGER PRIMARY KEY AUTOINCREMENT/);
  });

  test("requires (dataset_id, version, nonce) as NOT NULL columns", () => {
    expect(sql).toMatch(/dataset_id TEXT NOT NULL/);
    expect(sql).toMatch(/version TEXT NOT NULL/);
    expect(sql).toMatch(/nonce TEXT NOT NULL/);
  });

  test("optional DOI/provider fields are nullable", () => {
    // doi is null when the dispatching path hasn't minted yet; we want
    // a row written before dispatch fires regardless.
    expect(sql).toMatch(/doi TEXT,/);
    expect(sql).toMatch(/concept_doi TEXT,/);
    expect(sql).toMatch(/doi_provider TEXT,/);
  });

  test("status defaults to 'dispatched' and is NOT NULL", () => {
    // The /webhooks/manifest-ready and /manifest-failed handlers gate
    // on status='dispatched' to prevent replay; a NULL default would
    // let a freshly-inserted row look already-handled.
    expect(sql).toMatch(/status TEXT NOT NULL DEFAULT 'dispatched'/);
  });

  test("documents the three legal status values in a comment", () => {
    // Keeps the source of truth co-located with the schema; the worker
    // code reads/writes these exact strings, so they're an API surface.
    // Assert the DEFAULT value specifically (load-bearing constraint:
    // a freshly-inserted row must be 'dispatched' so the manifest-ready
    // status='dispatched' gate accepts the callback) and the documented
    // enum comment appears verbatim. A regression that drops the
    // comment or changes the default would fail here.
    expect(sql).toMatch(/status TEXT NOT NULL DEFAULT 'dispatched'/);
    expect(sql).toMatch(/dispatched \| ready \| failed/);
  });

  test("created_at defaults to datetime('now') -- queryable timeline", () => {
    expect(sql).toMatch(/created_at TEXT NOT NULL DEFAULT \(datetime\('now'\)\)/);
  });

  test("has completed_at, workflow_run_url, error_message for failure post-mortem", () => {
    expect(sql).toContain("completed_at TEXT");
    expect(sql).toContain("workflow_run_url TEXT");
    expect(sql).toContain("error_message TEXT");
  });

  test("UNIQUE (dataset_id, version, nonce) prevents replay collision", () => {
    // This is the load-bearing constraint: a successful callback for
    // dispatch #1 cannot replay against dispatch #2 because the new
    // dispatch generates a new nonce row.
    expect(sql).toMatch(/UNIQUE\(dataset_id, version, nonce\)/);
  });

  test("adds an index on status for queue-style sweeps", () => {
    // Ops will want SELECT * FROM manifest_jobs WHERE status='failed'
    // (and 'dispatched' for stuck-job detection). The index keeps that
    // cheap as the table grows.
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_manifest_jobs_status/);
  });

  test("adds an index on (dataset_id, version) for callback lookups", () => {
    // /webhooks/manifest-ready looks up by (dataset_id, version,
    // status='dispatched'). Without this index that scan grows with
    // table size.
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_manifest_jobs_dataset_version/);
    expect(sql).toMatch(/ON manifest_jobs\(dataset_id, version\)/);
  });
});
