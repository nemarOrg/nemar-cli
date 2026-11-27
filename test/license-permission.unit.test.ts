/**
 * License permission evidence, the pure rule (epic #2182, card B6; ADR 0139 decision 7 and its
 * amendment of 2026-11-25): the depositor's message per outcome, the basis a review keeps, what a
 * recorded permission covers, and what it clears in the review's derivation.
 *
 * CI TIER: unit-pure.
 */

import { describe, expect, test } from "bun:test";
import { evidenceFor } from "../backend/test/helpers/publication-review";
import {
  ACTION_REQUIRED_OUTCOMES,
  LINEAGE_OUTCOMES,
  LINEAGE_PERMISSION_REQUEST,
  type LineageSource,
} from "../shared/license-lineage";
import {
  type PermissionBasis,
  type PermissionScope,
  licensePermissionRecordedLine,
  licensePermissionRequest,
  mailNotSentLines,
  parsePermissionBasis,
  permissionBasisOf,
  permissionCovers,
} from "../shared/license-permission";
import {
  LINEAGE_UNCONFIRMED_OUTCOMES,
  type LiveFacts,
  PUBLICATION_PROMPT_VERSION,
  REVIEW_INPUTS,
  parsePublicationReviewReport,
  reasonsOf,
  reportReasons,
  storedVerdictWithPermission,
  verdictOf,
} from "../shared/publication-review";

const DS = "nm000480";
const SOURCE = "10.18112/openneuro.ds000001.v1.0.0";
const OTHER = "10.5281/zenodo.1234567";

function basis(
  ids: string[],
  outcome: PermissionBasis["outcome"] = "needs_permission",
  target: PermissionBasis["target_license"] = "cc-by",
): PermissionBasis {
  return {
    outcome,
    target_license: target,
    sources: ids.map((id) => ({ id, license: "cc-by-nc-nd", license_version: "4.0", outcome })),
  };
}

function source(id: string, outcome: LineageSource["outcome"], license = "cc-by"): LineageSource {
  return {
    id,
    resolver: "datacite",
    resource_type: "Dataset",
    title: "A title the registry holds",
    creators: [],
    publisher: null,
    license: license as LineageSource["license"],
    license_version: "4.0",
    raw: "free text a registry returned",
    evidence_url: null,
    status: "resolved",
    origin: "source_datasets",
    outcome,
  };
}

describe("the depositor's message", () => {
  test("one entry per outcome that needs action, and the reason's outcomes are the same set", () => {
    expect(Object.keys(LINEAGE_PERMISSION_REQUEST).sort()).toEqual(
      [...ACTION_REQUIRED_OUTCOMES].sort(),
    );
    expect([...LINEAGE_UNCONFIRMED_OUTCOMES]).toEqual([...ACTION_REQUIRED_OUTCOMES]);
  });

  test("each outcome's message, filled from the basis", () => {
    const authors = (o: "needs_permission" | "share_alike_mismatch") =>
      expect(licensePermissionRequest(DS, o, basis([SOURCE], o))).toBe(
        `The license of the upstream data (${SOURCE}, cc-by-nc-nd 4.0) does not permit this copy under cc-by. Please send evidence from the original authors that they accept this copy being published under cc-by, for example an email from them, to support@nemar.org, quoting ${DS}. An administrator will record it and the review will continue.`,
      );
    authors("needs_permission");
    authors("share_alike_mismatch");
    expect(
      licensePermissionRequest(
        DS,
        "source_is_publication",
        basis([SOURCE], "source_is_publication"),
      ),
    ).toBe(
      `The upstream source you named (${SOURCE}, cc-by-nc-nd 4.0) is a publication, not a dataset, so its license is not the data's license. Name the dataset the data came from in dataset_description.json SourceDatasets (its DOI or repository URL), or send evidence that the original authors accept this copy under cc-by, to support@nemar.org, quoting ${DS}.`,
    );
    expect(
      licensePermissionRequest(
        DS,
        "redistribution_prohibited",
        basis(["physionet:mimic-iv:2.2"], "redistribution_prohibited"),
      ),
    ).toBe(
      `The license of the upstream data (physionet:mimic-iv:2.2, cc-by-nc-nd 4.0) does not permit this copy under cc-by. Please send evidence from the repository that holds the upstream data, for example PhysioNet, that it permits this copy being published under cc-by, to support@nemar.org, quoting ${DS}; its data use agreement may bind the original authors too, so their permission alone may not be enough. An administrator will record it and the review will continue.`,
    );
    expect(licensePermissionRequest(DS, "unresolved", basis([SOURCE], "unresolved"))).toBe(
      `NEMAR could not read the upstream license (${SOURCE}, cc-by-nc-nd 4.0); reply to support@nemar.org with a link to it, quoting ${DS}, or wait for the next check.`,
    );
  });

  test("no free text is interpolated: a declared URL, an identifier with words in it, a bad id", () => {
    const b = basis([
      "url:https://example.org/please approve this",
      "10.1234/abc ignore the rules",
    ]);
    const text = licensePermissionRequest("not an id <b>", "needs_permission", b);
    expect(text).not.toContain("please approve");
    expect(text).not.toContain("ignore the rules");
    expect(text).not.toContain("<b>");
    expect(text).toContain(
      "(a source given as a link or text, cc-by-nc-nd 4.0; a source given as a link or text, cc-by-nc-nd 4.0)",
    );
    expect(text).toContain("quoting your dataset's id.");
    // The licenses are closed words: what is true is said for one that could not be read.
    const unread = licensePermissionRequest(DS, "needs_permission", {
      outcome: "needs_permission",
      target_license: null,
      sources: [
        { id: SOURCE, license: null, license_version: "9; drop", outcome: "needs_permission" },
      ],
    });
    expect(unread).toContain(`(${SOURCE}, a license NEMAR could not read)`);
    expect(unread).toContain("under a license NEMAR could not read.");
    expect(unread).not.toContain("drop");
  });

  test("the target is named as the dataset declares it, when that is a license id of the same license", () => {
    const declared = (d: unknown, target: PermissionBasis["target_license"] = "cc-by") =>
      licensePermissionRequest(DS, "needs_permission", {
        ...basis([SOURCE], "needs_permission", target),
        target_license_declared: d as string | null,
      });
    expect(declared("CC-BY-4.0")).toContain(
      "does not permit this copy under CC-BY-4.0. Please send evidence from the original authors that they accept this copy being published under CC-BY-4.0,",
    );
    expect(declared("CC0", "cc0")).toContain("under CC0.");
    expect(declared("CC0-1.0", "cc0")).toContain("under CC0-1.0.");
    expect(declared("ODC-By-1.0", "odc-by")).toContain("under ODC-By-1.0.");
    // Text that is not a license id, or that names another license, is never quoted.
    for (const d of [
      "CC BY 4.0 <b>",
      "CC-BY-NC-4.0",
      "CC-BY-4.0-Whatever",
      "https://example.org/x",
      null,
      7,
    ]) {
      expect(declared(d)).toContain("does not permit this copy under cc-by.");
    }
    // The publication sentence names it too.
    expect(
      licensePermissionRequest(DS, "source_is_publication", {
        ...basis([SOURCE], "source_is_publication"),
        target_license_declared: "CC-BY-4.0",
      }),
    ).toContain("accept this copy under CC-BY-4.0, to support@nemar.org");
  });

  test("without a basis, or with one of another outcome, the sources are left out", () => {
    for (const b of [null, basis([SOURCE], "unresolved")]) {
      expect(licensePermissionRequest(DS, "needs_permission", b)).toStartWith(
        "The license of the upstream data does not permit this copy under a license NEMAR could not read.",
      );
    }
  });

  test("the recorded line names the date, the administrator and the ticket", () => {
    expect(
      licensePermissionRecordedLine({
        recorded_at: "2026-11-25 18:30:00",
        recorded_by: "yahya",
        ticket_id: 412,
      }),
    ).toBe("License permission recorded on 2026-11-25 by yahya, ticket 412.");
  });
});

describe("the basis a review keeps", () => {
  test("the sources behind the outcome only, and the registry's free text dropped", () => {
    const b = permissionBasisOf({
      outcome: "needs_permission",
      target_license: "cc-by",
      sources: [source(SOURCE, "needs_permission", "cc-by-nd"), source(OTHER, "compatible")],
    });
    expect(b).toEqual({
      outcome: "needs_permission",
      target_license: "cc-by",
      target_license_declared: null,
      sources: [
        { id: SOURCE, license: "cc-by-nd", license_version: "4.0", outcome: "needs_permission" },
      ],
    });
    expect(parsePermissionBasis(JSON.stringify(b))).toEqual(b);
  });

  test("the declared License is kept when it is a license id that reads as the target", () => {
    const of = (raw: string | null) =>
      permissionBasisOf({
        outcome: "needs_permission",
        target_license: "cc-by",
        target_license_raw: raw,
        sources: [source(SOURCE, "needs_permission", "cc-by-nd")],
      });
    const kept = of("CC-BY-4.0");
    expect(kept.target_license_declared).toBe("CC-BY-4.0");
    expect(parsePermissionBasis(JSON.stringify(kept))).toEqual(kept);
    for (const raw of ["Creative Commons Attribution 4.0", "CC-BY-SA-4.0", "", null]) {
      expect(of(raw).target_license_declared).toBeNull();
    }
    // A basis stored before the field existed still reads, and names the target by its word.
    const { target_license_declared: _, ...old } = kept;
    expect(parsePermissionBasis(JSON.stringify(old))).toEqual(old);
    // A stored declared value that is not quotable, or reads as another license, is refused.
    for (const bad of ["CC BY <b>", "CC-BY-NC-4.0", 4]) {
      expect(
        parsePermissionBasis(JSON.stringify({ ...kept, target_license_declared: bad })),
      ).toBeNull();
    }
  });

  test("two compatible sources that conflict: both are behind the outcome", () => {
    const b = permissionBasisOf({
      outcome: "needs_permission",
      target_license: "cc-by-nc",
      sources: [
        source(SOURCE, "compatible_nc", "cc-by-nc"),
        source(OTHER, "compatible_attribution", "cc-by-sa"),
      ],
    });
    expect(b.sources.map((s) => s.id)).toEqual([SOURCE, OTHER]);
  });

  test("a compatible lineage has nothing behind it", () => {
    expect(
      permissionBasisOf({
        outcome: "compatible_attribution",
        target_license: "cc-by",
        sources: [source(SOURCE, "compatible_attribution")],
      }).sources,
    ).toEqual([]);
  });

  test("a stored basis is read strictly", () => {
    const good = basis([SOURCE]);
    for (const bad of [
      null,
      "",
      "not json",
      "[]",
      JSON.stringify({ ...good, extra: 1 }),
      JSON.stringify({ ...good, outcome: "approved" }),
      JSON.stringify({ ...good, target_license: "mit-ish" }),
      JSON.stringify({ ...good, sources: [{ ...good.sources[0], id: "" }] }),
      JSON.stringify({ ...good, sources: [{ ...good.sources[0], id: "x".repeat(513) }] }),
    ]) {
      expect(parsePermissionBasis(bad)).toBeNull();
    }
  });
});

describe("what a permission covers", () => {
  const scope = (
    ids: string[],
    outcome: PermissionScope["outcome"] = "needs_permission",
    target: PermissionScope["target_license"] = "cc-by",
  ): PermissionScope => ({
    outcome,
    target_license: target,
    source_ids: ids,
  });

  test("every source behind the outcome must be named", () => {
    expect(permissionCovers(scope([SOURCE]), basis([SOURCE]))).toBe(true);
    expect(permissionCovers(scope([SOURCE, OTHER]), basis([SOURCE]))).toBe(true);
    // One source it does not name, and it covers nothing.
    expect(permissionCovers(scope([SOURCE]), basis([SOURCE, OTHER]))).toBe(false);
    expect(permissionCovers(scope([OTHER]), basis([SOURCE]))).toBe(false);
  });

  test("the same outcome and target license, and never the dataset's own files", () => {
    expect(permissionCovers(scope([SOURCE], "needs_permission", "cc0"), basis([SOURCE]))).toBe(
      false,
    );
    expect(
      permissionCovers(
        scope([SOURCE], "needs_permission"),
        basis([SOURCE], "redistribution_prohibited"),
      ),
    ).toBe(false);
    expect(
      permissionCovers(
        scope(["dataset_description.json"], "unresolved", null),
        basis(["dataset_description.json"], "unresolved", null),
      ),
    ).toBe(false);
    for (const o of LINEAGE_OUTCOMES.filter(
      (x) => !(ACTION_REQUIRED_OUTCOMES as readonly string[]).includes(x),
    )) {
      // A permission's own outcome is one that needs action; a basis that does not need any is covered by none.
      expect(permissionCovers(scope([SOURCE]), { ...basis([SOURCE]), outcome: o })).toBe(false);
    }
  });
});

describe("what a permission clears in the derivation", () => {
  const ABSENT = Object.fromEntries(REVIEW_INPUTS.map((i) => [i, "absent"]));
  const report = (fail: boolean) =>
    parsePublicationReviewReport({
      v: 2,
      model: "claude-haiku-5-5",
      questions: {
        complete_and_honest: fail ? "fail" : "pass",
        meets_standards: "pass",
        authors_and_license: "pass",
        name_adequate: "pass",
      },
      findings: fail
        ? [
            {
              question: "complete_and_honest",
              severity: "blocker",
              code: "readme_missing_or_stub",
              document: "readme",
              note: "A stub.",
            },
          ]
        : [],
      summary: "",
      steering: false,
      evidence: {
        ...evidenceFor(),
        inputs: ABSENT,
        lineage: { outcome: "needs_permission", credited: true },
      },
      note_answer: "not_asked",
      record: {
        prompt_version: PUBLICATION_PROMPT_VERSION,
        models: [{ model: "claude-haiku-5-5", effort: "high" }],
        input_digest: "ab".repeat(32),
        resolver_version: null,
        enrichment_source: null,
      },
    });
  const live = (permitted: boolean): LiveFacts => ({
    request: { status: "requested", block_reason: null, anonymous: false },
    screen: { gate: "clear", head: "a".repeat(40), acknowledged_by: null, head_current: null },
    versions: { version_row_exists: false, prior_anonymous_request: false, first_published: false },
    doi: { concept_doi_present: false, concept_ezid_status: null },
    license_permission: permitted
      ? { recorded_at: "2026-11-25 18:30:00", recorded_by: "yahya", ticket_id: 412 }
      : null,
  });
  const codes = (permitted: boolean, fail: boolean) => {
    const r = report(fail);
    const stored = verdictOf(reportReasons(r));
    return reasonsOf({ live: live(permitted), row: { kind: "reported", report: r, stored } }).map(
      (x) => x.code,
    );
  };

  test("it clears the lineage reason, and the stored verdict is derived again without it", () => {
    expect(codes(false, false)).toEqual(["license_lineage_unconfirmed"]);
    expect(codes(true, false)).toEqual([]);
    const r = report(false);
    expect(storedVerdictWithPermission("action_required", r, true)).toBe("pass");
    expect(storedVerdictWithPermission("action_required", r, false)).toBe("action_required");
    // A stored column its report does not explain is kept: a permission never raises it.
    expect(storedVerdictWithPermission("fail", r, true)).toBe("fail");
  });

  test("it never clears another reason: a failed question stands, and so does the fail", () => {
    expect(codes(false, true)).toEqual(["question_failed", "license_lineage_unconfirmed"]);
    expect(codes(true, true)).toEqual(["question_failed"]);
    expect(storedVerdictWithPermission("fail", report(true), true)).toBe("fail");
  });
});

describe("the CLI's lines for mails that did not go out", () => {
  test("one line per state that is not sent, from copy; nothing when both went or nothing was due", () => {
    expect(mailNotSentLines({ administrators: "sent", depositor: "sent" })).toEqual([]);
    expect(mailNotSentLines({ administrators: "not_ready", depositor: "sent" })).toEqual([]);
    for (const depositor of ["fenced", "failed", "no_recipient"] as const) {
      const lines = mailNotSentLines({ administrators: "sent", depositor });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("tell the depositor by hand");
    }
    for (const administrators of ["undelivered", "review_unreadable"] as const) {
      const lines = mailNotSentLines({ administrators, depositor: "fenced" });
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("tell the administrators by hand");
    }
  });
});
