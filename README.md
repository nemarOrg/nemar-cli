# NEMAR CLI

[![Documentation](https://img.shields.io/badge/docs-nemar--cli.pages.dev-blue)](https://nemar-cli.pages.dev)
[![Tests](https://github.com/nemarDatasets/nemar-cli/actions/workflows/test.yml/badge.svg)](https://github.com/nemarDatasets/nemar-cli/actions/workflows/test.yml)

Command-line interface for [NEMAR](https://nemar.org) (Neuroelectromagnetic Data Archive and Tools Resource) dataset management.

**[Documentation](https://nemar-cli.pages.dev)** | [Quick Start](https://nemar-cli.pages.dev/getting-started/quickstart/) | [Commands](https://nemar-cli.pages.dev/commands/)

## Features

- **Dataset Management**: Upload, download, validate, and version BIDS datasets
- **PR-Based Versioning**: All changes require pull requests (main branch protected)
- **Collaborative**: Any NEMAR user can contribute to any dataset
- **BIDS Validation**: Automatic validation before upload and on PRs
- **DOI Integration**: Zenodo DOI creation for dataset versioning
- **DataLad Backend**: Git-annex for large file management with S3 storage

## Installation

Requires [Bun](https://bun.sh) runtime.

```bash
# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Install NEMAR CLI
bun install -g nemar-cli

# Or run directly without installing
bunx nemar-cli
```

### Prerequisites

For dataset operations:

- [DataLad](https://www.datalad.org/) and git-annex
- [Deno](https://deno.land/) (for BIDS validation)
- GitHub account (for PR collaboration)

```bash
# macOS
brew install datalad git-annex deno

# Ubuntu/Debian
sudo apt-get install git-annex
pip install datalad
curl -fsSL https://deno.land/install.sh | sh
```

## Quick Start

```bash
# 1. Sign up for NEMAR
nemar auth signup

# 2. After admin approval, login
nemar auth login

# 3. Validate your BIDS dataset
nemar dataset validate /path/to/dataset

# 4. Upload to NEMAR
nemar dataset upload /path/to/dataset --name "My Dataset"
```

## Architecture Overview

```mermaid
graph TB
    subgraph "User's Machine"
        CLI[NEMAR CLI]
        DL[DataLad]
    end

    subgraph "NEMAR Backend"
        API[Cloudflare Workers API]
        DB[(D1 Database)]
    end

    subgraph "Storage"
        GH[GitHub nemarDatasets]
        S3[(AWS S3)]
        ZEN[Zenodo DOI]
    end

    CLI --> API
    CLI --> DL
    DL --> GH
    DL --> S3
    API --> DB
    API --> GH
    API --> S3
    API --> ZEN
```

## Workflows

### User Registration & Authentication

```mermaid
sequenceDiagram
    participant U as User
    participant CLI as NEMAR CLI
    participant API as Backend
    participant Admin as Admin

    U->>CLI: nemar auth signup
    CLI->>API: POST /auth/signup
    API-->>U: Verification email
    U->>API: Click verification link
    API->>Admin: Notification: new user pending
    Admin->>CLI: nemar admin approve <user>
    CLI->>API: POST /admin/approve
    API-->>U: Approval email with instructions
    U->>CLI: nemar auth login
    CLI->>API: Validate API key
    API-->>CLI: Success + user info
```

### Dataset Upload (New Dataset)

```mermaid
sequenceDiagram
    participant U as User
    participant CLI as NEMAR CLI
    participant API as Backend
    participant GH as GitHub
    participant S3 as AWS S3

    U->>CLI: nemar dataset upload /path
    CLI->>CLI: Validate BIDS locally
    CLI->>API: POST /datasets/create
    API->>API: Assign dataset ID (nm000XXX)
    API->>GH: Create repo (Admin PAT)
    API->>GH: Add user as collaborator
    API->>GH: Set branch protection
    API-->>CLI: Dataset ID + presigned URLs
    CLI->>S3: Upload data files
    CLI->>GH: Push via DataLad
    CLI-->>U: Success! URLs provided
```

### Pull Request Workflow (Contributing to Dataset)

```mermaid
sequenceDiagram
    participant C as Contributor
    participant CLI as NEMAR CLI
    participant API as Backend
    participant S3 as AWS S3
    participant GH as GitHub
    participant GA as GitHub Actions
    participant O as Dataset Owner

    C->>CLI: nemar dataset clone nm000104
    CLI->>GH: datalad clone
    CLI->>S3: datalad get (fetch data)

    Note over C: Make local changes

    C->>CLI: nemar dataset pr create
    CLI->>API: POST /pr/create
    API->>S3: Create staging area
    API-->>CLI: Presigned URLs
    CLI->>S3: Upload to staging/pr-XXX/
    CLI->>GH: Push branch + create PR

    GH->>GA: Trigger: PR opened
    GA->>S3: Fetch staged data
    GA->>GA: Run BIDS validation
    GA->>GH: Report status

    O->>GH: Review PR
    O->>GH: Approve & Merge

    GH->>GA: Trigger: PR merged
    GA->>S3: Copy staging → final
    GA->>S3: Delete staging
    GA->>GH: Post success comment
```

### PR Data Flow (S3 Staging)

```mermaid
graph LR
    subgraph "Before Merge"
        A[Local Files] -->|Upload| B[S3 staging/pr-XXX/]
        B -->|git-annex points to| C[PR Branch]
    end

    subgraph "After Merge"
        B -->|Copy| D[S3 nm000XXX/]
        D -->|git-annex points to| E[Main Branch]
        B -->|Delete| F[Cleaned Up]
    end
```

### Dataset Versioning & DOI

```mermaid
sequenceDiagram
    participant A as Admin
    participant CLI as NEMAR CLI
    participant API as Backend
    participant ZEN as Zenodo
    participant GH as GitHub

    Note over A: First release: Admin creates concept DOI
    A->>CLI: nemar admin doi create nm000104
    CLI->>API: POST /admin/doi/create
    API->>ZEN: Pre-reserve DOI
    API->>GH: Update dataset_description.json
    API->>GH: Create release tag
    API->>ZEN: Upload & publish
    API-->>A: Concept DOI: 10.5281/zenodo.XXX

    Note over A: Later: User creates version DOI
    participant U as User
    U->>CLI: nemar dataset version nm000104 v1.1.0
    CLI->>API: POST /datasets/version
    API->>ZEN: Create new version DOI
    API->>GH: Create release tag
    API-->>U: Version DOI created
```

## Commands

### Authentication

```bash
nemar auth signup          # Register new account
nemar auth login           # Login with API key
nemar auth status          # Check authentication status
nemar auth logout          # Clear credentials
```

### Dataset Management

```bash
nemar dataset validate <path>              # Validate BIDS dataset
nemar dataset upload <path>                # Upload new dataset
nemar dataset download <id> [output]       # Download dataset
nemar dataset clone <id> [output]          # Clone for contribution
nemar dataset list                         # List your datasets
nemar dataset list --all                   # List all NEMAR datasets
nemar dataset status <id>                  # Check dataset status
nemar dataset version <id> <version>       # Create new version with DOI
```

### Pull Requests

```bash
nemar dataset pr create                    # Create PR from local changes
nemar dataset pr list                      # List PRs on your datasets
nemar dataset pr list --mine               # List PRs you created
nemar dataset pr show <pr-id>              # View PR details
nemar dataset pr update <pr-id>            # Push updates to PR
nemar dataset pr close <pr-id>             # Close PR without merging
```

### Admin Commands

```bash
nemar admin users                          # List all users
nemar admin users --pending                # List pending approvals
nemar admin approve <username>             # Approve user
nemar admin revoke <username>              # Revoke user access
nemar admin doi create <dataset-id>        # Create concept DOI
```

## Access Control

| Role | Push Branches | Merge PRs | Delete Repos | Create DOI |
|------|--------------|-----------|--------------|------------|
| NEMAR User | All repos | Own datasets | No | Version DOI |
| Dataset Owner | All repos | Own datasets | No | Version DOI |
| Admin | All repos | All datasets | Yes | Concept DOI |

### Key Principles

1. **PR-Mandatory**: Main branch is protected; all changes require PRs
2. **Collaborative**: Any NEMAR user can create PRs on any dataset
3. **Owner Approval**: Only dataset owner (or admin) can merge PRs
4. **No Deletion**: Users cannot delete repositories or S3 data
5. **Audit Trail**: All changes tracked via PR history

## Storage Architecture

```mermaid
graph TB
    subgraph "GitHub (nemarDatasets org)"
        META[Metadata + git history]
        REL[Releases + tags]
    end

    subgraph "AWS S3 (nemar bucket)"
        FINAL[nm000XXX/ - Published data]
        STAGE[staging/pr-XXX/ - PR data]
    end

    subgraph "Zenodo"
        DOI[DOIs + archived releases]
    end

    META ---|git-annex pointers| FINAL
    STAGE -->|On merge| FINAL
    REL -->|Archive| DOI
```

## Environment Variables

```bash
NEMAR_API_KEY          # API key (alternative to login)
NEMAR_API_URL          # Custom API endpoint (default: https://api.nemar.org)
NEMAR_NO_COLOR         # Disable colored output
```

## Development

```bash
# Clone repository
git clone https://github.com/nemarDatasets/nemar-cli.git
cd nemar-cli

# Install dependencies
bun install

# Run in development
bun run dev

# Run tests
bun test

# Lint
bun run lint

# Build
bun run build
```

## Related Projects

- [NEMAR](https://nemar.org) - Neuroelectromagnetic Data Archive
- [OpenNeuro](https://openneuro.org) - Open platform for neuroimaging data
- [BIDS](https://bids.neuroimaging.io) - Brain Imaging Data Structure
- [DataLad](https://www.datalad.org) - Distributed data management
- [BIDS Validator](https://github.com/bids-standard/bids-validator) - BIDS validation tool

## License

MIT
