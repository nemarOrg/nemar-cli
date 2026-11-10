/**
 * The three account-facing compute nudges wait for the compute terms to be published (epic #2021
 * phase D1; owner decision: third-party compute must not confuse anyone before it is open).
 *
 *   1. `affiliation` in `profile_gaps`  -> test/profile-gaps-matrix.test.ts (the one gap rule)
 *   2. the `nemar auth signup` institution prompt  -> `signupAffiliationStep`
 *   3. the "Compute access" row of `nemar auth profile`  -> `computeAccessChangeLines`
 *
 * `COMPUTE_TERMS_PUBLISHED` is a compile-time constant (false in production today), so the two
 * helpers take it as a defaulted parameter and both branches are shown by passing it. No mocks:
 * both helpers are pure and run for real.
 */

import { describe, expect, test } from "bun:test";
import { COMPUTE_TERMS_PUBLISHED } from "../shared/contract/compute-terms.js";
import { computeAccessChangeLines, signupAffiliationStep } from "../src/lib/account-gaps.js";

const GAP_LIST = new Set(["affiliation"]);
const NO_GAPS = new Set<string>();

describe("signupAffiliationStep", () => {
  test("the production constant is unpublished, and that is what the helper defaults to", () => {
    expect(COMPUTE_TERMS_PUBLISHED).toBe(false);
    expect(signupAffiliationStep({ gapFields: GAP_LIST, interactive: true })).toBe("none");
  });

  test("unpublished: a terminal with the gap on its list is not asked for an institution", () => {
    expect(
      signupAffiliationStep({ gapFields: GAP_LIST, interactive: true, published: false }),
    ).toBe("none");
  });

  test("published: a terminal with the gap on its list is asked", () => {
    expect(signupAffiliationStep({ gapFields: GAP_LIST, interactive: true, published: true })).toBe(
      "prompt",
    );
  });

  test("published but no terminal, or no gap: nothing is asked", () => {
    expect(
      signupAffiliationStep({ gapFields: GAP_LIST, interactive: false, published: true }),
    ).toBe("none");
    expect(signupAffiliationStep({ gapFields: NO_GAPS, interactive: true, published: true })).toBe(
      "none",
    );
  });

  test("an explicit --affiliation is the person's own answer and is saved either way", () => {
    for (const published of [true, false]) {
      expect(
        signupAffiliationStep({
          flag: "UCSD",
          gapFields: NO_GAPS,
          interactive: false,
          published,
        }),
      ).toBe("flag");
    }
  });
});

describe("computeAccessChangeLines", () => {
  test("unpublished: the row is withheld, and that is the default", () => {
    expect(COMPUTE_TERMS_PUBLISHED).toBe(false);
    expect(computeAccessChangeLines(false)).toEqual([]);
    expect(computeAccessChangeLines()).toEqual([]);
  });

  test("published: the row names the request command", () => {
    const lines = computeAccessChangeLines(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Compute access");
    expect(lines[0]).toContain("nemar compute request-access");
  });
});
