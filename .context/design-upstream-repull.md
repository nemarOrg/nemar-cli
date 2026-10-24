# Design record: upstream re-pull as a major version (epic #1046)

Status: design for epic #1046, 2026-10-23.
Binding text is ADR 0006 and ADR 0111 (Phase 1); this document is the analysis behind them.
Where this file and an ADR disagree, the ADR wins.

Owner refinements of 2026-10-23 are applied throughout:
2.0.0 is a pure mirror, NEMAR's non-conflicting corrections replay as 2.0.1, and the Worker may merge under a machine definition of clean.

## Facts the design rests on

- The importer is `src/lib/import-openneuro.ts` (`prepareImport`, copy, `finalizeImport`).
  It clones `OpenNeuroDatasets/<id>` at the default HEAD, with no tag argument.
- `POST /datasets/import` returns 409 when the dataset or repo exists; the CLI treats that as non-fatal (the idempotent retry path).
- Step 4c of prepare runs `git reset --hard origin/main` when origin has a main, under a documented same-version assumption (#993).
  A second import therefore keeps NEMAR's old tree while the copy manifest comes from the new upstream `whereis`.
- Copy is server-side S3 copy by key, skips present objects, 8 shards.
- `finalizeImport` skips publication and approval when the dataset is already public (#985).
- No importer step sets `Version`; publication reads `dataset_description.json` `Version`, default 1.0.0.
- Version DOIs are minted by EZID (ADR 0007) from a tag push: webhook, `run-version-doi`, `callbacks/version-doi.ts` (accepts `^\d+\.\d+\.\d+$`).
- `nemar dataset release --type major` edits `Version` on a `release/vX.Y.Z` branch and opens a PR.
  `version-check` requires a strict increment over main; PR merge tags and releases.
- Public repos protect main: PR, version check, non-fast-forward (ADR 0001); tags are CI-owned (ADR 0016).
- `datasets` has `source`, `source_id`, `concept_doi`, `latest_version_doi` and no `source_version`.
  The column budget test pins 84 columns, cap 97 (ADR 0034).
- `dataset_versions(dataset_id, version, doi, provider, ...)` is `UNIQUE(dataset_id, version)`.
- `import_jobs` is one sticky row per dataset with terminal statuses complete, rolled_back, quarantined.
- Discovery (`openneuro-discovery.ts`) already fetches `latestSnapshot.tag` and discards it; `diffNewDatasets` is id-only.
- `AUTO_IMPORT_ENABLED` is "true" in production (`backend/wrangler-sccn.toml`), so discovery must stay id-only.
- Verified on `on003645`: upstream's 2.0.2 commit is not in NEMAR's repo (an early import rewrote every commit), so there is no shared ancestry; trees compare equal to upstream 2.0.2 plus `.github/`.
- Upstream's `s3-PUBLIC` remote is versioned and `.log.rmet` stores a versionId per key; `parseS3Url` drops the query string, so today's copy takes the current object at the path, not the pinned version.
- `run-identifier-screen.yml` accepts a `ref` input; its callback is bound to `publication_requests.id`.
- ADR 0107 exempts a PR opened under an owner's or administrator's own GitHub login; a PR opened by the App is not exempt.

## 1. Mechanism

Replay the upstream delta (`from_tag..to_tag`) onto NEMAR `main` as one synthesized commit.
A git merge is rejected: no shared ancestry, and it would push unscrubbed upstream history.
Replacing the whole tree is rejected: it discards NEMAR edits and re-scrubs unchanged recordings, which breaks ADR 0091 (nothing already published is changed).

Working copy: clone `nemarDatasets/<id>` at `main` (so `enableremote nemar-s3` reuses the bucket's UUID, avoiding the #1320 failure), plus metadata-only clones of the upstream repo at `from_tag` and `to_tag`.

Starting point check: upstream-owned paths on `main` must equal upstream at `from_tag`, apart from differences a standard edit explains; otherwise refuse.

Three-way decision per path (base = upstream at `from_tag`, theirs = upstream at `to_tag`, ours = NEMAR `main`):

- ours equals base, or equals a standard edit applied to base ("explained"): take theirs and apply the standard edit to it.
- ours has an unexplained change and theirs differs from ours: conflict.
- path untouched upstream: keep ours.

Version policy on top of that (owner, 2026-10-23):

- The 2.0.0 mirror takes upstream for every conflict, so a re-pull never blocks.
- NEMAR's unexplained changes to upstream-owned paths that upstream did not touch are replayed as the stacked 2.0.1 PR, opened with the 2.0.0 PR and merged right after it so the public latest never lacks the corrections for long.
- Conflicting corrections are listed for an administrator and stay out of 2.0.1 until resolved.
- A version row with `source_version` set and version `N.0.0` is a mirror; the API exposes this derived flag and the website shows a mirror tag.

NEMAR owns always: `.nemar/**` and `.github/**` (the OpenNeuro related identifier in `.nemar/metadata.json` is rewritten to the new DOI).

`dataset_description.json` merges field by field:

- NEMAR owns `DatasetDOI` (concept DOI) and `Version` (the next major, or the patch for the 2.0.1 stack).
- The `SourceDatasets` entry for this ds is replaced by `{DOI, URL, Version: to_tag}`; other entries are kept from both sides.
- Every other key is upstream-owned and merged three-way.

Standard edits, re-applied as functions rather than merged as text:

- README rename and DOI badge (`planReadmeBadgeCommit`);
- the `.nemar/` line in `.bidsignore`;
- `applyNemarAnnexPolicy` on `.gitattributes` (ADR 0060);
- moving git-resident data into the annex;
- the ADR 0089 scrub and its provenance sentence;
- ADR 0091 date normalization (new and changed recordings only).

"Explained" is checked mechanically: a scrubbed key is explained when NEMAR's git-annex branch marks the upstream key dead; a file moved into the annex is explained when its key hashes the base blob.
`CHANGES` is upstream-owned; NEMAR never writes it.

Scrub and annex normalization run on delta paths only, before the commit, so unscrubbed bytes never enter NEMAR history (this removes ADR 0089's forward-fix hold for re-pulls).
The copy manifest is the keys the new tree names that are not present and not dead, written to `<id>/staging/repull-<tag>.json`.
Each copy item carries its versionId and the copy pins it; an item without a versionId is refused, never copied by path.
Prior-version objects stay (governance lock); the old version's manifest, DOI and routes are unchanged.
An abandoned re-pull leaves locked orphan objects; the plan states their size.

After merge: the push triggers Zarr conversion and enrichment; the tag triggers version-DOI, then manifest, summary and records, then the archive (which retires the previous zip under existing policy).
The release callback also queues one ADR 0023 reconcile (`--clean`, not `--wipe`) so stores for deleted recordings go, and re-arms the hed, channel-montage, data, availability and identifier stamps.

## 2. Landing path

- Always a PR, never a bypass. Branch `release/v<N+1>.0.0`, so the webhook's enrichment on release branches gives the tag a fresh `.nemar/metadata.json`.
- Version = next major of the highest of: `dataset_versions` rows, `v*` tags, `Version` on main. Refuse if another release PR is open or the three disagree.
- Manual path: the administrator's machine pushes the branch and opens the PR under their own login (ADR 0107 review `skipped`).
- Gates before merge: BIDS validation and `version-check` (required), and the identifier screen dispatched with `ref=<head sha>` and a callback bound to the re-pull row; it must be clear or carry a recorded administrator acknowledgment (ADR 0086).
- Merge: manual through `nemar admin repull <id> --merge` (claims the daily DOI budget, requires `clean`) or `nemar admin pr-reviews`; automatic merge by the Worker only under the machine definition below.
- After merge nothing changes: run-pr-merge tags, the tag webhook, run-version-doi, EZID; the DOI carries IsDerivedFrom `openneuro.<ds>.v<tag>` because the mint reads `SourceDatasets` at the tag.

Machine definition of clean (Worker merge, ADR 0111 amends ADR 0093 for this PR class only):

- the plan had zero unexplained paths against the pure-mirror rule (and the 2.0.1 PR zero conflicts);
- the identifier screen is clear (never `unchecked`);
- BIDS validation and `version-check` are green;
- the PR head equals the screened SHA;
- the daily merge cap is not exhausted.

Open check before building the merge call: whether the rulesets let the GitHub App merge without a human review.

## 3. State, idempotence, resumability

- Unit of work: `(dataset_id, to_tag)` in a new `upstream_repulls` table, not `import_jobs` (its sticky row, `preparing` reset, 6-hour sweep and retry engine would treat a re-pull as a broken import).
- Columns: `from_tag`, `to_tag`, `from_version`, `to_version`, `base_sha`, `plan_digest`, `branch`, `pr_number`, `head_sha`, `status`, counts, `last_error` (via `import-error.ts`, ADR 0051), `workflow_run_url`.
- `UNIQUE(dataset_id, to_tag)` plus a partial unique index allowing one non-terminal row per dataset.
- States: planned, prepared, copied, registered, pr_open, gates_clear, merged, released, complete; terminal: abandoned, failed, superseded (a newer tag arrived before merge: close the PR and plan again from the same `from_tag`).
- Every step checks its own end state first: `dataset_versions` already has `source_version = to_tag`; the branch exists with trailers `Upstream-Snapshot: ds003645@2.1.0` and `Repull-Plan: <digest>`; copy skips present objects; registration and the annex push are idempotent; the PR is found by head branch; the tag exists; the DOI row exists.
- `--execute` needs the digest of the reviewed plan; if main moved since the plan, plan again unless the new commits touch only `.nemar/**`.
- `--resume` continues from the recorded status; `--abandon` closes the PR, deletes the branch and reports orphan bytes.
- The retry engine reads only `import_jobs`, which a re-pull never writes.
- The import path gets the #993 guard: Step 4c refuses with `[openneuro-upstream-moved]` when the tag being imported differs from the tag `origin/main` mirrors; the classifier gets cause `upstream_moved`; the retry engine parks it like `identifier_scrub_refused`.
- For #1320, the plan's preflight compares the bucket `annex-uuid` with the nemar-s3 UUID in the git-annex branch and refuses, naming both.

## 4. Where the upstream tag is recorded

- `dataset_versions.source_version` and `source_version_basis` (`doi`, `lineage`, `unknown`; NULL = never examined).
- The dataset-level mirrored tag is derived: the `source_version` of the highest-semver version row. `datasets` stays at 84 columns.
- Written when the version row is inserted, from the tagged `dataset_description.json` the version-DOI callback already reads.
- One shared parser `sourceSnapshotOf(desc, sourceId)`: reads `Version`, then a DOI matching `10.18112/openneuro.<ds>.v<tag>`, then the URL; accepts only entries naming the dataset's own ds; disagreement gives unknown.
- Backfill of the roughly 900 mirrors: one resumable pass reads `v<version>/dataset_description.json` through the authenticated raw CDN (no REST quota); no match is `unknown`, never guessed; import-date versus snapshot-date appears in the report only as "probably stale"; the `lineage` check (tree equality outside NEMAR's paths) runs only inside the plan.
- First imports clone at the discovered tag (`--tag`) and write the `SourceDatasets` entry including `Version`; a tag not yet on the GitHub mirror refuses with `[openneuro-mirror-lag]`, transient and retried.
- Staleness predicate: public, mirrored tag known, and `latestTag` differs. Tags compare numerically component by component (legacy tags like `00001` too). Newer upstream is `stale-ready` if the tag answers on the mirror's raw CDN, else `mirror-lag`; older or unparsable upstream is an anomaly, reported only. Other states: unknown, unpublished, in-progress, parked.

## 5. Safety and gates

- `AUTO_REPULL_ENABLED` (opens PRs; off when absent; production-only through the scheduled allowlist) and `AUTO_REPULL_MERGE_ENABLED` (Worker merge), both default off.
- `REPULL_DAILY_OPEN_CAP` default 2; `REPULL_DAILY_MERGE_CAP` default 5, claimed by the backend before any merge, manual ones included, because every merge mints an irreversible DOI.
- `nemar admin repull <id>` is a dry run by default; `--execute` requires `--plan <file>`.
- Outside production the routes refuse any dataset that is not `xx` (the GitHub org is shared); mail goes through the admin-only fence.
- `diffNewDatasets` stays id-only so the live auto-import never sees stale mirrors.

Gates before the automatic path:

- G1: source_version live and backfilled; the share of unknown tags is known.
- G2: the staleness report is live and the measurement is done (stale counts per state; files added, changed, deleted; bytes to copy; metadata-only versus data-changing; conflict and unexplained counts from batch dry runs; DOI volume from GraphQL `snapshots{tag created}` over twelve months under one re-pull per snapshot and under at most one per 30 days, counting 2.0.1 patches).
- G3: the owner has reviewed dry-run plans for on003645 and on004362.
- G4: on003645 executed, then on004362; the 2.0.0 DOI resolves with IsDerivedFrom and 1.0.0 still serves. These production runs are deferred until everything is built and ds003645 2.1.0 is on the GitHub mirror (owner, 2026-10-23); if it is still missing, run on004362 first.
- G5: the owner sets the caps from the measured estimate and turns the flags on.

The automatic path takes only plans with zero conflicts and zero unexplained paths.

## 6. Least certain, and the cheapest experiment

- Detecting "explained" edits on early rewritten imports: local dry-run plans for on003645 and on004362, count unexplained paths.
- Whether the object at an OpenNeuro S3 path lags the pinned versionId: for keys that changed in ds004362 1.0.1, compare versionIds from `whereis` with the current object versions (anonymous HEAD).
- BIDS validation on the new tree (ds004362 1.0.1 has 2 errors upstream): run the pinned validator on dry-run output.
- Release-branch enrichment commits invalidating the screen's head: read `run-enrichment`, then rehearse on an `xx` fixture in dev.
- Zarr dropping stores for deleted recordings without `--clean`: read `generate_zarr.py`.
- #1320 on the test datasets: compare `s3://nemar/on003645/objects/annex-uuid` with `remote.log`.
- Raw-CDN behavior at fleet scale: run the backfill as a dry run over 50 rows.
- Not verified: whether rulesets restrict the merge method or let the App merge; the exact insert site of `source_version` under the central manifest flow; whether OpenNeuro writes S3 before or after it pushes to GitHub.

## 7. Phases

See the epic body of #1046.
Dependencies: 2, 3 and 5 are independent after 1 (5 needs 2's parser); 4 follows 2; 6 follows 5; 7 follows 4 and 6; 8 follows 4 and 6.
Next free ADR is 0111; next migration was 0100 on 2026-10-23 (recheck `origin/dev`).
