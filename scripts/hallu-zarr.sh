#!/usr/bin/env bash
################################################################################
# NEMAR SDSC Hallu Zarr conversion
#
# Purpose: Build the derived, latest-only Zarr serving copies for NEMAR public
#          datasets ON Hallu (ample compute + a 1 Gbps link, no GitHub Actions
#          120-min cap) and push them to s3://nemar/<id>/zarr/. Epic
#          nemarOrg/nemar-cli#684; the conversion engine replaces the
#          run-generate-zarr.yml Actions path for bulk/backfill.
#
# Design: self-contained + EPHEMERAL. For each dataset it downloads a fresh copy
#         into a scratch WORK_DIR via `nemar dataset download`, converts it with
#         the biosigIO driver (nemarDatasets/.github :: scripts/zarr/
#         generate_zarr.py --local), pushes the stores to S3, then DELETES the
#         scratch copy. Nothing persists between datasets -- disk is reclaimed
#         immediately and there is no dependency on the hallu-sync clones.
#         Idempotent + lock-guarded; one dataset's failure doesn't abort the run.
#
# Usage:
#   ./hallu-zarr.sh                 # all public datasets needing conversion
#   ./hallu-zarr.sh --dataset nm000132   # one dataset (test / targeted rebuild)
#   ./hallu-zarr.sh --full --dataset nm000132   # force a full reconvert
#   ./hallu-zarr.sh --limit 5       # cap datasets per run (paced backfill)
#
# Crontab (sibling of hallu-sync, offset to :30):
#   30 * * * * /path/to/nemar-cli/scripts/hallu-zarr.sh >> /data/projects/yahya/nemar/.nm-zarr-cron.log 2>&1
#
# Prereqs: curl, jq, git, git-annex, nemar CLI, aws, uv, python3 in PATH.
################################################################################

set -uo pipefail

# --- PATH bootstrap (Homebrew/Bun/uv installed under $HOME) -------------------
for p in "$HOME/.local/homebrew/bin" "$HOME/.bun/bin" "$HOME/.local/bin"; do
  [[ -d "$p" ]] && PATH="$p:$PATH"
done
export PATH

# --- Config (environment-overridable) ----------------------------------------
WORK_DIR="${ZARR_WORK_DIR:-/data/projects/yahya/nemar/tmp}"
STATE_DIR="${ZARR_STATE_DIR:-/data/projects/yahya/nemar}"
DRIVER_REPO="${ZARR_DRIVER_REPO:-${STATE_DIR}/dotgithub}"   # clone of nemarDatasets/.github
VENV_DIR="${ZARR_VENV_DIR:-${STATE_DIR}/.zarr-venv}"
BIOSIGIO_SPEC="${BIOSIGIO_SPEC:-biosigio[zarr,meg]>=1.1.2}"
API_BASE="${API_BASE:-https://api.nemar.org}"
CALLBACK_URL="${ZARR_CALLBACK_URL:-${API_BASE}/webhooks/zarr-ready}"
S3_BUCKET="${S3_BUCKET:-nemar}"
AWS_REGION="${AWS_DEFAULT_REGION:-us-east-2}"
# Scoped service profile (IAM user nemar-hallu-zarr; s3:Get/Put/Delete on
# nemar/*/zarr/* + ListBucket). The driver's `aws s3 ...` calls inherit it.
export AWS_PROFILE="${ZARR_AWS_PROFILE:-nemar-zarr}"
export AWS_DEFAULT_REGION="$AWS_REGION"
LOG_FILE="${ZARR_LOG_FILE:-${STATE_DIR}/.nm-zarr.log}"
LOCK_FILE="${ZARR_LOCK_FILE:-${STATE_DIR}/.nm-zarr.lock}"
# NEMAR_WEBHOOK_TOKEN may be exported by the environment; the callback is skipped
# when it is empty (the viewer reads index.json, not D1, so the callback is only
# D1 bookkeeping).
NEMAR_WEBHOOK_TOKEN="${NEMAR_WEBHOOK_TOKEN:-}"

ONLY_DATASET=""
FULL=""
LIMIT="${ZARR_LIMIT:-0}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dataset) ONLY_DATASET="$2"; shift 2 ;;
    --full) FULL="--full"; shift ;;
    --limit) LIMIT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

log() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" | tee -a "$LOG_FILE"; }
err() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] ERROR: $*" | tee -a "$LOG_FILE" >&2; }

mkdir -p "$WORK_DIR" "$STATE_DIR"

# --- Single-instance lock -----------------------------------------------------
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another hallu-zarr instance holds the lock; exiting"
  exit 3
fi

# --- One-time setup: driver repo + biosigIO venv ------------------------------
setup() {
  if [[ -d "$DRIVER_REPO/.git" ]]; then
    git -C "$DRIVER_REPO" fetch -q origin && git -C "$DRIVER_REPO" reset -q --hard origin/main
  else
    git clone -q https://github.com/nemarDatasets/.github "$DRIVER_REPO"
  fi
  if [[ ! -x "$VENV_DIR/bin/python" ]]; then
    uv venv -q "$VENV_DIR"
  fi
  # Idempotent: uv pip install is a no-op when satisfied.
  VIRTUAL_ENV="$VENV_DIR" uv pip install -q "$BIOSIGIO_SPEC" 2>&1 | tail -2 || true
}

DRIVER="$DRIVER_REPO/scripts/zarr/generate_zarr.py"

# --- Per-dataset: download -> convert -> push -> CLEANUP -----------------------
convert_dataset() {
  local id="$1"
  local dir="$WORK_DIR/$id"
  local cb="$WORK_DIR/$id.callback.json"
  log "[$id] start"

  rm -rf "$dir"
  if ! nemar dataset download "$id" -o "$dir" -j 8 >>"$LOG_FILE" 2>&1; then
    err "[$id] download failed; skipping"
    rm -rf "$dir"
    return 1
  fi

  local rc=0
  VIRTUAL_ENV="$VENV_DIR" "$VENV_DIR/bin/python" "$DRIVER" \
    --dataset-id "$id" --repo-dir "$dir" --local \
    --bucket "$S3_BUCKET" --region "$AWS_REGION" $FULL \
    --callback-out "$cb" >>"$LOG_FILE" 2>&1 || rc=$?

  if [[ -f "$cb" && -n "$NEMAR_WEBHOOK_TOKEN" ]]; then
    curl -sS --connect-timeout 10 --max-time 30 -X POST "$CALLBACK_URL" \
      -H "Content-Type: application/json" \
      -H "X-Webhook-Token: ${NEMAR_WEBHOOK_TOKEN}" \
      --data @"$cb" >>"$LOG_FILE" 2>&1 || err "[$id] callback failed (non-fatal)"
  fi

  # EPHEMERAL: always reclaim the scratch copy, success or failure. The store
  # is on S3; we never keep a local copy.
  rm -rf "$dir" "$cb"
  if [[ "$rc" -eq 0 ]]; then log "[$id] done"; else err "[$id] driver rc=$rc"; fi
  return "$rc"
}

# --- Dataset list (public nm/on only) -----------------------------------------
list_public_datasets() {
  curl -sS --max-time 60 "${API_BASE}/datasets?limit=1000" 2>/dev/null \
    | jq -r '.datasets[]? | select(.visibility=="public") | .dataset_id' 2>/dev/null \
    | grep -E '^(nm|on)[0-9]{6}$' | grep -v '^nm099999$' || true
}

setup
if [[ -z "$DRIVER" || ! -f "$DRIVER" ]]; then
  err "driver not found at $DRIVER after setup"; exit 1
fi

if [[ -n "$ONLY_DATASET" ]]; then
  convert_dataset "$ONLY_DATASET"
  exit $?
fi

n=0
while read -r id; do
  [[ -z "$id" ]] && continue
  convert_dataset "$id" || true
  n=$((n + 1))
  if [[ "$LIMIT" -gt 0 && "$n" -ge "$LIMIT" ]]; then
    log "reached --limit $LIMIT; stopping this run"
    break
  fi
done < <(list_public_datasets)

log "run complete: processed $n dataset(s)"
