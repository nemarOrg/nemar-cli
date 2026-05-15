# Data API: `data.nemar.org`

Public HTTPS access to every **published** NEMAR dataset, BIDS-shaped. No
nemar-cli, no git-annex, no NEMAR account.

The same handlers are reachable at three URL forms (pick whichever is most
convenient for your client):

```
https://data.nemar.org/<datasetId>/<version>/<path>          # canonical
https://api.nemar.org/data/<datasetId>/<version>/<path>      # API-hostname alias
https://<workers-dev-host>/data/<datasetId>/<version>/<path> # dev/testing
```

This document describes the canonical form.

## URL grammar

```
/<datasetId>/<version>/<path>
```

- `<datasetId>` -- one of `nm`, `xx`, `on` followed by six digits (e.g. `nm000103`).
- `<version>` -- `latest` or an explicit `vX.Y.Z` tag.
  `latest` resolves to the most recently DOI'd version recorded in the catalog.
- `<path>` -- BIDS-relative file or directory path. Trailing slashes accepted.
  Path traversal segments (`..`, absolute paths) return 404.

## Endpoints

### `GET /<datasetId>/<version>/<bids-path>`

If `<bids-path>` matches a file in the version manifest, responds `302 Found`
with the `Location` header pointing at the file bytes. Two backends:

- Git-annex content (large blobs): presigned S3 GET URL, valid for 1 hour.
- Inline git content (small files like `dataset_description.json`): a
  `raw.githubusercontent.com` URL pinned to the version tag.

If `<bids-path>` is a directory (i.e. one or more manifest entries start with
`<bids-path>/`), responds `200 OK` with an Apache-style HTML directory
listing.

If neither, responds `404`.

`Cache-Control: public, max-age=300` on file redirects, `max-age=60` on HTML
indexes.

### `GET /<datasetId>/<version>/manifest.json`

Responds `200` with a JSON array describing every file in the requested
version:

```json
[
  {
    "path": "dataset_description.json",
    "size": 480,
    "checksum_algorithm": "git",
    "checksum": "abc123...",
    "url": "https://raw.githubusercontent.com/nemarDatasets/nm000103/v1.0.0/dataset_description.json"
  },
  {
    "path": "sub-01/eeg/sub-01_task-rest_eeg.edf",
    "size": 12345678,
    "checksum_algorithm": "sha256",
    "checksum": "deadbeef...",
    "url": "https://nemar.s3.us-east-2.amazonaws.com/nm000103/objects/SHA256E-s12345678--deadbeef.edf?X-Amz-..."
  }
]
```

`checksum_algorithm` is `sha256` (default for annex-backed files), `md5` when
the dataset uses an MD5E backend, or `git` for files stored directly in the
git tree (where the `checksum` is the blob SHA, not a content hash).

URLs are pre-signed for 1 hour. Fetch the manifest immediately before a bulk
download to keep the URLs fresh.

### `GET /<datasetId>/metadata.json`

Dataset-level [neuroschema](https://github.com/nemarOrg/neuroschema) v0.3.0
`dataset` document combining the enrichment catalog (authors, MeSH keywords,
license, DOI, etc.), the full version list, and a derived BIDS subject /
session / modality / task / run tree from the **latest** version's manifest.
Designed for external indexers like
[eegdash-viewer](https://eegdash.github.io/eegdash-viewer/) that need to
resolve `dataset -> subjects/tasks/runs -> files` in one fetch.

Wire format mirrors the core schema at
`neuroschema/schema/core/dataset.schema.json`. NEMAR-specific aggregates
(version list, derived BIDS index, pipeline stage) live under
`extensions.nemar` per `neuroschema/schema/extensions/nemar.schema.json`.

```json
{
  "schema_version": "0.3.0",
  "doc_type": "dataset",
  "dataset_id": "nm000103",
  "name": "...",
  "description": "...",
  "source": "nemar",
  "recording_modality": ["EEG"],
  "license": "CC0-1.0",
  "authors": [
    {
      "name": "Doe, Jane",
      "name_type": "Personal",
      "orcid": "https://orcid.org/0000-0001-2345-6789",
      "affiliations": [{ "name": "Acme University", "identifier": "https://ror.org/...", "scheme": "ROR" }]
    }
  ],
  "keywords": [
    { "term": "Electroencephalography", "subject_scheme": "MeSH", "classification_code": "D004569" }
  ],
  "related_identifiers": [...],
  "contributors": [...],
  "dates": [...],
  "rights": [...],
  "funding": [...],
  "tasks": ["rest", "go-nogo"],
  "datatypes": ["eeg"],
  "sessions": ["baseline"],
  "sessions_count": 1,
  "demographics": { "subjects_count": 50, "age_min": 18, "age_max": 65 },
  "data_summary": { "total_files": 1234, "size_bytes": 1234567890, "size_human": "1.15 GB" },
  "provenance": { "latest_snapshot": "1.0.0", "publish_date": "2025-12-01T10:00:00Z" },
  "external_links": {
    "dataset_doi": "10.82901/NEMAR.nm000103",
    "github_url": "https://github.com/nemarDatasets/nm000103"
  },
  "extensions": {
    "nemar": {
      "versions": [
        {
          "version": "1.0.0",
          "doi": "10.82901/NEMAR.nm000103.v1.0.0",
          "created_at": "2025-12-01T10:00:00Z",
          "manifest_url": "/nm000103/v1.0.0/manifest.json"
        }
      ],
      "bids_index": {
        "version": "1.0.0",
        "subjects": {
          "sub-01": {
            "sessions": ["baseline"],
            "modalities": {
              "eeg": { "tasks": { "rest": { "runs": ["01", "02"] } } }
            }
          }
        }
      },
      "pipeline_stage": "validated"
    }
  }
}
```

**Partial payloads, never 500s.** When the metadata pipeline hasn't run
yet, enrichment-derived fields (`authors`, `keywords`, `license`,
`related_identifiers`, etc.) are returned as empty arrays or `null`. When
no versions are minted yet, `extensions.nemar.versions` is `[]` and
`bids_index` is `null`. When the latest version's manifest cannot be
fetched, `bids_index` is `null` but the catalog and version list still
return normally. Corrupt `enrichment_json` is logged and treated as
missing.

`bids_index` reflects only the **latest** version. A per-version index
endpoint at `/<datasetId>/<version>/index.json` may follow in a later
phase.

`Cache-Control: public, max-age=60`.

### `GET /<datasetId>` and `GET /<datasetId>/`

Phase 1 placeholder that points the caller at `latest/` and `latest/manifest.json`.
A full version listing arrives in epic #449 phase 3 (#497).

### `GET /<datasetId>/<version>`

`308 Permanent Redirect` to `/<datasetId>/<version>/` so the relative `../`
link in the rendered index resolves correctly.

## Response codes

| Code | When |
| --- | --- |
| `200` | Manifest JSON, HTML index, or `<datasetId>` placeholder |
| `302` | File path that resolves to backing-store bytes |
| `308` | `/<datasetId>/<version>` -> `/<datasetId>/<version>/` |
| `404` | Dataset not found, private, unpublished, version not minted, file not in manifest, path traversal attempt |

The route deliberately does not distinguish "not found" from "exists but
private". Private datasets are reached only via the existing
`nemar dataset clone` / `nemar dataset get` flow.

## MIME types

Files are served from S3 under their git-annex content-addressed key
(`SHA256E-s12345--...edf`), so the S3 object's `Content-Type` defaults to
`application/octet-stream`. Browsers will download rather than render. A
future iteration may override `response-content-type` in the presigned URL
based on the BIDS path's extension; until then, expect generic binary
content-type on file responses.

## What this does not cover

- Private and unpublished datasets. They stay on git-annex.
- Tombstones for files removed between versions. Phase 3 (#497).
- rclone-compatible delta sync. Phase 4 (#498), optional.
