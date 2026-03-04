# Downloading Datasets

Download NEMAR datasets using git-annex for efficient large file handling.

## Public vs Private Datasets

- **Public datasets** (published) can be downloaded by anyone without authentication.
- **Private datasets** (pre-publication) can only be downloaded by the owner and designated collaborators, and only through the NEMAR CLI. Direct git-annex commands (`git annex get`, `git annex pull`) will not work for private data.

After publishing, datasets become publicly available for everyone.

## Quick Download

```bash
# Download a public dataset (no account needed)
nemar dataset download nm000104

# Download a private dataset (requires login)
nemar auth login
nemar dataset download nm000115
```

This clones the dataset and downloads all data files from S3. The CLI shows real-time progress during download, including transfer speed, estimated time remaining, and per-file status.

## Download Options

```bash
# Download to specific directory
nemar dataset download nm000104 -o ./datasets/

# Clone metadata only (skip large data files)
nemar dataset download nm000104 --no-data

# Parallel downloads for large datasets
nemar dataset download nm000104 -j 8
```

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

## Download Progress

Downloads display real-time progress with:

- **Transfer speed** - current download rate (e.g., 2.4 MB/s)
- **Estimated time remaining** - based on sliding-window speed averaging
- **File progress** - tracks completed vs total files
- **Per-file status** - shows which file is currently downloading

The CLI automatically detects whether `git-annex` is installed. If available, it uses git-annex for efficient content-addressed downloads. Otherwise, it falls back to direct S3 downloads via pre-signed URLs.

## Prerequisites

The `download` command requires the GitHub CLI (`gh`) to be installed and authenticated. The CLI checks for required tools before starting and provides platform-specific install guidance if anything is missing.

For private datasets, you must also be logged in with `nemar auth login`.

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
