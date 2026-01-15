# Downloading Datasets

Download NEMAR datasets using DataLad for efficient large file handling.

## Quick Download

```bash
# Download dataset (metadata only by default)
nemar dataset download nm000104
```

This creates a DataLad dataset with metadata. Large files are not downloaded yet.

## Get Data Files

After downloading, get the actual data files:

```bash
cd nm000104

# Get all files
datalad get .

# Get specific files
datalad get sub-01/

# Get specific modality
datalad get **/eeg/*.edf
```

## Download Options

```bash
# Download to specific directory
nemar dataset download nm000104 --output ./datasets/

# Force re-download (overwrite existing)
nemar dataset download nm000104 --force

# Include data files immediately
nemar dataset download nm000104 --get-data
```

## How It Works

NEMAR uses DataLad with git-annex for efficient data management:

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
# Drop a specific file (keeps in S3)
datalad drop sub-01/eeg/sub-01_task-rest_eeg.edf

# Drop all files
datalad drop .
```

### Update to Latest Version

```bash
cd nm000104
datalad update --merge
```

## Troubleshooting

### "Permission denied" Error

Ensure you're logged in:

```bash
nemar auth status --refresh
```

### Slow Download

For large datasets, downloads happen from S3. Check your connection.

### "Content not available" Error

The file may have been removed or moved. Try:

```bash
datalad update --merge
datalad get <file>
```
