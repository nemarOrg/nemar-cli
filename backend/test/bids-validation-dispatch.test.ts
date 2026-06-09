/**
 * Pure tests for the run-bids-validation dispatch payload (epic #713, Phase 6).
 * No network, no mocks: assert the shape the central .github workflow expects.
 */

import { describe, expect, test } from "bun:test";
import validatorPin from "../../validator-version.json" with { type: "json" };
import { buildBidsValidationDispatch } from "../src/services/github";

describe("buildBidsValidationDispatch", () => {
  test("builds the run-bids-validation event with full client_payload", () => {
    const d = buildBidsValidationDispatch("nm000157", "deadbeefcafe", "main");
    expect(d.event_type).toBe("run-bids-validation");
    expect(d.client_payload).toEqual({
      dataset_id: "nm000157",
      ref: "main",
      head_sha: "deadbeefcafe",
      pr_number: "",
      validator_version: validatorPin.version,
    });
  });

  test("defaults ref to main", () => {
    const d = buildBidsValidationDispatch("on007139", "abc123");
    expect(d.client_payload.ref).toBe("main");
    expect(d.client_payload.head_sha).toBe("abc123");
  });

  test("pins validator_version to the CLI's validator-version.json", () => {
    const d = buildBidsValidationDispatch("nm000132", "sha");
    expect(d.client_payload.validator_version).toBe(validatorPin.version);
    // pr_number is always empty for branch-level revalidation
    expect(d.client_payload.pr_number).toBe("");
  });
});
