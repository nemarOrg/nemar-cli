# ADR 0141: The dispatcher stages the serving index, and the launch specification is version 2

**Status:** accepted
**Date:** 2026-11-25
**Accepted:** 2026-11-27
**Owner:** Seyed Yahya Shirazi

Completed by nemarOrg/nemar-process#98 on nemar-process `dev` (the launcher's part, decision 5), with nemarOrg/nemar-cli#2412 and nemarOrg/nemar-cli#2439 on `dev`.

Refines [ADR 0140](0140-a-run-handed-the-serving-index-names-it-in-its-derivative-key.md) decision 3 and [ADR 0118](0118-the-compute-gateway-records-every-tenant-job-and-keeps-the-ledger-in-expanse-service-units.md) where it fixes the launch specification `nemar.launch-spec.v1`.
Every key ADR 0140 defines keeps its bytes.

Refined by [ADR 0143](0143-every-worker-dispatched-run-of-the-archive-is-handed-its-tags-commit-or-waits-for-it.md) (2026-11-27), which also supersedes the last clause of ADR 0121 decision 10: every Worker-dispatched run of the archive is handed its tag's commit, staged index or not, and the tag is read before the index; a GitHub fault reading it defers the run without end and an absent tag refuses it, so decision 3's deferral covers the index's own faults only.

Decision 2 is superseded in part by [ADR 0144](0144-a-serving-index-ahead-of-its-tag-by-nemars-own-metadata-is-staged-as-the-tags.md) (2026-11-27): an index whose commit is ahead of the tag's by NEMAR-owned metadata only (`.nemar/`, `.github/`, and a `.gitattributes` edit that cannot change checkout bytes) is staged as the tag's, its own commit recorded as provenance, and the run is still handed the tag's commit; any other commit is refused with a word that says why.

## Context

A run of nemar-ica on the archive copy (`--input bids`) declares the views of the serving copy only when it is handed the serving copy's index as a file (`--serving-index`), together with `--dataset-id` and `--source-commit`, and it uses a row of the index only when the index's `source_commit` is exactly the run's `--source-commit` (nemarOrg/nemar-process#95).
The run's network fence admits no host, so the job cannot fetch the index itself.
ADR 0140 keyed such a run by the index's digest, but nothing the platform held recorded which index a run was handed, so a run that named one was not keyed (`serving_index_unattested`).

The launch specification is the one document the Worker hands the launcher.
Its root is closed (`additionalProperties: false`), and the launcher validates it against its copy of the schema and refuses an unknown member as `invalid_spec` (`launcher/nemar_launch/spec.py`).
A launcher that reads version 1 would therefore refuse a specification that carries a new member, however optional.

## Decision

1. **The launch specification is `nemar.launch-spec.v2`.**
   Version 2 adds one optional member, `serving_index: {sha256, size}`, and its route's answer `serving_index_response` (open, like the bundle's); nothing else changes.
   Every version 1 document is a version 2 document with the same bytes, so the golden vectors and every job without the member are unchanged.
   The schema stays one file shared byte for byte (`shared/contract/compute-launch.schema.json`, copied to nemar-process as `launcher/schema/launch-spec.v2.json`).
   The Worker writes the member only for a job of a recipe that keys the serving index on the archive input (`RECIPES_KEYING_SERVING_INDEX`), which runs on Tapis only; no launcher that reads version 1 was ever registered with a tenant (`deploy/tapis/released-versions.json` is empty), and a runner, which may hold one, is never handed the member.
   A launcher that reads version 1 must not be registered for such a recipe.
2. **The dispatcher stages the index exactly, or not at all.**
   At dispatch of such a job, before the claim, the Worker reads `<id>/zarr/index.json` and the commit of the version's tag.
   It stages the index only when the index's `source_commit` is exactly that commit; an index built from any other commit is refused (`source_commit_differs`), including one that differs from the tag by metadata only: the Zarr input's `metadata_only` allowance is never asked for.
   The exact bytes are kept in the records bucket under `serving-index/<sha256>.json`, written before the job exists, so a specification never names bytes that are not kept.
3. **A fault defers the run; anything else runs without the index** (amended 2026-11-25, owner ruling).
   When GitHub or the index cannot be read, or the copy cannot be kept (`github_unreadable`, `index_unreadable` including an S3 throw or a 403 on a ready copy, `token_mint_failed`, `no_github_credentials`, `index_not_stored`), the run is not dispatched.
   The deferral is a `refused` stamp with the word `serving_index_deferred`, which holds no slot, never counts toward the cooldown or the cap and is left out of the grid, so the dataset stays a candidate and later dispatch passes try again; no migration is needed.
   The dispatch answers `serving_index_deferred` (503) with the fault's word and `runs_without_index_after`, the time the run goes ahead without the index; its sentence says the stamp is a deferral, not a failure.
   A 403 from S3 is read with the dataset row, because the Worker's credentials lack `s3:ListBucket` and a missing object answers 403 too: a copy that is not `ready`, or has no store, is `no_index` and runs at once; a `ready` copy with stores is a fault (`index_unreadable`) and defers. Granting `s3:ListBucket`, which would make a missing object answer 404, is the owner's infrastructure change.
   Twenty-four hours after the run's first deferral (measured from the oldest deferred stamp newer than the tuple's newest stamp of any other kind), a fault dispatches the run without the index, and the specification records the fault's word.
   When the index is absent, built from another commit, too large or one the recipe cannot use (`no_index`, `source_commit_differs`, `tag_absent`, `index_too_large`, `index_unusable`, `index_commit_unusable`), the run is dispatched at once without one, and its specification records the word (`SERVING_INDEX_ABSENT_REASONS` in `shared/contract/compute.ts`).
   The run then declares no view of the serving copy.
   An index is usable only when it is strict JSON (UTF-8, no byte order mark, no repeated member name: `readIJson`) and has the shape the recipe checks before it reads one (nemar-process `zarr_input.validate_document`: `stores`, `store_count`, and each store's paths and each group's name, modality, rate and counts); the recipe, handed an index it cannot use, skips the views of the serving copy with `serving_index_unusable` rather than ending the run, so the defense holds on both sides.
4. **The job's specification records what was staged.**
   A recipe job's `serving_index` is `{sha256, size}` or `{reason}`; a job that is not a recipe's is refused the field.
   With a staged index the arguments add `--serving-index /data/serving-index/index.json --source-commit <the tag's commit>` after the archive's own (which already name `--dataset-id`).
5. **The launcher fetches the copy as it fetches the bundle.**
   `POST <api_base>/compute/jobs/<id>/serving-index` with the job token answers a ten-minute presigned GET of the copy the job's RECORDED specification names, and nothing the request carries; every other job is answered with the door's one refusal.
   The launcher downloads it before the network fence, checks its size and SHA-256, and binds its directory read-only at `/data/serving-index`; a dataset id cannot be that name.
   A failure ends the job `dataset_fetch_failed` before the container runs, with `serving_index_mismatch`, a platform detail, for a size or digest that differs.
6. **The derivative key reads the record of what was staged.**
   This replaces ADR 0140 decision 3.
   A recorded `{sha256, size}` is keyed `sha256:<hex>`, and the arguments must hand the run that copy (`--serving-index` once, at the path of decision 4).
   A recorded word, or no record, is keyed `none`, and the arguments must name no index.
   Anything else is not keyed (`serving_index_unattested`).

## Consequences

- A run staged with an index and a run staged without one now have different keys and both are stored, so `serving_index_unattested` no longer applies to a run the platform staged.
- nemar-ica stayed a placeholder that no path dispatched until that was lifted (amended 2026-11-27), so until then no index was staged and no job carried the member; since then an administrator's run dispatches it on Tapis, and the daily dispatcher still never does (`autoDispatch` is false).
  Amended 2026-11-27 (portable compute card Q1z): `nemar-ica` now also runs on a runner over the Zarr serving copy, where no index is staged.
- The kept copies are content-addressed and shared by every job of one index; `serving-index/` is outside a job's own records prefix and outside the records' lock and retention rules, so per-job retention does not delete them, and none is swept today. A future sweep must never remove a copy that a live job's recorded specification names.
- The launcher's `provenance.json` does not name the index, and the binding is indirect: the provenance's `launch_spec_digest` is the digest of the launch specification that carried `serving_index`, the Worker checks it against the digest it stored before submitting, and the derivative key reads the same digest from the job's recorded specification. That binds the digest the launcher was handed, not proof that the launcher checked the file: the check is the launcher's code (a size or digest that differs ends the job `serving_index_mismatch`), and nothing the run returns attests that it ran.
- nemar-process copies the schema under its new name and bumps its pin; its launcher validates version 2.

## Alternatives considered

- **Add the member under version 1:** a launcher that reads version 1 refuses it, so the name would stand for two contracts.
- **Write the copy under the job's own records after the job exists:** the job would name bytes that might never land, and a failed write would leave a job that can only fail at the launcher.
- **Accept an index of a metadata-only commit:** the recipe would refuse its rows (`serving_index_stale`), so the run would carry an index it cannot use.
- **Refuse the run when no index can be staged:** the archive run is useful without the views of the serving copy, and refusing it would make the views a condition of every result.

## Receipts

- nemar-cli #2324 (phase B2b) and #2383 ("Next: B2b"); nemarOrg/nemar-process#65 and #95.
- `shared/contract/compute-launch.schema.json`, `shared/contract/compute-launch.ts`, `shared/contract/compute.ts`, `backend/src/services/serving-index-staging.ts`, `backend/src/routes/callbacks/compute-job-callbacks.ts`, `backend/src/services/compute-derivatives.ts`.
