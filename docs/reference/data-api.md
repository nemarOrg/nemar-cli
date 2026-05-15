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

File redirects also carry `Content-Length`, `Last-Modified` (the version's
publication timestamp in RFC 1123 format), and `ETag` (the content
checksum, quoted per RFC 7232 -- `"sha256:<hex>"` for git-annex files,
`"git:<sha>"` for inline git content). Clients that skip the HEAD step
can read the metadata from the redirect itself.

### `HEAD /<datasetId>/<version>/<bids-path>`

Returns `200` with `Content-Length`, `Last-Modified`, `ETag`, and
`Cache-Control: public, max-age=300` headers and an empty body. Used
by `rclone sync` and other HTTP-backend mirroring tools to detect
file changes without transferring the file body.

For directory paths, returns `200` with `Content-Type: text/html` and an
empty body.

For paths that don't exist in the requested version, returns `404` with
an empty body. The tombstone walk (used on GET to surface a `last_seen_*`
hint) is intentionally skipped on HEAD -- a sync against a divergent
local copy fans out many HEAD requests, and the per-HEAD walk would
amplify them into many S3 round-trips.

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

Dataset landing page. Content-negotiated: HTML for browsers, JSON for
machine clients (default when no `Accept` is sent). The query parameter
`?format=json` or `?format=html` overrides the `Accept` header.

JSON shape:

```json
{
  "dataset_id": "nm000103",
  "latest": "v1.0.0",
  "metadata_url": "/nm000103/metadata.json",
  "versions": [
    {
      "version": "v1.0.0",
      "doi": "10.82901/NEMAR.nm000103.v1.0.0",
      "created_at": "2025-12-01T10:00:00Z",
      "manifest_url": "/nm000103/v1.0.0/manifest.json",
      "browse_url": "/nm000103/v1.0.0/"
    }
  ]
}
```

Versions are newest-first. `latest` is `null` when the dataset row exists
but no version has been minted yet (the page still returns `200`, with
a "no published versions yet" notice in the HTML form).

HTML rendering lists every version with its DOI, publication date, browse
URL, and manifest URL.

`Cache-Control: public, max-age=60`.

### `GET /<datasetId>/<version>`

`308 Permanent Redirect` to `/<datasetId>/<version>/` so the relative `../`
link in the rendered index resolves correctly.

## Versioned UX

### Version picker

HTML directory listings include a version picker above the file table
when the dataset has more than one published version. Each version is
rendered as a sibling link that switches the version segment of the
current URL while preserving the sub-path -- so switching versions on a
deeply-nested directory lands on the same directory in the chosen
version (or a tombstone 404, see below, if the path doesn't exist
there).

### File-removed tombstones

When a file path 404s but the same path existed in an older published
version, the response indicates the last version that contained it.

JSON shape:

```json
{
  "error": "File not found",
  "reason": "removed",
  "last_seen_version": "v1.0.0",
  "last_seen_url": "https://data.nemar.org/nm000103/v1.0.0/sub-99/eeg/sub-99_task-rest_eeg.edf"
}
```

A 404 without a tombstone (no `reason` field) means the path never
existed in any of the most recent versions.

The tombstone walk is capped at the **10 most recent older versions**.
Older datasets can still be browsed manually from `/<datasetId>/` --
the cap exists so a 404 on a long-removed path never fans out to
dozens of manifest fetches. If a determined client needs deeper
history, fetch `/<datasetId>/metadata.json` for the full version list
and walk it explicitly.

The HTML form of the same 404 (sent when `Accept: text/html`) renders
a friendly page with a clickable link to the last-seen URL.

### "Files removed since vN-1" footer

Directory index pages compare their listing against the immediately
prior published version. Names that existed in the prior version but
are absent in the current one are rendered in a collapsible
`<details>` footer with links to the prior version's URL. The
comparison is only against `vN-1`; older versions are not consulted
(use `metadata.json` for full history).

## Response codes

| Code | When |
| --- | --- |
| `200` | Manifest JSON, HTML index, dataset landing page (HTML or JSON), HEAD on existing file or directory |
| `302` | GET on a file path that resolves to backing-store bytes |
| `308` | `/<datasetId>/<version>` -> `/<datasetId>/<version>/` |
| `404` | Dataset not found, private, unpublished, version not minted, file not in manifest, path traversal attempt. Includes `reason: "removed"` + `last_seen_*` when the path existed in a recent prior version (GET only; HEAD returns bare 404) |

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
- rclone-compatible delta sync. Phase 4 (#498), optional.
