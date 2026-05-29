> Status: PROPOSAL (not yet implemented). Authored 2026-05-29 via a multi-agent design workflow (3 architectures + 4 feasibility verifiers + judge panel + synthesis). Ranking: A=7.7 (recommend), B=6.5, C=6.2. Feasibility verdicts: D1 FTS5 supported-with-caveats; row-fold migration supported; id-only Vectorize supported; back-compat supported-with-caveats.
> Origin: investigation of nemar.org website search drift (semantic search returned stale name/participants/authors for managed datasets while the datasets table held the real values).

# nemar-cli Dataset Store Consolidation — Final Design

## 1. TL;DR

**Winner: Approach A (Single Table of Record + FTS5 + ID-only Vectorize), hardened with grafts from B and C.** Collapse all 600 datasets into the `datasets` table as the sole source of truth per fact (legacy catalog-only rows folded in under a sentinel system owner, keeping the `NOT NULL` FK intact), replace the three competing `nemar_catalog` writers with a real driftless **FTS5 external-content** index kept in sync by `AFTER` triggers, and make Vectorize store **only the vector id** so every search result is hydrated from the live `datasets` row at query time.

A wins because it is the only design where drift is *structurally* impossible for **every** fact and **both** indexes: one table, one writer per domain, a lexical index that fires inside the same D1 write transaction, and a vector index that carries zero facts. B keeps two tables forever (a permanent inter-table invariant to police and a hand-maintained `search_text` the strongest verdict says is unnecessary) and C keeps `nemar_catalog` as a 4-hour eventually-consistent projection (it relocates drift rather than eliminating it, and is premised on the incorrect claim that D1 lacks FTS5). All capability assumptions are verified against the codebase and the four feasibility verdicts: wrangler is pinned at `^4.85.0` (past the lowercase-`begin` remote-apply bug), `owner_user_id` is `INTEGER NOT NULL` with a live `FOREIGN KEY` and an INNER JOIN to `users`, and migration 0026 is the proven 12-step rebuild template. From B and C we graft B's exemplary expand-migrate-contract discipline with a **dual-read flag window** (A's thinnest point), C's `enrichment_json`→`authors`/`license` backfill (a faithful copy of shipped 0023) and its **atomic Phase-3 deploy gate**, plus the orphan-`deleteByIds` and `returnMetadata:'none'` topK lift the Vectorize verdict requires.

## 2. Target architecture

```
                        ┌──────────────────────────────────────────────────┐
                        │              datasets  (SOURCE OF TRUTH)           │
                        │  one row per dataset — managed nm*/on*/ds* AND     │
                        │  folded legacy catalog-only rows (owner=SYSTEM_ID) │
                        │                                                    │
                        │  ops cols: status, visibility, github_repo,        │
                        │    concept_doi, zenodo_*, ezid_*, nemar_sync_*,    │
                        │    owner_user_id (NOT NULL → users.id), …          │
                        │  fact cols: name, description, subject_count,      │
                        │    modalities, age_min/max, file_size,             │
                        │    total_files, tasks, source, source_id,          │
                        │    + authors, license, readme, bids_version,       │
                        │      sessions_count, publish_date, uploader,       │
                        │      file_size_formatted, embedding_dirty          │
                        └───────────────┬───────────────────┬────────────────┘
                                        │                   │
                  AFTER INSERT/UPDATE/  │                   │  embedding_dirty=1
                  DELETE triggers       │                   │  (set by triggers + legacy sync)
                  (same D1 write txn)   │                   │
                                        ▼                   ▼
                    ┌───────────────────────────┐   ┌──────────────────────────┐
                    │  datasets_fts  (FTS5)      │   │  Vectorize index         │
                    │  external-content:         │   │  nemar-dataset-index     │
                    │  content='datasets',       │   │  384-dim cosine          │
                    │  content_rowid='id'        │   │                          │
                    │  indexes: name, desc,      │   │  per vector:             │
                    │  authors, tasks,           │   │   { id, values }         │
                    │  modalities, readme        │   │   metadata = {}          │
                    │  → stores NO facts,         │   │  → stores NO facts        │
                    │    only an index over       │   │    only the neighborhood  │
                    │    rowid                    │   │                          │
                    └─────────────┬──────────────┘   └────────────┬─────────────┘
                                  │  bm25() rank, snippet()        │  topK ids + scores
                                  │  JOIN rowid → datasets         │
                                  ▼                                ▼
                    ┌──────────────────────────────────────────────────────────┐
                    │  Read paths — ALL hydrate facts from datasets by id        │
                    │  GET /datasets   (list, single SELECT, no UNION)           │
                    │  GET /datasets/search  (exact-id → semantic → FTS5)        │
                    │  page-bundle.loadCatalogRow  (no JOIN — reads d.* direct)  │
                    └──────────────────────────────────────────────────────────┘
```

**The single rule that makes drift structurally impossible:**

> **No fact is ever copied. It is stored exactly once (in a `datasets` column) and both search indexes reference the owning row by id only — FTS5 by `content_rowid='id'` kept current by same-transaction triggers, Vectorize by `{id, values}` with empty metadata. Every search result hydrates its display fields from the live `datasets` row at query time.** A stale embedding can therefore only degrade *ranking*, never *correctness*; and the lexical index can never lag the row because the trigger fires inside the same D1 write.

## 3. Per-fact ownership matrix

| Fact (wire field) | Owning `datasets` column | How legacy catalog-only rows carry it | How it reaches lexical search | How it reaches vector search |
|---|---|---|---|---|
| `name` | `name` | folded value from `nemar_catalog.name` | FTS5 indexed column | embedded into vector text; hydrated by id |
| `description` | `description` (readme[:500]) | folded from `nemar_catalog.description` | FTS5 indexed column | hydrated by id |
| `participants` | `subject_count` (aliased `AS participants`) | folded from `nemar_catalog.participants` | hydrated via JOIN on rowid | hydrated by id |
| `modalities` | `modalities` | folded from `nemar_catalog.modalities` | FTS5 indexed column | embedded + hydrated by id |
| `tasks` | `tasks` | folded from `nemar_catalog.tasks` | FTS5 indexed column | embedded + hydrated by id |
| `authors` | `authors` (NEW) | folded from `nemar_catalog.authors` | FTS5 indexed column | embedded + hydrated by id |
| `license` | `license` (NEW) | folded from `nemar_catalog.license` | not indexed (hydrate only) | not embedded |
| `readme` (full body) | `readme` (NEW, truncated to 8 KB) | folded from `nemar_catalog.readme` | FTS5 indexed column (typo-tolerant body match + snippet) | first 1000 chars embedded |
| `bids_version` | `bids_version` (NEW) | folded from `nemar_catalog.bids_version` | n/a | n/a |
| `sessions_count` | `sessions_count` (NEW) | folded from `nemar_catalog.sessions_count` | n/a | n/a |
| `publish_date` | `publish_date` (NEW) | folded from `nemar_catalog.publish_date` | n/a (sort/filter only) | n/a |
| `file_size` | `file_size` | folded from `nemar_catalog.file_size` | hydrate only | n/a |
| `file_size_formatted` | `file_size_formatted` (NEW, stored) | folded from `nemar_catalog.file_size_formatted` | hydrate only | n/a |
| `doi` | `concept_doi` (aliased `AS doi`) | folded `nemar_catalog.doi` → `concept_doi` | hydrate only | hydrate only |
| `latest_version` | subquery on `dataset_versions` (managed); folded `latest_version` column for legacy | folded from `nemar_catalog.latest_version` | n/a | n/a |
| `owner_username` | `users.username` via FK | sentinel user `nemar-system`; real uploader preserved in `datasets.uploader` and surfaced as `owner_username` | n/a | n/a |
| `source` / `source_id` | `source` / `source_id` | folded (`'nemar.org'` / `'openneuro'`) | n/a | n/a |
| `source_type` | derived: `CASE WHEN owner_user_id = SYSTEM_USER_ID THEN 'catalog' ELSE 'managed' END` | discriminated by sentinel owner | n/a | n/a |

`authors` and `license` are derived from `enrichment_json` by the enrichment pipeline (C's `authorsFromEnrichment` logic) and persisted as first-class columns; they are no longer read from a cache table.

## 4. Schema changes

All changes are **plain `ALTER TABLE ADD COLUMN` + `INSERT` + `CREATE VIRTUAL TABLE` + `CREATE TRIGGER`**. **No SQLite table rebuild is required** — the migration verdict confirms the only thing that forces a 12-step rebuild is dropping/loosening a `NOT NULL` or changing a type, and the sentinel-user approach avoids touching `owner_user_id` entirely. Migration 0026's rebuild template is referenced only as a contingency, not used.

### Migration 0027 — additive columns + sentinel user (non-breaking)

```sql
-- New fact homes on the single source of truth
ALTER TABLE datasets ADD COLUMN authors TEXT;
ALTER TABLE datasets ADD COLUMN license TEXT;
ALTER TABLE datasets ADD COLUMN readme TEXT;             -- truncated to 8 KB on write
ALTER TABLE datasets ADD COLUMN bids_version TEXT;
ALTER TABLE datasets ADD COLUMN sessions_count INTEGER;
ALTER TABLE datasets ADD COLUMN publish_date TEXT;
ALTER TABLE datasets ADD COLUMN uploader TEXT;            -- legacy human uploader (NULL for managed)
ALTER TABLE datasets ADD COLUMN file_size_formatted TEXT;
ALTER TABLE datasets ADD COLUMN embedding_dirty INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_datasets_publish_date ON datasets(publish_date);
CREATE INDEX IF NOT EXISTS idx_datasets_embedding_dirty ON datasets(embedding_dirty);

-- Sentinel system owner. users.id is AUTOINCREMENT from 1; verify id=1 is free
-- before applying. If taken, use the lowest unused id and store it as
-- SYSTEM_USER_ID in src/lib/constants.ts. users now permits web-only rows (0026),
-- so a username-only system row is valid.
INSERT OR IGNORE INTO users (id, username, email, status, email_verified)
VALUES (1, 'nemar-system', 'system@nemar.org', 'approved', 1);
```

### Migration 0028 — backfill (single declarative migration, follows shipped 0023/0024 pattern)

```sql
-- (a) authors/license for managed rows from enrichment_json — faithful copy of 0023
UPDATE datasets SET
  authors = COALESCE(authors, CASE
    WHEN json_type(enrichment_json,'$.authors')='array' THEN
      (SELECT GROUP_CONCAT(json_extract(je.value,'$.name'),', ')
       FROM json_each(enrichment_json,'$.authors') je
       WHERE json_extract(je.value,'$.name') IS NOT NULL)
    WHEN json_type(enrichment_json,'$.authors')='object' THEN
      (SELECT GROUP_CONCAT(je.key,', ') FROM json_each(enrichment_json,'$.authors') je)
    ELSE NULL END),
  license = COALESCE(license, json_extract(enrichment_json,'$.license'))
WHERE enrichment_json IS NOT NULL;

-- (b) readme/bids_version/sessions_count/publish_date/file_size_formatted for managed
--     rows from their existing nemar_catalog cache row (COALESCE-preserve)
UPDATE datasets SET
  readme              = COALESCE((SELECT substr(c.readme,1,8192) FROM nemar_catalog c WHERE c.id=datasets.dataset_id), readme),
  bids_version        = COALESCE((SELECT c.bids_version        FROM nemar_catalog c WHERE c.id=datasets.dataset_id), bids_version),
  sessions_count      = COALESCE((SELECT c.sessions_count      FROM nemar_catalog c WHERE c.id=datasets.dataset_id), sessions_count),
  publish_date        = COALESCE((SELECT c.publish_date        FROM nemar_catalog c WHERE c.id=datasets.dataset_id), publish_date),
  file_size_formatted = COALESCE((SELECT c.file_size_formatted FROM nemar_catalog c WHERE c.id=datasets.dataset_id), file_size_formatted)
WHERE dataset_id IN (SELECT id FROM nemar_catalog);

-- (c) FOLD legacy catalog-only rows into datasets — sentinel owner, BOTH dedup guards.
--     Note the SECOND NOT IN that excludes ds* shadows of managed on* rows
--     (verified live at routes/datasets.ts:594-603). Approach A's original
--     INSERT omitted this; it is mandatory or mirrored rows double-list.
INSERT OR IGNORE INTO datasets (
  dataset_id, name, description, owner_user_id, status, visibility, is_sandbox,
  source, source_id, subject_count, modalities, age_min, age_max, file_size,
  total_files, tasks, authors, license, readme, bids_version, sessions_count,
  publish_date, uploader, file_size_formatted, created_at, updated_at, embedding_dirty)
SELECT
  c.id, c.name, c.description, 1, 'active', 'public', 0,
  c.source, c.source_id, c.participants, c.modalities, c.age_min, c.age_max, c.file_size,
  c.total_files, c.tasks, c.authors, c.license, substr(c.readme,1,8192), c.bids_version, c.sessions_count,
  COALESCE(c.publish_date, c.created_date, datetime('now')), c.uploader, c.file_size_formatted,
  COALESCE(c.created_date, datetime('now')), datetime('now'), 1
FROM nemar_catalog c
WHERE c.id NOT IN (SELECT dataset_id FROM datasets WHERE status='active')
  AND c.id NOT IN (
        SELECT source_id FROM datasets
        WHERE status='active' AND source='openneuro' AND source_id IS NOT NULL);
```

### Migration 0029 — FTS5 external-content index + sync triggers

> **Trigger bodies use UPPERCASE `BEGIN…END`** to avoid the workers-sdk#10998 `[code: 7500] incomplete input` remote-apply failure. Wrangler is pinned at `^4.85.0`, past the verified-good version. **Apply with `wrangler d1 migrations apply nemar-db --remote` against the `env.dev` D1 first** — local apply can pass while remote fails.

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS datasets_fts USING fts5(
  name, description, authors, tasks, modalities, readme,
  content='datasets', content_rowid='id'
);

-- Initial population (active, non-sandbox rows)
INSERT INTO datasets_fts(rowid, name, description, authors, tasks, modalities, readme)
SELECT id, name, description, authors, tasks, modalities, readme
FROM datasets WHERE status='active' AND (is_sandbox=0 OR is_sandbox IS NULL);

CREATE TRIGGER datasets_fts_ai AFTER INSERT ON datasets BEGIN
  INSERT INTO datasets_fts(rowid, name, description, authors, tasks, modalities, readme)
  VALUES (new.id, new.name, new.description, new.authors, new.tasks, new.modalities, new.readme);
END;

CREATE TRIGGER datasets_fts_ad AFTER DELETE ON datasets BEGIN
  INSERT INTO datasets_fts(datasets_fts, rowid, name, description, authors, tasks, modalities, readme)
  VALUES ('delete', old.id, old.name, old.description, old.authors, old.tasks, old.modalities, old.readme);
END;

CREATE TRIGGER datasets_fts_au AFTER UPDATE OF name, description, authors, tasks, modalities, readme ON datasets BEGIN
  INSERT INTO datasets_fts(datasets_fts, rowid, name, description, authors, tasks, modalities, readme)
  VALUES ('delete', old.id, old.name, old.description, old.authors, old.tasks, old.modalities, old.readme);
  INSERT INTO datasets_fts(rowid, name, description, authors, tasks, modalities, readme)
  VALUES (new.id, new.name, new.description, new.authors, new.tasks, new.modalities, new.readme);
END;

-- Mark vectors dirty when embedding-relevant fields change (drained by cron, §6)
CREATE TRIGGER datasets_embed_dirty_au
AFTER UPDATE OF name, description, modalities, tasks, authors, readme ON datasets BEGIN
  UPDATE datasets SET embedding_dirty = 1 WHERE id = new.id;
END;
```

### Migration 0030 — drop the cache (separate, reversible-until-run, behind a 24h+ validation window)

```sql
DROP TABLE nemar_catalog;
-- catalog_sync_log is retained as the legacy-ingest logging artifact.
```

**Rebuild contingency only:** if a *future* change must drop a `NOT NULL` or change a type on `datasets`, follow migration 0026 verbatim (rebuild `datasets_new` with the full column superset, recreate `dataset_collaborators` + `dataset_versions` children to repoint FKs, never `PRAGMA foreign_keys=OFF` inside the D1 transaction). This consolidation does not need it.

## 5. Search design

### Driftless lexical index — FTS5 (verdict-supported, high confidence)

`textSearch()` (`dataset-search.ts:60`) and the list endpoint's managed-branch `LIKE` chain are both rewritten onto `datasets_fts`. The external-content binding (`content='datasets'`, `content_rowid='id'`) means FTS5 stores **only an index over the base-table rowid**; the triggers keep it current inside the same D1 write, so the `search_text` precomputed column and its three writers are deleted outright.

```sql
-- /datasets/search text tier — bm25 ranking + snippet for highlighting (issue #12)
SELECT d.dataset_id AS id, d.name, d.modalities,
       d.subject_count AS participants, d.concept_doi AS doi,
       d.tasks, d.authors,
       snippet(datasets_fts, 5, '<mark>', '</mark>', '…', 12) AS snippet,
       bm25(datasets_fts) AS score
FROM datasets_fts
JOIN datasets d ON d.id = datasets_fts.rowid
WHERE datasets_fts MATCH ?
  AND d.status='active' AND (d.is_sandbox=0 OR d.is_sandbox IS NULL)
  AND d.visibility='public'
ORDER BY bm25(datasets_fts)
LIMIT ?;
```

The match term is wrapped as a quoted FTS5 phrase with internal quotes doubled to prevent injection. **Issue #12 coverage:** FTS5 prefix tokens (`term*`) give typo/stem tolerance; `readme` is an indexed column so **full README body matches**; `authors` is indexed so **author-name search** works; `snippet()` returns highlightable context. In the list endpoint the five-column `LIKE` + `COALESCE(c.search_text)` collapses to:

```sql
AND (d.dataset_id LIKE ? ESCAPE '\' OR d.source_id LIKE ? ESCAPE '\'
     OR d.id IN (SELECT rowid FROM datasets_fts WHERE datasets_fts MATCH ?))
```

### ID-only Vectorize + hydrate from D1

`syncToVectorize` writes `{ id, values }` with `metadata: {}`. `semanticSearch()` (`dataset-search.ts:25`, currently `returnMetadata:'all'` at line 41) is rewritten to:

1. `vectorize.query(vec, { topK, returnMetadata: 'none' })` — `'none'` **lifts the topK ceiling from 50 to 100**, matching the endpoint max.
2. Take the ordered `[{id, score}]`.
3. Hydrate in one batched query against the single table (no UNION needed — all 600 rows live in `datasets`, so the JOIN always resolves):

```sql
SELECT d.dataset_id AS id, d.name, d.modalities, d.subject_count AS participants,
       d.concept_doi AS doi, d.tasks, d.authors
FROM datasets d
WHERE d.dataset_id IN (?,?,…)
ORDER BY CASE d.dataset_id WHEN ? THEN 0 WHEN ? THEN 1 … END;  -- preserve vector ranking
```

A `buildInPlaceholders(n)` helper (≤100 params, well within D1 limits) is unit-tested. **This is the actual bug fix:** `nm000156` returns its real title/participants/authors regardless of when its vector was embedded.

### Hybrid lexical/semantic fusion (issue #12)

The tiered `/datasets/search` becomes **exact-id → semantic ∪ FTS5 (fused) → unavailable**. Run semantic and FTS5 in parallel and merge with **Reciprocal Rank Fusion** (`score = Σ 1/(k + rank_i)`, `k=60`), dedup by id, keep the FTS5 `snippet`. This gives semantic recall (concept queries) *and* lexical precision (exact author/task/typo-corrected token), with snippets for the UI. The wire `method` enum stays `{semantic, text, text_fallback, exact_id, unavailable}`; fused results report `method:'semantic'` when the vector tier contributed, else `'text'`. **No new response field is required** (`snippet` is additive-optional and currently unconsumed by the website; the CLI ignores unknown keys).

## 6. Re-embedding (Vectorize verdict — hybrid)

No index recreation (dims stay 384). Two complementary paths keep vectors fresh; **no Cloudflare Queue** (over-engineering at 600 docs):

- **(a) Inline, near-instant for managed writes.** At the existing synchronous hook sites — `dataset-reindex.ts:403` and `enrich-dataset.ts:941` (where `env.AI` + `env.VECTORIZE` are in scope) — append `ctx.waitUntil(embedAndUpsert(env.AI, env.VECTORIZE, id, name + modalities + tasks + authors + readme[:1000]))`. Fire-and-forget: one embed + one upsert (~tens of ms), never blocks or fails the user request. Upsert overwrites metadata in full, so `{}` atomically clears any stale 6-field metadata.
- **(b) `embedding_dirty` cron backstop.** The legacy 4-hourly GitHub Action (Node, no Workers AI binding) ingests catalog-only rows and sets `embedding_dirty=1`; the `AFTER UPDATE` trigger sets it on any fact change. A Worker cron (the `scheduled()` handler already exists at `index.ts:310`; crons defined in `wrangler-sccn.toml`) drains `WHERE embedding_dirty=1 ORDER BY updated_at LIMIT 50`, batch-embeds 20 at a time, upserts `{id, values}`, clears the flag. Bounds staleness to one cron interval.
- **(c) Orphan safety.** On dataset deletion call `vectorize.deleteByIds([id])`; the cron reconciles any vector whose `datasets` row is gone. This closes the verdict's one residual id-only risk (a vector the D1 hydrate cannot resolve).
- **One-time:** a Phase-3 admin action `POST /admin/vectorize/reindex-all` embeds all active public rows to fix the 70% managed stale-vector backlog.

## 7. Phased, reversible migration plan (expand → migrate → contract)

Each phase ships independently and is back-compatible. Phases 1–4 are code-only-reversible; the single irreversible moment is Phase 6 (`DROP TABLE`).

1. **Expand (additive DDL, zero behavior change).** Apply 0027 (columns + sentinel user), 0028 (backfill + fold), 0029 (FTS5 + triggers). Existing code still reads `nemar_catalog`; both stores now valid. Validate: `SELECT COUNT(*) FROM datasets` = ~600; `SELECT COUNT(*) FROM datasets_fts` matches active/public; `authors`/`license` populated where `enrichment_json IS NOT NULL`. **Apply 0029 against `env.dev` `--remote` first** to confirm triggers apply.
2. **Dual-write the new model.** Replace `syncNemarCatalogFromEnrichment` calls (`enrich-dataset.ts:941`, `dataset-reindex.ts:403`) with `writeDatasetCatalogFields()` writing `authors/license/readme/bids_version/sessions_count` + `name/description` directly to `datasets`. **Keep the `nemar_catalog` write as a safety net this phase** (write both). Add the inline `ctx.waitUntil` re-embed (§6a). Unit-test COALESCE-preserve semantics.
3. **Migrate reads behind a dual-read flag (B's discipline — A's thinnest point).** Behind `READ_FROM_DATASETS` (default off → flip on after smoke test): rewrite the list managed branch to read `d.subject_count AS participants`, `d.modalities`, `d.tasks`, `d.authors`, `d.file_size`, `d.file_size_formatted` (no `LEFT JOIN nemar_catalog`); collapse the UNION — the catalog-only branch becomes `source_type = CASE WHEN owner_user_id=SYSTEM_USER_ID THEN 'catalog' ELSE 'managed' END` with `owner_username = COALESCE(d.uploader, u.username)`. With the flag **off**, reads fall back to the old JOIN. Rewrite `buildFilterClauses`/`buildSortClause` to `d.*`, `textSearch()` to FTS5, `semanticSearch()` to id-only + hydrate, `page-bundle.loadCatalogRow` to read `d.authors`/`d.license` direct. **Atomic deploy gate (C):** the removal of `match.metadata.*` reads must land in the *same* deploy as the hydration query, or search breaks. Verify wire shapes against a preview deploy with `/browse` before flipping the flag.
4. **Re-embed backlog + retarget legacy sync.** Run `POST /admin/vectorize/reindex-all`. Retarget the 4-hourly Action to write folded catalog-only rows into `datasets` (sentinel owner, `ON CONFLICT(dataset_id) DO UPDATE` with COALESCE-preserve on operational columns it must not touch) and set `embedding_dirty=1`. Deploy the `embedding_dirty` cron (§6b) + `deleteByIds` on delete (§6c).
5. **Flip flag to read-new-only; bake.** `READ_FROM_DATASETS` on permanently. Remove the Phase-2 `nemar_catalog` dual-write. Keep the existing missing-table fallback (`datasets.ts:817`) as a permanent net. Monitor 24h+.
6. **Contract (irreversible).** Apply 0030 `DROP TABLE nemar_catalog`. Delete dead code (§9). `bun run typecheck` + `bun run test` green. Update `/admin/catalog/status` count to `datasets WHERE owner_user_id=SYSTEM_USER_ID`.

**Backup runbook note (FTS5 verdict caveat):** D1 export fails on databases containing virtual tables. Before any `wrangler d1 export`, `DROP TABLE datasets_fts`, export, then recreate via the 0029 `CREATE VIRTUAL TABLE` + the populate `INSERT … SELECT` (cheap at 600 rows). Document this in the backup runbook.

## 8. Backward-compatibility contract

**`GET /datasets`** — envelope `{datasets:[], count, total_count, limit, offset}` unchanged; `limit` 1–200 (def 50), `offset`, `total_count` = filtered `COUNT(*)`. Every row guarantees, byte-identical: `dataset_id, id (=dataset_id text), name, description, status, visibility, github_repo, concept_doi, doi, created_at, updated_at, owner_username, nemar_sync_status, source, source_id, source_type('managed'|'catalog'), modalities(string), participants(number), tasks(string), authors(string), file_size(number), file_size_formatted(string), latest_version`. Only the SQL expression behind each alias changes (e.g. `COALESCE(c.participants,0)` → `d.subject_count`).

**`GET /datasets/search`** — envelope `{results:[{id,name,modalities,participants,doi,tasks,authors,score}], count, method, min_score}` unchanged; `method` enum `{semantic,text,text_fallback,exact_id,unavailable}`; no offset; `limit ≤ 100`. `snippet` is additive-optional. The `SearchResult` interface is unchanged.

**`GET /datasets/:id`** — `{dataset:{…d.* + owner_username + owner_github}}`; no catalog JOIN today, left as-is (website sources tasks/authors from `data.nemar.org` for the detail page).

**Queries rewritten** (all verified line refs): list managed `?mine` (`datasets.ts:481-524`), public managed branch (`529-553`), catalog-only branch collapses (`580-605`, both NOT-IN guards folded into the migration `INSERT`), `buildFilterClauses` (`660-740`), `buildSortClause` participants/size (`752-755`), `textSearch` (`dataset-search.ts:60-95`) → FTS5, `semanticSearch` (`dataset-search.ts:25-54`, drops `returnMetadata:'all'` at line 41) → id-only + hydrate, `syncToVectorize` (`catalog-sync.ts:228-246`) → `{id,values}`, `page-bundle.loadCatalogRow` (`page-bundle.ts:82-94`) → `d.authors`/`d.license`, `/admin/catalog/status` (`admin.ts:5402`) → `datasets` count.

## 9. What gets deleted

- **Tables:** `nemar_catalog` (0030); the `search_text` precomputed column concept (no equivalent — FTS5 replaces it).
- **The three competing writers:** `catalog-sync.ts:syncToD1()` retargeted to write `datasets` (legacy ingest) and `syncToVectorize()` replaced by §6 re-embed paths; `catalog-from-local.ts` deleted entirely (`syncCatalogFromLocal`, `buildCatalogRecordFromLocal`, `LocalCatalogRecord`, `LocalDatasetRow`); `syncNemarCatalogFromEnrichment()` + `CatalogSyncFields` deleted from `dataset-metadata-columns.ts`, callers rewritten to `writeDatasetCatalogFields()`.
- **Code paths:** the entire catalog-only UNION branch and its double `NOT IN` (`datasets.ts:580-605`) — replaced by a single SELECT discriminated by sentinel owner; all `COALESCE(c.*, …)` wrappers; the `LEFT JOIN nemar_catalog c` at `datasets.ts:505/550`, `page-bundle.ts:84`, `dataset-search.ts:68`; the 6-field vector metadata literal (`catalog-sync.ts:230-244`); `POST /admin/catalog/sync-local`. The missing-table fallback (`datasets.ts:817`) is **kept** as a permanent net.

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| FTS5 trigger remote-apply fails (workers-sdk#10998) | Uppercase `BEGIN…END`; `wrangler … apply --remote` against `env.dev` D1 in Phase 1 before prod. Wrangler `^4.85.0` is past the fix. |
| D1 export breaks with a virtual table present | Backup runbook: `DROP TABLE datasets_fts` → export → recreate from 0029. Cheap at 600 rows. |
| Folded `ds*` shadows double-list next to managed `on*` mirror | The fold `INSERT` carries **both** dedup guards (status + `source_id` exclusion), mirroring live `datasets.ts:594-603`. Validate post-migration: no `id` appears twice in the list. |
| `nemar-system` shown as uploader (user-visible regression) | `datasets.uploader` (NEW) preserves the human name; `owner_username = COALESCE(d.uploader, u.username)`. |
| Raw D1 console UPDATE bypasses FTS5 triggers → silent stale index | Admin endpoint runs `INSERT INTO datasets_fts(datasets_fts) VALUES('integrity-check')` + `'rebuild'` on demand; cron runs integrity-check periodically. |
| `sessions_count`/`bids_version` have no managed extraction path today | Backfilled from cache; `writeDatasetCatalogFields` accepts both as optional. `bids_version` is already parsed in `dataset-reindex.ts` for the nemar.org push — wire it through. File a follow-up issue for BIDS-native `sessions_count` extraction (count `ses-*` dirs). |
| `readme` row width on D1 | Truncate to 8 KB on write (`substr(…,1,8192)`) — sufficient for FTS body match + description fallback, avoids D1 row-size pressure across ~420 managed readmes. |
| Sentinel `users.id=1` collision | Verify id=1 free before applying; else lowest unused id in `SYSTEM_USER_ID` constant. |
| Partial Phase-3 deploy → empty `authors` / broken search | Dual-read flag + atomic deploy gate (metadata-read removal lands with hydration query). |

## 11. Split of work

**nemar-cli (all changes here):** migrations 0027–0030; `routes/datasets.ts` (collapse UNION, rewrite filter/sort/list to `d.*`); `services/dataset-search.ts` (FTS5 `textSearch`, id-only `semanticSearch` + hydrate, RRF fusion, `buildInPlaceholders`); `services/catalog-sync.ts` (retarget `syncToD1`, delete `syncToVectorize`); delete `services/catalog-from-local.ts`; `services/dataset-metadata-columns.ts` (delete `syncNemarCatalogFromEnrichment`, add `writeDatasetCatalogFields`); `services/page-bundle.ts` (drop JOIN); `services/enrich-dataset.ts` + `services/dataset-reindex.ts` (rewrite hook, add inline re-embed); `index.ts` `scheduled()` (embedding_dirty cron); `routes/admin.ts` (`reindex-all`, status count, remove `sync-local`); `src/lib/constants.ts` (`SYSTEM_USER_ID`); retarget the 4-hourly GitHub Action; backup runbook update. **No CLI consumer change** — `src/lib/api.ts` shapes are byte-stable.

**website (no changes required):** the `Dataset` type (`dataset_id, id, name, description, status, visibility, github_repo, concept_doi, doi, created_at, updated_at, owner_username, nemar_sync_status, source, source_type, source_id, modalities, participants, tasks, authors, file_size, file_size_formatted, latest_version`) and `DatasetListResponse` are satisfied by the unchanged aliases; the website does not consume `/datasets/search`. The optional `snippet` field is ignored by existing clients. **The only condition under which the website changes is if it later opts in to render `snippet` highlights** — purely additive, not required by this consolidation.

---

**Recommendation: file the epic as Approach A hardened with the grafts above.** The two non-negotiable pre-production gates are (1) the `env.dev --remote` FTS5 trigger apply in Phase 1, and (2) the double-dedup-guard fold `INSERT` in 0028. Everything else is mechanical SQL behind frozen wire shapes.