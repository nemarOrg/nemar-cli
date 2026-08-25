-- Dataset-level recording statistics, aggregated from the Zarr conversion
-- index (epic #1144 Phase 2, issue #1146). generate_zarr.py's index.json
-- already carries duration_s and n_channels per channel group; nothing
-- aggregated them to the dataset level before this. Column names mirror
-- neuroschema's dataSummary vocabulary (v0.4.0) so serving them at
-- data-router.ts is a rename-free mapping.
--
-- index.stores lists only recordings that CONVERTED; recordings that failed
-- conversion live in a sibling `failures` array and appear in neither. ADR
-- 0027 makes zarr discovery raw-only, so stores + failures is the complete
-- raw-recording set -- recording_count is therefore store_count +
-- failure_count, never stores.length alone (that would silently undercount
-- by exactly the failure count). See services/s3.ts's aggregateRecordingStats
-- for the full rationale.
--
--   total_recording_duration   sum of per-STORE duration across the dataset,
--                              in seconds. A store's duration is the MAX
--                              across its channel groups -- concurrent
--                              streams of one recording -- never their sum.
--                              NULL when recordings_measured is 0: a zero
--                              would read as "zero-length dataset" rather
--                              than "not measured" (ADR 0005).
--   recording_duration_min     Per-store duration range, in seconds. NULL
--   recording_duration_max     when recordings_measured is 0.
--   recording_count            store_count + failure_count: every raw
--                              recording discovery found, converted or not.
--   recordings_unavailable     failure_count -- recordings that could not be
--                              summarised (truncated, corrupt, unsupported).
--   recordings_measured        Stores that yielded a duration. A store whose
--                              groups all lack duration_s (or has no groups)
--                              is unmeasured, not zero-length, and is
--                              excluded from this count. NULL until the
--                              sweep first runs a dataset.
--   channel_count_min          Channel-count range across stores. A group
--   channel_count_max          contributes here even when it has no
--                              duration (rate/channel-count can be known
--                              before a full read is measured), so this
--                              range can be populated while duration is
--                              still NULL.
--   recording_stats_at         Bookkeeping stamp; NULL means needs
--                              (re)computing. Nulled by the zarr-ready
--                              callback's 'ready' branch only, so a
--                              reconverted dataset is re-picked by the next
--                              sweep; the 'failed' branch leaves it (and
--                              every other stat column) untouched -- a bad
--                              rebuild must never erase good numbers.
--
-- Deliberately absent: sampling_frequency_min/max. The zarr index's `rate`
-- field is generate_zarr.py's per-modality serving cap (MODALITY_RATES),
-- not the recording's true acquisition rate -- publishing it as
-- data_summary.sampling_frequency_range would mislabel every dataset
-- acquired above the cap. The real rate lives in the BIDS sidecar
-- (`SamplingFrequency` in *_eeg.json), a different pipeline, out of scope
-- for this phase.
ALTER TABLE datasets ADD COLUMN total_recording_duration REAL;
ALTER TABLE datasets ADD COLUMN recording_duration_min REAL;
ALTER TABLE datasets ADD COLUMN recording_duration_max REAL;
ALTER TABLE datasets ADD COLUMN recording_count INTEGER;
ALTER TABLE datasets ADD COLUMN recordings_unavailable INTEGER;
ALTER TABLE datasets ADD COLUMN recordings_measured INTEGER;
ALTER TABLE datasets ADD COLUMN channel_count_min INTEGER;
ALTER TABLE datasets ADD COLUMN channel_count_max INTEGER;
ALTER TABLE datasets ADD COLUMN recording_stats_at TEXT;
