/**
 * Test Setup
 *
 * Loads test environment and provides test utilities.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Force every test process to use an isolated config dir before any module
// (notably src/lib/config.ts) can capture the user's real ~/.config/nemar/
// path at import time. Tests that explicitly need a different dir override
// NEMAR_CONFIG_DIR locally; the shared default just keeps the developer's
// real config out of the blast radius.
if (!process.env.NEMAR_CONFIG_DIR) {
  process.env.NEMAR_CONFIG_DIR = mkdtempSync(join(tmpdir(), "nemar-test-cfg-"));
}

// Load test environment variables
const envPath = join(import.meta.dir, ".env.test");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...valueParts] = trimmed.split("=");
      const value = valueParts.join("=");
      if (key && value) {
        process.env[key] = value;
      }
    }
  }
}

// Test configuration
export const TEST_CONFIG = {
  apiUrl: process.env.TEST_API_URL || "https://api.nemar.org",
  password: process.env.TEST_PASSWORD || "TestPassword123!",
  adminApiKey: process.env.TEST_ADMIN_API_KEY || "",
  userApiKey: process.env.TEST_USER_API_KEY || "",
  bypassToken: process.env.TEST_BYPASS_TOKEN || "",
};

/**
 * S3 bucket the backend under test issues credentials for.
 *
 * Production serves `nemar`; every non-production worker serves the dedicated
 * `nemar-dev` bucket (epic #923 gave dev/staging its own bucket so a dev action
 * can never touch real data). Derived from `apiUrl` rather than hardcoded, so a
 * live-backend test asserting on the bucket stays correct whichever environment
 * `TEST_API_URL` points at.
 */
export const EXPECTED_S3_BUCKET =
  new URL(TEST_CONFIG.apiUrl).hostname === "api.nemar.org" ? "nemar" : "nemar-dev";

// Validate test config
if (!TEST_CONFIG.adminApiKey || !TEST_CONFIG.userApiKey) {
  console.warn("Warning: Test API keys not configured. Some tests may fail.");
  console.warn("Create test/.env.test with TEST_ADMIN_API_KEY and TEST_USER_API_KEY");
}

/**
 * Make a test API request
 */
export async function testRequest<T>(
  path: string,
  options: RequestInit = {},
  apiKey?: string,
): Promise<{ status: number; data: T }> {
  const url = `${TEST_CONFIG.apiUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  // Add rate limit bypass header for tests
  if (TEST_CONFIG.bypassToken) {
    headers["X-Test-Bypass"] = TEST_CONFIG.bypassToken;
  }

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  const data = (await response.json()) as T;
  return { status: response.status, data };
}

/**
 * Generate a unique test username
 */
export function uniqueUsername(prefix = "test"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Cleanup function to remove test data
 */
export async function cleanupTestUser(username: string, adminApiKey: string): Promise<void> {
  // This would call the admin revoke endpoint
  // For now, test users are cleaned up manually or via scripts
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rate-limited test request (adds delay to avoid 429)
 */
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 100; // 100ms between requests

export async function rateLimitedRequest<T>(
  path: string,
  options: RequestInit = {},
  apiKey?: string,
): Promise<{ status: number; data: T }> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await sleep(MIN_REQUEST_INTERVAL - timeSinceLastRequest);
  }

  lastRequestTime = Date.now();
  return testRequest<T>(path, options, apiKey);
}
