#!/usr/bin/env bash
#
# Migrate S3 bucket structure from flat to subdirectory layout.
#
# Moves data files into objects/ and manifests into version/ subdirectory.
#
# Before:
#   s3://nemar/{datasetId}/{files}
#   s3://nemar/{datasetId}/manifests/v*.json
#
# After:
#   s3://nemar/{datasetId}/objects/{files}
#   s3://nemar/{datasetId}/version/v*.json
#   s3://nemar/{datasetId}/archives/          (empty, for future use)
#
# Also updates git-annex remote fileprefix in each repo.
#
# Usage:
#   ./scripts/migrate-s3-structure.sh [--dry-run] [dataset_id...]
#
# Examples:
#   ./scripts/migrate-s3-structure.sh --dry-run nm000103
#   ./scripts/migrate-s3-structure.sh nm000103 nm000104 nm000105 nm000106 nm000107

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

if $DRY_RUN; then
  echo "=== DRY RUN MODE - No changes will be made ==="
fi

BUCKET="nemar"
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

echo "Working directory: $WORK_DIR"
echo ""

for ds in "${DATASETS[@]}"; do
  echo "============================================"
  echo "Migrating $ds"
  echo "============================================"

  # Step 1: Copy data objects to objects/ subdirectory
  echo "  Step 1: Copying data files to objects/..."

  # List all objects, excluding manifests/ and any existing objects/version/archives dirs
  OBJECTS=$(aws s3api list-objects-v2 \
    --bucket "$BUCKET" \
    --prefix "${ds}/" \
    --query "Contents[?!contains(Key, '/manifests/') && !contains(Key, '/objects/') && !contains(Key, '/version/') && !contains(Key, '/archives/')].Key" \
    --output text 2>/dev/null || echo "")

  if [[ -z "$OBJECTS" || "$OBJECTS" == "None" ]]; then
    echo "  No data files found for $ds"
  else
    for key in $OBJECTS; do
      # Skip the prefix directory marker itself
      if [[ "$key" == "${ds}/" ]]; then
        continue
      fi

      # Extract the relative path after {datasetId}/
      rel_path="${key#${ds}/}"
      new_key="${ds}/objects/${rel_path}"

      if $DRY_RUN; then
        echo "    [DRY RUN] Would copy: $key -> $new_key"
      else
        echo "    Copying: $key -> $new_key"
        aws s3 cp "s3://${BUCKET}/${key}" "s3://${BUCKET}/${new_key}" --quiet
      fi
    done
  fi

  # Step 2: Copy manifests to version/ subdirectory
  echo "  Step 2: Copying manifests to version/..."

  MANIFESTS=$(aws s3api list-objects-v2 \
    --bucket "$BUCKET" \
    --prefix "${ds}/manifests/" \
    --query "Contents[].Key" \
    --output text 2>/dev/null || echo "")

  if [[ -z "$MANIFESTS" || "$MANIFESTS" == "None" ]]; then
    echo "  No manifests found for $ds"
  else
    for key in $MANIFESTS; do
      filename=$(basename "$key")
      new_key="${ds}/version/${filename}"

      if $DRY_RUN; then
        echo "    [DRY RUN] Would copy: $key -> $new_key"
      else
        echo "    Copying: $key -> $new_key"
        aws s3 cp "s3://${BUCKET}/${key}" "s3://${BUCKET}/${new_key}" --quiet
      fi
    done
  fi

  # Step 3: Update git-annex remote fileprefix
  echo "  Step 3: Updating git-annex remote..."

  if $DRY_RUN; then
    echo "    [DRY RUN] Would clone nemarDatasets/${ds} and update remote"
  else
    REPO_DIR="${WORK_DIR}/${ds}"
    git clone "git@github.com:nemarDatasets/${ds}.git" "$REPO_DIR" 2>/dev/null

    cd "$REPO_DIR"
    git annex init "migration-worker" 2>/dev/null || true

    # Update the S3 remote fileprefix
    git annex enableremote nemar-s3 fileprefix="${ds}/objects/" 2>/dev/null || {
      echo "    WARNING: Could not update remote. May need manual intervention."
    }

    git push origin git-annex 2>/dev/null || {
      echo "    WARNING: Could not push git-annex branch"
    }

    cd -
  fi

  # Step 4: Verify (check that files exist at new paths)
  echo "  Step 4: Verifying..."

  if ! $DRY_RUN; then
    NEW_COUNT=$(aws s3api list-objects-v2 \
      --bucket "$BUCKET" \
      --prefix "${ds}/objects/" \
      --query "KeyCount" \
      --output text 2>/dev/null || echo "0")
    echo "    Objects at new path: $NEW_COUNT"

    if [[ "$NEW_COUNT" == "0" ]]; then
      echo "    WARNING: No objects found at new path! Skipping old file deletion."
      continue
    fi
  fi

  # Step 5: Delete old flat objects (only data files, not objects/version/archives)
  echo "  Step 5: Cleaning up old flat objects..."

  if [[ -z "$OBJECTS" || "$OBJECTS" == "None" ]]; then
    echo "    No old objects to clean up"
  else
    for key in $OBJECTS; do
      if [[ "$key" == "${ds}/" ]]; then
        continue
      fi

      if $DRY_RUN; then
        echo "    [DRY RUN] Would delete old: $key"
      else
        echo "    Deleting old: $key"
        aws s3 rm "s3://${BUCKET}/${key}" --quiet
      fi
    done
  fi

  # Clean up old manifests/
  if [[ -n "$MANIFESTS" && "$MANIFESTS" != "None" ]]; then
    for key in $MANIFESTS; do
      if $DRY_RUN; then
        echo "    [DRY RUN] Would delete old manifest: $key"
      else
        echo "    Deleting old manifest: $key"
        aws s3 rm "s3://${BUCKET}/${key}" --quiet
      fi
    done
  fi

  echo "  Done migrating $ds"
  echo ""
done

echo "=== Migration complete ==="
if $DRY_RUN; then
  echo "(This was a dry run. Re-run without --dry-run to execute.)"
fi
echo ""
echo "Post-migration verification:"
echo "  1. For each dataset, run: git annex whereis (in the cloned repo)"
echo "  2. Test download: git annex get <file>"
echo "  3. Verify S3 structure: aws s3 ls s3://nemar/{datasetId}/"
