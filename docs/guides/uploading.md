# Uploading Datasets

This guide walks you through uploading a BIDS dataset to NEMAR.

## Prerequisites

Before uploading:

- [ ] Dataset is in valid BIDS format
- [ ] Logged in with `nemar auth login`
- [ ] DataLad and git-annex installed

## Step 1: Validate Your Dataset

Always validate before uploading:

```bash
nemar dataset validate ./my-dataset
```

!!! error "Validation Must Pass"
    Datasets with validation errors cannot be uploaded.
    Fix all errors before proceeding.

### Common Validation Issues

| Issue | Solution |
|-------|----------|
| Missing dataset_description.json | Create the required BIDS metadata file |
| Invalid JSON | Check for syntax errors in JSON files |
| Missing required fields | Add Name and BIDSVersion to dataset_description.json |
| Invalid modality data | Ensure data files match BIDS naming conventions |

## Step 2: Upload

```bash
nemar dataset upload ./my-dataset --name "My EEG Dataset"
```

### Options

| Option | Description |
|--------|-------------|
| `--name, -n` | Dataset name (defaults to folder name) |
| `--description` | Brief description |
| `--skip-validation` | Skip BIDS validation (not recommended) |
| `--dry-run` | Show what would be uploaded without doing it |

## Step 3: What Happens

The upload process:

1. **Validation** - Runs BIDS validator
2. **Repository Creation** - Creates private GitHub repo under nemarDatasets
3. **Metadata Push** - Pushes small files to GitHub
4. **Data Upload** - Uploads large files to S3 via git-annex
5. **Workflow Setup** - Configures GitHub Actions for PR workflow

## Step 4: Making Updates

After initial upload, make changes via pull requests:

```bash
cd nm000104  # Your dataset directory

# Create a branch
git checkout -b add-new-subjects

# Make changes...

# Commit and push
git add .
git commit -m "Add subjects 101-110"
git push -u origin add-new-subjects

# Create PR (opens in browser)
gh pr create
```

Changes are merged after admin review.

## Troubleshooting

### Upload Fails with Authentication Error

```bash
# Check login status
nemar auth status --refresh

# Re-login if needed
nemar auth login
```

### git-annex Errors

```bash
# Ensure git-annex is configured
git annex version

# Re-initialize if needed
git annex init
```

### Large File Upload Timeout

For very large datasets, files are uploaded in batches. If a timeout occurs:

```bash
# Resume upload
git annex copy --to origin
```
