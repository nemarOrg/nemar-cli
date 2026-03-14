# NEMAR Dataset Restoration Guide

**Version:** 1.0.0
**Date:** 2026-01-18
**Author:** NEMAR Development Team

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Restoration Architecture](#restoration-architecture)
4. [Quick Start](#quick-start)
5. [Detailed Procedure](#detailed-procedure)
6. [Verification](#verification)
7. [Troubleshooting](#troubleshooting)
8. [Technical Details](#technical-details)

---

## Overview

This guide documents the process for restoring NEMAR datasets from Zenodo preservation archives back to functional GitHub repositories with git-annex integration for S3-backed data storage.

### What Gets Restored

✅ **Preserved:**
- All S3 data files (never deleted)
- Dataset metadata (BIDS structure, README, JSON files)
- DataLad dataset IDs
- Git-annex pointer files
- S3 file locations

❌ **Lost (Not in Zenodo Archives):**
- Original git commit history
- Original git-annex repository UUIDs
- Git-annex location tracking branch

### Restoration Goals

1. **Functional Repository:** Users can clone and use `git annex get` to download files
2. **Correct File Storage:** Metadata in git, data files in git-annex
3. **S3 Integration:** Git-annex knows where to find files in S3
4. **BIDS Compliance:** Dataset structure and metadata intact
5. **Documentation:** Clear commit messages explaining restoration

---

## Prerequisites

### Required Tools

```bash
# Check if all tools are installed
command -v git && \
command -v git-annex && \
command -v gh && \
command -v unzip && \
command -v curl && \
echo "All tools installed ✓"
```

| Tool | Purpose | Install |
|------|---------|---------|
| `git` | Version control | `brew install git` |
| `git-annex` | Large file management | `brew install git-annex` |
| `gh` | GitHub CLI | `brew install gh` |
| `unzip` | Archive extraction | Built-in on macOS |
| `curl` | URL downloads | Built-in on macOS |

### Required Credentials

1. **AWS Credentials** - For S3 access verification (retrieve from 1Password)
   ```bash
   export AWS_ACCESS_KEY_ID="<from-1password>"
   export AWS_SECRET_ACCESS_KEY="<from-1password>"
   ```

2. **GitHub Authentication** - For repository creation
   ```bash
   gh auth login
   # Select: GitHub.com → SSH → Authenticate
   ```

3. **Multi-Account GitHub SSH** - For pushing to nemarDatasets org
   - Configured in `~/.ssh/config` as `nemar-neuromechanist-github`

### Required Files

- Zenodo archive ZIP files in `/tmp/restore/`
  - Format: `{dataset_id}-v{version}.zip`
  - Example: `nm000105-v1.1.0.zip`

---

## Restoration Architecture

### File Storage Strategy

```
Dataset Repository
│
├── Metadata (Regular Git)
│   ├── README.md                    # Human-readable content
│   ├── dataset_description.json     # BIDS metadata
│   ├── participants.json/tsv        # Subject metadata
│   ├── CHANGES                      # Version history
│   ├── LICENSE                      # Data license
│   └── .datalad/                    # DataLad config
│
└── Data Files (Git-Annex → S3)
    └── sub-*/ses-*/
        └── *.bdf, *.edf, *.set      # Pointer files
            ↓
            s3://nemar/{dataset_id}/{MD5E-key}
```

### Git-Annex Configuration

**Largefiles Policy:**
```bash
annex.largefiles='(include=*.edf or include=*.bdf or include=*.set or include=*.fif or include=*.vhdr or include=*.eeg or include=*.cnt or include=*.fdt or largerthan=100kb) and exclude=*.tsv and exclude=*.json and exclude=*.md and exclude=*.txt and exclude=*.yml and exclude=*.yaml and exclude=README* and exclude=LICENSE* and exclude=CHANGES* and exclude=.bidsignore and exclude=.gitignore'
```

**What This Means:**
- Files matching EEG/MEG extensions (`*.edf`, `*.bdf`, `*.set`, etc.) -> Git-annex (S3)
- Files > 100 KB -> Git-annex (S3)
- EXCEPT metadata files (`.tsv`, `.json`, `.md`, `.txt`, `.yml`, etc.) -> Always regular git
- `*.tsv.gz` is NOT excluded (compressed data, annexed normally)

### GitHub Structure

```
GitHub Repository: nemarDatasets/{dataset_id}
│
├── main branch
│   ├── Metadata files (actual content)
│   └── Data files (git-annex pointers)
│
└── git-annex branch
    ├── Location tracking (where files are)
    ├── UUID registry
    └── S3 URL mappings
```

---

## Quick Start

### Single Dataset Restoration

```bash
# 1. Set AWS credentials (retrieve from 1Password)
export AWS_ACCESS_KEY_ID="<from-1password>"
export AWS_SECRET_ACCESS_KEY="<from-1password>"

# 2. Make script executable
chmod +x /tmp/restore/nemar-restore-dataset.sh

# 3. Restore dataset
/tmp/restore/nemar-restore-dataset.sh \
  nm000105 \
  v1.1.0 \
  "discrete_gestures" \
  10.5281/zenodo.17613958 \
  f9028a54-3d7e-4af0-994f-19dc40de6a0a

# Result:
# ✅ Repository created at https://github.com/nemarDatasets/nm000105
```

### Batch Restoration (All 5 Datasets)

```bash
# Use the batch script (retrieve credentials from 1Password)
export AWS_ACCESS_KEY_ID="<from-1password>"
export AWS_SECRET_ACCESS_KEY="<from-1password>"

/tmp/restore/restore_all_datasets.sh
```

---

## Detailed Procedure

### Step-by-Step Process

#### 1. Extract Zenodo Archive (Step 1/13)

```bash
# Clean workspace
rm -rf /tmp/restore/restore_work/nm000105

# Extract archive
cd /tmp/restore/restore_work/nm000105
unzip -q /tmp/restore/nm000105-v1.1.0.zip
cd nm000105-1.1.0

# Verify BIDS dataset
test -f dataset_description.json && echo "✓ Valid BIDS dataset"
```

**What happens:**
- Removes any previous restoration attempts
- Extracts Zenodo ZIP to working directory
- Verifies dataset structure

#### 2. Initialize Git (Steps 2-3/13)

```bash
# Initialize repository
git init
git config user.name "NEMAR Restore"
git config user.email "nemarRestore@osc.earth"

# Initialize git-annex
git annex init "nm000105-restored"
```

**What happens:**
- Creates new git repository
- Sets committer identity to "NEMAR Restore"
- Initializes git-annex (generates new UUID)

#### 3. Configure Annexing Policy (Step 4/13)

```bash
# Configure what should be annexed (data files only, never metadata)
git annex config --set annex.largefiles \
  '(include=*.edf or include=*.bdf or include=*.set or include=*.fif or include=*.vhdr or include=*.eeg or include=*.cnt or include=*.fdt or largerthan=100kb) and exclude=*.tsv and exclude=*.json and exclude=*.md and exclude=*.txt and exclude=*.yml and exclude=*.yaml and exclude=README* and exclude=LICENSE* and exclude=CHANGES* and exclude=.bidsignore and exclude=.gitignore'
```

**Critical Step:**
- Ensures data files are annexed to S3
- Metadata files (TSV, JSON, MD, txt) always stay in git regardless of size
- Without this, large TSV/JSON files become annex pointers and break BIDS validation

#### 4. Add Files (Step 5/13)

```bash
# Add all files (respects largefiles config)
git annex add .
```

**What happens:**
- Data files (*.bdf, *.edf, *.set) → Added to git-annex
- Metadata files (README.md, *.json, *.tsv) → Added to git
- Git-annex recognizes existing pointer files from Zenodo

**Verification:**
```bash
# Check README is in git (not annexed)
git ls-files -s README.md
# Should show: 100644 <hash> 0 README.md
# NOT: 120000 (symlink = annexed)

# Check .bdf is annexed
git ls-files -s sub-000/ses-000/emg/*.bdf
# Should show: 100644 <hash> 0 file.bdf (pointer)
```

#### 5. Create Commit (Step 6/13)

```bash
git commit -m "Restore nm000105 from Zenodo archive

Dataset: discrete_gestures v1.1.0
Zenodo DOI: 10.5281/zenodo.17613958
DataLad ID: f9028a54-3d7e-4af0-994f-19dc40de6a0a
S3 Location: s3://nemar/nm000105/

Restoration Details:
- Restored from Zenodo preservation archive
- Original git history was not preserved
- DataLad dataset ID preserved
- S3 data files remain intact

Restored by: NEMAR Restore
Date: 2026-01-18 18:30:00 UTC"
```

**Commit Message Format:**
- Clear description of what was restored
- All relevant identifiers (Zenodo DOI, DataLad ID, S3 location)
- Restoration context (what was lost, what was preserved)
- Signature: "Restored by: NEMAR Restore"

#### 6. Register S3 URLs (Steps 7-8/13)

```bash
# For each annexed file, register its S3 URL
git annex find --include='*.bdf' | while read file; do
  key=$(git annex lookupkey "$file")
  git annex registerurl "$key" \
    "https://nemar.s3.us-east-2.amazonaws.com/nm000105/$key"
done
```

**What happens:**
- Tells git-annex where to download files from
- No S3 special remote created (avoids UUID conflicts)
- Uses public S3 URLs (HTTPS)

**Verification:**
```bash
git annex whereis sub-000/ses-000/emg/*.bdf
# Should show:
#   web: https://nemar.s3.us-east-2.amazonaws.com/nm000105/MD5E-...
```

#### 7. Create GitHub Repository (Steps 10-11/13)

```bash
# Create private repository
gh repo create nemarDatasets/nm000105 \
  --private \
  --description "NEMAR Dataset nm000105: discrete_gestures (Restored from Zenodo)"

# Add remote
git remote add origin \
  git@nemar-neuromechanist-github:nemarDatasets/nm000105.git
```

#### 8. Push to GitHub (Step 12/13)

```bash
# Push main branch
git push -u origin main

# Push git-annex branch (contains location tracking)
git push origin git-annex
```

**Why git-annex branch matters:**
- Contains S3 URL mappings
- Required for `git annex get` to work
- Other users need this to download files

#### 9. Verify (Step 13/13)

```bash
# Check repository exists
gh repo view nemarDatasets/nm000105

# Verify branches
git ls-remote origin
# Should show:
#   refs/heads/main
#   refs/heads/git-annex

# Test file download
git annex get sub-000/ses-000/emg/sub-000_ses-000_task-discretegestures_emg.bdf
```

---

## Verification

### GitHub Verification Checklist

| Check | Command | Expected Result |
|-------|---------|-----------------|
| **Repository exists** | `gh repo view nemarDatasets/{id}` | Shows repo URL |
| **README is readable** | Visit repo on GitHub | See README content, not pointer |
| **Both branches exist** | `git ls-remote origin` | See `main` and `git-annex` |
| **Repository is private** | Check GitHub settings | 🔒 Private |

### Local Verification

```bash
cd /tmp/restore/restore_work/nm000105/nm000105-1.1.0

# 1. Check file types
git ls-files -s README.md           # Should be 100644 (regular file)
git ls-files -s sub-*/ses-*/emg/*.bdf  # Should be 100644 (pointer)

# 2. Check README content
git show HEAD:README.md | head
# Should show actual README text, not "/annex/objects/..."

# 3. Check .bdf content
git show HEAD:sub-000/ses-000/emg/*.bdf
# Should show: /annex/objects/MD5E-...

# 4. Check S3 URLs registered
git annex whereis sub-000/ses-000/emg/*.bdf
# Should show web URL to S3

# 5. Test download
git annex get sub-000/ses-000/emg/*.bdf
# Should download from S3 successfully
```

### End-User Verification

Simulate what a user would do:

```bash
# Clone repository
git clone git@github.com:nemarDatasets/nm000105.git
cd nm000105

# Check metadata files are readable
cat README.md          # Should show actual content
cat dataset_description.json  # Should show JSON

# Check data files are pointers
ls -lh sub-000/ses-000/emg/*.bdf
# Should show small file (pointer), not 250 MB

# Download a file
git annex get sub-000/ses-000/emg/sub-000_ses-000_task-discretegestures_emg.bdf
# Should download 250+ MB from S3

# Verify file is now present
ls -lh sub-000/ses-000/emg/*.bdf
# Should show full file size
```

---

## Troubleshooting

### Common Issues

#### Issue 1: README Shows Pointer on GitHub

**Symptom:**
```
README.md shows:
.git/annex/objects/F3/VM/MD5E-...
```

**Cause:** `annex.largefiles` not configured before adding files

**Fix:**
```bash
# Delete repository and re-run with fixed script
gh repo delete nemarDatasets/nm000105 --yes
/tmp/restore/nemar-restore-dataset.sh nm000105 v1.1.0 ...
```

#### Issue 2: "Bucket already exists" Error

**Symptom:**
```
git-annex: Cannot reuse this bucket.
The bucket already exists, and its annex-uuid file indicates
it is used by a different special remote.
```

**Cause:** Trying to use `initremote` instead of `registerurl`

**Fix:** Use `registerurl` approach (already in script)

#### Issue 3: Can't Download Files

**Symptom:**
```bash
git annex get file.bdf
# No sources available
```

**Cause:** S3 URLs not registered

**Fix:**
```bash
# Re-register URLs
git annex find --include='*.bdf' | while read file; do
  key=$(git annex lookupkey "$file")
  git annex registerurl "$key" \
    "https://nemar.s3.us-east-2.amazonaws.com/nm000105/$key"
done
git push origin git-annex
```

#### Issue 4: Permission Denied on Cleanup

**Symptom:**
```bash
rm: .git/annex/objects/.../file: Permission denied
```

**Cause:** Git-annex locks files for safety

**Fix:**
```bash
chmod -R +w /tmp/restore/restore_work/nm000105
rm -rf /tmp/restore/restore_work/nm000105
```

---

## Technical Details

### Git-Annex Architecture

**What is git-annex?**
- Manages large files without storing them in git
- Tracks file locations (S3, local, other remotes)
- Uses symlinks (or pointer files) in working directory
- Actual files stored in `.git/annex/objects/`

**How Pointer Files Work:**

1. **Before git-annex:**
   ```
   data.bdf (250 MB actual file)
   ```

2. **After git annex add:**
   ```
   data.bdf → .git/annex/objects/.../MD5E-s250MB--hash.bdf
   ```

3. **What gets committed to git:**
   ```
   /annex/objects/MD5E-s250000000--abc123.bdf
   ```

4. **On GitHub:**
   - Shows as regular file (100644)
   - Content is pointer text (69 bytes)
   - Not a symlink (GitHub doesn't support those)

5. **When user clones:**
   ```bash
   git clone repo.git
   # data.bdf is a pointer file (69 bytes)

   git annex get data.bdf
   # Downloads from S3, creates symlink to .git/annex/objects/
   # data.bdf is now accessible as regular file
   ```

### S3 URL Registration

**Why registerurl instead of S3 special remote?**

| Approach | Pros | Cons |
|----------|------|------|
| **S3 Special Remote** | Full git-annex integration | Requires matching UUID |
| | Can upload/download | Conflicts with existing bucket |
| | Tracks costs | Can't reuse bucket |
| **Register URL** | No UUID conflicts ✓ | Read-only |
| | Works with existing buckets ✓ | No upload capability |
| | Simple setup ✓ | Manual URL management |

Since S3 data already exists and we're restoring (not creating), `registerurl` is the correct approach.

### DataLad Compatibility

**DataLad ID Preservation:**
```bash
# Stored in .datalad/config
cat .datalad/config
[datalad "dataset"]
    id = f9028a54-3d7e-4af0-994f-19dc40de6a0a
```

This ID is preserved during restoration, maintaining DataLad compatibility.

**DataLad Commands Still Work:**
```bash
datalad get sub-000/ses-000/emg/*.bdf  # Same as git annex get
datalad status                          # Shows dataset status
```

### Git Commit Identity

**Why "NEMAR Restore"?**

Using a dedicated identity for restoration commits:
1. **Clear Provenance:** Anyone looking at git history knows this was a restoration
2. **Audit Trail:** Easy to identify restored vs original commits
3. **Consistency:** All restorations use same identity
4. **Professionalism:** Official NEMAR agent, not personal account

**Commit Signature:**
```
Author: NEMAR Restore <nemarRestore@osc.earth>
Date:   Sat Jan 18 18:30:00 2026 +0000

    Restore nm000105 from Zenodo archive
    ...
    Restored by: NEMAR Restore
```

---

## Dataset-Specific Information

### Datasets to Restore

| Dataset ID | Version | Name | Zenodo DOI | DataLad ID | Files |
|------------|---------|------|------------|------------|-------|
| nm000103 | v1.0.0 | HBN-EEG NC | 10.5281/zenodo.17306881 | 4f073991-06ed-4587-93a0-36b4b5535ad0 | 3,523 |
| nm000104 | v1.1.0 | emg2qwerty | 10.5281/zenodo.17613953 | a2cae823-ec7e-4733-a0d9-a4e6876bbb46 | 2,272 |
| nm000105 | v1.1.0 | discrete_gestures | 10.5281/zenodo.17613958 | f9028a54-3d7e-4af0-994f-19dc40de6a0a | 201 |
| nm000106 | v1.1.0 | handwriting | 10.5281/zenodo.17613961 | 3aaf506c-8474-43ff-854c-b9f22ca415d7 | 1,615 |
| nm000107 | v1.1.0 | wrist | 10.5281/zenodo.17613963 | b4c4e0f8-6f5d-4960-a7d2-1484f06d573d | 365 |

### Restoration Commands

```bash
# nm000103
/tmp/restore/nemar-restore-dataset.sh nm000103 v1.0.0 "HBN-EEG NC" \
  10.5281/zenodo.17306881 4f073991-06ed-4587-93a0-36b4b5535ad0

# nm000104
/tmp/restore/nemar-restore-dataset.sh nm000104 v1.1.0 "emg2qwerty" \
  10.5281/zenodo.17613953 a2cae823-ec7e-4733-a0d9-a4e6876bbb46

# nm000105
/tmp/restore/nemar-restore-dataset.sh nm000105 v1.1.0 "discrete_gestures" \
  10.5281/zenodo.17613958 f9028a54-3d7e-4af0-994f-19dc40de6a0a

# nm000106
/tmp/restore/nemar-restore-dataset.sh nm000106 v1.1.0 "handwriting" \
  10.5281/zenodo.17613961 3aaf506c-8474-43ff-854c-b9f22ca415d7

# nm000107
/tmp/restore/nemar-restore-dataset.sh nm000107 v1.1.0 "wrist" \
  10.5281/zenodo.17613963 b4c4e0f8-6f5d-4960-a7d2-1484f06d573d
```

---

## References

- [Git-annex Documentation](https://git-annex.branchable.com/)
- [DataLad Handbook](https://handbook.datalad.org/)
- [BIDS Specification](https://bids-specification.readthedocs.io/)
- [Zenodo](https://zenodo.org/)
- [NEMAR Project](https://nemar.org/)

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-18 | Initial comprehensive restoration guide |

---

**Maintained by:** NEMAR Development Team
**Last Updated:** 2026-01-18
