/**
 * `nemar dataset publish request` right after an upload (issue #1646): the two
 * block reasons that mean "BIDS validation has not concluded", as opposed to
 * "it failed".
 *
 * A refusal for either one is a pending state, not an error, so the unit tests
 * here pin which refusals count. The command's own behavior (exit code, text)
 * is driven through the real CLI in test/publish-request-pending-cli.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { ApiError } from "../src/lib/api/errors";
import {
  CI_PENDING_BLOCK_REASONS,
  ciPendingHeadline,
  ciPendingHint,
  isCiPendingBlock,
} from "../src/lib/publish-pending";

function refusal(reason: string | undefined, status = 422): ApiError {
  return new ApiError(status, "BIDS validation has not run yet.", undefined, undefined, reason);
}

describe("isCiPendingBlock", () => {
  test("only the two CI-not-concluded reasons count", () => {
    expect(isCiPendingBlock(refusal("bids_validation_pending"))).toBe(true);
    expect(isCiPendingBlock(refusal("bids_validation_in_progress"))).toBe(true);
    expect(isCiPendingBlock(refusal("bids_validation_failed"))).toBe(false);
    expect(isCiPendingBlock(refusal("min_requirements_failed"))).toBe(false);
    expect(isCiPendingBlock(refusal("identifier_screen_findings"))).toBe(false);
    expect(isCiPendingBlock(refusal(undefined))).toBe(false);
    expect(isCiPendingBlock(new ApiError(409, "already requested"))).toBe(false);
    expect(isCiPendingBlock(new Error("x"))).toBe(false);
    expect(isCiPendingBlock(undefined)).toBe(false);
  });

  test("the status matters as well as the reason", () => {
    // The reason comes from a 422 body. The same word on any other status is
    // not the refusal this recognizes, so it keeps its error treatment.
    expect(isCiPendingBlock(refusal("bids_validation_pending", 500))).toBe(false);
    expect(isCiPendingBlock(refusal("bids_validation_in_progress", 403))).toBe(false);
  });

  test("the declared set is exactly the two pending reasons", () => {
    expect([...CI_PENDING_BLOCK_REASONS].sort()).toEqual([
      "bids_validation_in_progress",
      "bids_validation_pending",
    ]);
  });
});

describe("ciPendingHeadline", () => {
  test("says it is recorded, and tells not-started from running in one clause", () => {
    expect(ciPendingHeadline("bids_validation_pending")).toBe(
      "Request recorded: BIDS validation has not started yet.",
    );
    expect(ciPendingHeadline("bids_validation_in_progress")).toBe(
      "Request recorded: BIDS validation is still running.",
    );
  });
});

describe("ciPendingHint", () => {
  test("says it continues on its own, promises no time, and names both commands", () => {
    const text = ciPendingHint("nm000358").join("\n");
    expect(text).toContain("re-checks it automatically");
    expect(text).toContain("'nemar dataset ci nm000358'");
    expect(text).toContain("'nemar dataset publish request nm000358'");
    // No waiting flag exists any more, and no duration is promised.
    expect(text).not.toContain("--wait");
    expect(text).not.toMatch(/\b(\d+\s*(s|sec|seconds?|min|minutes?|hours?)|daily|hourly)\b/i);
  });
});
