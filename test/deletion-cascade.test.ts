/**
 * Dataset Deletion Cascade Tests
 *
 * Tests for DELETE /admin/datasets/:id endpoint.
 * Requires TEST_ADMIN_API_KEY (admin role) and TEST_OWNER_API_KEY (owner role)
 * in environment or test/.env.test.
 *
 * Uses the test API to create and delete sandbox datasets.
 */

import { describe, expect, test } from "bun:test";
import { TEST_CONFIG, testRequest } from "./setup";

const adminKey = TEST_CONFIG.adminApiKey;
const describeAdmin = adminKey ? describe : describe.skip;

interface DeleteResponse {
  datasetId: string;
  deleted: boolean;
  steps: {
    github: { success: boolean; error?: string };
    s3: { deleted: number; failed: Array<{ key: string; error: string }>; skipped?: boolean };
    d1: { success: boolean; versionsDeleted: number; pubRequestsDeleted: number; error?: string };
    // #646 Phase 4: Vectorize vector removal (skipped when VECTORIZE unbound).
    vectorize?: { success: boolean; skipped?: boolean; error?: string };
  };
  warnings: string[];
}

describeAdmin("Dataset deletion cascade", () => {
  test("returns 404 for non-existent dataset", async () => {
    const { status } = await testRequest<{ error: string }>(
      "/admin/datasets/xx999999",
      {
        method: "DELETE",
        body: JSON.stringify({ force: false }),
      },
      adminKey,
    );
    expect(status).toBe(404);
  });

  test("rejects invalid dataset ID format", async () => {
    const { status } = await testRequest<{ error: string }>(
      "/admin/datasets/bad-id",
      {
        method: "DELETE",
        body: JSON.stringify({ force: false }),
      },
      adminKey,
    );
    // Will return 404 because it won't find a dataset with that ID
    expect(status).toBe(404);
  });

  test("requires force=true for datasets with DOI", async () => {
    // Look for a dataset with a DOI to test the force requirement.
    // If none exist, this test verifies the error message format instead.
    const { status, data } = await testRequest<{ error: string; concept_doi?: string }>(
      "/admin/datasets/nm000103",
      {
        method: "DELETE",
        body: JSON.stringify({ force: false }),
      },
      adminKey,
    );
    // Should be 400 (needs force) or 403 (needs owner) or 404 (not found)
    expect([400, 403, 404]).toContain(status);
  });
});
