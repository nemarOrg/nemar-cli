-- What a public page shows of NEMAR's pipeline is the PROMOTED run (ADR 0134 decision 9 as amended
-- 2026-11-26, epic #2324 phase B4): a recipe's current public derivative (ADR 0137 decision 7), at the
-- dataset level and at the record level alike.
--
-- WHAT THIS IS FOR. Until now `/<id>/metadata.json` served the dataset-level `processing` entry and
-- `signalJourney` link of each recipe's LATEST ENDED run (`compute_pipeline_documents`, 0156), with an
-- `in_progress` link while a run reported, while its `dataQuality` came from the promoted run. Both levels
-- now describe the promoted run, built when they are read:
--  - the dataset `processing` entry from that run's reconciled counts (`compute_pipeline_progress`, which
--    is kept per stamp) and the order it declared (`compute_pipeline_progress_runs.declared`);
--  - the dataset `signalJourney` link from `compute_pipeline_progress_runs.link`, below;
--  - a recording's `processing` and `signalJourney` entries from the derivative's own recordings table and
--    record in the derivative store, under the checkpoint map below.
-- A canary run, a failed run and a run in progress show nothing on a public page; administrators keep the
-- grid. Nothing reads `compute_pipeline_documents` any more, so it is dropped.

-- The completed signalJourney link of a run's dataset record (a JSON object: recipe version, status,
-- location, SHA-256 of the record's bytes, signalJourney version), written when the run is reconciled
-- from the record it read then. NULL for a failed run, a run whose record made no link, and a run of a
-- recipe the registry does not know. The public read shows it only for the promoted run.
ALTER TABLE compute_pipeline_progress_runs ADD COLUMN link TEXT
  CONSTRAINT compute_pipeline_progress_runs_link CHECK (
    link IS NULL
    OR (length(link) BETWEEN 2 AND 2048 AND json_valid(link) AND json_type(link) = 'object'));

-- BACKFILL. A run reconciled before this column has its completed link only in the dataset's last
-- document, and only when it was the newest run of its recipe; an older run's link was replaced there and
-- cannot be recovered, so it stays NULL and its dataset shows no link until a newer run is promoted.
-- A `failed` link is not copied: a failed run is never shown.
UPDATE compute_pipeline_progress_runs SET link = (
    SELECT d.entry FROM compute_pipeline_documents d
     WHERE d.stamp_id = compute_pipeline_progress_runs.stamp_id AND d.namespace = 'signalJourney'
       AND json_valid(d.entry) AND json_extract(d.entry, '$.processing_status') = 'completed'
       AND length(d.entry) <= 2048)
  WHERE link IS NULL;

DROP TABLE compute_pipeline_documents;

-- The checkpoint map of a derivative's recipe version (a JSON array of `{checkpoint, steps}` in the
-- registry's order, without `stored`), recorded when the row is made, as `quality_plugins` is (0159): a
-- recording's outcomes are read through it, so a derivative made by a recipe version the registry has
-- since moved past is still read with its own version's map. NULL is a row made before this column, or one
-- whose recipe version the registry did not hold when it was keyed: the record-level read then uses the
-- registry's map only while the registry holds that very version, and otherwise shows no outcome.
ALTER TABLE compute_derivatives ADD COLUMN checkpoint_map TEXT
  CONSTRAINT compute_derivatives_checkpoint_map CHECK (
    checkpoint_map IS NULL
    OR (length(checkpoint_map) BETWEEN 2 AND 8192 AND json_valid(checkpoint_map)
      AND json_type(checkpoint_map) = 'array'));
