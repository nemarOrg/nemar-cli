# Blast-radius audit — folding catalog-only rows into `datasets` (#646 Phase 1)

> Companion to `.context/research-catalog-consolidation.md`. Records every
> place that touches the `datasets` (or `users`) table and how it behaves once
> migration 0028 folds ~180 legacy catalog-only rows into `datasets` under the
> sentinel system owner.

## The discriminator

Folded rows are inserted with `owner_user_id = SYSTEM_USER_ID` (**-1**, see
`backend/src/lib/constants.ts`), `status='active'`, `visibility='public'`,
`is_sandbox=0`, and **no** `github_repo` / `dataset_versions` of their own.
Every fact comes from their old `nemar_catalog` row.

The one rule:

> A real **managed** dataset has `owner_user_id != SYSTEM_USER_ID` (a positive
> real user id). A folded **catalog** dataset has `owner_user_id =
> SYSTEM_USER_ID`. Any query that assumed "every `datasets` row is managed"
> must add the discriminator.

Phase 1 keeps `GET /datasets` and `GET /datasets/search` **byte-stable**: the
folded rows stay dormant (served exactly as before, from `nemar_catalog`)
until Phase 3 flips reads onto `datasets`.

## GUARDED IN PHASE 1 (would break / mislead without the guard)

| # | Site | Breakage if unguarded | Guard applied |
|---|------|------------------------|---------------|
| 1 | `routes/datasets.ts` public **managed** branch (`WHERE d.status=?`) | The 180 folded rows surface as `source_type='managed'` with `doi`=NULL (lost real `c.doi`), `owner_username='nemar-system'`, `source` flipped — and double-list against the catalog branch | `AND d.owner_user_id != ?` (param `SYSTEM_USER_ID`) |
| 2 | `routes/datasets.ts` **catalog-only** branch, both `NOT IN` dedup subqueries | A folded row's id is now an active dataset, so the first `NOT IN` would suppress its own `nemar_catalog` source row → the 180 vanish entirely | `AND owner_user_id != ?` added to **both** subqueries; `catalogParams` seeded `[SYSTEM_USER_ID, SYSTEM_USER_ID]` |
| 3 | `routes/admin.ts` `/admin/stats` `total_datasets` | `COUNT(*) FROM datasets` inflates by ~180 | `WHERE owner_user_id != ${SYSTEM_USER_ID}`; added a separate `catalog_datasets` count |
| 4 | `services/deletion.ts` `deleteDatasetCascade` | Admin DELETE on a folded id drops the projection (reappears next list) while firing a 404 GitHub delete | Refuse when the row's `owner_user_id === SYSTEM_USER_ID` |
| 5 | `services/catalog-from-local.ts` `syncCatalogFromLocal` (active+public SELECT) | Re-projects folded rows back into `nemar_catalog`, clobbering the real `uploader` with `nemar-system` (circular) | `AND d.owner_user_id != ?` |
| 6 | `index.ts` stale-`nm` cleanup cron | Defense-in-depth only — `visibility='private'` already excludes public folded rows | `AND owner_user_id != ?` (guards a hypothetical future private sentinel row) |
| 7 | **User-side:** broadcast recipients (`services/broadcast.ts:93` `status='approved'`), `approved_users` stat, admin-notify fan-out (`email.ts:130`) | The sentinel **user** row would be emailed / counted as a real approved user | Sentinel user created with `status='revoked'` in 0027 — excluded from every `status='approved'` enumeration with zero extra code |

## SAFE BY DESIGN (no change needed — documented so reviewers don't re-flag)

- **`routes/datasets.ts` `?mine` branch** — `WHERE d.owner_user_id = ?` binds the
  caller's real (positive) id; `SYSTEM_USER_ID = -1` can never match.
- **`routes/users.ts` `/users/me`** and **`routes/admin.ts` `/admin/users/:username`**
  dataset counts — scoped `WHERE owner_user_id = <real user id>`.
- **`services/dataset-reindex.ts` `runDatasetSync`** — throws `Dataset has no
  GitHub repository` (400) before doing anything; all folded rows have
  `github_repo IS NULL`, so they're rejected naturally.
- **`services/manifest-coverage.ts`**, **`services/doctor/checks/missing-manifest.ts`**
  — require `github_repo IS NOT NULL` and/or a `dataset_versions` join; folded
  rows have neither.
- **`routes/data.ts` `loadPublishedDataset`**, **`services/page-bundle.ts`** — keyed
  by `dataset_id`; a folded public row resolves but exposes only read-only
  metadata (no S3/repo), which is the intended end state.
- **Per-dataset admin ops** (DOI create, enrich, visibility, reindex) keyed by
  `dataset_id` — admins may legitimately inspect a folded row; only deletion is
  refused (#4).
- **`routes/webhooks.ts`** — triggered by GitHub Actions on a real repo; folded
  rows have no repo, so they never enter these paths.
- **Sandbox cleanup cron** (`dataset_id LIKE 'xx%'`) — prefix-filtered; folded
  rows carry `nm*`/`on*`/`ds*` ids.

## Notes for later phases

- **Phase 3** removes these dormancy guards when reads move onto `datasets`:
  the list collapses to a single SELECT with
  `source_type = CASE WHEN owner_user_id = SYSTEM_USER_ID THEN 'catalog' ELSE 'managed' END`
  and `owner_username = COALESCE(d.uploader, u.username)`.
- **Phase 6** (`DROP TABLE nemar_catalog`): revisit #4 — once the fold is the
  only copy, deleting a sentinel-owned dataset becomes a legitimate admin op
  and the refuse-guard should be relaxed.

## Summary

The two enumerated sections above cover the touch-points that matter: **7 sites
guarded in Phase 1** (6 dataset-side + 1 user-side via the `revoked` sentinel
status) and the ~11 sites that are safe by design. The single highest-risk site
is the list endpoint (#1/#2) — without it the fold is a visible wire regression
rather than a dormant expansion.
