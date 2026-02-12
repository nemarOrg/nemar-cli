# NEMAR CLI

Command-line interface for NEMAR (Neuroelectromagnetic Data Archive and Tools Resource).

## What is NEMAR?

NEMAR is a curated repository for neurophysiology data in Brain Imaging Data Structure (BIDS) format.
This CLI provides tools for uploading, downloading, and managing datasets.

## Features

- **Authentication**: Secure API key-based authentication with admin approval workflow
- **BIDS Validation**: Validate datasets locally using the official BIDS validator
- **Dataset Upload**: Upload BIDS datasets with automatic git-annex and S3 integration
- **Dataset Download**: Download datasets using DataLad for efficient large file handling
- **DOI Management**: Create and manage DOIs through Zenodo integration

## Quick Example

```bash
# Install the CLI
bun install -g nemar-cli

# Sign up for an account
nemar auth signup

# After approval, log in
nemar auth login

# Validate your dataset
nemar dataset validate ./my-dataset

# Upload to NEMAR
nemar dataset upload ./my-dataset --name "My EEG Dataset"
```

## Getting Started

1. [Installation](getting-started/installation.md) - Install the CLI and dependencies
2. [Quick Start](getting-started/quickstart.md) - Get up and running in minutes
3. [Authentication](getting-started/authentication.md) - Set up your account

## Guides

- [Uploading](guides/uploading.md) - Upload datasets to NEMAR
- [Downloading](guides/downloading.md) - Download datasets from NEMAR
- [Validation](guides/validation.md) - Validate BIDS datasets
- [Versioning](guides/versioning.md) - Version bumps and dataset updates via PR
- [Publishing](guides/publishing.md) - Publish datasets with DOIs

## Support

- [GitHub Issues](https://github.com/nemarOrg/nemar-cli/issues) - Report bugs or request features
- [NEMAR Website](https://nemar.org) - Learn more about NEMAR
