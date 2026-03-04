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
    NEMAR requires `main` as the default branch. DataLad's adjusted branch naming (e.g. `adjusted/master(unlocked)`) will cause CI and metadata pipelines to fail.

    The CLI will detect non-`main` branches during upload and offer to rename automatically. You can also rename manually:
    ```bash
    git branch -m adjusted/master\(unlocked\) main
    ```

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

1. **Prerequisite Check** - Verifies required tools (git-annex, gh, aws) are installed with platform-specific install guidance if missing
2. **Auth and Prerequisites** - Verifies login, GitHub authentication (HTTPS preferred, SSH as fallback)
3. **BIDS Validation** - Runs the official BIDS validator (unless skipped)
4. **File Manifest** - Collects files and co-author ORCIDs
5. **License Enforcement** - Detects license from `dataset_description.json` or LICENSE file; prompts to select one if missing. Validates the license allows research redistribution (see [License Requirements](#license-requirements) below)
6. **Data Provenance** - For derived datasets, collects source dataset DOIs and checks license compatibility
7. **Confirmation** - Shows upload plan for review
8. **Dataset Registration** - Creates dataset record and private GitHub repo
9. **GitHub Invitation** - Accepts collaborator invitation to the repo
10. **git-annex Init** - Initializes git-annex and configures S3 remote
11. **Data Upload** - Uploads large files to S3 (uses AWS CLI fast-path when available)
12. **Metadata and Push** - Writes metadata, commits, and pushes to GitHub
13. **CI Deployment** - Deploys GitHub Actions workflows for validation

## License Requirements

Every dataset uploaded to NEMAR must have a license that allows research redistribution. The CLI will:

1. **Auto-detect** your license from `dataset_description.json` (the `License` field) or a LICENSE file
2. **Prompt you to choose** if no license is found, offering recommended open data licenses
3. **Validate** that the chosen license allows research use
4. **Create a LICENSE file** if one does not exist

Recommended licenses (most permissive to most restrictive):

| License | Description |
|---------|-------------|
| CC0-1.0 | Public domain dedication (no restrictions) |
| PDDL-1.0 | Public Domain Dedication and License |
| CC-BY-4.0 | Attribution only |
| CC-BY-SA-4.0 | Attribution + ShareAlike |
| CC-BY-NC-4.0 | Attribution + NonCommercial |
| CC-BY-NC-SA-4.0 | Attribution + NonCommercial + ShareAlike |
| ODC-By-1.0 | Open Data Commons Attribution |
| ODbL-1.0 | Open Database License |

You can also enter any valid SPDX license identifier manually if it allows research use.

!!! tip "License for Derived Data"
    If your dataset is derived from another dataset, the CLI will ask about data provenance and check that your chosen license is compatible with the source dataset's license. For example, a dataset derived from CC-BY-SA-4.0 source data must also use CC-BY-SA-4.0.

## GitHub Authentication

The CLI uses HTTPS-first authentication for GitHub operations:

1. **CI/CD**: Uses `GH_TOKEN` environment variable if set
2. **Local (preferred)**: Uses `gh auth token` from GitHub CLI, so run `gh auth login` first
3. **Fallback**: SSH key authentication (`nemar auth setup-ssh`)

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
