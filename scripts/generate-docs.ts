#!/usr/bin/env bun
/**
 * Generate documentation from CLI help output
 *
 * This script runs the CLI commands with --help and generates markdown files
 * for MkDocs documentation.
 *
 * Usage: bun run scripts/generate-docs.ts
 */

import { execSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const DOCS_DIR = join(import.meta.dir, "..", "docs");
const CLI_PATH = join(import.meta.dir, "..", "src", "index.ts");

// Command structure for documentation
const commands = {
  auth: {
    description: "Authentication and account management",
    subcommands: [
      "login",
      "signup",
      "status",
      "whoami",
      "switch",
      "logout",
      "resend-verification",
      "setup-ssh",
      "retrieve-key",
      "regenerate-key",
    ],
  },
  dataset: {
    description: "Dataset management operations",
    subcommands: [
      "validate",
      "upload",
      "download",
      "status",
      "list",
      "release",
      "update",
      "request-access",
      "invite",
      "collaborators",
      "publish request",
      "publish status",
      "publish resend",
      "clone",
      "get",
      "save",
      "push",
      "drop",
      "ci",
      "manifest",
    ],
  },
  sandbox: {
    description: "Sandbox training (required before uploading)",
    subcommands: ["status", "reset"],
  },
  admin: {
    description: "Administrative operations (requires admin privileges)",
    subcommands: [
      "users",
      "approve",
      "revoke",
      "role",
      "s3 regenerate-iam",
      "s3 lock",
      "repo public",
      "repo private",
      "ci check",
      "ci add",
      "doi create",
      "doi info",
      "doi update",
      "doi enrich",
      "publish list",
      "publish approve",
      "publish deny",
      "revert",
      "make-public",
      "delete-dataset",
    ],
  },
};

function runHelp(args: string[]): string {
  try {
    const cmd = `bun run ${CLI_PATH} ${args.join(" ")} --help 2>&1`;
    return execSync(cmd, { encoding: "utf-8" });
  } catch (error) {
    // Commander exits with code 0 for --help, but execSync may still throw
    if (error instanceof Error && "stdout" in error) {
      return (error as { stdout: string }).stdout;
    }
    return "";
  }
}

function escapeMarkdown(text: string): string {
  // Escape characters that might interfere with markdown
  return text;
}

function generateCommandDoc(command: string, config: (typeof commands)[keyof typeof commands]): string {
  const mainHelp = runHelp([command]);

  let doc = `# ${command}\n\n`;
  doc += `${config.description}\n\n`;
  doc += `## Usage\n\n`;
  doc += "```bash\n";
  doc += mainHelp;
  doc += "```\n\n";

  // Generate subcommand documentation
  doc += `## Subcommands\n\n`;

  for (const subcommand of config.subcommands) {
    const subHelp = runHelp([command, subcommand]);

    doc += `### ${command} ${subcommand}\n\n`;
    doc += "```bash\n";
    doc += subHelp;
    doc += "```\n\n";
  }

  return doc;
}

function generateMainDoc(): string {
  const mainHelp = runHelp([]);

  let doc = `# Command Reference\n\n`;
  doc += `Overview of all available NEMAR CLI commands.\n\n`;
  doc += `## Main Help\n\n`;
  doc += "```bash\n";
  doc += mainHelp;
  doc += "```\n\n";

  doc += `## Command Groups\n\n`;
  doc += `| Command | Description |\n`;
  doc += `|---------|-------------|\n`;
  doc += `| [auth](auth.md) | Authentication and account management |\n`;
  doc += `| [dataset](dataset.md) | Dataset management operations |\n`;
  doc += `| [sandbox](sandbox.md) | Sandbox training (required before uploading) |\n`;
  doc += `| [admin](admin.md) | Administrative operations (admin only) |\n`;

  return doc;
}

function generateIndexDoc(): string {
  return `# NEMAR CLI

Command-line interface for NEMAR (Neuroelectromagnetic Data Archive and Tools Resource).

## What is NEMAR?

NEMAR is a curated repository for neurophysiology data in Brain Imaging Data Structure (BIDS) format.
This CLI provides tools for uploading, downloading, and managing datasets.

## Features

- **Authentication**: Secure API key-based authentication with admin approval workflow
- **BIDS Validation**: Validate datasets locally using the official BIDS validator
- **Dataset Upload**: Upload BIDS datasets with automatic git-annex and S3 integration
- **Dataset Download**: Download datasets using git-annex for efficient large file handling
- **DOI Management**: Create and manage DOIs through EZID integration
- **Collaboration**: Invite collaborators and manage access

## Quick Example

\`\`\`bash
# Install the CLI
bun install -g nemar-cli

# Sign up for an account
nemar auth signup

# After approval, retrieve your API key
nemar auth retrieve-key

# Log in with your key
nemar auth login

# Validate your dataset
nemar dataset validate ./my-dataset

# Upload to NEMAR
nemar dataset upload ./my-dataset
\`\`\`

## Getting Started

1. [Installation](getting-started/installation.md) - Install the CLI and dependencies
2. [Quick Start](getting-started/quickstart.md) - Get up and running in minutes
3. [Authentication](getting-started/authentication.md) - Set up your account

## Support

- [GitHub Issues](https://github.com/nemarOrg/nemar-cli/issues) - Report bugs or request features
- [NEMAR Website](https://nemar.org) - Learn more about NEMAR
`;
}

function generateInstallationDoc(): string {
  return `# Installation

## Prerequisites

NEMAR CLI requires **Bun** runtime (v1.0+).

### Install Bun

\`\`\`bash
# macOS, Linux, WSL
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

# Homebrew
brew install oven-sh/bun/bun
\`\`\`

### For Dataset Operations

- **DataLad** (v1.0+) - For dataset upload/download
- **git-annex** (v10+) - Large file management
- **Deno** (v1.40+) - For BIDS validation

## Install NEMAR CLI

### Using Bun

\`\`\`bash
# Install globally
bun install -g nemar-cli

# Or run directly without installing
bunx nemar-cli --help
\`\`\`

### From Source

\`\`\`bash
git clone https://github.com/nemarOrg/nemar-cli.git
cd nemar-cli
bun install
bun link
\`\`\`

## Install Optional Dependencies

### macOS

\`\`\`bash
# Using Homebrew
brew install git-annex datalad deno

# Or using conda
conda install -c conda-forge datalad git-annex
\`\`\`

### Linux (Ubuntu/Debian)

\`\`\`bash
# Install git-annex
sudo apt-get update
sudo apt-get install -y git-annex

# Install DataLad
pip install datalad

# Install Deno
curl -fsSL https://deno.land/install.sh | sh
\`\`\`

### Windows (WSL)

We recommend using Windows Subsystem for Linux (WSL) for the best experience:

\`\`\`bash
# In WSL Ubuntu
sudo apt-get install git-annex
pip install datalad
\`\`\`

## Verify Installation

\`\`\`bash
# Check CLI version
nemar --version

# Check Bun
bun --version

# Check optional dependencies (for dataset operations)
git --version
git-annex version
datalad --version
deno --version
\`\`\`

## Troubleshooting

### "command not found: nemar"

Ensure Bun's bin directory is in your PATH:

\`\`\`bash
# Add to ~/.bashrc or ~/.zshrc
export PATH="$HOME/.bun/bin:$PATH"
\`\`\`

## Next Steps

- [Quick Start](quickstart.md) - Upload your first dataset
- [Authentication](authentication.md) - Set up your NEMAR account
`;
}

function generateQuickstartDoc(): string {
  return `# Quick Start

Get up and running with NEMAR CLI in 5 minutes.

## 1. Sign Up

Create a NEMAR account:

\`\`\`bash
nemar auth signup
\`\`\`

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

\`\`\`bash
nemar auth retrieve-key
\`\`\`

!!! warning "Save Your Key"
    The API key is only shown once. Store it securely.

## 3. Log In

\`\`\`bash
nemar auth login
# Enter your API key when prompted

# Or provide it directly
nemar auth login -k nemar_your_api_key_here
\`\`\`

## 4. Complete Sandbox Training

Before uploading real datasets, complete sandbox training:

\`\`\`bash
nemar sandbox
\`\`\`

This verifies your git-annex and GitHub setup by uploading a small test dataset.

## 5. Validate Your Dataset

Before uploading, validate your BIDS dataset:

\`\`\`bash
nemar dataset validate ./my-dataset
\`\`\`

Fix any errors before proceeding. Warnings are acceptable but should be reviewed.

## 6. Upload Your Dataset

Upload your validated dataset:

\`\`\`bash
nemar dataset upload ./my-dataset
\`\`\`

The dataset name defaults to the BIDS Name field in dataset_description.json (or the directory name as fallback).

## 7. Check Status

Monitor your dataset:

\`\`\`bash
nemar dataset status nm000104
\`\`\`

## Common Workflows

### Download a Dataset

\`\`\`bash
# Download a dataset (includes data files)
nemar dataset download nm000104

# Or clone without data files
nemar dataset clone nm000104

# Get specific data files later
nemar dataset get sub-01/
\`\`\`

### List Your Datasets

\`\`\`bash
nemar dataset list --mine
\`\`\`

### Create a New Version

After making changes, create a version bump PR:

\`\`\`bash
nemar dataset release nm000104 --type minor
\`\`\`

## Need Help?

\`\`\`bash
# General help
nemar --help

# Command-specific help
nemar dataset --help
nemar dataset upload --help
\`\`\`
`;
}

function generateAuthDoc(): string {
  return `# Authentication

NEMAR uses API key authentication with an admin approval workflow.

## Workflow Overview

1. **Sign up** - Create an account with your details
2. **Verify email** - Click the link in the verification email
3. **Wait for approval** - Admin reviews your request
4. **Retrieve API key** - Use \`nemar auth retrieve-key\` with your email and password
5. **Log in** - Use your API key to authenticate

## Creating an Account

\`\`\`bash
nemar auth signup
\`\`\`

You'll be prompted for:

| Field | Description |
|-------|-------------|
| Username | 3-30 characters, alphanumeric with - and _ |
| Email | Valid email for verification |
| Password | Minimum 12 characters |
| GitHub Username | Required for PR collaboration |
| ORCID iD | Optional, used for DOI creator metadata |
| Description | Why you need NEMAR access (min 20 chars) |

## Logging In

### Interactive

\`\`\`bash
nemar auth login
\`\`\`

### With API Key

\`\`\`bash
nemar auth login -k nemar_your_api_key_here
\`\`\`

### Environment Variable

\`\`\`bash
export NEMAR_API_KEY=nemar_your_api_key_here
nemar auth login
\`\`\`

## Check Status

\`\`\`bash
# View cached credentials
nemar auth status

# Refresh from server
nemar auth status --refresh
\`\`\`

## Log Out

\`\`\`bash
# Remove the active account
nemar auth logout

# Remove all stored accounts
nemar auth logout --all
\`\`\`

## Switch Accounts

If you have multiple NEMAR accounts:

\`\`\`bash
# Interactive account picker
nemar auth switch

# Switch to a specific account
nemar auth switch <username>
\`\`\`

## Resend Verification Email

If you didn't receive the verification email:

\`\`\`bash
nemar auth resend-verification
\`\`\`

## Security Notes

!!! warning "Keep Your API Key Secure"
    - Never commit your API key to version control
    - Use environment variables in scripts
    - Don't share your API key with others

Your API key is linked to:
- Your GitHub Personal Access Token (for repository operations)
- Your S3 credentials (for data upload/download)

If you suspect your key is compromised, regenerate it immediately:

\`\`\`bash
nemar auth regenerate-key
\`\`\`

This sends a verification email and revokes the old key upon confirmation.
`;
}

function generateUploadingGuide(): string {
  return `# Uploading Datasets

This guide walks you through uploading a BIDS dataset to NEMAR.

## Prerequisites

Before uploading:

- [ ] Dataset is in valid BIDS format
- [ ] Logged in with \`nemar auth login\`
- [ ] git-annex installed
- [ ] GitHub CLI (\`gh\`) installed and authenticated
- [ ] Sandbox training completed (\`nemar sandbox\`)

## Step 1: Validate Your Dataset

Always validate before uploading:

\`\`\`bash
nemar dataset validate ./my-dataset
\`\`\`

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

\`\`\`bash
nemar dataset upload ./my-dataset
\`\`\`

### Options

| Option | Description |
|--------|-------------|
| \`--name, -n\` | Dataset name (defaults to BIDS Name field, then directory name) |
| \`--description\` | Brief description |
| \`--skip-validation\` | Skip BIDS validation (not recommended) |
| \`--skip-orcid\` | Skip co-author ORCID collection |
| \`--dry-run\` | Show what would be uploaded without doing it |
| \`--restart\` | Clear upload progress and re-upload all files |
| \`-j, --jobs\` | Number of parallel upload jobs (default: 4) |
| \`-y, --yes\` | Skip confirmation and proceed |

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

\`\`\`bash
cd nm000104  # Your dataset directory

# Make changes, then save and push
nemar dataset save -m "Add subjects 101-110"
nemar dataset push
\`\`\`

Or create a formal update PR:

\`\`\`bash
nemar dataset update ./nm000104
\`\`\`

## Troubleshooting

### Upload Fails with Authentication Error

\`\`\`bash
# Check login status
nemar auth status --refresh

# Re-login if needed
nemar auth login
\`\`\`

### git-annex Errors

\`\`\`bash
# Ensure git-annex is configured
git annex version

# Re-initialize if needed
git annex init
\`\`\`

### Upload Interrupted or Timed Out

The upload tracks progress automatically. Re-run the same command to resume:

\`\`\`bash
# Resume from where it left off
nemar dataset upload ./my-dataset

# Or start fresh if resume fails
nemar dataset upload ./my-dataset --restart
\`\`\`
`;
}

function generateValidationGuide(): string {
  return `# BIDS Validation

NEMAR requires all datasets to be in valid BIDS format. This guide covers validation.

## Quick Validation

\`\`\`bash
nemar dataset validate ./my-dataset
\`\`\`

## What Gets Checked

The BIDS validator checks:

- **Structure** - Files and folders follow BIDS naming conventions
- **Metadata** - Required JSON sidecar files are present
- **Consistency** - Data matches metadata descriptions
- **Completeness** - Required files exist

## Understanding Results

### Errors (Must Fix)

Errors indicate invalid BIDS structure that must be fixed:

\`\`\`
[ERROR] dataset_description.json is missing
[ERROR] Invalid JSON in participants.tsv
\`\`\`

### Warnings (Review)

Warnings suggest potential issues but don't block upload:

\`\`\`
[WARNING] Recommended field 'License' is missing
[WARNING] No README file found
\`\`\`

## Validation Options

\`\`\`bash
# Basic validation
nemar dataset validate ./my-dataset

# Verbose output (show all checks)
nemar dataset validate ./my-dataset --verbose

# Ignore specific warnings
nemar dataset validate ./my-dataset --config .bidsvalidatorrc

# Output as JSON
nemar dataset validate ./my-dataset --json
\`\`\`

## Common Errors and Fixes

### Missing dataset_description.json

Create the file in your dataset root:

\`\`\`json
{
  "Name": "My EEG Dataset",
  "BIDSVersion": "1.9.0",
  "DatasetType": "raw",
  "License": "CC BY-NC 4.0",
  "Authors": ["Last, First", "Last2, First2"]
}
\`\`\`

### Invalid Filename

BIDS filenames must follow the pattern:
\`\`\`
sub-<label>[_ses-<label>][_task-<label>][_run-<index>]_<suffix>.<extension>
\`\`\`

Example:
\`\`\`
sub-01_ses-01_task-rest_run-01_eeg.edf
\`\`\`

### Missing Events File

For task data, create an events.tsv:

\`\`\`tsv
onset	duration	trial_type
0.0	0.5	stimulus
1.5	0.5	response
\`\`\`

## Custom Validation Config

Create \`.bidsvalidatorrc\` in your dataset root:

\`\`\`json
{
  "ignore": [
    "/derivatives/"
  ],
  "ignoredFiles": [
    ".DS_Store"
  ]
}
\`\`\`

## Validation Before Upload

Validation runs automatically during upload. To skip (not recommended):

\`\`\`bash
nemar dataset upload ./my-dataset --skip-validation
\`\`\`

!!! warning "Not Recommended"
    Skipping validation may result in a dataset that cannot be properly indexed or used.
`;
}

function generateDownloadingGuide(): string {
  return `# Downloading Datasets

Download NEMAR datasets using git-annex for efficient large file handling.

## Quick Download

\`\`\`bash
# Download dataset (includes all data files)
nemar dataset download nm000104
\`\`\`

This clones the dataset and downloads all data files from S3.

## Download Options

\`\`\`bash
# Download to specific directory
nemar dataset download nm000104 -o ./datasets/

# Clone metadata only (skip large data files)
nemar dataset download nm000104 --no-data

# Parallel downloads for large datasets
nemar dataset download nm000104 -j 8
\`\`\`

## Resume an Interrupted Download

If a download is interrupted, rerun with \`--resume\` instead of deleting the
partial clone:

\`\`\`bash
nemar dataset download nm000104 --resume
\`\`\`

\`--resume\` validates the existing directory is a git-annex clone of the same
dataset, refuses to proceed when the working tree is dirty, and refuses when
the local \`DatasetVersion\` has fallen behind the remote (use \`--update\`
instead). It then re-runs \`git annex get\` so only missing files are pulled.

## Update to a Newer Version

When upstream publishes a new version, pull only the diff:

\`\`\`bash
nemar dataset download nm000104 --update           # pulls just the changed files
nemar dataset download nm000104 --update --prune   # also drops orphaned annex objects
\`\`\`

\`--update\` reads the local and remote \`DatasetVersion\`, fast-forwards to the
remote \`HEAD\`, and runs \`git annex get\` only on the annex keys that changed
between the two manifests. For a 5 GB dataset with a 20 MB metadata bump, this
typically transfers ~20 MB instead of the whole dataset. Non-fast-forward
merges (you have local commits) are refused; use \`nemar dataset update\`
(the PR workflow) to push them first.

## BIDS Entity Filters

Pull only the parts of the dataset you need. The clone retains the full
git-annex tree (so the result is still a structurally valid BIDS dataset),
but only matching files have content locally. You can \`git annex get <path>\`
later to pull more.

\`\`\`bash
# Specific subjects only (auto-prefix; "01" == "sub-01")
nemar dataset download nm000104 --subjects sub-01,02

# A single task across all subjects
nemar dataset download nm000104 --tasks rest

# Subjects, tasks, and datatypes intersected
nemar dataset download nm000104 \\
  --subjects 01,02 --tasks rest --datatypes eeg

# Runs (unpadded 1-9 match both run-1 and run-01)
nemar dataset download nm000104 --runs 1,2

# Sessions
nemar dataset download nm000104 --sessions ses-pre,post

# Raw glob pass-through
nemar dataset download nm000104 --include 'sub-01/eeg/*.edf,*.json'
nemar dataset download nm000104 --exclude 'derivatives/**,sourcedata/**'
\`\`\`

| Flag | Comma-list values | Maps to |
|---|---|---|
| \`--subjects\` | \`sub-01,02\` | \`sub-01/**\`, \`sub-02/**\` |
| \`--sessions\` | \`ses-pre,post\` | \`**/ses-pre/**\`, \`**/ses-post/**\` |
| \`--tasks\` | \`rest,nback\` | \`**/*_task-rest_*\`, \`**/*_task-nback_*\` |
| \`--runs\` | \`1,2\` | \`**/*_run-1_*\`, \`**/*_run-01_*\`, ... |
| \`--datatypes\` | \`eeg,emg\` | \`**/eeg/**\`, \`**/emg/**\` |
| \`--include\` | raw glob list | \`--include\` pass-through |
| \`--exclude\` | raw glob list | \`--exclude\` pass-through |

Filters compose with \`--update\` (only changed files inside the filter scope
are pulled). They cannot be combined with \`--no-data\`, since filters imply
data download.

## Clone vs Download

For large datasets, you may want to clone first and get files selectively:

\`\`\`bash
# Clone metadata only
nemar dataset clone nm000104

# Get specific files later
cd nm000104
nemar dataset get sub-01/

# Get specific modality
nemar dataset get sub-01/eeg/
\`\`\`

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

\`\`\`bash
# See what files exist but aren't downloaded
git annex find --not --in here

# See what's downloaded
git annex find --in here
\`\`\`

### Free Space

Drop files you no longer need locally:

\`\`\`bash
# Drop specific files (keeps remote copies)
nemar dataset drop sub-01/eeg/sub-01_task-rest_eeg.edf

# Drop all local copies
nemar dataset drop
\`\`\`

## Troubleshooting

### "Permission denied" Error

Ensure you're logged in:

\`\`\`bash
nemar auth status --refresh
\`\`\`

### Slow Download

For large datasets, downloads happen from S3. Check your connection and try
increasing parallelism with \`-j 8\`.

### "Content not available" Error

The file may have been removed or moved. Try pulling the latest changes:

\`\`\`bash
git pull
nemar dataset get <file>
\`\`\`
`;
}

function generateConfigDoc(): string {
  return `# Configuration

NEMAR CLI configuration and settings.

## Config File Location

| OS | Path |
|----|------|
| macOS | \`~/.config/nemar/config.json\` |
| Linux | \`~/.config/nemar/config.json\` |
| Windows | \`%APPDATA%\\nemar\\config.json\` |

## Config Structure

\`\`\`json
{
  "apiKey": "nemar_...",
  "username": "johndoe",
  "email": "john@example.com",
  "githubUsername": "johndoe"
}
\`\`\`

## Environment Variables

Environment variables override config file settings:

| Variable | Description |
|----------|-------------|
| \`NEMAR_API_KEY\` | API key for authentication |
| \`NEMAR_API_URL\` | API base URL (default: production) |

## Precedence

1. Command-line flags
2. Environment variables
3. Config file
4. Defaults

## Managing Config

### View Config Location

\`\`\`bash
nemar auth status
# Shows config path
\`\`\`

### Clear Config

\`\`\`bash
nemar auth logout
\`\`\`

### Manual Edit

You can edit the config file directly, but using CLI commands is recommended.
`;
}

function generateEnvDoc(): string {
  return `# Environment Variables

Environment variables for NEMAR CLI configuration.

## Authentication

| Variable | Description | Required |
|----------|-------------|----------|
| \`NEMAR_API_KEY\` | Your NEMAR API key | For auth |

## API Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| \`NEMAR_API_URL\` | API base URL | Production API |

## Usage Examples

### In Shell

\`\`\`bash
export NEMAR_API_KEY=nemar_your_key_here
nemar auth status
\`\`\`

### In Scripts

\`\`\`bash
#!/bin/bash
NEMAR_API_KEY=nemar_your_key_here nemar dataset upload ./data
\`\`\`

### With dotenv

Create a \`.env\` file (don't commit this!):

\`\`\`
NEMAR_API_KEY=nemar_your_key_here
\`\`\`

Then:

\`\`\`bash
source .env
nemar auth status
\`\`\`

## CI/CD Usage

### GitHub Actions

\`\`\`yaml
jobs:
  upload:
    steps:
      - name: Upload dataset
        env:
          NEMAR_API_KEY: \${{ secrets.NEMAR_API_KEY }}
        run: nemar dataset upload ./data
\`\`\`

## Security

!!! warning "Never Commit Secrets"
    - Add \`.env\` to \`.gitignore\`
    - Use secret management in CI/CD
    - Rotate keys if exposed
`;
}

function generateApiDoc(): string {
  return `# API Reference

NEMAR CLI communicates with the NEMAR API. This reference is for advanced users.

## Base URL

\`\`\`
https://api.nemar.org
\`\`\`

## Authentication

All authenticated endpoints require:

\`\`\`
Authorization: Bearer nemar_your_api_key
\`\`\`

## Endpoints

### Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /auth/login | Validate API key |
| POST | /auth/signup | Register new user |
| GET | /auth/me | Get current user |
| POST | /auth/resend-verification | Resend email verification |
| POST | /auth/retrieve-key | Retrieve API key (email + password) |
| POST | /auth/request-key-regeneration | Request key regeneration |
| GET | /auth/confirm-key-regeneration | Confirm key regeneration |

### Datasets

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /datasets | List datasets |
| GET | /datasets/:id | Get dataset details |
| POST | /datasets | Create dataset |
| POST | /datasets/:id/upload | Get upload credentials |

### Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /admin/users | List users |
| GET | /admin/users/pending | List pending approvals |
| POST | /admin/users/:id/approve | Approve user |
| POST | /admin/users/:id/reject | Reject user |
| POST | /admin/datasets/:id/doi/concept | Create concept DOI |

## Error Responses

\`\`\`json
{
  "error": "Error message",
  "details": ["Additional information"]
}
\`\`\`

## Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad request |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Not found |
| 500 | Server error |
`;
}

// Main execution
function main() {
  console.log("Generating NEMAR CLI documentation...\n");

  // Create directory structure
  const dirs = [
    "docs",
    "docs/getting-started",
    "docs/commands",
    "docs/guides",
    "docs/reference",
  ];

  for (const dir of dirs) {
    mkdirSync(join(DOCS_DIR, "..", dir), { recursive: true });
  }

  // Generate static docs
  const staticDocs = [
    { path: "docs/index.md", content: generateIndexDoc() },
    { path: "docs/getting-started/installation.md", content: generateInstallationDoc() },
    { path: "docs/getting-started/quickstart.md", content: generateQuickstartDoc() },
    { path: "docs/getting-started/authentication.md", content: generateAuthDoc() },
    { path: "docs/guides/uploading.md", content: generateUploadingGuide() },
    { path: "docs/guides/validation.md", content: generateValidationGuide() },
    { path: "docs/guides/downloading.md", content: generateDownloadingGuide() },
    { path: "docs/reference/configuration.md", content: generateConfigDoc() },
    { path: "docs/reference/environment.md", content: generateEnvDoc() },
    { path: "docs/reference/api.md", content: generateApiDoc() },
  ];

  for (const { path, content } of staticDocs) {
    const fullPath = join(DOCS_DIR, "..", path);
    writeFileSync(fullPath, content);
    console.log(`  Created ${path}`);
  }

  // Generate command docs from CLI help
  console.log("\nGenerating command documentation from CLI help...\n");

  // Commands overview
  writeFileSync(join(DOCS_DIR, "commands", "index.md"), generateMainDoc());
  console.log("  Created docs/commands/index.md");

  // Individual commands
  for (const [command, config] of Object.entries(commands)) {
    const doc = generateCommandDoc(command, config);
    writeFileSync(join(DOCS_DIR, "commands", `${command}.md`), doc);
    console.log(`  Created docs/commands/${command}.md`);
  }

  console.log("\nDocumentation generated successfully!");
  console.log("\nTo preview: cd docs && mkdocs serve");
  console.log("To build: mkdocs build");
}

main();
