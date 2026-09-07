-- Explicit account kinds: person, service, test (epic #1272 phase 4, #1284;
-- ADR 0048).
--
-- WHAT THIS CLOSES. ADR 0045's `orcid_verified` gap exempted `admin`/`owner`
-- by role, documented there as interim: a role is a permission level, not a
-- fact about who or what an account is. Three operational accounts hold no
-- ORCID and never will (`nemarOwner`, `nemarAdmin`, `test-admin`), and a
-- person can legitimately hold a second, non-person account -- Yahya's
-- `cool-vibers` persona plus the seeded `test-*` fixtures. This column makes
-- that fact explicit instead of standing in for it with a role check.
--
-- THREE KINDS, ONE DEFAULT. `person` (the default -- every existing row and
-- every future signup is a person unless an owner says otherwise), `service`
-- (an operational account: no human signs in as it directly, keys are
-- owner-minted), `test` (a human's secondary persona: signs in and uploads
-- like a person, but a real DOI never attaches to it -- see
-- `realDatasetCreateGate` in backend/src/services/upload-gate.ts).
--
-- SQLite accepts a CHECK constraint on an `ADD COLUMN`, and the default
-- ('person') satisfies it, so this ALTER is rewrite-free -- verified with
-- `bun run migrations:d1-check`, same as every column-adding migration here
-- (0037, 0062, 0077, 0079).
--
-- THE DATA HALF IS KEYED BY USERNAME, NEVER BY ID. The production ids named
-- in the issue exist only in live D1; usernames are unique and stable across
-- environments (the same reasoning migration 0077's header gives for not
-- keying its flagging pass on anything but the columns it compares). Each
-- UPDATE is idempotent (`AND account_kind = 'person'` -- a row already moved
-- off the default is left alone on a re-run) and touches only the named
-- usernames; `deleted_at IS NULL` keeps a tombstoned row's kind at the
-- default it was masked with.
--
-- `test-web` is deliberately NOT in the `test` list: it is the shared
-- web-QA account (#1008) that has to reach the ORCID authorize page and the
-- Settings key form the way a real person would, so it stays `person`.
-- `test-owner` becomes `service` alongside the other operational fixtures --
-- its role is `owner` for exercising owner-only routes in tests, which is
-- orthogonal to its kind.
--
-- NO INDEX. Nothing queries this column by range or joins on it; the CHECK
-- constraint is the only enforcement it needs.

ALTER TABLE users ADD COLUMN account_kind TEXT NOT NULL DEFAULT 'person'
  CHECK (account_kind IN ('person', 'service', 'test'));

UPDATE users
   SET account_kind = 'service',
       updated_at = datetime('now')
 WHERE username COLLATE NOCASE IN ('nemarOwner', 'nemarAdmin', 'test-admin', 'test-owner')
   AND account_kind = 'person'
   AND deleted_at IS NULL;

UPDATE users
   SET account_kind = 'test',
       updated_at = datetime('now')
 WHERE username COLLATE NOCASE IN
       ('cool-vibers', 'test-user', 'test-pending', 'test-verified', 'test-revoked')
   AND account_kind = 'person'
   AND deleted_at IS NULL;
