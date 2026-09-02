/**
 * Migration 0071_reclaim_column_budget (#1182): rebuild `datasets` as an
 * 87-column table (92 after 0072_signal_defaults).
 *
 * Real engine, no mocks: every migration file up to 0070 is applied to a
 * real bun:sqlite database, rows are seeded covering every fate class
 * (full / partial / absent attestation, populated dropped columns, sparse
 * ids) plus rows in ALL THREE FK children and FTS content, then 0071 and
 * 0072 are applied and the outcome is asserted.
 *
 * PRAGMA foreign_keys = ON is set explicitly: bun:sqlite defaults it OFF
 * while D1 is always-on and cannot disable it. Without this the DROP
 * TABLE cascade hazard the migration's rescue/empty/restore ordering
 * exists for is not modelled at all, and the child-survival assertions
 * below could never fail.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");

const REBUILD_FILE = "0071_reclaim_column_budget.sql";
const SIGNAL_DEFAULTS_FILE = "0072_signal_defaults.sql";

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** Apply every migration strictly before the 0071 rebuild. */
function dbAt0070(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of migrationFiles().filter((f) => f < REBUILD_FILE)) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
  }
  return db;
}

/**
 * Split a migration file into individual statements, keeping CREATE TRIGGER
 * BEGIN...END bodies intact.
 *
 * Statement-at-a-time application is load-bearing: bun:sqlite's exec() on a
 * multi-statement string SWALLOWS any statement error except the last one's
 * (verified against bun 1.4.0 — a failing middle statement neither throws
 * nor stops the script), so exec()ing the whole file would let a fired
 * _rebuild_guard abort pass silently and the migration continue. D1 applies
 * statements individually and fails loudly; this models that.
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

function apply(db: Database, file: string): void {
  for (const stmt of splitStatements(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"))) {
    db.exec(stmt);
  }
}

function columnNames(db: Database): string[] {
  return (db.query("PRAGMA table_info(datasets)").all() as { name: string }[]).map((c) => c.name);
}

/** Sparse ids on purpose: production MIN(id)=48, MAX(id)=61277, and id is
 *  the FTS5 external-content rowid — reassignment corrupts the index. */
const IDS = { full: 48, partial: 1000, none: 61277 } as const;

function seed(db: Database): void {
  db.exec(`
    INSERT INTO users (id, username, email, github_username, status)
    VALUES (1, 'owner', 'owner@nemar.test', 'owner-gh', 'approved'),
           (2, 'requester', 'requester@nemar.test', 'requester-gh', 'approved');
  `);
  // Fate class 1: full attestation, every dropped column populated.
  db.query(
    `INSERT INTO datasets (
       id, dataset_id, name, description, owner_user_id, status, visibility,
       github_repo, concept_doi, ezid_identifier, ezid_status, doi_provider,
       uploader, file_size, file_size_formatted, num_citations,
       num_dataset_citations, num_datapaper_citations,
       zenodo_concept_id, zenodo_latest_version_id,
       authors, tasks, modalities, readme,
       attestation_deposit_type, attestation_key_status,
       attestation_deidentified, attestation_no_duplicate,
       attestation_upstream_source, attestation_accepted_at
     ) VALUES (
       ?, 'nm000048', 'Aardvark EEG Corpus', 'resting-state aardvark eeg', 1,
       'active', 'public', 'nemarDatasets/nm000048',
       '10.82901/nemar.nm000048', 'doi:10.82901/NEMAR.NM000048', 'public',
       'ezid', 'legacy-uploader', 850500, '1.00 GB', 5, 3, 2,
       '424242', '999999',
       'Ada Lovelace, Alan Turing', 'rest', 'eeg', 'A very restful readme',
       'redistribution', 'retained', 1, 1,
       'https://openneuro.org/datasets/ds000001', '2026-01-02 03:04:05'
     )`,
  ).run(IDS.full);
  // Fate class 2: partial attestation (owner deposit: no_duplicate and
  // upstream_source legitimately NULL — the production shape).
  db.query(
    `INSERT INTO datasets (
       id, dataset_id, name, owner_user_id, status, visibility,
       attestation_deposit_type, attestation_key_status,
       attestation_deidentified, attestation_accepted_at
     ) VALUES (?, 'nm001000', 'Badger MEG Nights', 1, 'active', 'private',
       'owner', 'destroyed', 1, '2026-02-03 04:05:06')`,
  ).run(IDS.partial);
  // Fate class 3: no attestation at all -> NULL JSON ("no attestation on
  // record", ADR 0024).
  db.query(
    `INSERT INTO datasets (id, dataset_id, name, owner_user_id, status, visibility)
     VALUES (?, 'nm061277', 'Capybara iEEG Atlas', 1, 'active', 'private')`,
  ).run(IDS.none);

  // All THREE FK children. Two reference datasets(id) with ON DELETE
  // CASCADE (access_requests, dataset_collaborators); dataset_versions
  // references datasets(dataset_id) with NO ACTION.
  db.query(
    "INSERT INTO access_requests (dataset_id, user_id, status, note) VALUES (?, 2, 'pending', 'please')",
  ).run(IDS.full);
  db.query(
    "INSERT INTO dataset_collaborators (dataset_id, user_id, granted_by, access_type) VALUES (?, 2, 1, 'invited')",
  ).run(IDS.partial);
  db.query(
    "INSERT INTO dataset_versions (dataset_id, version, doi, provider) VALUES ('nm000048', '1.0.0', '10.82901/nemar.nm000048.v1.0.0', 'ezid')",
  ).run();
}

function rebuilt(): Database {
  const db = dbAt0070();
  seed(db);
  apply(db, REBUILD_FILE);
  apply(db, SIGNAL_DEFAULTS_FILE);
  return db;
}

describe("migration 0071: datasets rebuild", () => {
  let db: Database;

  beforeEach(() => {
    db = rebuilt();
  });

  test("column budget: 87 after 0071, 92 after 0072, dropped columns gone", () => {
    const between = dbAt0070();
    seed(between);
    apply(between, REBUILD_FILE);
    expect(columnNames(between).length).toBe(87);

    const cols = columnNames(db);
    expect(cols.length).toBe(92);
    for (const gone of [
      "zenodo_latest_version_id",
      "uploader",
      "ezid_identifier",
      "doi_provider",
      "num_citations",
      "file_size_formatted",
      "attestation_deposit_type",
      "attestation_key_status",
      "attestation_deidentified",
      "attestation_no_duplicate",
      "attestation_upstream_source",
      "attestation_accepted_at",
    ]) {
      expect(cols).not.toContain(gone);
    }
    expect(cols).toContain("attestation");
    // Explicit keeps: the doomsday zenodo backup and the failure-only
    // metadata_columns_error channel survive.
    expect(cols).toContain("zenodo_concept_id");
    expect(cols).toContain("metadata_columns_error");
  });

  test("ids are copied verbatim (sparse, never reassigned)", () => {
    const rows = db
      .query("SELECT id, dataset_id FROM datasets ORDER BY id")
      .all() as { id: number; dataset_id: string }[];
    expect(rows).toEqual([
      { id: IDS.full, dataset_id: "nm000048" },
      { id: IDS.partial, dataset_id: "nm001000" },
      { id: IDS.none, dataset_id: "nm061277" },
    ]);
  });

  test("surviving column values ride through unchanged", () => {
    const row = db
      .query(
        `SELECT concept_doi, ezid_status, zenodo_concept_id, file_size,
                num_dataset_citations, num_datapaper_citations, github_repo
         FROM datasets WHERE id = ?`,
      )
      .get(IDS.full) as Record<string, unknown>;
    expect(row).toEqual({
      concept_doi: "10.82901/nemar.nm000048",
      ezid_status: "public",
      zenodo_concept_id: "424242",
      file_size: 850500,
      num_dataset_citations: 3,
      num_datapaper_citations: 2,
      github_repo: "nemarDatasets/nm000048",
    });
  });

  test("all three FK children survive the rebuild (the DROP TABLE cascade regression)", () => {
    // DROP TABLE performs an implicit DELETE that fires ON DELETE CASCADE
    // even under defer_foreign_keys; the rescue/empty/restore ordering is
    // what keeps these rows alive. foreign_keys=ON above makes this real.
    const ar = db
      .query("SELECT dataset_id, user_id, status, note FROM access_requests")
      .all() as Record<string, unknown>[];
    expect(ar).toEqual([{ dataset_id: IDS.full, user_id: 2, status: "pending", note: "please" }]);

    const dc = db
      .query("SELECT dataset_id, user_id, granted_by, access_type FROM dataset_collaborators")
      .all() as Record<string, unknown>[];
    expect(dc).toEqual([
      { dataset_id: IDS.partial, user_id: 2, granted_by: 1, access_type: "invited" },
    ]);

    const dv = db
      .query("SELECT dataset_id, version, doi, provider FROM dataset_versions")
      .all() as Record<string, unknown>[];
    expect(dv).toEqual([
      {
        dataset_id: "nm000048",
        version: "1.0.0",
        doi: "10.82901/nemar.nm000048.v1.0.0",
        provider: "ezid",
      },
    ]);

    // And the restored FKs are live again, not just present as text.
    // dataset_versions is NO ACTION: deleting its parent row must be
    // refused while a version row references it (production deletion code
    // clears dataset_versions first, see the deletion cascade in
    // AGENTS.md)...
    expect(() => db.query("DELETE FROM datasets WHERE id = ?").run(IDS.full)).toThrow(
      /FOREIGN KEY/,
    );
    // ...and once it is cleared, the CASCADE child follows the delete.
    db.query("DELETE FROM dataset_versions WHERE dataset_id = 'nm000048'").run();
    db.query("DELETE FROM datasets WHERE id = ?").run(IDS.full);
    expect(db.query("SELECT COUNT(*) AS n FROM access_requests").get()).toEqual({ n: 0 });
  });

  test("attestation collapse is field-exact per fate class", () => {
    const extract = (id: number) =>
      db
        .query(
          `SELECT attestation,
                  json_extract(attestation, '$.deposit_type') AS deposit_type,
                  json_extract(attestation, '$.key_status') AS key_status,
                  json_extract(attestation, '$.deidentified') AS deidentified,
                  json_extract(attestation, '$.no_duplicate') AS no_duplicate,
                  json_extract(attestation, '$.upstream_source') AS upstream_source,
                  json_extract(attestation, '$.accepted_at') AS accepted_at
           FROM datasets WHERE id = ?`,
        )
        .get(id) as Record<string, unknown>;

    const full = extract(IDS.full);
    expect(full.deposit_type).toBe("redistribution");
    expect(full.key_status).toBe("retained");
    expect(full.deidentified).toBe(1);
    expect(full.no_duplicate).toBe(1);
    expect(full.upstream_source).toBe("https://openneuro.org/datasets/ds000001");
    expect(full.accepted_at).toBe("2026-01-02 03:04:05");

    const partial = extract(IDS.partial);
    expect(partial.deposit_type).toBe("owner");
    expect(partial.key_status).toBe("destroyed");
    expect(partial.deidentified).toBe(1);
    expect(partial.no_duplicate).toBeNull();
    expect(partial.upstream_source).toBeNull();
    expect(partial.accepted_at).toBe("2026-02-03 04:05:06");

    // All six NULL -> NULL column, not a JSON object of nulls (ADR 0024's
    // "no attestation on record" must stay distinguishable).
    expect(extract(IDS.none).attestation).toBeNull();
  });

  test("sqlite_sequence is re-seeded at MAX(id); a fresh INSERT takes max+1", () => {
    const seq = db
      .query("SELECT seq FROM sqlite_sequence WHERE name = 'datasets'")
      .get() as { seq: number } | null;
    expect(seq?.seq).toBe(IDS.none);

    db.query(
      "INSERT INTO datasets (dataset_id, name, owner_user_id) VALUES ('nm900001', 'Fresh Row', 1)",
    ).run();
    const fresh = db
      .query("SELECT id FROM datasets WHERE dataset_id = 'nm900001'")
      .get() as { id: number };
    expect(fresh.id).toBe(IDS.none + 1);
  });

  test("FTS survives: integrity-check passes and MATCH returns the same rowids", () => {
    // Pre-rebuild MATCH set, captured from an identically-seeded pre-0071 DB.
    const before = dbAt0070();
    seed(before);
    const matchRowids = (d: Database) =>
      (
        d
          .query("SELECT rowid FROM datasets_fts WHERE datasets_fts MATCH 'aardvark' ORDER BY rowid")
          .all() as { rowid: number }[]
      ).map((r) => r.rowid);
    const expected = matchRowids(before);
    expect(expected).toEqual([IDS.full]); // the fixture must actually match

    expect(matchRowids(db)).toEqual(expected);
    // rank=1 = verify the index against the content table; throws SQLITE_CORRUPT
    // on desync. (The migration itself also runs this; re-run to prove the
    // final state, not just that the migration got past it.)
    expect(() =>
      db.exec("INSERT INTO datasets_fts(datasets_fts, rank) VALUES('integrity-check', 1)"),
    ).not.toThrow();
  });

  test("recreated triggers fire: a name UPDATE reindexes search and dirties the embedding", () => {
    expect(
      (db.query("SELECT embedding_dirty FROM datasets WHERE id = ?").get(IDS.none) as {
        embedding_dirty: number;
      }).embedding_dirty,
    ).toBe(0);

    db.query("UPDATE datasets SET name = 'Zebrafish LFP Nights' WHERE id = ?").run(IDS.none);

    const hits = (
      db
        .query("SELECT rowid FROM datasets_fts WHERE datasets_fts MATCH 'zebrafish'")
        .all() as { rowid: number }[]
    ).map((r) => r.rowid);
    expect(hits).toEqual([IDS.none]);

    expect(
      (db.query("SELECT embedding_dirty FROM datasets WHERE id = ?").get(IDS.none) as {
        embedding_dirty: number;
      }).embedding_dirty,
    ).toBe(1);
  });
});
