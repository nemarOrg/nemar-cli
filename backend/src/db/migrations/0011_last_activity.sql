-- Migration: 0011_last_activity
-- Add last_activity_at column for staleness detection in scheduled cleanup

ALTER TABLE datasets ADD COLUMN last_activity_at TEXT DEFAULT (datetime('now'));
