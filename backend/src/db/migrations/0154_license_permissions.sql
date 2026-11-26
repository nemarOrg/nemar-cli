-- License permission evidence (ADR 0139, decision 7 and its amendment of 2026-11-25; epic #2182,
-- card B6).
--
-- `publication_reviews.lineage_basis`: the lineage the Worker served the review's job, as the
-- permission rule reads it (`shared/license-permission.ts`, `permissionBasisOf`): a JSON object
-- with the combined outcome, the target license and the sources behind the outcome. Written when
-- the inputs are served; NULL on a row served before this column, or never served. A plain added
-- column: no CHECK of the table reads it, so the table is not rebuilt.
--
-- `license_permissions`: one row per permission an administrator recorded against a request, from
-- evidence the depositor sent to support@nemar.org (a support ticket, ADR 0112). It covers the
-- request's lineage when its outcome and target license are the review's, and its `source_ids`
-- name every source behind the outcome; it then covers every later request of the dataset with
-- the same basis too. `evidence` is the administrator's own summary of what was received, at most
-- 1,000 characters, shown to administrators only and never sent to a model. `ticket_id` is the
-- ticket the evidence arrived on, and `request_id` the request it was recorded against; both are
-- plain INTEGERs, not foreign keys, as migration 0098 declares none for reviews (a ticket's purge
-- keeps its row, and a permission outlives its request on purpose). Rows are never updated.
--
-- `license_permission_notices`: the depositor's notice, one per request and outcome. The row is
-- inserted (claimed) before the mail is sent, so a second store of the same review, or a second
-- review of the same request with the same outcome, sends nothing; `mail_state` records what
-- became of the one mail (`sent`, `fenced` by the dev Worker's DEV_EMAIL_ALLOWLIST, or `failed`).

ALTER TABLE publication_reviews ADD COLUMN lineage_basis TEXT
  CHECK (lineage_basis IS NULL OR json_valid(lineage_basis));

CREATE TABLE license_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL,
  request_id INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'needs_permission', 'share_alike_mismatch', 'redistribution_prohibited',
    'source_is_publication', 'unresolved'
  )),
  target_license TEXT,
  source_ids TEXT NOT NULL CHECK (json_valid(source_ids) AND json_type(source_ids) = 'array'
    AND json_array_length(source_ids) > 0),
  ticket_id INTEGER NOT NULL,
  evidence TEXT NOT NULL CHECK (length(evidence) BETWEEN 1 AND 1000),
  recorded_by INTEGER NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The derivation asks for a dataset's permissions recorded up to a request.
CREATE INDEX idx_license_permissions_dataset ON license_permissions (dataset_id, request_id);

CREATE TABLE license_permission_notices (
  request_id INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  review_id INTEGER NOT NULL,
  mail_state TEXT CHECK (mail_state IS NULL OR mail_state IN ('sent', 'fenced', 'failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (request_id, outcome)
);
