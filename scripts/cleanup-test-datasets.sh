#!/usr/bin/env bash
#
# Cleanup test datasets from S3, GitHub, and D1.
#
# WARNING: This script DELETES data permanently.
# Review the dataset lists carefully before running.
#
# Prerequisites:
#   - AWS CLI configured with s3:BypassGovernanceRetention permission
#   - gh CLI authenticated with nemarDatasets org access
#   - wrangler CLI for D1 operations
#
# Usage:
#   ./scripts/cleanup-test-datasets.sh [--dry-run]

set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "=== DRY RUN MODE - No changes will be made ==="
fi

BUCKET="nemar"

# Datasets with GOVERNANCE lock (nm000151, nm000152)
LOCKED_DATASETS=("nm000151" "nm000152")

# Non-production datasets to delete (no lock)
DELETE_DATASETS=("nm000146" "nm000147" "nm000148" "nm000149" "nm000150")

# Sandbox test datasets
SANDBOX_DATASETS=()
for i in $(seq -w 1 23); do
  SANDBOX_DATASETS+=("xx0000${i}")
done

# nm000120-nm000135 range
RANGE_DATASETS=()
for i in $(seq 120 135); do
  RANGE_DATASETS+=("nm000${i}")
done

echo ""
echo "=== Step 1: Unlock and delete GOVERNANCE-locked datasets ==="
for ds in "${LOCKED_DATASETS[@]}"; do
  echo "Processing $ds (GOVERNANCE locked)..."

  # List all objects
  OBJECTS=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "${ds}/" --query 'Contents[].Key' --output text 2>/dev/null || echo "")

  if [[ -z "$OBJECTS" || "$OBJECTS" == "None" ]]; then
    echo "  No S3 objects found for $ds, skipping S3 cleanup"
  else
    for key in $OBJECTS; do
      if $DRY_RUN; then
        echo "  [DRY RUN] Would remove retention and delete: $key"
      else
        echo "  Removing retention: $key"
        aws s3api put-object-retention \
          --bucket "$BUCKET" \
          --key "$key" \
          --retention '{}' \
          --bypass-governance-retention 2>/dev/null || echo "  WARNING: Failed to remove retention on $key"

        aws s3api delete-object --bucket "$BUCKET" --key "$key" 2>/dev/null || echo "  WARNING: Failed to delete $key"
      fi
    done
  fi

  # Make repo private then delete
  if $DRY_RUN; then
    echo "  [DRY RUN] Would delete GitHub repo nemarDatasets/$ds"
  else
    gh repo edit "nemarDatasets/$ds" --visibility private 2>/dev/null || true
    gh repo delete "nemarDatasets/$ds" --yes 2>/dev/null || echo "  WARNING: Could not delete repo $ds"
  fi
done

echo ""
echo "=== Step 2: Delete non-production datasets ==="
ALL_DELETE=("${DELETE_DATASETS[@]}" "${RANGE_DATASETS[@]}" "${SANDBOX_DATASETS[@]}")

for ds in "${ALL_DELETE[@]}"; do
  # Check if S3 prefix has objects
  COUNT=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "${ds}/" --query 'KeyCount' --output text 2>/dev/null || echo "0")

  if [[ "$COUNT" != "0" && "$COUNT" != "None" ]]; then
    if $DRY_RUN; then
      echo "  [DRY RUN] Would delete S3 objects for $ds ($COUNT objects)"
    else
      echo "  Deleting S3 objects for $ds ($COUNT objects)..."
      aws s3 rm --recursive "s3://${BUCKET}/${ds}/" 2>/dev/null || echo "  WARNING: S3 delete failed for $ds"
    fi
  fi

  # Delete GitHub repo (skip nm099999 - E2E test dataset)
  if [[ "$ds" != "nm099999" ]]; then
    if $DRY_RUN; then
      echo "  [DRY RUN] Would delete GitHub repo nemarDatasets/$ds"
    else
      gh repo delete "nemarDatasets/$ds" --yes 2>/dev/null || true
    fi
  fi
done

echo ""
echo "=== Step 3: Clean D1 records ==="
echo "Run the following SQL against your D1 database to clean up records:"
echo ""

# Build dataset ID list for SQL
ALL_IDS=("${LOCKED_DATASETS[@]}" "${DELETE_DATASETS[@]}" "${RANGE_DATASETS[@]}" "${SANDBOX_DATASETS[@]}")
ID_LIST=$(printf "'%s'," "${ALL_IDS[@]}")
ID_LIST="${ID_LIST%,}"  # Remove trailing comma

echo "-- Delete dataset records (except nm099999)"
echo "DELETE FROM datasets WHERE dataset_id IN ($ID_LIST) AND dataset_id != 'nm099999';"
echo ""
echo "-- Delete related publication requests"
echo "DELETE FROM publication_requests WHERE dataset_id IN ($ID_LIST) AND dataset_id != 'nm099999';"
echo ""
echo "-- Delete S3 permissions for deleted datasets"
echo "DELETE FROM user_s3_permissions WHERE s3_prefix IN ($ID_LIST) AND s3_prefix != 'nm099999';"
echo ""

echo "=== Cleanup complete ==="
if $DRY_RUN; then
  echo "(This was a dry run. Re-run without --dry-run to execute.)"
fi
