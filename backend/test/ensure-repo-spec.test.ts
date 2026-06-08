/**
 * Unit tests for the green-gate predicate (epic #713, phase #717).
 * Pure, no network, no mocks: assert `isRequiredCheckGreen` — the predicate
 * that decides whether `ensureRepoToSpec` applies branch protection. The full
 * ensureRepoToSpec composition is exercised end-to-end by the live flows; here
 * we pin the gate that prevents bricking a repo whose check is red/missing.
 */

import { describe, expect, test } from "bun:test";
import { NEMAR_APP_ID, type RequiredCheck, isRequiredCheckGreen } from "../src/services/github";

const BIDS: RequiredCheck = { context: "Run BIDS Validation", integration_id: NEMAR_APP_ID };

function run(name: string, conclusion: string | null, app_id: number | null = NEMAR_APP_ID) {
  return { name, conclusion, app_id };
}

describe("isRequiredCheckGreen", () => {
  test("matching App check-run with success is green", () => {
    expect(isRequiredCheckGreen(BIDS, [run("Run BIDS Validation", "success")], [])).toBe(true);
  });

  test("matching check-run with failure is not green", () => {
    expect(isRequiredCheckGreen(BIDS, [run("Run BIDS Validation", "failure")], [])).toBe(false);
  });

  test("missing check is not green (fail-closed)", () => {
    expect(isRequiredCheckGreen(BIDS, [run("something else", "success")], [])).toBe(false);
  });

  test("in-progress check (null conclusion) is not green", () => {
    expect(isRequiredCheckGreen(BIDS, [run("Run BIDS Validation", null)], [])).toBe(false);
  });

  test("neutral and skipped count as green", () => {
    expect(isRequiredCheckGreen(BIDS, [run("Run BIDS Validation", "neutral")], [])).toBe(true);
    expect(isRequiredCheckGreen(BIDS, [run("Run BIDS Validation", "skipped")], [])).toBe(true);
  });

  test("wrong integration_id does not satisfy a pinned check (spoof-resistant)", () => {
    expect(isRequiredCheckGreen(BIDS, [run("Run BIDS Validation", "success", 9999)], [])).toBe(
      false,
    );
  });

  test("unpinned check matches by name regardless of source", () => {
    const vc: RequiredCheck = { context: "version-check" };
    expect(isRequiredCheckGreen(vc, [run("version-check", "success", 15368)], [])).toBe(true);
  });

  test("falls back to a legacy commit status with state=success", () => {
    const legacy: RequiredCheck = { context: "bids-validation" };
    expect(
      isRequiredCheckGreen(legacy, [], [{ context: "bids-validation", state: "success" }]),
    ).toBe(true);
    expect(
      isRequiredCheckGreen(legacy, [], [{ context: "bids-validation", state: "failure" }]),
    ).toBe(false);
  });
});
