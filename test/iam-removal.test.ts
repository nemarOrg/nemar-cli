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
import {
  EXPECTED_S3_BUCKET,
  LIVE_TARGET_BLOCKED,
  TEST_CONFIG,
  testRequest as baseTestRequest,
} from "./setup";

const adminKey = TEST_CONFIG.adminApiKey;
const userKey = TEST_CONFIG.userApiKey;

/**
 * Every suite here needs a live backend, so all of them skip together when the
 * target is blocked (#1343's `LIVE_TARGET_BLOCKED`).
 *
 * The `beforeAll` below is why this file needed its own guard rather than
 * inheriting one: a file-scope hook runs even when every `describe` in the file
 * is skipped, so its `throw` was the single remaining failure in a bare
 * `bun test` after #1343 landed. It stays a throw, because a MISCONFIGURED live
 * run should be loud -- it just no longer fires when nobody asked for a live run
 * at all.
 */
const describeLive = describe.skipIf(LIVE_TARGET_BLOCKED);

beforeAll(() => {
  if (LIVE_TARGET_BLOCKED) return;
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

/**
 * The three collaborator cases need two rows that scripts/seed-dev-db.sql seeds for test-user on
 * nm099999: its dataset_collaborators row, which all three need, and its user_s3_permissions row
 * for the prefix, which the two upload routes need as well. POST /admin/datasets/nm099999/reset
 * deletes both and restores neither, and the only routes that write a collaborator row (invite,
 * and approving an access request) first invite test-user's GitHub login to
 * nemarDatasets/nm099999 on GitHub, which a test must not do. So each case reads its rows first and
 * fails with a message that names the one that is missing, instead of the route's 403.
 *
 * Nothing is written. The collaborator row is read from the collaborator list, as test-admin. No
 * route reads the permission row but the upload routes themselves, so it is read from
 * POST /datasets/:id/upload-urls as test-user, which checks the two rows in turn and writes nothing
 * (it signs URLs locally); while the collaborator row is missing it never reaches the second. A
 * row found is kept; a missing row, or an answer that cannot be read, is asked again by the next
 * case.
 */
const RESEED =
  "A reset of nm099999 deletes test-user's dataset_collaborators and user_s3_permissions rows for it and nothing restores them; re-seed them from scripts/seed-dev-db.sql (an owner's action on the dev database).";
const NO_S3_PERMISSION = "You do not have S3 upload permission for this dataset";
const found = { collaborator: false, s3Permission: false };

async function requireTestUserRows(needs: { s3Permission: boolean }): Promise<void> {
  if (!found.collaborator) {
    const { status, data } = await testRequest<{ collaborators?: { username?: string }[] }>(
      "/datasets/nm099999/collaborators",
      {},
      adminKey,
    );
    if (status !== 200) {
      throw new Error(
        `Precondition unread: GET /datasets/nm099999/collaborators answered ${status} to test-admin, so whether test-user has a dataset_collaborators row for nm099999 is unknown.`,
      );
    }
    if (!(data.collaborators ?? []).some((c) => c.username === "test-user")) {
      const s3 = needs.s3Permission
        ? " Its user_s3_permissions row, which the upload routes check only after that one, cannot be read until it exists."
        : "";
      throw new Error(
        `Missing precondition: test-user has no dataset_collaborators row for nm099999 on this backend.${s3} ${RESEED}`,
      );
    }
    found.collaborator = true;
  }
  if (!needs.s3Permission || found.s3Permission) return;
  const { status, data } = await testRequest<{ error?: unknown }>(
    "/datasets/nm099999/upload-urls",
    postJson({ files: ["iam-precondition-probe.txt"] }),
    userKey,
  );
  if (status === 200) {
    found.s3Permission = true;
    return;
  }
  if (status === 403 && data.error === NO_S3_PERMISSION) {
    throw new Error(
      `Missing precondition: test-user has no user_s3_permissions row for nm099999 on this backend (upload-urls answered "${NO_S3_PERMISSION}"). ${RESEED}`,
    );
  }
  throw new Error(
    `Precondition unread: POST /datasets/nm099999/upload-urls answered ${status} to test-user (${JSON.stringify(data.error ?? null)}), so whether test-user has a user_s3_permissions row for nm099999 is unknown.`,
  );
}

// -- Tests -----------------------------------------------------------------

describeLive("IAM Removal: Upload credentials (STS tokens)", () => {
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

describeLive("IAM Removal: Presigned upload URLs", () => {
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

describeLive("IAM Removal: Collaborator access", () => {
  test("collaborator (test-user) can get upload credentials for nm099999", async () => {
    await requireTestUserRows({ s3Permission: true });
    const { status, data } = await testRequest<UploadCredentialsResponse>(
      "/datasets/nm099999/upload-credentials",
      postJson(),
      userKey,
    );

    expect(status).toBe(200);
    expect(data.credentials.session_token).toBeDefined();
  });

  test("collaborator can get presigned upload URLs", async () => {
    await requireTestUserRows({ s3Permission: true });
    const { status, data } = await testRequest<UploadUrlsResponse>(
      "/datasets/nm099999/upload-urls",
      postJson({ files: ["collaborator-test.txt"] }),
      userKey,
    );

    expect(status).toBe(200);
    expect(data.upload_urls["collaborator-test.txt"]).toContain("X-Amz-Signature");
  });
});

describeLive("IAM Removal: Authorization enforcement", () => {
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

describeLive("IAM Removal: Download credentials", () => {
  test("dataset owner gets download credentials for private dataset", async () => {
    const { status, data } = await testRequest<{
      credentials: StsCredentials;
    }>("/datasets/nm099999/download-credentials", postJson(), adminKey);

    expect(status).toBe(200);
    expect(data.credentials.session_token).toBeDefined();
  });

  test("collaborator gets download credentials", async () => {
    await requireTestUserRows({ s3Permission: false });
    const { status, data } = await testRequest<{
      credentials: StsCredentials;
    }>("/datasets/nm099999/download-credentials", postJson(), userKey);

    expect(status).toBe(200);
    expect(data.credentials.session_token).toBeDefined();
  });
});

describeLive("IAM Removal: Deprecated endpoints", () => {
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

describeLive("IAM Removal: User approval (no IAM setup)", () => {
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
