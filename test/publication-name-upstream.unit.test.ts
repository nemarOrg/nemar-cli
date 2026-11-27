/**
 * The name rule in the publication review (the owner's rule of 2026-11-27): the evidence's
 * `name_upstream` word as the Worker's parser reads it, the two reasons it derives, the automatic
 * denial's two exceptions (ADR 0139 as amended), and the decision card's panel and next action.
 * Every report here is a body the production parser accepts, parsed by it.
 *
 * Mutation checks (applied one at a time, run, restored from a copy):
 *  - dropping the `report.questions.name_adequate === "fail"` condition in `eligibleCodesOf` turns
 *    "the name fact alone is never eligible" red;
 *  - dropping the `nameFromUpstream` skip turns "name_not_descriptive is not eligible when the
 *    Name is the upstream's title" red;
 *  - inverting the skip (skipping unless `matches`) turns "name_not_descriptive stays eligible"
 *    red;
 *  - deriving no reason from `differs` turns "differs fails the request" red.
 *
 * CI TIER: unit-pure. No network, no database.
 */

import { describe, expect, test } from "bun:test";
import {
  ACTION_SENTENCE,
  ASK_DEPOSITOR_NAME_SENTENCE,
  UPSTREAM_NAME_LINE,
  buildDecisionCard,
  cardLineageOf,
  parseServedMetadata,
  servedMetadataJson,
} from "../backend/src/services/decision-card";
import { v3PublicationReport } from "../backend/test/helpers/publication-review";
import { REGISTRY_TEXT_LABEL } from "../shared/contract/decision-card";
import type { LineageResult } from "../shared/license-lineage";
import { nameFollowsUpstream } from "../shared/name-follows-upstream";
import {
  AUTO_DENY_CODE_COPY,
  CONFIRMING_MODEL,
  autoDenyEligibility,
  confirmationOf,
  deniedReasonOf,
  eligibleCodesOf,
} from "../shared/publication-auto-deny";
import {
  type InputSource,
  PUBLICATION_PROMPT_VERSION,
  type PublicationReviewReport,
  type Question,
  REASONS,
  parsePublicationReviewEvidence,
  parsePublicationReviewReport,
  parseReviewInputs,
  previousDenialReasonsOf,
  reportReasons,
  verdictOf,
} from "../shared/publication-review";
import { GATE_CLEAR, SNAPSHOT, detailOf, reasonView } from "./helpers/decision-card-fixtures";
import { fullInputs } from "./helpers/review-inputs";

const PASSING = {
  complete_and_honest: "pass",
  meets_standards: "pass",
  authors_and_license: "pass",
  name_adequate: "pass",
} as const;

/** A version-3 report with the name word `name` (absent when undefined) and the model's answers. */
function report(
  name: string | undefined,
  o: {
    questions?: Partial<Record<Question, string>>;
    findings?: unknown[];
    model?: "claude-haiku-5-5" | "claude-sonnet-5-5";
  } = {},
): PublicationReviewReport {
  const body = v3PublicationReport(name === undefined ? {} : { name_upstream: name }, {
    questions: { ...PASSING, ...o.questions },
    findings: o.findings ?? [],
  });
  if (o.model === "claude-sonnet-5-5") {
    body.model = o.model;
    body.record = {
      ...(body.record as Record<string, unknown>),
      models: [{ model: o.model, effort: "max" }],
    };
    return parsePublicationReviewReport(body, { models: [CONFIRMING_MODEL] });
  }
  return parsePublicationReviewReport(body);
}

/** The model failed `name_adequate` with a blocker of `code`. */
function nameFailed(
  name: string | undefined,
  code = "name_not_descriptive",
  model?: "claude-sonnet-5-5",
) {
  return report(name, {
    questions: { name_adequate: "fail" },
    findings: [
      {
        question: "name_adequate",
        severity: "blocker",
        code,
        document: "dataset_description",
        note: "n",
      },
    ],
    model,
  });
}

const eligibility = (r: PublicationReviewReport) =>
  autoDenyEligibility({
    state: "reported",
    report: r,
    current: true,
    requestStatus: "requested",
    anonymous: false,
    earlierAutoDenials: 0,
  });

describe("the evidence's name word", () => {
  test("a version-3 block reads with it and without it; without it nothing changes", () => {
    for (const w of ["matches", "differs", "not_applicable", "unknown"]) {
      expect(report(w).evidence.name_upstream).toBe(w);
    }
    const before = report(undefined);
    expect("name_upstream" in before.evidence).toBe(false);
    // A stored report re-parses to itself, with or without the word.
    for (const r of [before, report("differs")]) {
      expect(parsePublicationReviewReport(JSON.parse(JSON.stringify(r)))).toEqual(r);
    }
  });

  test("an unknown word, a block with no lineage, or a version-2 block with it, is refused", () => {
    const v3 = v3PublicationReport().evidence as Record<string, unknown>;
    expect(() => parsePublicationReviewEvidence({ ...v3, name_upstream: "maybe" })).toThrow();
    expect(() => parsePublicationReviewEvidence({ ...v3, name_upstream: null })).toThrow();
    expect(() =>
      parsePublicationReviewEvidence({ ...v3, lineage: null, name_upstream: "matches" }),
    ).toThrow();
    const { license_file: _l, description_keys_not_shown_names: _k, ...v2 } = v3;
    expect(() =>
      parsePublicationReviewEvidence({
        ...v2,
        lineage: { outcome: "compatible", credited: false },
        name_upstream: "matches",
      }),
    ).toThrow();
  });
});

describe("the served sources' latest flag", () => {
  test("the inputs parser keeps resolved_latest only as true, and a body without it reads as before", () => {
    const body = fullInputs();
    const [src] = body.lineage.sources as [InputSource];
    const read = (extra: Record<string, unknown>) =>
      parseReviewInputs({
        ...body,
        lineage: { ...body.lineage, sources: [{ ...src, ...extra }] },
      }).lineage.sources[0];
    expect(read({ resolved_latest: true })?.resolved_latest).toBe(true);
    for (const v of [false, "true", 1, null]) {
      expect("resolved_latest" in (read({ resolved_latest: v }) ?? {}), String(v)).toBe(false);
    }
    expect("resolved_latest" in (read({}) ?? {})).toBe(false);
  });
});

describe("the reasons", () => {
  test("differs fails the request whatever the model answered, and an override clears it", () => {
    const r = report("differs");
    expect(reportReasons(r)).toEqual([{ code: "name_differs_from_upstream", detail: null }]);
    expect(verdictOf(reportReasons(r))).toBe("fail");
    expect(REASONS.name_differs_from_upstream).toMatchObject({
      class: "fail",
      clearedBy: "override",
    });
  });

  test("unknown asks for an administrator, never a fail", () => {
    const r = report("unknown");
    expect(reportReasons(r)).toEqual([{ code: "name_upstream_unconfirmed", detail: null }]);
    expect(verdictOf(reportReasons(r))).toBe("action_required");
  });

  test("matches, not applicable and no word add no reason", () => {
    for (const w of ["matches", "not_applicable", undefined]) {
      expect(reportReasons(report(w))).toEqual([]);
    }
  });

  test("the sentences name the rule, and no terminal", () => {
    for (const code of ["name_differs_from_upstream", "name_upstream_unconfirmed"] as const) {
      expect(REASONS[code].sentence).toContain("upstream dataset");
      expect(REASONS[code].cure).toContain(
        "an author-year naming the dataset's authors may follow it",
      );
      expect(REASONS[code].command).toBeUndefined();
    }
  });

  test("a denial for the name can be shown to the next review; the undecided word cannot", () => {
    expect(previousDenialReasonsOf("question_failed,name_differs_from_upstream")).toEqual([
      "question_failed",
      "name_differs_from_upstream",
    ]);
    expect(previousDenialReasonsOf("name_upstream_unconfirmed")).toEqual([]);
  });
});

describe("the automatic denial (ADR 0139 as amended on 2026-11-27)", () => {
  test("the name fact alone is never eligible: the model's own name question must fail too", () => {
    expect(eligibility(report("differs"))).toEqual({ eligible: false, why: "no_eligible_reason" });
    // A fail of another question with a code that is not eligible does not lend it eligibility.
    const other = report("differs", {
      questions: { complete_and_honest: "fail" },
      findings: [
        {
          question: "complete_and_honest",
          severity: "blocker",
          code: "other",
          document: null,
          note: "n",
        },
      ],
    });
    expect(eligibility(other)).toEqual({ eligible: false, why: "no_eligible_reason" });
  });

  test("with the model's name fail, the fact is eligible under its own reason", () => {
    // The model's code is not itself eligible, so the fact is the only eligible code.
    expect(eligibleCodesOf(nameFailed("differs", "other"))).toEqual({
      codes: ["name_differs_from_upstream"],
      reasons: ["name_differs_from_upstream"],
    });
    expect(eligibleCodesOf(nameFailed("differs"))).toEqual({
      codes: ["name_not_descriptive", "name_differs_from_upstream"],
      reasons: ["question_failed", "name_differs_from_upstream"],
    });
  });

  test("two runs that both failed the name agree on the fact, and the denial names it", () => {
    const side = (r: PublicationReviewReport) => ({
      eligibility: eligibility(r),
      inputDigest: "ab".repeat(32),
      promptVersion: PUBLICATION_PROMPT_VERSION,
    });
    const first = side(nameFailed("differs", "other"));
    const agreed = confirmationOf(first, side(nameFailed("differs", "other", "claude-sonnet-5-5")));
    expect(agreed).toEqual({
      agrees: true,
      codes: ["name_differs_from_upstream"],
      reasons: ["name_differs_from_upstream"],
    });
    if (agreed.agrees) expect(deniedReasonOf(agreed.reasons)).toBe("name_differs_from_upstream");
    // A confirming model that passed the name does not confirm, though the fact is in both.
    const passed = report("differs", { model: "claude-sonnet-5-5" });
    expect(confirmationOf(first, side(passed))).toEqual({ agrees: false });
  });

  test("name_not_descriptive is not eligible when the Name is the upstream's title", () => {
    expect(eligibility(nameFailed("matches"))).toEqual({
      eligible: false,
      why: "no_eligible_reason",
    });
    // Its fail still stands: an administrator decides.
    expect(verdictOf(reportReasons(nameFailed("matches")))).toBe("fail");
  });

  test("name_not_descriptive stays eligible otherwise", () => {
    for (const w of ["not_applicable", "unknown", undefined]) {
      expect(eligibleCodesOf(nameFailed(w)).codes, String(w)).toEqual(["name_not_descriptive"]);
    }
    expect(eligibleCodesOf(nameFailed("differs")).codes).toContain("name_not_descriptive");
  });

  test("a Name that follows only a README candidate shields nothing: the exception needs a declared source", () => {
    const candidate = {
      title: "Resting EEG",
      status: "resolved",
      origin: "readme",
      outcome: "compatible" as const,
    };
    const word = nameFollowsUpstream("Resting EEG", [candidate]);
    expect(word).toBe("not_applicable");
    expect(eligibleCodesOf(nameFailed(word)).codes).toEqual(["name_not_descriptive"]);
    // The same title declared in SourceDatasets is the upstream's name, and shields it.
    const declared = nameFollowsUpstream("Resting EEG", [
      { ...candidate, origin: "source_datasets" },
    ]);
    expect(declared).toBe("matches");
    expect(eligibleCodesOf(nameFailed(declared)).codes).toEqual([]);
  });

  test("the exception is about the name only: another eligible finding beside it still denies", () => {
    const r = report("matches", {
      questions: { name_adequate: "fail", complete_and_honest: "fail" },
      findings: [
        {
          question: "name_adequate",
          severity: "blocker",
          code: "name_not_descriptive",
          document: null,
          note: "n",
        },
        {
          question: "complete_and_honest",
          severity: "blocker",
          code: "readme_missing_or_stub",
          document: "readme",
          note: "n",
        },
      ],
    });
    expect(eligibleCodesOf(r).codes).toEqual(["readme_missing_or_stub"]);
  });

  test("the depositor's copy names the rule and the shapes of the suffix", () => {
    const c = AUTO_DENY_CODE_COPY.name_differs_from_upstream;
    expect(c.statement).toBe(REASONS.name_differs_from_upstream.sentence);
    expect(c.remedy).toContain("an author-year naming the dataset's authors may follow it");
    expect(c.anchor).toEndWith("#automatic-denial-name-differs-from-upstream");
  });
});

describe("the decision card", () => {
  const reasonsOf = (r: PublicationReviewReport) =>
    reportReasons(r).map((x) => ({ ...reasonView(x.code), detail: x.detail }));
  const card = (
    r: PublicationReviewReport,
    over: Parameters<typeof detailOf>[0] = {},
    titles?: string[],
  ) =>
    buildDecisionCard({
      detail: detailOf(
        { reasons: reasonsOf(r), outcome: verdictOf(reportReasons(r)), ...over },
        r.evidence as unknown as Record<string, unknown>,
        { questions: { ...r.questions } },
      ),
      freshCovered: false,
      gate: GATE_CLEAR,
      autoDenyState: null,
      snapshot:
        titles === undefined
          ? SNAPSHOT
          : {
              ...SNAPSHOT,
              lineage: {
                ...(SNAPSHOT.lineage as NonNullable<typeof SNAPSHOT.lineage>),
                upstream_titles: titles,
              },
            },
      current: null,
      freshLineage: null,
    });

  test("differs asks the depositor, in the sentence that names the rule, with the titles shown", () => {
    const c = card(report("differs"), {}, ["Resting EEG of healthy adults"]);
    expect(c.next_action.action).toBe("ask_depositor");
    expect(c.next_action.sentence).toBe(ASK_DEPOSITOR_NAME_SENTENCE);
    expect(c.next_action.sentence).toContain("be the upstream dataset's title");
    expect(c.upstream_name).toEqual({
      result: "differs",
      cue: "red",
      line: UPSTREAM_NAME_LINE.differs,
      titles: { label: REGISTRY_TEXT_LABEL, titles: ["Resting EEG of healthy adults"] },
    });
  });

  test("a blocked request asks the depositor in the general words, as before", () => {
    const c = card(report("differs"), { request_status: "blocked", block_reason: "minimums" });
    expect(c.next_action.action).toBe("ask_depositor");
    expect(c.next_action.sentence).toBe(ACTION_SENTENCE.ask_depositor);
  });

  test("the card sets a name fail aside only for a match on a declared source", () => {
    const src = { title: "Resting EEG", status: "resolved", outcome: "compatible" as const };
    const readmeOnly = nameFollowsUpstream("Resting EEG", [{ ...src, origin: "readme" }]);
    const declared = nameFollowsUpstream("Resting EEG", [{ ...src, origin: "source_datasets" }]);
    expect(card(nameFailed(readmeOnly)).next_action.action).toBe("deny");
    expect(card(nameFailed(declared)).next_action.action).toBe("administrator_reads");
  });

  test("unknown is amber and an administrator's to read", () => {
    const c = card(report("unknown"));
    expect(c.upstream_name.cue).toBe("amber");
    expect(c.next_action.action).toBe("administrator_reads");
  });

  test("a name fail on a Name that is the upstream's title is an administrator's, not a denial", () => {
    expect(card(nameFailed("matches")).next_action.action).toBe("administrator_reads");
    // Any other name fail is a denial, as before.
    expect(card(nameFailed("differs")).next_action.action).toBe("deny");
    expect(card(nameFailed("not_applicable")).next_action.action).toBe("deny");
  });

  test("matches and not applicable are green; a review before the rule is amber", () => {
    expect(card(report("matches")).upstream_name).toMatchObject({
      result: "matches",
      cue: "green",
    });
    expect(card(report("not_applicable")).upstream_name.cue).toBe("green");
    expect(card(report(undefined)).upstream_name).toMatchObject({
      result: null,
      cue: "amber",
      line: UPSTREAM_NAME_LINE.none,
    });
  });

  test("the snapshot keeps the dataset titles the lineage read, and an older snapshot still reads", () => {
    const lineage = {
      outcome: "compatible",
      resolved_at: "2026-11-27T12:00:00.000Z",
      dropped_doi_candidates: 0,
      sources: [
        {
          id: "10.1/a",
          title: "Resting EEG",
          status: "resolved",
          origin: "source_datasets",
          outcome: "compatible",
          declared_licenses: [],
        },
        {
          id: "10.1/b",
          title: "A paper",
          status: "publication",
          origin: "source_datasets",
          outcome: "source_is_publication",
          declared_licenses: [],
        },
      ],
    } as unknown as LineageResult;
    const served = cardLineageOf(lineage);
    expect(served.upstream_titles).toEqual(["Resting EEG"]);
    const round = parseServedMetadata(servedMetadataJson({ ...SNAPSHOT, lineage: served }));
    expect(round?.lineage?.upstream_titles).toEqual(["Resting EEG"]);
    // Written before the rule: no titles, and the snapshot is still the snapshot.
    expect(
      parseServedMetadata(servedMetadataJson(SNAPSHOT))?.lineage?.upstream_titles,
    ).toBeUndefined();
    // A hand-edited title list that is not strings is no snapshot.
    const bad = JSON.stringify({ ...SNAPSHOT, lineage: { ...served, upstream_titles: [1] } });
    expect(parseServedMetadata(bad)).toBeNull();
  });
});
