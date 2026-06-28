-- Epic #854 phase 1 (#857): first-class channel-count + electrode-system
-- columns on the datasets table. These let D1 answer "high-density EEG
-- datasets" / "EGI geodesic caps" queries and back the website's channel +
-- montage filter (FilterSidebar) without parsing per-recording BIDS sidecars.
--
-- Population happens in phase 2 (#858) via computeDatasetMetadataColumns ->
-- writeDatasetMetadataColumns in dataset-metadata-columns.ts, and the phase 3
-- (#859) backfill. Until then these stay NULL, which the projection exposes
-- and the website treats as "not populated yet".
--
-- n_channels: representative EEG channel count for the dataset. Prefer the
--   *_eeg.json EEGChannelCount sidecar, cross-checked against an exemplar
--   *_channels.tsv (real channels.tsv can carry channels the sidecar omits).
-- electrode_system: best-effort montage class -- one of
--   '10-20' | '10-10' | '10-05' | 'biosemi' | 'egi-geodesic' | 'other'.

ALTER TABLE datasets ADD COLUMN n_channels INTEGER;
ALTER TABLE datasets ADD COLUMN electrode_system TEXT;

CREATE INDEX IF NOT EXISTS idx_datasets_n_channels ON datasets(n_channels);
CREATE INDEX IF NOT EXISTS idx_datasets_electrode_system ON datasets(electrode_system);
