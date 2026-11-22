/**
 * The notice rule of an administrator's compute-access decision (shared/contract/compute-access.ts;
 * nemarOrg/docs#105): the text the PERSON is mailed, apart from the audit `reason`. One rule,
 * `computeAccessNoticeProblem`, read by the Worker's body schema and by the CLI before it sends; these
 * tests pin the rule and that the schema applies it, so the two readers cannot disagree.
 */

import { describe, expect, test } from "bun:test";
import { COMPUTE_ACCESS_DECISIONS } from "../shared/compute-access-state";
import {
  COMPUTE_ACCESS_NOTICE_MAX_CHARS,
  COMPUTE_ACCESS_NOTICE_RULE,
  COMPUTE_ACCESS_REASON_MAX_CHARS,
  computeAccessDecisionBodySchema,
  computeAccessNoticeProblem,
} from "../shared/contract/compute-access";

describe("computeAccessNoticeProblem", () => {
  test("every decision has a rule: suspend and revoke require, deny allows, grant refuses", () => {
    expect(Object.keys(COMPUTE_ACCESS_NOTICE_RULE).sort()).toEqual(
      [...COMPUTE_ACCESS_DECISIONS].sort(),
    );
    expect(COMPUTE_ACCESS_NOTICE_RULE).toEqual({
      grant: "refused",
      deny: "optional",
      suspend: "required",
      revoke: "required",
    });
  });

  test("a required notice that is absent, empty or only whitespace is notice_required", () => {
    for (const decision of ["suspend", "revoke"] as const) {
      for (const notice of [undefined, "", "   ", "\n\t "]) {
        expect([decision, notice, computeAccessNoticeProblem(decision, notice)]).toEqual([
          decision,
          notice,
          "notice_required",
        ]);
      }
      expect(computeAccessNoticeProblem(decision, "Your jobs exceeded the allocation.")).toBeNull();
    }
  });

  test("a denial takes a notice or none", () => {
    expect(computeAccessNoticeProblem("deny", undefined)).toBeNull();
    expect(computeAccessNoticeProblem("deny", "  ")).toBeNull();
    expect(computeAccessNoticeProblem("deny", "Outside what compute is for.")).toBeNull();
  });

  test("a grant refuses any notice, even an empty one", () => {
    expect(computeAccessNoticeProblem("grant", undefined)).toBeNull();
    expect(computeAccessNoticeProblem("grant", "")).toBe("notice_refused");
    expect(computeAccessNoticeProblem("grant", "Welcome")).toBe("notice_refused");
  });

  test("the bound counts code points after trimming", () => {
    const max = COMPUTE_ACCESS_NOTICE_MAX_CHARS;
    expect(computeAccessNoticeProblem("suspend", "n".repeat(max))).toBeNull();
    expect(computeAccessNoticeProblem("suspend", `  ${"n".repeat(max)}\n`)).toBeNull();
    expect(computeAccessNoticeProblem("suspend", "n".repeat(max + 1))).toBe("notice_too_long");
    // An emoji is two UTF-16 units and one character.
    expect(computeAccessNoticeProblem("suspend", "\u{1F600}".repeat(max))).toBeNull();
    expect(computeAccessNoticeProblem("suspend", "\u{1F600}".repeat(max + 1))).toBe(
      "notice_too_long",
    );
  });

  test("control characters other than newline and tab are refused", () => {
    for (const c of ["\u0000", "\u0007", "\u001b", "\r", "\u007f"]) {
      expect(computeAccessNoticeProblem("revoke", `a${c}b`)).toBe("notice_control_char");
    }
    expect(computeAccessNoticeProblem("revoke", "First line.\n\tSecond line.")).toBeNull();
  });
});

describe("computeAccessDecisionBodySchema", () => {
  test("applies the notice rule at `notice`, with the rule's word as the message", () => {
    const parsed = computeAccessDecisionBodySchema("suspend").safeParse({
      reason: "for the record",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual([
        expect.objectContaining({ path: ["notice"], code: "custom", message: "notice_required" }),
      ]);
    }
    const grant = computeAccessDecisionBodySchema("grant").safeParse({ notice: "x" });
    expect(grant.success).toBe(false);
    if (!grant.success) expect(grant.error.issues[0]?.message).toBe("notice_refused");
  });

  test("keeps the reason bound, stays open, and passes a valid body through unchanged", () => {
    const schema = computeAccessDecisionBodySchema("revoke");
    const body = { reason: "r".repeat(COMPUTE_ACCESS_REASON_MAX_CHARS), notice: "Ended." };
    expect(schema.parse(body)).toEqual(body);
    expect(
      schema.safeParse({ reason: "r".repeat(COMPUTE_ACCESS_REASON_MAX_CHARS + 1), notice: "x" })
        .success,
    ).toBe(false);
    // Open, like every contract schema: an unknown key is dropped (the Worker closes the shape itself).
    expect(schema.parse({ notice: "x", extra: 1 })).toEqual({ notice: "x" });
    expect(schema.safeParse({ notice: 7 }).success).toBe(false);
    expect(computeAccessDecisionBodySchema("deny").parse({})).toEqual({});
    expect(computeAccessDecisionBodySchema("grant").parse({ reason: "ok" })).toEqual({
      reason: "ok",
    });
  });
});
