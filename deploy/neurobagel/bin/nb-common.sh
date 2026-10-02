# shellcheck shell=bash
# shellcheck disable=SC2034  # variables here are consumed by the scripts that source this file
#
# Shared helpers for the NEMAR Neurobagel node scripts (epic #1586, Phase 3, #1589).
#
# Sourced, never executed. The sourcing script sets `set -euo pipefail` itself. Written for bash
# 3.2 and later (no associative arrays, no mapfile) so the loader tests also run on a Mac.
#
# Two directories, deliberately separate:
#   NB_CODE_DIR  where these scripts, pins.env and docker-compose.nemar.yml live (this checkout)
#   NB_HOME      where the deployment keeps its state: .env, secrets/, recipes/, data/, state/,
#                backups/, logs/. On the host both are the same directory; tests point NB_HOME at
#                a scratch directory so a test run can never touch a real deployment.
#
# The decisions the scripts make (rollback target, memory abort, hold, guard breaches, whether the
# node serves what it should, status verdicts) are pure functions in nb-decide.sh, so they can be
# tested against real captured text without Docker.

# errexit reaches into command substitutions on bash >= 4.4 with this; older bash ignores it.
shopt -s inherit_errexit 2>/dev/null || true

NB_CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
NB_HOME="${NB_HOME:-$NB_CODE_DIR}"
NB_PROJECT="nemar-neurobagel"

NB_DATA_DIR="$NB_HOME/data"
NB_RELEASES_DIR="$NB_DATA_DIR/releases"
NB_MANIFESTS_DIR="$NB_DATA_DIR/manifests"
NB_CURRENT_LINK="$NB_DATA_DIR/current"
NB_STATE_DIR="$NB_HOME/state"
NB_BACKUPS_DIR="$NB_HOME/backups"
NB_LOGS_DIR="$NB_HOME/logs"
NB_SECRETS_DIR="$NB_HOME/secrets"
NB_RECIPES_DIR="$NB_HOME/recipes"
NB_ENV_FILE="$NB_HOME/.env"
NB_PINS_FILE="$NB_CODE_DIR/pins.env"
NB_OVERLAY_FILE="$NB_CODE_DIR/docker-compose.nemar.yml"
NB_SCHEMA_FILE="$NB_CODE_DIR/index.schema.json"

# Exit codes shared by every script (sysexits-style where one exists).
NB_EX_USAGE=2
NB_EX_SOURCE=3        # the artifact source could not be read or returned something invalid
NB_EX_VALIDATE=4      # the candidate release failed validation; nothing was changed
NB_EX_RELOAD=5        # the reload failed and the previous release was restored
NB_EX_ROLLBACK=6      # the reload failed AND restoring the previous release failed
NB_EX_HOLD=7          # the node is on hold (incident mode); nothing was reloaded
NB_EX_PREFLIGHT=8     # a pre-flight check refused the operation (memory, docker, install)
NB_EX_BUSY=75         # another loader or reload holds the lock (EX_TEMPFAIL)
NB_EX_CONFIG=78       # configuration problem (EX_CONFIG)

nb_ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
nb_epoch() { date -u +%s; }
nb_log() { printf '%s %s\n' "$(nb_ts)" "$*" >&2; }
nb_die() {
  local code="$1"
  shift
  nb_log "ERROR: $*"
  exit "$code"
}

# Print the comment block that follows the shebang, without the comment marks.
nb_usage() { # script
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$1"
}

nb_need() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || nb_die "$NB_EX_PREFLIGHT" "required command not found: $c"
  done
}

# ---------------------------------------------------------------------------------------------
# .env access without ever executing it. Precedence: process environment, then .env (last
# assignment wins), then the supplied default. Values are taken literally.
# ---------------------------------------------------------------------------------------------
nb_env_get() {
  local key="$1" default="${2-}" val
  if [ -n "${!key-}" ]; then
    printf '%s' "${!key}"
    return 0
  fi
  if [ -f "$NB_ENV_FILE" ]; then
    val="$(grep -E "^${key}=" "$NB_ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '\r' || true)"
    if [ -n "$val" ]; then
      printf '%s' "$val"
      return 0
    fi
  fi
  printf '%s' "$default"
}

nb_pin_get() {
  grep -E "^${1}=" "$NB_PINS_FILE" | tail -n 1 | cut -d= -f2- | tr -d '\r'
}

# ---------------------------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------------------------
nb_sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  else
    shasum -a 256 | cut -d' ' -f1
  fi
}
nb_sha256() { nb_sha256_stdin <"$1"; }

# Replace DEST (a symlink or file) with TARGET in one rename(2). `mv` and `ln -sfn` are not used
# for symlink swaps: mv follows a symlink-to-directory destination and ln unlinks before it
# links. perl is part of every Debian and macOS base system.
nb_atomic_symlink() {
  local target="$1" link="$2" tmp
  tmp="${link}.tmp.$$"
  rm -f "$tmp"
  ln -s "$target" "$tmp"
  perl -e 'rename($ARGV[0], $ARGV[1]) or die "rename failed: $!\n"' "$tmp" "$link" || {
    rm -f "$tmp"
    return 1
  }
}

# Read stdin into DEST by writing a sibling temp file and renaming it over DEST.
# An empty result is never installed: every state file this deployment writes has content, so an
# empty one means the producer failed, and replacing a good file with nothing is the worst outcome.
nb_write_atomic() {
  local dest="$1" tmp
  tmp="${dest}.tmp.$$"
  cat >"$tmp"
  if [ ! -s "$tmp" ]; then
    rm -f "$tmp"
    nb_log "refusing to install an empty $(basename "$dest")"
    return 1
  fi
  mv -f "$tmp" "$dest"
}

nb_init_dirs() {
  mkdir -p "$NB_RELEASES_DIR" "$NB_MANIFESTS_DIR" "$NB_STATE_DIR" "$NB_LOGS_DIR"
  chmod 700 "$NB_STATE_DIR" 2>/dev/null || true
}

# Name of the release directory the `current` symlink points at, or empty.
nb_current_release() {
  local t
  if [ -L "$NB_CURRENT_LINK" ]; then
    t="$(readlink "$NB_CURRENT_LINK")"
    basename "$t"
  fi
}

# ---------------------------------------------------------------------------------------------
# Lock. An flock(2) on state/lock, held on file descriptor 9 for the life of the process. The
# kernel drops it when the process dies, however it dies, so there is no stale lock to detect and
# no process id to be reused after a reboot. (perl is the portable way to call flock from bash:
# the flock command is not on a Mac, and perl is in every Debian and macOS base system.)
#
# state/lock.info says who holds it, for humans: "<pid> <what> <time>". It is informative only.
# Callers acquire once. A child script started by a holder inherits the lock through
# NB_LOCK_HELD=<holder pid>, honoured only while that process is alive and named in lock.info.
# ---------------------------------------------------------------------------------------------
NB_LOCK_FILE="$NB_STATE_DIR/lock"
NB_LOCK_INFO="$NB_STATE_DIR/lock.info"
NB_LOCK_OWNED=0

nb_lock_acquire() {
  local what="${1:-$(basename "$0")}"
  mkdir -p "$NB_STATE_DIR"
  if [ -n "${NB_LOCK_HELD:-}" ] && [ -f "$NB_LOCK_INFO" ] \
    && [ "$(cut -d' ' -f1 "$NB_LOCK_INFO" 2>/dev/null)" = "$NB_LOCK_HELD" ] && kill -0 "$NB_LOCK_HELD" 2>/dev/null; then
    return 0
  fi
  { exec 9>>"$NB_LOCK_FILE"; } 2>/dev/null || return 1
  # LOCK_EX | LOCK_NB. The lock belongs to the open file description, which bash keeps on fd 9
  # after this short perl process has exited.
  if ! perl -e 'open(my $f, ">&=", 9) or exit 2; flock($f, 6) or exit 1' 2>/dev/null; then
    exec 9>&-
    return 1
  fi
  printf '%s %s %s\n' "$$" "$what" "$(nb_ts)" >"$NB_LOCK_INFO"
  NB_LOCK_OWNED=1
  export NB_LOCK_HELD="$$"
  trap 'nb_lock_release' EXIT
  return 0
}

nb_lock_release() {
  if [ "$NB_LOCK_OWNED" = 1 ]; then
    rm -f "$NB_LOCK_INFO"
    exec 9>&-
  fi
  NB_LOCK_OWNED=0
}

nb_lock_describe() {
  if [ -f "$NB_LOCK_INFO" ]; then
    awk '{printf "pid %s, %s since %s", $1, $2, $3}' "$NB_LOCK_INFO"
  else
    printf 'holder unknown'
  fi
}

# The usual start of a script that must not overlap another: take the lock or leave with 75.
nb_lock_or_exit() { # what
  if ! nb_lock_acquire "$1"; then
    nb_log "another loader or reload is running ($(nb_lock_describe)); exiting"
    exit "$NB_EX_BUSY"
  fi
}

# ---------------------------------------------------------------------------------------------
# Docker Compose wrapper. Every call names the project, so nothing here can ever act on another
# compose project. The project directory is the recipes checkout because the recipes compose file
# uses paths relative to itself (./scripts, ./vocab, ./init_data).
# ---------------------------------------------------------------------------------------------
nb_compose() {
  docker compose \
    --project-name "$NB_PROJECT" \
    --project-directory "$NB_RECIPES_DIR" \
    --env-file "$NB_PINS_FILE" \
    --env-file "$NB_ENV_FILE" \
    -f "$NB_RECIPES_DIR/docker-compose.yml" \
    -f "$NB_OVERLAY_FILE" \
    "$@"
}

nb_check_project_name() {
  local configured
  configured="$(nb_env_get COMPOSE_PROJECT_NAME "$NB_PROJECT")"
  [ "$configured" = "$NB_PROJECT" ] \
    || nb_die "$NB_EX_CONFIG" "COMPOSE_PROJECT_NAME is '$configured' in .env; it must be '$NB_PROJECT'"
}

# ---------------------------------------------------------------------------------------------
# Host facts (Linux). MemAvailable is what the guardrails are written against.
# ---------------------------------------------------------------------------------------------
nb_mem_available_mb() {
  if [ -r /proc/meminfo ]; then
    awk '/^MemAvailable:/ {printf "%d", $2/1024}' /proc/meminfo
  fi
}

# Which boot of the host this is, and how long ago it began. Empty where /proc does not say (a Mac).
nb_boot_id() {
  if [ -r /proc/sys/kernel/random/boot_id ]; then
    tr -d '\n' </proc/sys/kernel/random/boot_id
  fi
}

nb_uptime_s() {
  if [ -r /proc/uptime ]; then
    awk '{printf "%d", $1}' /proc/uptime
  fi
}

nb_load1() {
  if [ -r /proc/loadavg ]; then
    cut -d' ' -f1 /proc/loadavg
  fi
}

# ---------------------------------------------------------------------------------------------
# Loader state files
# ---------------------------------------------------------------------------------------------
nb_hold_active() { [ -f "$NB_STATE_DIR/hold" ]; }

# ---------------------------------------------------------------------------------------------
# Containers of this project
# ---------------------------------------------------------------------------------------------
# -a: a stopped container (a node on hold has its API stopped) is still this service's container.
nb_container_id() { nb_compose ps -aq "$1" 2>/dev/null | head -n 1; }

nb_container_running() {
  local id
  id="$(nb_container_id "$1")"
  [ -n "$id" ] && [ "$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null)" = true ]
}

# ---------------------------------------------------------------------------------------------
# POST JSON to the node API and print the body. GraphDB refuses any group-by or distinct query
# while it has less than 250 MB of free heap (its default.min.distinct.threshold), and a freshly
# loaded 50,000-subject graph on a 1.5 GiB heap sits near that line until the next collection
# (measured 2026-10-01: HTTP 500 from the node, then success seconds later). One refusal is not a
# verdict, so the query is retried a few times before it counts as a failure.
# ---------------------------------------------------------------------------------------------
nb_post_json() { # url body
  local url="$1" body="$2" tries i=1 out
  tries="$(nb_env_get NB_VERIFY_RETRIES 6)"
  while true; do
    if out="$(curl -fsS --max-time 300 -X POST -H 'Content-Type: application/json' -d "$body" "$url" 2>/dev/null)"; then
      printf '%s' "$out"
      return 0
    fi
    [ "$i" -lt "$tries" ] || return 1
    i=$((i + 1))
    sleep "$(nb_env_get NB_VERIFY_RETRY_PAUSE_S 10)"
  done
}

# ---------------------------------------------------------------------------------------------
# The node must serve exactly the datasets of a release, and only protected records. This asks the
# running node; the judgement itself is nb_verify_judge in nb-decide.sh. Sets NB_VERIFY_REASON,
# NB_VERIFY_EXPECTED and NB_VERIFY_SERVED. The empty datasets query is the heaviest dataset-level
# query a user can send, which is the point.
# ---------------------------------------------------------------------------------------------
nb_verify_node() { # release
  local release="$1" port datasets subjects first
  port="$(nb_env_get NB_NAPI_PORT_HOST 18000)"
  NB_VERIFY_REASON=""
  NB_VERIFY_EXPECTED=0
  NB_VERIFY_SERVED=0
  if ! datasets="$(nb_post_json "http://127.0.0.1:${port}/datasets" '{}')"; then
    NB_VERIFY_REASON="the node API did not answer a datasets query"
    return 1
  fi
  # One dataset is enough for the subject check: record protection is a node-wide setting, and the
  # unrestricted subjects query at the planned scale is heavy enough for GraphDB to refuse it for
  # lack of free heap (measured with a 1 GiB heap and 50,105 subjects).
  first="$(printf '%s' "$datasets" | jq -r '.[0].dataset_uuid // empty' 2>/dev/null || true)"
  subjects="[]"
  if [ -n "$first" ]; then
    if ! subjects="$(nb_post_json "http://127.0.0.1:${port}/subjects" "$(jq -cn --arg u "$first" '{dataset_uuids: [$u]}')")"; then
      NB_VERIFY_REASON="the node API did not answer a subjects query"
      return 1
    fi
  fi
  nb_verify_judge "$NB_RELEASES_DIR/$release" "$datasets" "$subjects"
}

# Keep a cron-redirected log from growing without bound: rename it once it passes MAXBYTES. The
# redirect that is already open keeps writing to the renamed file for this run; the next run opens
# a fresh one.
nb_rotate_log() { # file [maxbytes]
  local f="$1" max="${2:-2097152}"
  if [ -f "$f" ] && [ "$(wc -c <"$f" | tr -d ' ')" -gt "$max" ]; then
    mv -f "$f" "$f.1"
  fi
}

# What a failed reload leaves behind so the scheduled loader does not retry the same content in a
# loop: the release, the reason, and the content id from that release's manifest.
nb_record_reload_failure() { # release reason
  local release="$1" reason="$2"
  [ -f "$NB_MANIFESTS_DIR/$release.json" ] || return 0
  jq -n --arg at "$(nb_ts)" --argjson epoch "$(nb_epoch)" --arg release "$release" --arg reason "$reason" \
    --slurpfile m "$NB_MANIFESTS_DIR/$release.json" \
    '{at:$at, epoch:$epoch, release:$release, reason:$reason, content_id:$m[0].content_id}' \
    | nb_write_atomic "$NB_STATE_DIR/reload-failed"
}

# shellcheck source=nb-decide.sh
. "$NB_CODE_DIR/bin/nb-decide.sh"
