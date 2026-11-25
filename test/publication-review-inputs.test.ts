/**
 * The publication review's widened inputs, job side (ADR 0139, decisions 5, 6, 7 and 9; epic #2182,
 * card B4): the pre-send scan of each section, the fences the model reads them in, the input digest,
 * and what the lineage and the note's answer can do to a verdict.
 *
 * Everything here is the production code over inputs bodies in the shape the Worker serves
 * (`helpers/review-inputs.ts`): the real pre-send module, the real prompt builder, the real report
 * parser and the real reasons. Nothing is mocked; the one network piece, the job's fetch of the
 * inputs, is driven against a local `Bun.serve` that answers the way the Worker's route does.
 */

import { describe, expect, test } from "bun:test";
import {
  fetchPublicationReviewInputs,
  runPublicationReview,
} from "../scripts/ci/publication-review";
import { evidenceFromDocuments } from "../scripts/ci/publication-review-evidence";
import { isInputCleared, presendInputs } from "../scripts/ci/publication-review-presend";
import {
  assemblePublicationReport,
  buildPublicationReviewMessages,
  publicationInputDigest,
} from "../scripts/ci/publication-review-prompt";
import { LINEAGE_OUTCOMES } from "../shared/license-lineage";
import {
  LINEAGE_UNCONFIRMED_OUTCOMES,
  PUBLICATION_REPORT_VERSION,
  type PublicationReviewEvidence,
  REVIEW_INPUTS,
  type RawDocument,
  type ReviewDocument,
  type ReviewInputsBody,
  ReviewInputsError,
  lineageCredited,
  parsePublicationReviewEvidence,
  parsePublicationReviewReport,
  parseReviewInputs,
  reasonStatement,
  reportReasons,
  verdictOf,
} from "../shared/publication-review";
import { emptyInputs, fullInputs } from "./helpers/review-inputs";

const NONCE = "0123456789abcdef0123456789abcdef";
const HEAD = "a".repeat(40);

const present = (text: string, name: string): RawDocument => ({ name, state: "present", text });
const DOCS: Record<ReviewDocument, RawDocument> = {
  readme: present(
    "# Resting EEG\nSixty-four channel EEG at rest, eyes open and closed.\n",
    "README.md",
  ),
  dataset_description: present(
    JSON.stringify({
      Name: "Resting-state EEG in healthy adults",
      Version: "1.0.0",
      BIDSVersion: "1.9.0",
      License: "CC-BY-4.0",
      Authors: ["Lab of Example Studies"],
      EthicsApprovals: ["Approved by an institutional review board, protocol 2026-001"],
    }),
    "dataset_description.json",
  ),
  changes: present("1.0.0 2026-11-01\n  - Initial release.\n", "CHANGES"),
  license: present("Creative Commons Attribution 4.0\n", "LICENSE"),
  participants_json: { name: "participants.json", state: "absent", text: null },
};

const SUMMARY = {
  subjects: 30,
  sessions: 0,
  recordings: 30,
  datatypes: ["eeg" as const],
  formats: { ".edf": 30 },
  has_derivatives: false,
  has_sourcedata: false,
  has_code: false,
  sampling_rates_hz: [512],
  channel_counts: [64],
  sidecars_read: 30,
  sidecars_total: 30,
};

/** The evidence and cleared text the job would build for `body`. */
function build(body: ReviewInputsBody) {
  const presend = presendInputs(body);
  return evidenceFromDocuments(DOCS, {
    head: HEAD,
    anonymous: false,
    tagsText: "",
    bidsRuns: JSON.stringify({
      workflow_runs: [{ head_sha: HEAD, status: "completed", conclusion: "success" }],
    }),
    summary: SUMMARY,
    inputs: {
      presend,
      lineage: { outcome: body.lineage.outcome, credited: lineageCredited(body.lineage.sources) },
    },
  });
}

/** The user message the model would be sent for `body`. */
function userOf(body: ReviewInputsBody): string {
  const { facts, cleared, clearedInputs } = build(body);
  return buildPublicationReviewMessages({ facts, cleared, clearedInputs, nonce: NONCE }).user;
}

const ALL_PASS = {
  complete_and_honest: "pass",
  meets_standards: "pass",
  authors_and_license: "pass",
  name_adequate: "pass",
};

/** A report the job would assemble for `body` from a model that passed every question. */
function reportOf(body: ReviewInputsBody, over: Record<string, unknown> = {}) {
  const { facts } = build(body);
  return assemblePublicationReport(
    { questions: ALL_PASS, findings: [], summary: "A dataset.", steering: false, ...over },
    facts,
  );
}

describe("each new section is fenced and scanned", () => {
  test("every section of a clean body is cleared, registered and sent in its own fence", () => {
    const body = fullInputs();
    const r = presendInputs(body);
    for (const i of REVIEW_INPUTS) {
      expect({ i, state: r.states[i] }).toEqual({ i, state: "sent" });
      expect(isInputCleared(i, r.cleared[i])).toBe(true);
      // Registered under its own name: a section's text is not cleared as any other.
      for (const other of REVIEW_INPUTS) {
        if (other !== i) expect(isInputCleared(other, r.cleared[i])).toBe(false);
      }
    }
    const user = userOf(body);
    for (const i of REVIEW_INPUTS) expect(user).toContain(`<untrusted-${NONCE} kind="${i}">`);
    expect(user).toContain("We expanded the README");
    // The facts tell the model each section's state in the documents' four words.
    expect(user).toContain('"metadata": {');
  });

  test("an empty body sends no section, and the facts say each is absent", () => {
    const r = presendInputs(emptyInputs());
    for (const i of REVIEW_INPUTS) expect(r.states[i]).toBe("absent");
    expect(r.cleared).toEqual({});
    const user = userOf(emptyInputs());
    for (const i of REVIEW_INPUTS) expect(user).not.toContain(`kind="${i}"`);
  });

  test("each section is cut to its own budget, and the cut is a fact", () => {
    const long = "word ".repeat(1000);
    const body = fullInputs({ resubmission_note: long });
    const r = presendInputs(body);
    expect(r.states.resubmission_note).toBe("sent_cut");
    expect((r.cleared.resubmission_note ?? "").length).toBeLessThanOrEqual(
      2_000 + "\n[cut]".length,
    );
  });

  test("the prompt builder refuses a section the pre-send module did not clear", () => {
    const { facts, cleared, clearedInputs } = build(fullInputs());
    const forged = { ...clearedInputs, resubmission_note: clearedInputs.lineage };
    expect(() =>
      buildPublicationReviewMessages({ facts, cleared, clearedInputs: forged, nonce: NONCE }),
    ).toThrow("an input was not cleared by pre-send");
    const { coverage: _dropped, ...missing } = clearedInputs;
    expect(() =>
      buildPublicationReviewMessages({ facts, cleared, clearedInputs: missing, nonce: NONCE }),
    ).toThrow("cleared inputs disagree with the facts");
  });
});

describe("a section holding a path or a name-like value is withheld and recorded", () => {
  const withheldCases: [string, ReviewInputsBody, (typeof REVIEW_INPUTS)[number], string][] = [
    [
      "a note with a path on someone's machine",
      fullInputs({ resubmission_note: "Fixed the files in /Users/jdoe/eeg-study/ as asked." }),
      "resubmission_note",
      "/Users/jdoe",
    ],
    [
      "a note with a Windows drive path",
      fullInputs({ resubmission_note: "Converted on D:\\lab\\raw before upload." }),
      "resubmission_note",
      "D:\\lab",
    ],
    [
      "an enrichment with a patient name under an identifier key, deep inside a field",
      fullInputs({
        enrichment: {
          fields: {
            title: "Resting EEG",
            related_identifiers: [{ identifier: "10.1/x", PatientName: "Jane Example" }],
          },
          source: null,
        },
      }),
      "enrichment",
      "Jane Example",
    ],
    [
      "an enrichment with a file URL",
      fullInputs({
        enrichment: { fields: { description: "See file:///home/jdoe/notes.txt" }, source: null },
      }),
      "enrichment",
      "/home/jdoe",
    ],
    [
      "a registry record whose URL is a local path",
      fullInputs({
        lineage: {
          ...fullInputs().lineage,
          sources: [{ ...fullInputs().lineage.sources[0], evidence_url: "C:/Users/jdoe/record" }],
        },
      }),
      "registry_records",
      "C:/Users/jdoe",
    ],
  ];

  for (const [name, body, input, value] of withheldCases) {
    test(name, () => {
      const r = presendInputs(body);
      expect(r.states[input]).toBe("withheld_finding");
      expect(r.cleared[input]).toBeUndefined();
      expect(Object.keys(r.withheld_findings).length).toBeGreaterThan(0);
      const user = userOf(body);
      expect(user).not.toContain(value);
      expect(user).not.toContain(`kind="${input}"`);
      // Recorded: the evidence says so, its counts say why (and are never sent), and the review
      // says text was withheld, naming the section.
      const { facts } = build(body);
      expect(facts.inputs?.[input]).toBe("withheld_finding");
      const report = reportOf(body);
      const withheld = reportReasons(report).find((r) => r.code === "text_withheld");
      expect(withheld?.detail?.split(",")).toContain(input);
      expect(reasonStatement(withheld as never, report)).toContain("withheld");
      expect(verdictOf(reportReasons(report))).not.toBe("pass");
      expect(user).not.toMatch(/json-identifier-key|local-user-path|withheld_findings/);
    });
  }
});

describe("the input digest", () => {
  const digest = (body: ReviewInputsBody) => {
    const { facts, cleared, clearedInputs } = build(body);
    return publicationInputDigest({ facts, cleared, clearedInputs });
  };

  test("is stable for identical inputs, whatever the run's nonce", () => {
    const a = digest(fullInputs());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(digest(fullInputs())).toBe(a);
  });

  test("changes with one byte of any section", () => {
    const a = digest(fullInputs());
    const note = fullInputs().resubmission_note as string;
    expect(digest(fullInputs({ resubmission_note: `${note}.` }))).not.toBe(a);
    expect(digest(fullInputs({ resubmission_note: note.replace("README", "README ") }))).not.toBe(
      a,
    );
    const cov = fullInputs({
      coverage: {
        source: "screen_v2",
        formats: { edf: { files: 60, read: 57, partial: 2, failed: 1 } },
      },
    });
    expect(digest(cov)).not.toBe(a);
  });

  test("is the one the assembled report records", async () => {
    const body = fullInputs();
    const { facts, cleared, clearedInputs } = build(body);
    const d = publicationInputDigest({ facts, cleared, clearedInputs });
    const report = assemblePublicationReport(
      {
        questions: ALL_PASS,
        findings: [],
        summary: "x",
        steering: false,
        note_addresses_reasons: "pass",
      },
      facts,
      undefined,
      { inputDigest: d, resolverVersion: body.lineage.resolver_version },
    );
    expect(report.v).toBe(PUBLICATION_REPORT_VERSION);
    expect(report.record).toEqual({
      prompt_version: "publication-review-prompt/2",
      models: [{ model: "claude-haiku-5-5", effort: "high" }],
      input_digest: d,
      resolver_version: body.lineage.resolver_version,
    });
  });
});

describe("license lineage in the verdict (ADR 0139, decision 7, amended 2026-11-25)", () => {
  const withOutcome = (outcome: (typeof LINEAGE_OUTCOMES)[number]) =>
    fullInputs({
      resubmission_note: null,
      lineage: {
        ...fullInputs().lineage,
        outcome,
        sources: fullInputs().lineage.sources.map((s) => ({ ...s, outcome })),
      },
    });

  test("unresolved gives license_lineage_unconfirmed, and the verdict is action required, never fail", () => {
    const report = reportOf(withOutcome("unresolved"));
    const reasons = reportReasons(report);
    expect(reasons).toEqual([{ code: "license_lineage_unconfirmed", detail: "unresolved" }]);
    expect(verdictOf(reasons)).toBe("action_required");
  });

  test("each outcome that needs action is that one reason, and the others are none", () => {
    expect([...LINEAGE_UNCONFIRMED_OUTCOMES].sort()).toEqual(
      [
        "needs_permission",
        "redistribution_prohibited",
        "share_alike_mismatch",
        "source_is_publication",
        "unresolved",
      ].sort(),
    );
    for (const outcome of LINEAGE_OUTCOMES) {
      const reasons = reportReasons(reportOf(withOutcome(outcome)));
      const lineage = reasons.filter((r) => r.code === "license_lineage_unconfirmed");
      expect({ outcome, n: lineage.length }).toEqual({
        outcome,
        n: LINEAGE_UNCONFIRMED_OUTCOMES.includes(outcome) ? 1 : 0,
      });
      expect({ outcome, v: verdictOf(reasons) }).not.toEqual({ outcome, v: "fail" });
    }
  });

  test("attribution without a SourceDatasets credit is the platform's concern, and only then", () => {
    const uncredited = fullInputs({
      resubmission_note: null,
      lineage: {
        ...fullInputs().lineage,
        sources: fullInputs().lineage.sources.map((s) => ({ ...s, origin: "related_identifiers" })),
      },
    });
    const report = reportOf(uncredited);
    expect(report.findings.map((f) => [f.code, f.severity])).toEqual([
      ["source_credit_missing", "concern"],
    ]);
    // A concern: the verdict is untouched.
    expect(verdictOf(reportReasons(report))).toBe("pass");
    expect(reportOf(fullInputs({ resubmission_note: null })).findings).toEqual([]);
    // A model cannot file it, and cannot remove it: the parser decides it from the evidence.
    const filed = reportOf(fullInputs({ resubmission_note: null }), {
      findings: [
        {
          question: "authors_and_license",
          severity: "blocker",
          code: "source_credit_missing",
          document: "none",
          note: "x",
        },
      ],
    });
    expect(filed.findings).toEqual([]);
    // Parsing a parsed report changes nothing.
    expect(parsePublicationReviewReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });
});

describe("the note's answer (ADR 0139, decision 5)", () => {
  test("a note answered fail or unknown asks for a person; it never fails the request", () => {
    for (const answer of ["fail", "unknown"] as const) {
      const report = reportOf(fullInputs(), { note_addresses_reasons: answer });
      expect(report.note_answer).toBe(answer);
      const reasons = reportReasons(report);
      expect(reasons.map((r) => r.code)).toContain("resubmission_note_unaddressed");
      expect(verdictOf(reasons)).toBe("action_required");
    }
  });

  test("a note's pass cannot make a pass of anything else, and its fail cannot make a fail", () => {
    // Every question passed and the note passed: the verdict is the rest's (here pass).
    expect(
      verdictOf(reportReasons(reportOf(fullInputs(), { note_addresses_reasons: "pass" }))),
    ).toBe("pass");
    // A question the model could not answer stays action required, whatever the note's answer.
    const unknown = { ...ALL_PASS, meets_standards: "unknown" };
    expect(
      verdictOf(
        reportReasons(
          reportOf(fullInputs(), { questions: unknown, note_addresses_reasons: "pass" }),
        ),
      ),
    ).toBe("action_required");
    // A failed question stays a fail, and the note adds nothing that could lower it further.
    const failed = { ...ALL_PASS, name_adequate: "fail" };
    const withFail = reportReasons(
      reportOf(fullInputs(), { questions: failed, note_addresses_reasons: "fail" }),
    );
    expect(verdictOf(withFail)).toBe("fail");
    expect(verdictOf(withFail.filter((r) => r.code !== "question_failed"))).toBe("action_required");
  });

  test("no note shown: the answer is not asked, whatever the model said, and counts for nothing", () => {
    for (const answer of ["pass", "fail", "unknown", "not_asked", undefined]) {
      const report = reportOf(fullInputs({ resubmission_note: null }), {
        note_addresses_reasons: answer,
      });
      expect(report.note_answer).toBe("not_asked");
      expect(verdictOf(reportReasons(report))).toBe("pass");
    }
  });

  test("a note shown and left unanswered is unknown, never a pass", () => {
    const report = reportOf(fullInputs(), { note_addresses_reasons: "not_asked" });
    expect(report.note_answer).toBe("unknown");
    expect(verdictOf(reportReasons(report))).toBe("action_required");
  });
});

describe("the job never reviews on part of its inputs", () => {
  test("a body that is not the Worker's shape is refused with one fixed word", () => {
    const good = emptyInputs();
    for (const bad of [
      null,
      { ...good, extra: 1 },
      { ...good, v: 2 },
      {
        ...good,
        coverage: {
          source: "screen_v2",
          formats: { "../x": { files: 1, read: 0, partial: 0, failed: 0 } },
        },
      },
      {
        ...good,
        coverage: {
          source: "screen_v2",
          formats: { edf: { files: 1, read: 2, partial: 0, failed: 0 } },
        },
      },
      {
        ...good,
        coverage: {
          source: "screen_v2",
          formats: { edf: { files: 1, read: 0, partial: 0, failed: 0, kinds: 3 } },
        },
      },
      { ...good, lineage: { ...good.lineage, outcome: "fine" } },
      { ...good, lineage: { ...good.lineage, resolver_version: "x" } },
      { ...good, enrichment: { fields: { methods_description: "x" }, source: null } },
    ]) {
      expect(() => parseReviewInputs(bad)).toThrow(ReviewInputsError);
    }
    expect(parseReviewInputs(JSON.parse(JSON.stringify(fullInputs())))).toEqual(fullInputs());
  });

  test("a fetch that fails, or answers anything but a 200, is inputs_unavailable, before git or a model", async () => {
    for (const status of [409, 401, 502]) {
      let asked = 0;
      const server = Bun.serve({
        port: 0,
        fetch: () => {
          asked++;
          return Response.json({ error: "x" }, { status });
        },
      });
      try {
        const res = await runPublicationReview({
          // Neither the repository nor the files exist: reaching them would be another error.
          repoDir: "/nonexistent",
          head: HEAD,
          fetchedHead: HEAD,
          tagsFile: "/nonexistent/tags",
          bidsRunsFile: "/nonexistent/bids",
          anonymous: false,
          fetchInputs: () =>
            fetchPublicationReviewInputs(
              `http://127.0.0.1:${server.port}`,
              "token",
              { reviewId: 1, datasetId: "nm000480" },
              async () => {},
            ),
        });
        expect(res).toMatchObject({ outcome: "error", error: "inputs_unavailable" });
        // A 5xx is retried, as the callback is; a 4xx will not improve.
        expect(asked).toBe(status >= 500 ? 3 : 1);
      } finally {
        server.stop(true);
      }
    }
    const malformed = await runPublicationReview({
      repoDir: "/nonexistent",
      head: HEAD,
      fetchedHead: HEAD,
      tagsFile: "/nonexistent/tags",
      bidsRunsFile: "/nonexistent/bids",
      anonymous: false,
      fetchInputs: async () => ({ v: 1 }),
    });
    expect(malformed).toMatchObject({ outcome: "error", error: "inputs_unavailable" });
  });
});

describe("a stored version-1 report reads as it always did", () => {
  test("its evidence has no inputs and no lineage, and it reads back after a store", () => {
    const facts = build(emptyInputs()).facts;
    const { inputs: _inputs, lineage: _lineage, ...v1Evidence } = facts;
    const parsed = parsePublicationReviewEvidence(v1Evidence) as PublicationReviewEvidence;
    expect(parsed.inputs).toBeNull();
    expect(parsed.lineage).toBeNull();
    const v1 = parsePublicationReviewReport({
      v: 1,
      model: "claude-haiku-5-5",
      questions: ALL_PASS,
      findings: [],
      summary: "x",
      steering: false,
      evidence: v1Evidence,
    });
    expect(v1).toMatchObject({ v: 1, note_answer: "not_asked", record: null });
    expect(parsePublicationReviewReport(JSON.parse(JSON.stringify(v1)))).toEqual(v1);
    // A version-1 report cannot claim the widened inputs, nor a version-2 one deny them.
    expect(() =>
      parsePublicationReviewReport({ ...JSON.parse(JSON.stringify(v1)), note_answer: "pass" }),
    ).toThrow();
  });
});
