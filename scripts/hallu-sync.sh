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
API_BASE="${API_BASE:-https://api.nemar.org}"
S3_BASE="${S3_BASE:-https://nemar.s3.us-east-2.amazonaws.com}"
NEMAR_GROUP="${NEMAR_GROUP:-nemar}"
DOWNLOAD_JOBS="${DOWNLOAD_JOBS:-4}"
ZIP_ENABLED=true

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

  # Check DATA_DIR (required)
  if [[ ! -d "$DATA_DIR" ]]; then
    log_error "Directory does not exist: $DATA_DIR"
    exit 2
  fi
  if [[ ! -w "$DATA_DIR" ]]; then
    log_error "Directory is not writable: $DATA_DIR"
    exit 2
  fi

  # Check ZIP_DIR (optional; skip zip sync if not writable)
  ZIP_ENABLED=true
  if [[ ! -d "$ZIP_DIR" ]]; then
    log "WARNING: ZIP_DIR does not exist: $ZIP_DIR (zip sync disabled)"
    ZIP_ENABLED=false
  elif [[ ! -w "$ZIP_DIR" ]]; then
    log "WARNING: ZIP_DIR is not writable: $ZIP_DIR (zip sync disabled)"
    ZIP_ENABLED=false
  fi

  log "Prerequisites OK (zip_sync=${ZIP_ENABLED})"
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

# Fetch all public nm-prefix datasets by paginating the API.
# Emits tab-separated `dataset_id<TAB>latest_version` pairs. The version
# column is empty when the listing endpoint doesn't include it (older
# backend) or when the dataset has no minted version yet.
#
# jq stderr is captured and bubbled up via log_error so a parse failure
# does not silently end pagination and produce a truncated sync. A
# returned-but-empty page is the only condition that ends the loop
# cleanly.
discover_datasets() {
  local offset=0
  local limit=100
  local all_rows=()

  while true; do
    local response
    response=$(curl -sf "${API_BASE}/datasets?limit=${limit}&offset=${offset}" 2>/dev/null) || {
      log_error "API request failed at offset=${offset}; aborting discovery"
      return 1
    }

    local rows jq_err
    jq_err=$(mktemp)
    # Use `if ! ...` so a jq failure doesn't trip the global `set -e` AND
    # we still inspect the failure. The previous form used `|| true` to
    # suppress the exit, but that overwrote $? with `true`'s status (0), so
    # the jq_status check that followed was always 0 and a malformed
    # response silently looked like "no more datasets" and ended discovery.
    if ! rows=$(echo "$response" | jq -r '.datasets[] | [.dataset_id, (.latest_version // "")] | @tsv' 2>"$jq_err"); then
      local jq_status=$?
      log_error "jq parse failed at offset=${offset} (exit=${jq_status}): $(cat "$jq_err"); aborting discovery"
      rm -f "$jq_err"
      return 1
    fi
    rm -f "$jq_err"

    if [[ -z "$rows" ]]; then
      break
    fi

    while IFS=$'\t' read -r id version; do
      if [[ "$id" =~ ^nm[0-9]{6}$ ]]; then
        all_rows+=("${id}"$'\t'"${version}")
      fi
    done <<< "$rows"

    local count
    count=$(echo "$response" | jq '.datasets | length' 2>/dev/null)
    if [[ ! "$count" =~ ^[0-9]+$ ]]; then
      log_error "Unexpected /datasets shape at offset=${offset} (no numeric .datasets length); aborting discovery"
      return 1
    fi
    if (( count < limit )); then
      break
    fi

    offset=$((offset + limit))
  done

  printf '%s\n' "${all_rows[@]}"
}

# Get latest version for a dataset from manifest API
get_latest_version() {
  local dataset_id="$1"
  local response
  response=$(curl -sf "${API_BASE}/datasets/${dataset_id}/manifest" 2>/dev/null) || {
    log_error "${dataset_id}: Failed to fetch manifest from API"
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

  # Case 1: Directory exists but no manifest entry
  if [[ -d "$dataset_dir" && -z "$recorded_data_version" ]]; then
    if [[ -d "$dataset_dir/.git" ]]; then
      log "[ADOPT] ${dataset_id}: existing checkout without manifest entry, recording at ${latest_version}"
      update_manifest "$dataset_id" "data_version" "$latest_version"
      apply_permissions "$dataset_dir"
      return 0
    else
      log "[CLEAN] ${dataset_id}: incomplete directory (no .git), removing"
      rm -rf "$dataset_dir"
    fi
  fi

  # Case 2: No directory on disk -> fresh download
  if [[ ! -d "$dataset_dir" ]]; then
    log "[FRESH] ${dataset_id}: first download (version ${latest_version})"

    if ! nemar dataset download "$dataset_id" -o "$dataset_dir" -j "$DOWNLOAD_JOBS" >>"$LOG_FILE" 2>&1; then
      log_error "[FAIL] ${dataset_id}: download failed"
      rm -rf "$dataset_dir"
      return 1
    fi

    apply_permissions "$dataset_dir"
    update_manifest "$dataset_id" "data_version" "$latest_version"
    return 0
  fi

  # Case 3: Directory exists, check if update needed
  if [[ "$recorded_data_version" != "$latest_version" ]]; then
    log "[UPDATE] ${dataset_id}: ${recorded_data_version} -> ${latest_version}"

    if ! (cd "$dataset_dir" && git pull --ff-only >>"$LOG_FILE" 2>&1); then
      log_error "[FAIL] ${dataset_id}: git pull failed"
      return 1
    fi

    if ! (cd "$dataset_dir" && git annex get . --jobs="$DOWNLOAD_JOBS" >>"$LOG_FILE" 2>&1); then
      log_error "[FAIL] ${dataset_id}: git annex get failed"
      return 1
    fi

    apply_permissions "$dataset_dir"
    update_manifest "$dataset_id" "data_version" "$latest_version"
    return 0
  fi

  log "[SKIP] ${dataset_id}: data up to date (${latest_version})"
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
  local zip_file="${ZIP_DIR}/${dataset_id}.zip"

  # HEAD check: archive may not exist yet (async generation)
  local http_status
  http_status=$(curl -s -o /dev/null -w '%{http_code}' --head "$archive_url" 2>/dev/null) || http_status="000"

  if [[ "$http_status" != "200" ]]; then
    log "[WAIT] ${dataset_id}: zip archive not available yet (HTTP ${http_status})"
    return 0
  fi

  log "[ZIP] ${dataset_id}: downloading ${latest_version}"
  local tmp_zip="${ZIP_DIR}/.tmp-${dataset_id}.zip"
  rm -f "$tmp_zip"

  if ! curl -sf -o "$tmp_zip" "$archive_url" >>"$LOG_FILE" 2>&1; then
    log_error "[FAIL] ${dataset_id}: zip download failed"
    rm -f "$tmp_zip"
    return 1
  fi

  if ! unzip -t "$tmp_zip" >/dev/null 2>&1; then
    log_error "[FAIL] ${dataset_id}: zip verification failed (truncated download?)"
    rm -f "$tmp_zip"
    return 1
  fi

  chmod 644 "$tmp_zip"
  chgrp "$NEMAR_GROUP" "$tmp_zip" 2>/dev/null || true

  # Remove old versioned zip if it exists (from before naming convention change)
  if [[ -n "$recorded_zip_version" ]]; then
    local old_zip="${ZIP_DIR}/${dataset_id}-${recorded_zip_version}.zip"
    rm -f "$old_zip"
  fi

  mv "$tmp_zip" "$zip_file"
  update_manifest "$dataset_id" "zip_version" "$latest_version"
  log "[ZIP] ${dataset_id}: synced ${latest_version}"
  return 0
}

sync_dataset() {
  local dataset_id="$1" latest_version="$2"
  local failed=0

  sync_dataset_data "$dataset_id" "$latest_version" || failed=1
  if [[ "$ZIP_ENABLED" == "true" ]]; then
    sync_dataset_zip "$dataset_id" "$latest_version" || failed=1
  fi

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
  if ! datasets=$(discover_datasets); then
    log_error "Dataset discovery failed; nothing synced this cycle"
    return 1
  fi

  if [[ -z "$datasets" ]]; then
    log "No datasets found"
    log "=== Sync complete: 0 datasets ==="
    return 0
  fi

  local total=0 ok=0 failed=0 skipped=0 manifest_fallbacks=0

  while IFS=$'\t' read -r dataset_id listing_version; do
    [[ -z "$dataset_id" ]] && continue
    total=$((total + 1))

    # Prefer the version that came back on the listing; fall back to the
    # per-dataset manifest call only when the listing didn't carry one
    # (older backend, or no minted version yet).
    local latest_version="$listing_version"
    if [[ -z "$latest_version" ]]; then
      latest_version=$(get_latest_version "$dataset_id")
      manifest_fallbacks=$((manifest_fallbacks + 1))
    fi

    if [[ -z "$latest_version" ]]; then
      log "[SKIP] ${dataset_id}: No versions available"
      skipped=$((skipped + 1))
      continue
    fi

    if sync_dataset "$dataset_id" "$latest_version"; then
      ok=$((ok + 1))
    else
      failed=$((failed + 1))
    fi
  done <<< "$datasets"

  log "=== Sync complete: ${total} datasets, ${ok} OK, ${failed} failed, ${skipped} skipped, ${manifest_fallbacks} manifest API fallbacks ==="

  # If the listing failed to carry latest_version for every single dataset,
  # the optimisation has silently regressed (column dropped, all NULLs,
  # rollback). Surface this loudly so cron monitoring fires.
  if (( total > 0 && manifest_fallbacks == total )); then
    log_error "Listing returned no latest_version for any dataset (${manifest_fallbacks}/${total} fell back to /manifest); the listing optimisation may have regressed"
  fi
}

main "$@"
