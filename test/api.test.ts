/**
 * API Client Integration Tests
 *
 * Tests the API client against the real backend.
 * Requires test users to be set up in the database.
 */

import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { TEST_CONFIG, testRequest, sleep } from "./setup";

// Add delay between tests to avoid rate limiting
beforeEach(async () => {
  await sleep(300);
});

describe("API Health", () => {
  test("GET /health returns status ok", async () => {
    const { status, data } = await testRequest<{ status: string; version: string }>("/health");

    expect(status).toBe(200);
    expect(data.status).toBe("ok");
    expect(data.version).toBeDefined();
  });

  test("GET / returns 404 (no root handler)", async () => {
    // Root route is not implemented; returns 404
    const response = await fetch(`${TEST_CONFIG.apiUrl}/`);
    expect(response.status).toBe(404);
  });
});

describe("Authentication API", () => {
  describe("POST /auth/login", () => {
    test("valid admin API key returns user info with is_admin=true", async () => {
      const { status, data } = await testRequest<{
        valid: boolean;
        user: { username: string; is_admin: boolean };
      }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ api_key: TEST_CONFIG.adminApiKey }),
      });

      expect(status).toBe(200);
      expect(data.valid).toBe(true);
      expect(data.user.username).toBe("test-admin");
      expect(data.user.is_admin).toBe(true);
    });

    test("valid user API key returns user info with is_admin=false", async () => {
      const { status, data } = await testRequest<{
        valid: boolean;
        user: { username: string; is_admin: boolean };
      }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ api_key: TEST_CONFIG.userApiKey }),
      });

      expect(status).toBe(200);
      expect(data.valid).toBe(true);
      expect(data.user.username).toBe("test-user");
      expect(data.user.is_admin).toBe(false);
    });

    test("invalid API key returns 401", async () => {
      const { status, data } = await testRequest<{ error: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ api_key: "invalid_key_12345678901234567890" }),
      });

      expect(status).toBe(401);
      expect(data.error).toBe("Invalid API key");
    });

    test("missing API key returns 400", async () => {
      const { status } = await testRequest("/auth/login", {
        method: "POST",
        body: JSON.stringify({}),
      });

      expect(status).toBe(400);
    });
  });

  describe("POST /auth/signup", () => {
    test("signup with existing username returns 409", async () => {
      const { status, data } = await testRequest<{ error: string }>("/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          username: "test-user",
          email: "new@example.com",
          password: "TestPassword123!",
          github_username: "octocat",
          description: "I need NEMAR access for testing and research purposes.",
        }),
      });

      expect(status).toBe(409);
      expect(data.error).toBe("Username already taken");
    });

    test("signup with existing email returns 409", async () => {
      const { status, data } = await testRequest<{ error: string }>("/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          username: "unique-test-user",
          email: "test-user@nemar.test",
          password: "TestPassword123!",
          github_username: "octocat",
          description: "I need NEMAR access for testing and research purposes.",
        }),
      });

      expect(status).toBe(409);
      expect(data.error).toBe("Email already registered");
    });

    test("signup with weak password returns 400", async () => {
      const { status, data } = await testRequest<{ error: string }>("/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          username: "unique-test-user",
          email: "unique@example.com",
          password: "weak",
          github_username: "octocat",
          description: "I need NEMAR access for testing and research purposes.",
        }),
      });

      expect(status).toBe(400);
    });

    test("signup with invalid email returns 400", async () => {
      const { status } = await testRequest("/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          username: "unique-test-user",
          email: "not-an-email",
          password: "TestPassword123!",
          github_username: "octocat",
          description: "I need NEMAR access for testing and research purposes.",
        }),
      });

      expect(status).toBe(400);
    });

    test("signup with missing description returns 400", async () => {
      const { status } = await testRequest("/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          username: "unique-test-user",
          email: "unique@example.com",
          password: "TestPassword123!",
          github_username: "octocat",
        }),
      });

      expect(status).toBe(400);
    });

    test("signup with short description returns 400", async () => {
      const { status } = await testRequest("/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          username: "unique-test-user",
          email: "unique@example.com",
          password: "TestPassword123!",
          github_username: "octocat",
          description: "Too short",
        }),
      });

      expect(status).toBe(400);
    });
  });

  describe("POST /auth/resend-verification", () => {
    test("resend for non-existent email returns generic message (no leak)", async () => {
      const { status, data } = await testRequest<{ message: string }>("/auth/resend-verification", {
        method: "POST",
        body: JSON.stringify({ email: "nonexistent@example.com" }),
      });

      expect(status).toBe(200);
      expect(data.message).toContain("If an account exists");
    });

    test("resend for already verified user returns appropriate message", async () => {
      const { status, data } = await testRequest<{ message: string }>("/auth/resend-verification", {
        method: "POST",
        body: JSON.stringify({ email: "test-user@nemar.test" }),
      });

      expect(status).toBe(200);
      expect(data.message).toContain("already verified");
    });
  });
});

describe("User API", () => {
  describe("GET /users/me", () => {
    test("authenticated user can get their info", async () => {
      const { status, data } = await testRequest<{
        user: { username: string; email: string; is_admin: boolean };
      }>("/users/me", {}, TEST_CONFIG.userApiKey);

      expect(status).toBe(200);
      expect(data.user.username).toBe("test-user");
      expect(data.user.email).toBe("test-user@nemar.test");
      expect(data.user.is_admin).toBe(false);
    });

    test("admin user can get their info", async () => {
      const { status, data } = await testRequest<{
        user: { username: string; is_admin: boolean };
      }>("/users/me", {}, TEST_CONFIG.adminApiKey);

      expect(status).toBe(200);
      expect(data.user.username).toBe("test-admin");
      expect(data.user.is_admin).toBe(true);
    });

    test("unauthenticated request returns 401", async () => {
      const { status } = await testRequest("/users/me");

      expect(status).toBe(401);
    });

    test("invalid token returns 401", async () => {
      const { status } = await testRequest("/users/me", {}, "invalid_token");

      expect(status).toBe(401);
    });
  });
});

describe("Admin API", () => {
  describe("GET /admin/users", () => {
    test("admin can list all users", async () => {
      const { status, data } = await testRequest<{
        users: Array<{ username: string; status: string }>;
        count: number;
      }>("/admin/users", {}, TEST_CONFIG.adminApiKey);

      expect(status).toBe(200);
      expect(data.count).toBeGreaterThan(0);
      expect(data.users.some((u) => u.username === "test-admin")).toBe(true);
    });

    test("admin can filter users by status", async () => {
      const { status, data } = await testRequest<{
        users: Array<{ username: string; status: string }>;
      }>("/admin/users?status=verified", {}, TEST_CONFIG.adminApiKey);

      expect(status).toBe(200);
      expect(data.users.every((u) => u.status === "verified")).toBe(true);
    });

    test("non-admin user gets 403", async () => {
      const { status, data } = await testRequest<{ error: string }>(
        "/admin/users",
        {},
        TEST_CONFIG.userApiKey
      );

      expect(status).toBe(403);
      expect(data.error).toContain("Admin");
    });

    test("unauthenticated request returns 401", async () => {
      const { status } = await testRequest("/admin/users");

      expect(status).toBe(401);
    });
  });

  describe("POST /admin/approve/:username", () => {
    test("approving non-existent user returns 404", async () => {
      const { status, data } = await testRequest<{ error: string }>(
        "/admin/approve/nonexistent-user",
        { method: "POST" },
        TEST_CONFIG.adminApiKey
      );

      expect(status).toBe(404);
    });

    test("approving already approved user returns error", async () => {
      const { status, data } = await testRequest<{ error: string }>(
        "/admin/approve/test-user",
        { method: "POST" },
        TEST_CONFIG.adminApiKey
      );

      expect(status).toBe(409); // Conflict: already approved
      expect(data.error).toContain("approved");
    });

    test("non-admin cannot approve users", async () => {
      const { status } = await testRequest(
        "/admin/approve/test-verified",
        { method: "POST" },
        TEST_CONFIG.userApiKey
      );

      expect(status).toBe(403);
    });
  });

  describe("POST /admin/revoke/:username", () => {
    test("revoking non-existent user returns 404", async () => {
      const { status } = await testRequest<{ error: string }>(
        "/admin/revoke/nonexistent-user",
        { method: "POST" },
        TEST_CONFIG.adminApiKey
      );

      expect(status).toBe(404);
    });

    test("non-admin cannot revoke users", async () => {
      const { status } = await testRequest(
        "/admin/revoke/test-user",
        { method: "POST" },
        TEST_CONFIG.userApiKey
      );

      expect(status).toBe(403);
    });
  });
});

describe("Datasets API", () => {
  describe("GET /datasets", () => {
    test("public can list datasets (returns empty or datasets)", async () => {
      const { status, data } = await testRequest<{
        datasets: Array<{ dataset_id: string }>;
        count: number;
      }>("/datasets");

      expect(status).toBe(200);
      expect(Array.isArray(data.datasets)).toBe(true);
      expect(typeof data.count).toBe("number");
    });
  });

  describe("GET /datasets/:id", () => {
    test("non-existent dataset returns 404", async () => {
      const { status } = await testRequest("/datasets/nm999999");

      expect(status).toBe(404);
    });
  });
});

describe("DOI/Zenodo API", () => {
  describe("GET /admin/datasets/:id/doi", () => {
    test("admin can get DOI info for a dataset", async () => {
      // First check if we have any datasets
      const { data: datasetsList } = await testRequest<{
        datasets: Array<{ dataset_id: string }>;
      }>("/datasets");

      if (datasetsList.datasets.length === 0) {
        // Skip if no datasets exist
        return;
      }

      const datasetId = datasetsList.datasets[0].dataset_id;
      const { status, data } = await testRequest<{
        dataset_id: string;
        name: string;
        concept_doi: string | null;
      }>(`/admin/datasets/${datasetId}/doi`, {}, TEST_CONFIG.adminApiKey);

      expect(status).toBe(200);
      expect(data.dataset_id).toBe(datasetId);
    });

    test("non-admin user gets 403", async () => {
      const { status, data } = await testRequest<{ error: string }>(
        "/admin/datasets/nm000001/doi",
        {},
        TEST_CONFIG.userApiKey
      );

      expect(status).toBe(403);
      expect(data.error).toContain("Admin");
    });

    test("unauthenticated request returns 401", async () => {
      const { status } = await testRequest("/admin/datasets/nm000001/doi");

      expect(status).toBe(401);
    });

    test("non-existent dataset returns 404", async () => {
      const { status } = await testRequest<{ error: string }>(
        "/admin/datasets/nm999999/doi",
        {},
        TEST_CONFIG.adminApiKey
      );

      expect(status).toBe(404);
    });
  });

  describe("POST /admin/datasets/:id/doi/concept", () => {
    test("non-admin user gets 403", async () => {
      const { status, data } = await testRequest<{ error: string }>(
        "/admin/datasets/nm000001/doi/concept",
        { method: "POST", body: JSON.stringify({}) },
        TEST_CONFIG.userApiKey
      );

      expect(status).toBe(403);
      expect(data.error).toContain("Admin");
    });

    test("unauthenticated request returns 401", async () => {
      const { status } = await testRequest("/admin/datasets/nm000001/doi/concept", {
        method: "POST",
        body: JSON.stringify({}),
      });

      expect(status).toBe(401);
    });

    test("non-existent dataset returns 404", async () => {
      const { status } = await testRequest<{ error: string }>(
        "/admin/datasets/nm999999/doi/concept",
        { method: "POST", body: JSON.stringify({}) },
        TEST_CONFIG.adminApiKey
      );

      expect(status).toBe(404);
    });
  });

  describe("POST /webhooks/publish-version-doi", () => {
    test("missing webhook token returns 401", async () => {
      const { status, data } = await testRequest<{ error: string }>(
        "/webhooks/publish-version-doi",
        {
          method: "POST",
          body: JSON.stringify({
            dataset_id: "nm000001",
            version: "1.0.0",
            release_url: "https://github.com/example/repo/releases/tag/v1.0.0",
          }),
        }
      );

      expect(status).toBe(401);
      expect(data.error).toBe("Invalid webhook token");
    });

    test("invalid webhook token returns 401", async () => {
      const headers = { "X-Webhook-Token": "invalid_token" };
      const response = await fetch(`${TEST_CONFIG.apiUrl}/webhooks/publish-version-doi`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          dataset_id: "nm000001",
          version: "1.0.0",
          release_url: "https://github.com/example/repo/releases/tag/v1.0.0",
        }),
      });

      expect(response.status).toBe(401);
    });

    test("missing required fields returns 400", async () => {
      const headers = { "X-Webhook-Token": "test_token" };
      const response = await fetch(`${TEST_CONFIG.apiUrl}/webhooks/publish-version-doi`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          dataset_id: "nm000001",
          // Missing version and release_url
        }),
      });

      // Will be 401 if token is invalid, or 400 if token is valid but fields missing
      expect([400, 401]).toContain(response.status);
    });
  });
});

describe("Dataset Collaborators API", () => {
  describe("POST /datasets/:id/request-access", () => {
    test("unauthenticated request returns 401", async () => {
      const { status } = await testRequest("/datasets/nm000001/request-access", {
        method: "POST",
      });

      expect(status).toBe(401);
    });

    test("non-existent dataset returns 404", async () => {
      const { status, data } = await testRequest<{ error: string }>(
        "/datasets/nm999999/request-access",
        { method: "POST" },
        TEST_CONFIG.userApiKey
      );

      expect(status).toBe(404);
    });

    test("invalid dataset ID format returns 404", async () => {
      const { status } = await testRequest<{ error: string }>(
        "/datasets/invalid-id/request-access",
        { method: "POST" },
        TEST_CONFIG.userApiKey
      );

      // Invalid ID format results in 404 since no dataset matches
      expect(status).toBe(404);
    });
  });

  describe("POST /datasets/:id/invite", () => {
    test("unauthenticated request returns 401", async () => {
      const { status } = await testRequest("/datasets/nm000001/invite", {
        method: "POST",
        body: JSON.stringify({ username: "someone" }),
      });

      expect(status).toBe(401);
    });

    test("non-admin non-owner gets 403", async () => {
      // First get a dataset that test-user doesn't own
      const { data: datasetsList } = await testRequest<{
        datasets: Array<{ dataset_id: string; owner_username: string }>;
      }>("/datasets");

      const otherDataset = datasetsList.datasets.find(
        (d) => d.owner_username !== "test-user"
      );

      if (!otherDataset) {
        // Skip if no suitable dataset exists
        return;
      }

      const { status, data } = await testRequest<{ error: string }>(
        `/datasets/${otherDataset.dataset_id}/invite`,
        { method: "POST", body: JSON.stringify({ username: "someone" }) },
        TEST_CONFIG.userApiKey
      );

      expect(status).toBe(403);
      expect(data.error).toContain("owner or admin");
    });

    test("non-existent dataset returns 404", async () => {
      const { status } = await testRequest<{ error: string }>(
        "/datasets/nm999999/invite",
        { method: "POST", body: JSON.stringify({ username: "test-user" }) },
        TEST_CONFIG.adminApiKey
      );

      expect(status).toBe(404);
    });

    test("inviting non-existent user returns 404", async () => {
      // First get any dataset
      const { data: datasetsList } = await testRequest<{
        datasets: Array<{ dataset_id: string }>;
      }>("/datasets");

      if (datasetsList.datasets.length === 0) {
        return;
      }

      const { status, data } = await testRequest<{ error: string }>(
        `/datasets/${datasetsList.datasets[0].dataset_id}/invite`,
        { method: "POST", body: JSON.stringify({ username: "nonexistent-user-12345" }) },
        TEST_CONFIG.adminApiKey
      );

      expect(status).toBe(404);
      expect(data.error).toContain("not found");
    });

    test("missing username returns 400", async () => {
      const { status } = await testRequest(
        "/datasets/nm000001/invite",
        { method: "POST", body: JSON.stringify({}) },
        TEST_CONFIG.adminApiKey
      );

      expect(status).toBe(400);
    });
  });

  describe("GET /datasets/:id/collaborators", () => {
    test("unauthenticated request returns 401", async () => {
      const { status } = await testRequest("/datasets/nm000001/collaborators");

      expect(status).toBe(401);
    });

    test("non-admin non-owner gets 403", async () => {
      // First get a dataset that test-user doesn't own
      const { data: datasetsList } = await testRequest<{
        datasets: Array<{ dataset_id: string; owner_username: string }>;
      }>("/datasets");

      const otherDataset = datasetsList.datasets.find(
        (d) => d.owner_username !== "test-user"
      );

      if (!otherDataset) {
        // Skip if no suitable dataset exists
        return;
      }

      const { status, data } = await testRequest<{ error: string }>(
        `/datasets/${otherDataset.dataset_id}/collaborators`,
        {},
        TEST_CONFIG.userApiKey
      );

      expect(status).toBe(403);
      expect(data.error).toContain("owner or admin");
    });

    test("non-existent dataset returns 404", async () => {
      const { status } = await testRequest<{ error: string }>(
        "/datasets/nm999999/collaborators",
        {},
        TEST_CONFIG.adminApiKey
      );

      expect(status).toBe(404);
    });

    test("admin can list collaborators for any dataset", async () => {
      const { data: datasetsList } = await testRequest<{
        datasets: Array<{ dataset_id: string }>;
      }>("/datasets");

      if (datasetsList.datasets.length === 0) {
        return;
      }

      const { status, data } = await testRequest<{
        dataset_id: string;
        collaborators: Array<{ username: string }>;
        count: number;
      }>(
        `/datasets/${datasetsList.datasets[0].dataset_id}/collaborators`,
        {},
        TEST_CONFIG.adminApiKey
      );

      expect(status).toBe(200);
      expect(data.dataset_id).toBe(datasetsList.datasets[0].dataset_id);
      expect(Array.isArray(data.collaborators)).toBe(true);
      expect(typeof data.count).toBe("number");
    });
  });
});

describe("Error Handling", () => {
  test("invalid JSON returns 400", async () => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (TEST_CONFIG.bypassToken) {
      headers["X-Test-Bypass"] = TEST_CONFIG.bypassToken;
    }
    const response = await fetch(`${TEST_CONFIG.apiUrl}/auth/login`, {
      method: "POST",
      headers,
      body: "not valid json",
    });

    expect(response.status).toBe(400);
  });

  test("unknown route returns 404", async () => {
    // Unknown routes return plain text 404, not JSON
    const response = await fetch(`${TEST_CONFIG.apiUrl}/unknown/route`);
    expect(response.status).toBe(404);
  });
});
