/**
 * Real behavioral test for the catalog-consolidation expand step (#646 Phase 1).
 *
 * Unlike the source-string pins used for older migrations (D1 wasn't reachable
 * from a Bun unit test), bun:sqlite ships JSON1 + FTS5, so we apply the ACTUAL
 * migration files (0027/0028/0029) against an in-memory SQLite seeded to mirror
 * prod's managed + catalog shape, then assert the fold, backfill, FTS5 index,
 * triggers, and the read-path dormancy guards behave correctly.
 *
 * Seed (mirrors the two dedup cases the fold must respect):
 *   users:    alice(10), on_owner(11)             -- real positive ids
 *   managed:  nm000200 (object-shape enrichment authors + license),
 *             nm000201 (legacy array-shape authors),
 *             on002718 (openneuro mirror, source_id='ds002718')
 *   catalog:  nm000200  -> already an active managed dataset  => NOT folded
 *             ds002718  -> shadow of the on002718 mirror       => NOT folded
 *             ds999999  -> pure catalog-only                   => FOLDED
 *             on999998  -> pure catalog-only                   => FOLDED
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SYSTEM_USER_ID } from "../backend/src/lib/constants";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "backend/src/db/migrations");
const migration = (name: string) => readFileSync(join(MIGRATIONS_DIR, name), "utf8");
const M0027 = migration("0027_consolidation_columns_and_sentinel.sql");
const M0028 = migration("0028_backfill_and_fold_catalog.sql");
const M0029 = migration("0029_datasets_fts.sql");

// Pre-0027 schema slice that the migrations + list query touch.
const BASE_SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  github_username TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','verified','approved','revoked')),
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  signup_source TEXT NOT NULL DEFAULT 'cli'
    CHECK (signup_source IN ('cli','web'))
);
CREATE TABLE datasets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  owner_user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','archived','deleted')),
  github_repo TEXT,
  concept_doi TEXT,
  latest_version_doi TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_sandbox INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private','public')),
  enrichment_json TEXT,
  source TEXT,
  source_id TEXT,
  nemar_sync_status TEXT,
  subject_count INTEGER,
  modalities TEXT,
  age_min REAL,
  age_max REAL,
  file_size INTEGER,
  total_files INTEGER,
  tasks TEXT,
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);
CREATE TABLE nemar_catalog (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  modalities TEXT,
  participants INTEGER DEFAULT 0,
  age_min INTEGER DEFAULT 0,
  age_max INTEGER DEFAULT 0,
  tasks TEXT,
  authors TEXT,
  doi TEXT,
  license TEXT,
  bids_version TEXT,
  file_size INTEGER DEFAULT 0,
  file_size_formatted TEXT,
  total_files INTEGER DEFAULT 0,
  sessions_count INTEGER DEFAULT 0,
  latest_version TEXT,
  publish_date TEXT,
  created_date TEXT,
  uploader TEXT,
  readme TEXT,
  source TEXT NOT NULL DEFAULT 'nemar.org',
  source_id TEXT,
  is_processed INTEGER DEFAULT 0,
  search_text TEXT,
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const SEED = `
INSERT INTO users (id, username, email, status, email_verified, signup_source) VALUES
  (10, 'alice', 'alice@example.org', 'approved', 1, 'cli'),
  (11, 'on_owner', 'on@example.org', 'approved', 1, 'cli');

INSERT INTO datasets
  (dataset_id, name, description, owner_user_id, status, visibility, is_sandbox, source, source_id, concept_doi, enrichment_json, subject_count, modalities, tasks)
VALUES
  ('nm000200', 'Managed Object Authors', 'desc', 10, 'active', 'public', 0, NULL, NULL, NULL,
     '{"authors":{"Gan Huang":{},"Zhenxing Hu":{}},"license":"CC0"}', 5, 'eeg', 'rest'),
  ('nm000201', 'Managed Array Authors', 'desc', 10, 'active', 'public', 0, NULL, NULL, NULL,
     '{"authors":[{"name":"Ada Lovelace"},{"name":"Alan Turing"}],"license":"CC-BY"}', 3, 'emg', 'grip'),
  ('on002718', 'Managed Mirror', 'desc', 11, 'active', 'public', 0, 'openneuro', 'ds002718',
     '10.18112/openneuro.ds002718.v1', NULL, 8, 'eeg', 'oddball');

INSERT INTO nemar_catalog
  (id, name, description, modalities, participants, tasks, authors, doi, license, bids_version, sessions_count, publish_date, created_date, uploader, readme, file_size_formatted, source, source_id)
VALUES
  ('nm000200', 'Managed Object Authors', 'desc', 'eeg', 5, 'rest', NULL, NULL, NULL,
     '1.8.0', 2, '2024-01-01', '2024-01-01', 'alice', 'Full readme body about motor imagery EEG', '1.2 GB', 'nemar.org', NULL),
  ('ds002718', 'Shadow DS', 'desc', 'eeg', 8, 'oddball', 'Mirror Author', '10.18112/openneuro.ds002718.v1', 'CC0',
     '1.6.0', 1, '2023-06-01', '2023-06-01', 'OpenNeuro', 'shadow readme', '900 MB', 'openneuro', NULL),
  ('ds999999', 'Folded Catalog One', 'desc', 'eeg', 20, 'sternberg', 'Marie Curie', '10.18112/openneuro.ds999999.v1', 'CC0',
     '1.7.0', 4, '2022-03-03', '2022-03-03', 'OpenNeuro', 'catalog readme one', '5 GB', 'openneuro', NULL),
  ('on999998', 'Folded Catalog Two', 'desc', 'meg', 12, 'rest', 'Niels Bohr', '10.82900/nm.on999998', 'CC-BY',
     '1.9.0', 3, '2021-05-05', '2021-05-05', 'Lab X', 'catalog readme two', '3 GB', 'nemar.org', NULL);
`;

function buildDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(BASE_SCHEMA);
  db.exec(SEED);
  return db;
}

// Schema-only DB for tests that seed their own edge-case rows before the fold.
function blankDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(BASE_SCHEMA);
  return db;
}

function applyExpand(db: Database) {
  db.exec(M0027);
  db.exec(M0028);
  db.exec(M0029);
}

// Reproduces the single-table list query from routes/datasets.ts (#646): after
// the 0028 fold, catalog rows live in `datasets` under the sentinel owner and
// are discriminated by source_type. The fold itself already deduped the ds*
// shadows (guard 2), so the read needs no UNION and no NOT-IN guards. This
// asserts the folded data lists each id once with the right source_type.
const GUARDED_LIST = `
  SELECT d.dataset_id AS id,
         CASE WHEN d.owner_user_id = ${SYSTEM_USER_ID} THEN 'catalog' ELSE 'managed' END AS source_type,
         d.concept_doi AS doi
  FROM datasets d
  LEFT JOIN users u ON d.owner_user_id = u.id
  WHERE d.status = 'active'
    AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL)
    AND d.visibility = 'public'
`;

describe("0027 sentinel user", () => {
  test("creates nemar-system at SYSTEM_USER_ID with status='revoked'", () => {
    const db = buildDb();
    applyExpand(db);
    const row = db
      .query("SELECT id, username, status FROM users WHERE id = ?")
      .get(SYSTEM_USER_ID) as { id: number; username: string; status: string };
    expect(row).toBeTruthy();
    expect(row.username).toBe("nemar-system");
    // 'revoked' keeps the sentinel out of broadcast recipients + approved counts.
    expect(row.status).toBe("revoked");
  });

  test("SYSTEM_USER_ID is negative so it never collides with real AUTOINCREMENT ids", () => {
    expect(SYSTEM_USER_ID).toBeLessThan(0);
  });
});

describe("0028 fold + backfill", () => {
  let db: Database;
  beforeEach(() => {
    db = buildDb();
    applyExpand(db);
  });

  test("folds pure catalog-only rows under the sentinel owner", () => {
    const rows = db
      .query(
        "SELECT dataset_id, owner_user_id, status, visibility, is_sandbox, embedding_dirty, concept_doi FROM datasets WHERE owner_user_id = ? ORDER BY dataset_id",
      )
      .all(SYSTEM_USER_ID) as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.dataset_id)).toEqual(["ds999999", "on999998"]);
    for (const r of rows) {
      expect(r.owner_user_id).toBe(SYSTEM_USER_ID);
      expect(r.status).toBe("active");
      expect(r.visibility).toBe("public");
      expect(r.is_sandbox).toBe(0);
      expect(r.embedding_dirty).toBe(1); // no vector yet -> drained by Phase-4 cron
    }
    // concept_doi folded from nemar_catalog.doi (preserved for Phase 3).
    const folded = db
      .query("SELECT concept_doi FROM datasets WHERE dataset_id='ds999999'")
      .get() as {
      concept_doi: string;
    };
    expect(folded.concept_doi).toBe("10.18112/openneuro.ds999999.v1");
  });

  test("does NOT fold a catalog id that is already an active managed dataset (dedup guard 1)", () => {
    const owner = db
      .query("SELECT owner_user_id FROM datasets WHERE dataset_id='nm000200'")
      .get() as {
      owner_user_id: number;
    };
    expect(owner.owner_user_id).toBe(10); // still alice, not re-folded to sentinel
  });

  test("does NOT fold a ds* shadow when its managed on* mirror exists (dedup guard 2)", () => {
    const shadow = db
      .query("SELECT COUNT(*) AS n FROM datasets WHERE dataset_id='ds002718'")
      .get() as {
      n: number;
    };
    expect(shadow.n).toBe(0);
  });

  test("backfills authors+license from object-shape enrichment_json", () => {
    const r = db
      .query("SELECT authors, license FROM datasets WHERE dataset_id='nm000200'")
      .get() as {
      authors: string;
      license: string;
    };
    expect(r.authors).toBe("Gan Huang, Zhenxing Hu");
    expect(r.license).toBe("CC0");
  });

  test("backfills authors from legacy array-shape enrichment_json", () => {
    const r = db
      .query("SELECT authors, license FROM datasets WHERE dataset_id='nm000201'")
      .get() as {
      authors: string;
      license: string;
    };
    expect(r.authors).toBe("Ada Lovelace, Alan Turing");
    expect(r.license).toBe("CC-BY");
  });

  test("backfills readme/bids_version for managed rows from their nemar_catalog row", () => {
    const r = db
      .query(
        "SELECT readme, bids_version, sessions_count FROM datasets WHERE dataset_id='nm000200'",
      )
      .get() as { readme: string; bids_version: string; sessions_count: number };
    expect(r.readme).toContain("motor imagery");
    expect(r.bids_version).toBe("1.8.0");
    expect(r.sessions_count).toBe(2);
  });

  test("total datasets = managed + folded (no double-list)", () => {
    const n = (db.query("SELECT COUNT(*) AS n FROM datasets").get() as { n: number }).n;
    expect(n).toBe(5); // 3 managed + 2 folded
  });

  test("re-running 0028 is idempotent and COALESCE-preserves step-(a) and step-(b) values", () => {
    // authors is filled by step (a) from enrichment_json; readme by step (b)
    // from nemar_catalog. Both must survive a re-run unchanged.
    db.exec(
      "UPDATE datasets SET authors = 'MANUAL OVERRIDE', readme = 'CUSTOM README' WHERE dataset_id = 'nm000200'",
    );
    db.exec(M0028); // second run
    const r = db
      .query("SELECT authors, readme FROM datasets WHERE dataset_id='nm000200'")
      .get() as {
      authors: string;
      readme: string;
    };
    expect(r.authors).toBe("MANUAL OVERRIDE"); // step (a) not clobbered
    expect(r.readme).toBe("CUSTOM README"); // step (b) not clobbered
    const n = (db.query("SELECT COUNT(*) AS n FROM datasets").get() as { n: number }).n;
    expect(n).toBe(5); // no duplicate folds
  });

  test("folds publish_date via the COALESCE(publish_date, created_date, now) fallback", () => {
    const d = blankDb();
    d.exec(
      "INSERT INTO nemar_catalog (id, name, publish_date, created_date) VALUES ('ds777777', 'PD Fallback', NULL, '2020-01-01')",
    );
    applyExpand(d);
    const r = d.query("SELECT publish_date FROM datasets WHERE dataset_id='ds777777'").get() as {
      publish_date: string;
    };
    expect(r.publish_date).toBe("2020-01-01"); // fell back to created_date, not datetime('now')
  });

  test("INSERT OR IGNORE skips a catalog id that collides with a NON-active managed dataset", () => {
    const d = blankDb();
    d.exec(
      "INSERT INTO users (id, username, email, status) VALUES (10,'alice','a@x.org','approved')",
    );
    // An archived managed dataset that guard 1 (status='active') would NOT catch.
    d.exec(
      "INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility) VALUES ('ds555555','Archived',10,'archived','private')",
    );
    d.exec("INSERT INTO nemar_catalog (id, name) VALUES ('ds555555','Catalog Collide')");
    applyExpand(d);
    const rows = d
      .query("SELECT owner_user_id, status FROM datasets WHERE dataset_id='ds555555'")
      .all() as Array<{ owner_user_id: number; status: string }>;
    expect(rows.length).toBe(1); // not double-inserted
    expect(rows[0].owner_user_id).toBe(10); // the archived row, not a sentinel fold
    expect(rows[0].status).toBe("archived");
  });

  test("truncates a long readme to 8 KB on fold", () => {
    const d = blankDb();
    const longReadme = "x".repeat(10_000);
    d.exec("INSERT INTO nemar_catalog (id, name, readme) VALUES ('ds888888','Long Readme', ?)", [
      longReadme,
    ]);
    applyExpand(d);
    const r = d
      .query("SELECT LENGTH(readme) AS len FROM datasets WHERE dataset_id='ds888888'")
      .get() as {
      len: number;
    };
    expect(r.len).toBe(8192);
  });
});

describe("admin /stats count split", () => {
  test("total_datasets excludes folded rows; catalog_datasets counts them", () => {
    const db = buildDb();
    applyExpand(db);
    // Mirrors the two subqueries added to routes/admin.ts GET /admin/stats.
    const r = db
      .query(
        `SELECT
           (SELECT COUNT(*) FROM datasets WHERE owner_user_id != ${SYSTEM_USER_ID}) AS total_datasets,
           (SELECT COUNT(*) FROM datasets WHERE owner_user_id = ${SYSTEM_USER_ID}) AS catalog_datasets`,
      )
      .get() as { total_datasets: number; catalog_datasets: number };
    expect(r.total_datasets).toBe(3); // managed only
    expect(r.catalog_datasets).toBe(2); // folded only

    // Anti-regression pin: the real handler must keep the split.
    const adminSrc = readFileSync(
      join(import.meta.dir, "..", "backend/src/routes/admin.ts"),
      "utf8",
    );
    expect(adminSrc).toContain(
      "FROM datasets WHERE owner_user_id != ${SYSTEM_USER_ID}) as total_datasets",
    );
    expect(adminSrc).toContain(
      "FROM datasets WHERE owner_user_id = ${SYSTEM_USER_ID}) as catalog_datasets",
    );
  });
});

describe("dormancy guards keep GET /datasets byte-stable", () => {
  test("folded rows surface once via the catalog branch with their real doi/source_type", () => {
    const db = buildDb();
    applyExpand(db);
    const rows = db.query(GUARDED_LIST).all() as Array<{
      id: string;
      source_type: string;
      doi: string | null;
    }>;

    // No id appears twice.
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);

    const byId = new Map(rows.map((r) => [r.id, r]));
    // The two folded rows arrive as 'catalog' (NOT 'managed') with their real DOI,
    // exactly as before the fold.
    expect(byId.get("ds999999")).toEqual({
      id: "ds999999",
      source_type: "catalog",
      doi: "10.18112/openneuro.ds999999.v1",
    });
    expect(byId.get("on999998")).toEqual({
      id: "on999998",
      source_type: "catalog",
      doi: "10.82900/nm.on999998",
    });
    // Managed rows stay managed; the shadowed ds* row stays hidden.
    expect(byId.get("nm000200")?.source_type).toBe("managed");
    expect(byId.get("on002718")?.source_type).toBe("managed");
    expect(byId.has("ds002718")).toBe(false);
    // Whole set: 3 managed + 2 catalog.
    expect(ids.sort()).toEqual(["ds999999", "nm000200", "nm000201", "on002718", "on999998"]);
  });

  test("real handler reads single-table with the sentinel discriminator (anti-regression pin)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "backend/src/routes/datasets.ts"), "utf8");
    // #646 contract (#652): the list is a single SELECT over `datasets`,
    // discriminated by the sentinel owner -- no UNION, no nemar_catalog catalog
    // branch, no NOT-IN dedup guards (the 0028 fold did the dedup).
    expect(src).toContain("THEN 'catalog' ELSE 'managed' END AS source_type");
    expect(src).not.toContain("UNION ALL");
    expect(src).not.toContain("FROM nemar_catalog c");
  });
});

describe("0029 FTS5 index + triggers", () => {
  let db: Database;
  beforeEach(() => {
    db = buildDb();
    applyExpand(db);
  });

  test("indexes every datasets row (count parity with the base table)", () => {
    const fts = (db.query("SELECT COUNT(*) AS n FROM datasets_fts").get() as { n: number }).n;
    const base = (db.query("SELECT COUNT(*) AS n FROM datasets").get() as { n: number }).n;
    expect(fts).toBe(base);
  });

  test("MATCH finds folded rows by name and managed rows by readme body", () => {
    const byName = db
      .query("SELECT rowid FROM datasets_fts WHERE datasets_fts MATCH 'Folded'")
      .all() as Array<{ rowid: number }>;
    expect(byName.length).toBe(2);
    const byReadme = db
      .query(
        "SELECT d.dataset_id FROM datasets_fts f JOIN datasets d ON d.id = f.rowid WHERE datasets_fts MATCH 'motor'",
      )
      .all() as Array<{ dataset_id: string }>;
    expect(byReadme.map((r) => r.dataset_id)).toContain("nm000200");
  });

  test("AFTER INSERT / UPDATE / DELETE triggers keep the index in sync", () => {
    db.exec(
      "INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility) VALUES ('nm000300','Trigger Insert Probe',10,'active','public')",
    );
    expect(
      (
        db
          .query("SELECT COUNT(*) AS n FROM datasets_fts WHERE datasets_fts MATCH 'Probe'")
          .get() as { n: number }
      ).n,
    ).toBe(1);

    db.exec("UPDATE datasets SET name = 'Trigger Renamed Token' WHERE dataset_id = 'nm000300'");
    expect(
      (
        db
          .query("SELECT COUNT(*) AS n FROM datasets_fts WHERE datasets_fts MATCH 'Probe'")
          .get() as { n: number }
      ).n,
    ).toBe(0);
    expect(
      (
        db
          .query("SELECT COUNT(*) AS n FROM datasets_fts WHERE datasets_fts MATCH 'Renamed'")
          .get() as { n: number }
      ).n,
    ).toBe(1);

    db.exec("DELETE FROM datasets WHERE dataset_id = 'nm000300'");
    expect(
      (
        db
          .query("SELECT COUNT(*) AS n FROM datasets_fts WHERE datasets_fts MATCH 'Renamed'")
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });

  test("embedding_dirty trigger marks a row stale when an embedding-relevant fact changes", () => {
    db.exec("UPDATE datasets SET embedding_dirty = 0 WHERE dataset_id = 'nm000201'");
    db.exec("UPDATE datasets SET modalities = 'eeg,emg' WHERE dataset_id = 'nm000201'");
    const r = db
      .query("SELECT embedding_dirty FROM datasets WHERE dataset_id='nm000201'")
      .get() as {
      embedding_dirty: number;
    };
    expect(r.embedding_dirty).toBe(1);
  });

  test("updating embedding_dirty alone does NOT re-fire the trigger (OF-list scoping)", () => {
    // The embed_dirty trigger's inner UPDATE touches only embedding_dirty,
    // which is absent from its OF list, so a direct write must not be forced
    // back to 1. Use sentinel value 7 that a (wrong) re-fire would clobber to 1.
    db.exec("UPDATE datasets SET embedding_dirty = 7 WHERE dataset_id = 'nm000200'");
    const r = db
      .query("SELECT embedding_dirty FROM datasets WHERE dataset_id='nm000200'")
      .get() as {
      embedding_dirty: number;
    };
    expect(r.embedding_dirty).toBe(7);
  });

  test("trigger bodies use uppercase BEGIN...END (workers-sdk#10998 remote-apply guard)", () => {
    expect(M0029).toMatch(/AFTER INSERT ON datasets BEGIN/);
    expect(M0029).toMatch(/AFTER DELETE ON datasets BEGIN/);
    expect(M0029).toMatch(/AFTER UPDATE OF [^\n]+ ON datasets BEGIN/);
    // No lowercase begin/end in the DDL itself (comments are stripped first).
    const ddl = M0029.replace(/--[^\n]*/g, "");
    expect(ddl).not.toMatch(/\bbegin\b/);
    expect(ddl).not.toMatch(/\bend\b/);
  });
});

// #646: the single-table list dropped the read-time NOT-IN dedup in favour of
// fold-time dedup (migration 0028). A ds* catalog row folded BEFORE its on*
// mirror was imported would then double-list, since 0028 only dedups shadows
// whose mirror already existed. POST /admin/datasets/import cleans up the
// stale sentinel shadow; these tests pin that contract.
describe("post-import shadow cleanup keeps the single-table list deduped", () => {
  function seeded(): Database {
    const db = blankDb();
    db.exec(M0027); // consolidation columns + the sentinel user (id = -1)
    db.exec("INSERT INTO users (id, username, email) VALUES (10, 'alice', 'alice@x.org')");
    // ds002718 folded as a sentinel shadow; its on* mirror imported afterwards.
    db.exec(
      "INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, source) VALUES ('ds002718','Folded shadow',-1,'active','public','openneuro')",
    );
    db.exec(
      "INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, source, source_id) VALUES ('on002718','Managed mirror',10,'active','public','openneuro','ds002718')",
    );
    return db;
  }

  const listIds = (db: Database) =>
    (db.query(GUARDED_LIST).all() as Array<{ id: string }>).map((r) => r.id).sort();

  test("without cleanup the folded shadow double-lists next to the managed mirror", () => {
    expect(listIds(seeded())).toEqual(["ds002718", "on002718"]);
  });

  test("the import-handler cleanup DELETE removes the shadow (mirror lists once)", () => {
    const db = seeded();
    // Mirrors the DELETE the import handler runs after inserting the on* mirror.
    db.query("DELETE FROM datasets WHERE owner_user_id = ? AND dataset_id = ?").run(
      SYSTEM_USER_ID,
      "ds002718",
    );
    expect(listIds(db)).toEqual(["on002718"]);
  });

  test("admin import handler wires the shadow cleanup (source pin)", () => {
    const admin = readFileSync(join(import.meta.dir, "..", "backend/src/routes/admin.ts"), "utf8");
    expect(admin).toMatch(/DELETE FROM datasets WHERE owner_user_id = \? AND dataset_id = \?/);
  });
});
