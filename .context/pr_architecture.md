# NEMAR Pull Request Architecture

## Novel Design: PR-Mandatory Versioning

Unlike OpenNeuro which allows direct pushes, NEMAR enforces **all changes through pull requests**. This provides:

1. **Audit Trail**: Every change is reviewed and documented
2. **Quality Control**: BIDS validation before merge
3. **Collaboration**: Anyone can propose changes
4. **Rollback Safety**: Easy to revert via PR history

---

## Core Principle: Main Branch is Sacred

```
main branch ──────────────────────────────────────────────►
     │                    │                    │
     │  PR #1 ────────────┤                    │
     │  (approved)        │                    │
     │                    │  PR #2 ────────────┤
     │                    │  (approved)        │
     │                    │                    │

Direct push to main: BLOCKED (even for owner)
```

---

## GitHub Branch Protection Configuration

When NEMAR creates a dataset repository, it automatically configures strict branch protection:

```bash
# API call to set branch protection
gh api -X PUT /repos/nemarDatasets/{dataset_id}/branches/main/protection \
  -f required_pull_request_reviews.required_approving_review_count=1 \
  -f required_pull_request_reviews.dismiss_stale_reviews=true \
  -f required_pull_request_reviews.require_last_push_approval=true \
  -f enforce_admins=true \
  -f required_status_checks.strict=true \
  -f required_status_checks.contexts[]="bids-validation" \
  -f restrictions=null \
  -f allow_force_pushes=false \
  -f allow_deletions=false
```

### Protection Rules Explained

| Rule | Setting | Purpose |
|------|---------|---------|
| `required_approving_review_count` | 1 | At least one approval required |
| `dismiss_stale_reviews` | true | New commits invalidate old approvals |
| `require_last_push_approval` | true | Pusher cannot self-approve |
| `enforce_admins` | true | Even admins must use PRs |
| `required_status_checks` | "bids-validation" | BIDS validation must pass |
| `allow_force_pushes` | false | Cannot rewrite history |
| `allow_deletions` | false | Cannot delete branches |

---

## Roles and Permissions

### How It Works: GitHub Native + Actions

```
┌─────────────────────────────────────────────────────────────────┐
│                     REPOSITORY CREATION                         │
│                                                                 │
│  1. User signs up with GitHub username                          │
│  2. Admin PAT creates repo in nemarDatasets org                 │
│  3. Admin PAT adds user as collaborator (maintain permission)   │
│  4. User can now use GitHub UI/CLI to manage PRs                │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                     PR MERGE FLOW                               │
│                                                                 │
│  1. Owner reviews PR on GitHub (native UI)                      │
│  2. Owner clicks "Merge" on GitHub (or: gh pr merge)            │
│  3. GitHub Action triggers on merge event                       │
│  4. Action copies staging S3 → final S3                         │
│  5. Action updates git-annex pointers                           │
│  6. Action cleans up staging                                    │
└─────────────────────────────────────────────────────────────────┘
```

### Dataset Owner
- **GitHub collaborator with `maintain` permission** on their dataset repo
- Can approve/merge PRs via GitHub UI or `gh pr merge`
- Cannot push directly to main (branch protection)
- Can close PRs without merging
- Uses their own GitHub account (provided during NEMAR signup)

### Contributors (Any NEMAR User)
- **GitHub collaborator with `push` permission** on ALL dataset repos
- Added as collaborator to all repos upon NEMAR account approval
- Can create branches and PRs on any dataset
- Can push to their PR branches
- Cannot merge (only owner/admin can)
- Cannot push directly to main (branch protection)
- Uses their own GitHub account

### NEMAR Admins
- **GitHub org owners** (can override anything)
- Can merge any PR (emergency override)
- Can create concept DOIs
- Can revoke user access

### NEMAR Backend (Admin PAT)
- Creates repositories
- Adds/removes collaborators
- Sets branch protection rules
- Generates presigned URLs for S3 staging
- Does NOT handle PR merges (GitHub Actions does that)

### GitHub Actions (Runs in Repo)
- Triggered on PR events
- Runs BIDS validation on PR open/update
- On PR merge: copies staging → final S3
- On PR close: cleans up staging
- Uses repository secrets for S3 access

---

## PR Workflow: Metadata Only

For changes that only affect metadata files (JSON, TSV, MD):

```
1. Contributor clones dataset
   nemar dataset clone nm000104 ./nm000104

2. Contributor creates branch and makes changes
   cd nm000104
   git checkout -b fix/update-authors
   # Edit dataset_description.json
   git add dataset_description.json
   git commit -m "fix: update author affiliations"

3. Contributor pushes and creates PR
   git push origin fix/update-authors
   nemar dataset pr create --branch fix/update-authors

4. GitHub Actions runs BIDS validation
   [Automated check - must pass]

5. Dataset owner reviews and approves
   [Via GitHub UI or CLI]

6. PR is merged
   [Automatic - no data staging needed]
```

---

## PR Workflow: With Data Changes

For changes that include data files (EDF, BDF, etc.):

```
┌──────────────────────────────────────────────────────────────────────┐
│                         PR WITH DATA WORKFLOW                        │
└──────────────────────────────────────────────────────────────────────┘

Step 1: Clone Dataset
┌─────────────┐
│ Contributor │──► nemar dataset clone nm000104 ./nm000104
└─────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│ Local Copy                          │
│ ├── dataset_description.json        │
│ ├── participants.tsv                │
│ └── sub-001/                        │
│     └── eeg/                        │
│         └── data.edf (from S3)      │
└─────────────────────────────────────┘

Step 2: Make Changes Locally
┌─────────────┐
│ Contributor │──► Add new files, modify existing
└─────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│ Modified Local Copy                 │
│ ├── dataset_description.json        │
│ ├── participants.tsv (modified)     │
│ ├── sub-001/                        │
│ └── sub-002/ ◄──── NEW              │
│     └── eeg/                        │
│         └── data.edf                │
└─────────────────────────────────────┘

Step 3: Create PR (CLI handles complexity)
┌─────────────┐
│ Contributor │──► nemar dataset pr create --message "Add sub-002"
└─────────────┘
       │
       ├──► CLI detects: metadata changes + NEW data files
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│ NEMAR Backend                                                   │
│                                                                 │
│ 1. Create PR record in database                                 │
│    INSERT INTO pull_requests (pr_id, dataset_id, ...)           │
│                                                                 │
│ 2. Create staging area on S3                                    │
│    s3://nemar/staging/pr-{uuid}/nm000104/                       │
│                                                                 │
│ 3. Generate presigned URLs for data uploads                     │
│    - sub-002/eeg/data.edf → presigned PUT URL                   │
│                                                                 │
│ 4. Return staging info to CLI                                   │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│ CLI Actions                                                     │
│                                                                 │
│ 1. Upload data files to staging                                 │
│    curl -X PUT {presigned_url} --data-binary @sub-002/eeg/...   │
│                                                                 │
│ 2. Create git branch with:                                      │
│    - Metadata changes (tracked in git)                          │
│    - git-annex pointers → staging S3 location                   │
│                                                                 │
│ 3. Push branch to GitHub                                        │
│                                                                 │
│ 4. Create GitHub PR via API                                     │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
Step 4: Automated Validation (GitHub Actions)
┌─────────────────────────────────────────────────────────────────┐
│ GitHub Actions Workflow (triggered on PR)                       │
│                                                                 │
│ 1. Checkout PR branch                                           │
│ 2. Configure git-annex to access staging S3                     │
│ 3. Download staged data files                                   │
│ 4. Run BIDS validator                                           │
│ 5. Report status back to PR                                     │
│                                                                 │
│ Status: ✓ BIDS Validation Passed                                │
│         OR                                                      │
│ Status: ✗ BIDS Validation Failed (with details)                 │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
Step 5: Owner Reviews PR
┌──────────────┐
│ Dataset Owner │──► Reviews changes on GitHub
└──────────────┘    - Sees diff of metadata files
                    - Sees list of new/modified data files
                    - Sees BIDS validation status
                    - Can download and inspect data
       │
       ▼
Step 6a: APPROVED - Merge PR
┌─────────────────────────────────────────────────────────────────┐
│ On PR Merge (GitHub Webhook → NEMAR Backend)                    │
│                                                                 │
│ 1. Backend receives webhook notification                        │
│                                                                 │
│ 2. Copy staged data to final location                           │
│    aws s3 cp --recursive \                                      │
│      s3://nemar/staging/pr-{uuid}/nm000104/ \                   │
│      s3://nemar/nm000104/                                       │
│                                                                 │
│ 3. Update git-annex pointers to final S3 location               │
│    (Commit to main after merge)                                 │
│                                                                 │
│ 4. Delete staging area                                          │
│    aws s3 rm --recursive s3://nemar/staging/pr-{uuid}/          │
│                                                                 │
│ 5. Update dataset metadata in D1                                │
│    - New file count                                             │
│    - New size                                                   │
│    - Last updated timestamp                                     │
│                                                                 │
│ 6. Log action for audit                                         │
└─────────────────────────────────────────────────────────────────┘

Step 6b: REJECTED - Close PR
┌─────────────────────────────────────────────────────────────────┐
│ On PR Close (GitHub Webhook → NEMAR Backend)                    │
│                                                                 │
│ 1. Backend receives webhook notification                        │
│                                                                 │
│ 2. Delete staging area                                          │
│    aws s3 rm --recursive s3://nemar/staging/pr-{uuid}/          │
│                                                                 │
│ 3. Update PR record status = 'closed'                           │
│                                                                 │
│ 4. Log action for audit                                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## S3 Staging Architecture

### Bucket Structure

```
s3://nemar/
│
├── nm000101/                    # Published dataset 1
│   ├── sub-001/eeg/data.edf
│   └── sub-002/eeg/data.edf
│
├── nm000102/                    # Published dataset 2
│   └── ...
│
├── staging/                     # PR staging area (temporary)
│   │
│   ├── pr-abc123/               # PR staging (expires in 30 days)
│   │   ├── nm000101/            # Target dataset
│   │   │   └── sub-003/         # New data for PR
│   │   │       └── eeg/
│   │   │           └── data.edf
│   │   └── .metadata.json       # PR metadata
│   │
│   └── pr-def456/               # Another PR
│       └── ...
│
└── archive/                     # Deleted versions (recoverable)
    └── ...
```

### Staging Lifecycle

```
┌─────────────────┐    30 days    ┌──────────────────┐
│  PR Created     │ ────────────► │  Auto-Cleanup    │
│  (staging/)     │   (if stale)  │  (deleted)       │
└────────┬────────┘               └──────────────────┘
         │
         │ PR Merged
         ▼
┌─────────────────┐
│  Data copied    │
│  to final loc   │
│  Staging deleted│
└─────────────────┘
```

### S3 Lifecycle Rule

```json
{
  "Rules": [
    {
      "ID": "CleanupStagingAfter30Days",
      "Status": "Enabled",
      "Filter": {
        "Prefix": "staging/"
      },
      "Expiration": {
        "Days": 30
      }
    }
  ]
}
```

---

## Database Schema for PRs

```sql
-- Pull request tracking
CREATE TABLE pull_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_uuid TEXT NOT NULL UNIQUE,         -- pr-abc123 (internal ID)
  dataset_id TEXT NOT NULL,             -- nm000104
  contributor_id INTEGER NOT NULL,
  github_pr_number INTEGER,             -- GitHub PR #
  github_pr_url TEXT,
  title TEXT NOT NULL,
  description TEXT,

  -- Status tracking
  status TEXT DEFAULT 'open',           -- open, merged, closed, expired
  has_data_changes BOOLEAN DEFAULT FALSE,

  -- S3 staging
  staging_prefix TEXT,                  -- staging/pr-abc123/nm000104/
  staging_size_bytes INTEGER DEFAULT 0,

  -- Timestamps
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  merged_at DATETIME,
  closed_at DATETIME,
  expires_at DATETIME,                  -- created_at + 30 days

  FOREIGN KEY (dataset_id) REFERENCES dataset_registry(dataset_id),
  FOREIGN KEY (contributor_id) REFERENCES users(id)
);

-- Files in each PR
CREATE TABLE pr_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_uuid TEXT NOT NULL,
  file_path TEXT NOT NULL,              -- sub-002/eeg/data.edf
  file_type TEXT NOT NULL,              -- 'metadata' or 'data'
  action TEXT NOT NULL,                 -- 'add', 'modify', 'delete'
  file_size_bytes INTEGER,

  -- For data files
  staging_key TEXT,                     -- S3 key in staging
  final_key TEXT,                       -- S3 key after merge

  FOREIGN KEY (pr_uuid) REFERENCES pull_requests(pr_uuid)
);

-- Indexes
CREATE INDEX idx_pr_dataset ON pull_requests(dataset_id);
CREATE INDEX idx_pr_status ON pull_requests(status);
CREATE INDEX idx_pr_contributor ON pull_requests(contributor_id);
CREATE INDEX idx_pr_files_pr ON pr_files(pr_uuid);
```

---

## GitHub Actions Workflows

Each dataset repository has two workflows:

### 1. BIDS Validation (on PR open/update)

```yaml
# .github/workflows/bids-validation.yml
name: BIDS Validation

on:
  pull_request:
    branches: [main]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup DataLad
        run: |
          pip install datalad
          git config --global user.email "ci@nemar.org"
          git config --global user.name "NEMAR CI"

      - name: Configure S3 access
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        run: |
          # git-annex can now access both staging and final S3

      - name: Get data files
        run: |
          datalad get .

      - name: Run BIDS Validator
        run: |
          pip install bids-validator-deno
          bids-validator-deno . --json > validation-results.json

      - name: Report Results
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const results = JSON.parse(fs.readFileSync('validation-results.json'));

            if (results.errors.length > 0) {
              core.setFailed('BIDS validation failed');
            }

            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: `## BIDS Validation Results\n\nErrors: ${results.errors.length}\nWarnings: ${results.warnings.length}`
            });
```

### 2. PR Merge Handler (copies staging → final S3)

```yaml
# .github/workflows/pr-merge.yml
name: PR Merge - Finalize Data

on:
  pull_request:
    types: [closed]
    branches: [main]

jobs:
  finalize-data:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: main
          fetch-depth: 0

      - name: Configure AWS
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-2

      - name: Get PR metadata
        id: pr-meta
        run: |
          # Extract staging prefix from PR (stored in PR body or label)
          PR_NUMBER=${{ github.event.pull_request.number }}
          DATASET_ID=${{ github.event.repository.name }}
          echo "staging_prefix=staging/pr-${PR_NUMBER}/${DATASET_ID}/" >> $GITHUB_OUTPUT
          echo "final_prefix=${DATASET_ID}/" >> $GITHUB_OUTPUT

      - name: Copy staging data to final location
        run: |
          STAGING="s3://nemar/${{ steps.pr-meta.outputs.staging_prefix }}"
          FINAL="s3://nemar/${{ steps.pr-meta.outputs.final_prefix }}"

          echo "Copying from $STAGING to $FINAL"
          aws s3 cp --recursive "$STAGING" "$FINAL"

      - name: Update git-annex pointers
        run: |
          pip install datalad
          git config user.email "ci@nemar.org"
          git config user.name "NEMAR CI"

          # Update annex pointers from staging to final URLs
          # This is done by re-registering the files with final location
          datalad save -m "Update annex pointers after PR merge"
          git push origin main

      - name: Cleanup staging
        run: |
          aws s3 rm --recursive "s3://nemar/${{ steps.pr-meta.outputs.staging_prefix }}"
          echo "Staging area cleaned up"

      - name: Notify success
        uses: actions/github-script@v7
        with:
          script: |
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: ${{ github.event.pull_request.number }},
              body: '✅ Data successfully copied to final location and staging cleaned up.'
            });

  cleanup-rejected:
    if: github.event.pull_request.merged == false
    runs-on: ubuntu-latest
    steps:
      - name: Configure AWS
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-2

      - name: Cleanup staging (PR rejected)
        run: |
          PR_NUMBER=${{ github.event.pull_request.number }}
          DATASET_ID=${{ github.event.repository.name }}
          aws s3 rm --recursive "s3://nemar/staging/pr-${PR_NUMBER}/${DATASET_ID}/"
          echo "Staging area cleaned up (PR was closed without merge)"
```

---

## CLI Commands for PR Workflow

```bash
# Clone a dataset (creates local DataLad dataset)
nemar dataset clone <dataset-id> [output-dir]

# Create a PR from local changes
nemar dataset pr create \
  --message "Add subject 002" \
  --description "New participant from Site B"

# List PRs
nemar dataset pr list                    # All PRs on your datasets
nemar dataset pr list --mine             # PRs you created
nemar dataset pr list --dataset nm000104 # PRs on specific dataset

# View PR details
nemar dataset pr show <pr-id>

# Update an existing PR (push more changes)
nemar dataset pr update <pr-id>

# As owner: Approve and merge
nemar dataset pr merge <pr-id>

# Close without merging
nemar dataset pr close <pr-id>

# Check PR status
nemar dataset pr status <pr-id>
```

---

## Security Considerations

### Staging Access Control
- Presigned URLs for staging are scoped to specific PR
- URLs expire after 24 hours (renewable via CLI)
- Only PR creator and dataset owner can access staging

### GitHub Webhook Security
- Webhooks verified with secret token
- Only process events from nemarDatasets org
- Validate PR state before processing

### Data Integrity
- BIDS validation required before merge
- Checksums verified on S3 copy
- Audit log for all operations

---

## Comparison with OpenNeuro

| Feature | OpenNeuro | NEMAR |
|---------|-----------|-------|
| Direct push to main | Yes | No (blocked) |
| PR-based changes | No | Required |
| Data staging | No | Yes (S3 staging/) |
| Pre-merge validation | On push | On PR (status check) |
| Contributor approval | Not required | Required |
| Collaborative editing | Limited | Full PR workflow |
| Change history | Git commits | Git commits + PR reviews |

---

## Implementation Priority

1. **Phase 1**: Basic PR flow (metadata only)
   - Branch protection setup
   - GitHub PR creation
   - BIDS validation status check

2. **Phase 2**: Data PR flow
   - S3 staging infrastructure
   - Presigned URL generation
   - Data copy on merge

3. **Phase 3**: Advanced features
   - PR templates
   - Auto-assign reviewers
   - Conflict detection
   - PR size limits
