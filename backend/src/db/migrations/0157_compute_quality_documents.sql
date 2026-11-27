-- The dataset quality summaries of NEMAR's pipeline runs (ADR 0137 decision 8, epic #2324 phase B1).
--
-- WHAT THIS IS FOR. A recipe writes, beside its dataset record, one neuroschema 0.6.0 `dataQuality`
-- document at `level: dataset` (`product/desc-<label>_dataquality.json`, at most 65,536 bytes): the run's
-- counts, the distribution of each metric over the recordings that passed, and the recordings it did not
-- process. When the run is reconciled the backend checks it (services/quality-documents.ts: the schema,
-- the writer's rules, the stamp's identity, the dataset record's digest, the recordings table's counts and
-- the metric names) and keeps the recipe's entry here, one row per stamp. `/<id>/metadata.json` and the page
-- bundle serve the entry of each recipe's CURRENT PUBLIC derivative only (a stored `catalog` or `published`
-- row, the newest by `stored_at`), so a run shows on a page once an administrator promotes it, and a
-- `canary` run never does. A recording's quality is not kept here: it is projected from its record on
-- request (ADR 0137 decision 8), so D1 grows by one row per run, never per recording.
--
-- `stamp_id` is the run's stamp (`compute_pipeline_stamps.id`): a stamp has one summary. `dataset_id` and
-- `recipe` are the STAMP's, never the document's (which names no dataset). `entry` is the recipe's entry
-- as the document wrote it (`datasetRecipeSummary`), validated in code before it is written.
-- `record_sha256` is the digest of the dataset record the entry names, kept as its own column so a row can
-- be matched to its record without parsing the entry.
--
-- NO FOREIGN KEY. Deleting a dataset deletes its rows in the deletion's batch (services/deletion.ts). No
-- column names a person, holds a credential or a path outside a run's product.
--
-- Every CHECK is named, a numeric column is checked with `typeof(...) = 'integer'`, every term is TRUE or
-- FALSE and never NULL, and every GLOB is at most 50 characters (D1 refuses longer), as 0117 requires.

CREATE TABLE compute_quality_documents (
  stamp_id INTEGER PRIMARY KEY NOT NULL CONSTRAINT compute_quality_documents_stamp CHECK (
    typeof(stamp_id) = 'integer' AND stamp_id > 0),
  dataset_id TEXT NOT NULL CONSTRAINT compute_quality_documents_dataset CHECK (
    length(dataset_id) = 8 AND substr(dataset_id, 1, 2) NOT GLOB '*[^a-z]*'
    AND substr(dataset_id, 3) NOT GLOB '*[^0-9]*'),
  recipe TEXT NOT NULL CONSTRAINT compute_quality_documents_recipe CHECK (
    length(recipe) BETWEEN 1 AND 64 AND recipe NOT GLOB '*[^a-z0-9-]*'),
  entry TEXT NOT NULL CONSTRAINT compute_quality_documents_entry CHECK (
    length(entry) BETWEEN 2 AND 65536 AND substr(entry, 1, 1) = '{'),
  record_sha256 TEXT NOT NULL CONSTRAINT compute_quality_documents_record CHECK (
    length(record_sha256) = 64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  written_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A dataset's summaries by recipe, newest stamp last (the page read and deletion).
CREATE INDEX compute_quality_documents_dataset
  ON compute_quality_documents (dataset_id, recipe, stamp_id);
