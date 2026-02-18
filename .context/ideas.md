# NEMAR CLI Design Ideas

## Authentication System

### Option A: Cloudflare Stack (Recommended)
- **Workers:** API endpoints
- **D1:** SQLite database for users/tokens
- **KV:** Session storage, rate limiting
- **Email:** Cloudflare Email Workers or SendGrid

Pros: Serverless, low cost, global edge deployment
Cons: Vendor lock-in, D1 is still maturing

### Option B: Self-hosted
- **Backend:** Node.js/Bun server
- **Database:** PostgreSQL
- **Email:** SendGrid/Mailgun

Pros: Full control, no vendor lock-in
Cons: Infrastructure management, higher cost

### Decision: Start with Cloudflare for MVP, design for portability

---

## GitHub Integration

### Option A: GitHub App
- More secure (installation tokens)
- Granular permissions per repository
- Better for organization management

### Option B: Personal Access Token (PAT)
- Simpler to implement
- User manages their own token
- Works with existing workflow

### Option C: Hybrid (System PAT + User PAT)
- System PAT for repo creation
- User PAT for push access
- More complex but flexible

### Decision: Start with System PAT (admin-managed), evaluate GitHub App later

---

## S3 Credential Management

### Option A: IAM Users per NEMAR User
- Each user gets IAM credentials
- Scoped to their dataset prefix
- Direct S3 access

### Option B: Presigned URLs
- No user-level credentials
- Backend generates presigned URLs
- More secure, less flexible

### Option C: STS Assume Role
- Temporary credentials
- Role-based access
- Best security, most complex

### Decision: Start with presigned URLs for upload, evaluate IAM users if needed

---

## Dataset Upload Workflow

### Option A: Direct Upload
1. Validate locally
2. Create DataLad dataset
3. Push to GitHub + S3

Pros: Simple, matches existing workflow
Cons: User needs DataLad installed

### Option B: Streaming Upload
1. Validate locally
2. Stream files to backend
3. Backend creates DataLad dataset

Pros: No DataLad on user machine
Cons: Complex backend, slow for large files

### Option C: Hybrid
1. Metadata via API
2. Data via presigned S3 URLs
3. Backend finalizes DataLad dataset

Pros: Fast data upload, no user DataLad
Cons: Two-phase upload, complexity

### Decision: Option A for v1 (requires DataLad), consider Option C for v2

---

## CLI Framework Comparison

| Framework | Pros | Cons |
|-----------|------|------|
| Commander.js | Simple, popular, TypeScript support | Less feature-rich |
| Yargs | Feature-rich, good TypeScript | Heavier |
| Oclif | Enterprise-grade, plugins | Complex, Salesforce-backed |
| CAC | Lightweight, fast | Less popular |
| Cliffy | Deno-native, modern | Deno-focused |

### Decision: Commander.js for simplicity, well-known patterns

---

## Configuration Storage

### User Config Location
- Linux/macOS: `~/.config/nemar/`
- Windows: `%APPDATA%/nemar/`

### Config Files
- `config.json` - API endpoint, preferences
- `credentials.json` - Encrypted tokens (or use OS keychain)

### Environment Variables
- `NEMAR_API_KEY` - Override for CI/CD
- `NEMAR_API_URL` - Custom backend URL
- `NEMAR_NO_COLOR` - Disable colors

---

## Future Considerations

### Plugin System
- Allow community plugins for:
  - Custom validators
  - Alternative storage backends
  - Integration with other tools

### Dataset Templates
- Pre-configured dataset templates for common modalities
- Auto-generate required files

### Web Dashboard
- Companion web interface
- Dataset browsing, statistics
- Admin panel

---

## Granular Access Control Architecture

### Design Goals
1. **Tight control:** CLI manages all access; users cannot bypass
2. **Granularity:** Per-user, per-dataset access control
3. **Auditability:** Track all operations
4. **Revocability:** Instantly revoke access without data loss
5. **No deletion:** Users cannot delete repos or S3 data

---

### GitHub Access Control (nemarDatasets Organization)

#### Repository Protection Strategy
```
nemarDatasets (Organization)
├── Owner: Admin (full control)
├── Repository Creation: CLI backend only
├── Repository Deletion: Disabled for all except owner
└── Per-repo collaborator access
```

#### Permission Levels
| Role | Create Repo | Push | Delete Repo | Manage Collaborators |
|------|-------------|------|-------------|---------------------|
| Owner (Admin) | Yes | Yes | Yes | Yes |
| User | No | Own repos only | No | No |
| CLI Backend | Yes | All repos | No | Yes |

#### Implementation via GitHub CLI
```bash
# Create repository (backend only)
gh repo create nemarDatasets/nm000XXX --private

# Add user as collaborator (push access only)
gh api repos/nemarDatasets/nm000XXX/collaborators/USERNAME \
  -X PUT -f permission=push

# Remove user access (revocation)
gh api repos/nemarDatasets/nm000XXX/collaborators/USERNAME -X DELETE

# List collaborators
gh api repos/nemarDatasets/nm000XXX/collaborators

# Branch protection (prevent force push, require reviews)
gh api repos/nemarDatasets/nm000XXX/branches/main/protection \
  -X PUT -f enforce_admins=true \
  -f required_pull_request_reviews.dismiss_stale_reviews=true
```

#### Fine-Grained PAT Strategy
1. **Admin PAT:** Full org access (repo creation, collaborator management)
2. **User Tokens:** Not PATs; users use NEMAR API tokens
3. **Backend Service:** Uses Admin PAT for all GitHub operations

Users never get GitHub PATs directly. The CLI backend:
1. Receives user request via API token
2. Validates user owns the dataset
3. Executes GitHub operation with admin PAT
4. Returns result to user

---

### S3 Access Control (NEMAR Bucket)

#### Bucket Structure
```
s3://nemar/
├── nm000101/        # Dataset 1
│   ├── *.edf        # User A owns
│   └── ...
├── nm000102/        # Dataset 2
│   ├── *.bdf        # User B owns
│   └── ...
└── nm000103/        # Dataset 3
    └── ...          # User A owns (multiple datasets)
```

#### S3 Policy Strategy

**Option A: Prefix-Based IAM Policies (Recommended for tight control)**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::nemar/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::nemar/${nemar:dataset_id}/*",
      "Condition": {
        "StringEquals": {
          "nemar:user_id": "${aws:userid}"
        }
      }
    },
    {
      "Effect": "Deny",
      "Action": ["s3:DeleteObject", "s3:DeleteBucket"],
      "Resource": "arn:aws:s3:::nemar/*"
    }
  ]
}
```

**Option B: Presigned URLs (Maximum control)**
- User requests upload URL from CLI backend
- Backend validates ownership, generates presigned PUT URL
- URL expires after 1 hour
- User uploads directly to S3
- No user credentials stored

```typescript
// Backend generates presigned URL
const url = await s3.getSignedUrl("putObject", {
  Bucket: "nemar",
  Key: `${datasetId}/${filename}`,
  Expires: 3600, // 1 hour
  ContentType: "application/octet-stream"
});
```

#### S3 Versioning
Enable bucket versioning to prevent data loss:
```bash
aws s3api put-bucket-versioning \
  --bucket nemar \
  --versioning-configuration Status=Enabled
```

With versioning:
- Delete operations create delete markers (data recoverable)
- Previous versions always accessible to admin
- MFA Delete can require 2FA for permanent deletion

#### Dataset Ownership Tracking
Database schema:
```sql
CREATE TABLE dataset_ownership (
  id INTEGER PRIMARY KEY,
  dataset_id TEXT NOT NULL UNIQUE,  -- nm000XXX
  owner_user_id INTEGER NOT NULL,
  github_repo_name TEXT NOT NULL,
  s3_prefix TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);
```

---

### Access Control Flow

#### User Uploads Dataset
```
1. User: nemar dataset upload /path/to/bids --name my-dataset
2. CLI: POST /api/datasets/create
   - Backend validates user token
   - Generates dataset_id (nm000XXX)
   - Creates GitHub repo with admin PAT
   - Adds user as collaborator (push only)
   - Records ownership in database
   - Returns dataset_id and presigned URLs
3. CLI: Uploads data via presigned URLs
4. CLI: Creates DataLad dataset locally
5. CLI: Pushes to GitHub (user has push access)
6. Done: User has read/write to their dataset only
```

#### Admin Revokes User
```
1. Admin: nemar admin revoke username
2. CLI: POST /api/admin/revoke
   - Backend validates admin token
   - For each dataset owned by user:
     - Remove GitHub collaborator access
     - (Data remains; user just cannot access)
   - Revoke API token
   - Log action for audit
3. Done: User immediately loses all access
```

#### User Tries to Delete (Blocked)
```
1. User: tries to delete repo via GitHub UI
   - BLOCKED: User only has push permission, not admin
2. User: tries to delete S3 objects
   - BLOCKED: No direct S3 credentials
   - Presigned URLs are PUT only, not DELETE
3. User: tries to delete via CLI
   - BLOCKED: No delete command exists
```

---

### Token Architecture

```
User Registration
       ↓
Admin Approval
       ↓
Generate Credentials
├── NEMAR API Token (stored in D1)
│   - Used for all CLI operations
│   - Validates against backend
│   - Can be revoked instantly
│
└── NO Direct Cloud Credentials
    - No GitHub PAT given to user
    - No S3 credentials given to user
    - All operations proxied through backend
```

---

### Audit Trail
```sql
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  user_id INTEGER,
  action TEXT NOT NULL,  -- 'dataset_create', 'dataset_upload', 'user_revoke'
  resource_type TEXT,    -- 'dataset', 'user'
  resource_id TEXT,      -- 'nm000XXX', 'username'
  details JSON,          -- Additional context
  ip_address TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

---

### Implementation with gh and aws CLI

#### GitHub Operations (Backend Only)
```bash
# Create repo
gh repo create nemarDatasets/$DATASET_ID --private --description "$DESC"

# Add collaborator
gh api -X PUT repos/nemarDatasets/$DATASET_ID/collaborators/$USERNAME \
  -f permission=push

# Protect main branch
gh api -X PUT repos/nemarDatasets/$DATASET_ID/branches/main/protection \
  -f enforce_admins=true \
  -f restrictions=null \
  -f required_pull_request_reviews=null \
  -f required_status_checks=null

# List repos where user is collaborator
gh api "/orgs/nemarDatasets/repos" --jq '.[] | .name'
```

#### S3 Operations (Backend Only)
```bash
# Generate presigned URL for upload
aws s3 presign s3://nemar/$DATASET_ID/$FILENAME --expires-in 3600

# Enable versioning
aws s3api put-bucket-versioning --bucket nemar \
  --versioning-configuration Status=Enabled

# Deny delete via bucket policy
aws s3api put-bucket-policy --bucket nemar --policy '{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Deny",
    "Principal": "*",
    "Action": ["s3:DeleteObject", "s3:DeleteBucket"],
    "Resource": ["arn:aws:s3:::nemar", "arn:aws:s3:::nemar/*"],
    "Condition": {
      "StringNotEquals": {
        "aws:PrincipalArn": "arn:aws:iam::ACCOUNT:user/nemar-admin"
      }
    }
  }]
}'
```

---

### Decision Summary

| Component | Strategy | Rationale |
|-----------|----------|-----------|
| GitHub Access | Backend-proxied with Admin PAT | Tight control, no user PATs |
| S3 Access | Presigned URLs | No user credentials, time-limited |
| Deletion | Denied at all levels | S3 versioning + no delete command |
| Audit | Full logging in D1 | Accountability |
| Revocation | Instant via token invalidation | Security |

---

## Metadata Pipeline Design (Issue #154)

### Single Source of Truth

`.nemar/metadata.json` should contain ALL metadata needed for DOI minting. No more assembling from multiple sources on the fly. The file tracks its pipeline stage so we know how mature the metadata is.

### Pipeline Stage Progression

```
seeded -> enriched -> validated -> DOI-ready
```

- **seeded**: Base metadata pulled from BIDS files. All authors present (even without ORCIDs). Data type, license, source datasets, funding from BIDS.
- **enriched**: LLM has added description, methods, keywords, additional funding/related identifiers from README.
- **validated**: LLM judge has reviewed for correctness. Relation types verified, author completeness checked, keyword relevance confirmed.

### DOI Gating

DOIs should NOT be minted until metadata reaches `validated` stage. This prevents issues like the LLM incorrectly classifying a "derived from" relationship as "version of".

### LLM Validation System Prompt Design

The validation stage uses a judge LLM (same model) to review metadata quality. The system prompt should be modeled after Anthropic's pr-review-toolkit approach: structured evaluation with specific criteria, confidence scores, and actionable feedback.

Validation criteria:
1. **Author completeness** - Are all authors from README/BIDS present?
2. **Relation type accuracy** - Is each related identifier's relation type correct? (IsDerivedFrom vs IsVersionOf vs IsDescribedBy vs IsSupplementTo)
3. **Keyword relevance** - Do keywords accurately describe the dataset?
4. **Description accuracy** - Does the abstract match the actual dataset content?
5. **Funding accuracy** - Are award numbers real and correctly attributed?

Output: JSON with pass/fail per criterion, confidence score, and suggested corrections.

### Refactoring bidsToDataCite()

Currently pulls from `dataset_description.json` + enrichment. Should be refactored to read `.nemar/metadata.json` as primary source. The metadata file IS the DOI record, just in a different format.

---

## References
- OpenNeuro CLI architecture
- GitHub CLI patterns
- AWS CLI credential management
- DataLad documentation
- AWS S3 Presigned URLs documentation
- GitHub REST API for collaborators
