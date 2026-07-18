/**
 * IAM Removal Validation Tests
 *
 * Validates that the platform works correctly after replacing per-user IAM
 * policies with backend-scoped credentials. Tests hit the live dev backend.
 *
 * These tests use nm099999 (pre-seeded in dev D1) and focus on credential
 * generation and authorization, not dataset creation (which requires real
 * GitHub accounts). Dataset creation is covered by the E2E test.
 *
 * Run with: bun test test/iam-removal.test.ts
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { version as cliVersion } from "../package.json";
import { EXPECTED_S3_BUCKET, TEST_CONFIG, testRequest as baseTestRequest } from "./setup";

const adminKey = TEST_CONFIG.adminApiKey;
const userKey = TEST_CONFIG.userApiKey;

beforeAll(() => {
  if (!adminKey) {
    throw new Error(
      "TEST_ADMIN_API_KEY not configured. Create test/.env.test with the required keys. " +
        "See scripts/seed-dev-db.sql for the expected test users.",
    );
  }
  if (!userKey) {
    throw new Error(
      "TEST_USER_API_KEY not configured. Create test/.env.test with the required keys.",
    );
  }
});

// -- Shared response types -------------------------------------------------

interface StsCredentials {
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
  expiration: string;
}

interface UploadCredentialsResponse {
  credentials: StsCredentials;
  s3: { bucket: string; region: string; prefix: string };
}

interface UploadUrlsResponse {
  upload_urls: Record<string, string>;
}

// -- Helpers ---------------------------------------------------------------

/** Wraps baseTestRequest to include X-CLI-Version header (required by backend). */
async function testRequest<T>(
  path: string,
  options: RequestInit = {},
  apiKey?: string,
): Promise<{ status: number; data: T }> {
  const headers = {
    ...(options.headers as Record<string, string>),
    "X-CLI-Version": cliVersion,
  };
  return baseTestRequest<T>(path, { ...options, headers }, apiKey);
}

/** Shorthand for POST with an optional JSON body. */
function postJson(body: unknown = {}): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

// -- Tests -----------------------------------------------------------------

describe("IAM Removal: Upload credentials (STS tokens)", () => {
  test("dataset owner gets upload credentials for nm099999", async () => {
    const { status, data } = await testRequest<UploadCredentialsResponse>(
      "/datasets/nm099999/upload-credentials",
      postJson(),
      adminKey,
    );

    expect(status).toBe(200);
    expect(data.credentials.access_key_id).toBeDefined();
    expect(data.credentials.secret_access_key).toBeDefined();
    // STS token: session_token is the key differentiator from permanent IAM keys
    expect(data.credentials.session_token).toBeDefined();
    expect(data.credentials.session_token.length).toBeGreaterThan(100);
    expect(data.credentials.expiration).toBeDefined();
    expect(data.s3.prefix).toBe("nm099999/objects");
    // Environment-derived: prod serves `nemar`, dev/staging serves `nemar-dev`
    // (epic #923). Hardcoding "nemar" here asserted that dev shared the
    // production bucket, which is exactly what that epic removed.
    expect(data.s3.bucket).toBe(EXPECTED_S3_BUCKET);
  });

  test("STS credentials have correct expiration (within 2 hours)", async () => {
    const { status, data } = await testRequest<UploadCredentialsResponse>(
      "/datasets/nm099999/upload-credentials",
      postJson(),
      adminKey,
    );

    expect(status).toBe(200);
    const expiration = new Date(data.credentials.expiration);
    const now = new Date();
    const hoursUntilExpiry = (expiration.getTime() - now.getTime()) / (1000 * 60 * 60);
    // Default STS duration is 7200s (2h); allowing up to 2.1h for clock drift
    expect(hoursUntilExpiry).toBeGreaterThan(1);
    expect(hoursUntilExpiry).toBeLessThanOrEqual(2.1);
  });
});

describe("IAM Removal: Presigned upload URLs", () => {
  test("presigned URLs use valid AWS signatures", async () => {
    const { status, data } = await testRequest<UploadUrlsResponse>(
      "/datasets/nm099999/upload-urls",
      postJson({ files: ["test-iam-validation.txt"] }),
      adminKey,
    );

    expect(status).toBe(200);
    const url = data.upload_urls["test-iam-validation.txt"];
    expect(url).toBeDefined();
    expect(url).toContain("X-Amz-Signature");
    expect(url).toContain("X-Amz-Expires");
    expect(url).toContain("nm099999/objects/test-iam-validation.txt");
  });

  test("presigned URL actually works for S3 PUT", async () => {
    const { status, data } = await testRequest<UploadUrlsResponse>(
      "/datasets/nm099999/upload-urls",
      postJson({ files: ["test-iam-put-validation.txt"] }),
      adminKey,
    );

    expect(status).toBe(200);
    const url = data.upload_urls["test-iam-put-validation.txt"];
    const putResponse = await fetch(url, {
      method: "PUT",
      body: "IAM removal test content",
      headers: { "Content-Type": "text/plain" },
    });

    expect(putResponse.status).toBe(200);
  });
});

describe("IAM Removal: Collaborator access", () => {
  test("collaborator (test-user) can get upload credentials for nm099999", async () => {
    const { status, data } = await testRequest<UploadCredentialsResponse>(
      "/datasets/nm099999/upload-credentials",
      postJson(),
      userKey,
    );

    expect(status).toBe(200);
    expect(data.credentials.session_token).toBeDefined();
  });

  test("collaborator can get presigned upload URLs", async () => {
    const { status, data } = await testRequest<UploadUrlsResponse>(
      "/datasets/nm099999/upload-urls",
      postJson({ files: ["collaborator-test.txt"] }),
      userKey,
    );

    expect(status).toBe(200);
    expect(data.upload_urls["collaborator-test.txt"]).toContain("X-Amz-Signature");
  });
});

describe("IAM Removal: Authorization enforcement", () => {
  test("unauthenticated request gets 401", async () => {
    const { status } = await testRequest("/datasets/nm099999/upload-credentials", postJson());

    expect(status).toBe(401);
  });

  test("user gets error for non-existent dataset", async () => {
    // nm000999 does not exist in dev D1, so this tests the 404/403 boundary
    const { status } = await testRequest(
      "/datasets/nm000999/upload-credentials",
      postJson(),
      userKey,
    );

    expect([403, 404]).toContain(status);
  });
});

describe("IAM Removal: Download credentials", () => {
  test("dataset owner gets download credentials for private dataset", async () => {
    const { status, data } = await testRequest<{
      credentials: StsCredentials;
    }>("/datasets/nm099999/download-credentials", postJson(), adminKey);

    expect(status).toBe(200);
    expect(data.credentials.session_token).toBeDefined();
  });

  test("collaborator gets download credentials", async () => {
    const { status, data } = await testRequest<{
      credentials: StsCredentials;
    }>("/datasets/nm099999/download-credentials", postJson(), userKey);

    expect(status).toBe(200);
    expect(data.credentials.session_token).toBeDefined();
  });
});

describe("IAM Removal: Deprecated endpoints", () => {
  test("regenerate-iam returns 410 Gone", async () => {
    const { status, data } = await testRequest<{ status: string; message: string }>(
      "/admin/regenerate-iam/test-user",
      { method: "POST" },
      adminKey,
    );

    expect(status).toBe(410);
    expect(data.status).toBe("deprecated");
    expect(data.message).toContain("no longer needed");
  });
});

describe("IAM Removal: User approval (no IAM setup)", () => {
  // Note: We do NOT actually approve test-verified here because it would
  // change shared DB state and break other tests (e.g., cli.test.ts expects
  // test-verified to remain in "verified" status). Instead, we verify the
  // approve endpoint exists and rejects already-approved users without
  // returning IAM fields.
  test("re-approving already-approved user returns no iam fields", async () => {
    // test-admin is already approved in seed data
    const { status, data } = await testRequest<Record<string, unknown>>(
      "/admin/approve/test-admin",
      { method: "POST" },
      adminKey,
    );

    // Already approved -> 409 Conflict
    expect(status).toBe(409);
    expect(data.iam_setup).toBeUndefined();
    expect(data.iam_username).toBeUndefined();
  });
});
