# NEMAR CLI - Development Instructions

## CRITICAL: Live Datasets

**nm000103-nm000107 are LIVE datasets.** Do NOT modify their visibility, S3 data, DOIs, or repo settings during development/testing. They are kept private during dev for maximum control but contain real data.

For E2E testing, use disposable test dataset `nm099999` (already registered in D1 and GitHub). Note: `xx`-prefix datasets are blocked from publishing (sandbox check).

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
- **API URL:** `https://api.osc.earth/nemar` (production)
- **Platform:** Cloudflare Workers + D1 (SQLite)
- **Note:** Old `nemar-api.shirazi-10f.workers.dev` URL is disabled

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
# Configure git-annex to NOT annex workflow files (critical!)
git annex config --set annex.largefiles 'include=*.edf or include=*.bdf or largerthan=100kb'

# Push git-annex branch so clones can see remotes
git push origin git-annex
```
**Key insights:**
- Workflow files stored in git-annex = GitHub can't read them (symlinks)
- `aws s3 cp` doesn't update git-annex tracking; use `git annex copy --from --to` or register URLs
- Always push `git-annex` branch for clone compatibility

## CLI Commands (Target Structure)
```bash
nemar auth login          # Interactive login
nemar auth signup         # New user registration
nemar auth status         # Check authentication status
nemar auth logout         # Clear credentials

nemar dataset validate    # Validate BIDS dataset
nemar dataset upload      # Upload dataset to NEMAR
nemar dataset download    # Download dataset
nemar dataset status      # Check dataset status
nemar dataset list        # List user's datasets

nemar admin approve       # Approve pending user (admin)
nemar admin users         # List users (admin)
nemar admin revoke        # Revoke user access (admin)
nemar admin doi create    # Create concept DOI (admin)
```

## External Resources
- OpenNeuro CLI: https://github.com/OpenNeuroOrg/openneuro
- BIDS Validator: https://github.com/bids-standard/bids-validator
- DataLad: https://www.datalad.org/
- Existing tools: ~/Documents/git/EMG-2-BIDS/tools/

---
Remember: Build maintainable systems. Check .rules/ for detailed guidance.
