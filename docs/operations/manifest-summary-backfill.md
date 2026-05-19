# Manifest summary.json backfill

Backfill the compact `summary.json` artifact for datasets that were
published before the central manifest-generation workflow started emitting
it (issue #558, epic #559). Specifically: the five datasets recovered
manually on 2026-05-18: `nm000103`, `nm000106`, `nm000166`, `on004362`,
`on005261`.

`scripts/backfill-summaries.sh` is a thin dispatcher around
`gh workflow run`. It triggers `generate-manifest.yml` (the central
workflow on `nemarDatasets/.github`) once per dataset with the recorded
version + DOI + concept DOI as inputs. The workflow walks the dataset's
git tree at the version tag, builds both `manifest.json` and
`summary.json`, and uploads them to
`s3://nemar/<id>/version/v<X.Y.Z>{,-summary}.json`. The dispatcher waits
30 seconds between dispatches so we don't hammer the central workflow.
Re-running the script just overwrites the S3 objects; safe to retry.

## Prerequisites

1. `generate-manifest.yml` is deployed at `nemarDatasets/.github` main
   and exposes a `workflow_dispatch` trigger with inputs `dataset_id`,
   `version`, `doi`, `concept_doi`.
2. Org-level secrets at `nemarDatasets` (visibility: all repos):
   `NEMAR_APP_ID`, `NEMAR_APP_PRIVATE_KEY`, `AWS_ACCESS_KEY_ID`,
   `AWS_SECRET_ACCESS_KEY`, `MANIFEST_CALLBACK_SECRET` (see
   `.context/epic_central_manifest_state.md` for the ops sequence).
3. Local `gh` CLI authenticated with `workflow:write` on
   `nemarDatasets/.github`. Check with `gh auth status`.

## Run

```sh
# Print the dispatch commands without firing.
./scripts/backfill-summaries.sh --dry-run

# Fire for real (5 dispatches, ~2 minutes wall time).
./scripts/backfill-summaries.sh
```

Watch progress with `gh run list --repo nemarDatasets/.github --workflow generate-manifest.yml`.

## Verify

For each dataset, fetch the new summary through the public route added in
this PR (Stream C):

```sh
curl -s https://data.nemar.org/nm000103/2.0.0/summary.json | jq .totals
# { "files": <int>, "bytes": <int>, "subjects": <int> }
```

A non-empty `.totals` block plus `.modalities`, `.subjects`, `.paths`
matching the dataset shape means the backfill landed. If the request
returns 404 `{"error":"Summary not found for this version"}`, the
workflow either has not finished, failed, or never dispatched. Drop the
edge cache by reissuing the request (60s negative cache) and check the
workflow run for errors.
