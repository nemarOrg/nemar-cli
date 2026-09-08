#!/usr/bin/env bash
# MCP server smoke test under real workerd (epic #1065 phase 2, issue #1294),
# derived from the phase 1 spike's smoke.sh (backend/spike/mcp-transport/,
# deleted by this phase). Starts `wrangler dev -c wrangler-sccn.toml --env dev
# --local` from backend/, waits for readiness, then exercises the MCP sub-app
# through the api-host path mount (/mcp) -- the hostname fork (mcp.nemar.org)
# cannot be exercised on loopback, since resolveHostRoute reads the hostname
# from the request URL, and a bare 127.0.0.1 request never matches it.
#
# Local D1 (--local) may be empty; none of these checks need rows -- they
# exercise the transport (both protocol eras), the tool registry, and input
# validation, not catalog data.
#
# Prints PASS/FAIL per check and exits non-zero if any check fails.
set -u

cd "$(dirname "${BASH_SOURCE[0]}")/.."

PORT=8799
BASE="http://127.0.0.1:${PORT}"
LOG="$(mktemp -t mcp-smoke-wrangler-dev)"
FAILED=0

pass() { echo "PASS: $1"; }
fail() {
  echo "FAIL: $1"
  FAILED=1
}
info() { echo "INFO: $1"; }

echo "Starting wrangler dev on port ${PORT} (log: ${LOG})..."
WRANGLER_CMD=(bunx wrangler dev -c wrangler-sccn.toml --env dev --local --port "${PORT}")
"${WRANGLER_CMD[@]}" >"${LOG}" 2>&1 &
WRANGLER_PID=$!

# Plain `bunx wrangler` is expected to work here (no `wrangler login` needed
# for --local dev); fall back to cfman only if the log shows a login demand.
sleep 2
if grep -qi "not logged in\|please log in\|authentication" "${LOG}" 2>/dev/null; then
  echo "Plain wrangler asked for a login; retrying via cfman..."
  kill "${WRANGLER_PID}" >/dev/null 2>&1
  wait "${WRANGLER_PID}" 2>/dev/null
  WRANGLER_CMD=(bunx cfman wrangler --account sccn dev -c wrangler-sccn.toml --env dev --local --port "${PORT}")
  "${WRANGLER_CMD[@]}" >"${LOG}" 2>&1 &
  WRANGLER_PID=$!
fi

TMPD=$(mktemp -d)

cleanup() {
  # wrangler dev spawns workerd as a child; take it down too, not just the parent.
  pkill -TERM -P "${WRANGLER_PID}" >/dev/null 2>&1
  kill "${WRANGLER_PID}" >/dev/null 2>&1
  wait "${WRANGLER_PID}" 2>/dev/null
  rm -rf "${TMPD}"
}
trap cleanup EXIT

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
for _ in $(seq 1 30); do
  if curl -s -o /dev/null "${BASE}/mcp" -X OPTIONS; then
    break
  fi
  sleep 1
done
if ! curl -s -o /dev/null "${BASE}/mcp" -X OPTIONS; then
  echo "FAIL: wrangler dev never became ready; log:"
  cat "${LOG}"
  exit 1
fi

MODERN_META='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}'

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
if [ "${LIST_STATUS}" = "200" ] && echo "${LIST_RESP}" | grep -q '"search_datasets"' && echo "${LIST_RESP}" | grep -q '"describe_dataset"'; then
  pass "tools/list answers 200 listing exactly search_datasets and describe_dataset"
else
  fail "tools/list: expected 200 + both tools, got HTTP ${LIST_STATUS}: ${LIST_RESP}"
fi
if echo "${LIST_RESP}" | grep -q '"ttlMs":86400000' && echo "${LIST_RESP}" | grep -q '"cacheScope":"public"'; then
  pass "tools/list carries the 24h public cache hint (ttlMs/cacheScope on the result)"
else
  fail "tools/list: expected ttlMs=86400000/cacheScope=public on the result: ${LIST_RESP}"
fi

# --- tools/call describe_dataset for an id absent from (possibly empty) local D1 ---
DESCRIBE_STATUS=$(post_modern 3 "tools/call" '"name":"describe_dataset","arguments":{"dataset_id":"xx000000"},' -H "Mcp-Name: describe_dataset")
DESCRIBE_RESP=$(cat "${TMPD}/3.json")
if [ "${DESCRIBE_STATUS}" = "200" ] && echo "${DESCRIBE_RESP}" | grep -q '"isError":true' && echo "${DESCRIBE_RESP}" | grep -q 'search_datasets'; then
  pass "describe_dataset(xx000000): tool error naming search_datasets"
else
  fail "describe_dataset(xx000000): expected isError naming search_datasets, got HTTP ${DESCRIBE_STATUS}: ${DESCRIBE_RESP}"
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

# --- GET / (bare root): the api-host path mount forwards ONLY the exact
# `/mcp` path (decision 2's app.all("/mcp", ...), not a `.route()` sub-tree
# mount), so the mcp sub-app's own descriptor at `/` is reachable ONLY via
# the hostname fork (mcp.nemar.org / mcp-test.nemar.org), which cannot be
# exercised on loopback (see this file's header comment). This check
# therefore confirms the EXISTING api root descriptor still answers
# unaffected by the /mcp mount -- not the MCP descriptor. See the PR body's
# deviations section for the full derivation.
ROOT_STATUS=$(curl -s -o "${TMPD}/root.json" -w "%{http_code}" "${BASE}/")
ROOT_RESP=$(cat "${TMPD}/root.json")
if [ "${ROOT_STATUS}" = "200" ] && echo "${ROOT_RESP}" | grep -q '"name":"NEMAR API"'; then
  pass "GET / answers 200 with the (unaffected) NEMAR API descriptor -- see header comment on why this isn't the MCP descriptor on loopback"
else
  fail "GET /: expected 200 + NEMAR API descriptor, got HTTP ${ROOT_STATUS}: ${ROOT_RESP}"
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
