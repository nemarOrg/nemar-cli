#!/usr/bin/env bash
# Compare two @bids/validator releases on reference datasets, with the gate that the central
# validation workflow (run-bids-validation.yml) applies: an error counts only when its location is
# not a git-annex pointer.
#
# Usage: compare-gating.sh --old <version> --new <version> --out <dir>
#          [--ids "<dataset ids>"] [--local <dir>]... [--canary]
#
# Each dataset is validated with the flags the central workflow passes (--json --ignoreWarnings),
# once per release. Validation runs from a scratch directory, never from inside a dataset, so Deno
# does not read a configuration file from the dataset.
#
# Writes into <dir>:
#   summary.md          the section the bump pull request body carries
#   results.tsv         one row per dataset: status, gating error counts, changed, note
#   diff-<id>.txt       the gating errors that differ, for each changed dataset
#
# A dataset that cannot be cloned or validated is listed as not compared. It is never reported as
# unchanged, because an absent result is not evidence that nothing changed.
set -uo pipefail

REFERENCE_IDS="xx099900 xx099901 xx099902 xx099903 xx099904 xx099905 xx099906 nm000103 nm000104 nm000105 nm000106 nm000107"

OLD=""
NEW=""
OUT=""
IDS="$REFERENCE_IDS"
LOCALS=()
CANARY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --old) OLD="$2"; shift 2 ;;
    --new) NEW="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --ids) IDS="$2"; shift 2 ;;
    --local) LOCALS+=("$2"); shift 2 ;;
    --canary) CANARY=1; shift ;;
    *) echo "compare-gating.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$OLD" ] || [ -z "$NEW" ] || [ -z "$OUT" ]; then
  echo "usage: compare-gating.sh --old <version> --new <version> --out <dir> [--ids \"...\"] [--local <dir>]... [--canary]" >&2
  exit 2
fi
for tool in deno jq git; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "compare-gating.sh: $tool is required" >&2
    exit 1
  fi
done

mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
RUN="$OUT/run"
DATA="$OUT/data"
mkdir -p "$RUN" "$DATA"
printf 'dataset\tstatus\tgating_old\tgating_new\tchanged\tnote\n' > "$OUT/results.tsv"

# A layout that a release can change: a data file that is an unfetched git-annex link, with a
# sidecar next to it. The central workflow filters the data file's error, not the sidecar's.
make_canary() {
  local d="$1"
  rm -rf "$d"
  mkdir -p "$d/sub-01/emg"
  printf '%s\n' '{"Name":"canary","BIDSVersion":"1.10.0","DatasetType":"raw"}' > "$d/dataset_description.json"
  printf 'participant_id\nsub-01\n' > "$d/participants.tsv"
  printf '%s\n' '{"SamplingFrequency":1000,"EMGChannelCount":1,"RecordingDuration":1,"EMGReference":"Other","PowerLineFrequency":50,"SoftwareFilters":"n/a"}' > "$d/sub-01/emg/sub-01_task-x_emg.json"
  printf 'name\ttype\tunits\tsampling_frequency\nEMG1\tEMG\tuV\t1000\n' > "$d/sub-01/emg/sub-01_task-x_channels.tsv"
  ln -s ../../.git/annex/objects/missing.bdf "$d/sub-01/emg/sub-01_task-x_emg.bdf"
}

# Each target is "id|absolute path".
TARGETS=()
for id in $IDS; do
  dir="$DATA/$id"
  if [ ! -d "$dir/.git" ]; then
    rm -rf "$dir"
    if ! GIT_TERMINAL_PROMPT=0 git clone --depth 1 --quiet "https://github.com/nemarDatasets/$id.git" "$dir" 2>"$RUN/$id.clone.err"; then
      rm -rf "$dir"
      printf '%s\tnot_compared\t-\t-\t-\tcould not clone nemarDatasets/%s\n' "$id" "$id" >> "$OUT/results.tsv"
      continue
    fi
  fi
  TARGETS+=("$id|$dir")
done
for loc in ${LOCALS[@]+"${LOCALS[@]}"}; do
  dir=$(cd "$loc" && pwd)
  TARGETS+=("$(basename "$dir")|$dir")
done
if [ "$CANARY" = 1 ]; then
  dir="$DATA/canary-emg-annex-sidecar"
  make_canary "$dir"
  TARGETS+=("canary-emg-annex-sidecar|$dir")
fi

# Gating errors: the error codes at locations that are not git-annex pointers, as sorted lines.
gate() {
  jq -r --slurpfile annex "$ANNEX" '
    .issues.issues[]
    | select(.severity == "error")
    | select(.location as $loc | ($annex[0] | index($loc)) | not)
    | "\(.code)\t\(.subCode // "-")\t\(.location // "-")"' "$RUN/$ID.$1.json" | sort > "$2"
}

for target in ${TARGETS[@]+"${TARGETS[@]}"}; do
  ID="${target%%|*}"
  dir="${target#*|}"
  ANNEX="$RUN/$ID.annex.json"

  # The annex-pointer list, built the way run-bids-validation.yml builds it: every symlink, and
  # every small file that holds a git-annex pointer.
  ( cd "$dir" && {
      find . -type l -not -path './.git/*' | sed 's|^\.||'
      find . -type f -not -path './.git/*' -size -1024c -exec grep -l '^/annex/objects/' {} + 2>/dev/null | sed 's|^\./|/|'
    } | sort -u ) > "$RUN/$ID.annex.txt"
  jq -R -s 'split("\n") | map(select(length > 0))' "$RUN/$ID.annex.txt" > "$ANNEX"

  status="compared"
  note="-"
  for ver in "$OLD" "$NEW"; do
    ( cd "$RUN" && deno run -A "jsr:@bids/validator@$ver" "$dir" --json --ignoreWarnings > "$RUN/$ID.$ver.json" 2> "$RUN/$ID.$ver.err" )
    if ! jq -e . "$RUN/$ID.$ver.json" >/dev/null 2>&1; then
      status="not_compared"
      note="no report from $ver: $(head -c 160 "$RUN/$ID.$ver.err" | tr '\n\t' '  ')"
    fi
  done

  g_old="-"
  g_new="-"
  changed="-"
  if [ "$status" = "compared" ]; then
    gate "$OLD" "$RUN/$ID.$OLD.gating"
    gate "$NEW" "$RUN/$ID.$NEW.gating"
    g_old=$(wc -l < "$RUN/$ID.$OLD.gating" | tr -d ' ')
    g_new=$(wc -l < "$RUN/$ID.$NEW.gating" | tr -d ' ')
    if diff -q "$RUN/$ID.$OLD.gating" "$RUN/$ID.$NEW.gating" >/dev/null 2>&1; then
      changed="no"
    else
      changed="yes"
      {
        echo "Gating errors that differ: '<' is $OLD, '>' is $NEW."
        diff "$RUN/$ID.$OLD.gating" "$RUN/$ID.$NEW.gating"
      } > "$OUT/diff-$ID.txt"
    fi
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$ID" "$status" "$g_old" "$g_new" "$changed" "$note" >> "$OUT/results.tsv"
done

# The pull request section. Counts come only from rows that were compared.
compared=$(awk -F'\t' 'NR > 1 && $2 == "compared"' "$OUT/results.tsv" | wc -l | tr -d ' ')
changed_count=$(awk -F'\t' 'NR > 1 && $5 == "yes"' "$OUT/results.tsv" | wc -l | tr -d ' ')
total=$(awk 'NR > 1' "$OUT/results.tsv" | wc -l | tr -d ' ')
{
  echo "## Reference datasets"
  echo
  echo "Gating errors are the errors that survive the annex-pointer filter of \`run-bids-validation.yml\`, counted for the current pin ($OLD) and the candidate ($NEW). Both releases ran with the same flags. \"Changed\" means the set of gating errors differs."
  echo
  echo "| Dataset | Gating errors, $OLD | Gating errors, $NEW | Changed |"
  echo "|---|---|---|---|"
  awk -F'\t' 'NR > 1 && $2 == "compared" { printf "| %s | %s | %s | %s |\n", $1, $3, $4, $5 }' "$OUT/results.tsv"
  echo
  echo "Compared $compared of $total datasets; $changed_count changed."
  not_compared=$(awk -F'\t' 'NR > 1 && $2 != "compared" { printf "%s (%s); ", $1, $6 }' "$OUT/results.tsv")
  if [ -n "$not_compared" ]; then
    echo
    echo "Not compared, so not counted as unchanged: ${not_compared%; }."
  fi
  for f in "$OUT"/diff-*.txt; do
    [ -e "$f" ] || continue
    echo
    echo "### $(basename "$f" .txt | sed 's/^diff-//')"
    echo
    echo '```diff'
    head -n 40 "$f"
    echo '```'
  done
} > "$OUT/summary.md"

echo "compared $compared of $total datasets; $changed_count changed; summary in $OUT/summary.md"
exit 0
