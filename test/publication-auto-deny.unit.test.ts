/**
 * The automatic denial's rule, mode, cap and copy (ADR 0139, decisions 1 to 4 and 8), through the
 * real shared module. Every report here is a body the production parser accepts, parsed by it, so
 * the eligibility reads exactly what the Worker would store.
 *
 * "The mail names what is true of the dataset" (ADR 0139, amended 2026-11-27) is pinned on the
 * first-run reports of the shadow run on production 0.10.58 (`test/fixtures/auto-deny-shadow/`).
 * Mutation checks, each applied alone to `shared/publication-auto-deny.ts`, run, and restored:
 *  - dropping the `report.evidence.license_field` condition of license_missing turns "a License
 *    field with no LICENSE file is not 'no license'" red;
 *  - dropping the model's-own-fail filter on `failed` turns "every finding needs the model's own
 *    fail" red;
 *  - dropping the `documents.readme === "absent"` condition, or the document check on a native
 *    readme_missing_or_stub, turns the decision 2 tests red;
 *  - dropping the blocker condition on steering turns "a reader note coded as steering" red;
 *  - dropping `name_upstream === "unknown"` or the any-source protection turns the name tests red.
 *
 * CI TIER: unit-pure. No network, no database.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  evidenceFor,
  goodPublicationReport,
  v3PublicationReport,
} from "../backend/test/helpers/publication-review";
import { descriptionFacts } from "../scripts/ci/publication-review-evidence";
import { LICENSE_FILE_STATES, type LicenseFileState } from "../shared/license-file";
import { LINEAGE_OUTCOMES } from "../shared/license-lineage";
import { nameFollowsAnySourceTitle } from "../shared/name-follows-upstream";
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
  autoDenyCodeLine,
  autoDenyCodesColumn,
  autoDenyCodesOf,
  autoDenyDailyCapOf,
  autoDenyEligibility,
  autoDenyModeOf,
  autoDenyReasonLine,
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
  answersOf,
  parsePublicationReviewReport,
  previousDenialReasonsOf,
  reportReasons,
  verdictOf,
} from "../shared/publication-review";
import shadowRun from "./fixtures/auto-deny-shadow/shadow-2026-11-28.json";

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

const PASSED = {
  complete_and_honest: "pass",
  meets_standards: "pass",
  authors_and_license: "pass",
  name_adequate: "pass",
} as const;

/** A blocker finding of `code` against `question`, about `document`. */
function blocker(question: string, code: string, document: string | null) {
  return { question, severity: "blocker", code, document, note: "n" };
}

/** A report whose `complete_and_honest` failed with one blocker of `code` about `document`. */
function failingAbout(code: string, document: string | null): PublicationReviewReport {
  return report({
    questions: { ...PASSED, complete_and_honest: "fail" },
    findings: [blocker("complete_and_honest", code, document)],
  });
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
    nameFollowsASource: false,
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
    expect([...AUTO_DENY_CODES]).toEqual([
      ...AUTO_DENY_FINDING_CODES,
      "steering_attempt",
      "name_differs_from_upstream",
    ]);
    expect([...AUTO_DENY_REASON_CODES]).toEqual([
      "question_failed",
      "steering_attempt",
      "name_differs_from_upstream",
    ]);
  });

  test("no screen, lineage or infrastructure reason is ever an eligible reason", () => {
    for (const code of AUTO_DENY_REASON_CODES) {
      expect(code.startsWith("identifier_screen")).toBe(false);
      expect(code).not.toBe("license_lineage_unconfirmed");
      // The name rule's undecided word is NEMAR's failure to read a record: never a denial.
      expect(code).not.toBe("name_upstream_unconfirmed");
      expect(code.startsWith("review_")).toBe(false);
    }
    for (const code of ["source_license_conflict", "provenance_unclear", "evidence_incomplete"]) {
      expect((AUTO_DENY_CODES as readonly string[]).includes(code)).toBe(false);
    }
  });

  test("each eligible finding code denies when it is a blocker against the failed question", () => {
    // Each as the rules of 2026-11-27 let it deny: a description finding about
    // dataset_description.json, and "no license" only where the platform read no License field.
    for (const code of AUTO_DENY_FINDING_CODES) {
      const r =
        code === "description_incomplete"
          ? failingAbout(code, "dataset_description")
          : code === "license_missing"
            ? report(
                {
                  questions: { ...PASSED, authors_and_license: "fail" },
                  findings: [blocker("authors_and_license", code, "dataset_description")],
                },
                { license_field: false },
              )
            : failing(code);
      expect({ code, e: autoDenyEligibility(input({ report: r })) }).toEqual({
        code,
        e: { eligible: true, codes: [code], reasons: ["question_failed"] },
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

  test("a steering attempt filed as a blocker is eligible on its own", () => {
    const r = report({
      steering: true,
      findings: [blocker("complete_and_honest", "steering_attempt", "readme")],
    });
    expect(autoDenyEligibility(input({ report: r }))).toEqual({
      eligible: true,
      codes: ["steering_attempt"],
      reasons: ["steering_attempt"],
    });
  });

  test("a steering flag with no blocker finding of it never denies (ADR 0139, amended 2026-11-27)", () => {
    // The flag alone, and a steering finding at concern or note: the review still fails, and a
    // person decides.
    const cases = [
      report({ steering: true }),
      ...(["concern", "note"] as const).map((severity) =>
        report({
          findings: [{ ...blocker("complete_and_honest", "steering_attempt", "readme"), severity }],
        }),
      ),
    ];
    for (const r of cases) {
      expect(r.steering).toBe(true);
      expect(autoDenyEligibility(input({ report: r }))).toEqual({
        eligible: false,
        why: "no_eligible_reason",
      });
    }
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
        [["meets_standards", "license_inconsistent", "readme"]],
        // Any finding about the LICENSE document, whatever its code.
        [["complete_and_honest", "ethics_statement_missing", "license"]],
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

// ---------------------------------------------------------------------------------------------
// The shadow run on production 0.10.58 (ADR 0139, amended 2026-11-27: the mail reasons)
// ---------------------------------------------------------------------------------------------

type ShadowId = keyof typeof shadowRun.reviews;

/** A first run of the shadow run, as stored, parsed by the production parser. */
function shadow(id: ShadowId, evidence: Record<string, unknown> = {}): PublicationReviewReport {
  const body = structuredClone(shadowRun.reviews[id].report) as Record<string, unknown>;
  body.evidence = { ...(body.evidence as Record<string, unknown>), ...evidence };
  return parsePublicationReviewReport(body);
}

/** The codes the mail would name for one run, with no declared source's title followed. */
const codesOf = (r: PublicationReviewReport, nameFollowsASource: boolean | null = false) =>
  eligibleCodesOf(r, { nameFollowsASource }).codes;

/** The words the mail would print for a code: its line in the denial mail. */
const mailSays = (codes: readonly string[]) =>
  codes.map((c) => autoDenyReasonLine(c as (typeof AUTO_DENY_CODES)[number]));

describe("the shadow run's records: the mail names what is true of the dataset", () => {
  test("the records are what production recorded under the earlier rule", () => {
    for (const id of ["nm001014", "nm001019", "nm001028", "nm001032", "nm001039", "nm001041"]) {
      expect(shadowRun.reviews[id as ShadowId].auto_deny_state).toBe("would_deny");
    }
    expect(shadowRun.reviews.nm000622.auto_deny_state).toBe("disagreed");
  });

  test("decision 1: a License field with no LICENSE file is not 'no license' (nm001019)", () => {
    const r = shadow("nm001019");
    expect(r.evidence.license_field).toBe(true);
    expect(r.evidence.license_file?.state).toBe("absent");
    // The model filed license_missing as a blocker on the question it failed.
    expect(
      r.findings.some(
        (f) =>
          f.code === "license_missing" &&
          f.severity === "blocker" &&
          r.questions[f.question] === "fail",
      ),
    ).toBe(true);
    expect(codesOf(r)).toEqual(["readme_missing_or_stub", "authors_placeholder"]);
    expect(mailSays(codesOf(r)).join(" ")).not.toContain("has no license");
    // With no License field the platform's fact holds, and the same finding is eligible.
    expect(codesOf(shadow("nm001019", { license_field: false }))).toContain("license_missing");
  });

  test("decision 1: never on a question the model answered unknown (nm001014)", () => {
    const r = shadow("nm001014");
    expect(r.questions.authors_and_license).toBe("unknown");
    expect(codesOf(r)).toEqual(["readme_missing_or_stub"]);
    // A missing License field lowers the question to fail, but the model's own answer is unknown:
    // the fact alone, which both runs see, is not a second model agreeing.
    const lowered = shadow("nm001014", { license_field: false });
    expect(verdictOf(reportReasons(lowered))).toBe("fail");
    expect(codesOf(lowered)).not.toContain("license_missing");
  });

  test("decision 2: a README description_incomplete is not eligible while the README exists", () => {
    // nm001032, nm001039 and nm001041: the model coded a template README description_incomplete.
    // The platform has no fact that a README which exists says too little, so the finding is not
    // eligible on the model's word; nm001032, whose only blocker it is, goes to a person.
    for (const id of ["nm001032", "nm001039", "nm001041"] as const) {
      const r = shadow(id);
      expect(r.evidence.documents.readme).toBe("sent");
      const finding = r.findings.find(
        (f) => f.code === "description_incomplete" && f.severity === "blocker",
      );
      expect({ id, document: finding?.document }).toEqual({ id, document: "readme" });
      const codes = codesOf(r);
      expect({ id, readme: codes.includes("readme_missing_or_stub") }).toEqual({
        id,
        readme: false,
      });
      expect(codes).not.toContain("description_incomplete");
      expect(mailSays(codes).join(" ")).not.toContain("dataset_description.json leaves out");
    }
    expect(codesOf(shadow("nm001032"))).toEqual([]);
    // A substantial README lacking a detail, with the README sent: not eligible.
    expect(codesOf(failingAbout("description_incomplete", "readme"))).toEqual([]);
  });

  test("decision 2: with no README on record the finding is named as the README's", () => {
    const r = report(
      {
        questions: { ...PASSED, complete_and_honest: "fail" },
        findings: [blocker("complete_and_honest", "description_incomplete", "readme")],
      },
      { documents: { ...(evidenceFor().documents as Record<string, string>), readme: "absent" } },
    );
    expect(codesOf(r)).toEqual(["readme_missing_or_stub"]);
    expect(mailSays(codesOf(r))[0]).toContain(AUTO_DENY_CODE_COPY.readme_missing_or_stub.statement);
  });

  test("decision 2: about dataset_description.json it is itself, about another document not eligible", () => {
    expect(codesOf(failingAbout("description_incomplete", "dataset_description"))).toEqual([
      "description_incomplete",
    ]);
    for (const document of ["participants_json", "changes", "license", null]) {
      expect({
        document,
        codes: codesOf(failingAbout("description_incomplete", document)),
      }).toEqual({ document, codes: [] });
    }
  });

  test("decision 2: readme_missing_or_stub is said only of the README", () => {
    expect(codesOf(failingAbout("readme_missing_or_stub", "readme"))).toEqual([
      "readme_missing_or_stub",
    ]);
    expect(codesOf(failingAbout("readme_missing_or_stub", null))).toEqual([
      "readme_missing_or_stub",
    ]);
    for (const document of ["dataset_description", "changes", "participants_json"]) {
      expect({
        document,
        codes: codesOf(failingAbout("readme_missing_or_stub", document)),
      }).toEqual({ document, codes: [] });
    }
  });

  test("every finding needs the model's own fail, never one a platform fact lowered", () => {
    // The model passed authors_and_license with a placeholder blocker (the parser makes that
    // unknown), and the platform's placeholder fact lowered it to fail: not eligible.
    const r = report(
      {
        questions: { ...PASSED, authors_and_license: "pass" },
        findings: [blocker("authors_and_license", "authors_placeholder", "dataset_description")],
      },
      { authors_count: 1, placeholder_authors: 1 },
    );
    expect(r.questions.authors_and_license).toBe("unknown");
    expect(verdictOf(reportReasons(r))).toBe("fail");
    expect(codesOf(r)).toEqual([]);
    // The same finding beside the model's own fail is eligible.
    const own = report(
      {
        questions: { ...PASSED, authors_and_license: "fail" },
        findings: [blocker("authors_and_license", "authors_placeholder", "dataset_description")],
      },
      { authors_count: 1, placeholder_authors: 1 },
    );
    expect(codesOf(own)).toEqual(["authors_placeholder"]);
  });

  test("end to end: nm001019's own dataset_description.json gives the placeholder fact", () => {
    // The file as the review job read it at the reviewed commit; its only author is the converter's
    // pointer, which the stored evidence (made before the rule) counted as no placeholder.
    const text = readFileSync(
      join(import.meta.dir, "fixtures/auto-deny-shadow/nm001019-dataset_description.json"),
      "utf-8",
    );
    expect(shadowRun.reviews.nm001019.report.evidence.placeholder_authors).toBe(0);
    const facts = descriptionFacts(text, null, false, { readmeUnread: true });
    expect(facts).toMatchObject({ authors_count: 1, placeholder_authors: 1, minimums: "failed" });
    expect(facts.minimum_failures).toContain("authors_missing");
    // The job's facts in the stored report: the parser accepts them, the platform now agrees with
    // the model's placeholder blocker, and that blocker (the model failed the question) is eligible.
    const r = shadow("nm001019", facts);
    expect(answersOf(r).answers.authors_and_license).toBe("fail");
    expect(reportReasons(r).map((x) => x.code)).toContain("submission_minimum_failed");
    expect(codesOf(r)).toContain("authors_placeholder");
    expect(codesOf(r)).not.toContain("license_missing");
    // Had the model answered unknown, the fact alone lowers the question to fail, and nothing on it
    // is eligible: the fact is the same in both runs.
    const body = structuredClone(shadowRun.reviews.nm001019.report) as Record<string, unknown>;
    body.questions = {
      ...(body.questions as Record<string, string>),
      authors_and_license: "unknown",
    };
    body.findings = (body.findings as Array<Record<string, unknown>>).filter(
      (f) => f.question !== "authors_and_license",
    );
    body.evidence = { ...(body.evidence as Record<string, unknown>), ...facts };
    const unknown = parsePublicationReviewReport(body);
    expect(answersOf(unknown).notes).toContainEqual(
      expect.objectContaining({ question: "authors_and_license", fact: "placeholder_author" }),
    );
    expect(codesOf(unknown)).not.toContain("authors_placeholder");
  });

  test("the converter placeholder is eligible only where the model itself failed the question", () => {
    // The first runs of the shadow run whose only author is the converter's pointer.
    for (const id of ["nm001019", "nm001037", "nm001039", "nm001041"] as const) {
      const r = shadow(id);
      expect(r.questions.authors_and_license).toBe("fail");
      expect({ id, e: codesOf(r).includes("authors_placeholder") }).toEqual({ id, e: true });
    }
  });

  test("decision 3: a reader note coded as steering does not deny (nm000622)", () => {
    const r = shadow("nm000622");
    expect(r.steering).toBe(true);
    expect(r.findings.filter((f) => f.code === "steering_attempt").map((f) => f.severity)).toEqual([
      "note",
    ]);
    // The review still fails on it, and a person decides.
    expect(verdictOf(reportReasons(r))).toBe("fail");
    expect(autoDenyEligibility(input({ report: r }))).toEqual({
      eligible: false,
      why: "no_eligible_reason",
    });
  });

  test("decision 4: a Name that is a declared publication's title is not called not descriptive (nm001028)", () => {
    const r = shadow("nm001028");
    // The name rule reads dataset sources only, and the source is a journal article on Zenodo.
    expect(r.evidence.name_upstream).toBe("not_applicable");
    const name =
      "Cross-validating models of continuous data from simulation and experiment by using linear regression and artificial neural networks";
    // The title as DataCite gives it for 10.5281/zenodo.3648065 (test/fixtures/license-lineage/66).
    const title = name;
    expect(nameFollowsAnySourceTitle(name, [title])).toBe(true);
    // Folding: case, punctuation and British spelling do not make it another title.
    expect(nameFollowsAnySourceTitle(name.toUpperCase().replace(/ /g, "  "), [title])).toBe(true);
    // Its README finding is description_incomplete about a README that exists: not eligible.
    expect(codesOf(r, true)).toEqual([]);
    // Not known (a snapshot written before the titles were kept) protects the Name too.
    expect(codesOf(r, null)).toEqual([]);
    // A Name that follows no source's title keeps the finding eligible.
    expect(codesOf(r, false)).toEqual(["name_not_descriptive"]);
    expect(autoDenyEligibility(input({ report: r, nameFollowsASource: true }))).toEqual({
      eligible: false,
      why: "no_eligible_reason",
    });
  });

  test("the reports production would deny for the right reasons keep them", () => {
    expect(codesOf(shadow("nm001016"))).toEqual(["readme_missing_or_stub"]);
    expect(codesOf(shadow("nm001037"))).toEqual(["readme_missing_or_stub", "authors_placeholder"]);
  });
});

describe("the stored codes of an agreement (migration 0164)", () => {
  test("written in the codes' order, read back, and anything else reads as none", () => {
    expect(autoDenyCodesColumn(["authors_placeholder", "readme_missing_or_stub"])).toBe(
      "readme_missing_or_stub,authors_placeholder",
    );
    expect(autoDenyCodesColumn([])).toBeNull();
    expect(autoDenyCodesOf("readme_missing_or_stub,authors_placeholder")).toEqual([
      "readme_missing_or_stub",
      "authors_placeholder",
    ]);
    for (const raw of [
      null,
      "",
      "nonsense",
      "readme_missing_or_stub,",
      "steering_attempt,steering_attempt",
      7,
    ]) {
      expect({ raw, codes: autoDenyCodesOf(raw) }).toEqual({ raw, codes: null });
    }
    expect(autoDenyCodeLine("readme_missing_or_stub")).toBe(
      `readme_missing_or_stub: ${AUTO_DENY_CODE_COPY.readme_missing_or_stub.statement}`,
    );
  });
});
