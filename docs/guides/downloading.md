# Downloading Datasets

Download NEMAR datasets using git-annex for efficient large file handling.

## Quick Download

```bash
# Download dataset (includes all data files)
nemar dataset download nm000104
```

This clones the dataset and downloads all data files from S3.

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
