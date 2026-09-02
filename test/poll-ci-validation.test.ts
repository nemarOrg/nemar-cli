/**
 * Unit test for pollCiValidation — the CLI-side polling state machine that
 * replaced the in-Worker sleep in issue #472.
 *
 * Covers the branches the official PR review (PR #493) flagged as untested:
 *  1. Early stop on missing.length === 0 — single probe.
 *  2. Early stop on errors.length > 0 — single probe, retrying is wasted.
 *  3. Loop exhaustion returns the last result (missing still > 0 after both
 *     attempts → caller surfaces the warning).
 *  4. Probe exception returns null (network hiccup; deploy already succeeded,
 *     so we skip the inline warning rather than fail the command).
 *  5. The second probe runs only when the first reports missing-but-no-errors.
 *
 * No mocks (per project policy). The probe is a real function we pass in via
 * the dependency-injected parameter on `pollCiValidation`. Delays are zeroed
 * so the suite stays fast.
 */

import { describe, expect, test } from "bun:test";
import "./setup";
import { type ValidationProbe, pollCiValidation } from "../src/commands/admin";

/** Build a probe that returns a queued sequence of results, one per call. */
function queuedProbe(
  results: Array<{ valid: string[]; missing: string[]; errors: string[] } | "throw">,
): { probe: ValidationProbe; calls: () => number } {
  let i = 0;
  const probe: ValidationProbe = async () => {
    const next = results[i++];
    if (!next || next === "throw") {
      throw new Error("simulated network failure");
    }
    return next;
  };
  return { probe, calls: () => i };
}

describe("pollCiValidation", () => {
  test("returns immediately when first probe reports all-clear (missing=[], errors=[])", async () => {
    const { probe, calls } = queuedProbe([{ valid: ["a.yml", "b.yml"], missing: [], errors: [] }]);
    const result = await pollCiValidation("nm099999", probe, [0, 0]);
    expect(result).not.toBeNull();
    expect(result?.missing).toEqual([]);
    expect(result?.errors).toEqual([]);
    expect(result?.valid).toEqual(["a.yml", "b.yml"]);
    // One probe only — retry skipped on success.
    expect(calls()).toBe(1);
  });

  test("returns immediately when probe reports errors (retry wouldn't help)", async () => {
    const { probe, calls } = queuedProbe([{ valid: [], missing: [], errors: ["GitHub API 500"] }]);
    const result = await pollCiValidation("nm099999", probe, [0, 0]);
    expect(result).not.toBeNull();
    expect(result?.errors).toEqual(["GitHub API 500"]);
    expect(calls()).toBe(1);
  });

  test("retries once when first probe reports missing-but-no-errors (indexing lag)", async () => {
    // First probe sees indexing lag (1 missing, no errors). Second probe
    // sees the workflow indexed.
    const { probe, calls } = queuedProbe([
      { valid: ["a.yml"], missing: ["b.yml"], errors: [] },
      { valid: ["a.yml", "b.yml"], missing: [], errors: [] },
    ]);
    const result = await pollCiValidation("nm099999", probe, [0, 0]);
    expect(result?.missing).toEqual([]);
    expect(calls()).toBe(2);
  });

  test("returns last result when both probes report missing (genuine parse error)", async () => {
    // Both probes see the same missing workflow → likely a real YAML error,
    // not indexing lag. Caller surfaces the warning.
    const { probe, calls } = queuedProbe([
      { valid: ["a.yml"], missing: ["broken.yml"], errors: [] },
      { valid: ["a.yml"], missing: ["broken.yml"], errors: [] },
    ]);
    const result = await pollCiValidation("nm099999", probe, [0, 0]);
    expect(result).not.toBeNull();
    expect(result?.missing).toEqual(["broken.yml"]);
    expect(calls()).toBe(2);
  });

  test("returns null when the probe itself throws (network hiccup)", async () => {
    const { probe, calls } = queuedProbe(["throw"]);
    const result = await pollCiValidation("nm099999", probe, [0, 0]);
    expect(result).toBeNull();
    // Threw on the first probe — we don't retry on transport failure.
    expect(calls()).toBe(1);
  });

  test("respects the configured backoff cadence (count of delays = max probes)", async () => {
    // Three delay slots → up to three probes if all keep reporting missing.
    const { probe, calls } = queuedProbe([
      { valid: [], missing: ["a.yml"], errors: [] },
      { valid: [], missing: ["a.yml"], errors: [] },
      { valid: [], missing: ["a.yml"], errors: [] },
    ]);
    const result = await pollCiValidation("nm099999", probe, [0, 0, 0]);
    expect(result?.missing).toEqual(["a.yml"]);
    expect(calls()).toBe(3);
  });
});
