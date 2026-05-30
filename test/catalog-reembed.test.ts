/**
 * Phase 4 tests (#646 / #650): catalog-ingest retarget, dirty drain, reembed
 * guard. The load-bearing logic is pure D1 (real bun:sqlite via a forwarding
 * adapter). The Vectorize/Workers-AI calls (embed/upsert/deleteByIds) are
 * covered by source-pins + the live dev validation — no shims.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { upsertCatalogRecordsToDatasets } from "../backend/src/services/catalog-sync";
import { drainEmbeddingDirty, reembedDatasetVector } from "../backend/src/services/dataset-search";

const MIG = join(import.meta.dir, "..", "backend/src/db/migrations");

// Real bun:sqlite-backed D1 shim, incl. batch().
function realD1(db: Database): D1Database {
  const make = (q: string) => {
    const stmt = db.query(q);
    let bound: unknown[] = [];
    const api = {
      bind(...p: unknown[]) {
        bound = p;
        return api;
      },
      run() {
        const r = stmt.run(...(bound as never[]));
        return Promise.resolve({ success: true, meta: { changes: r.changes } });
      },
      first<T>() {
        return Promise.resolve((stmt.get(...(bound as never[])) as T) ?? null);
      },
      all<T>() {
        return Promise.resolve({ results: stmt.all(...(bound as never[])) as T[] });
      },
    };
    return api;
  };
  return {
    prepare: make,
    batch: (stmts: Array<{ run: () => Promise<unknown> }>) =>
      Promise.all(stmts.map((s) => s.run())),
  } as unknown as D1Database;
}

const BASE_SCHEMA = `
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, email TEXT NOT NULL UNIQUE,
  password_hash TEXT, github_username TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','approved','revoked')),
  email_verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  signup_source TEXT NOT NULL DEFAULT 'cli' CHECK (signup_source IN ('cli','web')));
CREATE TABLE datasets (id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  description TEXT, owner_user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','deleted')),
  github_repo TEXT, concept_doi TEXT, latest_version_doi TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_sandbox INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  enrichment_json TEXT, source TEXT, source_id TEXT, nemar_sync_status TEXT,
  subject_count INTEGER, modalities TEXT, age_min REAL, age_max REAL, file_size INTEGER,
  total_files INTEGER, tasks TEXT, FOREIGN KEY (owner_user_id) REFERENCES users(id));
INSERT INTO users (id, username, email, status) VALUES (10, 'alice', 'a@x.org', 'approved'), (11, 'on', 'on@x.org', 'approved');
`;

function db0027(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(BASE_SCHEMA);
  db.exec(readFileSync(join(MIG, "0027_consolidation_columns_and_sentinel.sql"), "utf8"));
  return db;
}

// biome-ignore lint/suspicious/noExplicitAny: minimal NemarCatalogRecord for tests
function rec(over: Record<string, unknown>): any {
  return {
    id: "ds000000",
    name: "Catalog Dataset",
    created: "2022-01-01",
    uploader: "OpenNeuro",
    latestSnapshot: "1.0.0",
    publishDate: "2022-02-02",
    sessionsNum: 1,
    file_size: 100,
    byte_size_format: "100 B",
    totalFiles: 5,
    participants: 9,
    age_min: 0,
    age_max: 0,
    BIDSVersion: "1.8.0",
    License: "CC0",
    Authors: "Catalog Author",
    DatasetDOI: "doi:10/cat",
    tasks: "rest",
    modalities: "eeg",
    readme: "catalog readme",
    local_dataset: 0,
    processed: 0,
    ...over,
  };
}

describe("upsertCatalogRecordsToDatasets", () => {
  function seeded(): Database {
    const db = db0027();
    db.exec(`
      INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, source, source_id, authors)
      VALUES
      ('nm000500','Managed Active',10,'active','public',NULL,NULL,'Managed Active Authors'),
      ('on000600','Managed Mirror',11,'active','public','openneuro','ds000600','Mirror Authors'),
      ('nm000800','Managed Archived',10,'archived','public',NULL,NULL,'Managed Keep'),
      ('ds000700','Folded Existing',-1,'active','public','openneuro','ds000700','Old Folded');
    `);
    return db;
  }

  test("inserts a new catalog row as folded (owner=-1, dirty=1, public/active)", async () => {
    const db = seeded();
    const n = await upsertCatalogRecordsToDatasets(realD1(db), [
      rec({ id: "ds000900", Authors: "New A" }),
    ]);
    expect(n).toBe(1);
    const row = db
      .query(
        "SELECT owner_user_id, status, visibility, is_sandbox, embedding_dirty, authors, concept_doi FROM datasets WHERE dataset_id='ds000900'",
      )
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      owner_user_id: -1,
      status: "active",
      visibility: "public",
      is_sandbox: 0,
      embedding_dirty: 1,
      authors: "New A",
      concept_doi: "doi:10/cat",
    });
  });

  test("updates an existing folded (sentinel) row and re-dirties it", async () => {
    const db = seeded();
    db.exec("UPDATE datasets SET embedding_dirty=0 WHERE dataset_id='ds000700'");
    await upsertCatalogRecordsToDatasets(realD1(db), [
      rec({ id: "ds000700", Authors: "Refreshed" }),
    ]);
    const row = db
      .query(
        "SELECT authors, embedding_dirty, owner_user_id FROM datasets WHERE dataset_id='ds000700'",
      )
      .get() as { authors: string; embedding_dirty: number; owner_user_id: number };
    expect(row).toEqual({ authors: "Refreshed", embedding_dirty: 1, owner_user_id: -1 });
  });

  test("skips records that are an active managed dataset (dedup)", async () => {
    const db = seeded();
    const n = await upsertCatalogRecordsToDatasets(realD1(db), [
      rec({ id: "nm000500", Authors: "HIJACK" }),
    ]);
    expect(n).toBe(0);
    const row = db
      .query("SELECT owner_user_id, authors FROM datasets WHERE dataset_id='nm000500'")
      .get() as { owner_user_id: number; authors: string };
    expect(row).toEqual({ owner_user_id: 10, authors: "Managed Active Authors" });
  });

  test("skips ds* shadows of a managed on* mirror (dedup)", async () => {
    const db = seeded();
    const n = await upsertCatalogRecordsToDatasets(realD1(db), [rec({ id: "ds000600" })]);
    expect(n).toBe(0);
    expect(db.query("SELECT 1 FROM datasets WHERE dataset_id='ds000600'").get()).toBeNull();
  });

  test("ON CONFLICT WHERE owner=-1 protects a colliding NON-active managed row", async () => {
    // nm000800 is archived -> passes the active-only dedup, so it reaches the
    // INSERT...ON CONFLICT. The WHERE owner_user_id=-1 guard must no-op it.
    const db = seeded();
    await upsertCatalogRecordsToDatasets(realD1(db), [rec({ id: "nm000800", Authors: "HIJACK" })]);
    const row = db
      .query("SELECT owner_user_id, status, authors FROM datasets WHERE dataset_id='nm000800'")
      .get() as { owner_user_id: number; status: string; authors: string };
    expect(row).toEqual({ owner_user_id: 10, status: "archived", authors: "Managed Keep" });
  });

  test("truncates readme to 8 KB on the folded row", async () => {
    const db = seeded();
    await upsertCatalogRecordsToDatasets(realD1(db), [
      rec({ id: "ds000901", readme: "x".repeat(10_000) }),
    ]);
    const r = db
      .query("SELECT LENGTH(readme) AS len FROM datasets WHERE dataset_id='ds000901'")
      .get() as {
      len: number;
    };
    expect(r.len).toBe(8192);
  });

  test("description = readme[:500], independent of the 8 KB readme cap", async () => {
    const db = seeded();
    await upsertCatalogRecordsToDatasets(realD1(db), [
      rec({ id: "ds000902", readme: "a".repeat(600) }),
    ]);
    const r = db
      .query(
        "SELECT LENGTH(readme) AS rl, LENGTH(description) AS dl FROM datasets WHERE dataset_id='ds000902'",
      )
      .get() as { rl: number; dl: number };
    expect(r.rl).toBe(600); // under the 8 KB cap
    expect(r.dl).toBe(500); // description truncated to 500
  });

  test("maps every NemarCatalogRecord field to the right datasets column (bind-order guard)", async () => {
    const db = db0027();
    await upsertCatalogRecordsToDatasets(realD1(db), [
      rec({
        id: "ds123456",
        name: "Mapped Name",
        readme: "Mapped Readme Body",
        participants: 42,
        modalities: "eeg,meg",
        age_min: 5,
        age_max: 65,
        file_size: 12345,
        totalFiles: 99,
        tasks: "rest,oddball",
        Authors: "Mapped Author",
        License: "CC-BY-4.0",
        BIDSVersion: "1.9.1",
        sessionsNum: 7,
        publishDate: "2023-03-03",
        uploader: "Mapped Uploader",
        byte_size_format: "12.3 KB",
        DatasetDOI: "doi:10/mapped",
        created: "2021-01-01",
      }),
    ]);
    const row = db
      .query(
        `SELECT name, description, subject_count, modalities, age_min, age_max, file_size, total_files,
                tasks, authors, license, bids_version, sessions_count, publish_date, uploader,
                file_size_formatted, concept_doi, created_at, source, source_id
         FROM datasets WHERE dataset_id='ds123456'`,
      )
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      name: "Mapped Name",
      description: "Mapped Readme Body",
      subject_count: 42,
      modalities: "eeg,meg",
      age_min: 5,
      age_max: 65,
      file_size: 12345,
      total_files: 99,
      tasks: "rest,oddball",
      authors: "Mapped Author",
      license: "CC-BY-4.0",
      bids_version: "1.9.1",
      sessions_count: 7,
      publish_date: "2023-03-03",
      uploader: "Mapped Uploader",
      file_size_formatted: "12.3 KB",
      concept_doi: "doi:10/mapped",
      created_at: "2021-01-01",
      source: "openneuro", // ds* -> openneuro, source_id = id
      source_id: "ds123456",
    });
  });

  test("nm* catalog-only record gets source='nemar.org' and source_id=NULL", async () => {
    const db = db0027();
    await upsertCatalogRecordsToDatasets(realD1(db), [rec({ id: "nm999900" })]);
    const row = db
      .query("SELECT source, source_id FROM datasets WHERE dataset_id='nm999900'")
      .get() as { source: string; source_id: string | null };
    expect(row).toEqual({ source: "nemar.org", source_id: null });
  });
});

describe("drainEmbeddingDirty guard", () => {
  test("returns {0,0} and does not embed when AI/Vectorize are unset", async () => {
    const db = db0027();
    db.exec(
      "INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, embedding_dirty) VALUES ('nm111','X',10,'active','public',1)",
    );
    expect(await drainEmbeddingDirty(realD1(db), undefined, undefined, 50)).toEqual({
      scanned: 0,
      embedded: 0,
    });
    const r = db.query("SELECT embedding_dirty FROM datasets WHERE dataset_id='nm111'").get() as {
      embedding_dirty: number;
    };
    expect(r.embedding_dirty).toBe(1); // untouched
  });
});

describe("reembedDatasetVector guard", () => {
  test("returns false and does NOT clear the dirty flag when AI/Vectorize are unset", async () => {
    const db = db0027();
    db.exec(
      "INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, embedding_dirty) VALUES ('nm000999','X',10,'active','public',1)",
    );
    const ok = await reembedDatasetVector(realD1(db), undefined, undefined, "nm000999");
    expect(ok).toBe(false);
    const r = db
      .query("SELECT embedding_dirty FROM datasets WHERE dataset_id='nm000999'")
      .get() as {
      embedding_dirty: number;
    };
    expect(r.embedding_dirty).toBe(1); // unchanged
  });
});

describe("dirty-row drain selection", () => {
  test("selects embedding_dirty=1 rows oldest-updated first, up to LIMIT", () => {
    const db = db0027();
    db.exec(`
      INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, embedding_dirty, updated_at) VALUES
      ('a','A',10,'active','public',1,'2020-01-03'),
      ('b','B',10,'active','public',1,'2020-01-01'),
      ('c','C',10,'active','public',0,'2020-01-02'),
      ('d','D',10,'active','public',1,'2020-01-02');
    `);
    const ids = (
      db
        .query(
          "SELECT dataset_id FROM datasets WHERE embedding_dirty = 1 ORDER BY updated_at LIMIT ?",
        )
        .all(2) as Array<{ dataset_id: string }>
    ).map((r) => r.dataset_id);
    expect(ids).toEqual(["b", "d"]); // oldest two dirty; 'c' excluded (not dirty)
  });
});

describe("Phase 4 wiring (source pins)", () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");

  test("deletion removes the vector; reembed clears the flag; cron drains; reindex keysets", () => {
    expect(read("backend/src/services/deletion.ts")).toContain(
      "env.VECTORIZE.deleteByIds([datasetId])",
    );
    expect(read("backend/src/services/dataset-search.ts")).toContain(
      "UPDATE datasets SET embedding_dirty = 0",
    );
    expect(read("backend/src/index.ts")).toContain("drainEmbeddingDirty(env.DB");
    const admin = read("backend/src/routes/admin.ts");
    expect(admin).toContain("/vectorize/reindex-all");
    expect(admin).toContain("AND dataset_id > ?");
  });

  test("catalog ingest dual-writes datasets alongside nemar_catalog", () => {
    expect(read("backend/src/services/catalog-sync.ts")).toContain(
      "upsertCatalogRecordsToDatasets(db, records)",
    );
  });
});
