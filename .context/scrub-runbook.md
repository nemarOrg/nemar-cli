# Runbook: scrub a published dataset in place

Operational steps for [ADR 0085](decisions/0085-a-privacy-correction-scrubs-every-version-in-place.md).
One dataset at a time, the smallest one first.
Every stage is a dry run unless a command carries `--execute`, and nothing irreversible happens before step 9.
Four steps are irreversible, and each sits in a marked box: the force-push of the rewritten history (step 9), the deletion of the archives and of the old bytes (steps 15a and 15b), and making the dataset public again (step 16).
A box needs the maintainer's go for that dataset, in exact words, before its `--execute` is typed (see "Boxes and the go").

**The working directory holds file names that may be identifying (the git plan, the clone), so it is private (`chmod 700`) and is deleted when the dataset is done.**
Nothing printed or written by any stage is a participant value.
The one place values are read is the names-only probe in "Before each dataset", and it prints member names, never values.

## Setup

```bash
D=nm000186                  # the dataset id
W=$HOME/scrub-work/$D       # the working directory; no spaces in the path
T=scripts/scrub             # the tools; run every command from the root of a checkout of the merged branch
mkdir -p -m 700 "$W"
```

**Prerequisites**, on the machine that runs the stages:

- `bun`, `uv` (the rewrite runs `uv run --with git-filter-repo==2.47.0`, so uv must be able to fetch or have cached that version), `git`, `git-annex`, `jq`, `curl`, and `gh` as an org admin (`switch.ts` takes its token from `GITHUB_TOKEN` or `gh auth token`).
- **`aws` CLI 2.23.0 or later.**
  `s3-scrub.ts` (every command except `zarr-public`) and `ledger-cli.ts publish` run `aws --version` first and refuse an older CLI (`aws-cli-too-old`) or one whose version cannot be read (`aws-cli-version-unknown`), both exit 3 with nothing attempted.
  The hash host needs the same CLI for its default source command, although `hash_stage.py` does not check.
- Credentials are the ambient `aws login` session (short-lived `ASIA` credentials).
  A long-lived `AKIA` key in the environment is refused (`long-lived-key-in-environment`).
  The S3 tools resolve the session once and share it across every `aws` call (`cliCredentialSource`), because parallel `aws` processes race on the login session's single-use refresh token.
  So do not `export` credentials in the shell that runs the TypeScript tools: a key already in the environment is used as it is, and it expires.
- The hash host (a host with fast reads from S3; Hallu in the maintainers' setup) needs `python3` 3.12, the `aws` CLI, and the host's own read-only AWS credentials.
- The suites pass on the checkout: `NEMAR_REQUIRE_SCRUB_TOOLS=1 bun run test:scrub` (669 tests when this runbook was written; the variable makes a missing tool a failure, not a skip).
  One file: `bun test --path-ignore-patterns=x test/scrub/<file>.test.ts`, because `bunfig.toml` keeps `test/scrub` out of a bare `bun test` and hides even an explicit path.

Every tool prints counts and fixed words only.
`s3-scrub.ts`, `git-scrub.ts` and `hash_stage.py` print their usage with `--help`; the others print theirs on a usage error.
A bad flag is exit 2 everywhere.

## Boxes and the go

An **irreversible** step is one whose result cannot be undone from what the tools keep.
Each box below lists what it destroys, the checks to make by hand (the tool checks the rest, and a dry run shows all of its refusals at once before `--execute` is typed), and the words.

The go is a sentence the maintainer says for this dataset and this step:

```
GO <step> <dataset> <plan-id>
```

where `<plan-id>` is `shasum -a 256 $W/plan.json | cut -c1-12` (`sha256sum` on Linux).
The plan-id ties the go to one plan, so a go cannot be reused for another dataset or after a re-plan.
For example, `GO delete-old nm000186 3f9a1c0b27de`.
The steps are `switch`, `drop-archives`, `delete-old` and `public`, and each needs its own go.

Record each go twice before acting on it: append the line and the date to `$W/go.txt`, and post the same line as a comment on the epic issue (nemarOrg/nemar-cli#1610), which is public and carries no value.
The ledger records each step afterwards (`--actor` is the person who ran it), but it has no field for who gave the go and it refuses free text by design (ADR 0036), so the go itself cannot be written into a ledger line.
`$W` is deleted at the end, so the epic comment is the record that lasts.

The tools add their own words: `--confirm-dataset $D` on `drop-archives` and `delete-old` (the dataset id typed again, required even for the dry run), and the prompt of `nemar admin repo public`.

## Exit codes

| Tool | 0 | 1 | 2 | 3 | 4 | 5 | Signals |
|---|---|---|---|---|---|---|---|
| `s3-scrub.ts` | ok | a stage failed | usage | refused (a precondition or proof is missing or stale) | unreadable (the plan, a Zarr store or the Zarr index is incomplete) | versions or markers remain after a delete | 129, 130, 143 |
| `git-scrub.ts` | done | failed (a command or the tool broke) | usage | refused (nothing was changed) | checked and not clean (`verify` found failures, or `annex-registry`'s read-back disagrees) | | |
| `build-git-plan.ts` | plan written | failed | usage | refused (no plan written) | | | |
| `switch.ts` | done | failed (a push failed part way) | usage | refused (nothing changed) | | a ruleset could not be restored | 129, 130, 143 after restoring |
| `hash_stage.py` | all done and verified | an object failed | usage | refused (an input does not match the contract, or `patches-stale`) | `--limit` stopped with keys left | | 129, 130, 143 |
| `ledger-cli.ts` | done | failed | usage | refused (nothing written) | written but not proven: look at the object now | | 129, 130, 143 |
| `identifier-fleet-scan.ts` | done | | usage | the run was stopped (a server was struggling) | | | |

Each step below says which exit continues; a nonzero exit is never "close enough".

`drop-archives` and `delete-old` evaluate every refusal before they stop, so one dry run lists them all.
On stdout there is one line per refusal, `<stage>: refused <word>: <what triggered it>` (a count, a file name or a tag, never a value), in a fixed order.
The stop line on stderr joins the words with `+`, for example `s3-scrub: archives-not-dropped+history-remains`; with one refusal it is the word alone, and the exit is 3 either way.

## Files in the working directory

| File | Written by | Needed by |
|---|---|---|
| `plan.json`, `patches.json` | step 1 (`patches.json` first; `plan.json` names its sha256 as `patchesSha256`) | every later stage |
| `hashes.json` | step 3, on the hash host | step 4 |
| `assembled.json`, `keymap.json` | step 4 | steps 5, 7, 8, 14, 15a, 15b |
| `verified.json` | step 5 | steps 15a and 15b |
| `new-hash-verified.json` | step 5, on the hash host | steps 15a and 15b |
| `git-plan.json`, `git-plan.json.skipped.json`, `git-plan.report.json` | step 2 | steps 7, 13, 14 |
| `before.json` | step 7 | steps 7 (local verify) and 9 (snapshot) |
| `git-verified.json` | step 7 (mode `local`), then step 14 (mode `fresh-clone`, which overwrites it) | steps 15a and 15b need the `fresh-clone` one |
| `ruleset.json` | step 9 | step 9 (switch, check, restore) |
| `zarr-plan.json`, `zarr-verified.json`, `zarr-unknown-members.json` | step 10 | steps 15a and 15b (the first two) and 16 (`zarr-public`) |
| `archives-dropped.json` | step 15a | the record only |
| `deleted.json` | step 15b | step 17 (the ledger) |
| `ledger.jsonl` | step 13 | steps 13 and 17 |
| `original.bundle` | step 0 | rollback |
| `go.txt` | by hand | the record |

Every file is written atomically (a temp file in the same directory, then a rename) with mode 0600.
A file that exists and cannot be read is `<name>-unreadable` (exit 1); `<name>-missing` means it does not exist (exit 3).

**Files from an older version of the tools are refused.**
A `plan.json` made before `patchesSha256` existed (the read-only plans of 2026-10-04 are such files) is refused by `assemble`, `verify` and the hash stage as `patches-stale` (exit 3): plan again, which is read-only.
A re-plan is refused over an existing `assembled.json` (`assembled-exists`), because it would orphan an assembly; abandon the assembly first (see "Abort points and rollback").
A `zarr-verified.json` from the older Zarr stage has no `stores` or `allowedMembers` and does not parse: `drop-archives` and `delete-old` refuse it (`zarr-not-scrubbed`) and `zarr-public` refuses it (`zarr-verified.json-invalid`); run the zarr stage again.
A `before.json` or a switch snapshot without `originTips` is refused (`before-invalid` by `switch.ts snapshot`, `snapshot-invalid` by `switch.ts switch`, `refused: contract` by `git-scrub verify`), and a before file cannot be taken after the rewrite (`snapshot-after-rewrite`), so a clone the older tool rewrote is cloned again and rewritten again, with `original.bundle` as the way back.
A `ledger.jsonl` line written by the older tool with `old-versions-deleted` and a bare verification no longer validates; the line is appended again from `deleted.json` (step 17).

## What a copy of a recording can be

A scrub is only complete when every copy NEMAR controls is clean.
Measured in the real bucket on 2026-10-04 and 2026-10-05, a dataset has these:

| Where | What it holds | Handled by |
|---|---|---|
| `D/objects/` | the recordings, locked 100 years | steps 1 to 6, 15b |
| GitHub history | annex pointers, inline JSON, file names | steps 7 to 9 |
| `D/zarr/**/<store>.zarr/zarr.json` | the subject and operator members the converter mirrors from the EDF or BDF header into `attributes.recording_metadata`: `patientcode`, `birthdate`, `gender`, `patient_name`, `patient_additional`, `admincode`, `technician`, `equipment`, `recording_additional` (the removal set, `EDF_MIRROR_MEMBERS`), plus every key the scanner calls an identifier. Only the technical members stay (`startdate`, `filetype`, `number_of_signals`, `file_duration`, `datarecord_duration`, `source_file`, `source_format`, `streamed`, `channels_tsv_units`). Not locked | steps 10 and 15b |
| `D/archives/*.zip` | the original recordings, zipped | steps 11, 15a and 16 |
| `D/version/<tag>.json` | keys, paths and checksums | steps 12 and 15b |
| `D/version/<tag>-summary.json` | entities, signal summaries, provenance; no header field (checked by key name) | regenerated with the manifest in step 12 |
| `D/version/<tag>-records.json` | the same kind of content | not regenerated by the manifest dispatch; checked by key name on 2026-10-04 |
| Zenodo backup deposits | a release archive of the tag, when a Zenodo key is configured | no tool here reads or changes Zenodo: step 17 |

The principle behind the Zarr row, from the maintainer (2026-10-05): a store holds the data and the events plus channel names, types and units and technical recording metadata, and says nothing about the subject.
Subject and phenotype information (age, sex, patient code, birth date, name, additional patient text) lives at dataset scope, and `participants.tsv` is the one canonical place for it.
So `gender` is removed from a store although sex is neither a name nor a date: the scrubbed header's patient field says nothing about sex, and the store must say no more than the header does.

## What a push sets off

No tool in this branch suppresses workflow dispatch, pauses the Zarr queue or removes the uploader's write access (ADR 0085 lists these as not built).
So the operator expects, and watches, what a push causes:

- **A `v*` tag push** (a force-push is still a push) makes the Worker dispatch the version-DOI workflow for each such tag.
  That run mints idempotently (a version that already has a DOI is not minted again), dispatches the central manifest job with `skip_canary: true`, and can upload a Zenodo backup when a Zenodo key is configured (`backend/src/routes/callbacks/version-doi.ts`).
  The same workflow dispatches the archive job, so a new archive can appear after the tags move.
- **A push to `main`** dispatches enrichment when it touches enrichment paths; the enrichment workflow's `source_hash` guard skips a run whose source is unchanged, so a run may follow a rewrite.
- **Zarr is not dispatched from the webhook.**
  The converter runs on the Hallu cron (ADR 0029).
  While the dataset is private the queue's `reconcile` parks it as `unlisted` (`scripts/zarr/zarr_queue.py`), so it is not converted; a row already `inprogress` is finished by its own converter.
  Before step 10, confirm on Hallu that no queue row for `D` is `inprogress`.
- `zarr.nemar.org` gates on visibility before it reads any cache, so it serves nothing for a private dataset.
  Its edge copy of a `zarr.json` lives `max-age=60, stale-while-revalidate=300` (so at least 6 minutes) when the URL carries no `?v=` token, and `max-age=86400, stale-while-revalidate=86400` when it does (`cacheControlFor` in `backend/src/routes/zarr-data.ts`).
  A cache purge is a no-op: the Cloudflare token and zone id are unset in production, as that file documents.

Watch the runs with `gh run list --repo nemarDatasets/.github --limit 30`, and let them finish before step 12 and again before step 14.

## Real-bucket checklist

The local S3 stand-in (`test/scrub/helpers/s3-standin.ts`) encodes what its authors believe S3 does.
The first multipart canary found that real S3 refuses an `UploadPart` without a checksum under Object Lock, which the stand-in had not said.
So each item below is assumed, not measured, until it has been run against the real bucket and GitHub: once before the first real `--execute` on any dataset (before step 4), and again after any change to an S3 call.
Use only the test prefixes: `nm099999` or a dev ephemeral sandbox `xx090000` to `xx098999`, never a live dataset, a production sandbox or the exemplar fleet.
Record the outcome of each item on the epic.

```bash
aws login                                  # a fresh session; the checklist is short
PC=nm099999/canary-$(date +%s)-tool/       # the prefix for the canary stage
PM=nm099999/canary-$(date +%s)-manual/     # the prefix for the manual items; never share one with the stage
mkdir -p -m 700 "$W/check" && printf 'a\n' > "$W/check/a.txt"
```

**C1. The canary stage, both modes.**
An earlier canary, without the conditional-write steps, passed against the real bucket on 2026-10-04, so run the current one.
It proves: the lock holds without the bypass and gives way with it; an `If-Match` put and get with the current ETag succeed, and with a stale one are refused (`PreconditionFailed`); an `UploadPart` and `UploadPartCopy` under a lock set at `CreateMultipartUpload`; the checksum headers the CLI sends over HTTPS (the stand-in sees plain HTTP, and real S3 may take `aws-chunked` bodies with trailing checksums); that an unlocked object deletes without the bypass, which also shows that no default bucket retention applies; and that the final listing is empty.

```bash
bun run $T/s3/s3-scrub.ts canary --prefix $PC --execute
bun run $T/s3/s3-scrub.ts canary --prefix $PC --execute --multipart
```

Expected, each run exit 0, with these lines in order:

```
canary: put a locked probe object
canary: a delete without the bypass was refused (the lock holds)
canary: a delete with the bypass succeeded
canary: a put conditional on the current ETag succeeded
canary: a put and a get conditional on a stale ETag were refused (precondition)
canary: the unlocked versions were deleted by id without the bypass
canary: zero versions and zero delete markers remain under the prefix
```

With `--multipart`, also `canary: multipart object built with the lock set at create`, and the without-bypass and with-bypass pair twice more.
Any other word is a stop: `lock-not-enforced`, `bypass-denied`, `conditional-put-not-enforced`, `conditional-get-not-enforced`, `conditional-put-failed:...`, `unlocked-delete-refused:...`, `multipart-lock-missing`, or `canary-remainder` (exit 5).
Then confirm independently that nothing is left; both listings must be empty:

```bash
aws s3api list-object-versions --bucket nemar --prefix $PC
aws s3api list-multipart-uploads --bucket nemar --prefix $PC
```

**C2. `If-None-Match` on a put.**
`ledger-cli.ts publish` uses it for a first publish, and the canary does not.

```bash
aws s3api put-object --bucket nemar --key ${PM}none-match.txt --body $W/check/a.txt --if-none-match '*'   # expect success and a VersionId
aws s3api put-object --bucket nemar --key ${PM}none-match.txt --body $W/check/a.txt --if-none-match '*'   # expect a nonzero exit: PreconditionFailed (412)
```

**C3. A conflicting write in flight (`409 ConditionalRequestConflict`).**
No command provokes it on demand.
The tools map it to the same word as `412` (`precondition-failed`), so the stage reports `changed-concurrently` (zarr) or `remote-ledger-changed` (ledger) and writes nothing.
If it ever appears, the rule is: look at the object, then run the stage again.

**C4. `DeleteObject` of a version id that does not exist.**
The stand-in answers 404 `NoSuchVersion`; real S3 is believed to answer 204.
The code does not depend on either: deletes are counted for the report only, and the final authoritative `ListObjectVersions` decides (`delete-old`, `drop-archives`, the canary).

```bash
V=$(aws s3api put-object --bucket nemar --key ${PM}gone.txt --body $W/check/a.txt --query VersionId --output text)
aws s3api delete-object --bucket nemar --key ${PM}gone.txt --version-id "$V"    # removes it
aws s3api delete-object --bucket nemar --key ${PM}gone.txt --version-id "$V"    # the version is gone now: note exit 0 (204) or NoSuchVersion
```

**C5. `CompleteMultipartUpload` answering 200 with an `<Error>` body.**
The stand-in never does, and no command provokes it.
Every assembly re-reads the new object after completing it, so a silent failure shows as `new-object-missing` or `new-size-mismatch`, but the word does not name the cause.
If it appears: list the open uploads (`aws s3api list-multipart-uploads --bucket nemar --prefix $D/objects/`), abort what is open, and run `assemble` again, which resumes.
C1 with `--multipart` proves the happy path of the same call.

**C6. The anonymous `HEAD` gate** of `delete-old` and `zarr-public`.
The tests use a constant-status local server, not the stand-in.
This bucket denies anonymous `ListBucket`, so a missing key answers 403 as a private one does, and only a key known to exist makes 403 mean private.

```bash
S3=https://nemar.s3.us-east-2.amazonaws.com
curl -s -o /dev/null -w '%{http_code}\n' -I "$S3/<public dataset>/version/<one of its tags>.json"        # expect 200 (the public control)
K=$(aws s3 cp "s3://nemar/$D/version/<one of its tags>.json" - | jq -r '[.files[].key | select(startswith("git:") | not)][0]')
curl -s -o /dev/null -w '%{http_code}\n' -I "$S3/$D/objects/$K"                                          # expect 403 (D is private)
```

Take the control from the public catalog (`https://api.nemar.org/datasets`: a public dataset's `dataset_id` and `latest_version`).
The second request needs an object that exists, so it takes one key from the dataset's own manifest.
Allow a few minutes after any change of visibility: on 2026-10-04 three datasets stayed readable briefly while the bucket policy settled.

**C7. The `aws` CLI's retry policy.**
Every test pins `AWS_MAX_ATTEMPTS=1`, and the tools do not, so on the real bucket the CLI can repeat a conditional put after a timeout.
A repeated `If-Match` put whose first attempt landed gets 412 and is reported as `changed-concurrently` or `remote-ledger-changed`, although nothing else wrote.
That is fail-safe (a refusal, never an overwrite) but the word misleads: read the object, then run the stage again.
See what the CLI will do with `aws configure get retry_mode; aws configure get max_attempts` (empty output means the defaults).

**C8. `ListMultipartUploads`.**
`assemble` uses it to report an upload that a lost `CreateMultipartUpload` answer left open, and it has only run against the stand-in.
The call itself, and the operator's permission for it, are proven with the CLI:

```bash
U=$(aws s3api create-multipart-upload --bucket nemar --key ${PM}mpu.bin --query UploadId --output text)
aws s3api list-multipart-uploads --bucket nemar --prefix $PM --query 'Uploads[].[Key,UploadId]' --output text   # expect one row naming the key and $U
aws s3api abort-multipart-upload --bucket nemar --key ${PM}mpu.bin --upload-id "$U"
aws s3api list-multipart-uploads --bucket nemar --prefix $PM        # expect no Uploads
```

The tool's own parser of that answer is proven only by the stand-in.

**C9. Encryption and cache control on a Zarr rewrite.**
The zarr stage keeps a store root's content type, cache control and server-side encryption (`sse`, `kmsKeyId`) when it rewrites it, which is tested against the stand-in only.
Before the first zarr `--execute`, record what one store root carries, and compare after step 10:

```bash
aws s3api head-object --bucket nemar --key "$D/zarr/<one store>/zarr.json" --query '[ServerSideEncryption,SSEKMSKeyId,ContentType,CacheControl]'
```

Expect the same four values before and after.

**C10. Bucket-wide Object Lock settings.**

```bash
aws s3api get-object-lock-configuration --bucket nemar
```

Expect `ObjectLockEnabled: Enabled` and no `Rule` (no default retention).
A default retention would refuse the unlocked deletes of `drop-archives` and of the prune, version by version, which the stages report but cannot fix.

**C11. GitHub ruleset updates.**
`switch.ts` lifts a ruleset with a `PUT` of the ruleset as `GET` returned it minus its read-only fields, restores it the same way, and reads it back.
Only the real API shows that this is accepted.
On the disposable end-to-end repository, with a clone that has nothing to push, a round trip lifts and restores the rulesets and pushes no ref:

```bash
git clone https://github.com/nemarDatasets/nm099999 $W/check/clone
bun run $T/git/git-scrub.ts snapshot --repo $W/check/clone --out $W/check/before.json
bun run $T/github/switch.ts snapshot --repo nemarDatasets/nm099999 --clone $W/check/clone --before $W/check/before.json --out $W/check/ruleset.json
bun run $T/github/switch.ts switch --repo nemarDatasets/nm099999 --clone $W/check/clone --snapshot $W/check/ruleset.json            # dry run
bun run $T/github/switch.ts switch --repo nemarDatasets/nm099999 --clone $W/check/clone --snapshot $W/check/ruleset.json --execute
bun run $T/github/switch.ts check --repo nemarDatasets/nm099999 --snapshot $W/check/ruleset.json
```

Expect `plan: lift N ruleset(s), push 0 ref(s)`, then `lifted ruleset ...`, `restored N ruleset(s)`, `done: lifted=N pushed=0 restored=N`, and `protection matches the snapshot`.
If it prints `snapshot: 0 ruleset(s)` the repository has no ruleset and this proved nothing.
The snapshot also refuses a repository whose branches or tags are not what the switch expects (`unexpected-remote-head`, `remote-only-tag`); then the check needs another repository that has a tag ruleset.
A force-push of a moved tag is not part of this round trip; step 9 of the first dataset is its first proof, so read its dry run twice.

**Clean up** the manual prefix, and confirm both listings are empty:

```bash
aws s3api list-object-versions --bucket nemar --prefix $PM --output json \
  | jq -r '(.Versions // []) + (.DeleteMarkers // []) | .[] | [.Key, .VersionId] | @tsv' \
  | while IFS="$(printf '\t')" read -r k v; do aws s3api delete-object --bucket nemar --key "$k" --version-id "$v"; done
aws s3api list-object-versions --bucket nemar --prefix $PM
aws s3api list-multipart-uploads --bucket nemar --prefix $PM
rm -rf $W/check
```

## Before each dataset

1. The tooling PR and the docs PRs are merged, and the maintainer has said go for this dataset.
   The first dataset is also the first real run of every stage: take it slowly, and stop at the first word this runbook does not explain.
2. The real-bucket checklist has been run with the current checkout, after the last change to an S3 call.
3. The dataset is private with the bucket-policy exclusion (`nemar admin repo private $D` is the supported transition: the GitHub repository, the bucket policy and the catalog row), verified by C6: an anonymous `HEAD` of one of its objects answers 403, and a public control answers 200.
4. The uploader, and for a mirror the source archive, have been told and asked not to upload over it.
   Nothing here stops an upload: a push the uploader makes during the run is caught by the leases of step 9 (`remote-moved-since-clone`), and a recording written to S3 after the plan is caught by `delete-old` (`unplanned-recording`).
5. **Read the member names, not the values, of the real Zarr stores**, so the lists in `scripts/scrub/s3/zarr-json.ts` are known to cover what the converter wrote.
   One store:

   ```bash
   S=$(aws s3 cp "s3://nemar/$D/zarr/index.json" - | jq -r '.stores[0].zarr')
   aws s3 cp "s3://nemar/$D/zarr/$S/zarr.json" - | jq -r '(.attributes.recording_metadata // .attributes.recording_info // {}) | keys[]'
   ```

   Every store, as a histogram of names and counts (never a value):

   ```bash
   aws s3 cp "s3://nemar/$D/zarr/index.json" - | jq -r '.stores[].zarr' \
     | while read -r s; do aws s3 cp "s3://nemar/$D/zarr/$s/zarr.json" - | jq -r '(.attributes.recording_metadata // .attributes.recording_info // {}) | keys[]'; done \
     | sort | uniq -c | sort -rn
   ```

   `jq keys` prints names only; never print the object itself.
   For comparison, the census of 2026-10-05 (names only, store roots only):
   - **nm000186**, all 88 store roots: `birthdate`, `patientcode`, `gender` and `equipment` (non-empty in every one); `startdate` (a typed object); `source_file`, `source_format`, `number_of_signals`; empty `filetype`, `file_duration`, `datarecord_duration`; `channels_tsv_units` (an object with `converted`, `kept_importer_unit`, `relabelled`, `units_column_present`); no `technician`, `admincode`, `patient_name`, `patient_additional` or `recording_additional`.
     The real run therefore removes exactly four members from each of the 88 roots (352) and leaves the other eight.
   - **nm000348**, 153 stores (33,250 Zarr keys): only `channels_tsv_units`, `number_of_signals`, `source_file`, `streamed`.
     Nothing to remove, and a clean proof (`found: stores`), not a failure.
   - A name outside the removal set and the allow-list refuses the zarr stage (`unknown-recording-member`, step 10) until a person has looked at it.
     The four technical flags biosigIO writes only when they apply (`channel_labels_deduplicated`, `brainvision_header_recovered`, `eeglab_fdt_recovered`, `edf_tolerant_read`, named in `scripts/zarr/requirements.txt`) are not in the allow-list, so a store with one is refused until `--allow-member NAME` names it; whether to add them to the list is the maintainer's decision.
6. Know what a push sets off (above).
   And know that nothing stops the converter from writing the removed members again on a reconversion until Phase 8 (nemarOrg/nemar-cli#1626) changes it, so a reconversion after the scrub makes `zarr-public` report them.

## Steps

### Step 0: Clone

A private working copy, and a normal clone, because the rewrite refuses a tree that is not clean and a `--no-checkout` clone reads as every file deleted:

```bash
git clone https://github.com/nemarDatasets/$D $W/clone && (cd $W/clone && git annex init)
git -C $W/clone bundle create $W/original.bundle --all
```

The bundle holds the original inline content and every ref, so it is private and is deleted with `W`.
It is the way back until step 15b.

### Step 1: Plan (read-only)

```bash
bun run $T/s3/s3-scrub.ts plan --dataset $D --out $W
```

Continue only on exit 0.
Exit 4 means the plan is incomplete, and no later stage runs on it: a key was unreadable, a manifest named an EDF or BDF held inline in git (`git-inline-recording`), `version/` held a file that is neither a manifest nor a known sibling (`version-dir-unknown-file`), or a recording hidden by a delete marker needs a scrub (`masked-needs-scrub`; a recording with markers and no version at all is `markers-only`).
A masked recording (`masked-needs-scrub`, `markers-only`) is a person's decision: the tools never remove a delete marker, so remove it and plan again, or deal with its versions.
The line `plan: unreadable by reason: ...` names each reason with its count.
The keys are the union of every manifest and of a listing of every version and delete marker under `D/objects/`, so a recording that no manifest names, or whose current entry is a delete marker, is still found.
Read the counts: tags, keys, how many need a scrub, bytes to hash.
A plan made with `--tags` is partial, and a plan with any unreadable key is incomplete; assemble, verify, zarr, drop-archives, delete-old and the hash stage all refuse either (`plan-partial`, `plan-has-unreadable`).

### Step 2: Git plan (read-only)

```bash
bun run $T/plan/build-git-plan.ts --repo $W/clone --dataset $D --out $W/git-plan.json --s3-plan $W/plan.json > $W/git-plan.report.json
```

It reads every commit of every ref, not only the tips, and prints one JSON line of counts (`dropPaths`, `jsonFilesBlanked`, `jsonKeysBlanked`, `provenanceEntriesDropped`, `skippedOversizeJson`, `skippedUnparseableJson`, `orphanKeys`, `versions`), which the redirect keeps for step 13.
Exit 3 is a refusal that writes no plan:

- `skipped-json (oversize=N unparseable=M)`: an inline JSON file could not be read in some commit (over 1 MiB, or not UTF-8 JSON), so its identifier keys would never be blanked.
  The paths are in `$W/git-plan.json.skipped.json`.
  Look at them; if a person accepts them unread, run again with `--allow-skipped-json`, and the plan lists them under `skippedJson` (their keys are not blanked).
- `tag-not-semver (N)`: a `v*` tag that is not `vX.Y.Z[-pre]`.
- `orphan-key (N)`: a key the S3 plan scrubs that no commit's pointer or symlink names, so the rewrite would refuse its keymap entry.
  Assembling such a key (an orphan, with `gitReferenced: false` in the keymap) is not built (ADR 0085, deferred items); stop and ask.
- `s3-plan-dataset-mismatch`.

Anything outside `sourcedata/` that the scanner flags is for a person to decide, not for the plan.
Read the counts (files dropped, JSON files blanked, provenance entries).

### Step 3: Hash

This reads every object once; the original is verified against its own key in the same pass.
`hash_stage.py` runs where the data is read quickly, so it runs on the hash host, which needs only `hash_stage.py` (standard library plus the `aws` CLI), `plan.json` and `patches.json`.
For a small dataset the host can be this machine, with the credentials frozen for the short run: `eval "$(aws configure export-credentials --format env)"`, in a shell that runs nothing else.
For a large one, copy the inputs, run there, and carry `hashes.json` back (the files hold annex keys, sizes, version ids and patched headers, no value; they are 0600):

```bash
H=hallu                                       # an ssh alias for the hash host
ssh $H "mkdir -p -m 700 scrub-work/$D"
scp -p $T/hash/hash_stage.py $W/plan.json $W/patches.json $H:scrub-work/$D/
ssh $H "cd scrub-work/$D && python3 hash_stage.py compute --plan plan.json --patches patches.json --out hashes.json --workers 16"
scp $H:scrub-work/$D/hashes.json $W/hashes.json
```

For a run longer than a session, launch it detached on the host (the form is in the maintainers' memory `hallu-launch-and-self-deploy-lag`), and later run the foreground command again: `hashes.json` is resumed, so it reads nothing more and exits 0 exactly when every key is in it.
Each entry is bound to its patch, so a re-plan with different scanner rules recomputes rather than reusing a stale digest.
`--limit N` reads at most N keys and exits 4 when keys remain; `--timeout`, `--retries`, `--retry-backoff`, `--checkpoint-every` and `--source-cmd` are in `--help`.
Continue only on exit 0.
The stage refuses (exit 3) a partial plan, a plan with an unreadable key, a `patches.json` that is not the one written with `plan.json` (`patches-stale`), and totals that disagree with the keys.
SIGINT, SIGTERM and SIGHUP kill every running source command with its `aws` child, save the finished keys, and exit 130, 143 or 129.

### Step 4: Assemble (admin credentials)

```bash
bun run $T/s3/s3-scrub.ts assemble --dir $W               # dry run: object count, bytes uploaded versus copied server side
bun run $T/s3/s3-scrub.ts assemble --dir $W --execute
```

New keys are created with GOVERNANCE retention at creation.
Nothing is deleted.
It writes `assembled.json` and `keymap.json` only when every object succeeded.
A failed `CreateMultipartUpload` lists the open uploads left on the new key and prints each as `assemble: open upload left by a failed create: key=... uploadId=...`, and the failure word gets `+upload-may-be-open`; a failed abort prints `assemble: abort-failed key=... uploadId=... (...)`.
Uploads are reported, never aborted for you: abort them as in "If a stage is killed", then run assemble again, which finds and keeps what it already made.

### Step 5: Verify

On this machine, `verify` checks sizes, the patched header, sampled ranges, retention, and that the version assembly recorded is still the current version of the new key; it writes `verified.json`:

```bash
bun run $T/s3/s3-scrub.ts verify --dir $W
```

On the hash host, `verify-new` re-reads every NEW object at the version assembly recorded (`newVersionId`, through `aws s3api get-object --version-id`, the body on `/dev/fd/3`) and checks it against its key:

```bash
scp -p $W/assembled.json $H:scrub-work/$D/
ssh $H "cd scrub-work/$D && python3 hash_stage.py verify-new --assembled assembled.json --out new-hash-verified.json --workers 16"
scp $H:scrub-work/$D/new-hash-verified.json $W/new-hash-verified.json
```

When both have passed, remove the host's copy: `ssh $H "rm -rf scrub-work/$D"`.
That default source is new: run it once on a small dataset on the host it will run on before trusting it on a large one, since a Linux `/dev/fd` behaves differently from macOS in edge cases.
Both must pass.
`verify` prints `verify: ok ...`, and a failure prints `verify: FAILED ...` with words such as `new-not-current` (someone wrote the new key after assembly), `old-unreadable:<Op>:<class>`, `header-not-patch`, `range-mismatch`, `lock-missing`, `retention-short`.
`verify-new` writes `new-hash-verified.json` only if every object matches, and removes one left by an earlier run.

### Step 6: Sanity (still read-only)

The public fleet scan lists only public datasets and refuses a private one (`--only ids not in the public catalog`, exit 2), and a dataset must never be made public to scan it.
So for a private dataset the screen from inside is the plan itself, which read every recording header with the scrub's own rule: step 1's counts are that screen, and step 16 runs it again after the scrub.
If the scan's record for this dataset from before it went private is still on hand (`<out>/$D.json`), compare counts: `jq '{status, incomplete, edf_bdf: .files.edf_bdf, flagged: .edf_bdf_files_flagged}'` of that file against the plan's keys and `needScrub`.
The record holds counts and never paths, and the plan counts distinct keys while the scan counts files, so a gap is explained, not assumed away: shared keys explain a plan with fewer, and a scan that was `incomplete` explains one with more.

### Step 7: Rewrite history in the clone

```bash
bun run $T/git/git-scrub.ts snapshot --repo $W/clone --out $W/before.json
bun run $T/git/git-scrub.ts rewrite --repo $W/clone --keymap $W/keymap.json --plan $W/git-plan.json
bun run $T/git/git-scrub.ts verify --repo $W/clone --keymap $W/keymap.json --plan $W/git-plan.json --s3-plan $W/plan.json --before $W/before.json
```

Take `before.json` before the rewrite: it records `originTips`, every head and tag the clone knew of the remote, which step 9 uses as its leases, and a snapshot after the rewrite is refused (`snapshot-after-rewrite`).
`rewrite --snapshot-out $W/before.json` snapshots first, in one command.
The rewrite derives its target from the plan (the clone's origin must be `nemarDatasets/$D`; `--expect-remote` is optional and must name the same repository).
It refuses a clone that is not clean or has a stash, whose branches do not match origin, or whose history never held a keymap key (`keymap-key-never-seen`), and prints `rewrite: ok <counts>`.
A relative `--report` is resolved from where you stand.
Its refusals are exit 3 (`bad-input: ...` too), and failures are exit 1.
A failure after the refs were rewritten prints `failed: cleanup-after-rewrite: the refs WERE rewritten; old objects may remain in the object store. In the clone run ...`: run the two commands it names in the clone, then verify.
The rewrite deletes `refs/annex/last-index`, a cache that git-annex 10.20240129 writes and that names the pre-rewrite index (it would keep every old pointer blob reachable); a later `git status` can recreate it, naming the new index, which is harmless.

Verify must exit 0: no old key in any blob, commit message or annotated-tag message of any ref, every EDF and BDF key in any commit is a new key or one the plan found clean, no dropped path, JSON blanked and structural edits applied, commit counts and tag names unchanged.
Exit 4 prints `verify: FAIL reason=... count=...` for each reason.
`--allow-unparseable-json` accepts a plan path whose content is not JSON in some commit; it is about plan paths and is unrelated to step 2's `--allow-skipped-json`.
A passing verify writes `$W/git-verified.json` in mode `local`; steps 15a and 15b need the one that step 14 writes.

### Step 8: Register keys in the clone

```bash
bun run $T/git/git-scrub.ts annex-registry --repo $W/clone --keymap $W/keymap.json              # dry run
bun run $T/git/git-scrub.ts annex-registry --repo $W/clone --keymap $W/keymap.json --execute
```

New keys are recorded present at the S3 remote only, and old keys are retracted at every holder and marked dead.
The S3 remote is the special remote named exactly `nemar-s3` in this clone (read from `git-annex:remote.log`, else `git config remote.nemar-s3.annex-uuid`), so there is no uuid to paste: each repository's `initremote` gave its remote its own uuid, and one from another dataset is refused.
Refusals (exit 3): `annex-not-initialized`, `no-nemar-s3-remote`, `remote-uuid-ambiguous` (two remotes named `nemar-s3`), `remote-uuid-unknown` (any `--remote-uuid`, given or derived, that is not a special remote of this clone), `old-key-unknown` (an old key with no location log and no holder: another dataset's keymap).
The dry run prints `annex-registry: dry-run oldKeys=.. holdersToRetract=.. newKeys=.. newToRegister=..`; `--execute` prints `annex-registry: ok ...`, or `FAILED` with exit 4 when the read-back disagrees.
This changes the clone's `git-annex` branch only; nothing is on GitHub until step 9.

### Step 9: Switch the repository

> **IRREVERSIBLE: step 9, force-push of every branch and tag**
>
> **What it destroys.**
> The dataset's published history on GitHub: `main` and every `v*` tag are replaced by the rewritten ones, and the pushed `git-annex` branch marks every old key dead.
> The only way back is `$W/original.bundle`, by hand and untested (see "Abort points and rollback"), and GitHub's cached views and pull-request refs are beyond NEMAR.
>
> **Preconditions you check by hand.**
> - Steps 7 and 8 passed, and `jq -r .mode $W/git-verified.json` prints `local`.
> - The dataset is private (C6) and the uploader has been told.
> - The snapshot below succeeded, and `switch.ts check` right after it says `protection matches the snapshot`.
> - You have read the dry run of the switch: `plan: lift N ruleset(s), push M ref(s)`, where M is one for `main` plus one per tag that changed, and N is the number of active rulesets that block the push (a branch ruleset the pusher can bypass is left alone).
> - The maintainer's go is recorded: `GO switch <dataset> <plan-id>`.
>
> **Commands.**
> ```bash
> bun run $T/github/switch.ts snapshot --repo nemarDatasets/$D --clone $W/clone --before $W/before.json --out $W/ruleset.json
> bun run $T/github/switch.ts switch --repo nemarDatasets/$D --clone $W/clone --snapshot $W/ruleset.json              # dry run
> bun run $T/github/switch.ts switch --repo nemarDatasets/$D --clone $W/clone --snapshot $W/ruleset.json --execute
> bun run $T/github/switch.ts check --repo nemarDatasets/$D --snapshot $W/ruleset.json
> git -C $W/clone fetch origin git-annex && git -C $W/clone annex merge && git -C $W/clone push origin git-annex
> ```
>
> **Words.**
> `snapshot` is never written over a file (`snapshot-exists`), and it refuses (exit 3, nothing written) on `remote-moved-since-clone (N ref(s))` (the remote's heads and tags are not exactly `before.json`'s `originTips`: someone pushed since the clone), `ruleset-already-lifted` (a tag ruleset, or a branch ruleset the pusher cannot bypass, is not `active`; `--accept-disabled` overrides, and the restore then restores it as it was), `before-invalid`, `unexpected-remote-head` (the remote has a head other than `main` and `git-annex`), `remote-only-tag` and `origin-mismatch`.
> `switch` also refuses `ruleset-not-in-snapshot`, `snapshot-other-repository`, `snapshot-invalid` and `remote-moved-since-clone`; read its plan line first.
> It reports `pushed refs/heads/main` and `pushed tag K of N` as each ref lands, then `restored N ruleset(s)`.
> A push that fails part way exits **1**: stderr says `switch: push failed: <class>` (`non-fast-forward`, which includes a stale lease, `hook-declined`, `auth`, `network`, `timeout`, `other`), then which branches and how many tags were and were not pushed, that the rulesets were restored, and that the remote may be half rewritten.
> Run `switch.ts check`, compare `git ls-remote` with `before.json`'s `originTips`, fix the cause, and run it again; the leases refuse to overwrite anything else.
> SIGINT, SIGTERM and SIGHUP restore the rulesets for the whole lift-push-restore window, print `switch: interrupted by <SIGNAL>; protection restored`, and exit 130, 143 or 129; a second signal during the restore prints `restore in progress` and is ignored.
> **If a ruleset could not be restored the exit is 5, and any exit while one may be lifted prints `RESTORE FAILED: run switch.ts restore --execute now`: do that at once, before anything else, and read `switch.ts check`.**
> The git-annex push is a normal push, never a force: the fetch and merge come first because the remote's branch can have moved, and step 14 reads the PUSHED branch.
> `git annex sync --no-content --only-annex` does the same.

### Step 10: Zarr serving copy (not locked)

```bash
bun run $T/s3/s3-scrub.ts zarr --dir $W                                   # dry run
bun run $T/s3/s3-scrub.ts zarr --dir $W --execute
```

The dry run reads every store root and every nested `zarr.json` and says how many need a scrub; `--execute` removes the subject and identifier members from each, writing a document back only if no one changed it since it was read (an ETag-conditional put), and re-reads every document to prove it clean.

**What a clean store means:** the data and events, the channel names, types and units, and the technical recording metadata, and nothing else.
The rule is one function for the stage, its re-read, its proof and the public check of step 16:

- Removed: every key the scanner calls an identifier and every member of the removal set (`EDF_MIRROR_MEMBERS`: `patientcode`, `birthdate`, `gender`, `patient_name`, `patient_additional`, `admincode`, `technician`, `equipment`, `recording_additional`), at any depth and in any spelling, when it holds something.
- Kept: every other member of `recording_metadata` (or `recording_info`) that is in the allow-list `KNOWN_BENIGN`, or is a key the scanner knows (`email` is kept: it is a review key, not removed), or is named with `--allow-member NAME` (repeatable, any spelling, letters and digits only, else `bad-allow-member`; recorded in `zarr-verified.json` as `allowedMembers`, which `zarr-public` applies too).
- Refused: anything else stops the run before any document is written (`unknown-recording-member`, exit 3, in the dry run too).
  The names, never values, go to `$W/zarr-unknown-members.json` with the number of documents per name, and stdout says `zarr: unknown-recording-member in N document(s), M distinct name(s); the names are in zarr-unknown-members.json`.
  Look at each name, ask the maintainer, and run again with `--allow-member`.

Every `zarr.json` inside a store (an array's or a nested group's) is read, cleaned and re-read too, at most `--max-zarr-json N` documents (default 20,000; more is refused before any is read, `too-many-zarr-json`, exit 3).
The stage also refuses to prove a prefix it cannot account for (objects but no store root, a `zarr.json` outside any store, a store without its root, a Zarr v2 metadata file, a byte order mark): exit 4, nothing proven.
A store that vanishes between the listing and its read is `HeadObject:not-found`, a failure (exit 1), never clean.
The output is `zarr: stores=S docs=D clean=.. scrubbed=.. unreadable=.. unknownMembers=.. failed=..` (`needScrub=` in the dry run) and, on success, `zarr: ok; every one of S store roots and D zarr.json documents is clean`.
From the census, nm000186's roots are expected to need a scrub (88) and the real run to remove 352 members; nested documents were not part of the census.
It writes `zarr-plan.json` (counts and a digest of the keys it read, no key) and `zarr-verified.json` (`stores`, `allowedMembers`, `counts`).
A dataset with nothing under `D/zarr/` is `found: no-zarr`, which `drop-archives` and `delete-old` do not accept once Zarr objects exist.
Run this step with `--execute` for every dataset, one without a Zarr copy too: `drop-archives` refuses without a `zarr-verified.json` for this plan, and for such a dataset the proof is the `no-zarr` one.

The noncurrent versions of every zarr object still hold the old metadata, and step 15b prunes them with `--prune-noncurrent $D/zarr/`.
Expect about one noncurrent version per document rewritten, so `delete-old --max-prune` must cover the store roots plus the nested documents rewritten (its dry run prints the exact number).

**Waiting for the edge.**
The stage writes to S3, not through `zarr.nemar.org`.
The dataset is private, so the Worker serves none of it, and a purge does nothing.
After step 16 an untokened `zarr.json` can still be served from the edge for at least 6 minutes, and a tokened one for up to a day (`max-age=86400, stale-while-revalidate=86400`), counted from the last time the dataset was public (these are the `Cache-Control` values the Worker sets; how the Workers Cache API treats `stale-while-revalidate` has not been measured here).
If the privacy flip was less than two days ago, check a store root through `https://zarr.nemar.org/$D/zarr/<store>/zarr.json` after step 16 as well; a non-browser GET of a store object is redirected to S3, so it tests S3, not the edge copy.
`attributes.nemar.source_commit` and the index's `source_commit` now name commits that no longer exist; that is not a privacy matter, remapping them is not built (ADR 0085), and the next reconversion of the dataset repairs them.

### Step 11: Archives, a read-only look

```bash
bun run $T/s3/s3-scrub.ts drop-archives --dir $W --confirm-dataset $D
```

This is the dry run: it prints `drop-archives: keys=.. versions=.. markers=..` and the `would delete` line, and deletes nothing.
Note the counts.
The archive holds the original recordings, so it must go, but not yet: step 15a does it, after the rewrite has been verified from outside the clone, because it cannot be undone.
The tool enforces that: it refuses until every proof of step 15a is in `$W` and names this plan, so here it is expected to exit 3 with `drop-archives: refused git-proof-stale: mode local, not fresh-clone` (step 14 has not run yet).
Any other refusal line names a proof to fix before step 15a: a missing `verified.json`, `new-hash-verified.json` or `zarr-verified.json`, or one made for another plan.

### Step 12: Regenerate every tag's manifest after the tags moved

Before the tags move, the job rebuilds the old manifest from the old tree.
The tag pushes of step 9 dispatch the version-DOI run for each moved tag, which dispatches the central manifest job, so manifests usually regenerate on their own.
Wait for those runs (`gh run list --repo nemarDatasets/.github --limit 30`), check each manifest as below, and dispatch by hand only a tag whose manifest still names an old key.
The manifest job regenerates `D/version/<tag>.json` and `<tag>-summary.json` (the summary is rebuilt from the scrubbed tree); `<tag>-records.json` is not regenerated by it.

A manual dispatch for a **private** dataset must carry `skip_canary: true`: the job's canary makes an unauthenticated request to `raw.githubusercontent.com`, which cannot serve a private repository.
The CLI's `nemar admin summary check --fix` does not pass it, so call the admin route's client with it, as the signed-in admin (the route answers 404 for a tag with no published version row):

```bash
for tag in $(jq -r '.tags[]' $W/plan.json); do
  bun -e "import { dispatchManifest } from './src/lib/api/admin'; console.log(await dispatchManifest('$D', '$tag', { skipCanary: true }))"
done
```

Then confirm that each `s3://nemar/$D/version/<tag>.json` names only new keys; the `comm` line prints nothing when it is right:

```bash
for tag in $(jq -r '.tags[]' $W/plan.json); do
  aws s3 cp "s3://nemar/$D/version/$tag.json" - | jq -r '.files | to_entries[] | select(.key | test("\\.(edf|bdf)$"; "i")) | .value.key' | LC_ALL=C sort -u > $W/manifest-$tag.keys
  jq -r 'keys[]' $W/keymap.json | LC_ALL=C sort | LC_ALL=C comm -12 - $W/manifest-$tag.keys
done
```

`delete-old` reads every current manifest itself and refuses while one names an old key (`manifest-names-old-key`) or a recording the scrub did not account for (`manifest-names-unplanned-key`).

### Step 13: Ledger

One line per action, appended to `$W/ledger.jsonl`, with the numbers read from the stages' own files:

```bash
ACTOR=$(gh api user --jq .login)
VERSIONS=$(jq -r '.tags | join(",")' $W/plan.json)
A="bun run $T/ledger-cli.ts append --file $W/ledger.jsonl --dataset $D --actor $ACTOR --versions $VERSIONS"
$A --action plan --counts keys=$(jq .totals.keys $W/plan.json),need_scrub=$(jq .totals.needScrub $W/plan.json) --verification plan-only
$A --action headers-scrubbed --counts objects=$(jq '.entries | length' $W/assembled.json),headers=$(jq .counts.headersChecked $W/verified.json) --verification scanner-clean+payload-identical+rehash-ok
$A --action files-removed --counts drop_paths=$(jq '.dropPaths | length' $W/git-plan.json),json_files_blanked=$(jq '.blankJsonKeys | length' $W/git-plan.json),provenance_entries_dropped=$(jq .provenanceEntriesDropped $W/git-plan.report.json) --verification scanner-clean
$A --action history-rewritten --counts refs=$(jq .counts.refs $W/git-verified.json),commits=$(jq .counts.commits $W/git-verified.json) --verification scanner-clean
$A --action locks-applied --counts objects=$(jq '.entries | length' $W/assembled.json) --verification none
$A --action manifests-regenerated --counts manifests=$(jq '.tags | length' $W/plan.json) --verification none
```

A ledger line holds counts and a closed vocabulary only: an action (`plan`, `headers-scrubbed`, `files-removed`, `history-rewritten`, `locks-applied`, `manifests-regenerated`, `old-versions-deleted`, `published-again`), versions as tags, counts as `name=number` with lowercase names, a verification from the closed list (`none`, `plan-only`, `scanner-clean`, `scanner-clean+payload-identical`, `scanner-clean+payload-identical+rehash-ok`, `public-surface-clean`, `authoritative-listing-empty`), a scanner revision and an actor handle.
The tool refuses any other text.
The words chosen above are this runbook's convention: the closed list has no word for a lock or a manifest check, so those two lines say `none`, and the proof files named in steps 5 and 12 are what verified them.
The scanner revision is the last commit that touched `shared/identifier-scan.ts`, `shared/identifier-scrub.ts` or `scripts/scrub/s3/zarr-json.ts`, unless `--scanner` is given.
`ledger-cli.ts show --file $W/ledger.jsonl` prints the file back, validating every line.

Commit the file as `.nemar/corrections.jsonl` on `main` (a normal push, not a force; if GitHub declines it, stop and ask, and never lift a ruleset by hand), and publish it:

```bash
mkdir -p $W/clone/.nemar && cp $W/ledger.jsonl $W/clone/.nemar/corrections.jsonl
git -C $W/clone add .nemar/corrections.jsonl && git -C $W/clone commit -m "Record the privacy correction" && git -C $W/clone push origin main
bun run $T/ledger-cli.ts publish --file $W/ledger.jsonl --dataset $D                 # dry run
bun run $T/ledger-cli.ts publish --file $W/ledger.jsonl --dataset $D --execute
```

`publish` copies the file to `s3://nemar/$D/corrections/ledger.jsonl`.
It treats only a genuine not-found (`NoSuchKey`) as "no ledger yet"; every other read failure refuses with `remote-ledger-unreadable (<Op>:<class>)` (`GetObject:access-denied`, `:unreachable`, `:failed`, `:timeout`), and a 403 is never absence, the dry run included.
It also refuses (exit 3) `remote-ledger-not-utf8`, `remote-ledger-partial-line`, `not-an-append` (anything but a strict extension of what is there), `ledger-empty`, `ledger-other-dataset`, and `remote-ledger-changed` (the conditional put was refused: someone wrote between the read and the put, their version stands; look, then run it again).
The put is conditional (`--if-none-match '*'` for a first publish, `--if-match <ETag read>` for an extension) and the bytes put are the bytes validated.
Exit 4 (`read-back-differs-after-write`, `read-back-failed-after-write (...)`) means written but not proven: look at the object now.
`--timeout-sec N` (default 120) bounds each `aws` call, and a transfer gets five times as long.
The change-log sentence is already in every version through the git plan.

### Step 14: Verify while still private

Admin reads, no public exposure.
Let the runs of step 9 finish first, so the clone sees the settled state.
Then clone the dataset fresh from GitHub and verify the pushed refs, not the local rewrite:

```bash
git clone https://github.com/nemarDatasets/$D $W/fresh
bun run $T/git/git-scrub.ts verify --fresh-clone --repo $W/fresh --keymap $W/keymap.json --plan $W/git-plan.json --s3-plan $W/plan.json
rm -rf $W/fresh
```

**`--fresh-clone` takes no `--before`** (a usage error, exit 2).
A fresh clone needs no `git annex init`: the pushed `git-annex` branch is read from `refs/remotes/origin/git-annex`.
It checks, over every ref: no old key anywhere; every EDF and BDF key is new or planned clean; no dropped path; JSON blanked and structural edits applied; appended text once at the end; the tag names equal the plan's `tags` (`tag-names-not-plan`); every commit that touches `.nemar/corrections.jsonl` touches nothing else (`ledger-commit-not-alone`), and the ledger at every head tip is valid for this dataset (`ledger-invalid`); and in the pushed `git-annex` branch, no old key is held anywhere (`annex-old-key-held`), every old key is dead (`annex-old-key-not-dead`) and every new key is recorded present (`annex-new-key-unregistered`; `annex-branch-missing` if the branch was not pushed).
It does not compare commit counts, tip paths or annex refs, so the ledger commit of step 13 is tolerated.
Exit 0 writes `$W/git-verified.json` in mode `fresh-clone` (overwriting step 7's), which steps 15a and 15b require, with this same `keymap.json` and `plan.json`.
Exit 4 prints `verify: FAIL reason=...` and removes any earlier proof.

Then read every regenerated manifest again (step 12's check).
`verify-new` (step 5) already hashed every new object.
The dataset stays private until the old bytes are gone, so there is no window in which an old key is publicly readable.

### Step 15: Drop the archives, then delete the old bytes

> **IRREVERSIBLE: step 15a, drop the archives**
>
> **What it destroys.**
> Every version and every delete marker of every key under `s3://nemar/$D/archives/`, by version id, with no bypass.
> The archive is a zip of the dataset's files as they were, original recordings included, and nothing can be patched inside a zip, so it is deleted and rebuilt from the scrubbed tree (step 16).
> The tool checks for itself that the scrub has been verified everywhere before the originals are lost (the list is under "It refuses unless"); the checks below are the ones it cannot make.
>
> **Preconditions you check by hand.**
> - The archive jobs that step 9's tag pushes dispatched have finished (`gh run list --repo nemarDatasets/.github --limit 30`), so none is built after the drop; a new archive built from the scrubbed tree is deleted here too, because the tool deletes every version.
> - The dry run of step 15b, run now with the flags it will run with (`--prune-noncurrent`, `--max-delete`, `--max-prune`), lists `archives-not-dropped` and no other refusal.
>   It evaluates every refusal, so anything else it names is something to fix while the originals still exist.
> - You have read step 11's counts, and the dry run below exits 0 with the same counts or ones you can explain (an archive job that ran since).
> - The maintainer's go is recorded: `GO drop-archives <dataset> <plan-id>`.
>
> **Commands.**
> ```bash
> bun run $T/s3/s3-scrub.ts drop-archives --dir $W --confirm-dataset $D                  # dry run
> bun run $T/s3/s3-scrub.ts drop-archives --dir $W --confirm-dataset $D --execute
> ```
> `--verified`, `--hash-verified` and `--git-verified` default to `verified.json`, `new-hash-verified.json` and `git-verified.json` in `$W`, as for step 15b.
>
> **It refuses unless** (all exit 3, all in the dry run, and every one that applies is listed, while the dry run still prints what it would delete):
> - the plan is complete and not partial, and `--confirm-dataset` matches (`plan-partial`, `plan-has-unreadable`, `confirm-dataset-mismatch`); these stop before anything else is read;
> - `assembled.json` exists, names this dataset and bucket, and holds only keys the plan marked for a scrub, each with a new key of its own (`assembled.json-missing`, `assembled-wrong-dataset`, `assembled-wrong-bucket`, `assembled-not-in-plan`, `duplicate-new-key`, `old-key-is-a-new-key`);
> - `verified.json` and `new-hash-verified.json` (step 5) exist, parse, and name the exact bytes of `assembled.json`, this dataset and its number of entries (`verified.json-missing`, `new-hash-verified.json-missing`, `verified.json-invalid`, `new-hash-verified.json-invalid`, `verified-stale`, `new-hash-verified-stale`, `proof-wrong-dataset`, `proof-count-mismatch`);
> - `git-verified.json` (step 14) exists, parses, is mode `fresh-clone`, and names this `keymap.json` and `plan.json`, and the keymap is this assembly's (`git-proof-missing`, `git-proof-invalid`, `git-proof-stale`, `keymap.json-missing`, `keymap-mismatch`);
> - `zarr-verified.json` (step 10) exists, parses, and names this `plan.json` and the `zarr-plan.json` beside it, and while Zarr objects are current it proves stores, not `no-zarr` (`zarr-not-scrubbed`, with the reason).
>
> These are step 15b's checks of the same files, with the same words, except that step 15b asks for the Zarr proof only while Zarr objects are current.
> A proof file that is there and cannot be read is `<name>-unreadable` (exit 1, a failure).
> The `zarr-public` check of step 16 runs after the dataset is public again and writes no proof, so it is not a precondition here.
>
> **Words.**
> It ends with an authoritative `ListObjectVersions` that must show nothing; otherwise it prints `drop-archives: FAILED, versions and markers remain` and exits 5, with no `archives-dropped.json`.
> A lock refusal is reported and fails the stage: archives carry no lock, so a refusal is news, and the lock is a person's to look at.
> An archive job can run after the drop (a tag push dispatches one), and `delete-old` refuses `archives-not-dropped` if any archive version or marker is there, so drop again after the jobs finish.

> **IRREVERSIBLE: step 15b, delete the old bytes**
>
> **What it destroys.**
> Every version and delete marker of every old key under `D/objects/`, by version id with the governance bypass (a locked object is the point), and the noncurrent versions under `D/version/` and `D/zarr/` that `--prune-noncurrent` names (no bypass).
> After it nothing NEMAR controls holds the original bytes, and `$W/original.bundle` can no longer restore a usable dataset.
>
> **Preconditions you check by hand.**
> The tool checks the proofs of steps 5, 10 and 14 and that step 15a is done (the list is under "It refuses unless"); these are left to you:
> - `$W/deleted.json` does not exist yet.
> - Nothing wrote to the dataset since the plan; the tool refuses anything it did not plan, but read the dry run.
> - The dry run's lines: `delete-old: keys=K versions=V markers=M planRecorded=R limit=L` and `delete-old: prune noncurrent versions=N markers=P`.
> - `--max-delete` is set to V+M (it can only lower the plan's own count, never raise it) and `--max-prune` to at least N+P (default 1000).
> - The maintainer's go is recorded: `GO delete-old <dataset> <plan-id>`.
>
> **Commands.** The dry run first, with every refusal evaluated:
> ```bash
> bun run $T/s3/s3-scrub.ts delete-old --dir $W --confirm-dataset $D --prune-noncurrent $D/version/ --prune-noncurrent $D/zarr/
> bun run $T/s3/s3-scrub.ts delete-old --dir $W --confirm-dataset $D --prune-noncurrent $D/version/ --prune-noncurrent $D/zarr/ --max-delete <V+M> --max-prune <N+P> --execute
> ```
> `--verified`, `--hash-verified` and `--git-verified` default to `verified.json`, `new-hash-verified.json` and `git-verified.json` in `$W`.
> A dry run evaluates every refusal and lists them all, so the dry run before step 15a shows everything that would stop this step: `archives-not-dropped` is the expected line then, and any other line is something to fix before the archives go.
> The working files are checked first, all of them (the proofs, `assembled.json`, `keymap.json` and the prune prefixes); if any of them refuses, the bucket is not read (`delete-old: the bucket was not read; its checks run once the working files agree`), and the bucket's checks are listed once the files agree.
> Nothing that clears a refusal of the working files is irreversible.
>
> **It refuses unless** (all exit 3, all in the dry run, and every one that applies is listed):
> - the plan is complete and not partial, and `--confirm-dataset` matches (`plan-partial`, `plan-has-unreadable`, `confirm-dataset-mismatch`); these stop before anything else is read;
> - both S3 proofs exist, parse, and name the exact bytes of `assembled.json` (`verified.json-missing`, `new-hash-verified.json-missing`, `verified-stale`, `new-hash-verified-stale`, `proof-wrong-dataset`, `proof-count-mismatch`), and `assembled.json` names this dataset and bucket (`assembled-wrong-dataset`, `assembled-wrong-bucket`);
> - the git proof exists, parses, is mode `fresh-clone`, and names this `keymap.json` and `plan.json` (`git-proof-missing`, `git-proof-invalid`, `git-proof-stale`), and the keymap is this assembly's (`keymap-mismatch`);
> - every current manifest names no old key and no recording the scrub did not account for (`manifest-names-old-key`, `manifest-names-unplanned-key`, `manifest-unreadable`, `no-manifests`);
> - every EDF and BDF under `D/objects/`, a version or a marker included, is a planned or an assembled key (`unplanned-recording`);
> - `D/archives/` holds no version or marker at all (`archives-not-dropped`);
> - while Zarr objects are current, `zarr-verified.json` exists, names stores, and belongs to this plan (`zarr-not-scrubbed`);
> - an anonymous `HEAD` of a new object, and of an old one while any remains, answers 403 (`dataset-is-public` on 200, `privacy-unproven` otherwise), and `--public-base` is the plan's bucket's own S3 endpoint over https (`bad-public-base`, exit 2);
> - every version of an old key is the size its key declares (`version-size-differs`) and one the plan recorded (`version-not-in-plan`: someone wrote to an old key after the plan, so stop and find out why);
> - the count is within `--max-delete` (`over-max-delete`) and the prune within `--max-prune` (`over-max-prune`);
> - every prefix with history (`D/version/`, `D/zarr/`) is named with `--prune-noncurrent` (`history-remains`, with the count per prefix), and a prune prefix is exactly `D/version/`, `D/archives/` or `D/zarr/` (`bad-prune-prefix`).
>
> **Words.**
> It ends with an authoritative `ListObjectVersions` showing zero versions and zero markers for every old key and no history under `D/archives/`, `D/version/` or `D/zarr/`; otherwise it exits 5 and writes no `deleted.json`.
> A re-run is safe and resumes: once the old keys are gone the new keys prove privacy, so a run that stopped at exit 5 is finished by running it again.
> `deleted.json` is removed at the start of every run, so a refused or failed run leaves none.
> An archive object that appears during the run is found by the final listing (exit 5, `history-remains`).

### Step 16: Screen from inside, make the dataset public again, then verify from outside

First the screen from inside.
The old keys are gone, so a new read-only plan, into a fresh directory, reads the header of every recording that remains with the scrub's own rule:

```bash
bun run $T/s3/s3-scrub.ts plan --dataset $D --out $W/post
```

Expect exit 0 with `needScrub=0 unreadable=0`: no recording header has anything left for the rule to change, and its key count equals step 1's (each scrubbed key was replaced by one new key, and each clean key stayed).
Anything else stops here, with the dataset still private.

> **IRREVERSIBLE: step 16, make the dataset public again**
>
> **What it exposes.**
> Everything now in the repository and the bucket, to everyone and to every cache and crawler.
> Making it private again stops new reads and recalls nothing already read.
>
> **Preconditions you check by hand.**
> - Step 15b finished: `$W/deleted.json` exists and the run ended `zero versions and zero markers remain`.
> - `$W/zarr-verified.json` exists for this plan (a `found: no-zarr` proof is fine when there is no Zarr copy).
> - Every earlier box has its go and its record, and the plan above said `needScrub=0 unreadable=0`.
> - The maintainer's go is recorded: `GO public <dataset> <plan-id>`.
>
> **Command.**
> ```bash
> nemar admin repo public $D
> ```
> It prompts for confirmation (`--yes` skips the prompt; use it only in a script).
> The visibility change takes a few minutes to settle, as the 2026-10-04 change to private did.
>
> **If anything below fails**, make it private again (`nemar admin repo private $D`) and stop: the new objects were verified twice, so the fault is in a manifest, a cache or a route, not in the bytes.

Wait a few minutes, then confirm with C6's two commands (the dataset's object must now answer 200).
Then the archive, which step 15a deleted along with every older version.
No command in this repository builds an archive for one dataset by hand: the Worker dispatches `generate-archive` after a version-DOI run (`triggerArchiveGeneration` in `backend/src/services/github/dispatch.ts`) and re-dispatches a failed one (`backend/src/services/archive-retry.ts`), and nothing re-dispatches a missing one.
So ask the maintainer to have it built from the scrubbed tree, and when it exists confirm that its zip hashes its own content.
This is not a privacy matter (the archive is built from the tree that is now clean), so it does not hold up the checks below.
Then, from outside:

```bash
bun run scripts/identifier-fleet-scan.ts --out $W/fleet --only $D --force
jq '{status, incomplete, edf_bdf: .files.edf_bdf, flagged: .edf_bdf_files_flagged, by_kind: .findings_by_kind}' $W/fleet/$D.json
```

The scan reads the public catalog, the data plane and public S3, with `--out` required and `--only` taking this one dataset.
It exits 2 for a usage error such as a dataset that is not public yet, and 3 if a server was struggling.
Expect no direct finding (`status` is not `direct-identifiers`), and never read `unchecked`, `incomplete` or `not-screened` as clean.
Then an anonymous download of one file per version, hashing to its new key, and the data plane's manifest naming only new keys:

```bash
DATA=https://data.nemar.org
for tag in $(jq -r '.tags[]' $W/plan.json); do
  curl -s "$DATA/$D/$tag/manifest.json" | jq -r '.[].url' > $W/public-urls-$tag.txt
  echo "$tag old keys named: $(jq -r 'keys[]' $W/keymap.json | grep -c -F -f - $W/public-urls-$tag.txt)"
  U=$(curl -s "$DATA/$D/$tag/manifest.json" | jq -r '[.[] | select(.path | test("\\.(edf|bdf)$"; "i"))] | min_by(.size) | .url')
  WANT=$(basename "${U%%\?*}" | sed -E 's/^SHA256E-s[0-9]+--([0-9a-f]{64}).*/\1/')
  GOT=$(curl -s "$U" | shasum -a 256 | cut -d' ' -f1)
  [ "$WANT" = "$GOT" ] && echo "$tag download ok" || echo "$tag DOWNLOAD DOES NOT MATCH ITS KEY"
done
```

Each tag must say `old keys named: 0` and `download ok`.
A manifest can lag by its cache (`max-age=60`), so repeat after a minute before concluding.

Then the Zarr copy, as an anonymous reader reads it:

```bash
bun run $T/s3/s3-scrub.ts zarr-public --dataset $D --zarr-verified $W/zarr-verified.json
```

It reads `zarr/index.json` and the root of every store in the union of the index's stores and the proof's, and exits 0 only when at least one store was read and every one is clean by the zarr stage's own rule, or the proof says `no-zarr` and the index names no store (so there is nothing to skip).
Its refusals are `store-not-in-index` (a store the zarr stage proved is not in the index), `zarr-verified-wrong-dataset`, `zarr-verified.json-missing` and `zarr-verified.json-invalid` (exit 3), and `index-unreadable` and `index-malformed` (exit 4); a store with an identifier or an unknown member is exit 1.
It reads store roots only, because an anonymous reader cannot list the nested documents.
Check one store root through `zarr.nemar.org` too if the privacy flip was recent (step 10).
Do step 17 only after all of this passes.

### Step 17: Afterwards

- Record the deletion and the republication in the ledger, then commit and publish it again as in step 13 (it is a strict extension):

  ```bash
  $A --action old-versions-deleted --proof $W/deleted.json
  $A --action published-again --counts manifests=$(jq '.tags | length' $W/plan.json) --verification public-surface-clean
  cp $W/ledger.jsonl $W/clone/.nemar/corrections.jsonl
  git -C $W/clone add .nemar/corrections.jsonl && git -C $W/clone commit -m "Record the deletion and republication" && git -C $W/clone push origin main
  bun run $T/ledger-cli.ts publish --file $W/ledger.jsonl --dataset $D --execute
  ```

  (`$A` is step 13's variable; in a new shell, set `ACTOR`, `VERSIONS` and `A` again.)
  `old-versions-deleted` is read, not typed: `--proof` must be `deleted.json` (parsed strictly), its counts (`keys`, `versions`, `markers`, `pruned_versions`, `pruned_markers`) are taken from it, `--counts` beside it is a usage error, and the verification is set to `authoritative-listing-empty+proof-<first 16 hex of the sha256 of deleted.json>` (`--verification` may be omitted or say `authoritative-listing-empty`; anything else is `verification-contradicts-proof`).
  Refusals: `proof-missing`, `proof-invalid`, `proof-wrong-dataset`, and `verification-needs-deletion` when `authoritative-listing-empty` is used with another action.
- Comment on the dataset issue in plain words and close it; tell the uploader and the authors, and the source archive for a mirror.
- Ask GitHub Support to clear cached views and pull-request refs.
- Other copies NEMAR controls: check whether a Zenodo backup deposit of this dataset exists (the version-DOI callback can create one from the tag's release archive); no tool here reads or changes Zenodo, so ask the maintainer.
  Check the Actions logs and artifacts of the central workflows that ran for this dataset for printed headers.
- Delete the working directory, the bundle and the local clones: `rm -rf $W`.

## If a stage is killed

A signal (Ctrl-C, `kill`, a dropped terminal) makes `s3-scrub.ts` and `ledger-cli.ts` kill their `aws` children, remove their private temp directory (which can hold raw original bytes mid-download) and exit 130 (SIGINT), 143 (SIGTERM) or 129 (SIGHUP).
A `kill -9` does none of that: then remove `$TMPDIR/scrub-s3-*` by hand.
What a signal cannot undo is in S3, and none of it shows in `list-object-versions`:

- **assemble**: an open multipart upload for each object in progress, created with the lock parameters and billed until aborted.
  The `assemble: open upload left by a failed create: key=... uploadId=...` lines name the ones a failed create left; find the rest with `aws s3api list-multipart-uploads --bucket nemar --prefix $D/objects/` and abort each with `aws s3api abort-multipart-upload --bucket nemar --key <Key> --upload-id <UploadId>`; confirm the listing is empty.
  A new object that was completed but never reached `assembled.json` is found and kept by a re-run, so run assemble again rather than deleting it.
- **canary**: up to three locked objects under the canary prefix (`probe.txt`, `multipart-source.bin`, `multipart.bin`, GOVERNANCE for one day), an open multipart upload (a failed abort prints `canary: abort-failed key=... uploadId=...`), and up to two unlocked versions of `conditional.json`.
  List with `aws s3api list-object-versions --bucket nemar --prefix <prefix>` and `list-multipart-uploads --prefix <prefix>`; delete each version by id (`--bypass-governance-retention` for the locked ones), abort each upload, and confirm both listings are empty.
- **zarr**, **drop-archives**, **delete-old**: some objects changed or deleted; each stage resumes on a re-run (delete-old proves privacy from the new keys once the old ones are gone).
- **hash stage**: `hashes.json` holds every key finished before the signal, and a `hashes.json.tmp` (keys only) may remain; a re-run resumes.
  A signal on the host kills the source commands with their process groups, so no `aws` child is left.
- **switch.ts**: it restores the rulesets and exits 130, 143 or 129; if it could not, it prints `RESTORE FAILED: run switch.ts restore --execute now`.
  A `kill -9` or a lost machine skips even that: run `switch.ts restore --repo nemarDatasets/$D --snapshot $W/ruleset.json --execute` at once, then `switch.ts check`.
  Which refs landed is `git ls-remote` against `before.json`'s `originTips`.

## Abort points and rollback

- Steps 0 to 6 change nothing but add new locked objects; abandoning leaves them, deleted later by version id with the bypass (the canary shows it works, and a failed canary is cleaned the same way).
  To abandon an assembly: list the versions of each new key in `assembled.json` with `aws s3api list-object-versions`, delete each with `--bypass-governance-retention`, then move `W` aside and plan again.
- Steps 7 and 8 are local and rewrite the clone in place (they prune the old objects from the clone); `$W/original.bundle` is the way back for the local state.
- Step 9 is the first change to the repository.
  Until step 15b the old S3 objects still exist, so the old tips can be pushed back from the bundle, by hand and untested: force-push the bundle's `main` and tags with the rulesets lifted, and restore the pushed `git-annex` branch the same way, because it already marks the old keys dead and retracts their holders (the alternative is to record each old key present at each holder again with `git annex setpresentkey KEY UUID 1`, with the holders read from the bundle's `git-annex` branch).
  Then regenerate the manifests from the restored tree with step 12's dispatch (`skip_canary: true` while private): a rolled-back dataset would otherwise serve the regenerated manifests, whose old versions survive as noncurrent versions until step 15b prunes `D/version/`.
  The tag pushes dispatch the version-DOI runs again, so watch them.
- Step 10 changes objects that are not locked; their old versions survive until step 15b prunes them, which is the only way back: copy the old version over the current object (`aws s3api copy-object` with `?versionId=` in the copy source), untested.
- Step 12 adds manifest versions; see step 9.
- Step 15a deletes every archive version outright; the way back is the rebuild of step 16.
- Step 15b has no rollback.
  Do it only after step 14 passes and the go is recorded, and keep `--max-delete` at the dry-run number.
  The new objects exist and are verified twice before it, so what it removes is only the old copies.
- Step 16 is undone for new reads only: make the dataset private again, and stop.

## Order of datasets

Start with the smallest confirmed one to prove the whole path, then nm000348 (156 GB of recordings across 5 tags, the reported one), then the rest by size.
Sizes (Sep 15 snapshot): nm000186 0.5 GB, nm000176 0.8 GB, nm000114 0.9 GB, nm000246 62.7 GB, nm000348 165 GB.
Read-only plans made on 2026-10-04: nm000186 has 3 tags and 176 keys (541 MB to hash); nm000348 has 5 tags and 525 keys (156.4 GB to hash); every key in both needs a scrub.
Those plan files predate `patchesSha256` and are refused by every later stage, so plan again.
The Zarr copy of nm000348 holds none of the removed members, and its zarr stage run is a clean proof with nothing to remove.
