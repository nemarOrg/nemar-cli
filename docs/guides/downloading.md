# Downloading Datasets

Download NEMAR datasets using git-annex for efficient large file handling.

## Quick Download

```bash
# Download dataset (skips stimuli/ and derivatives/ by default)
nemar dataset download nm000104
```

This clones the dataset and downloads data files from S3, except for content
under `stimuli/` and `derivatives/` (see "Stimuli and derivatives" below).

## Download Options

```bash
# Download to specific directory
nemar dataset download nm000104 -o ./datasets/

# Clone metadata only (skip all data files)
nemar dataset download nm000104 --no-data

# Parallel downloads for large datasets
nemar dataset download nm000104 -j 8
```

## Stimuli and Derivatives

By default, content under `stimuli/` and `derivatives/` is skipped because
these folders can be very large. Git-annex pointers (symlinks) are still
cloned, so the dataset structure is intact and you can fetch the content on
demand.

```bash
# Default: skip stimuli/ and derivatives/
nemar dataset download nm000104

# Include stimuli/
nemar dataset download nm000104 --stimuli

# Include both
nemar dataset download nm000104 --stimuli --derivatives

# Already cloned? Fetch them later from inside the dataset directory:
cd nm000104
nemar dataset get --stimuli
nemar dataset get --derivatives
nemar dataset get stimuli/sub-01/         # explicit path is also honored
```

## Resume an Interrupted Download

If a download is interrupted, rerun with `--resume` instead of deleting the
partial clone:

```bash
nemar dataset download nm000104 --resume
```

`--resume` validates the existing directory is a git-annex clone of the same
dataset, refuses to proceed when the working tree is dirty, and refuses when
the local `DatasetVersion` has fallen behind the remote (use `--update`
instead). It then re-runs `git annex get` so only missing files are pulled.

## Update to a Newer Version

When upstream publishes a new version, pull only the diff:

```bash
nemar dataset download nm000104 --update           # pulls just the changed files
nemar dataset download nm000104 --update --prune   # also drops orphaned annex objects
```

`--update` reads the local and remote `DatasetVersion`, fast-forwards to the
remote `HEAD`, and runs `git annex get` only on the annex keys that changed
between the two manifests. For a 5 GB dataset with a 20 MB metadata bump, this
typically transfers ~20 MB instead of the whole dataset. Non-fast-forward
merges (you have local commits) are refused; use `nemar dataset update`
(the PR workflow) to push them first.

## BIDS Entity Filters

Pull only the parts of the dataset you need. The clone retains the full
git-annex tree (so the result is still a structurally valid BIDS dataset),
but only matching files have content locally. You can `git annex get <path>`
later to pull more.

```bash
# Specific subjects only (auto-prefix; "01" == "sub-01")
nemar dataset download nm000104 --subjects sub-01,02

# A single task across all subjects
nemar dataset download nm000104 --tasks rest

# Subjects, tasks, and datatypes intersected
nemar dataset download nm000104 \
  --subjects 01,02 --tasks rest --datatypes eeg

# Runs (unpadded 1-9 match both run-1 and run-01)
nemar dataset download nm000104 --runs 1,2

# Sessions
nemar dataset download nm000104 --sessions ses-pre,post

# Raw glob pass-through
nemar dataset download nm000104 --include 'sub-01/eeg/*.edf,*.json'
nemar dataset download nm000104 --exclude 'derivatives/**,sourcedata/**'
```

| Flag | Comma-list values | Maps to |
|---|---|---|
| `--subjects` | `sub-01,02` | `sub-01/**`, `sub-02/**` |
| `--sessions` | `ses-pre,post` | `**/ses-pre/**`, `**/ses-post/**` |
| `--tasks` | `rest,nback` | `**/*_task-rest_*`, `**/*_task-nback_*` |
| `--runs` | `1,2` | `**/*_run-1_*`, `**/*_run-01_*`, ... |
| `--datatypes` | `eeg,emg` | `**/eeg/**`, `**/emg/**` |
| `--include` | raw glob list | `--include` pass-through |
| `--exclude` | raw glob list | `--exclude` pass-through |

Filters compose with `--update` (only changed files inside the filter scope
are pulled). They cannot be combined with `--no-data`, since filters imply
data download.

## Clone vs Download

For large datasets, you may want to clone first and get files selectively:

```bash
# Clone metadata only
nemar dataset clone nm000104

# Get specific files later
cd nm000104
nemar dataset get sub-01/

# Get specific modality
nemar dataset get sub-01/eeg/
```

## How It Works

NEMAR uses git-annex for efficient data management:

1. **Metadata** stored in Git (GitHub)
2. **Large files** stored in S3 (retrieved on demand)
3. **Versioning** tracked automatically

This means:
- Quick initial clone (just metadata)
- Download only files you need
- Automatic deduplication
- Version history preserved

## Working with Downloaded Data

### Check What's Available

```bash
# See what files exist but aren't downloaded
git annex find --not --in here

# See what's downloaded
git annex find --in here
```

### Free Space

Drop files you no longer need locally:

```bash
# Drop specific files (keeps remote copies)
nemar dataset drop sub-01/eeg/sub-01_task-rest_eeg.edf

# Drop all local copies
nemar dataset drop
```

## Troubleshooting

### "Permission denied" Error

Ensure you're logged in:

```bash
nemar auth status --refresh
```

### Slow Download

For large datasets, downloads happen from S3. Check your connection and try
increasing parallelism with `-j 8`.

### "Content not available" Error

The file may have been removed or moved. Try pulling the latest changes:

```bash
git pull
nemar dataset get <file>
```

## HTTPS access via data.nemar.org

Every published dataset is also reachable over plain HTTPS, with no
nemar-cli, git-annex, or NEMAR account required:

```
https://data.nemar.org/<datasetId>/<version>/<bids-path>   # 302s to the file
https://data.nemar.org/<datasetId>/latest/...              # resolves to most recent
https://data.nemar.org/<datasetId>/<version>/manifest.json # JSON file index
https://data.nemar.org/<datasetId>/<version>/              # browsable HTML index
```

`<version>` is either `latest` or an explicit `vX.Y.Z` tag.

This path is **public datasets only**. Private and unpublished datasets stay
on the existing `nemar dataset clone` / `nemar dataset get` flow.

### Dataset landing page

`https://data.nemar.org/<datasetId>/` lists every published version of the
dataset with its DOI, browse URL, and `manifest.json` link. HTML for
browsers, JSON for machine clients (the default when no `Accept` header
is sent, or override with `?format=json`).

### Removed files

If a file path 404s but existed in an older published version, the 404
body tells you the last version that contained it:

```bash
$ curl -s https://data.nemar.org/nm000103/v2.0.0/sub-99/eeg/sub-99_task-rest_eeg.edf | jq
{
  "error": "File not found",
  "reason": "removed",
  "last_seen_version": "v1.0.0",
  "last_seen_url": "https://data.nemar.org/nm000103/v1.0.0/sub-99/eeg/sub-99_task-rest_eeg.edf"
}
```

The walk goes back through the 10 most recent prior versions. For
exhaustive history, fetch `metadata.json` which lists every version.
Directory index pages also show a collapsible "Files removed since
vN-1" footer when files were dropped between versions.

### Parallel downloaders

Because the worker 302s to direct backing-store URLs, every mainstream
parallel downloader works without a custom integration:

| Tool | One-liner |
| --- | --- |
| `aria2c -j 16` | `curl -sL https://data.nemar.org/nm000103/latest/manifest.json \| jq -r '.[].url' \| aria2c -j 16 -i -` |
| `wget --mirror` | `wget -r -np https://data.nemar.org/nm000103/latest/` |
| `curl + xargs` | `xargs -P 16 -n 1 curl -O < urls.txt` |
| `rclone copy` | `rclone copy --transfers 16 :http:data.nemar.org/nm000103/latest/ ./` |
| `rclone sync` | `rclone sync :http:data.nemar.org/nm000103/latest/ ./nm000103/` (see Sync with rclone below) |
| Whole dataset zip | `aws s3 cp s3://nemar/nm000103/archives/v1.0.0.zip ./` (unchanged) |

`manifest.json` carries the SHA-256 of each file, so parallel downloaders
that support checksum verification can verify integrity for free.

### Sync with rclone

`rclone sync` against the HTTP backend works against `data.nemar.org`,
so you can mirror a dataset locally and re-sync to pick up only what
changed between versions:

```bash
# First-time download:
rclone sync :http:data.nemar.org/nm000103/v1.0.0/ ./nm000103/v1.0.0/ \
  --transfers 16 --multi-thread-streams 4

# Re-run: only changed files transfer.
rclone sync :http:data.nemar.org/nm000103/v1.0.0/ ./nm000103/v1.0.0/

# Switch to a newer version: only the diff transfers.
rclone sync :http:data.nemar.org/nm000103/latest/ ./nm000103/latest/
```

Each file response carries `Content-Length`, `Last-Modified` (the
version's publication timestamp), and `ETag` (the content's SHA-256
or git blob SHA). rclone uses size + mtime for delta detection by
default; pass `--checksum` to use the ETag instead:

```bash
rclone check :http:data.nemar.org/nm000103/v1.0.0/ ./nm000103/v1.0.0/ --checksum
```

`rclone lsl` and `rclone ls` produce flat listings if you want a
machine-readable file inventory without fetching `manifest.json`:

```bash
rclone lsl :http:data.nemar.org/nm000103/v1.0.0/
```

Side note: every directory's `manifest.json` is also visible to rclone
as a file entry, so it lands alongside the BIDS data on a sync. Skip
it with `--exclude manifest.json` if you don't want the inventory file
in your local copy.

### Same routes via api.nemar.org

The same handlers are also reachable via the API hostname at
`https://api.nemar.org/data/<datasetId>/<version>/...` -- useful for clients
that already pin to the API origin. The custom `data.nemar.org` hostname is
the canonical public contract.
