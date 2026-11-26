-- The automatic denial of a publication request (ADR 0139, decisions 1 to 4; epic #2182, card B5).
--
-- `publication_reviews` gains three columns:
--
--   * `confirm_of`: the review this row confirms, or NULL for a review of the request itself (the
--     first run). A confirming run is dispatched only after a first run whose `fail` was eligible
--     for an automatic denial, on another model, over the same inputs. It is a plain INTEGER, not a
--     foreign key, for the reason migration 0098 declares none.
--   * `auto_deny_state`: what the automatic denial made of a first run, one closed word:
--       none          nothing (the default: not eligible, the mode is off, or still confirming);
--       would_deny    the confirming run agreed and the mode is `shadow`, so nothing was denied;
--       denied        the confirming run agreed, the mode is `on`, and the request was denied;
--       capped        the confirming run agreed, but the daily cap was reached, so a person decides;
--       not_eligible  the confirming run agreed, but the request had changed (a race was lost);
--       disagreed     the confirming run did not agree, so a person decides;
--       confirm_failed the confirming run did not report a result (an error, a refusal, a cut-off
--                     answer, a dispatch that failed or was declined, or the watchdog expired
--                     it), so nothing confirmed the fail and a person decides;
--       no_service_account the confirming run agreed and the mode is `on`, but the nemarAdmin
--                     service account is missing, so nothing was denied;
--       restored      the request was denied automatically and an administrator restored it; the
--                     same commit is never denied automatically again, and its place under the
--                     day's cap stays counted.
--     A confirming row always holds `none`: the word is the first run's.
--   * `denial_mail_state`: what became of the depositor's denial mail, for a `denied` first run:
--     `sent` (at least one recipient took it and none failed), `failed` (a provider refused or did
--     not answer a send), `fenced` (the dev Worker's DEV_EMAIL_ALLOWLIST held every recipient).
--     NULL when no denial mail was due. `denial_mail_attempts` counts the tries: the daily tick
--     retries a `failed` mail once. `denial_mail_listed_at` is when a digest that reached an
--     administrator listed the mail as not delivered, so each one is listed exactly once.
--   * `auto_deny_at`: when that word was written; NULL for `none`. The daily cap counts `denied`,
--     `would_deny` and `restored` by it, and the administrators' digest reads every word but `none` by it.
--
-- The table's UNIQUE (request_id, head_sha, anonymous) becomes a partial unique index over first
-- runs only, and a second partial index allows one confirming row per first run. SQLite cannot drop
-- a table constraint in place, so the table is rebuilt with every row, column and index it had;
-- nothing references it, and no trigger or view reads it.
--
-- `publication_requests` gains `auto_denied` (0 or 1): the request was denied by the automatic
-- denial. A dataset with two such requests is not denied automatically again (decision 1).
--
-- `publication_auto_deny_digests` holds one row per daily digest the administrators were sent, so
-- the digest is claimed once a day and the next one starts where the last one ended.

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
  confirm_of INTEGER,
  auto_deny_state TEXT NOT NULL DEFAULT 'none' CHECK (auto_deny_state IN (
    'none', 'would_deny', 'denied', 'capped', 'not_eligible', 'disagreed', 'confirm_failed',
    'no_service_account', 'restored'
  )),
  auto_deny_at TEXT,
  denial_mail_state TEXT CHECK (denial_mail_state IS NULL
    OR denial_mail_state IN ('sent', 'failed', 'fenced')),
  denial_mail_attempts INTEGER NOT NULL DEFAULT 0 CHECK (denial_mail_attempts >= 0),
  denial_mail_listed_at TEXT,
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
  CHECK ((models IS NULL) = (input_digest IS NULL)),
  -- The automatic denial's word is a first run's, and stamped exactly when it is not `none`.
  CHECK (confirm_of IS NULL OR auto_deny_state = 'none'),
  CHECK ((auto_deny_state = 'none') = (auto_deny_at IS NULL))
);

INSERT INTO publication_reviews_new (
  id, request_id, dataset_id, head_sha, anonymous, requested_by, started_by, state, verdict,
  detail, report, nonce, claimed_at, attempts, override_by, override_at, override_reasons,
  created_at, decided_at, scanner_id, reader_versions, resolver_version, models, prompt_version,
  input_digest, enrichment_source, inputs_served_at
)
SELECT
  id, request_id, dataset_id, head_sha, anonymous, requested_by, started_by, state, verdict,
  detail, report, nonce, claimed_at, attempts, override_by, override_at, override_reasons,
  created_at, decided_at, scanner_id, reader_versions, resolver_version, models, prompt_version,
  input_digest, enrichment_source, inputs_served_at
FROM publication_reviews;

DROP TABLE publication_reviews;
ALTER TABLE publication_reviews_new RENAME TO publication_reviews;

CREATE INDEX idx_publication_reviews_depositor ON publication_reviews (requested_by, created_at);
CREATE INDEX idx_publication_reviews_state ON publication_reviews (state, created_at);
-- One first run per request, commit and release kind (the table's former UNIQUE).
CREATE UNIQUE INDEX idx_publication_reviews_key ON publication_reviews (request_id, head_sha, anonymous)
  WHERE confirm_of IS NULL;
-- One confirming run per first run.
CREATE UNIQUE INDEX idx_publication_reviews_confirm ON publication_reviews (confirm_of)
  WHERE confirm_of IS NOT NULL;
-- The cap and the digest read the automatic denial's words by when they were written.
CREATE INDEX idx_publication_reviews_auto_deny ON publication_reviews (auto_deny_state, auto_deny_at);

ALTER TABLE publication_requests ADD COLUMN auto_denied INTEGER NOT NULL DEFAULT 0
  CHECK (auto_denied IN (0, 1));

CREATE TABLE publication_auto_deny_digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The UTC day the digest is for (YYYY-MM-DD): one digest a day, claimed by its insert.
  day TEXT NOT NULL UNIQUE,
  -- The end of the window it covers; the next digest starts here.
  window_end TEXT NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
