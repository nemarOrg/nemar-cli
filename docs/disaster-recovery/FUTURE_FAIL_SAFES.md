# Backend Fail-Safes to Prevent Dataset Deletion

**Status:** TO BE IMPLEMENTED (Tracked in Issue #35)
**Priority:** P0 - Critical
**Version:** 1.0.0
**Date:** 2026-01-18

---

## Overview

This document specifies fail-safes that must be implemented in the NEMAR backend and CLI to prevent accidental deletion of production datasets. These requirements were identified after the 2026-01-18 incident where datasets nm000103-nm000107 were accidentally deleted.

**IMPORTANT:** These fail-safes are **not yet implemented**. This is a specification document for future development.

---

## Backend Deletion Fail-Safes (CRITICAL - Must Implement)

**File:** `backend/src/routes/datasets.ts`

**Requirements:** The backend must implement a DELETE endpoint with the following checks:

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

---

## CLI Deletion Fail-Safes

**File:** `src/commands/dataset.ts`

**Requirements:** The CLI delete command must implement the following safeguards:

```typescript
// DELETE command must:

// 1. Show warning about DOI datasets
if (datasetInfo.conceptDoi) {
  console.error(chalk.red('WARNING: This dataset has a DOI!'));
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
console.log(chalk.yellow(`  - GitHub repository: nemarDatasets/${datasetId}`));
console.log(chalk.yellow(`  - Database entry`));
console.log(chalk.yellow(`  - S3 bucket: s3://nemar/${datasetId}/`));
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

## Implementation Checklist

- [ ] Backend: Implement DELETE /datasets/:id endpoint
- [ ] Backend: Add DOI check
- [ ] Backend: Add published/public status check
- [ ] Backend: Add owner permission check
- [ ] Backend: Add explicit confirmation requirement
- [ ] Backend: Add audit logging
- [ ] CLI: Implement `nemar dataset delete` command
- [ ] CLI: Add DOI warning
- [ ] CLI: Add dataset ID confirmation prompt
- [ ] CLI: Add deletion preview
- [ ] CLI: Add final confirmation prompt
- [ ] Tests: Add integration tests for all fail-safes
- [ ] Tests: Verify audit logging
- [ ] Docs: Update user documentation

---

## Testing Requirements

### Unit Tests
- Backend rejects deletion of datasets with DOIs
- Backend rejects deletion of published datasets
- Backend requires explicit confirmation
- Backend logs all deletion attempts

### Integration Tests
- CLI shows appropriate warnings for DOI datasets
- CLI requires correct dataset ID to be typed
- CLI shows preview of what will be deleted
- Full deletion flow succeeds for valid deletions
- Full deletion flow fails appropriately for protected datasets

---

## Deployment Plan

1. Implement backend fail-safes first
2. Deploy backend changes to staging
3. Test thoroughly with test datasets
4. Deploy backend to production
5. Implement CLI fail-safes
6. Release new CLI version
7. Document new deletion procedure

---

## Related

- **Issue:** #35 - Two-tier admin permissions and deletion fail-safes
- **Context:** 2026-01-18 incident (datasets nm000103-nm000107 accidentally deleted)
- **Recovery:** See DISASTER_RECOVERY.md

---

**This is a specification document. None of these fail-safes are currently implemented.**
