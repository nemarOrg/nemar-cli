/**
 * Dataset ID generation and validation tests
 *
 * Tests for the ID cap at 99999, validation logic, and dedup behavior.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidDatasetId } from "../backend/src/services/datasetId";
import { TEST_CONFIG, testRequest as baseTestRequest } from "./setup";

// Read CLI version from package.json for the X-CLI-Version header
const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf-8"));
const cliVersion: string = pkg.version;

/** Wraps baseTestRequest to include X-CLI-Version header (required by POST /datasets). */
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

describe("isValidDatasetId", () => {
  test("accepts valid nm IDs", () => {
    expect(isValidDatasetId("nm000108")).toBe(true);
    expect(isValidDatasetId("nm099999")).toBe(true);
    expect(isValidDatasetId("nm000001")).toBe(true);
  });

  test("accepts valid xx and on IDs", () => {
    expect(isValidDatasetId("xx000001")).toBe(true);
    expect(isValidDatasetId("on007262")).toBe(true);
  });

  test("rejects IDs above 99999", () => {
    expect(isValidDatasetId("nm100000")).toBe(false);
    expect(isValidDatasetId("nm100001")).toBe(false);
    expect(isValidDatasetId("nm999999")).toBe(false);
  });

  test("rejects invalid prefixes", () => {
    expect(isValidDatasetId("ab000001")).toBe(false);
    expect(isValidDatasetId("000001nm")).toBe(false);
  });

  test("rejects wrong length", () => {
    expect(isValidDatasetId("nm00001")).toBe(false);
    expect(isValidDatasetId("nm0000001")).toBe(false);
    expect(isValidDatasetId("nm")).toBe(false);
    expect(isValidDatasetId("")).toBe(false);
  });
});

// API tests require a running backend with test credentials
const adminKey = TEST_CONFIG.adminApiKey;
const userKey = TEST_CONFIG.userApiKey;
const describeApi = adminKey && userKey ? describe : describe.skip;

// Dedup API test requires the dedup changes to be deployed.
// Set TEST_DEDUP_DEPLOYED=1 to run this test after deployment.
const describeDedup = describeApi && process.env.TEST_DEDUP_DEPLOYED ? describe : describe.skip;

describeDedup("POST /datasets dedup", () => {
  test("returns 200 with resumed=true for duplicate name", async () => {
    const uniqueName = `dedup-test-${Date.now()}`;

    // First creation
    const { status: s1, data: d1 } = await testRequest<{
      dataset: { dataset_id: string };
      resumed?: boolean;
    }>(
      "/datasets",
      {
        method: "POST",
        body: JSON.stringify({ name: uniqueName, sandbox: true }),
      },
      userKey,
    );
    expect(s1).toBe(201);
    expect(d1.resumed).toBeUndefined();
    const firstId = d1.dataset.dataset_id;

    // Second creation with same name should hit dedup
    const { status: s2, data: d2 } = await testRequest<{
      dataset: { dataset_id: string };
      resumed?: boolean;
    }>(
      "/datasets",
      {
        method: "POST",
        body: JSON.stringify({ name: uniqueName, sandbox: true }),
      },
      userKey,
    );
    expect(s2).toBe(200);
    expect(d2.resumed).toBe(true);
    expect(d2.dataset.dataset_id).toBe(firstId);

    // Cleanup
    await baseTestRequest(`/admin/datasets/${firstId}`, { method: "DELETE" }, adminKey);
  });
});
