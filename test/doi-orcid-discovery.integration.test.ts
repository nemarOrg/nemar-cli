import { describe, expect, test } from "bun:test";
import {
  discoverOrcidsFromReferencedDois,
  queryDataCiteDoi,
} from "../backend/src/services/doi-orcid-discovery.js";

// These tests hit the real DataCite / Crossref APIs (live outbound network),
// so they live in a `*.integration.test.ts` file. The CI classifier keeps such
// files OUT of the fast, required `unit-pure` tier (which is meant to be
// deterministic and offline) and runs them in the integration tier instead,
// with `--retry=2 --timeout 30000`. That matters because `deploy-backend.yml`'s
// test-gate runs the pure tier as a hard gate in front of the PRODUCTION
// deploy: a transient external-API hiccup here must retry, not turn a prod
// deploy red. Split out of `doi-orcid-discovery.test.ts`, which keeps the
// deterministic offline extraction/matching tests.

// ---------------------------------------------------------------------------
// queryDataCiteDoi (integration - hits real API)
// ---------------------------------------------------------------------------

describe("queryDataCiteDoi", () => {
  test("resolves MNE-BIDS JOSS paper (16 authors, all with ORCIDs)", async () => {
    const result = await queryDataCiteDoi("10.21105/joss.01896");
    expect(result).not.toBeNull();
    expect(result!.creators.length).toBe(16);

    const withOrcid = result!.creators.filter((c) =>
      c.nameIdentifiers?.some((ni) => ni.nameIdentifierScheme === "ORCID"),
    );
    expect(withOrcid.length).toBe(16);

    // Spot-check a known author
    const stefan = result!.creators.find((c) => c.familyName === "Appelhoff");
    expect(stefan).toBeDefined();
    expect(stefan!.nameIdentifiers[0].nameIdentifier).toContain("0000-0001-8002-0877");
  });

  test("resolves a known DOI with ORCIDs (BIDS paper)", async () => {
    const result = await queryDataCiteDoi("10.1038/s41597-019-0104-8");
    expect(result).not.toBeNull();
    expect(result!.doi).toBe("10.1038/s41597-019-0104-8");
    expect(result!.creators.length).toBeGreaterThan(0);

    // The BIDS paper has authors with ORCIDs
    const withOrcid = result!.creators.filter((c) =>
      c.nameIdentifiers?.some((ni) => ni.nameIdentifierScheme === "ORCID"),
    );
    expect(withOrcid.length).toBeGreaterThan(0);
  });

  test("returns null for non-existent DOI", async () => {
    const result = await queryDataCiteDoi("10.9999/does-not-exist-xyz");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// discoverOrcidsFromReferencedDois (integration)
// ---------------------------------------------------------------------------

describe("discoverOrcidsFromReferencedDois", () => {
  test("discovers ORCIDs from MNE-BIDS JOSS paper", async () => {
    const result = await discoverOrcidsFromReferencedDois({
      Authors: [
        "Appelhoff, Stefan",
        "Jas, Mainak",
        "Gramfort, Alexandre",
        "Unknown Author",
      ],
      ReferencesAndLinks: ["10.21105/joss.01896"],
    });

    expect(result.totalDoisQueried).toBe(1);
    expect(result.unresolvedDois).toHaveLength(0);
    expect(Object.keys(result.discoveries).length).toBe(3);
    expect(result.discoveries["Appelhoff, Stefan"].orcid).toBe("0000-0001-8002-0877");
    expect(result.discoveries["Appelhoff, Stefan"].confidence).toBe("exact");
    expect(result.discoveries["Jas, Mainak"].orcid).toBe("0000-0002-3199-9027");
    expect(result.discoveries["Gramfort, Alexandre"].orcid).toBe("0000-0001-9791-4404");
    expect(result.discoveries["Unknown Author"]).toBeUndefined();
  });

  test("tracks unresolved DOIs", async () => {
    const result = await discoverOrcidsFromReferencedDois({
      Authors: ["Doe, John"],
      ReferencesAndLinks: ["10.9999/does-not-exist-xyz"],
    });
    expect(result.totalDoisQueried).toBe(1);
    expect(result.unresolvedDois).toContain("10.9999/does-not-exist-xyz");
    expect(Object.keys(result.discoveries)).toHaveLength(0);
  });

  test("discovers affiliations from DataCite creators", async () => {
    const result = await discoverOrcidsFromReferencedDois({
      Authors: ["Appelhoff, Stefan"],
      ReferencesAndLinks: ["10.21105/joss.01896"],
    });
    expect(result.discoveries["Appelhoff, Stefan"]).toBeDefined();
    // ORCID format should be valid (XXXX-XXXX-XXXX-XXXX)
    expect(result.discoveries["Appelhoff, Stefan"].orcid).toMatch(
      /^\d{4}-\d{4}-\d{4}-[\dX]{4}$/,
    );
  });

  test("skips authors with existing ORCIDs", async () => {
    const result = await discoverOrcidsFromReferencedDois(
      {
        Authors: ["Appelhoff, Stefan"],
        ReferencesAndLinks: ["https://doi.org/10.1038/s41597-019-0104-8"],
      },
      { "Appelhoff, Stefan": { orcid: "0000-0000-0000-0000" } },
    );

    // Should not overwrite existing ORCID
    expect(result.discoveries["Appelhoff, Stefan"]).toBeUndefined();
  });

  test("returns empty for no DOIs", async () => {
    const result = await discoverOrcidsFromReferencedDois({
      Authors: ["Doe, John"],
    });
    expect(result.totalDoisQueried).toBe(0);
    expect(Object.keys(result.discoveries)).toHaveLength(0);
  });

  test("returns empty for no authors", async () => {
    const result = await discoverOrcidsFromReferencedDois({
      ReferencesAndLinks: ["https://doi.org/10.1038/s41597-019-0104-8"],
    });
    expect(Object.keys(result.discoveries)).toHaveLength(0);
  });

  test("discovers ORCIDs from HowToAcknowledge DOI (nm000132 scenario)", async () => {
    // nm000132's dataset_description.json has DOI only in HowToAcknowledge,
    // not in ReferencesAndLinks or SourceDatasets
    const result = await discoverOrcidsFromReferencedDois({
      Authors: [
        "Emily S. Kappenman",
        "Jaclyn L. Farrens",
        "Wendy Zhang",
        "Andrew X. Stewart",
        "Steven J. Luck.",
      ],
      HowToAcknowledge:
        "Kappenman, E., Farrens, J., Zhang, W., Stewart, A. X., & Luck, S. J. (2020, May 22). ERP CORE: An Open Resource for Human Event-Related Potential Research. https://doi.org/10.31234/osf.io/4azqm",
      ReferencesAndLinks: ["https://erpinfo.org/erp-core"],
    });

    // The preprint DOI should be found in HowToAcknowledge
    expect(result.totalDoisQueried).toBeGreaterThanOrEqual(1);
    // DataCite+Crossref merged results: ORCIDs for Zhang and Stewart
    expect(Object.keys(result.discoveries).length).toBeGreaterThanOrEqual(2);
    expect(result.discoveries["Wendy Zhang"]?.orcid).toBe("0000-0002-3586-2626");
    expect(result.discoveries["Andrew X. Stewart"]?.orcid).toBe("0000-0002-9402-4411");
  });

  test("accepts additionalDois for second-pass discovery", async () => {
    const result = await discoverOrcidsFromReferencedDois(
      {
        Authors: ["Appelhoff, Stefan", "Jas, Mainak"],
        // No DOIs in BIDS fields
      },
      undefined,
      // DOIs discovered by LLM from README
      [{ doi: "10.21105/joss.01896", source: "RelatedIdentifiers" as const }],
    );

    expect(result.totalDoisQueried).toBe(1);
    expect(Object.keys(result.discoveries).length).toBeGreaterThanOrEqual(1);
    expect(result.discoveries["Appelhoff, Stefan"]?.orcid).toBe("0000-0001-8002-0877");
  });
});
