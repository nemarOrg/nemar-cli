-- What the Worker served a publication review's job, kept for the administrator's decision card
-- (ADR 0142, decision 4; epic #2449, phase 4).
--
-- The card leads with the dataset's own words as the review read them: the main fields of the
-- enrichment (D1's copy of `.nemar/metadata.json`), `dataset_description.json`'s Name, License and
-- Authors at the reviewed commit, and the lineage the review was served with what its sources'
-- registries declare. The enrichment the review reads is the copy current when the inputs are
-- served, and it changes afterwards, so the card cannot read it back later: the serve keeps it.
--
--   * `served_metadata`: the snapshot as JSON (`servedMetadataJson` in
--     `backend/src/services/decision-card.ts`), written in the statement that stamps the serve
--     (`inputs_served_at`), and rewritten by every later serve of the same row, because the latest
--     serve is the one the job read (as `lineage_basis`). NULL on every row from before this
--     migration and on a row whose inputs were never served: the card then shows the fields NEMAR
--     holds now and says they are not as reviewed. The CHECK keeps it a served row's alone, valid
--     JSON, and at most 65,536 characters; the writer leaves it NULL rather than exceed that, and
--     the reader parses it strictly every time, so a value edited by hand reads as no snapshot.
ALTER TABLE publication_reviews ADD COLUMN served_metadata TEXT
  CHECK (served_metadata IS NULL OR (
    inputs_served_at IS NOT NULL
    AND json_valid(served_metadata)
    AND length(served_metadata) <= 65536
  ));
