-- An administrator's re-review of a reported publication review (ADR 0102, amendment of 2026-11-27).
--
-- Until now a `reported` review was final: an administrator's start answered `has_result`, and a
-- request had exactly one first run per (request, commit, release kind). The owner compares review
-- models and efforts on the same queue requests at the same commits, so an administrator may now
-- start the review again. The earlier review is kept as history and a new first run of the same
-- commit and release kind becomes the review in force.
--
-- `publication_reviews` gains two columns:
--
--   * `superseded_at`: when an administrator's re-review took this review's place, or NULL for a
--     review that has not been replaced. A superseded row is history only: it is never the review
--     in force, never claimed, restarted or stored to again, and the approval gate never reads it.
--     It still counts in the platform's allowance and in the automatic denial's daily cap, because
--     its model call was real.
--   * `superseded_by`: the id of the row that replaced it, a plain INTEGER and not a foreign key,
--     for the reason migration 0098 declares none. It is set in the same batch as `superseded_at`,
--     and only with it: the column's CHECK keeps the two together, so a replacement is never named
--     for a row that was not replaced.
--
-- The partial unique index that allows one first run per (request, commit, release kind) now covers
-- unsuperseded first runs only; that is what lets the replacement be inserted beside the row it
-- replaces, and it still allows exactly one review in force. SQLite cannot change an index in
-- place, so it is dropped and created again; every row already on record is unsuperseded, so the
-- new index holds exactly the rows the old one did.
ALTER TABLE publication_reviews ADD COLUMN superseded_at TEXT;
ALTER TABLE publication_reviews ADD COLUMN superseded_by INTEGER
  CHECK (superseded_by IS NULL OR superseded_at IS NOT NULL);

DROP INDEX idx_publication_reviews_key;
CREATE UNIQUE INDEX idx_publication_reviews_key ON publication_reviews (request_id, head_sha, anonymous)
  WHERE confirm_of IS NULL AND superseded_at IS NULL;
