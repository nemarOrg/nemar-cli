-- Dataset-store consolidation, Phase 1 / expand step 1 (#646, #647).
--
-- Make `datasets` the single source of truth by giving it homes for the
-- facts that today live only in the nemar_catalog cache. Additive only:
-- plain ADD COLUMN + a sentinel user INSERT. No table rebuild is needed --
-- the only thing that forces a 0026-style 12-step rebuild is dropping or
-- loosening a NOT NULL / changing a type, and the negative-id sentinel
-- (below) deliberately avoids touching owner_user_id at all.
--
-- The fold of legacy catalog-only rows and the backfill happen in 0028;
-- the FTS5 index + triggers in 0029. Existing read paths keep reading
-- nemar_catalog this phase (with dormancy guards added in code so the
-- folded rows stay invisible to GET /datasets until Phase 3).

-- New fact homes on the source of truth. Types mirror nemar_catalog
-- (0018): participants->subject_count already exists from 0020, so only
-- the columns with no datasets home yet are added here.
ALTER TABLE datasets ADD COLUMN authors TEXT;
ALTER TABLE datasets ADD COLUMN license TEXT;
ALTER TABLE datasets ADD COLUMN readme TEXT;              -- truncated to 8 KB on write (0028)
ALTER TABLE datasets ADD COLUMN bids_version TEXT;
ALTER TABLE datasets ADD COLUMN sessions_count INTEGER;
ALTER TABLE datasets ADD COLUMN publish_date TEXT;
ALTER TABLE datasets ADD COLUMN uploader TEXT;            -- legacy human uploader (NULL for managed rows)
ALTER TABLE datasets ADD COLUMN file_size_formatted TEXT;
ALTER TABLE datasets ADD COLUMN embedding_dirty INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_datasets_publish_date ON datasets(publish_date);
CREATE INDEX IF NOT EXISTS idx_datasets_embedding_dirty ON datasets(embedding_dirty);

-- Sentinel system owner for folded catalog-only rows (see SYSTEM_USER_ID in
-- backend/src/lib/constants.ts). The id is -1, NOT 1:
--   * users.id=1 (and the next several) are already taken by real rows on
--     both dev and prod, so the design doc's VALUES(1, ...) would silently
--     no-op under INSERT OR IGNORE and mis-attribute every folded dataset.
--   * a negative id is guaranteed free everywhere and does not advance the
--     users AUTOINCREMENT sequence (sqlite_sequence tracks the max positive
--     rowid only), so real signups keep their natural ids.
-- Migration 0026 dropped the NOT NULL on username/password_hash/github_username,
-- so an email+username-only system row is valid. owner_user_id's FK to
-- users(id) is satisfied because this row exists before the 0028 fold runs.
--
-- status='revoked' (NOT 'approved') is deliberate: it keeps this non-login
-- system account out of every "active user" enumeration for free, with no
-- extra guard code -- broadcast recipients (services/broadcast.ts: status =
-- 'approved'), the approved-user admin stat, and admin notification fan-out
-- all gate on 'approved'. Nothing couples a dataset's behavior to its owner's
-- status, so the folded datasets (status='active', owner=-1) are unaffected.
INSERT OR IGNORE INTO users (id, username, email, status, email_verified, signup_source)
VALUES (-1, 'nemar-system', 'system@nemar.org', 'revoked', 1, 'cli');
