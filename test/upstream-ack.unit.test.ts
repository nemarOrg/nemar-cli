/**
 * The batch-acknowledgment rule (epic #2182, card D3; ADR 0086, amendment 2026-11-25):
 * `shared/upstream-ack.ts`, pure. Reports are built by the production parser, the lineage by the
 * production shapes, and the exclusions are read from the real D2 measurement in the repository.
 *
 * Each eligibility branch has an eligible and an ineligible case. The route's own tests
 * (backend/test/upstream-ack-route.test.ts) drive the same rule through D1, GitHub and the
 * recorded registry responses.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nameClass as scriptNameClass } from "../scripts/dev/measure-queue-blockers";
import type { FindingKind } from "../shared/identifier-scan";
import { type ScreenReport, parseScreenReport } from "../shared/identifier-screen-report";
import { EXCLUDED_NAME_CLASSES, excludedImageCount, nameClass } from "../shared/image-name-class";
import type { LineageResult, LineageSource } from "../shared/license-lineage";
import { ACKNOWLEDGMENT_MAX_LENGTH } from "../shared/publication-limits";
import {
  ACK_ELIGIBLE_KINDS,
  type AckOutcome,
  NOT_ELIGIBLE_REASONS,
  type ScreenFacts,
  UPSTREAM_ACK_ANCHOR,
  UPSTREAM_ACK_COPY,
  UPSTREAM_ACK_MESSAGES,
  ackOutcomeLine,
  buildAckReason,
  exclusionsOf,
  lineageEligibility,
  readD2Exclusions,
  reasonEligibility,
  screenEligibility,
  treeEligibility,
} from "../shared/upstream-ack";
import { UPSTREAM_ACK_EXCLUSIONS } from "../shared/upstream-ack-excluded";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const D2_PATH = join(import.meta.dir, "..", ".context/plans/publication-queue/d2-blockers.json");

/** A report the production parser accepts. */
function reportFor(
  status: string,
  o: {
    kinds?: Partial<Record<FindingKind, number>>;
    formats?: Record<string, number>;
    incomplete?: boolean;
    edf?: number;
    extra?: Record<string, unknown>;
  } = {},
): ScreenReport {
  const edf = o.edf ?? (status === "not-screened" ? 0 : 4);
  return parseScreenReport({
    version: 1,
    scanner: "identifier-scan@abcdef1",
    head: HEAD,
    scan: {
      id: "nm000901",
      version: null,
      scanned_at: "2026-11-20T12:00:00.000Z",
      manifest_source: "clone",
      status,
      incomplete: o.incomplete ?? false,
      incomplete_reasons: o.incomplete ? ["json-unread"] : [],
      files: { total: 40, edf_bdf: edf, header_read: edf, header_read_failed: 0 },
      ...(o.kinds ? { findings_by_kind: o.kinds } : {}),
      unscreened_formats: o.formats ?? { ".set": 12, ".fdt": 12 },
      ...o.extra,
    },
  });
}

const MEASURED = { measured: new Set(["nm000901"]), excluded: new Set<string>() };

function facts(over: Partial<ScreenFacts> = {}): ScreenFacts {
  const report = over.report ?? reportFor("not-screened");
  return {
    datasetId: "nm000901",
    exempt: false,
    requestStatus: "requested",
    acknowledged: false,
    screenState: report?.scan?.status ?? null,
    report,
    exclusions: MEASURED,
    ...over,
  };
}

function source(over: Partial<LineageSource> = {}): LineageSource {
  return {
    id: "10.18112/openneuro.ds003645.v2.0.2",
    resolver: "openneuro",
    resource_type: "Dataset",
    license: "cc0",
    license_version: null,
    raw: "CC0",
    evidence_url: "https://openneuro.org/datasets/ds003645/versions/2.0.2",
    status: "resolved",
    origin: "source_datasets",
    outcome: "compatible",
    ...over,
  };
}

function lineage(outcome: LineageResult["outcome"], sources: LineageSource[]): LineageResult {
  return {
    outcome,
    inputs: { dataset_description: "read", nemar_metadata: "missing", readme: "missing" },
    target_license: "cc0",
    target_license_raw: "CC0",
    sources,
    resolver_version: "license-lineage/1",
    fetched_at: "2026-11-25T00:00:00.000Z",
  } as LineageResult;
}

describe("screenEligibility", () => {
  test("not-screened and clean-edf-only-others-unscreened with unread formats are eligible", () => {
    expect(screenEligibility(facts()).eligible).toBe(true);
    expect(
      screenEligibility(facts({ report: reportFor("clean-edf-only-others-unscreened") })).eligible,
    ).toBe(true);
  });

  test("the request must be awaiting an administrator", () => {
    for (const status of ["blocked", "approving", "published", "denied"]) {
      expect(screenEligibility(facts({ requestStatus: status }))).toEqual({
        eligible: false,
        reason: "not_requested",
      });
    }
  });

  test("a recorded acknowledgment is not recorded again", () => {
    expect(screenEligibility(facts({ acknowledged: true }))).toEqual({
      eligible: false,
      reason: "already_acknowledged",
    });
  });

  test("a sandbox dataset is exempt", () => {
    expect(screenEligibility(facts({ exempt: true }))).toEqual({
      eligible: false,
      reason: "exempt",
    });
  });

  test("no stored screen, or a report that does not match its state, is no_screen", () => {
    expect(screenEligibility(facts({ screenState: null, report: null })).eligible).toBe(false);
    expect(screenEligibility(facts({ screenState: null, report: null }))).toEqual({
      eligible: false,
      reason: "no_screen",
    });
    expect(screenEligibility(facts({ report: null, screenState: "not-screened" }))).toEqual({
      eligible: false,
      reason: "no_screen",
    });
    expect(
      screenEligibility(
        facts({
          screenState: "not-screened",
          report: reportFor("clean-edf-only-others-unscreened"),
        }),
      ),
    ).toEqual({ eligible: false, reason: "no_screen" });
  });

  test("a direct identifier is never eligible, whatever else holds", () => {
    const direct = reportFor("direct-identifiers", {
      kinds: { "edf-patient-name": 2, "image-or-document-file": 1 },
    });
    expect(screenEligibility(facts({ report: direct, screenState: "direct-identifiers" }))).toEqual(
      { eligible: false, reason: "screen_state" },
    );
  });

  test("unchecked, error, unreported, pending and the clear states are not eligible", () => {
    const unchecked = reportFor("unchecked", { incomplete: true });
    expect(screenEligibility(facts({ report: unchecked, screenState: "unchecked" }))).toEqual({
      eligible: false,
      reason: "screen_state",
    });
    for (const state of [
      "error",
      "unreported",
      "pending",
      "clean",
      "dates-only",
      "no-recordings",
    ]) {
      expect(screenEligibility(facts({ screenState: state })).eligible).toBe(false);
    }
  });

  test("review: image and tooling findings only are eligible; any other kind is not", () => {
    const images = reportFor("review", {
      kinds: { "image-or-document-file": 12, "tooling-debris": 2 },
    });
    expect(screenEligibility(facts({ report: images, screenState: "review" })).eligible).toBe(true);

    for (const kind of [
      "local-user-path",
      "json-identifier-key",
      "acq-time-dated",
      "path-subject-label",
      "edf-patient-code",
    ] as FindingKind[]) {
      const r = reportFor("review", { kinds: { "image-or-document-file": 3, [kind]: 1 } });
      expect(screenEligibility(facts({ report: r, screenState: "review" }))).toEqual({
        eligible: false,
        reason: "finding_kind",
      });
    }
  });

  test("a review holding local-user-path is not eligible (the mutation guard)", () => {
    // Widening ACK_ELIGIBLE_KINDS with local-user-path makes this fail.
    expect(ACK_ELIGIBLE_KINDS.has("local-user-path")).toBe(false);
    const r = reportFor("review", { kinds: { "local-user-path": 1 } });
    expect(screenEligibility(facts({ report: r, screenState: "review" }))).toEqual({
      eligible: false,
      reason: "finding_kind",
    });
  });

  test("an incomplete screen is not eligible; the same screen complete is", () => {
    const kinds = { "image-or-document-file": 2 };
    const incomplete = reportFor("review", { kinds, incomplete: true });
    expect(screenEligibility(facts({ report: incomplete, screenState: "review" }))).toEqual({
      eligible: false,
      reason: "screen_incomplete",
    });
    const complete = reportFor("review", { kinds });
    expect(screenEligibility(facts({ report: complete, screenState: "review" })).eligible).toBe(
      true,
    );
  });

  test("an excluded request is not eligible; one D2 did not measure is not either", () => {
    const excluded = { measured: new Set(["nm000901"]), excluded: new Set(["nm000901"]) };
    expect(screenEligibility(facts({ exclusions: excluded }))).toEqual({
      eligible: false,
      reason: "excluded",
    });
    const unmeasured = { measured: new Set(["nm000902"]), excluded: new Set<string>() };
    expect(screenEligibility(facts({ exclusions: unmeasured }))).toEqual({
      eligible: false,
      reason: "not_measured",
    });
  });
});

describe("lineageEligibility", () => {
  test("each compatible outcome with a source read from its own record is eligible", () => {
    for (const [outcome, license] of [
      ["compatible", "cc0"],
      ["compatible_attribution", "cc-by"],
      ["compatible_nc", "cc-by-nc"],
    ] as const) {
      const s = source({ outcome, license, resolver: "datacite" });
      const e = lineageEligibility(lineage(outcome, [s]));
      expect(e.eligible).toBe(true);
    }
    const physio = source({ resolver: "physionet", license: "odc-by" });
    expect(lineageEligibility(lineage("compatible_attribution", [physio])).eligible).toBe(true);
  });

  test("unresolved and needs_permission lineage are not eligible", () => {
    // Accepting `unresolved` in ACK_LINEAGE_OUTCOMES makes the first assertion fail.
    for (const outcome of [
      "unresolved",
      "needs_permission",
      "redistribution_prohibited",
      "share_alike_mismatch",
      "source_is_publication",
      "no_upstream_declared",
    ] as const) {
      const s = source({ outcome: "compatible" });
      expect(lineageEligibility(lineage(outcome, [s]))).toEqual({
        eligible: false,
        reason: "lineage_outcome",
      });
    }
  });

  test("a license read only from an index of publications is not eligible", () => {
    for (const resolver of ["crossref", "openalex"] as const) {
      expect(lineageEligibility(lineage("compatible", [source({ resolver })]))).toEqual({
        eligible: false,
        reason: "lineage_no_own_record",
      });
    }
    // A source of an own-record resolver that did not resolve does not count either.
    expect(
      lineageEligibility(
        lineage("compatible", [source({ resolver: "datacite", status: "fetch_failed" })]),
      ),
    ).toEqual({ eligible: false, reason: "lineage_no_own_record" });
  });

  test("the first own-record source is named and the rest are counted", () => {
    const e = lineageEligibility(
      lineage("compatible", [
        source({ id: "10.1/openalex-first", resolver: "openalex" }),
        source({ id: "10.5281/zenodo.1", resolver: "datacite" }),
        source({ id: "10.5281/zenodo.2", resolver: "datacite" }),
      ]),
    );
    if (!e.eligible) throw new Error("expected eligible");
    expect(e.source.id).toBe("10.5281/zenodo.1");
    expect(e.others).toBe(2);
  });
});

describe("buildAckReason", () => {
  test("names the upstream, its license, the resolver, the formats and the policy", () => {
    const r = reportFor("review", {
      kinds: { "image-or-document-file": 4 },
      formats: { ".set": 3, ".fdt": 3 },
    });
    const text = buildAckReason(r, source({ license: "cc-by", license_version: "4.0" }), 0);
    expect(text).toBe(
      `public-upstream: same recordings as 10.18112/openneuro.ds003645.v2.0.2 (cc-by 4.0, read from openneuro); not read by NEMAR: .fdt, .set; images/documents acknowledged; policy https://docs.nemar.org/platform/identifier-screening/#${UPSTREAM_ACK_ANCHOR}`,
    );
  });

  test("at most 500 characters with 10 sources and every format", () => {
    const formats: Record<string, number> = {};
    for (const f of [".set", ".fdt", ".mat", ".vhdr", ".eeg", ".vmrk", ".snirf", ".nwb", ".xdf"]) {
      formats[f] = 1;
    }
    for (let i = 0; i < 30; i++) formats[`.fmt${i}`] = 1;
    const r = reportFor("review", {
      kinds: { "image-or-document-file": 1, "tooling-debris": 1 },
      formats,
    });
    const sources = Array.from({ length: 10 }, (_, i) =>
      source({ id: `10.5281/zenodo.${String(i).padStart(9, "7")}`, resolver: "datacite" }),
    );
    const e = lineageEligibility(lineage("compatible", sources));
    if (!e.eligible) throw new Error("expected eligible");
    const text = buildAckReason(r, e.source, e.others);
    expect(text.length).toBeLessThanOrEqual(ACKNOWLEDGMENT_MAX_LENGTH);
    expect(text).toContain("(+9 more)");
    expect(text).toMatch(/\+\d+ more; images\/documents acknowledged; tooling files acknowledged;/);
    expect(text.endsWith(`#${UPSTREAM_ACK_ANCHOR}`)).toBe(true);
    // A source id of hundreds of characters still leaves the policy link whole.
    const long = buildAckReason(r, source({ id: `10.1/${"x".repeat(600)}` }), 9);
    expect(long.length).toBeLessThanOrEqual(ACKNOWLEDGMENT_MAX_LENGTH);
    expect(long.endsWith(`#${UPSTREAM_ACK_ANCHOR}`)).toBe(true);
  });
});

describe("readD2Exclusions on the real measurement", () => {
  const doc = JSON.parse(readFileSync(D2_PATH, "utf-8"));

  test("the requests holding photo/face or questionnaire files are excluded, by dataset id", () => {
    const { excluded, measured } = readD2Exclusions(doc);
    const expected: string[] = [];
    for (const d of doc.datasets as Array<{
      id: string;
      images: { byName: Record<string, number> } | null;
    }>) {
      const byName = d.images?.byName ?? {};
      if ((byName["photo-face"] ?? 0) > 0 || (byName.questionnaire ?? 0) > 0) expected.push(d.id);
    }
    expect(expected.length).toBeGreaterThan(0);
    expect([...excluded].sort()).toEqual(expected.sort());
    // D2 could not read two requests (empty repositories): they are not measured.
    for (const u of doc.unreadable as Array<{ id: string }>) expect(measured.has(u.id)).toBe(false);
    expect(measured.size).toBe(doc.datasets.length - doc.unreadable.length);
  });

  test("a document of another shape throws rather than excluding nothing", () => {
    expect(() => readD2Exclusions({})).toThrow();
    expect(() => readD2Exclusions({ datasets: [] })).toThrow();
    expect(() => readD2Exclusions({ datasets: [{ id: "nm000001", images: {} }] })).toThrow();
  });
});

describe("UPSTREAM_ACK_COPY", () => {
  test("every outcome and the policy section have a statement, a read, a remedy and the anchor", () => {
    const keys: Array<keyof typeof UPSTREAM_ACK_COPY> = [
      UPSTREAM_ACK_ANCHOR,
      "eligible",
      "acknowledged",
      "state_moved",
      "not_recorded:write_failed",
      ...NOT_ELIGIBLE_REASONS.map((r) => `not_eligible:${r}` as AckOutcome),
      ...UPSTREAM_ACK_MESSAGES,
    ];
    expect(Object.keys(UPSTREAM_ACK_COPY).sort()).toEqual([...keys].sort());
    for (const k of keys) {
      const c = UPSTREAM_ACK_COPY[k];
      for (const v of [c.statement, c.read, c.remedy]) expect(v.length).toBeGreaterThan(10);
      expect(c.anchor).toBe(
        `https://docs.nemar.org/platform/identifier-screening/#${UPSTREAM_ACK_ANCHOR}`,
      );
    }
  });
});

describe("defense in depth and robustness (review round 1)", () => {
  const images = { "image-or-document-file": 3 };
  const review = (extra: Record<string, unknown>) =>
    facts({ report: reportFor("review", { kinds: images, extra }), screenState: "review" });

  test("a flagged EDF/BDF file is never acknowledged; none flagged is", () => {
    expect(screenEligibility(review({ edf_bdf_files_flagged: 1 }))).toEqual({
      eligible: false,
      reason: "finding_kind",
    });
    expect(screenEligibility(review({ edf_bdf_files_flagged: 0 })).eligible).toBe(true);
  });

  test("an EDF/BDF file count of a kind outside the set is never acknowledged", () => {
    expect(screenEligibility(review({ edf_bdf_files_by_kind: { "edf-patient-code": 1 } }))).toEqual(
      { eligible: false, reason: "finding_kind" },
    );
    expect(
      screenEligibility(review({ edf_bdf_files_by_kind: { "image-or-document-file": 1 } }))
        .eligible,
    ).toBe(true);
  });

  test("a failed side read is incomplete; none failed is eligible", () => {
    expect(screenEligibility(review({ side_reads_failed: 2 }))).toEqual({
      eligible: false,
      reason: "screen_incomplete",
    });
    expect(screenEligibility(review({ side_reads_failed: 0 })).eligible).toBe(true);
  });

  test("a 600-character license is cut to 80 characters, and the reason still fits", () => {
    const long = "x".repeat(600);
    const text = buildAckReason(
      reportFor("not-screened"),
      source({ license: "cc-by", license_version: long }),
      9,
    );
    expect(text).toContain(`(cc-by ${"x".repeat(71)}..., read from openneuro)`);
    expect(text.length).toBeLessThanOrEqual(ACKNOWLEDGMENT_MAX_LENGTH);
    expect(reasonEligibility(text)).toEqual({ eligible: true, reason: text });
  });

  test("a reason over the limit is reason_too_long, never cut and recorded", () => {
    expect(reasonEligibility("r".repeat(ACKNOWLEDGMENT_MAX_LENGTH + 1))).toEqual({
      eligible: false,
      reason: "reason_too_long",
    });
    expect(reasonEligibility("r".repeat(ACKNOWLEDGMENT_MAX_LENGTH)).eligible).toBe(true);
  });

  test("a malformed name-class count throws", () => {
    for (const bad of ["3", -1, 1.5, null]) {
      expect(() =>
        readD2Exclusions({ datasets: [{ id: "nm000001", images: { byName: { other: bad } } }] }),
      ).toThrow("count");
    }
    expect(
      readD2Exclusions({
        datasets: [{ id: "nm000001", images: { byName: { "photo-face": 2 } } }],
      }).excluded.has("nm000001"),
    ).toBe(true);
  });

  test("ackOutcomeLine prints the bare outcome for one it has no words for", () => {
    expect(
      ackOutcomeLine({
        dataset_id: "nm000001",
        outcome: "not_eligible:from_the_future" as AckOutcome,
      }),
    ).toBe("nm000001  not_eligible:from_the_future");
    expect(ackOutcomeLine({ dataset_id: "nm000001", outcome: "eligible" })).toContain(
      UPSTREAM_ACK_COPY.eligible.statement,
    );
  });
});

describe("the generated exclusions module", () => {
  test("agrees with d2-blockers.json, date and source included", () => {
    const doc = JSON.parse(readFileSync(D2_PATH, "utf-8"));
    const { measured, excluded } = readD2Exclusions(doc);
    expect([...UPSTREAM_ACK_EXCLUSIONS.excluded]).toEqual([...excluded].sort());
    expect([...UPSTREAM_ACK_EXCLUSIONS.measured]).toEqual([...measured].sort());
    expect(UPSTREAM_ACK_EXCLUSIONS.generatedOn).toBe(doc.generatedAt);
    expect(UPSTREAM_ACK_EXCLUSIONS.source).toBe(
      ".context/plans/publication-queue/d2-blockers.json",
    );
    const checked = exclusionsOf(UPSTREAM_ACK_EXCLUSIONS);
    expect(checked.excluded.size).toBe(excluded.size);
  });

  test("exclusionsOf fails closed", () => {
    expect(() => exclusionsOf({ excluded: [], measured: [] })).toThrow();
    expect(() => exclusionsOf({ excluded: ["nm000002"], measured: ["nm000001"] })).toThrow();
    expect(() => exclusionsOf({ excluded: [], measured: ["bad"] })).toThrow();
  });
});

describe("treeEligibility and the shared name classifier", () => {
  test("a photo, face or questionnaire image or document in the tree excludes; null is unreadable", () => {
    expect(treeEligibility(null)).toEqual({ eligible: false, reason: "tree_unreadable" });
    expect(treeEligibility(["sub-01/eeg/sub-01_eeg.set", "code/plot.png"])).toEqual({
      eligible: true,
    });
    for (const p of [
      "sourcedata/photo_1.jpg",
      "stimuli/faces/face_neutral.png",
      "docs/sleepQuestionnaire.pdf",
      "stimuli/photos_1.tif",
    ]) {
      expect(treeEligibility(["code/plot.png", p]), p).toEqual({
        eligible: false,
        reason: "excluded",
      });
    }
    // A BIDS photograph, which the screen itself accepts, keeps the request out of a batch.
    for (const p of [
      "sub-01/ses-01/eeg/sub-01_ses-01_photo.jpg",
      "sub-02/eeg/sub-02_acq-face_photo.PNG",
      "sub-03/ieeg/sub-03_photo.tif",
    ]) {
      expect(treeEligibility(["code/plot.png", p]), p).toEqual({
        eligible: false,
        reason: "photo_file",
      });
    }
    expect(treeEligibility(["sub-01/eeg/sub-01_photo.json"])).toEqual({ eligible: true });
    // Whole words only, and only image or document files.
    expect(excludedImageCount(["code/interface.png", "phenotype/questionnaire.tsv"])).toBe(0);
  });

  test("the D2 script uses the same classifier", () => {
    expect(scriptNameClass).toBe(nameClass);
    expect(nameClass("sourcedata/consent_form.pdf")).toBe("consent");
    expect(EXCLUDED_NAME_CLASSES).toEqual(["photo-face", "questionnaire"]);
  });
});
