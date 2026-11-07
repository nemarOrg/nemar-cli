-- Compute access: a person's own, separate grant (epic #2021 phase D1, #2022; ADR 0118, the
-- compute-access addendum).
--
-- WHAT THIS IS FOR. Compute is gated by an export-control judgement and by a finite allocation, so
-- it is a human grant that is DECIDED APART FROM upload access. `service_access` is written only by
-- upload approval (ADR 0040) and nothing here reads it or writes it. Compute gets its own columns on
-- `users`, in the style of migrations 0062 and 0076 for upload access.
--
-- THE STATE (`compute_access`): none, requested, active, suspended, denied, revoked. The edges
-- between them are `shared/compute-access-state.ts`; the database holds only the vocabulary. A row
-- starts at `none`, and so does every existing row (the DEFAULT), so nothing changes for anyone the
-- day this applies.
--
-- THE STAMPS ARE HISTORY AND ARE NEVER CLEARED BY A DECISION. The open request is
-- `compute_access = 'requested'`, not a stamp that is set: unlike upload access (migration 0076, where
-- revocation clears the request stamps), a denied or revoked person keeps the record of when they asked,
-- what for and which terms they accepted, because a closed state is exactly the one a later
-- administrator needs that history to read. The one place a stamp is cleared is the tombstone mask,
-- which clears the purpose text (a person's prose) and keeps the terms version and time.
--   * `compute_access_requested_at`: when the person asked.
--   * `compute_access_notified_at`: when at least one administrator received the review card. NULL
--     with a request open means nobody was told, and a repeat of the request re-sends (as 0076).
--   * `compute_access_granted_at`, `compute_access_granted_by`: the latest grant and the
--     administrator's user id. No foreign key: the pointer outlives an administrator's deletion, as
--     `service_access_granted_by` does.
--   * `compute_purpose`: what the person intends to compute, 20 to 1000 characters, or NULL.
--   * `compute_terms_version`, `compute_terms_accepted_at`: the terms the person accepted and when.
--     The version is a short word of letters, digits and `. _ -` (at most 32 characters).
--
-- THE COUPLING THE DATABASE DOES NOT ENFORCE. "active implies a grant stamp" is a rule of the
-- writers (the request route and the administrator's decisions) and is pinned by tests; every CHECK
-- here is a single-column CHECK whose terms are TRUE or FALSE, never NULL, because a CHECK passes on
-- NULL and a multi-column rule would have to survive every writer of `users` (the table is rebuilt
-- by migrations, see 0026). A later migration that REBUILDS `users` must carry these columns, their
-- CHECKs and the index across.
--
-- D1 limits kept in mind: the GLOB pattern is 18 characters, far under the 50 D1 allows, and every
-- statement is a plain ALTER or CREATE INDEX that D1 runs as written.
--
-- ONE LINE OF STORAGE, NO NEW TABLE: a person asks once and an administrator answers once, so there
-- is never more than one request per account (ADR 0042's reasoning, which ADR 0036 and 0034 share).
-- If requests ever become repeatable, a table is the decision to revisit first.

ALTER TABLE users ADD COLUMN compute_access TEXT NOT NULL DEFAULT 'none'
  CHECK (compute_access IN ('none', 'requested', 'active', 'suspended', 'denied', 'revoked'));

ALTER TABLE users ADD COLUMN compute_access_requested_at TEXT;

ALTER TABLE users ADD COLUMN compute_access_notified_at TEXT;

ALTER TABLE users ADD COLUMN compute_access_granted_at TEXT;

ALTER TABLE users ADD COLUMN compute_access_granted_by INTEGER;

ALTER TABLE users ADD COLUMN compute_purpose TEXT
  CHECK (compute_purpose IS NULL OR length(compute_purpose) BETWEEN 20 AND 1000);

ALTER TABLE users ADD COLUMN compute_terms_version TEXT
  CHECK (compute_terms_version IS NULL
    OR (length(compute_terms_version) BETWEEN 1 AND 32
        AND compute_terms_version NOT GLOB '*[^0-9A-Za-z._-]*'));

ALTER TABLE users ADD COLUMN compute_terms_accepted_at TEXT;

-- The administrator's queue is the open requests, oldest first.
CREATE INDEX idx_users_compute_access_requested
  ON users(compute_access_requested_at)
  WHERE compute_access = 'requested';
