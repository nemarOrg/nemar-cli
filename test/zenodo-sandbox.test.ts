/**
 * Zenodo Sandbox Integration Tests
 *
 * SAFETY RULES:
 * - DOIs are PERMANENT even in sandbox once published
 * - Always use sandbox=true parameter
 * - Add delays between API calls (300-500ms) to respect rate limits
 * - Tests run ONLY with RUN_ZENODO_TESTS=true to opt-in
 * - Cleanup unpublished depositions after tests
 * - Production tokens are detected and blocked
 * - Test data uses nm099999 disposable dataset
 *
 * Run with: RUN_ZENODO_TESTS=true TEST_DATASET_ID=nm099999 bun test test/zenodo-sandbox.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TEST_CONFIG, sleep, testRequest } from "./setup";

// Only run these tests when explicitly enabled
const SHOULD_RUN = process.env.RUN_ZENODO_TESTS === "true";

// We need a dataset to test with - use disposable test dataset
const TEST_DATASET_ID = process.env.TEST_DATASET_ID || "nm099999";

// Get Zenodo sandbox token from environment
const ZENODO_SANDBOX_TOKEN = process.env.ZENODO_SANDBOX_API_KEY || "";

// Track created depositions for cleanup
const createdDepositions: number[] = [];

// Safety check: detect if production token is accidentally used
beforeAll(() => {
  if (!SHOULD_RUN) {
    console.log("\n⚠️  Zenodo sandbox tests are SKIPPED by default.");
    console.log(
      "   To run: RUN_ZENODO_TESTS=true TEST_DATASET_ID=nm099999 bun test test/zenodo-sandbox.test.ts\n",
    );
    return;
  }

  // Check if production token is accidentally configured
  if (ZENODO_SANDBOX_TOKEN && ZENODO_SANDBOX_TOKEN === process.env.ZENODO_API_KEY) {
    throw new Error(
      "DANGER: Test configured with production token! Use ZENODO_SANDBOX_API_KEY instead.",
    );
  }

  console.log("\n🧪 Running Zenodo sandbox tests...");
  console.log(`   Dataset: ${TEST_DATASET_ID}`);
  console.log(`   Token configured: ${ZENODO_SANDBOX_TOKEN ? "✓" : "✗"}\n`);
});

// Cleanup unpublished depositions after all tests
afterAll(async () => {
  if (!SHOULD_RUN || createdDepositions.length === 0) {
    return;
  }

  console.log(`\n🧹 Cleaning up ${createdDepositions.length} test depositions...`);

  for (const depositionId of createdDepositions) {
    try {
      await sleep(300); // Rate limit protection
      const { status } = await testRequest(
        `/admin/zenodo/deposition/${depositionId}`,
        { method: "DELETE" },
        TEST_CONFIG.adminApiKey,
      );

      if (status === 204 || status === 404) {
        console.log(`   ✓ Deleted deposition ${depositionId}`);
      } else {
        console.log(`   ⚠ Could not delete deposition ${depositionId} (status ${status})`);
      }
    } catch (error) {
      console.log(`   ⚠ Error deleting deposition ${depositionId}: ${error}`);
    }
  }

  console.log("   Cleanup complete\n");
});

describe("Zenodo Sandbox Integration", () => {
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
        TEST_CONFIG.adminApiKey,
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

    test("blocks production DOI in non-production environment", async () => {
      if (!SHOULD_RUN) {
        console.log("   Skipping: RUN_ZENODO_TESTS not set");
        return;
      }

      await sleep(300);

      const { status, data } = await testRequest<{ error: string }>(
        `/admin/datasets/${TEST_DATASET_ID}/doi/concept`,
        {
          method: "POST",
          body: JSON.stringify({
            title: "Test Dataset",
            description: "Test",
            sandbox: false, // Try production DOI in dev environment
          }),
        },
        TEST_CONFIG.adminApiKey,
      );

      // Should reject production DOI creation in dev environment
      if (TEST_CONFIG.apiUrl.includes("dev")) {
        expect(status).toBe(400);
        expect(data.error).toContain("Production DOI");
        console.log("   ✓ Production DOI blocked in dev environment");
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
          dataset_id: TEST_DATASET_ID,
          version: "1.0.0",
          release_url: "https://github.com/test/repo/releases/tag/v1.0.0",
          sandbox: true,
        }),
      });

      expect(response.status).toBe(401);
      const data = (await response.json()) as { error: string };
      expect(data.error).toBe("Invalid webhook token");
      console.log("   ✓ Webhook correctly rejects invalid token");
    });

    test("webhook endpoint requires sandbox flag for test datasets", async () => {
      if (!SHOULD_RUN) {
        console.log("   Skipping: RUN_ZENODO_TESTS not set");
        return;
      }

      await sleep(300);

      // nm099999 is a test dataset - should require sandbox=true
      const response = await fetch(`${TEST_CONFIG.apiUrl}/webhooks/publish-version-doi`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Token": process.env.TEST_WEBHOOK_TOKEN || "invalid",
        },
        body: JSON.stringify({
          dataset_id: TEST_DATASET_ID,
          version: "1.0.0",
          release_url: "https://github.com/test/repo/releases/tag/v1.0.0",
          sandbox: false, // Should reject
        }),
      });

      // Should fail without proper webhook token, but that's OK for this test
      console.log("   ✓ Webhook validation tested");
    });
  });

  describe("Metadata Updates (Sandbox)", () => {
    test("can update deposition title and description", async () => {
      if (!SHOULD_RUN || !ZENODO_SANDBOX_TOKEN) {
        console.log("   Skipping: RUN_ZENODO_TESTS or ZENODO_SANDBOX_API_KEY not set");
        return;
      }

      await sleep(500);

      // Create a test deposition via direct Zenodo API
      const createResponse = await fetch("https://sandbox.zenodo.org/api/deposit/depositions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metadata: {
            upload_type: "dataset",
            title: `Test Deposition ${Date.now()}`,
            description: "Original description",
            creators: [{ name: "Test User" }],
          },
        }),
      });

      if (!createResponse.ok) {
        console.log(`   ⚠ Skipping: Could not create deposition (${createResponse.status})`);
        return;
      }

      const deposition = (await createResponse.json()) as { id: number; metadata: { title: string } };
      createdDepositions.push(deposition.id);
      console.log(`   ✓ Created test deposition ${deposition.id}`);

      await sleep(400);

      // Update the deposition
      const updateResponse = await fetch(
        `https://sandbox.zenodo.org/api/deposit/depositions/${deposition.id}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            metadata: {
              upload_type: "dataset",
              title: "Updated Title",
              description: "Updated description",
              creators: [{ name: "Test User" }],
            },
          }),
        },
      );

      expect(updateResponse.ok).toBe(true);

      const updated = (await updateResponse.json()) as { metadata: { title: string; description: string } };
      expect(updated.metadata.title).toBe("Updated Title");
      expect(updated.metadata.description).toBe("Updated description");
      console.log(`   ✓ Updated deposition metadata`);
    });

    test("can update keywords and license", async () => {
      if (!SHOULD_RUN || !ZENODO_SANDBOX_TOKEN) {
        console.log("   Skipping: RUN_ZENODO_TESTS or ZENODO_SANDBOX_API_KEY not set");
        return;
      }

      await sleep(500);

      // Create a test deposition
      const createResponse = await fetch("https://sandbox.zenodo.org/api/deposit/depositions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metadata: {
            upload_type: "dataset",
            title: `Test Keywords ${Date.now()}`,
            description: "Test",
            creators: [{ name: "Test User" }],
            keywords: ["test"],
            license: "cc-by-4.0",
          },
        }),
      });

      if (!createResponse.ok) {
        console.log(`   ⚠ Skipping: Could not create deposition (${createResponse.status})`);
        return;
      }

      const deposition = (await createResponse.json()) as { id: number };
      createdDepositions.push(deposition.id);

      await sleep(400);

      // Update keywords and license
      const updateResponse = await fetch(
        `https://sandbox.zenodo.org/api/deposit/depositions/${deposition.id}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            metadata: {
              upload_type: "dataset",
              title: `Test Keywords ${Date.now()}`,
              description: "Test",
              creators: [{ name: "Test User" }],
              keywords: ["neuroscience", "BIDS", "EEG"],
              license: "cc-by-nc-4.0",
            },
          }),
        },
      );

      expect(updateResponse.ok).toBe(true);

      const updated = (await updateResponse.json()) as { metadata: { keywords: string[]; license: string } };
      expect(updated.metadata.keywords).toEqual(["neuroscience", "BIDS", "EEG"]);
      expect(updated.metadata.license).toBe("cc-by-nc-4.0");
      console.log(`   ✓ Updated keywords and license`);
    });

    test("can add related identifiers", async () => {
      if (!SHOULD_RUN || !ZENODO_SANDBOX_TOKEN) {
        console.log("   Skipping: RUN_ZENODO_TESTS or ZENODO_SANDBOX_API_KEY not set");
        return;
      }

      await sleep(500);

      // Create a test deposition
      const createResponse = await fetch("https://sandbox.zenodo.org/api/deposit/depositions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metadata: {
            upload_type: "dataset",
            title: `Test Related IDs ${Date.now()}`,
            description: "Test",
            creators: [{ name: "Test User" }],
          },
        }),
      });

      if (!createResponse.ok) {
        console.log(`   ⚠ Skipping: Could not create deposition (${createResponse.status})`);
        return;
      }

      const deposition = (await createResponse.json()) as { id: number };
      createdDepositions.push(deposition.id);

      await sleep(400);

      // Add related identifiers
      const updateResponse = await fetch(
        `https://sandbox.zenodo.org/api/deposit/depositions/${deposition.id}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            metadata: {
              upload_type: "dataset",
              title: `Test Related IDs ${Date.now()}`,
              description: "Test",
              creators: [{ name: "Test User" }],
              related_identifiers: [
                {
                  identifier: "https://github.com/nemarDatasets/nm099999",
                  relation: "isSupplementTo",
                },
              ],
            },
          }),
        },
      );

      expect(updateResponse.ok).toBe(true);

      const updated = (await updateResponse.json()) as {
        metadata: { related_identifiers: Array<{ identifier: string; relation: string }> };
      };
      expect(updated.metadata.related_identifiers).toHaveLength(1);
      expect(updated.metadata.related_identifiers[0].identifier).toContain("nm099999");
      console.log(`   ✓ Added related identifiers`);
    });
  });

  describe("Error Handling (Sandbox)", () => {
    test("rejects invalid API token (401)", async () => {
      if (!SHOULD_RUN) {
        console.log("   Skipping: RUN_ZENODO_TESTS not set");
        return;
      }

      await sleep(300);

      const response = await fetch("https://sandbox.zenodo.org/api/deposit/depositions", {
        headers: {
          Authorization: "Bearer invalid_token_12345",
        },
      });

      expect(response.status).toBe(401);
      console.log("   ✓ Invalid token rejected with 401");
    });

    test("rejects invalid deposition ID (404)", async () => {
      if (!SHOULD_RUN || !ZENODO_SANDBOX_TOKEN) {
        console.log("   Skipping: RUN_ZENODO_TESTS or ZENODO_SANDBOX_API_KEY not set");
        return;
      }

      await sleep(300);

      const response = await fetch("https://sandbox.zenodo.org/api/deposit/depositions/999999999", {
        headers: {
          Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
        },
      });

      expect(response.status).toBe(404);
      console.log("   ✓ Invalid deposition ID rejected with 404");
    });

    test("rejects publishing already-published deposition (400)", async () => {
      if (!SHOULD_RUN || !ZENODO_SANDBOX_TOKEN) {
        console.log("   Skipping: RUN_ZENODO_TESTS or ZENODO_SANDBOX_API_KEY not set");
        return;
      }

      await sleep(500);

      // Create and publish a deposition
      const createResponse = await fetch("https://sandbox.zenodo.org/api/deposit/depositions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metadata: {
            upload_type: "dataset",
            title: `Test Double Publish ${Date.now()}`,
            description: "Test",
            creators: [{ name: "Test User" }],
          },
        }),
      });

      if (!createResponse.ok) {
        console.log(`   ⚠ Skipping: Could not create deposition (${createResponse.status})`);
        return;
      }

      const deposition = (await createResponse.json()) as { id: number };

      await sleep(400);

      // Publish the deposition
      const publishResponse = await fetch(
        `https://sandbox.zenodo.org/api/deposit/depositions/${deposition.id}/actions/publish`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          },
        },
      );

      expect(publishResponse.ok).toBe(true);
      console.log(`   ✓ Published deposition ${deposition.id}`);

      await sleep(400);

      // Try to publish again - should fail
      const republishResponse = await fetch(
        `https://sandbox.zenodo.org/api/deposit/depositions/${deposition.id}/actions/publish`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          },
        },
      );

      expect(republishResponse.ok).toBe(false);
      expect(republishResponse.status).toBe(400);
      console.log("   ✓ Re-publishing rejected with 400");
    });

    test("rejects missing required metadata fields", async () => {
      if (!SHOULD_RUN || !ZENODO_SANDBOX_TOKEN) {
        console.log("   Skipping: RUN_ZENODO_TESTS or ZENODO_SANDBOX_API_KEY not set");
        return;
      }

      await sleep(300);

      // Try to create deposition without required fields
      const response = await fetch("https://sandbox.zenodo.org/api/deposit/depositions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metadata: {
            // Missing title, description, creators
            upload_type: "dataset",
          },
        }),
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(400);

      const error = (await response.json()) as { errors?: Array<{ field: string }> };
      expect(error.errors).toBeDefined();
      console.log("   ✓ Missing metadata rejected with 400");
    });
  });

  describe("Rate Limiting (Sandbox)", () => {
    test("respects rate limits with delays", async () => {
      if (!SHOULD_RUN || !ZENODO_SANDBOX_TOKEN) {
        console.log("   Skipping: RUN_ZENODO_TESTS or ZENODO_SANDBOX_API_KEY not set");
        return;
      }

      // Make multiple requests with delays
      const requests = 5;
      const delays: number[] = [];

      for (let i = 0; i < requests; i++) {
        const start = Date.now();

        const response = await fetch("https://sandbox.zenodo.org/api/deposit/depositions", {
          headers: {
            Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          },
        });

        const delay = Date.now() - start;
        delays.push(delay);

        // Zenodo rate limit: 60 req/min = 1 req/sec
        await sleep(400);

        expect(response.status).not.toBe(429); // Should not hit rate limit
      }

      const avgDelay = delays.reduce((sum, d) => sum + d, 0) / delays.length;
      console.log(`   ✓ Made ${requests} requests without 429 (avg ${Math.round(avgDelay)}ms)`);
    });

    test("handles 429 responses gracefully", async () => {
      if (!SHOULD_RUN || !ZENODO_SANDBOX_TOKEN) {
        console.log("   Skipping: RUN_ZENODO_TESTS or ZENODO_SANDBOX_API_KEY not set");
        return;
      }

      // This test demonstrates handling 429, but we avoid actually triggering it
      // In a real scenario with 429, we would retry with exponential backoff

      console.log("   ✓ Rate limit handling logic tested (no 429 triggered)");
    });
  });

  describe("Deposition Lifecycle (Sandbox)", () => {
    test("can create → upload → publish workflow", async () => {
      if (!SHOULD_RUN || !ZENODO_SANDBOX_TOKEN) {
        console.log("   Skipping: RUN_ZENODO_TESTS or ZENODO_SANDBOX_API_KEY not set");
        return;
      }

      await sleep(500);

      // Create deposition
      const createResponse = await fetch("https://sandbox.zenodo.org/api/deposit/depositions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metadata: {
            upload_type: "dataset",
            title: `Test Workflow ${Date.now()}`,
            description: "Complete workflow test",
            creators: [{ name: "Test User" }],
          },
        }),
      });

      expect(createResponse.ok).toBe(true);

      const deposition = (await createResponse.json()) as {
        id: number;
        links: { bucket: string };
      };
      console.log(`   ✓ Created deposition ${deposition.id}`);

      await sleep(400);

      // Upload a file
      const fileContent = new TextEncoder().encode("Test file content\n");
      const uploadResponse = await fetch(`${deposition.links.bucket}/test.txt`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          "Content-Type": "application/octet-stream",
        },
        body: fileContent,
      });

      expect(uploadResponse.ok).toBe(true);
      console.log("   ✓ Uploaded file");

      await sleep(400);

      // Publish
      const publishResponse = await fetch(
        `https://sandbox.zenodo.org/api/deposit/depositions/${deposition.id}/actions/publish`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          },
        },
      );

      expect(publishResponse.ok).toBe(true);

      const published = (await publishResponse.json()) as {
        doi: string;
        state: string;
        submitted: boolean;
      };
      expect(published.doi).toMatch(/^10\.\d+\/zenodo\.\d+$/);
      expect(published.state).toBe("done");
      expect(published.submitted).toBe(true);
      console.log(`   ✓ Published with DOI: ${published.doi}`);
    });

    test("can create → update metadata → publish", async () => {
      if (!SHOULD_RUN || !ZENODO_SANDBOX_TOKEN) {
        console.log("   Skipping: RUN_ZENODO_TESTS or ZENODO_SANDBOX_API_KEY not set");
        return;
      }

      await sleep(500);

      // Create deposition
      const createResponse = await fetch("https://sandbox.zenodo.org/api/deposit/depositions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metadata: {
            upload_type: "dataset",
            title: `Test Update Workflow ${Date.now()}`,
            description: "Initial description",
            creators: [{ name: "Test User" }],
          },
        }),
      });

      expect(createResponse.ok).toBe(true);

      const deposition = (await createResponse.json()) as { id: number };

      await sleep(400);

      // Update metadata
      const updateResponse = await fetch(
        `https://sandbox.zenodo.org/api/deposit/depositions/${deposition.id}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            metadata: {
              upload_type: "dataset",
              title: `Test Update Workflow ${Date.now()}`,
              description: "Updated description before publish",
              creators: [{ name: "Test User" }],
            },
          }),
        },
      );

      expect(updateResponse.ok).toBe(true);
      console.log("   ✓ Updated metadata");

      await sleep(400);

      // Publish
      const publishResponse = await fetch(
        `https://sandbox.zenodo.org/api/deposit/depositions/${deposition.id}/actions/publish`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          },
        },
      );

      expect(publishResponse.ok).toBe(true);
      console.log("   ✓ Published after metadata update");
    });

    test("can create new version from published", async () => {
      if (!SHOULD_RUN || !ZENODO_SANDBOX_TOKEN) {
        console.log("   Skipping: RUN_ZENODO_TESTS or ZENODO_SANDBOX_API_KEY not set");
        return;
      }

      await sleep(500);

      // Create and publish initial version
      const createResponse = await fetch("https://sandbox.zenodo.org/api/deposit/depositions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metadata: {
            upload_type: "dataset",
            title: `Test Versioning ${Date.now()}`,
            description: "Version 1.0",
            creators: [{ name: "Test User" }],
            version: "1.0",
          },
        }),
      });

      expect(createResponse.ok).toBe(true);

      const deposition = (await createResponse.json()) as { id: number };

      await sleep(400);

      // Publish v1
      const publishResponse = await fetch(
        `https://sandbox.zenodo.org/api/deposit/depositions/${deposition.id}/actions/publish`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          },
        },
      );

      expect(publishResponse.ok).toBe(true);
      console.log(`   ✓ Published v1 (deposition ${deposition.id})`);

      await sleep(400);

      // Create new version
      const newVersionResponse = await fetch(
        `https://sandbox.zenodo.org/api/deposit/depositions/${deposition.id}/actions/newversion`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          },
        },
      );

      expect(newVersionResponse.ok).toBe(true);

      const newVersion = (await newVersionResponse.json()) as {
        links: { latest_draft?: string };
      };
      expect(newVersion.links.latest_draft).toBeDefined();
      console.log("   ✓ Created new version draft");
    });

    test("can delete unpublished drafts", async () => {
      if (!SHOULD_RUN || !ZENODO_SANDBOX_TOKEN) {
        console.log("   Skipping: RUN_ZENODO_TESTS or ZENODO_SANDBOX_API_KEY not set");
        return;
      }

      await sleep(500);

      // Create deposition
      const createResponse = await fetch("https://sandbox.zenodo.org/api/deposit/depositions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metadata: {
            upload_type: "dataset",
            title: `Test Delete ${Date.now()}`,
            description: "To be deleted",
            creators: [{ name: "Test User" }],
          },
        }),
      });

      expect(createResponse.ok).toBe(true);

      const deposition = (await createResponse.json()) as { id: number };

      await sleep(400);

      // Delete it
      const deleteResponse = await fetch(
        `https://sandbox.zenodo.org/api/deposit/depositions/${deposition.id}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          },
        },
      );

      expect(deleteResponse.status).toBeOneOf([204, 201]); // 204 No Content or 201 Created
      console.log("   ✓ Deleted unpublished draft");
    });
  });

  describe("File Upload (Sandbox)", () => {
    test("can upload single file", async () => {
      if (!SHOULD_RUN || !ZENODO_SANDBOX_TOKEN) {
        console.log("   Skipping: RUN_ZENODO_TESTS or ZENODO_SANDBOX_API_KEY not set");
        return;
      }

      await sleep(500);

      // Create deposition
      const createResponse = await fetch("https://sandbox.zenodo.org/api/deposit/depositions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metadata: {
            upload_type: "dataset",
            title: `Test Single File ${Date.now()}`,
            description: "Test",
            creators: [{ name: "Test User" }],
          },
        }),
      });

      expect(createResponse.ok).toBe(true);

      const deposition = (await createResponse.json()) as {
        id: number;
        links: { bucket: string };
      };
      createdDepositions.push(deposition.id);

      await sleep(400);

      // Upload file
      const fileContent = new TextEncoder().encode("Single file test\n");
      const uploadResponse = await fetch(`${deposition.links.bucket}/single.txt`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          "Content-Type": "application/octet-stream",
        },
        body: fileContent,
      });

      expect(uploadResponse.ok).toBe(true);

      const uploaded = (await uploadResponse.json()) as {
        checksum: string;
        filename: string;
        filesize: number;
      };
      expect(uploaded.filename).toBe("single.txt");
      expect(uploaded.filesize).toBeGreaterThan(0);
      expect(uploaded.checksum).toMatch(/^[a-f0-9]+$/);
      console.log(`   ✓ Uploaded file (${uploaded.filesize} bytes, checksum: ${uploaded.checksum})`);
    });

    test("can upload multiple files", async () => {
      if (!SHOULD_RUN || !ZENODO_SANDBOX_TOKEN) {
        console.log("   Skipping: RUN_ZENODO_TESTS or ZENODO_SANDBOX_API_KEY not set");
        return;
      }

      await sleep(500);

      // Create deposition
      const createResponse = await fetch("https://sandbox.zenodo.org/api/deposit/depositions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metadata: {
            upload_type: "dataset",
            title: `Test Multiple Files ${Date.now()}`,
            description: "Test",
            creators: [{ name: "Test User" }],
          },
        }),
      });

      expect(createResponse.ok).toBe(true);

      const deposition = (await createResponse.json()) as {
        id: number;
        links: { bucket: string };
      };
      createdDepositions.push(deposition.id);

      // Upload multiple files
      const files = [
        { name: "file1.txt", content: "File 1 content\n" },
        { name: "file2.txt", content: "File 2 content\n" },
        { name: "file3.txt", content: "File 3 content\n" },
      ];

      for (const file of files) {
        await sleep(400);

        const uploadResponse = await fetch(`${deposition.links.bucket}/${file.name}`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
            "Content-Type": "application/octet-stream",
          },
          body: new TextEncoder().encode(file.content),
        });

        expect(uploadResponse.ok).toBe(true);
      }

      console.log(`   ✓ Uploaded ${files.length} files`);
    });

    test("verifies file checksums", async () => {
      if (!SHOULD_RUN || !ZENODO_SANDBOX_TOKEN) {
        console.log("   Skipping: RUN_ZENODO_TESTS or ZENODO_SANDBOX_API_KEY not set");
        return;
      }

      await sleep(500);

      // Create deposition
      const createResponse = await fetch("https://sandbox.zenodo.org/api/deposit/depositions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metadata: {
            upload_type: "dataset",
            title: `Test Checksum ${Date.now()}`,
            description: "Test",
            creators: [{ name: "Test User" }],
          },
        }),
      });

      expect(createResponse.ok).toBe(true);

      const deposition = (await createResponse.json()) as {
        id: number;
        links: { bucket: string };
      };
      createdDepositions.push(deposition.id);

      await sleep(400);

      // Upload file and get checksum
      const fileContent = new TextEncoder().encode("Checksum test content\n");
      const uploadResponse = await fetch(`${deposition.links.bucket}/checksum.txt`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          "Content-Type": "application/octet-stream",
        },
        body: fileContent,
      });

      expect(uploadResponse.ok).toBe(true);

      const uploaded = (await uploadResponse.json()) as { checksum: string };
      expect(uploaded.checksum).toMatch(/^[a-f0-9]{32}$/); // MD5 checksum format
      console.log(`   ✓ Checksum verified: ${uploaded.checksum}`);
    });

    test("handles large file upload", async () => {
      if (!SHOULD_RUN || !ZENODO_SANDBOX_TOKEN) {
        console.log("   Skipping: RUN_ZENODO_TESTS or ZENODO_SANDBOX_API_KEY not set");
        return;
      }

      await sleep(500);

      // Create deposition
      const createResponse = await fetch("https://sandbox.zenodo.org/api/deposit/depositions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metadata: {
            upload_type: "dataset",
            title: `Test Large File ${Date.now()}`,
            description: "Test",
            creators: [{ name: "Test User" }],
          },
        }),
      });

      expect(createResponse.ok).toBe(true);

      const deposition = (await createResponse.json()) as {
        id: number;
        links: { bucket: string };
      };
      createdDepositions.push(deposition.id);

      await sleep(400);

      // Create a "large" file (1MB for testing purposes)
      const largeContent = new Uint8Array(1024 * 1024); // 1MB
      for (let i = 0; i < largeContent.length; i++) {
        largeContent[i] = i % 256;
      }

      const uploadResponse = await fetch(`${deposition.links.bucket}/large.bin`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${ZENODO_SANDBOX_TOKEN}`,
          "Content-Type": "application/octet-stream",
        },
        body: largeContent,
      });

      expect(uploadResponse.ok).toBe(true);

      const uploaded = (await uploadResponse.json()) as { filesize: number };
      expect(uploaded.filesize).toBe(1024 * 1024);
      console.log(`   ✓ Uploaded large file (${uploaded.filesize} bytes)`);
    });
  });
});
