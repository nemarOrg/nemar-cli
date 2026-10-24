# ADR 0111: An upstream re-pull is a reviewed delta on a release branch

**Status:** accepted
**Date:** 2026-10-23
**Owner:** Seyed Yahya Shirazi

Epic #1046, Phase 1 (#1907).
Amends [ADR 0006](0006-upstream-re-pull-is-a-major-version-bump.md): its policy stands (a re-pull is a major bump), and this record adds the mechanism and says what major and patch mean on a mirror.
Narrows [ADR 0093](0093-pull-requests-awaiting-approval-are-managed-from-one-admin-command-and-an-approval-is-the-administrators-own.md) in one aspect, the merge, for one class of pull request, the re-pull pull request the automatic path opened (decision 7); ADR 0107 already partially supersedes ADR 0093, and for every other pull request what remains of it stands.
Builds on ADR 0001 (published datasets are PR-only), ADR 0023 (`--clean` reconciles), ADR 0034 (the column budget), ADR 0060, ADR 0085, ADR 0086, ADR 0089 and ADR 0091 (what an imported tree goes through), and ADR 0053 and ADR 0054 (unknown is never zero).
The analysis is `.context/design-upstream-repull.md`; where it and this record disagree, this record wins.
Decisions 4 and 10 are built, as their dated amendments below record, and so are the record of decision 3 (the table, its routes and its fences) and the fences of decision 6 (Amendment 2026-10-24 (#1912), Phase 6a); every other rule in the Decision section is designed here and built by the later phases of #1046, and its present tense states the rule, not today's behavior.
*Annotated 2026-10-24: superseded in part by the Phase 6e amendment (#1912): the identifier screen bound to the re-pull row (decision 7), the merge cap of decision 6, and the verified merge and release are built too.*

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
*Annotated 2026-10-24: decisions 4 and 10 are built, as their dated amendments below record; the record of decision 3 and the fences of decision 6 are built by Phase 6a (#1912); every other rule is still designed and not built.*
*Annotated 2026-10-24: superseded in part by the Phase 6e amendment: the screen bound to the row, the merge cap and the verified merge and release are built as well.*

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
- Whether the NEMAR installation token is accepted for another organization's public raw files (`OpenNeuroDatasets`), which the staleness report's mirror probe uses; if it is not, every probe reads `stale_unverified` with the reason and the first production run shows it.
- That the central `run-identifier-screen` workflow posts a re-pull screen's report to its own callback path (`/webhooks/identifier-screen-repull-result`); the workflow accepts any plain https `callback_url` (read), and no run has used this one yet (added by the Phase 6e amendment).
- GitHub's answers to the reads the re-pull's release and merge make (`commits/tags/<tag>` asked for `application/vnd.github.sha`, `compare/<merge>...<tag>` and its status words, a squash-merged pull request's `head` and `merge_commit_sha`); only stand-ins have answered them (added by the Phase 6e amendment).

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

## Amendment 2026-10-23 (#1911): Phase 5 builds the plan, and its readings are settled

Extended 2026-10-24, after the Phase 3 and Phase 4a amendments below: the section on `to_tag` (OpenNeuro's latest snapshot, and an order the tags cannot prove is unverified) and the reuse of Phase 3's tag shape and Phase 4a's `isSourceTag` were settled that day.

Epic #1046, Phase 5.
`nemar admin repull plan <id>` is built: a read-only plan, written to a file under its digest, that Phase 6's `nemar admin repull execute` will take.
Execution is not built.
This section records the owner's and the lead's rulings of 2026-10-23 that the decision text left open, and two corrections to it.
The decision text above is unchanged.

### The command is `nemar admin repull plan <id>`, then `nemar admin repull execute`

Decision 2 says `nemar admin repull <id>` is a dry run by default and `--execute` takes `--plan <file>`.
The built shape is two subcommands: `plan` makes the plan, and `execute` (Phase 6) takes the plan file.

`plan` writes nothing to the mirror, S3, D1 or the NEMAR API.
What it writes is its scratch directory, removed on exit, on SIGINT and on SIGTERM unless `--keep-workdir`, and the plan file, which is its output: mode 0600 in the administrator's config directory (`$NEMAR_CONFIG_DIR/repull/<id>/`, `~/.config/nemar` by default), because a path can itself be an identifier.
The default output holds counts and no path, key or file content.

Read-only is enforced by a guard, for every call the plan makes that could write:
each git subprocess, the git-annex branch reads included, may run only `clone`, `fetch`, `ls-remote`, `cat-file`, `ls-tree`, `rev-parse` or `rev-list`, each with a fixed list of options in the exact spelling the planner uses, so an attached form (`-ccore.hooksPath=x`, `-uevil`) is refused as the separated one is;
`clone` and `ls-remote` take only a `https://github.com/<org>/<repo>` or `file:///` URL and `fetch` only the remote `origin`;
the one `aws` call, when asked for, is `s3api list-objects-v2` with `--bucket`, `--prefix`, `--region` and `--output json`;
and the plan's own HTTP requests (the open pull requests, the bucket's anonymous `annex-uuid` marker) are GET or HEAD.
Outside the guard, and read-only by what they are: OpenNeuro's latest-snapshot query (a GraphQL POST that only asks); the NEMAR API's two GETs (the dataset row and its version rows), which the command makes through the API client before it plans; `gh auth token`, which reads the administrator's stored GitHub token; reads of the test bases' local directories; and the scratch directory and the plan file.
`GIT_NO_LAZY_FETCH=1` is set on every git call; the planner does not depend on it, because it reads only blobs the clone holds and lists the missing ones with `rev-list --missing=print`, which never fetches.

The digest is the sha256 of the plan body's canonical JSON.
The time, the environment, whether test bases redirected the remotes (`sources`), the preflight answers and executability are outside the body, so the same remotes and the same options give the same digest.
Because they are outside it, Phase 6 recomputes the preflight and executability itself and never trusts either from a file.

Exit 0 means the plan is executable, 3 that it was made and is not, and 1 that nothing was planned.
Conflicts and corrections do not by themselves stop a plan: N.0.0 takes upstream's side and N.0.1 replays NEMAR's corrections, as decision 1 says.
A plan is not executable when a preflight check is not `ok`, a key has no pin, or a plan refusal holds (the privacy ledger, a gitlink, a target that cannot be computed, a dead key, the fetch bound, a concept DOI that disagrees).

### `CHANGES` is upstream-owned, except ADR 0085's privacy sentence (correction)

Decision 1 says "`CHANGES` is upstream-owned, and NEMAR never writes it".
ADR 0085's correction does write it: its git plan appends one `changeLogEntry` sentence to `CHANGES` in every rewritten commit.
Read literally, decision 1 would make every corrected dataset's `CHANGES` unexplained, and decision 1's ledger rule would then refuse every re-pull of it.
The ruling: `CHANGES` stays upstream-owned, and the privacy sentence is a ledger edit, a standard edit like the provenance sentence.
A plan recognizes NEMAR's `CHANGES` as upstream's text followed by one or more sentences that `changeLogEntry` itself rebuilds byte for byte, and N.0.0's `CHANGES` is upstream's new text with the same sentences appended, whether upstream keeps `CHANGES` in git or in the annex.
Any other NEMAR change to `CHANGES` is unexplained.

### `SourceDatasets` merges three-way

"Other `SourceDatasets` entries are kept from both sides" means a three-way merge of the entries as a set, by canonical value: an entry either side added is kept, an entry upstream removed is not brought back, and an entry NEMAR removed stays removed.
The entry naming the dataset's own `ds` is NEMAR's and is replaced, as decision 1 says, by `{DOI: "doi:10.18112/openneuro.<ds>.v<to_tag>", URL, Version: to_tag}`.
An entry of any shape, `null` included, is merged as a value and never passed to `applyConceptDoiToDescription`, which throws on a `null` entry.

### A mirror whose tag is unknown gets a dry run only

Decision 4 says a mirror whose tag is unknown is never re-pulled.
`plan` refuses one with `from-tag-unknown`, and `--from-tag` on one makes the plan with the check refused as `from-tag-not-recorded`: it is shown, it is never executable, and its lineage is marked not recordable, so Phase 6 never records `lineage` from it.
`--from-tag` that disagrees with a recorded tag refuses as `from-tag-disagrees`, and a tag that is not an OpenNeuro snapshot tag at all (by `isOpenNeuroTag`, the shape decision 10's import also uses: `1..2`, `a/b`) as `from-tag-malformed` or `to-tag-malformed`; `v1.1.0` names the same snapshot as `1.1.0` (`sameUpstreamTag`).
A highest version row that was never examined (both columns NULL), or rows that cannot be read at all (a versions route that answers 404), is not unknown: the plan reads that version's tagged `dataset_description.json` from its own clone with `sourceSnapshotOf`, the file and the parser the backfill would use, and says so in `from_tag_source` (`tagged-description`).

### `to_tag` is OpenNeuro's latest snapshot, and its order is OpenNeuro's

Decision 10 says `to_tag` is a tag, never a branch head, and the Phase 4a amendment (dated 2026-10-24, below) rules that upstream's creation order decides, not the number.
So `plan` takes its default `to_tag` from OpenNeuro's own `latestSnapshot.tag`, the query decision 10's import pins its tag with (`fetchOpenNeuroLatestTag`), and never from the highest number among the mirror's tags.
The tag must have an OpenNeuro tag's shape (`isOpenNeuroTag`), be one the version rows can record (`isSourceTag`, `to-tag-unrecordable` otherwise, because a re-pull to it could never be proved), and be on the GitHub mirror (`mirror-lag` otherwise); equal to `from_tag` is `nothing-to-pull`, and with no answer from OpenNeuro and no `--to-tag` nothing is planned (`latest-unknown`).
A `--to-tag` that OpenNeuro does not name as its latest, or any `--to-tag` while OpenNeuro does not answer, is planned with the check `unchecked` (`order-unverified`), because the planner cannot prove from the tags that it is newer than `from_tag`; such a plan is never executable.
OpenNeuro's latest that is not numerically after `from_tag` is `order-unverified` too, never refused and never `ok`: it can be real creation order (`00006` before `1.0.0`) or a step backwards (a withdrawn snapshot, or a mirror recorded ahead of upstream's latest), and the tags cannot tell which.
The query is a GraphQL POST that only asks, and it runs outside the HTTP guard for that reason.

### Which `ds` a mirror names (closes the Phase 2 amendment's open item)

An `on` id maps to its `ds`, and its dataset row's `source_id` must agree (`source-disagrees` otherwise).
Any other id, an `xx` fixture included, maps through its dataset row's `source_id` (the `datasets` row `GET /datasets/:id` returns), and with none the plan refuses as `no-source-id`.
For every id the row's `source` must be `openneuro` (`not-a-mirror` otherwise).

### Legacy badges, an inherited `.gitattributes` and un-annexed root metadata are explained

The standard edits a plan recognizes include the forms early imports and publications left:
a README under one or more DOI badges for the catalog's concept DOI, in either spelling NEMAR has written (the shields.io form `buildDoiBadge` makes, and the Zenodo form it made before #1182), each rebuilt and compared byte for byte, while a badge naming any other DOI is not NEMAR's edit and is unexplained;
an inherited `.gitattributes` with its `annex.largefiles` attributes stripped (ADR 0060), and a git-held file NEMAR's policy annexed whose key hashes upstream's blob;
and root metadata upstream annexed that the import un-annexed, whose bytes hash to upstream's key.
The README family is compared as a unit, the import's rename (any case and extension, #642) applied before the publish step's (four exact spellings).
The concept DOI is the catalog's (`datasets.concept_doi`); a `DatasetDOI` on `main` that names another refuses as `concept-doi-disagrees`, and with none in the catalog no badge is explained and N.0.0's README cannot be computed.

### Presence comes from the location log, or from a bucket listing when asked

A key NEMAR already holds is not copied.
By default "holds" is read from NEMAR's git-annex branch (the newest `nemar-s3` status is present, or `main` names the key), and the plan says `presence_basis: "location-log"`.
`--bucket-listing` reads a listing of `nemar-s3`'s prefix instead, with the ambient AWS credentials, and holds a key only when its object is there at the size the key declares (`bucket-listing`), because the location log can claim content the bucket never received (#1396).
The listing must hold the prefix's own `annex-uuid` object, or it cannot be told from an empty or partial one, and nothing is planned.
A dead key is never held or copied: it is judged before presence, so an object that outlives its dead mark under the governance lock is not counted, and a dead key N.0.0 would name is listed separately, as `dead_recordings` when the path is a recording the scrub will re-key, and otherwise refused (`target-names-dead-key`).
Root metadata upstream annexed is read from upstream's pinned object at execution and kept in git, so its key is listed with `purpose: "unannex"`, needs a pin like a copied key, and is never counted as held.

### A blob the plan could not read is unchecked, never a guess

A git blob of 1 MiB or more is fetched only when a check needs it and an annex key states its size, within `--max-fetch-gb`.
A blob the bound refuses, or that a fetch which exited 0 did not deliver, makes its path `unchecked` (subtype `fetch-bound`), never a conflict or a correction, and refuses the plan (`fetch-bound`).
A byte count that is partly unknown is reported as at least the known part plus the number of unknown sizes, never as complete (`copy_bytes_unknown`, `local_bytes_unknown`, `orphan_bytes_unknown`).
A scrubbed key is explained only when both keys declare the same size; an unknown size is not the same size.

### Readings of decision 8 and decision 1 the plan needed (corrections and clarifications)

- "The keys the scrubbed new tree names" cannot be known before the scrub runs.
  The plan binds the pre-scrub manifest, and Phase 6 must check that what it copies is a subset of the plan's copy keys plus its own local uploads.
- Deletions are not delta paths as decision 1 defines them; the plan lists them separately, and reports a deleted path and an added path with the same content as one rename, without deciding anything from it.
- #1911's text says a plan refuses on a starting-point mismatch; decision 1 supersedes it, and the plan classifies such a path by the table instead.

### Left open

- A file NEMAR's enrichment adds that upstream lacks (the generated `participants.tsv` of `ensureParticipantsTsv`) is not among decision 1's standard edits, so a plan counts it as a correction.
  For a dataset whose ledger holds a recorded privacy correction, that one correction makes every plan refuse, with no override.
  That is the safe direction, and the owner decides before Phase 6 whether the generated file becomes a standard edit.
- The `CHANGES` sentence is matched only at the end of the file; a sentence followed by upstream text that ADR 0085's rewrite never produces is unexplained.

## Amendment 2026-10-24 (#1909): decision 10, as built

Phase 3 builds decision 10, on the parser Phase 2 built for decision 4 (Amendment 2026-10-23 above); the rest of the Decision section is still designed and not built.
The lead's rulings of 2026-10-23 settle three questions decision 10 left open, and this records them with what was built.

- **Which tag.** The auto-import passes the tag discovery found.
  Every other entry point (the retry engine, `recover --execute`, a dispatch without `--tag`) passes none, and prepare asks OpenNeuro's GraphQL for `latestSnapshot.tag` when it runs, so "the tag the retry discovers" is the latest at the retry.
  An explicit `--tag` is honored; when it is not the latest, prepare warns, because decision 8 is not built and the copy takes the object currently at each upstream path.
- **Mirror lag.** A latest tag OpenNeuro cannot name refuses with `[openneuro-mirror-lag]` too, before the dataset record is created.
  Recovery quarantines it as `mirror_lag`, so it stays retryable rather than `not_found_dataset`.
  Retries are capped by the retry engine's 14-day window, counted from its first retry of the row; past it the row is parked as `mirror_lag` and one admin issue is filed then; no quarantine mail and no failure-time issue are sent for it (ruling 2).
  The window is the engine's existing `first_incomplete_at`, so a row whose window an earlier, unrelated retry opened and never closed parks at its first mirror lag, with its one issue.
  The override also bypasses `has_doi`, `made_public` and `has_version`: the refusal came before this run changed anything, and only a quarantine that stays retryable lets the lag clear.
- **What "records a tag" reads.** The guard reads origin's description with Phase 2's parser, `sourceSnapshotOf` in `shared/source-snapshot.ts`, the one reader of the tag; see Amendment 2026-10-23 for its rule.
  Phase 3 first shipped a reader of its own, and where the two differed the parser won: a tag is numeric and dotted (`1.0.0`, `00001`), so a `2.1.0-rc1` that OpenNeuro's tag shape admits is no tag; an entry naming this dataset and another gives no tag at all; and of the GitHub mirror's URLs only the tree and release forms name the dataset, not the `.git` clone URL.
  Two tags are the same snapshot only when equal after a leading `v` is dropped (`sameUpstreamTag`), the safe direction; the parser's `compareSourceTags` orders `1.0` and `1.0.0` as equal, so the guard does not use it.
- **An unreleased import whose tag moved is retargeted, not hard-reset (ruling 1).**
  `git reset --soft origin/main` keeps the new tag's tree and lands it as a fast-forward, so "prepared again at the tag the retry discovers" holds; the hard reset would have kept the old tree, #993's mismatch.
  "Released" is any `dataset_versions` row, read through `GET /datasets/:id/versions`, asked only when the tag moved; not being able to read it is a plain failure, never "unreleased".
  A retarget is refused when origin's `.nemar/corrections.jsonl` holds a line the new tree would drop with consequence: a recorded correction (ADR 0085), or an `import-scrubbed` line whose scrub blanked a JSON value or scrubbed a git-held recording, because origin's history still holds those originals and only a hard reset keeps that hold (ADR 0089).
  Step 5b's scrub writes the new tree's own ledger line; it does not carry the old ones.
- **The guard fails closed, and says when it is inert.** An origin whose `main` cannot be asked or fetched stops prepare (only `git ls-remote --exit-code`'s status 2, no such ref, is a first import; git's messages are localized, so none is matched); the recorded tag is read before the branch name, so a detached or adjusted branch cannot skip it.
  When origin's `main` records no readable tag, prepare prints why, because the guard cannot fire then.
  The refusal of a released mirror names the repair that passes the guard, `nemar admin import-openneuro <ds> --tag <recorded tag>`; the retry engine dispatches no tag, so it never runs it.
- **The entry.** A first import, and a retarget, record `{DOI: doi:10.18112/openneuro.<ds>.v<tag>, URL: https://openneuro.org/datasets/<ds>/versions/<tag>, Version: <tag>}` in `SourceDatasets`, all three from the one tag, unless an entry already records a tag for the dataset.
  An untagged entry that names the dataset alone (a concept DOI, a dataset page) is completed in place, so the dataset keeps one entry.
  The import writes only a record the parser then reads as the tag: when an entry for the dataset carries another tag or names another dataset too, or the tag is not one the parser reads, the file is left alone and prepare warns that the guard stays inert for the dataset.
  It is not written after a hard reset, whose tree is origin's.
  Publication's `applyConceptDoiToDescription` (`shared/standard-edits/description.ts`) compares DOIs normalized and adds no second entry for a dataset an entry already names, judged by the parser's `isOwnSourceEntry`, so a stale or differently spelled upstream `DatasetDOI` cannot make the recorded tag unknown.
- **`upstream_moved` and `annex_uuid_conflict` (ruling 3).** Recovery has no rule for either marker, so a failure usually quarantines the row by the dataset's state first (`has_doi` for a released mirror), and a quarantined row is no retry candidate.
  The retry engine's park, in both wordings of the annex conflict, is the backstop for a `failed` or `incomplete` row that carries one and reaches the sweep, because each retry fails the same way; an operator restarts the import by hand after fixing the bucket marker.
  The #1320 preflight compares the bucket's `annex-uuid` with the `nemar-s3` uuids the git-annex branch records and refuses a disagreement with `[nemar-annex-uuid-conflict]`, naming both and the recovery.
  It answers unchecked, and prepare goes on as before with a warning, whenever the comparison is incomplete: Step 4b's fetch or merge failed, git cannot read the branch, the bucket cannot be asked, or origin has a git-annex branch that records no `nemar-s3`.

## Amendment 2026-10-24 (#1910): Phase 4a builds the staleness report

Epic #1046, Phase 4, first part.
Decision 6 says staleness is "computed by its own report" and designs no more than that.
This section says what the report is, in the words the code uses, and states the readings the decision text left open.
The decision text above is unchanged.
The command (`nemar admin upstream-status`), the weekly section and the mirror flag are not built by this part; the next part builds them and records them in its own amendment, and where this section mentions them it says "will".

### What it is

`GET /admin/upstream-status[?limit=N][&after=onNNNNNN][&dataset=onNNNNNN]` is read-only and admin-only.
It reads D1, asks OpenNeuro for the snapshot lists of the mirrors that need it (a batched GraphQL query, fifty datasets to a request, sequential, ids only as variables), and asks OpenNeuro's GitHub mirror whether a newer tag has arrived.
The report itself writes nothing to D1, GitHub or S3, sends no mail and files no issue (ADR 0052, ADR 0053, ADR 0055); authentication, which wraps the route, still stamps `tokens.last_used_at`.
The verdicts are one pure function in `shared/upstream-staleness.ts`, so that the route now, and the command, the weekly report and the later scheduler (all still to be built) will read the same answer.
A call examines at most 100 mirrors.
`dataset` together with `after`, a `limit` that is not a positive integer, and a malformed `after` or `dataset` are 400.
`counts` in a response is for that page; aggregating pages is the caller's job, and the command of the next part will do it over the rows.

### The population

The report covers managed `on######` mirrors: `source = 'openneuro'`, not owned by the system user.
A withdrawn mirror is excluded from the pass and counted on its own, so the report says how many it left out.
Any other `on######` row (another `source`, or owned by the system user) is also left out and counted, as `excluded_unmanaged`, so what was left out is said (ADR 0054).
`xx` fixtures are not covered, and the "Left open" item above stays open for the re-pull phases.
Every other managed mirror is classified, public or not; the row carries its visibility.
Design §4 said "public"; the decision text does not, and a private mirror that is behind is still behind.

### The states, and which wins

A row is exactly one of `current`, `stale_ready`, `mirror_lag`, `stale_unverified`, `anomaly`, `unknown`, `not_examined`, `unpublished`, `in_progress`, `parked` or `unchecked`.
"Stale" is the sum of the three `stale_*` states.
The first matching step wins:

1. An import is preparing, copying or finalizing and the row is not blocklisted: `in_progress`.
2. The row is blocklisted, or its import is quarantined or rolled back: `parked`.
3. `source_id` names another dataset than the id implies: `anomaly` (`source_id_mismatch`).
4. No NEMAR version exists: `unpublished`.
5. The highest version was never examined for its tag: `not_examined`.
6. The highest version's tag is unknown: `unknown`, never current and never stale.
7. The tag is known and OpenNeuro was not asked or could not answer: `unchecked`.
8. Upstream is deleted or absent: `anomaly` (`upstream_deleted`, `upstream_absent`).
9. Upstream has no snapshot: `anomaly` (`upstream_no_snapshot`).
   A snapshot in upstream's own list was created after the one it calls latest: `anomaly` (`upstream_latest_inconsistent`), before the tags are compared.
10. The latest tag equals the recorded one: `current`.
11. The latest tag is not a numeric tag: `anomaly` (`upstream_tag_unparsable`).
12. The recorded tag is not among upstream's snapshots: `anomaly` (`recorded_tag_not_upstream`).
13. The latest snapshot was created at the same time as the recorded one (`upstream_older`; an earlier latest is already `upstream_latest_inconsistent`, because the recorded tag is in the list), or either date is unreadable: `anomaly` (`upstream_older`, `upstream_dates_unreadable`).
    The latest's own date is tried first and its entry in the list second; if neither reads, the row is `upstream_dates_unreadable` before the tags are compared, so an undated latest never reads `current`.
14. Otherwise upstream is newer, and the GitHub mirror decides between `stale_ready`, `mirror_lag` and `stale_unverified`.

A row that cannot be compared (steps 1 to 5) is never sent to OpenNeuro.
`unchecked` is the state of a mirror whose answer could not be had, and it is never rendered as current or as not stale (ADR 0053, ADR 0054).
A partial GraphQL response (a node and an error for the same alias), a null latest beside a non-empty list, and an error message that is not "Dataset <that id> does not exist." are each an `unchecked` read, never a verdict.

### Upstream's creation order decides, not the number

Design §4 said tags compare numerically, and the decision text does not fix an order.
Real histories contradict the numeric reading: `ds000001` has snapshots `00006` (2018) and `1.0.0` (2020), and `1.0.0` is numerically smaller.
Ordering by number would call a mirror recorded at `00006` an anomaly while it is stale.
So the recorded tag must appear in upstream's snapshot list, and upstream's latest is newer when its creation time is later.
`compareSourceTags` is not used for the verdict.
A latest tag that the Phase 2 parser could never record (`57fecb0c...` is a legacy snapshot id; `v2.0.2.` is a negative example of the parser's tag pattern) is an anomaly, because a re-pull to it could never be proved afterwards by a recorded `source_version`.
Known limit: a tag re-created upstream under the SAME tag (OpenNeuro's `ds003645` 2.1.0 carries a creation time later than its first sighting) cannot be detected from the tag, so the mirror reads `current` or `stale` by tag alone.
The dry-run plan of the re-pull phase compares trees and sees it.

### Mirror lag is proved, not inferred

The report reads `dataset_description.json` of `OpenNeuroDatasets/<ds>` at the newer tag through the authenticated raw CDN.
A hit is `stale_ready`.
A 404 is `mirror_lag` only if a control read of the same repository at `HEAD`, with the same credential, succeeds: the same kind of proof as the backfill's for a 404 (Phase 2 amendment), read at `HEAD` because OpenNeuro's default branch name varies, where the backfill reads `main`.
A 200 counts only when its body is a JSON object, so an HTML page served with a 200 is `stale_unverified`, for the tag read and for the control read alike.
An error, a 404 on the control too, or a call whose probe budget ran out is `stale_unverified` with the reason, and is still counted stale.
Two known limits: a tag whose root holds no `dataset_description.json` would read as lag, which is not seen in practice; and the raw CDN caches a 404 for about five minutes, so a tag that arrived minutes ago can read `mirror_lag`, and a re-check inside that window will not change it.

### Probably stale, for display only

An `unknown` row is compared with upstream by date only to say "probably stale": upstream's latest snapshot was created after the mirror's highest NEMAR version row.
It is a separate count, never added to stale and never recorded as a tag (decision 4).

### No cron, and nothing is filed

Nothing acts on staleness before the scheduled re-pull, and ADR 0053 says an alarm needs outstanding work.
The report runs on demand.
The Monday report will carry a counts-only section (the next part builds it), which will be the unconditional heartbeat ADR 0054 asks for.
The argument against a daily job holds once that section lands: until then nothing sends the number anywhere, and the on-demand route is the only reader.
A daily job would spend subrequests on the busiest tick and produce a number nobody receives.
The scheduler of the later phase will call the same service.

### Two points the decision text should have made

"In-progress" can mean only `import_jobs` today.
When `upstream_repulls` exists, a non-terminal row there must join step 1, and candidates for a re-pull come from `stale_ready` alone.
A report with stale mirrors is a successful report.
The route answers 502 only when at least one row on the page needed an OpenNeuro verdict (a known tag) and every such row ended `unchecked`.
A page of only unknown-tag rows with OpenNeuro down is 200 with those rows `unknown`, their reasons naming the failure, and a partial failure is 200 with some rows `unchecked` and the problem in `errors[]`.
A per-alias OpenNeuro read failure on an UNKNOWN-tag row leaves the row `unknown`, with `unchecked` at 0 and `errors[]` empty (`errors[]` carries batch-level failures only), so the command must not read unknown rows as verified clean: they are by definition not compared, and the reason text names the failure.
So a 200 does not prove every mirror was compared: the command of the next part must treat a 200 whose rows include `unchecked`, or whose `errors[]` is not empty, as "could not see" and exit 2, not only a 502.


## Amendment 2026-10-24 (#1910): Phase 4b builds the command, the weekly section and the mirror flag

Epic #1046, Phase 4, second part.
This part builds what the Phase 4a amendment said "will" be built: the command that walks the report, its section in the Monday report, and the derived mirror flag of decision 5.
The decision text above and the Phase 4a amendment are unchanged.

### The command

`nemar admin upstream-status` walks `GET /admin/upstream-status` page by page and adds the pages up itself.
It recounts the states from the deduplicated rows with the shared counter and never adds the pages' own `counts`, so a row seen on two pages is counted once.
It exits 0 when no row was `unchecked`, no page failed or carried `errors[]`, `--max-pages` did not stop the walk early and the population did not change during the pass, whatever the stale count: stale is a finding, not a failure.
Exit 0 does not mean a clean fleet: unknown-tag and never-examined mirrors were not compared and still exit 0, which is why the report prints them with their own counts.
It exits 2 when the pass could not see: any `unchecked` row, any page the API refused (502, after which the walk stops, because a down OpenNeuro would cost its timeout on every remaining page), any page whose `errors[]` is not empty even on a 200, `--max-pages` reached before the end, or a population that changed during the pass.
It exits 1 when a request fails; after a failed first read it prints the failure and no table, because a table of zeros would claim a fleet that was never read.
An `unknown` row is by definition not compared, and the command says so; a per-alias OpenNeuro failure on one leaves it `unknown`, so it is never read as verified clean.
`--dataset` and `--after` examine part of the fleet and do not demand all of it.

### The weekly section

The Monday report gains `## Upstream freshness`, after Coverage: "Examined N of M" and how many of those were actually compared with upstream (a mirror never examined for its tag is examined and not compared), counts by state rendered only through the one renderer that prints unknown as unknown, "Stale in total", the count of unknown-tag mirrors that look stale by date (display only), and a pointer to the command.
The split of the stale rows between "tag on the GitHub mirror", "not there yet" and "not checked" depends on the 25 probes one pass makes and is not a fleet-wide proportion; the report says so.
No dataset is named in it, and none in the errors it adds, because the report is filed on a public-facing repository.
Stale is reported and is not a reason for the week to ask for attention: it is the expected backlog until the scheduled re-pull exists, and an alarm that never clears gets muted (ADR 0053).
Blindness is a reason, and arrives three ways.
A pass that did not run or threw leaves `upstream` null, which the shared attention rule treats as unknown, and so does a backend that predates the field.
A mirror that could not be compared (`unchecked`), a problem OpenNeuro reported, and a pass that did not reach every mirror each add one entry to the report's list of failed parts, which the headline counts.
The pass is bounded for the Monday tick, which shares ONE subrequest allowance with its other jobs.
A page of 100 mirrors is at most 2 GraphQL requests and 3 D1 statements, so 20 pages are at most 40 GraphQL requests and 60 statements, plus at most 25 tag reads and 25 control reads (the probe budget is for the whole pass, not per page), plus one token mint: about 151 in the worst case, and about 101 for a fleet of 1,000 mirrors.
The token is minted once for the pass, and a failed mint is remembered rather than retried on every page.
A stale row the budget left out reads `stale_unverified`, which is still stale.
The 20-page cap is a ceiling of 2,000 managed mirrors.
Past it `truncated` is always true and every Monday would add a "did not reach every mirror" entry, a permanent alarm that gets muted (ADR 0053), so when the fleet nears 2,000 the cap must be raised; each added page costs up to 5 subrequests.
`nemar admin import-weekly` prints the same counts, and `unknown` when the pass is null or absent.
It exits 2 when the pass threw (the backend then also lists an `upstream` entry among the failed parts, which that command already reads as "could not determine"), and 1 when the backend predates the field (the key is absent and there is no such entry).
The log line gains `upstream_stale=` and `upstream_unchecked=`, `unknown` when null.

### The mirror flag

Decision 5 defines a mirror as a version row with `source_version` set and a version of the form N.0.0, and says the API exposes it as a derived flag.
The flag is three-valued, because a literal boolean would have to say "not a mirror" for a version whose tag is unknown, which is the unknown-as-no that ADR 0054 forbids.
`true`: an N.0.0 of an `on######` dataset whose row records a known tag (basis `doi` or `lineage`).
`false`: any other dataset, or a version that is not N.0.0, whatever it records (NEMAR's own corrections are N.x.y).
`null`: an N.0.0 of an `on######` dataset whose tag is unknown or was never examined; a consumer must not show it as a mirror.
It is read from each row's own tag, not from the dataset's highest version, derived at read time and never stored, so `datasets` gains no column.
It rides on every version of `GET /datasets/:id/versions` (beside the tag and its basis, which that owner-or-admin route already carried) and of the public landing, `data.nemar.org/<id>/` as JSON and the page bundle's landing, which exposes the flag only and neither the tag nor its basis.
Decision 5 says the website shows a mirror tag on that version.
What the website receives is the flag, so it shows a chip from `mirror`; the public wire carries the flag and never the tag itself.
`metadata.json` is not changed.
An `xx` fixture is `false` even after a rehearsal re-pull; how an `xx` names its upstream stays open (Left open, above).

## Amendment 2026-10-24 (#1912): Phase 6 builds manual execution

Epic #1046, Phase 6, delivered in slices; each pull request adds the slice for what it builds, and the decision text above is unchanged.
This slice is the record (decision 3) and the fences that guard it (decision 6).
Nothing here copies, pushes or opens a pull request: the record is written by routes that only record and refuse, and no route sends mail (a source scan pins that the code imports no mail service).

### The table keys a row by attempt

Decision 3 reads "one row per `(dataset_id, to_tag)`, `UNIQUE`".
Taken literally, a tag whose re-pull was abandoned or failed could never be tried again, so this record reads it per attempt: migration 0105 keys the row by `(dataset_id, to_tag, attempt)`, and the partial unique index still allows one non-terminal row per dataset.
A new attempt for a tag is allowed only when every earlier attempt ended `abandoned`, `failed` or `superseded`.
A tag is merged as a major once: a second partial unique index on `(dataset_id, to_tag)` where `merge_sha` is set backs that in the database.
A row with the same tag and the same plan digest is returned as it is (200), before the version rows are consulted, so a rerun resumes it even after N.0.0 is tagged and is no longer the dataset's highest version; any other open row is `repull-in-flight` and names itself.

### A merge that nothing has reconciled blocks the dataset

Create refuses (`merge-unreconciled`) when any record of the dataset holds a merge claim or a merge sha, for either pull request, and is not finished, whatever its status: `failed`, `released`, `merged` and `gates_clear` all count.
`complete` is finished, and so is `patch_declined`, which is reachable only from a released N.0.0 and is refused while the patch claim is held.
A `failed` row that has a tag sha and no patch claim or patch merge is finished too: N.0.0 is merged and tagged, so nothing is unreconciled, though its tag stays pulled.
The case Phase 6f still owns is a `failed` row with a claim or a merge sha and no tag sha, or with any patch claim or patch merge: nothing in 6a writes out of it.
`failed` stays writable on purpose, so a lost merge answer can be reported; it does not free the dataset, because a merge may be on `main` with no row saying so, and a second major would be a second DOI.
Clearing a claim after GitHub confirms the pull request was not merged, and expiring a stuck open row, are written by Phase 6f (resume and reconcile); Phase 6a has no writer for either, and open rows never expire here.

### The fences, as built

- **Environment.**
  Every `/admin/repulls` write refuses a dataset that is not `xx` unless `ENVIRONMENT` is exactly `production`.
  The test is "is production", not "is not a known non-production value": the organization is shared, so an unset or misspelled binding must leave the fence on, which is the reverse of the repository's usual fail-closed helper.
  The same fence applies to a transition, so a record of an `on` dataset cannot be moved outside production either.
- **Anonymous datasets** are refused (`anonymous-dataset`) with no override.
  A re-pull takes upstream's authors and README, which would undo ADR 0065's blind.
- **A withdrawn dataset**, **an import that is preparing, copying or finalizing**, and **a dataset not recorded as a mirror of that `ds`** are refused, each by its own code.
  These run at create only: the execution phases must re-check the anonymity, withdrawn and import fences when they move a record, which a transition does not do today.
  *Annotated 2026-10-24: superseded by the Phase 6e amendment: the mirror, anonymity, withdrawn and import fences now also run at the screen's dispatch, at the gates and at the claim to merge.*
- **The dataset's own version rows must agree with the plan.**
  The highest version (both `1.0.0` and `v1.0.0` spellings, ordered by number) must be the plan's `from_version`, and every row at it must name `from_tag` by `doi` or `lineage`.
  A row recorded `unknown` is never re-pulled (decision 4).
  A row never examined is accepted only when the plan itself establishes the lineage, because the Worker has no other evidence of the tag.

### The states as built

The 17 states, and the only edges between them, are `shared/repull-state.ts`; the database holds the stage invariants as CHECKs, so a half-written row is refused even by a writer that skips the service.
A transition is one compare-and-set on the recorded status and on the row's `revision`, which every write increments, so of two writers that read the same row only one applies, even when both repeat a status.
It takes only an allowed edge, writes only the columns its target names, and keeps the pull request's branch and number once set.
A branch must be the release branch of the version the row carries.
`counts` is merged key by key and holds only declared keys with non-negative integers, never a path or a key.
`last_error` goes through the ADR 0051 rule and is never blank; an edge into `failed`, or the `planned` edge that records why a step could not finish, must say why, and an edge into a different, non-terminal status clears the stored error.

Four edges repeat a status to write one thing: `planned` (the error), `released` (the count of locked objects) and `gates_clear` and `patch_gates_clear` (the claim to merge).
The claim is recorded before the merge is sent, names exactly the screened head, and cannot be recorded twice.
The caller sends the head and nothing else: the Worker stamps the time with its own clock and refuses a request that carries one, because a caller-stated time could be backdated or set ahead and defeat the sweep for stuck claims that Phase 6f writes.
The time and the head are set together or not at all (a CHECK).
While it is held, closing the pull request (`abandoned`, `superseded`, `patch_declined`) and moving its head (`pr_open`, `patch_synthesized`) are refused, because the pull request may have merged; `failed` is not.

Two kinds of state are not written by this route, so a caller cannot state them.
`merged`, `released`, `patch_merged` and `patch_released` are facts about GitHub and the version row, and are written only by routes that read them.
`gates_clear` and `patch_gates_clear` are written only when the identifier screen is bound to the row.
Both groups are refused here (`use-verified-route`, `screen-not-built`) except for the repeating edges above, so the record cannot be used to skip the screen or to claim a merge that did not happen.
*Annotated 2026-10-24: superseded by the Phase 6e amendment: `screen-not-built` no longer exists; `gates_clear` and `patch_gates_clear` are accepted through the transition route when the screen bound to the row passes for the pull request's live head.*

### The record is deleted with its dataset

Unlike `import_jobs`, whose state row deliberately outlives the dataset so a rolled-back orphan stays auditable, `deleteDatasetCascade` deletes these rows.
A fixture dataset is deleted and re-created under one id, and a stale open row would block the re-created dataset for good; the DOI record of a merged re-pull lives in its own tables, not here.

### Lineage at create

`lineage_recordable` is an administrator's assertion that the plan compared the from-version's tree with upstream's outside the paths NEMAR owns.
The Worker holds neither tree and has no evidence of it; the assertion is recorded in the audit row.
When it is made, create upgrades that version's row to the basis `lineage`, in the same batch as the record, and says how many rows it upgraded (`lineage_rows`).
It writes only a row never examined, or one that already names the same tag by `doi` or `lineage`, in either spelling of the tag; a row recorded `unknown`, or naming another tag, is never overwritten.
The upgrade is one way: `doi` becomes `lineage` and nothing writes it back, so the audit row records the basis the row held before.
One statement writes the word `lineage`, and a source scan keeps it the only one.

### The staleness report reads the record

The staleness report's Amendment (#1910) says "in-progress" can mean only `import_jobs` until `upstream_repulls` exists, and that a non-terminal row there must then join the first step.
It does now: a mirror with one open re-pull, in any non-terminal status, is `in_progress` ("a re-pull to <tag> is <status>"), is never sent to OpenNeuro, and is never offered as a candidate for another re-pull.
The partial unique index allows at most one open row per dataset, so the join adds no rows.

## Amendment 2026-10-24 (#1910): Phase 4c builds the measurement

Epic #1046, Phase 4, third part.
Gate G2 of the design record asks for a measurement before anything runs on its own, and decision 6 lists what it holds.
This part builds the half of it that upstream alone can answer: `nemar admin upstream-status --measure`.
The decision text above and the earlier amendments are unchanged.

### What it measures

For each stale mirror (`stale_ready`, `mirror_lag` or `stale_unverified`) the command reads OpenNeuro's recursive file listing at the recorded tag and at upstream's latest tag, in one request, and summarizes the difference.
Files match by name, and a file is changed when its identifier differs, whatever its size.
An annexed file's identifier is its annex key, so a changed key is changed content.
A file counts as annexed when the snapshot that holds it says so: the new side for an addition, the old side for a deletion, either side for a change, so a file that moves between git and the annex is annexed.
A delta is data-changing when any annexed file was added, changed or deleted, and metadata-only otherwise.
The bytes to copy are the sizes of the distinct annex keys the latest snapshot has and the recorded one does not, read from the size each key declares in its fields (the strict field, so a free-text name that looks like a size is not read as one) and otherwise from the listing.
A listing is refused rather than summarized when it cannot be a snapshot: no file at all, no root `dataset_description.json`, a size that is not a non-negative integer, a repeated filename, or an answer that carries `errors[]` beside its data.
An empty tree would otherwise make every file of the other snapshot look added or deleted.
The mirror report prints the files added, changed and deleted, the bytes to copy, and how many deltas are metadata-only and how many are data-changing.
The listings are a few megabytes for a dataset of thousands of files, so the command reads them from the administrator's machine and the Worker never does.

### DOI volume

The estimate reads the snapshot lists the staleness pass already holds, for every mirror whose tag is known.
The catch-up is one re-pull, straight to the latest tag, for each stale mirror.
The trailing year of upstream churn is counted two ways: one re-pull for every snapshot created in the window, and at most one per 30 days for a dataset.
A dataset's first snapshot (the earliest by date, whatever the list order) was its import and is not counted; when any snapshot of a dataset has an unreadable date the earliest cannot be named, so none is left out for that dataset and the estimate errs high.
A snapshot whose creation date does not parse is counted separately and never read as old, and a snapshot dated in the future is counted separately and left out of the figures.
The human report also lists the mirrors the estimate left out, by state.
Whether a re-pull also carries NEMAR's corrections, and so a second DOI, is known only from a plan, so every figure is also given doubled as an upper bound.
At the default `REPULL_DAILY_OPEN_CAP` of 2 the catch-up takes the number of re-pulls divided by two, rounded up, in days.

### Two limits, and what belongs to Phase 5

The delta is upstream's between the two tags.
It is not NEMAR's tree: NEMAR's own corrections, the scrub, the annex policy and date normalization are not in it, so it says how much upstream changed and not how much a re-pull would write.
A tag recorded with basis `doi` is a declaration, not a tree comparison (see "What `doi` means"), and early imports cloned the default branch, so a delta measured from a wrong declaration is wrong.
The command prints both limits with the numbers.
The conflict and unexplained-path counts of gate G2 need a plan, which compares NEMAR's tree with upstream's; they come from Phase 5's `nemar admin repull plan`, and G2 is complete only with them.

### Unknown is never zero

A listing that could not be read leaves that delta null with its reason and counts it as unknown.
A stale mirror left out by `--measure-limit` is counted as not measured.
While either count is above zero, or a new key in a measured delta has no known size, the total bytes to copy is null, and the sum over the deltas with a known size is printed beside it as "at least".
A total also says what it does not cover.
Only stale mirrors are measured, so the measurement carries the scope of the pass (the whole fleet, one mirror, or the mirrors after a cursor) and a count of the mirrors it cannot measure: unknown tag (and how many of those look stale by date), never examined, unchecked, anomaly, in progress, parked and unpublished.
The measurement is marked incomplete while any delta is unknown or not measured or a new key has no known size, so a complete measurement always has a known byte total; a deliberate `--measure-limit` leaves the exit code at 0.
A delta that could not be read exits 2, as an `unchecked` row does: the pass could not see.
Reading is sequential, with a progress line every ten mirrors, and stops after five consecutive failed reads to reach OpenNeuro (a network error, a timeout or an HTTP error): the rest are recorded as unknown with that reason, because OpenNeuro being down would otherwise cost the timeout on every remaining mirror.
A listing that OpenNeuro answered but that is unusable for one dataset (a snapshot deleted upstream, no root `dataset_description.json`, errors beside the data) marks only that mirror unknown and does not count toward the stop.
Only a complete pass is measured: one that threw, was refused, stopped at `--max-pages`, saw the population change, had an `unchecked` row or carried `errors[]` may hold a partial set of stale mirrors, and totaling a part of the fleet would read as the whole.
Such a pass reports `measurement` as null with the reason and keeps its own exit code.
The measurement is read-only: it writes nothing to NEMAR or to OpenNeuro, and the only requests it sends OpenNeuro are read queries.

## Amendment 2026-10-24 (#1912): Phase 6e binds the screen to the row, caps the merge and verifies the release

A further slice of the Phase 6 amendment above, built by Phase 6e.

### The screen is bound to the row

This slice is the screen of decision 7, the merge cap of decision 6, and the two facts the record could not state before, the merge and the release.
Nothing here merges, opens or closes a pull request, and nothing mails anyone; the source scan that pins the record's import closure now covers the screen, its callback and the verified service too.

A re-pull's screens live in `upstream_repull_screens` (migration 0106): one row per screened commit of one of the two pull requests, `n0` for N.0.0's and `n1` for N.0.1's.
`POST /admin/repulls/:id/screen` dispatches the publication screen's workflow with `ref` set to the recorded head, `request_id` 0, and a callback of its own, `/webhooks/identifier-screen-repull-result`, whose token is a kind of its own.
The token binds the dataset, the row, the pull request, the commit and a one-shot nonce, under a domain line no other kind's message begins with.
A screen is dispatched only while its pull request is open and not yet clear (`pr_open`, `patch_synthesized`), only for the head the row records, and only while the environment and dataset fences hold.
Outside production only an `xx` dataset passes the environment fence, and ADR 0086 exempts `xx` from the screen, so a non-production Worker never dispatches one.
The workflow resolves a 40-character `ref` to that commit and reports it as the screened head (read in `scripts/identifier-screen-ci-lib.ts`, not run).

The publication screen mails its result; this one does not, so it reads the publication screen's helpers from the module that mails nobody.
The report deadline and the Worker's own error report moved there for that reason, and the publication screen re-exports both.

Unknown is never clear.
No screen, a screen that errored, and one still pending 50 minutes after its dispatch all read as "run it again"; the last reads `unreported` when it is read, so no cron writes it, and its run may still report until a new dispatch replaces the nonce.
A report about another commit or another dataset, or outside the contract, is stored as the Worker's `workflow-failed` error, never as a verdict.
A commit is dispatched again while it has no verdict, and while its verdict asks for a person (review, unchecked, not screened, clean in EDF only) and no administrator has acknowledged it, so a rerun may still clear it; a run still out, a clear verdict, a direct identifier and an acknowledged verdict are not, and only a new commit is screened anew.
Dispatching for a new head frees the earlier run, so at most one run per re-pull waits for a report, which the callback needs because the workflow echoes only the dataset.

An acknowledgment (ADR 0086) attaches only to a verdict that asks for a person, never to a direct identifier, with a reason of the publication path's length, and the database refuses one on any other state.
It counts only for the administrator who recorded it, the publication path's rule, so a reason one administrator gave does not stand in for another's at the gates or at the merge.
It is recorded once: a second administrator is refused (`already-acknowledged`), and the write itself holds only while none is recorded.
So if the administrator who recorded it is absent, or is no longer an administrator, nothing else unblocks the pull request: only a new head, screened anew, does.

The edges into `gates_clear` and `patch_gates_clear` were refused by the record until the screen was bound (`screen-not-built`); they now open.
The gates sha must be the head the row records, the dataset fences are read again, and the screen must pass for that head; the statement that writes the edge re-asserts the verdict it read, so a verdict that changed in between is not relied on (`screen-changed`).
The caller's word for the head is not taken: before the gates and before the claim the Worker reads the live pull request on GitHub, which must be open, not a draft, unmerged, aimed at `main` from the recorded release branch, with its head at the sha being gated or claimed; a GitHub that cannot be read refuses (502), a draft is `pr-draft` (409) and takes no unit of the cap, and any other mismatch is `head-moved` (409), with nothing recorded.
The live read is followed by the UPDATE and then the caller's merge, so the head check holds only if Phase 6f's merge call passes that same `sha` to GitHub's merge API, which refuses a head that moved: GitHub's `head.sha` can lag just after a push, in the unsafe direction, and the merge's own `sha` is the check that closes that gap.
The dataset fences are read again by the Worker at every step toward a merge: the dispatch, the gates and the claim; the other edges still re-check only the environment fence.

### The merge cap, as built

The claim to merge stays the self-edge the first slice built, and it now also needs the dataset fences, the screen passing for the claimed head, the live head, and one unit of `REPULL_DAILY_MERGE_CAP`.
The screen's verdict, the unit and two of the dataset fences (neither anonymous nor withdrawn) are in the statement that writes the claim, so they are atomic with it, and two claims racing for the last unit cannot both win; the mirror and import fences and the live head are read before it.
A refused claim writes nothing (ADR 0099).
The day is a fixed UTC day on D1's own clock, and N.0.0's and N.0.1's claims count together, because each merge mints a DOI.
The binding reads as Phase 7's caps will: absent, the default 5; one or two digits from 0 to 20, that number, and 0 stops every merge; anything else reads 0, and the refusal says the cap is unreadable (`merge-cap-unreadable`) rather than quietly falling back to the default.
Reporting that as attention in the weekly report is Phase 7's.

A claim is released only when the caller says the merge was not sent or was refused, while the row is still at its gates-clear status holding that claim, only once the claim is five minutes old by the Worker's own stamp (`claim-too-recent` before that), and only when GitHub says the pull request did not merge; an unknown outcome cannot release, so a lost answer is resolved from GitHub.
That is a guard of one read and an age, not proof that no merge is in flight: a merge that lands between the read and the release is recorded later, by the merge route, as one no tool held a claim for.
The route is built here; Phase 6f's resume is its caller.

### The merge and the release, verified

`merged` and `patch_merged` are written by `POST /admin/repulls/:id/merged`, after the Worker reads the recorded pull request on GitHub with its own credential: its number, its release branch, aimed at `main`, merged, and GitHub's merge commit.
A merge with no claim held by a NEMAR tool, and a merge at a head other than the screened one, are still recorded, because they happened and the record must say so before a second major could follow; each is counted on its own, `merged_outside_tool` meaning only that no claim was held and `merged_unscreened_head` only that the merged head is not the screened one, and those two counts are written only by the Worker and shown in the record.
The cap binds NEMAR's tools only (Consequences); this is how a merge outside them shows.
A pull request merged while the row is still `pr_open` has no edge here; the row stays open, which blocks a new re-pull, and Phase 6f's resume owns it.

`released` and `patch_released` are written by `POST /admin/repulls/:id/released` once the version row exists with a DOI (either spelling of the version), the tag `v<version>` resolves to the commit the caller reports, and that commit contains the merge.
Containing, not equal: the dataset workflow tags `main`'s head when it runs, which can be an enrichment commit after the merge.
A comparison that says `diverged` or `behind`, or a tag on another commit, is `tag-mismatch`; a comparison GitHub could not make is `compare-unresolved`.
A retried `merged` or `released` that finds its fact already recorded for the same commit answers with the stored row (`replayed`), so a caller whose answer was lost may ask again; another commit is refused.
In the same batch, and only when the transition itself applies: N.0.0's version row is upgraded to `lineage` when the caller verified the tagged tree outside the paths NEMAR owns (an assertion recorded in the audit row, as at create; never for N.0.1, which carries NEMAR's corrections), and the dataset's hed, channel-montage, data and availability stamps are removed, so each of those sweeps reads the new version again.
Only that dataset's stamps are touched, and the values the sweeps wrote stay until each sweep overwrites them.

Decision 2's "one ADR 0023 reconcile is queued" needs no new writer: the Zarr queue's `reconcile` already re-queues a public dataset whose `latest_version` differs from the version it converted, and every conversion runs `--clean`, which reconciles (`scripts/zarr/zarr_queue.py`, `scripts/zarr/hallu-zarr.sh`, read).
A release changes `latest_version`, so the stamp re-arm is the only new behavior.

Checked only against stand-ins, until the canary and the first production runs: that GitHub's commit read resolves an annotated tag to its commit, the words its comparison answers with, and a squash-merged pull request's `head` and `merge_commit_sha` as this reads them.

## Amendment 2026-10-24 (#1912): Phase 6b builds the seams execution shares with the import

Epic #1046, Phase 6, the slice of shared seams: code the import runs that the later slices' execution will run too.
Nothing here executes a re-pull, and the decision text above is unchanged.
It builds the delta scrub's inputs, the ledger word that scrub writes, the generated `participants.tsv` as a standard edit, the order `to_tag` is checked in, and the finalize gate as functions.
It makes two corrections, to decision 1's ledger rule and to the Phase 5 amendment's reading of `to_tag`'s order.

### The scrub takes a scope, a source per key, and a pinned version

Decision 2 says the scrub runs on the delta paths only.
`scrubImportedTree` takes the paths it may read and change (`scope`), and a recording, a JSON file or a scans table outside them is neither read nor changed; its counts see only the scope.
The scope must name every path changed since `HEAD`, staged or not, or the scrub refuses (`scope-incomplete`) before it reads anything, because a changed path it does not read would reach the commit unscrubbed.
A re-pull never commits a header change whose provenance file lacks ADR 0085's sentence: when a header in the scope will change and a provenance file (`sourcedata/sourcedata_provenance.json` or its README) lies outside the scope, the scrub refuses (`provenance-out-of-scope`) before a byte is downloaded, and the caller puts both files in the scope (the lead's ruling of 2026-10-24, which settles the owner question this slice first left open).
A provenance file that is not a JSON object is counted on its own (`provenance_malformed`), apart from one that is not a regular file (`provenance_not_annotated`); the importer warns on either, as it did.
The caller names each annexed recording's source (`sourceOf`) in place of the importer's whereis map: a source, a key NEMAR already holds, whose bytes are already in NEMAR's bucket where the identifier screen reads them (ADR 0086, ADR 0088), so it is counted and not read again, or none, which is counted.
A source can be one version of an S3 object, read at its path-style URL with every segment encoded and `?versionId=` kept, for the header and for the download, so the scrub reads the bytes decision 8's pinned copy will copy; the rules that the object is the key's size and hashes to it are unchanged.
The importer passes none of these, and its suites pass unedited.
The manifest's closing check, every recording a copy brings from upstream had its header read, is a function of its own (`assertCopiedRecordingsRead`), for the re-pull's copy to close with.
That `.log.rmet` records a `versionId` per key stays under "Not yet verified": this slice reads a pin it is given and verifies no upstream.

### `repull-scrubbed`, and the ledger rule (correction)

Decision 1 says a ledger line whose `action` is other than `import-scrubbed` is a recorded correction.
Read literally, the re-pull's own delta scrub would then record a correction on every dataset it scrubs, and the next plan of that dataset would refuse any unexplained path.
The delta scrub writes its own word, `repull-scrubbed`, before the one commit, so no history NEMAR pushes holds what it replaced (decision 9).
The rule, corrected: a recorded correction is a line whose `action` is neither `import-scrubbed` nor `repull-scrubbed`.
A `repull-scrubbed` line holds nothing: a re-import's history hold (ADR 0089) still reads `import-scrubbed` lines only.
ADR 0085's fresh-clone proof tolerates a commit that appends `repull-scrubbed` lines beside other files, as it tolerates the importer's, because the re-pull's commit is one commit; without that, every re-pulled dataset would fail `ledger-commit-not-alone` for good.
It does so only when that commit carries decision 2's `Upstream-Snapshot:` and `Repull-Plan:` trailers and edits no earlier line, so the merge that lands N.0.0 on `main` must keep both trailers in its commit message.
Neither scrub word can be typed: `ledger-cli.ts append` refuses `import-scrubbed` and `repull-scrubbed`, which only the scrub that wrote them, in the commit that carries what it scrubbed, may write.
Decision 10's retarget of an unreleased import still refuses any line but the importer's own, `repull-scrubbed` included.
A re-pull needs a released mirror, which the guard refuses before that rule runs, so the line should never meet it; if it does, dropping a record of a scrub is not the retarget's to decide, which is the safe direction.

### The generated `participants.tsv` is a standard edit (closes the Phase 5 amendment's open item)

The enrichment's placeholder `participants.tsv` (`ensureParticipantsTsv`, for a tree with `sub-*` directories and no file of its own) is one of decision 1's standard edits.
Its rule moved to `shared/standard-edits/participants.ts`, which the enrichment still reaches through `backend/src/services/participants-tsv.ts`, so the plan recognizes the edit by calling the function the enrichment commits with.
Where upstream ships no `participants.tsv` at a tag, NEMAR's file is explained from that tag when it is, byte for byte, the placeholder of that tag's subjects.
The file is a function of the subjects, not of any upstream file, so it is upstream-changed when the subjects changed between the tags, and N.0.0's is the placeholder of `to_tag`'s subjects, or no file when `to_tag` has none.
A placeholder edited afterwards is NEMAR's own addition and stays a correction.
So a dataset whose ledger records a privacy correction is no longer refused for that file alone.

### The plan records its planner

The plan body's `planner` is 2 for this planner, so a plan Phase 5's planner made is refused by execution as made under other rules, never read under these (the refusal is a later slice's).

### `to_tag` is ordered by OpenNeuro's creation order (correction to the Phase 5 amendment)

The Phase 5 amendment took OpenNeuro's latest as `ok` when it was numerically after `from_tag`, and `order-unverified` otherwise; the Phase 4a amendment had already ruled that upstream's creation order decides, not the number.
The plan now reads OpenNeuro's latest and its whole snapshot list, each with its creation time, in one answer: the query the staleness report sends, read by the same parser (`shared/openneuro-snapshots.ts`).
It orders them with the helper the report's verdict uses (`upstreamSnapshotOrder`), so the two cannot disagree.
The check is `ok` only when `to_tag` is OpenNeuro's latest and OpenNeuro's own list shows it created after `from_tag`.
Every order the answer cannot establish is `unchecked` (`order-unverified`), never refused and never `ok`, and the plan is not executable: an unreadable creation date, of the latest, of `from_tag` or of any other snapshot in the list (which could be the newest of all), a latest its own list contradicts, a `from_tag` the list does not name, a latest created no later than `from_tag`, no `from_tag` to order against, and no answer at all with `--to-tag` named; without `--to-tag`, no answer plans nothing (`latest-unknown`).
The staleness report reads the same helper, so another snapshot with an unreadable date makes a mirror `upstream_dates_unreadable` where it would have read stale or `upstream_older`; a mirror at the stated latest is still `current`.
The numbers are never compared, so a mirror recorded at `00006` whose upstream made `1.0.0` later is re-pullable.
A `--to-tag` that is not OpenNeuro's latest stays `unchecked`, as the Phase 5 amendment ruled, even when the list shows it newer.
The latest tag is the same `latestSnapshot.tag` an import pins to, and the query is still a GraphQL POST that only asks, outside the plan's HTTP guard.

### The import's refusal points at the re-pull

Decision 10's `[openneuro-upstream-moved]` refusal of a released mirror now names the re-pull, `nemar admin repull plan <id>`, to OpenNeuro's latest snapshot by default or with `--to-tag` to the tag the import was at, which need not be the newer one, before the repair at the recorded tag, which is still the last thing it says.

### The finalize gate is three functions

The verify, tree gate and register steps of an import's finalize are `verifyManifestObjects`, `treeGate` and `registerTreeKeys` (`src/lib/import-finalize-gate.ts`), with every message as it was, because the Worker classifies them; the re-pull's register step will call the same three.
