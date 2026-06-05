#!/usr/bin/env bash
#
# Add S3 special remote to dataset repos that predate CLI v0.6.3.
#
# Before v0.6.3, uploads used `git annex registerurl` (web remote) instead of
# `git annex initremote nemar-s3` (S3 special remote). This means downloads
# fail because `enableS3Remote` can't find a remote named "nemar-s3".
#
# This script clones each repo, runs initremote with the correct config,
# uses fsck to update location tracking logs, and pushes the updated
# git-annex branch back to GitHub.
#
# Prerequisites:
#   - AWS credentials resolvable via the default chain
#     (~/.aws/credentials mode 0600, or aws sso login). Long-lived
#     AKIA keys in process env vars are rejected by the credentials
#     guard; see https://docs.nemar.org/admin/operations/access-policies/ (principles 5 + 6).
#   - git-annex installed
#   - SSH access to nemarDatasets GitHub org
#
# Usage:
#   ./scripts/migrate-s3-remote.sh [--dry-run] dataset_id [dataset_id ...]
#
# Examples:
#   ./scripts/migrate-s3-remote.sh --dry-run nm000113
#   ./scripts/migrate-s3-remote.sh nm000103 nm000104 nm000105

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
  echo "Example: $0 nm000103 nm000104 nm000105 nm000106 nm000107"
  exit 1
fi

# Verify AWS credentials via shared guard (rejects long-lived AKIA* keys
# in env, requires ~/.aws/credentials or aws sso login). See
# https://docs.nemar.org/admin/operations/access-policies/ (principles 5 + 6).
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
  echo "  Step 1: Checking if remote.log already exists..."
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

  # Step 4: Remove stale annex-uuid from S3 if present
  # Previous migrations (migrate-s3-structure.sh) may have left an annex-uuid
  # file in S3 without registering the remote in the git-annex branch.
  # initremote refuses to reuse a bucket with a mismatched annex-uuid.
  ANNEX_UUID_KEY="${ds}/objects/annex-uuid"
  if aws s3 ls "s3://${BUCKET}/${ANNEX_UUID_KEY}" &>/dev/null; then
    echo "  Step 4a: Removing stale annex-uuid from S3..."
    if $DRY_RUN; then
      echo "    [DRY RUN] Would delete s3://${BUCKET}/${ANNEX_UUID_KEY}"
    else
      if ! aws s3 rm "s3://${BUCKET}/${ANNEX_UUID_KEY}" --quiet 2>&1; then
        echo "  FAIL: Could not remove stale annex-uuid for $ds"
        FAILED=$((FAILED + 1))
        cd "$WORK_DIR"
        echo ""
        continue
      fi
      echo "    Removed stale annex-uuid"
    fi
  fi

  # Step 5: Create S3 special remote
  echo "  Step 5: Creating nemar-s3 special remote..."

  if $DRY_RUN; then
    echo "    [DRY RUN] Would run: git annex initremote nemar-s3 type=S3 encryption=none bucket=$BUCKET fileprefix=${ds}/objects/ datacenter=$REGION signature=v4 autoenable=true protocol=https publicurl=$PUBLIC_URL"
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

  # Step 6: Update location tracking via fsck
  # initremote creates a new UUID, but location logs still reference the old
  # web remote UUID. fsck verifies each file exists on S3 and updates the
  # location logs to include the new nemar-s3 UUID.
  echo "  Step 6: Updating location tracking (fsck)..."

  if $DRY_RUN; then
    echo "    [DRY RUN] Would run: git annex fsck --from nemar-s3 --fast"
  else
    if git annex fsck --from nemar-s3 --fast 2>&1; then
      echo "    Location tracking updated"
    else
      echo "    WARNING: fsck had errors (some files may not be on S3)"
    fi
  fi

  # Step 7: Push git-annex branch
  echo "  Step 7: Pushing git-annex branch..."

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

  SUCCESS=$((SUCCESS + 1))
  echo "  Done: $ds"
  cd "$WORK_DIR"
  echo ""
done

echo "=== Migration complete ==="
echo "  Success: $SUCCESS"
echo "  Skipped: $SKIPPED (already had remote.log)"
echo "  Failed:  $FAILED"

if $DRY_RUN; then
  echo ""
  echo "(This was a dry run. Re-run without --dry-run to execute.)"
fi

echo ""
echo "Post-migration verification:"
echo "  nemar dataset download <dataset_id>"
