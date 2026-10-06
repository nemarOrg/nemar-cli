# ADR 0085: A privacy correction scrubs every version in place, and NEMAR keeps the history of each correction

**Status:** accepted
**Date:** 2026-10-04
**Owner:** Seyed Yahya Shirazi

## Context

A researcher reported name-like strings in the EDF/BDF patient headers of a published dataset
(epic #1610). Reading the headers of every public dataset (`scripts/identifier-fleet-scan.ts`)
found the same class in others, always in a dataset that re-shares data other groups
released: the `nm` datasets are conversions of public releases and the `on` datasets are
OpenNeuro mirrors. For the reported dataset a header read from inside the original release was
byte-identical to NEMAR's copy, so the identifiers come from upstream and were public before
NEMAR copied them. That lowers the severity and removes none of the obligation.

The bytes are everywhere a version is: the git history (pointer files and inline JSON), the
S3 objects (public read, a content-addressed key per file, GOVERNANCE Object Lock for 100
years on `<id>/objects/` only, in a versioned bucket), the per-version manifests, and the data
plane. The standing rules pull in different directions. ADR 0006 gives NEMAR's own changes a
minor or patch bump. ADR 0016 leaves tags to CI. The Takedown Procedure withdrew prior versions
and tombstoned the DOI, but a tombstone hides bytes and deletes none, and withdrawing every
version of a dataset with 34 citations breaks every analysis that cites it. A new corrected
version would leave the old ones serving the identifiers. The existing delete paths add delete
markers in a versioned bucket, so they remove nothing.

## Decision

**What gates.** A name, a birth date finer than year, a record number, an age over 89, contact
details and a face gate. An acquisition date alone does not: it is acceptable when nothing in
the dataset ties the recording to an identifiable person (published in the Contributor Terms,
2026-10-04). The scanner reports start dates at review severity and they never block.

**The default remedy is an in-place scrub of every version.** The affected fields are removed
from every version NEMAR serves, and version numbers and DOIs are kept; no new version is
issued. The Contributor Terms and the Takedown Procedure reserve the right to do this and say
how depositors, authors and source archives are told. Withdrawal with deletion of the data is
reserved for a dataset that cannot be scrubbed: a license that forbids modified copies, an
identifier carried in the signal or pervasive (audio, video, many annotations), or an extent
that cannot be bounded. A tombstone alone is never the remedy.

**The scrub replaces keys, it does not edit locked objects.** For EDF and BDF files only
bytes 8 to 88 (patient identification) and 88 to 168 (recording identification) change, and
only when the scanner finds a name, a birth date finer than year, a record number or non-ASCII
text in them; the start date and time, the record count and every byte after offset 256 stay
identical, which is proven byte for byte (`shared/identifier-scrub.ts`). The new content has a
new SHA256E key, so the order is add, verify, switch, delete:

1. restrict the dataset (private with the bucket-policy exclusion, the supported visibility
   transition), suppress workflow dispatch, pause its Zarr queue, and take the uploader's write
   access away; **NOT BUILT in Phase 2, except the restriction**: no tool suppresses dispatch,
   pauses the queue or removes write access (see "Build status"), and the runbook tells the
   operator what a push sets off and to watch it; dispatch suppression was decided on 2026-10-06
   as a temporary disable of three central workflows, done by hand (amendment of that date);
2. hash the new content on a host with fast S3 reads (the key needs the whole file), verifying
   the original against its own key in the same pass;
3. assemble each new object server side (a patched first part and `UploadPartCopy` for the rest),
   with explicit GOVERNANCE retention at creation, and verify it (sizes, patched header, sampled
   ranges, retention) and re-hash it from S3;
4. rewrite the git history of every branch and tag with `git-filter-repo` so every tree names
   the new keys and drops or blanks the inline identifiers, record the new keys as present and
   the old keys as dead in the `git-annex` branch, lift the per-repository tag ruleset, force-push,
   and restore the ruleset;
5. regenerate every tag's manifest AFTER the tags move (before, the job rebuilds the old
   manifest from the old tree); the remap of `zarr_source_commit` and the index `source_commit`
   is **NOT BUILT in Phase 2** (it is not a privacy matter, and the next reconversion of the
   dataset repairs both);
6. verify through the public surface that every manifest names only new keys and that downloads
   hash to them;
7. delete the old object versions, and the noncurrent manifest and archive versions, by VersionId
   with the governance bypass, and prove it with an authoritative `ListObjectVersions` showing
   zero versions and zero delete markers;
8. ask GitHub Support to clear cached views and pull-request refs, check for other copies NEMAR
   controls, delete local clones, and make the dataset public (re-enabling dispatch and access
   has nothing to undo while step 1 is not built); the Support request is withdrawn by the
   decision of 2026-10-06, which accepts the pull-request refs as a residual (amendment of
   that date).

Retention is never shortened with `PutObjectRetention`, which would open an unprotected window.
Nothing is deleted until the public surface has been verified, and deletion is the only
irreversible step.

**Purged keys stay purged. NOT BUILT in Phase 2.**
Nothing creates, stores or reads a purge list yet.
The design is that every old key goes on a private purge list (a document with a catalog pointer, not a per-key table, ADR 0036), and that import copy, recovery (ADR 0063), key registration (ADR 0061), the availability count (ADR 0064) and the publish gate refuse a purged key, and none counts it as missing.
What Phase 2 does instead: the old keys are marked dead in the `git-annex` branch and deleted by version id, so the bytes are gone, but nothing stops the same bytes being uploaded or recovered again.
The epic's phase list owns only some readers: the publication gate is Phase 4 (#1614; the design review on #1613 names the publication orchestrator as the gate that holds), and the importer's prepare step is Phase 7 (#1618, which must refuse a key on the purge list).
No phase builds the list itself, its catalog pointer, or the readers in import copy, recovery, registration and the availability count, so that work is unowned and needs its own issue before Phase 4 or Phase 7 can use it.

**Authority and a rehearsal.** The owner gives an explicit go for each dataset after a dry run
whose plan is read-only. The bypass is proven on a disposable canary object before any real
object is touched, and the first real scrub is a single dataset.

**NEMAR keeps the history of its corrective actions.** An append-only ledger records, per
dataset, each action (plan, headers scrubbed, files removed, history rewritten, locks applied,
manifests regenerated, old versions deleted, republished), the versions affected, counts, the
scanner version and rules, the verification result and who ran it, with no values and no per-file
lists (ADR 0036). It lives where a history rewrite cannot erase it: a file in the dataset
repository committed after the rewrite, an object under the dataset's S3 prefix, and a count and
pointer on the catalog row. Each corrected version's change log says that a privacy correction
was made, without describing what was removed.
The file (`.nemar/corrections.jsonl`) and the object (`<id>/corrections/ledger.jsonl`) are built (`scripts/scrub/ledger-cli.ts`, runbook step 13).
**The count and pointer on the catalog row are NOT BUILT in Phase 2**, and no phase of the epic lists them; they need a migration and a route, so they need an owner.
The ledger has no field for who gave the go for an irreversible step, and refuses free text by design, so the runbook records each go in a comment on the epic.

**The scrub is a step in the workflows that bring data in. NOT BUILT in Phase 2.**
The importer's prepare step (ADR 0060) scrubs identifying fields in place, then the same deterministic screen runs, then the ledger is written, so a later OpenNeuro import or re-pull is scrubbed again and does not reintroduce what was corrected.
That is Phase 7 (#1618).
The publication workflow gains `identifier_screen`, a hard gate before `s3_public_read` that fails closed on a direct finding, and treats an unread header or a recording format the scanner cannot parse as not screened, which only an explicit, recorded admin acknowledgment can pass.
That is Phase 4 (#1614).
Phase 2 builds the tools an administrator runs by hand, and the shared header scrub that both phases will call (`shared/identifier-scrub.ts`).

## Consequences

- The original bytes are gone from NEMAR for good. Copies others downloaded, forks, and GitHub's
  cached views and pull-request refs are beyond NEMAR; the Takedown Procedure says so.
- The bytes behind a tag and a DOI change. What preserves provenance is the ledger, the change
  log and this ADR, not the version number; a citing analysis still reproduces because the signal
  bytes are identical.
- A mirror diverges from upstream. The provenance text that said sourcedata is byte-for-byte
  unmodified is corrected for any dataset scrubbed, and upstream archives are told.
- Scrubbing re-reads every affected file once (about 345 GB across the first 16 datasets), which is
  why hashing runs on a host with fast S3 reads and assembly never moves the payload.
- **NOT BUILT in Phase 2:** the purge list does not exist, so nothing yet refuses a purged key.
  Several services must learn it before it can be trusted, and until the publication gate and the importer step exist, only byte-identical re-uploads would be caught by it.
- Webhooks dispatch a version-DOI run on any non-delete tag push and enrichment on pushes to
  `main`, and the design was that dispatch is suppressed for the duration of a rewrite.
  **That suppression is NOT BUILT in Phase 2**, so the force-push of the tags dispatches a version-DOI run for each moved tag, which dispatches the central manifest job and the archive job, and can upload a Zenodo backup.
  On 2026-10-06 the maintainer decided to suppress it by hand instead, disabling three central workflows for a short window (amendment of that date; runbook steps 8b and 9b), and the derived files are then rebuilt by hand (steps 12 and 15c).

## Alternatives considered

- **A new corrected version, with earlier versions withdrawn.** Leaves the identifiers in every
  version until withdrawal, breaks every citation of the earlier versions, and mints an
  irreversible version DOI. Rejected.
- **Tombstone every version.** Hides the bytes and deletes none. Rejected as a remedy.
- **Make the dataset private and stop.** Stops anonymous reads and fixes nothing; kept only as
  the interim step.
- **Scrub the objects but not the git history.** Leaves the inline JSON, file names and every old
  key reachable from old commits and tags. Rejected.
- **Edit the objects at their existing keys.** Impossible: the key is the content hash.
- **A different key backend for scrubbed files, to avoid re-reading them.** Breaks the annex
  policy (ADR 0031) and every reader that assumes SHA256E. Rejected.

## Receipts

- Epic #1610 and its phases: #1611 (scanner), #1612 (this ADR and the tooling, PR #1625), #1613
  (uploader preflight), #1614 (publication gate), #1615 (scheduled sweep), #1616 (admin triage),
  #1618 (importer) and #1626 (Zarr stores carry no subject-level metadata); docs PRs #57, #58
  and #59.
- The design review recorded on #1612 (key replacement, delete by VersionId, canary, purge list,
  dispatch suppression, manifests after the tag move); the purge list and the dispatch
  suppression in it are not built in Phase 2.
- `.context/scrub-runbook.md`, which holds the operational steps, the exit codes, and the
  real-bucket checklist that must run before the first real execute.
- `scripts/identifier-fleet-scan.ts` and its results, `shared/identifier-scan.ts`,
  `shared/identifier-scrub.ts`.
- ADRs amended today: 0006, 0010, 0016, 0060, 0061, 0063, 0064, 0067.

## Amendment 2026-10-05 (#1612): the other copies, and what a successful run proves

A review of the Phase 2 tooling and a first read of the real bucket found things the procedure above did not name.

**Two more copies of the identifiers.**
The Zarr serving copy repeats header fields:
every store's root metadata (`<id>/zarr/<path>.zarr/zarr.json`) carries, in `attributes.recording_metadata`, the subject and operator members the converter copies from the EDF or BDF header (the removal set is listed under "What a clean Zarr store means" below).
Those objects are not Object Locked, so the `zarr` stage removes those members in place and re-reads every document; the noncurrent versions of every zarr object are then pruned, because the bucket is versioned.
The archive zip under `<id>/archives/` contains the original recordings, so `drop-archives` deletes every version of it, only after the rewrite has been verified from a fresh clone of the pushed repository (runbook step 15a, because the deletion cannot be undone).
The stage refuses until the proofs of the new objects, of the pushed history and of the Zarr copy are in the working directory and name this plan.
The archive is then rebuilt from the scrubbed tree by the normal archive workflow, which the maintainer has to trigger, because no command in this repository builds one by hand and nothing re-dispatches a missing archive (runbook step 16; corrected by the amendment of 2026-10-06: the central repository has a manual dispatch, and the runbook rebuilds the archive in step 15c).
`<tag>-summary.json` and `<tag>-records.json` were checked by key name and hold entities, signal summaries and provenance, no header field.
The manifest job regenerates `<tag>-summary.json` together with the manifest; `<tag>-records.json` is not regenerated by it.

**Verification before deletion is by admin reads.**
Step 6 says to verify through the public surface, but the dataset is private until the old bytes are gone, which is what keeps any old key from being publicly readable.
What is verified before deletion is therefore the pushed refs in a fresh clone (`git-scrub verify --fresh-clone`, which also reads the pushed `git-annex` branch), every regenerated manifest and every new object re-hashed from S3, all by an administrator.
After the old bytes are deleted and before the dataset is made public again, a new read-only plan over what remains must say there is nothing left to scrub (`needScrub=0`).
The fleet scan lists only public datasets, so it cannot screen a private one, and that plan is the screen from inside; the fleet scan runs after publication.
The public surface is checked after the dataset is made public again, and a failure there makes it private again; the new objects were verified twice, so the fault would be in a manifest, a cache or a route.

**The irreversible steps check for themselves.**
`delete-old` refuses unless the plan is complete and not partial, both S3 proofs name the exact bytes of `assembled.json`, the verification of a fresh clone of the pushed repository (`git-verified.json`, mode `fresh-clone`) names this keymap and plan, no current manifest names an old key, an anonymous request for a new object, and for an old one while any remains, is refused (the dataset is private), the Zarr stage has verified for this plan, and no archive remains.
`drop-archives` refuses unless the plan is complete and not partial, and the same proofs of the working directory hold: both S3 proofs, the fresh-clone git proof with its keymap, and the Zarr stage's proof for this plan (a `no-zarr` proof only while no Zarr object is current).
It checks them with the same code and the same words as `delete-old`.
Both stages evaluate every refusal before they stop and list them all, so the dry run of `delete-old` before the archives are dropped shows everything that would stop the deletion, not only that the archives remain.
The maintainer's go for each irreversible step (the force-push, the archive drop, the deletion and making the dataset public again) is an operator discipline in the runbook, not something a tool checks.
A prune prefix is an allow-list (`<id>/version/`, `<id>/archives/`, `<id>/zarr/`), never a deny-list, because a deny-list let the dataset root through in review.

**A successful run is not proof that nothing was missed.**
The plan's keys are the union of every manifest and a listing of `<id>/objects/`, the git plan reads every commit rather than the tag tips, and `verify` requires every EDF and BDF key in any commit to be a new key or one the plan found clean.
The hash stage binds each digest to the patch it was computed for, so a re-plan cannot reuse a stale one.

**The stand-in is not S3.**
On first contact with the real bucket the tools disagreed with their stand-in twice: S3 requires a checksum header on an `UploadPart` of a multipart upload created with Object Lock parameters, and `<id>/version/` holds `<tag>-records.json` beside the manifest.
Both were fixed, and the canary, which runs on the real bucket against a test prefix, is run again after any change to an S3 call.

**Second review of the same day: what a "clean" Zarr store means.**
The first version of the `zarr` stage removed only the members the scanner calls identifiers, but the converter mirrors the whole EDF identification fields into the store, including `technician`, `admincode`, `patient_additional`, `equipment` and `recording_additional`, which the EDF scrub rewrites and the scanner does not name as keys.
A store holding a technician's name came out "clean" and was proven clean.
The stage, its re-read, its proof and the public check (`zarr-public`, runbook step 16) now share one list of the mirrored members (`EDF_MIRROR_MEMBERS`), so what one removes the other checks.
An earlier version of this paragraph kept `gender` because sex is neither a name, a date nor a record number; the decision of 2026-10-05 below supersedes that, and `gender` is removed.
The same review made `delete-old` finish clean or refuse: any version or marker left under `archives/`, `version/` or `zarr/` is refused before a delete, history found afterwards writes no `deleted.json`, every live version must be in the plan, and the privacy probe also covers the new keys so a failed prune can be re-run.
Signals (`SIGINT`, `SIGTERM`, `SIGHUP`) remove the temp directory and kill the `aws` children, because `finally` does not run on a signal and the directory can hold raw header bytes.

**What a clean Zarr store means (decision 2026-10-05).**
A store holds the data and the events, plus channel names, types and units and technical recording metadata.
It says nothing about the subject: age, sex or gender, patient code, birth date, name and additional patient text live at dataset scope, and `participants.tsv` is the one canonical place for them.
Operator and administrative free text copied from a recording header (technician, administrative code, equipment, additional recording text) is not data, events or channels either.
A store is clean when every `zarr.json` in it, the root and every array's or nested group's, passes one rule (`scripts/scrub/s3/zarr-json.ts`), shared by the `zarr` stage, its re-read, its proof and `zarr-public`:

- **Removed:** every member of the removal set `EDF_MIRROR_MEMBERS` (`patientcode`, `birthdate`, `gender`, `patient_name`, `patient_additional`, `admincode`, `technician`, `equipment`, `recording_additional`) and every key the scanner calls an identifier, at any depth under `attributes` and in any spelling, whenever it holds something.
  `gender` is removed for consistency with the scrubbed header, whose patient field is `X X X X`; `participants.tsv` keeps sex.
  The document is edited as text, so every byte outside the removed members is the original byte.
- **Allowed:** the members of `recording_metadata` (or `recording_info`) in the allow-list `KNOWN_BENIGN`: `startdate` (an acquisition date does not gate), `filetype`, `number_of_signals`, `file_duration`, `datarecord_duration`, `source_file`, `source_format`, `streamed` and `channels_tsv_units` with whatever it holds, plus any key the scanner knows at review severity (an `email` is kept, not removed).
- **Refused:** any other member name refuses the run (`unknown-recording-member`, exit 3) before a document is written.
  The names, never values, go to `zarr-unknown-members.json`, and a person accepts a name with `--allow-member NAME`, which `zarr-verified.json` records and `zarr-public` applies.
  biosigIO's four technical flags, which it writes only when they apply (`channel_labels_deduplicated`, `brainvision_header_recovered`, `eeglab_fdt_recovered`, `edf_tolerant_read`), are not in `KNOWN_BENIGN`, so a store that carries one refuses until `--allow-member` names it.
  Whether to add them to the list is the maintainer's decision.

`zarr-public` reads store roots only, because an anonymous reader cannot list the nested documents.
Nothing yet stops the converter writing the removed members again on a reconversion; that is Phase 8 (#1626), which also covers a fleet-wide strip of the stores nobody has scrubbed.

**The Zarr census (names only, read-only, 2026-10-05).**
A read-only census read the member names of every store root of two datasets, never a value.

- nm000186, all 88 store roots: `birthdate`, `patientcode`, `gender` and `equipment`, non-empty in every one; `startdate` (a typed object); `source_file`, `source_format`, `number_of_signals`; empty `filetype`, `file_duration` and `datarecord_duration`; `channels_tsv_units` (an object with `converted`, `kept_importer_unit`, `relabelled`, `units_column_present`).
  No `technician`, `admincode`, `patient_name`, `patient_additional` or `recording_additional`.
  So the real run must remove exactly four members from each of the 88 roots (352) and leave the other eight, and a test builds 88 such stores by hand and asserts exactly that.
- nm000348, 153 stores (33,250 Zarr keys): only `channels_tsv_units`, `number_of_signals`, `source_file` and `streamed`.
  There is nothing to remove, and that is a clean proof (`found: stores`), not a failure.

The census read store roots only; nested documents were not censused.

## Amendment 2026-10-06 (#1612): dispatch is suppressed by hand, and what a scrub leaves behind

Three decisions by the maintainer, made on 2026-10-06 after a read-only investigation of what a push sets off and of the copies outside the bucket and the repository.
The runbook (`.context/scrub-runbook.md`) carries the procedure, the checks and the commands.

**Decision 1: dispatch is suppressed by a temporary workflow disable.**
For a short window around the force-push, the three central workflows the Worker dispatches on a push, `run-version-doi.yml`, `run-enrichment.yml` and `run-bids-validation.yml` in `nemarDatasets/.github`, are disabled with `gh workflow disable` and then enabled again.
No code.
A disabled workflow drops the dispatches of every dataset repository, and `repository_dispatch` answers 204 whether or not a run starts, so the runbook batches every ready dataset into one window, announces it on the epic, checks with `gh workflow list --all` before the first push and after the last, and confirms from `gh run list` that no run started for a dataset of the batch (runbook steps 8b and 9b).
`gh workflow disable` is outward-facing, so opening the window needs the maintainer's go for each dataset, in the same form as a box (`GO window <dataset> <plan-id>`).
A repository whose own legacy workflows (`version-doi.yml`, `generate-archive.yml`, `llm-enrichment.yml`) would run on the push is not reached by the central disable, so GitHub Actions is disabled on it for the window and enabled again after.
The decision named the seven repositories whose `main` carries those files (nm000197, nm000200, nm000246, nm000277, nm000301, nm000340, nm000348).
A tag push runs the workflow files of the pushed commit, and a read of every tag on 2026-10-06 found `version-doi.yml` in at least one tag of each of the fourteen `nm` datasets of the sixteen, so the runbook decides per repository by checking every ref the push moves.
The legacy workflows are a fleet-drift finding (`GET /admin/fleet/drift`, `DEPRECATED_WORKFLOW_PRESENT`) and are not stripped by the scrub.
The cost the window carries: a push to any other dataset repository during it loses its dispatches, which step 9b lists for the maintainer.
With dispatch suppressed, the derived files are rebuilt by hand: every tag's manifest and records before the deletion, so its prune removes the versions they replace (step 12), and exactly one archive, for the latest version, after the deletion and before the dataset is public again (step 15c).

**Decision 2: GitHub pull-request refs are an accepted residual.**
In the maintainer's words: "Don't worry just force push and move forward, these are not our mistakes, we do our best."
No GitHub Support request and no recreation of the repository; this withdraws the Support request of step 8 above.
Twelve of the sixteen repositories carry two to five `refs/pull/<N>/head`, which survive a force-push, cannot be deleted by the owner, and keep the pre-scrub commits fetchable once the repository is public.
A branch is treated differently: a branch merged into `main` is deleted before the clone (the switch refuses any remote head but `main` and `git-annex`, and a branch is visible once the repository is public), and a branch ahead of `main` stops the run for the maintainer.

**Decision 3: the Hallu copies stay.**
In the maintainer's words: "Leave the Hallu copies."
`scripts/hallu-sync.sh` keeps a clone with annexed content and the archive zip of every public `nm` dataset on the SCCN host and never deletes one that goes private.
A scrub keeps the version numbers, so the sync keeps the pre-scrub copy without an error; on the dataset's next version its `git pull --ff-only` fails on the rewritten history, every hour, until the clone is replaced.

**What a scrub leaves behind**, in short (the runbook's "Residuals" has the checks):

- pull-request refs and GitHub's cached views (decision 2);
- the Hallu copies, including the QA output under `processed/<id>/` (decision 3);
- Zenodo: a backup deposit is a draft of the tag's git tree, never a recording, and one made before the scrub holds the pre-scrub tree; published legacy Zenodo records cannot be deleted by NEMAR; whether any draft exists is UNVERIFIED, and drafts are not decided;
- the public Actions logs of `nemarDatasets/.github` (90-day retention), which printed paths, README-derived metadata, the validator's JSON and the head of each records file for the pre-scrub trees; whether any validator message quotes header text is UNVERIFIED; not decided;
- the failure text in `<id>/zarr/index.json` (`failures[].detail`, `pending[].last_error`), which the runbook counts before the flip and stops on for a person.

**Corrections to the amendment of 2026-10-05.**

- `<tag>-records.json` is regenerated by every version-DOI run whose publish step succeeds (its `trigger-records` job); only the manifest job leaves it alone, which is what that amendment's sentence was about.
- A manual archive dispatch exists, in the central repository: `run-generate-archive.yml` takes `workflow_dispatch` with `dataset_id`, `version` (`X.Y.Z`, no leading `v`) and `force`.
  Its idempotency guard skips a version whose zip exists unless `force` is true.
  The rest of that sentence holds: nothing re-dispatches a missing archive, because the archive retry looks only at a `failed` status.
- `datasets.latest_version_doi` is written unconditionally by every successful version-DOI publish, and the runs of several tags race with no concurrency group; the runbook compares it with its value from before the window (step 15c).
- The archive is no longer rebuilt after the flip at the maintainer's request: the runbook rebuilds it in step 15c, while the dataset is still private, and step 16 checks the new key anonymously after the flip.

## Build status

Built in Phase 2 (PR #1625, issue #1612): the S3 stages (`plan`, `assemble`, `verify`, `zarr`, `drop-archives`, `delete-old`, `zarr-public`, `canary`), the hash stage, the git stages (`snapshot`, `rewrite`, `verify`, `annex-registry`), the ruleset switch, the git plan, the ledger file and object, the shared header scrub, and the runbook.
The two deleting stages, `drop-archives` and `delete-old`, check the proofs of every copy for themselves and report every refusal at once (runbook steps 15a and 15b); neither is left to the operator.
The maintainer's go is the one precondition of an irreversible step that no tool checks.

**NOT BUILT in Phase 2, with the phase that owns each** (phases and issues from epic #1610):

| Claim | Status | Owner |
|---|---|---|
| Suppress workflow dispatch for the dataset | **decided 2026-10-06, no code**: for a short window the runbook disables `run-version-doi.yml`, `run-enrichment.yml` and `run-bids-validation.yml` in `nemarDatasets/.github`, and GitHub Actions on a repository whose own legacy workflows would run (runbook steps 8b and 9b); suppression per dataset in code stays not built | the maintainer's decision of 2026-10-06; a code form, should one be wanted, needs its own sub-issue |
| Pause the dataset's Zarr queue, remove the uploader's write access | not built; while private, the queue parks the dataset as `unlisted` | none in the phase list |
| The purge list, and its readers in import copy, recovery, registration and the availability count | not built | none for the list and those readers; the publication gate is Phase 4 (#1614) and the importer's prepare step is Phase 7 (#1618) |
| The ledger's count and pointer on the catalog row | not built | none in the phase list |
| Remap `zarr_source_commit` and the index `source_commit` | not built; the next reconversion repairs them | none; Phase 8 (#1626) changes the converter but does not list it |
| The importer scrubs in place on every import and re-pull | not built | Phase 7 (#1618) |
| `identifier_screen`, the publication gate | not built | Phase 4 (#1614) |
| The converter never writes subject members, and a fleet-wide strip of existing stores | not built | Phase 8 (#1626) |
| The uploader's preflight, the scheduled sweep, admin triage | not built | Phases 3 (#1613), 5 (#1615) and 6 (#1616) |

**Deferred inside Phase 2, none a blocker for the first real run on nm000186:**

- **Assembling an orphan recording (review item S6, full form).**
  A key the S3 plan scrubs that no commit's pointer or symlink names would be assembled with `gitReferenced: false` in the keymap, and the rewrite would accept flagged entries.
  That changes the keymap format, `assemble`, the Python rewrite and `delete-old`'s keymap check, so it is not built.
  Today such a key stops the git plan early with `orphan-key` (before, it stopped the rewrite late with `keymap-key-never-seen`).
- **The 88-store test through the real converter (review item T8a).**
  biosigIO 1.2.10, the converter's pin, was not installable without the network, so the test builds the stores from the census by hand (and names biosigIO 1.2.10 in a comment); it has not run end to end through the converter.
- **`--prune-degenerate never`** of the rewrite (review item T9) is not tested separately: with `--prune-empty never` and no pruned paths in the fixtures it cannot be observed, and a dedicated fixture would be needed.
- **The `KNOWN_BENIGN` extension** for biosigIO's four conditional flags is the maintainer's decision; until it is made, such a store refuses until `--allow-member` names the flag.

The stand-in is not S3, and the items only the real bucket and GitHub can prove are the real-bucket checklist of the runbook.
An earlier canary, without the conditional-write steps, passed against the real bucket on 2026-10-04; the checklist has not run with the current tools, and it must run before the first real execute.
