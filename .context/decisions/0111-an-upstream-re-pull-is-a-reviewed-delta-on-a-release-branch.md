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

## Context

ADR 0006 fixed the policy for an upstream re-pull and left the machinery to epic #1046.
An imported mirror never re-enters candidacy: discovery parses `latestSnapshot.tag` into `DiscoveredDataset.latestTag`, which nothing reads or stores, and `diffNewDatasets` compares ids only.
Running the importer again is not a re-pull: `POST /admin/datasets/import` answers 403 outside production first, then 409 when the dataset or its repository already exists, prepare's step 4c resets onto `origin/main` under a same-version assumption (#993), so the copy manifest follows the new upstream while the tree stays NEMAR's old one, and finalize skips publication for a public dataset (#985).
Nothing records which upstream snapshot a version mirrors: the importer clones the default HEAD, no importer step sets `Version`, and neither `datasets` nor `dataset_versions` has a `source_version`.
Early imports rewrote every commit, so on `on003645` NEMAR's history shares no ancestry with upstream's although the trees match upstream 2.0.2 plus `.github/`.
`AUTO_IMPORT_ENABLED` is `"true"` in production (`backend/wrangler-sccn.toml`), so nothing a re-pull needs may reach the auto-import's candidate set.
Measured staleness is real: `on004362` missed upstream's 1.0.1 metadata fix (#1810).

## Decision

Everything in this section is designed and not yet built.

**An upstream re-pull replays the delta between two pinned upstream tags onto NEMAR's `main` as one synthesized commit on `release/vN.0.0`, landed through a pull request; N.0.0 is a pure mirror of the upstream snapshot, and NEMAR's corrections follow as N.0.1.**

### 1. N.0.0 is a pure mirror, and upstream wins every conflict

- The N.0.0 tree is upstream's tree at `to_tag` with NEMAR's standard edits applied, and nothing else outside the paths NEMAR owns.
- NEMAR owns `.nemar/**`, `.github/**`, and in `dataset_description.json` the keys `DatasetDOI` (the concept DOI) and `Version`, and the `SourceDatasets` entry naming this dataset's own `ds`, which becomes `{DOI, URL, Version: to_tag}`.
  Other `SourceDatasets` entries are kept from both sides, and every other key and path is upstream-owned.
  `CHANGES` is upstream-owned, and NEMAR never writes it.
- The standard edits are re-applied as functions, never merged as text: the README rename and DOI badge, the `.nemar/` line in `.bidsignore`, ADR 0060's annex policy, moving git-resident data into the annex, ADR 0089's scrub with its provenance sentence, and ADR 0091's date normalization.
- A change recorded in the dataset's privacy ledger (`.nemar/corrections.jsonl`, ADR 0085) is a standard edit: N.0.0 carries it, and a plan that would revert one refuses.
  The ledger holds counts and no per-file list (ADR 0036), so when it records a correction and the plan cannot tell whether an unexplained path belongs to it, the plan refuses rather than revert it.
  This keeps ADR 0085's promise that a re-pull is scrubbed again and does not reintroduce what was corrected.
- Base is upstream at `from_tag`, theirs is upstream at `to_tag`, and ours is NEMAR `main`.
  An upstream-changed path is one that differs between base and theirs.
  A delta path is one the re-pull's commit adds or changes relative to ours.
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
- Corrections replay as N.0.1, the next patch, in a second pull request that targets `main` and is opened with N.0.0's.
  It is merged only after N.0.0 has merged and been tagged.
  Both are squash-merged, as `y` in ADR 0093's `next` merges, so N.0.1 cannot be stacked by branch ancestry: once N.0.0 is tagged, N.0.1 is synthesized again on the new `main` (the corrections replayed onto N.0.0's tree), and its gates are read on that commit, never on the one it was opened with.
  A re-pull with no corrections opens no N.0.1.

### 2. The delta is replayed as one commit, through a pull request

- The plan compares base, theirs and ours per path (decision 1), on a clone of `nemarDatasets/<id>` at `main` (so `enableremote nemar-s3` reuses the bucket's UUID, avoiding #1320) and metadata-only clones of upstream at the two tags.
- The result is one commit on `release/vN.0.0`, carrying the trailers `Upstream-Snapshot: <ds>@<to_tag>` and `Repull-Plan: <digest>`.
  N is the next major after the highest of the `dataset_versions` rows, the `v*` tags and `Version` on `main`; the plan refuses when the three disagree or another release pull request is open, not counting this re-pull's own N.0.1.
- It lands through a pull request, never a bypass and never a direct push, and it is never a git merge of upstream's history: upstream's commits are not pushed to NEMAR.
- The scrub, the annex policy and the date normalization run on the delta paths only (decision 1), before the copy and before the commit.
  An object the copy writes is anonymously readable by key (ADR 0089), so nothing unscrubbed is copied into NEMAR's bucket, and nothing unscrubbed enters NEMAR's history.
  A recording the commit does not touch keeps its bytes and its key.
- `nemar admin repull <id>` is a dry run by default, and `--execute` requires `--plan <file>` with the digest of the reviewed plan; when `main` moved since the plan, it plans again unless the new commits touch only `.nemar/**`.
- The merge goes through the existing release path: the existing dataset workflows tag the merge, the tag mints the version DOI through EZID (ADR 0007), and the DOI carries `IsDerivedFrom` `openneuro.<ds>.v<to_tag>` because the mint reads `SourceDatasets` at the tag.
- New behavior the build adds, because no callback does it today: after the tag, one ADR 0023 reconcile (`--clean`, never `--wipe`) is queued for the dataset, so the Zarr stores of deleted recordings go, and the dataset's hed, channel-montage, data and availability stamps are re-armed.
  Today those four stamps are cleared only fleet-wide, by `?reset=1` on the sweep routes in `backend/src/routes/admin/datasets-lifecycle.ts`; the identifier sweep's verdict already counts only for the version it was dispatched for (ADR 0088).

### 3. Re-pull state lives in `upstream_repulls`, never in `import_jobs`

- One row per `(dataset_id, to_tag)`, `UNIQUE`, plus a partial unique index allowing one non-terminal row per dataset.
- The one row records both pull requests: `branch`, `pr_number` and `head_sha` for N.0.0, and `patch_branch`, `patch_pr_number` and `patch_head_sha` for N.0.1, which stay NULL when there are no corrections.
  `origin` records who opened them: `automatic` for the scheduled path, `administrator` for `nemar admin repull <id> --execute`.
  A second row keyed by version was rejected because the N.0.1 row would be open beside the N.0.0 row, which the one-non-terminal-row index forbids.
- Its states are planned, prepared, copied, registered, pr_open, gates_clear, merged and released, then, when there is an N.0.1, patch_synthesized, patch_gates_clear, patch_merged and patch_released, and finally complete.
  Abandoned, failed and superseded are terminal, and superseded means a newer tag arrived before N.0.0 merged, so the pull requests are closed and the plan made again from the same `from_tag`.
- Every step checks its own end state before it acts, so `--resume` continues from the recorded status.
  `--abandon` closes the pull requests, deletes the branches and reports the orphaned bytes, and is refused once N.0.0 has merged, because its tag and DOI exist.
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
- the ADR 0107 review stored for that head is not `declined`, which blocks even where the review's ruleset is only a shadow check;
- the pull request's head equals the screened SHA;
- the daily merge cap is not exhausted, and its claim is made before the merge is sent.

The merge is sent with the screened SHA, so GitHub refuses a branch that moved, and only when GitHub reports the pull request `clean`: the NEMAR App is a bypass actor (ADR 0001, ADR 0107), and `clean` is what keeps "never a bypass" true for a merge the App makes.
The Worker submits no approving review on this class either, since ADR 0001 requires none; the record is the merge, the `upstream_repulls` row and the plan digest.

**What this narrows in ADR 0093, for re-pull pull requests only.**
ADR 0107 already partially supersedes ADR 0093; this record narrows one more aspect of it, the merge, and only for this class.
ADR 0093's approval sentences stand as written, "its approval is made by the administrator, from their machine, with their own GitHub login" and "No Worker code path approves", because the Worker submits no review.
What changes, for a re-pull pull request the automatic path opened, is that a merge no longer always follows an administrator's approval and `--merge` or `y`: the Worker merges one that is machine clean.
For every other pull request the Worker neither approves nor merges.
AGENTS.md's summary of ADR 0093 ("nothing merges without `--merge` or a `y`") is updated by the phase that builds the merge.

A re-pull pull request that is not machine clean, or that an administrator opened, is merged by an administrator, through `nemar admin repull <id> --merge` or `nemar admin pr-reviews`, under ADR 0093, with a screen that is `clear` or carries the administrator's recorded acknowledgment (ADR 0086).
`nemar admin pr-reviews` will require that screen for a re-pull pull request, which its `approve --merge` does not check today, and will claim the merge cap before the merge is sent.

An `xx` re-pull takes the administrator path only.
ADR 0086 exempts `xx` from the identifier screen, so an `xx` re-pull never has a `clear` verdict and is never machine clean, and an administrator merges it under that exemption, with no screen.
The Worker's merge call is not built until the ruleset check below is done.

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
- A re-pull's `from_tag` is the recorded `source_version`, and its `to_tag` is a tag.
- The import path gets #993's guard, and only for a released mirror.
  Step 4c refuses with `[openneuro-upstream-moved]` when `origin/main` records a tag (its `SourceDatasets` entry), the dataset has released a version (a `dataset_versions` row exists), and the tag being imported differs from the recorded one.
  The classifier calls that `upstream_moved`, and the retry engine parks it like `identifier_scrub_refused`, because moving a released mirror to a new tag is a re-pull's job.
  An import that never released a version and is retried is prepared again at the tag the retry discovers: it is the same import, not a re-pull.
  An unrecorded tag, `origin/main` naming none or the released version's `source_version` being NULL, never trips the guard.

## Consequences

- **DOI volume grows with upstream churn.**
  Every merged re-pull mints a version DOI that cannot be withdrawn, and a re-pull with corrections mints two.
  The volume is measured before anything runs on its own (gate G2 of the design record), and the owner sets the caps from that estimate and turns the switches on (G5).
- **Two DOIs when N.0.1 has content.**
  N.0.0 cites upstream's snapshot without NEMAR's corrections, which is what its number says, and N.0.1 is the version a reader most likely wants.
- **A window between N.0.0 and N.0.1.**
  Between the two merges the public latest lacks NEMAR's corrections; the window lasts at least until N.0.0 is tagged and N.0.1 is synthesized again and its gates pass, and a conflict keeps its correction out until an administrator resolves it.
  A change the privacy ledger records, and a change a deterministic rule re-applies (the scrub, the date normalization), are standard edits, so N.0.0 carries them and the window never lacks them.
  Every other correction is in the window, including a privacy-minded one the ledger does not record.
- **Orphan locked objects.**
  An abandoned re-pull leaves copied objects under the governance lock; they cost storage and are reported, not deleted.
- **One synthesized commit instead of upstream's history.**
  NEMAR's log shows one commit per re-pull, named by its trailers, and not upstream's commits; upstream's repository and `CHANGES` remain the record of how the snapshot was made.
- **Few re-pulls will be merged by the Worker at first.**
  Most mirrors are in formats the scanner does not parse, so their screen asks for an acknowledgment (ADR 0089, Consequences), and only an administrator can give one.
- **The merge cap binds NEMAR's tools only.**
  An organization administrator merging in the GitHub UI is not stopped by it.
- **The Worker gains a path that merges into `main` of a public dataset.**
  It is bounded by the machine definition, the switch and the cap, and a defect in it would mint a DOI; that is why the merge call waits for the ruleset check and for gates G1 to G5.
- **The Worker's merge has no staging rehearsal.**
  Outside production only `xx` datasets are re-pulled, and they never reach machine clean, so the Worker's merge first runs in production, behind its switch.
- **A NEMAR change that would deserve a major has no major on a mirror;** it takes a minor.
- The importer changes as well: it clones a tag, and it refuses a re-import whose tag moved.

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
- Whether a plan can tell which paths a ledger-recorded correction changed, since the ledger lists no files; until it can, decision 1's refusal applies to every unexplained path of a dataset whose ledger records a correction.
- What ADR 0107's review does to a re-pull pull request the App opens.
  The App is not exempt, so the review runs; where its ruleset is in force GitHub reports `clean` only once the check passes, and whether a re-pull diff can pass at all is unknown, because ADR 0109 fails a changed `CHANGES` line and holds a replaced recording, both normal in a re-pull.
  Whether `fail`, `uncertain` or `could_not_decide` should also stop the Worker where the ruleset is only a shadow check is not decided; only `declined` does.
- Whether enrichment commits on the release branch move its head after the screen read it.
- Not decided: what ends a row whose N.0.1 pull request an administrator closes unmerged; until that is decided, such a row stays non-terminal and blocks the dataset's next re-pull.
- Whether OpenNeuro writes S3 before it pushes to GitHub, and whether the object at a path lags the pinned `versionId`.
- That upstream's `.log.rmet` records a `versionId` per key, which the design record states and nothing here has checked.
- That the dataset workflows tag the squash merge of a re-pull pull request as they tag other merges to `main`.

## Receipts

- Epic #1046 and its Phase 1, #1907; the design record `.context/design-upstream-repull.md`.
- #993 (step 4c's same-version assumption), #1320 (the bucket's annex UUID belongs to another special remote), #985 (finalize skips publication for a published dataset), #1810 (`on004362` missed upstream's 1.0.1).
- `src/lib/import-openneuro.ts` (`prepareImport`, step 4c, `finalizeImport`), `backend/src/routes/admin/imports.ts` (`POST /admin/datasets/import`), `backend/src/services/openneuro-discovery.ts` (`diffNewDatasets`, `latestTag`), `backend/src/services/auto-import.ts`, `backend/src/routes/admin/datasets-lifecycle.ts` (the `?reset=1` stamp resets), `backend/src/routes/callbacks/version-doi.ts`, `src/commands/dataset.ts` (`release --type`, `update --bump`), `backend/test/datasets-column-budget.test.ts`.
