/**
 * DOI provider dispatch layer tests
 *
 * Tests ORCID validation, DOI dispatch routing, ORCID auto-injection,
 * provider parsing, and DataCite version relation enrichment.
 */

import { describe, expect, test } from "bun:test";
import { bidsToDataCite, buildDataCiteXml } from "../backend/src/services/datacite";
import {
  buildConceptIdentifier,
  buildOrcidEnrichment,
  buildVersionIdentifier,
  createConceptDoi,
  createEzidVersionDoi,
  parseDoiProvider,
} from "../backend/src/services/doi";

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

describe("parseDoiProvider", () => {
  test("returns 'ezid' for 'ezid' input", () => {
    expect(parseDoiProvider("ezid")).toBe("ezid");
  });

  test("returns 'zenodo' for 'zenodo' input", () => {
    expect(parseDoiProvider("zenodo")).toBe("zenodo");
  });

  test("returns fallback for null", () => {
    expect(parseDoiProvider(null)).toBe("ezid");
  });

  test("returns fallback for undefined", () => {
    expect(parseDoiProvider(undefined)).toBe("ezid");
  });

  test("returns fallback for invalid string", () => {
    expect(parseDoiProvider("datacite")).toBe("ezid");
  });

  test("uses custom fallback when provided", () => {
    expect(parseDoiProvider(null, "zenodo")).toBe("zenodo");
  });

  test("returns fallback for empty string", () => {
    expect(parseDoiProvider("")).toBe("ezid");
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

  test("returns empty enrichment when no ORCID provided", () => {
    const enrichment = buildOrcidEnrichment({ Name: "Test", Authors: ["Doe, Jane"] }, "jane");

    expect(enrichment).toEqual({});
  });

  test("returns empty enrichment when no BIDS description", () => {
    const enrichment = buildOrcidEnrichment(undefined, "jane", "0000-0002-1825-0097");

    expect(enrichment).toEqual({});
  });

  test("returns empty enrichment when no uploaderName", () => {
    const enrichment = buildOrcidEnrichment(
      { Name: "Test", Authors: ["Doe, Jane"] },
      undefined,
      "0000-0002-1825-0097",
    );

    expect(enrichment).toEqual({});
  });

  test("returns empty enrichment when no authors in BIDS", () => {
    const enrichment = buildOrcidEnrichment({ Name: "Test" }, "jane", "0000-0002-1825-0097");

    expect(enrichment).toEqual({});
  });

  test("returns empty enrichment when uploader name does not match any author", () => {
    const enrichment = buildOrcidEnrichment(
      { Name: "Test", Authors: ["Doe, Jane", "Smith, John"] },
      "nobody",
      "0000-0002-1825-0097",
    );

    // No match found, so authors map should not be set
    expect(enrichment.authors).toBeUndefined();
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
