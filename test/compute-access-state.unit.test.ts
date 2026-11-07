/**
 * The compute-access state machine (epic #2021 phase D1, #2022): the six states, the only edges
 * between them, and the one state that may use compute. Pure, so it is called directly.
 *
 * The expected edge list below is written out from the phase brief, not derived from the table, so
 * the test can disagree with the implementation. MUTATIONS: add `active -> requested`; let
 * `denied` or `revoked` reach `requested`; make `canUseCompute` accept `suspended`.
 */

import { describe, expect, test } from "bun:test";
import {
  COMPUTE_ACCESS_DECISIONS,
  COMPUTE_ACCESS_STATES,
  COMPUTE_ACCESS_TRANSITIONS,
  COMPUTE_DECISION_FROM,
  COMPUTE_DECISION_TARGET,
  type ComputeAccessState,
  canTransition,
  canUseCompute,
  isComputeAccessDecision,
  isComputeAccessState,
} from "../shared/compute-access-state.js";

const EDGES: Array<[ComputeAccessState, ComputeAccessState]> = [
  ["none", "requested"],
  ["requested", "active"],
  ["requested", "denied"],
  ["active", "suspended"],
  ["active", "revoked"],
  ["suspended", "active"],
  ["suspended", "revoked"],
  ["denied", "active"],
  ["revoked", "active"],
];

describe("the states and the edges", () => {
  test("six states, in the order the brief gives them", () => {
    expect([...COMPUTE_ACCESS_STATES]).toEqual([
      "none",
      "requested",
      "active",
      "suspended",
      "denied",
      "revoked",
    ]);
  });

  test("exactly the nine edges of the brief are allowed, and the other 27 are not", () => {
    let allowed = 0;
    for (const from of COMPUTE_ACCESS_STATES) {
      for (const to of COMPUTE_ACCESS_STATES) {
        const expected = EDGES.some(([f, t]) => f === from && t === to);
        expect([from, to, canTransition(from, to)]).toEqual([from, to, expected]);
        if (expected) allowed += 1;
      }
    }
    expect(allowed).toBe(9);
  });

  test("a closed state is left only by an administrator's grant", () => {
    for (const closed of ["denied", "revoked"] as const) {
      expect([...COMPUTE_ACCESS_TRANSITIONS[closed]]).toEqual(["active"]);
      expect(canTransition(closed, "requested")).toBe(false);
    }
  });

  test("only none may become requested: a person asks once", () => {
    for (const from of COMPUTE_ACCESS_STATES) {
      expect([from, canTransition(from, "requested")]).toEqual([from, from === "none"]);
    }
  });

  test("only active may use compute", () => {
    for (const s of COMPUTE_ACCESS_STATES) expect([s, canUseCompute(s)]).toEqual([s, s === "active"]);
  });

  test("a word that is not a state is not one", () => {
    for (const bad of ["granted", "Active", "", null, undefined, 1]) {
      expect(isComputeAccessState(bad)).toBe(false);
    }
    for (const good of COMPUTE_ACCESS_STATES) expect(isComputeAccessState(good)).toBe(true);
  });
});

describe("the four decisions", () => {
  test("each ends in its state and starts from exactly the states the brief names", () => {
    expect([...COMPUTE_ACCESS_DECISIONS]).toEqual(["grant", "deny", "suspend", "revoke"]);
    expect(COMPUTE_DECISION_TARGET).toEqual({
      grant: "active",
      deny: "denied",
      suspend: "suspended",
      revoke: "revoked",
    });
    expect([...COMPUTE_DECISION_FROM.grant].sort()).toEqual(
      ["denied", "requested", "revoked", "suspended"].sort(),
    );
    expect([...COMPUTE_DECISION_FROM.deny]).toEqual(["requested"]);
    expect([...COMPUTE_DECISION_FROM.suspend]).toEqual(["active"]);
    expect([...COMPUTE_DECISION_FROM.revoke]).toEqual(["active", "suspended"]);
  });

  test("a grant is refused from none and from active", () => {
    expect(COMPUTE_DECISION_FROM.grant).not.toContain("none");
    expect(COMPUTE_DECISION_FROM.grant).not.toContain("active");
  });

  test("a decision word is exactly one of the four", () => {
    for (const d of COMPUTE_ACCESS_DECISIONS) expect(isComputeAccessDecision(d)).toBe(true);
    for (const bad of ["approve", "Grant", "", null]) expect(isComputeAccessDecision(bad)).toBe(false);
  });
});
