-- Index datasets.source_id (#808).
--
-- The exact-id search tier (lookupDatasetById) and GET /datasets/resolve/:id
-- match `source_id` (the OpenNeuro ds###### behind an on###### mirror) so a user
-- can search/resolve by the upstream id. `dataset_id` is uniquely indexed
-- (0001) but `source_id` was never indexed, so the `WHERE dataset_id = ? OR
-- source_id = ?` lookup table-scans -- fine at ~700 rows, but the exact-id tier
-- is meant to be sub-millisecond/deterministic. Additive index only; also
-- speeds the /resolve endpoint and the auto-import source_id dedup.
CREATE INDEX IF NOT EXISTS idx_datasets_source_id ON datasets(source_id);
