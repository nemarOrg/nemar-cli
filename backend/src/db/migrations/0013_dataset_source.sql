-- Migration: 0013_dataset_source
-- Description: Add source tracking for imported datasets (e.g., OpenNeuro)

ALTER TABLE datasets ADD COLUMN source TEXT;
ALTER TABLE datasets ADD COLUMN source_id TEXT;
