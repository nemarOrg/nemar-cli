-- The serving index a derivative's key names (ADR 0138, owner ruling of 2026-11-25, nemar-cli #2341).
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
