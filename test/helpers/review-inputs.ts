/**
 * Inputs bodies for the publication review's job (ADR 0139, decision 6), in the shape the Worker's
 * `POST /webhooks/publication-review-inputs` answers with. They are data the job reads, not a
 * stand-in for any rule: the real pre-send module and the real prompt builder run over them.
 */

import { RESOLVER_VERSION } from "../../shared/license-lineage";
import type { ReviewInputsBody } from "../../shared/publication-review";

/** A body with nothing to show: no enrichment, no upstream source, no note, no screen counts. */
export function emptyInputs(over: Partial<ReviewInputsBody> = {}): ReviewInputsBody {
  return {
    v: 1,
    enrichment: null,
    lineage: {
      outcome: "no_upstream_declared",
      target_license: "cc0",
      sources: [],
      resolver_version: RESOLVER_VERSION,
      resolved_at: "2026-11-27T12:00:00.000Z",
    },
    resubmission_note: null,
    previous_denial: null,
    coverage: { source: "none", formats: {} },
    ...over,
  };
}

/** A body with every section present and clean. */
export function fullInputs(over: Partial<ReviewInputsBody> = {}): ReviewInputsBody {
  return emptyInputs({
    enrichment: {
      fields: {
        title: "Resting-state EEG in healthy adults",
        description: "Sixty-four channel EEG recorded at rest with eyes open and closed.",
        keywords: [{ term: "EEG" }, { term: "resting state" }],
        license: "CC-BY-4.0",
        related_identifiers: [
          {
            identifier: "10.18112/openneuro.ds000001.v1.0.0",
            identifier_type: "DOI",
            relation_type: "IsDerivedFrom",
          },
        ],
        funding_references: [{ funder_name: "A research council", award_number: "R01-0000" }],
        creators: [{ name: "Lab of Example Studies" }],
      },
      source: "2026-11-20 10:00:00",
    },
    lineage: {
      outcome: "compatible_attribution",
      target_license: "cc-by",
      sources: [
        {
          id: "10.18112/openneuro.ds000001.v1.0.0",
          resolver: "datacite",
          resource_type: "Dataset",
          title: "A source dataset of resting EEG",
          creators: ["Doe, J.", "Roe, R."],
          publisher: "OpenNeuro",
          license: "cc-by",
          license_version: "4.0",
          evidence_url: "https://api.datacite.org/dois/10.18112/openneuro.ds000001.v1.0.0",
          status: "resolved",
          origin: "source_datasets",
          outcome: "compatible_attribution",
        },
      ],
      resolver_version: RESOLVER_VERSION,
      resolved_at: "2026-11-27T12:00:00.000Z",
    },
    resubmission_note: "We expanded the README and added the ethics approval number.",
    previous_denial: { automated: true, reasons: ["question_failed"] },
    coverage: {
      source: "screen_v2",
      formats: { edf: { files: 60, read: 58, partial: 1, failed: 1 } },
    },
    ...over,
  });
}
