# NEMAR User Roles and Responsibilities

**Version:** 1.0.0
**Date:** 2026-01-18

## User Accounts

NEMAR system uses dedicated service accounts for different operational tasks:

| Account | Email | Role | Responsibilities |
|---------|-------|------|------------------|
| **Owner** | `yahya@osc.earth` | Super User | System ownership, full access, policy decisions |
| **nemarAdmin** | `nemarAdmin@osc.earth` | Administrator | User approval, dataset creation, routine admin |
| **nemarRestore** | `nemarRestore@osc.earth` | Restore Agent | Dataset restoration, git commits for recovered data |

---

## Role Details

### Owner (yahya@osc.earth)

**Purpose:** Ultimate system authority and oversight

**Responsibilities:**
- System ownership and governance
- Policy and architectural decisions
- Super-user access to all systems
- Emergency interventions
- Delegation of administrative tasks

**Access:**
- Full access to all GitHub organizations
- AWS root/admin credentials
- Cloudflare admin access
- All database permissions

**Notes:**
- Retains ownership but delegates routine operations to nemarAdmin
- Involved in critical decisions and emergencies
- Not used for day-to-day operations

---

### nemarAdmin (nemarAdmin@osc.earth)

**Purpose:** Day-to-day administrative operations

**Responsibilities:**
- Approve new user registrations
- Create dataset repositories
- Manage user permissions
- Create concept DOIs for datasets
- Handle routine administrative tasks
- Monitor system health

**Access:**
- Admin role in backend database
- GitHub organization admin (nemarDatasets)
- Dataset creation permissions
- User management interface
- Zenodo DOI creation

**Typical Operations:**
```bash
# Approve pending user
nemar admin approve <username>

# Create concept DOI
nemar admin doi create <dataset_id>

# List pending users
nemar admin users --pending

# Revoke user access
nemar admin revoke <username>
```

**Notes:**
- Primary contact for user support
- Handles dataset lifecycle management
- Does NOT have super-user/owner privileges
- Escalates to Owner for policy decisions

---

### nemarRestore (nemarRestore@osc.earth)

**Purpose:** Automated dataset restoration and recovery operations

**Responsibilities:**
- Restore datasets from Zenodo archives
- Recreate GitHub repositories after deletion
- Git commit attribution for restored datasets
- Documentation of restoration process
- Verification of restored data integrity

**Access:**
- Git commit identity
- GitHub push access (via scripts)
- AWS read access to S3 (for verification)
- No interactive login (service account)

**Usage:**
This account is used **only** for git commit identity during restoration:

```bash
# Git configuration in restoration scripts
git config user.name "NEMAR Restore"
git config user.email "nemarRestore@osc.earth"

# Commits appear as:
Author: NEMAR Restore <nemarRestore@osc.earth>
Date:   Sat Jan 18 18:30:00 2026 +0000

    Restore nm000105 from Zenodo archive
    ...
    Restored by: NEMAR Restore
```

**Notes:**
- Service account, not for human login
- Used exclusively for restoration commits
- Provides clear audit trail for recovered datasets
- Commits are signed "Restored by: NEMAR Restore"

---

## Workflow Examples

### New User Registration

1. User submits registration via CLI
2. Email verification sent
3. **nemarAdmin** receives notification
4. **nemarAdmin** reviews and approves
5. System generates credentials
6. User receives approval email

### Dataset Creation

1. User validates BIDS dataset locally
2. User runs `nemar dataset upload`
3. System creates GitHub repo
4. System uploads to S3
5. **nemarAdmin** creates concept DOI
6. Dataset published

### Dataset Restoration

1. Dataset accidentally deleted
2. **Owner** or **nemarAdmin** identifies need
3. Run restoration script (uses **nemarRestore** identity)
4. Script commits as "NEMAR Restore <nemarRestore@osc.earth>"
5. Verification performed
6. Database entries restored by **nemarAdmin**

---

## Security Considerations

### Principle of Least Privilege

- **nemarAdmin**: Can manage users and datasets, cannot modify system architecture
- **nemarRestore**: Can only commit to git, no database or user management access
- **Owner**: Retains full access but delegates routine operations

### Access Separation

```
Owner (yahya)
    ├── Full system access
    ├── Policy decisions
    └── Emergency interventions

nemarAdmin
    ├── User management
    ├── Dataset management
    └── DOI creation

nemarRestore (Service Account)
    └── Git commit identity only
```

### Audit Trail

All operations are logged with appropriate attribution:

- User approvals → Logged to nemarAdmin
- Dataset restorations → Git commits by NEMAR Restore
- System changes → Logged to Owner
- API usage → Logged per user's API token

---

## Future Enhancements

### Two-Tier Admin Permissions (Issue #35)

Planned enhancement to dataset deletion:

**Tier 1: nemarAdmin**
- Can delete datasets they created
- Cannot delete owner-created datasets
- Requires confirmation for deletions

**Tier 2: Owner**
- Can delete any dataset
- Requires double confirmation
- Logged with full audit trail

### Automated Restore Triggers

Future automation could:
- Detect accidental deletions
- Trigger restoration automatically
- Notify **nemarAdmin** of recovery
- Update database entries

---

## Contact

**For Administrative Questions:**
- Email: nemarAdmin@osc.earth
- Role: Day-to-day operations, user management

**For System/Policy Questions:**
- Email: yahya@osc.earth
- Role: System owner, architectural decisions

**For Technical Documentation:**
- See: NEMAR_RESTORATION_GUIDE.md
- See: Repository CLAUDE.md files

---

## References

- [NEMAR CLI Repository](https://github.com/nemarOrg/nemar-cli)
- [Issue #35: Two-tier admin permissions](https://github.com/nemarOrg/nemar-cli/issues/35)
- [Issue #37: Dataset restoration](https://github.com/nemarOrg/nemar-cli/issues/37)

---

**Maintained by:** NEMAR Development Team
**Last Updated:** 2026-01-18
