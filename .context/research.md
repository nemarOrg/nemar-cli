# NEMAR CLI Technical Research

## Existing Infrastructure Analysis

### Current Tools (EMG-2-BIDS/tools)
Location: `~/Documents/git/EMG-2-BIDS/tools/`

**publish_nemar_dataset.py:**
- Creates DataLad dataset from BIDS directory
- Configures S3 special remote (nemar bucket, us-east-2)
- Creates GitHub sibling in nemarDatasets org
- Pushes metadata to GitHub, binary data to S3

**register_zenodo_doi.py:**
- Pre-reserves DOI from Zenodo
- Updates dataset_description.json with DOI
- Creates git tag and GitHub release
- Uploads release zip to Zenodo
- Publishes DOI (permanent)

**Key Configuration:**
- S3 bucket: `nemar` in `us-east-2`
- GitHub org: `nemarDatasets`
- Large files: `*.edf`, `*.bdf`, `*.set`, `*.fif`, `*.vhdr`, `*.eeg`, `*.cnt`

### nemarDatasets Organization
Current datasets: nm000103-nm000107
Structure: DataLad datasets with S3 backend
Private repos: nemar-tools, nemar-metadata

---

## OpenNeuro CLI Analysis

### Commands
- `login` - Configure API credentials
- `upload` - Push dataset to platform
- `download` - Fetch dataset snapshot

### Authentication
- API key stored locally
- Environment variable support: `OPENNEURO_API_KEY`
- Deno-based credential storage

### Upload Flow
1. Check for dataset_description.json
2. Run validation (warnings can be ignored)
3. Affirm data is defaced
4. Push via isomorphic git

---

## BIDS Validator

### Installation Options
```bash
# Via PyPI (pre-compiled Deno binary)
pip install bids-validator-deno
bids-validator-deno /path/to/dataset

# Via Deno directly
deno run -ERWN jsr:@bids/validator /path/to/dataset

# As library (JavaScript)
import { validate } from '@bids/validator';
```

### Configuration
- `.bidsignore` - Files to skip validation
- Custom config JSON - Reclassify issues

---

## DataLad Integration

### Key Commands
```bash
# Create dataset
datalad create -D "description" /path

# Configure git-annex large files
git annex config --set annex.largefiles "include=*.edf or ..."

# Add S3 special remote
git annex initremote <name> type=S3 bucket=<bucket> ...

# Create GitHub sibling
datalad create-sibling-github --github-organization <org> <name>

# Push
datalad push --to github
```

### Dependencies
- datalad
- git-annex
- Python 3.x

---

## Cloudflare Infrastructure

### Workers
- Serverless functions at edge
- TypeScript/JavaScript support
- Wrangler CLI for deployment

### D1 (SQLite)
- SQLite database at edge
- Good for user/token storage
- Limited to 10GB per database

### KV
- Key-value store
- Good for sessions, caching
- Eventually consistent

### Email Workers
- Send transactional emails
- Integrates with MailChannels

---

## GitHub API

### Repository Management
```bash
# Create repo in org
gh repo create org/repo --private

# Delete repo (requires admin)
gh repo delete org/repo

# Manage collaborators
gh api repos/org/repo/collaborators/user -X PUT
```

### Personal Access Tokens
- Classic tokens: broad scope
- Fine-grained tokens: repo-specific

### GitHub Apps
- Installation tokens
- Better security model
- More complex setup

---

## S3 Integration

### Bucket Policy (public read)
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::nemar/*"
  }]
}
```

### Presigned URLs
- Temporary access without credentials
- Configurable expiration
- Scoped to specific objects

### Versioning
- S3 bucket versioning for data protection
- Prevents accidental deletion
- Increases storage costs

---

## Prototype Results

> **Full details in `.context/validated_workflows.md`** - that document contains the complete, tested commands and gotchas.

### Prototype 1: Git-Annex Staging → Final Workflow
**Date:** 2026-01-14
**Status:** ✓ VALIDATED
**Details:** See `validated_workflows.md` Section 1

**Summary:** Use `git annex copy --from staging-s3 --to final-s3` instead of manual `aws s3 cp`. The native git-annex approach handles location tracking automatically and avoids `annex-uuid` conflicts.

### Prototype 2: GitHub Branch Protection
**Date:** 2026-01-14
**Status:** ✓ VALIDATED
**Details:** See `validated_workflows.md` Section 2

**Summary:** Branch protection with `enforce_admins=true` blocks everyone including org owners. Direct pushes blocked, PRs require approval, self-approval not allowed. Public repos required for free tier.

### Prototype 3: GitHub Actions S3 Copy
**Date:** 2026-01-14
**Status:** ✓ VALIDATED
**Details:** See `validated_workflows.md` Section 3

**Summary:** Use `pull_request: [closed]` trigger with `if: github.event.pull_request.merged == true/false` conditions. Two jobs: `copy-data` (on merge) and `cleanup-only` (on close without merge). Both scenarios tested and working.

### Prototype 4: Full E2E PR Workflow
**Date:** 2026-01-14
**Status:** ✓ VALIDATED (with caveats)
**Details:** See `validated_workflows.md` Section 4

**Summary:** Complete workflow validated. Key findings:
1. **Largefiles config critical** - workflow files must NOT be annexed or GitHub can't read them
2. **Git-annex tracking gap** - `aws s3 cp` doesn't update git-annex; need to use `git annex copy --from --to` or register URLs
3. **Push git-annex branch** - required for clones to see remote configurations
4. **Public URL works** - files accessible via publicurl even without native git-annex tracking

### Prototype 5: Git-Annex in GitHub Actions
**Date:** 2026-01-14
**Status:** ✓ VALIDATED
**Details:** See `validated_workflows.md` Section 5

**Summary:** Git-annex installs and works in GitHub Actions. Key findings:
1. **apt-get install works** - version 10.20240129 available in Ubuntu repos
2. **Git config required** - must set `user.email` and `user.name` before commits
3. **signature=v4 required** - for us-east-2 S3 region
4. **Full round-trip validated** - upload, drop, get all work correctly

---

## GitHub Education for Organizations

### Free GitHub Team for Educators

GitHub provides free GitHub Team for qualifying educational organizations through the GitHub Education program.

**Benefits:**
- Unlimited private repositories
- Unlimited collaborators
- Branch protection on private repositories
- Required pull request reviews
- All Team-tier features

### How to Upgrade an Organization

**Prerequisites:**
- Must be verified as educator on GitHub Education
- Must be owner of the organization to upgrade
- Benefits may take 3-5 days to activate after verification

**Steps:**
1. Visit [GitHub Global Campus for Teachers](https://education.github.com/globalcampus/teacher)
2. Find "Upgrade your academic organizations" section
3. Click "Upgrade to GitHub Team"
4. Select organization from list
5. Click "Upgrade" button

### Verifying the Upgrade

Navigate to: `Organization → Settings → Billing and Plans → Current Plan`

Should show "GitHub Team" instead of "Free"

### Troubleshooting

If the upgrade option doesn't appear:
- Wait 3-5 days after educator verification
- Ensure you're the organization owner
- Contact support@github.com for assistance

### Resources
- [GitHub Docs: Discounted Plans](https://docs.github.com/en/billing/concepts/discounted-plans)
- [GitHub Education](https://education.github.com/)
- [GitHub Global Campus for Teachers](https://education.github.com/globalcampus/teacher)

---

## Questions to Resolve

1. **DataLad Dependency:** Require users to install DataLad or handle in backend?
2. **Credential Storage:** OS keychain vs. encrypted file?
3. **Large File Upload:** Resume support for multi-GB files?
4. **Admin Workflow:** CLI-only or web interface too?
5. **Rate Limiting:** How to prevent abuse?
