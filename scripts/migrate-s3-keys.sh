#!/usr/bin/env bash
#
# Re-key S3 objects from path-based to content-addressed storage.
#
# Datasets uploaded by CLI before v0.6.3 stored files on S3 using their
# original file paths (e.g., nm000113/objects/sub-01/eeg/file.edf).
# The S3 special remote expects content-addressed keys
# (e.g., nm000113/objects/SHA256E-s12345--abc.edf).
#
# This script:
#   1. Clones the repo and maps each annexed file to its git-annex key
#   2. Server-side copies each S3 object from path-based to content-addressed key
#   3. Creates the nemar-s3 S3 special remote via initremote
#   4. Runs fsck to update location tracking
#   5. Pushes the git-annex branch
#   6. Cleans up old path-based S3 objects
#
# Prerequisites:
#   - AWS credentials resolvable via the default chain
#     (~/.aws/credentials mode 0600, or aws sso login). Long-lived
#     AKIA keys in process env vars are rejected by the credentials
#     guard; see docs/operations/access-policies.md (principles 5 + 6).
#   - git-annex installed
#   - SSH access to nemarDatasets GitHub org
#
# Usage:
#   ./scripts/migrate-s3-keys.sh [--dry-run] dataset_id [dataset_id ...]
#
# Examples:
#   ./scripts/migrate-s3-keys.sh --dry-run nm000113
#   ./scripts/migrate-s3-keys.sh nm000109 nm000110 nm000111

set -euo pipefail

DRY_RUN=false
DATASETS=()

for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then
    DRY_RUN=true
  else
    DATASETS+=("$arg")
  fi
done

if [[ ${#DATASETS[@]} -eq 0 ]]; then
  echo "Usage: $0 [--dry-run] dataset_id [dataset_id ...]"
  echo "Example: $0 nm000109 nm000110 nm000111"
  exit 1
fi

# Verify AWS credentials via shared guard (rejects long-lived AKIA* keys
# in env, requires ~/.aws/credentials or aws sso login). See
# docs/operations/access-policies.md (principles 5 + 6).
# shellcheck source=lib/aws-creds-guard.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/aws-creds-guard.sh"
nemar_guard_aws_credentials || exit $?

# Verify git-annex is installed
if ! command -v git-annex &>/dev/null; then
  echo "ERROR: git-annex not found"
  exit 1
fi

if $DRY_RUN; then
  echo "=== DRY RUN MODE - No changes will be made ==="
fi

BUCKET="nemar"
REGION="us-east-2"
PUBLIC_URL="https://nemar.s3.us-east-2.amazonaws.com"
ORG="nemarDatasets"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

echo "Working directory: $WORK_DIR"
echo ""

SUCCESS=0
SKIPPED=0
FAILED=0

for ds in "${DATASETS[@]}"; do
  echo "============================================"
  echo "Processing $ds"
  echo "============================================"

  # Step 1: Check if remote.log already exists (idempotency)
  echo "  Step 1: Checking if already migrated..."
  HAS_REMOTE=$(gh api "repos/${ORG}/${ds}/git/trees/git-annex" \
    --jq '[.tree[].path | select(. == "remote.log")] | length' 2>/dev/null || echo "0")

  if [[ "$HAS_REMOTE" -gt 0 ]]; then
    echo "  SKIP: $ds already has remote.log on git-annex branch"
    SKIPPED=$((SKIPPED + 1))
    echo ""
    continue
  fi

  # Step 2: Clone the repo
  echo "  Step 2: Cloning..."
  REPO_DIR="${WORK_DIR}/${ds}"

  if ! git clone "git@github.com:${ORG}/${ds}.git" "$REPO_DIR" > "${WORK_DIR}/${ds}_clone.log" 2>&1; then
    echo "  FAIL: Could not clone $ds"
    tail -3 "${WORK_DIR}/${ds}_clone.log"
    FAILED=$((FAILED + 1))
    echo ""
    continue
  fi

  cd "$REPO_DIR"

  # Step 3: Initialize git-annex
  echo "  Step 3: Initializing git-annex..."
  if ! git annex init "migration" 2>&1; then
    echo "  FAIL: git annex init failed for $ds"
    FAILED=$((FAILED + 1))
    cd "$WORK_DIR"
    echo ""
    continue
  fi

  # Step 4: Map files to git-annex keys and copy S3 objects
  echo "  Step 4: Re-keying S3 objects (server-side copy)..."

  COPY_OK=0
  COPY_FAIL=0
  COPY_SKIP=0
  OLD_KEYS=()

  while IFS= read -r file; do
    key=$(git annex lookupkey "$file" 2>/dev/null || echo "")
    if [[ -z "$key" ]]; then
      continue
    fi

    OLD_S3_KEY="${ds}/objects/${file}"
    NEW_S3_KEY="${ds}/objects/${key}"

    # Check if content-addressed key already exists (idempotent)
    if aws s3api head-object --bucket "$BUCKET" --key "$NEW_S3_KEY" &>/dev/null; then
      COPY_SKIP=$((COPY_SKIP + 1))
      OLD_KEYS+=("$OLD_S3_KEY")
      continue
    fi

    # Check if source exists
    if ! aws s3api head-object --bucket "$BUCKET" --key "$OLD_S3_KEY" &>/dev/null; then
      echo "    MISSING: s3://${BUCKET}/${OLD_S3_KEY}"
      COPY_FAIL=$((COPY_FAIL + 1))
      continue
    fi

    if $DRY_RUN; then
      echo "    [DRY RUN] s3://.../${OLD_S3_KEY} -> s3://.../${NEW_S3_KEY}"
      COPY_OK=$((COPY_OK + 1))
    else
      if aws s3 cp "s3://${BUCKET}/${OLD_S3_KEY}" "s3://${BUCKET}/${NEW_S3_KEY}" --quiet 2>/dev/null; then
        COPY_OK=$((COPY_OK + 1))
        OLD_KEYS+=("$OLD_S3_KEY")
      else
        echo "    FAIL: Could not copy ${OLD_S3_KEY}"
        COPY_FAIL=$((COPY_FAIL + 1))
      fi
    fi
  done < <(git annex find --include='*' 2>/dev/null)

  echo "    Copied: $COPY_OK, Skipped: $COPY_SKIP (already exist), Failed: $COPY_FAIL"

  if [[ $COPY_FAIL -gt 0 && $COPY_OK -eq 0 && $COPY_SKIP -eq 0 ]]; then
    echo "  FAIL: All copies failed for $ds"
    FAILED=$((FAILED + 1))
    cd "$WORK_DIR"
    echo ""
    continue
  fi

  # Step 5: Remove stale annex-uuid if present
  ANNEX_UUID_KEY="${ds}/objects/annex-uuid"
  if aws s3 ls "s3://${BUCKET}/${ANNEX_UUID_KEY}" &>/dev/null; then
    echo "  Step 5: Removing stale annex-uuid from S3..."
    if ! $DRY_RUN; then
      if ! aws s3 rm "s3://${BUCKET}/${ANNEX_UUID_KEY}" --quiet 2>&1; then
        echo "  FAIL: Could not remove stale annex-uuid for $ds"
        FAILED=$((FAILED + 1))
        cd "$WORK_DIR"
        echo ""
        continue
      fi
    fi
  fi

  # Step 6: Create S3 special remote
  echo "  Step 6: Creating nemar-s3 special remote..."

  if $DRY_RUN; then
    echo "    [DRY RUN] Would run: git annex initremote nemar-s3 ..."
  else
    if git annex initremote nemar-s3 \
      type=S3 \
      encryption=none \
      bucket="$BUCKET" \
      fileprefix="${ds}/objects/" \
      datacenter="$REGION" \
      signature=v4 \
      autoenable=true \
      protocol=https \
      publicurl="$PUBLIC_URL" 2>&1; then
      echo "    S3 remote created"
    else
      echo "  FAIL: Could not create S3 remote for $ds"
      FAILED=$((FAILED + 1))
      cd "$WORK_DIR"
      echo ""
      continue
    fi
  fi

  # Step 7: Update location tracking via fsck
  echo "  Step 7: Updating location tracking (fsck)..."

  if $DRY_RUN; then
    echo "    [DRY RUN] Would run: git annex fsck --from nemar-s3 --fast"
  else
    if git annex fsck --from nemar-s3 --fast 2>&1; then
      echo "    Location tracking updated"
    else
      echo "    WARNING: fsck reported errors for $ds (some files may not be tracked)"
    fi
  fi

  # Step 8: Push git-annex branch
  echo "  Step 8: Pushing git-annex branch..."

  if $DRY_RUN; then
    echo "    [DRY RUN] Would run: git push origin git-annex"
  else
    if git push origin git-annex 2>&1; then
      echo "    Pushed git-annex branch"
    else
      echo "  FAIL: Could not push git-annex branch for $ds"
      FAILED=$((FAILED + 1))
      cd "$WORK_DIR"
      echo ""
      continue
    fi
  fi

  # Step 9: Clean up old path-based S3 objects
  echo "  Step 9: Cleaning up old path-based S3 objects..."

  CLEANED=0
  DEL_FAIL=0
  for old_key in "${OLD_KEYS[@]}"; do
    if $DRY_RUN; then
      echo "    [DRY RUN] Would delete s3://${BUCKET}/${old_key}"
      CLEANED=$((CLEANED + 1))
    else
      if aws s3 rm "s3://${BUCKET}/${old_key}" --quiet 2>&1; then
        CLEANED=$((CLEANED + 1))
      else
        echo "    WARNING: Failed to delete s3://${BUCKET}/${old_key}"
        DEL_FAIL=$((DEL_FAIL + 1))
      fi
    fi
  done
  echo "    Cleaned up $CLEANED old objects${DEL_FAIL:+, $DEL_FAIL failed}"

  SUCCESS=$((SUCCESS + 1))
  echo "  Done: $ds"
  cd "$WORK_DIR"
  echo ""
done

echo "=== Migration complete ==="
echo "  Success: $SUCCESS"
echo "  Skipped: $SKIPPED (already migrated)"
echo "  Failed:  $FAILED"

if $DRY_RUN; then
  echo ""
  echo "(This was a dry run. Re-run without --dry-run to execute.)"
fi

echo ""
echo "Post-migration verification:"
echo "  nemar dataset download <dataset_id>"
