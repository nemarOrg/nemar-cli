-- The serving index a derivative's key names (ADR 0140, owner ruling of 2026-11-25, nemar-cli #2341),
-- and the quality plugins of its recipe version (review of #2383).
--
-- WHAT THIS IS FOR. A run of nemar-ica on the archive (`bids`) input can be handed the serving copy's
-- index (`--serving-index`), and the index changes its product: the views of the serving copy are declared
-- or skipped, and the record names the index. So that recipe's key on that input is a version 2 key
-- (`nemar.derivative-key.v2`), whose ninth line is `serving_index`: `none` when the run was given no index,
-- or `sha256:` and the SHA-256 of the index file's bytes. The column keeps that field, so the description
-- (`derivative.json`) writes the key's own text again from the row, and an administrator sees which index
-- a derivative was made with.
--
-- NULL is a version 1 key: every row of every other recipe, and every row made before this column existed.
-- No nemar-ica row exists before it: the registry holds nemar-ica as a placeholder, which no path
-- dispatches, so no nemar-ica stamp has succeeded and none has been keyed. A version 1 key stays valid and
-- keeps its bytes.
--
-- The field goes with the archive input only (the key's own pairing). Every CHECK is named and every GLOB is
-- at most 50 characters (D1 refuses longer), as 0117 requires.

ALTER TABLE compute_derivatives ADD COLUMN serving_index TEXT
  CONSTRAINT compute_derivatives_serving_index CHECK (
    serving_index IS NULL
    OR (input = 'bids' AND (serving_index = 'none'
      OR (length(serving_index) = 71 AND substr(serving_index, 1, 7) = 'sha256:'
        AND substr(serving_index, 8) NOT GLOB '*[^0-9a-f]*'))));

-- The plugins the derivative's recipe version runs at its `quality` checkpoint, recorded when the row is
-- made (a JSON array of plugin names, in the registry's order; `[]` for a recipe with none). The quality
-- route checks each plugin view's source against THIS list, so a derivative made by a recipe version the
-- registry has since moved past is still checked against its own version's plugins and still served.
-- NULL is a row made before this column existed, or one whose recipe version the registry did not hold
-- when it was keyed: the route serves no view of it, since nothing says which plugins were the recipe's.
ALTER TABLE compute_derivatives ADD COLUMN quality_plugins TEXT
  CONSTRAINT compute_derivatives_quality_plugins CHECK (
    quality_plugins IS NULL
    OR (json_valid(quality_plugins) AND json_type(quality_plugins) = 'array'));

-- BACKFILL. A `nemar-floor` row runs no quality plugin at any version (its `quality` checkpoint is the
-- recipe's own `qc` step), so its list is `[]` whatever version made it, and its rows stay servable.
-- Every other recipe's earlier rows stay NULL: their plugins depend on the version, and a version the
-- registry no longer holds cannot be read back here, so a guess could admit a plugin's view the run never
-- ran. No nemar-ica row exists (nemar-ica is a placeholder no path dispatches), so none is left out today.
UPDATE compute_derivatives SET quality_plugins = '[]'
  WHERE recipe = 'nemar-floor' AND quality_plugins IS NULL;
