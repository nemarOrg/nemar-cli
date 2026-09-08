#!/usr/bin/env bash
# Spike smoke test (issue #1293, phase 1 plan step 5). Starts `wrangler dev`
# against this worker, then exercises:
#   - server/discover and tools/list in the 2026-07-28 envelope
#   - tools/call (decode_chunk) in the 2026-07-28 envelope, with the
#     Mcp-Method/Mcp-Name headers the spec makes mandatory
#   - the legacy 2025-era `initialize` handshake, then a legacy tools/call
#   - the -32020 (HeaderMismatch) rejection when Mcp-Name disagrees with the body
#   - GET/DELETE on /mcp answering 405 (modern-only-endpoint behavior)
# Prints PASS/FAIL per check and exits non-zero if any REQUIRED check fails.
# decode_chunk's path (a) (numcodecs WASM blosc) is reported but never fails
# the run: whether it works under workerd is exactly what this spike measures,
# and a documented failure there is a result, not a bug in the smoke test.
set -u

cd "$(dirname "${BASH_SOURCE[0]}")"

PORT=8799
BASE="http://localhost:${PORT}"
LOG="$(mktemp -t mcp-spike-wrangler-dev)"
FAILED=0

pass() { echo "PASS: $1"; }
fail() {
  echo "FAIL: $1"
  FAILED=1
}

echo "Starting wrangler dev on port ${PORT} (log: ${LOG})..."
bunx wrangler dev --port "${PORT}" >"${LOG}" 2>&1 &
WRANGLER_PID=$!

cleanup() {
  kill "${WRANGLER_PID}" >/dev/null 2>&1
  wait "${WRANGLER_PID}" 2>/dev/null
}
trap cleanup EXIT

echo "Waiting for readiness..."
for _ in $(seq 1 30); do
  if curl -s -o /dev/null "${BASE}/"; then
    break
  fi
  sleep 1
done
if ! curl -s -o /dev/null "${BASE}/"; then
  echo "FAIL: wrangler dev never became ready; log:"
  cat "${LOG}"
  exit 1
fi

MODERN_META='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}'

# --- server/discover ---
DISCOVER_BODY="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"server/discover\",\"params\":{${MODERN_META}}}"
DISCOVER_RESP=$(curl -s -X POST "${BASE}/mcp" -H "Content-Type: application/json" \
  -H "Mcp-Method: server/discover" -d "${DISCOVER_BODY}")
if echo "${DISCOVER_RESP}" | grep -q '"supportedVersions":\["2026-07-28"\]'; then
  pass "server/discover reports supportedVersions [2026-07-28]"
else
  fail "server/discover: unexpected response: ${DISCOVER_RESP}"
fi

# --- tools/list ---
LIST_BODY="{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{${MODERN_META}}}"
LIST_RESP=$(curl -s -X POST "${BASE}/mcp" -H "Content-Type: application/json" \
  -H "Mcp-Method: tools/list" -d "${LIST_BODY}")
if echo "${LIST_RESP}" | grep -q '"decode_chunk"' && echo "${LIST_RESP}" | grep -q '"describe_fixture"'; then
  pass "tools/list lists describe_fixture and decode_chunk"
else
  fail "tools/list: unexpected response: ${LIST_RESP}"
fi

# --- tools/call decode_chunk (modern envelope) ---
DECODE_BODY="{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"decode_chunk\",\"arguments\":{},${MODERN_META}}}"
DECODE_RESP=$(curl -s -X POST "${BASE}/mcp" -H "Content-Type: application/json" \
  -H "Mcp-Method: tools/call" -H "Mcp-Name: decode_chunk" -d "${DECODE_BODY}")
if echo "${DECODE_RESP}" | grep -q '"paths_agree":true'; then
  pass "decode_chunk: path (a) and path (b) agree"
elif echo "${DECODE_RESP}" | grep -q '"path_b_pure_js":{"ok":true.*"matches_expected":true'; then
  pass "decode_chunk: path (b) matches the Python ground truth (path (a) did not agree/succeed -- see below)"
else
  fail "decode_chunk: unexpected response: ${DECODE_RESP}"
fi
if echo "${DECODE_RESP}" | grep -q '"path_a_numcodecs_wasm":{"ok":true'; then
  echo "INFO: decode_chunk path (a) (numcodecs WASM) succeeded under workerd"
else
  echo "INFO: decode_chunk path (a) (numcodecs WASM) did NOT succeed under workerd -- response: ${DECODE_RESP}"
fi
if echo "${DECODE_RESP}" | grep -q '"path_b_pure_js":{"ok":true,"error":null.*"matches_expected":true'; then
  pass "decode_chunk path (b) (pure JS) matches chunk.expected.json"
else
  fail "decode_chunk path (b) (pure JS) did not match chunk.expected.json: ${DECODE_RESP}"
fi

# --- legacy 2025-era initialize handshake ---
ACCEPT_HEADER="Accept: application/json, text/event-stream"
INIT_BODY='{"jsonrpc":"2.0","id":4,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-legacy","version":"0.0.0"}}}'
INIT_RESP=$(curl -s -X POST "${BASE}/mcp" -H "Content-Type: application/json" -H "${ACCEPT_HEADER}" -d "${INIT_BODY}")
if echo "${INIT_RESP}" | grep -q '"protocolVersion":"2025-06-18"'; then
  pass "legacy initialize handshake succeeds"
else
  fail "legacy initialize: unexpected response: ${INIT_RESP}"
fi

# --- legacy tools/call (no _meta envelope at all) ---
LEGACY_CALL_BODY='{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"describe_fixture","arguments":{}}}'
LEGACY_CALL_RESP=$(curl -s -X POST "${BASE}/mcp" -H "Content-Type: application/json" -H "${ACCEPT_HEADER}" -d "${LEGACY_CALL_BODY}")
if echo "${LEGACY_CALL_RESP}" | grep -q '"dataset_id":"on008083"'; then
  pass "legacy tools/call (describe_fixture) succeeds with no _meta envelope"
else
  fail "legacy tools/call: unexpected response: ${LEGACY_CALL_RESP}"
fi

# --- header mismatch: Mcp-Name disagrees with body params.name -> -32020 ---
MISMATCH_BODY="{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"decode_chunk\",\"arguments\":{},${MODERN_META}}}"
MISMATCH_STATUS=$(curl -s -o /tmp/mcp-spike-mismatch-body.json -w "%{http_code}" -X POST "${BASE}/mcp" \
  -H "Content-Type: application/json" -H "Mcp-Method: tools/call" -H "Mcp-Name: describe_fixture" \
  -d "${MISMATCH_BODY}")
MISMATCH_RESP=$(cat /tmp/mcp-spike-mismatch-body.json)
if [ "${MISMATCH_STATUS}" = "400" ] && echo "${MISMATCH_RESP}" | grep -q '"code":-32020'; then
  pass "Mcp-Name/body mismatch rejected with HTTP 400 / JSON-RPC -32020"
else
  fail "Mcp-Name mismatch: expected 400/-32020, got HTTP ${MISMATCH_STATUS}: ${MISMATCH_RESP}"
fi

# --- missing Mcp-Method header on an otherwise-modern request -> -32020 ---
NOMETHOD_BODY="{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/list\",\"params\":{${MODERN_META}}}"
NOMETHOD_STATUS=$(curl -s -o /tmp/mcp-spike-nomethod-body.json -w "%{http_code}" -X POST "${BASE}/mcp" \
  -H "Content-Type: application/json" -d "${NOMETHOD_BODY}")
NOMETHOD_RESP=$(cat /tmp/mcp-spike-nomethod-body.json)
if [ "${NOMETHOD_STATUS}" = "400" ] && echo "${NOMETHOD_RESP}" | grep -q '"code":-32020'; then
  pass "missing Mcp-Method header rejected with HTTP 400 / JSON-RPC -32020"
else
  fail "missing Mcp-Method: expected 400/-32020, got HTTP ${NOMETHOD_STATUS}: ${NOMETHOD_RESP}"
fi

# --- GET/DELETE on /mcp: modern-only-endpoint behavior is 405 ---
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

if [ "${FAILED}" -eq 0 ]; then
  echo "ALL REQUIRED CHECKS PASSED"
  exit 0
else
  echo "ONE OR MORE CHECKS FAILED"
  exit 1
fi
