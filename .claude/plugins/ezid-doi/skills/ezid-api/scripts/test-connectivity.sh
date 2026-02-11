#!/bin/bash
# Test EZID API connectivity and basic operations
# Uses the public test account - safe to run anytime

set -e

EZID_URL="https://ezid.cdlib.org"
TEST_USER="apitest"
TEST_PASS="ezidapitest2025!"
TEST_SHOULDER="doi:10.5072/FK2"

echo "=== EZID API Connectivity Test ==="
echo ""

# 1. Server status
echo "1. Checking server status..."
STATUS=$(curl -s "$EZID_URL/status")
echo "   $STATUS"
if [[ "$STATUS" != "success: EZID is up" ]]; then
  echo "   FAILED: Server not responding"
  exit 1
fi

# 2. Authentication
echo "2. Testing authentication..."
AUTH=$(curl -s -u "$TEST_USER:$TEST_PASS" "$EZID_URL/login")
echo "   $AUTH"
if [[ "$AUTH" != *"success"* ]]; then
  echo "   FAILED: Authentication failed"
  exit 1
fi

# 3. Mint a test DOI
echo "3. Minting test DOI..."
MINT_RESULT=$(curl -s -u "$TEST_USER:$TEST_PASS" -X POST \
  -H 'Content-Type: text/plain' \
  --data-binary $'_target: https://nemar.org/test\n_status: reserved\n_profile: datacite\ndatacite.creator: Test, User\ndatacite.title: EZID Connectivity Test\ndatacite.publisher: NEMAR\ndatacite.publicationyear: 2026\ndatacite.resourcetype: Dataset' \
  "$EZID_URL/shoulder/$TEST_SHOULDER")
echo "   $MINT_RESULT"

# Extract the identifier
DOI=$(echo "$MINT_RESULT" | sed 's/success: //' | sed 's/ |.*//')
if [[ -z "$DOI" || "$MINT_RESULT" == *"error"* ]]; then
  echo "   FAILED: Could not mint DOI"
  exit 1
fi

# 4. Retrieve it
echo "4. Retrieving $DOI..."
GET_RESULT=$(curl -s "$EZID_URL/id/$DOI" | head -1)
echo "   $GET_RESULT"

# 5. Delete it (cleanup)
echo "5. Deleting test DOI..."
DEL_RESULT=$(curl -s -u "$TEST_USER:$TEST_PASS" -X DELETE "$EZID_URL/id/$DOI")
echo "   $DEL_RESULT"

echo ""
echo "=== All tests passed ==="
