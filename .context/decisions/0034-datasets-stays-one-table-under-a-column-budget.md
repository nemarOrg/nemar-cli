# ADR 0034: `datasets` stays one table, under an enforced column budget

**Status:** accepted
**Date:** 2026-09-01
**Owner:** Seyed Yahya Shirazi

## Context

D1 caps a table at 100 columns.
`datasets` reached 98 columns at migration 0070,
and the signal-defaults migration (five more columns) could not apply,
which blocked every deploy (#1182).
Local SQLite allows 2000 columns, so no local run ever reproduced the failure;
the cap was discovered at deploy time.
SQLite refuses `DROP COLUMN` on a CHECK-bound column,
and four of the six attestation columns carry CHECKs,
so no incremental `ALTER` could reclaim the space:
only a full table rebuild can.

## Decision

`datasets` remains the single table of record (reaffirming ADR 0003 and ADR 0024);
the cap is met by spending columns only on facts that cannot be derived at read time,
and the budget is enforced by a CI tripwire
(`backend/test/datasets-column-budget.test.ts` pins the count exactly
and caps it at 97), so the next over-budget migration fails in CI, not at deploy.

Migration `0071_reclaim_column_budget` rebuilds the table at 87 columns
(92 after the renumbered `0072_signal_defaults`):

- **Dropped, each with its derivation re-checked against all 789 production rows:**
  - `ezid_identifier`: equal to `'doi:' || UPPER(concept_doi)` in 768/768 rows,
    and no row had either value without the other;
    now composed by `conceptEzidIdentifier` (`services/ezid.ts`).
  - `doi_provider`: `'ezid'` in 789/789 rows (ADR 0007);
    reads collapse to the constant,
    and the admin concept-mint route rejects any other provider with 400.
  - `num_citations`: equal to `num_dataset_citations + num_datapaper_citations`
    in 789/789 rows; served as that SQL sum in every projection, sort, and facet.
  - `file_size_formatted`: derived at read time with `formatFileSize`
    (binary/1024, `services/dataset-metadata-columns.ts`),
    which was already the column's only writer —
    never `formatBytes` from `services/s3.ts` (decimal),
    which would silently shift every displayed size.
  - `uploader` and `zenodo_latest_version_id`: 0 non-null rows;
    the owner label is the joined `users.username`,
    and the Zenodo version pointer had no reader that survives ADR 0007.
- **Collapsed 6 → 1:** the attestation columns become one `attestation` JSON
  column (`CHECK (attestation IS NULL OR json_valid(attestation))`) with keys
  `deposit_type, key_status, deidentified, no_duplicate, upstream_source,
  accepted_at` (0/1 integers for the booleans).
  This AMENDS ADR 0024's storage without changing its decision:
  the attestation is still recorded on the dataset row at create time,
  NULL still means "no attestation on record",
  and the wire contract still serves the six flat fields —
  the detail route explodes the JSON back out, so clients are unaffected.
- **Kept deliberately:** `zenodo_concept_id` and its index
  (the doomsday backup reference, owner direction),
  and `metadata_columns_error` —
  0 rows because it is a FAILURE-ONLY channel
  (written by `services/enrich-dataset.ts` and `services/dataset-reindex.ts`
  when metadata-column writes fail), not dead.
  The 12 sweep bookkeeping stamps are untouched here; a follow-up PR owns them.

The rebuild's statement ordering is load-bearing and cascade-safe:
`datasets` has three FK children —
`access_requests` and `dataset_collaborators` (`ON DELETE CASCADE`, both keyed on
`datasets(id)`) and `dataset_versions` (NO ACTION), which is keyed on
`datasets(dataset_id)`, the TEXT natural key, not on `id`.
Two of the three are written `REFERENCES "datasets"` with quotes,
so a grep for `REFERENCES datasets(id)` finds only one of them;
migration 0026 documented this same trap already —
and `DROP TABLE` performs an implicit DELETE that fires CASCADE
even under `PRAGMA defer_foreign_keys`
(deferral postpones violation reporting, not the action).
So the children are rescued into plain tables and emptied before the drop,
and restored after the rename,
which is safe for either FK target because both `id` and `dataset_id`
are copied verbatim and unchanged.
Guard statements (`_rebuild_guard`, `CHECK (ok = 1)`) abort the migration
before anything destructive if a copy miscounts,
and `datasets.id` (sparse; production MIN 48, MAX 61277; the FTS5 rowid)
is copied explicitly so AUTOINCREMENT never reassigns it.

## Consequences

- Deploys unblock, and the budget is a reviewed number:
  widening `datasets` now requires consciously raising the pinned count,
  and passing 97 requires an ADR superseding this one.
- Derived serving means stale stored values can no longer disagree with their
  source: `file_size_formatted` rows that had drifted from `file_size`
  now display the correct size (a user-visible correction),
  and `num_citations` can never desync from its addends.
- Undeclared passthrough fields disappear from `GET /datasets/:id`
  (`doi_provider`, `ezid_identifier`, `zenodo_latest_version_id`, `uploader`);
  nothing in the declared contract changes.
- Rollback is asymmetric after the migration applies:
  old worker code writes columns that no longer exist,
  so a code-only revert is impossible — recovery is restore-from-backup
  (ADR 0004) plus re-applying the pre-rebuild schema.
- The retired zenodo mint/publish branches are now unreachable
  (provider is constant); they remain in place for a follow-up removal
  rather than growing this change.

## Alternatives considered

- **Split `datasets` into side tables (a `dataset_stats` or `attestations`
  table).** Rejected: ADR 0003's single-table decision is load-bearing for
  the catalog read path and FTS; a second table reintroduces the drift class
  the consolidation removed, for the same sub-100 total.
- **Drop only the six zero-reader columns and keep the attestation columns
  flat.** Rejected: that lands at 92 before signal defaults and 97 after,
  leaving no headroom; the attestation collapse is what buys a usable budget.
- **Store the attestation as six JSON-in-one-TEXT flat wire fields (no
  explode).** Rejected: it changes the declared detail contract
  (`shared/contract/dataset.ts`), which this change must not.
- **`ALTER TABLE ... DROP COLUMN` incrementally.** Impossible: SQLite refuses
  DROP COLUMN on CHECK-bound columns, which four attestation columns are.

## Receipts

- #1182 (the cap incident), PR: "Rebuild datasets as a narrower table".
- Derivations verified live against production D1 (789 rows) before the
  migration was written; re-derive before trusting them at a later date.
- ADR 0003 (single table of record), ADR 0007 (EZID sole provider),
  ADR 0024 (attestation recorded, not assumed — storage amended here).
- `backend/test/reclaim-column-budget-migration.test.ts` (cascade-safe
  rebuild, mutation-proved) and
  `backend/test/datasets-column-budget.test.ts` (the budget tripwire).
