# Recover runbook (epic #967 Phase 5, #972)

Operational sequence for re-copying the 45 datasets in `scripts/recover-datasets.json`
(published with 0-byte content in the #967 incident; upstream confirmed accessible).
This is a **post-deploy, production-only, operator-gated** step -- it is not run as part
of this PR and cannot be exercised in a dev sandbox (`POST /admin/datasets/import` and the
retry engine both 403 outside `ENVIRONMENT=production`).

## Prerequisites

- Phase 5 (this PR) merged to the epic branch and the epic branch deployed to production.
- `nemar auth login` as an admin/owner against the production API.
- `gh auth status` authenticated with access to `nemarDatasets/.github` (workflow dispatch).

## Sequence

1. **Dry run first.**
   ```
   nemar admin recover --all
   ```
   Confirms the 45-target resolution and prints the per-dataset plan. No network mutation.

2. **Execute.**
   ```
   nemar admin recover --all --execute
   ```
   For each of the 45: forces `POST /admin/imports/:id/verify` (reclassifies a stale
   `complete` `import_jobs` row to `incomplete`; a direct re-dispatch onto a `complete`
   row would silently no-op the status callback -- see `import-state.ts`'s monotonic
   `WHERE status NOT IN ('complete','rolled_back','quarantined')` guard). Then dispatches
   ONE `gh workflow run onboard-openneuro.yml --repo nemarDatasets/.github` for the whole
   batch (the hardened prepare/copy/finalize matrix from Phases 1-3).

3. **Watch the workflow run.**
   ```
   gh run list --repo nemarDatasets/.github --limit 5
   ```
   or the Actions tab for `onboard-openneuro.yml`. The batch fans out per-dataset
   prepare/copy/finalize jobs; expect this to take a while (45 datasets, S3-side copy).

4. **Watch remediation converge.**
   ```
   nemar admin recover status --all
   ```
   Reports each target's `data_complete`/`bytes_present` from the catalog (Phase 3's
   completion oracle). Re-run periodically until all 45 show `complete`. Do NOT read
   `nemar admin import status` alone as ground truth here -- treat `datasets.data_complete`
   as authoritative, not `import_jobs.status` (see the reclassify-first rationale above).

5. **Acceptance audit.**
   ```
   nemar admin data-integrity-sweep --older-than 0
   ```
   Forces a re-check of every row already stamped by the incident-discovery sweep
   (including the 45 just recovered), so a dataset that reports `data_complete=1` via
   `recover status` is also confirmed by the independent fleet-wide per-key audit.

6. **Confirm.** All 45 `data_complete=1` in both `recover status --all --json` and the
   `data-integrity-sweep` output. If any target is still incomplete after the workflow run
   finishes, check `nemar admin import status <id>` for `last_error` / `recovery_attempts`;
   the Phase 2 retry engine will keep retrying automatically, or re-run step 2 for the
   stragglers (`nemar admin recover <id> --execute`).

## Non-goals

- This runbook does not cover the 11 datasets in `scripts/withdrawn-datasets.json`
  (Phase 4 withdrew those; their upstream is not accessible).
- No new copy/retry/audit logic exists for Phase 5 -- steps 2-5 above are pure reuse of
  Phases 1-3's already-deployed, already-tested machinery.
