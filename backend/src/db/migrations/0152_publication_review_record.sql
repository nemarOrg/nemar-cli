-- The publication review's reproducibility record, and the run error `inputs_unavailable`
-- (ADR 0139, decisions 6 and 9; epic #2182, card B4).
--
-- Every review now stores what a depositor or an administrator needs to see what it was given and
-- to compare it with another review:
--
--   * `scanner_id`: the identifier screen's scanner that read the reviewed commit
--     (`identifier-scan@<revision>`), copied by the Worker from its own stored screen report.
--   * `reader_versions`: the version of each format reader that scanner had, as a JSON object of
--     reader id to version, from a version-2 screen report; NULL for a version-1 report.
--   * `resolver_version`: the license-lineage resolver's version (`license-lineage/<n>`).
--   * `models`: the model calls of the review, a JSON array of `{ "model", "effort" }`.
--   * `prompt_version`: the review prompt's version (`publication-review-prompt/<n>`).
--   * `input_digest`: the SHA-256, in hex, of the exact input the job sent, with the run's fence
--     nonce replaced by a fixed one, so two reviews over the same inputs have the same digest.
--   * `enrichment_source`: which enrichment the review read: the copy of `.nemar/metadata.json`
--     that D1 held at review time, named by the instant D1 stored it (or a commit); NULL for none.
--
-- `head_sha` already records the commit. The seven columns are set only on a reported row, and a
-- reported row written by a job from before this record (a version-1 report) leaves them NULL.
--
-- `detail` gains `inputs_unavailable`: the job could not read the review's widened inputs from
-- the Worker and reviewed nothing.
--
-- `inputs_served_at` is when the Worker answered the job's inputs call with the inputs. It is set
-- once, and only on a claimed row still waiting. A job that posts `inputs_unavailable` after it
-- was served them may have called the model, so that word is then stored as `workflow_failed`,
-- which counts against the caps, as a claimed `stale_head` is.
--
-- SQLite cannot change a CHECK in place, so the table is rebuilt with every row, column and index
-- it had; nothing references it (migration 0098 declares no foreign key either way), and no
-- trigger or view reads it.

CREATE TABLE publication_reviews_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  dataset_id TEXT NOT NULL,
  head_sha TEXT NOT NULL CHECK (length(head_sha) = 40),
  anonymous INTEGER NOT NULL CHECK (anonymous IN (0, 1)),
  requested_by INTEGER NOT NULL,
  started_by INTEGER,
  state TEXT NOT NULL
    CHECK (state IN ('dispatched', 'reported', 'declined', 'errored', 'unreported')),
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('pass', 'fail', 'action_required')),
  detail TEXT CHECK (detail IS NULL OR detail IN (
    'depositor_limit', 'platform_limit',
    'evidence_unavailable', 'stale_head', 'auth_failed', 'model_unavailable', 'model_refused',
    'model_truncated', 'model_invalid', 'report_invalid', 'dispatch_failed',
    'dispatch_unconfigured', 'review_disabled', 'workflow_failed', 'inputs_unavailable'
  )),
  report TEXT,
  nonce TEXT,
  claimed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  override_by INTEGER,
  override_at TEXT,
  override_reasons TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  scanner_id TEXT,
  reader_versions TEXT,
  resolver_version TEXT,
  models TEXT,
  prompt_version TEXT,
  input_digest TEXT CHECK (input_digest IS NULL OR length(input_digest) = 64),
  enrichment_source TEXT,
  inputs_served_at TEXT,
  UNIQUE (request_id, head_sha, anonymous),
  -- A verdict, and a stored report, exist exactly when the review reported.
  CHECK ((state = 'reported') = (verdict IS NOT NULL)),
  CHECK ((state = 'reported') = (report IS NOT NULL)),
  -- A closed word exists exactly when the row was declined or errored, and it is a word of that kind.
  CHECK ((state IN ('declined', 'errored')) = (detail IS NOT NULL)),
  CHECK (state <> 'declined' OR detail IN ('depositor_limit', 'platform_limit')),
  CHECK (state <> 'errored' OR detail NOT IN ('depositor_limit', 'platform_limit')),
  -- A nonce exists exactly while the review may still be answered.
  CHECK (state IN ('dispatched', 'unreported') OR nonce IS NULL),
  CHECK (state <> 'dispatched' OR nonce IS NOT NULL),
  -- Decided exactly when it left 'dispatched'.
  CHECK ((state = 'dispatched') = (decided_at IS NULL)),
  -- An override is recorded whole or not at all.
  CHECK ((override_by IS NULL) = (override_at IS NULL)),
  CHECK ((override_by IS NULL) = (override_reasons IS NULL)),
  -- The record is a reported review's alone.
  CHECK (state = 'reported' OR (scanner_id IS NULL AND reader_versions IS NULL
    AND resolver_version IS NULL AND models IS NULL AND prompt_version IS NULL
    AND input_digest IS NULL AND enrichment_source IS NULL)),
  -- The job's part of the record is written whole or not at all.
  CHECK ((models IS NULL) = (prompt_version IS NULL)),
  CHECK ((models IS NULL) = (input_digest IS NULL))
);

INSERT INTO publication_reviews_new (
  id, request_id, dataset_id, head_sha, anonymous, requested_by, started_by, state, verdict,
  detail, report, nonce, claimed_at, attempts, override_by, override_at, override_reasons,
  created_at, decided_at
)
SELECT
  id, request_id, dataset_id, head_sha, anonymous, requested_by, started_by, state, verdict,
  detail, report, nonce, claimed_at, attempts, override_by, override_at, override_reasons,
  created_at, decided_at
FROM publication_reviews;

DROP TABLE publication_reviews;
ALTER TABLE publication_reviews_new RENAME TO publication_reviews;

CREATE INDEX idx_publication_reviews_depositor ON publication_reviews (requested_by, created_at);
CREATE INDEX idx_publication_reviews_state ON publication_reviews (state, created_at);
