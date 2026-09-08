/**
 * The `last_error` invariant (epic #1306, ADR 0050):
 *
 *   A SPECIFIC error message must never be overwritten by a GENERIC one.
 *
 * Two layers:
 *   - the pure rule (isGenericImportError / resolveImportError), and
 *   - the regression it exists to prevent, driven through the REAL recovery
 *     path against real in-memory SQLite with every migration applied.
 *
 * The regression test is the point of this file. `runImportRecovery` used to
 * overwrite `last_error` with `quarantined: <reason>`, which does not contain
 * the literal `[openneuro-upstream-inaccessible]` marker that
 * IMPORT_RETRY_CANDIDATES_QUERY requires to re-select a quarantined row. So a
 * dataset quarantined for being upstream-inaccessible could never be retried.
 *
 * The pre-existing test for that query (import-retry.test.ts) missed it by
 * hand-building its fixture as `quarantined: ${OPENNEURO_UPSTREAM_MARKER}` -- a
 * string production never writes -- so it asserted the intent rather than the
 * behaviour. Here the fixture is produced BY the production code path.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  GENERIC_IMPORT_ERROR_PREFIXES,
  isGenericImportError,
  resolveImportError,
} from "../src/services/import-error";
import { OPENNEURO_UPSTREAM_MARKER, runImportRecovery } from "../src/services/import-recovery";
import { IMPORT_RETRY_CANDIDATES_QUERY } from "../src/services/import-retry";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

// The real message the CLI emits for an upstream-inaccessible prepare, marker
// included. Mirrors src/lib/import-openneuro.ts.
const UPSTREAM_MESSAGE = `${OPENNEURO_UPSTREAM_MARKER} OpenNeuro objects not anonymously readable; NEMAR has no signed OpenNeuro login (see run log)`;

// ---------------------------------------------------------------------------
// The pure rule
// ---------------------------------------------------------------------------

describe("isGenericImportError", () => {
  test("absence of information counts as generic", () => {
    expect(isGenericImportError(null)).toBe(true);
    expect(isGenericImportError(undefined)).toBe(true);
    expect(isGenericImportError("")).toBe(true);
    expect(isGenericImportError("   ")).toBe(true);
  });

  test("every declared bookkeeping prefix is generic", () => {
    for (const prefix of GENERIC_IMPORT_ERROR_PREFIXES) {
      expect(isGenericImportError(`${prefix}whatever`)).toBe(true);
    }
  });

  test("the strings the pipeline actually writes are generic", () => {
    expect(isGenericImportError("terminal: prepare=failure copy=failure finalize=failure")).toBe(
      true,
    );
    expect(isGenericImportError("quarantined: upstream_inaccessible")).toBe(true);
    expect(isGenericImportError("auto-rollback: unambiguous_orphan")).toBe(true);
    expect(isGenericImportError("stuck > 6h (scheduled sweep)")).toBe(true);
  });

  test("a real diagnosis is specific", () => {
    expect(isGenericImportError(UPSTREAM_MESSAGE)).toBe(false);
    expect(
      isGenericImportError(
        "Failed to push: remote: Invalid username or token. Password authentication is not supported for Git operations.",
      ),
    ).toBe(false);
    expect(
      isGenericImportError(
        "Failed to configure S3 remote: The bucket already exists, and its annex-uuid file indicates it is used by a different special remote.",
      ),
    ).toBe(false);
  });
});

describe("resolveImportError", () => {
  test("a generic incoming never overwrites a specific stored", () => {
    expect(resolveImportError(UPSTREAM_MESSAGE, "terminal: prepare=failure")).toBe(
      UPSTREAM_MESSAGE,
    );
    expect(resolveImportError(UPSTREAM_MESSAGE, "quarantined: upstream_inaccessible")).toBe(
      UPSTREAM_MESSAGE,
    );
    expect(resolveImportError(UPSTREAM_MESSAGE, null)).toBe(UPSTREAM_MESSAGE);
  });

  test("a specific incoming always wins -- a better diagnosis replaces an earlier one", () => {
    expect(resolveImportError("terminal: prepare=failure", UPSTREAM_MESSAGE)).toBe(
      UPSTREAM_MESSAGE,
    );
    expect(resolveImportError(UPSTREAM_MESSAGE, "Failed to push: GH013")).toBe(
      "Failed to push: GH013",
    );
  });

  test("generic replaces generic, so bookkeeping still updates", () => {
    expect(resolveImportError("terminal: prepare=failure", "quarantined: has_doi")).toBe(
      "quarantined: has_doi",
    );
    expect(resolveImportError(null, "terminal: prepare=failure")).toBe("terminal: prepare=failure");
  });
});

// ---------------------------------------------------------------------------
// The regression, driven through the real recovery path
// ---------------------------------------------------------------------------

/** Seed a `failed` import_jobs row plus the datasets row recovery reads. */
function seedFailedImport(db: Database, datasetId: string, lastError: string): void {
  db.query(
    `INSERT INTO import_jobs (dataset_id, source, source_id, stage, status, last_error)
     VALUES (?, 'openneuro', ?, 'prepare', 'failed', ?)`,
  ).run(datasetId, `ds${datasetId.slice(2)}`, lastError);
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, visibility, status)
     VALUES (?, 'test', 1, 'private', 'active')`,
  ).run(datasetId);
}

function retryCandidateIds(db: Database): string[] {
  return (
    db.query(IMPORT_RETRY_CANDIDATES_QUERY).all("2099-01-01 00:00:00", 100) as {
      dataset_id: string;
    }[]
  ).map((r) => r.dataset_id);
}

describe("recovery preserves the marker the retry engine needs", () => {
  // No email config -> alertAdmins is a no-op. Auto-rollback off, so the
  // marker path goes straight to quarantine with no cascade.
  const env = { ENVIRONMENT: "test" } as unknown as Bindings;

  test("an upstream-inaccessible quarantine stays retryable", async () => {
    const db = freshDb();
    seedFailedImport(db, "on000001", UPSTREAM_MESSAGE);

    const status = await runImportRecovery(realD1(db), env, "on000001");
    expect(status).toBe("quarantined");

    const row = db
      .query("SELECT status, last_error FROM import_jobs WHERE dataset_id = ?")
      .get("on000001") as { status: string; last_error: string | null };

    expect(row.status).toBe("quarantined");
    // The marker must survive recovery, verbatim.
    expect(row.last_error).toContain(OPENNEURO_UPSTREAM_MARKER);
    // ...and therefore the row is still a retry candidate. This is the
    // assertion that fails without the fix: recovery used to write
    // "quarantined: upstream_inaccessible", which drops the bracketed marker
    // and makes the row invisible to the candidate query forever.
    expect(retryCandidateIds(db)).toContain("on000001");
  });

  test("a quarantine with no specific error still records the reason", async () => {
    const db = freshDb();
    // Generic stored error -> nothing to protect, so bookkeeping is written.
    seedFailedImport(db, "on000002", "terminal: prepare=failure copy=failure finalize=failure");

    await runImportRecovery(realD1(db), env, "on000002");

    const row = db
      .query("SELECT status, last_error FROM import_jobs WHERE dataset_id = ?")
      .get("on000002") as { status: string; last_error: string | null };

    expect(row.status).toBe("quarantined");
    expect(row.last_error).toStartWith("quarantined: ");
    // Not upstream-inaccessible, so correctly NOT a retry candidate.
    expect(retryCandidateIds(db)).not.toContain("on000002");
  });
});
