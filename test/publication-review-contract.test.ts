/**
 * The publication review's contract (ADR 0101), and the shared pieces it stands on.
 *
 * Pure: no database and no network. Real parser, real reasons table, real renderer, driven with
 * the inputs a hostile job, a hostile depositor or a hostile model controls.
 */

import { describe, expect, test } from "bun:test";
import * as prompt from "../scripts/ci/pr-review-prompt";
import * as prReview from "../shared/pr-review";
import * as untrusted from "../shared/untrusted-text";

describe("the text tools moved to shared/untrusted-text.ts", () => {
  test("the pull-request review re-exports the same sanitizer, not a copy", () => {
    expect(prReview.sanitizeNote).toBe(untrusted.sanitizeNote);
    expect(untrusted.DEFAULT_NOTE_MAX).toBe(prReview.NOTE_MAX);
  });

  test("the prompt module re-exports the same fence and tidy functions, not copies", () => {
    expect(prompt.fence).toBe(untrusted.fence);
    expect(prompt.tidy).toBe(untrusted.tidy);
    expect(prompt.tidyPath).toBe(untrusted.tidyPath);
  });
});
