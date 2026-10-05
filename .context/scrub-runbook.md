# Runbook: scrub a published dataset in place

Operational steps for [ADR 0085](decisions/0085-a-privacy-correction-scrubs-every-version-in-place.md).
One dataset at a time, first one first.
Every stage is a dry run unless it says `--execute`, and nothing irreversible happens before step 15.
**A working directory holds file names that may be identifying (the git plan, the clone), so it is private (`chmod 700`) and is deleted when the dataset is done.**
Nothing printed or written by any stage is a participant value.

`D` is the dataset id, `W` the working directory (`~/scrub-work/D`), `T` the tools (`bun run scripts/scrub/...` from a checkout of the merged branch).
Credentials are the ambient `aws login` session (short-lived `ASIA` credentials, never a long-lived `AKIA` key) and `gh` as an org admin.
The S3 tools resolve credentials once and share them across every `aws` call (`cliCredentialSource`), because parallel `aws` processes race on the login session's single-use refresh token.
The hash stage is a separate Python process: freeze the credentials for a short local run with `eval "$(aws configure export-credentials --format env)"`, and use the host's own read-only credentials for a long run on Hallu.

## What a copy of a recording can be

A scrub is only complete when every copy NEMAR controls is clean.
Measured in the real bucket on 2026-10-04, a dataset has these:

| Where | What it holds | Handled by |
|---|---|---|
| `D/objects/` | the recordings, locked 100 years | steps 1 to 6, 15 |
| GitHub history | annex pointers, inline JSON, file names | steps 7 to 9 |
| `D/zarr/**/<store>.zarr/zarr.json` | every EDF identification field the converter copies into `attributes.recording_metadata` (`patientcode`, `birthdate`, `patient_name`, `patient_additional`, `admincode`, `technician`, `equipment`, `recording_additional`; `gender` and `startdate` stay), not locked | steps 10 and 15 |
| `D/archives/*.zip` | the original recordings, zipped | steps 11 and 15 |
| `D/version/<tag>.json` | keys, paths and checksums | step 12, 15 |
| `D/version/<tag>-summary.json`, `<tag>-records.json` | entities, signal summaries, provenance; no header field (checked by key name) | not regenerated |

## Before the first dataset

1. ADR 0085 and the docs PRs are merged, the tooling PR is merged, and the owner has said go for this dataset.
2. **Canary** proves the bypass and the multipart path on the real bucket, on the test prefix only:
   `bun run $T/s3/s3-scrub.ts canary --prefix nm099999/canary-$RANDOM/ --execute`, then the same with `--multipart`.
   Run it again after any change to an S3 call: the stand-in encodes what its author believed, and the first multipart canary found that real S3 refuses an `UploadPart` without a checksum under Object Lock.
   Confirm with an independent `aws s3api list-object-versions` and `list-multipart-uploads` that nothing is left.
3. The dataset is private with the bucket-policy exclusion, verified with an anonymous HEAD of one object (403) and a public control (200).
   Allow a few minutes after any bulk change.
   `delete-old` checks this itself and refuses unless the anonymous HEAD answers 403.
4. The uploader and, for a mirror, the source archive have been told, and asked not to upload over it.
5. **Read the key names, not the values, of one real store per dataset**, so the zarr stage's list of mirrored fields (`EDF_MIRROR_MEMBERS` in `scripts/scrub/s3/zarr-json.ts`) is known to cover what the converter wrote:
   `K=$(aws s3api list-objects-v2 --bucket nemar --prefix D/zarr/ --query "Contents[?ends_with(Key, '.zarr/zarr.json')].Key | [0]" --output text)`, then
   `aws s3 cp "s3://nemar/$K" - | jq -r '.attributes.recording_metadata | keys[]'`.
   `jq keys` prints names only; never print the object itself.
   Stop if a name holds header text (patient or recording identification) and is not in the list or the scanner's keys: extend the list first.
6. Know the dispatch behavior: the Worker dispatches version-DOI on any non-delete `v*` tag push (idempotent on the ledger) and enrichment on a push to `main` (it short-circuits on an unchanged source hash).
   Zarr is not dispatched from the webhook; the converter runs on the Hallu cron (ADR 0029) and can rewrite a store while this runbook edits it, so keep the dataset out of the Zarr queue until step 15.
   `zarr.nemar.org` serves only public datasets, but its edge caches chunk objects for up to a day and metadata for 60 seconds.

## Steps

0. **Clone** (private working copy), a normal clone, because the rewrite refuses a tree that is not clean and a `--no-checkout` clone reads as every file deleted:
   `git clone https://github.com/nemarDatasets/D W/clone && cd W/clone && git annex init`.
   Then keep a way back until step 15: `git bundle create W/original.bundle --all` (it holds the original inline content, so it is private and deleted with `W`).
1. **Plan** (read-only): `s3-scrub.ts plan --dataset D --out W`.
   Stop unless it exits 0: exit 4 means a key was unreadable, a manifest named an EDF or BDF held inline in git, or `version/` held a file that is neither a manifest nor a known sibling, and the plan is incomplete.
   The keys are the union of every manifest and a listing of `D/objects/`, so a recording that no manifest names is still found.
   Read the counts: keys, how many need a scrub, bytes to hash.
   A plan made with `--tags` is partial and every later stage refuses it.
2. **Git plan** (read-only): `bun run scripts/scrub/plan/build-git-plan.ts --repo W/clone --dataset D --out W/git-plan.json`.
   It reads every commit of every ref, not only the tips.
   Read the counts (images dropped, JSON files blanked, provenance entries).
   Anything outside `sourcedata/` that the scanner flags is for a person to decide, not for the plan.
3. **Hash** (reads every object once; the original is verified against its own key in the same pass):
   `python3 hash_stage.py compute --plan plan.json --patches patches.json --out hashes.json --workers 16`, on this machine for a small dataset and on Hallu (detached launch form, memory `hallu-launch-and-self-deploy-lag`) for a large one.
   Each entry is bound to its patch, so a re-plan with different scanner rules recomputes rather than reusing a stale digest.
   Exit 0 only.
4. **Assemble** (admin credentials): `s3-scrub.ts assemble --dir W` is the dry run (object count, bytes uploaded versus copied server side); then `--execute`.
   New keys are created with GOVERNANCE retention at creation.
   Nothing is deleted.
   It writes `assembled.json` and `keymap.json`.
5. **Verify**: `s3-scrub.ts verify --dir W` (sizes, patched header, sampled ranges, retention) writes `verified.json`; on the hash host `python3 hash_stage.py verify-new --assembled assembled.json --out new-hash-verified.json` re-reads every NEW object and checks its key.
   Both must pass.
6. **Sanity**: compare the plan's counts with the fleet scan for the dataset (`identifier-fleet-scan.ts --only D`): every recording the scan flagged is in the plan.
7. **Rewrite history** in the clone: `git-scrub.ts snapshot --repo W/clone --out W/before.json`, `git-scrub.ts rewrite --repo W/clone --keymap W/keymap.json --plan W/git-plan.json`, then `git-scrub.ts verify --repo W/clone --keymap W/keymap.json --plan W/git-plan.json --s3-plan W/plan.json --before W/before.json`.
   The expected remote is derived from the plan's dataset and the rewrite refuses a clone of any other repository or a keymap whose keys the history never held.
   Verify must exit 0: no old key in any blob of any ref, every EDF and BDF key in any commit is a new key or one the plan found clean, no dropped path, JSON blanked, commit counts and tag names unchanged.
8. **Register keys** in the clone (dry run first, then `--execute`): `git-scrub.ts annex-registry --repo W/clone --keymap W/keymap.json --remote-uuid 58cfc116-2170-45b1-9b1e-e7ec6979f534`.
   New keys present only at the S3 remote, old keys retracted at every holder and marked dead; an old key with no location log at all is refused.
9. **Switch** (lifts only what blocks, pushes with leases, restores): `github/switch.ts snapshot --repo nemarDatasets/D --clone W/clone --out W/ruleset.json`, then `switch --snapshot ...` (dry run), then `--execute`, then `check`.
   It refuses unless the remote's only heads are `main` and `git-annex`, the remote has no tag the clone lacks, and the clone's origin is that repository.
   If the process dies, run `restore --execute` at once; exit 5 means a ruleset could not be restored and needs a person now.
   Then push the `git-annex` branch normally.
10. **Zarr serving copy** (not locked): `s3-scrub.ts zarr --dir W` is the dry run (stores, how many carry an identifier key); then `--execute` removes exactly those keys from each store's root metadata and re-reads every store to prove it clean.
    The members it removes are the scanner's identifier keys and every mirrored EDF identification field (`EDF_MIRROR_MEMBERS`), and its re-read, its proof and the public check in step 16 apply the same rule through the same function.
    It writes `zarr-verified.json`.
    Wait 60 seconds for the edge's metadata TTL, or purge `D/zarr/*`.
    The noncurrent versions of every zarr object still hold the old metadata, so they are pruned in step 15 with `--prune-noncurrent D/zarr/`.
    `attributes.nemar.source_commit` and the index `source_commit` now name commits that no longer exist; that is not a privacy matter and is repaired by the next reconversion of the dataset, not here.
11. **Archives**: `s3-scrub.ts drop-archives --dir W --confirm-dataset D` is the dry run; then `--execute` deletes every version of every key under `D/archives/`.
    Regenerate the archive from the scrubbed tree with the normal archive workflow afterwards (a dispatch on the dataset), and confirm the new zip hashes its own content.
12. **Regenerate every tag's manifest AFTER the tags moved** (before, the job rebuilds the old one from the old tree): dispatch through `/admin/manifest/dispatch` for each tag (see memory `manifest-healing-dispatch-over-rest`).
    Confirm each `s3://nemar/D/version/<tag>.json` names only new keys.
    `delete-old` reads every current manifest and refuses while one names an old key.
13. **Ledger**: `bun run scripts/scrub/ledger-cli.ts append --file W/ledger.jsonl --dataset D --action ... --versions ... --counts ... --verification ... --actor HANDLE` for each of plan, headers-scrubbed, files-removed, history-rewritten, locks-applied, manifests-regenerated.
    Commit `W/ledger.jsonl` as `.nemar/corrections.jsonl` on `main` (a normal push, not a force), and `ledger-cli.ts publish --file W/ledger.jsonl --dataset D --execute`, which uploads to `s3://nemar/D/corrections/ledger.jsonl` and refuses anything that is not a strict append.
    The change-log sentence is already in every version through the git plan.
14. **Verify while still private** (admin reads, no public exposure): re-clone the dataset fresh from GitHub and run `git-scrub.ts verify` against it (the pushed refs, not the local rewrite); read every regenerated manifest and confirm it names only new keys; `verify-new` (step 5) already hashed every new object.
    The dataset stays private until the old bytes are gone, so there is no window in which an old key is publicly readable.
15. **Delete the old bytes** (the only irreversible step): `s3-scrub.ts delete-old --dir W --confirm-dataset D --verified W/verified.json --hash-verified W/new-hash-verified.json` is the dry run (counts of versions and markers, and every refusal below evaluated); then `--execute` with `--prune-noncurrent D/version/`, `--prune-noncurrent D/zarr/` and, where archives existed, `--prune-noncurrent D/archives/`, and `--max-delete` at the dry-run number.
    It refuses unless: the plan is complete and not partial; both proofs name the exact bytes of `assembled.json`; every current manifest names no old key; the anonymous HEAD of an old object answers 403; `zarr-verified.json` exists when `D/zarr/` has objects; and no archive remains.
    It ends with an authoritative `ListObjectVersions` showing zero versions and zero markers for every old key.
16. **Make public and verify from outside**: `nemar admin repo public D --yes`, then the fleet scan for the dataset (`identifier-fleet-scan.ts --only D`) expecting no direct finding, an anonymous download of one file per version hashing to its new key, `s3-scrub.ts zarr-public --dataset D` (anonymous reads of the Zarr index and every store root it names, by the zarr stage's own rule; exit 0 only), and the data plane manifest naming only new keys.
    If anything fails, make it private again and stop; the new objects were verified twice, so the fault is in a manifest, a cache or a route, not in the bytes.
17. **Afterwards**: comment on the dataset issue in plain words and close it; tell the uploader and the authors; ask GitHub Support to clear cached views and pull-request refs; delete the working directory, the bundle and the local clones; record `old-versions-deleted` and `published-again` in the ledger and push it.

## Abort points and rollback

- Steps 0 to 6 change nothing but add new objects; abandoning leaves extra locked objects that are deleted later by version id with bypass (the canary shows it works, and a failed canary is cleaned the same way).
- Step 7 is local and rewrites the clone in place (it prunes the old objects from the clone); `W/original.bundle` is the way back for the local state.
- Step 9 is the first change to the repository.
  Until step 15 the old tips can be pushed back from the bundle, because the old S3 objects still exist, but the pushed `git-annex` branch has already marked the old keys dead, so a roll back must also revive them (`git annex` `setpresentkey`) before the old tree is usable.
- Steps 10 and 11 change objects that are not locked; their old versions survive until step 15 prunes them, which is the only way back.
- Step 15 has no rollback.
  Do it only after step 14 passes, and keep `--max-delete` at the dry-run number.
  The new objects exist and are verified twice before it, so what step 15 removes is only the old copies.

## Order of datasets

Start with the smallest confirmed one to prove the whole path, then nm000348 (156 GB of recordings across 5 tags, the reported one), then the rest by size.
Sizes (Sep 15 snapshot): nm000186 0.5 GB, nm000176 0.8 GB, nm000114 0.9 GB, nm000246 62.7 GB, nm000348 165 GB.
Read-only plans made on 2026-10-04: nm000186 has 3 tags and 176 keys (541 MB to hash); nm000348 has 5 tags and 525 keys (156.4 GB to hash); every key in both needs a scrub.
