-- NEMAR Database Schema
-- Migration: 0006_dataset_visibility
-- Description: Add visibility column to control dataset access (private/public)

-- Add visibility column to datasets table
-- Default to 'private' for existing datasets (safe default; admins can change later)
ALTER TABLE datasets ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
  CHECK (visibility IN ('private', 'public'));

-- Index for filtering by visibility
CREATE INDEX IF NOT EXISTS idx_datasets_visibility ON datasets(visibility);

-- Update the status CHECK constraint comment:
-- - status: lifecycle state (active, archived, deleted)
-- - visibility: access control (private, public)
-- These are independent: a dataset can be active+private, active+public, archived+public, etc.
