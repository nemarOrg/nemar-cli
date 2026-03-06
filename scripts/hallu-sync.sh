#!/usr/bin/env bash
################################################################################
# NEMAR SDSC Hallu Dataset Sync
#
# Purpose: Synchronize NEMAR datasets (clones + zip archives) to SDSC Hallu
#          at /data/qumulo/openneuro/ for processing pipelines and downloads.
#
# Design: Idempotent, crash-safe, concurrent-safe. Runs hourly via crontab.
#         Only handles nm-prefix datasets. Each dataset is isolated; one
#         failure does not abort the run.
#
# Usage:
#   ./scripts/hallu-sync.sh
#
# Crontab:
#   0 * * * * /path/to/nemar-cli/scripts/hallu-sync.sh >> /data/qumulo/openneuro/.nm-sync-cron.log 2>&1
#
# Prerequisites:
#   - curl, jq, git, git-annex, nemar CLI in PATH
#   - User must be in NEMAR_GROUP (default: nemar)
#   - DATA_DIR and ZIP_DIR must exist and be writable
#
# Exit Codes:
#   0 - Success (even if individual datasets failed)
#   1 - General error
#   2 - Missing prerequisites
#   3 - Lock held by another instance
################################################################################

set -euo pipefail

################################################################################
# PATH Bootstrap (pick up tools installed via Homebrew/Bun in user home)
################################################################################

for p in "$HOME/.local/homebrew/bin" "$HOME/.bun/bin" "$HOME/.local/bin"; do
  [[ -d "$p" ]] && [[ ":$PATH:" != *":$p:"* ]] && export PATH="$p:$PATH"
done

################################################################################
# Configuration (all environment-overridable)
################################################################################

DATA_DIR="${DATA_DIR:-/data/qumulo/openneuro}"
ZIP_DIR="${ZIP_DIR:-${DATA_DIR}/zip_files}"
MANIFEST_FILE="${MANIFEST_FILE:-${DATA_DIR}/.nm-sync-manifest.json}"
LOG_FILE="${LOG_FILE:-${DATA_DIR}/.nm-sync.log}"
LOCK_FILE="${LOCK_FILE:-${DATA_DIR}/.nm-sync.lock}"
API_BASE="${API_BASE:-https://api.osc.earth/nemar}"
S3_BASE="${S3_BASE:-https://nemar.s3.us-east-2.amazonaws.com}"
NEMAR_GROUP="${NEMAR_GROUP:-nemar}"
DOWNLOAD_JOBS="${DOWNLOAD_JOBS:-4}"

################################################################################
# Logging
################################################################################

log() {
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" | tee -a "$LOG_FILE"
}

log_error() {
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] ERROR: $*" | tee -a "$LOG_FILE" >&2
}

################################################################################
# Log Rotation (>50 MB -> .log.1)
################################################################################

rotate_log() {
  if [[ -f "$LOG_FILE" ]]; then
    local size
    size=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
    if (( size > 52428800 )); then
      mv "$LOG_FILE" "${LOG_FILE}.1"
      log "Log rotated (previous log was ${size} bytes)"
    fi
  fi
}

################################################################################
# Lock (flock -n)
################################################################################

acquire_lock() {
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "Another instance is running (lock: $LOCK_FILE). Exiting."
    exit 3
  fi
}

################################################################################
# Prerequisites Check
################################################################################

check_prerequisites() {
  local missing=()

  for cmd in curl jq git git-annex nemar; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done

  if (( ${#missing[@]} > 0 )); then
    log_error "Missing required commands: ${missing[*]}"
    exit 2
  fi

  # Check group membership
  if ! id -Gn | tr ' ' '\n' | grep -qx "$NEMAR_GROUP"; then
    log_error "Current user is not in group '$NEMAR_GROUP'"
    exit 2
  fi

  # Check directories
  for dir in "$DATA_DIR" "$ZIP_DIR"; do
    if [[ ! -d "$dir" ]]; then
      log_error "Directory does not exist: $dir"
      exit 2
    fi
    if [[ ! -w "$dir" ]]; then
      log_error "Directory is not writable: $dir"
      exit 2
    fi
  done

  log "Prerequisites OK"
}

################################################################################
# Manifest Helpers
################################################################################

read_manifest() {
  if [[ -f "$MANIFEST_FILE" ]]; then
    cat "$MANIFEST_FILE"
  else
    echo '{}'
  fi
}

get_manifest_field() {
  local dataset_id="$1" field="$2"
  read_manifest | jq -r --arg id "$dataset_id" --arg f "$field" '.[$id][$f] // empty'
}

update_manifest() {
  local dataset_id="$1" field="$2" value="$3"
  local tmp="${MANIFEST_FILE}.tmp"
  local now
  now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

  read_manifest | jq --arg id "$dataset_id" --arg f "$field" --arg v "$value" \
    --arg ts "${field}_synced_at" --arg now "$now" \
    '.[$id] //= {} | .[$id][$f] = $v | .[$id][$ts] = $now' > "$tmp"
  mv "$tmp" "$MANIFEST_FILE"
}

################################################################################
# Permissions
################################################################################

apply_permissions() {
  local path="$1"
  chgrp -R "$NEMAR_GROUP" "$path" 2>/dev/null || true
  find "$path" -type d -exec chmod 2755 {} + 2>/dev/null || true
  find "$path" -type f -not -path "*/.git/*" -exec chmod 644 {} + 2>/dev/null || true
}

################################################################################
# API Helpers
################################################################################

# Fetch all public nm-prefix datasets by paginating the API
discover_datasets() {
  local offset=0
  local limit=100
  local all_ids=()

  while true; do
    local response
    response=$(curl -sf "${API_BASE}/datasets?limit=${limit}&offset=${offset}" 2>/dev/null) || {
      log_error "API request failed at offset=${offset}"
      break
    }

    local ids
    ids=$(echo "$response" | jq -r '.datasets[].dataset_id // empty' 2>/dev/null)

    if [[ -z "$ids" ]]; then
      break
    fi

    while IFS= read -r id; do
      # Only nm-prefix datasets matching nmXXXXXX
      if [[ "$id" =~ ^nm[0-9]{6}$ ]]; then
        all_ids+=("$id")
      fi
    done <<< "$ids"

    local count
    count=$(echo "$response" | jq -r '.count // 0')
    if (( count < limit )); then
      break
    fi

    offset=$((offset + limit))
  done

  printf '%s\n' "${all_ids[@]}"
}

# Get latest version for a dataset from manifest API
get_latest_version() {
  local dataset_id="$1"
  local response
  response=$(curl -sf "${API_BASE}/datasets/${dataset_id}/manifest" 2>/dev/null) || {
    echo ""
    return
  }

  # versions array is sorted; last entry is latest
  echo "$response" | jq -r '.versions[-1] // empty' 2>/dev/null
}

################################################################################
# Per-Dataset Sync
################################################################################

sync_dataset_data() {
  local dataset_id="$1" latest_version="$2"
  local dataset_dir="${DATA_DIR}/${dataset_id}"
  local recorded_data_version
  recorded_data_version=$(get_manifest_field "$dataset_id" "data_version")

  # Case 1: Directory exists but no manifest entry (orphan from crashed run)
  if [[ -d "$dataset_dir" && -z "$recorded_data_version" ]]; then
    log "${dataset_id}: Orphan directory detected, removing and re-downloading"
    rm -rf "$dataset_dir"
  fi

  # Case 2: No directory on disk -> fresh download
  if [[ ! -d "$dataset_dir" ]]; then
    log "${dataset_id}: Downloading (version ${latest_version})"
    local tmp_dir="${DATA_DIR}/.tmp-${dataset_id}"
    rm -rf "$tmp_dir"

    if ! nemar dataset download "$dataset_id" -o "$tmp_dir" -j "$DOWNLOAD_JOBS" >>"$LOG_FILE" 2>&1; then
      log_error "${dataset_id}: Download failed"
      rm -rf "$tmp_dir"
      return 1
    fi

    apply_permissions "$tmp_dir"
    mv "$tmp_dir" "$dataset_dir"
    update_manifest "$dataset_id" "data_version" "$latest_version"
    log "${dataset_id}: Data synced (version ${latest_version})"
    return 0
  fi

  # Case 3: Directory exists, check if update needed
  if [[ "$recorded_data_version" != "$latest_version" ]]; then
    log "${dataset_id}: Updating data ${recorded_data_version} -> ${latest_version}"

    if ! (cd "$dataset_dir" && git pull --ff-only >>"$LOG_FILE" 2>&1); then
      log_error "${dataset_id}: git pull failed"
      return 1
    fi

    if ! (cd "$dataset_dir" && git annex get . --jobs="$DOWNLOAD_JOBS" >>"$LOG_FILE" 2>&1); then
      log_error "${dataset_id}: git annex get failed"
      return 1
    fi

    apply_permissions "$dataset_dir"
    update_manifest "$dataset_id" "data_version" "$latest_version"
    log "${dataset_id}: Data updated to ${latest_version}"
    return 0
  fi

  log "${dataset_id}: Data up to date (${latest_version})"
  return 0
}

sync_dataset_zip() {
  local dataset_id="$1" latest_version="$2"
  local recorded_zip_version
  recorded_zip_version=$(get_manifest_field "$dataset_id" "zip_version")

  if [[ "$recorded_zip_version" == "$latest_version" ]]; then
    return 0
  fi

  local archive_url="${S3_BASE}/${dataset_id}/archives/${latest_version}.zip"
  local zip_file="${ZIP_DIR}/${dataset_id}-${latest_version}.zip"

  # HEAD check: archive may not exist yet (async generation)
  local http_status
  http_status=$(curl -s -o /dev/null -w '%{http_code}' --head "$archive_url" 2>/dev/null) || http_status="000"

  if [[ "$http_status" != "200" ]]; then
    log "${dataset_id}: Zip archive not available yet (HTTP ${http_status}), will retry next run"
    return 0
  fi

  log "${dataset_id}: Downloading zip ${latest_version}"
  local tmp_zip="${ZIP_DIR}/.tmp-${dataset_id}.zip"
  rm -f "$tmp_zip"

  if ! curl -sf -o "$tmp_zip" "$archive_url" >>"$LOG_FILE" 2>&1; then
    log_error "${dataset_id}: Zip download failed"
    rm -f "$tmp_zip"
    return 1
  fi

  # Verify zip integrity
  if ! unzip -t "$tmp_zip" >/dev/null 2>&1; then
    log_error "${dataset_id}: Zip verification failed (truncated download?)"
    rm -f "$tmp_zip"
    return 1
  fi

  chmod 644 "$tmp_zip"
  chgrp "$NEMAR_GROUP" "$tmp_zip" 2>/dev/null || true

  # Remove old version zip if different
  if [[ -n "$recorded_zip_version" && "$recorded_zip_version" != "$latest_version" ]]; then
    local old_zip="${ZIP_DIR}/${dataset_id}-${recorded_zip_version}.zip"
    rm -f "$old_zip"
  fi

  mv "$tmp_zip" "$zip_file"
  update_manifest "$dataset_id" "zip_version" "$latest_version"
  log "${dataset_id}: Zip synced (${latest_version})"
  return 0
}

sync_dataset() {
  local dataset_id="$1" latest_version="$2"
  local failed=0

  sync_dataset_data "$dataset_id" "$latest_version" || failed=1
  sync_dataset_zip "$dataset_id" "$latest_version" || failed=1

  return $failed
}

################################################################################
# Main
################################################################################

main() {
  rotate_log
  log "=== Sync started ==="

  acquire_lock
  check_prerequisites

  # Discover datasets
  log "Discovering datasets..."
  local datasets
  datasets=$(discover_datasets)

  if [[ -z "$datasets" ]]; then
    log "No datasets found"
    log "=== Sync complete: 0 datasets ==="
    return 0
  fi

  local total=0 ok=0 failed=0 skipped=0

  while IFS= read -r dataset_id; do
    [[ -z "$dataset_id" ]] && continue
    total=$((total + 1))

    # Get latest version
    local latest_version
    latest_version=$(get_latest_version "$dataset_id")

    if [[ -z "$latest_version" ]]; then
      log "${dataset_id}: No versions available, skipping"
      skipped=$((skipped + 1))
      continue
    fi

    if sync_dataset "$dataset_id" "$latest_version"; then
      ok=$((ok + 1))
    else
      failed=$((failed + 1))
    fi
  done <<< "$datasets"

  log "=== Sync complete: ${total} datasets, ${ok} OK, ${failed} failed, ${skipped} skipped ==="
}

main "$@"
