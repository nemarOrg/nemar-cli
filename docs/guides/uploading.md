# Uploading Datasets

This guide walks you through uploading a BIDS dataset to NEMAR.

## Prerequisites

Before uploading:

- [ ] Dataset is in valid BIDS format
- [ ] Logged in with `nemar auth login`
- [ ] git-annex installed
- [ ] GitHub CLI (`gh`) installed and authenticated
- [ ] Sandbox training completed (`nemar sandbox`)

!!! warning "DataLad Users"
    If your dataset was initialized with `datalad create`, rename the default branch to `main` before uploading:
    ```bash
    git branch -m adjusted/master\(unlocked\) main
    ```
    NEMAR requires `main` as the default branch. DataLad's adjusted branch naming will cause CI and metadata pipelines to fail.

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
nemar dataset upload ./my-dataset
```

### Options

| Option | Description |
|--------|-------------|
| `--name, -n` | Dataset name (defaults to BIDS Name field, then directory name) |
| `--description` | Brief description |
| `--skip-validation` | Skip BIDS validation (not recommended) |
| `--skip-orcid` | Skip co-author ORCID collection |
| `--dry-run` | Show what would be uploaded without doing it |
| `--restart` | Clear upload progress and re-upload all files |
| `-j, --jobs` | Number of parallel upload jobs (default: 4) |
| `-y, --yes` | Skip confirmation and proceed |

## Step 3: What Happens

The upload process:

1. **Auth and Prerequisites** - Verifies login, git-annex, GitHub CLI
2. **BIDS Validation** - Runs the official BIDS validator (unless skipped)
3. **File Manifest** - Collects files and co-author ORCIDs
4. **Confirmation** - Shows upload plan for review
5. **Dataset Registration** - Creates dataset record and private GitHub repo
6. **GitHub Invitation** - Accepts collaborator invitation to the repo
7. **git-annex Init** - Initializes git-annex and configures S3 remote
8. **Data Upload** - Uploads large files to S3 (uses AWS CLI fast-path when available)
9. **Metadata and Push** - Writes metadata, commits, and pushes to GitHub
10. **CI Deployment** - Deploys GitHub Actions workflows for validation

## Step 4: Making Updates

After initial upload, push changes using the CLI:

```bash
cd nm000104  # Your dataset directory

# Make changes, then save and push
nemar dataset save -m "Add subjects 101-110"
nemar dataset push
```

Or create a formal update PR:

```bash
nemar dataset update ./nm000104
```

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

### Upload Interrupted or Timed Out

The upload tracks progress automatically. Re-run the same command to resume:

```bash
# Resume from where it left off
nemar dataset upload ./my-dataset

# Or start fresh if resume fails
nemar dataset upload ./my-dataset --restart
```
