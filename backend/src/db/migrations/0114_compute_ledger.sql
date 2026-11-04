-- The compute gateway's allocation ledger and owner policy (epic #2005 phase A2, #2007; ADR 0118,
-- decision 3).
--
-- WHAT THIS IS FOR. NEMAR says how many Expanse service units (SU) a holder may spend and refuses a
-- spend that would exceed it, atomically. Three tables carry that:
--   * `compute_policy`: the owner's policy, one immutable row per version (the current policy is
--     the highest version, and no row means DEFAULT_COMPUTE_POLICY of shared/contract/compute.ts);
--   * `compute_pools`: one row per holder and pool (cpu, gpu) with three running totals;
--   * `compute_ledger`: the append-only entries, whose deltas the totals are the sum of.
--
-- AMOUNTS ARE WHOLE THOUSANDTHS OF AN SU (milli-SU), never floating point. Every amount column
-- refuses a value that is not an INTEGER (`typeof`) and one beyond 2^53 - 1 (9007199254740991), the
-- largest number a JavaScript double holds exactly, so a total read back in the Worker is exact. A
-- sum of two such values stays far below the 2^63 at which SQLite would turn an integer into a
-- float, so no statement here can.
--
-- THE LEDGER IS THE ONLY WRITER OF A POOL'S TOTALS. `compute_ledger_apply` (AFTER INSERT) adds an
-- entry's three deltas to `pool_id`'s row and its held and charged deltas to `budget_pool_id`'s row.
-- So a total can never disagree with the ledger, "only if the entry was inserted" holds by
-- construction (there is no second statement to forget), and an entry a total refuses (a CHECK
-- below on the pool) is not written either: the entry and the totals are one statement. No code
-- path updates `granted_milli`, `held_milli` or `charged_milli`; a test reads every source file and
-- every migration for one.
--
-- WHAT A HOLD IS. A hold is an entry whose WHERE (`HOLD_INSERT_SQL` in services/compute-ledger.ts)
-- checks the pool, its budget and the key in the same statement that inserts it, so two holds for
-- the last SU cannot both be written and a refused hold writes nothing (ADR 0099; the claim of
-- upstream-repull-dispatch.ts is the precedent). A job has one hold. A hold is closed once, by a
-- release or a charge, and the unique index on `hold_ref` is what says so.
--
-- NO FOREIGN KEY, to `users` or between these tables, and none that cascades: ledger entries are
-- never removed by a cascade from the account row (design section 5), so an account's deletion
-- leaves its pools and entries as they are, to follow the retention schedule. The two triggers that
-- stand where a foreign key would (the pool exists; the budget is a platform pool of the same
-- word) are named below. Every CHECK term is TRUE or FALSE, never NULL: a CHECK passes on NULL, so
-- a term that could be NULL would let the row in. Every CHECK is named, so a test can say which
-- one refused a row.
--
-- SQLite runs BEFORE triggers ahead of the CHECKs, so an entry for a pool that does not exist is
-- refused by the trigger's message and not by a CHECK: that is why `pool_id` has no CHECK of its
-- own. D1 rejects SQL that bun:sqlite accepts, so every GLOB below is at most 50 characters.

-- ---------------------------------------------------------------------------------------------
-- compute_policy
-- ---------------------------------------------------------------------------------------------
--
--   * `version`: 1, 2, 3 ... in the order they were set; the highest is the current policy.
--   * `policy_json`: the whole policy, a JSON object of at most 64 KiB, validated by the strict
--     ComputePolicySchema before it is written (services/compute-policy.ts). The CASE is load-bearing:
--     json_type() throws on malformed JSON and SQLite does not promise left-to-right evaluation of
--     AND, so the CASE guarantees json_valid runs first (migration 0074 says the same).
--   * `set_by`: the owner's user id. No foreign key; the writer checks the account is an owner in
--     the same statement that inserts the row.
--   * `note`: why, in at most 500 characters; optional.
--   * `created_at`: when, on D1's clock.

CREATE TABLE compute_policy (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_json TEXT NOT NULL CONSTRAINT compute_policy_json CHECK (
    CASE WHEN json_valid(policy_json) THEN json_type(policy_json) = 'object' ELSE 0 END
    AND length(policy_json) <= 65536),
  set_by INTEGER NOT NULL CONSTRAINT compute_policy_set_by CHECK (set_by >= 1),
  note TEXT CONSTRAINT compute_policy_note CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER compute_policy_no_update BEFORE UPDATE ON compute_policy
BEGIN
  SELECT RAISE(ABORT, 'compute_policy is append-only: a version is never changed');
END;

CREATE TRIGGER compute_policy_no_delete BEFORE DELETE ON compute_policy
BEGIN
  SELECT RAISE(ABORT, 'compute_policy is append-only: a version is never removed');
END;

-- ---------------------------------------------------------------------------------------------
-- compute_pools
-- ---------------------------------------------------------------------------------------------
--
--   * `id`: the pool's number, which an entry names.
--   * `holder_kind`: `account` (a person; `holder_ref` is the user id), `platform` (NEMAR's own two
--     budgets; the keys are `pipelines` and `people`, seeded below) or `partner` (a partner client's
--     own pool; `holder_ref` is its client id).
--   * `holder_ref`: 1 to 64 characters of letters, digits and `_ . -`; an account's is a number
--     without a leading zero.
--   * `pool`: `cpu` or `gpu`; Expanse's two resources are separate ACCESS resources
--     (COMPUTE_POOLS in shared/contract/compute.ts, and a test compares the two).
--   * `granted_milli`: SU the holder may spend, in all. Only the ledger changes it.
--   * `held_milli`: SU set aside by open holds. Only the ledger changes it.
--   * `charged_milli`: SU spent. Only the ledger changes it.
--     Available is granted - held - charged and MAY BE NEGATIVE (an `overrun`, or an adjustment of
--     the grant below what is used, is a fact that already happened); a stored TOTAL never is.
--   * `frozen`: 1 while the pool may not place a hold (a suspended account). Not a total and not the
--     ledger's; an operator sets it.
--   * `created_at`, `updated_at`: on D1's clock; the trigger moves `updated_at`.
--
-- The platform pools are seeded here because a hold for a person's job checks the platform budget
-- in the same statement, and a budget that does not exist is a refusal nobody can clear.

CREATE TABLE compute_pools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  holder_kind TEXT NOT NULL CONSTRAINT compute_pools_holder_kind CHECK (
    holder_kind IN ('account', 'platform', 'partner')),
  holder_ref TEXT NOT NULL CONSTRAINT compute_pools_holder_ref CHECK (
    length(holder_ref) BETWEEN 1 AND 64
    AND holder_ref NOT GLOB '*[^A-Za-z0-9_.-]*'
    AND (holder_kind <> 'account' OR (holder_ref NOT GLOB '*[^0-9]*' AND holder_ref GLOB '[1-9]*'))),
  pool TEXT NOT NULL CONSTRAINT compute_pools_pool CHECK (pool IN ('cpu', 'gpu')),
  granted_milli INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_pools_granted CHECK (
    typeof(granted_milli) = 'integer' AND granted_milli BETWEEN 0 AND 9007199254740991),
  held_milli INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_pools_held CHECK (
    typeof(held_milli) = 'integer' AND held_milli BETWEEN 0 AND 9007199254740991),
  charged_milli INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_pools_charged CHECK (
    typeof(charged_milli) = 'integer' AND charged_milli BETWEEN 0 AND 9007199254740991),
  frozen INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_pools_frozen CHECK (frozen IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (holder_kind, holder_ref, pool)
);

-- A pool is permanent: the ledger names it, and the ledger is never removed.
CREATE TRIGGER compute_pools_no_delete BEFORE DELETE ON compute_pools
BEGIN
  SELECT RAISE(ABORT, 'a compute pool is never deleted: the ledger names it');
END;

-- What a pool IS (its number, holder and word) never changes: an entry's budget is judged by it.
CREATE TRIGGER compute_pools_identity_fixed BEFORE UPDATE OF id, holder_kind, holder_ref, pool
  ON compute_pools
BEGIN
  SELECT RAISE(ABORT, 'a compute pool''s identity never changes');
END;

INSERT INTO compute_pools (holder_kind, holder_ref, pool) VALUES ('platform', 'pipelines', 'cpu');
INSERT INTO compute_pools (holder_kind, holder_ref, pool) VALUES ('platform', 'pipelines', 'gpu');
INSERT INTO compute_pools (holder_kind, holder_ref, pool) VALUES ('platform', 'people', 'cpu');
INSERT INTO compute_pools (holder_kind, holder_ref, pool) VALUES ('platform', 'people', 'gpu');

-- ---------------------------------------------------------------------------------------------
-- compute_ledger
-- ---------------------------------------------------------------------------------------------
--
--   * `id`: the entry's number, in the order they were written.
--   * `kind`: what the entry does to a pool, one of LEDGER_ENTRY_KINDS of shared/compute-state.ts
--     (a test compares the two). Which deltas a kind may carry is `compute_ledger_deltas`:
--     grant  granted+                       an admin, the owner or a renewal gives SU
--     hold   held+                          SU set aside before a submit
--     release held-                         a hold given back in full (a job that never started)
--     charge held <= 0, charged >= 0        a hold settled: the hold leaves `held`, what the job
--                                           used (never more than the hold) enters `charged`
--     refund charged-                       a charge returned (a failure NEMAR caused)
--     adjust exactly one of granted/charged  a correction, either way (the final figure of a job
--                                           from Expanse's own accounting; an admin's fix)
--     overrun charged+                      use beyond the hold; available may go negative
--     expire granted-                       unused SU that lapse (a renewal)
--   * `pool_id`: the pool the entry is about; the trigger takes the three deltas into its row. No
--     CHECK here: `compute_ledger_pool_exists` refuses a pool that does not exist, and runs first.
--   * `budget_pool_id`: the platform pool a spend is also counted against, or NULL. Only a kind that
--     spends may name one (a grant and an expiry may not, nor may an adjustment of the grant); it
--     is a platform pool of the same word as `pool_id` (`compute_ledger_budget_platform`) and not
--     `pool_id` itself. The trigger takes the held and charged deltas into its row, never granted.
--   * `granted_delta_milli`, `held_delta_milli`, `charged_delta_milli`: the change to each total,
--     whole milli-SU within +- (2^53 - 1), 0 when the kind does not move it.
--   * `job_id`: the job (`job_` and 24 lowercase hex digits, COMPUTE_JOB_ID_RE) a hold, release,
--     charge, refund or overrun is about; NULL for a grant, an expiry and an admin's adjustment.
--     A job has one hold (`compute_ledger_one_hold_per_job`).
--   * `hold_ref`: the id of the hold a release or a charge closes (required for both) and an overrun
--     belongs to; NULL otherwise. A hold is closed once (`compute_ledger_closes_once`).
--   * `reason`: a fixed word, 1 to 64 characters of lowercase letters, digits and `_`
--     (COMPUTE_WORD_RE, and a test compares the two), never free text.
--   * `actor_user_id`: the person who did it, or NULL for the Worker's own entries.
--   * `idempotency_key`: unique over the whole ledger, 1 to 128 characters of letters, digits and
--     `. _ : -`. A retry with the key of an entry that was written finds that entry.
--   * `created_at`: when, on D1's clock.

CREATE TABLE compute_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CONSTRAINT compute_ledger_kind CHECK (kind IN
    ('grant', 'hold', 'release', 'charge', 'refund', 'adjust', 'overrun', 'expire')),
  pool_id INTEGER NOT NULL,
  budget_pool_id INTEGER,
  granted_delta_milli INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_ledger_granted_int CHECK (
    typeof(granted_delta_milli) = 'integer'
    AND granted_delta_milli BETWEEN -9007199254740991 AND 9007199254740991),
  held_delta_milli INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_ledger_held_int CHECK (
    typeof(held_delta_milli) = 'integer'
    AND held_delta_milli BETWEEN -9007199254740991 AND 9007199254740991),
  charged_delta_milli INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_ledger_charged_int CHECK (
    typeof(charged_delta_milli) = 'integer'
    AND charged_delta_milli BETWEEN -9007199254740991 AND 9007199254740991),
  job_id TEXT CONSTRAINT compute_ledger_job_id CHECK (job_id IS NULL OR (
    length(job_id) = 28 AND substr(job_id, 1, 4) = 'job_'
    AND substr(job_id, 5) NOT GLOB '*[^0-9a-f]*')),
  hold_ref INTEGER CONSTRAINT compute_ledger_hold_ref CHECK (hold_ref IS NULL OR hold_ref >= 1),
  reason TEXT CONSTRAINT compute_ledger_reason CHECK (reason IS NULL OR (
    length(reason) BETWEEN 1 AND 64 AND reason NOT GLOB '*[^a-z0-9_]*')),
  actor_user_id INTEGER CONSTRAINT compute_ledger_actor CHECK (
    actor_user_id IS NULL OR actor_user_id >= 1),
  idempotency_key TEXT NOT NULL UNIQUE CONSTRAINT compute_ledger_key CHECK (
    length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CONSTRAINT compute_ledger_deltas CHECK (CASE kind
    WHEN 'grant' THEN granted_delta_milli > 0 AND held_delta_milli = 0 AND charged_delta_milli = 0
    WHEN 'hold' THEN held_delta_milli > 0 AND granted_delta_milli = 0 AND charged_delta_milli = 0
    WHEN 'release' THEN held_delta_milli < 0 AND granted_delta_milli = 0 AND charged_delta_milli = 0
    WHEN 'charge' THEN held_delta_milli <= 0 AND charged_delta_milli >= 0 AND granted_delta_milli = 0
    WHEN 'refund' THEN charged_delta_milli < 0 AND granted_delta_milli = 0 AND held_delta_milli = 0
    WHEN 'adjust' THEN held_delta_milli = 0
      AND (granted_delta_milli <> 0) + (charged_delta_milli <> 0) = 1
    WHEN 'overrun' THEN charged_delta_milli > 0 AND granted_delta_milli = 0 AND held_delta_milli = 0
    WHEN 'expire' THEN granted_delta_milli < 0 AND held_delta_milli = 0 AND charged_delta_milli = 0
    ELSE 0 END),
  CONSTRAINT compute_ledger_job_required CHECK (
    kind NOT IN ('hold', 'release', 'charge', 'refund', 'overrun') OR job_id IS NOT NULL),
  CONSTRAINT compute_ledger_closing_hold CHECK (
    kind NOT IN ('release', 'charge') OR hold_ref IS NOT NULL),
  CONSTRAINT compute_ledger_hold_ref_kinds CHECK (
    hold_ref IS NULL OR kind IN ('release', 'charge', 'overrun')),
  CONSTRAINT compute_ledger_budget_kinds CHECK (budget_pool_id IS NULL
    OR kind IN ('hold', 'release', 'charge', 'refund', 'overrun')
    OR (kind = 'adjust' AND charged_delta_milli <> 0)),
  CONSTRAINT compute_ledger_budget_distinct CHECK (
    budget_pool_id IS NULL OR budget_pool_id <> pool_id)
);

-- A hold is closed once, by one release or one charge; the entry that finds it closed writes nothing.
CREATE UNIQUE INDEX compute_ledger_closes_once ON compute_ledger (hold_ref)
  WHERE kind IN ('release', 'charge');

-- A job has one hold, so settling a job names one hold and a retried submit cannot hold twice.
CREATE UNIQUE INDEX compute_ledger_one_hold_per_job ON compute_ledger (job_id)
  WHERE kind = 'hold';

CREATE INDEX compute_ledger_pool ON compute_ledger (pool_id, id);

CREATE INDEX compute_ledger_job ON compute_ledger (job_id, id) WHERE job_id IS NOT NULL;

CREATE TRIGGER compute_ledger_no_update BEFORE UPDATE ON compute_ledger
BEGIN
  SELECT RAISE(ABORT, 'compute_ledger is append-only: an entry is never changed');
END;

CREATE TRIGGER compute_ledger_no_delete BEFORE DELETE ON compute_ledger
BEGIN
  SELECT RAISE(ABORT, 'compute_ledger is append-only: an entry is never removed');
END;

-- Where a foreign key would stand: the pool an entry is about must exist, or its deltas would land
-- nowhere and the totals would disagree with the ledger.
CREATE TRIGGER compute_ledger_pool_exists BEFORE INSERT ON compute_ledger
WHEN NOT EXISTS (SELECT 1 FROM compute_pools WHERE id = NEW.pool_id)
BEGIN
  SELECT RAISE(ABORT, 'a ledger entry names a pool that exists');
END;

-- The budget an entry is counted against is a platform pool of the same word as the entry's pool,
-- so a cpu job is never counted against a gpu budget, and a person's spend is never counted
-- against another person.
CREATE TRIGGER compute_ledger_budget_platform BEFORE INSERT ON compute_ledger
WHEN NEW.budget_pool_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM compute_pools b, compute_pools p
   WHERE b.id = NEW.budget_pool_id AND p.id = NEW.pool_id
     AND b.holder_kind = 'platform' AND b.pool = p.pool)
BEGIN
  SELECT RAISE(ABORT, 'a ledger entry''s budget is a platform pool of the same word as its pool');
END;

-- THE ONE WRITER OF A POOL'S TOTALS. A budget pool that is NULL matches no row.
CREATE TRIGGER compute_ledger_apply AFTER INSERT ON compute_ledger
BEGIN
  UPDATE compute_pools
     SET granted_milli = granted_milli + NEW.granted_delta_milli,
         held_milli = held_milli + NEW.held_delta_milli,
         charged_milli = charged_milli + NEW.charged_delta_milli,
         updated_at = datetime('now')
   WHERE id = NEW.pool_id;
  UPDATE compute_pools
     SET held_milli = held_milli + NEW.held_delta_milli,
         charged_milli = charged_milli + NEW.charged_delta_milli,
         updated_at = datetime('now')
   WHERE id = NEW.budget_pool_id;
END;
