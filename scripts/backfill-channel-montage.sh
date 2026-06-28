#!/usr/bin/env bash
#
# Drive the channel/montage backfill (epic #854 phase 3, #859) by polling
# POST /admin/datasets/channel-montage-sweep?limit=N until `remaining` reaches 0.
# The endpoint is idempotent (only rows with channel_montage_checked_at IS NULL
# are candidates) and writes n_channels / electrode_system WITHOUT bumping
# updated_at, so re-running is safe and the catalog's "newest" sort is untouched.
#
# Target whichever env's D1 you mean to populate. The DEV worker seeds dev D1;
# api.nemar.org seeds PROD D1 (what the public site reads) -- run dev first to
# validate, then prod.
#
# Usage:
#   NEMAR_ADMIN_KEY=... ./scripts/backfill-channel-montage.sh
#   NEMAR_API_BASE=https://nemar-api-dev.sccn-org.workers.dev \
#     NEMAR_ADMIN_KEY=... ./scripts/backfill-channel-montage.sh --limit 10
#
# Env:
#   NEMAR_ADMIN_KEY   (required) admin/owner API key (Bearer)
#   NEMAR_API_BASE    (default https://api.nemar.org)
#   --limit N         per-batch cap (default 15, endpoint clamps to <=30)
#   --dry-run         print the first batch result and stop (no loop)

set -euo pipefail

API_BASE="${NEMAR_API_BASE:-https://api.nemar.org}"
LIMIT=15
DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "[backfill] unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "${NEMAR_ADMIN_KEY:-}" ]]; then
  echo "[backfill] ERROR: set NEMAR_ADMIN_KEY (admin/owner API key)." >&2
  exit 1
fi
for bin in curl jq; do
  command -v "$bin" >/dev/null || { echo "[backfill] ERROR: $bin not found." >&2; exit 1; }
done

echo "[backfill] target: $API_BASE  limit/batch: $LIMIT"
batch=0
total_processed=0
total_populated=0
while true; do
  batch=$((batch + 1))
  resp="$(curl -fsS -X POST \
    -H "Authorization: Bearer ${NEMAR_ADMIN_KEY}" \
    "${API_BASE}/admin/datasets/channel-montage-sweep?limit=${LIMIT}")" || {
      echo "[backfill] request failed on batch $batch" >&2; exit 1; }

  processed="$(jq -r '.processed' <<<"$resp")"
  populated="$(jq -r '.populated' <<<"$resp")"
  noData="$(jq -r '.noData' <<<"$resp")"
  remaining="$(jq -r '.remaining' <<<"$resp")"
  nerr="$(jq -r '.errors | length' <<<"$resp")"
  total_processed=$((total_processed + processed))
  total_populated=$((total_populated + populated))
  echo "[backfill] batch $batch: processed=$processed populated=$populated noData=$noData errors=$nerr remaining=$remaining"
  if [[ "$nerr" -gt 0 ]]; then jq -c '.errors[]' <<<"$resp" | sed 's/^/[backfill]   error: /'; fi

  if $DRY_RUN; then echo "[backfill] dry-run: stopping after one batch."; break; fi
  if [[ "$processed" -eq 0 || "$remaining" == "0" || "$remaining" == "null" ]]; then break; fi
  sleep 3
done

echo "[backfill] done. batches=$batch processed=$total_processed populated=$total_populated"
