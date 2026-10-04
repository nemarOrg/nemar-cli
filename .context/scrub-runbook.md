# Runbook: scrub a published dataset in place

Operational steps for [ADR 0085](decisions/0085-a-privacy-correction-scrubs-every-version-in-place.md). One
dataset at a time, first one first. Every stage is a dry run unless it says `--execute`, and nothing
irreversible happens before step 12. **A working directory holds file names that may be identifying
(the git plan), so it is private and is deleted when the dataset is done.** Nothing printed or
written by any stage is a participant value.

`D` is the dataset id, `W` the working directory (`~/scrub-work/D`), `T` the tools
(`bun run scripts/scrub/...` from a checkout of this branch). Credentials are the ambient `aws` session
(an `ASIA` session, never a long-lived `AKIA` key in the environment) and `gh` as an org admin.

## Before the first dataset

1. ADR 0085 and the docs PRs are merged; the owner has said go for this dataset.
2. **Canary** proves the bypass: `bun run $T/s3/s3-scrub.ts canary --prefix D/canary-$RANDOM/ --execute`
   (and once with `--multipart`). It puts a locked object, shows delete without bypass is refused, deletes
   by version id with bypass, and ends at zero versions and zero markers. Run it on the test prefix
   `nm099999/` first.
3. The dataset is private with the bucket-policy exclusion (interim step), verified with an anonymous HEAD
   of one object (403) and a public control (200). Allow a few minutes after any bulk change.
4. The uploader and, for a mirror, the source archive have been told, and asked not to upload over it.
5. Know the dispatch behavior: the Worker dispatches version-DOI on any non-delete `v*` tag push (idempotent
   on the ledger) and enrichment on a push to `main` (it short-circuits on an unchanged source hash). Zarr is
   not dispatched from the webhook.

## Steps

0. **Clone metadata only** (private working copy):
   `git clone --no-checkout https://github.com/nemarDatasets/D W/clone && cd W/clone && git annex init`.
1. **Plan** (read-only): `s3-scrub.ts plan --dataset D --out W`. Stop unless it exits 0: exit 4 means a key was
   unreadable and the plan is incomplete. Read the counts: keys, how many need a scrub, bytes to hash.
2. **Git plan** (read-only): `bun run scripts/scrub/plan/build-git-plan.ts --repo W/clone --dataset D --out W/git-plan.json`.
   Read the counts (images dropped, JSON files blanked, provenance entries). Anything outside `sourcedata/`
   that the scanner flags is for a person to decide, not for the plan.
3. **Hash** on Hallu (reads every object once; the original is verified against its own key in the same pass):
   copy `plan.json` and `patches.json` over, then, with the detached launch form (see memory
   `hallu-launch-and-self-deploy-lag`), `python3 hash_stage.py compute --plan plan.json --patches patches.json
   --out hashes.json --workers 16`. Copy `hashes.json` back. Exit 0 only.
4. **Assemble** (admin credentials): `s3-scrub.ts assemble --dir W` is the dry run (object count, bytes uploaded
   versus copied server side); then `--execute`. New keys are created with GOVERNANCE retention at creation.
   Nothing is deleted. It writes `assembled.json` and `keymap.json`.
5. **Verify**: `s3-scrub.ts verify --dir W` (sizes, patched header, sampled ranges, retention) writes
   `verified.json`; on Hallu `python3 hash_stage.py verify-new --assembled assembled.json --out
   new-hash-verified.json` re-reads every NEW object and checks its key. Both must pass.
6. **Rewrite history** in a fresh clone: `git-scrub.ts snapshot --repo W/clone --out W/before.json`,
   `git-scrub.ts rewrite --repo W/clone --keymap W/keymap.json --plan W/git-plan.json --expect-remote ...`,
   `git-scrub.ts verify --repo W/clone --keymap ... --plan ... --before W/before.json`. Verify must exit 0:
   no old key in any blob of any ref, no dropped path, JSON blanked, commit counts and tag names unchanged.
7. **Register keys** in the clone (dry run first, then `--execute`): `git-scrub.ts annex-registry --repo W/clone
   --keymap W/keymap.json --remote-uuid 58cfc116-2170-45b1-9b1e-e7ec6979f534`. New keys present only at the S3 remote,
   old keys retracted at every holder and marked dead.
8. **Switch** (lifts only what blocks, pushes with leases, restores): `github/switch.ts snapshot --repo
   nemarDatasets/D --clone W/clone --out W/ruleset.json`, then `switch --snapshot ... ` (dry run), then
   `--execute`, then `check`. If the process dies, run `restore --execute` at once. Then push the
   `git-annex` branch normally.
9. **Regenerate every tag's manifest AFTER the tags moved** (before, the job rebuilds the old one from the old
   tree): dispatch through `/admin/manifest/dispatch` for each tag (see memory `manifest-healing-dispatch-over-rest`).
   Confirm each `s3://nemar/D/version/<tag>.json` names only new keys.
10. **Ledger**: append the entries (plan, headers-scrubbed, files-removed, history-rewritten, locks-applied,
    manifests-regenerated) with `scripts/scrub/ledger.ts`; commit `.nemar/corrections.jsonl` to `main` (a normal
    push, not a force) and upload it to `s3://nemar/D/corrections/ledger.jsonl`. The change-log sentence is already
    in every version through the git plan.
11. **Verify while still private** (admin reads, no public exposure): re-clone the dataset fresh from GitHub and run
    `git-scrub.ts verify` against it (the pushed refs, not the local rewrite); read every regenerated
    `s3://nemar/D/version/<tag>.json` and confirm it names only new keys; `verify-new` (step 5) already hashed every new
    object. The dataset stays private until the old bytes are gone, so there is no window in which an old key is
    publicly readable.
12. **Delete the old bytes** (the only irreversible step): `s3-scrub.ts delete-old --dir W --verified
    W/verified.json --hash-verified W/new-hash-verified.json` is the dry run (counts of versions and markers);
    then `--execute` with `--prune-noncurrent D/version/` (and `D/archives/` where archives exist). It ends with
    an authoritative `ListObjectVersions` showing zero versions and zero markers for every old key.
13. **Make public and verify from outside**: `nemar admin repo public D --yes`, then the fleet scan for the dataset
    (`identifier-fleet-scan.ts --only D`) expecting no direct finding, an anonymous download of one file per version
    hashing to its new key, and the data plane manifest naming only new keys. If anything fails, make it private again
    and stop; the new objects were verified twice, so the fault is in a manifest, a cache or a route, not in the bytes.
14. **Afterwards**: comment on the dataset issue in plain words and close it; tell the uploader and the authors; ask
    GitHub Support to clear cached views and pull-request refs; delete the working directory and local clones; record
    `old-versions-deleted` and `published-again` in the ledger and push it.

## Abort points and rollback

- Steps 0 to 5 change nothing but add new objects; abandoning leaves extra locked objects that are deleted later
  by version id with bypass (the canary shows it works).
- Step 6 is local. Step 8 is the first change to the repository; the pre-push snapshot lets the old tips be pushed
  back until step 12, because the old objects still exist.
- Step 12 has no rollback. Do it only after step 11 passes, and keep `--max-delete` at the dry-run number. The new objects exist and are verified twice before it, so what step 12 removes is only the old copies.

## Order of datasets

Start with the smallest confirmed one to prove the whole path, then nm000348 (165 GB, the reported one), then
the rest by size. Sizes (Sep 15 snapshot): nm000186 0.5 GB, nm000176 0.8 GB, nm000114 0.9 GB, nm000246 62.7 GB,
nm000348 165 GB.
