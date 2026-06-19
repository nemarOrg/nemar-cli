/**
 * Unit tests for the blocked-publication-request re-evaluation decision (#428).
 *
 * evaluateBlockedBidsValidation is the pure core of the daily cron sweep that
 * un-sticks publication requests whose BIDS validation CI resolved after the
 * request was blocked. Pinning the decision matrix here guards against a
 * future refactor silently re-opening the "blocked forever" bug (13 of
 * bruaristimunha's requests sat blocked for weeks). The D1/GitHub wiring in
 * sweepBlockedBidsValidationRequests is integration territory; this file owns
 * the transition logic.
 */

import { describe, expect, test } from "bun:test";
import {
  BIDS_VALIDATION_BLOCK_REASONS,
  evaluateBlockedBidsValidation,
} from "../backend/src/services/publication-sweep";

describe("evaluateBlockedBidsValidation (#428)", () => {
  test("no runs yet -> keep blocked (still pending)", () => {
    expect(evaluateBlockedBidsValidation({ hasRuns: false, latestConclusion: null })).toEqual({
      kind: "keep",
    });
  });

  test("latest run success -> unblock", () => {
    expect(evaluateBlockedBidsValidation({ hasRuns: true, latestConclusion: "success" })).toEqual({
      kind: "unblock",
    });
  });

  test("latest run failure -> reblock as bids_validation_failed", () => {
    expect(evaluateBlockedBidsValidation({ hasRuns: true, latestConclusion: "failure" })).toEqual({
      kind: "reblock",
      blockReason: "bids_validation_failed",
    });
  });

  test("latest run in progress (conclusion null) -> keep blocked", () => {
    expect(evaluateBlockedBidsValidation({ hasRuns: true, latestConclusion: null })).toEqual({
      kind: "keep",
    });
  });

  test("inconclusive terminal states (cancelled/skipped/timed_out) -> keep blocked", () => {
    for (const c of ["cancelled", "skipped", "timed_out", "action_required", "neutral"]) {
      expect(evaluateBlockedBidsValidation({ hasRuns: true, latestConclusion: c })).toEqual({
        kind: "keep",
      });
    }
  });

  test("block-reason set matches the readiness check's reasons", () => {
    // The sweep must scan exactly the block_reasons the publish-request path can
    // set, or it would leave some requests stuck. Pin the contract.
    expect([...BIDS_VALIDATION_BLOCK_REASONS].sort()).toEqual([
      "bids_validation_failed",
      "bids_validation_in_progress",
      "bids_validation_pending",
    ]);
  });
});
