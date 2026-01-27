# Publishing Datasets

This guide explains how to publish private datasets to make them publicly accessible with a permanent DOI.

## Overview

The publication workflow transforms a private dataset into a public, citable resource through a multi-step process:

1. **User Request** - Dataset owner requests publication
2. **Admin Review** - NEMAR admin reviews and approves
3. **Automated Orchestrator** - System makes dataset public and assigns DOI
4. **Published** - Dataset is public with permanent DOI

## User Perspective

### Prerequisites

Before requesting publication, ensure your dataset:

- [x] Has been uploaded to NEMAR
- [x] Passes BIDS validation
- [x] Is complete and ready for public sharing
- [x] Has accurate metadata in `dataset_description.json`

### Requesting Publication

Submit a publication request for your dataset:

```bash
nemar dataset publish request nm000104
```

**What happens next:**
1. Your request is recorded in the system
2. All NEMAR admins receive an email notification
3. Your dataset remains private until approved
4. You can check status at any time

### Checking Status

Check the status of your publication request:

```bash
nemar dataset publish status nm000104
```

**Possible statuses:**
- `requested` - Waiting for admin review
- `approving` - Admin is running the publication process
- `published` - Dataset is now public with DOI
- `denied` - Request was denied (includes reason)

### Resending Notification

If admins haven't responded, you can resend the notification:

```bash
nemar dataset publish resend nm000104
```

This sends a reminder email to all admins without creating a duplicate request.

### After Approval

Once approved, you'll receive an email containing:

- ✅ Confirmation that your dataset is now public
- ✅ Your permanent DOI (e.g., `10.5281/zenodo.12345`)
- ✅ Link to the public dataset page
- ✅ Citation information

Your dataset is now:
- Publicly visible on GitHub
- Protected by tag protection (versions cannot be modified)
- Backed by permanent S3 storage with Object Lock
- Citable with a permanent DOI

## Admin Perspective

### Reviewing Requests

List all publication requests:

```bash
# All requests
nemar admin publish list

# Filter by status
nemar admin publish list --pending
nemar admin publish list --approved
nemar admin publish list --denied
```

**Output includes:**
- Dataset ID and name
- Requesting user
- Request date
- Current status
- Current step (if approving)

### Approving Publication

Approve a publication request:

```bash
nemar admin publish approve nm000104
```

**Interactive confirmation:**
The CLI will show you:
- Dataset information
- Requesting user
- What will happen (5 orchestrator steps)

You can:
- Press `y` to proceed
- Press `n` to cancel
- Use `--yes` flag to skip confirmation

**Non-interactive mode:**
```bash
nemar admin publish approve nm000104 --yes
```

### The Publication Orchestrator

When you approve a request, an automated 6-step orchestrator runs:

#### Step 1: CI Check
**Purpose:** Verify BIDS validation passes

**Actions:**
- Check if BIDS validation workflow exists
- Deploy workflows if missing
- Verify latest CI run passes (if any runs exist)

**Possible failure:**
- BIDS validation is failing
- **Resolution:** User needs to fix validation issues first

#### Step 2: Make Repository Public
**Purpose:** Make the dataset publicly accessible

**Actions:**
- Change GitHub repository visibility from private to public
- Dataset becomes visible at `github.com/nemarDatasets/<repo>`

**Possible failure:**
- GitHub API error
- **Resolution:** Check GitHub admin token permissions

#### Step 3: Tag Protection
**Purpose:** Prevent version manipulation

**Actions:**
- Enable tag protection rules on the repository
- Prevents deletion or modification of version tags
- Ensures DOI integrity (DOIs reference specific tags)

**Possible failure:**
- GitHub API error
- Repository already has conflicting rules

#### Step 4: Create Concept DOI
**Purpose:** Assign permanent DOI

**Actions:**
- Create Zenodo deposition (if no concept DOI exists)
- Pre-reserve concept DOI
- Link DOI to dataset in database

**Possible failure:**
- Zenodo API error
- Dataset already has concept DOI (not an error, step is skipped)

**Note:** This creates the **concept DOI** (parent DOI). Version DOIs are created automatically when users create new versions via git tags.

#### Step 5: S3 Object Lock
**Purpose:** Prevent data deletion

**Actions:**
- Enable S3 Object Lock on dataset bucket
- Ensures data referenced by DOI cannot be deleted
- Compliance mode (even admins cannot delete)

**Possible failure:**
- AWS API error
- Object Lock already enabled (not an error, step is skipped)

#### Step 6: Notify User
**Purpose:** Send publication confirmation email

**Actions:**
- Send email to dataset owner with:
  - Confirmation that dataset is now published
  - Permanent DOI for citation
  - Link to public dataset page
  - Citation information

**Possible failure:**
- Email service error
- **Resolution:** Email may fail but publication is complete; user can check status manually

**Note:** This is the final step. Once completed, the publication request status changes to "published".

### Resuming Failed Publications

If a step fails, you can resume from the failed step:

```bash
nemar admin publish approve nm000104 --resume
```

**How it works:**
- System remembers which steps completed successfully
- Only failed and remaining steps are re-run
- Safe to run multiple times (idempotent)

**Example scenario:**
```bash
# First attempt fails at step 3
nemar admin publish approve nm000104
# Error: Tag protection failed

# Fix the issue (e.g., remove conflicting GitHub rules)
# Then resume
nemar admin publish approve nm000104 --resume
# Skips completed steps 1-2, retries step 3, then continues with 4-6
```

### Denying Publication

Deny a publication request with a reason:

```bash
nemar admin publish deny nm000104 --reason "BIDS validation failing - please fix errors and resubmit"
```

**What happens:**
- Request status set to `denied`
- User receives email with your reason
- User can fix issues and submit a new request

## Email Notifications

### Publication Request Email (to admins)

**Subject:** `[NEMAR] Publication request for nm000104`

**Content:**
- Dataset information (ID, name)
- Requesting user details
- Link to dataset
- CLI command to approve/deny

### Publication Approved Email (to user)

**Subject:** `[NEMAR] Your dataset nm000104 has been published`

**Content:**
- Confirmation of publication
- Permanent DOI
- Link to public dataset
- Citation information
- Next steps (creating version DOIs)

### Publication Denied Email (to user)

**Subject:** `[NEMAR] Publication request for nm000104 denied`

**Content:**
- Denial reason from admin
- What to fix
- How to resubmit after fixing issues

## Troubleshooting

### User Issues

**Problem:** Request submission fails with "Dataset not found"
- **Cause:** Dataset ID is incorrect or dataset doesn't exist
- **Solution:** Check dataset ID with `nemar dataset list --mine`

**Problem:** Request submission fails with "Already published"
- **Cause:** Dataset is already public
- **Solution:** No action needed, dataset is already public

**Problem:** Request submission fails with "Unauthorized"
- **Cause:** Not logged in or not dataset owner
- **Solution:** Run `nemar auth login` and ensure you own the dataset

**Problem:** Status shows "denied" but I fixed the issues
- **Cause:** Old request was denied
- **Solution:** Submit a new request with `nemar dataset publish request <id>`

### Admin Issues

**Problem:** Approval fails at "CI Check" step
- **Cause:** BIDS validation is failing
- **Solution:** User needs to fix validation issues first. Deny request with clear reason.

**Problem:** Approval fails at "Make Repository Public" step
- **Cause:** GitHub API error or permissions issue
- **Solution:**
  - Check `GITHUB_ADMIN_PAT` is valid
  - Verify token has `repo` and `admin:org` scopes
  - Retry with `--resume`

**Problem:** Approval fails at "Tag Protection" step
- **Cause:** Conflicting tag protection rules
- **Solution:**
  - Check GitHub repository settings
  - Remove conflicting rules manually
  - Retry with `--resume`

**Problem:** Approval fails at "Create Concept DOI" step
- **Cause:** Zenodo API error
- **Solution:**
  - Check `ZENODO_API_KEY` is valid
  - Verify Zenodo service is operational
  - Retry with `--resume`

**Problem:** Approval fails at "S3 Object Lock" step
- **Cause:** AWS API error or permissions issue
- **Solution:**
  - Check AWS credentials are valid
  - Verify S3 bucket exists
  - Retry with `--resume`

**Problem:** Want to re-run entire orchestrator
- **Cause:** Need fresh start (not resume)
- **Solution:** Not currently supported. Contact dev team if needed.

## Best Practices

### For Users

1. **Validate before requesting** - Run `nemar dataset validate` locally first
2. **Complete metadata** - Ensure `dataset_description.json` is accurate
3. **Be patient** - Admins may take time to review
4. **Communicate** - If urgent, contact admins directly (don't just resend)

### For Admins

1. **Check CI first** - Review BIDS validation status before approving
2. **Use --resume** - If a step fails, fix the issue and resume (don't start over)
3. **Provide clear reasons** - When denying, explain exactly what needs fixing
4. **Monitor email** - Publication request emails help track new requests

## FAQ

**Q: How long does publication take?**
A: Once approved, the orchestrator takes 1-2 minutes to complete all 5 steps. Admin review time varies.

**Q: Can I unpublish a dataset?**
A: No. Once published, a dataset is permanently public. The DOI is permanent and cannot be deleted.

**Q: Can I update a published dataset?**
A: Yes. Dataset owners can update their datasets via direct pushes or pull requests.

**Q: What if I need to publish urgently?**
A: Contact NEMAR admins directly. Publication requests are processed in order received.

**Q: Can I have multiple publication requests?**
A: Only one active request per dataset. Previous requests must be completed (approved/denied) before submitting new ones.

**Q: What happens if orchestrator is interrupted?**
A: Use `--resume` to continue from the last successful step. The system tracks progress automatically.

## Related Commands

- `nemar dataset upload` - Upload a new dataset
- `nemar dataset validate` - Validate BIDS compliance
- `nemar admin doi create` - Create concept DOI (admin only)
- `nemar dataset push --pr` - Create PR for updates after publication

## See Also

- [Dataset Commands Reference](../commands/dataset.md)
- [Admin Commands Reference](../commands/admin.md)
- [Uploading Datasets Guide](uploading.md)
- [BIDS Validation Guide](validation.md)
