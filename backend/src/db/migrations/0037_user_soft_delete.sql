-- Soft-delete (tombstone) for users (epic #695, observability dashboard remove
-- action).
--
-- Admins (owner-only) remove test/abandoned accounts from the dashboard. A hard
-- DELETE is the wrong tool here: it would let a future signup reuse the freed id
-- (though AUTOINCREMENT mostly prevents this), and it erases the row that audit
-- and foreign-key references point at. Instead we tombstone: keep the row, stamp
-- `deleted_at`, mask the PII columns (email/username/github/etc.), and revoke
-- tokens. The id is preserved forever and is never reused.
--
-- `deleted_at` is the single source of truth for "this account is gone": every
-- auth chokepoint and every admin list/count adds `deleted_at IS NULL` so a
-- tombstoned user can't log in, verify, retrieve a key, appear in listings, or
-- block a fresh signup with the same (now-masked) email. We deliberately do NOT
-- add a 'deleted' value to the status CHECK constraint (that needs a full table
-- rebuild in SQLite); the delete endpoint sets status='revoked' AND stamps
-- `deleted_at`, and the `deleted_at` predicate is what the code keys on.
--
-- Retention/PII: the tombstone erases PII (masks email, nulls username/github/
-- password/orcid/etc., zeroes email_verified). The audit_log 'user_deleted' row
-- keeps only the non-PII integer user id as resource_id (no original
-- username/email in its details), so deletion leaves no recoverable identity.
--
-- NULLable, no default: an account is live until it is tombstoned.
ALTER TABLE users ADD COLUMN deleted_at TEXT;

-- Partial-ish index for the "exclude tombstones" predicate that now rides on
-- every user listing/count and the auth lookups.
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at);
