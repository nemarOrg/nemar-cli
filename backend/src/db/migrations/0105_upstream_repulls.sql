-- The record of an upstream re-pull (epic #1046 phase 6, #1912; ADR 0111, decision 3).
--
-- WHAT THIS IS FOR. A re-pull replays the delta between two pinned upstream tags onto a
-- mirror as one synthesized commit on `release/vN.0.0`, and lands it through a pull request.
-- That is a long, resumable, partly irreversible sequence (a copy into the bucket, a pull
-- request, a merge that mints a DOI), so each step must be able to check its own end state
-- and continue from the recorded status. This table is that record. It is separate from
-- `import_jobs` on purpose: the sticky row per dataset, the `preparing` reset, the six-hour
-- sweep and the retry engine would each read a re-pull as a broken import (decision 3).
--
-- ONE ROW PER ATTEMPT. Decision 3 reads "one row per (dataset_id, to_tag), UNIQUE". Taken
-- literally, a tag whose re-pull was abandoned or failed could never be tried again, so the row
-- is keyed by `(dataset_id, to_tag, attempt)` instead. A new attempt for a tag is allowed only
-- when every earlier one ended `abandoned`, `failed` or `superseded` without a merge; the
-- service enforces that, and the partial unique index below enforces that at most one row per
-- dataset is open at any time.
--
-- THE STATES. planned, prepared, copied, registered, pr_open, gates_clear, merged and released
-- are N.0.0's path; patch_synthesized, patch_gates_clear, patch_merged and patch_released are
-- N.0.1's (the corrections replayed after N.0.0 is tagged); complete ends both. abandoned,
-- failed, superseded and patch_declined are terminal too. The allowed edges are not in this file:
-- they live in shared/repull-state.ts, and the service is the only writer.
--
-- STAGE INVARIANTS. A row at a stage carries what that stage produced, so a half-written row
-- (a `pr_open` row with no pull request number, a `released` row with no tag) is refused by the
-- database and not only by the code that normally writes it. Every term below is TRUE or
-- FALSE, never NULL: a CHECK passes on NULL, so a term that could be NULL would let the row in.
--
-- WHERE NULL MEANS WHAT. `patch_*` columns stay NULL until `patch_synthesized`, and for good when
-- the re-pull has no corrections to replay. `merge_claimed_at` and `merge_claim_sha` are set
-- before a merge is sent and kept when its outcome is unknown, so a lost answer is resolved from
-- GitHub and never repeated blind. `terminal_at` is NULL exactly while the row is open.
--
-- NO FOREIGN KEY to `datasets`, as `import_jobs` (migration 0044): `deleteDatasetCascade` deletes
-- the rows. `datasets` gains nothing, so ADR 0034's column budget is untouched.

CREATE TABLE upstream_repulls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL,
  upstream_ds TEXT NOT NULL CHECK (upstream_ds GLOB 'ds[0-9][0-9][0-9][0-9][0-9][0-9]'),
  from_tag TEXT NOT NULL,
  to_tag TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  from_version TEXT NOT NULL,
  to_version TEXT NOT NULL,
  patch_version TEXT,
  plan_digest TEXT NOT NULL CHECK (length(plan_digest) = 71 AND substr(plan_digest, 1, 7) = 'sha256:'),
  planner INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('automatic', 'administrator')),
  actor_user_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned', 'prepared', 'copied', 'registered', 'pr_open',
    'gates_clear', 'merged', 'released', 'patch_synthesized', 'patch_gates_clear', 'patch_merged',
    'patch_released', 'complete', 'abandoned', 'failed', 'superseded', 'patch_declined')),
  base_sha TEXT NOT NULL,
  synth_tree TEXT,
  synth_sha TEXT,
  manifest_digest TEXT,
  branch TEXT,
  pr_number INTEGER,
  head_sha TEXT,
  gates_sha TEXT,
  merge_claimed_at TEXT,
  merge_claim_sha TEXT,
  merge_sha TEXT,
  tag_sha TEXT,
  patch_base_sha TEXT,
  patch_branch TEXT,
  patch_pr_number INTEGER,
  patch_head_sha TEXT,
  patch_gates_sha TEXT,
  patch_merge_claimed_at TEXT,
  patch_merge_claim_sha TEXT,
  patch_merge_sha TEXT,
  patch_tag_sha TEXT,
  counts TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(counts)),
  last_error TEXT,
  workflow_run_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  terminal_at TEXT,
  UNIQUE (dataset_id, to_tag, attempt),
  CHECK (status IN ('planned', 'abandoned', 'failed', 'superseded')
    OR (synth_tree IS NOT NULL AND synth_sha IS NOT NULL)),
  CHECK (status NOT IN ('pr_open', 'gates_clear', 'merged', 'released', 'patch_synthesized',
      'patch_gates_clear', 'patch_merged', 'patch_released', 'complete', 'patch_declined')
    OR (branch IS NOT NULL AND pr_number IS NOT NULL AND head_sha IS NOT NULL)),
  CHECK (status <> 'gates_clear' OR gates_sha IS NOT NULL),
  CHECK (status <> 'patch_gates_clear' OR patch_gates_sha IS NOT NULL),
  CHECK (status NOT IN ('merged', 'released', 'patch_synthesized', 'patch_gates_clear',
      'patch_merged', 'patch_released', 'complete', 'patch_declined')
    OR merge_sha IS NOT NULL),
  CHECK (status NOT IN ('released', 'patch_synthesized', 'patch_gates_clear', 'patch_merged',
      'patch_released', 'complete', 'patch_declined')
    OR tag_sha IS NOT NULL),
  CHECK (status NOT IN ('patch_synthesized', 'patch_gates_clear', 'patch_merged', 'patch_released')
    OR (patch_version IS NOT NULL AND patch_branch IS NOT NULL AND patch_pr_number IS NOT NULL
        AND patch_head_sha IS NOT NULL AND patch_base_sha IS NOT NULL)),
  CHECK (status NOT IN ('patch_merged', 'patch_released') OR patch_merge_sha IS NOT NULL),
  CHECK (status <> 'complete' OR patch_version IS NULL OR patch_tag_sha IS NOT NULL),
  CHECK ((terminal_at IS NULL) = (status NOT IN ('complete', 'abandoned', 'failed', 'superseded',
    'patch_declined')))
);

CREATE UNIQUE INDEX upstream_repulls_one_open ON upstream_repulls (dataset_id)
  WHERE status NOT IN ('complete', 'abandoned', 'failed', 'superseded', 'patch_declined');

CREATE INDEX upstream_repulls_merge_claims ON upstream_repulls (merge_claimed_at)
  WHERE merge_claimed_at IS NOT NULL;

CREATE INDEX upstream_repulls_patch_claims ON upstream_repulls (patch_merge_claimed_at)
  WHERE patch_merge_claimed_at IS NOT NULL;
