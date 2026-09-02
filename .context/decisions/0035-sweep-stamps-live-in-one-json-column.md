# ADR 0035: Sweep bookkeeping stamps live in one JSON column

**Status:** accepted
**Date:** 2026-09-01
**Owner:** Seyed Yahya Shirazi

## Context

ADR 0034 put `datasets` under an enforced column budget
and explicitly deferred the largest remaining reclamation:
the 12 sweep bookkeeping stamps
(`enrichment_updated_at`, `metadata_updated_at`, `archive_checked_at`,
`zarr_checked_at`, `records_checked_at`, `citations_updated_at`,
`channel_montage_checked_at`, `hed_checked_at`, `data_checked_at`,
`availability_report_at`, `recording_stats_at`, `signal_defaults_at`).
Unlike the attestation group 0071 collapsed,
these columns are filtered on directly:
every sweep selects its candidates with a predicate over its stamp,
and a wrong predicate does not error —
the sweep silently stops finding candidates,
or reprocesses the same rows forever, under a green cron log (#1183, the
#1184 failure mode).

## Decision

Migration `0073_collapse_sweep_stamps` collapses the 12 stamp columns into
one `sweep_stamps` TEXT column
(`CHECK (sweep_stamps IS NULL OR json_valid(sweep_stamps))`),
taking `datasets` from 92 columns to 81.
Keys are the old column names verbatim
(`$.archive_checked_at`, never a shortened form),
so the codebase stays greppable by stamp name.

**No rebuild was needed, unlike 0071:** none of the 12 carries a CHECK
constraint, none appears in any trigger, and only `zarr_checked_at` was
indexed (`idx_datasets_zarr_checked_at`, dropped —
at ~800 rows every sweep is a trivial scan either way),
so plain `ALTER TABLE ... DROP COLUMN` applies after dropping that index.
The backfill writes all 12 keys on every row,
JSON null where the stamp was NULL.

**Two conventions are BINDING for any future sweep stamp:**

1. **Candidacy reads through
   `json_extract(sweep_stamps, '$.<stamp>') IS NULL`.**
   json_extract returns SQL NULL for a missing key, an explicit JSON null,
   AND a NULL column (re-derived on the real engine, and pinned in
   `backend/test/collapse-sweep-stamps-migration.test.ts`),
   so all three shapes mean "never swept" —
   which is what makes the rewrite equivalent to the old `IS NULL`
   predicates. A new row starts at `sweep_stamps` NULL; a callback re-arms
   a sweep with `json_remove(sweep_stamps, '$.<stamp>')`.
2. **Every stamp write wraps the column in
   `COALESCE(sweep_stamps, '{}')`:**
   `json_set(NULL, ...)` returns NULL and silently discards the write,
   which would leave the row a permanent re-sweep candidate —
   reprocessed every run, forever, with nothing in the logs.
   Multiple stamps in one UPDATE nest:
   `json_remove(json_set(COALESCE(sweep_stamps, '{}'), ...), ...)`.

The stamps' `<` / `>` time comparisons keep working as string comparisons:
all 12 stamps hold `datetime('now')` output,
uniformly 19 characters `YYYY-MM-DD HH:MM:SS`
(verified across all 789 production rows before the migration was written),
and JSON round-tripping preserves the text byte-for-byte.
Any future stamp writer must keep writing `datetime('now')`-shaped values,
never ISO-8601 `T`/`Z` forms, or lexicographic order stops being
chronological for same-day values.

Because a wrong predicate fails silently, every rewritten candidate
predicate carries a test at the sweep's real entry point
(`backend/test/sweep-stamps-candidates.test.ts` plus the per-sweep suites),
each proved by mutating that one predicate and watching its own test fail;
sweep-write SQL that is only reachable behind a live S3/GitHub call is
exported as a named constant and pinned by importing the exact string.

## Consequences

- `datasets` lands at 81 columns — 16 clear of the 97 ceiling —
  and the budget pin in `backend/test/datasets-column-budget.test.ts`
  moves to 81.
- Adding a future sweep stamp no longer costs a column,
  but it MUST follow the two binding conventions above;
  a missed COALESCE is a silent, permanent re-sweep loop,
  not an error anyone will see.
- Stamp reads become marginally more verbose and are no longer indexable
  per-stamp; acceptable at the catalog's ~800-row scale, and the one
  stamp index that existed was dropped with its column.
- Rollback after the migration applies is asymmetric, as with 0071:
  old worker code writes columns that no longer exist,
  so recovery is restore-from-backup (ADR 0004).

## Alternatives considered

- **A `dataset_sweeps` side table (dataset_id, stamp, checked_at).**
  Rejected: reintroduces the drift class ADR 0003/0034 consolidated away,
  adds a join to every sweep's candidate query, and spends its win on a
  problem (per-stamp indexing) that does not exist at this scale.
- **Dropping only the least-used stamps and keeping the hot ones flat.**
  Rejected: buys back fewer columns while still forcing the JSON
  convention split-brained across two storage shapes.
- **Keys shortened (`$.archive` instead of `$.archive_checked_at`).**
  Rejected: breaks greppability by stamp name, which is how every
  cross-reference in this codebase finds the sweeps.

## Receipts

- #1183 (this collapse), #1182 / ADR 0034 (the budget that deferred it),
  #1184 (the silent-predicate failure mode this guards against).
- `backend/src/db/migrations/0073_collapse_sweep_stamps.sql`;
  `backend/test/collapse-sweep-stamps-migration.test.ts` (backfill
  round-trip, null-shape equivalence, COALESCE and time-format pins);
  `backend/test/sweep-stamps-candidates.test.ts` (per-sweep entry-point
  candidate selection, mutation-proved).
- The datetime-format uniformity and the no-CHECK/no-trigger/one-index
  facts were verified against live production D1 before writing the
  migration; re-derive before trusting them at a later date.
