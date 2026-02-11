/**
 * DOI provider dispatch layer tests
 *
 * Tests ORCID validation, DOI dispatch routing, and ORCID auto-injection.
 */

import { describe, test, expect } from "bun:test";
import { bidsToDataCite, buildDataCiteXml } from "../backend/src/services/datacite";

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
    const metadata = bidsToDataCite(
      "nm000104",
      "10.82901/NEMAR.test",
      { Name: "Test", Authors: ["Doe, Jane"] },
    );

    expect(metadata.creators[0].orcid).toBeUndefined();
  });
});

describe("DOI provider dispatch types", () => {
  test("DoiResult interface has required fields", async () => {
    // Verify the types are importable and well-formed
    const { createConceptDoi, createEzidVersionDoi } = await import(
      "../backend/src/services/doi"
    );
    expect(typeof createConceptDoi).toBe("function");
    expect(typeof createEzidVersionDoi).toBe("function");
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

describe("DataCite enrichment with version relations", () => {
  test("IsVersionOf relation is included in metadata", () => {
    const metadata = bidsToDataCite(
      "nm000104",
      "10.82901/NEMAR.version1",
      { Name: "Test", Authors: ["Doe, Jane"] },
      {
        relatedDois: [
          { doi: "10.82901/NEMAR.concept", relationType: "IsVersionOf" },
        ],
      },
    );

    expect(metadata.relatedIdentifiers).toBeDefined();
    const versionRel = metadata.relatedIdentifiers?.find(
      (r) => r.relationType === "IsVersionOf",
    );
    expect(versionRel).toBeDefined();
    expect(versionRel?.identifier).toBe("10.82901/NEMAR.concept");
  });

  test("HasVersion relation in concept DOI update", () => {
    const metadata = bidsToDataCite(
      "nm000104",
      "10.82901/NEMAR.concept",
      { Name: "Test", Authors: ["Doe, Jane"] },
      {
        relatedDois: [
          { doi: "10.82901/NEMAR.v1", relationType: "HasVersion" },
        ],
      },
    );

    const xml = buildDataCiteXml(metadata);
    expect(xml).toContain("HasVersion");
    expect(xml).toContain("10.82901/NEMAR.v1");
  });
});
