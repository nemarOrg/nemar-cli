/**
 * Unit tests for the branch-ruleset primitive (epic #713, phase #716).
 *
 * Pure, no network, no mocks: they assert the shape of the ruleset payload that
 * `ensureBranchRuleset` sends to GitHub, and the per-repo required-check
 * derivation. The end-to-end behavior (does a detached App check satisfy the
 * pinned required context?) is verified separately by the live nm099999 proof,
 * not here.
 */

import { describe, expect, test } from "bun:test";
import {
  BRANCH_RULESET_NAME,
  NEMAR_APP_ID,
  buildBranchRulesetPayload,
  deriveContexts,
} from "../src/services/github";

function ruleOfType(payload: ReturnType<typeof buildBranchRulesetPayload>, type: string) {
  return payload.rules.find((r) => (r as { type: string }).type === type) as
    | { type: string; parameters?: Record<string, unknown> }
    | undefined;
}

describe("buildBranchRulesetPayload", () => {
  const payload = buildBranchRulesetPayload({
    checks: [{ context: "Run BIDS Validation", integration_id: NEMAR_APP_ID }],
  });

  test("targets the branch ruleset with the canonical name and tracks the default branch", () => {
    expect(payload.name).toBe(BRANCH_RULESET_NAME);
    expect(payload.target).toBe("branch");
    expect(payload.enforcement).toBe("active");
    expect(payload.conditions.ref_name.include).toEqual(["~DEFAULT_BRANCH"]);
  });

  test("PR rule requires zero approving reviews (solo author self-merge)", () => {
    const pr = ruleOfType(payload, "pull_request");
    expect(pr).toBeDefined();
    expect(pr?.parameters?.required_approving_review_count).toBe(0);
  });

  test("a pinned check carries its integration_id; do_not_enforce_on_create is set", () => {
    const checks = ruleOfType(payload, "required_status_checks");
    expect(checks).toBeDefined();
    expect(checks?.parameters?.required_status_checks).toEqual([
      { context: "Run BIDS Validation", integration_id: NEMAR_APP_ID },
    ]);
    expect(checks?.parameters?.do_not_enforce_on_create).toBe(true);
  });

  test("an unpinned check omits integration_id (accepts any source)", () => {
    const p = buildBranchRulesetPayload({ checks: [{ context: "version-check" }] });
    const checks = ruleOfType(p, "required_status_checks");
    expect(checks?.parameters?.required_status_checks).toEqual([{ context: "version-check" }]);
  });

  test("strict is off by default and honored when set", () => {
    const off = ruleOfType(
      buildBranchRulesetPayload({ checks: [{ context: "x" }] }),
      "required_status_checks",
    );
    expect(off?.parameters?.strict_required_status_checks_policy).toBe(false);
    const on = ruleOfType(
      buildBranchRulesetPayload({ checks: [{ context: "x" }], strict: true }),
      "required_status_checks",
    );
    expect(on?.parameters?.strict_required_status_checks_policy).toBe(true);
  });

  test("force-pushes and branch deletion are blocked", () => {
    expect(ruleOfType(payload, "non_fast_forward")).toBeDefined();
    expect(ruleOfType(payload, "deletion")).toBeDefined();
  });

  test("bypass actors are the NEMAR App (Integration) and org admins", () => {
    const app = payload.bypass_actors.find((a) => a.actor_id === NEMAR_APP_ID);
    expect(app).toEqual({
      actor_id: NEMAR_APP_ID,
      actor_type: "Integration",
      bypass_mode: "always",
    });
    const admin = payload.bypass_actors.find((a) => a.actor_type === "OrganizationAdmin");
    expect(admin?.bypass_mode).toBe("always");
  });

  test("mixed pinned + unpinned checks are preserved in order", () => {
    const p = buildBranchRulesetPayload({
      checks: [
        { context: "Run BIDS Validation", integration_id: NEMAR_APP_ID },
        { context: "version-check" },
      ],
    });
    const checks = ruleOfType(p, "required_status_checks");
    expect(checks?.parameters?.required_status_checks).toEqual([
      { context: "Run BIDS Validation", integration_id: NEMAR_APP_ID },
      { context: "version-check" },
    ]);
  });
});

describe("deriveContexts", () => {
  test("central-flow repos: App-pinned BIDS + unpinned version-check", () => {
    for (const repo of ["nm000132", "nm000226", "on007139", "nm099999"]) {
      expect(deriveContexts(repo)).toEqual([
        { context: "Run BIDS Validation", integration_id: NEMAR_APP_ID },
        { context: "version-check" },
      ]);
    }
  });

  test("legacy-inline repos: unpinned 'bids-validation' (github-actions) + version-check", () => {
    for (const repo of ["nm000103", "nm000105", "nm000106", "nm000107"]) {
      expect(deriveContexts(repo)).toEqual([
        { context: "bids-validation" },
        { context: "version-check" },
      ]);
    }
  });
});
