# Phase 2 — Consistent retry engine + blocklist + OpenNeuro maintainer report


> **STATUS: HISTORICAL.** Phase plan for #975, now shipped.
> Current decisions live in [`.context/decisions/`](decisions/README.md); where this document and an ADR disagree, the ADR wins.

Epic #967 (OpenNeuro import integrity & recovery). Phase issue #969. Branch
`feature/issue-969-phase2-retry-engine` off the epic branch.

## Goal

Build a self-healing retry subsystem for OpenNeuro imports that:

1. Discovers every incomplete import (not just `failed`): `quarantined`, `failed`,
   AND the falsely-`complete` rows whose S3 objects are missing/0-byte.
2. Retries the copy on a paced, capped, ~2-week window by RE-DISPATCHING the
   existing `onboard-openneuro.yml` (server-side S3 copy in GitHub Actions).
3. Sends public-but-403 (upstream-inaccessible) datasets to a **blocklist** and
   emails an OpenNeuro maintainer report once, then keeps a slow re-check so access
   restoration auto-resumes the import.

Prod is already mitigated (`AUTO_IMPORT_ENABLED=false`, PR #966). This phase builds
the MECHANISM; Phase 5 runs it on the real backlog; Phase 3 surfaces completeness on
the website; Phase 4 withdraws the permanently-broken ones.

## Non-negotiable context

- **Execution env: GitHub Actions only.** The copy is a server-side S3 copy
  (`batchServerSideCopy`), so the runner never streams bytes. The onboard workflow
  already carries `AWS_ACCESS_KEY_ID/SECRET`. The retry engine is a Worker cron that
  dispatches `onboard-openneuro.yml` via `triggerOpenNeuroOnboard` — it does NOT copy
  anything itself and there is NO Hallu path.
- **Prod-only cron job.** The retry sweep dispatches GitHub work against the shared
  `nemarDatasets` org and can email, so it belongs in the `if (prodOnlyJobs)` block of
  `scheduled()` (backend/src/index.ts ~:746). A new daily job is prod-only by default
  (see the allowlist comment there). Add early `return` guards inside the service too
  (defense-in-depth, mirroring `archiveRetrySweep`/`reconcileReservedVersionDois`).
- **Build on existing signals.** `upstream_inaccessible` quarantine reason and
  `OPENNEURO_UPSTREAM_MARKER` (`[openneuro-upstream-inaccessible]`) already exist in
  `import-recovery.ts`; the blocklist keys off them. `auto_attempts` already exists
  (migration 0047). Do not invent parallel vocabulary.
- **No mocks** (real tests only). No emojis. Backend imports `shared/` so run
  `bun install` at BOTH repo root and `backend/` before typecheck.

## Schema — migration `0058_import_retry_blocklist.sql`

Additive `ALTER TABLE import_jobs` only (plain ADD COLUMN; not FTS-backed, not in any
trigger — same note as 0047). Add:

- `recovery_attempts INTEGER NOT NULL DEFAULT 0` — retry-engine dispatch counter
  (distinct from `auto_attempts`, which is the discovery-tick counter).
- `first_incomplete_at TEXT` — when this row first entered an incomplete/failed state
  under the engine; the anchor for the 2-week window. Set once, never overwritten while
  incomplete; cleared on return to healthy `complete`.
- `next_retry_at TEXT` — earliest time the engine may re-dispatch (backoff).
- `blocklisted INTEGER NOT NULL DEFAULT 0` — 1 = parked as upstream-inaccessible.
- `blocklist_reason TEXT` — e.g. `upstream_403_after_window`, `no_source`.
- `maintainer_notified_at TEXT` — set when the OpenNeuro report email was sent (once).
- `integrity_checked_at TEXT` — last time the Worker re-verified this row's S3 per-key
  (NULL = never; drives the bounded reclassification sweep below).

Add a new status token `incomplete` to `ImportStatus`/`IMPORT_STATUSES` in
`import-recovery.ts` (status is plain TEXT, no CHECK constraint — safe). Meaning:
"the import row exists and reached `complete` once, but S3 is missing keys; needs
re-copy." It is NON-terminal (the engine retries it). Update `TERMINAL_IMPORT_STATUSES`
only if needed (it stays `complete|rolled_back|quarantined`; `incomplete` is not terminal).

Extend `backend/test/auto-import.test.ts` (or a new `import-retry.test.ts`) with a
migration test that runs 0058 and asserts the columns exist and default correctly.

## Core primitive — `verifyImportS3(env, datasetId)` (Worker-side, cheap)

Given a dataset, decide whether its S3 content is complete WITHOUT downloading anything:

1. Read the version manifest (the key→size map). Prefer the published version manifest
   at `s3://<bucket>/<id>/version/v<latest>.json`; if absent, fall back to listing
   `<id>/objects/`. (Confirm the manifest shape/path from `services/s3.ts` +
   `dataset-metadata` code; reuse `annexKeyDeclaredSize` from Phase 1's
   `src/lib/s3-server-copy.ts` if importable, else port the parser.)
2. `ListBucket` `<id>/objects/` once (paginated) into a `Map<key, size>`.
3. Return `{ complete: boolean, missingKeys: string[], zeroByteKeys: string[],
   expectedCount, presentCount }` using per-key declared-size comparison (a key present
   but at the wrong/0 size counts as MISSING — the exact bug this epic fixes).

This is the same per-key logic as Phase 1's `isKeyPresentAtDeclaredSize`, applied
Worker-side against a listing. Keep it in a new `backend/src/services/import-integrity.ts`.
Phase 3's general `data-integrity-sweep` endpoint will reuse this primitive.

Unit-test the pure comparison (given manifest + listing → missing/zero/complete) with
real fixtures, no network.

## Reclassification sweep (bounded, resumable) — feeds the retry engine

The 56 falsely-`complete` rows must be discovered generally, not from a static list.
Each retry tick, BEFORE retrying, re-verify up to `RECLASSIFY_BATCH` (e.g. 10) `complete`
import rows with `integrity_checked_at IS NULL` (oldest `updated_at` first):

- Run `verifyImportS3`. Set `integrity_checked_at = now`.
- If incomplete → flip `status='incomplete'`, set `first_incomplete_at = COALESCE(existing, now)`,
  `next_retry_at = now` (eligible immediately), write `audit_log` (`import_reclassified_incomplete`).
- If complete → leave `status='complete'`, clear any stale incomplete markers.

Bounded per tick so a run is cheap; resumable via `integrity_checked_at`. Over a few
days every `complete` row is checked once; thereafter only newly-completed imports need
a check (set `integrity_checked_at` on the happy-path finalize too, so the sweep never
re-walks healthy rows — OPTIONAL, or just let NULL rows drain once).

Also provide an on-demand admin path (below) so an operator can force-verify a dataset.

## Retry engine — `sweepImportRetries(env)` in `import-retry.ts`

Prod-only cron sweep. Pure decision functions separated from I/O and exhaustively
unit-tested (mirror `pickNextDataset`/`decideAutoImportGate` in `auto-import.ts`).

Constants (exported for tests):
- `RETRY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000` (~2 weeks).
- `RETRY_BACKOFF_MS` — exponential-ish per attempt, e.g. `min(6h * 2^(n-1), 48h)`.
- `MAX_RECOVERY_DISPATCHES_PER_TICK` (e.g. 3) — pace GitHub dispatch; avoids the
  secondary-rate-limit trap (see memory `bulk_approval_rate_limit`).
- `BLOCKLIST_RECHECK_MS` (e.g. 3 days) — slow re-verify cadence for blocklisted rows.

Candidate query: `status IN ('incomplete','failed','quarantined')` AND `blocklisted=0`
AND (`next_retry_at IS NULL OR next_retry_at <= now`). Exclude `rolled_back` and `complete`.
Skip `quarantined` rows whose reason is a NEMAR-bug class you don't want auto-retried —
scope the auto-retry to import-data-missing causes (`upstream_inaccessible`,
copy/finalize failures, and the reclassified `incomplete`). A `quarantined` row that is
`has_doi`/`made_public`/`system_owned` is a human-review case: DO NOT auto-retry; leave it.

Per eligible candidate, decide:

1. **Verify current state first** (`verifyImportS3`). If now complete (upstream came
   back, a prior dispatch landed): mark `status='complete'`, clear `first_incomplete_at`,
   `blocklisted`, `next_retry_at`; audit `import_recovered`. Done — no dispatch.
2. Else if `first_incomplete_at` is older than `RETRY_WINDOW_MS` AND the last failure was
   upstream-inaccessible (marker in `last_error`, or a fresh HEAD/GET of one missing
   OpenNeuro object returns 403): **blocklist it** — set `blocklisted=1`,
   `blocklist_reason='upstream_403_after_window'`, enqueue for the maintainer report,
   audit `import_blocklisted`. Stop dispatching; it moves to the slow re-check lane.
3. Else (still inside the window, or a non-upstream failure): **re-dispatch**
   `onboard-openneuro` for its `source_id` via `triggerOpenNeuroOnboard`; bump
   `recovery_attempts`, set `next_retry_at = now + backoff(recovery_attempts)`,
   `first_incomplete_at = COALESCE(existing, now)`, audit `import_retry_dispatched`.
   Respect `MAX_RECOVERY_DISPATCHES_PER_TICK`.

Blocklisted rows: on their own slow cadence (`BLOCKLIST_RECHECK_MS`), re-run
`verifyImportS3`; if complete → recover (un-blocklist, `complete`). This is the
"auto-resume on access restoration" the user asked for.

## Idempotent re-dispatch (substrate)

Re-dispatching `onboard-openneuro` for an already-imported dataset must be a clean retry,
not quarantine noise. Make the CLI `--phase prepare` idempotent in
`src/lib/import-openneuro.ts`:

- If the NEMAR dataset record + GitHub repo already exist, REUSE them (do not error).
  The `POST /admin/datasets/import` 409 path is fine server-side (the row/repo exist);
  prepare must treat "already exists" as success and continue to (re)build the manifest
  and ensure `main` is pushed, rather than aborting.
- Rebuild the key→source manifest deterministically from the OpenNeuro clone (so a retry
  works even if the staged manifest was cleaned).
- Add golden/unit coverage for the "second prepare on an existing dataset" path.

Minimal `onboard-openneuro.yml` template change if needed (e.g. a comment; ideally no
behavior change since the CLI now self-heals). If the workflow needs a `mode` input,
keep it backward-compatible. NOTE: the deployed copy lives in `nemarDatasets/.github`;
this repo only holds the template — flag any workflow edit as a cross-repo deploy in the PR.

## Blocklist + OpenNeuro maintainer report (email)

- Blocklist = `import_jobs WHERE blocklisted=1`. Expose via `GET /admin/imports?blocklisted=1`
  (extend the existing list route) and in the CLI `import status` output.
- Email: new `sendOpenNeuroMaintainerReport(recipients, datasets[], ...)` in
  `services/email.ts`, mirroring `sendImportQuarantineEmail`. Content: the list of
  public-but-403 source datasets (`ds######`), when first seen, attempts, and a request
  to restore anonymous read access. Recipient is env-driven:
  `OPENNEURO_SUPPORT_EMAIL` (add to bindings + wrangler-sccn.toml, prod only).
- **Human-in-the-loop gate.** Sending mail to an external party must not fire silently.
  Gate the actual send behind `OPENNEURO_MAINTAINER_EMAIL_ENABLED='true'` (default unset
  → DRY RUN: compute + audit-log the report, set `maintainer_notified_at` only on real
  send). Send at most once per dataset (`maintainer_notified_at IS NULL` guard). The
  operator flips the flag / reviews the first batch. Document this in the PR.
- Prefer batching: one report email per sweep covering all newly-blocklisted datasets,
  not one per dataset.

## Admin surface (CLI + routes)

- Extend `GET /admin/imports` with `?blocklisted=` and include the new columns
  (`recovery_attempts`, `first_incomplete_at`, `next_retry_at`, `blocklisted`,
  `blocklist_reason`, `maintainer_notified_at`, `integrity_checked_at`) in the row shape
  and `by_status` (add `incomplete` to the status enum count).
- `POST /admin/imports/:id/verify` — force `verifyImportS3` now; flip to `incomplete` or
  `complete` accordingly. Lets an operator seed a specific dataset into the retry lane.
- CLI `src/commands/admin.ts`: `nemar admin import status` renders the retry/blocklist
  columns; add `nemar admin import verify <id>`. Keep `retry`/`rollback` working; `retry`
  should also reset `blocklisted=0`, `next_retry_at=now` so a manual retry un-parks.
- Update AGENTS.md's admin command list + the import section.

## Tests (real, no mocks)

- Migration 0058 applies; columns/defaults correct.
- `verifyImportS3` pure comparison: manifest+listing fixtures → missing/zero/complete
  (0-byte present key counts as missing; wrong-size counts as missing; declared-0 files
  are NOT flagged — mirror Phase 1's reorder fix).
- Retry decision functions: window boundary (13d29h vs 14d1h), backoff schedule, per-tick
  dispatch cap, blocklist transition, recover-on-verify-complete, blocklist slow re-check.
- Reclassification: a `complete` row with 0-byte objects flips to `incomplete`; a healthy
  one stays; `integrity_checked_at` advances; batch bound respected.
- Email dry-run: report computed + audited but no send when flag unset;
  `maintainer_notified_at` only set on real send; once-per-dataset guard.
- Idempotent prepare golden path (second prepare on existing dataset succeeds).
- Backend + CLI: `bun test`, `bunx tsc --noEmit` (root+backend installs), Biome clean.

## Explicitly OUT of scope (later phases)

- `data_complete` tri-state column + website/catalog "incomplete" surfacing + the general
  `admin data-integrity-sweep` endpoint → Phase 3.
- Making the 9 upstream-blocked + 2 no-source datasets private + EZID `_status=unavailable`
  → Phase 4.
- Actually running the engine on the real 45 source-accessible datasets + final per-key
  audit → Phase 5.

Phase 2 ships the engine dark-ish (prod cron present, but blocklist email behind a flag)
and unit-proven; it does not itself remediate the corpus.

## Deliverable

PR to the epic branch `feature/issue-967-epic-openneuro-integrity`, `Closes #969`,
`Part of epic #967`. Then `/review-pr` (sonnet) before squash-merge.
