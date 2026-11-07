-- Indexes for the compute read routes (epic #2021 phase D2, #2023; ADR 0118, the addendum of that phase).
--
-- WHAT THIS IS FOR. `GET /compute/me`, `/compute/me/usage`, `/compute/me/jobs`, `/compute/me/jobs/:id` and
-- `/compute/stats` read Epic A's tables. `EXPLAIN QUERY PLAN` on the statements those routes run
-- (`backend/test/compute-read-plans.test.ts` runs it on the real statements and fails when one scans) shows
-- that Epic A's indexes cover a person's own reads and not the three aggregate ones:
--   * a person's usage: `compute_ledger_pool (pool_id, id)` answers the pool filter; covered.
--   * one job: the primary key; covered. A person's job list pages by `(created_at, id)`: the job id is the
--     cursor's tie-breaker (the table's row number is not put on the wire), and `compute_jobs_account_created
--     (account_id, created_at)` ends in the row number, not the id, so the list would sort within each
--     second; the index below ends in the id and the list needs no sort.
--   * the queue estimate (per partition, jobs started in the last seven days, newest first) scanned
--     `compute_jobs`: the index below answers it, and is partial on the two stamps a sample needs.
--   * the partner's aggregate usage (every charge entry that names a job, in a window) scanned the whole
--     ledger, and the count of people and of outcomes in a window scanned every job: the two time indexes
--     below bound each to its window.
--
-- NOTHING ELSE CHANGES: no column, no trigger, no row. An index is rebuildable from the table and a
-- migration that drops it loses nothing. D1: a plain CREATE INDEX, no GLOB.

-- The queue estimate: `WHERE partition = ? AND started_at >= ... ORDER BY started_at DESC LIMIT 2000`, over
-- the jobs that have both scheduler stamps. A query uses a partial index only if it states the same terms.
CREATE INDEX compute_jobs_queue_started ON compute_jobs (partition, started_at)
  WHERE started_at IS NOT NULL AND remote_submitted_at IS NOT NULL;

-- A person's job list, newest first, `ORDER BY created_at DESC, id DESC` with an `id` cursor tie-breaker.
--
-- It is PARTIAL on `flag_unreserved = 0`, which the list states (a swept job is nobody's to list), and that
-- is not only a saving: a plain index on `(account_id, ...)` was chosen by SQLite for every query that
-- names only the account, among them Epic A's quota sums (`account_id = ? AND results_bytes IS NOT NULL`,
-- which `compute_jobs_results` answers), and took their plan. A query that does not state the predicate
-- cannot use a partial index, so Epic A's plans are as they were.
CREATE INDEX compute_jobs_account_created_id ON compute_jobs (account_id, created_at, id)
  WHERE flag_unreserved = 0;

-- The partner's aggregate: jobs made in a window (active people, outcomes).
CREATE INDEX compute_jobs_created ON compute_jobs (created_at);

-- The partner's aggregate usage: ledger entries in a window.
CREATE INDEX compute_ledger_created ON compute_ledger (created_at);
