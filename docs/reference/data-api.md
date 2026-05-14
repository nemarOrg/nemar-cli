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
- Metadata enrichment (authors, modalities, MeSH, DOI). Phase 2 (#496)
  adds `metadata.json` next to `manifest.json`.
- Tombstones for files removed between versions. Phase 3 (#497).
- rclone-compatible delta sync. Phase 4 (#498), optional.
