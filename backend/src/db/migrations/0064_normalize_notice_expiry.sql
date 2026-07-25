-- Issue #1024: normalize notices.expires_at so expiry comparisons work.
--
-- `getActiveNotices` filters with `expires_at > datetime('now')`. Both sides
-- are TEXT, so SQLite compares them byte-wise under BINARY collation.
-- `datetime('now')` emits `YYYY-MM-DD HH:MM:SS` (space separator), while
-- `expires_at` was stored as RFC3339 with a `T` (the admin create route
-- validates with `z.string().datetime({ offset: true })` and bound the value
-- through unchanged). `T` is 0x54, space is 0x20, so whenever the date halves
-- matched, the ISO value always compared greater and the notice was treated
-- as unexpired:
--
--   sqlite> SELECT '2026-07-25T00:00:00.000Z' > '2026-07-25 09:00:00';  -- 1
--
-- i.e. a notice that expired at midnight was still served as active at 09:00,
-- and only lapsed once the date rolled over. Expiries on an earlier date
-- worked correctly, which is why this survived: it looks right most of the
-- time and fails exactly on the same-day window ("maintenance ends at 14:00")
-- that same-day expiries exist for.
--
-- Normalizing on write (here for existing rows, and via `datetime(?)` in
-- services/notices.ts for new ones) is the sturdier of the two fixes: it also
-- makes idx_notices_expires comparisons well-defined, rather than leaving the
-- index sorted in a format the query doesn't compare against. `datetime()`
-- converts any offset to UTC and is idempotent on values already in SQLite
-- format, so re-running this is safe.
--
-- The `datetime(expires_at) IS NOT NULL` guard matters: `datetime()` returns
-- NULL for an unparseable string, and NULL in this column means "never
-- expires". Without the guard a malformed timestamp would be silently
-- promoted from "expired" to "permanent", which is the worst possible
-- direction for a banner. Such a row is left untouched for a human to see.
--
-- Cloudflare D1 forbids explicit BEGIN/COMMIT (error 7500); the runtime wraps
-- each migration in a transaction already.

UPDATE notices
   SET expires_at = datetime(expires_at)
 WHERE expires_at IS NOT NULL
   AND datetime(expires_at) IS NOT NULL;
