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

  test("GET / returns API info", async () => {
    const { status, data } = await testRequest<{ name: string; version: string }>("/");

    expect(status).toBe(200);
    expect(data.name).toBe("NEMAR API");
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

      expect(status).toBe(400);
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
    const { status, data } = await testRequest<{ error: string }>("/unknown/route");

    expect(status).toBe(404);
    expect(data.error).toBe("Not Found");
  });
});
