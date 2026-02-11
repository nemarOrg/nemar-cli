-- EZID DOI provider support and ORCID on users
-- Phase 2 of EZID integration (issue #107)

-- Add ORCID to users (optional; researchers may not have one)
ALTER TABLE users ADD COLUMN orcid TEXT;

-- Add EZID columns to datasets
ALTER TABLE datasets ADD COLUMN ezid_identifier TEXT;
ALTER TABLE datasets ADD COLUMN ezid_status TEXT;
ALTER TABLE datasets ADD COLUMN doi_provider TEXT NOT NULL DEFAULT 'ezid';

-- Existing datasets with Zenodo concept IDs should use zenodo provider
UPDATE datasets SET doi_provider = 'zenodo' WHERE zenodo_concept_id IS NOT NULL;

-- Index for EZID identifier lookups
CREATE INDEX idx_datasets_ezid ON datasets(ezid_identifier);
