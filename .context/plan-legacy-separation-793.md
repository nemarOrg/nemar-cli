# Epic: Complete separation from legacy nemar.org dataexplorer (+ DOI re-targeting)

> **Related decisions:** [ADR 0007 - EZID is the sole DOI provider](decisions/0007-ezid-is-the-sole-doi-provider.md).
> Note: the `ww2.nemar.org` forwarding described below is superseded — nemar.org now serves the browser directly (cutover 2026-07-31).

Issue: #793 (blocks #748). Drafted 2026-06-26.

## Goal / end state

Full, two-way separation between the new NEMAR system (`api.nemar.org`,
`ww2.nemar.org`, D1) and the legacy `nemar.org/dataexplorer` PHP site:

1. New system no longer indexes legacy `ds######` datasets (the broken #748
   search hits). Every `source='openneuro'` row is `on######`.
2. New system no longer pulls FROM or pushes TO the legacy dataexplorer DB.
3. Legacy dataexplorer DB no longer holds our `nm`/`on` records.
4. All DOIs (new + existing) point at the canonical `https://nemar.org/dataset/<id>`,
   forwarded to `ww2.nemar.org/dataset/<id>` until the main domain serves it natively.

Scope is the nemar.org dataexplorer coupling ONLY. SDSC Hallu data sync, S3,
Zarr, QA pipelines stay fully intact.

## Ground truth (prod D1, 2026-06-26)

- Datasets by kind/source: `on`/openneuro=401, `nm`/null=197, `ds`/openneuro=183.
- All 183 `ds` rows are `owner_user_id=-1` (system-folded shadows); 0 owned by
  real users; 0 have an `on` mirror yet. These are pure legacy-catalog shadows
  with no nemarDatasets repo / no S3 backing -> exactly the #748 broken hits.
- 181 rows carry `nemar_sync_status='synced'` (datasets we pushed INTO legacy).
- DOIs: 584 datasets with `ezid_identifier`; 598 version DOIs. **0 Zenodo** (EZID
  is sole provider). The extra `concept_doi` rows (767-584=183) are the `ds`
  shadows carrying their OpenNeuro DOI (NOT ours; untouched).
- Blast radius for DOI re-target: ~**1,182 EZID identifiers** (584 concept + 598 version).

## The two legacy couplings

- **Incoming (pull):** `.github/workflows/catalog-sync.yml` (cron `0 */4 * * *`)
  fetches `dataexplorer_dataset` from `nemar.org/api/dataexplorer/datapipeline/records`
  and POSTs to `/admin/catalog/sync` -> `catalog-sync.ts:upsertCatalogRecordsToDatasets`.
  This FOLDS the `ds` rows as `owner=-1`. Its `ON CONFLICT ... WHERE owner_user_id =
  SYSTEM_USER_ID` guard never clobbers managed `nm`/`on` rows -> safe to kill; only
  drops shadows. **This is what regenerates `ds` rows every 4 h.**
- **Outgoing (push):** `backend/src/services/nemar-sync.ts:syncDatasetToNemar`
  (delete-then-insert across 4 tables: `dataexplorer_dataset`, `_extra_dataset`,
  `_dataset_channel_count`, `_supplementary_dataset`). Auth via `NEMAR_USERNAME`/
  `NEMAR_PASSWORD`. Has a per-dataset DELETE (`deleteRecords`, line 200) -> reuse for purge.
  Callers: publish `sync_nemar` step (`admin.ts:4968`), version-DOI webhooks
  (`webhooks.ts:1107/1429/1724` -> `syncToNemarAfterVersionDoi`), reindex
  (`dataset-reindex.ts:336`), CLI `nemar admin sync run/status`
  (`src/commands/admin.ts:3001`, `src/lib/api.ts:2006/2014`), endpoints POST
  `/admin/datasets/:id/sync` + GET `/admin/sync/status`. Already skips `on*` datasets.

## DOI target inventory (legacy `dataexplorer/detail` -> canonical `/dataset/`)

Concept: `doi.ts:192`, `admin.ts:2127`, `admin.ts:2135`, `admin.ts:4575` (publish),
`admin.ts:4510` (+`4514` release-body link).
Version: `doi.ts:301`, `admin.ts:2200`.
Enrichment landing-link embeds: `llm-enrich.ts:372`, `enrich-dataset.ts:401`.
Zenodo path (`doi.ts:218`) sets NO nemar target (Zenodo self-hosts) -> unaffected.

New scheme:
- Concept DOI `_target` = `https://nemar.org/dataset/<id>`
- Version DOI `_target` = `https://nemar.org/dataset/<id>?v=v<version>` (ww2 already
  honors `?v=v1.1.0`; forwarder must preserve query string).

## Decisions locked (owner, 2026-06-26)

- Kill incoming catalog-sync entirely (auto-import #775 is the sole OpenNeuro source).
- Purge our `nm`/`on` rows from the legacy DB; leave the legacy site's own `ds` catalog.
- Scope = nemar.org dataexplorer only; keep Hallu/S3/Zarr/QA.
- Delete all 183 `ds` shadows now (fixes #748); not-yet-imported ones reappear as
  `on` when auto-import reaches them.
- Forwarder: SCCN owns the nemar.org zone; I add the CF redirect rule `/dataset/*`
  -> `https://ww2.nemar.org/dataset/$1` (preserve query), verify before DOI flips.
- Execution: full epic via /project:epic-dev; explicit go-gate before each prod mutation.

## Dependency spine (must hold)

1. Forwarder live + verified BEFORE any DOI flips.
2. DOIs re-targeted off `dataexplorer/detail` BEFORE purging our rows from legacy DB.
3. Incoming catalog-sync dead BEFORE deleting `ds` rows (else they re-fold in 4 h).

## Phases

### Phase 1 — DOI target builder -> canonical URL + forwarder
- Infra: CF redirect rule on nemar.org zone `/dataset/*` -> `ww2.nemar.org/dataset/$1`
  (301, preserve query). Verify `doi.org/<doi>` -> `nemar.org/dataset/<id>` -> ww2.
  (First confirm the zone is in the SCCN account.)
- Code: replace all `dataexplorer/detail?dataset_id=<id>` builders (see inventory)
  with canonical concept/version URLs. Deploy. New DOIs + enrichment mint canonical.

### Phase 2 — Bulk re-target ~1,182 existing EZID DOIs
- New gated admin op (`nemar admin doi retarget`, dry-run default): re-point each
  EZID `_target` (concept + per-version). Canary `nm000132` -> verify resolution ->
  batch with rate-limit + resumable/idempotent log. Reversible (target is mutable).

### Phase 3 — Kill both legacy couplings (code)
- Incoming: remove `catalog-sync.yml`, `/admin/catalog/sync`, `catalog-sync.ts`, fold path.
- Outgoing: remove `nemar-sync.ts` builder + all callers/endpoints/CLI. Extract a slim
  `legacy-purge.ts` (`getAccessToken` + `deleteRecords` only) for Phase 4.

### Phase 4 — One-time data purge
- Run legacy purge: delete our `nm`/`on` rows from the 4 legacy tables (181) ->
  verify `dataexplorer/detail` empty for our ids.
- Snapshot the 183 `ds` rows to a file, then delete from D1 (`datasets` +
  `dataset_versions`, `publication_requests`, `manifest_jobs`, `user_s3_permissions`)
  + Vectorize `deleteByIds`; FTS auto-cascades. Verify ww2 search clean. Fixes #748.

### Phase 5 — Retire ds code paths + cleanup
- Remove `legacy-purge.ts`; narrow id regexes `(nm|on|ds)`->`(nm|on)` (keep
  `lookupDatasetById` source_id fallback for bookmarked `ds` links); drop
  `NEMAR_USERNAME/PASSWORD` + `nemar_sync_*` usage (migration to drop columns +
  `catalog_sync_log`); guard/test asserting all `source='openneuro'` rows are `on%`;
  update AGENTS.md/CLAUDE.md. Cross-repo: drop the `LIKE 'on%'` observability
  special-case in nemar-observability.

## Risk / rollback

- DOI re-target: EZID `_target` is mutable -> fully reversible; mitigate mass error
  with canary + verify + resumable idempotent log.
- Legacy purge: deletes our rows from the legacy DB; re-syncable only while delete
  client exists (it does, Phase 4). Low risk (legacy site, being retired).
- `ds` delete: 183 broken shadows, re-creatable from OpenNeuro via auto-import;
  snapshot first; D1 also hourly-backed-up (#655).

## Verification gates

- P1: forwarder chain resolves for a sample id incl. `?v=`.
- P2: spot-check N DOIs via doi.org -> ww2.
- P3: deploy green; no remaining references to legacy endpoints; tests updated.
- P4: legacy detail empty for our ids; ww2 search returns no `ds`; #748 retest
  (`ww2.nemar.org/discover?q=p300+delorme`).
