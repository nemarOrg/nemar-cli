import { describe, expect, test } from "bun:test";
import { estimateUsageCostUsd, pruneUnsourcedDois } from "../backend/src/services/llm-enrich.js";
import { buildLlmUsageDataPoint } from "../backend/src/services/llm-metrics.js";

describe("pruneUnsourcedDois", () => {
  const readme = `Cited works:
[1] Some paper. https://doi.org/10.1021/real.doi.2024
[2] A textual citation with no DOI, Brain (2019).`;
  const bids = { Name: "Test", ReferencesAndLinks: ["https://doi.org/10.1038/bids.ref"] };

  test("drops DOI entries absent from README and BIDS description", () => {
    const result = pruneUnsourcedDois(
      {
        related_identifiers: [
          // Hallucinated: not in source (the on004100 case)
          {
            identifier: "10.1093/brain/awac360",
            identifier_type: "DOI",
            relation_type: "IsDescribedBy",
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
  });

  test("exempts IsDerivedFrom and URL entries", () => {
    const result = pruneUnsourcedDois(
      {
        related_identifiers: [
          {
            identifier: "10.18112/openneuro.ds000001.v1.0.0",
            identifier_type: "DOI",
            relation_type: "IsDerivedFrom",
          },
          {
            identifier: "https://github.com/nemarDatasets/nm000001",
            identifier_type: "URL",
            relation_type: "IsDescribedBy",
          },
        ],
      },
      "empty readme",
      { Name: "Test" },
    );
    expect(result.related_identifiers).toHaveLength(2);
  });

  test("matches case-insensitively and handles empty lists", () => {
    const result = pruneUnsourcedDois(
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
    expect(pruneUnsourcedDois({}, readme, bids)).toEqual({});
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
