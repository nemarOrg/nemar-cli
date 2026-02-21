# Quick Start

Get up and running with NEMAR CLI in 5 minutes.

## 1. Sign Up

Create a NEMAR account:

```bash
nemar auth signup
```

You'll be prompted to enter:
- Username
- Email address
- Password (min 12 characters)
- GitHub username
- ORCID iD (optional, for DOI metadata)
- Description of why you need access

!!! info "Admin Approval Required"
    After signing up, verify your email and wait for admin approval.
    You'll receive a notification email once approved.

## 2. Retrieve Your API Key

After approval, retrieve your API key using your email and password:

```bash
nemar auth retrieve-key
```

!!! warning "Save Your Key"
    The API key is only shown once. Store it securely.

## 3. Log In

```bash
nemar auth login
# Enter your API key when prompted

# Or provide it directly
nemar auth login -k nemar_your_api_key_here
```

## 4. Complete Sandbox Training

Before uploading real datasets, complete sandbox training:

```bash
nemar sandbox
```

This verifies your git-annex and GitHub setup by uploading a small test dataset.

## 5. Validate Your Dataset

Before uploading, validate your BIDS dataset:

```bash
nemar dataset validate ./my-dataset
```

Fix any errors before proceeding. Warnings are acceptable but should be reviewed.

## 6. Upload Your Dataset

Upload your validated dataset:

```bash
nemar dataset upload ./my-dataset
```

The dataset name defaults to the BIDS Name field in dataset_description.json (or the directory name as fallback).

## 7. Check Status

Monitor your dataset:

```bash
nemar dataset status nm000104
```

## Common Workflows

### Download a Dataset

```bash
# Download a dataset (includes data files)
nemar dataset download nm000104

# Or clone without data files
nemar dataset clone nm000104

# Get specific data files later
nemar dataset get sub-01/
```

### List Your Datasets

```bash
nemar dataset list --mine
```

### Create a New Version

After making changes, create a version bump PR:

```bash
nemar dataset release nm000104 --type minor
```

## Need Help?

```bash
# General help
nemar --help

# Command-specific help
nemar dataset --help
nemar dataset upload --help
```
