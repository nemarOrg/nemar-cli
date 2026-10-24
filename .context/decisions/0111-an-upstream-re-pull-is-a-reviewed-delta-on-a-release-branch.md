# ADR 0111: An upstream re-pull is a reviewed delta on a release branch

**Status:** accepted
**Date:** 2026-10-23
**Owner:** Seyed Yahya Shirazi

Epic #1046, Phase 1 (#1907).
Amends [ADR 0006](0006-upstream-re-pull-is-a-major-version-bump.md): its policy stands (a re-pull is a major bump), and this record adds the mechanism and says what major and patch mean on a mirror.
Narrows [ADR 0093](0093-pull-requests-awaiting-approval-are-managed-from-one-admin-command-and-an-approval-is-the-administrators-own.md) in one aspect, the merge, for one class of pull request, the re-pull pull request the automatic path opened (decision 7); ADR 0107 already partially supersedes ADR 0093, and for every other pull request what remains of it stands.
Builds on ADR 0001 (published datasets are PR-only), ADR 0023 (`--clean` reconciles), ADR 0034 (the column budget), ADR 0060, ADR 0085, ADR 0086, ADR 0089 and ADR 0091 (what an imported tree goes through), and ADR 0053 and ADR 0054 (unknown is never zero).
The analysis is `.context/design-upstream-repull.md`; where it and this record disagree, this record wins.
Nothing in the Decision section is built yet: each rule there is designed here and built by the later phases of #1046, and its present tense states the rule, not today's behavior.
*Annotated 2026-10-24: decisions 4 and 10 are built, as their dated amendments below record; every other rule is still designed and not built.*

## Context

ADR 0006 fixed the policy for an upstream re-pull and left the machinery to epic #1046.
An imported mirror never re-enters candidacy: discovery parses `latestSnapshot.tag` into `DiscoveredDataset.latestTag`, which nothing reads or stores, and `diffNewDatasets` compares ids only.
Running the importer again is not a re-pull: `POST /admin/datasets/import` answers 403 outside production first, then 409 when the dataset or its repository already exists, prepare's step 4c resets onto `origin/main` under a same-version assumption (#993), so the copy manifest follows the new upstream while the tree stays NEMAR's old one, and finalize skips publication for a public dataset (#985).
Nothing records which upstream snapshot a version mirrors: the importer clones the default HEAD, no importer step sets `Version`, and neither `datasets` nor `dataset_versions` has a `source_version`.
*Annotated 2026-10-24: the importer now clones a pinned upstream tag and records it in `SourceDatasets` (see Amendment 2026-10-24).*
Early imports rewrote every commit, so on `on003645` NEMAR's history shares no ancestry with upstream's although the trees match upstream 2.0.2 plus `.github/`.
`AUTO_IMPORT_ENABLED` is `"true"` in production (`backend/wrangler-sccn.toml`), so nothing a re-pull needs may reach the auto-import's candidate set.
Measured staleness is real: `on004362` missed upstream's 1.0.1 metadata fix (#1810).

## Decision

Everything in this section is designed and not yet built.
*Annotated 2026-10-24: decisions 4 and 10 are built, as their dated amendments below record; every other rule is still designed and not built.*

**An upstream re-pull replays the delta between two pinned upstream tags onto NEMAR's `main` as one synthesized commit on `release/vN.0.0`, landed through a pull request; N.0.0 is a pure mirror of the upstream snapshot, and NEMAR's corrections follow as N.0.1.**

`from_tag` is the upstream tag NEMAR's latest version mirrors, the `source_version` of its highest version row (decision 4), and `to_tag` is the upstream tag being pulled; both are tags, never a branch head (decision 10).

### 1. N.0.0 is a pure mirror, and upstream wins every conflict

- The N.0.0 tree is upstream's tree at `to_tag` with NEMAR's standard edits applied, and nothing else outside the paths NEMAR owns.
- NEMAR owns `.nemar/**`, `.github/**`, and in `dataset_description.json` the keys `DatasetDOI` (the concept DOI) and `Version`, and the `SourceDatasets` entry naming this dataset's own `ds`, which becomes `{DOI, URL, Version: to_tag}`.
  Other `SourceDatasets` entries are kept from both sides, and every other key and path is upstream-owned.
  `CHANGES` is upstream-owned, and NEMAR never writes it.
- The standard edits are re-applied as functions, never merged as text: the README rename and DOI badge, the `.nemar/` line in `.bidsignore`, ADR 0060's annex policy, moving git-resident data into the annex, ADR 0089's scrub with its provenance sentence, and ADR 0091's date normalization.
- A change recorded in the dataset's privacy ledger (`.nemar/corrections.jsonl`, ADR 0085) is a standard edit: N.0.0 carries it, and a plan that would revert one refuses.
  A ledger line whose `action` is other than `import-scrubbed` (the importer's own line, which the delta scrub re-applies as a function) is a recorded correction.
  The ledger holds counts and no per-file list (ADR 0036), so a plan cannot tell which unexplained paths a recorded correction made, and it refuses rather than revert one: the refusal applies to a dataset whose ledger holds at least one recorded correction, to any plan for it with an unexplained path, and it has no override.
  This keeps ADR 0085's promise that a re-pull is scrubbed again and does not reintroduce what was corrected.
- Base is upstream at `from_tag`, theirs is upstream at `to_tag`, and ours is NEMAR `main`.
  An upstream-changed path is one that differs between base and theirs.
  A delta path is one the re-pull's commit adds or changes relative to ours.
  Delta paths are fixed from the pre-scrub plan, so the scrub that runs on them never changes which paths they are.
  A path present on one side only differs from that side.
- An unexplained path is an upstream-owned path where ours differs from base, ours is not a standard edit applied to base, and ours is not already theirs with the standard edits applied.
  "Explained" is checked mechanically: a scrubbed key is explained when NEMAR's git-annex branch marks the upstream key dead, and a file moved into the annex is explained when its key hashes the base blob.
- An unexplained path is a conflict when it is upstream-changed and a correction when it is not, so "zero unexplained paths" means no conflict and no correction.
- N.0.0 takes, per upstream-owned path:
  ours, when the path is neither upstream-changed nor unexplained, so no standard edit is run on it again;
  theirs with the standard edits applied, when it is upstream-changed and not unexplained;
  theirs with the standard edits applied, for a conflict, so a re-pull never blocks on one;
  and theirs with the standard edits applied, for a correction, which N.0.1 then replays.
- The conflict cases each take upstream's side in N.0.0, and the plan lists NEMAR's side for an administrator:
  upstream deleted a path NEMAR changed (N.0.0 deletes it);
  NEMAR deleted a path upstream changed (N.0.0 has upstream's new file);
  and both added a path with different content (N.0.0 has upstream's).
  A path NEMAR added or deleted that upstream did not change is a correction: N.0.0 follows upstream, and N.0.1 replays NEMAR's addition or deletion.
- A conflict stays out of N.0.1 until an administrator resolves it.
- Corrections replay as N.0.1, the next patch, in a second pull request that targets `main`.
  That pull request is opened at `patch_synthesized`, on the new `main` after N.0.0 is merged and tagged, and its gates are read on that commit; until then the `patch_*` columns (decision 3) are NULL and the plan lists the corrections.
  Both pull requests are squash-merged, as `y` in ADR 0093's `next` merges, so N.0.1 is synthesized on the new `main` (the corrections replayed onto N.0.0's tree) and never stacked by branch ancestry.
  A re-pull with no corrections opens no N.0.1.

### 2. The delta is replayed as one commit, through a pull request

- The plan compares base, theirs and ours per path (decision 1), on a clone of `nemarDatasets/<id>` at `main` (so `enableremote nemar-s3` reuses the bucket's UUID, avoiding #1320) and metadata-only clones of upstream at the two tags.
- The result is one commit on `release/vN.0.0`, carrying the trailers `Upstream-Snapshot: <ds>@<to_tag>` and `Repull-Plan: <digest>`.
  N is the next major after the highest of the `dataset_versions` rows, the `v*` tags and `Version` on `main`; the plan refuses when the three disagree or another release pull request is open.
  N.0.1's pull request is opened only after N.0.0's has merged, so the two are never open together.
- It lands through a pull request, never a bypass and never a direct push, and it is never a git merge of upstream's history: upstream's commits are not pushed to NEMAR.
- The scrub, the annex policy and the date normalization run on the delta paths only (decision 1), before the copy and before the commit.
  An object the copy writes is anonymously readable by key (ADR 0089), so nothing unscrubbed is copied into NEMAR's bucket, and nothing unscrubbed enters NEMAR's history.
  A recording the commit does not touch keeps its bytes and its key.
- `nemar admin repull <id>` is a dry run by default, and `--execute` requires `--plan <file>` with the digest of the reviewed plan; when `main` moved since the plan, it plans again and stops for review of the new digest, unless the new commits touch only `.nemar/**`.
- The merge goes through the existing release path: the existing dataset workflows tag the merge, the tag mints the version DOI through EZID (ADR 0007), and the DOI carries `IsDerivedFrom` `openneuro.<ds>.v<to_tag>` because the mint reads `SourceDatasets` at the tag.
- New behavior the build adds, because no callback does it today: after the tag, one ADR 0023 reconcile (`--clean`, never `--wipe`) is queued for the dataset, so the Zarr stores of deleted recordings go, and the dataset's hed, channel-montage, data and availability stamps are re-armed.
  Today those four stamps are cleared only fleet-wide, by `?reset=1` on the sweep routes in `backend/src/routes/admin/datasets-lifecycle.ts`; the identifier sweep's verdict already counts only for the version it was dispatched for (ADR 0088).

### 3. Re-pull state lives in `upstream_repulls`, never in `import_jobs`

- One row per `(dataset_id, to_tag)`, `UNIQUE`, plus a partial unique index allowing one non-terminal row per dataset.
- The one row records both pull requests: `branch`, `pr_number` and `head_sha` for N.0.0, and `patch_branch`, `patch_pr_number` and `patch_head_sha` for N.0.1, which stay NULL until `patch_synthesized`, and for good when there are no corrections.
  `origin` records who opened them: `automatic` for the scheduled path, `administrator` for `nemar admin repull <id> --execute`.
  A second row keyed by version was rejected: created at plan time it would be open beside the N.0.0 row, which the one-non-terminal-row index forbids, and created at `patch_synthesized` it would leave a gap after N.0.0's release in which another re-pull could start before the corrections land.
- Its states are planned, prepared, copied, registered, pr_open, gates_clear, merged and released, then, when there is an N.0.1, patch_synthesized, patch_gates_clear, patch_merged and patch_released, and finally complete.
  Abandoned, failed, superseded and patch_declined are terminal, and superseded means a newer tag arrived before N.0.0 merged, so its pull request is closed and the plan made again from the same `from_tag`.
- Every step checks its own end state before it acts, so `--resume` continues from the recorded status.
- `--abandon` before N.0.0 merges closes its pull request and deletes its branch, when they exist, reports the orphaned bytes and ends the row `abandoned`.
  After N.0.0 has merged, it closes only N.0.1's pull request and branch, when they exist, and ends the row `patch_declined` (terminal).
  N.0.0 stays released, because its tag and DOI exist, and its corrections remain corrections in the next plan.
  A step that finds a recorded pull request closed unmerged ends the row the same way: `abandoned` before the N.0.0 merge, `patch_declined` after it.
- `last_error` is written through `import-error.ts`, so ADR 0051's rule applies.
- A re-pull never writes `import_jobs`: its sticky row per dataset, its `preparing` reset, its six-hour sweep and the retry engine, which reads only `import_jobs`, would each treat a re-pull as a broken import.

### 4. The upstream tag is recorded per version, and the dataset's tag is derived

- `dataset_versions` gains `source_version` (the upstream tag) and `source_version_basis` (`doi`, `lineage` or `unknown`).
  An unknown tag is stored as `source_version` NULL with basis `unknown`, and both NULL means the row was never examined, so "`source_version` set" always means a known tag.
- The dataset's mirrored tag is the `source_version` of its highest-semver version row, derived at read time, so `datasets` gains no column and stays under ADR 0034's budget (84 columns pinned, cap 97, on 2026-10-23).
- The value is written when the version row is inserted, from the tagged `dataset_description.json` the version-DOI callback already reads, by one parser, `sourceSnapshotOf(desc, sourceId)`.
  It reads `Version`, then a DOI matching `10.18112/openneuro.<ds>.v<tag>`, then the URL, accepts only an entry naming the dataset's own `ds`, and answers `unknown` when they disagree.
- The backfill of existing mirrors reads `v<version>/dataset_description.json` through the authenticated raw CDN, and no match is `unknown`.
- Unknown is never guessed and never rendered as zero: a mirror whose tag is unknown is never re-pulled, the staleness report counts it as unknown and never as current, and an import date compared with a snapshot date is shown only as "probably stale", never recorded as a tag.
  The `lineage` basis (tree equality outside NEMAR's paths) is established only inside a plan.

### 5. N.0.0 on a mirror always means an upstream pull

- A version row with `source_version` set (not NULL, so never an unknown tag) and a version of the form `N.0.0` is a mirror.
  The API exposes that as a derived flag, computed at read time and never stored, and the website shows a mirror tag on that version.
- A manual major bump is refused on `on` datasets: `nemar dataset release --type major`, and `nemar dataset update --bump major`, which reaches the same number.
  NEMAR's own changes to a mirror take minor and patch.

### 6. Discovery stays id-only, and the re-pull has its own switches and caps

- `diffNewDatasets` stays id-only, so the live auto-import never sees a stale mirror; staleness is computed by its own report.
- `AUTO_REPULL_ENABLED` lets the scheduled path open re-pull pull requests, and `AUTO_REPULL_MERGE_ENABLED` lets the Worker merge them (decision 7).
  Both are off when absent, and the scheduled path is production-only through the dev cron's allowlist.
- `REPULL_DAILY_OPEN_CAP` (default 2) bounds the re-pull pull requests the automatic path opens in a day.
- `REPULL_DAILY_MERGE_CAP` (default 5) bounds merges: every merge a NEMAR tool makes of a re-pull pull request, the Worker's and the manual ones (`nemar admin repull <id> --merge`, `nemar admin pr-reviews`) alike, first claims one from the backend, and a refused claim merges nothing, because every merge mints an irreversible DOI.
- The automatic path takes only a plan with zero unexplained paths.
- Outside production, the re-pull routes refuse every dataset that is not `xx`, because the GitHub organization is shared, and re-pull mail goes through the admin-only fence.

### 7. The Worker may merge a re-pull pull request, and nothing else, when it is machine clean

A re-pull pull request is machine clean when all of these hold:

- `AUTO_REPULL_MERGE_ENABLED` is on, and the pull request is the one `upstream_repulls` recorded for this re-pull (its branch, number and head SHA) on a row whose `origin` is `automatic`: a pull request an administrator opened, including through `--execute`, is never merged by the Worker;
- the plan had zero unexplained paths, so there is no conflict and no correction to replay: the Worker never merges an N.0.1 pull request, because N.0.1 exists only when a correction does, and an administrator merges it;
- the identifier screen, dispatched with `ref=<head sha>` and a callback bound to the re-pull row, says `clear`: never `unchecked`, never `rerun`, and never `acknowledge`, which needs a person (ADR 0086);
- BIDS validation and `version-check` are green;
- an ADR 0107 review is stored for that head and its verdict is `pass`; any other verdict, or none, is not machine clean, because unknown is never treated as clean (ADR 0053, ADR 0054), and this holds even where the review's ruleset is only a shadow check;
- the pull request's head equals the screened SHA;
- the daily merge cap is not exhausted, and its claim is made before the merge is sent.

The merge is sent with the screened SHA, so GitHub refuses a branch that moved, and only when GitHub reports the pull request `clean`: the NEMAR App is a bypass actor (ADR 0001, ADR 0107), and `clean` is what keeps "never a bypass" true for a merge the App makes.
The Worker submits no approving review on this class either, since ADR 0001 requires none; the record is the merge, the `upstream_repulls` row and the plan digest.
The Worker's merge call is not built until the ruleset check under "Not yet verified" is done.

**What this narrows in ADR 0093, for re-pull pull requests only.**
ADR 0107 already partially supersedes ADR 0093; this record narrows one more aspect of it, the merge, and only for this class.
ADR 0093's approval sentences stand as written, "its approval is made by the administrator, from their machine, with their own GitHub login" and "No Worker code path approves", because the Worker submits no review.
What changes, for a re-pull pull request the automatic path opened, is that a merge no longer always follows an administrator's approval and `--merge` or `y`: the Worker merges one that is machine clean.
For every other pull request the Worker neither approves nor merges.
AGENTS.md's summary of ADR 0093 ("nothing merges without `--merge` or a `y`") is updated by the phase that builds the merge.

A re-pull pull request that is not machine clean, or that an administrator opened, is merged by an administrator, through `nemar admin repull <id> --merge` or `nemar admin pr-reviews`, under ADR 0093, with a screen that is `clear` or carries the administrator's recorded acknowledgment (ADR 0086).
`nemar admin pr-reviews` will require that screen for a re-pull pull request other than an `xx` one (below), which its `approve --merge` does not check today, and will claim the merge cap before the merge is sent.

An `xx` re-pull takes the administrator path only.
ADR 0086 exempts `xx` from the identifier screen, so an `xx` re-pull never has a `clear` verdict and is never machine clean, and an administrator merges it under that exemption, with no screen.

### 8. A copy pins the object version, and nothing of the prior version is deleted

- The copy manifest is the keys the scrubbed new tree names that are not present and not dead, written to `<id>/staging/repull-<tag>.json`.
- Each copy item carries the S3 `versionId` upstream's `.log.rmet` records for its key, and the copy pins it; an item without a `versionId` is refused, never copied by path.
  Today `parseS3Url` drops the query string, so the import copy takes whatever object is current at the path.
- Prior-version objects stay under their governance lock, and the old version's manifest, DOI and data-plane routes are unchanged.
- An abandoned re-pull leaves locked orphan objects; the plan states their size, and `--abandon` reports them.

### 9. A re-pull is a new version of a published dataset, not a publication

- It makes no publication request; the identifier screen gates its merge (decision 7) instead.
- ADR 0089's forward-fix hold does not apply.
  That hold exists because an import pushes upstream's history, which still holds what the scrub replaced; a re-pull pushes none and scrubs its delta paths before its copy and its one commit, so nothing it copies or adds to NEMAR's history holds an original.
- ADR 0091's date normalization applies on delta paths only, so nothing already published is changed.

### 10. The upstream tag is pinned, never HEAD

- A first import clones the discovered tag (`--tag`), never the default HEAD, and writes the `SourceDatasets` entry with `Version`.
- A tag not yet on the GitHub mirror refuses with `[openneuro-mirror-lag]`, which is transient and retried, not parked.
  *Annotated 2026-10-24: see Amendment 2026-10-24 (parked after 14 days).*
- A re-pull's `from_tag` is the recorded `source_version`, and its `to_tag` is a tag.
- The import path gets #993's guard, and only for a released mirror.
  Step 4c refuses with `[openneuro-upstream-moved]` when three things hold: `origin/main` records a tag; the dataset has released a version (a `dataset_versions` row exists); and the tag being imported differs from the recorded one.
  "Records a tag" means `sourceSnapshotOf` (decision 4) finds one in `origin/main`'s `dataset_description.json`, not only in its `Version` key, so a legacy entry that names the tag only in its DOI or URL counts too.
  The classifier calls that `upstream_moved`, and the retry engine parks it like `identifier_scrub_refused`, because moving a released mirror to a new tag is a re-pull's job.
  An import that never released a version and is retried is prepared again at the tag the retry discovers: it is the same import, not a re-pull.
  An unrecorded tag, `origin/main` naming none or the released version's `source_version` being NULL, never trips the guard.

## Consequences

- **DOI volume grows with upstream churn.**
  Every merged re-pull mints a version DOI that cannot be withdrawn, and a re-pull with corrections mints two.
  The volume is measured before anything runs on its own (gate G2 of the design record), and the owner sets the caps from that estimate and turns the switches on (G5); the first Worker merges run with `REPULL_DAILY_MERGE_CAP` set to 1.
- **Two DOIs when N.0.1 has content.**
  N.0.0 cites upstream's snapshot without NEMAR's corrections, which is what its number says, and N.0.1 is the version a reader most likely wants.
- **A window between N.0.0 and N.0.1.**
  Between the two merges the public latest lacks NEMAR's corrections; the window lasts until an administrator merges N.0.1, which can happen only once N.0.0 is tagged and N.0.1 is synthesized and its gates pass, and a conflict keeps its correction out until an administrator resolves it.
  A change the privacy ledger records, and a change a deterministic rule re-applies (the scrub, the date normalization), are standard edits, so N.0.0 carries them and the window never lacks them.
  Every other correction is in the window, including a privacy-minded one the ledger does not record.
- **Orphan locked objects.**
  An abandoned re-pull leaves copied objects under the governance lock; they cost storage and are reported, not deleted.
- **One synthesized commit instead of upstream's history.**
  NEMAR's log shows one commit per re-pull, named by its trailers, and not upstream's commits; upstream's repository and `CHANGES` remain the record of how the snapshot was made.
- **Few re-pulls will be merged by the Worker at first.**
  Most mirrors are in formats the scanner does not parse, so their screen asks for an acknowledgment (ADR 0089, Consequences), and only an administrator can give one.
  Machine clean also needs an ADR 0107 review that passes, which no re-pull diff is yet known to get.
- **The merge cap binds NEMAR's tools only.**
  An organization administrator merging in the GitHub UI is not stopped by it.
- **The Worker gains a path that merges into `main` of a public dataset.**
  It is bounded by the machine definition, the switch and the cap, and a defect in it would mint a DOI; that is why the merge call waits for the ruleset check and for gates G1 to G5.
- **The Worker's merge has no staging rehearsal.**
  Outside production only `xx` datasets are re-pulled, and they never reach machine clean, so the Worker's merge first runs in production, behind its switch and with `REPULL_DAILY_MERGE_CAP` set to 1 for its first merges (G5).
- **A NEMAR change that would deserve a major has no major on a mirror;** it takes a minor.
- The importer changes as well: it clones a tag, and it refuses a re-import of a released mirror whose recorded tag moved.

## Alternatives considered

- **A git merge of upstream.** There is no shared ancestry on early rewritten imports, and pushing upstream's history would carry its unscrubbed bytes into NEMAR's (ADR 0089).
- **Replacing the whole tree.** Discards NEMAR's edits and re-scrubs and re-normalizes unchanged recordings under new keys, which breaks ADR 0091's rule that nothing already published is changed.
- **Carrying NEMAR's corrections inside N.0.0.** A re-pull would block on every conflict, and N.0.0 would no longer say "this is upstream's snapshot", which is the question ADR 0006's version rule answers.
- **The Worker never merges.** Keeps ADR 0093 whole, and leaves every re-pull of about 900 mirrors waiting for an administrator; the machine definition, the cap and a switch that is off by default bound the risk instead, and the switch off is exactly this alternative.
- **`source_version` on `datasets`.** Spends a column of ADR 0034's budget on a value the highest version row already gives, and loses which tag each version mirrored.
- **Reusing `import_jobs`.** Its sticky row, `preparing` reset, six-hour sweep and retry engine would each read a re-pull as a failed import.
- **A minor bump for upstream.** Rejected by ADR 0006 already; here it would also stop the version number from saying which versions are mirrors.

## Not yet verified

- Whether the rulesets let the GitHub App merge without a human review, and without using its bypass; the merge call is not built until this is checked.
- Where `source_version` is inserted under the central manifest flow.
- Whether "explained" edits are detected on early rewritten imports (`on003645`, `on004362`); local dry-run plans count the unexplained paths.
- Whether ADR 0107's review can ever pass a re-pull diff.
  The App is not exempt, so the review runs, and ADR 0109 fails a changed `CHANGES` line and holds a replaced recording, both normal in a re-pull; until a re-pull's review passes, none is machine clean.
- Whether enrichment commits on the release branch move its head after the screen read it.
- Whether OpenNeuro writes S3 before it pushes to GitHub, and whether the object at a path lags the pinned `versionId`.
- That upstream's `.log.rmet` records a `versionId` per key, which the design record states and nothing here has checked.
- That the dataset workflows tag the squash merge of a re-pull pull request as they tag other merges to `main`.

## Receipts

- Epic #1046 and its Phase 1, #1907; the design record `.context/design-upstream-repull.md`.
- #993 (step 4c's same-version assumption), #1320 (the bucket's annex UUID belongs to another special remote), #985 (finalize skips publication for a published dataset), #1810 (`on004362` missed upstream's 1.0.1).
- `src/lib/import-openneuro.ts` (`prepareImport`, step 4c, `finalizeImport`), `backend/src/routes/admin/imports.ts` (`POST /admin/datasets/import`), `backend/src/services/openneuro-discovery.ts` (`diffNewDatasets`, `latestTag`), `backend/src/services/auto-import.ts`, `backend/src/routes/admin/datasets-lifecycle.ts` (the `?reset=1` stamp resets), `backend/src/routes/callbacks/version-doi.ts`, `src/commands/dataset.ts` (`release --type`, `update --bump`), `backend/test/datasets-column-budget.test.ts`.

## Amendment 2026-10-23 (#1908): Phase 2 builds decision 4, and the insert site is verified

Epic #1046, Phase 2.
Decision 4 is built: migration 0104 adds `dataset_versions.source_version` and `source_version_basis`, `shared/source-snapshot.ts` holds the one parser, the version insert records the snapshot, and `nemar admin upstream-backfill` records it for the mirrors that predate the columns.
This section makes one correction and states three readings that the decision text left open.
The correction is to a sentence in decision 4, "from the tagged `dataset_description.json` the version-DOI callback already reads", and it answers the "Not yet verified" item "Where `source_version` is inserted under the central manifest flow."
The decision text above is unchanged.

### Where `source_version` is inserted under the central manifest flow (verified)

The item read "Where `source_version` is inserted under the central manifest flow."
Decision 4 says the value is written "from the tagged `dataset_description.json` the version-DOI callback already reads".
Under the central flow that sentence is wrong.
The mint reads the tagged description (`mintEzidVersionDoi`, `backend/src/services/central-manifest.ts`) but returns only the DOI and its warnings, `dispatchCentralManifestJob` stores `manifest_jobs` without the description, and `/webhooks/manifest-ready`, which inserts the row, reads none.
So the insert reads the tagged file itself, once, through the authenticated raw CDN (no REST quota), bounded by a 4 second fetch timeout and a 5 second deadline, and it can never fail the insert.

`dataset_versions` is inserted at five sites, all through one statement, `INSERT_DATASET_VERSION_SQL` in `backend/src/services/source-snapshot.ts`, and a source scan keeps it the only one.

| Site | Where | Live | How it gets the snapshot |
|---|---|---|---|
| A | `routes/callbacks/manifest.ts`, the manifest-ready callback | production, every central-flow publish | reads `v<version>/dataset_description.json` |
| B | `routes/admin/datasets-lifecycle.ts`, admin manifest regeneration | production, manual recovery | the same read, with the repository and token the route already holds |
| C | `services/publication-orchestrator.ts`, the inline path | dev only (`MANIFEST_VIA_CENTRAL_WORKFLOW` is `"false"` there) | the description `readRepoMetadata` returned |
| D | `routes/callbacks/version-doi.ts`, the legacy EZID handler | dev only | the description `readRepoMetadata` returned |
| E | `routes/callbacks/version-doi.ts`, the Zenodo handler | unreachable (EZID is the registrar, ADR 0007) | none; NULL/NULL |

`MANIFEST_VIA_CENTRAL_WORKFLOW` is `"true"` in the production `[vars]` of `backend/wrangler-sccn.toml` and `"false"` under `[env.dev.vars]`, so A and B are the sites that matter.
`readRepoMetadata` never throws: a failed read returns `{ Name }` and a `BIDS metadata unavailable` warning, and an absent file returns the same `{ Name }` with no warning.
C and D therefore record NULL/NULL for either, and record `unknown` only for a description that was really read.

### The parser reads the entry's `Version`, never the top-level one

Decision 4 says the parser "reads `Version`, then a DOI ..., then the URL".
The `Version` it reads is the one inside the dataset's own `SourceDatasets` entry.
The top-level `Version` and `DatasetDOI` are NEMAR's (decision 1), and reading the top-level `Version` would record NEMAR's own version number as upstream's.
An entry is the dataset's own only when its DOI or URL names the dataset's `ds`; an entry that names no `ds` is ignored, `Version` included.
In practice the existing evidence is usually the DOI alone, because `applyConceptDoiToDescription` moves OpenNeuro's original `DatasetDOI` into `SourceDatasets` as `{DOI}` with no URL and no `Version`.

The three signals are never ranked.
Any disagreement between signals, between two own entries, or an entry that names two datasets is `unknown`; the order in the decision text decides only which signal is looked at first.
A tag that cannot be read (`v2.0.2.`, `2.0.x`) is no signal, and a tag is stored exactly as upstream wrote it (`00001` is not `1`).

### What `doi` means

The basis word `doi` is kept as the decision fixed it, and it covers a tag found in the entry's `Version`, DOI or URL.
It says the tag is declared by the version's own tagged description.
It does not say the tree was compared with upstream's; early imports cloned the default HEAD, so a matching DOI is a claim.
Only `lineage`, which a Phase 5 plan alone writes, says the tree was compared.

### An absent file at insert time is not examined, and an error is never a verdict

At insert time an absent file, a failed fetch, a timeout, a body over 1 MiB, a token that cannot be minted and a dataset that is not `on######` all leave NULL/NULL.
A 404 shortly after a tag is pushed can be the raw CDN not having caught up, so an insert never turns "absent" into `unknown`.
`unknown` is written at insert only for a description that was read and names no single tag, which is a property of the content: a tagged blob is immutable.
Only the sites that read the raw file themselves (A and B) can see that the file is not JSON, so only they record `unknown` for it; the inline sites C and D go through `readRepoMetadata`, which turns unparseable JSON into a fallback and a warning, and that is NULL/NULL there.
The insert is `ON CONFLICT (dataset_id, version) DO NOTHING`, not `INSERT OR IGNORE`, so a snapshot pair the table's CHECK refuses raises (the callback answers 500 and the job stays retryable) and does not drop the row silently; a replayed insert for an existing version is still a no-op.

The backfill is the only writer that records `unknown` for an absent file, and `unknown` is final: nothing examines the row again.
So a 404 is recorded only when it is proved to be about the tag and not about the credential, which GitHub also answers with 404.
The proof is a control read: the same repository's `dataset_description.json` at `main`, with the same credential, must succeed.
If the control read fails, the row is counted `not_examined` as a transient error, nothing is written, and the next pass tries it again.
If the control read is also absent, the description is missing at the tag and at `main` (or the default branch is not `main`), nothing is written, and a rerun will not change that: the row is reported with `kind: "needs_admin"` and an administrator has to look at it.
Both hold for a batch of any size, a single row included.
The row must also be older than one hour, so a CDN-cached 404 on a fresh tag is never made final.
A fetch error in the backfill writes nothing, and a batch in which no read proved the credential while at least one 404 is unconfirmed is refused as `suspect_credential` (502), whatever else errored beside it.
Only a version of the form N.N.N is a candidate, and a ref is always the canonical `vX.Y.Z` tag, so a stored `v1.0.0` can never read `vv1.0.0`.
The write is `WHERE source_version_basis IS NULL`, so it never overwrites a recorded value; its paging is a keyset on `(dataset_id, version)`, so a row that always errors cannot starve the rows behind it.
A dry run, which is the default, writes nothing.

### Left open

Outside production only `xx` datasets are re-pulled (decision 6), and nothing says how an `xx` dataset names its upstream `ds`.
The parser takes the `ds` as an argument, but the insert sites and the backfill handle `on######` only.
Whether an `xx` fixture maps through `import_jobs.source_id` is a Phase 4 and 5 question.

## Amendment 2026-10-24 (#1909): decision 10, as built

Phase 3 builds decision 10; the rest of the Decision section is still designed and not built.
The lead's rulings of 2026-10-23 settle three questions decision 10 left open, and this records them with what was built.

- **Which tag.** The auto-import passes the tag discovery found.
  Every other entry point (the retry engine, `recover --execute`, a dispatch without `--tag`) passes none, and prepare asks OpenNeuro's GraphQL for `latestSnapshot.tag` when it runs, so "the tag the retry discovers" is the latest at the retry.
  An explicit `--tag` is honored; when it is not the latest, prepare warns, because decision 8 is not built and the copy takes the object currently at each upstream path.
- **Mirror lag.** A latest tag OpenNeuro cannot name refuses with `[openneuro-mirror-lag]` too, before the dataset record is created.
  Recovery quarantines it as `mirror_lag`, so it stays retryable rather than `not_found_dataset`.
  Retries are capped by the retry engine's 14-day window, counted from its first retry of the row; past it the row is parked as `mirror_lag` and one admin issue is filed then; no quarantine mail and no failure-time issue are sent for it (ruling 2).
  The window is the engine's existing `first_incomplete_at`, so a row whose window an earlier, unrelated retry opened and never closed parks at its first mirror lag, with its one issue.
  The override also bypasses `has_doi`, `made_public` and `has_version`: the refusal came before this run changed anything, and only a quarantine that stays retryable lets the lag clear.
- **What "records a tag" reads.** The `SourceDatasets` entries naming the dataset's own `ds`: their `Version`, then a `10.18112/openneuro.<ds>.v<tag>` DOI, then the URL (openneuro.org's dataset pages or the OpenNeuroDatasets GitHub mirror only), all required to agree.
  The top-level `Version` is NEMAR's own and records nothing about upstream.
  Two tags are the same snapshot only when equal after a leading `v` is dropped, the safe direction.
- **An unreleased import whose tag moved is retargeted, not hard-reset (ruling 1).**
  `git reset --soft origin/main` keeps the new tag's tree and lands it as a fast-forward, so "prepared again at the tag the retry discovers" holds; the hard reset would have kept the old tree, #993's mismatch.
  "Released" is any `dataset_versions` row, read through `GET /datasets/:id/versions`, asked only when the tag moved; not being able to read it is a plain failure, never "unreleased".
  A retarget is refused when origin's `.nemar/corrections.jsonl` holds a line the new tree would drop with consequence: a recorded correction (ADR 0085), or an `import-scrubbed` line whose scrub blanked a JSON value or scrubbed a git-held recording, because origin's history still holds those originals and only a hard reset keeps that hold (ADR 0089).
  Step 5b's scrub writes the new tree's own ledger line; it does not carry the old ones.
- **The guard fails closed, and says when it is inert.** An origin whose `main` cannot be asked or fetched stops prepare (only `git ls-remote --exit-code`'s status 2, no such ref, is a first import; git's messages are localized, so none is matched); the recorded tag is read before the branch name, so a detached or adjusted branch cannot skip it.
  When origin's `main` records no readable tag, prepare prints why, because the guard cannot fire then.
  The refusal of a released mirror names the repair that passes the guard, `nemar admin import-openneuro <ds> --tag <recorded tag>`; the retry engine dispatches no tag, so it never runs it.
- **The entry.** A first import, and a retarget, record `{DOI: doi:10.18112/openneuro.<ds>.v<tag>, URL: https://openneuro.org/datasets/<ds>/versions/<tag>, Version: <tag>}` in `SourceDatasets`, all three from the one tag, unless an entry already records a tag for the dataset.
  An untagged entry that names the dataset alone (a concept DOI, a dataset page) is completed in place, so the dataset keeps one entry; an entry naming two datasets is left alone and the record appended.
  It is not written after a hard reset, whose tree is origin's.
  Publication's `applyConceptDoiToDescription` compares DOIs normalized and adds no second entry for a dataset an entry already names, so a stale or differently spelled upstream `DatasetDOI` cannot make the recorded tag unknown.
- **`upstream_moved` and `annex_uuid_conflict` (ruling 3).** Recovery has no rule for either marker, so a failure usually quarantines the row by the dataset's state first (`has_doi` for a released mirror), and a quarantined row is no retry candidate.
  The retry engine's park, in both wordings of the annex conflict, is the backstop for a `failed` or `incomplete` row that carries one and reaches the sweep, because each retry fails the same way; an operator restarts the import by hand after fixing the bucket marker.
  The #1320 preflight compares the bucket's `annex-uuid` with the `nemar-s3` uuids the git-annex branch records and refuses a disagreement with `[nemar-annex-uuid-conflict]`, naming both and the recovery.
  It answers unchecked, and prepare goes on as before with a warning, whenever the comparison is incomplete: Step 4b's fetch or merge failed, git cannot read the branch, the bucket cannot be asked, or origin has a git-annex branch that records no `nemar-s3`.
