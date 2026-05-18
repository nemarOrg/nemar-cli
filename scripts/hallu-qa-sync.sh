#!/usr/bin/env bash
################################################################################
# NEMAR SDSC Hallu QA Artifact Sync
#
# Purpose: Mirror NEMAR pipeline QA artifacts from SDSC Hallu (at
#          /data/qumulo/openneuro/processed/<id>/) into S3 so the
#          data.nemar.org Worker can serve them at /<id>/qa/*.
#
# Sibling to hallu-sync.sh (which syncs the dataset bytes themselves). This
# script handles the QA tree: dataqual.json, histogram figures, per-file QA
# summaries, ICA plots, eeg-plot mid-samples, spectopo, etc. Pipeline
# internals (code/, logs/, raw .mat files) are excluded.
#
# Design: Idempotent (aws s3 sync), crash-safe, concurrent-safe (flock).
#         Each dataset is isolated; one failure does not abort the run.
#
# Usage:
#   ./scripts/hallu-qa-sync.sh                      # full hourly sweep
#   ./scripts/hallu-qa-sync.sh --dataset nm000132   # one dataset, verbose
#   ./scripts/hallu-qa-sync.sh --verbose            # full sweep, verbose
#
# Crontab:
#   15 * * * * /path/to/nemar-cli/scripts/hallu-qa-sync.sh >> /data/qumulo/openneuro/.nm-qa-sync-cron.log 2>&1
#
# Cron offset (minute 15) avoids overlap with the bytes sync (hallu-sync.sh
# at minute 0) so the two jobs don't compete for the same flock / S3 quota
# spike.
#
# Prerequisites:
#   - curl, jq, aws CLI in PATH
#   - User must be in NEMAR_GROUP (default: nemar)
#   - PROCESSED_DIR must exist and be readable
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
PROCESSED_DIR="${PROCESSED_DIR:-${DATA_DIR}/processed}"
MANIFEST_FILE="${MANIFEST_FILE:-${DATA_DIR}/.nm-qa-sync-manifest.json}"
LOG_FILE="${LOG_FILE:-${DATA_DIR}/.nm-qa-sync.log}"
LOCK_FILE="${LOCK_FILE:-${DATA_DIR}/.nm-qa-sync.lock}"
S3_BUCKET="${S3_BUCKET:-nemar}"
S3_REGION="${S3_REGION:-us-east-2}"
NEMAR_GROUP="${NEMAR_GROUP:-nemar}"
SYNC_JOBS="${SYNC_JOBS:-4}"
# Hallu directories are keyed by OpenNeuro id (ds*). When a ds* has been
# mirrored as on* in the catalog, we upload its QA to the canonical on* key so
# `data.nemar.org/on*/qa/*` serves it. The resolve endpoint translates
# ds -> on; unmirrored ds* are skipped (no public landing page yet).
API_BASE="${API_BASE:-https://api.nemar.org}"

# Exclude pipeline internals (kept on hallu for debugging; not exposed publicly).
# `code/` and `logs/` are run-time pipeline state, `*.mat` is raw MATLAB output
# we don't ship to users. Glob patterns are passed to `aws s3 sync --exclude`.
EXCLUDES=(
  "--exclude" "code/*"
  "--exclude" "logs/*"
  "--exclude" "*.mat"
  "--exclude" "*~"
  "--exclude" ".*"
)

VERBOSE=false
SINGLE_DATASET=""

################################################################################
# Argument Parsing
################################################################################

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verbose|-v)
      VERBOSE=true
      shift
      ;;
    --dataset)
      SINGLE_DATASET="$2"
      shift 2
      ;;
    --help|-h)
      sed -n '/^# Usage:/,/^# Exit Codes:/p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

################################################################################
# Logging
################################################################################

log() {
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" | tee -a "$LOG_FILE"
}

log_error() {
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] ERROR: $*" | tee -a "$LOG_FILE" >&2
}

log_verbose() {
  if [[ "$VERBOSE" == "true" ]]; then
    log "$@"
  fi
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

  for cmd in curl jq aws; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done

  if (( ${#missing[@]} > 0 )); then
    log_error "Missing required commands: ${missing[*]}"
    exit 2
  fi

  # Check group membership (skip on machines where the group doesn't apply, e.g. macOS dev)
  if id -Gn | tr ' ' '\n' | grep -qx "$NEMAR_GROUP"; then
    log_verbose "User is in group '$NEMAR_GROUP'"
  else
    log "WARNING: current user is not in group '$NEMAR_GROUP' (continuing anyway)"
  fi

  # Check PROCESSED_DIR (required)
  if [[ ! -d "$PROCESSED_DIR" ]]; then
    log_error "Directory does not exist: $PROCESSED_DIR"
    exit 2
  fi

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
# Per-Dataset Sync
################################################################################

# Compute a content-fingerprint for the QA tree of a dataset so we can skip
# datasets that haven't changed since the last successful sync. Uses the
# newest mtime across the eligible (post-exclusion) files. Falls back to a
# count-only sentinel if find emits nothing (empty tree). Output is a single
# opaque string suitable for direct comparison with a previous value.
qa_tree_fingerprint() {
  local src="$1"
  local newest
  # `-not -path '*/code/*' -not -path '*/logs/*'` mirrors the EXCLUDES we
  # pass to aws s3 sync, so the fingerprint and the sync agree on scope.
  newest=$(find "$src" \
    -type f \
    -not -path '*/code/*' \
    -not -path '*/logs/*' \
    -not -name '*.mat' \
    -not -name '*~' \
    -not -name '.*' \
    -printf '%T@\n' 2>/dev/null \
    | sort -nr | head -1)
  if [[ -z "$newest" ]]; then
    echo "empty"
  else
    echo "$newest"
  fi
}

# ds* -> on* lookup table, populated once at startup by load_canonical_mapping.
# Keyed by ds id (e.g. "ds002718"), value is the canonical on id ("on002718").
declare -A DS_TO_ON

# Fetch the full set of ds -> on mirror mappings from the catalog in one paginated
# pass. Replaces per-dataset calls to /datasets/resolve/:id: the previous design
# could hit hundreds of resolves in a sweep and tripped intermittent failures.
# This runs once per script invocation and is safe to call before any sync work.
load_canonical_mapping() {
  local offset=0 limit=200
  local fetched=0 total=-1

  while :; do
    local resp
    if ! resp=$(curl -fsS --max-time 30 "${API_BASE}/datasets?limit=${limit}&offset=${offset}" 2>/dev/null); then
      log_error "Failed to fetch catalog mapping from ${API_BASE}/datasets at offset=${offset}"
      return 1
    fi

    local pairs
    pairs=$(printf '%s' "$resp" | jq -r '
      .datasets[]
      | select(.source_id != null and (.source_id | tostring | startswith("ds")))
      | "\(.source_id)\t\(.dataset_id)"
    ')
    if [[ -n "$pairs" ]]; then
      while IFS=$'\t' read -r src_id dst_id; do
        [[ -n "$src_id" && -n "$dst_id" ]] && DS_TO_ON["$src_id"]="$dst_id"
      done <<<"$pairs"
    fi

    local page_count
    page_count=$(printf '%s' "$resp" | jq -r '.count // 0')
    if (( total < 0 )); then
      total=$(printf '%s' "$resp" | jq -r '.total_count // 0')
    fi
    fetched=$((fetched + page_count))
    if (( page_count == 0 )) || (( fetched >= total )); then
      break
    fi
    offset=$((offset + limit))
  done

  log "Loaded ${#DS_TO_ON[@]} ds->on mirror mapping(s) from catalog"
}

# Translate a hallu directory name into the canonical S3 key prefix.
#
# nm*/on* directories already use canonical ids; we publish under the same id.
# ds* directories are OpenNeuro shadows. When the catalog has an on* mirror
# (DS_TO_ON has an entry), we publish under the on* id so the canonical
# landing page at /dataset/on* sees the QA. ds* with no mirror yet return
# empty -- the caller treats that as a skip.
resolve_canonical_id() {
  local source_id="$1"

  if [[ ! "$source_id" =~ ^ds[0-9]{6}$ ]]; then
    echo "$source_id"
    return 0
  fi

  echo "${DS_TO_ON[$source_id]:-}"
}

sync_dataset_qa() {
  local source_id="$1"
  local src="${PROCESSED_DIR}/${source_id}"

  if [[ ! -d "$src" ]]; then
    log_verbose "[SKIP] ${source_id}: no processed/ directory"
    return 0
  fi

  # Resolve ds* -> on* (or identity for nm*/on*) via the in-memory mapping
  # loaded once at startup. Manifest is keyed by the source dir so per-directory
  # fingerprints stay stable across renames; the S3 destination uses the
  # canonical id.
  local dest_id
  dest_id=$(resolve_canonical_id "$source_id")
  if [[ -z "$dest_id" ]]; then
    log_verbose "[SKIP] ${source_id}: no canonical mirror (ds* without on* in catalog)"
    return 0
  fi

  local dst="s3://${S3_BUCKET}/${dest_id}/qa/"

  local fingerprint
  fingerprint=$(qa_tree_fingerprint "$src")
  if [[ "$fingerprint" == "empty" ]]; then
    log_verbose "[SKIP] ${source_id}: empty QA tree (no eligible files)"
    return 0
  fi

  local recorded_fingerprint
  recorded_fingerprint=$(get_manifest_field "$source_id" "fingerprint")
  local recorded_dest
  recorded_dest=$(get_manifest_field "$source_id" "dest_id")
  if [[ "$recorded_fingerprint" == "$fingerprint" && "$recorded_dest" == "$dest_id" ]]; then
    log_verbose "[SKIP] ${source_id}: QA tree unchanged (fingerprint=${fingerprint}, dest=${dest_id})"
    return 0
  fi

  if [[ "$source_id" != "$dest_id" ]]; then
    log "[SYNC] ${source_id} -> ${dest_id}: ${recorded_fingerprint:-<new>} -> ${fingerprint}"
  else
    log "[SYNC] ${source_id}: ${recorded_fingerprint:-<new>} -> ${fingerprint}"
  fi

  # `aws s3 sync` is idempotent: it only uploads new / changed files. The
  # exclude flags mirror the fingerprint scope.
  local sync_output
  if ! sync_output=$(aws s3 sync "$src/" "$dst" \
    --region "$S3_REGION" \
    --no-progress \
    "${EXCLUDES[@]}" 2>&1); then
    log_error "[FAIL] ${source_id}: aws s3 sync exited non-zero"
    log_error "  ${sync_output}"
    return 1
  fi

  # Log the count of newly uploaded objects so operators see signal-not-noise.
  local upload_count
  upload_count=$(printf '%s\n' "$sync_output" | grep -c '^upload:' || true)
  log "[OK] ${source_id} -> ${dest_id}: synced ${upload_count} new/changed objects"
  log_verbose "$sync_output"

  update_manifest "$source_id" "fingerprint" "$fingerprint"
  update_manifest "$source_id" "dest_id" "$dest_id"
  return 0
}

################################################################################
# Main
################################################################################

main() {
  rotate_log
  log "=== QA sync started ==="

  acquire_lock
  check_prerequisites

  if ! load_canonical_mapping; then
    log_error "Aborting: could not load ds->on mapping from catalog"
    return 1
  fi

  # Discover datasets: either one explicit argument or every nm/on/ds*-prefix
  # subdirectory of PROCESSED_DIR. ds* dirs are mapped to their on* canonical
  # id at upload time (see resolve_canonical_id). xx* sandbox datasets are
  # skipped: they exist only for E2E testing and have no public catalog presence.
  local datasets=()
  if [[ -n "$SINGLE_DATASET" ]]; then
    datasets=("$SINGLE_DATASET")
  else
    while IFS= read -r d; do
      [[ -z "$d" ]] && continue
      datasets+=("$d")
    done < <(find "$PROCESSED_DIR" -mindepth 1 -maxdepth 1 -type d \
      -regextype posix-extended -regex '.*/(nm|on|ds)[0-9]{6}$' \
      -printf '%f\n' | sort)
  fi

  if (( ${#datasets[@]} == 0 )); then
    log "No datasets found under $PROCESSED_DIR"
    log "=== QA sync complete: 0 datasets ==="
    return 0
  fi

  log "Discovered ${#datasets[@]} dataset(s) to evaluate"

  local total=0 ok=0 failed=0 skipped=0
  for dataset_id in "${datasets[@]}"; do
    total=$((total + 1))
    # Track skip vs success via the manifest: if fingerprint didn't change
    # we'll have logged a [SKIP] above and update_manifest wasn't called.
    local before
    before=$(get_manifest_field "$dataset_id" "fingerprint_synced_at")
    if sync_dataset_qa "$dataset_id"; then
      local after
      after=$(get_manifest_field "$dataset_id" "fingerprint_synced_at")
      if [[ "$before" != "$after" ]]; then
        ok=$((ok + 1))
      else
        skipped=$((skipped + 1))
      fi
    else
      failed=$((failed + 1))
    fi
  done

  log "=== QA sync complete: ${total} datasets, ${ok} synced, ${skipped} unchanged, ${failed} failed ==="
}

main "$@"
