# Dataset Versioning

NEMAR uses semantic versioning (X.Y.Z) and pull requests for all dataset changes. Every change to a dataset goes through a PR, which triggers CI checks (BIDS validation, version verification). On merge, GitHub Actions automatically tags the release and mints a DOI if configured.

## Version Types

- **Patch** (1.0.0 -> 1.0.1): Bug fixes, metadata corrections, small additions
- **Minor** (1.0.0 -> 1.1.0): New subjects, new modalities, significant additions
- **Major** (1.0.0 -> 2.0.0): Breaking changes, restructured data, format changes

## Two Workflows

### 1. Version Bump Only (`release`)

Use `nemar dataset release` when you want to tag a new version without changing data. This is common when the dataset content is already correct and you simply need to cut a release.

```bash
# Interactive: prompts for patch/minor/major
nemar dataset release nm000104

# Non-interactive: specify bump type directly
nemar dataset release nm000104 --type patch -y

# Explicit version
nemar dataset release nm000104 --version 2.0.0 -y
```

What happens:
1. CLI clones the repo to a temp directory
2. Creates branch `release/v1.0.1`
3. Updates `dataset_description.json` with new version
4. Pushes and creates a PR
5. CI runs BIDS validation and version checks
6. On merge: tag, GitHub Release, and version DOI (if concept DOI exists)

### 2. Data or Metadata Changes (`update`)

Use `nemar dataset update` when you have local changes to push. This handles both metadata-only changes (JSON, TSV, README) and data file changes (EDF, BDF, etc.).

```bash
# First, clone and make changes locally
nemar dataset clone nm000104
cd nm000104
nemar dataset get .

# Make your changes...
# Edit participants.tsv, add new files, etc.

# Push changes via PR
nemar dataset update -m "Add subjects 10-15"
```

What happens:
1. CLI detects dataset ID from git remote
2. Categorizes changes (metadata vs data files)
3. Creates branch `update/nm000104-<timestamp>`
4. Bumps version (patch by default)
5. Commits all changes
6. For data files: uploads to S3 via `git annex copy --to nemar-s3`
7. Pushes and creates a PR

## Monitoring CI and Auto-merge

Both commands support `--monitor` to watch CI checks and offer to merge:

```bash
# Release with monitoring
nemar dataset release nm000104 --type patch --monitor -y

# Output:
#   Dataset: My EEG Study
#   Current version: 1.0.0
#   Version bump: 1.0.0 -> 1.0.1
#   ... cloning, branching, committing ...
#   PR: https://github.com/nemarDatasets/nm000104/pull/5
#   Monitoring CI checks...
#   ......
#   All checks passed!
#   ? Merge the PR? (y/N) y
#   PR merged successfully!
```

## Using an Existing Clone

If you already have the dataset cloned, avoid a redundant clone:

```bash
# Use --dir with release
nemar dataset release nm000104 --dir ./nm000104

# Or just cd into the clone for update
cd nm000104
nemar dataset update
```

## What CI Checks Run on PRs

When a PR is created against `main`, GitHub Actions runs two workflows:

1. **BIDS Validation** (`bids-validation.yml`) - Runs the BIDS validator (Deno-based) on the dataset. Output is written to `.nemar/validation.json`. Warnings are tolerated; only errors cause failure.
2. **Version Check** (`version-check.yml`) - Ensures `dataset_description.json` has a version that is higher than the latest git tag. Prevents merging without a version bump.

Both must pass before the PR can be merged. These workflows are automatically deployed by the publish orchestrator and by `nemar dataset release`.

## What Happens on PR Merge

When a PR is merged to `main`, the `pr-merge.yml` workflow fires and performs:

1. **Tag and Release** - Reads the version from `dataset_description.json`, creates a `vX.Y.Z` git tag and GitHub Release
2. **Webhook** - Calls the backend's `/webhooks/publish-version-doi` endpoint with the dataset ID, version, and release URL
3. **Version DOI** - If a concept DOI exists, the backend mints a version DOI via EZID (or Zenodo). For EZID, the DOI pattern is `<concept_doi>.V<version>`.
4. **Zenodo Backup** - For EZID-provider datasets, creates/updates a Zenodo draft deposition with the release archive (never published, serves as backup)
5. **Version Manifest** - Generates a manifest (file listing with checksums) and uploads to `s3://nemar/<dataset_id>/version/v<version>.json`

The webhook token (`NEMAR_WEBHOOK_TOKEN`) is configured as an organization-level secret on nemarDatasets; no per-repo setup is needed.

## The `.nemar/` Directory

All NEMAR-generated files are stored under `.nemar/` in the dataset repository. This directory is excluded from BIDS validation via `.bidsignore`. Current contents:

- `.nemar/validation.json` - BIDS validation output from CI

The `.bidsignore` file automatically includes `.nemar/` and `nemar_metadata.json` entries. These are added during dataset upload.

## Prerequisites

- **git** - For cloning and branching
- **gh** (GitHub CLI) - For creating PRs (`brew install gh`)
- **git-annex** - Only needed if updating data files
- **NEMAR account** - Must be logged in (`nemar auth login`)

## Examples

### Quick patch release

```bash
nemar dataset release nm000104 --type patch -y
```

### Minor release with monitoring

```bash
nemar dataset release nm000104 --type minor --monitor
```

### Update metadata files

```bash
cd nm000104
# Edit participants.tsv, dataset_description.json, etc.
nemar dataset update -m "Fix participant demographics"
```

### Update with new data files

```bash
cd nm000104
# Add new EDF files to sub-XX/eeg/
nemar dataset update --bump minor -m "Add subjects 20-25"
```

### Update from a different directory

```bash
nemar dataset update /path/to/nm000104 --bump patch -m "Fix events.tsv"
```

### Full lifecycle example

```bash
# 1. Upload a new dataset
nemar dataset upload ./my-eeg-study

# 2. Request publication (admin approves, concept DOI is created)
nemar dataset publish request nm000108
# ... admin approves ...

# 3. Make corrections and release a new version
nemar dataset clone nm000108
cd nm000108
nemar dataset get .
# fix some metadata...
nemar dataset update -m "Fix channel locations" --monitor -y

# 4. Cut a minor release for new subjects
# add new subject folders...
nemar dataset update --bump minor -m "Add 10 new subjects" --monitor -y

# 5. Pure version bump (no data changes)
nemar dataset release nm000108 --type major --monitor
```
