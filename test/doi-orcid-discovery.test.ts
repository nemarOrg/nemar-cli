import { describe, expect, test } from "bun:test";
import {
  type DataCiteCreator,
  extractDoisFromBids,
  matchCreatorsToAuthors,
  queryDataCiteDoi,
  discoverOrcidsFromReferencedDois,
} from "../backend/src/services/doi-orcid-discovery.js";

// ---------------------------------------------------------------------------
// extractDoisFromBids
// ---------------------------------------------------------------------------

describe("extractDoisFromBids", () => {
  test("extracts DOIs from ReferencesAndLinks", () => {
    const result = extractDoisFromBids({
      ReferencesAndLinks: [
        "https://doi.org/10.1038/s41597-019-0104-8",
        "10.21105/joss.01896",
        "https://example.com/not-a-doi",
      ],
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      doi: "10.1038/s41597-019-0104-8",
      source: "ReferencesAndLinks",
    });
    expect(result[1]).toEqual({
      doi: "10.21105/joss.01896",
      source: "ReferencesAndLinks",
    });
  });

  test("extracts DOIs from SourceDatasets", () => {
    const result = extractDoisFromBids({
      SourceDatasets: [
        { DOI: "doi:10.1234/foo" },
        { URL: "https://doi.org/10.5678/bar" },
        { URL: "https://example.com/not-doi" },
      ],
    });
    expect(result).toHaveLength(2);
    expect(result[0].doi).toBe("10.1234/foo");
    expect(result[0].source).toBe("SourceDatasets");
    expect(result[1].doi).toBe("10.5678/bar");
  });

  test("deduplicates DOIs across sources", () => {
    const result = extractDoisFromBids({
      SourceDatasets: [{ DOI: "10.1234/foo" }],
      ReferencesAndLinks: ["https://doi.org/10.1234/foo"],
    });
    expect(result).toHaveLength(1);
  });

  test("returns empty for no DOIs", () => {
    expect(extractDoisFromBids({})).toHaveLength(0);
    expect(extractDoisFromBids({ ReferencesAndLinks: ["not a doi"] })).toHaveLength(0);
  });

  test("handles malformed SourceDatasets entries", () => {
    const result = extractDoisFromBids({
      SourceDatasets: [null, "string", { DOI: 123 }, { URL: null }],
    });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// matchCreatorsToAuthors
// ---------------------------------------------------------------------------

describe("matchCreatorsToAuthors", () => {
  const makeCreator = (
    familyName: string,
    givenName: string,
    orcid?: string,
  ): DataCiteCreator => ({
    name: `${familyName}, ${givenName}`,
    familyName,
    givenName,
    nameIdentifiers: orcid
      ? [{ nameIdentifier: `https://orcid.org/${orcid}`, nameIdentifierScheme: "ORCID" }]
      : [],
    affiliation: [],
  });

  test("exact match: same Last, First format", () => {
    const creators = [makeCreator("Appelhoff", "Stefan")];
    const matches = matchCreatorsToAuthors(creators, ["Appelhoff, Stefan"]);
    expect(matches).toHaveLength(1);
    expect(matches[0].bidsAuthor).toBe("Appelhoff, Stefan");
    expect(matches[0].confidence).toBe("exact");
  });

  test("exact match: case insensitive", () => {
    const creators = [makeCreator("APPELHOFF", "STEFAN")];
    const matches = matchCreatorsToAuthors(creators, ["appelhoff, stefan"]);
    expect(matches).toHaveLength(1);
    expect(matches[0].confidence).toBe("exact");
  });

  test("high confidence: family name + first initial", () => {
    const creators = [makeCreator("Appelhoff", "Stefan")];
    const matches = matchCreatorsToAuthors(creators, ["Appelhoff, S."]);
    expect(matches).toHaveLength(1);
    expect(matches[0].confidence).toBe("high");
  });

  test("medium confidence: family name only", () => {
    const creators = [makeCreator("Appelhoff", "Stefan")];
    // BIDS has "Appelhoff, M." (different initial from "Stefan")
    const matches = matchCreatorsToAuthors(creators, ["Appelhoff, Michael"]);
    expect(matches).toHaveLength(1);
    expect(matches[0].confidence).toBe("medium");
  });

  test("no match for different family names", () => {
    const creators = [makeCreator("Smith", "John")];
    const matches = matchCreatorsToAuthors(creators, ["Doe, Jane"]);
    expect(matches).toHaveLength(0);
  });

  test("skips organizational creators (no familyName)", () => {
    const orgCreator: DataCiteCreator = {
      name: "NEMAR Consortium",
      nameIdentifiers: [],
      affiliation: [],
    };
    const matches = matchCreatorsToAuthors([orgCreator], ["NEMAR Consortium"]);
    // Should match on exact name even without familyName
    expect(matches).toHaveLength(1);
    expect(matches[0].confidence).toBe("exact");
  });

  test("each author matched at most once", () => {
    const creators = [
      makeCreator("Smith", "John"),
      makeCreator("Smith", "Jane"),
    ];
    const matches = matchCreatorsToAuthors(creators, ["Smith, John"]);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchedCreator.givenName).toBe("John");
  });

  test("each creator matched at most once", () => {
    const creators = [makeCreator("Smith", "John")];
    const matches = matchCreatorsToAuthors(creators, [
      "Smith, John",
      "Smith, J.",
    ]);
    expect(matches).toHaveLength(1);
    // "Smith, John" should win (exact match in pass 1)
    expect(matches[0].bidsAuthor).toBe("Smith, John");
  });

  test("handles accented characters", () => {
    const creators = [makeCreator("Muller", "Hans")];
    const matches = matchCreatorsToAuthors(creators, ["Müller, Hans"]);
    expect(matches).toHaveLength(1);
    // After NFD normalization + accent stripping, should match
    expect(matches[0].confidence).toBe("exact");
  });

  test("cross-format: creator 'First Last' matches BIDS 'Last, First'", () => {
    const creator: DataCiteCreator = {
      name: "Stefan Appelhoff",
      familyName: "Appelhoff",
      givenName: "Stefan",
      nameIdentifiers: [],
      affiliation: [],
    };
    const matches = matchCreatorsToAuthors([creator], ["Appelhoff, Stefan"]);
    expect(matches).toHaveLength(1);
    expect(matches[0].confidence).toBe("exact");
  });

  test("cross-format: BIDS 'First Last' matches creator 'Last, First'", () => {
    const creators = [makeCreator("Appelhoff", "Stefan")];
    // BIDS author in "First Last" format (non-standard but possible)
    const matches = matchCreatorsToAuthors(creators, ["Stefan Appelhoff"]);
    expect(matches).toHaveLength(1);
    expect(matches[0].confidence).toBe("exact");
  });
});

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
});
