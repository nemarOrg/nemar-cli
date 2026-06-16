/**
 * Tests for the pure decision functions behind the async version-DOI publish
 * (epic #749, Phase 2 / #751):
 *   - shouldShortCircuitInflightPublish: dedupe a duplicate POST only while a
 *     prior attempt is still in flight (accepted | dispatched).
 *   - versionDoiPollOutcome: the CI poller's status -> decision map.
 *
 * Pure functions, no I/O, no mocks.
 */

import { describe, expect, test } from "bun:test";
import {
  shouldShortCircuitInflightPublish,
  versionDoiPollOutcome,
} from "../src/routes/webhooks";

describe("shouldShortCircuitInflightPublish", () => {
  test("no existing row -> start a fresh publish", () => {
    expect(shouldShortCircuitInflightPublish(null)).toBe(false);
  });

  test("in-flight (accepted | dispatched) -> short-circuit to avoid a duplicate job", () => {
    expect(shouldShortCircuitInflightPublish({ status: "accepted" })).toBe(true);
    expect(shouldShortCircuitInflightPublish({ status: "dispatched" })).toBe(true);
  });

  test("terminal (ready | failed) -> allow a deliberate re-drive", () => {
    expect(shouldShortCircuitInflightPublish({ status: "ready" })).toBe(false);
    expect(shouldShortCircuitInflightPublish({ status: "failed" })).toBe(false);
  });
});

describe("versionDoiPollOutcome", () => {
  test("ready -> success", () => {
    expect(versionDoiPollOutcome("ready")).toBe("success");
  });

  test("failed -> fail", () => {
    expect(versionDoiPollOutcome("failed")).toBe("fail");
  });

  test("non-terminal / unknown / nullish -> wait", () => {
    for (const s of ["accepted", "dispatched", "unknown", "", null, undefined]) {
      expect(versionDoiPollOutcome(s)).toBe("wait");
    }
  });
});
