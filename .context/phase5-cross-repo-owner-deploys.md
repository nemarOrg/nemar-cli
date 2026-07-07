# Phase 5 cross-repo owner deploys (epic #923)

These changes live in the **`nemarDatasets/.github`** repo (the central-workflow repo) and in
prod infra, NOT in nemar-cli. Phase 5 in nemar-cli only adds the dispatch payload fields and the
config-gated forwarder; the workflows that CONSUME them must be updated by the owner. All are
backward-compatible: each new field is optional and the workflows default to the current prod
behavior when it is absent, so they can be deployed before or after the nemar-cli merge.

## 1. Central workflows read `s3_bucket` (required for the dev-bucket split)

nemar-cli now sends `s3_bucket` in the `client_payload` of `generate-manifest`, `generate-archive`,
and `generate-zarr` (`backend/src/services/github/dispatch.ts`), sourced from the worker's
`S3_BUCKET` (prod `nemar`, dev `nemar-dev`). The corresponding workflows in `nemarDatasets/.github`
currently hardcode `s3://nemar`. Update each to:

```yaml
env:
  S3_BUCKET: ${{ github.event.client_payload.s3_bucket || 'nemar' }}
```

and replace every hardcoded `s3://nemar/...` / `--bucket nemar` with `s3://${S3_BUCKET}/...`. Affected
workflows: `run-generate-manifest.yml` (required — without it, dev manifests land in the prod
bucket), `run-generate-archive.yml`, `run-generate-zarr.yml`.

## 2. Workflows read `callback_base_url` (staging callbacks hit the dev worker)

`generate-archive` / `generate-zarr` now also receive `callback_base_url` (the worker's
`API_BASE_URL`; prod `https://api.nemar.org`, dev `https://api-test.nemar.org`). Build their POST-back
URLs from it instead of a hardcoded host:

```yaml
CALLBACK_BASE="${{ github.event.client_payload.callback_base_url || 'https://api.nemar.org' }}"
# ...POST "$CALLBACK_BASE/webhooks/archive-ready" (or /webhooks/zarr-ready)
```

(`generate-manifest` already receives a fully-built `callback_url` from nemar-cli, so it needs no
`callback_base_url` change.)

## 3. `emit_manifest.py` — parameterize `DATA_NEMAR_BASE` (Phase 4 comment-review follow-up)

`nemarDatasets/.github` `scripts/emit_manifest.py` hardcodes `DATA_NEMAR_BASE = "https://data.nemar.org"`
in the git-committed raw manifest's `bytes_url`. Phase 4 parameterized the *served* `bytes_url`
(`DATA_BASE_URL` -> `data-test.nemar.org` on staging), so for staging exemplars the two now disagree.
Make `emit_manifest.py` read an override with the prod default:

```python
DATA_NEMAR_BASE = os.environ.get("DATA_NEMAR_BASE", "https://data.nemar.org")
```

and have `run-generate-manifest.yml` pass `DATA_NEMAR_BASE` from a new
`client_payload.data_base_url` (add it to `triggerManifestGeneration` alongside `s3_bucket` when this
is deployed) so the raw and served `bytes_url` match on staging. Prod leaves it unset -> byte-identical.

## 4. `onboard-openneuro.yml` — parameterize the hardcoded webhook host (low urgency)

`onboard-openneuro.yml` has five hardcoded `https://api.nemar.org/webhooks/import-state` literals.
Replace with `${{ github.event.client_payload.callback_base_url || 'https://api.nemar.org' }}` so a
dev-worker-dispatched onboarding calls back to the dev worker. Low urgency (staging exemplars use the
clone tool, not OpenNeuro onboarding), but worth folding into the same pass.

## Deploy order

Deploy 1 + 2 before pointing the dev worker at the exemplar fleet (else dev manifests/archives/zarr
write to the prod bucket / call back to the prod worker). 3 + 4 can follow. None affect prod: absent
fields -> prod defaults.
