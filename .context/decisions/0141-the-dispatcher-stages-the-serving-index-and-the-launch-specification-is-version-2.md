# ADR 0141: The dispatcher stages the serving index, and the launch specification is version 2

**Status:** proposed
**Date:** 2026-11-25
**Owner:** Seyed Yahya Shirazi

Refines [ADR 0140](0140-a-run-handed-the-serving-index-names-it-in-its-derivative-key.md) decision 3 and [ADR 0118](0118-the-compute-gateway-records-every-tenant-job-and-keeps-the-ledger-in-expanse-service-units.md) where it fixes the launch specification `nemar.launch-spec.v1`.
Every key ADR 0140 defines keeps its bytes.

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
3. **Staging never refuses a run.**
   With no index, an index that cannot be read, a tag that cannot be read, or an index of another commit, the job is dispatched without one, and its specification records the word (`SERVING_INDEX_ABSENT_REASONS` in `shared/contract/compute.ts`).
   The run then declares no view of the serving copy, as before this decision.
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
- nemar-ica stays a placeholder: no path dispatches it until the owner lifts that, so no index has been staged and no job has carried the member.
- The kept copies are content-addressed and shared by every job of one index; they are outside a job's own records prefix, so per-job retention does not delete them.
- nemar-process copies the schema under its new name and bumps its pin; its launcher validates version 2.

## Alternatives considered

- **Add the member under version 1:** a launcher that reads version 1 refuses it, so the name would stand for two contracts.
- **Write the copy under the job's own records after the job exists:** the job would name bytes that might never land, and a failed write would leave a job that can only fail at the launcher.
- **Accept an index of a metadata-only commit:** the recipe would refuse its rows (`serving_index_stale`), so the run would carry an index it cannot use.
- **Refuse the run when no index can be staged:** the archive run is useful without the views of the serving copy, and refusing it would make the views a condition of every result.

## Receipts

- nemar-cli #2324 (phase B2b) and #2383 ("Next: B2b"); nemarOrg/nemar-process#65 and #95.
- `shared/contract/compute-launch.schema.json`, `shared/contract/compute-launch.ts`, `shared/contract/compute.ts`, `backend/src/services/serving-index-staging.ts`, `backend/src/routes/callbacks/compute-job-callbacks.ts`, `backend/src/services/compute-derivatives.ts`.
