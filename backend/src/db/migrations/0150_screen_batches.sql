-- A paced re-screen of many publication requests, mailed as one digest (epic #2182, card D4).
--
-- `nemar admin dataset publish screen-batch` re-screens a selection of requests one dispatch at a
-- time. Each screen stores exactly the result a single `screen` would, but the batch sends no
-- per-request administrator mail and no depositor mail; when the batch ends the administrators
-- get one digest that names every request it did not mail about (ADR 0086, amendment of
-- 2026-11-25).
--
--   * `screen_batches.total`: the requests the batch was created for. `reported` counts the
--     distinct requests that have settled: a stored report, a screen that could not start (its
--     error is stored at once), a dispatch the Worker refused, or a request screened again outside
--     the batch. A request settles once: `identifier_screen_batch_settled_at` is set by one
--     conditional UPDATE, and only a row that UPDATE returns is counted. `closed_at` is set when
--     the administrator stops dispatching; it leaves `total` alone. The digest is due when the
--     batch is closed or `reported >= total`, AND no request dispatched by the batch is still
--     unsettled (so a result stored between the close and its settle is waited for), or two hours
--     after `last_dispatch_at` (the sweep; the batch's creation when nothing was dispatched),
--     whichever comes first. A batch closed with nothing dispatched is due at once.
--   * `selection`: JSON array of [request_id, dataset_id, screen_state_before, status_before],
--     the screen state and the request status read when the batch was created. It is how the
--     digest says what changed and names a request that never reported. Bounded at 500 entries.
--   * `refused`: JSON array of [dataset_id, reason word], once per dataset, for the dispatches the
--     Worker refused (no active request, a request that changed, a screen still running, ...) and
--     for a request screened again outside the batch. The digest says them apart from a screen
--     that could not start and from one that never reported.
--   * `digest_claimed_at` / `digest_sent_at`: the digest's lease and its stamp. The lease is taken
--     in one conditional UPDATE, so of two callbacks racing for the last report exactly one sends;
--     `digest_sent_at` is set only after a send that reached at least one administrator, and a
--     lease that expires is retaken by the sweep.
--   * `publication_requests.identifier_screen_batch_id`: the batch whose dispatch last screened
--     the request; `identifier_screen_batch_settled_at` is when the batch counted that screen.
--     Both are NULL for a screen started any other way: a re-run or a re-request resets them
--     with the rest of the screen's columns, so a single screen mails as it always did. No
--     FOREIGN KEY, matching the screen's acknowledgment columns.
--
-- All new columns are nullable and nothing is backfilled: every existing request was screened
-- outside a batch.

CREATE TABLE screen_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  total INTEGER NOT NULL CHECK (total >= 1),
  reported INTEGER NOT NULL DEFAULT 0,
  last_dispatch_at TEXT NOT NULL DEFAULT (datetime('now')),
  selection TEXT NOT NULL,
  refused TEXT,
  closed_at TEXT,
  digest_claimed_at TEXT,
  digest_sent_at TEXT
);

ALTER TABLE publication_requests ADD COLUMN identifier_screen_batch_id INTEGER;
ALTER TABLE publication_requests ADD COLUMN identifier_screen_batch_settled_at TEXT;
