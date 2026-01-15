# BIDS Validation

NEMAR requires all datasets to be in valid BIDS format. This guide covers validation.

## Quick Validation

```bash
nemar dataset validate ./my-dataset
```

## What Gets Checked

The BIDS validator checks:

- **Structure** - Files and folders follow BIDS naming conventions
- **Metadata** - Required JSON sidecar files are present
- **Consistency** - Data matches metadata descriptions
- **Completeness** - Required files exist

## Understanding Results

### Errors (Must Fix)

Errors indicate invalid BIDS structure that must be fixed:

```
[ERROR] dataset_description.json is missing
[ERROR] Invalid JSON in participants.tsv
```

### Warnings (Review)

Warnings suggest potential issues but don't block upload:

```
[WARNING] Recommended field 'License' is missing
[WARNING] No README file found
```

## Validation Options

```bash
# Basic validation
nemar dataset validate ./my-dataset

# Verbose output (show all checks)
nemar dataset validate ./my-dataset --verbose

# Ignore specific warnings
nemar dataset validate ./my-dataset --config .bidsvalidatorrc

# Output as JSON
nemar dataset validate ./my-dataset --json
```

## Common Errors and Fixes

### Missing dataset_description.json

Create the file in your dataset root:

```json
{
  "Name": "My EEG Dataset",
  "BIDSVersion": "1.9.0",
  "DatasetType": "raw",
  "License": "CC BY-NC 4.0",
  "Authors": ["Last, First", "Last2, First2"]
}
```

### Invalid Filename

BIDS filenames must follow the pattern:
```
sub-<label>[_ses-<label>][_task-<label>][_run-<index>]_<suffix>.<extension>
```

Example:
```
sub-01_ses-01_task-rest_run-01_eeg.edf
```

### Missing Events File

For task data, create an events.tsv:

```tsv
onset	duration	trial_type
0.0	0.5	stimulus
1.5	0.5	response
```

## Custom Validation Config

Create `.bidsvalidatorrc` in your dataset root:

```json
{
  "ignore": [
    "/derivatives/"
  ],
  "ignoredFiles": [
    ".DS_Store"
  ]
}
```

## Validation Before Upload

Validation runs automatically during upload. To skip (not recommended):

```bash
nemar dataset upload ./my-dataset --skip-validation
```

!!! warning "Not Recommended"
    Skipping validation may result in a dataset that cannot be properly indexed or used.
