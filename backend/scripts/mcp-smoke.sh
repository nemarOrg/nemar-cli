#!/usr/bin/env bash
# MCP server smoke test under real workerd (epic #1065 phase 2, issue #1294),
# derived from the phase 1 spike's smoke.sh (backend/spike/mcp-transport/,
# deleted by this phase). Starts `wrangler dev --local` against
# mcp-smoke-entry.ts / mcp-smoke.wrangler.toml -- a throwaway entry/config
# pair, NOT backend/wrangler-sccn.toml -- because `wrangler dev --local`
# cannot start the real backend/src/index.ts in this environment at all
# (issue #1324: that entry module also exports two plain string constants
# alongside the default handler, and this local workerd runtime rejects any
# named export that isn't a function/ExportedHandler). The throwaway config
# pins the SAME compatibility_date/compatibility_flags as wrangler-sccn.toml
# (see that file's comment) so this run still proves the real config works.
#
# Because the entry IS the mcp sub-app directly (no host fork in front of
# it), every path this script drives -- including `/` -- reaches the real
# mcp sub-app, unlike a prior version of this script that could only reach
# the sub-app through the workers.dev-style `/mcp` path mount and had to
# settle for asserting the (unrelated) API root descriptor at `/` instead.
#
# Local D1 DOES need the migrated schema for two of these checks
# (describe_dataset/search_datasets query the `datasets`/`dataset_versions`
# tables even for a row that doesn't exist -- an unmigrated D1 has no such
# TABLE at all, which surfaces as a D1_ERROR wrapped in isError:true whose
# text never mentions search_datasets, failing the check below for the
# wrong reason). So this script applies every migration to the local D1
# first, via `wrangler d1 execute --local --file`, one file at a time, with
# full-line `--` comments stripped -- the same technique
# scripts/d1-migration-check.ts already uses, and for the same reason:
# `wrangler d1 migrations apply` scans the raw file text for the words
# "BEGIN TRANSACTION"/"COMMIT" and refuses "a file containing several
# transactions" even when those words appear only inside a comment (true
# for migration 0021 and others). No row data is ever inserted -- every
# check below still works against an empty, merely-migrated catalog.
#
# Prints PASS/FAIL per check and exits non-zero if any check fails.
set -u

cd "$(dirname "${BASH_SOURCE[0]}")"

PORT=8799
BASE="http://127.0.0.1:${PORT}"
LOG="$(mktemp -t mcp-smoke-wrangler-dev)"
CONFIG="mcp-smoke.wrangler.toml"
DB_NAME="nemar-mcp-smoke-db"
MIGRATIONS_DIR="../src/db/migrations"
FAILED=0

pass() { echo "PASS: $1"; }
fail() {
  echo "FAIL: $1"
  FAILED=1
}

echo "Wiping this script's local D1 state (fresh migrate every run, like scripts/d1-migration-check.ts)..."
D1_STATE_DIR=".wrangler/state/v3/d1"
if [ -d "${D1_STATE_DIR}" ]; then
  # `find -delete` rather than `rm -rf`: this directory is re-created empty
  # by wrangler on demand, so removing its CONTENTS is equivalent and
  # sidesteps environments that refuse a recursive directory delete
  # outright. Exit status IS checked here -- a failed wipe must not
  # silently leave stale D1 state for the migrations step below to land
  # on top of (a false "already migrated" false negative, or a genuine
  # schema collision), which swallowing this with `|| true` would risk.
  if ! find "${D1_STATE_DIR}" -mindepth 1 -delete; then
    echo "FAIL: could not wipe ${D1_STATE_DIR} (see the error above)"
    exit 1
  fi
else
  echo "${D1_STATE_DIR} does not exist yet (first run); nothing to wipe."
fi

echo "Applying local D1 migrations to ${DB_NAME} (--local; never touches Cloudflare)..."
MIG_TMP=$(mktemp -d)
mig_count=0
for f in $(ls "${MIGRATIONS_DIR}" | grep '\.sql$' | sort); do
  # Drop whole-line `--` comments only; every statement stays byte-identical.
  # See scripts/d1-migration-check.ts's stripFullLineComments for the same
  # technique and its documented invariant (no migration may continue a
  # multi-line string literal on a line starting with `--`).
  sed -E '/^[[:space:]]*--/d' "${MIGRATIONS_DIR}/${f}" >"${MIG_TMP}/${f}"
  if ! bunx wrangler d1 execute "${DB_NAME}" -c "${CONFIG}" --local --file "${MIG_TMP}/${f}" -y >"${MIG_TMP}/last.log" 2>&1; then
    echo "FAIL: migration ${f} did not apply to the local smoke D1:"
    cat "${MIG_TMP}/last.log"
    rm -rf "${MIG_TMP}"
    exit 1
  fi
  mig_count=$((mig_count + 1))
done
rm -rf "${MIG_TMP}"
echo "Applied ${mig_count} migrations."

# WRANGLER_PID is set just below, right before the trap is registered --
# empty here so an EXIT firing before that assignment (a failure in this
# block itself) still runs cleanup() safely: `kill ""`/`pkill -P ""` are
# no-ops under the >/dev/null 2>&1 guards inside cleanup(), not errors that
# abort it.
WRANGLER_PID=
TMPD=$(mktemp -d)

cleanup() {
  # wrangler dev spawns workerd as a child; take it down too, not just the parent.
  pkill -TERM -P "${WRANGLER_PID}" >/dev/null 2>&1
  kill "${WRANGLER_PID}" >/dev/null 2>&1
  wait "${WRANGLER_PID}" 2>/dev/null
  rm -rf "${TMPD}"
}
# Registered BEFORE wrangler is spawned (PR #1323 review item H): if
# anything between here and readiness fails or the script is interrupted,
# cleanup() still runs and tears down whatever wrangler/workerd process is
# currently running, rather than leaving an orphaned --local instance
# holding the port and the D1 state lock.
trap cleanup EXIT

echo "Starting wrangler dev on port ${PORT} (log: ${LOG})..."
WRANGLER_CMD=(bunx wrangler dev -c "${CONFIG}" --local --port "${PORT}")
"${WRANGLER_CMD[@]}" >"${LOG}" 2>&1 &
WRANGLER_PID=$!

# Plain `bunx wrangler` is expected to work here (no `wrangler login` needed
# for --local dev); fall back to cfman only if the log shows a login demand.
sleep 2
if grep -qi "not logged in\|please log in\|authentication" "${LOG}" 2>/dev/null; then
  echo "Plain wrangler asked for a login; retrying via cfman..."
  kill "${WRANGLER_PID}" >/dev/null 2>&1
  wait "${WRANGLER_PID}" 2>/dev/null
  WRANGLER_CMD=(bunx cfman wrangler --account sccn dev -c "${CONFIG}" --local --port "${PORT}")
  "${WRANGLER_CMD[@]}" >"${LOG}" 2>&1 &
  WRANGLER_PID=$!
fi

# post_modern <id> <method> <params-json-without-meta> [extra curl args...]
# Prints the HTTP status; the body lands in ${TMPD}/<id>.json. Times the
# call with curl's own %{time_total} so the PR body can quote per-call
# elapsed_ms without depending on the (absent, locally) ANALYTICS_MCP binding.
TIMES_FILE="${TMPD}/times.txt"
: >"${TIMES_FILE}"
post_modern() {
  local id="$1" method="$2" params="$3"
  shift 3
  local body="{\"jsonrpc\":\"2.0\",\"id\":${id},\"method\":\"${method}\",\"params\":{${params}${MODERN_META}}}"
  local status
  status=$(curl -s -X POST "${BASE}/mcp" \
    -H "Content-Type: application/json" -H "Mcp-Method: ${method}" "$@" \
    -o "${TMPD}/${id}.json" -w "%{http_code} %{time_total}" -d "${body}")
  echo "id=${id} method=${method} status_time=${status}" >>"${TIMES_FILE}"
  echo "${status%% *}"
}

echo "Waiting for readiness..."
READY=0
for _ in $(seq 1 30); do
  if curl -s -o /dev/null "${BASE}/mcp" -X OPTIONS; then
    READY=1
    break
  fi
  sleep 1
done
if [ "${READY}" -ne 1 ]; then
  echo "FAIL: wrangler dev never became ready under compatibility_date=2024-12-01; log:"
  cat "${LOG}"
  echo "COMPATIBILITY DATE VERDICT: 2024-12-01 did NOT start the SDK -- see log above. Not bumped (per instruction); reporting only."
  exit 1
fi
echo "COMPATIBILITY DATE VERDICT: 2024-12-01 (unchanged from wrangler-sccn.toml) started the SDK cleanly under real workerd."

MODERN_META='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}'

# --- GET / : the real mcp descriptor (the entry IS the sub-app now) ---
ROOT_STATUS=$(curl -s -o "${TMPD}/root.json" -w "%{http_code}" "${BASE}/")
ROOT_RESP=$(cat "${TMPD}/root.json")
if [ "${ROOT_STATUS}" = "200" ] && echo "${ROOT_RESP}" | grep -q '"service":"nemar-mcp"' && echo "${ROOT_RESP}" | grep -q "\"endpoint\":\"${BASE}/mcp\""; then
  pass "GET / answers 200 with the real mcp descriptor, endpoint built from the request origin"
else
  fail "GET /: expected 200 + nemar-mcp descriptor with endpoint ${BASE}/mcp, got HTTP ${ROOT_STATUS}: ${ROOT_RESP}"
fi

# --- server/discover ---
DISCOVER_STATUS=$(post_modern 1 "server/discover" "")
DISCOVER_RESP=$(cat "${TMPD}/1.json")
if [ "${DISCOVER_STATUS}" = "200" ] && echo "${DISCOVER_RESP}" | grep -q '"supportedVersions":\["2026-07-28"\]'; then
  pass "server/discover answers 200 with supportedVersions [2026-07-28]"
else
  fail "server/discover: expected 200 + supportedVersions, got HTTP ${DISCOVER_STATUS}: ${DISCOVER_RESP}"
fi

# --- tools/list ---
LIST_STATUS=$(post_modern 2 "tools/list" "")
LIST_RESP=$(cat "${TMPD}/2.json")
if [ "${LIST_STATUS}" = "200" ] \
  && echo "${LIST_RESP}" | grep -q '"search_datasets"' \
  && echo "${LIST_RESP}" | grep -q '"describe_dataset"' \
  && echo "${LIST_RESP}" | grep -q '"list_recordings"' \
  && echo "${LIST_RESP}" | grep -q '"get_events"' \
  && echo "${LIST_RESP}" | grep -q '"render_overview"'; then
  pass "tools/list answers 200 listing all five tools (phase 2+3)"
else
  fail "tools/list: expected 200 + all five tools, got HTTP ${LIST_STATUS}: ${LIST_RESP}"
fi
if echo "${LIST_RESP}" | grep -q '"ttlMs":86400000' && echo "${LIST_RESP}" | grep -q '"cacheScope":"public"'; then
  pass "tools/list carries the 24h public cache hint (ttlMs/cacheScope on the result)"
else
  fail "tools/list: expected ttlMs=86400000/cacheScope=public on the result: ${LIST_RESP}"
fi

# --- tools/call describe_dataset for an id absent from the migrated-but-empty local D1 ---
DESCRIBE_STATUS=$(post_modern 3 "tools/call" '"name":"describe_dataset","arguments":{"dataset_id":"xx000000"},' -H "Mcp-Name: describe_dataset")
DESCRIBE_RESP=$(cat "${TMPD}/3.json")
if [ "${DESCRIBE_STATUS}" = "200" ] && echo "${DESCRIBE_RESP}" | grep -q '"isError":true' && echo "${DESCRIBE_RESP}" | grep -q 'search_datasets'; then
  pass "describe_dataset(xx000000): tool error naming search_datasets"
else
  fail "describe_dataset(xx000000): expected isError naming search_datasets, got HTTP ${DESCRIBE_STATUS}: ${DESCRIBE_RESP}"
fi

# --- tools/call search_datasets, no arguments, over the migrated-but-empty catalog ---
SEARCH_STATUS=$(post_modern 9 "tools/call" '"name":"search_datasets","arguments":{},' -H "Mcp-Name: search_datasets")
SEARCH_RESP=$(cat "${TMPD}/9.json")
if [ "${SEARCH_STATUS}" = "200" ] && echo "${SEARCH_RESP}" | grep -q '"count":0'; then
  pass "search_datasets(): 200 with count 0 over the empty (migrated) catalog"
else
  fail "search_datasets(): expected 200 + count 0, got HTTP ${SEARCH_STATUS}: ${SEARCH_RESP}"
fi

# --- tools/call list_recordings for an id absent from the migrated-but-empty local D1 ---
# (epic #1065 phase 3, issue #1295): the shared catalog-row not-found error,
# the same wording describe_dataset(xx000000) got above.
LIST_RECORDINGS_STATUS=$(post_modern 10 "tools/call" '"name":"list_recordings","arguments":{"dataset_id":"xx000000"},' -H "Mcp-Name: list_recordings")
LIST_RECORDINGS_RESP=$(cat "${TMPD}/10.json")
if [ "${LIST_RECORDINGS_STATUS}" = "200" ] && echo "${LIST_RECORDINGS_RESP}" | grep -q '"isError":true' && echo "${LIST_RECORDINGS_RESP}" | grep -qi 'not found'; then
  pass "list_recordings(xx000000): tool error, not found in the public catalog"
else
  fail "list_recordings(xx000000): expected isError naming 'not found', got HTTP ${LIST_RECORDINGS_STATUS}: ${LIST_RECORDINGS_RESP}"
fi

# --- tools/call describe_dataset with a malformed dataset_id ---
# Verified against the real SDK (not assumed): the registerTool input-schema
# validator answers a normal CallToolResult with isError: true, HTTP 200 --
# NOT a JSON-RPC protocol-level error the way the Mcp-Name mismatch below is.
# This still proves the SDK's JSON Schema validator (zod4 mirrors,
# schemas.ts) runs under workerd without ajv code generation: the workerd
# jsonSchemaValidator export condition (@cfworker/json-schema-backed, per the
# SDK's own ServerOptions.jsonSchemaValidator doc) is what rejects the input.
MALFORMED_STATUS=$(post_modern 4 "tools/call" '"name":"describe_dataset","arguments":{"dataset_id":"not-an-id"},' -H "Mcp-Name: describe_dataset")
MALFORMED_RESP=$(cat "${TMPD}/4.json")
if [ "${MALFORMED_STATUS}" = "200" ] && echo "${MALFORMED_RESP}" | grep -q '"isError":true' && echo "${MALFORMED_RESP}" | grep -qi 'dataset_id'; then
  pass "describe_dataset(not-an-id): input validation rejected under workerd (isError, no ajv code generation)"
else
  fail "describe_dataset(not-an-id): expected isError naming dataset_id, got HTTP ${MALFORMED_STATUS}: ${MALFORMED_RESP}"
fi

# --- legacy 2025-era initialize handshake ---
ACCEPT_HEADER="Accept: application/json, text/event-stream"
INIT_BODY='{"jsonrpc":"2.0","id":5,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-legacy","version":"0.0.0"}}}'
INIT_STATUS=$(curl -s -o "${TMPD}/init.json" -w "%{http_code}" -X POST "${BASE}/mcp" -H "Content-Type: application/json" -H "${ACCEPT_HEADER}" -d "${INIT_BODY}")
INIT_RESP=$(cat "${TMPD}/init.json")
if [ "${INIT_STATUS}" = "200" ] && echo "${INIT_RESP}" | grep -q '"protocolVersion":"2025-06-18"'; then
  pass "legacy initialize handshake answers 200"
else
  fail "legacy initialize: expected 200 + protocolVersion, got HTTP ${INIT_STATUS}: ${INIT_RESP}"
fi

# --- legacy tools/call (no _meta envelope at all) ---
LEGACY_CALL_BODY='{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"search_datasets","arguments":{}}}'
LEGACY_CALL_STATUS=$(curl -s -o "${TMPD}/legacy-call.json" -w "%{http_code}" -X POST "${BASE}/mcp" -H "Content-Type: application/json" -H "${ACCEPT_HEADER}" -d "${LEGACY_CALL_BODY}")
LEGACY_CALL_RESP=$(cat "${TMPD}/legacy-call.json")
if [ "${LEGACY_CALL_STATUS}" = "200" ] && echo "${LEGACY_CALL_RESP}" | grep -q '"count"'; then
  pass "legacy tools/call (search_datasets) answers 200 with no _meta envelope"
else
  fail "legacy tools/call: expected 200 + a count field, got HTTP ${LEGACY_CALL_STATUS}: ${LEGACY_CALL_RESP}"
fi

# --- header mismatch: Mcp-Name disagrees with body params.name -> -32020 ---
MISMATCH_BODY="{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"describe_dataset\",\"arguments\":{\"dataset_id\":\"xx000000\"},${MODERN_META}}}"
MISMATCH_STATUS=$(curl -s -o "${TMPD}/mismatch.json" -w "%{http_code}" -X POST "${BASE}/mcp" \
  -H "Content-Type: application/json" -H "Mcp-Method: tools/call" -H "Mcp-Name: search_datasets" \
  -d "${MISMATCH_BODY}")
MISMATCH_RESP=$(cat "${TMPD}/mismatch.json")
if [ "${MISMATCH_STATUS}" = "400" ] && echo "${MISMATCH_RESP}" | grep -q '"code":-32020'; then
  pass "Mcp-Name/body mismatch rejected with HTTP 400 / JSON-RPC -32020"
else
  fail "Mcp-Name mismatch: expected 400/-32020, got HTTP ${MISMATCH_STATUS}: ${MISMATCH_RESP}"
fi

# --- GET/DELETE on /mcp: 405 (SDK's own dual-era legacy:'stateless' posture) ---
GET_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/mcp")
DELETE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "${BASE}/mcp")
if [ "${GET_STATUS}" = "405" ]; then
  pass "GET /mcp answers 405"
else
  fail "GET /mcp: expected 405, got ${GET_STATUS}"
fi
if [ "${DELETE_STATUS}" = "405" ]; then
  pass "DELETE /mcp answers 405"
else
  fail "DELETE /mcp: expected 405, got ${DELETE_STATUS}"
fi

# --- OPTIONS /mcp: 204 with the MCP-specific CORS headers ---
OPTIONS_HEADERS=$(curl -s -D - -o /dev/null -X OPTIONS "${BASE}/mcp" -H "Origin: https://nemar.org")
if echo "${OPTIONS_HEADERS}" | grep -qi "204" && echo "${OPTIONS_HEADERS}" | grep -qi "Mcp-Method"; then
  pass "OPTIONS /mcp is 204 with the Mcp-* headers allowed"
else
  fail "OPTIONS /mcp: expected 204 with Mcp-* headers: ${OPTIONS_HEADERS}"
fi

# --- Origin gate: disallowed Origin on the actual POST -> 403 / -32000 ---
EVIL_STATUS=$(curl -s -o "${TMPD}/evil.json" -w "%{http_code}" -X POST "${BASE}/mcp" \
  -H "Content-Type: application/json" -H "Mcp-Method: server/discover" -H "Origin: https://evil.example" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"server/discover\",\"params\":{${MODERN_META}}}")
EVIL_RESP=$(cat "${TMPD}/evil.json")
if [ "${EVIL_STATUS}" = "403" ] && echo "${EVIL_RESP}" | grep -q '"code":-32000'; then
  pass "a disallowed Origin on POST /mcp is rejected 403 / -32000"
else
  fail "disallowed Origin: expected 403/-32000, got HTTP ${EVIL_STATUS}: ${EVIL_RESP}"
fi

echo ""
echo "Per-call status/time_total (id method status_time):"
cat "${TIMES_FILE}"

if [ "${FAILED}" -eq 0 ]; then
  echo "ALL REQUIRED CHECKS PASSED"
  exit 0
else
  echo "ONE OR MORE CHECKS FAILED"
  exit 1
fi
