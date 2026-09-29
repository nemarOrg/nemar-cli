import { describe, expect, test } from "bun:test";
import {
  estimateUsageCostUsd,
  mergeWithExisting,
  pruneUnsourcedDois,
  seedFromBids,
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

  test("re-enrichment relabels nm000275's data paper and deposits (#1549)", () => {
    // nm000275's real BIDS description: its Scientific Data descriptor and
    // both figshare deposits sit in ReferencesAndLinks (seeded References),
    // and the raw deposit is also a SourceDataset (seeded IsDerivedFrom).
    const seeded = seedFromBids(
      {
        Name: "Multi-channel EEG recordings during a sustained-attention driving task",
        ReferencesAndLinks: [
          "https://doi.org/10.1038/s41597-019-0027-4",
          "https://doi.org/10.6084/m9.figshare.6427334.v5",
          "https://doi.org/10.6084/m9.figshare.7666055.v3",
          "https://doi.org/10.1109/TBCAS.2014.2316224",
        ],
        SourceDatasets: [{ URL: "https://doi.org/10.6084/m9.figshare.6427334.v5" }],
      },
      null,
    );
    const merged = mergeWithExisting(seeded, {
      related_identifiers: [
        // Upper case in the LLM echo must still match the seeded entry.
        {
          identifier: "10.1038/S41597-019-0027-4",
          identifier_type: "DOI",
          relation_type: "IsDescribedBy",
        },
        // References -> IsDerivedFrom: the pre-processed deposit of the same data.
        {
          identifier: "10.6084/m9.figshare.7666055.v3",
          identifier_type: "DOI",
          relation_type: "IsDerivedFrom",
        },
        // IsDerivedFrom (SourceDatasets) is locked against a downgrade.
        {
          identifier: "10.6084/m9.figshare.6427334.v5",
          identifier_type: "DOI",
          relation_type: "References",
        },
        // Lower case echo of a seeded upper-case DOI: reclassified, not appended.
        {
          identifier: "10.1109/tbcas.2014.2316224",
          identifier_type: "DOI",
          relation_type: "References",
        },
      ],
    });
    expect(merged.related_identifiers?.map((r) => [r.identifier, r.relation_type])).toEqual([
      ["10.6084/m9.figshare.6427334.v5", "IsDerivedFrom"],
      ["10.1038/s41597-019-0027-4", "IsDescribedBy"],
      ["10.6084/m9.figshare.7666055.v3", "IsDerivedFrom"],
      ["10.1109/TBCAS.2014.2316224", "References"],
    ]);
  });

  test("only References may move to IsDerivedFrom", () => {
    const merged = mergeWithExisting(
      {
        version: "2.0" as const,
        related_identifiers: [
          {
            identifier: "10.1038/s41597-019-0027-4",
            identifier_type: "DOI" as const,
            relation_type: "IsDescribedBy",
          },
        ],
      },
      {
        related_identifiers: [
          {
            identifier: "10.1038/s41597-019-0027-4",
            identifier_type: "DOI",
            relation_type: "IsDerivedFrom",
          },
        ],
      },
    );
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
  test("applies sonnet-5-5 standard rates", () => {
    // 1M input at $2 + 100k output at $10/M = 2 + 1
    expect(
      estimateUsageCostUsd({ calls: 2, input_tokens: 1_000_000, output_tokens: 100_000 }),
    ).toBe(3);
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
