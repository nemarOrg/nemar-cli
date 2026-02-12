/**
 * GitHub Repository Deletion Tests
 *
 * Tests for deleteRepository in github.ts.
 * Requires GITHUB_ADMIN_PAT in environment (with delete_repo scope).
 *
 * These tests use non-existent repo names to verify idempotent behavior
 * without actually deleting any real repositories.
 */

import { describe, expect, test } from "bun:test";
import { deleteRepository } from "../backend/src/services/github";

function getGitHubPat(): string | null {
  return process.env.GITHUB_ADMIN_PAT || null;
}

const pat = getGitHubPat();
const describeGH = pat ? describe : describe.skip;

describeGH("GitHub deletion - deleteRepository", () => {
  test("returns true for non-existent repo (idempotent)", async () => {
    const result = await deleteRepository("xx-nonexistent-test-repo-99999", pat as string);
    expect(result).toBe(true);
  });

  test("throws for invalid PAT", async () => {
    await expect(deleteRepository("xx000001", "ghp_invalid_token_12345")).rejects.toThrow(
      "Failed to delete repo",
    );
  });
});
