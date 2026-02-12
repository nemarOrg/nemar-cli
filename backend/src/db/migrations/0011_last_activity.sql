-- Migration: 0011_last_activity
-- Add last_activity_at column for staleness detection in scheduled cleanup

ALTER TABLE datasets ADD COLUMN last_activity_at TEXT DEFAULT (datetime('now'));

-- Backfill existing rows so the cron does not treat them as stale
UPDATE datasets SET last_activity_at = datetime('now') WHERE last_activity_at IS NULL;
