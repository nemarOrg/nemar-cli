-- NEMAR Database Schema
-- Migration: 0004_sandbox
-- Description: Add sandbox training fields to users table and sandbox ID sequence

-- Add sandbox training fields to users table
ALTER TABLE users ADD COLUMN sandbox_completed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN sandbox_completed_at TEXT;
ALTER TABLE users ADD COLUMN sandbox_dataset_id TEXT;

-- Add sandbox prefix to ID sequence (xx000xxx pattern)
INSERT OR IGNORE INTO id_sequence (prefix, next_number) VALUES ('xx', 1);

-- Add sandbox flag to datasets table to distinguish sandbox datasets
ALTER TABLE datasets ADD COLUMN is_sandbox INTEGER NOT NULL DEFAULT 0;

-- Index for querying sandbox datasets
CREATE INDEX IF NOT EXISTS idx_datasets_sandbox ON datasets(is_sandbox);
