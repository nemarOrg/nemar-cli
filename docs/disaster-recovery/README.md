# NEMAR Disaster Recovery Documentation

This directory contains comprehensive disaster recovery procedures for NEMAR dataset restoration.

## 📚 Documentation

### [DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md)
**🚨 EMERGENCY RESPONSE GUIDE**

**Use this first in an emergency!**

- 8-step emergency procedure (< 2 hour recovery)
- Quick reference cards
- Essential credentials and contacts
- Troubleshooting guide
- Backend fail-safe specifications

**Target Audience:** nemarRestore operator, Emergency responder

---

### [NEMAR_RESTORATION_GUIDE.md](./NEMAR_RESTORATION_GUIDE.md)
**Complete Technical Documentation**

Detailed technical guide covering:
- Restoration architecture
- Step-by-step procedures with verification
- Git-annex and DataLad integration
- End-user verification tests
- Technical deep-dives

**Target Audience:** Developers, Technical operators

---

### [NEMAR_USER_ROLES.md](./NEMAR_USER_ROLES.md)
**User Roles and Responsibilities**

Defines the NEMAR user account structure:
- **Owner** (yahya@osc.earth) - Super user, policy decisions
- **nemarAdmin** (nemarAdmin@osc.earth) - Day-to-day operations
- **nemarRestore** (nemarRestore@osc.earth) - Disaster recovery service account

**Target Audience:** Administrators, New team members

---

## 🛠️ Scripts

Located in `/scripts/`:

### `nemar-restore-dataset.sh`
Production-ready restoration script for individual datasets.

**Usage:**
```bash
export AWS_ACCESS_KEY_ID="<key>"
export AWS_SECRET_ACCESS_KEY="<secret>"

./scripts/nemar-restore-dataset.sh \
  <dataset_id> \
  <version> \
  <name> \
  <zenodo_doi> \
  <datalad_id>
```

**Example:**
```bash
./scripts/nemar-restore-dataset.sh \
  nm000105 \
  v1.1.0 \
  "discrete_gestures" \
  10.5281/zenodo.17613958 \
  f9028a54-3d7e-4af0-994f-19dc40de6a0a
```

---

### `restore_database_entries.sql`
SQL script to restore database entries after GitHub restoration.

**Usage:**
```bash
wrangler d1 execute nemar-db --remote --file=scripts/restore_database_entries.sql
```

---

## 🚨 Emergency Quick Start

**IF DATASETS ARE ACCIDENTALLY DELETED:**

1. **Stay calm** - S3 data is likely intact
2. Open [DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md)
3. Follow **STEP 1-8** (don't read the whole doc first)
4. Target recovery time: < 2 hours

**Emergency Contact:** yahya@osc.earth

---

## 📖 Background

This disaster recovery system was developed in response to a real incident on 2026-01-18 when datasets nm000103-nm000107 were accidentally deleted during test dataset cleanup.

### What Happened
- 5 production datasets accidentally deleted from GitHub and database
- S3 data remained intact (7,976 files)
- All datasets had Zenodo preservation archives

### Recovery Process
- Retrieved datasets from Zenodo archives
- Restored GitHub repositories with git-annex configuration
- Restored database entries
- **Total recovery time: 90 minutes** (target: < 2 hours)
- **Data loss: None**

### Lessons Learned
1. Zenodo archives are critical for disaster recovery
2. S3 separation protects data layer
3. Git-annex configuration requires careful setup
4. Backend fail-safes needed to prevent deletion
5. Clear procedures enable fast recovery

---

## 🔄 Maintenance

### Quarterly Recovery Drill
Test the recovery procedure every 3 months:

1. Create test dataset (nm999999)
2. "Accidentally" delete it
3. Restore from Zenodo archive
4. Verify end-to-end functionality
5. Document timing and issues
6. Update procedures based on learnings

**Last drill:** 2026-01-18 (production incident)
**Next drill:** 2026-04-18

---

## 🔗 Related Issues

- [Issue #37](https://github.com/nemarDatasets/nemar-cli/issues/37) - Dataset restoration incident and procedures
- [Issue #35](https://github.com/nemarDatasets/nemar-cli/issues/35) - Backend fail-safes for dataset deletion
- [Issue #34](https://github.com/nemarDatasets/nemar-cli/issues/34) - Add --yes flags for non-interactive mode

---

## 📞 Contacts

| Role | Email | Purpose |
|------|-------|---------|
| **Owner** | yahya@osc.earth | Emergency decisions, S3 data issues |
| **nemarAdmin** | nemarAdmin@osc.earth | Day-to-day operations, user management |
| **nemarRestore** | nemarRestore@osc.earth | Service account for git commits |

---

## 📝 Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-18 | Initial disaster recovery system based on real incident |

---

**This documentation may save your datasets. Keep it updated.**
