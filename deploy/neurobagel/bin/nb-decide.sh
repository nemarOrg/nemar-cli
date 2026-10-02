# shellcheck shell=bash
# shellcheck disable=SC2034  # NB_VERIFY_* are read by the scripts that source this file
#
# The decisions the NEMAR Neurobagel node scripts make, as pure shell functions.
#
# Sourced by nb-common.sh. Nothing here starts a container, reads a socket or changes a file: each
# function takes text or plain values and answers. That is the point. The safety logic (which release
# to roll back to, when to abort for memory, when a hold wins, what counts as a guard breach, whether
# the node serves what it should, what status says) used to live inside the Docker-driving scripts,
# where no test could reach it. Here it is tested against REAL captured text
# (test/fixtures/neurobagel-node/, and the output of the real loader).
#
# Bash 3.2 compatible.

# ---------------------------------------------------------------------------------------------
# Memory
# ---------------------------------------------------------------------------------------------

# Succeeds when host memory is KNOWN and below the abort threshold (MiB). An unknown reading (not
# Linux) is never a breach.
nb_decide_mem_breach() { # available_mb abort_mb
  [ -n "$1" ] && [ "$1" -lt "$2" ]
}

# Succeeds when a reload may start: memory unknown, or at least the minimum.
nb_decide_mem_preflight_ok() { # available_mb min_mb
  [ -z "$1" ] || [ "$1" -ge "$2" ]
}

# ---------------------------------------------------------------------------------------------
# Hold. A node on hold must stay down, so a hold wins over a reload in progress, except when the
# reload IS the operator ending the hold (nb unhold).
# ---------------------------------------------------------------------------------------------
nb_decide_hold_stop() { # hold_present(0|1) from_unhold(0|1) -> prints stop or go
  if [ "$1" = 1 ] && [ "$2" = 0 ]; then echo stop; else echo go; fi
}

# A failed reload is held against the CONTENT (and not retried for a while) only when the content
# can be at fault. A hold, or a host that ran short of memory, says nothing about it.
nb_decide_blame_content() { # held(0|1) mem_breach(0|1) -> prints yes or no
  if [ "$1" = 1 ] || [ "$2" = 1 ]; then echo no; else echo yes; fi
}

# ---------------------------------------------------------------------------------------------
# Releases
# ---------------------------------------------------------------------------------------------

# A release name is <UTC timestamp>-<8 hex>[-<n>]. Anything else is never used as a path.
nb_release_name_ok() {
  printf '%s' "$1" | grep -qE '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}(-[0-9]+)?$'
}

# Prints the first candidate that is a well-formed release name, is not the one named as `current`,
# and exists as a directory under RELEASES_DIR. Prints nothing when none qualifies.
nb_first_release() { # current releases_dir candidate...
  local cur="$1" dir="$2" t
  shift 2
  for t in "$@"; do
    [ -n "$t" ] && [ "$t" != "$cur" ] && nb_release_name_ok "$t" && [ -d "$dir/$t" ] || continue
    printf '%s' "$t"
    return 0
  done
  return 0
}

# Where a FAILED reload of `current` goes back to: the release that was last loaded AND verified
# (applied), if it is still on disk, and only otherwise the release published before this one.
# The previously published release may never have been loaded at all.
nb_decide_rollback_target() { # current applied rollback_to releases_dir
  nb_first_release "$1" "$4" "$2" "$3"
}

# Where `nb rollback` goes by default. When the live release is the loaded one, back to the one
# loaded before it; when it is not (a staged release is waiting), to the loaded one.
nb_decide_manual_rollback_target() { # current applied previous_loaded rollback_to releases_dir
  if [ "$1" = "$2" ]; then
    nb_first_release "$1" "$5" "$3" "$4"
  else
    nb_first_release "$1" "$5" "$2" "$3" "$4"
  fi
}

# ---------------------------------------------------------------------------------------------
# Guard
# ---------------------------------------------------------------------------------------------

# Load rule: breach only after SAMPLES consecutive readings above THRESHOLD. Prints "<streak> ok"
# or "<streak> breach"; feed the streak back in on the next sample.
nb_guard_load_rule() { # load streak threshold samples
  local load="$1" streak="$2" thr="$3" need="$4"
  if [ -n "$load" ] && awk -v l="$load" -v t="$thr" 'BEGIN { exit !(l > t) }'; then
    streak=$((streak + 1))
    if [ "$streak" -ge "$need" ]; then echo "$streak breach"; else echo "$streak ok"; fi
  else
    echo "0 ok"
  fi
}

# Neighbour rule. BASELINE_FILE and stdin hold lines "name<TAB>started_at<TAB>restart_count" and
# "name<TAB>started_at<TAB>restart_count<TAB>health<TAB>state". Prints a ;-separated list such as
# "svc-a(restarted);svc-b(gone)", or nothing. A container the baseline has never seen is new, not
# restarted, and is ignored.
nb_guard_neighbor_breaches() { # baseline_file < current lines
  local baseline="$1" now n s r h bad=""
  now="$(cat)"
  while IFS=$'\t' read -r n s r h _; do
    [ -n "$n" ] || continue
    cut -f1 "$baseline" | grep -qxF "$n" || continue
    grep -qxF "$(printf '%s\t%s\t%s' "$n" "$s" "$r")" <(cut -f1-3 "$baseline") || bad="$bad $n(restarted)"
    [ "$h" != unhealthy ] || bad="$bad $n(unhealthy)"
  done <<<"$now"
  while IFS=$'\t' read -r n _; do
    [ -n "$n" ] || continue
    printf '%s\n' "$now" | cut -f1 | grep -qxF "$n" || bad="$bad $n(gone)"
  done <"$baseline"
  printf '%s' "${bad# }" | tr ' ' ';'
}

# ---------------------------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------------------------

# One problem per line, from the loader's own records.
#   last_load_json  state/last-load.json (may be absent)
#   last_ok_epoch   when a loader run last finished well (a run that found nothing to do counts)
#   source_set      1 when NB_SOURCE is configured, so a loader is expected to be running
#   stale_s         how long without a good run is too long
#   freeze          the freeze note, empty when not frozen
nb_loader_problems() { # last_load_json last_ok_epoch now source_set stale_s freeze
  local f="$1" ok="$2" now="$3" set="$4" stale="$5" freeze="$6" outcome at
  [ -z "$freeze" ] || echo "the loader is frozen ($freeze); end it with: nb load --thaw"
  if [ -f "$f" ]; then
    outcome="$(jq -r '.outcome // ""' "$f" 2>/dev/null || true)"
    at="$(jq -r '.at // ""' "$f" 2>/dev/null || true)"
    case "$outcome" in
      reload-failed | known-bad | source-failed | validation-failed)
        echo "the newest content is NOT being served: the last loader run ended $outcome at $at"
        ;;
    esac
  fi
  if [ "$set" = 1 ]; then
    if [ -z "$ok" ]; then
      echo "the loader has not completed a run yet"
    elif [ $((now - ok)) -gt "$stale" ]; then
      echo "no successful loader run for $(((now - ok) / 60)) minutes"
    fi
  fi
}

# Prints a problem when the guard's heartbeat exists and is older than MAX_AGE seconds. A guard that
# was running and has gone quiet is itself a finding.
nb_guard_heartbeat_problem() { # heartbeat_epoch now max_age
  [ -n "$1" ] || return 0
  if [ $(($2 - $1)) -gt "$3" ]; then
    echo "the resource guard last sampled $((($2 - $1) / 60)) minutes ago"
  fi
}

# Verdict and exit code from the problems (joined with "; ") and the hold note. Prints
# "<verdict> <code>": healthy 0, degraded 1, down 2, hold 3. A node on hold whose API still answers
# is not on hold in any useful sense, so it is degraded.
nb_status_verdict() { # problems hold
  local problems="$1" hold="$2"
  if [ -n "$hold" ]; then
    case "$problems" in
      *"on hold but its API still answers"*) echo "degraded 1" ;;
      *) echo "hold 3" ;;
    esac
    return 0
  fi
  if [ -z "$problems" ]; then
    echo "healthy 0"
    return 0
  fi
  case "$problems" in
    *"is exited"* | *"is created"* | *"is dead"* | *"has no container"*) echo "down 2" ;;
    *) echo "degraded 1" ;;
  esac
}

# ---------------------------------------------------------------------------------------------
# Does the node serve what it should?
#
# Judges the node's own answers against a release directory. DATASETS and SUBJECTS are the JSON
# bodies of POST /datasets {} and of POST /subjects for one dataset. Returns 0 only when the node
# serves exactly the datasets of the release (in the form it reports them: the vocabulary URI form
# of nb:<uuid>) and every record is protected. Sets NB_VERIFY_REASON, NB_VERIFY_EXPECTED and
# NB_VERIFY_SERVED.
# ---------------------------------------------------------------------------------------------
nb_verify_judge() { # release_dir datasets_json subjects_json
  local dir="$1" datasets="$2" subjects="$3" want got missing extra f
  NB_VERIFY_REASON=""
  NB_VERIFY_EXPECTED=0
  NB_VERIFY_SERVED=0
  want="$(for f in "$dir"/*.jsonld; do
    [ -e "$f" ] || continue
    jq -r '.identifier | sub("^nb:"; "http://neurobagel.org/vocab/")' "$f"
  done | sort)"
  NB_VERIFY_EXPECTED="$(printf '%s\n' "$want" | grep -c . || true)"

  if ! printf '%s' "$datasets" | jq -e 'type == "array"' >/dev/null 2>&1; then
    NB_VERIFY_REASON="the node's datasets answer was not a list"
    return 1
  fi
  got="$(printf '%s' "$datasets" | jq -r '.[].dataset_uuid' | sort)"
  NB_VERIFY_SERVED="$(printf '%s\n' "$got" | grep -c . || true)"
  if [ "$NB_VERIFY_SERVED" -eq 0 ]; then
    NB_VERIFY_REASON="the node served no dataset at all"
    return 1
  fi
  if [ "$(printf '%s' "$datasets" | jq '[.[] | select(.records_protected != true)] | length')" -ne 0 ]; then
    NB_VERIFY_REASON="the node returned a dataset that is not marked records_protected"
    return 1
  fi
  if ! printf '%s' "$subjects" | jq -e 'type == "array"' >/dev/null 2>&1; then
    NB_VERIFY_REASON="the node's subjects answer was not a list"
    return 1
  fi
  if [ "$(printf '%s' "$subjects" | jq '[.[] | select(.subject_data != "protected")] | length')" -ne 0 ]; then
    NB_VERIFY_REASON="the node returned participant-level records; NB_RETURN_AGG must be true"
    return 1
  fi
  if [ "$(printf '%s' "$subjects" | jq 'length')" -eq 0 ]; then
    NB_VERIFY_REASON="the subjects answer was empty, so record protection could not be confirmed"
    return 1
  fi
  missing="$(comm -23 <(printf '%s\n' "$want") <(printf '%s\n' "$got") | tr '\n' ' ')"
  extra="$(comm -13 <(printf '%s\n' "$want") <(printf '%s\n' "$got") | tr '\n' ' ')"
  if [ -n "$missing" ] || [ -n "$extra" ]; then
    NB_VERIFY_REASON="served datasets differ from the release (missing: ${missing:-none}; unexpected: ${extra:-none})"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------------------------
# Reading what the stock containers print. Pure functions over text, tested against real captured
# output.
# ---------------------------------------------------------------------------------------------

# Reads the graph container's log for ONE start on stdin and prints exactly one line:
#   loaded            the stock setup script finished and reported no upload error
#   failed: <reason>  it finished with an error, or stopped on one
#   pending           it has not finished yet
# The stock upload script prints "ERROR: Upload failed for these files" and still exits 0, so the
# log text is the only signal there is.
nb_graph_log_verdict() {
  local logs
  logs="$(cat)"
  if printf '%s\n' "$logs" | grep -q 'Finished setting up the Neurobagel graph backend'; then
    if printf '%s\n' "$logs" | grep -qE 'ERROR: (Upload failed|Failed to clear)'; then
      printf 'failed: the graph reported upload errors: %s\n' \
        "$(printf '%s\n' "$logs" | grep -A5 -E 'ERROR: (Upload failed|Failed to clear)' | tr '\n' ' ' | cut -c1-300)"
    else
      echo loaded
    fi
  elif printf '%s\n' "$logs" | grep -qE 'Error: NB_GRAPH|ERROR: Failed to clear'; then
    printf 'failed: the graph setup script failed: %s\n' \
      "$(printf '%s\n' "$logs" | grep -E 'Error:|ERROR:' | head -n 2 | tr '\n' ' ' | cut -c1-300)"
  else
    echo pending
  fi
}

# Reads the stock initialiser's log on stdin and prints "<accepted> <total>" for the JSON-LD files
# it validated, or nothing when the summary line is absent.
nb_init_counts() {
  sed -n 's/.*successfully extracted from \([0-9]*\)\/\([0-9]*\) JSONLD.*/\1 \2/p' | tail -n 1
}
