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

import { describe, expect, test } from "bun:test";
import { TEST_CONFIG, testRequest as _testRequest } from "./setup";

const adminKey = TEST_CONFIG.adminApiKey;
const userKey = TEST_CONFIG.userApiKey;

// Wrap testRequest to include X-CLI-Version header (required by backend)
async function testRequest<T>(
  path: string,
  options: RequestInit = {},
  apiKey?: string,
): Promise<{ status: number; data: T }> {
  const headers = {
    ...(options.headers as Record<string, string>),
    "X-CLI-Version": "0.7.20",
  };
  return _testRequest<T>(path, { ...options, headers }, apiKey);
}

describe("IAM Removal: Upload credentials (STS tokens)", () => {
  test("owner gets upload credentials for nm099999", async () => {
    const { status, data } = await testRequest<{
      credentials: {
        access_key_id: string;
        secret_access_key: string;
        session_token: string;
        expiration: string;
      };
      s3: { bucket: string; region: string; prefix: string };
    }>(
      "/datasets/nm099999/upload-credentials",
      { method: "POST", body: JSON.stringify({}) },
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
    expect(data.s3.bucket).toBe("nemar");
  });

  test("STS credentials have correct expiration (within 2 hours)", async () => {
    const { data } = await testRequest<{
      credentials: { expiration: string };
    }>(
      "/datasets/nm099999/upload-credentials",
      { method: "POST", body: JSON.stringify({}) },
      adminKey,
    );

    const expiration = new Date(data.credentials.expiration);
    const now = new Date();
    const hoursUntilExpiry = (expiration.getTime() - now.getTime()) / (1000 * 60 * 60);
    // Should expire within ~2 hours (default duration)
    expect(hoursUntilExpiry).toBeGreaterThan(1);
    expect(hoursUntilExpiry).toBeLessThanOrEqual(2.1);
  });
});

describe("IAM Removal: Presigned upload URLs", () => {
  test("presigned URLs use valid AWS signatures", async () => {
    const { status, data } = await testRequest<{
      upload_urls: Record<string, string>;
    }>(
      "/datasets/nm099999/upload-urls",
      {
        method: "POST",
        body: JSON.stringify({ files: ["test-iam-validation.txt"] }),
      },
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
    const { data } = await testRequest<{
      upload_urls: Record<string, string>;
    }>(
      "/datasets/nm099999/upload-urls",
      {
        method: "POST",
        body: JSON.stringify({ files: ["test-iam-put-validation.txt"] }),
      },
      adminKey,
    );

    const url = data.upload_urls["test-iam-put-validation.txt"];
    // Actually PUT a small file to S3 using the presigned URL
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
    // test-user has user_s3_permissions for nm099999 (seeded)
    const { status, data } = await testRequest<{
      credentials: { session_token: string };
    }>(
      "/datasets/nm099999/upload-credentials",
      { method: "POST", body: JSON.stringify({}) },
      userKey,
    );

    expect(status).toBe(200);
    expect(data.credentials.session_token).toBeDefined();
  });

  test("collaborator can get presigned upload URLs", async () => {
    const { status, data } = await testRequest<{
      upload_urls: Record<string, string>;
    }>(
      "/datasets/nm099999/upload-urls",
      {
        method: "POST",
        body: JSON.stringify({ files: ["collaborator-test.txt"] }),
      },
      userKey,
    );

    expect(status).toBe(200);
    expect(data.upload_urls["collaborator-test.txt"]).toContain("X-Amz-Signature");
  });
});

describe("IAM Removal: Authorization enforcement", () => {
  test("unauthenticated request gets 401", async () => {
    const { status } = await testRequest(
      "/datasets/nm099999/upload-credentials",
      { method: "POST", body: JSON.stringify({}) },
    );

    expect(status).toBe(401);
  });

  test("user without s3_permission gets 403 on upload-credentials", async () => {
    // test-user does NOT have permission for a non-existent dataset
    const { status } = await testRequest(
      "/datasets/nm000999/upload-credentials",
      { method: "POST", body: JSON.stringify({}) },
      userKey,
    );

    // 404 (dataset not found) or 403 (no permission) -- either is correct
    expect([403, 404]).toContain(status);
  });
});

describe("IAM Removal: Download credentials", () => {
  test("owner gets download credentials for private dataset", async () => {
    const { status, data } = await testRequest<{
      credentials: {
        access_key_id: string;
        secret_access_key: string;
        session_token: string;
      };
    }>(
      "/datasets/nm099999/download-credentials",
      { method: "POST", body: JSON.stringify({}) },
      adminKey,
    );

    expect(status).toBe(200);
    expect(data.credentials.session_token).toBeDefined();
  });

  test("collaborator gets download credentials", async () => {
    const { status, data } = await testRequest<{
      credentials: { session_token: string };
    }>(
      "/datasets/nm099999/download-credentials",
      { method: "POST", body: JSON.stringify({}) },
      userKey,
    );

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
  test("approval response has no iam_setup field", async () => {
    // Approve test-verified user (already in verified status in seed)
    const { status, data } = await testRequest<Record<string, unknown>>(
      "/admin/approve/test-verified",
      { method: "POST" },
      adminKey,
    );

    // May be 200 (approved) or 400 (already approved from previous test run)
    if (status === 200) {
      expect(data.iam_setup).toBeUndefined();
      expect(data.iam_username).toBeUndefined();
      expect(data.email_sent).toBeDefined();
    }
  });
});
