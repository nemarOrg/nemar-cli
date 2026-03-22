# NEMAR CLI - Development Instructions

## CRITICAL: Live Datasets

**nm000103-nm000107 are LIVE datasets.** Do NOT modify their visibility, S3 data, DOIs, or repo settings during development/testing. They are kept private during dev for maximum control but contain real data.

For E2E testing, use test dataset `nm099999`. It is created on-demand via `POST /admin/datasets/nm099999/reset` (lazy creation if missing). Run the full E2E cycle with:

```bash
nemar admin e2e-test --verbose    # Reset, upload, clone, download, update cycle
nemar admin e2e-test --skip-reset # Reuse existing nm099999 state
```

The E2E test (`src/lib/e2e-test.ts`) runs a 10-step pipeline: reset, prepare fixtures, init git-annex, configure S3/GitHub remotes, upload, push, clone, download+verify, update cycle, cleanup. It uses `test/fixtures/bids-minimal/` as the source BIDS dataset.

Note: `xx`-prefix datasets are blocked from publishing (sandbox check).

## Dataset Deletion

Datasets can be deleted via `DELETE /admin/datasets/:id` or `nemar admin delete-dataset <id>`. Deletion cascades through GitHub repo, S3 objects, and D1 records (`dataset_versions`, `publication_requests`, `datasets`; `dataset_collaborators` auto-cascades via FK).

**Permission model:**
- Unpublished datasets (no DOI, private): admin or owner can delete
- Published datasets (with DOI or public): owner only, requires `force=true`

**Scheduled cleanup** (daily at 3 AM UTC, production only):
- Sandbox (`xx`) datasets: auto-deleted after 14 days
- Stale `nm` datasets: private, no DOI, no active pub requests, inactive 90 days

**Note:** `last_activity_at` must be updated by endpoints that mutate datasets (uploads, version creation, publication requests) to prevent premature staleness. See migration 0011.

## Project Overview
**Purpose:** Command-line interface for NEMAR (Neuroelectromagnetic Data Archive and Tools Resource) dataset management
**Tech Stack:** TypeScript, Bun, Commander.js, DataLad integration
**Repository:** https://github.com/nemarOrg/nemar-cli

### GitHub Organization Structure
- **nemarOrg** - Tooling and infrastructure repos (nemar-cli, nemar-tools, nemar-metadata, neuroschema)
- **nemarDatasets** - Dataset repos only (nm000103, nm000104, etc.)

The backend code (`ORG_NAME = "nemarDatasets"` in `backend/src/services/github.ts`) and publishing scripts intentionally target `nemarDatasets` because that is where dataset repos live. Do not change these to `nemarOrg`.

## Architecture Overview

### Backend Infrastructure
- **API URL:** `https://api.osc.earth/nemar` (production, personal account)
- **SCCN API URL:** `https://nemar-api.sccn-org.workers.dev` (SCCN account, migration in progress)
- **Platform:** Cloudflare Workers + D1 (SQLite)
- **Cloudflare accounts:** Managed via `npx cfman wrangler --account <name>`
  - `neuromechanist` - Personal account (current production)
  - `sccn` - SCCN institutional account (migration target, Epic #314)
- **Wrangler configs:** `backend/wrangler.toml` (personal), `backend/wrangler-sccn.toml` (SCCN)

### S3 Bucket Structure
```
s3://nemar/{datasetId}/
    objects/                     # git-annex content-addressed blobs
    version/                     # version manifests (v1.0.0.json)
    archives/                    # downloadable zip snapshots (v1.0.0.zip)
s3://nemar/staging/pr-{n}/{datasetId}/objects/   # PR staging area
```

### Core Components
1. **Authentication System** - User registration, API tokens, admin approval workflow
2. **Dataset Management** - BIDS validation, DataLad integration, upload/download
3. **Backend Integration** - Cloudflare Workers/D1 for user database, API token management
4. **Storage Integration** - GitHub (metadata), S3 (data files), Zenodo (DOI)

### User Flow
1. User signs up (username, email, password) -> email verification -> admin approval
2. Admin approves -> system generates API token, S3 credentials, GitHub PAT
3. User uploads dataset -> BIDS validation -> private GitHub repo + S3 upload
4. Admin creates concept DOI -> user can version with new DOIs

## Environment Setup
```bash
# Install dependencies
bun install

# Run CLI in development
bun run src/index.ts

# Build for distribution
bun build src/index.ts --outdir dist --target node
```

## Test Machines
For development and testing, two machines are used with different NEMAR accounts:

| Machine | SSH Alias | NEMAR User | Role |
|---------|-----------|------------|------|
| yahyas-mcm | `ssh mcm` | yahya | Admin |
| yahyas-mba | `ssh mba` | cool-vibers | Regular user |

**Important:** On both machines, `nemar` CLI requires an interactive zsh shell:
```bash
# From mcm, run commands on mba:
ssh mba "zsh -i -c 'nemar sandbox'"

# From mba, run commands on mcm:
ssh mcm "zsh -i -c 'nemar admin users'"
```

## Development Workflow
1. **Check context:** Review .context/plan.md for current tasks
2. **Branch:** `git checkout -b feature/short-description`
3. **Code:** Follow patterns in .rules/javascript.md
4. **Test:** Real tests only with `bun test`
5. **Commit:** Atomic, <50 chars, no emojis, no co-author tags
6. **PR:** Reference context and issue

## Version Bumping

**Never edit package.json version manually.** Always use the bump script.

### When to Bump
- **patch**: Bug fixes, minor improvements (0.2.7 -> 0.2.8)
- **minor**: New features, backward compatible (0.2.7 -> 0.3.0)
- **major**: Breaking changes (0.2.7 -> 1.0.0)
- **dev**: Development pre-release for testing (0.2.7 -> 0.2.8-dev)

### Release Workflow
```bash
# 1. Work on feature branch, merge to dev via PR
# 2. When ready to release, bump version on dev branch:
git checkout dev && git pull origin dev
./scripts/bump-version.sh minor    # or patch/major

# 3. Push to dev
git push origin dev

# 4. Create PR from dev to main (or merge existing PR)
# 5. When merged to main, CI automatically:
#    - Tags the release (v0.3.0)
#    - Publishes to npm with 'latest' tag
```

### Bump Commands
```bash
# Release bumps (strips pre-release suffix)
./scripts/bump-version.sh patch    # 0.2.7-dev -> 0.2.8
./scripts/bump-version.sh minor    # 0.2.7-dev -> 0.3.0
./scripts/bump-version.sh major    # 0.2.7 -> 1.0.0

# Pre-release bumps (for testing before release)
./scripts/bump-version.sh dev      # 0.2.7 -> 0.2.8-dev

# Explicit version
./scripts/bump-version.sh 1.0.0    # Set exact version
```

### What the Script Does
1. Updates version in package.json
2. Builds the CLI (`bun run build`)
3. Verifies the built CLI reports correct version
4. Commits the change automatically

If build fails, the script restores the original version.

## Core Principles

### Authentication & Security
- API tokens tied to GitHub PAT and S3 credentials per user
- Token revocation must cascade to all linked credentials
- Never store plaintext passwords; use Argon2 or bcrypt
- Email verification required before admin review

### BIDS Validation
- Use bids-validator library for dataset validation
- Validation must pass before upload proceeds
- Support validation configuration files for dataset-specific rules

### DataLad Integration
- Git-annex for large file management
- S3 special remote for data storage
- GitHub for metadata and version control
- Semantic versioning for releases

### DOI Management
- Concept DOI created by admin only
- Version DOIs can be created by users after concept exists
- Zenodo integration for DOI registration
- DOIs are permanent; require explicit confirmation

## Rules Reference
- `.rules/javascript.md` - TypeScript/Bun standards
- `.rules/git.md` - Commit and branching standards
- `.rules/testing.md` - NO MOCK policy
- `.rules/code_review.md` - PR review process
- `.rules/documentation.md` - Documentation standards
- `.rules/ci_cd.md` - GitHub Actions setup

## Context Files
- `.context/plan.md` - Development phases and tasks
- `.context/ideas.md` - Design decisions and alternatives
- `.context/research.md` - Technical investigations
- `.context/validated_workflows.md` - **Tested and proven workflows** (use these!)
- `.context/prototyping_plan.md` - Prototypes to validate assumptions

## Validated Workflows (Use These!)

The following workflows have been **tested through prototyping** and are proven to work. Always reference `.context/validated_workflows.md` before implementing related features.

### Git-Annex Staging → Final (Validated 2026-01-14)
For PR-based data uploads, use git-annex native copy instead of manual S3 operations:
```bash
# Upload to staging during PR
git annex copy --to staging-s3 <files>

# On PR merge, copy to final (handles bookkeeping automatically)
git annex copy --from staging-s3 --to final-s3 <files>

# Cleanup staging after merge
aws s3 rm --recursive s3://nemar/staging/pr-<NUMBER>/
```
**Key insight:** Don't use `aws s3 cp`; use `git annex copy --from --to` for automatic location tracking.

### GitHub Branch Protection (Validated 2026-01-14)
PR-mandatory workflow using GitHub branch protection:
```bash
# Apply protection (requires public repo or GitHub Team)
gh api -X PUT /repos/nemarDatasets/<repo>/branches/main/protection \
  --input - << 'EOF'
{
  "required_pull_request_reviews": {"required_approving_review_count": 1, "dismiss_stale_reviews": true},
  "enforce_admins": true,
  "required_status_checks": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF

# Enable auto-merge
gh repo edit nemarDatasets/<repo> --enable-auto-merge
```
**Key insight:** `enforce_admins=true` blocks everyone including org owners; self-approval is not allowed.
**✅ Resolved:** nemarDatasets upgraded to GitHub Team via GitHub Education; private repo branch protection validated.

### GitHub Actions S3 Copy (Validated 2026-01-14)
Automatic S3 staging → final copy on PR merge:
```yaml
# .github/workflows/pr-merge.yml
on:
  pull_request:
    types: [closed]  # Not [merged]! Check merged status in job condition
    branches: [main]

jobs:
  copy-data:
    if: github.event.pull_request.merged == true  # Only on actual merge
    # ... copy staging → final, then cleanup

  cleanup-only:
    if: github.event.pull_request.merged == false  # PR closed without merge
    # ... just cleanup staging
```
**Key insight:** Use `pull_request: [closed]` with `if: merged == true/false` condition; GitHub has no `merged` event.

### Git-Annex in GitHub Actions (Validated 2026-01-14)
Install and use git-annex in GitHub Actions for native operations:
```yaml
- name: Install git-annex
  run: sudo apt-get update && sudo apt-get install -y git-annex

- name: Configure git
  run: |
    git config --global user.email "actions@github.com"
    git config --global user.name "GitHub Actions"
```
**Key insights:**
- `signature=v4` required for S3 initremote in us-east-2
- Git config must be set before any commits
- Enables `git annex copy --from --to` in CI

### Full E2E PR Workflow (Validated 2026-01-14)
Critical configuration for DataLad + GitHub + S3:
```bash
# Configure git-annex to annex data files but NEVER metadata (tsv, json, md, etc.)
git annex config --set annex.largefiles '(include=*.edf or include=*.bdf or include=*.set or include=*.fif or include=*.vhdr or include=*.eeg or include=*.cnt or include=*.fdt or largerthan=100kb) and exclude=*.tsv and exclude=*.json and exclude=*.md and exclude=*.txt and exclude=*.yml and exclude=*.yaml and exclude=README* and exclude=LICENSE* and exclude=CHANGES* and exclude=.bidsignore and exclude=.gitignore'

# Push git-annex branch so clones can see remotes
git push origin git-annex
```
**Key insights:**
- Workflow files stored in git-annex = GitHub can't read them (symlinks)
- `aws s3 cp` doesn't update git-annex tracking; use `git annex copy --from --to` or register URLs
- Always push `git-annex` branch for clone compatibility

## CLI Commands
```bash
# Authentication
nemar auth login              # Authenticate with API key
nemar auth signup             # Register new account
nemar auth status             # Check authentication status
nemar auth whoami             # Alias for status
nemar auth switch [username]  # Switch between stored accounts
nemar auth logout             # Remove active account (--all for all)
nemar auth resend-verification # Resend email verification
nemar auth setup-ssh          # Configure SSH for GitHub
nemar auth retrieve-key       # Retrieve API key after approval
nemar auth regenerate-key     # Request new API key

# Dataset Management
nemar dataset validate        # Validate BIDS dataset
nemar dataset upload          # Upload dataset to NEMAR
nemar dataset download        # Download a dataset
nemar dataset status          # Check dataset status
nemar dataset list            # List datasets (--mine for own)
nemar dataset release         # Create version bump PR
nemar dataset update          # Push local changes via PR
nemar dataset request-access  # Request collaborator access
nemar dataset invite          # Invite collaborator
nemar dataset collaborators   # List collaborators
nemar dataset publish request # Request publication
nemar dataset publish status  # Check publication status
nemar dataset clone           # Clone dataset (metadata only)
nemar dataset get             # Download annexed data files
nemar dataset save            # Stage and commit changes
nemar dataset push            # Push commits and data
nemar dataset drop            # Free local copies of annexed files
nemar dataset ci              # Check BIDS validation CI status
nemar dataset manifest        # View version manifests

# Sandbox (required before uploading)
nemar sandbox                 # Run sandbox training
nemar sandbox status          # Check training status
nemar sandbox reset           # Reset for re-training

# Admin (requires admin privileges)
nemar admin users             # List users
nemar admin approve           # Approve pending user
nemar admin revoke            # Revoke user access
nemar admin role              # Change user role (owner only)
nemar admin s3 regenerate-iam # Regenerate AWS credentials
nemar admin s3 lock           # Apply S3 Object Lock
nemar admin repo public       # Make repo public
nemar admin repo private      # Make repo private
nemar admin ci check          # Check CI workflow status
nemar admin ci add            # Deploy CI workflows
nemar admin doi create        # Create concept DOI
nemar admin doi info          # Get DOI info
nemar admin doi update        # Update DOI metadata
nemar admin doi enrich        # Enrich DOI metadata
nemar admin publish list      # List publication requests
nemar admin publish approve   # Approve and publish dataset
nemar admin publish deny      # Deny publication request
nemar admin revert            # Revert dataset to previous version
nemar admin make-public       # Publish dataset (permanent)
nemar admin delete-dataset    # Delete dataset and all resources
nemar admin sync run          # Sync dataset metadata to nemar.org
nemar admin sync status       # Show nemar.org sync status
nemar admin email-preferences show    # Show email notification preferences
nemar admin email-preferences update  # Update email notification preferences

# Root-level shortcuts
nemar login                   # Alias for auth login
nemar logout                  # Alias for auth logout
nemar signup                  # Alias for auth signup
nemar whoami                  # Alias for auth status
nemar switch                  # Alias for auth switch
```

## External Resources
- OpenNeuro CLI: https://github.com/OpenNeuroOrg/openneuro
- BIDS Validator: https://github.com/bids-standard/bids-validator
- DataLad: https://www.datalad.org/
- Existing tools: ~/Documents/git/EMG-2-BIDS/tools/

---
Remember: Build maintainable systems. Check .rules/ for detailed guidance.
