# Validated Workflows

> **Decisions recorded:** [ADR 0015 - git-annex takes data files only](decisions/0015-git-annex-annexes-data-only-metadata-stays-in-git.md), [ADR 0001 - Changes go through pull requests](decisions/0001-dataset-changes-go-through-pull-requests.md).

This document contains workflows that have been **tested and validated** through prototyping. These are proven to work and should be used as reference during implementation.

> **Important:** Only add workflows here after successful prototyping. Each workflow should include the validation date and test conditions.

---

## Table of Contents
1. [Git-Annex Staging → Final Workflow](#1-git-annex-staging--final-workflow)
2. [GitHub Branch Protection](#2-github-branch-protection)
3. [GitHub Actions S3 Copy on PR Merge](#3-github-actions-s3-copy-on-pr-merge)
4. [Full E2E PR Workflow](#4-full-e2e-pr-workflow)
5. [Git-Annex in GitHub Actions](#5-git-annex-in-github-actions)
6. [IAM Eventual Consistency Fix](#6-iam-eventual-consistency-fix)
7. [GitHub Invitation Auto-Accept](#7-github-invitation-auto-accept)
8. [Commit Authorship for NEMAR Users](#8-commit-authorship-for-nemar-users)

---

## 1. Git-Annex Staging → Final Workflow

**Validated:** 2026-01-14
**Prototype:** Prototype 1 from `.context/prototyping_plan.md`
**Purpose:** Stage data files in temporary S3 location during PR review, then move to final location on merge while maintaining git-annex integrity.

### Prerequisites
- DataLad and git-annex installed
- AWS credentials configured (`aws configure` or environment variables)
- Access to S3 bucket (`nemar`)

### Key Insight
**Use `git annex copy --from <source> --to <dest>` instead of `aws s3 cp`**

The native git-annex approach is superior because:
- Handles location tracking automatically
- No manual `setpresentkey` calls needed
- Single command for transfer
- Avoids `annex-uuid` conflicts

### Validated Commands

#### Step 1: Initialize Staging Remote
```bash
# Set AWS credentials for git-annex
export AWS_ACCESS_KEY_ID=$(aws configure get aws_access_key_id)
export AWS_SECRET_ACCESS_KEY=$(aws configure get aws_secret_access_key)

# Initialize staging remote (use PR number in prefix for isolation)
git annex initremote staging-s3 \
  type=S3 \
  encryption=none \
  bucket=nemar \
  fileprefix=staging/pr-<PR_NUMBER>/ \
  datacenter=us-east-2 \
  publicurl=https://nemar.s3.us-east-2.amazonaws.com
```

#### Step 2: Upload Files to Staging
```bash
# Copy specific files
git annex copy --to staging-s3 path/to/file.edf

# Or copy all annexed files
git annex copy --to staging-s3 .
```

#### Step 3: Verify Upload
```bash
# Check where git-annex thinks files are
git annex whereis <file>

# Verify in S3
aws s3 ls s3://nemar/staging/pr-<PR_NUMBER>/
```

#### Step 4: Initialize Final Remote (After PR Approval, Before Merge)
```bash
# Initialize final remote with dataset ID prefix
git annex initremote final-s3 \
  type=S3 \
  encryption=none \
  bucket=nemar \
  fileprefix=<DATASET_ID>/ \
  datacenter=us-east-2 \
  publicurl=https://nemar.s3.us-east-2.amazonaws.com
```

#### Step 5: Copy Staging → Final (On Merge)
```bash
# Native git-annex copy handles all bookkeeping
git annex copy --from staging-s3 --to final-s3 .
```

#### Step 6: Cleanup Staging (Post-Merge)
```bash
# Delete staging files from S3
aws s3 rm --recursive s3://nemar/staging/pr-<PR_NUMBER>/
```

#### Step 7: Verify Final Location Works
```bash
# Drop local copy
git annex drop <file> --force

# Retrieve from final
git annex get <file> --from final-s3

# Verify content
cat <file>
```

### Test Results

| Test | Result | Notes |
|------|--------|-------|
| Upload to staging | ✓ Pass | Files appear in S3 with correct keys |
| whereis shows staging | ✓ Pass | Public URL displayed correctly |
| Copy staging → final | ✓ Pass | Native git-annex copy works |
| whereis shows both | ✓ Pass | Both locations tracked |
| Delete staging | ✓ Pass | aws s3 rm works |
| Get from final | ✓ Pass | File retrieved after staging deleted |
| Content integrity | ✓ Pass | File content unchanged |

### Gotchas and Warnings

1. **Don't copy `annex-uuid` file manually**
   - Each S3 prefix needs its own unique UUID
   - Using `aws s3 cp --recursive` copies the UUID file
   - This causes "bucket already used by different remote" error
   - Solution: Use `git annex copy --from --to` which avoids this

2. **AWS credentials for git-annex**
   - Git-annex doesn't read `~/.aws/credentials` automatically
   - Must export `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
   - Or use: `export AWS_ACCESS_KEY_ID=$(aws configure get aws_access_key_id)`

3. **Remote naming convention**
   - Use consistent names: `staging-s3`, `final-s3`
   - Or per-dataset: `staging-pr-123`, `nm000104-s3`

### Architecture Implications

- **PR Isolation:** Each PR gets its own staging prefix (`staging/pr-123/`)
- **On Merge:** GitHub Action runs `git annex copy --from staging-s3 --to final-s3`
- **Final Location:** Dataset ID prefix (`nm000104/`)
- **Cleanup:** GitHub Action deletes staging after successful copy
- **Closed Without Merge:** GitHub Action just deletes staging

### Alternative Approach (Also Validated, But Not Preferred)

Manual approach using `aws s3 cp` + `setpresentkey`:

```bash
# Copy files (excluding annex-uuid)
aws s3 cp --recursive --exclude "annex-uuid" \
  s3://nemar/staging/pr-123/ \
  s3://nemar/nm000104/

# Get file key and final remote UUID
KEY=$(git annex lookupkey <file>)
FINAL_UUID=$(git config remote.final-s3.annex-uuid)

# Register file as present in final
git annex setpresentkey "$KEY" "$FINAL_UUID" 1
```

This works but is more error-prone and requires manual bookkeeping.

---

## 2. GitHub Branch Protection

**Validated:** 2026-01-14
**Prototype:** Prototype 2 from `.context/prototyping_plan.md`
**Purpose:** Enforce PR-mandatory workflow where all changes to main branch require pull requests with approval.

### Prerequisites
- GitHub CLI (`gh`) authenticated with org admin access
- Repository must be **public** (or org needs GitHub Team/Enterprise for private repos)
- Initial commit on main branch before applying protection

### Key Insight
**Branch protection with `enforce_admins=true` blocks everyone, including org owners**

This ensures:
- No one can bypass the PR requirement
- Even admin `--admin` flag on `gh pr merge` is blocked
- Self-approval is not allowed by GitHub

### Validated Commands

#### Step 1: Create Repository (if needed)
```bash
# Create repo in org
gh repo create nemarDatasets/<repo-name> --public --description "Description"

# Clone and create initial commit
git clone https://github.com/nemarDatasets/<repo-name>.git
cd <repo-name>
echo "# Repo Name" > README.md
git add README.md
git commit -m "Initial commit"
git push origin main
```

#### Step 2: Apply Branch Protection
```bash
gh api -X PUT /repos/nemarDatasets/<repo-name>/branches/main/protection \
  --input - << 'EOF'
{
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "enforce_admins": true,
  "required_status_checks": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

#### Step 3: Enable Auto-Merge (Optional but Recommended)
```bash
gh repo edit nemarDatasets/<repo-name> --enable-auto-merge
```

#### Step 4: Verify Protection
```bash
# Check protection rules
gh api /repos/nemarDatasets/<repo-name>/branches/main/protection

# Try direct push (should fail)
echo "test" >> README.md && git add . && git commit -m "test" && git push
# Expected: GH006: Protected branch update failed
```

### Test Results

| Test | Result | Notes |
|------|--------|-------|
| Direct push to main | ✓ Blocked | `GH006: Protected branch update failed` |
| PR merge without approval | ✓ Blocked | `base branch policy prohibits the merge` |
| Admin bypass (`--admin`) | ✓ Blocked | `At least 1 approving review is required` |
| Self-approval | ✓ Blocked | `Can not approve your own pull request` |
| Auto-merge enable | ✓ Works | Waits for approval, then merges |
| PR status shows BLOCKED | ✓ Works | `mergeStateStatus: BLOCKED` |

### Protection Settings Explained

| Setting | Value | Effect |
|---------|-------|--------|
| `required_approving_review_count` | 1 | At least 1 approval needed |
| `dismiss_stale_reviews` | true | New commits invalidate old approvals |
| `enforce_admins` | true | Admins can't bypass (critical!) |
| `allow_force_pushes` | false | No force push to main |
| `allow_deletions` | false | Can't delete main branch |
| `required_status_checks` | null | No CI checks required (add later) |

### Gotchas and Warnings

1. **✅ RESOLVED: Private repos now supported with GitHub Team**
   - Branch protection on private repos requires GitHub Team/Enterprise
   - nemarDatasets org upgraded to GitHub Team via GitHub Education (free for educators)
   - **Validated 2026-01-14:** Private repo `prototype-private-test` with full branch protection working

2. **Initial commit required before protection**
   - Can't protect a branch that doesn't exist
   - Push at least one commit to main first

3. **Self-approval not possible**
   - GitHub blocks approving your own PR
   - Need at least 2 people for testing, or disable temporarily

4. **Auto-merge must be enabled at repo level**
   - Run `gh repo edit --enable-auto-merge` first
   - Then PRs can use `gh pr merge --auto`

### Architecture Implications

- **All dataset changes via PR:** Direct pushes blocked for everyone
- **Approval workflow:** At least 1 reviewer must approve
- **Auto-merge:** Users can enable auto-merge, PR merges when approved
- **Status checks:** Can add BIDS validation as required check later
- **Collaboration:** Any GitHub user can fork and submit PRs

### Adding Status Checks (For Later)

To require BIDS validation before merge:
```bash
gh api -X PUT /repos/nemarDatasets/<repo>/branches/main/protection \
  --input - << 'EOF'
{
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "enforce_admins": true,
  "required_status_checks": {
    "strict": true,
    "contexts": ["bids-validation"]
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

---

## 3. GitHub Actions S3 Copy on PR Merge

**Validated:** 2026-01-14
**Prototype:** Prototype 3 from `.context/prototyping_plan.md`
**Purpose:** Automatically copy data from S3 staging to final location when PR is merged, and cleanup staging on both merge and close.

### Prerequisites
- GitHub repository with Actions enabled
- AWS credentials stored as repository secrets (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
- S3 bucket with appropriate permissions

### Key Insight
**Use conditional jobs with `if: github.event.pull_request.merged == true/false`**

The workflow has two jobs:
- `copy-data`: Runs only when PR is merged (copies staging → final, then cleans up)
- `cleanup-only`: Runs only when PR is closed without merge (just cleans up)

### Validated Workflow File

`.github/workflows/pr-merge.yml`:
```yaml
name: PR Merge - Copy Data

on:
  pull_request:
    types: [closed]
    branches: [main]

jobs:
  copy-data:
    # Only run if PR was actually merged
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - name: Configure AWS
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-2

      - name: Copy staging to final
        run: |
          STAGING="s3://nemar/staging/pr-${{ github.event.pull_request.number }}/"
          FINAL="s3://nemar/<dataset-id>/"

          if aws s3 ls "$STAGING" 2>/dev/null | head -1; then
            echo "Copying staging to final..."
            aws s3 cp --recursive "$STAGING" "$FINAL"
          else
            echo "No staging files (metadata-only PR)"
          fi

      - name: Cleanup staging
        run: |
          STAGING="s3://nemar/staging/pr-${{ github.event.pull_request.number }}/"
          if aws s3 ls "$STAGING" 2>/dev/null | head -1; then
            aws s3 rm --recursive "$STAGING"
          fi

  cleanup-only:
    # Runs when PR is closed WITHOUT merging
    if: github.event.pull_request.merged == false
    runs-on: ubuntu-latest
    steps:
      - name: Configure AWS
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-2

      - name: Cleanup staging
        run: |
          STAGING="s3://nemar/staging/pr-${{ github.event.pull_request.number }}/"
          if aws s3 ls "$STAGING" 2>/dev/null | head -1; then
            aws s3 rm --recursive "$STAGING"
            echo "Staging cleaned up"
          fi
```

### Setting Up Repository Secrets

```bash
# Get AWS credentials and set as secrets
AWS_KEY=$(aws configure get aws_access_key_id)
echo "$AWS_KEY" | gh secret set AWS_ACCESS_KEY_ID --repo <org>/<repo>

AWS_SECRET=$(aws configure get aws_secret_access_key)
echo "$AWS_SECRET" | gh secret set AWS_SECRET_ACCESS_KEY --repo <org>/<repo>

# Verify secrets are set
gh secret list --repo <org>/<repo>
```

### Test Results

| Test | Result | Notes |
|------|--------|-------|
| Action triggers on PR merge | ✓ Pass | `copy-data` job runs |
| Action triggers on PR close | ✓ Pass | `cleanup-only` job runs |
| Correct job selection | ✓ Pass | Conditional `if` works correctly |
| S3 copy staging → final | ✓ Pass | Files appear in final location |
| S3 cleanup after merge | ✓ Pass | Staging deleted after copy |
| S3 cleanup on close (no merge) | ✓ Pass | Staging deleted, no copy |
| No copy on close without merge | ✓ Pass | Final location unchanged |

### Gotchas and Warnings

1. **Trigger is `pull_request: [closed]`, not `[merged]`**
   - GitHub doesn't have a `merged` event type
   - Must use `closed` and check `github.event.pull_request.merged` in job condition

2. **Check if staging exists before operations**
   - Not all PRs have data changes (some are metadata-only)
   - Use `aws s3 ls` check before copy/delete to avoid errors

3. **AWS credentials must be repository secrets**
   - Set via `gh secret set` or GitHub UI
   - Secrets are masked in logs

4. **Job summary is helpful for audit trail**
   - Use `$GITHUB_STEP_SUMMARY` to post results
   - Shows what was copied/cleaned in PR view

### Architecture Implications

- **Automatic data management:** No manual intervention needed after PR merge
- **Staging isolation:** Each PR has its own staging prefix (`staging/pr-<number>/`)
- **Cleanup on both outcomes:** Staging is cleaned whether PR is merged or closed
- **Audit trail:** GitHub Actions logs show exactly what happened
- **Scalable:** Works for any number of concurrent PRs

### Integration with Git-Annex Workflow

For the full workflow (combining Prototypes 1 and 3):

1. User creates PR with data changes
2. CLI uploads data to `s3://nemar/staging/pr-<number>/`
3. CLI pushes git-annex pointers to branch
4. Reviewers approve PR
5. PR is merged
6. **GitHub Action runs:**
   - Copies `staging/pr-<number>/` → `<dataset-id>/`
   - Cleans up staging
7. Git-annex in main branch now points to final location

---

## 4. Full E2E PR Workflow

**Validated:** 2026-01-14
**Prototype:** Prototype 4 from `.context/prototyping_plan.md`
**Purpose:** Complete end-to-end workflow combining DataLad, S3 staging, GitHub Actions, and branch protection.

### Prerequisites
- DataLad and git-annex installed locally
- AWS credentials configured
- GitHub CLI authenticated with org access
- Repository with branch protection and GitHub Actions

### Key Insights

1. **Git-annex largefiles configuration is critical**
   - By default, git-annex tracks ALL files including workflow YAML
   - GitHub can't read workflow files stored as git-annex symlinks
   - Must configure with explicit metadata exclusions (see `src/lib/git-annex.ts` DATA_EXTENSIONS and METADATA_EXCLUSIONS)

2. **GitHub Actions S3 copy doesn't update git-annex**
   - `aws s3 cp` moves the file but git-annex doesn't know
   - Fresh clones can't find the file in the final location
   - Need to register URLs or use git-annex native commands

3. **Public URL works for downloads**
   - Files with `publicurl` configured can be fetched via `web` remote
   - Use `git annex addurl` to register if needed

### Complete Workflow Steps

#### Setup (One-time per dataset)

```bash
# 1. Create DataLad dataset
datalad create my-dataset
cd my-dataset

# 2. Configure git-annex: annex data files, never metadata (see src/lib/git-annex.ts for canonical pattern)
git annex config --set annex.largefiles '(include=*.edf or include=*.bdf or include=*.set or include=*.fif or include=*.vhdr or include=*.eeg or include=*.cnt or include=*.fdt or largerthan=100kb) and exclude=*.tsv and exclude=*.json and exclude=*.md and exclude=*.txt and exclude=*.yml and exclude=*.yaml and exclude=README* and exclude=LICENSE* and exclude=CHANGES* and exclude=.bidsignore and exclude=.gitignore'

# 3. Add workflow files (will be in git, not git-annex)
mkdir -p .github/workflows
# ... create workflow file ...
git add .github/workflows/
git commit -m "Add workflow"

# 4. Initialize S3 final remote
git annex initremote nemar-s3 type=S3 encryption=none bucket=nemar \
  fileprefix=<dataset-id>/ datacenter=us-east-2 \
  publicurl=https://nemar.s3.us-east-2.amazonaws.com

# 5. Push to GitHub
git remote add origin https://github.com/nemarDatasets/<dataset-id>.git
git push -u origin main
git push origin git-annex

# 6. Apply branch protection
gh api -X PUT /repos/nemarDatasets/<dataset-id>/branches/main/protection \
  --input - << 'EOF'
{
  "required_pull_request_reviews": {"required_approving_review_count": 1},
  "enforce_admins": true,
  ...
}
EOF
```

#### Contributor Workflow (Adding Data via PR)

```bash
# 1. Clone dataset
datalad clone https://github.com/nemarDatasets/<dataset-id>.git
cd <dataset-id>

# 2. Create branch
git checkout -b add-new-data

# 3. Add new data files
mkdir -p sub-XXX/eeg
cp /source/data.edf sub-XXX/eeg/
datalad save -m "Add subject XXX"

# 4. Initialize staging remote for this PR
git annex initremote staging-s3 type=S3 encryption=none bucket=nemar \
  fileprefix=staging/pr-<number>/ datacenter=us-east-2 \
  publicurl=https://nemar.s3.us-east-2.amazonaws.com

# 5. Upload to staging
git annex copy --to staging-s3 sub-XXX/

# 6. Push and create PR
git push origin add-new-data
git push origin git-annex
gh pr create --title "Add subject XXX" --body "Data staged at s3://nemar/staging/pr-<number>/"
```

#### Automated Workflow (On PR Merge)

GitHub Action copies staging → final and cleans up staging.

**Important:** The current workflow uses `aws s3 cp`. For full git-annex integration, should use:
```bash
# In GitHub Action, with git-annex installed:
git annex copy --from staging-s3 --to nemar-s3 .
```

#### Fresh Clone (Consumer)

```bash
# 1. Clone dataset
datalad clone https://github.com/nemarDatasets/<dataset-id>.git
cd <dataset-id>

# 2. Enable S3 remote
datalad siblings enable -s nemar-s3

# 3. Get data files
datalad get sub-XXX/eeg/
```

### Test Results

| Test | Result | Notes |
|------|--------|-------|
| DataLad dataset creation | ✓ Pass | Works with git-annex |
| S3 final remote setup | ✓ Pass | publicurl configured |
| Workflow file in git (not annex) | ✓ Pass | After largefiles config |
| Branch protection | ✓ Pass | Blocks direct push |
| Staging upload | ✓ Pass | Data in staging prefix |
| GitHub Action trigger | ✓ Pass | Runs on PR merge |
| S3 copy staging → final | ✓ Pass | Files copied |
| Staging cleanup | ✓ Pass | Staging deleted |
| Fresh clone data retrieval | ⚠️ Partial | Works via URL, needs git-annex tracking fix |

### Gotchas and Warnings

1. **⚠️ Configure largefiles BEFORE adding workflow files**
   - If workflow is annexed, GitHub can't read it
   - Fix: `git annex unannex .github/workflows/*` then re-add

2. **⚠️ Git-annex tracking after S3 copy**
   - `aws s3 cp` doesn't update git-annex location tracking
   - Fresh clones won't find files in final remote
   - Solution: Use `git annex copy --from --to` in Action, or register URLs

3. **Git-annex branch must be pushed**
   - Push `git-annex` branch so clones can see remote configurations
   - `git push origin git-annex`

4. **Staging remote per PR**
   - Each PR needs its own staging remote with unique prefix
   - Prefix matches PR number: `staging/pr-<number>/`

### Architecture Implications

- **Git-annex in GitHub Actions:** For full integration, install git-annex in Actions
- **URL registration:** Alternative to git-annex in Actions; register final URLs post-copy
- **Public access:** S3 files accessible via publicurl without AWS credentials
- **Workflow files:** Must be in git proper, not git-annex

### Recommended Largefiles Configuration

See `src/lib/git-annex.ts` (DATA_EXTENSIONS + METADATA_EXCLUSIONS) for the canonical pattern.

```bash
git annex config --set annex.largefiles '(include=*.edf or include=*.bdf or include=*.set or include=*.fif or include=*.vhdr or include=*.eeg or include=*.cnt or include=*.fdt or largerthan=100kb) and exclude=*.tsv and exclude=*.json and exclude=*.md and exclude=*.txt and exclude=*.yml and exclude=*.yaml and exclude=README* and exclude=LICENSE* and exclude=CHANGES* and exclude=.bidsignore and exclude=.gitignore'
```

This ensures:
- EEG/MEG data files -> git-annex (S3)
- Metadata (TSV, JSON, MD, txt, yml) -> always git (GitHub), regardless of size
- tsv.gz -> annexed (compressed data; `exclude=*.tsv` doesn't match `*.tsv.gz`)

---

## 5. Git-Annex in GitHub Actions

**Validated:** 2026-01-14
**Prototype:** Prototype 5 from `.context/prototyping_plan.md`
**Purpose:** Install and run git-annex within GitHub Actions to enable native git-annex operations (copy, get, drop) in automated workflows.

### Prerequisites
- GitHub repository with Actions enabled
- AWS credentials stored as repository secrets (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
- S3 bucket with appropriate permissions

### Key Insights

1. **git-annex is available via apt-get on ubuntu-latest**
   - Version 10.20240129 available in Ubuntu repos
   - Simple `apt-get install -y git-annex`

2. **Git config required before commits**
   - GitHub Actions runner has no git identity
   - Must set `user.email` and `user.name` before any commits

3. **signature=v4 required for us-east-2 S3**
   - Default S3 signature version doesn't work with us-east-2
   - Must add `signature=v4` to initremote command

### Validated Workflow File

`.github/workflows/test-gitannex.yml`:
```yaml
name: Test Git-Annex in Actions

on:
  push:
    branches: [main]
  pull_request:
    types: [closed]
    branches: [main]
  workflow_dispatch:  # Allow manual trigger

jobs:
  test-gitannex:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Install git-annex
        run: |
          sudo apt-get update
          sudo apt-get install -y git-annex
          echo "Git-annex version:"
          git annex version

      - name: Configure AWS
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-2

      - name: Configure git
        run: |
          git config --global user.email "actions@github.com"
          git config --global user.name "GitHub Actions"

      - name: Test git-annex with S3
        run: |
          # Initialize git-annex in this repo
          git annex init "github-actions"

          # Create a test file
          echo "Test data from GitHub Actions - $(date)" > testfile.txt
          git annex add testfile.txt
          git commit -m "Add test file"

          # Initialize S3 remote (signature=v4 required for us-east-2)
          git annex initremote test-s3 \
            type=S3 \
            encryption=none \
            bucket=nemar \
            fileprefix=gitannex-action-test/ \
            datacenter=us-east-2 \
            signature=v4 \
            publicurl=https://nemar.s3.us-east-2.amazonaws.com

          # Copy to S3
          git annex copy --to test-s3 testfile.txt

          # Verify
          echo "=== whereis output ==="
          git annex whereis testfile.txt

          # Drop local and get from S3
          git annex drop testfile.txt --force
          git annex get testfile.txt --from test-s3

          echo "=== File content after round-trip ==="
          cat testfile.txt

          echo "### Git-annex Test Results" >> $GITHUB_STEP_SUMMARY
          echo "- Installation: ✓ Success" >> $GITHUB_STEP_SUMMARY
          echo "- S3 remote init: ✓ Success" >> $GITHUB_STEP_SUMMARY
          echo "- Upload to S3: ✓ Success" >> $GITHUB_STEP_SUMMARY
          echo "- Download from S3: ✓ Success" >> $GITHUB_STEP_SUMMARY

      - name: Cleanup S3
        if: always()
        run: |
          aws s3 rm --recursive s3://nemar/gitannex-action-test/ || true
```

### Test Results

| Test | Result | Notes |
|------|--------|-------|
| apt-get install git-annex | ✓ Pass | Version 10.20240129 installed |
| git annex init | ✓ Pass | Repository initialized |
| git annex add + commit | ✓ Pass | After setting git config |
| S3 initremote with signature=v4 | ✓ Pass | Required for us-east-2 |
| git annex copy --to S3 | ✓ Pass | File uploaded |
| git annex whereis | ✓ Pass | Shows S3 location |
| git annex drop | ✓ Pass | Local copy removed |
| git annex get --from S3 | ✓ Pass | File retrieved |
| Content integrity | ✓ Pass | File unchanged after round-trip |
| S3 cleanup | ✓ Pass | Test files removed |

### Gotchas and Warnings

1. **⚠️ Git config MUST be set before commits**
   - Error: `Author identity unknown`
   - Fix: Add step to set `git config --global user.email` and `user.name`
   - Must run BEFORE any `git commit` command

2. **⚠️ signature=v4 required for us-east-2**
   - Error: `The authorization mechanism you have provided is not supported. Please use AWS4-HMAC-SHA256`
   - Fix: Add `signature=v4` to initremote command
   - This is required for any AWS region that doesn't support v2 signatures

3. **fetch-depth: 0 for full history**
   - Required if you need git-annex branch history
   - Without it, git-annex operations may fail on existing repos

4. **Cleanup with if: always()**
   - Always cleanup test files even if earlier steps fail
   - Prevents S3 bucket pollution from failed runs

### Architecture Implications

- **Native git-annex in CI:** Can use `git annex copy --from --to` instead of `aws s3 cp`
- **Proper location tracking:** Git-annex bookkeeping stays consistent
- **No manual setpresentkey:** Native commands handle location tracking
- **Workflow integration:** Can combine with PR merge workflow for full automation

### Production Workflow Pattern

For the PR merge workflow with git-annex:

```yaml
- name: Copy staging to final with git-annex
  run: |
    # Enable remotes
    git annex enableremote staging-s3 || true
    git annex enableremote final-s3 || true

    # Copy all files from staging to final
    git annex copy --from staging-s3 --to final-s3 .

    # Update git-annex branch
    git push origin git-annex

- name: Cleanup staging
  if: always()
  run: |
    aws s3 rm --recursive s3://nemar/staging/pr-${{ github.event.pull_request.number }}/ || true
```

This ensures git-annex location tracking stays accurate across the entire workflow.

---

## 6. IAM Eventual Consistency Fix

**Validated:** 2026-01-20
**Issue:** S3 uploads failing with 403 AccessDenied immediately after IAM policy updates
**Purpose:** Handle AWS IAM eventual consistency during dataset creation and upload.

### Problem

When a new dataset is created, the backend updates the user's IAM policy to grant access to the new S3 prefix. However, AWS IAM is eventually consistent, meaning policy changes can take several seconds to propagate globally. This causes 403 AccessDenied errors when the CLI immediately tries to upload files.

### Key Insight

**Admin users don't hit this issue** because they have `AllowFullBucketAccess` (access to `nemar/*`). Regular users have prefix-scoped policies that are updated per-dataset, triggering the eventual consistency delay.

### Solution Implemented

1. **Initial wait after dataset creation:** 10 seconds (in `sandbox.ts` and `dataset.ts`)
2. **Retry logic for 403 errors:** 4 retries with progressive delays (10s, 15s, 20s, 25s)
3. **Total max wait:** ~70 seconds for IAM propagation

### Validated Code

In `src/lib/datalad.ts`, the `uploadFileWithPresignedUrl` function:
```typescript
// Only retry on 403 AccessDenied (likely IAM propagation delay)
const isIamError = response.status === 403 && errorText.includes("AccessDenied");
if (!isIamError || attempt === maxRetries) {
  return { success: false, error: lastError };
}

// Wait before retry: 10s, 15s, 20s, 25s
const delayMs = initialDelayMs + attempt * 5000;
await new Promise((resolve) => setTimeout(resolve, delayMs));
```

### Test Results

| Test | Result | Notes |
|------|--------|-------|
| Admin upload (yahya) | ✓ Pass | No retries needed (full bucket access) |
| Regular user upload (cool-vibers) | ✓ Pass | With retry logic, succeeds after 1-2 retries |
| Sandbox training on MBA | ✓ Pass | Full workflow completes successfully |

### Architecture Implications

- **No backend changes needed:** Client-side retry handles the delay
- **Transparent to users:** Spinner shows progress, no manual intervention
- **Graceful degradation:** If IAM truly fails, error message shows after max retries

---

## 7. GitHub Invitation Auto-Accept

**Validated:** 2026-01-20
**Issue:** Users added as collaborators must manually accept GitHub invitation before pushing
**Purpose:** Automate invitation acceptance via CLI during upload workflow.

### Problem

When a dataset is created, the backend creates a private GitHub repo and invites the user as a collaborator. The user must accept the invitation before they can push. This adds friction and a potential failure point.

### Key Insight

**GitHub invitations can be accepted via API** using the GitHub CLI:
```bash
# List pending invitations (as the invited user)
gh api /user/repository_invitations

# Accept specific invitation by ID
gh api --method PATCH /user/repository_invitations/{invitation_id}
```

### Validated Commands

```bash
# List all pending invitations
gh api /user/repository_invitations --jq '.[] | {id, repo: .repository.full_name}'

# Accept a specific invitation
gh api --method PATCH /user/repository_invitations/123456789

# Combined: find and accept invitation for a specific repo
INVITATION_ID=$(gh api /user/repository_invitations --jq '.[] | select(.repository.full_name == "nemarDatasets/xx000018") | .id')
gh api --method PATCH /user/repository_invitations/$INVITATION_ID
```

### Test Results

| Test | Result | Notes |
|------|--------|-------|
| List invitations via API | ✓ Pass | Returns JSON array of pending invitations |
| Accept invitation via API | ✓ Pass | Returns 204 No Content on success |
| Push after acceptance | ✓ Pass | User can push to repo |

### Gotchas and Warnings

1. **gh CLI must be authenticated as the invited user**
   - The invitation is for the NEMAR user's GitHub account
   - If `gh` is authenticated as a different account, it won't see the invitation

2. **macOS keyring not accessible via SSH**
   - `gh auth status` may fail via SSH due to keyring access
   - Test invitation acceptance locally or use token-based auth

3. **Invitation acceptance provides natural IAM delay**
   - The time user takes to accept gives IAM policies time to propagate
   - Useful side effect for the eventual consistency issue

### Architecture Implications

- **CLI should auto-accept invitations:** After dataset creation, CLI should find and accept the invitation
- **Requires user's GitHub token:** The user must have authenticated `gh` CLI or provide token
- **Fallback:** If auto-accept fails, prompt user to accept manually via GitHub UI

### Implementation Notes (Issue #41)

To implement in CLI:
1. After dataset creation, list invitations for the current user
2. Find invitation matching the newly created repo
3. Accept via PATCH API call
4. Proceed with git push

---

## 8. Commit Authorship for NEMAR Users

**Validated:** 2026-01-20
**Issue:** Commits authored as admin instead of the uploading user
**Purpose:** Ensure commits are attributed to the correct NEMAR user.

### Problem

Git commits use the identity from local `git config user.name` and `user.email`. If a machine is configured with the admin's identity, all commits will be attributed to the admin regardless of who is uploading the dataset.

### Key Insight

**Git commit authorship is independent of push authentication.** The `--author` flag can override the configured identity:
```bash
git commit --author="username <registered-email>" -m "message"
```

### Solution

Use the NEMAR user's registered email in the commit author:
```bash
# In datalad.ts saveDataset function:
git commit --author="${username} <${email}>" -m "Initial dataset upload"
```

### Test Results

| Test | Result | Notes |
|------|--------|-------|
| Commit with --author flag | ✓ Works | Author overrides git config |
| Push with different gh auth | ✓ Works | Push uses gh CLI auth, commit uses --author |
| GitHub shows correct author | ✓ Works | Commit attributed to specified email |

### Architecture Implications

- **CLI needs user email:** Must fetch from backend or config during upload
- **Backend should return email:** Include user's registered email in API responses
- **Consistent attribution:** All dataset commits should use NEMAR user identity

### Implementation Notes (Issue #41)

1. Fetch user's registered email from backend (or cache in local config)
2. Pass to `saveDataset()` function
3. Use `--author` flag in git commit commands
4. Consider also setting `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` environment variables

---

## Template for New Validated Workflows

```markdown
## N. Workflow Name

**Validated:** YYYY-MM-DD
**Prototype:** Reference to prototype
**Purpose:** What this workflow accomplishes

### Prerequisites
- List requirements

### Validated Commands
```bash
# Step-by-step commands that have been tested
```

### Test Results
| Test | Result | Notes |
|------|--------|-------|

### Gotchas and Warnings
1. Issues discovered during testing

### Architecture Implications
- How this affects the overall system design
```

---

*Last updated: 2026-01-20 (Added workflows 6, 7, 8 from S3 upload debugging)*
