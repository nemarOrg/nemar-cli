/**
 * The dataset pull-request review contract (ADR 0092).
 *
 * Real parser, real verdict, real renderer, driven with the inputs an attacker controls: a
 * pull request's text reaches a model and the model's output reaches a check-run, so every test
 * here asks what a hostile report or a hostile note can and cannot do.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CRITERIA,
  DECLINE_REASONS,
  FINDING_CODES,
  HISTORICAL_DECLINE_REASONS,
  MAX_FINDINGS,
  MAX_LISTED,
  MAX_MODEL_FILES,
  MODEL_PRICES_USD_PER_MTOK,
  NOTE_MAX,
  OVERRIDE_MODES,
  PRODUCED_DECLINE_REASONS,
  PR_REVIEW_COMMENT_MARKER,
  type PrReviewReport,
  PrReviewReportError,
  REVIEW_OUTCOME_KINDS,
  REVIEW_STATES,
  RUN_ERRORS,
  type ReviewOutcome,
  VERDICTS,
  conclusionOf,
  effectiveCriteria,
  estimateCostUsd,
  factsOf,
  isRunError,
  parseCallbackOutcome,
  parsePrReviewReport,
  parseStoredPrReviewReport,
  renderCheck,
  renderComment,
  sanitizeNote,
  standingOf,
  verdictOf,
} from "../shared/pr-review";

const emptyAreas = () => ({
  dataset_description: { added: 0, modified: 0, removed: 0 },
  readme_and_changes: { added: 0, modified: 0, removed: 0 },
  participants: { added: 0, modified: 0, removed: 0 },
  sidecars: { added: 0, modified: 0, removed: 0 },
  recordings: { added: 0, modified: 0, removed: 0 },
  derivatives: { added: 0, modified: 0, removed: 0 },
  sourcedata: { added: 0, modified: 0, removed: 0 },
  code: { added: 0, modified: 0, removed: 0 },
  other: { added: 0, modified: 0, removed: 0 },
});

/** The evidence a version 1 report carries, whose counts add up. `recordings` absorbs the rest. */
function evidenceV1(over: Record<string, unknown> = {}): Record<string, unknown> {
  const files_changed = (over.files_changed as number | undefined) ?? 12;
  return {
    files_changed,
    files_read: Math.min(files_changed, 4),
    truncated: false,
    version_before: "1.0.0",
    version_after: "1.1.0",
    subjects_before: 20,
    subjects_after: 22,
    areas: {
      ...emptyAreas(),
      dataset_description: { added: 0, modified: files_changed > 0 ? 1 : 0, removed: 0 },
      recordings: { added: Math.max(files_changed - 1, 0), modified: 0, removed: 0 },
    },
    listed: [
      { status: "modified", path: "dataset_description.json" },
      { status: "added", path: "sub-21/eeg/sub-21_task-rest_eeg.edf" },
    ],
    ...over,
  };
}

/** Evidence as the script produces it for a version 2 report: version 1's and the text facts. */
function evidence(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...evidenceV1(over),
    description_empty: false,
    title_problem: null,
    name_problem: null,
    ...over,
  };
}

/** The six criteria of a full report, all pass, with `over` laid on top. */
function crit(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    genuine_contribution: "pass",
    no_degradation: "pass",
    advances_revision: "pass",
    material_improvement: "pass",
    clear_title_and_description: "pass",
    description_not_misleading: "pass",
    ...over,
  };
}

/** The criteria of a screen report: the screen stopped it, and nothing else was assessed. */
const SCREENED = {
  genuine_contribution: "fail",
  no_degradation: "unknown",
  advances_revision: "unknown",
  material_improvement: "unknown",
  clear_title_and_description: "unknown",
  description_not_misleading: "unknown",
};

/**
 * A version 2 full report as the job posts it. A `criteria` in `over` is laid on top of the six
 * all-pass answers, so a test names only the answers it is about.
 */
function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  const { criteria, ...rest } = over;
  return {
    v: 2,
    stage: "full",
    models: { screen: "claude-haiku-5-5", review: "claude-sonnet-5-5" },
    criteria: crit((criteria as Record<string, unknown> | undefined) ?? {}),
    findings: [],
    summary: "Adds two subjects and corrects the task description.",
    steering: false,
    evidence: evidence(),
    usage: {
      screen: { input_tokens: 1500, output_tokens: 800 },
      review: { input_tokens: 21000, output_tokens: 9000 },
    },
    ...rest,
  };
}

/** A version 2 report that ended at the screen: it read the pull request as spam. */
function screenReport(over: Record<string, unknown> = {}): Record<string, unknown> {
  return report({
    stage: "screen",
    models: { screen: "claude-haiku-5-5", review: null },
    criteria: SCREENED,
    findings: [
      {
        criterion: "genuine_contribution",
        severity: "blocker",
        code: "spam",
        path: null,
        note: "",
      },
    ],
    summary: "The description advertises an unrelated service.",
    evidence: evidence({ files_read: 0 }),
    usage: { screen: { input_tokens: 1500, output_tokens: 800 }, review: null },
    ...over,
  });
}

/** A version 1 report, as rows stored before the screen existed hold it. */
function reportV1(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    model: "claude-haiku-5-5",
    criteria: { no_degradation: "pass", advances_revision: "pass", material_improvement: "pass" },
    findings: [],
    summary: "Adds two subjects and corrects the task description.",
    steering: false,
    evidence: evidenceV1(),
    ...over,
  };
}

function parsed(over: Record<string, unknown> = {}): PrReviewReport {
  return parsePrReviewReport(report(over));
}

function refusal(raw: unknown): string {
  try {
    parsePrReviewReport(raw);
  } catch (e) {
    if (e instanceof PrReviewReportError) return e.code;
    throw e;
  }
  return "accepted";
}

/** Every outcome a review can come to, one of each shape, so a new conclusion is seen by all of them. */
function everyOutcome(): ReviewOutcome[] {
  const unknownCriteria = {
    no_degradation: "unknown",
    advances_revision: "pass",
    material_improvement: "pass",
  };
  return [
    { kind: "reported", report: parsed() },
    { kind: "reported", report: parsed({ steering: true }) },
    { kind: "reported", report: parsed({ criteria: unknownCriteria }) },
    ...DECLINE_REASONS.map((reason) => ({ kind: "declined", reason }) as const),
    ...RUN_ERRORS.map((error) => ({ kind: "error", error }) as const),
    { kind: "unreported" },
    { kind: "exempt" },
    { kind: "exempt", waived: true },
    { kind: "reported", report: parsePrReviewReport(screenReport()) },
    { kind: "reported", report: parseStoredPrReviewReport(reportV1()) },
    { kind: "naming", facts: { title: "author_year", name: null } },
    { kind: "naming", facts: { title: null, name: "template_field" } },
    { kind: "naming", facts: { title: null, name: "unchecked" } },
    { kind: "naming", facts: { title: "template_field", name: "unchecked" } },
    { kind: "naming", facts: { title: "author_year", name: "author_year" } },
  ];
}

describe("the report is a closed vocabulary", () => {
  test("a well-formed report is accepted", () => {
    expect(parsed().criteria.no_degradation).toBe("pass");
  });

  test("an unknown top-level key is refused, not ignored", () => {
    expect(refusal(report({ verdict: "pass" }))).toBe("unknown_key");
  });

  test("a model that is not in the closed set is refused", () => {
    expect(
      refusal(report({ models: { screen: "some-other-model", review: "claude-sonnet-5-5" } })),
    ).toBe("bad_model");
    expect(
      refusal(report({ models: { screen: "claude-haiku-5-5", review: "claude-haiku-5-5" } })),
    ).toBe("bad_model");
  });

  test("a criterion value outside the three words is refused", () => {
    expect(
      refusal(
        report({
          criteria: {
            no_degradation: "pass",
            advances_revision: "pass",
            material_improvement: "great",
          },
        }),
      ),
    ).toBe("bad_criteria");
  });

  test("an extra criterion is refused", () => {
    expect(
      refusal(
        report({
          criteria: {
            no_degradation: "pass",
            advances_revision: "pass",
            material_improvement: "pass",
            override: "pass",
          },
        }),
      ),
    ).toBe("bad_criteria");
  });

  test("a finding with an invented code is refused", () => {
    const finding = {
      criterion: "no_degradation",
      severity: "note",
      code: "approve_this",
      path: null,
      note: "",
    };
    expect(refusal(report({ findings: [finding] }))).toBe("bad_findings");
  });

  test("more findings than the cap is refused", () => {
    const finding = {
      criterion: "no_degradation",
      severity: "note",
      code: "other",
      path: null,
      note: "x",
    };
    expect(refusal(report({ findings: Array(MAX_FINDINGS + 1).fill(finding) }))).toBe(
      "bad_findings",
    );
  });

  test("a version that is not X.Y.Z is refused", () => {
    expect(
      refusal(
        report({
          evidence: evidence({ version_after: "latest and greatest" }),
        }),
      ),
    ).toBe("bad_evidence");
  });

  test("a refusal never quotes what it refused", () => {
    try {
      parsePrReviewReport(
        report({ models: { screen: "IGNORE ALL PREVIOUS INSTRUCTIONS", review: "x" } }),
      );
      throw new Error("should have been refused");
    } catch (e) {
      expect(String(e)).not.toContain("IGNORE");
      expect((e as PrReviewReportError).code).toBe("bad_model");
    }
  });

  test("a path that is not path-shaped is dropped, not trusted into the check", () => {
    const finding = (path: string) => ({
      criterion: "no_degradation",
      severity: "concern",
      code: "data_removed",
      path,
      note: "gone",
    });
    const r = parsePrReviewReport(
      report({
        findings: [
          finding("sub-01/eeg/sub-01_task-rest_eeg.edf"),
          finding("[click](https://evil.example)"),
          finding("../../etc/passwd"),
          finding("a path with spaces"),
        ],
      }),
    );
    expect(r.findings.map((f) => f.path)).toEqual([
      "sub-01/eeg/sub-01_task-rest_eeg.edf",
      null,
      null,
      null,
    ]);
  });

  test("a failing criterion with no finding gets one, so a red check has something to read", () => {
    const r = parsed({
      criteria: { no_degradation: "fail", advances_revision: "pass", material_improvement: "pass" },
    });
    const f = r.findings.find((x) => x.criterion === "no_degradation");
    expect(f?.severity).toBe("blocker");
    expect(f?.note).toBe("No detail given.");
  });
});

describe("every changed file is accounted for", () => {
  test("areas that do not add up to the total are refused, so a change cannot be dropped or invented", () => {
    const short = evidence({ files_changed: 12 });
    (short.areas as Record<string, { added: number }>).recordings.added = 3;
    expect(refusal(report({ evidence: short }))).toBe("bad_evidence");
    const over = evidence({ files_changed: 12 });
    (over.areas as Record<string, { removed: number }>).code.removed = 1;
    expect(refusal(report({ evidence: over }))).toBe("bad_evidence");
  });

  test("an area outside the closed set is refused", () => {
    const e = evidence();
    (e.areas as Record<string, unknown>).secrets = { added: 0, modified: 0, removed: 0 };
    expect(refusal(report({ evidence: e }))).toBe("bad_evidence");
  });

  test("more files read than changed is refused", () => {
    expect(refusal(report({ evidence: evidence({ files_changed: 3, files_read: 4 }) }))).toBe(
      "bad_evidence",
    );
  });

  test("a listed name that is not path-shaped is shown as hidden, and still counted", () => {
    const r = parsed({
      evidence: evidence({
        listed: [{ status: "removed", path: "[click me](https://evil.example)" }],
      }),
    });
    expect(r.evidence.listed[0]).toEqual({ status: "removed", path: null });
    const { text } = renderCheck({ kind: "reported", report: r });
    expect(text).toContain("name not shown");
    expect(text).not.toContain("evil.example");
  });

  test("the account shows each area that changed, the version, the subjects and how much was read", () => {
    const { summary } = renderCheck({ kind: "reported", report: parsed() });
    expect(summary).toContain("What changed");
    expect(summary).toContain("| Dataset description | 0 | 1 | 0 |");
    expect(summary).toContain("| Recordings and data files | 11 | 0 | 0 |");
    expect(summary).not.toContain("| Code |");
    expect(summary).toContain("Version 1.0.0 to 1.1.0.");
    expect(summary).toContain("Subjects 20 to 22.");
    expect(summary).toContain("The content of 4 of 12 changed files was read.");
    expect(summary).toContain("stored outside git");
  });

  test("when everything was read, it says so instead of apologising", () => {
    const r = parsed({ evidence: evidence({ files_changed: 2, files_read: 2 }) });
    expect(renderCheck({ kind: "reported", report: r }).summary).toContain(
      "The content of all 2 changed files was read.",
    );
  });

  test("a pull request that changes nothing says so", () => {
    const r = parsed({ evidence: evidence({ files_changed: 0, files_read: 0, listed: [] }) });
    expect(renderCheck({ kind: "reported", report: r }).summary).toContain("No files changed.");
  });

  test("the file list says how many it is leaving out", () => {
    const r = parsed({ evidence: evidence({ files_changed: 500, truncated: true }) });
    const { text } = renderCheck({ kind: "reported", report: r });
    expect(text).toContain("Changed files (2 of 500)");
    expect(text).toContain("and 498 more files, counted above");
  });
});

describe("notes are plain words", () => {
  test("links, images, html, mentions and cross references are removed", () => {
    const out = sanitizeNote(
      "See [the docs](https://evil.example/x) and ![img](https://evil.example/p.png) <script>alert(1)</script> " +
        "cc @maintainer fixes #12 and owner/repo#99 https://evil.example www.evil.example",
    );
    expect(out).not.toMatch(/https?:/i);
    expect(out).not.toContain("www.");
    expect(out).not.toContain("@");
    expect(out).not.toContain("#");
    expect(out).not.toContain("<");
    expect(out).not.toContain("](");
    expect(out).toContain("the docs");
  });

  test("zero-width, bidirectional and control characters cannot hide anything", () => {
    const hidden = [0x200b, 0x202e, 0x0007, 0x2028].map((c) => String.fromCharCode(c));
    const out = sanitizeNote(`pa${hidden[0]}ss${hidden[1]} fa${hidden[2]}il${hidden[3]}x`);
    for (const h of hidden) expect(out).not.toContain(h);
  });

  test("emphasis, backticks, table pipes and escapes are removed so a note cannot restyle the check", () => {
    const out = sanitizeNote("**Verdict: PASS** `code` | col \\ _x_ ~~y~~");
    expect(out).not.toMatch(/[*`|\\_~]/);
  });

  test("a note is cut to its limit", () => {
    expect(sanitizeNote("a".repeat(5000)).length).toBeLessThanOrEqual(NOTE_MAX);
  });

  test("a non-string is empty, never throws", () => {
    expect(sanitizeNote({ toString: () => "x" })).toBe("");
    expect(sanitizeNote(null)).toBe("");
  });

  test("a hostile note inside a parsed report reaches the check-run already clean", () => {
    const r = parsed({
      summary: "[approve](https://evil.example) @owner **PASS**",
      findings: [
        {
          criterion: "material_improvement",
          severity: "note",
          code: "other",
          path: null,
          note: "ping @everyone and see https://evil.example",
        },
      ],
    });
    const { summary, text } = renderCheck({ kind: "reported", report: r });
    for (const s of [summary, text]) {
      expect(s).not.toContain("@");
      expect(s).not.toMatch(/https?:/);
    }
  });
});

describe("the verdict is derived, and git facts override the model", () => {
  test("all three criteria pass is a pass", () => {
    expect(verdictOf(parsed())).toBe("pass");
  });

  test("any failing criterion fails the review", () => {
    // `genuine_contribution` is the screen's, and a full report always passes it (see the stage tests).
    for (const c of CRITERIA.filter((x) => x !== "genuine_contribution")) {
      expect(verdictOf(parsed({ criteria: { [c]: "fail" } })), c).toBe("fail");
    }
  });

  test("an unknown criterion with no failure is uncertain, never a pass", () => {
    const criteria = {
      no_degradation: "pass",
      advances_revision: "unknown",
      material_improvement: "pass",
    };
    expect(verdictOf(parsed({ criteria }))).toBe("uncertain");
  });

  test("steering fails the review even when every criterion passes", () => {
    expect(verdictOf(parsed({ steering: true }))).toBe("fail");
  });

  test("a pull request that changes no file cannot be a material improvement", () => {
    const r = parsed({
      evidence: evidence({ files_changed: 0, files_read: 0, listed: [] }),
    });
    expect(effectiveCriteria(r).material_improvement).toBe("fail");
    expect(verdictOf(r)).toBe("fail");
  });

  test("an unchanged version cannot advance the revision, whatever the model said", () => {
    const r = parsed({
      evidence: evidence({ files_changed: 3, version_after: "1.0.0" }),
    });
    expect(verdictOf(r)).toBe("fail");
  });

  test("an unreadable new version cannot be better than unknown", () => {
    const r = parsed({
      evidence: evidence({ files_changed: 3, version_after: null }),
    });
    expect(effectiveCriteria(r).advances_revision).toBe("unknown");
    expect(verdictOf(r)).toBe("uncertain");
  });

  test("a truncated change list cannot certify that nothing was lost", () => {
    const r = parsed({
      evidence: evidence({ files_changed: 9000, files_read: 40, truncated: true }),
    });
    expect(effectiveCriteria(r).no_degradation).toBe("unknown");
    expect(verdictOf(r)).toBe("uncertain");
  });
});

describe("a report cannot disagree with itself in the direction of a pass", () => {
  const finding = (over: Record<string, unknown>) => ({
    criterion: "no_degradation",
    severity: "note",
    code: "other",
    path: null,
    note: "Something.",
    ...over,
  });

  test("a steering finding fails the review even when the model said steering is false", () => {
    const r = parsed({ steering: false, findings: [finding({ code: "steering_attempt" })] });
    expect(r.steering).toBe(true);
    expect(verdictOf(r)).toBe("fail");
    expect(conclusionOf({ kind: "reported", report: r })).toBe("failure");
  });

  test("the flag alone still fails, and parsing a stored report again changes nothing", () => {
    expect(verdictOf(parsed({ steering: true }))).toBe("fail");
    const once = parsed({ steering: false, findings: [finding({ code: "steering_attempt" })] });
    expect(parsePrReviewReport(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  test("a blocker against a criterion the model passed makes that criterion unknown", () => {
    for (const c of CRITERIA) {
      const r = parsed({
        findings: [finding({ criterion: c, severity: "blocker", code: "data_removed" })],
      });
      expect(r.criteria[c], c).toBe("unknown");
      expect(verdictOf(r), c).toBe("uncertain");
      expect(conclusionOf({ kind: "reported", report: r }), c).toBe("action_required");
    }
  });

  test("concerns and notes do not change an answer, and a blocker never raises one", () => {
    expect(verdictOf(parsed({ findings: [finding({ severity: "concern" })] }))).toBe("pass");
    expect(verdictOf(parsed({ findings: [finding({ severity: "note" })] }))).toBe("pass");
    const failing = parsed({
      criteria: { no_degradation: "fail", advances_revision: "pass", material_improvement: "pass" },
      findings: [finding({ severity: "blocker" })],
    });
    expect(failing.criteria.no_degradation).toBe("fail");
    expect(verdictOf(failing)).toBe("fail");
  });

  test("a steering finding is kept when findings are cut to make room for the explanations", () => {
    const filler = Array.from({ length: 7 }, () => finding({ severity: "note" }));
    const r = parsed({
      criteria: { no_degradation: "fail", advances_revision: "fail", material_improvement: "pass" },
      findings: [...filler, finding({ code: "steering_attempt" })],
    });
    expect(r.steering).toBe(true);
  });
});

describe("conclusions: only a clear pass is green, nothing unknown ever satisfies a required check", () => {
  test("pass is success and fail is failure", () => {
    expect(conclusionOf({ kind: "reported", report: parsed() })).toBe("success");
    expect(conclusionOf({ kind: "reported", report: parsed({ steering: true }) })).toBe("failure");
  });

  test("uncertain, declined, errored and unreported all need a person", () => {
    const criteria = {
      no_degradation: "unknown",
      advances_revision: "pass",
      material_improvement: "pass",
    };
    expect(conclusionOf({ kind: "reported", report: parsed({ criteria }) })).toBe(
      "action_required",
    );
    expect(conclusionOf({ kind: "declined", reason: "contributor_paused" })).toBe(
      "action_required",
    );
    expect(conclusionOf({ kind: "error", error: "model_refused" })).toBe("action_required");
    expect(conclusionOf({ kind: "unreported" })).toBe("action_required");
  });

  test("everyOutcome has every kind of outcome there is, so the rules below see them all", () => {
    expect(new Set(everyOutcome().map((o) => o.kind))).toEqual(new Set(REVIEW_OUTCOME_KINDS));
  });

  test("neutral is the conclusion of nothing: GitHub counts it as passing", () => {
    for (const o of everyOutcome()) {
      expect(["success", "failure", "action_required", "skipped"]).toContain(conclusionOf(o));
      expect(conclusionOf(o)).not.toBe("neutral" as never);
    }
  });

  test("skipped, which GitHub also counts as passing, is the conclusion of the exempt outcome and of no other", () => {
    expect(conclusionOf({ kind: "exempt" })).toBe("skipped");
    const skipped = everyOutcome().filter((o) => conclusionOf(o) === "skipped");
    expect(skipped).toEqual([{ kind: "exempt" }, { kind: "exempt", waived: true }]);
    // And an exempt outcome is not a pass by another name: the only `success` is a reported pass.
    const green = everyOutcome().filter((o) => conclusionOf(o) === "success");
    expect(green.length).toBeGreaterThan(0);
    for (const o of green) {
      expect(o.kind).toBe("reported");
      if (o.kind === "reported") expect(verdictOf(o.report)).toBe("pass");
    }
  });

  test("a pull request opened by an owner or administrator says the review is not required, and that skipped is not a pass", () => {
    const r = renderCheck({ kind: "exempt" });
    expect(r.title).toBe("Not required: opened by a NEMAR owner or administrator");
    expect(r.summary).toContain("did not run");
    expect(r.summary).toContain("may merge without it");
    expect(r.text).toContain("Skipped is not a pass");
    // It must not borrow the words of a review that ran.
    for (const words of ["Passes", "Needs changes", "Could not decide", "does not pass"]) {
      expect(`${r.title} ${r.summary} ${r.text}`).not.toContain(words);
    }
  });

  test("every outcome renders, and a red or amber check explains itself", () => {
    const failing = parsed({
      criteria: { no_degradation: "fail", advances_revision: "pass", material_improvement: "pass" },
      findings: [
        {
          criterion: "no_degradation",
          severity: "blocker",
          code: "data_removed",
          path: "sub-02/eeg/sub-02_task-rest_eeg.edf",
          note: "Recording deleted with no mention in CHANGES.",
        },
      ],
    });
    const r = renderCheck({ kind: "reported", report: failing });
    expect(r.title).toBe("Needs changes");
    expect(r.text).toContain("Data removed");
    expect(r.text).toContain("sub-02/eeg/sub-02_task-rest_eeg.edf");
    expect(renderCheck({ kind: "declined", reason: "contributor_paused" }).summary).toContain(
      "by hand",
    );
    expect(renderCheck({ kind: "error", error: "model_refused" }).text).toContain("does not pass");
    expect(renderCheck({ kind: "unreported" }).title).toBe("Could not decide");
  });

  test("every outcome renders a title, a summary and a comment, and only a review that ran says it passed", () => {
    for (const o of everyOutcome()) {
      const r = renderCheck(o);
      expect(r.title.length, JSON.stringify(o)).toBeGreaterThan(0);
      expect(r.summary.length, JSON.stringify(o)).toBeGreaterThan(0);
      const says = `${r.title} ${renderComment(o, "0123456789abcdef0123456789abcdef01234567")}`;
      if (conclusionOf(o) !== "success") expect(says, JSON.stringify(o)).not.toContain("Passes");
    }
  });

  test.each([...HISTORICAL_DECLINE_REASONS])(
    "a stored row with the old word %s still renders as not reviewed, and says the limit is gone",
    (reason) => {
      const outcome: ReviewOutcome = { kind: "declined", reason };
      const r = renderCheck(outcome);
      expect(r.title).toBe("Not reviewed");
      expect(conclusionOf(outcome)).toBe("action_required");
      // A person can act on it: the limit no longer exists, so a new commit or a start works.
      expect(r.summary).toContain("has since been removed");
      expect(r.summary).toContain(
        "Push a new commit, or ask a NEMAR administrator to start the review",
      );
      expect(renderComment(outcome, "0123456789abcdef0123456789abcdef01234567")).toContain(
        "NEEDS A PERSON",
      );
      // Plain words: no word of the vocabulary, JSON or escape reaches the text.
      expect(`${r.title} ${r.summary} ${r.text}`).not.toMatch(/_|[{}\\]/);
    },
  );

  test.each([...DECLINE_REASONS])(
    "the sentence for %s is about the moment the commit arrived, because it is shown again long after",
    (reason) => {
      const { summary } = renderCheck({ kind: "declined", reason });
      expect(summary).toContain("when this commit arrived");
      // Never the present tense about a state that may have ended.
      expect(summary).not.toMatch(/\b(is paused|is rate limited|is reached)\b/);
    },
  );

  test("every finding code has a label", () => {
    for (const code of FINDING_CODES) {
      const r = parsed({
        findings: [{ criterion: "no_degradation", severity: "note", code, path: null, note: "" }],
      });
      expect(renderCheck({ kind: "reported", report: r }).text.length).toBeGreaterThan(0);
    }
  });
});

describe("the pull-request comment", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  test("it leads with the marker, the badge and the commit, and carries the findings", () => {
    const failing = parsed({
      criteria: { no_degradation: "fail", advances_revision: "pass", material_improvement: "pass" },
      findings: [
        {
          criterion: "no_degradation",
          severity: "blocker",
          code: "data_removed",
          path: "sub-02/eeg/sub-02_task-rest_eeg.edf",
          note: "Recording deleted.",
        },
      ],
    });
    const body = renderComment({ kind: "reported", report: failing }, sha);
    expect(body.startsWith(PR_REVIEW_COMMENT_MARKER)).toBe(true);
    expect(body).toContain("NEEDS CHANGES");
    expect(body).toContain("0123456");
    expect(body).toContain("Data removed");
  });

  test("a pass says PASS, and anything undecided says it needs a person", () => {
    expect(renderComment({ kind: "reported", report: parsed() }, sha)).toContain("PASS");
    expect(renderComment({ kind: "error", error: "model_refused" }, sha)).toContain(
      "NEEDS A PERSON",
    );
    expect(renderComment({ kind: "declined", reason: "contributor_paused" }, sha)).toContain(
      "NEEDS A PERSON",
    );
  });

  test("an exempt pull request says NOT REQUIRED, and is never mistaken for a pass or a failure", () => {
    const body = renderComment({ kind: "exempt" }, sha);
    expect(body.startsWith(PR_REVIEW_COMMENT_MARKER)).toBe(true);
    expect(body).toContain("## NEMAR PR review: NOT REQUIRED");
    expect(body).toContain("Not required: opened by a NEMAR owner or administrator");
    expect(body).toContain("0123456");
    for (const other of ["PASS", "NEEDS CHANGES", "NEEDS A PERSON"]) {
      expect(body).not.toContain(other);
    }
    expect(body.split(PR_REVIEW_COMMENT_MARKER).length - 1).toBe(1);
  });

  test("a commit value that is not a hash is left out, not quoted", () => {
    const body = renderComment({ kind: "unreported" }, "[x](https://evil.example) @owner");
    expect(body).not.toContain("evil.example");
    expect(body).not.toContain("@owner");
  });

  test("the marker appears exactly once, so the Worker can find its own comment", () => {
    const body = renderComment({ kind: "reported", report: parsed() }, sha);
    expect(body.split(PR_REVIEW_COMMENT_MARKER).length - 1).toBe(1);
  });
});

describe("a contributor's standing: only an administrator's block pauses anyone (ADR 0107)", () => {
  test("with no decision a contributor is not paused", () => {
    expect(standingOf(null)).toEqual({ paused: false });
  });

  test("a block pauses, and says an administrator did it", () => {
    expect(standingOf("block")).toEqual({ paused: true, because: "maintainer" });
  });

  test("an allow only lifts a block: it is the standing of someone with no decision", () => {
    expect(standingOf("allow")).toEqual(standingOf(null));
  });
});

describe("the sanitiser is bounded on hostile input", () => {
  test.each(["![", "[", "<a ", "&#", "(", "]("])(
    "200,000 repetitions of %j are cut and fast",
    (unit) => {
      const started = performance.now();
      const out = sanitizeNote(unit.repeat(200_000));
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(Array.from(out).length).toBeLessThanOrEqual(NOTE_MAX);
    },
  );

  test("a cut that splits a surrogate pair leaves no lone half behind", () => {
    const out = sanitizeNote(`${"a".repeat(NOTE_MAX * 8 - 1)}\u{1F600}tail`, NOTE_MAX);
    expect(out).not.toMatch(/\p{Cs}/u);
  });

  test("the text a person reads is still the start of the note, cut at the limit", () => {
    const out = sanitizeNote(`start ${"x".repeat(5_000)}`, 50);
    expect(out.startsWith("start xxx")).toBe(true);
    expect(Array.from(out)).toHaveLength(50);
  });
});

describe("the sanitiser cannot rebuild a link, and is a fixed point", () => {
  // Stripping characters AFTER finding links rebuilds them, and entities decode to the characters
  // the function removes, so each of these has to come out without a link.
  const attacks = [
    "ht@tp://evil.example/x",
    "w@ww.evil.example",
    "j`avascript:alert(1)",
    "h*ttps://evil.example",
    "ht#tps://evil.example",
    "ww_w.evil.example",
    "ht~tp://evil.example",
    "ft|p://evil.example",
    "&commat;octocat see &num;12 and &#64;owner and &#x40;owner",
    "&lt;script&gt;alert(1)&lt;/script&gt;",
    "GH-12 and gh-345 and GH-7",
    "see [a](https://x.example) and ![i](https://y.example/p.png)",
    '<a href="https://x.example">c</a>',
    "ftp://x.example/a",
    "file:///etc/passwd",
    "data:text/html;base64,AAAA",
    "owner/repo#12 fixes #3",
  ];
  const LINKISH = /\b(?:https?|ftp|file|data|javascript):|www\.\S/i;
  // What GitHub's autolinker actually links: a scheme or www. at the start, after whitespace, or
  // after one of * _ ~ (. Glued to a letter (as in "tpwww.x") it is plain text.
  const AUTOLINKED = /(?:^|[\s*_~(])(?:(?:https?|ftp):\/\/\S|www\.\S)/i;
  const NOTIFYING = /[@#<>`*_~|\\[\]{}]|&#?\w+;|\bGH-\d+/i;

  for (const a of attacks) {
    test(`${JSON.stringify(a)} comes out inert`, () => {
      const out = sanitizeNote(a);
      expect(out).not.toMatch(LINKISH);
      expect(out).not.toMatch(NOTIFYING);
      expect(sanitizeNote(out)).toBe(out);
    });
  }

  test("a seeded fuzz of link and mention fragments never produces a link, a mention or a second-pass change", () => {
    const parts = [
      "ht",
      "tp",
      "s",
      "://",
      "@",
      "#",
      "*",
      "_",
      "`",
      "[",
      "]",
      "(",
      ")",
      "<",
      ">",
      "&",
      "amp;",
      "commat;",
      "www.",
      "evil",
      ".com",
      "GH-",
      "12",
      " ",
      "|",
      "~",
      "\\",
      "a",
      "javascript:",
      "data:",
    ];
    let seed = 20261008;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed;
    };
    for (let i = 0; i < 400; i++) {
      let s = "";
      const n = 3 + (next() % 14);
      for (let j = 0; j < n; j++) s += parts[next() % parts.length];
      const out = sanitizeNote(s);
      expect(out, JSON.stringify(s)).not.toMatch(AUTOLINKED);
      expect(out, JSON.stringify(s)).not.toMatch(NOTIFYING);
      expect(sanitizeNote(out), JSON.stringify(s)).toBe(out);
    }
  });

  test("a note is cut by whole characters, never through a surrogate pair", () => {
    const smile = String.fromCodePoint(0x1f600);
    const out = sanitizeNote("x".repeat(NOTE_MAX - 4) + smile.repeat(10));
    expect(out.isWellFormed()).toBe(true);
    expect(Array.from(out).length).toBeLessThanOrEqual(NOTE_MAX);
    expect(out.endsWith("...")).toBe(true);
  });

  test("a parsed report's notes and summary are inert after one pass through the parser", () => {
    const r = parsed({
      summary: "ht@tp://evil.example &commat;owner GH-9",
      findings: [
        {
          criterion: "no_degradation",
          severity: "note",
          code: "other",
          path: null,
          note: "w@ww.evil.example",
        },
      ],
    });
    expect(r.summary).not.toMatch(LINKISH);
    expect(r.findings[0].note).not.toMatch(LINKISH);
    expect(parsed({ summary: r.summary }).summary).toBe(r.summary);
  });
});

describe("findings are never evicted by the facts, and a red check always says why", () => {
  const finding = (criterion: string, i: number) => ({
    criterion,
    severity: "note",
    code: "other",
    path: null,
    note: `n${i}`,
  });

  test("with a full set of model findings, every failing criterion still has one", () => {
    const r = parsed({
      criteria: { no_degradation: "fail", advances_revision: "fail", material_improvement: "pass" },
      findings: Array.from({ length: MAX_FINDINGS }, (_, i) => finding("material_improvement", i)),
    });
    expect(r.findings.length).toBeLessThanOrEqual(MAX_FINDINGS);
    for (const c of ["no_degradation", "advances_revision"]) {
      expect(
        r.findings.some((f) => f.criterion === c),
        c,
      ).toBe(true);
    }
    // The model's own last findings made room; the added ones are intact.
    expect(r.findings.filter((f) => f.note === "No detail given.")).toHaveLength(2);
  });

  test("a failure found from the files is stated in the check, not left under 'No findings'", () => {
    const r = parsed({ evidence: evidence({ version_before: "1.2.0", version_after: "1.1.0" }) });
    const { text } = renderCheck({ kind: "reported", report: r });
    expect(text).toContain("Version not advanced");
    expect(text).toContain("found from the files, not by the reviewer");
    expect(text).not.toContain("No findings.");
  });

  test("a fact the model already reported is not repeated", () => {
    const r = parsed({
      criteria: { no_degradation: "pass", advances_revision: "fail", material_improvement: "pass" },
      findings: [
        {
          criterion: "advances_revision",
          severity: "blocker",
          code: "version_not_advanced",
          path: null,
          note: "Same version.",
        },
      ],
      evidence: evidence({ version_before: "1.0.0", version_after: "1.0.0" }),
    });
    const { text } = renderCheck({ kind: "reported", report: r });
    expect(text.match(/Version not advanced/g)).toHaveLength(1);
  });
});

describe("facts lower a criterion and never raise one", () => {
  const verdictFor = (e: Record<string, unknown>, criteria?: Record<string, string>) =>
    verdictOf(parsed({ evidence: e, ...(criteria ? { criteria } : {}) }));
  const emptyAreasLocal = () => ({
    dataset_description: { added: 0, modified: 0, removed: 0 },
    readme_and_changes: { added: 0, modified: 0, removed: 0 },
    participants: { added: 0, modified: 0, removed: 0 },
    sidecars: { added: 0, modified: 0, removed: 0 },
    recordings: { added: 0, modified: 0, removed: 0 },
    derivatives: { added: 0, modified: 0, removed: 0 },
    sourcedata: { added: 0, modified: 0, removed: 0 },
    code: { added: 0, modified: 0, removed: 0 },
    other: { added: 0, modified: 0, removed: 0 },
  });

  test("a version downgrade cannot advance the revision, however the model answered", () => {
    expect(verdictFor(evidence({ version_before: "2.0.0", version_after: "1.0.5" }))).toBe("fail");
    expect(verdictFor(evidence({ version_before: "1.2.0", version_after: "1.1.9" }))).toBe("fail");
  });

  test("versions compare as numbers, not as text", () => {
    expect(verdictFor(evidence({ version_before: "1.9.0", version_after: "1.10.0" }))).toBe("pass");
    expect(verdictFor(evidence({ version_before: "9.0.0", version_after: "10.0.0" }))).toBe("pass");
    expect(verdictFor(evidence({ version_before: "1.10.0", version_after: "1.9.0" }))).toBe("fail");
  });

  test("a dataset whose main had no version, gaining one, still advances", () => {
    expect(verdictFor(evidence({ version_before: null, version_after: "1.0.0" }))).toBe("pass");
  });

  test("removing a recording needs a person: never a pass on the model's word", () => {
    const areas = { ...emptyAreasLocal(), recordings: { added: 0, modified: 0, removed: 1 } };
    const e = evidence({ files_changed: 1, files_read: 0, areas, listed: [] });
    const r = parsed({ evidence: e });
    expect(verdictOf(r)).toBe("uncertain");
    expect(factsOf(r).notes).toContainEqual({
      criterion: "no_degradation",
      code: "data_removed",
      result: "unknown",
    });
  });

  test("removing the participants table, the dataset description, README or CHANGES needs a person", () => {
    for (const area of ["participants", "dataset_description", "readme_and_changes"]) {
      const areas = { ...emptyAreasLocal(), [area]: { added: 0, modified: 0, removed: 1 } };
      const e = evidence({ files_changed: 1, files_read: 0, areas, listed: [] });
      expect(verdictFor(e), area).toBe("uncertain");
    }
  });

  test("a fall in the subject count needs a person; a rise or no change does not", () => {
    expect(verdictFor(evidence({ subjects_before: 22, subjects_after: 20 }))).toBe("uncertain");
    expect(verdictFor(evidence({ subjects_before: 20, subjects_after: 22 }))).toBe("pass");
    expect(verdictFor(evidence({ subjects_before: 20, subjects_after: 20 }))).toBe("pass");
    expect(verdictFor(evidence({ subjects_before: null, subjects_after: 20 }))).toBe("pass");
  });

  test("a fact never turns a model's fail into something milder", () => {
    const e = evidence({ subjects_before: 22, subjects_after: 20 });
    const v = verdictFor(e, {
      no_degradation: "fail",
      advances_revision: "pass",
      material_improvement: "pass",
    });
    expect(v).toBe("fail");
  });

  test.each(["sidecars", "derivatives", "sourcedata", "code", "other"])(
    "removing a file in %s needs a person: it is a loss somebody should look at",
    (area) => {
      const areas = { ...emptyAreasLocal(), [area]: { added: 0, modified: 0, removed: 3 } };
      const e = evidence({ files_changed: 3, files_read: 0, areas, listed: [] });
      expect(verdictFor(e)).toBe("uncertain");
    },
  );

  test("adding or changing files in any area is left to the model's answer", () => {
    for (const area of ["sidecars", "derivatives", "sourcedata", "code", "other"]) {
      const areas = { ...emptyAreasLocal(), [area]: { added: 2, modified: 1, removed: 0 } };
      const e = evidence({ files_changed: 3, files_read: 0, areas, listed: [] });
      expect(verdictFor(e), area).toBe("pass");
    }
  });
});

describe("the evidence block cannot claim more than it can hold", () => {
  test("a file list longer than the number of changed files is refused", () => {
    const listed = Array.from({ length: 5 }, (_, i) => ({ status: "added", path: `a/${i}` }));
    expect(refusal(report({ evidence: evidence({ files_changed: 1, listed }) }))).toBe(
      "bad_evidence",
    );
  });

  test("a change list longer than the model was shown must say it was cut", () => {
    const big = evidence({ files_changed: MAX_MODEL_FILES + 1, files_read: 0, truncated: false });
    expect(refusal(report({ evidence: big }))).toBe("bad_evidence");
    const cut = evidence({ files_changed: MAX_MODEL_FILES + 1, files_read: 0, truncated: true });
    expect(refusal(report({ evidence: cut }))).toBe("accepted");
  });
});

describe("the callback body becomes an outcome, and never a verdict by itself", () => {
  test("a good report is a reported outcome", () => {
    const o = parseCallbackOutcome({ outcome: "reported", report: report(), error: undefined });
    expect(o.kind).toBe("reported");
  });

  test("a report the parser refuses is report_invalid, with no quotation of it", () => {
    const o = parseCallbackOutcome({
      outcome: "reported",
      report: { ...report(), verdict: "pass" },
      error: undefined,
    });
    expect(o).toEqual({ kind: "error", error: "report_invalid" });
  });

  test("an error word in the vocabulary is kept; one outside it is workflow_failed", () => {
    expect(
      parseCallbackOutcome({ outcome: "error", report: undefined, error: "model_refused" }),
    ).toEqual({ kind: "error", error: "model_refused" });
    expect(
      parseCallbackOutcome({ outcome: "error", report: undefined, error: "boom SMITH" }),
    ).toEqual({ kind: "error", error: "workflow_failed" });
  });

  test("any other outcome, including one that says pass, is workflow_failed", () => {
    for (const outcome of ["pass", "success", "REPORTED", "reported ", undefined, null, 1, {}]) {
      const o = parseCallbackOutcome({ outcome, report: report(), error: undefined });
      expect(o, JSON.stringify(outcome)).toEqual({ kind: "error", error: "workflow_failed" });
    }
  });

  test("a job cannot report the Worker's own dispatch_failed", () => {
    expect(
      parseCallbackOutcome({ outcome: "error", report: undefined, error: "dispatch_failed" }),
    ).toEqual({ kind: "error", error: "workflow_failed" });
  });

  test("a refused report tells the caller the parser's fixed word, and nothing else changes", () => {
    const told: string[] = [];
    const o = parseCallbackOutcome(
      { outcome: "reported", report: { ...report(), summary: 3 }, error: undefined },
      (code) => told.push(code),
    );
    expect(o).toEqual({ kind: "error", error: "report_invalid" });
    expect(told).toEqual(["bad_summary"]);
  });

  test("isRunError accepts exactly the vocabulary", () => {
    expect(isRunError("dispatch_failed")).toBe(true);
    expect(isRunError("model_refused")).toBe(true);
    expect(isRunError("other")).toBe(false);
    expect(isRunError(undefined)).toBe(false);
  });
});

describe("closed lists the SQL and the code share", () => {
  test("they name the values the Worker stores", () => {
    expect([...VERDICTS]).toEqual(["pass", "fail", "uncertain"]);
    expect([...REVIEW_STATES]).toEqual([
      "dispatched",
      "reported",
      "declined",
      "errored",
      "unreported",
    ]);
    expect([...OVERRIDE_MODES]).toEqual(["allow", "block"]);
  });

  test("the decline words are two lists, the one produced today and the historical one, and together every stored word", () => {
    expect([...PRODUCED_DECLINE_REASONS]).toEqual(["contributor_paused"]);
    expect([...HISTORICAL_DECLINE_REASONS]).toEqual(["rate_limited", "daily_limit"]);
    expect([...DECLINE_REASONS]).toEqual([
      ...PRODUCED_DECLINE_REASONS,
      ...HISTORICAL_DECLINE_REASONS,
    ]);
    // No word is on both lists, so a word that is no longer produced cannot be mistaken for one that is.
    expect(
      PRODUCED_DECLINE_REASONS.filter((w) =>
        (HISTORICAL_DECLINE_REASONS as readonly string[]).includes(w),
      ),
    ).toEqual([]);
  });
});

describe("the brand on a parsed report", () => {
  test("only the parser mints one: no other source file casts to PrReviewReport", () => {
    const root = join(import.meta.dir, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", ".git", "test", "dist"].includes(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry.name) && !path.endsWith("shared/pr-review.ts")) {
          if (/\bas\s+PrReviewReport\b/.test(readFileSync(path, "utf8"))) offenders.push(path);
        }
      }
    };
    for (const d of ["shared", "src", "backend/src", "scripts"]) walk(join(root, d));
    expect(offenders).toEqual([]);
  });
});

describe("the parser refuses a hostile value in every field, not only the notes", () => {
  const finding = (over: Record<string, unknown> = {}) => ({
    criterion: "no_degradation",
    severity: "note",
    code: "other",
    path: null,
    note: "x",
    ...over,
  });
  const areasWith = (area: string, counts: Record<string, unknown>, files_changed = 12) => {
    const e = evidence({ files_changed });
    (e.areas as Record<string, unknown>)[area] = counts;
    return e;
  };

  const cases: Array<[string, Record<string, unknown>, string]> = [
    [
      "a severity that is markup and a mention",
      { findings: [finding({ severity: "@everyone [approve](https://evil.example)" })] },
      "bad_findings",
    ],
    [
      "a finding criterion outside the three",
      { findings: [finding({ criterion: "approve" })] },
      "bad_findings",
    ],
    ["a finding with an extra key", { findings: [finding({ verdict: "pass" })] }, "bad_findings"],
    [
      "a finding with a missing key",
      { findings: [{ criterion: "no_degradation", severity: "note", code: "other", path: null }] },
      "bad_findings",
    ],
    ["findings that are not a list", { findings: { 0: finding() } }, "bad_findings"],
    ["a path that is a number", { findings: [finding({ path: 7 })] }, "bad_findings"],
    ["a note that is not text", { findings: [finding({ note: { a: 1 } })] }, "bad_findings"],
    ["a version that is not 2", { v: 3 }, "bad_version"],
    ["version 1, by callback", { v: 1 }, "bad_version"],
    ["a version given as text", { v: "1" }, "bad_version"],
    ["a summary that is not text", { summary: 3 }, "bad_summary"],
    ["steering as the word false", { steering: "false" }, "bad_steering"],
    ["steering as zero", { steering: 0 }, "bad_steering"],
    ["steering left out", { steering: undefined }, "unknown_key"],
    [
      "a fractional count",
      { evidence: areasWith("recordings", { added: 10.5, modified: 0, removed: 0 }) },
      "bad_evidence",
    ],
    [
      "a negative count",
      { evidence: areasWith("recordings", { added: -1, modified: 0, removed: 0 }) },
      "bad_evidence",
    ],
    [
      "a count above the cap",
      { evidence: areasWith("recordings", { added: 1e9, modified: 0, removed: 0 }, 1e9) },
      "bad_evidence",
    ],
    [
      "a count given as text",
      { evidence: areasWith("recordings", { added: "11", modified: 0, removed: 0 }) },
      "bad_evidence",
    ],
    [
      "an area with an extra key",
      { evidence: areasWith("recordings", { added: 11, modified: 0, removed: 0, approved: 1 }) },
      "bad_evidence",
    ],
    [
      "an evidence block with an extra key",
      { evidence: evidence({ approved: true }) },
      "bad_evidence",
    ],
    [
      "a listed file with an extra key",
      { evidence: evidence({ listed: [{ status: "added", path: "a", note: "x" }] }) },
      "bad_evidence",
    ],
    [
      "a listed file status that is invented",
      { evidence: evidence({ listed: [{ status: "approved", path: "a" }] }) },
      "bad_evidence",
    ],
    ["truncated given as text", { evidence: evidence({ truncated: "false" }) }, "bad_evidence"],
    [
      "a subject count that is negative",
      { evidence: evidence({ subjects_before: -2 }) },
      "bad_evidence",
    ],
    [
      "a subject count that is fractional",
      { evidence: evidence({ subjects_after: 2.5 }) },
      "bad_evidence",
    ],
  ];
  for (const [label, over, code] of cases) {
    test(`${label} is refused as ${code}`, () => {
      const raw = report(over);
      if (over.steering === undefined && "steering" in over)
        Reflect.deleteProperty(raw, "steering");
      expect(refusal(raw)).toBe(code);
    });
  }

  test.each(["1.0", "v1.0.0", "1.0.0-rc1", "1.0.0 ", "1.0.0\n", "1.x.0", "1..0", "", " "])(
    "the version %j is refused",
    (v) => {
      expect(refusal(report({ evidence: evidence({ version_after: v }) }))).toBe("bad_evidence");
      expect(refusal(report({ evidence: evidence({ version_before: v }) }))).toBe("bad_evidence");
    },
  );

  test("a list longer than the cap is refused", () => {
    const listed = Array.from({ length: MAX_LISTED + 1 }, (_, i) => ({
      status: "added",
      path: `sub-${i}/f.json`,
    }));
    expect(refusal(report({ evidence: evidence({ files_changed: 80, listed }) }))).toBe(
      "bad_evidence",
    );
  });
});

describe("the revision must go up, in every component of the version", () => {
  const verdictFor = (before: string, after: string) =>
    verdictOf(parsed({ evidence: evidence({ version_before: before, version_after: after }) }));

  test.each([
    ["1.0.0", "1.0.1", "pass"],
    ["1.0.0", "1.1.0", "pass"],
    ["1.0.0", "2.0.0", "pass"],
    ["1.9.9", "1.10.0", "pass"],
    ["1.99.99", "2.0.0", "pass"],
    ["1.0.1", "1.0.0", "fail"],
    ["1.0.0", "1.0.0", "fail"],
    ["2.0.0", "1.99.99", "fail"],
    ["1.10.0", "1.9.9", "fail"],
  ])("%s to %s is %s", (before, after, expected) => {
    expect(verdictFor(before, after)).toBe(expected as "pass" | "fail");
  });
});

describe("the check shows what the facts left of an answer, not what the model said", () => {
  test("a criterion a fact lowered reads as lowered in the table", () => {
    const r = parsed({ evidence: evidence({ version_before: "1.0.0", version_after: "1.0.0" }) });
    const check = renderCheck({ kind: "reported", report: r });
    const text = `${check.summary}\n${check.text}`;
    // The model answered pass; the version did not move.
    expect(r.criteria.advances_revision).toBe("pass");
    expect(text).toMatch(/The revision advances[^\n]*\bNo\b/);
    expect(text).not.toMatch(/The revision advances[^\n]*\bYes\b/);
  });
});

// ---------------------------------------------------------------------------------------------
// Version 2: the screen, the review, the text facts, the usage (ADR 0107)
// ---------------------------------------------------------------------------------------------

describe("a version 2 report is exactly its keys, and its stage is a contract", () => {
  test("the report carries exactly the version 2 keys, and its evidence the three text facts", () => {
    const r = parsed();
    expect(Object.keys(r).sort()).toEqual([
      "criteria",
      "evidence",
      "findings",
      "models",
      "stage",
      "steering",
      "summary",
      "usage",
      "v",
    ]);
    expect(Object.keys(r.criteria).sort()).toEqual([...CRITERIA].sort());
    expect(r.evidence).toMatchObject({
      description_empty: false,
      title_problem: null,
      name_problem: null,
    });
    for (const key of ["description_empty", "title_problem", "name_problem"]) {
      const e = evidence();
      delete e[key];
      expect(refusal(report({ evidence: e })), key).toBe("bad_evidence");
    }
    expect(refusal(report({ evidence: evidence({ title_problem: "surname_year" }) }))).toBe(
      "bad_evidence",
    );
    expect(refusal(report({ evidence: evidence({ description_empty: "no" }) }))).toBe(
      "bad_evidence",
    );
  });

  test("a screen report is accepted only as a fail of genuine_contribution, the rest not assessed", () => {
    expect(refusal(screenReport())).toBe("accepted");
    expect(refusal(screenReport({ criteria: { ...SCREENED, genuine_contribution: "pass" } }))).toBe(
      "bad_stage",
    );
    expect(refusal(screenReport({ criteria: { ...SCREENED, no_degradation: "pass" } }))).toBe(
      "bad_stage",
    );
    expect(refusal(screenReport({ criteria: { ...SCREENED, advances_revision: "fail" } }))).toBe(
      "bad_stage",
    );
    expect(
      refusal(
        screenReport({ models: { screen: "claude-haiku-5-5", review: "claude-sonnet-5-5" } }),
      ),
    ).toBe("bad_model");
    expect(
      refusal(
        screenReport({
          usage: {
            screen: { input_tokens: 1, output_tokens: 1 },
            review: { input_tokens: 1, output_tokens: 1 },
          },
        }),
      ),
    ).toBe("bad_usage");
    expect(refusal(screenReport({ stage: "partial" }))).toBe("bad_stage");
  });

  test("a full report must pass genuine_contribution and name its review model and usage", () => {
    expect(refusal(report({ criteria: { genuine_contribution: "fail" } }))).toBe("bad_stage");
    expect(refusal(report({ criteria: { genuine_contribution: "unknown" } }))).toBe("bad_stage");
    expect(refusal(report({ models: { screen: "claude-haiku-5-5", review: null } }))).toBe(
      "bad_model",
    );
    expect(
      refusal(report({ usage: { screen: { input_tokens: 1, output_tokens: 1 }, review: null } })),
    ).toBe("bad_usage");
  });

  test("a screen report cannot pass, whatever else it says", () => {
    const r = parsePrReviewReport(screenReport());
    expect(verdictOf(r)).toBe("fail");
    expect(conclusionOf({ kind: "reported", report: r })).toBe("failure");
    // Even with every other word of it as clean as can be.
    const clean = parsePrReviewReport(screenReport({ findings: [], summary: "" }));
    expect(verdictOf(clean)).toBe("fail");
    expect(clean.findings.map((f) => f.code)).toEqual(["other"]);
  });

  test("usage counts are whole numbers of tokens, or the report is refused", () => {
    const usage = (screen: unknown) => ({
      screen,
      review: { input_tokens: 10, output_tokens: 10 },
    });
    for (const bad of [
      { input_tokens: -1, output_tokens: 1 },
      { input_tokens: 1.5, output_tokens: 1 },
      { input_tokens: "1", output_tokens: 1 },
      { input_tokens: 1 },
      { input_tokens: 1, output_tokens: 1, cost: 3 },
      { input_tokens: 1, output_tokens: 1e12 },
      null,
    ]) {
      expect(refusal(report({ usage: usage(bad) })), JSON.stringify(bad)).toBe("bad_usage");
    }
    expect(refusal(report({ usage: { screen: { input_tokens: 1, output_tokens: 1 } } }))).toBe(
      "bad_usage",
    );
    const r = parsed();
    if (r.v !== 2) throw new Error("not version 2");
    expect(r.usage.review).toEqual({ input_tokens: 21000, output_tokens: 9000 });
  });
});

describe("the text facts fail the verdict whatever the model says", () => {
  test("an empty description fails the text criterion", () => {
    const r = parsed({ evidence: evidence({ description_empty: true }) });
    expect(factsOf(r).criteria.clear_title_and_description).toBe("fail");
    expect(verdictOf(r)).toBe("fail");
    expect(renderCheck({ kind: "reported", report: r }).text).toContain("Description is empty");
  });

  test("a title that breaks the naming rule fails, and the check says how to fix it", () => {
    const r = parsed({ evidence: evidence({ title_problem: "author_year" }) });
    expect(verdictOf(r)).toBe("fail");
    const check = renderCheck({ kind: "reported", report: r });
    expect(check.summary).toContain("**Naming rule**");
    expect(check.summary).toContain("Edit the title.");
    expect(check.text).toContain("Title starts with a name and a year");
    expect(check.text).toContain("found by the naming rule, not by the reviewer");
  });

  test("a new dataset name that breaks the rule fails no_degradation", () => {
    const r = parsed({ evidence: evidence({ name_problem: "template_field" }) });
    expect(factsOf(r).criteria.no_degradation).toBe("fail");
    expect(verdictOf(r)).toBe("fail");
    expect(renderCheck({ kind: "reported", report: r }).summary).toContain(
      "changes the dataset's name",
    );
  });

  test("every rule that applies is stated, even when another already failed the criterion", () => {
    const r = parsed({
      evidence: evidence({ description_empty: true, title_problem: "template_field" }),
      criteria: { clear_title_and_description: "fail" },
      findings: [
        {
          criterion: "clear_title_and_description",
          severity: "blocker",
          code: "title_placeholder",
          path: null,
          note: "Template text.",
        },
      ],
    });
    const codes = factsOf(r).notes.map((n) => n.code);
    expect(codes).toContain("description_missing");
    expect(codes).toContain("title_template_field");
    const text = renderCheck({ kind: "reported", report: r }).text;
    expect(text).toContain("Description is empty");
    expect(text).toContain("Title has an unfilled template field");
  });

  test("a misleading description is a blocker that fails", () => {
    const r = parsed({
      criteria: { description_not_misleading: "fail" },
      findings: [
        {
          criterion: "description_not_misleading",
          severity: "blocker",
          code: "description_misleading",
          path: null,
          note: "Says README only; recordings were removed.",
        },
      ],
    });
    expect(verdictOf(r)).toBe("fail");
  });

  test("a description that does not quite match, as a note, can still pass", () => {
    const r = parsed({
      findings: [
        {
          criterion: "description_not_misleading",
          severity: "note",
          code: "description_mismatch",
          path: null,
          note: "The description does not mention the new sidecar.",
        },
      ],
    });
    expect(verdictOf(r)).toBe("pass");
    expect(conclusionOf({ kind: "reported", report: r })).toBe("success");
  });
});

describe("a stored version 1 report keeps what it said; a version 1 callback is refused", () => {
  test("a stored version 1 report is read by its own rules and keeps its verdict", () => {
    expect(verdictOf(parseStoredPrReviewReport(reportV1()))).toBe("pass");
    expect(
      verdictOf(
        parseStoredPrReviewReport(
          reportV1({
            criteria: {
              no_degradation: "unknown",
              advances_revision: "pass",
              material_improvement: "pass",
            },
          }),
        ),
      ),
    ).toBe("uncertain");
    expect(verdictOf(parseStoredPrReviewReport(reportV1({ steering: true })))).toBe("fail");
    // And it renders three questions, not six.
    const { summary, text } = renderCheck({
      kind: "reported",
      report: parseStoredPrReviewReport(reportV1()),
    });
    expect(summary).not.toContain("genuine contribution");
    expect(summary).toContain("Nothing is lost or broken");
    expect(text).toContain("Reviewed with claude-haiku-5-5.");
  });

  test("the stored parser still reads version 2, and still refuses what version 2 refuses", () => {
    expect(verdictOf(parseStoredPrReviewReport(report()))).toBe("pass");
    expect(() => parseStoredPrReviewReport(report({ verdict: "pass" }))).toThrow(
      PrReviewReportError,
    );
    expect(() => parseStoredPrReviewReport(reportV1({ model: "claude-sonnet-5-5" }))).toThrow(
      PrReviewReportError,
    );
  });

  test("a version 1 report sent by callback is report_invalid, and the reason is bad_version", () => {
    const refused: string[] = [];
    const o = parseCallbackOutcome(
      { outcome: "reported", report: reportV1(), error: undefined },
      (code) => refused.push(code),
    );
    expect(o).toEqual({ kind: "error", error: "report_invalid" });
    expect(refused).toEqual(["bad_version"]);
  });
});

describe("the check text of version 2", () => {
  test("a screen report reads Not assessed for every question it never asked", () => {
    const { title, summary, text } = renderCheck({
      kind: "reported",
      report: parsePrReviewReport(screenReport()),
    });
    expect(title).toBe("Needs changes: stopped by the screen");
    expect(summary).toContain("the full review did not run");
    expect(summary).toContain("| A genuine contribution, not spam | No |");
    expect(summary).toContain("| Nothing is lost or broken | Not assessed |");
    expect(summary).toContain("| The description is not misleading | Not assessed |");
    expect(summary).toContain("The full review did not run, so no file's content was read.");
    expect(text).toContain("Screened with claude-haiku-5-5; the full review did not run.");
    expect(text).not.toContain("not shown to the reviewer in full");
  });

  test("a rule that failed a criterion of a screen report reads No, not Not assessed", () => {
    const { summary } = renderCheck({
      kind: "reported",
      report: parsePrReviewReport(
        screenReport({ evidence: evidence({ files_read: 0, title_problem: "author_year" }) }),
      ),
    });
    expect(summary).toContain("| The title and description say what changed | No |");
  });

  test("a full report names both models and asks a NEMAR administrator, never a maintainer", () => {
    for (const o of everyOutcome()) {
      const r = renderCheck(o);
      const all = `${r.title}\n${r.summary}\n${r.text}`;
      expect(all, o.kind).not.toMatch(/\bmaintainer\b/i);
    }
    const { text } = renderCheck({ kind: "reported", report: parsed() });
    expect(text).toContain("Screened with claude-haiku-5-5 and reviewed with claude-sonnet-5-5.");
  });

  test("an outcome with no verdict does not pass and says a person must look", () => {
    for (const error of ["model_refused", "model_truncated"] as const) {
      const outcome = { kind: "error", error } as const;
      expect(conclusionOf(outcome)).toBe("action_required");
      expect(renderCheck(outcome).text).toContain(
        "No verdict was reached, so this check does not pass. A NEMAR administrator needs to look at this pull request.",
      );
    }
  });

  test("conclusionOf is never skipped for a reported review, at any stage", () => {
    const reports = [
      parsed(),
      parsed({ steering: true }),
      parsed({ criteria: { no_degradation: "unknown" } }),
      parsed({ criteria: { advances_revision: "fail" } }),
      parsePrReviewReport(screenReport()),
      parseStoredPrReviewReport(reportV1()),
    ];
    for (const report of reports) {
      expect(conclusionOf({ kind: "reported", report })).not.toBe("skipped");
    }
  });

  test("no word in angle brackets is left outside a code span, where GitHub would strip it as a tag", () => {
    for (const o of everyOutcome()) {
      const r = renderCheck(o);
      for (const text of [
        `${r.title}\n${r.summary}\n${r.text}`,
        renderComment(o, "a".repeat(40)),
      ]) {
        const bare = text
          .replace(/`[^`]*`/g, "")
          .replace(/<\/?(details|summary)>/g, "")
          .replace(/<!--[^>]*-->/g, "");
        expect(bare, o.kind).not.toMatch(/<\/?[A-Za-z][^>]*>/);
      }
    }
  });

  test("the human text carries no closed code word and no JSON, outside the file names it lists", () => {
    // The words with an underscore: a one-word code (spam, other) is also a plain English word.
    const words = [
      ...FINDING_CODES,
      ...RUN_ERRORS,
      ...DECLINE_REASONS,
      ...CRITERIA,
      "author_year",
      "template_field",
    ].filter((w) => w.includes("_"));
    for (const o of everyOutcome()) {
      const r = renderCheck(o);
      // A path in a code span is a file name the report lists, not a code.
      const all = `${r.title}\n${r.summary}\n${r.text}`.replace(/`[^`]*`/g, "");
      expect(all, o.kind).not.toMatch(/[{}]/);
      for (const w of words) expect(all, `${o.kind}: ${w}`).not.toContain(w);
    }
  });
});

describe("the naming rule on an owner's or administrator's pull request", () => {
  test("a refused title or name fails; a name that could not be read needs a person", () => {
    expect(conclusionOf({ kind: "naming", facts: { title: "author_year", name: null } })).toBe(
      "failure",
    );
    expect(conclusionOf({ kind: "naming", facts: { title: null, name: "author_year" } })).toBe(
      "failure",
    );
    expect(conclusionOf({ kind: "naming", facts: { title: null, name: "unchecked" } })).toBe(
      "action_required",
    );
    expect(
      conclusionOf({ kind: "naming", facts: { title: "template_field", name: "unchecked" } }),
    ).toBe("failure");
  });

  test("the check says what the rule found, how to fix it, and the one override", () => {
    const r = renderCheck({ kind: "naming", facts: { title: "author_year", name: "author_year" } });
    expect(r.title).toBe("Needs changes: the naming rule");
    expect(r.summary).toContain("Edit the title.");
    expect(r.summary).toContain("changes the dataset's name");
    expect(r.text).toContain("`nemar admin pr-reviews allow <dataset> <pr> --admin`");
    const u = renderCheck({ kind: "naming", facts: { title: null, name: "unchecked" } });
    expect(u.title).toBe("Could not decide: the naming rule was not checked");
    expect(u.summary).toContain("could not be read from GitHub");
  });

  test("a waiver is skipped and says it was waived, for this commit only", () => {
    const r = renderCheck({ kind: "exempt", waived: true });
    expect(r.title).toContain("naming rule waived");
    expect(r.text).toContain("does not carry over");
    expect(renderComment({ kind: "exempt", waived: true }, "a".repeat(40))).toContain(
      "NOT REQUIRED",
    );
  });
});

describe("the estimate of what the reviews cost", () => {
  test("each stage is priced as its own model, to the cent", () => {
    // 1M tokens in and out of each: Haiku 0.10 + 0.50, Sonnet 2 + 10.
    expect(
      estimateCostUsd({
        screen_input: 1_000_000,
        screen_output: 1_000_000,
        review_input: 1_000_000,
        review_output: 1_000_000,
      }),
    ).toBe(12.6);
    expect(
      estimateCostUsd({ screen_input: 0, screen_output: 0, review_input: 0, review_output: 0 }),
    ).toBe(0);
    expect(MODEL_PRICES_USD_PER_MTOK["claude-sonnet-5-5"]).toEqual({ input: 2, output: 10 });
  });
});
