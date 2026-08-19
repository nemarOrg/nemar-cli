import { describe, expect, test } from "bun:test";
import {
  estimateUsageCostUsd,
  mergeWithExisting,
  pruneUnsourcedDois,
} from "../backend/src/services/llm-enrich.js";
import { buildLlmUsageDataPoint } from "../backend/src/services/llm-metrics.js";

describe("pruneUnsourcedDois", () => {
  const readme = `Cited works:
[1] Some paper. https://doi.org/10.1021/real.doi.2024
[2] A textual citation with no DOI, Brain (2019).`;
  const bids = { Name: "Test", ReferencesAndLinks: ["https://doi.org/10.1038/bids.ref"] };

  test("drops LLM-vocabulary DOI entries absent from README and BIDS description", () => {
    const { result, pruned } = pruneUnsourcedDois(
      {
        related_identifiers: [
          // Hallucinated: not in source (the on004100 case)
          {
            identifier: "10.1093/brain/awac360",
            identifier_type: "DOI",
            relation_type: "IsDescribedBy",
          },
          // Hallucinated IsDerivedFrom: prunable despite the label — a real
          // one comes from BIDS SourceDatasets and matches the source text
          {
            identifier: "10.5555/fabricated.source",
            identifier_type: "DOI",
            relation_type: "IsDerivedFrom",
          },
          // Present in README
          {
            identifier: "10.1021/real.doi.2024",
            identifier_type: "DOI",
            relation_type: "References",
          },
          // Present in BIDS ReferencesAndLinks
          { identifier: "10.1038/bids.ref", identifier_type: "DOI", relation_type: "References" },
        ],
      },
      readme,
      bids,
    );
    expect(result.related_identifiers?.map((r) => r.identifier)).toEqual([
      "10.1021/real.doi.2024",
      "10.1038/bids.ref",
    ]);
    expect(pruned.map((p) => p.identifier)).toEqual([
      "10.1093/brain/awac360",
      "10.5555/fabricated.source",
    ]);
  });

  test("keeps legitimate IsDerivedFrom whose DOI is in BIDS SourceDatasets", () => {
    const bidsWithSource = {
      Name: "Test",
      SourceDatasets: [{ URL: "https://doi.org/10.18112/openneuro.ds000001.v1.0.0" }],
    };
    const { result, pruned } = pruneUnsourcedDois(
      {
        related_identifiers: [
          {
            identifier: "10.18112/openneuro.ds000001.v1.0.0",
            identifier_type: "DOI",
            relation_type: "IsDerivedFrom",
          },
        ],
      },
      "empty readme",
      bidsWithSource,
    );
    expect(result.related_identifiers).toHaveLength(1);
    expect(pruned).toHaveLength(0);
  });

  test("exempts URL entries and non-LLM relation types", () => {
    const { result, pruned } = pruneUnsourcedDois(
      {
        related_identifiers: [
          {
            identifier: "https://github.com/nemarDatasets/nm000001",
            identifier_type: "URL",
            relation_type: "IsDescribedBy",
          },
          // Importer/curator assertions are outside the LLM vocabulary and
          // must survive even when absent from the source text
          {
            identifier: "10.18112/openneuro.ds000001",
            identifier_type: "DOI",
            relation_type: "IsIdenticalTo",
          },
          { identifier: "10.9999/curator.set", identifier_type: "DOI", relation_type: "IsCitedBy" },
        ],
      },
      "empty readme",
      { Name: "Test" },
    );
    expect(result.related_identifiers).toHaveLength(3);
    expect(pruned).toHaveLength(0);
  });

  test("matches case-insensitively and handles empty lists", () => {
    const { result } = pruneUnsourcedDois(
      {
        related_identifiers: [
          {
            identifier: "10.1021/REAL.doi.2024",
            identifier_type: "DOI",
            relation_type: "References",
          },
        ],
      },
      readme,
      bids,
    );
    expect(result.related_identifiers).toHaveLength(1);
    expect(pruneUnsourcedDois({}, readme, bids)).toEqual({ result: {}, pruned: [] });
  });
});

describe("mergeWithExisting relation locks", () => {
  test("LLM cannot reclassify non-triad relation types (IsIdenticalTo, IsCitedBy)", () => {
    const existing = {
      version: "2.0" as const,
      pipeline_stage: "seeded" as const,
      related_identifiers: [
        {
          identifier: "10.18112/openneuro.ds000001",
          identifier_type: "DOI" as const,
          relation_type: "IsIdenticalTo",
        },
        {
          identifier: "10.9999/curator.set",
          identifier_type: "DOI" as const,
          relation_type: "IsCitedBy",
        },
      ],
    };
    const llmResult = {
      related_identifiers: [
        {
          identifier: "10.18112/openneuro.ds000001",
          identifier_type: "DOI" as const,
          relation_type: "References",
        },
        {
          identifier: "10.9999/curator.set",
          identifier_type: "DOI" as const,
          relation_type: "References",
        },
      ],
    };
    const merged = mergeWithExisting(existing, llmResult);
    expect(merged.related_identifiers?.map((r) => r.relation_type)).toEqual([
      "IsIdenticalTo",
      "IsCitedBy",
    ]);
  });

  test("LLM cannot move a triad entry to a non-triad type", () => {
    const existing = {
      version: "2.0" as const,
      pipeline_stage: "seeded" as const,
      related_identifiers: [
        {
          identifier: "10.1038/data.paper",
          identifier_type: "DOI" as const,
          relation_type: "IsDescribedBy",
        },
      ],
    };
    const llmResult = {
      related_identifiers: [
        {
          identifier: "10.1038/data.paper",
          identifier_type: "DOI" as const,
          relation_type: "IsVersionOf",
        },
      ],
    };
    const merged = mergeWithExisting(existing, llmResult);
    expect(merged.related_identifiers?.[0].relation_type).toBe("IsDescribedBy");
  });

  test("duplicate-identifier entries are all updated consistently", () => {
    const existing = {
      version: "2.0" as const,
      pipeline_stage: "seeded" as const,
      related_identifiers: [
        {
          identifier: "10.1038/dup.doi",
          identifier_type: "DOI" as const,
          relation_type: "References",
        },
        {
          identifier: "10.1038/dup.doi",
          identifier_type: "DOI" as const,
          relation_type: "IsSupplementTo",
        },
      ],
    };
    const llmResult = {
      related_identifiers: [
        {
          identifier: "10.1038/dup.doi",
          identifier_type: "DOI" as const,
          relation_type: "IsDescribedBy",
        },
      ],
    };
    const merged = mergeWithExisting(existing, llmResult);
    expect(merged.related_identifiers?.map((r) => r.relation_type)).toEqual([
      "IsDescribedBy",
      "IsDescribedBy",
    ]);
  });
});

describe("estimateUsageCostUsd", () => {
  test("applies sonnet-5 standard rates", () => {
    // 1M input at $3 + 100k output at $15/M = 3 + 1.5
    expect(
      estimateUsageCostUsd({ calls: 2, input_tokens: 1_000_000, output_tokens: 100_000 }),
    ).toBe(4.5);
  });
});

describe("buildLlmUsageDataPoint", () => {
  test("field ordering matches the read-side contract", () => {
    const point = buildLlmUsageDataPoint({
      datasetId: "nm000001",
      outcome: "ok",
      calls: 3,
      inputTokens: 12000,
      outputTokens: 2500,
      estCostUsd: 0.0735,
    });
    expect(point.indexes).toEqual(["nm000001"]);
    expect(point.blobs).toEqual(["nm000001", "enrichment", "ok"]);
    expect(point.doubles).toEqual([3, 12000, 2500, 0.0735]);
  });
});
