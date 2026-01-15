/**
 * Zenodo Sandbox Integration Tests
 *
 * These tests hit the real Zenodo sandbox API to verify DOI creation.
 * Run with: RUN_ZENODO_TESTS=true bun test test/zenodo-sandbox.test.ts
 *
 * NOTE: DOIs are PERMANENT even in sandbox - each test creates real depositions.
 * Only run when you need to verify Zenodo integration is working.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { TEST_CONFIG, testRequest, sleep } from "./setup";

// Only run these tests when explicitly enabled
const SHOULD_RUN = process.env.RUN_ZENODO_TESTS === "true";

// We need a dataset to test with - create one or use existing
const TEST_DATASET_ID = process.env.TEST_DATASET_ID || "";

describe("Zenodo Sandbox Integration", () => {
  beforeAll(() => {
    if (!SHOULD_RUN) {
      console.log("\n⚠️  Zenodo sandbox tests are SKIPPED by default.");
      console.log("   To run: RUN_ZENODO_TESTS=true TEST_DATASET_ID=nm000xxx bun test test/zenodo-sandbox.test.ts\n");
    }
  });

  describe("Concept DOI Creation (Sandbox)", () => {
    test("can create concept DOI on sandbox", async () => {
      if (!SHOULD_RUN) {
        console.log("   Skipping: RUN_ZENODO_TESTS not set");
        return;
      }

      if (!TEST_DATASET_ID) {
        console.log("   Skipping: TEST_DATASET_ID not set");
        return;
      }

      // Add delay to avoid rate limiting
      await sleep(500);

      const { status, data } = await testRequest<{
        message: string;
        concept_doi: string;
        zenodo_id: number;
        zenodo_url: string;
        setup_command: string;
        warning: string;
        error?: string;
      }>(
        `/admin/datasets/${TEST_DATASET_ID}/doi/concept`,
        {
          method: "POST",
          body: JSON.stringify({
            title: `Test Dataset - ${new Date().toISOString()}`,
            description: "Automated test DOI creation",
            sandbox: true,
          }),
        },
        TEST_CONFIG.adminApiKey
      );

      // Could be 200 (success) or 400 (already has DOI)
      if (status === 200) {
        console.log(`   ✓ Created sandbox DOI: ${data.concept_doi}`);
        expect(data.concept_doi).toMatch(/^10\.\d+\/zenodo\.\d+$/);
        expect(data.zenodo_id).toBeGreaterThan(0);
        expect(data.zenodo_url).toContain("sandbox.zenodo.org");
        expect(data.setup_command).toContain("gh secret set");
      } else if (status === 400 && data.error?.includes("already has")) {
        console.log("   ✓ Dataset already has concept DOI (expected on re-run)");
        expect(data.error).toContain("already has a concept DOI");
      } else {
        console.log(`   Response: ${JSON.stringify(data)}`);
        // Fail the test if unexpected status
        expect(status).toBeOneOf([200, 400]);
      }
    });

    test("sandbox DOI info is retrievable", async () => {
      if (!SHOULD_RUN) {
        console.log("   Skipping: RUN_ZENODO_TESTS not set");
        return;
      }

      if (!TEST_DATASET_ID) {
        console.log("   Skipping: TEST_DATASET_ID not set");
        return;
      }

      await sleep(300);

      const { status, data } = await testRequest<{
        dataset_id: string;
        name: string;
        concept_doi: string | null;
        zenodo_concept_url: string | null;
      }>(`/admin/datasets/${TEST_DATASET_ID}/doi`, {}, TEST_CONFIG.adminApiKey);

      expect(status).toBe(200);
      expect(data.dataset_id).toBe(TEST_DATASET_ID);

      if (data.concept_doi) {
        console.log(`   ✓ DOI info retrieved: ${data.concept_doi}`);
        expect(data.zenodo_concept_url).toContain("zenodo.org");
      } else {
        console.log("   Dataset has no concept DOI yet");
      }
    });
  });

  describe("Version DOI Publishing (Sandbox)", () => {
    test("webhook endpoint validates token", async () => {
      if (!SHOULD_RUN) {
        console.log("   Skipping: RUN_ZENODO_TESTS not set");
        return;
      }

      await sleep(300);

      // Test with invalid token - should reject
      const response = await fetch(`${TEST_CONFIG.apiUrl}/webhooks/publish-version-doi`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Token": "invalid_test_token",
        },
        body: JSON.stringify({
          dataset_id: TEST_DATASET_ID || "nm000001",
          version: "1.0.0",
          release_url: "https://github.com/test/repo/releases/tag/v1.0.0",
          sandbox: true,
        }),
      });

      expect(response.status).toBe(401);
      const data = await response.json() as { error: string };
      expect(data.error).toBe("Invalid webhook token");
      console.log("   ✓ Webhook correctly rejects invalid token");
    });
  });
});
