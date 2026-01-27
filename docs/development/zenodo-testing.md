# Zenodo Sandbox Testing

This guide explains how to test DOI creation workflows using the Zenodo sandbox environment.

## Table of Contents

- [What is Zenodo Sandbox?](#what-is-zenodo-sandbox)
- [When to Use Sandbox](#when-to-use-sandbox)
- [Setup](#setup)
- [Running Tests](#running-tests)
- [CLI Sandbox Mode](#cli-sandbox-mode)
- [Test Data Management](#test-data-management)
- [Test Coverage](#test-coverage)
- [Rate Limits](#rate-limits)
- [Troubleshooting](#troubleshooting)
- [Webhook Testing](#webhook-testing)
- [References](#references)

## What is Zenodo Sandbox?

Zenodo provides a **sandbox environment** (`sandbox.zenodo.org`) separate from production for testing DOI workflows. Key characteristics:

- **Separate infrastructure**: Completely isolated from production Zenodo
- **Test DOIs**: DOIs are created in sandbox registry (not indexed by DataCite)
- **No production impact**: Actions in sandbox never affect production
- **DOIs are permanent**: Once published, even sandbox DOIs cannot be deleted
- **Same API**: Identical API to production, different base URL

**Important**: Sandbox DOIs do NOT resolve via `doi.org` because they are not registered with DataCite. Use Zenodo's sandbox URL directly.

## When to Use Sandbox

Use the sandbox for:

- ✅ Testing DOI creation workflows
- ✅ Developing new DOI-related features
- ✅ Running automated tests in CI/CD
- ✅ Learning Zenodo API without production side effects
- ✅ Verifying metadata formatting before production

Do NOT use sandbox for:

- ❌ Real dataset publication (DOIs won't resolve)
- ❌ Testing DataCite integration (sandbox doesn't register with DataCite)
- ❌ Permanent archival (sandbox may be reset periodically)

## Setup

### 1. Get Sandbox API Token

1. Go to [sandbox.zenodo.org](https://sandbox.zenodo.org)
2. Create an account (separate from production Zenodo)
3. Navigate to **Account Settings > Applications > Personal access tokens**
4. Create new token with `deposit:write` and `deposit:actions` scopes
5. Save the token securely

### 2. Configure Environment

Create or update `test/.env.test`:

```bash
# Required for Zenodo tests
ZENODO_SANDBOX_API_KEY=your_sandbox_token_here
RUN_ZENODO_TESTS=true
TEST_DATASET_ID=nm099999

# Admin credentials (from backend team)
TEST_ADMIN_API_KEY=your_admin_key
TEST_API_URL=https://nemar-api-dev.shirazi-10f.workers.dev
```

**Security notes:**
- Never commit `.env.test` to git (already in `.gitignore`)
- Never use production Zenodo token for sandbox tests
- Keep sandbox token separate from production token

## Running Tests

### Local Testing

Run Zenodo sandbox tests:

```bash
# All sandbox tests
RUN_ZENODO_TESTS=true TEST_DATASET_ID=nm099999 bun test test/zenodo-sandbox.test.ts

# Specific test suite
RUN_ZENODO_TESTS=true TEST_DATASET_ID=nm099999 bun test test/zenodo-sandbox.test.ts -t "Metadata Updates"
```

**Note**: Tests are skipped by default unless `RUN_ZENODO_TESTS=true` to prevent accidental sandbox usage.

### CI/CD Testing

Tests run automatically on:
- Pull requests that modify `backend/` or `test/` files
- Pushes to `main` or `dev` branches

CI workflow uses GitHub Secrets:
- `ZENODO_SANDBOX_API_KEY`: Sandbox API token (admin must configure)
- `TEST_ADMIN_API_KEY`: Backend admin credentials

View test results:
```bash
gh run list --workflow=test.yml --limit 5
gh run view --log
```

## CLI Sandbox Mode

The CLI supports sandbox mode for testing DOI creation without affecting production:

### Create Sandbox Concept DOI

```bash
nemar admin doi create nm099999 \
  --sandbox \
  --title "Test Dataset" \
  --description "Testing DOI workflow"
```

**CLI will display:**
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                 SANDBOX MODE ENABLED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  • Using Zenodo sandbox (sandbox.zenodo.org)
  • DOI will NOT be indexed by DataCite
  • DOI will NOT resolve in production
  • Use this for testing workflows only
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### View Sandbox DOI Info

```bash
nemar admin doi info nm099999
```

Sandbox DOIs are detected and labeled:
```
Mode: SANDBOX (test DOI)
  This DOI is not indexed by DataCite and will not resolve in production
```

## Test Data Management

### Disposable Test Dataset

Tests use **nm099999** as the standard test dataset:
- Already registered in D1 database
- Already has GitHub repository
- Designated for testing purposes
- Data can be safely modified/deleted

### Deposition Cleanup

Test suite automatically cleans up unpublished depositions after tests complete:

```typescript
afterAll(async () => {
  // Deletes all unpublished depositions created during tests
  // Published depositions are permanent and cannot be deleted
});
```

**Important**: Published sandbox DOIs are permanent and accumulate over time. This is by design (Zenodo does not allow DOI deletion).

### Avoiding Data Pollution

- Use timestamped titles: `Test Dataset ${Date.now()}`
- Limit published depositions (most tests use drafts only)
- Track created depositions in `createdDepositions` array
- Delete unpublished drafts in cleanup

## Test Coverage

The test suite covers 7 major areas:

### 1. Concept DOI Creation (Sandbox)
- ✓ Create concept DOI on sandbox
- ✓ Retrieve DOI info
- ✓ Block production DOI in dev environment

### 2. Version DOI Publishing (Sandbox)
- ✓ Webhook token validation
- ✓ Sandbox flag enforcement

### 3. Metadata Updates (Sandbox)
- ✓ Update title and description
- ✓ Update keywords and license
- ✓ Add related identifiers

### 4. Error Handling (Sandbox)
- ✓ Invalid API token (401)
- ✓ Invalid deposition ID (404)
- ✓ Publishing already-published (400)
- ✓ Missing required metadata (400)

### 5. Rate Limiting (Sandbox)
- ✓ Respect rate limits with delays
- ✓ Handle 429 responses gracefully

### 6. Deposition Lifecycle (Sandbox)
- ✓ Create → upload → publish workflow
- ✓ Create → update metadata → publish
- ✓ Create new version from published
- ✓ Delete unpublished drafts

### 7. File Upload (Sandbox)
- ✓ Upload single file
- ✓ Upload multiple files
- ✓ Verify file checksums
- ✓ Handle large file upload (1MB)

## Rate Limits

Zenodo enforces rate limits to protect the service:

### Limits
- **Sandbox**: 60 requests per minute minimum (1 request per second)
- **Production**: 100 requests per minute (authenticated)

### Best Practices
- **Minimum delay**: 1000ms (60 req/min = 1 req/sec)
- **Recommended delay**: 400-500ms provides safety margin (120-150 req/min max)
- Use exponential backoff for retries
- Respect 429 (Too Many Requests) responses

**Why 400ms instead of 1000ms?** The test suite uses 400ms delays to provide a safety buffer. While the documented limit is 60 req/min (1000ms), using 400ms allows ~150 req/min maximum, which accounts for:
- Request processing time variations
- Network latency
- Other concurrent API calls
- Potential rate limit enforcement variations

### Test Implementation
```typescript
// Using 400ms delays (safety margin above 60 req/min minimum)
await sleep(400);

// Rate limit handling with exponential backoff
if (response.status === 429) {
  const retryAfter = response.headers.get("Retry-After");
  await sleep(Number.parseInt(retryAfter || "60") * 1000);
  // Retry request
}
```

## Troubleshooting

### Tests Skipped

**Problem**: Tests show "Skipping: RUN_ZENODO_TESTS not set"

**Solution**: Set environment variable:
```bash
RUN_ZENODO_TESTS=true bun test test/zenodo-sandbox.test.ts
```

### Token Not Configured

**Problem**: Tests skip with "ZENODO_SANDBOX_API_KEY not set"

**Solution**: Add token to `test/.env.test`:
```bash
ZENODO_SANDBOX_API_KEY=your_sandbox_token
```

### Production Token Detected

**Problem**: Error "DANGER: Test configured with production token!"

**Solution**: Ensure `ZENODO_SANDBOX_API_KEY` is different from `ZENODO_API_KEY`:
```bash
# test/.env.test
ZENODO_SANDBOX_API_KEY=sandbox_token_here  # ✓ Correct

# Do NOT do this:
# ZENODO_SANDBOX_API_KEY=$ZENODO_API_KEY   # ✗ Wrong
```

### 401 Unauthorized

**Problem**: Tests fail with 401 status

**Causes**:
- Invalid or expired sandbox token
- Token doesn't have required scopes

**Solution**:
1. Verify token on sandbox.zenodo.org
2. Check token has `deposit:write` and `deposit:actions` scopes
3. Generate new token if expired

### 404 Not Found

**Problem**: Dataset nm099999 not found

**Solution**: Ensure test dataset is registered:
```bash
# Contact admin to verify nm099999 exists in dev database
# Or use different test dataset ID
TEST_DATASET_ID=nm000XXX bun test test/zenodo-sandbox.test.ts
```

### 429 Rate Limited

**Problem**: Tests fail with "Too Many Requests"

**Solution**: Increase delays between requests:
```typescript
await sleep(500); // Increase from 300ms to 500ms
```

### CI Tests Failing

**Problem**: Tests pass locally but fail in CI

**Causes**:
- GitHub secret not configured
- Wrong environment URL

**Solution**:
1. Verify `ZENODO_SANDBOX_API_KEY` exists in GitHub Secrets
2. Check workflow uses correct API URL (dev, not prod)

## Webhook Testing

Webhook endpoint tests verify GitHub Actions can trigger version DOI creation:

### Webhook Flow
1. User creates GitHub release
2. GitHub Actions workflow triggers
3. Workflow calls webhook: `/webhooks/publish-version-doi`
4. Backend creates new version DOI on Zenodo
5. Backend updates dataset metadata in D1

### Test Coverage
- ✓ Invalid webhook token rejected (401)
- ✓ Sandbox flag required for test datasets

### Manual Testing
```bash
curl -X POST https://nemar-api-dev.shirazi-10f.workers.dev/webhooks/publish-version-doi \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: test_token" \
  -d '{
    "dataset_id": "nm099999",
    "version": "1.0.0",
    "release_url": "https://github.com/nemarDatasets/nm099999/releases/tag/v1.0.0",
    "sandbox": true
  }'
```

## References

- [Zenodo Sandbox](https://sandbox.zenodo.org)
- [Zenodo API Documentation](https://developers.zenodo.org)
- [Zenodo REST API](https://developers.zenodo.org/#rest-api)
- [DataCite DOI Registration](https://datacite.org)
- [NEMAR Backend API](../backend/README.md)

## Related Documentation

- [DOI Management](../user-guide/doi-management.md)
- [Dataset Publication](../user-guide/publication.md)
- [CI/CD Setup](../../.github/workflows/README.md)
