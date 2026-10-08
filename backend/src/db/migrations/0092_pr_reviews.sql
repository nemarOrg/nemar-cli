-- The dataset pull-request review (ADR 0092).
--
-- When a pull request is opened or updated against `main` of a dataset repository, the Worker
-- (which the NEMAR GitHub App already delivers every pull_request event to, forks included)
-- decides whether to review it, records the attempt here, and dispatches a workflow to
-- nemarDatasets/.github. That workflow reads the change as git data, asks a model three questions
-- (is anything lost or broken, does the revision advance, is the dataset materially better) and
-- posts a report back to /webhooks/pr-review-result. The Worker stores what
-- `parsePrReviewReport` accepted and publishes the result as a check-run and one pull-request
-- comment. The report's shape, and every word in it, is declared in `shared/pr-review.ts`.
--
-- One row per (dataset, pull request, head commit): a delivery GitHub repeats, or a second event
-- for the same commit, finds the row and does nothing, which is also what stops a duplicate
-- delivery from costing a second review.
--
--   * `state`: dispatched (handed to GitHub, waiting for a report), reported (a verdict is
--     stored), declined (not sent to the model: the contributor is paused, or a rate limit
--     applied), errored (the run reported that it could not decide), unreported (the watchdog
--     gave up waiting). CHECK-constrained, and a reader still must not trust the column.
--   * `verdict`: pass, fail or uncertain, DERIVED by `verdictOf` from the report and the git
--     facts and stored beside it so the tally is a query. NULL unless `state` = 'reported'.
--   * `detail`: the closed word for a declined or errored row (`DECLINE_REASONS`, `RUN_ERRORS`).
--   * `nonce`: signed into the callback token, the one-shot handshake the other callbacks use.
--     Cleared when a result is stored. KEPT when the watchdog marks a row 'unreported', so a late
--     but valid report is still accepted.
--   * `author_id` / `author_login`: who opened the pull request. The numeric GitHub id is the key
--     (a login can be renamed or reused); the login is only for people to read. A fork's author is
--     whoever opened the pull request, not the fork's owner.
--   * `author_association`: GitHub's own relationship label, used only to choose a rate cap.
--   * `from_fork`: 1 when the head lives in another repository. The review is identical either
--     way, because the workflow reads `refs/pull/N/head` from the BASE repository and never runs
--     anything from the pull request.
--   * `report`: the parsed report, re-serialized JSON, never the raw callback body.
--   * `check_run_id` / `comment_id`: the GitHub objects the result was published to, so a new
--     commit edits them in place.
--
-- The contributor tally is not stored. "Rejected" and "decided" are counted from this table by
-- `AUTHOR_TALLY_SQL` in services/pr-review.ts (ADR 0034: derive, don't store), so a re-run or a
-- later commit that passes corrects the tally by itself.
--
-- No FOREIGN KEY to `datasets` or `users`: deleting a dataset must not be blocked by, or cascade
-- into, its review history, and a contributor is a GitHub account that need not have a NEMAR one.

CREATE TABLE pr_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  author_id INTEGER NOT NULL,
  author_login TEXT NOT NULL,
  author_association TEXT,
  from_fork INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL
    CHECK (state IN ('dispatched', 'reported', 'declined', 'errored', 'unreported')),
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('pass', 'fail', 'uncertain')),
  detail TEXT,
  nonce TEXT,
  report TEXT,
  check_run_id INTEGER,
  comment_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  UNIQUE (dataset_id, pr_number, head_sha)
);

CREATE INDEX idx_pr_reviews_author ON pr_reviews (author_id, created_at);
CREATE INDEX idx_pr_reviews_pr ON pr_reviews (dataset_id, pr_number, id);
CREATE INDEX idx_pr_reviews_state ON pr_reviews (state, created_at);

-- A maintainer's standing decision about one contributor. It wins over the tally in both
-- directions: 'allow' keeps reviewing someone the tally would pause, 'block' pauses someone it
-- would not. Set by an administrator; there is no route for it yet, so today it is a row written
-- with `wrangler d1 execute` (ADR 0092).
CREATE TABLE pr_review_overrides (
  author_id INTEGER PRIMARY KEY,
  author_login TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('allow', 'block')),
  reason TEXT,
  set_by INTEGER,
  set_at TEXT NOT NULL DEFAULT (datetime('now'))
);
