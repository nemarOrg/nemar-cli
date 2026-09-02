import { describe, expect, test } from "bun:test";
import {
  type DataCiteCreator,
  extractDoisFromBids,
  extractDoisFromRelatedIdentifiers,
  matchCreatorsToAuthors,
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

  test("extracts DOIs from HowToAcknowledge", () => {
    const result = extractDoisFromBids({
      HowToAcknowledge:
        "Please cite: Kappenman et al. (2020). ERP CORE. https://doi.org/10.31234/osf.io/4azqm",
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      doi: "10.31234/osf.io/4azqm",
      source: "HowToAcknowledge",
    });
  });

  test("extracts multiple DOIs from HowToAcknowledge", () => {
    const result = extractDoisFromBids({
      HowToAcknowledge: "Cite 10.1234/abc and also https://doi.org/10.5678/def for this dataset.",
    });
    expect(result).toHaveLength(2);
    expect(result[0].doi).toBe("10.1234/abc");
    expect(result[1].doi).toBe("10.5678/def");
  });

  test("strips trailing punctuation from HowToAcknowledge DOIs", () => {
    const result = extractDoisFromBids({
      HowToAcknowledge:
        "See https://doi.org/10.31234/osf.io/4azqm. Also cite 10.1234/foo; and 10.5678/bar:",
    });
    expect(result).toHaveLength(3);
    expect(result[0].doi).toBe("10.31234/osf.io/4azqm");
    expect(result[1].doi).toBe("10.1234/foo");
    expect(result[2].doi).toBe("10.5678/bar");
  });

  test("deduplicates DOIs between HowToAcknowledge and ReferencesAndLinks", () => {
    const result = extractDoisFromBids({
      HowToAcknowledge: "Cite https://doi.org/10.31234/osf.io/4azqm",
      ReferencesAndLinks: ["https://doi.org/10.31234/osf.io/4azqm"],
    });
    expect(result).toHaveLength(1);
  });

  test("ignores non-string HowToAcknowledge", () => {
    const result = extractDoisFromBids({ HowToAcknowledge: 12345 });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractDoisFromRelatedIdentifiers
// ---------------------------------------------------------------------------

describe("extractDoisFromRelatedIdentifiers", () => {
  test("extracts DOIs from related identifiers", () => {
    const result = extractDoisFromRelatedIdentifiers(
      [
        { identifier: "10.1234/foo", identifier_type: "DOI", relation_type: "References" },
        {
          identifier: "https://example.com",
          identifier_type: "URL",
          relation_type: "IsDescribedBy",
        },
        { identifier: "10.5678/bar", identifier_type: "DOI", relation_type: "IsSupplementedBy" },
      ],
      new Set(),
    );
    expect(result).toHaveLength(2);
    expect(result[0].doi).toBe("10.1234/foo");
    expect(result[0].source).toBe("RelatedIdentifiers");
    expect(result[1].doi).toBe("10.5678/bar");
  });

  test("skips DOIs already in the seen set", () => {
    const alreadySeen = new Set(["10.1234/foo"]);
    const result = extractDoisFromRelatedIdentifiers(
      [
        { identifier: "10.1234/foo", identifier_type: "DOI", relation_type: "References" },
        { identifier: "10.5678/bar", identifier_type: "DOI", relation_type: "References" },
      ],
      alreadySeen,
    );
    expect(result).toHaveLength(1);
    expect(result[0].doi).toBe("10.5678/bar");
  });

  test("skips non-DOI identifiers", () => {
    const result = extractDoisFromRelatedIdentifiers(
      [
        {
          identifier: "https://github.com/test",
          identifier_type: "URL",
          relation_type: "IsDescribedBy",
        },
      ],
      new Set(),
    );
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// matchCreatorsToAuthors
// ---------------------------------------------------------------------------

describe("matchCreatorsToAuthors", () => {
  const makeCreator = (familyName: string, givenName: string, orcid?: string): DataCiteCreator => ({
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
    const creators = [makeCreator("Smith", "John"), makeCreator("Smith", "Jane")];
    const matches = matchCreatorsToAuthors(creators, ["Smith, John"]);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchedCreator.givenName).toBe("John");
  });

  test("each creator matched at most once", () => {
    const creators = [makeCreator("Smith", "John")];
    const matches = matchCreatorsToAuthors(creators, ["Smith, John", "Smith, J."]);
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
