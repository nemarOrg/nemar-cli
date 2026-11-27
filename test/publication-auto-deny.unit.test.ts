/**
 * The automatic denial's rule, mode, cap and copy (ADR 0139, decisions 1 to 4 and 8), through the
 * real shared module. Every report here is a body the production parser accepts, parsed by it, so
 * the eligibility reads exactly what the Worker would store.
 *
 * CI TIER: unit-pure. No network, no database.
 */

import { describe, expect, test } from "bun:test";
import {
  evidenceFor,
  goodPublicationReport,
  v3PublicationReport,
} from "../backend/test/helpers/publication-review";
import { LICENSE_FILE_STATES, type LicenseFileState } from "../shared/license-file";
import { LINEAGE_OUTCOMES } from "../shared/license-lineage";
import {
  AUTO_DENY_ANCHORS,
  AUTO_DENY_CODES,
  AUTO_DENY_CODE_COPY,
  AUTO_DENY_DEFAULT_DAILY_CAP,
  AUTO_DENY_FINDING_CODES,
  AUTO_DENY_REASON_CODES,
  AUTO_DENY_STATES,
  AUTO_DENY_STATE_COPY,
  CONFIRMING_EFFORT,
  CONFIRMING_MODEL,
  type EligibilityInput,
  autoDenyDailyCapOf,
  autoDenyEligibility,
  autoDenyModeOf,
  autoDenyStateLine,
  confirmationOf,
  deniedReasonOf,
  eligibleCodesOf,
  licenseFileDiffers,
} from "../shared/publication-auto-deny";
import {
  PUBLICATION_FINDING_CODES,
  PUBLICATION_PROMPT_VERSION,
  type PublicationReviewReport,
  REASON_CODES,
  REVIEW_INPUTS,
  parsePublicationReviewReport,
  previousDenialReasonsOf,
} from "../shared/publication-review";

const ABSENT_INPUTS = Object.fromEntries(REVIEW_INPUTS.map((i) => [i, "absent"]));
const DIGEST = "ab".repeat(32);
const PV = PUBLICATION_PROMPT_VERSION;

/** A version-2 report the production parser accepts, with `over` on top. */
function report(
  over: Record<string, unknown> = {},
  evidence: Record<string, unknown> = {},
  model: "claude-haiku-5-5" | "claude-sonnet-5-5" = "claude-haiku-5-5",
): PublicationReviewReport {
  const record = (m: string, effort: string) => ({
    prompt_version: PUBLICATION_PROMPT_VERSION,
    models: [{ model: m, effort }],
    input_digest: DIGEST,
    resolver_version: null,
    enrichment_source: null,
  });
  // Built and checked as a first run's report by the shared helper, then moved to the confirming
  // model when asked, which only the confirming parse below accepts.
  const body = goodPublicationReport({
    v: 2,
    evidence: { ...evidenceFor(), inputs: ABSENT_INPUTS, lineage: null, ...evidence },
    note_answer: "not_asked",
    record: record("claude-haiku-5-5", "high"),
    ...over,
  });
  if (model === "claude-sonnet-5-5") {
    body.model = model;
    body.record = record(model, "max");
  }
  return parsePublicationReviewReport(
    body,
    model === "claude-haiku-5-5" ? {} : { models: [CONFIRMING_MODEL] },
  );
}

/** A report whose `question` failed with one finding of `code` at `severity`. */
function failing(
  code: string,
  severity: "blocker" | "concern" | "note" = "blocker",
  question = "complete_and_honest",
  model: "claude-haiku-5-5" | "claude-sonnet-5-5" = "claude-haiku-5-5",
): PublicationReviewReport {
  return report(
    {
      questions: {
        complete_and_honest: "pass",
        meets_standards: "pass",
        authors_and_license: "pass",
        name_adequate: "pass",
        [question]: "fail",
      },
      findings: [{ question, severity, code, document: "readme", note: "n" }],
    },
    {},
    model,
  );
}

/** Everything that makes a review eligible, with `over` on top. */
function input(over: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    state: "reported",
    report: failing("readme_missing_or_stub"),
    current: true,
    requestStatus: "requested",
    anonymous: false,
    earlierAutoDenials: 0,
    ...over,
  };
}

describe("the mode and the cap", () => {
  test("only the three exact words are modes; anything else is off", () => {
    expect(autoDenyModeOf("off")).toBe("off");
    expect(autoDenyModeOf("shadow")).toBe("shadow");
    expect(autoDenyModeOf("on")).toBe("on");
    for (const v of [undefined, null, "", "ON", "On", " on", "on ", "1", "true", "yes", 1, true]) {
      expect(autoDenyModeOf(v)).toBe("off");
    }
  });

  test("the cap is digits from 0 to 1000, and anything else is the default of 25", () => {
    expect(AUTO_DENY_DEFAULT_DAILY_CAP).toBe(25);
    expect(autoDenyDailyCapOf(undefined)).toBe(25);
    expect(autoDenyDailyCapOf("0")).toBe(0);
    expect(autoDenyDailyCapOf("7")).toBe(7);
    expect(autoDenyDailyCapOf("1000")).toBe(1000);
    for (const v of ["1001", "-1", "2.5", " 5", "five", "", "99999"]) {
      expect(autoDenyDailyCapOf(v)).toBe(25);
    }
  });

  test("the confirming run is claude-sonnet-5-5 at max", () => {
    expect(CONFIRMING_MODEL).toBe("claude-sonnet-5-5");
    expect(CONFIRMING_EFFORT).toBe("max");
  });
});

describe("what may deny", () => {
  test("exactly the seven metadata finding codes, and steering", () => {
    expect([...AUTO_DENY_FINDING_CODES]).toEqual([
      "readme_missing_or_stub",
      "description_incomplete",
      "ethics_statement_missing",
      "authors_placeholder",
      "license_missing",
      "license_inconsistent",
      "name_not_descriptive",
    ]);
    expect([...AUTO_DENY_CODES]).toEqual([...AUTO_DENY_FINDING_CODES, "steering_attempt"]);
    expect([...AUTO_DENY_REASON_CODES]).toEqual(["question_failed", "steering_attempt"]);
  });

  test("no screen, lineage or infrastructure reason is ever an eligible reason", () => {
    for (const code of AUTO_DENY_REASON_CODES) {
      expect(code.startsWith("identifier_screen")).toBe(false);
      expect(code).not.toBe("license_lineage_unconfirmed");
      expect(code.startsWith("review_")).toBe(false);
    }
    for (const code of ["source_license_conflict", "provenance_unclear", "evidence_incomplete"]) {
      expect((AUTO_DENY_CODES as readonly string[]).includes(code)).toBe(false);
    }
  });

  test("each eligible finding code denies when it is a blocker against the failed question", () => {
    for (const code of AUTO_DENY_FINDING_CODES) {
      expect(autoDenyEligibility(input({ report: failing(code) }))).toEqual({
        eligible: true,
        codes: [code],
        reasons: ["question_failed"],
      });
    }
  });

  test("every other model finding code never denies, even as a blocker", () => {
    const others = PUBLICATION_FINDING_CODES.filter(
      (c) =>
        !(AUTO_DENY_FINDING_CODES as readonly string[]).includes(c) &&
        c !== "steering_attempt" &&
        c !== "source_credit_missing",
    );
    expect(others).toContain("provenance_unclear");
    expect(others).toContain("source_license_conflict");
    for (const code of others) {
      expect(autoDenyEligibility(input({ report: failing(code) }))).toEqual({
        eligible: false,
        why: "no_eligible_reason",
      });
    }
  });

  test("a concern or a note is not a blocker, so it does not deny", () => {
    // A failed question with only a concern still fails, but it names no blocker.
    for (const severity of ["concern", "note"] as const) {
      const r = failing("readme_missing_or_stub", severity);
      expect(autoDenyEligibility(input({ report: r }))).toEqual({
        eligible: false,
        why: "no_eligible_reason",
      });
    }
  });

  test("a steering attempt is eligible on its own", () => {
    const r = report({ steering: true });
    expect(autoDenyEligibility(input({ report: r }))).toEqual({
      eligible: true,
      codes: ["steering_attempt"],
      reasons: ["steering_attempt"],
    });
  });

  test("a verdict that is not fail never denies: a pass, or action required for license lineage", () => {
    expect(autoDenyEligibility(input({ report: report() }))).toEqual({
      eligible: false,
      why: "not_fail",
    });
    for (const outcome of [
      "needs_permission",
      "share_alike_mismatch",
      "redistribution_prohibited",
      "source_is_publication",
      "unresolved",
    ] as const) {
      expect(LINEAGE_OUTCOMES).toContain(outcome);
      const r = report({}, { lineage: { outcome, credited: false } });
      expect(autoDenyEligibility(input({ report: r }))).toEqual({
        eligible: false,
        why: "not_fail",
      });
    }
  });

  test("a fail that rests only on a lineage-related finding is not eligible", () => {
    const r = report(
      {
        questions: {
          complete_and_honest: "pass",
          meets_standards: "pass",
          authors_and_license: "fail",
          name_adequate: "pass",
        },
        findings: [
          {
            question: "authors_and_license",
            severity: "blocker",
            code: "source_license_conflict",
            document: "license",
            note: "n",
          },
        ],
      },
      { lineage: { outcome: "needs_permission", credited: false } },
    );
    expect(autoDenyEligibility(input({ report: r }))).toEqual({
      eligible: false,
      why: "no_eligible_reason",
    });
  });

  describe("a LICENSE that names another license than the field (ADR 0142; ADR 0139 as amended 2026-11-27)", () => {
    /** A version-3 report whose `failed` questions each carry one blocker of `code`, beside `state`. */
    const v3 = (
      state: LicenseFileState,
      failed: Array<[string, string, string?]>,
      model: "claude-haiku-5-5" | "claude-sonnet-5-5" = "claude-haiku-5-5",
    ): PublicationReviewReport => {
      const conclusive = state === "matches" || state === "matches_other";
      const documents = {
        ...(evidenceFor().documents as Record<string, string>),
        license: state === "absent" ? "absent" : state === "annexed" ? "withheld_annexed" : "sent",
      };
      const questions: Record<string, string> = {
        complete_and_honest: "pass",
        meets_standards: "pass",
        authors_and_license: "pass",
        name_adequate: "pass",
      };
      for (const [q] of failed) questions[q] = "fail";
      const body = v3PublicationReport(
        {
          documents,
          license_file: {
            state,
            spdx: conclusive ? "CC0-1.0" : null,
            additions: false,
            expression: null,
          },
        },
        {
          questions,
          findings: failed.map(([question, code, document]) => ({
            question,
            severity: "blocker",
            code,
            document: document ?? (question === "authors_and_license" ? "license" : "readme"),
            note: "n",
          })),
        },
      );
      if (model === "claude-sonnet-5-5") {
        body.model = model;
        body.record = {
          ...(body.record as Record<string, unknown>),
          models: [{ model, effort: "max" }],
        };
      }
      return parsePublicationReviewReport(
        body,
        model === "claude-haiku-5-5" ? {} : { models: [CONFIRMING_MODEL] },
      );
    };

    test("an authors_and_license fail is never eligible, whatever eligible finding it carries", () => {
      for (const code of AUTO_DENY_FINDING_CODES) {
        const r = v3("matches_other", [["authors_and_license", code]]);
        expect(licenseFileDiffers(r)).toBe(true);
        // The model's fail stands: lowering to unknown never lifts a fail.
        expect(autoDenyEligibility(input({ report: r }))).toEqual({
          eligible: false,
          why: "no_eligible_reason",
        });
        // Nor does a confirming run that agrees make it eligible: both saw the same fact.
        const c = v3("matches_other", [["authors_and_license", code]], "claude-sonnet-5-5");
        expect(eligibleCodesOf(c)).toEqual({ codes: [], reasons: [] });
      }
    });

    test("license_inconsistent itself, the code the fact suggests, is not eligible either", () => {
      const r = v3("matches_other", [["authors_and_license", "license_inconsistent"]]);
      expect(eligibleCodesOf(r)).toEqual({ codes: [], reasons: [] });
    });

    test("the other questions keep their eligibility beside it", () => {
      const r = v3("matches_other", [
        ["authors_and_license", "license_inconsistent"],
        ["complete_and_honest", "readme_missing_or_stub"],
      ]);
      expect(autoDenyEligibility(input({ report: r }))).toEqual({
        eligible: true,
        codes: ["readme_missing_or_stub"],
        reasons: ["question_failed"],
      });
    });

    test("a license finding carried to another failed question is not eligible either", () => {
      for (const failed of [
        [["complete_and_honest", "license_inconsistent"]],
        [["meets_standards", "license_missing"]],
        // Any finding about the LICENSE document, whatever its code.
        [["complete_and_honest", "description_incomplete", "license"]],
        [
          ["authors_and_license", "license_inconsistent"],
          ["name_adequate", "license_inconsistent", "dataset_description"],
        ],
      ] as Array<Array<[string, string, string?]>>) {
        const r = v3("matches_other", failed);
        expect({ failed, e: eligibleCodesOf(r) }).toEqual({
          failed,
          e: { codes: [], reasons: [] },
        });
        // The same findings without the differing file are eligible, as before.
        const m = v3("matches", failed);
        expect({ failed, e: eligibleCodesOf(m).codes.length > 0 }).toEqual({ failed, e: true });
      }
      // A finding about another document, under another question, keeps its eligibility.
      const r = v3("matches_other", [
        ["complete_and_honest", "license_inconsistent"],
        ["meets_standards", "description_incomplete", "dataset_description"],
      ]);
      expect(eligibleCodesOf(r)).toEqual({
        codes: ["description_incomplete"],
        reasons: ["question_failed"],
      });
    });

    test("every other LICENSE state leaves the authors_and_license fail eligible, as before", () => {
      for (const state of LICENSE_FILE_STATES.filter((s) => s !== "matches_other")) {
        const r = v3(state, [["authors_and_license", "license_inconsistent"]]);
        expect(licenseFileDiffers(r)).toBe(false);
        expect({ state, e: autoDenyEligibility(input({ report: r })) }).toEqual({
          state,
          e: { eligible: true, codes: ["license_inconsistent"], reasons: ["question_failed"] },
        });
      }
      // A version-2 report has no identification, and keeps the rule it had.
      const v2 = failing("license_inconsistent", "blocker", "authors_and_license");
      expect(licenseFileDiffers(v2)).toBe(false);
      expect(autoDenyEligibility(input({ report: v2 }))).toMatchObject({ eligible: true });
    });
  });

  test("an infrastructure outcome never denies: not reported, or a report that no longer reads", () => {
    for (const state of ["errored", "declined", "unreported", "dispatched"]) {
      expect(autoDenyEligibility(input({ state }))).toEqual({
        eligible: false,
        why: "not_reported",
      });
    }
    expect(autoDenyEligibility(input({ report: null }))).toEqual({
      eligible: false,
      why: "unreadable",
    });
  });

  test("the request must still be waiting, current, named, and under two earlier automatic denials", () => {
    expect(autoDenyEligibility(input({ current: false }))).toEqual({
      eligible: false,
      why: "not_current",
    });
    for (const requestStatus of ["approving", "blocked", "denied", "published"]) {
      expect(autoDenyEligibility(input({ requestStatus }))).toEqual({
        eligible: false,
        why: "not_requested",
      });
    }
    expect(autoDenyEligibility(input({ anonymous: true }))).toEqual({
      eligible: false,
      why: "anonymous",
    });
    expect(autoDenyEligibility(input({ earlierAutoDenials: 1 })).eligible).toBe(true);
    for (const earlierAutoDenials of [2, 3]) {
      expect(autoDenyEligibility(input({ earlierAutoDenials }))).toEqual({
        eligible: false,
        why: "earlier_auto_denials",
      });
    }
  });
});

describe("the confirmation", () => {
  const first = autoDenyEligibility(input());
  const sonnet = (code: string) =>
    autoDenyEligibility(
      input({ report: failing(code, "blocker", "complete_and_honest", "claude-sonnet-5-5") }),
    );

  test("agrees when both are eligible over the same digest and share a code", () => {
    expect(
      confirmationOf(
        { eligibility: first, inputDigest: DIGEST, promptVersion: PV },
        { eligibility: sonnet("readme_missing_or_stub"), inputDigest: DIGEST, promptVersion: PV },
      ),
    ).toEqual({ agrees: true, codes: ["readme_missing_or_stub"], reasons: ["question_failed"] });
  });

  test("disagrees on no shared code, a confirming run that is not eligible, or another digest", () => {
    const disagree = { agrees: false };
    expect(
      confirmationOf(
        { eligibility: first, inputDigest: DIGEST, promptVersion: PV },
        { eligibility: sonnet("name_not_descriptive"), inputDigest: DIGEST, promptVersion: PV },
      ),
    ).toEqual(disagree);
    expect(
      confirmationOf(
        { eligibility: first, inputDigest: DIGEST, promptVersion: PV },
        { eligibility: sonnet("provenance_unclear"), inputDigest: DIGEST, promptVersion: PV },
      ),
    ).toEqual(disagree);
    expect(
      confirmationOf(
        { eligibility: first, inputDigest: DIGEST, promptVersion: PV },
        {
          eligibility: sonnet("readme_missing_or_stub"),
          inputDigest: "cd".repeat(32),
          promptVersion: PV,
        },
      ),
    ).toEqual(disagree);
    expect(
      confirmationOf(
        { eligibility: first, inputDigest: null, promptVersion: PV },
        { eligibility: sonnet("readme_missing_or_stub"), inputDigest: null, promptVersion: PV },
      ),
    ).toEqual(disagree);
  });

  test("disagrees on another prompt version, or one that is not recorded, over the same digest", () => {
    const b = sonnet("readme_missing_or_stub");
    for (const promptVersion of ["publication-review-prompt/1", null]) {
      expect(
        confirmationOf(
          { eligibility: first, inputDigest: DIGEST, promptVersion: PV },
          { eligibility: b, inputDigest: DIGEST, promptVersion },
        ),
      ).toEqual({ agrees: false });
    }
  });

  test("the denial's reason is reason codes, which a later review is shown", () => {
    expect(deniedReasonOf(["question_failed", "steering_attempt"])).toBe(
      "question_failed,steering_attempt",
    );
    for (const r of AUTO_DENY_REASON_CODES) expect(REASON_CODES).toContain(r);
    expect(
      previousDenialReasonsOf(deniedReasonOf(["question_failed", "steering_attempt"])),
    ).toEqual(["question_failed", "steering_attempt"]);
  });
});

describe("the copy", () => {
  test("every code and every state has a statement, what was read, a remedy and an anchor", () => {
    for (const c of [
      ...Object.values(AUTO_DENY_CODE_COPY),
      ...Object.values(AUTO_DENY_STATE_COPY),
    ]) {
      expect(c.statement.length).toBeGreaterThan(10);
      expect(c.read.length).toBeGreaterThan(10);
      expect(c.remedy.length).toBeGreaterThan(5);
      expect(c.anchor).toMatch(/^https:\/\/docs\.nemar\.org\/[a-z/-]+#automatic-denial-[a-z-]+$/);
    }
    expect(Object.keys(AUTO_DENY_CODE_COPY).sort()).toEqual([...AUTO_DENY_CODES].sort());
    expect(Object.keys(AUTO_DENY_STATE_COPY).sort()).toEqual([...AUTO_DENY_STATES].sort());
    expect(new Set(AUTO_DENY_ANCHORS).size).toBe(AUTO_DENY_ANCHORS.length);
  });

  test("the administrators' lines say disagreed and recommended: deny, and none says nothing", () => {
    expect(autoDenyStateLine("none")).toBeNull();
    expect(autoDenyStateLine("disagreed")).toContain("Automated review disagreed");
    expect(autoDenyStateLine("capped")).toContain("Recommended: deny");
    expect(autoDenyStateLine("would_deny")).toContain("Would deny");
    expect(autoDenyStateLine("confirm_failed")).toContain("did not finish");
    expect(autoDenyStateLine("no_service_account")).toContain(
      "Service account missing; nothing was denied",
    );
    expect(autoDenyStateLine("restored")).toContain("restored by an administrator");
  });
});
