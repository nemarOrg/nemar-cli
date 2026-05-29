-- Dataset-store consolidation, Phase 1 / expand step 3 (#646, #647).
--
-- A driftless lexical index over `datasets`. FTS5 external-content
-- (content='datasets', content_rowid='id') stores ONLY an inverted index
-- over the base-table rowid -- no facts are copied. The AFTER triggers fire
-- inside the same D1 write transaction, so the index can never lag the row.
-- This replaces the precomputed nemar_catalog.search_text column (and its
-- writers) in Phase 3, when the read paths move onto datasets_fts.
--
-- ! GATE: apply this migration against the env.dev D1 with --remote FIRST.
--   The trigger bodies use UPPERCASE BEGIN...END to dodge workers-sdk#10998
--   ("[code: 7500] incomplete input" on lowercase begin during remote
--   apply). Wrangler is pinned >=4.85.0, past the verified-good version, but
--   a LOCAL apply can still pass while a --remote apply fails, so dev/remote
--   is the real check before prod.
--
-- ! BACKUP RUNBOOK: `wrangler d1 export` fails on a DB containing a virtual
--   table. Before any export: DROP TABLE datasets_fts, export, then recreate
--   from this file (cheap at ~600 rows).

CREATE VIRTUAL TABLE IF NOT EXISTS datasets_fts USING fts5(
  name, description, authors, tasks, modalities, readme,
  content='datasets', content_rowid='id'
);

-- Initial populate: index EVERY datasets row (unconditional), matching the
-- unconditional triggers below. Status/visibility/sandbox are filtered at
-- READ time (Phase 3), not here -- if the populate filtered but the triggers
-- did not, the index would drift (a later private/archived row would be
-- indexed while existing ones were not). So: index all, filter on read.
INSERT INTO datasets_fts(rowid, name, description, authors, tasks, modalities, readme)
SELECT id, name, description, authors, tasks, modalities, readme FROM datasets;

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

-- Mark a row's vector stale when an embedding-relevant fact changes. The
-- inner UPDATE touches only embedding_dirty, which is NOT in either trigger's
-- OF list, so it neither re-fires this trigger nor the FTS triggers above.
-- Drained by the Phase-4 embedding_dirty cron.
CREATE TRIGGER datasets_embed_dirty_au
AFTER UPDATE OF name, description, modalities, tasks, authors, readme ON datasets BEGIN
  UPDATE datasets SET embedding_dirty = 1 WHERE id = new.id;
END;
