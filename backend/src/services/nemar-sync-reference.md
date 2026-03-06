# nemar.org Datapipeline API Reference

Reference copy of the API contract used by `cdesyoun/nemar-hosting-data-sync` (PHP script).
Saved here in case the upstream repository becomes unavailable.

**Upstream:** https://github.com/cdesyoun/nemar-hosting-data-sync
**Retrieved:** 2026-03-05

## API Endpoints

Base URL: `https://nemar.org/api/dataexplorer/datapipeline`

### POST /token -- Get Access Token

Request:
```json
{"username": "<username>", "password": "<password>"}
```

Response:
```json
{"nemar_access_token": "<jwt>"}
```

Note: Some API versions return `access_token` instead of `nemar_access_token`. Handle both.

### POST / -- Insert Record

Request:
```json
{
  "nemar_access_token": "<jwt>",
  "table_name": "<table_name>",
  "entry": { ... field-value pairs ... }
}
```

### DELETE /delete -- Delete Records

Note: Uses HTTP DELETE method (not POST). The PHP script docs say POST but the API rejects POST.

Request:
```json
{
  "nemar_access_token": "<jwt>",
  "table_name": "<table_name>",
  "dataset_id": "<dataset_id>"
}
```

## Database Tables

### 1. dataexplorer_dataset (30 fields)

| Field | Type | Notes |
|---|---|---|
| id | string | Dataset ID, e.g., "nm000103" |
| created | string | YYYY-MM-DD HH:MM:SS |
| uploader | string | Username of uploader |
| latestSnapshot | string | Version, e.g., "1.0.0" |
| name | string | Dataset name from BIDS |
| publishDate | string | YYYY-MM-DD HH:MM:SS |
| onBrainlife | int | 0 or 1 |
| sessionsNum | int | Number of sessions |
| file_size | int | Total file size in bytes |
| byte_size_format | string | Human-readable, e.g., "270 GB" |
| totalFiles | int | Total file count |
| participants | int | Participant count |
| age_min | int | Minimum participant age |
| age_max | int | Maximum participant age |
| BIDSVersion | string | e.g., "1.9.0" |
| License | string | e.g., "CC-BY-NC-SA 4.0" |
| Authors | string | Comma-separated |
| Acknowledgements | string | |
| HowToAcknowledge | string | |
| Funding | string | Joined with ` ===NEMAR-SEP=== ` |
| ReferencesAndLinks | string | Joined with ` ===NEMAR-SEP=== ` |
| DatasetDOI | string | DOI identifier |
| EthicsApprovals | string | Joined with ` ===NEMAR-SEP=== ` |
| tasks | string | Comma-separated task names |
| HEDVersion | string | HED version from dataset_description.json |
| modalities | string | e.g., "eeg", "emg" |
| readme | string | Full README text |
| local_dataset | int | 1 = local, 0 = external |
| processed | int | 0 = raw, 1 = processed/derivative |
| hedAnnotation | int | 0 or 1 |

### 2. dataexplorer_extra_dataset (8 fields)

| Field | Type | Notes |
|---|---|---|
| id | string | Dataset ID |
| channel_counts | string | JSON: `{"EEG Channels": 64}` |
| runs_session | int | Number of runs |
| file_formats | string | Comma-separated extensions |
| data_pipeline | string | Currently unused (empty) |
| event_count | int | Number of event files |
| total_actual_file_size | int | Size in KB |
| zip_file_size | int | Zip archive size in KB |

### 3. dataexplorer_dataset_channel_count (3 fields, multiple rows per dataset)

| Field | Type | Notes |
|---|---|---|
| id | string | Dataset ID |
| name | string | Channel type, e.g., "EEG Channels" |
| count | int | Number of channels |

### 4. dataexplorer_supplementary_dataset (8 fields)

| Field | Type | Notes |
|---|---|---|
| id | string | Dataset ID |
| latestSnapshot_created | string | YYYY-MM-DD HH:MM:SS |
| description_name | string | Dataset name |
| primaryModality | string | Primary modality |
| secondaryModalities | string | Comma-separated |
| issues | string | JSON array (currently "[]") |
| git_local_tag | string | Latest local git tag |
| git_remote_tag | string | Latest remote git tag |

## Example Metadata Input

```json
{
  "entry": {
    "0": {
      "id": "nm000103",
      "created": "2025-10-09 09:04:56",
      "uploader": "Seyed Yahya Shirazi",
      "latestSnapshot": "1.0.0",
      "name": "Healthy Brain Network EEG - Not for Commercial Use",
      "publishDate": "2025-10-09 09:04:56",
      "onBrainlife": 0,
      "sessionsNum": 0,
      "file_size": 289938407424,
      "byte_size_format": "270 GB",
      "totalFiles": 17615,
      "participants": 447,
      "age_min": 5,
      "age_max": 21,
      "BIDSVersion": "1.9.0",
      "License": "CC-BY-NC-SA 4.0",
      "Authors": "Seyed Yahya Shirazi, Alexandre Franco, ...",
      "Funding": "See https://childmind.org/...",
      "ReferencesAndLinks": "https://dx.doi.org/10.1038/sdata.2017.181<br/>...",
      "DatasetDOI": "10.5281/zenodo.17306881",
      "modalities": "emg",
      "readme": "## Overview\n...",
      "local_dataset": 1,
      "processed": 0,
      "hedAnnotation": 0
    }
  },
  "success": true
}
```

## Multi-Value Field Separator

The ` ===NEMAR-SEP=== ` separator (space-equals-equals-equals-NEMAR-hyphen-SEP-equals-equals-equals-space) is used to join arrays for these fields:
- Funding
- ReferencesAndLinks
- EthicsApprovals

Input formats normalized by the PHP script:
- Arrays: `["item1", "item2"]` -> joined
- HTML: `"item1<br/>item2"` -> split and joined
- Newline/semicolon delimited -> split and joined

## Channel Type Mapping (TSV type -> display name)

```
EEG -> "EEG Channels"
ECOG -> "EEG Channels"
MEG -> "MEG Channels"
MEGREF -> "MEG REF Channels"
EMG -> "EMG Channels"
EOG -> "EOG Channels"
HEOG -> "EOG Channels"
VEOG -> "EOG Channels"
ECG -> "ECG Channels"
TRIG -> "Trigger Channels"
STIM -> "Trigger Channels"
MISC -> "MISC Channels"
REF -> "REF Channels"
```
