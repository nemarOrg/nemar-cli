/**
 * The administrator's decision card, as the Worker's pure builder makes it (ADR 0142, decision 4):
 * the license cue table rule by rule, the next action tier by tier, the rule that it never says
 * approve while a gate withholds approval (over every reason code and every screen gate), each
 * question's strongest finding, the dataset's own words as reviewed or not, and the served
 * snapshot's strict reader.
 *
 * The detail the card is built beside is assembled here from the real report parser's evidence and
 * the real reasons table, as the Worker's `publicationReviewDetail` would carry them; nothing the
 * builder decides is replaced.
 *
 * Mutation checks (each applied, run, and restored from a copy; each turned a named test red):
 *   - `license_file_differs` made amber ("a LICENSE that names another license is red");
 *   - `needs_permission` ignoring the recorded permission (three tests, "needs_permission and
 *     share-alike covered by a recorded permission are green" among them);
 *   - `redistribution_prohibited` exempted by a permission ("redistribution stays red even with a
 *     recorded permission");
 *   - the fresher lineage covered by the review's permission ("the review's permission never covers
 *     the card's fresher lineage");
 *   - the head check removed from the door and the tiers ("a screened commit that is no longer
 *     main ..."; also the route test in backend/test/decision-card.test.ts);
 *   - the request-status conditions removed ("only a requested request, or a stopped approval with
 *     nothing published, suggests approve");
 *   - the `cue !== "red"` of `approvalWouldPass` removed ("a red cue never suggests approve, even
 *     with every gate clear");
 *   - the `d.reasons.length === 0` of `approvalWouldPass` removed, alone and together with the
 *     reason tiers' fall-through to `ask_depositor` ("no reason code, alone, ever leads to
 *     approve"); the fall-through alone is an equivalent mutant, because the door still refuses;
 *   - the platform rank of `strongestFindingOf` removed ("a platform fact comes first, then a
 *     platform finding, then blocker, concern, note").
 *
 * CI TIER: unit-pure. Pure: no database, no network, no spawn.
 */

import { describe, expect, test } from "bun:test";
import {
  ACTION_COMMAND,
  ACTION_SENTENCE,
  type CardDetail,
  type CueFacts,
  GREEN_REASON,
  LICENSE_CUE_RULES,
  NOT_AS_REVIEWED_NOTE,
  NOT_REVIEWED_NOTE,
  PERMITTED_GREEN_REASON,
  SERVED_METADATA_MAX,
  type ServedMetadata,
  approvalWouldPass,
  buildDecisionCard,
  cardDescriptionOf,
  cardEnrichmentOf,
  cardLineageOf,
  licenseCueOf,
  nextActionOf,
  parseServedMetadata,
  servedMetadataJson,
} from "../backend/src/services/decision-card";
import {
  CARD_DESCRIPTION_MAX,
  DECISION_ACTIONS,
  DEPOSITOR_TEXT_LABEL,
  MODEL_TEXT_LABEL,
  REGISTRY_TEXT_LABEL,
} from "../shared/contract/decision-card";
import { LICENSE_MATCHER_VERSION } from "../shared/license-file";
import type { LineageResult, LineageSource } from "../shared/license-lineage";
import {
  AUTO_DENY_CODE_COPY,
  AUTO_DENY_STATES,
  AUTO_DENY_STATE_COPY,
} from "../shared/publication-auto-deny";
import { REASON_CODES, type ReasonCode } from "../shared/publication-review";
import { GATE_CLEAR, ID, SNAPSHOT, detailOf, reasonView } from "./helpers/decision-card-fixtures";

/** nm001028's source as the resolver records it: a Zenodo journal article that holds data. */
const PAPER_TITLE =
  "Cross-validating models of continuous data from simulation and experiment by using linear regression and artificial neural networks";
const SOURCE_BASE = {
  creators: [],
  publisher: null,
  license_version: "4.0",
  raw: null,
  origin: "source_datasets",
} as const;
const PAPER_AND_OSF: LineageResult = {
  outcome: "source_is_publication",
  sources: [
    {
      ...SOURCE_BASE,
      id: "10.5281/zenodo.3648065",
      resolver: "datacite",
      resource_type: "Text",
      title: PAPER_TITLE,
      license: "cc-by",
      declared_licenses: [{ text: "Creative Commons Attribution 4.0 International", url: null }],
      evidence_url: null,
      status: "publication",
      outcome: "source_is_publication",
      registry_files: { type: "Journal article", files: 1, data_files: 1, examples: ["Data.zip"] },
    },
    {
      ...SOURCE_BASE,
      id: "10.17605/osf.io/fx4ud",
      resolver: "osf",
      resource_type: "Dataset",
      title: "fNIRS mother-infant",
      license: "cc-by",
      declared_licenses: [{ text: "CC-By Attribution 4.0 International", url: null }],
      evidence_url: null,
      status: "resolved",
      outcome: "compatible_attribution",
      doi_registered: false,
    },
  ] as LineageSource[],
  resolved_at: "2026-11-28T05:53:01.949Z",
} as unknown as LineageResult;

const card = (detail: CardDetail, o: Partial<Parameters<typeof buildDecisionCard>[0]> = {}) =>
  buildDecisionCard({
    detail,
    freshCovered: false,
    gate: GATE_CLEAR,
    autoDenyState: "none",
    snapshot: SNAPSHOT,
    current: null,
    freshLineage: null,
    ...o,
  });

/** Facts every rule leaves green. */
const GREEN: CueFacts = {
  fieldPresent: true,
  field: "CC-BY-4.0",
  file: { state: "matches", spdx: "CC-BY-4.0", additions: false, expression: null },
  matcher: LICENSE_MATCHER_VERSION,
  lineages: [{ outcome: "compatible", covered: false }],
  credited: false,
  enrichmentLicense: "CC-BY-4.0",
};

const file = (state: NonNullable<CueFacts["file"]>["state"], expression: string | null = null) => ({
  state,
  spdx: state === "absent" || state === "annexed" ? null : "CC-BY-4.0",
  additions: false,
  expression,
});

const reasonOf = (code: string) => {
  const rule = LICENSE_CUE_RULES.find((r) => r.code === code);
  if (!rule) throw new Error(`no rule ${code}`);
  return rule.reason;
};

describe("the license cue, rule by rule", () => {
  test("clean facts are green, with the green sentence and no reasons", () => {
    expect(licenseCueOf(GREEN)).toEqual({ cue: "green", reason: GREEN_REASON, reasons: [] });
  });

  test("before deploy 3 an unresolved lineage heads the card, not the unavailable matcher (seam review of #2486)", () => {
    const cue = licenseCueOf({
      ...GREEN,
      file: { ...file("unreadable"), spdx: null },
      matcher: "unavailable",
      lineages: [{ outcome: "unresolved", covered: false }],
    });
    const reasonOf = (code: string) => LICENSE_CUE_RULES.find((r) => r.code === code)?.reason;
    expect(cue.cue).toBe("amber");
    expect(cue.reason).toBe(reasonOf("lineage_unresolved"));
    expect(cue.reasons.at(-1)).toBe(reasonOf("matcher_unavailable"));
    // Unscanned is not unread: no "could not be read in full" while the matcher is unavailable.
    expect(cue.reasons).not.toContain(reasonOf("license_file_unreadable"));
  });

  const cases: Array<[string, Partial<CueFacts>, "red" | "amber", string]> = [
    ["no License field is red", { fieldPresent: false, field: null }, "red", "no_license_field"],
    [
      "a LICENSE that names another license is red",
      { file: { ...file("matches_other"), spdx: "CC-BY-NC-4.0" } },
      "red",
      "license_file_differs",
    ],
    [
      "needs_permission is red",
      { lineages: [{ outcome: "needs_permission", covered: false }] },
      "red",
      "needs_permission",
    ],
    [
      "a share-alike mismatch is red",
      { lineages: [{ outcome: "share_alike_mismatch", covered: false }] },
      "red",
      "share_alike_mismatch",
    ],
    [
      "redistribution_prohibited without a recorded permission is red",
      { lineages: [{ outcome: "redistribution_prohibited", covered: false }] },
      "red",
      "redistribution_prohibited",
    ],
    [
      "an unrecognized LICENSE is amber",
      { file: file("unrecognized") },
      "amber",
      "license_file_unrecognized",
    ],
    [
      "a compound expression is amber, as unrecognized",
      { file: file("unrecognized", "MIT OR Apache-2.0") },
      "amber",
      "license_file_unrecognized",
    ],
    ["an annexed LICENSE is amber", { file: file("annexed") }, "amber", "license_file_annexed"],
    [
      "an unreadable LICENSE is amber",
      { file: file("unreadable") },
      "amber",
      "license_file_unreadable",
    ],
    [
      "no LICENSE beside a recognized field is amber",
      { file: file("absent") },
      "amber",
      "license_file_absent_recognized",
    ],
    [
      "no LICENSE beside a field that does not normalize is amber",
      { file: file("absent"), field: "Ask the authors", enrichmentLicense: null },
      "amber",
      "license_file_absent_unrecognized",
    ],
    [
      "the matcher unavailable is amber, and says so first",
      { matcher: "unavailable", file: file("unreadable") },
      "amber",
      "matcher_unavailable",
    ],
    [
      "no LICENSE identification on record is amber",
      { file: null },
      "amber",
      "license_file_not_identified",
    ],
    [
      "an unresolved lineage is amber",
      { lineages: [{ outcome: "unresolved", covered: false }] },
      "amber",
      "lineage_unresolved",
    ],
    [
      "a source that is a publication is amber",
      { lineages: [{ outcome: "source_is_publication", covered: false }] },
      "amber",
      "source_is_publication",
    ],
    [
      "an uncredited attribution source is amber",
      { lineages: [{ outcome: "compatible_attribution", covered: false }], credited: false },
      "amber",
      "uncredited_attribution",
    ],
    [
      "an enrichment license that disagrees is amber",
      { enrichmentLicense: "CC0-1.0" },
      "amber",
      "enrichment_license_disagrees",
    ],
  ];
  for (const [name, over, cue, code] of cases) {
    test(name, () => {
      const got = licenseCueOf({ ...GREEN, ...over });
      expect(got.cue).toBe(cue);
      expect(got.reason).toBe(reasonOf(code));
    });
  }

  test("every rule of the table is exercised above, so none is dead", () => {
    const named = new Set(cases.map(([, , , code]) => code));
    expect(LICENSE_CUE_RULES.map((r) => r.code).filter((c) => !named.has(c))).toEqual([]);
  });

  test("redistribution stays red even with a recorded permission (lead ruling)", () => {
    const got = licenseCueOf({
      ...GREEN,
      lineages: [{ outcome: "redistribution_prohibited", covered: true }],
    });
    expect(got.cue).toBe("red");
    expect(got.reason).toBe(reasonOf("redistribution_prohibited"));
  });

  test("needs_permission and share-alike covered by a recorded permission are green, and say so", () => {
    for (const outcome of ["needs_permission", "share_alike_mismatch"] as const) {
      const got = licenseCueOf({ ...GREEN, lineages: [{ outcome, covered: true }] });
      expect(got).toEqual({ cue: "green", reason: PERMITTED_GREEN_REASON, reasons: [] });
    }
  });

  test("a fresher outcome the recorded permission does not cover still counts against the cue", () => {
    const got = licenseCueOf({
      ...GREEN,
      lineages: [
        { outcome: "needs_permission", covered: true },
        { outcome: "share_alike_mismatch", covered: false },
      ],
    });
    expect(got.cue).toBe("red");
    expect(got.reason).toBe(reasonOf("share_alike_mismatch"));
  });

  test("a credited attribution source, and a matching enrichment, stay green", () => {
    expect(
      licenseCueOf({
        ...GREEN,
        lineages: [{ outcome: "compatible_attribution", covered: false }],
        credited: true,
      }).cue,
    ).toBe("green");
    expect(licenseCueOf({ ...GREEN, enrichmentLicense: "CC BY 4.0" }).cue).toBe("green");
  });

  test("red outranks amber: the reason is the red one, and every reason is listed", () => {
    const got = licenseCueOf({
      ...GREEN,
      fieldPresent: false,
      field: null,
      matcher: "unavailable",
    });
    expect(got.cue).toBe("red");
    expect(got.reason).toBe(reasonOf("no_license_field"));
    expect(got.reasons).toEqual([reasonOf("no_license_field"), reasonOf("matcher_unavailable")]);
  });

  test("a fresher lineage adds a reason and never removes the review's own", () => {
    const got = licenseCueOf({
      ...GREEN,
      lineages: [
        { outcome: "unresolved", covered: false },
        { outcome: "compatible", covered: false },
      ],
    });
    expect(got.cue).toBe("amber");
    const worse = licenseCueOf({
      ...GREEN,
      lineages: [
        { outcome: "unresolved", covered: false },
        { outcome: "needs_permission", covered: false },
      ],
    });
    expect(worse.cue).toBe("red");
  });

  test("through the builder: the review's permission never covers the card's fresher lineage", () => {
    const d = detailOf(
      {
        license_permission: {
          recorded_at: "2026-11-26 10:00:00",
          recorded_by: "admin",
          ticket_id: 412,
          line: "A license permission is on record.",
        },
      },
      { lineage: { outcome: "unresolved", credited: false, resolved_at: "2026-11-20 09:00:00" } },
    );
    const fresh = {
      outcome: "needs_permission" as const,
      credited: false,
      resolved_at: "2026-11-27T13:00:00.000Z",
      declared_licenses: [],
    };
    const uncoveredCard = card(d, { freshLineage: fresh, freshCovered: false });
    expect(uncoveredCard.license.cue).toBe("red");
    expect(uncoveredCard.license.fresh_lineage?.permission_covers).toBe(false);
    const coveredCard = card(d, { freshLineage: fresh, freshCovered: true });
    expect(coveredCard.license.cue).toBe("amber");
  });

  test("through the builder: the review's facts, the snapshot's field and the record's matcher", () => {
    const red = card(detailOf({}, { license_file: { ...file("matches_other"), spdx: "MIT" } }));
    expect(red.license.cue).toBe("red");
    expect(red.license.license_file?.state).toBe("matches_other");
    const unavailable = card(
      detailOf(
        {},
        {},
        {
          reproducibility: {
            ...(detailOf().review?.reproducibility ?? ({} as never)),
            license_matcher: "unavailable",
          },
        },
      ),
    );
    expect(unavailable.license.reason).toBe("License matcher unavailable.");
    const noField = card(detailOf({}, { license_field: false }));
    expect(noField.license.cue).toBe("red");
  });
});

describe("the next action", () => {
  const clean = detailOf();

  test("a clean request suggests approve, with its sentence and command", () => {
    const c = card(clean);
    expect(c.next_action).toEqual({
      action: "approve",
      sentence: ACTION_SENTENCE.approve,
      command: `nemar admin dataset publish approve ${ID}`,
    });
  });

  test("no reason code, alone, ever leads to approve", () => {
    let visited = 0;
    for (const code of REASON_CODES) {
      const d = detailOf({ reasons: [reasonView(code)] });
      expect(
        nextActionOf(d, {
          cue: "green",
          autoDenyState: null,
          freshBetter: false,
          unresolved: false,
          ...GATE_CLEAR,
        }),
      ).not.toBe("approve");
      expect(approvalWouldPass(d, "green", GATE_CLEAR)).toBe(false);
      visited++;
    }
    expect(visited).toBe(REASON_CODES.length);
  });

  test("no screen gate but clear or exempt leads to approve", () => {
    for (const gate of ["blocks", "acknowledge", "rerun", "wait"] as const) {
      const d = detailOf({ screen_gate: gate });
      expect(card(d).next_action.action).not.toBe("approve");
    }
    expect(card(detailOf({ screen_gate: "exempt" })).next_action.action).toBe("approve");
  });

  test("a blocked request never suggests approve", () => {
    const d = detailOf({ request_status: "blocked", block_reason: "minimums" });
    expect(card(d).next_action.action).toBe("ask_depositor");
  });

  test("a red cue never suggests approve, even with every gate clear", () => {
    const d = detailOf({}, { license_file: { ...file("matches_other"), spdx: "MIT" } });
    expect(d.reasons).toEqual([]);
    expect(card(d).next_action.action).toBe("administrator_reads");
    // The door itself refuses a red cue, whatever the tiers before it decided.
    expect(approvalWouldPass(clean, "red", GATE_CLEAR)).toBe(false);
    expect(approvalWouldPass(clean, "amber", GATE_CLEAR)).toBe(true);
  });

  test("a stale head suggests running the screen again, an unchecked one waiting; neither approve", () => {
    for (const [head, action] of [
      ["stale", "rerun_screen"],
      ["unverified", "wait"],
    ] as const) {
      const c = card(clean, { gate: { head, approvalInFlight: false } });
      expect(c.next_action.action).toBe(action);
      expect(c.identifier_screen.head).toBe(head);
      expect(c.identifier_screen.head_line).not.toBeNull();
      expect(approvalWouldPass(clean, "green", { head, approvalInFlight: false })).toBe(false);
    }
    expect(card(clean).identifier_screen.head_line).toBeNull();
  });

  test("only a requested request, or a stopped approval with nothing published, suggests approve", () => {
    const stopped = detailOf({ request_status: "approving" });
    expect(card(stopped).next_action.action).toBe("approve");
    const running = card(stopped, { gate: { head: "current", approvalInFlight: true } });
    expect(running.next_action.action).toBe("wait");
    expect(approvalWouldPass(stopped, "green", { head: "current", approvalInFlight: true })).toBe(
      false,
    );
    const publishing = detailOf({ request_status: "approving", started_publishing: true });
    expect(card(publishing).next_action.action).toBe("administrator_reads");
    expect(approvalWouldPass(publishing, "green", GATE_CLEAR)).toBe(false);
    for (const status of ["published", "denied"]) {
      const over = detailOf({ request_status: status });
      expect(card(over).next_action.action).toBe("administrator_reads");
      expect(approvalWouldPass(over, "green", GATE_CLEAR)).toBe(false);
    }
  });

  const tiers: Array<[string, ReasonCode[], string]> = [
    ["a minimum that failed: the depositor", ["submission_minimum_failed"], "ask_depositor"],
    ["a screen still running: wait", ["identifier_screen_pending"], "wait"],
    ["a screen with no verdict: run it again", ["identifier_screen_not_run"], "rerun_screen"],
    ["a review not started: start it", ["review_not_started"], "start_review"],
    ["a review running: wait", ["review_running"], "wait"],
    ["a failed question: deny", ["question_failed"], "deny"],
    ["steering: deny", ["steering_attempt"], "deny"],
    ["text withheld: an administrator reads", ["text_withheld"], "administrator_reads"],
    ["an unknown question: an administrator reads", ["question_unknown"], "administrator_reads"],
    [
      "BIDS unconcluded: an administrator reads",
      ["bids_unconcluded_at_review"],
      "administrator_reads",
    ],
    ["a DOI state: an administrator reads", ["doi_state_unexpected"], "administrator_reads"],
    ["a version missing: the depositor", ["version_missing"], "ask_depositor"],
    [
      "a lineage that needs evidence: record the permission",
      ["license_lineage_unconfirmed"],
      "record_license_permission",
    ],
    [
      "the acknowledgment alone: acknowledge",
      ["identifier_screen_needs_acknowledgment"],
      "acknowledge_screen",
    ],
    [
      "the depositor's cure comes before the screen's wait",
      ["submission_minimum_failed", "identifier_screen_pending"],
      "ask_depositor",
    ],
    [
      "a fail comes before the acknowledgment",
      ["identifier_screen_needs_acknowledgment", "question_failed"],
      "deny",
    ],
  ];
  for (const [name, codes, action] of tiers) {
    test(name, () => {
      const d = detailOf({ reasons: codes.map(reasonView) });
      expect(card(d).next_action.action).toBe(action);
    });
  }

  test("a confirming run that agreed (shadow or capped) suggests deny, and the state is shown", () => {
    const d = detailOf({ reasons: [reasonView("question_unknown")] });
    for (const state of ["would_deny", "capped"]) {
      const c = card(d, { autoDenyState: state });
      expect(c.next_action.action).toBe("deny");
      expect(c.auto_deny).toEqual({
        state,
        line: AUTO_DENY_STATE_COPY[state as "would_deny"].statement,
        // An agreement recorded before migration 0164 kept no codes.
        codes: [],
        reasons: [],
      });
    }
    expect(card(d, { autoDenyState: "disagreed" }).next_action.action).toBe("administrator_reads");
    expect(card(d, { autoDenyState: "none" }).auto_deny).toBeNull();
    expect(card(d, { autoDenyState: "a word from elsewhere" }).auto_deny).toBeNull();
  });

  test("an unresolved lineage that resolves now: review again, both lineages shown", () => {
    const d = detailOf(
      { reasons: [reasonView("license_lineage_unconfirmed")] },
      { lineage: { outcome: "unresolved", credited: false, resolved_at: "2026-11-20 09:00:00" } },
    );
    const fresh = {
      outcome: "compatible" as const,
      credited: false,
      resolved_at: "2026-11-27T13:00:00.000Z",
      declared_licenses: ["10.5281/zenodo.123456: CC-BY-4.0"],
    };
    const c = card(d, { freshLineage: fresh });
    expect(c.next_action.action).toBe("review_again");
    expect(c.next_action.command).toBe(`nemar admin dataset publish start ${ID} --again`);
    expect(c.license.lineage?.resolved_at).toBe("2026-11-20 09:00:00");
    expect(c.license.fresh_lineage).toEqual({
      ...fresh,
      declared_licenses: { label: REGISTRY_TEXT_LABEL, licenses: fresh.declared_licenses },
      permission_covers: false,
    });
    // Never raises: the review's unresolved still stands as amber.
    expect(c.license.cue).toBe("amber");
    // Still unresolved now: NEMAR could not read the registry, so an administrator reads it.
    const still = card(d, { freshLineage: { ...fresh, outcome: "unresolved" } });
    expect(still.next_action.action).toBe("administrator_reads");
  });

  test("every action has a web sentence and a command", () => {
    for (const a of DECISION_ACTIONS) {
      expect(ACTION_SENTENCE[a].length).toBeGreaterThan(0);
      expect(ACTION_COMMAND[a].startsWith("nemar admin dataset publish ")).toBe(true);
    }
  });
});

describe("each question's strongest finding", () => {
  const finding = (severity: string, code: string, question = "complete_and_honest") => ({
    question: question as "complete_and_honest",
    severity,
    code,
    label: `label of ${code}`,
    document: null,
    document_label: null,
    note: `note of ${code}`,
  });

  test("a platform fact comes first, then a platform finding, then blocker, concern, note", () => {
    const findings = [
      finding("note", "other"),
      finding("concern", "readme_mismatch"),
      finding("blocker", "readme_missing_or_stub"),
      finding("concern", "source_credit_missing"),
    ];
    const withFact = card(
      detailOf(
        {},
        {},
        {
          findings,
          fact_notes: [
            { question: "complete_and_honest", fact: "x", result: "unknown", text: "A fact." },
          ],
        },
      ),
    );
    expect(withFact.questions[0].strongest).toEqual({
      source: "platform",
      severity: "fact",
      label: "A fact.",
      note: null,
      note_label: null,
    });
    const noFact = card(detailOf({}, {}, { findings }));
    expect(noFact.questions[0].strongest).toMatchObject({
      source: "platform",
      label: "label of source_credit_missing",
      note_label: null,
    });
    const modelOnly = card(detailOf({}, {}, { findings: findings.slice(0, 3) }));
    expect(modelOnly.questions[0].strongest).toEqual({
      source: "model",
      severity: "blocker",
      label: "label of readme_missing_or_stub",
      note: "note of readme_missing_or_stub",
      note_label: MODEL_TEXT_LABEL,
    });
    const concernNote = card(detailOf({}, {}, { findings: findings.slice(0, 2) }));
    expect(concernNote.questions[0].strongest?.severity).toBe("concern");
  });

  test("the four questions in order, each with its answer; none without a report", () => {
    const c = card(detailOf());
    expect(c.questions.map((q) => [q.question, q.answer, q.strongest])).toEqual([
      ["complete_and_honest", "pass", null],
      ["meets_standards", "pass", null],
      ["authors_and_license", "pass", null],
      ["name_adequate", "pass", null],
    ]);
    expect(card(detailOf({ review: null })).questions).toEqual([]);
  });
});

describe("the dataset's own words", () => {
  test("as reviewed: the snapshot, labeled as the depositor's, with the version from the facts", () => {
    const c = card(detailOf());
    expect(c.metadata).toEqual({
      as_reviewed: true,
      note: null,
      label: DEPOSITOR_TEXT_LABEL,
      enrichment_source: "2026-11-20 10:00:00",
      enrichment: SNAPSHOT.enrichment,
      dataset_description: SNAPSHOT.dataset_description,
      version: "1.0.0",
      anonymous: false,
    });
    // The review's facts counted no placeholder, the names flag one: the card says the larger, so
    // its count never says fewer placeholders than the names it flags (nm001019).
    expect(c.authors).toEqual({
      names: [
        { name: "Ada Lovelace", placeholder: false },
        { name: "TBD", placeholder: true },
      ],
      count: 2,
      placeholders: 1,
    });
  });

  test("a converter's pointer to the upstream's people is a placeholder (nm001019)", () => {
    const d = detailOf();
    const c = card(d, {
      snapshot: {
        ...SNAPSHOT,
        dataset_description: {
          name: "Your turn, my turn. Neural synchrony during mother-infant proto-conversation.",
          license: "CC-BY-4.0",
          authors: ["Original Dataset Authors (see SourceDatasets)"],
        },
      },
    });
    expect(c.authors.names).toEqual([
      { name: "Original Dataset Authors (see SourceDatasets)", placeholder: true },
    ]);
    expect(c.authors.placeholders).toBe(1);
  });

  test("a review with no snapshot shows what NEMAR holds now and says it is not as reviewed", () => {
    const c = card(detailOf(), {
      snapshot: null,
      current: {
        enrichment: SNAPSHOT.enrichment,
        enrichment_source: null,
        dataset_description: null,
      },
    });
    expect(c.metadata.as_reviewed).toBe(false);
    expect(c.metadata.note).toBe(NOT_AS_REVIEWED_NOTE);
    expect(c.metadata.enrichment).toEqual(SNAPSHOT.enrichment);
    const none = card(detailOf({ review: null }), { snapshot: null, current: null });
    expect(none.metadata.note).toBe(NOT_REVIEWED_NOTE);
    expect(none.authors).toEqual({ names: [], count: null, placeholders: null });
  });

  test("the description is cut at the cap and says so; control characters are removed", () => {
    const long = `${"a".repeat(CARD_DESCRIPTION_MAX + 50)}`;
    const e = cardEnrichmentOf({
      title: "Title‮ reversed\n",
      description: long,
      creators: [{ name: "Ada" }, "Grace", 3],
      keywords: [{ term: "EEG" }, "rest"],
      funding_references: [{ funder_name: "NIH", award_number: "R01" }, { funder_name: "NSF" }],
      license: "CC-BY-4.0",
    });
    expect(e?.title).toBe("Title reversed");
    expect(e?.description?.length).toBe(CARD_DESCRIPTION_MAX);
    expect(e?.description_cut).toBe(true);
    expect(e?.creators).toEqual(["Ada", "Grace"]);
    expect(e?.keywords).toEqual(["EEG", "rest"]);
    expect(e?.funding).toEqual(["NIH (R01)", "NSF"]);
    expect(cardEnrichmentOf(null)).toBeNull();
  });

  test("an anonymous release's Authors are withheld; a description that is not an object is none", () => {
    const text = JSON.stringify({ Name: "N", License: "CC0-1.0", Authors: ["A", "B"] });
    expect(cardDescriptionOf(text, true)).toEqual({ name: "N", license: "CC0-1.0", authors: [] });
    expect(cardDescriptionOf(text, false)?.authors).toEqual(["A", "B"]);
    expect(cardDescriptionOf("[1]", false)).toBeNull();
    expect(cardDescriptionOf("not json", false)).toBeNull();
    expect(cardDescriptionOf(null, false)).toBeNull();
  });
});

describe("the served snapshot", () => {
  test("reads back what it writes", () => {
    const text = servedMetadataJson(SNAPSHOT);
    expect(text).not.toBeNull();
    expect(parseServedMetadata(text)).toEqual(SNAPSHOT);
  });

  test("anything else reads as no snapshot", () => {
    for (const raw of [
      null,
      "",
      "not json",
      "[]",
      JSON.stringify({ ...SNAPSHOT, v: 2 }),
      JSON.stringify({ ...SNAPSHOT, enrichment: { ...SNAPSHOT.enrichment, creators: [1] } }),
      JSON.stringify({ ...SNAPSHOT, lineage: { ...SNAPSHOT.lineage, outcome: "fine" } }),
      JSON.stringify({ ...SNAPSHOT, dataset_description: "x" }),
    ]) {
      expect(parseServedMetadata(raw)).toBeNull();
    }
  });

  test("one too long for its column is not written", () => {
    const huge: ServedMetadata = {
      ...SNAPSHOT,
      lineage: {
        outcome: "compatible",
        credited: false,
        resolved_at: null,
        declared_licenses: ["x".repeat(SERVED_METADATA_MAX)],
      },
    };
    expect(servedMetadataJson(huge)).toBeNull();
  });

  test("the reasons an agreement named are shown, in the mail's words (migration 0164)", () => {
    const d = detailOf();
    for (const state of ["would_deny", "capped", "denied"]) {
      const c = card(d, {
        autoDenyState: state,
        autoDenyCodes: "readme_missing_or_stub,authors_placeholder",
      });
      expect(c.auto_deny).toEqual({
        state,
        line: AUTO_DENY_STATE_COPY[state as "would_deny"].statement,
        codes: ["readme_missing_or_stub", "authors_placeholder"],
        reasons: [
          AUTO_DENY_CODE_COPY.readme_missing_or_stub.statement,
          AUTO_DENY_CODE_COPY.authors_placeholder.statement,
        ],
      });
    }
    // A stored value that is not a list of known codes shows none, never a guess.
    expect(card(d, { autoDenyState: "would_deny", autoDenyCodes: "x,y" }).auto_deny?.codes).toEqual(
      [],
    );
  });

  test("the declared sources' titles, publications included, and papers with data files are kept", () => {
    const lineage = cardLineageOf(PAPER_AND_OSF);
    expect(lineage.source_titles).toEqual([PAPER_TITLE, "fNIRS mother-infant"]);
    // The name rule's own titles are datasets' alone.
    expect(lineage.upstream_titles).toEqual(["fNIRS mother-infant"]);
    expect(lineage.paper_with_data_files).toEqual([
      "10.5281/zenodo.3648065: the registry types this record as a journal article but it holds data files (1 of 1 files, such as Data.zip); it is still read as a publication for the license lineage, and an administrator decides.",
    ]);
    // The OSF node DataCite does not hold is named by its URL, never by the DOI NEMAR made.
    expect(lineage.declared_licenses).toEqual([
      "10.5281/zenodo.3648065: Creative Commons Attribution 4.0 International",
      "https://osf.io/fx4ud: CC-By Attribution 4.0 International",
    ]);
    expect(lineage.declared_licenses.join(" ")).not.toContain("10.17605/osf.io/fx4ud");
    // Written and read back; an older snapshot without the titles reads as not knowing them.
    const snap: ServedMetadata = { ...SNAPSHOT, lineage };
    expect(parseServedMetadata(servedMetadataJson(snap))).toEqual(snap);
    expect(parseServedMetadata(servedMetadataJson(SNAPSHOT))?.lineage?.source_titles).toBe(
      undefined,
    );
    expect(cardLineageOf({ ...PAPER_AND_OSF, sources: [] }).source_titles).toEqual([]);
    // The card's license panel carries the paper's line under the registry label.
    const c = card(detailOf(), { snapshot: snap });
    expect(c.license.lineage?.paper_with_data_files).toEqual({
      label: REGISTRY_TEXT_LABEL,
      lines: lineage.paper_with_data_files,
    });
  });

  test("every automatic-denial state but none has a line", () => {
    const d = detailOf();
    for (const s of AUTO_DENY_STATES) {
      expect(card(d, { autoDenyState: s }).auto_deny === null).toBe(s === "none");
    }
  });
});
