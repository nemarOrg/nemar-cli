-- NEMAR Database Schema
-- Migration: 0002_zenodo
-- Description: Add Zenodo deposition ID columns for DOI management

-- Add Zenodo deposition IDs to track the Zenodo records
ALTER TABLE datasets ADD COLUMN zenodo_concept_id TEXT;
ALTER TABLE datasets ADD COLUMN zenodo_latest_version_id TEXT;

-- Index for lookups by Zenodo ID
CREATE INDEX IF NOT EXISTS idx_datasets_zenodo_concept ON datasets(zenodo_concept_id);
