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
# reload IS the operator ending that hold (nb unhold). A hold with different text is a NEWER hold,
# set by `nb hold` while the unhold's reload was running, and it wins like any other.
# ---------------------------------------------------------------------------------------------
nb_decide_hold_stop() { # present(0|1) from_unhold(0|1) ending_text current_text -> prints stop or go
  if [ "$1" != 1 ]; then echo go; return 0; fi
  if [ "$2" != 1 ]; then echo stop; return 0; fi
  # An unhold that does not say which hold it is ending (no text) ends whatever is there.
  if [ -z "$3" ] || [ "$3" = "$4" ]; then echo go; else echo stop; fi
}

# `nb unhold` removes the hold it was asked to end, and only that one. It reads the flag when it
# starts (READ) and, when its work is done, looks at the flag again (NOW; empty when it is gone).
# A different text means `nb hold` ran again in between, and that newer hold is not ours to end.
nb_decide_unhold_flag() { # read_text now_text -> prints remove, keep or gone
  if [ -z "$2" ]; then echo gone; return 0; fi
  if [ "$1" = "$2" ]; then echo remove; else echo keep; fi
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
# The match is on the WHOLE string: `grep` works line by line, so a value such as "valid<newline>../.."
# matched when any one line did. [[ =~ ]] anchors on the string, and a newline is refused outright.
nb_release_name_ok() {
  local re='^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}(-[0-9]+)?$'
  case "$1" in *$'\n'*) return 1 ;; esac
  [[ "$1" =~ $re ]]
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

# The baseline of the other containers (name, start time, restart count) belongs to ONE boot of the
# host. After a reboot every container has a new start time, and a baseline taken before it would
# read all of them as restarted: a guard allowed to act on the neighbour rule would then stop the
# node a few seconds after every boot. So the baseline carries the boot id it was taken in, and a
# different boot id (or a host that has only just booted and whose containers are still coming up)
# means "record it again", never "breach".
#
# nb_guard_baseline_render BOOT_ID < neighbour state lines  -> the baseline file text
nb_guard_baseline_render() { # boot_id
  printf '#boot_id\t%s\n' "$1"
  cut -f1-3
}

# The boot id a baseline was taken in; empty when it has none (a baseline from before this rule).
nb_guard_baseline_boot_id() { # < baseline text
  awk -F'\t' '$1 == "#boot_id" { print $2; exit }'
}

# What the guard does with its baseline before judging the neighbours. Prints one of:
#   record  take a new baseline now, and judge nothing against the old one
#   stamp   keep the entries and add the current boot id (a baseline from before boot ids; it is
#           taken to belong to this boot, which is true for the one-time upgrade it exists for)
#   keep    judge against the baseline as it is
# An unknown boot id (no /proc) never forces a record; an unknown uptime never counts as "just booted".
nb_decide_baseline_action() { # present(0|1) baseline_boot current_boot uptime_s settle_s
  local present="$1" bboot="$2" cboot="$3" up="$4" settle="$5"
  if [ "$present" != 1 ]; then echo record; return 0; fi
  if [ -n "$cboot" ] && [ -n "$bboot" ] && [ "$bboot" != "$cboot" ]; then echo record; return 0; fi
  if [ -n "$cboot" ] && [ -z "$bboot" ]; then echo stamp; return 0; fi
  if [ -n "$up" ] && [ "$up" -lt "$settle" ]; then echo record; return 0; fi
  echo keep
}

# Neighbour rule. BASELINE_FILE and stdin hold lines "name<TAB>started_at<TAB>restart_count" and
# "name<TAB>started_at<TAB>restart_count<TAB>health<TAB>state". Prints a ;-separated list such as
# "svc-a(restarted);svc-b(gone)", or nothing. A container the baseline has never seen is new, not
# restarted, and is ignored.
nb_guard_neighbor_breaches() { # baseline_file < current lines
  local baseline="$1" now n s r h bad=""
  now="$(cat)"
  # Lines starting with # are the baseline's header (its boot id), not containers.
  while IFS=$'\t' read -r n s r h _; do
    [ -n "$n" ] || continue
    grep -v '^#' "$baseline" | cut -f1 | grep -qxF "$n" || continue
    grep -qxF "$(printf '%s\t%s\t%s' "$n" "$s" "$r")" <(grep -v '^#' "$baseline" | cut -f1-3) || bad="$bad $n(restarted)"
    [ "$h" != unhealthy ] || bad="$bad $n(unhealthy)"
  done <<<"$now"
  while IFS=$'\t' read -r n _; do
    [ -n "$n" ] || continue
    case "$n" in '#'*) continue ;; esac
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

# Prints a problem when the guard's heartbeat is older than MAX_AGE seconds (a guard that was running
# and has gone quiet is itself a finding), or is missing while a guard is EXPECTED (a guard that
# never started is the same finding). EXPECTED is NB_GUARD_EXPECTED: 1 unless the operator has said
# in .env that this node runs without one.
nb_guard_heartbeat_problem() { # heartbeat_epoch now max_age expected(0|1)
  if [ -z "$1" ]; then
    if [ "${4:-0}" = 1 ]; then echo "the resource guard has never started (no heartbeat)"; fi
    return 0
  fi
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

# ---------------------------------------------------------------------------------------------
# `nb compose` passes the operator's arguments to `docker compose` after the project name, the
# project directory, the env files and the compose files. A global flag in those arguments would
# override one of them and reach another project, so they are refused. Only the arguments BEFORE
# the subcommand are global flags: `logs -f` and `up -p` mean something else after it.
# Prints the offending flag, or nothing when the arguments are fine.
# ---------------------------------------------------------------------------------------------
nb_compose_args_refused() { # args...
  local a
  while [ $# -gt 0 ]; do
    a="$1"
    case "$a" in
      -p | -p* | --project-name | --project-name=* | --project-directory | --project-directory=* \
        | -f | -f* | --file | --file=* | --env-file | --env-file=*)
        printf '%s' "$a"
        return 0
        ;;
      # Global flags that take a separate value: skip the value, it is not the subcommand.
      --profile | --ansi | --progress | --parallel | --context | -H | --host)
        shift
        ;;
      -*) ;;
      *) return 0 ;;
    esac
    shift
  done
  return 0
}

# ---------------------------------------------------------------------------------------------
# The stock validator runs in a throwaway container: no network, a memory limit with no swap, a
# CPU limit, low CPU shares and a high OOM score (the kernel sacrifices it first), a pids limit,
# no new privileges, the caller's own uid, and the candidate mounted read-only. It carries this
# project's compose labels (as a one-off), so `nb down` and the guard treat it as this project's
# and never as another container of the host. One argument per line, so the caller can build an
# array without word splitting.
# ---------------------------------------------------------------------------------------------
nb_validator_args() { # image mem cpus uid_gid input_dir output_dir name
  printf '%s\n' run --rm --name "$7" --network none \
    --memory "$2" --memory-swap "$2" --cpus "$3" --cpu-shares 128 --oom-score-adj 500 --pids-limit 128 \
    --security-opt no-new-privileges:true --user "$4" \
    --label "com.docker.compose.project=$NB_PROJECT" --label com.docker.compose.oneoff=True \
    -e NB_CATALOG_MODE=false -e PYTHONDONTWRITEBYTECODE=1 \
    -v "$5:/input_data:ro" -v "$6:/data" "$1"
}
