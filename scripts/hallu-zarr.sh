#!/usr/bin/env bash
################################################################################
# NEMAR SDSC Hallu Zarr conversion (queue-driven)
#
# Purpose: Build the derived, latest-only Zarr serving copies for NEMAR public
#          datasets ON Hallu (ample compute + a 1 Gbps link, no GitHub Actions
#          120-min cap) and push them to s3://nemar/<id>/zarr/. Epic
#          nemarOrg/nemar-cli#684; the conversion engine replaces the
#          run-generate-zarr.yml Actions path for bulk/backfill.
#
# Design: self-contained, EPHEMERAL, and crash-safe via a persistent SQLite
#         queue (scripts/zarr/zarr_queue.py). Each run:
#           1. reconcile -- enqueue every public dataset whose latest version
#              isn't converted yet, and reset any `inprogress` job left by a
#              crashed/rebooted run back to `pending`.
#           2. drain     -- claim the oldest job, download a fresh copy into a
#              scratch dir via `nemar dataset download`, convert it with the
#              biosigIO driver (generate_zarr.py --local), push the stores to S3,
#              `rm -rf` the scratch copy, and mark the job done (or fail w/
#              backoff). Repeat until the queue is empty (or --limit).
#         flock keeps a single long backfill draining across hourly cron ticks
#         (a later tick finds the lock held and exits). As long as the box is on,
#         the cron fires and the queue resumes exactly where it left off.
#
# Usage:
#   ./hallu-zarr.sh                      # reconcile + drain the queue
#   ./hallu-zarr.sh --limit 20           # cap datasets per run (paced)
#   ./hallu-zarr.sh --dataset nm000132   # one dataset now (bypasses the queue)
#   ./hallu-zarr.sh --dataset nm000132 --full
#   ./hallu-zarr.sh --stats              # print queue status and exit
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
QUEUE_DB="${ZARR_QUEUE_DB:-${STATE_DIR}/zarr-queue.db}"
LOG_FILE="${ZARR_LOG_FILE:-${STATE_DIR}/.nm-zarr.log}"
LOCK_FILE="${ZARR_LOCK_FILE:-${STATE_DIR}/.nm-zarr.lock}"
# NEMAR_WEBHOOK_TOKEN may be exported by the environment; the callback is skipped
# when it is empty (the viewer reads index.json, not D1, so the callback is only
# D1 bookkeeping).
NEMAR_WEBHOOK_TOKEN="${NEMAR_WEBHOOK_TOKEN:-}"

ONLY_DATASET=""
FULL=""
LIMIT="${ZARR_LIMIT:-0}"
STATS_ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dataset) ONLY_DATASET="$2"; shift 2 ;;
    --full) FULL="--full"; shift ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --stats) STATS_ONLY=1; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

log() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" | tee -a "$LOG_FILE"; }
err() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] ERROR: $*" | tee -a "$LOG_FILE" >&2; }

mkdir -p "$WORK_DIR" "$STATE_DIR"

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
QUEUE="$DRIVER_REPO/scripts/zarr/zarr_queue.py"
qpy() { VIRTUAL_ENV="$VENV_DIR" "$VENV_DIR/bin/python" "$QUEUE" --db "$QUEUE_DB" "$@"; }

# --- Per-dataset: download -> convert -> push -> CLEANUP -----------------------
# Returns 0 on success. The store is on S3; the scratch copy is always deleted.
convert_dataset() {
  local id="$1" version="${2:-}"
  local dir="$WORK_DIR/$id"
  local cb="$WORK_DIR/$id.callback.json"
  log "[$id] start (version=${version:-?})"

  rm -rf "$dir"
  if ! nemar dataset download "$id" -o "$dir" -j 8 >>"$LOG_FILE" 2>&1; then
    err "[$id] download failed"
    rm -rf "$dir"
    return 1
  fi

  local rc=0
  VIRTUAL_ENV="$VENV_DIR" "$VENV_DIR/bin/python" "$DRIVER" \
    --dataset-id "$id" --repo-dir "$dir" --local \
    --bucket "$S3_BUCKET" --region "$AWS_REGION" $FULL \
    --callback-out "$cb" >>"$LOG_FILE" 2>&1 || rc=$?

  if [[ "$rc" -eq 0 && -f "$cb" && -n "$NEMAR_WEBHOOK_TOKEN" ]]; then
    curl -sS --connect-timeout 10 --max-time 30 -X POST "$CALLBACK_URL" \
      -H "Content-Type: application/json" \
      -H "X-Webhook-Token: ${NEMAR_WEBHOOK_TOKEN}" \
      --data @"$cb" >>"$LOG_FILE" 2>&1 || err "[$id] callback failed (non-fatal)"
  fi

  # EPHEMERAL: always reclaim the scratch copy, success or failure.
  rm -rf "$dir" "$cb"
  if [[ "$rc" -eq 0 ]]; then log "[$id] done"; else err "[$id] driver rc=$rc"; fi
  return "$rc"
}

# --- Single-instance lock -----------------------------------------------------
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another hallu-zarr instance holds the lock; exiting"
  exit 3
fi

setup
if [[ ! -f "$DRIVER" || ! -f "$QUEUE" ]]; then
  err "driver/queue not found under $DRIVER_REPO after setup"; exit 1
fi

if [[ -n "$STATS_ONLY" ]]; then
  qpy stats
  exit 0
fi

# Targeted single-dataset run bypasses the queue (manual rebuild / test).
if [[ -n "$ONLY_DATASET" ]]; then
  v="$(curl -sS --max-time 30 "${API_BASE}/datasets/${ONLY_DATASET}" 2>/dev/null \
        | jq -r '.dataset.latest_version // ""' 2>/dev/null)"
  convert_dataset "$ONLY_DATASET" "$v"
  exit $?
fi

# Reconcile (enqueue pending + recover stale inprogress), then drain the queue.
log "reconcile: $(qpy reconcile --api-base "$API_BASE")"
n=0
while :; do
  line="$(qpy next)"
  [[ -z "$line" ]] && break
  id="${line%%$'\t'*}"; version="${line#*$'\t'}"
  if convert_dataset "$id" "$version"; then
    qpy done "$id" "$version"
  else
    qpy fail "$id" "conversion failed (see ${LOG_FILE})"
  fi
  n=$((n + 1))
  if [[ "$LIMIT" -gt 0 && "$n" -ge "$LIMIT" ]]; then
    log "reached --limit $LIMIT; stopping (queue persists; next run continues)"
    break
  fi
done

log "run complete: processed $n dataset(s); $(qpy stats | head -1)"
