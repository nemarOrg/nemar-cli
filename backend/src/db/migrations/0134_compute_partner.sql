-- The partner contract's tables and columns (epic #2021 phase D4, #2025; ADR 0118, the amendment of this
-- phase). It writes ONLY what Epic A's schema (0114 to 0119, 0130) and the earlier phases of this epic
-- (0131, 0132) do not have. Read before writing, and what was found:
--   * the unique index on the bound Tapis uuid EXISTS: `compute_jobs.tapis_uuid TEXT UNIQUE` (0115). Not
--     written again. A second bind of one Tapis job to two rows is refused by it, and the partner route
--     answers that as `tapis_job_in_use`.
--   * the orphan slot (`orphan_tapis_uuid`, 0116), the rotation stamp (`examined_at`, 0116), the cancel
--     intent and its reason (`cancel_requested_at`, `cancel_reason`, 0115) and the four flags (0115)
--     EXIST. The reaper uses them; none is added.
--   * the client's caps on open reservations and on service units reserved per day EXIST on the client's
--     own record (`oidc_clients.cap_open_reservations`, `cap_su_per_day`, 0121), so no cap column is
--     added. NULL there means "no cap set yet", and the Worker then applies its own default (never
--     unlimited): `COMPUTE_CLIENT_CAP_DEFAULTS` in `shared/contract/compute-partner.ts`.
--   * Epic A keys a PERSON's job by `(account_id, idempotency_key)` and compares `spec_digest`. A partner
--     job has no key of its own on that index: two clients, or one client for two people, could collide on
--     it, and a key on a job with no account could be stored and never found (ADR 0118, A3 amendment,
--     item 12). So the partner contract has its own table, below.
--
-- compute_idempotency_keys: one row per (scope, key) a partner client has used.
--   * `scope`: `client:<the client's public id>`. One namespace per client, so two clients may use the same
--     key and never meet.
--   * `key`: the caller's `Idempotency-Key`, 1 to 64 letters, digits and `. _ : -`.
--   * `request_hash`: the SHA-256 (64 lowercase hex digits) of the request: the method, the path, the
--     person the token names and the exact body. A key that finds a row is a replay only when the hash is
--     the same; anything else is `idempotency_conflict`, never an answer with the first request.
--   * `job_id`: the job the request is about (the hold's job for a reservation).
--   * `created_at`: on D1's clock.
-- A reservation's row is written IN THE SAME BATCH as its hold (gated on the hold row of that job
-- existing), so two requests with one key racing make one hold: the primary key refuses the second as a
-- whole, and the batch is one transaction. No foreign key, none cascades: a job follows the retention
-- schedule and not an account's deletion. Rows are small and bounded by the client's caps; their
-- pruning follows the job's retention and is not designed here.
--
-- compute_jobs, three columns, all NULL for a job that is not a partner's reservation:
--   * `partner_state`: NULL while the job is a RESERVATION (a hold the partner has not reported a Tapis job
--     under); `pending` once a Tapis job is bound and NEMAR's own read-back has not yet verified it;
--     `verified` when the read-back matched (the job is then an ordinary live job, `submitted`, followed
--     by the lifecycle); `mismatch` when it did not (NEMAR cancels the Tapis job, releases the hold, and
--     charges what ran to the partner's pool, never to the person). Every generic list of the lifecycle
--     leaves a `pending` and a `mismatch` row alone: no path charges a person for a job NEMAR has not
--     bound AND verified.
--   * `partner_flag`: a fixed word an administrator is shown: `owner_mismatch`, `app_mismatch`,
--     `resources_mismatch` (why a read-back refused the job), `ambiguous_tag` (the reaper found several
--     Tapis jobs under one tag and kept the hold), `tapis_unreachable` (the last look could not be made).
--     Checked by shape, never by a list, so a new word never forces a rebuild of the table.
--   * `partner_verified_at`: when the read-back matched. A partner's files enter `records/` only for a row
--     that has this set (the copy is a lock that cannot be undone).
-- D1 runs ALTER TABLE ADD COLUMN as written; every GLOB below is at most 50 characters.

CREATE TABLE compute_idempotency_keys (
  scope TEXT NOT NULL CONSTRAINT compute_idempotency_scope CHECK (
    length(scope) BETWEEN 8 AND 71 AND substr(scope, 1, 7) = 'client:'
    AND substr(scope, 8) NOT GLOB '*[^A-Za-z0-9_.-]*'),
  key TEXT NOT NULL CONSTRAINT compute_idempotency_key CHECK (
    length(key) BETWEEN 1 AND 64 AND key NOT GLOB '*[^A-Za-z0-9._:-]*'),
  request_hash TEXT NOT NULL CONSTRAINT compute_idempotency_hash CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  job_id TEXT NOT NULL CONSTRAINT compute_idempotency_job CHECK (
    length(job_id) = 28 AND substr(job_id, 1, 4) = 'job_' AND substr(job_id, 5) NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope, key)
);

ALTER TABLE compute_jobs ADD COLUMN partner_state TEXT
  CONSTRAINT compute_jobs_partner_state CHECK (
    partner_state IS NULL OR partner_state IN ('pending', 'verified', 'mismatch'));

ALTER TABLE compute_jobs ADD COLUMN partner_flag TEXT
  CONSTRAINT compute_jobs_partner_flag CHECK (
    partner_flag IS NULL OR (length(partner_flag) BETWEEN 1 AND 64
      AND partner_flag NOT GLOB '*[^a-z0-9_]*'));

ALTER TABLE compute_jobs ADD COLUMN partner_verified_at TEXT;

--   * `partner_expires_at`: when the reservation expires, written ONCE at creation from the owner's wait
--     then (a policy change does not move a reservation already made: the answer the partner was given and
--     the reaper's clock are the same stored time). NULL for a job that is not a partner's reservation.
--   * `partner_files_digest`: the SHA-256 of the first accepted list of declared files (path, size and
--     digest of each, in order). A partner's later report may repeat that list and no other, so a verified
--     job cannot be given upload addresses for ever-new path sets.
ALTER TABLE compute_jobs ADD COLUMN partner_expires_at TEXT;

--   * `partner_read_failures` and `partner_first_failed_at`: how many times the reaper's tick could not read
--     a bound, unverified job back, on separate ticks, and when the first of them was. A job is refused as
--     `unverifiable` only after at least three failed reads spanning two hours; a read that succeeds ends the
--     question (the row is verified or refused for what the record shows), so one outage cannot refuse a
--     job that matches.
ALTER TABLE compute_jobs ADD COLUMN partner_read_failures INTEGER NOT NULL DEFAULT 0
  CONSTRAINT compute_jobs_partner_read_failures CHECK (partner_read_failures BETWEEN 0 AND 1000000);

ALTER TABLE compute_jobs ADD COLUMN partner_first_failed_at TEXT;

ALTER TABLE compute_jobs ADD COLUMN partner_files_digest TEXT
  CONSTRAINT compute_jobs_partner_files_digest CHECK (
    partner_files_digest IS NULL OR (length(partner_files_digest) = 64
      AND partner_files_digest NOT GLOB '*[^0-9a-f]*'));

-- The client's open reservations and running jobs, counted INSIDE the hold's own statement against the
-- client's cap: the live partner jobs of one client. A query uses a partial index only if it states the
-- same terms, so the cap's count states `source = 'partner'` and the live list verbatim.
CREATE INDEX compute_jobs_client_live ON compute_jobs (client_id)
  WHERE source = 'partner' AND client_id IS NOT NULL
    AND state IN ('created', 'uploading', 'submitted', 'queued', 'running', 'archiving', 'unreported');

-- The reaper's list: reservations nobody has reported a Tapis job under, in rotation (never examined
-- first, then the longest ago), and the unverified rows (`pending`, `mismatch`) the same tick finishes. The
-- statements NAME their index (`INDEXED BY`), because left to choose the planner took the unique index on
-- the Tapis uuid and a temporary b-tree; the plan is pinned by `compute-partner-migration.test.ts`. An
-- ended refusal leaves the second index (its `state` is part of the predicate).
CREATE INDEX compute_jobs_partner_open ON compute_jobs (examined_at, created_at)
  WHERE source = 'partner' AND tapis_uuid IS NULL AND state = 'created';

CREATE INDEX compute_jobs_partner_unverified ON compute_jobs (examined_at, created_at)
  WHERE partner_state IN ('pending', 'mismatch') AND state = 'created';
