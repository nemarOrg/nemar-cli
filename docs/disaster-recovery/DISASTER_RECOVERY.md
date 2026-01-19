# NEMAR DISASTER RECOVERY GUIDE

**🚨 EMERGENCY RESPONSE PROCEDURES**

**Version:** 1.0.0
**Last Updated:** 2026-01-18
**Operator:** nemarRestore account
**Emergency Contact:** yahya@osc.earth

---

## 🔴 EMERGENCY: Datasets Accidentally Deleted

**TIME IS CRITICAL** - Follow these steps immediately:

### STEP 1: ASSESS DAMAGE (5 minutes)

```bash
# 1. Check what's in S3 (data layer)
export AWS_ACCESS_KEY_ID="<from-1password>"
export AWS_SECRET_ACCESS_KEY="<from-1password>"
aws s3 ls s3://nemar/ | grep "^PRE nm"

# 2. Check what's on GitHub (metadata layer)
gh repo list nemarDatasets --limit 200 | grep "^nemarDatasets/nm"

# 3. Check database
wrangler d1 execute nemar-db --remote --command \
  "SELECT dataset_id, name, concept_doi, status FROM datasets ORDER BY dataset_id"
```

**Record findings:**
- S3 buckets present: ___________
- GitHub repos present: ___________
- Database entries present: ___________

---

### STEP 2: VERIFY DATA INTEGRITY (5 minutes)

```bash
# For each missing dataset, verify S3 data exists
for dataset_id in nm000103 nm000104 nm000105 nm000106 nm000107; do
  echo "Checking $dataset_id..."
  count=$(aws s3 ls s3://nemar/${dataset_id}/ --recursive | wc -l)
  echo "  Files in S3: $count"
done
```

**✅ IF S3 DATA EXISTS** → Proceed to restoration (safe!)
**❌ IF S3 DATA MISSING** → STOP - Escalate to yahya@osc.earth immediately

---

### STEP 3: GET ZENODO ARCHIVES (10 minutes)

Zenodo archives are our backup. Find concept DOIs from nemarDatasets profile:

```bash
# Visit https://github.com/nemarDatasets/.github/blob/main/profile/README.md
# Or use gh cli:
gh repo view nemarDatasets/.github --web

# Download archives for each missing dataset
cd /tmp/restore
for doi in 17306881 17613953 17613958 17613961 17613963; do
  # Find latest version from Zenodo page
  # Download: https://zenodo.org/records/{doi}/files/{dataset_id}-v{version}.zip?download=1
  curl -L "https://zenodo.org/records/${doi}/files/..." -o "nm00010X-vX.X.X.zip"
done
```

**Dataset → Zenodo Mapping:**
| Dataset | Concept DOI | Name |
|---------|-------------|------|
| nm000103 | 10.5281/zenodo.17306881 | HBN-EEG NC |
| nm000104 | 10.5281/zenodo.17613953 | emg2qwerty |
| nm000105 | 10.5281/zenodo.17613958 | discrete_gestures |
| nm000106 | 10.5281/zenodo.17613961 | handwriting |
| nm000107 | 10.5281/zenodo.17613963 | wrist |

---

### STEP 4: RUN RESTORATION SCRIPT (30-60 minutes)

```bash
# CRITICAL: Verify you have the script and credentials
cd /tmp/restore
ls -lh nemar-restore-dataset.sh  # Should exist
chmod +x nemar-restore-dataset.sh

# Set AWS credentials
export AWS_ACCESS_KEY_ID="<from-1password>"
export AWS_SECRET_ACCESS_KEY="<from-1password>"

# Restore each dataset (smallest first for quick validation)
./nemar-restore-dataset.sh nm000105 v1.1.0 "discrete_gestures" \
  10.5281/zenodo.17613958 f9028a54-3d7e-4af0-994f-19dc40de6a0a

# If first one succeeds, continue with others:
./nemar-restore-dataset.sh nm000107 v1.1.0 "wrist" \
  10.5281/zenodo.17613963 b4c4e0f8-6f5d-4960-a7d2-1484f06d573d

./nemar-restore-dataset.sh nm000106 v1.1.0 "handwriting" \
  10.5281/zenodo.17613961 3aaf506c-8474-43ff-854c-b9f22ca415d7

./nemar-restore-dataset.sh nm000104 v1.1.0 "emg2qwerty" \
  10.5281/zenodo.17613953 a2cae823-ec7e-4733-a0d9-a4e6876bbb46

./nemar-restore-dataset.sh nm000103 v1.0.0 "HBN-EEG NC" \
  10.5281/zenodo.17306881 4f073991-06ed-4587-93a0-36b4b5535ad0
```

**Watch for:**
- ✅ Green SUCCESS messages at each step
- ❌ Red ERROR messages → STOP and investigate
- 🟡 Yellow WARNING messages → Note but continue

---

### STEP 5: VERIFY GITHUB RESTORATION (10 minutes)

```bash
# Check all repos exist
for dataset in nm000103 nm000104 nm000105 nm000106 nm000107; do
  gh repo view nemarDatasets/$dataset --json name,isPrivate,url
done

# Check both branches present
for dataset in nm000103 nm000104 nm000105 nm000106 nm000107; do
  echo "$dataset branches:"
  gh api repos/nemarDatasets/$dataset/branches --jq '.[].name'
done

# CRITICAL: Verify README is NOT annexed
for dataset in nm000103 nm000104 nm000105 nm000106 nm000107; do
  size=$(gh api repos/nemarDatasets/$dataset/contents/README.md --jq '.size')
  echo "$dataset README: $size bytes"
  if [ "$size" -lt 100 ]; then
    echo "  ⚠️  WARNING: README may be annexed (too small)"
  fi
done
```

**Expected:**
- All repos exist and are PRIVATE
- Both `main` and `git-annex` branches present
- README files are 2-10 KB (actual content, not 69-byte pointers)

---

### STEP 6: RESTORE DATABASE ENTRIES (5 minutes)

```bash
# Run the SQL restoration script
wrangler d1 execute nemar-db --remote --file=/tmp/restore/restore_database_entries.sql

# Verify restoration
wrangler d1 execute nemar-db --remote --command \
  "SELECT dataset_id, name, concept_doi, status FROM datasets
   WHERE dataset_id IN ('nm000103', 'nm000104', 'nm000105', 'nm000106', 'nm000107')
   ORDER BY dataset_id"
```

**Expected output:** 5 rows showing all datasets with status='active'

---

### STEP 7: TEST END-TO-END (15 minutes)

```bash
# Clone one dataset and test file download
cd /tmp/test-recovery
git clone git@github.com:nemarDatasets/nm000105.git
cd nm000105

# Verify README is readable
cat README.md | head -10
# Should show actual content, not "/annex/objects/..."

# Test downloading a data file
git annex get sub-000/ses-000/emg/sub-000_ses-000_task-discretegestures_emg.bdf
# Should download ~250 MB from S3 successfully

# Verify file is now present locally
ls -lh sub-000/ses-000/emg/sub-000_ses-000_task-discretegestures_emg.bdf
# Should show full file size, not small pointer
```

---

### STEP 8: DOCUMENT & NOTIFY (10 minutes)

```bash
# Create GitHub issue documenting the incident
gh issue create --repo nemarDatasets/nemar-cli \
  --title "Dataset Restoration: nm000103-nm000107 - $(date +%Y-%m-%d)" \
  --body "## Incident

**Date:** $(date)
**Datasets affected:** nm000103, nm000104, nm000105, nm000106, nm000107
**Cause:** [Describe what happened]
**Data loss:** None (S3 data intact, recovered from Zenodo archives)

## Recovery Actions

- [x] Verified S3 data intact
- [x] Downloaded Zenodo archives
- [x] Restored GitHub repositories
- [x] Restored database entries
- [x] Verified end-to-end functionality

## Restored Repositories

- https://github.com/nemarDatasets/nm000103
- https://github.com/nemarDatasets/nm000104
- https://github.com/nemarDatasets/nm000105
- https://github.com/nemarDatasets/nm000106
- https://github.com/nemarDatasets/nm000107

## Lessons Learned

[Document what went wrong and how to prevent it]

## Follow-up Actions

- [ ] Implement fail-safes (Issue #35)
- [ ] Update disaster recovery procedures
- [ ] Test recovery procedures quarterly

**Recovered by:** nemarRestore
**Contact:** yahya@osc.earth"

# Email notification to admin
echo "Subject: NEMAR Dataset Recovery Complete

Datasets nm000103-nm000107 have been successfully recovered.

See issue for details: [issue-url]

All datasets verified functional.

- NEMAR Restore
" | mail -s "NEMAR Recovery Complete" nemarAdmin@osc.earth
```

---

## 📋 QUICK REFERENCE

### Essential Credentials

**Store in 1Password:**
- AWS Access Key ID: `AKIASZJLRMPHWL33WDUL`
- AWS Secret Access Key: `[retrieve from 1Password]`
- GitHub SSH: `~/.ssh/config` → `nemar-neuromechanist-github`
- Wrangler auth: `wrangler login`

### Essential Files

**Must have ready:**
```
/tmp/restore/
├── nemar-restore-dataset.sh       # Main restoration script
├── restore_database_entries.sql   # Database restoration SQL
├── DISASTER_RECOVERY.md           # This guide
├── NEMAR_RESTORATION_GUIDE.md     # Detailed technical docs
└── NEMAR_USER_ROLES.md            # Account roles and access
```

### DataLad IDs (Critical for Restoration)

| Dataset | DataLad ID |
|---------|------------|
| nm000103 | 4f073991-06ed-4587-93a0-36b4b5535ad0 |
| nm000104 | a2cae823-ec7e-4733-a0d9-a4e6876bbb46 |
| nm000105 | f9028a54-3d7e-4af0-994f-19dc40de6a0a |
| nm000106 | 3aaf506c-8474-43ff-854c-b9f22ca415d7 |
| nm000107 | b4c4e0f8-6f5d-4960-a7d2-1484f06d573d |

---

## ⚠️ PREVENTION - FAIL-SAFES TO IMPLEMENT

### Backend Deletion Fail-Safes (CRITICAL - Must Implement)

**File:** `backend/src/routes/datasets.ts`

```typescript
// BEFORE allowing deletion, check:

// 1. CHECK: Does dataset have a concept DOI?
if (dataset.concept_doi || dataset.latest_version_doi) {
  throw new Error(
    `Cannot delete dataset ${dataset.dataset_id}: has DOI(s). ` +
    `Datasets with DOIs are preserved on Zenodo and cannot be deleted. ` +
    `Contact owner (yahya@osc.earth) if deletion is absolutely necessary.`
  );
}

// 2. CHECK: Is dataset public/published?
if (dataset.status === 'published' || dataset.visibility === 'public') {
  throw new Error(
    `Cannot delete published/public dataset ${dataset.dataset_id}. ` +
    `Published datasets must remain available. ` +
    `Contact owner (yahya@osc.earth) if deletion is absolutely necessary.`
  );
}

// 3. CHECK: Two-tier admin permissions
if (dataset.owner_user_id !== requesting_user_id) {
  if (!requesting_user_is_owner) {  // Only owner can delete others' datasets
    throw new Error(
      `Cannot delete dataset ${dataset.dataset_id}: ` +
      `Only the owner (yahya@osc.earth) can delete datasets created by other users.`
    );
  }
}

// 4. REQUIRE: Explicit confirmation
if (!request.body.confirm_deletion || request.body.confirmation_text !== dataset.dataset_id) {
  throw new Error(
    `Deletion requires explicit confirmation. ` +
    `Set confirm_deletion=true and confirmation_text='${dataset.dataset_id}'`
  );
}

// 5. AUDIT LOG: Record deletion attempt
await logAuditEvent({
  user_id: requesting_user_id,
  action: 'dataset_delete_attempt',
  resource_type: 'dataset',
  resource_id: dataset.dataset_id,
  details: JSON.stringify({
    has_doi: !!dataset.concept_doi,
    status: dataset.status,
    owner: dataset.owner_user_id
  })
});
```

### CLI Deletion Fail-Safes

**File:** `src/commands/dataset.ts`

```typescript
// DELETE command must:

// 1. Show warning about DOI datasets
if (datasetInfo.conceptDoi) {
  console.error(chalk.red('⚠️  WARNING: This dataset has a DOI!'));
  console.error(chalk.yellow(`   Concept DOI: ${datasetInfo.conceptDoi}`));
  console.error(chalk.yellow('   Datasets with DOIs are preserved on Zenodo.'));
  console.error(chalk.yellow('   Deletion is strongly discouraged.'));
  console.error('');
}

// 2. Require typing dataset ID to confirm
const confirmation = await prompt({
  type: 'text',
  name: 'confirm',
  message: `Type the dataset ID '${datasetId}' to confirm deletion:`
});

if (confirmation.confirm !== datasetId) {
  console.error(chalk.red('Deletion cancelled: confirmation did not match'));
  process.exit(1);
}

// 3. Show what will be deleted
console.log(chalk.yellow('\nThe following will be deleted:'));
console.log(chalk.yellow(`  • GitHub repository: nemarDatasets/${datasetId}`));
console.log(chalk.yellow(`  • Database entry`));
console.log(chalk.yellow(`  • S3 bucket: s3://nemar/${datasetId}/`));
console.log('');

// 4. Final confirmation
const finalConfirm = await prompt({
  type: 'confirm',
  name: 'final',
  message: 'Are you ABSOLUTELY SURE?',
  initial: false
});

if (!finalConfirm.final) {
  console.error(chalk.green('Deletion cancelled'));
  process.exit(0);
}
```

---

## 🔍 TROUBLESHOOTING

### Problem: "Bucket already exists" error

**Cause:** Trying to use `initremote` with existing S3 bucket

**Solution:** Use `registerurl` approach (already in script)

### Problem: README shows pointer on GitHub

**Cause:** `annex.largefiles` not configured before adding files

**Solution:**
```bash
# Delete repo and re-run restoration script
gh repo delete nemarDatasets/nm000105 --yes
/tmp/restore/nemar-restore-dataset.sh nm000105 v1.1.0 ...
```

### Problem: Can't download files (`git annex get` fails)

**Cause:** S3 URLs not registered or git-annex branch not pushed

**Solution:**
```bash
cd /path/to/dataset
# Re-register S3 URLs
git annex find --include='*.bdf' | while read file; do
  key=$(git annex lookupkey "$file")
  git annex registerurl "$key" \
    "https://nemar.s3.us-east-2.amazonaws.com/nm000105/$key"
done
git push origin git-annex
```

### Problem: Permission denied during cleanup

**Cause:** Git-annex locks files

**Solution:**
```bash
chmod -R +w /tmp/restore/restore_work/nm000105
rm -rf /tmp/restore/restore_work/nm000105
```

---

## 📞 EMERGENCY CONTACTS

| Role | Contact | When to Contact |
|------|---------|-----------------|
| **Owner** | yahya@osc.earth | S3 data missing, policy decisions |
| **nemarAdmin** | nemarAdmin@osc.earth | Database access, user issues |
| **AWS Support** | aws.amazon.com/support | S3 access issues |
| **GitHub Support** | support.github.com | Repository access issues |

---

## 📊 RECOVERY TIME OBJECTIVES (RTO)

| Component | Target RTO | Actual (2026-01-18) |
|-----------|------------|---------------------|
| **Assessment** | 5 min | 5 min |
| **S3 Verification** | 5 min | 3 min |
| **Download Archives** | 10 min | 8 min |
| **Restore 1 dataset** | 10 min | 7 min |
| **Restore all 5** | 60 min | 45 min |
| **Database restore** | 5 min | 2 min |
| **Verification** | 15 min | 10 min |
| **TOTAL** | **< 2 hours** | **< 90 min** |

---

## 🔄 QUARTERLY DRILL

**Every 3 months, test recovery procedure:**

1. Create test dataset `nm999999`
2. "Accidentally" delete it
3. Restore from Zenodo archive
4. Verify end-to-end functionality
5. Document timing and issues
6. Update procedures based on learnings

**Last drill:** 2026-01-18 (production incident)
**Next drill:** 2026-04-18

---

## 📝 VERSION HISTORY

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-18 | Initial version based on real incident recovery |

---

**This document saved lives (or at least datasets).**

**Keep it updated. Practice the drills. Implement the fail-safes.**

**🚨 In an emergency, read STEP 1-8 above. Don't read the whole document first.**
