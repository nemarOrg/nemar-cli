/**
 * A publication request's review detail and a served snapshot, as the Worker's
 * `publicationReviewDetail` and the inputs serve would carry them, for the decision card's tests
 * (`test/decision-card.unit.test.ts`, `test/decision-card-display.unit.test.ts`). The evidence is
 * the real report parser's and the reasons the real table's.
 */

import type {
  CardDetail,
  GateFacts,
  ServedMetadata,
} from "../../backend/src/services/decision-card";
import { v3PublicationReport } from "../../backend/test/helpers/publication-review";
import type { ReasonView } from "../../shared/contract/publication-review-admin";
import { LICENSE_MATCHER_VERSION } from "../../shared/license-file";
import {
  REASONS,
  type ReasonCode,
  parsePublicationReviewReport,
} from "../../shared/publication-review";

export const ID = "nm000480";

/** A reason as the detail carries it, from the real table. */
export function reasonView(code: ReasonCode): ReasonView {
  const r = REASONS[code];
  return {
    code,
    class: r.class,
    cleared_by: r.clearedBy,
    detail: null,
    sentence: r.sentence,
    cure: r.cure,
  };
}

/** A clean, reviewed detail of a version-3 report, unless `over` says otherwise. */
export function detailOf(
  over: Partial<CardDetail> = {},
  evidence: Record<string, unknown> = {},
  review: Partial<NonNullable<CardDetail["review"]>> = {},
): CardDetail {
  const report = parsePublicationReviewReport(v3PublicationReport(evidence));
  return {
    environment: "production",
    enabled: true,
    dataset_id: ID,
    request_id: 7,
    request_status: "requested",
    anonymous: false,
    identifier_screen: {
      state: "clear",
      headline: "Identifier screen: clear",
      tone: "ok",
      lines: [],
    },
    screen_acknowledgment: null,
    block_reason: null,
    resubmission_note: null,
    previous_request_id: null,
    started_publishing: false,
    total_files: 4,
    applies: true,
    gate: "enforced",
    outcome: "pass",
    start_offered: false,
    screen_gate: "clear",
    reasons: [],
    license_permission: null,
    description: { headline: "Review passed", tone: "ok", lines: [], next: null, summary: null },
    review: {
      id: 11,
      head_sha: report.evidence.head,
      anonymous: false,
      state: "reported",
      detail: null,
      stored_verdict: "pass",
      model: report.model,
      version: report.evidence.version,
      created_at: "2026-11-27 12:00:00",
      decided_at: "2026-11-27 12:10:00",
      started_by: null,
      override: null,
      questions: { ...report.questions },
      fact_notes: [],
      findings: [],
      summary: null,
      evidence: report.evidence,
      reproducibility: {
        head_sha: report.evidence.head,
        scanner_id: null,
        reader_versions: null,
        resolver_version: null,
        models: null,
        prompt_version: null,
        input_digest: null,
        enrichment_source: null,
        license_matcher: LICENSE_MATCHER_VERSION,
      },
      ...review,
    },
    history: [],
    history_truncated: false,
    ...over,
  };
}

export const SNAPSHOT: ServedMetadata = {
  v: 1,
  enrichment: {
    title: "Resting EEG in sixty adults",
    description: "Eyes-open and eyes-closed resting EEG.",
    description_cut: false,
    license: "CC-BY-4.0",
    creators: ["Ada Lovelace"],
    keywords: ["EEG", "resting state"],
    funding: ["NIH (R01-1)"],
  },
  enrichment_source: "2026-11-20 10:00:00",
  dataset_description: {
    name: "Resting EEG",
    license: "CC-BY-4.0",
    authors: ["Ada Lovelace", "TBD"],
  },
  lineage: {
    outcome: "compatible",
    credited: false,
    resolved_at: "2026-11-27T12:00:00.000Z",
    declared_licenses: [],
  },
};

/** The approval's own gates as a clean request has them: the screened commit current, no run. */
export const GATE_CLEAR: GateFacts = { head: "current", approvalInFlight: false };
