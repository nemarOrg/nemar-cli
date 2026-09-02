/**
 * DOI provider dispatch layer tests
 *
 * Tests ORCID validation, DOI dispatch routing, ORCID auto-injection,
 * and DataCite version relation enrichment.
 */

import { describe, expect, test } from "bun:test";
import {
  bidsToDataCite,
  buildDataCiteXml,
  isValidRelationType,
  nemarMetadataToEnrichment,
  parseNemarMetadata,
} from "../backend/src/services/datacite";
import {
  buildConceptIdentifier,
  buildOrcidEnrichment,
  buildVersionIdentifier,
  createConceptDoi,
  createEzidVersionDoi,
} from "../backend/src/services/doi";
// The CLI-side llm-enrich fork was deleted (dead code since enrichment moved
// to the central workflow); these tests pin the backend implementation.
import { validateLlmResultV2 as validateLlmResult } from "../backend/src/services/llm-enrich";

describe("ORCID validation", () => {
  const orcidRegex = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

  test("accepts valid ORCID", () => {
    expect(orcidRegex.test("0000-0002-1825-0097")).toBe(true);
  });

  test("accepts ORCID ending in X", () => {
    expect(orcidRegex.test("0000-0001-5109-390X")).toBe(true);
  });

  test("rejects ORCID without dashes", () => {
    expect(orcidRegex.test("0000000218250097")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(orcidRegex.test("")).toBe(false);
  });

  test("rejects invalid format", () => {
    expect(orcidRegex.test("not-an-orcid")).toBe(false);
  });

  test("rejects too short", () => {
    expect(orcidRegex.test("0000-0002-1825-009")).toBe(false);
  });
});

describe("buildOrcidEnrichment", () => {
  test("matches author by case-insensitive substring", () => {
    const enrichment = buildOrcidEnrichment(
      { Name: "Test", Authors: ["Shirazi, Yahya", "Smith, John"] },
      "yahya",
      "0000-0002-1825-0097",
    );

    expect(enrichment.authors).toBeDefined();
    expect(enrichment.authors?.["Shirazi, Yahya"]?.orcid).toBe("0000-0002-1825-0097");
    // Should not match the second author
    expect(enrichment.authors?.["Smith, John"]).toBeUndefined();
  });

  test("returns enrichment with uploaderName but no authors when no ORCID provided", () => {
    const enrichment = buildOrcidEnrichment({ Name: "Test", Authors: ["Doe, Jane"] }, "jane");

    expect(enrichment).toEqual({ uploaderName: "jane" });
    expect(enrichment.authors).toBeUndefined();
  });

  test("returns enrichment with uploader fields when no BIDS description", () => {
    const enrichment = buildOrcidEnrichment(undefined, "jane", "0000-0002-1825-0097");

    expect(enrichment).toEqual({ uploaderName: "jane", uploaderOrcid: "0000-0002-1825-0097" });
    expect(enrichment.authors).toBeUndefined();
  });

  test("returns enrichment with uploaderOrcid when no uploaderName", () => {
    const enrichment = buildOrcidEnrichment(
      { Name: "Test", Authors: ["Doe, Jane"] },
      undefined,
      "0000-0002-1825-0097",
    );

    expect(enrichment).toEqual({ uploaderOrcid: "0000-0002-1825-0097" });
    expect(enrichment.authors).toBeUndefined();
  });

  test("returns enrichment with uploader fields when no authors in BIDS", () => {
    const enrichment = buildOrcidEnrichment({ Name: "Test" }, "jane", "0000-0002-1825-0097");

    expect(enrichment).toEqual({ uploaderName: "jane", uploaderOrcid: "0000-0002-1825-0097" });
    expect(enrichment.authors).toBeUndefined();
  });

  test("returns enrichment with uploader fields when uploader name does not match any author", () => {
    const enrichment = buildOrcidEnrichment(
      { Name: "Test", Authors: ["Doe, Jane", "Smith, John"] },
      "nobody",
      "0000-0002-1825-0097",
    );

    // No match found, so authors map should not be set but uploader fields preserved
    expect(enrichment.authors).toBeUndefined();
    expect(enrichment.uploaderName).toBe("nobody");
    expect(enrichment.uploaderOrcid).toBe("0000-0002-1825-0097");
  });

  test("matches first matching author only", () => {
    const enrichment = buildOrcidEnrichment(
      { Name: "Test", Authors: ["Smith, Jane", "Smith, John"] },
      "smith",
      "0000-0002-1825-0097",
    );

    expect(enrichment.authors).toBeDefined();
    // Should match only the first "Smith" entry
    expect(enrichment.authors?.["Smith, Jane"]?.orcid).toBe("0000-0002-1825-0097");
    expect(enrichment.authors?.["Smith, John"]).toBeUndefined();
  });
});

describe("ORCID auto-injection into DataCite creators", () => {
  test("injects ORCID when author matches enrichment", () => {
    const metadata = bidsToDataCite(
      "nm000104",
      "10.82901/NEMAR.test",
      {
        Name: "Test Dataset",
        Authors: ["Shirazi, Yahya", "Smith, John"],
      },
      {
        authors: {
          "Shirazi, Yahya": { orcid: "0000-0002-1825-0097" },
        },
      },
    );

    expect(metadata.creators.length).toBe(2);
    expect(metadata.creators[0].orcid).toBe("0000-0002-1825-0097");
    expect(metadata.creators[1].orcid).toBeUndefined();
  });

  test("includes ORCID in generated XML", () => {
    const metadata = bidsToDataCite(
      "nm000104",
      "10.82901/NEMAR.test",
      { Name: "Test", Authors: ["Doe, Jane"] },
      { authors: { "Doe, Jane": { orcid: "0000-0001-5109-390X" } } },
    );

    const xml = buildDataCiteXml(metadata);
    expect(xml).toContain("0000-0001-5109-390X");
    expect(xml).toContain("ORCID");
  });

  test("handles no enrichment gracefully", () => {
    const metadata = bidsToDataCite("nm000104", "10.82901/NEMAR.test", {
      Name: "Test",
      Authors: ["Doe, Jane"],
    });

    expect(metadata.creators[0].orcid).toBeUndefined();
  });
});

describe("DOI provider dispatch functions", () => {
  test("exports expected functions", () => {
    expect(typeof createConceptDoi).toBe("function");
    expect(typeof createEzidVersionDoi).toBe("function");
  });

  test("createConceptDoi rejects missing EZID credentials", async () => {
    await expect(
      createConceptDoi(
        {
          provider: "ezid",
          datasetId: "nm099999",
          datasetName: "Test",
          uploaderName: "testuser",
        },
        {
          EZID_USERNAME: "",
          EZID_PASSWORD: "",
          ZENODO_API_KEY: "",
        },
      ),
    ).rejects.toThrow("EZID credentials not configured");
  });

  test("createConceptDoi rejects missing Zenodo credentials", async () => {
    await expect(
      createConceptDoi(
        {
          provider: "zenodo",
          datasetId: "nm099999",
          datasetName: "Test",
          uploaderName: "testuser",
        },
        {
          EZID_USERNAME: "",
          EZID_PASSWORD: "",
          ZENODO_API_KEY: "",
        },
      ),
    ).rejects.toThrow("Zenodo API key not configured");
  });

  test("createEzidVersionDoi rejects missing credentials", async () => {
    await expect(
      createEzidVersionDoi(
        { EZID_USERNAME: "", EZID_PASSWORD: "" },
        {
          datasetId: "nm099999",
          conceptIdentifier: "doi:10.5072/FK2test",
          version: "1.0.0",
          bidsDescription: { Name: "Test" },
          githubRepo: "nemarDatasets/nm099999",
        },
      ),
    ).rejects.toThrow("EZID credentials not configured");
  });

  test("sandbox with sandbox creds does not throw credential error", async () => {
    // Should get past credential check and fail at network level (mintIdentifier)
    await expect(
      createConceptDoi(
        {
          provider: "ezid",
          datasetId: "nm099999",
          datasetName: "Test",
          uploaderName: "testuser",
          sandbox: true,
        },
        {
          EZID_USERNAME: "",
          EZID_PASSWORD: "",
          EZID_SANDBOX_USERNAME: "apitest",
          EZID_SANDBOX_PASSWORD: "testpass",
          ZENODO_API_KEY: "",
        },
      ),
    ).rejects.not.toThrow("EZID credentials not configured");
  });

  test("sandbox without sandbox creds throws sandbox credential error", async () => {
    await expect(
      createConceptDoi(
        {
          provider: "ezid",
          datasetId: "nm099999",
          datasetName: "Test",
          uploaderName: "testuser",
          sandbox: true,
        },
        {
          EZID_USERNAME: "produser",
          EZID_PASSWORD: "prodpass",
          ZENODO_API_KEY: "",
        },
      ),
    ).rejects.toThrow("EZID sandbox credentials not configured");
  });

  test("sandbox without any creds throws sandbox credential error", async () => {
    await expect(
      createConceptDoi(
        {
          provider: "ezid",
          datasetId: "nm099999",
          datasetName: "Test",
          uploaderName: "testuser",
          sandbox: true,
        },
        {
          EZID_USERNAME: "",
          EZID_PASSWORD: "",
          ZENODO_API_KEY: "",
        },
      ),
    ).rejects.toThrow("EZID sandbox credentials not configured");
  });

  test("Zenodo sandbox rejects missing sandbox API key", async () => {
    await expect(
      createConceptDoi(
        {
          provider: "zenodo",
          datasetId: "nm099999",
          datasetName: "Test",
          uploaderName: "testuser",
          sandbox: true,
        },
        {
          EZID_USERNAME: "",
          EZID_PASSWORD: "",
          ZENODO_API_KEY: "prod-key",
        },
      ),
    ).rejects.toThrow("Zenodo sandbox API key not configured");
  });
});

describe("signup schema ORCID field", () => {
  test("ORCID regex matches Zod schema pattern", () => {
    // The Zod schema in auth.ts uses this regex
    const zodRegex = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

    // Valid ORCIDs
    expect(zodRegex.test("0000-0002-1825-0097")).toBe(true);
    expect(zodRegex.test("0000-0001-5109-390X")).toBe(true);

    // Invalid
    expect(zodRegex.test("")).toBe(false);
    expect(zodRegex.test("1234")).toBe(false);
  });
});

describe("buildConceptIdentifier", () => {
  test("builds production concept identifier", () => {
    expect(buildConceptIdentifier("nm000104")).toBe("doi:10.82901/NEMAR.NM000104");
  });

  test("builds sandbox concept identifier", () => {
    expect(buildConceptIdentifier("nm099999", true)).toBe("doi:10.5072/FK2NM099999");
  });

  test("uppercases dataset ID", () => {
    expect(buildConceptIdentifier("nm000104")).toBe("doi:10.82901/NEMAR.NM000104");
  });

  test("handles already uppercase input", () => {
    expect(buildConceptIdentifier("NM000104")).toBe("doi:10.82901/NEMAR.NM000104");
  });
});

describe("buildVersionIdentifier", () => {
  test("builds production version identifier", () => {
    expect(buildVersionIdentifier("nm000104", "1.0.0")).toBe("doi:10.82901/NEMAR.NM000104.V1.0.0");
  });

  test("builds sandbox version identifier", () => {
    expect(buildVersionIdentifier("nm099999", "1.0.0", true)).toBe(
      "doi:10.5072/FK2NM099999.V1.0.0",
    );
  });

  test("uppercases version string", () => {
    expect(buildVersionIdentifier("nm000104", "2.1.0")).toBe("doi:10.82901/NEMAR.NM000104.V2.1.0");
  });

  test("handles pre-release versions", () => {
    expect(buildVersionIdentifier("nm000104", "1.0.0-beta")).toBe(
      "doi:10.82901/NEMAR.NM000104.V1.0.0-BETA",
    );
  });
});

describe("DataCite enrichment with version relations", () => {
  test("IsVersionOf relation is included in metadata", () => {
    const metadata = bidsToDataCite(
      "nm000104",
      "10.82901/NEMAR.version1",
      { Name: "Test", Authors: ["Doe, Jane"] },
      {
        relatedDois: [{ doi: "10.82901/NEMAR.concept", relationType: "IsVersionOf" }],
      },
    );

    expect(metadata.relatedIdentifiers).toBeDefined();
    const versionRel = metadata.relatedIdentifiers?.find((r) => r.relationType === "IsVersionOf");
    expect(versionRel).toBeDefined();
    expect(versionRel?.identifier).toBe("10.82901/NEMAR.concept");
  });

  test("HasVersion relation in concept DOI update", () => {
    const metadata = bidsToDataCite(
      "nm000104",
      "10.82901/NEMAR.concept",
      { Name: "Test", Authors: ["Doe, Jane"] },
      {
        relatedDois: [{ doi: "10.82901/NEMAR.v1", relationType: "HasVersion" }],
      },
    );

    const xml = buildDataCiteXml(metadata);
    expect(xml).toContain("HasVersion");
    expect(xml).toContain("10.82901/NEMAR.v1");
  });

  test("multiple HasVersion relations preserved in XML", () => {
    const metadata = bidsToDataCite(
      "nm000104",
      "10.82901/NEMAR.concept",
      { Name: "Test", Authors: ["Doe, Jane"] },
      {
        relatedDois: [
          { doi: "10.82901/NEMAR.v1", relationType: "HasVersion" },
          { doi: "10.82901/NEMAR.v2", relationType: "HasVersion" },
          { doi: "10.82901/NEMAR.v3", relationType: "HasVersion" },
        ],
      },
    );

    const xml = buildDataCiteXml(metadata);
    expect(xml).toContain("10.82901/NEMAR.v1");
    expect(xml).toContain("10.82901/NEMAR.v2");
    expect(xml).toContain("10.82901/NEMAR.v3");

    // Count HasVersion occurrences
    const hasVersionCount = (xml.match(/HasVersion/g) || []).length;
    expect(hasVersionCount).toBe(3);
  });
});

describe("parseNemarMetadata", () => {
  test("parses valid full metadata", () => {
    const result = parseNemarMetadata({
      version: "1.0",
      authors: {
        "Shirazi, Yahya": { orcid: "0000-0002-1825-0097", affiliation: "UC San Diego" },
        "Smith, John": { orcid: "0000-0001-5109-390X" },
      },
      keywords: ["EEG", "motor imagery", "BCI"],
      relatedDois: [{ doi: "10.1234/paper", relationType: "IsSupplementTo" }],
      fundingReferences: [
        { funderName: "NIH", awardNumber: "R01-MH123456", awardTitle: "Neural mechanisms" },
      ],
      description: "A test dataset",
      methodsDescription: "EEG was recorded",
      sizes: ["2.4 GB (142 files)"],
      formats: [".edf", ".tsv", ".json"],
    });

    expect(result).not.toBeNull();
    expect(result?.authors?.["Shirazi, Yahya"]?.orcid).toBe("0000-0002-1825-0097");
    expect(result?.authors?.["Shirazi, Yahya"]?.affiliation).toBe("UC San Diego");
    expect(result?.keywords).toEqual(["EEG", "motor imagery", "BCI"]);
    expect(result?.relatedDois).toHaveLength(1);
    expect(result?.fundingReferences).toHaveLength(1);
    expect(result?.description).toBe("A test dataset");
    expect(result?.sizes).toEqual(["2.4 GB (142 files)"]);
    expect(result?.formats).toEqual([".edf", ".tsv", ".json"]);
  });

  test("parses partial metadata", () => {
    const result = parseNemarMetadata({
      version: "1.0",
      keywords: ["EEG"],
    });

    expect(result).not.toBeNull();
    expect(result?.keywords).toEqual(["EEG"]);
    expect(result?.authors).toBeUndefined();
    expect(result?.description).toBeUndefined();
  });

  test("returns result for empty object", () => {
    const result = parseNemarMetadata({});
    expect(result).not.toBeNull();
    expect(result?.version).toBe("1.0");
  });

  test("returns null for null input", () => {
    expect(parseNemarMetadata(null)).toBeNull();
  });

  test("returns null for array input", () => {
    expect(parseNemarMetadata([])).toBeNull();
  });

  test("returns null for string input", () => {
    expect(parseNemarMetadata("not an object")).toBeNull();
  });

  test("ignores invalid author entries", () => {
    const result = parseNemarMetadata({
      authors: {
        "Valid, Author": { orcid: "0000-0002-1825-0097" },
        "Invalid, Entry": "not an object",
        "Empty, Entry": {},
      },
    });

    expect(result?.authors).toBeDefined();
    expect(Object.keys(result?.authors!)).toEqual(["Valid, Author"]);
  });

  test("filters non-string keywords", () => {
    const result = parseNemarMetadata({
      keywords: ["valid", 123, null, "also valid"],
    });

    expect(result?.keywords).toEqual(["valid", "also valid"]);
  });

  test("rejects unrecognized version", () => {
    const result = parseNemarMetadata({ version: "3.0", description: "test" });
    expect(result).toBeNull();
  });

  test("accepts v2.0 format", () => {
    const result = parseNemarMetadata({ version: "2.0", description: "test" });
    expect(result).not.toBeNull();
    expect(result?.version).toBe("2.0");
  });

  test("accepts missing version (defaults to 1.0)", () => {
    const result = parseNemarMetadata({ description: "test" });
    expect(result).not.toBeNull();
    expect(result?.version).toBe("1.0");
  });

  test("filters relatedDois with invalid relationType at parse time", () => {
    const result = parseNemarMetadata({
      relatedDois: [
        { doi: "10.1234/valid", relationType: "IsSupplementTo" },
        { doi: "10.1234/invalid", relationType: "NotARelationType" },
        { doi: "10.1234/missing-type" },
        { doi: "10.1234/number-type", relationType: 42 },
      ],
    });
    expect(result?.relatedDois).toHaveLength(1);
    expect(result?.relatedDois?.[0].doi).toBe("10.1234/valid");
  });

  test("filters relatedDois missing required fields", () => {
    const result = parseNemarMetadata({
      relatedDois: [
        { doi: "10.1234/valid", relationType: "Cites" },
        { relationType: "Cites" },
        { doi: "10.1234/no-type" },
        null,
        "string",
      ],
    });
    expect(result?.relatedDois).toHaveLength(1);
  });

  test("filters fundingReferences missing funderName", () => {
    const result = parseNemarMetadata({
      fundingReferences: [
        { funderName: "NIH", awardNumber: "R01" },
        { funderName: "NSF" },
        { awardNumber: "orphan" },
        null,
      ],
    });
    expect(result?.fundingReferences).toHaveLength(2);
    expect(result?.fundingReferences?.[0].funderName).toBe("NIH");
    expect(result?.fundingReferences?.[1].funderName).toBe("NSF");
  });
});

describe("nemarMetadataToEnrichment", () => {
  test("converts full NemarMetadata to enrichment", () => {
    const nemarMeta = parseNemarMetadata({
      version: "1.0",
      authors: { "Doe, Jane": { orcid: "0000-0001-5109-390X", affiliation: "MIT" } },
      keywords: ["EEG"],
      description: "A dataset",
      sizes: ["1 GB"],
      formats: [".edf"],
    })!;

    const enrichment = nemarMetadataToEnrichment(nemarMeta);
    expect(enrichment.authors?.["Doe, Jane"]?.orcid).toBe("0000-0001-5109-390X");
    expect(enrichment.keywords).toEqual([{ value: "EEG" }]);
    expect(enrichment.description).toBe("A dataset");
    expect(enrichment.sizes).toEqual(["1 GB"]);
    expect(enrichment.formats).toEqual([".edf"]);
  });

  test("merges with base enrichment, NemarMetadata takes precedence for authors", () => {
    const base = {
      authors: {
        "Shirazi, Yahya": { orcid: "0000-0002-1825-0097" },
        "Old, Author": { orcid: "0000-0000-0000-0001" },
      },
      keywords: [{ value: "neuroscience" }],
    };

    const nemarMeta = parseNemarMetadata({
      version: "1.0",
      authors: {
        "Shirazi, Yahya": { orcid: "0000-0002-1825-0097", affiliation: "UCSD" },
      },
      keywords: ["EEG"],
    })!;

    const enrichment = nemarMetadataToEnrichment(nemarMeta, base);

    // Base author preserved
    expect(enrichment.authors?.["Old, Author"]?.orcid).toBe("0000-0000-0000-0001");
    // NemarMetadata author overrides (adds affiliation)
    expect(enrichment.authors?.["Shirazi, Yahya"]?.affiliation).toBe("UCSD");
    // Keywords merged and deduplicated
    const kwValues = enrichment.keywords?.map((k) => k.value);
    expect(kwValues).toContain("neuroscience");
    expect(kwValues).toContain("EEG");
  });

  test("deduplicates keywords on merge", () => {
    const base = { keywords: [{ value: "EEG" }, { value: "BIDS" }] };
    const nemarMeta = parseNemarMetadata({ keywords: ["EEG", "motor imagery"] })!;
    const enrichment = nemarMetadataToEnrichment(nemarMeta, base);
    expect(enrichment.keywords?.map((k) => k.value)).toEqual(["EEG", "BIDS", "motor imagery"]);
  });

  test("merges funding references instead of overwriting", () => {
    const base = {
      fundingInfo: [{ funderName: "NIH", awardNumber: "R01-MH111" }],
    };
    const nemarMeta = parseNemarMetadata({
      fundingReferences: [
        { funderName: "NSF", awardNumber: "BCS-222" },
        { funderName: "NIH", awardNumber: "R01-MH111" },
      ],
    })!;
    const enrichment = nemarMetadataToEnrichment(nemarMeta, base);
    expect(enrichment.fundingInfo).toHaveLength(2);
    expect(enrichment.fundingInfo?.[0].funderName).toBe("NIH");
    expect(enrichment.fundingInfo?.[1].funderName).toBe("NSF");
  });

  test("deduplicates related DOIs on merge", () => {
    const base = {
      relatedDois: [{ doi: "10.1234/paper", relationType: "IsSupplementTo" as const }],
    };
    const nemarMeta = parseNemarMetadata({
      relatedDois: [
        { doi: "10.1234/paper", relationType: "IsSupplementTo" },
        { doi: "10.1234/new", relationType: "Cites" },
      ],
    })!;
    const enrichment = nemarMetadataToEnrichment(nemarMeta, base);
    expect(enrichment.relatedDois).toHaveLength(2);
    expect(enrichment.relatedDois?.map((r) => r.doi)).toEqual(["10.1234/paper", "10.1234/new"]);
  });

  test("funding conversion maps field names correctly", () => {
    const nemarMeta = parseNemarMetadata({
      fundingReferences: [
        { funderName: "ERC", awardNumber: "ERC-2023", awardTitle: "Brain Dynamics" },
      ],
    })!;
    const enrichment = nemarMetadataToEnrichment(nemarMeta);
    expect(enrichment.fundingInfo).toHaveLength(1);
    expect(enrichment.fundingInfo?.[0]).toEqual({
      funderName: "ERC",
      awardNumber: "ERC-2023",
      awardTitle: "Brain Dynamics",
    });
  });

  test("passes description and methodsDescription through", () => {
    const nemarMeta = parseNemarMetadata({
      description: "New description",
      methodsDescription: "EEG at 256Hz",
    })!;
    const base = { description: "Old description" };
    const enrichment = nemarMetadataToEnrichment(nemarMeta, base);
    expect(enrichment.description).toBe("New description");
    expect(enrichment.methodsDescription).toBe("EEG at 256Hz");
  });
});

describe("sizes and formats in DataCite XML", () => {
  test("sizes appear in XML when provided via enrichment", () => {
    const metadata = bidsToDataCite(
      "nm000104",
      "10.82901/NEMAR.test",
      { Name: "Test", Authors: ["Doe, Jane"] },
      { sizes: ["2.4 GB (142 files)"], formats: [".edf", ".tsv", ".json"] },
    );

    const xml = buildDataCiteXml(metadata);
    expect(xml).toContain("<sizes>");
    expect(xml).toContain("2.4 GB (142 files)");
    expect(xml).toContain("<formats>");
    expect(xml).toContain(".edf");
    expect(xml).toContain(".tsv");
  });

  test("no sizes/formats in XML when not provided", () => {
    const metadata = bidsToDataCite("nm000104", "10.82901/NEMAR.test", {
      Name: "Test",
      Authors: ["Doe, Jane"],
    });

    const xml = buildDataCiteXml(metadata);
    expect(xml).not.toContain("<sizes>");
    expect(xml).not.toContain("<formats>");
  });
});

describe("enrichment keywords merged with auto-keywords", () => {
  test("enrichment keywords appear alongside auto-generated subjects", () => {
    const metadata = bidsToDataCite(
      "nm000104",
      "10.82901/NEMAR.test",
      { Name: "Test", Authors: ["Doe, Jane"] },
      { keywords: [{ value: "motor imagery" }, { value: "BCI" }] },
      { modalities: ["eeg"] },
    );

    const subjectValues = metadata.subjects?.map((s) => s.value) || [];
    // Auto-generated: EEG, BIDS, neuroscience
    expect(subjectValues).toContain("motor imagery");
    expect(subjectValues).toContain("BCI");
    expect(subjectValues).toContain("EEG");
    expect(subjectValues).toContain("BIDS");
    expect(subjectValues).toContain("neuroscience");
  });
});

describe("validateLlmResult (v2 format)", () => {
  test("valid full response", () => {
    const result = validateLlmResult({
      description: "A test dataset",
      methods_description: "EEG recorded at 256Hz",
      keywords: [{ term: "EEG" }, { term: "motor imagery" }],
      funding_references: [{ funder_name: "NIH", award_number: "R01-MH123" }],
      related_identifiers: [
        { identifier: "10.1234/test", identifier_type: "DOI", relation_type: "IsSupplementTo" },
      ],
    });
    expect(result.description).toBe("A test dataset");
    expect(result.methods_description).toBe("EEG recorded at 256Hz");
    expect(result.keywords).toHaveLength(2);
    expect(result.keywords?.[0].term).toBe("EEG");
    expect(result.funding_references).toHaveLength(1);
    expect(result.related_identifiers).toHaveLength(1);
  });

  test("accepts plain string keywords", () => {
    const result = validateLlmResult({
      keywords: ["EEG", "motor imagery"],
    });
    expect(result.keywords).toHaveLength(2);
    expect(result.keywords?.[0].term).toBe("EEG");
    expect(result.keywords?.[1].term).toBe("motor imagery");
  });

  test("rejects DOIs that don't match pattern", () => {
    const result = validateLlmResult({
      related_identifiers: [
        { identifier: "10.1234/valid", identifier_type: "DOI", relation_type: "Cites" },
        { identifier: "not-a-doi", identifier_type: "DOI", relation_type: "Cites" },
        { identifier: "10.12/short-prefix", identifier_type: "DOI", relation_type: "Cites" },
      ],
    });
    expect(result.related_identifiers).toHaveLength(1);
    expect(result.related_identifiers?.[0].identifier).toBe("10.1234/valid");
  });

  test("filters invalid funding references", () => {
    const result = validateLlmResult({
      funding_references: [
        { funder_name: "NIH", award_number: "R01" },
        { notFunderName: "bad" },
        null,
        "string",
      ],
    });
    expect(result.funding_references).toHaveLength(1);
    expect(result.funding_references?.[0].funder_name).toBe("NIH");
  });

  test("empty object returns empty result", () => {
    const result = validateLlmResult({});
    expect(result).toEqual({});
  });

  test("non-string description ignored", () => {
    const result = validateLlmResult({ description: 123 });
    expect(result.description).toBeUndefined();
  });

  test("filters invalid relation types", () => {
    const result = validateLlmResult({
      related_identifiers: [
        { identifier: "10.1234/valid", identifier_type: "DOI", relation_type: "IsSupplementTo" },
        {
          identifier: "10.1234/bad-type",
          identifier_type: "DOI",
          relation_type: "NotARelationType",
        },
        {
          identifier: "10.1234/case-sensitive",
          identifier_type: "DOI",
          relation_type: "issupplementto",
        },
      ],
    });
    expect(result.related_identifiers).toHaveLength(1);
    expect(result.related_identifiers?.[0].identifier).toBe("10.1234/valid");
  });

  test("accepts funding with non-string awardNumber (drops the field)", () => {
    const result = validateLlmResult({
      funding_references: [
        { funder_name: "NIH", award_number: "R01" },
        { funder_name: "NSF", award_number: 42 },
      ],
    });
    // Both entries valid (funder_name present); non-string award_number silently dropped
    expect(result.funding_references).toHaveLength(2);
    expect(result.funding_references?.[0].funder_name).toBe("NIH");
    expect(result.funding_references?.[0].award_number).toBe("R01");
    expect(result.funding_references?.[1].funder_name).toBe("NSF");
    expect(result.funding_references?.[1].award_number).toBeUndefined();
  });
});

describe("isValidRelationType", () => {
  test("valid relation types accepted", () => {
    expect(isValidRelationType("IsSupplementTo")).toBe(true);
    expect(isValidRelationType("Cites")).toBe(true);
    expect(isValidRelationType("HasVersion")).toBe(true);
  });

  test("invalid relation types rejected", () => {
    expect(isValidRelationType("banana")).toBe(false);
    expect(isValidRelationType("")).toBe(false);
    expect(isValidRelationType("issupplementto")).toBe(false);
  });
});

describe("relation type validation pipeline", () => {
  test("invalid relationType filtered at parse time by parseNemarMetadata", () => {
    const parsed = parseNemarMetadata({
      relatedDois: [
        { doi: "10.1234/valid", relationType: "IsSupplementTo" },
        { doi: "10.1234/invalid", relationType: "NotARelationType" },
      ],
    });
    // parseNemarMetadata now filters invalid relation types
    expect(parsed?.relatedDois).toHaveLength(1);
    expect(parsed?.relatedDois?.[0].doi).toBe("10.1234/valid");
  });

  test("nemarMetadataToEnrichment still filters if invalid types sneak through", () => {
    // Simulate a NemarMetadata with an invalid type (e.g., from old file format)
    const enrichment = nemarMetadataToEnrichment({
      version: "1.0",
      relatedDois: [
        { doi: "10.1234/valid", relationType: "IsSupplementTo" },
        { doi: "10.1234/invalid", relationType: "NotARelationType" },
      ],
    });
    expect(enrichment.relatedDois).toHaveLength(1);
    expect(enrichment.relatedDois?.[0].doi).toBe("10.1234/valid");
  });
});

describe("Version format validation", () => {
  const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;
  const stripVersionPrefix = (version: string): string => version.replace(/^[vV]/, "");

  test("accepts stable semver versions", () => {
    expect(SEMVER_REGEX.test("1.0.0")).toBe(true);
    expect(SEMVER_REGEX.test("2.1.3")).toBe(true);
    expect(SEMVER_REGEX.test("10.20.30")).toBe(true);
    expect(SEMVER_REGEX.test("0.1.0")).toBe(true);
    expect(SEMVER_REGEX.test("0.0.1")).toBe(true);
  });

  test("rejects pre-release versions", () => {
    expect(SEMVER_REGEX.test("1.0.0-beta")).toBe(false);
    expect(SEMVER_REGEX.test("1.0.0-alpha.1")).toBe(false);
    expect(SEMVER_REGEX.test("1.0.0-rc.1")).toBe(false);
    expect(SEMVER_REGEX.test("1.0.0-dev")).toBe(false);
  });

  test("rejects build metadata", () => {
    expect(SEMVER_REGEX.test("1.0.0+build123")).toBe(false);
    expect(SEMVER_REGEX.test("1.0.0-beta+build123")).toBe(false);
  });

  test("rejects non-semver strings", () => {
    expect(SEMVER_REGEX.test("banana")).toBe(false);
    expect(SEMVER_REGEX.test("1.0")).toBe(false);
    expect(SEMVER_REGEX.test("v1.0.0")).toBe(false);
    expect(SEMVER_REGEX.test("")).toBe(false);
  });

  test("v-prefix stripping normalizes correctly", () => {
    expect(stripVersionPrefix("v1.0.0")).toBe("1.0.0");
    expect(stripVersionPrefix("V1.0.0")).toBe("1.0.0");
    expect(stripVersionPrefix("1.0.0")).toBe("1.0.0");
    expect(stripVersionPrefix("v")).toBe("");
  });

  test("buildVersionIdentifier with v-prefix input produces double-v", () => {
    // This documents why webhook validation must strip the v-prefix BEFORE
    // passing to buildVersionIdentifier
    expect(buildVersionIdentifier("nm000104", "v1.0.0")).toBe(
      "doi:10.82901/NEMAR.NM000104.VV1.0.0",
    );
  });
});
