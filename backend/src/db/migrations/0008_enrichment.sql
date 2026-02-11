-- Add enrichment cache columns to datasets table
-- Stores the nemar_metadata.json content for fast access without GitHub API calls
ALTER TABLE datasets ADD COLUMN enrichment_json TEXT;
ALTER TABLE datasets ADD COLUMN enrichment_updated_at TEXT;
