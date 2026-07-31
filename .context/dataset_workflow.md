# NEMAR Dataset Workflow Architecture

> **Decisions recorded:** [ADR 0011 - Dataset IDs are backend-assigned in reserved bands](decisions/0011-dataset-ids-are-backend-assigned-in-reserved-bands.md), [ADR 0002 - Access control via GitHub collaboration](decisions/0002-access-control-via-github-collaboration.md).

> **Related Documents:**
> - `.context/pr_architecture.md` - Detailed PR workflow design
> - `.context/access_control.md` - GitHub/S3 access control

## Dataset ID Management

### Serial ID Assignment
Dataset IDs follow the pattern `nm000XXX` and must be centrally managed to avoid conflicts.

```
nm000001 - nm000099   # Reserved/legacy
nm000100 - nm000199   # Current range
nm000200+             # Future allocation
```

### ID Generation Strategy
The backend (not CLI, not user) assigns dataset IDs:

```sql
-- D1 Database Schema
CREATE TABLE dataset_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL UNIQUE,     -- nm000XXX (generated)
  name TEXT NOT NULL,                   -- human-readable name
  owner_user_id INTEGER NOT NULL,
  status TEXT DEFAULT 'active',         -- active, archived, pending
  concept_doi TEXT,                     -- Zenodo concept DOI
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);

```

**ID Generation Flow (gap-reuse):**
```
1. User: nemar dataset upload /path/to/bids --name "My Dataset"
2. Backend (see backend/src/services/datasetId.ts):
   - Find lowest unused number by checking gaps in the datasets table
   - Candidates: start number (108 for nm) + each existing_number+1
   - Pick MIN(candidate) not already in datasets table
   - INSERT claiming row with dataset_id, retry on UNIQUE conflict
3. Return: dataset_id to CLI

Note: Deleted dataset IDs are reused. The old id_sequence table
is no longer used; gap-finding queries the datasets table directly.
```

---

## Data Download (Pull) Workflow

### Simple Clone (Read-Only)
```bash
# User wants to download a dataset
nemar dataset download nm000104 --output ./my-data

# Under the hood:
1. CLI queries backend for dataset info
2. Backend returns: { github_url, s3_prefix, versions }
3. CLI runs: datalad clone https://github.com/nemarDatasets/nm000104
4. CLI runs: datalad get .  # Fetches data from S3
5. Done: User has full dataset locally
```

### Wrapper Around DataLad
```typescript
// src/lib/datalad.ts
export async function cloneDataset(datasetId: string, outputDir: string) {
  // Check if datalad is installed
  await checkDataladInstalled();

  // Clone from GitHub
  const repoUrl = `https://github.com/nemarDatasets/${datasetId}`;
  await exec(`datalad clone ${repoUrl} ${outputDir}`);

  // Get data from S3
  await exec(`datalad get .`, { cwd: outputDir });
}

export async function checkDataladInstalled() {
  try {
    await exec('datalad --version');
  } catch {
    throw new Error(
      'DataLad is required but not installed.\n' +
      'Install with: brew install datalad git-annex'
    );
  }
}
```

---

## Contribution Workflow (Pull Requests)

### The Challenge
When someone wants to contribute to a dataset:
- **Metadata changes** (JSON, TSV, MD): Easy, standard GitHub PR
- **Data changes** (EDF, BDF): Complex, data is on S3, not GitHub

### Two Types of PRs

#### Type 1: Metadata-Only PR
Standard GitHub flow:
```
1. Contributor forks/branches dataset repo
2. Edits metadata files locally
3. Commits and pushes to their fork/branch
4. Creates PR on GitHub
5. Dataset owner reviews and merges
6. Done
```

#### Type 2: Data PR (Complex)
Requires staging area on S3:

```
S3 Bucket Structure:
s3://nemar/
├── nm000104/              # Published dataset (main)
│   ├── sub-001/
│   │   └── eeg/
│   │       └── data.edf
│   └── ...
│
├── staging/               # Temporary staging area for PRs
│   ├── pr-12345/          # PR-specific staging
│   │   ├── nm000104/      # Dataset being modified
│   │   │   └── sub-002/   # New subject being added
│   │   │       └── eeg/
│   │   │           └── data.edf
│   │   └── metadata.json  # PR metadata
│   └── pr-12346/
│       └── ...
│
└── archive/               # Old versions (if needed)
```

---

## Data PR Workflow (Detailed)

### Step 1: Contributor Clones Dataset
```bash
nemar dataset clone nm000104 --output ./nm000104
cd nm000104
```

### Step 2: Contributor Makes Changes
```bash
# Add new subject data
cp -r /path/to/new/subject ./sub-002

# Or modify existing files
# ... edit files ...
```

### Step 3: Contributor Creates PR
```bash
nemar dataset pr create --message "Add subject 002 data"

# Under the hood:
1. CLI detects changed/new files (git status + git annex)
2. CLI separates:
   - Metadata changes (JSON, TSV) → GitHub
   - Data changes (EDF, BDF) → S3 staging
3. CLI requests staging area from backend:
   POST /api/pr/create
   Body: { dataset_id: "nm000104", files: [...] }
4. Backend:
   - Creates PR record in database
   - Generates presigned URLs for staging: s3://nemar/staging/pr-{id}/
   - Returns PR ID and upload URLs
5. CLI uploads data files to staging
6. CLI creates git branch with:
   - Metadata changes
   - Updated git-annex pointers (pointing to staging location)
7. CLI pushes branch and creates GitHub PR
8. Returns: PR URL
```

### Step 4: Dataset Owner Reviews
```bash
# Owner can preview the PR
nemar dataset pr preview pr-12345

# Under the hood:
1. Clone the PR branch
2. Data fetched from staging area
3. Owner can validate BIDS, inspect files
```

### Step 5: PR Approval/Rejection

**If Approved:**
```bash
nemar dataset pr merge pr-12345  # (or via GitHub merge button with webhook)

# Under the hood:
1. Backend receives merge notification (GitHub webhook)
2. Backend:
   - Copies data from s3://nemar/staging/pr-12345/nm000104/
     to s3://nemar/nm000104/
   - Updates git-annex pointers to final S3 location
   - Commits pointer updates
   - Merges PR on GitHub
   - Deletes staging area
   - Logs action
3. Dataset now has new data
```

**If Rejected:**
```bash
# Owner closes PR on GitHub (or via CLI)
nemar dataset pr close pr-12345

# Under the hood:
1. Backend receives close notification
2. Backend:
   - Deletes s3://nemar/staging/pr-12345/
   - Closes GitHub PR
   - Logs action
```

---

## PR Database Schema

```sql
CREATE TABLE pull_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_id TEXT NOT NULL UNIQUE,           -- pr-12345
  dataset_id TEXT NOT NULL,             -- nm000104
  contributor_user_id INTEGER NOT NULL,
  github_pr_number INTEGER,             -- GitHub PR #
  github_pr_url TEXT,
  status TEXT DEFAULT 'open',           -- open, merged, closed
  has_data_changes BOOLEAN DEFAULT FALSE,
  staging_prefix TEXT,                  -- s3://nemar/staging/pr-12345/
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  merged_at DATETIME,
  closed_at DATETIME,
  FOREIGN KEY (dataset_id) REFERENCES dataset_registry(dataset_id),
  FOREIGN KEY (contributor_user_id) REFERENCES users(id)
);

CREATE TABLE pr_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_id TEXT NOT NULL,
  file_path TEXT NOT NULL,              -- sub-002/eeg/data.edf
  file_type TEXT NOT NULL,              -- 'metadata' or 'data'
  action TEXT NOT NULL,                 -- 'add', 'modify', 'delete'
  staging_url TEXT,                     -- Presigned URL (for data files)
  final_url TEXT,                       -- Final S3 location
  FOREIGN KEY (pr_id) REFERENCES pull_requests(pr_id)
);
```

---

## Authorization for PRs

### Who Can Create PRs?
- Any **authorized NEMAR user** can create PRs on any public dataset
- This enables collaborative science

### Who Can Approve/Merge PRs?
- **Dataset owner** (the user who uploaded it)
- **NEMAR admins** (can intervene if needed)

```sql
-- Check if user can merge PR
SELECT
  CASE
    WHEN pr.dataset_id IN (
      SELECT dataset_id FROM dataset_registry WHERE owner_user_id = ?
    ) THEN TRUE
    WHEN ? IN (SELECT user_id FROM admins) THEN TRUE
    ELSE FALSE
  END as can_merge
FROM pull_requests pr
WHERE pr.pr_id = ?
```

### PR Permissions Matrix

| Action | Dataset Owner | Other Users | Admins |
|--------|--------------|-------------|--------|
| Create PR | Yes | Yes | Yes |
| View PR | Yes | Yes | Yes |
| Merge PR | Yes | No | Yes |
| Close PR | Yes | Only their own | Yes |
| Delete staging data | Auto on close | No | Yes |

---

## Staging Area Management

### Cleanup Policy
- Staging data expires after 30 days if PR not merged
- Background job cleans up expired staging areas
- Webhook on PR close triggers immediate cleanup

### Storage Costs
- Staging is temporary; shouldn't accumulate
- Monitor staging size; alert if > threshold

### Security
- Staging presigned URLs expire after 24 hours
- Contributor can only access their own staging area
- Staging data not publicly accessible

---

## CLI Commands for PRs

```bash
# Clone a dataset to contribute
nemar dataset clone nm000104 ./my-copy

# After making changes, create a PR
nemar dataset pr create \
  --message "Add subject 002 with 3 sessions" \
  --description "New participant data from Site B"

# List your open PRs
nemar dataset pr list --mine

# List PRs on datasets you own (for review)
nemar dataset pr list --to-review

# Preview a PR (as owner)
nemar dataset pr preview pr-12345

# Merge a PR (as owner)
nemar dataset pr merge pr-12345

# Close a PR without merging
nemar dataset pr close pr-12345
```

---

## Integration with DataLad

### The Key Insight
DataLad uses git-annex, which stores **pointers** in git and **data** in special remotes (S3).

When we stage data for a PR:
1. Data goes to `s3://nemar/staging/pr-XXXXX/`
2. Git-annex pointers in the PR branch point to staging location
3. On merge, we:
   - Move data to final location
   - Update pointers to point to final location
   - Commit the pointer update

### Git-Annex Pointer Example
```
# .git/annex/objects/...
# Points to: s3://nemar/staging/pr-12345/nm000104/sub-002/eeg/data.edf

# After merge, updated to:
# Points to: s3://nemar/nm000104/sub-002/eeg/data.edf
```

---

## Workflow Diagram

```
Contributor                    Backend                     S3 / GitHub
    │                            │                              │
    │ nemar dataset clone        │                              │
    │ ─────────────────────────► │                              │
    │                            │ datalad clone               │
    │                            │ ────────────────────────────►│
    │ ◄──────────────────────────│ ◄────────────────────────────│
    │   Dataset cloned           │                              │
    │                            │                              │
    │ [Make local changes]       │                              │
    │                            │                              │
    │ nemar dataset pr create    │                              │
    │ ─────────────────────────► │                              │
    │                            │ Create PR record             │
    │                            │ Generate staging URLs        │
    │ ◄──────────────────────────│                              │
    │   Upload URLs              │                              │
    │                            │                              │
    │ Upload data to staging     │                              │
    │ ─────────────────────────────────────────────────────────►│
    │                            │                              │ staging/pr-XXX
    │ Push PR branch             │                              │
    │ ─────────────────────────────────────────────────────────►│
    │                            │                              │ GitHub PR
    │ ◄──────────────────────────│ ◄────────────────────────────│
    │   PR created               │                              │
    │                            │                              │
    │                            │                              │
Owner                            │                              │
    │ nemar dataset pr merge     │                              │
    │ ─────────────────────────► │                              │
    │                            │ Copy staging → final         │
    │                            │ ────────────────────────────►│
    │                            │ Merge GitHub PR              │
    │                            │ ────────────────────────────►│
    │                            │ Delete staging               │
    │                            │ ────────────────────────────►│
    │ ◄──────────────────────────│                              │
    │   PR merged                │                              │
```

---

## Open Questions

1. **Who manages dataset ownership transfer?** (If original uploader leaves)
2. **Multiple owners/maintainers per dataset?** (Like GitHub collaborators)
3. **Size limits on PRs?** (Prevent 100GB staging uploads)
4. **PR validation?** (Run BIDS validator on PR before allowing merge)
5. **Conflict resolution?** (What if two PRs modify same file?)
