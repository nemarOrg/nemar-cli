/**
 * Unit tests for the pure decision helpers in src/lib/import-openneuro.ts.
 *
 * The orchestration function `importOpenNeuro()` itself can only be tested
 * end-to-end through `nemarDatasets/.github/workflows/onboard-openneuro.yml`
 * (no-mocks policy + live GitHub / S3 / backend dependencies). What CAN be
 * tested here is `decideSkipCiCheck`, the small pure function that gates
 * publication approval against the (deployed?, poll outcome, trust-upstream)
 * matrix. Wrong branch here publishes unvalidated data, so the matrix is
 * worth covering exhaustively.
 */

import { describe, expect, test } from "bun:test";
import { decideSkipCiCheck } from "../src/lib/import-openneuro";

describe("decideSkipCiCheck", () => {
  test("CI not deployed always aborts, regardless of --trust-upstream", () => {
    for (const trustUpstream of [true, false]) {
      const d = decideSkipCiCheck({ ciDeployed: false, poll: null, trustUpstream });
      expect(d.skipCiCheck).toBe(false);
      expect(d.abortReason).toBeDefined();
      expect(d.abortReason).toContain("CI workflows did not deploy");
    }
  });

  test("poll found: defer to ci_check (skipCiCheck=false, no abort)", () => {
    for (const trustUpstream of [true, false]) {
      const d = decideSkipCiCheck({
        ciDeployed: true,
        poll: { kind: "found" },
        trustUpstream,
      });
      expect(d.skipCiCheck).toBe(false);
      expect(d.abortReason).toBeUndefined();
    }
  });

  test("poll timeout + --trust-upstream: skip ci check (the #431 fast-path)", () => {
    const d = decideSkipCiCheck({
      ciDeployed: true,
      poll: { kind: "timeout" },
      trustUpstream: true,
    });
    expect(d.skipCiCheck).toBe(true);
    expect(d.abortReason).toBeUndefined();
  });

  test("poll timeout WITHOUT --trust-upstream: abort, do not silently skip", () => {
    const d = decideSkipCiCheck({
      ciDeployed: true,
      poll: { kind: "timeout" },
      trustUpstream: false,
    });
    expect(d.skipCiCheck).toBe(false);
    expect(d.abortReason).toBeDefined();
    expect(d.abortReason).toContain("Re-run with --trust-upstream");
  });

  test("every poll errored: ALWAYS abort, even under --trust-upstream", () => {
    // This is the trust-hole #431 was meant to close: we never actually
    // observed validation state, so --trust-upstream must not approve.
    for (const trustUpstream of [true, false]) {
      const d = decideSkipCiCheck({
        ciDeployed: true,
        poll: { kind: "error", lastError: new Error("HTTP 401: Unauthorized") },
        trustUpstream,
      });
      expect(d.skipCiCheck).toBe(false);
      expect(d.abortReason).toBeDefined();
      expect(d.abortReason).toContain("Every BIDS validation poll attempt failed");
      expect(d.abortReason).toContain("HTTP 401");
    }
  });

  test("error branch stringifies non-Error throws", () => {
    const d = decideSkipCiCheck({
      ciDeployed: true,
      poll: { kind: "error", lastError: "raw string thrown" },
      trustUpstream: true,
    });
    expect(d.abortReason).toContain("raw string thrown");
  });

  test("null poll (CI not deployed branch never polled): handled by ciDeployed=false guard", () => {
    // The orchestrator passes poll=null only when ciDeployed=false; that path
    // is covered above. If callers somehow pass poll=null with ciDeployed=true
    // we treat that as "no observation needed" and approve normally.
    const d = decideSkipCiCheck({
      ciDeployed: true,
      poll: null,
      trustUpstream: false,
    });
    expect(d.skipCiCheck).toBe(false);
    expect(d.abortReason).toBeUndefined();
  });
});
