-- The input a pipeline run read, and what the run said it read (portable compute, card Q0b; ADR 0121;
-- plan D12 and D14). One recipe, `nemar-floor`, reads two inputs: `bids` (the dataset's files, on Tapis) and
-- `zarr` (the dataset's Zarr serving copy, on a runner). Until now the Zarr input was its own recipe name,
-- `nemar-floor-zarr`, a transition name; this migration folds it into `nemar-floor` with the input as part of
-- the stamp's CLAIMED tuple, and gives a succeeded stamp the fields a derivative will be keyed from.
--
-- THE TUPLE GROWS BY `input`. A stamp is one run of a recipe, at a version, on an engine, over one version of
-- one dataset, reading one input. `compute_pipeline_stamps_live` (one `dispatched` or `succeeded` stamp per
-- tuple) and `compute_pipeline_stamps_attempt` (one attempt number per tuple) are recreated with `input` after
-- `engine`, so a `bids` run and a `zarr` run of one dataset version coexist and two racing claims of one tuple
-- and input still give one stamp. `input` is `bids` for every stamp that existed: before this migration the
-- only recipe that read anything else was `nemar-floor-zarr`.
--
-- WHAT A SUCCESS RECORDS. A stamp the Worker ends `succeeded` already has its `recipe_version` and `engine`
-- rewritten from the recipe's own record. It now also takes, from the same record and only in the shape of its
-- column (a value that does not fit is left NULL, never stored): `reader` (the reader that decoded the Zarr
-- stores, `eegprep-lean@<version>+<commit>`), `input_engine` (the Zarr engine version the serving index names)
-- and `input_digest` (`sha256:` and 64 hexadecimal digits of what a Zarr run read, or `git:` and the 40
-- hexadecimal digits of the commit a BIDS run read). All three are NULL on a stamp that has not succeeded and
-- on one whose record did not state them.
--
-- THE ORDER MATTERS. The two unique indexes are dropped BEFORE the rename, because a `nemar-floor-zarr` stamp
-- and a `nemar-floor` stamp of the same dataset version, recipe version and engine are two tuples now (two
-- inputs) and the old five-column indexes would refuse the rename; they are recreated after it, with `input`.
--
-- Every CHECK is named, every term is TRUE or FALSE and never NULL (as 0117 requires), and every GLOB is at
-- most 50 characters (D1 refuses longer). No foreign key; nothing here names a person, a path or a host.

ALTER TABLE compute_pipeline_stamps ADD COLUMN input TEXT NOT NULL DEFAULT 'bids'
  CONSTRAINT compute_pipeline_stamps_input CHECK (input IN ('bids', 'zarr'));

ALTER TABLE compute_pipeline_stamps ADD COLUMN reader TEXT
  CONSTRAINT compute_pipeline_stamps_reader CHECK (
    reader IS NULL OR (length(reader) BETWEEN 1 AND 128 AND reader NOT GLOB '*[^0-9A-Za-z._+@-]*'));

ALTER TABLE compute_pipeline_stamps ADD COLUMN input_engine TEXT
  CONSTRAINT compute_pipeline_stamps_input_engine CHECK (
    input_engine IS NULL OR (length(input_engine) BETWEEN 1 AND 128
      AND input_engine NOT GLOB '*[^0-9A-Za-z._+@-]*'));

ALTER TABLE compute_pipeline_stamps ADD COLUMN input_digest TEXT
  CONSTRAINT compute_pipeline_stamps_input_digest CHECK (
    input_digest IS NULL
    OR (length(input_digest) = 71 AND substr(input_digest, 1, 7) = 'sha256:'
      AND substr(input_digest, 8) NOT GLOB '*[^0-9a-f]*')
    OR (length(input_digest) = 44 AND substr(input_digest, 1, 4) = 'git:'
      AND substr(input_digest, 5) NOT GLOB '*[^0-9a-f]*'));

DROP INDEX compute_pipeline_stamps_live;

DROP INDEX compute_pipeline_stamps_attempt;

-- The transition name becomes the one recipe with its input: the stamps of `nemar-floor-zarr` are the
-- `nemar-floor` stamps that read `zarr`.
UPDATE compute_pipeline_stamps SET recipe = 'nemar-floor', input = 'zarr'
 WHERE recipe = 'nemar-floor-zarr';

-- THE RULE: one live or succeeded stamp per tuple and input. A query that relies on it states the same predicate.
CREATE UNIQUE INDEX compute_pipeline_stamps_live
  ON compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, input)
  WHERE state IN ('dispatched', 'succeeded');

-- Attempt numbers of one tuple and input are distinct, whatever became of the attempts before.
CREATE UNIQUE INDEX compute_pipeline_stamps_attempt
  ON compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, input, attempt);
