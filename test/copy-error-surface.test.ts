/**
 * git-annex copy-error surfacing (#886, epic #896).
 *
 * git-annex writes the real S3 failure (e.g. 400 EntityTooLarge on a >5 GB
 * single-part PUT) to STDOUT, not stderr. copyToAnnexRemote used to surface only
 * stderr.trim(), leaving the user with a generic "Failed to copy to remote".
 * extractCopyError must recover the real cause from stdout when stderr is empty.
 */

import { describe, expect, test } from "bun:test";
import { extractCopyError } from "../src/lib/git-annex/transfer";

describe("extractCopyError", () => {
  test("prefers stderr when present", () => {
    expect(extractCopyError("copy foo ok\n", "fatal: some git error")).toBe(
      "fatal: some git error",
    );
  });

  test("recovers the EntityTooLarge cause from stdout when stderr is empty", () => {
    const stdout = [
      "copy sub-01/ieeg/sub-01_task-rest_ieeg.eeg (to nemar-s3...)",
      "  <S3 error: EntityTooLarge: Your proposed upload exceeds the maximum allowed size>",
      "failed",
      "git-annex: copy: 1 failed",
    ].join("\n");
    const msg = extractCopyError(stdout, "");
    expect(msg).toContain("EntityTooLarge");
    expect(msg).toContain("failed");
    expect(msg).not.toBe("Failed to copy to remote");
  });

  test("falls back to the stdout tail when no line matches the error patterns", () => {
    const stdout = Array.from({ length: 20 }, (_, i) => `progress line ${i}`).join("\n");
    const msg = extractCopyError(stdout, "");
    // last 8 lines, not the whole 20-line blob
    expect(msg).toContain("progress line 19");
    expect(msg).toContain("progress line 12");
    expect(msg).not.toContain("progress line 11");
  });

  test("returns the generic message only when there is nothing to surface", () => {
    expect(extractCopyError("", "")).toBe("Failed to copy to remote");
    expect(extractCopyError("   \n  \n", "   ")).toBe("Failed to copy to remote");
  });
});
