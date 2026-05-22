#!/usr/bin/env bash
#
# Backfill summary.json (and re-emit manifest.json) for the 5 datasets
# recovered manually on 2026-05-18.
#
# This dispatches the central manifest-generation workflow
# (.github/workflows/generate-manifest.yml on nemarDatasets/.github) once
# per dataset. The workflow walks the dataset's git tree at the recorded
# version tag, builds manifest.json + summary.json, and uploads both to
# s3://nemar/<id>/version/v<X.Y.Z>{,-summary}.json.
#
# Idempotent: running this twice on the same dataset just re-dispatches
# the workflow, which overwrites the S3 objects. Wait 30s between
# dispatches so we don't hammer the central workflow.
#
# Prerequisites:
#   - generate-manifest.yml deployed to nemarDatasets/.github main
#     (epic #559 PR-1; relocated #564)
#   - Required secrets at nemarDatasets ORG level, visibility=all repos:
#     NEMAR_APP_ID, NEMAR_APP_PRIVATE_KEY, AWS_ACCESS_KEY_ID,
#     AWS_SECRET_ACCESS_KEY, MANIFEST_CALLBACK_SECRET
#   - gh CLI authenticated with workflow:write on nemarDatasets/.github
#
# Usage:
#   ./scripts/backfill-summaries.sh             # dispatch all
#   ./scripts/backfill-summaries.sh --dry-run   # print commands only

set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "=== DRY RUN MODE - No workflow dispatches will fire ==="
fi

# Fail fast on an unauthenticated gh CLI so the operator doesn't watch
# every dispatch fail in sequence (each followed by a 30s sleep) only to
# learn at the end that the token was expired.
if ! gh auth status --hostname github.com &>/dev/null; then
  echo "[backfill] ERROR: gh CLI not authenticated. Run: gh auth login" >&2
  exit 1
fi

REPO="nemarDatasets/.github"
WORKFLOW="generate-manifest.yml"
SLEEP_BETWEEN=30

# Format: dataset_id:version:doi:concept_doi
# Versions and DOIs sourced from https://api.nemar.org/datasets/<id> on
# 2026-05-19 (Cloudflare D1 not directly queryable from the worktree;
# the public catalog row is the same source of truth used by the central
# workflow).
# nm000104, nm000105, nm000107 excluded — not publicly listed in catalog as of 2026-05-19
DATASETS=(
  "nm000103:2.0.0:10.82901/nemar.nm000103.v2.0.0:10.82901/nemar.nm000103"
  "nm000106:2.0.0:10.82901/nemar.nm000106.v2.0.0:10.82901/nemar.nm000106"
  "nm000166:1.0.0:10.82901/nemar.nm000166.v1.0.0:10.82901/nemar.nm000166"
  "on004362:1.0.0:10.82901/nemar.on004362.v1.0.0:10.82901/nemar.on004362"
  "on005261:1.0.0:10.82901/nemar.on005261.v1.0.0:10.82901/nemar.on005261"
)

FIRED=()
WOULD_FIRE=()
FAILED=()

dispatch_one() {
  local dataset_id="$1"
  local version="$2"
  local doi="$3"
  local concept_doi="$4"

  local cmd=(
    gh workflow run "$WORKFLOW"
    --repo "$REPO"
    -f "dataset_id=$dataset_id"
    -f "version=$version"
    -f "doi=$doi"
    -f "concept_doi=$concept_doi"
  )

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] ${cmd[*]}"
    # Track separately so the final summary can't claim dispatches that
    # never happened. A confused operator reading "Fired (5)" after a
    # dry run is a real failure mode.
    WOULD_FIRE+=("$dataset_id@$version")
    return 0
  fi

  echo "[backfill] dispatching $dataset_id@v$version ..."
  if "${cmd[@]}"; then
    FIRED+=("$dataset_id@$version")
    echo "[backfill] dispatched $dataset_id@v$version"
  else
    FAILED+=("$dataset_id@$version")
    echo "[backfill] FAILED to dispatch $dataset_id@v$version" >&2
  fi
}

LAST_IDX=$((${#DATASETS[@]} - 1))
IDX=0
for entry in "${DATASETS[@]}"; do
  IFS=':' read -r dataset_id version doi concept_doi <<< "$entry"
  dispatch_one "$dataset_id" "$version" "$doi" "$concept_doi"

  if [[ "$DRY_RUN" != "true" && "$IDX" -lt "$LAST_IDX" ]]; then
    echo "[backfill] sleeping ${SLEEP_BETWEEN}s before next dispatch ..."
    sleep "$SLEEP_BETWEEN"
  fi
  IDX=$((IDX + 1))
done

echo
echo "=== Summary ==="
if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry-run would fire (${#WOULD_FIRE[@]}):"
  for d in "${WOULD_FIRE[@]}"; do echo "  - $d"; done
  echo
  echo "Re-run without --dry-run to dispatch."
  exit 0
fi

echo "Fired (${#FIRED[@]}):"
for d in "${FIRED[@]}"; do echo "  - $d"; done
if [[ "${#FAILED[@]}" -gt 0 ]]; then
  echo "Failed (${#FAILED[@]}):"
  for d in "${FAILED[@]}"; do echo "  - $d"; done
  exit 1
fi
echo
echo "Verify with:"
echo "  curl -s https://data.nemar.org/<dataset_id>/<version>/summary.json | jq .totals"
