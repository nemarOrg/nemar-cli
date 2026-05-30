/**
 * Phase 3 read-path tests (#646 / #649).
 *
 * Pure helpers tested directly; DB-bound helpers (FTS5 search, id-only
 * hydration, exact-id lookup, the 0030 backfill) run against a real in-memory
 * SQLite engine (migrations 0027/0029/0030 applied to bun:sqlite) via a thin
 * forwarding D1 adapter — no mocks, real SQL.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDatasetFilterClauses } from "../backend/src/routes/datasets";
import {
  type SearchResult,
  buildFtsMatch,
  buildInPlaceholders,
  ftsSearch,
  hydrateDatasetsByIds,
  lookupDatasetById,
  rrfFuse,
} from "../backend/src/services/dataset-search";

const MIG = join(import.meta.dir, "..", "backend/src/db/migrations");
const sql = (f: string) => readFileSync(join(MIG, f), "utf8");

// Real bun:sqlite-backed D1 shim (forwards every call to real SQLite).
function realD1(db: Database): D1Database {
  return {
    prepare(q: string) {
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
    },
  } as unknown as D1Database;
}

const BASE_SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, email TEXT NOT NULL UNIQUE,
  password_hash TEXT, github_username TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','approved','revoked')),
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  signup_source TEXT NOT NULL DEFAULT 'cli' CHECK (signup_source IN ('cli','web'))
);
CREATE TABLE datasets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  description TEXT, owner_user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','deleted')),
  github_repo TEXT, concept_doi TEXT, latest_version_doi TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_sandbox INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  enrichment_json TEXT, source TEXT, source_id TEXT, nemar_sync_status TEXT,
  subject_count INTEGER, modalities TEXT, age_min REAL, age_max REAL, file_size INTEGER,
  total_files INTEGER, tasks TEXT,
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);
CREATE TABLE nemar_catalog (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, modalities TEXT,
  participants INTEGER DEFAULT 0, age_min INTEGER DEFAULT 0, age_max INTEGER DEFAULT 0,
  tasks TEXT, authors TEXT, doi TEXT, license TEXT, bids_version TEXT, file_size INTEGER DEFAULT 0,
  file_size_formatted TEXT, total_files INTEGER DEFAULT 0, sessions_count INTEGER DEFAULT 0,
  latest_version TEXT, publish_date TEXT, created_date TEXT, uploader TEXT, readme TEXT,
  source TEXT NOT NULL DEFAULT 'nemar.org', source_id TEXT, is_processed INTEGER DEFAULT 0,
  search_text TEXT, synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO users (id, username, email, status) VALUES (10, 'alice', 'a@x.org', 'approved');
`;

// DB with 0027+0029 applied and search rows seeded (triggers populate FTS).
function searchDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(BASE_SCHEMA);
  db.exec(sql("0027_consolidation_columns_and_sentinel.sql"));
  db.exec(sql("0029_datasets_fts.sql"));
  db.exec(`
    INSERT INTO datasets (dataset_id, name, description, owner_user_id, status, visibility, is_sandbox,
      subject_count, modalities, tasks, authors, readme, concept_doi, uploader)
    VALUES
    ('nm000300','EEG Motor Imagery','desc',10,'active','public',0, 37,'eeg','imagery','Ada Lovelace',
       'A study of motor imagery using electroencephalography during sleep cycles','doi:10/mi', NULL),
    ('nm000301','Private EEG Study','desc',10,'active','private',0, 5,'eeg','rest','Bob','private readme','doi:10/p', NULL),
    ('xx000001','Sandbox EEG','desc',10,'active','public',1, 2,'eeg','imagery','Carol','sandbox readme', NULL, NULL),
    ('ds000246','Folded MEG Dataset',NULL,-1,'active','public',0, 12,'meg','rest','Niels Bohr','meg readme','doi:10/folded','OpenNeuro'),
    ('nm000302','Archived Public EEG','desc',10,'archived','public',0, 3,'eeg','rest','X','archived readme','doi:10/arch', NULL);
  `);
  return db;
}

describe("buildInPlaceholders", () => {
  test("builds the placeholder string", () => {
    expect(buildInPlaceholders(1)).toBe("?");
    expect(buildInPlaceholders(3)).toBe("?,?,?");
    expect(buildInPlaceholders(100).split(",").length).toBe(100);
  });
  test("rejects out-of-range / non-integer", () => {
    expect(() => buildInPlaceholders(0)).toThrow();
    expect(() => buildInPlaceholders(101)).toThrow();
    expect(() => buildInPlaceholders(1.5)).toThrow();
    expect(() => buildInPlaceholders(-1)).toThrow();
  });
});

describe("buildFtsMatch", () => {
  test("quotes + prefixes tokens, OR-joined, injection-safe", () => {
    expect(buildFtsMatch("motor imagery")).toBe('"motor"* OR "imagery"*');
    // operator chars are stripped by tokenization
    expect(buildFtsMatch('foo OR bar"; DROP')).toBe('"foo"* OR "or"* OR "bar"* OR "drop"*');
  });
  test("drops <2-char tokens and returns null when empty", () => {
    expect(buildFtsMatch("a b")).toBeNull();
    expect(buildFtsMatch("   ...  ")).toBeNull();
  });
});

describe("rrfFuse", () => {
  test("fuses by reciprocal rank, dedups, keeps FTS snippet", () => {
    const sem: SearchResult[] = [
      {
        id: "a",
        name: "A",
        modalities: "",
        participants: 0,
        doi: "",
        tasks: "",
        authors: "",
        score: 0.9,
      },
      {
        id: "b",
        name: "B",
        modalities: "",
        participants: 0,
        doi: "",
        tasks: "",
        authors: "",
        score: 0.8,
      },
    ];
    const lex: SearchResult[] = [
      {
        id: "b",
        name: "B",
        modalities: "",
        participants: 0,
        doi: "",
        tasks: "",
        authors: "",
        score: 1,
        snippet: "<mark>B</mark>",
      },
      {
        id: "c",
        name: "C",
        modalities: "",
        participants: 0,
        doi: "",
        tasks: "",
        authors: "",
        score: 1,
      },
    ];
    const fused = rrfFuse(sem, lex);
    expect(fused.map((r) => r.id)).toEqual(["b", "a", "c"]); // b in both -> top
    expect(fused.find((r) => r.id === "b")?.snippet).toBe("<mark>B</mark>"); // snippet grafted
    expect(new Set(fused.map((r) => r.id)).size).toBe(fused.length); // deduped
  });
});

describe("ftsSearch (FTS5 over datasets_fts)", () => {
  let db: Database;
  beforeEach(() => {
    db = searchDb();
  });

  test("matches name + readme body; excludes private + sandbox; returns snippet", async () => {
    const rows = await ftsSearch(realD1(db), "motor imagery", 20);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("nm000300");
    expect(ids).not.toContain("nm000301"); // private
    expect(ids).not.toContain("xx000001"); // sandbox
    const hit = rows.find((r) => r.id === "nm000300");
    expect(hit?.participants).toBe(37);
    expect(typeof hit?.snippet).toBe("string");
  });

  test("README-body term matches (typo-adjacent recall via readme index)", async () => {
    const rows = await ftsSearch(realD1(db), "electroencephalography sleep", 20);
    expect(rows.map((r) => r.id)).toContain("nm000300");
  });

  test("author-name query matches", async () => {
    const rows = await ftsSearch(realD1(db), "Lovelace", 20);
    expect(rows.map((r) => r.id)).toContain("nm000300");
  });
});

describe("hydrateDatasetsByIds", () => {
  test("preserves input order and drops missing ids; reads facts from datasets", async () => {
    const db = searchDb();
    const rows = await hydrateDatasetsByIds(realD1(db), ["ds000246", "nm000300", "does-not-exist"]);
    expect(rows.map((r) => r.id)).toEqual(["ds000246", "nm000300"]);
    expect(rows[0].authors).toBe("Niels Bohr");
    expect(rows[1].participants).toBe(37);
  });
});

describe("lookupDatasetById", () => {
  test("returns public+active rows only", async () => {
    const db = searchDb();
    expect((await lookupDatasetById(realD1(db), "nm000300"))?.id).toBe("nm000300");
    expect(await lookupDatasetById(realD1(db), "nm000301")).toBeNull(); // private
    expect(await lookupDatasetById(realD1(db), "xx000001")).toBeNull(); // sandbox
    expect(await lookupDatasetById(realD1(db), "nm000302")).toBeNull(); // archived (public)
  });
});

describe("buildDatasetFilterClauses (flag-ON list filters over d.*)", () => {
  test("search routes through FTS subquery + id/source_id LIKE (3 params)", () => {
    const params: (string | number)[] = [];
    const clause = buildDatasetFilterClauses(params, { search: "motor imagery" });
    expect(clause).toContain("datasets_fts MATCH ?");
    expect((clause.match(/LIKE \? ESCAPE/g) || []).length).toBe(2);
    expect(params).toEqual(["%motor imagery%", "%motor imagery%", '"motor"* OR "imagery"*']);
  });

  test("search with no FTS-usable tokens falls back to 4 LIKE params", () => {
    const params: (string | number)[] = [];
    const clause = buildDatasetFilterClauses(params, { search: "a b" }); // <2-char tokens
    expect(clause).not.toContain("datasets_fts MATCH");
    expect((clause.match(/LIKE \? ESCAPE/g) || []).length).toBe(4);
    expect(params.length).toBe(4);
  });

  test("modality/author/task/recent push one param each; hasDoi pushes none", () => {
    const params: (string | number)[] = [];
    buildDatasetFilterClauses(params, {
      modality: "eeg",
      author: "ada",
      task: "rest",
      hasDoi: true,
      recent: 30,
    });
    expect(params).toEqual(["%eeg%", "%ada%", "%rest%", "-30 days"]);
  });
});

describe("flag-ON list discriminator (source_type + owner_username)", () => {
  test("folded rows are 'catalog' w/ uploader; managed are 'managed' w/ username; private/sandbox excluded", () => {
    // Mirrors the load-bearing expressions of the flag-ON GET /datasets SELECT.
    const db = searchDb();
    const rows = db
      .query(
        `SELECT d.dataset_id,
                CASE WHEN d.owner_user_id = -1 THEN 'catalog' ELSE 'managed' END AS source_type,
                COALESCE(d.uploader, u.username) AS owner_username,
                d.concept_doi AS doi
         FROM datasets d LEFT JOIN users u ON d.owner_user_id = u.id
         WHERE d.status='active' AND (d.is_sandbox=0 OR d.is_sandbox IS NULL) AND d.visibility='public'`,
      )
      .all() as Array<{
      dataset_id: string;
      source_type: string;
      owner_username: string | null;
      doi: string | null;
    }>;
    const byId = new Map(rows.map((r) => [r.dataset_id, r]));
    expect(byId.get("ds000246")).toEqual({
      dataset_id: "ds000246",
      source_type: "catalog",
      owner_username: "OpenNeuro", // d.uploader
      doi: "doi:10/folded",
    });
    expect(byId.get("nm000300")?.source_type).toBe("managed");
    expect(byId.get("nm000300")?.owner_username).toBe("alice"); // u.username (uploader null)
    expect(byId.has("nm000301")).toBe(false); // private
    expect(byId.has("xx000001")).toBe(false); // sandbox
    expect(byId.has("nm000302")).toBe(false); // archived
  });
});

describe("migration 0030 backfill (managed authors/license from cache)", () => {
  test("fills empty authors/license for managed rows; preserves existing; skips sentinel", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(BASE_SCHEMA);
    db.exec(sql("0027_consolidation_columns_and_sentinel.sql")); // adds authors/license cols + sentinel user
    db.exec(`
      INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, authors, license)
      VALUES
      ('nm000400','Needs Backfill',10,'active','public',NULL,NULL),
      ('nm000401','Has Authors',10,'active','public','Existing Author',NULL),
      ('nm000402','No Catalog Row',10,'active','public',NULL,NULL),
      ('ds000999','Folded',-1,'active','public','Folded Author','CC0');
      INSERT INTO nemar_catalog (id, name, authors, license) VALUES
      ('nm000400','Needs Backfill','Cached Author','CC-BY'),
      ('nm000401','Has Authors','Should Not Win','MIT'),
      ('ds000999','Folded','Should Not Touch Sentinel','GPL');
    `);
    db.exec(sql("0030_backfill_managed_authors_license.sql"));
    const get = (id: string) =>
      db.query("SELECT authors, license FROM datasets WHERE dataset_id=?").get(id) as {
        authors: string | null;
        license: string | null;
      };
    expect(get("nm000400")).toEqual({ authors: "Cached Author", license: "CC-BY" }); // filled
    expect(get("nm000401").authors).toBe("Existing Author"); // preserved
    expect(get("nm000402").authors).toBeNull(); // no catalog row -> untouched
    expect(get("ds000999").authors).toBe("Folded Author"); // sentinel untouched (owner=-1)
  });
});

describe("read sites (anti-regression source pins)", () => {
  const datasetsSrc = readFileSync(
    join(import.meta.dir, "..", "backend/src/routes/datasets.ts"),
    "utf8",
  );
  const pageBundleSrc = readFileSync(
    join(import.meta.dir, "..", "backend/src/services/page-bundle.ts"),
    "utf8",
  );

  test("list keeps the source_type discriminator + uploader-aware owner_username", () => {
    expect(datasetsSrc).toContain("d.concept_doi AS doi");
    expect(datasetsSrc).toContain("THEN 'catalog' ELSE 'managed' END AS source_type");
    expect(datasetsSrc).toContain("COALESCE(d.uploader, u.username) AS owner_username");
  });

  test("page-bundle reads license/authors from datasets, not the dropped cache", () => {
    expect(pageBundleSrc).toContain("d.modalities, d.tasks, d.license, d.authors");
    expect(pageBundleSrc).not.toContain("LEFT JOIN nemar_catalog");
  });
});
