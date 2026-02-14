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

## 3. Validate Your Dataset

Before uploading, validate your BIDS dataset:

```bash
nemar dataset validate ./my-dataset
```

Fix any errors before proceeding. Warnings are acceptable but should be reviewed.

## 4. Upload Your Dataset

Upload your validated dataset:

```bash
nemar dataset upload ./my-dataset --name "My EEG Dataset"
```

The upload process will:
1. Run BIDS validation
2. Create a private GitHub repository
3. Upload large files to S3 via git-annex
4. Initialize version control with DataLad

## 5. Check Status

Monitor your dataset:

```bash
nemar dataset status nm000104
```

## Common Workflows

### Download a Dataset

```bash
# Download dataset metadata
nemar dataset download nm000104

# Get all data files
cd nm000104
datalad get .
```

### List Your Datasets

```bash
nemar dataset list --mine
```

### Create a New Version

After making changes, create a new version with DOI:

```bash
nemar dataset version nm000104 1.1.0 --description "Added 10 more subjects"
```

## Need Help?

```bash
# General help
nemar --help

# Command-specific help
nemar dataset --help
nemar dataset upload --help
```
