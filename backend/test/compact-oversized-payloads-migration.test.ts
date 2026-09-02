/**
 * Migration 0074_compact_oversized_payloads (#1189, fixes #1188): rewrite the
 * stored unbounded per-file payloads -- `audit_log.details` integrity-check
 * key arrays and `datasets.zarr_data_failures` entry arrays -- into the
 * counts-and-pointer summaries the write paths now produce, so no row renders
 * a backup INSERT statement over D1's ~100 KB limit (SQLITE_TOOBIG aborted a
 * real restore partway).
 *
 * Real engine, no mocks: every migration before 0074 is applied to a real
 * bun:sqlite database, rows are seeded at the production worst case (12,397
 * missing keys / 877 zarr failure entries) plus every leave-alone class
 * (already compact, NULL, non-JSON, array-carrying but not the integrity
 * shape), then 0074 is applied and the outcome asserted -- including that
 * derived counts SURVIVE and that a rendered single-row INSERT stays under
 * the 95,000-byte acceptance bound that makes restore-remote.sh work again.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type DatasetVersionIntegrityResult,
  integrityAuditSummary,
} from "../src/services/import-integrity";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");
const COMPACT_FILE = "0074_compact_oversized_payloads.sql";

/**
 * The acceptance bound (#1189): after 0074, no audit_log or datasets row may
 * render a backup statement larger than this. Comfortably under D1's ~100 KB
 * statement limit, which the restore hit at 15 statements (#1188).
 */
const MAX_STATEMENT_BYTES = 95_000;

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** Apply every migration strictly before 0074 (the known-good chain). */
function dbBefore0074(): Database {
  const db = new Database(":memory:");
  for (const f of migrationFiles().filter((f) => f < COMPACT_FILE)) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
  }
  return db;
}

/**
 * Statement-at-a-time application, same as
 * reclaim-column-budget-migration.test.ts (see there for the verified
 * failure mode): bun:sqlite's exec() on a multi-statement string swallows
 * any statement error except the last one's, so exec()ing the whole file
 * could let a failing first UPDATE pass silently. D1 applies statements
 * individually and fails loudly; this models that. 0074 has no triggers,
 * but the splitter keeps the CREATE TRIGGER handling so it stays reusable.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current: string[] = [];
  let inTrigger = false;
  for (const line of sql.split("\n")) {
    const stripped = line.trim();
    if (stripped === "" || stripped.startsWith("--")) continue;
    current.push(line);
    if (/^CREATE TRIGGER/i.test(stripped)) inTrigger = true;
    const ends = inTrigger ? /^END;$/i.test(stripped) : stripped.endsWith(";");
    if (ends) {
      statements.push(current.join("\n"));
      current = [];
      inTrigger = false;
    }
  }
  if (current.length > 0) statements.push(current.join("\n"));
  return statements;
}

function apply0074(db: Database): void {
  for (const stmt of splitStatements(readFileSync(join(MIGRATIONS_DIR, COMPACT_FILE), "utf-8"))) {
    db.exec(stmt);
  }
}

const byteLength = (s: string) => new TextEncoder().encode(s).byteLength;

/** Synthetic annex keys shaped like production's (`SHA256E-s<size>--<hash>.<ext>`). */
function annexKeys(n: number): string[] {
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    keys.push(`SHA256E-s${1000000 + i}--${String(i).padStart(8, "0").repeat(8)}.edf`);
  }
  return keys;
}

/** The production worst case (#1188): 12,397 missing keys, ~1.1 MB inlined. */
function bigVerified(): DatasetVersionIntegrityResult {
  const missingKeys = annexKeys(12397);
  return {
    complete: false,
    missingKeys,
    zeroByteKeys: missingKeys.slice(0, 41),
    expectedCount: 12400,
    presentCount: 3,
    bytesPresent: 123456,
    declaredBytes: 987654321,
    declaredFiles: 12500,
    version: "2.0.0",
  };
}

/** Null-version variant: the migration must carry `null` through as JSON
 *  null, not the string "null" and not 0. */
function smallVerified(): DatasetVersionIntegrityResult {
  return {
    complete: false,
    missingKeys: annexKeys(500),
    zeroByteKeys: [],
    expectedCount: 500,
    presentCount: 0,
    bytesPresent: 0,
    declaredBytes: 4200,
    declaredFiles: 500,
    version: null,
  };
}

/** 877 entries, the largest production `zarr_data_failures` row (#1188). */
function zarrFailureArray(n: number): string {
  const out: { path: string; code: string; reason: string }[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      path: `sub-${String(i).padStart(4, "0")}/ses-01/eeg/sub-${String(i).padStart(4, "0")}_ses-01_task-rest_run-01_eeg.bdf`,
      code: "mixed_sample_rates",
      reason: "EDF/BDF channels declare differing sample rates (#737)",
    });
  }
  return JSON.stringify(out);
}

// Leave-alone payloads, asserted byte-identical after the migration.
const NATIVE_SUMMARY = JSON.stringify(
  integrityAuditSummary({
    complete: true,
    missingKeys: [],
    zeroByteKeys: [],
    expectedCount: 10,
    presentCount: 10,
    bytesPresent: 100,
    declaredBytes: 100,
    declaredFiles: 10,
    version: "1.0.0",
  }),
);
const NON_JSON_DETAILS = "plain text log line, not JSON at all";
const UNRELATED_ARRAY_DETAILS = JSON.stringify({
  dataset_ids: ["on000002", "on000003"],
  updated: 2,
});
// Carries ONE of the two integrity arrays: not the
// DatasetVersionIntegrityResult signature (that pair travels together), so
// the shape-scoped rewrite must not fabricate a summary with null counts
// out of some other action's payload.
const SINGLE_ARRAY_DETAILS = JSON.stringify({ missingKeys: ["SHA256E-s1--a.edf"], note: "other" });
const NATIVE_ZARR_SUMMARY = JSON.stringify({ count: 3, detail_ref: "zarr/index.json" });
const NON_JSON_ZARR = "corrupted, not json";

function seedAudit(
  db: Database,
  action: string,
  resourceId: string | null,
  details: string | null,
) {
  db.query("INSERT INTO audit_log (action, resource_id, details) VALUES (?, ?, ?)").run(
    action,
    resourceId,
    details,
  );
}

function seed(db: Database): void {
  db.exec(`
    INSERT INTO users (username, email, password_hash, status, role, email_verified)
    VALUES ('compactowner', 'compactowner@example.org', 'x', 'approved', 'user', 1);
  `);

  seedAudit(db, "import_verify_forced", "on004952", JSON.stringify(bigVerified()));
  seedAudit(db, "import_reclassified_incomplete", "on005170", JSON.stringify(smallVerified()));
  seedAudit(db, "import_verify_forced", "on000001", NATIVE_SUMMARY);
  seedAudit(db, "user_login", null, null);
  seedAudit(db, "legacy_note", null, NON_JSON_DETAILS);
  seedAudit(db, "import_dispatch_cooldown", "on000002,on000003", UNRELATED_ARRAY_DETAILS);
  seedAudit(db, "some_other_action", "on000004", SINGLE_ARRAY_DETAILS);

  const owner = db.query<{ id: number }, []>("SELECT id FROM users LIMIT 1").get();
  if (!owner) throw new Error("seed: owner insert failed");
  const insertDataset = db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility,
                           zarr_data_failures, readme, enrichment_json)
     VALUES (?, ?, ?, 'active', 'public', ?, ?, ?)`,
  );
  // Realistic bulk in the OTHER text columns (#1188 measured readme <= 8 KB,
  // enrichment_json 2-4 KB on the oversized rows) so the statement-size pin
  // below bounds a whole realistic row, not a bare one.
  insertDataset.run(
    "on007523",
    "Worst case zarr failures",
    owner.id,
    zarrFailureArray(877),
    "R".repeat(8000),
    JSON.stringify({ abstract: "e".repeat(4000) }),
  );
  insertDataset.run("on007688", "Null failures", owner.id, null, null, null);
  insertDataset.run("on001111", "Native summary", owner.id, NATIVE_ZARR_SUMMARY, null, null);
  insertDataset.run("on002222", "Non-JSON failures", owner.id, NON_JSON_ZARR, null, null);
}

/**
 * Render a row as the backup does -- one INSERT with inline literals,
 * single quotes doubled. A local model of the statement `wrangler d1 export
 * --table` emits (the exporter itself lives in nemarOrg/nemar-db-backup):
 * this pins OUR shapes' statement size, it does not test their exporter.
 */
function renderInsert(db: Database, table: string, where: string, param: string): string {
  const cols = (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  const row = db
    .query(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM ${table} WHERE ${where}`)
    .get(param) as Record<string, unknown>;
  if (!row) throw new Error(`renderInsert: no ${table} row for ${param}`);
  const literal = (v: unknown): string => {
    if (v === null) return "NULL";
    if (typeof v === "number" || typeof v === "bigint") return String(v);
    return `'${String(v).replaceAll("'", "''")}'`;
  };
  const values = cols.map((c) => literal(row[c]));
  return `INSERT INTO ${table}(${cols.join(",")}) VALUES(${values.join(",")});`;
}

const auditDetails = (db: Database, resourceId: string): string | null =>
  (
    db.query("SELECT details FROM audit_log WHERE resource_id = ?").get(resourceId) as {
      details: string | null;
    }
  ).details;

const zarrFailures = (db: Database, datasetId: string): string | null =>
  (
    db.query("SELECT zarr_data_failures FROM datasets WHERE dataset_id = ?").get(datasetId) as {
      zarr_data_failures: string | null;
    }
  ).zarr_data_failures;

describe("migration 0074: compact oversized payloads", () => {
  let db: Database;

  beforeEach(() => {
    db = dbBefore0074();
    seed(db);
  });

  test("integrity-array audit payloads are rewritten to the write-path summary, counts derived", () => {
    // The fixtures genuinely reach the boundary the migration exists for.
    expect(
      byteLength(renderInsert(db, "audit_log", "resource_id = ?", "on004952")),
    ).toBeGreaterThan(MAX_STATEMENT_BYTES);

    apply0074(db);

    const big = auditDetails(db, "on004952") as string;
    expect(byteLength(big)).toBeLessThan(400);
    // The exact shape the write path (integrityAuditSummary) now produces,
    // plus the migration marker. Counts are DERIVED from the dropped arrays
    // (12,397 / 41), `complete` stays boolean false (not 0), scalars ride
    // through. toEqual is strict about false-vs-0 and null-vs-0.
    expect(JSON.parse(big)).toEqual({
      ...integrityAuditSummary(bigVerified()),
      compacted_by: "migration_0074",
    });
    expect(JSON.parse(big).missing_count).toBe(12397);
    expect(JSON.parse(big).zero_byte_count).toBe(41);
    expect(big).not.toContain("missingKeys");

    // Shape-scoped, not action-scoped: the reclassification sweep wrote the
    // same integrity shape under a different action. A null version must
    // survive as JSON null.
    const small = auditDetails(db, "on005170") as string;
    expect(JSON.parse(small)).toEqual({
      ...integrityAuditSummary(smallVerified()),
      compacted_by: "migration_0074",
    });
    expect(JSON.parse(small).version).toBeNull();
    expect(JSON.parse(small).missing_count).toBe(500);
    expect(JSON.parse(small).zero_byte_count).toBe(0);
  });

  test("already-compact, NULL, non-JSON, and non-integrity payloads are byte-identical", () => {
    apply0074(db);
    expect(auditDetails(db, "on000001")).toBe(NATIVE_SUMMARY);
    expect(
      (
        db.query("SELECT details FROM audit_log WHERE action = 'user_login'").get() as {
          details: string | null;
        }
      ).details,
    ).toBeNull();
    expect(
      (
        db.query("SELECT details FROM audit_log WHERE action = 'legacy_note'").get() as {
          details: string | null;
        }
      ).details,
    ).toBe(NON_JSON_DETAILS);
    expect(auditDetails(db, "on000002,on000003")).toBe(UNRELATED_ARRAY_DETAILS);
    expect(auditDetails(db, "on000004")).toBe(SINGLE_ARRAY_DETAILS);
  });

  test("zarr_data_failures arrays become count + pointer; leave-alone rows untouched", () => {
    expect(byteLength(renderInsert(db, "datasets", "dataset_id = ?", "on007523"))).toBeGreaterThan(
      MAX_STATEMENT_BYTES,
    );

    apply0074(db);

    const compacted = zarrFailures(db, "on007523") as string;
    expect(byteLength(compacted)).toBeLessThan(120);
    expect(JSON.parse(compacted)).toEqual({
      count: 877,
      detail_ref: "zarr/index.json",
      compacted_by: "migration_0074",
    });

    expect(zarrFailures(db, "on007688")).toBeNull();
    expect(zarrFailures(db, "on001111")).toBe(NATIVE_ZARR_SUMMARY);
    expect(zarrFailures(db, "on002222")).toBe(NON_JSON_ZARR);
  });

  test("a compacted record is distinguishable from a natively-written one", () => {
    apply0074(db);
    expect(JSON.parse(auditDetails(db, "on004952") as string).compacted_by).toBe("migration_0074");
    expect(JSON.parse(auditDetails(db, "on000001") as string).compacted_by).toBeUndefined();
    expect(JSON.parse(zarrFailures(db, "on007523") as string).compacted_by).toBe("migration_0074");
    expect(JSON.parse(zarrFailures(db, "on001111") as string).compacted_by).toBeUndefined();
  });

  test("re-running 0074 is a no-op (rewritten rows no longer match)", () => {
    apply0074(db);
    const first = auditDetails(db, "on004952");
    const firstZarr = zarrFailures(db, "on007523");
    apply0074(db);
    expect(auditDetails(db, "on004952")).toBe(first as string);
    expect(zarrFailures(db, "on007523")).toBe(firstZarr as string);
  });

  test("acceptance pin (#1188): no rendered backup statement exceeds 95,000 bytes", () => {
    apply0074(db);
    const auditIds = (db.query("SELECT id FROM audit_log").all() as { id: number }[]).map((r) =>
      String(r.id),
    );
    for (const id of auditIds) {
      expect(byteLength(renderInsert(db, "audit_log", "id = ?", id))).toBeLessThan(
        MAX_STATEMENT_BYTES,
      );
    }
    const datasetIds = (
      db.query("SELECT dataset_id FROM datasets").all() as { dataset_id: string }[]
    ).map((r) => r.dataset_id);
    for (const id of datasetIds) {
      expect(byteLength(renderInsert(db, "datasets", "dataset_id = ?", id))).toBeLessThan(
        MAX_STATEMENT_BYTES,
      );
    }
  });
});
