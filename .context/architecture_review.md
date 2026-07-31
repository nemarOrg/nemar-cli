# NEMAR Architecture Review: Failure Scenarios & Gaps

> **Decisions recorded:** [ADR 0019 - Every user gets push to every repo](decisions/0019-every-user-gets-push-to-every-repo.md) (**superseded**), [ADR 0001 - Published datasets are PR-only](decisions/0001-dataset-changes-go-through-pull-requests.md).
> The rest of this document is an early risk register. Items marked "Recommendation" were not all adopted; verify against code before relying on one.

This document identifies potential failure scenarios, edge cases, and architectural gaps that need to be addressed.

---

## Critical Issues (Must Fix)

### 1. Git-Annex Pointers Don't Work That Way

**Problem:** The current design assumes we can "update git-annex pointers" after moving files from staging to final S3 location. However, git-annex pointers are **content-addressed** (based on file hash), not URL-based.

**How git-annex actually works:**
```
# The pointer is a symlink to a hash-based path:
sub-001/eeg/data.edf -> .git/annex/objects/XX/YY/{SHA256_HASH}

# The hash doesn't change when you move the file!
# git-annex just needs to know WHERE to find files with that hash.
```

**Actual Solution:** We don't need to update pointers. We need to:
1. Register the final S3 location as a remote that has the file
2. Or copy the file and register it with `git annex registerurl`

**Action Required:** Revise the workflow to use proper git-annex commands:
```bash
# After copying staging → final, register the new URL
git annex registerurl <key> <final-s3-url>

# Or use git-annex copy to move between remotes
```

---

### 2. How Do Contributors Get Push Access? [RESOLVED]

**Problem:** The design says contributors are "added when they create PR" but you need push access to push a branch in the first place. This is circular.

**Solution: All NEMAR Users Are Collaborators (Push Access)**

Every approved NEMAR user gets push access to ALL dataset repos:
- On user approval: Add as collaborator to all existing repos
- On new repo creation: Add all existing users as collaborators
- Permission level: `push` (can create branches, cannot delete repo)

**Why this works:**
1. Branch protection prevents direct push to main
2. Only owner/admin can approve and merge PRs
3. Encourages open collaboration (like scientific community)
4. No friction for contributors

**Implementation:**
```typescript
// On user approval
async function onUserApproved(userId: string, githubUsername: string) {
  // Add to all existing repos
  const repos = await db.query('SELECT dataset_id FROM dataset_registry');
  for (const repo of repos) {
    await gh.addCollaborator('nemarDatasets', repo.dataset_id, githubUsername, 'push');
  }
}

// On new dataset creation
async function onDatasetCreated(datasetId: string) {
  // Add all existing users
  const users = await db.query('SELECT github_username FROM users WHERE status = "approved"');
  for (const user of users) {
    await gh.addCollaborator('nemarDatasets', datasetId, user.github_username, 'push');
  }
}
```

**Note:** GitHub org repos can have up to 25,000 collaborators, which is plenty for a scientific community.

---

### 3. Staging Prefix Inconsistency

**Problem:** Documents use different staging prefix formats:
- `pr_architecture.md`: `staging/pr-{uuid}/nm000104/`
- GitHub Action: `staging/pr-${PR_NUMBER}/${DATASET_ID}/`
- `dataset_workflow.md`: `staging/pr-12345/nm000104/`

**Question:** Should we use:
- PR UUID (from NEMAR backend)?
- GitHub PR number?
- Something else?

**Recommendation:** Use GitHub PR number since:
- GitHub Action knows it
- Human-readable
- Unique within repo

**But:** The GitHub PR number doesn't exist until the PR is created on GitHub. The staging needs to exist BEFORE we create the PR (to upload data).

**Solution:** Two-step process:
1. Backend generates temporary staging: `staging/temp-{uuid}/`
2. After PR created, rename to: `staging/pr-{number}/`
3. Or: Store mapping in PR body/labels

---

### 4. GitHub Action Doesn't Know If PR Has Data Changes

**Problem:** GitHub Action runs on all PR merges, but it shouldn't try to copy S3 staging if the PR only has metadata changes.

**Solution:** Add label or marker:
```yaml
- name: Check for data changes
  id: check-data
  run: |
    # Check if PR has 'data-changes' label
    if [[ "${{ contains(github.event.pull_request.labels.*.name, 'data-changes') }}" == "true" ]]; then
      echo "has_data=true" >> $GITHUB_OUTPUT
    else
      echo "has_data=false" >> $GITHUB_OUTPUT
    fi

- name: Copy staging data
  if: steps.check-data.outputs.has_data == 'true'
  run: |
    # ... S3 copy logic
```

**CLI should:** Add `data-changes` label when creating PR with data files.

---

### 5. S3 Lifecycle vs Active PRs

**Problem:** S3 lifecycle rule deletes staging after 30 days, but PR might still be active (waiting for review, ongoing discussion).

**Solutions:**
1. **Extend on activity:** Backend updates object tags when PR is updated
2. **Don't use lifecycle:** Rely only on cleanup-on-close and periodic cleanup job
3. **Warn user:** Before 30 days, post comment warning about expiry

**Recommendation:** Option 2 - explicit cleanup is more predictable.

---

### 6. GitHub Action Failure Recovery

**Problem:** If GitHub Action fails after merge (network issue, S3 error), data is stuck in staging, pointers are wrong.

**Current state:** No recovery mechanism.

**Solutions:**
1. **Idempotent actions:** Can re-run manually
2. **Retry mechanism:** GitHub Actions can retry on failure
3. **Admin recovery command:** `nemar admin pr recover <pr-number>`
4. **Health check job:** Periodic job that checks for merged PRs with orphaned staging

**Recommendation:** All of the above:
```yaml
- name: Copy staging data
  uses: nick-fields/retry@v2
  with:
    timeout_minutes: 30
    max_attempts: 3
    command: |
      aws s3 cp --recursive "$STAGING" "$FINAL"
```

---

## High Priority Issues

### 7. Concurrent PR Merges

**Problem:** Two PRs merged simultaneously → both GitHub Actions try to push to main.

**Solution:**
- Use `concurrency` in GitHub Actions:
```yaml
concurrency:
  group: pr-merge-${{ github.repository }}
  cancel-in-progress: false  # Queue, don't cancel
```

---

### 8. Large Dataset Uploads (>5GB files, >100GB total)

**Problems:**
1. Presigned URLs expire (default 1 hour)
2. S3 multipart upload required for files > 5GB
3. GitHub Action timeout for large S3 copies (6 hour limit)

**Solutions:**
1. **Multipart presigned URLs:** Generate presigned URLs for each part
2. **Longer expiry:** 24 hours for presigned URLs
3. **Chunked copy:** Use S3 Transfer Acceleration or break into batches
4. **Size limits:** Warn or block PRs > 100GB

---

### 9. First Commit / Branch Protection Bootstrap

**Problem:** Newly created repo has no `main` branch yet. Can't apply branch protection to non-existent branch.

**Solution:**
```bash
# When creating repo:
1. Create repo
2. Create initial commit (README, .github/workflows)
3. Push to main
4. Apply branch protection
5. Add owner as collaborator
```

---

### 10. User's GitHub Account Deleted/Renamed

**Problem:** If user deletes or renames their GitHub account, collaborator access breaks.

**Solution:**
- Store GitHub user ID (numeric, stable), not just username
- Periodic health check: verify all collaborators still exist
- Admin command to update GitHub username: `nemar admin user update-github <user> <new-github>`

---

## Medium Priority Issues

### 11. Non-NEMAR User Creates PR via Fork

**Problem:** Random GitHub user forks and creates PR. Staging workflow doesn't work.

**Options:**
1. **Block:** Only accept PRs from collaborators
2. **Allow metadata-only:** Fork PRs can only change metadata
3. **Manual staging:** Admin creates staging for fork PRs

**Recommendation:** Option 2 - allow metadata-only PRs from forks.

---

### 12. Orphaned Staging (CLI Crash Mid-PR-Create)

**Problem:** User runs `nemar dataset pr create`, staging is created, data uploaded, but CLI crashes before GitHub PR is created.

**Solutions:**
1. **30-day expiry:** Catches eventually
2. **Orphan detection job:** Find staging with no matching GitHub PR
3. **Resume command:** `nemar dataset pr resume` to complete interrupted PR creation

---

### 13. Presigned URL Security

**Problem:** Presigned URLs, if leaked, allow anyone to upload to staging.

**Mitigations:**
1. **Short expiry:** 1 hour (but conflicts with large uploads)
2. **IP restriction:** If possible, scope to user's IP
3. **One-time use:** Track used URLs, reject duplicates
4. **HTTPS only:** Ensure transport encryption

---

### 14. GitHub Username Validation

**Problem:** User might typo their GitHub username during signup.

**Solution:**
```typescript
// During signup, validate GitHub username exists
const response = await fetch(`https://api.github.com/users/${username}`);
if (!response.ok) {
  throw new Error(`GitHub user '${username}' not found`);
}
```

---

### 15. Admin PAT Rotation

**Problem:** Admin PAT expires or is compromised.

**Solution:**
- Store PAT in Cloudflare secrets (rotatable)
- Monitor PAT expiry, alert before expiration
- Document rotation procedure

---

## Lower Priority Issues

### 16. Conflict Detection Between PRs

**Problem:** Two PRs modify same file, first merges, second has conflicts.

**Current behavior:** Git will detect conflict on merge attempt.

**Enhancement:** Warn when creating PR if another open PR touches same files.

---

### 17. Dataset Ownership Transfer

**Problem:** Original uploader leaves organization.

**Solution:**
- Admin command: `nemar admin dataset transfer <dataset-id> <new-owner>`
- Update collaborator permissions
- Log transfer in audit

---

### 18. Multiple Maintainers per Dataset

**Problem:** Currently only one owner per dataset.

**Enhancement:** Add maintainers table:
```sql
CREATE TABLE dataset_maintainers (
  dataset_id TEXT,
  user_id INTEGER,
  role TEXT,  -- 'owner', 'maintainer', 'contributor'
  PRIMARY KEY (dataset_id, user_id)
);
```

---

### 19. Rate Limiting on PR Creation

**Problem:** User could spam PR creation, consuming staging space.

**Solution:**
- Limit open PRs per user (e.g., max 5)
- Limit staging space per user (e.g., max 100GB)

---

### 20. DataLad Not Installed Error Handling

**Problem:** User runs commands without DataLad installed.

**Solution:**
```typescript
export async function ensureDataLad(): Promise<void> {
  try {
    await exec('datalad --version');
  } catch {
    console.error(chalk.red('DataLad is required but not installed.'));
    console.log('');
    console.log('Install DataLad:');
    console.log('  macOS:   brew install datalad git-annex');
    console.log('  Ubuntu:  sudo apt install datalad git-annex');
    console.log('  pip:     pip install datalad');
    console.log('');
    console.log('See: https://handbook.datalad.org/intro/installation.html');
    process.exit(1);
  }
}
```

---

## Summary Table

| Issue | Severity | Status | Solution |
|-------|----------|--------|----------|
| Git-annex pointer misunderstanding | Critical | Must fix | Use registerurl or remote-to-remote copy |
| Contributor push access | Critical | **RESOLVED** | All NEMAR users get push access to all repos |
| Staging prefix inconsistency | Critical | Must fix | Standardize on GitHub PR number + temp prefix |
| Detecting data-changes PRs | High | Must fix | Use labels |
| S3 lifecycle vs active PRs | High | Should fix | Explicit cleanup only |
| GitHub Action failure recovery | High | Should fix | Retry + admin recovery |
| Concurrent PR merges | High | Should fix | GitHub Actions concurrency |
| Large uploads | High | Should fix | Multipart, longer expiry |
| Branch protection bootstrap | Medium | Should fix | Initial commit before protection |
| GitHub account changes | Medium | Should fix | Store user ID + health check |
| Fork PRs | Medium | Design decision | Allow metadata-only |
| Orphaned staging | Medium | Should fix | Resume command + cleanup job |
| Username validation | Medium | Should fix | GitHub API check on signup |
| Admin PAT rotation | Medium | Should document | Rotation procedure |
| PR conflicts | Low | Enhancement | Conflict warning |
| Ownership transfer | Low | Enhancement | Admin command |
| Multiple maintainers | Low | Enhancement | Maintainers table |
| Rate limiting | Low | Enhancement | Limits on PRs/space |
| DataLad error handling | Low | Should fix | Better error messages |

---

## Recommended Next Steps

1. **Fix critical issues first** before implementing
2. **Create detailed design** for contributor access workflow
3. **Prototype git-annex** staging → final workflow to verify approach
4. **Update architecture docs** with fixes
5. **Add error handling** throughout CLI
