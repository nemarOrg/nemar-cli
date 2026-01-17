# NEMAR Prototyping Plan

Before full implementation, we need to validate key assumptions through prototypes.

---

## Prototype 1: Git-Annex Staging → Final Workflow

**Goal:** Verify that we can stage data files in a temporary S3 location, then move them to a final location while maintaining git-annex integrity.

### Setup
```bash
# Create test dataset structure
mkdir -p /tmp/nemar-prototype
cd /tmp/nemar-prototype

# Install dependencies (if not already)
brew install datalad git-annex

# Configure AWS credentials
export AWS_ACCESS_KEY_ID=xxx
export AWS_SECRET_ACCESS_KEY=xxx
export AWS_DEFAULT_REGION=us-east-2
```

### Test Scenario
```bash
# 1. Create a DataLad dataset
datalad create test-dataset
cd test-dataset

# 2. Add a test file
echo "test data content" > testfile.txt
datalad save -m "Add test file"

# 3. Initialize S3 special remote for STAGING
git annex initremote staging-s3 \
  type=S3 \
  encryption=none \
  bucket=nemar \
  fileprefix=staging/prototype-test/ \
  datacenter=us-east-2 \
  publicurl=https://nemar.s3.us-east-2.amazonaws.com

# 4. Push file to staging
git annex copy --to staging-s3 testfile.txt

# 5. Verify file is in staging
aws s3 ls s3://nemar/staging/prototype-test/

# 6. Now simulate "PR merge" - copy to final location
aws s3 cp --recursive \
  s3://nemar/staging/prototype-test/ \
  s3://nemar/prototype-final/

# 7. Register the new URL with git-annex
# First, get the key for the file
KEY=$(git annex lookupkey testfile.txt)
echo "File key: $KEY"

# 8. Register the final S3 URL
git annex registerurl "$KEY" \
  "https://nemar.s3.us-east-2.amazonaws.com/prototype-final/SHA256E-..."

# 9. Alternatively, add final location as another remote
git annex initremote final-s3 \
  type=S3 \
  encryption=none \
  bucket=nemar \
  fileprefix=prototype-final/ \
  datacenter=us-east-2 \
  publicurl=https://nemar.s3.us-east-2.amazonaws.com

# 10. Tell git-annex the file exists in final
git annex setpresentkey "$KEY" $(git config remote.final-s3.annex-uuid) 1

# 11. Test: Can we get the file from final?
git annex drop testfile.txt  # Remove local copy
git annex get testfile.txt --from final-s3  # Should work!

# 12. Clean up staging
aws s3 rm --recursive s3://nemar/staging/prototype-test/
```

### Questions to Answer
1. Does `git annex registerurl` work with S3 public URLs?
2. Can we use `setpresentkey` to tell git-annex a file exists in a new location?
3. What happens if we try to get a file after staging is deleted but before final is registered?
4. Is there a simpler approach using git-annex's built-in copy between remotes?

### Alternative Approach: Copy Between Remotes
```bash
# Instead of aws s3 cp, use git-annex:
git annex copy --from staging-s3 --to final-s3 testfile.txt

# This might handle the bookkeeping automatically!
```

---

## Prototype 2: GitHub Branch Protection

**Goal:** Verify that branch protection actually prevents direct pushes and requires PR approval.

### Setup
```bash
# Create test repo in nemarDatasets org
gh repo create nemarDatasets/prototype-test --private --description "Testing branch protection"

# Clone it
git clone git@github.com:nemarDatasets/prototype-test.git
cd prototype-test

# Create initial commit (required before protection)
echo "# Prototype Test" > README.md
git add README.md
git commit -m "Initial commit"
git push origin main
```

### Apply Branch Protection
```bash
# Set branch protection via API
gh api -X PUT /repos/nemarDatasets/prototype-test/branches/main/protection \
  -f required_pull_request_reviews[required_approving_review_count]=1 \
  -f required_pull_request_reviews[dismiss_stale_reviews]=true \
  -f enforce_admins=true \
  -f required_status_checks=null \
  -f restrictions=null \
  -f allow_force_pushes=false \
  -f allow_deletions=false
```

### Test Scenarios

#### Test 1: Direct Push Should Fail
```bash
echo "Direct change" >> README.md
git add README.md
git commit -m "Try direct push"
git push origin main
# Expected: REJECTED - branch protection
```

#### Test 2: PR Without Approval Should Fail
```bash
git checkout -b test-branch
echo "PR change" >> README.md
git add README.md
git commit -m "Change via PR"
git push origin test-branch
gh pr create --title "Test PR" --body "Testing"
gh pr merge --auto
# Expected: Cannot merge - needs approval
```

#### Test 3: PR With Approval Should Work
```bash
# Have another user (or admin) approve the PR
# Then merge should work
```

### Questions to Answer
1. Does `enforce_admins=true` really block org owners?
2. Can we programmatically approve PRs (for testing)?
3. What error messages do users see when blocked?

---

## Prototype 3: GitHub Actions for S3 Copy

**Goal:** Verify GitHub Actions can copy S3 staging → final on PR merge.

### Setup
Create `.github/workflows/pr-merge.yml` in prototype repo:

```yaml
name: PR Merge - Copy Data

on:
  pull_request:
    types: [closed]
    branches: [main]

jobs:
  copy-data:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - name: Configure AWS
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-2

      - name: Get PR info
        run: |
          echo "PR Number: ${{ github.event.pull_request.number }}"
          echo "Repo: ${{ github.event.repository.name }}"

      - name: Copy staging to final (simulated)
        run: |
          STAGING="s3://nemar/staging/pr-${{ github.event.pull_request.number }}/"
          FINAL="s3://nemar/${{ github.event.repository.name }}/"

          echo "Would copy from: $STAGING"
          echo "Would copy to: $FINAL"

          # Uncomment for real test:
          # aws s3 cp --recursive "$STAGING" "$FINAL"

      - name: Cleanup staging (simulated)
        run: |
          echo "Would delete: s3://nemar/staging/pr-${{ github.event.pull_request.number }}/"
          # aws s3 rm --recursive "s3://nemar/staging/pr-${{ ... }}/"
```

### Test Scenarios

#### Test 1: Action Triggers on Merge
1. Create PR
2. Approve and merge
3. Verify action ran

#### Test 2: Action Does NOT Trigger on Close-Without-Merge
1. Create PR
2. Close without merging
3. Verify action did NOT run the copy job

#### Test 3: Verify S3 Copy Works
1. Pre-populate staging with test data
2. Merge PR
3. Verify data copied to final
4. Verify staging deleted

### Questions to Answer
1. How long does S3 copy take for large files?
2. What happens if action times out?
3. Can we detect and skip if no staging exists?

---

## Prototype 4: Full End-to-End PR Flow

**Goal:** Simulate complete PR workflow including data staging.

### Scenario: Add New Subject to Dataset

```bash
# === SETUP ===
# Create test dataset repo with DataLad
# Configure S3 remotes (staging + final)
# Add initial data

# === CONTRIBUTOR WORKFLOW ===
# 1. Clone dataset
nemar dataset clone prototype-test ./local-copy
cd local-copy

# 2. Create branch
git checkout -b add-subject-002

# 3. Add new data file
mkdir -p sub-002/eeg
echo "EEG data for subject 002" > sub-002/eeg/data.txt

# 4. Create PR (simulated CLI)
# - Detect new files
# - Request presigned URLs from backend
# - Upload to staging S3
# - Create git-annex pointers to staging
# - Push branch
# - Create GitHub PR

# === OWNER WORKFLOW ===
# 5. Review PR on GitHub
# - See metadata diff
# - See "data-changes" label
# - BIDS validation passes (status check)

# 6. Approve and merge

# === AUTOMATED WORKFLOW ===
# 7. GitHub Action triggers
# - Copy staging → final
# - Update git-annex (if needed)
# - Delete staging
# - Post comment confirming success

# === VERIFICATION ===
# 8. Clone fresh copy
git clone git@github.com:nemarDatasets/prototype-test.git fresh-copy
cd fresh-copy
datalad get sub-002/eeg/data.txt
# Should fetch from FINAL S3, not staging
```

---

## Prototype 5: Collaborator Management at Scale

**Goal:** Test adding all users as collaborators to all repos.

### Questions to Test
1. How long does it take to add 100 collaborators to a repo?
2. How long to add 1 user to 50 repos?
3. Are there rate limits?
4. What's the GitHub API pattern for bulk operations?

### Test Script
```bash
# Create test users (or use existing)
USERS=("user1" "user2" "user3" ...)

# Time how long it takes to add all
time for user in "${USERS[@]}"; do
  gh api -X PUT "/repos/nemarDatasets/prototype-test/collaborators/$user" \
    -f permission=push
done
```

---

## Prototype 6: Git-Annex in GitHub Actions

**Goal:** Verify git-annex can be installed and used within GitHub Actions for native copy operations.

**Status:** ✅ VALIDATED (2026-01-14)

### Test Repository
`nemarDatasets/prototype-gitannex-action`

### Key Findings

1. **apt-get install works**
   - `sudo apt-get install -y git-annex` installs version 10.20240129
   - No special repositories needed

2. **Git config required**
   - GitHub Actions runner has no identity
   - Must set `user.email` and `user.name` before commits

3. **signature=v4 required for us-east-2**
   - Default S3 signature fails in us-east-2
   - Add `signature=v4` to initremote command

### Validated Workflow
```yaml
- name: Install git-annex
  run: |
    sudo apt-get update
    sudo apt-get install -y git-annex

- name: Configure git
  run: |
    git config --global user.email "actions@github.com"
    git config --global user.name "GitHub Actions"

- name: Initialize S3 remote
  run: |
    git annex initremote test-s3 \
      type=S3 \
      encryption=none \
      bucket=nemar \
      fileprefix=test/ \
      datacenter=us-east-2 \
      signature=v4 \
      publicurl=https://nemar.s3.us-east-2.amazonaws.com
```

### Full details
See `.context/validated_workflows.md` Section 5.

---

## Prototype Priority Order

| # | Prototype | Priority | Risk Level | Effort | Status |
|---|-----------|----------|------------|--------|--------|
| 1 | Git-annex staging → final | Critical | High | 2-3 hours | ✅ Validated |
| 2 | GitHub branch protection | High | Low | 1 hour | ✅ Validated |
| 3 | GitHub Actions S3 copy | High | Medium | 2 hours | ✅ Validated |
| 4 | Full E2E PR flow | High | Medium | 3-4 hours | ✅ Validated |
| 5 | Collaborator at scale | Medium | Low | 1 hour | Pending |
| 6 | Git-annex in GitHub Actions | High | Medium | 1 hour | ✅ Validated |

---

## Success Criteria

### Must Work
- [x] Git-annex can track files in staging, then final (Validated 2026-01-14)
- [x] Branch protection blocks direct pushes (Validated 2026-01-14)
- [x] GitHub Action triggers on PR merge only (Validated 2026-01-14)
- [x] S3 copy completes within reasonable time (Validated 2026-01-14)
- [x] Fresh clone can access files from final location (Validated 2026-01-14, via publicurl)

### Should Work
- [x] Cleanup happens on PR close (no merge) (Validated 2026-01-14, Prototype 3)
- [x] Git-annex installs and runs in GitHub Actions (Validated 2026-01-14, Prototype 6)
- [ ] Concurrent PR merges don't conflict
- [ ] Large files (multi-GB) work

### Nice to Have
- [ ] Progress reporting for uploads
- [ ] Resume interrupted uploads
- [ ] Retry on transient failures

---

## Blockers

### ✅ GitHub Team Required for Private Repos - RESOLVED
**Status:** RESOLVED via GitHub Education
**Date identified:** 2026-01-14
**Date resolved:** 2026-01-14

Branch protection on private repositories requires GitHub Team subscription ($4/user/month).
- Authors need private repos before publication (confirmed requirement)
- Branch protection is critical for PR-mandatory workflow

#### Resolution: GitHub Education Free Team Upgrade

Upgraded nemarDatasets org to GitHub Team via GitHub Education (free for educators).

**Validation Test (2026-01-14):**
- Created private repo: `nemarDatasets/prototype-private-test`
- Applied branch protection with `enforce_admins: true`
- ✅ Direct push to main: BLOCKED
- ✅ PR merge without approval: BLOCKED
- ✅ Admin bypass (`--admin`): BLOCKED
- ✅ PR status shows `REVIEW_REQUIRED`

**Result:** Full branch protection works on private repos with GitHub Team.

---

## Next Steps

1. **Start with Prototype 1** (git-annex) - highest risk, most uncertainty
2. If git-annex works, proceed with Prototypes 2-3 in parallel
3. Combine learnings into Prototype 4 (E2E)
4. Document findings and update architecture

Would you like to start prototyping now?
