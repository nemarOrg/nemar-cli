#!/usr/bin/env bash
#
# Remove stale web URLs from git-annex branches.
#
# Datasets uploaded before the S3 remote fix had web URLs registered
# using human-readable file paths (e.g., sub-01/eeg/file.edf) instead
# of content-addressed annex keys. These URLs point to S3 paths that
# don't exist, causing git-annex to fail with 403 on download.
#
# The S3 special remote (nemar-s3) already has the correct key-based
# paths, so the web URLs are just stale noise that breaks downloads.
#
# For public datasets (with DOI), this creates a patch version bump
# since the git-annex branch change affects the repo.
# For private datasets, it force-pushes the cleaned git-annex branch.
#
# Prerequisites:
#   - git-annex installed
#   - SSH access to nemarDatasets GitHub org
#   - gh CLI authenticated
#
# Usage:
#   ./scripts/cleanup-web-urls.sh [--dry-run] dataset_id [dataset_id ...]
#
# Examples:
#   ./scripts/cleanup-web-urls.sh --dry-run nm000112
#   ./scripts/cleanup-web-urls.sh nm000109 nm000110 nm000111 nm000112

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
  echo "Example: $0 nm000109 nm000110 nm000111 nm000112"
  exit 1
fi

if ! command -v git-annex &>/dev/null; then
  echo "ERROR: git-annex not found"
  exit 1
fi

if $DRY_RUN; then
  echo "=== DRY RUN MODE - No changes will be made ==="
fi

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

  # Step 1: Check if dataset has web URLs
  echo "  Step 1: Checking for stale web URLs..."

  WEB_COUNT=$(cd /tmp && rm -rf "${ds}-probe" \
    && git clone --bare --single-branch -b git-annex "git@github.com:${ORG}/${ds}.git" "${ds}-probe" 2>/dev/null \
    && cd "${ds}-probe" \
    && git ls-tree -r HEAD --name-only 2>/dev/null | grep -c '\.log\.web$' || echo 0)
  rm -rf "/tmp/${ds}-probe"

  if [[ "$WEB_COUNT" -eq 0 ]]; then
    echo "  SKIP: $ds has no web URLs"
    SKIPPED=$((SKIPPED + 1))
    echo ""
    continue
  fi

  echo "  Found $WEB_COUNT web URL entries"

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
  if ! git annex init "web-url-cleanup" > /dev/null 2>&1; then
    echo "  FAIL: git annex init failed for $ds"
    FAILED=$((FAILED + 1))
    cd "$WORK_DIR"
    echo ""
    continue
  fi

  # Step 4: Remove all web URLs
  echo "  Step 4: Removing stale web URLs..."

  REMOVED=0
  RM_FAIL=0

  # For each annexed file, check for and remove web URLs.
  # git annex whereis shows URLs; we remove any that are registered
  # under the web remote (these are the stale path-based URLs).
  while IFS= read -r file; do
    # Skip non-annexed files (git-tracked, not symlinks to annex)
    key=$(git annex lookupkey "$file" 2>/dev/null || echo "")
    [[ -z "$key" ]] && continue

    # Get web URLs via whereis
    WHEREIS_OUT=$(git annex whereis "$file" 2>/dev/null || echo "")

    # Extract URLs from whereis output (lines starting with "  web: ")
    while IFS= read -r line; do
      url=$(echo "$line" | sed -n 's/^  web: //p')
      [[ -z "$url" ]] && continue

      if $DRY_RUN; then
        echo "    [DRY RUN] rmurl $(basename "$file") -> $url"
        REMOVED=$((REMOVED + 1))
      else
        if git annex rmurl "$file" "$url" > /dev/null 2>&1; then
          REMOVED=$((REMOVED + 1))
        else
          echo "    FAIL: Could not remove URL for $file"
          RM_FAIL=$((RM_FAIL + 1))
        fi
      fi
    done <<< "$WHEREIS_OUT"
  done < <(git ls-files 2>/dev/null)

  echo "    Removed: $REMOVED URLs, Failed: $RM_FAIL"

  if [[ $REMOVED -eq 0 && $RM_FAIL -eq 0 ]]; then
    echo "  SKIP: No URLs to remove"
    SKIPPED=$((SKIPPED + 1))
    cd "$WORK_DIR"
    echo ""
    continue
  fi

  # Step 5: Push git-annex branch
  echo "  Step 5: Pushing git-annex branch..."

  if $DRY_RUN; then
    echo "    [DRY RUN] Would push git-annex branch"
  else
    if git push origin git-annex 2>&1; then
      echo "    Pushed"
    else
      echo "    Regular push failed, trying force push..."
      if git push --force origin git-annex 2>&1; then
        echo "    Force pushed"
      else
        echo "  FAIL: Could not push git-annex branch for $ds"
        FAILED=$((FAILED + 1))
        cd "$WORK_DIR"
        echo ""
        continue
      fi
    fi
  fi

  # Step 6: Verify (pick first annexed file and check whereis)
  echo "  Step 6: Verifying..."
  SAMPLE_FILE=""
  while IFS= read -r f; do
    k=$(git annex lookupkey "$f" 2>/dev/null || echo "")
    if [[ -n "$k" ]]; then
      SAMPLE_FILE="$f"
      break
    fi
  done < <(git ls-files 2>/dev/null)
  if [[ -n "$SAMPLE_FILE" ]]; then
    echo "    Sample: $SAMPLE_FILE"
    git annex whereis "$SAMPLE_FILE" 2>&1 | grep -E '^\s+(web|nemar)' || true
  fi

  SUCCESS=$((SUCCESS + 1))
  echo "  Done: $ds ($REMOVED URLs removed)"
  cd "$WORK_DIR"
  echo ""
done

echo "=== Cleanup complete ==="
echo "  Success: $SUCCESS"
echo "  Skipped: $SKIPPED (no web URLs)"
echo "  Failed:  $FAILED"

if $DRY_RUN; then
  echo ""
  echo "(This was a dry run. Re-run without --dry-run to execute.)"
fi
