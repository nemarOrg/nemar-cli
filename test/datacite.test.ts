/**
 * DataCite XML builder tests
 *
 * Tests XML generation, BIDS mapping, and utility functions.
 */

import { describe, test, expect } from "bun:test";
import {
  buildDataCiteXml,
  bidsToDataCite,
  parseAuthorName,
  mapLicense,
  mapModalityToResourceType,
  type DataCiteMetadata,
} from "../backend/src/services/datacite";

describe("parseAuthorName", () => {
  test("parses Last, First format", () => {
    const result = parseAuthorName("Shirazi, Yahya");
    expect(result.familyName).toBe("Shirazi");
    expect(result.givenName).toBe("Yahya");
    expect(result.name).toBe("Shirazi, Yahya");
  });

  test("parses Last, First Middle format", () => {
    const result = parseAuthorName("Esper, Nathalia B.");
    expect(result.familyName).toBe("Esper");
    expect(result.givenName).toBe("Nathalia B.");
  });

  test("handles name without comma", () => {
    const result = parseAuthorName("NEMAR Consortium");
    expect(result.name).toBe("NEMAR Consortium");
    expect(result.givenName).toBeUndefined();
    expect(result.familyName).toBeUndefined();
  });
});

describe("mapLicense", () => {
  test("maps CC-BY-4.0", () => {
    const result = mapLicense("CC-BY-4.0");
    expect(result?.rightsIdentifier).toBe("CC-BY-4.0");
    expect(result?.rightsURI).toBe("https://creativecommons.org/licenses/by/4.0/");
  });

  test("maps CC BY-NC 4.0 with spaces", () => {
    const result = mapLicense("CC BY-NC 4.0");
    expect(result?.rightsIdentifier).toBe("CC-BY-NC-4.0");
  });

  test("maps CC0", () => {
    const result = mapLicense("CC0");
    expect(result?.rightsIdentifier).toBe("CC0-1.0");
  });

  test("returns free text for unknown license", () => {
    const result = mapLicense("Custom License v2");
    expect(result?.rights).toBe("Custom License v2");
    expect(result?.rightsURI).toBe("");
  });

  test("returns null for undefined", () => {
    expect(mapLicense(undefined)).toBeNull();
  });
});

describe("mapModalityToResourceType", () => {
  test("maps eeg", () => {
    expect(mapModalityToResourceType("eeg")).toBe("EEG Dataset");
  });

  test("maps meg", () => {
    expect(mapModalityToResourceType("meg")).toBe("MEG Dataset");
  });

  test("maps array input", () => {
    expect(mapModalityToResourceType(["eeg", "meg"])).toBe("EEG Dataset");
  });

  test("returns generic for unknown", () => {
    expect(mapModalityToResourceType("unknown")).toBe("Neuroimaging Dataset");
  });

  test("returns Dataset for undefined", () => {
    expect(mapModalityToResourceType(undefined)).toBe("Dataset");
  });
});

describe("buildDataCiteXml", () => {
  test("builds minimal valid XML", () => {
    const metadata: DataCiteMetadata = {
      identifier: "10.82901/NEMAR.TEST",
      creators: [{ name: "Shirazi, Yahya", givenName: "Yahya", familyName: "Shirazi" }],
      titles: ["Test Dataset"],
      publisher: "NEMAR",
      publicationYear: 2026,
      resourceTypeGeneral: "Dataset",
    };

    const xml = buildDataCiteXml(metadata);

    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain("kernel-4");
    expect(xml).toContain("10.82901/NEMAR.TEST");
    expect(xml).toContain("Shirazi, Yahya");
    expect(xml).toContain("<givenName>Yahya</givenName>");
    expect(xml).toContain("<familyName>Shirazi</familyName>");
    expect(xml).toContain("<title>Test Dataset</title>");
    expect(xml).toContain("<publisher>NEMAR</publisher>");
    expect(xml).toContain("<publicationYear>2026</publicationYear>");
    expect(xml).toContain('resourceTypeGeneral="Dataset"');
  });

  test("includes all 20 properties when provided", () => {
    const metadata: DataCiteMetadata = {
      identifier: "10.82901/NEMAR.FULL",
      creators: [{
        name: "Shirazi, Yahya",
        givenName: "Yahya",
        familyName: "Shirazi",
        orcid: "0000-0001-2345-6789",
        affiliation: "UCSD",
        ror: "https://ror.org/0168r3w48",
      }],
      titles: ["Full Metadata Test"],
      publisher: "NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)",
      publicationYear: 2026,
      resourceTypeGeneral: "Dataset",
      resourceTypeSpecific: "EEG Dataset",
      subjects: ["EEG", "BIDS"],
      contributors: [{
        name: "NEMAR",
        contributorType: "HostingInstitution",
        nameType: "Organizational",
      }],
      dates: [{ date: "2026-02-10", dateType: "Issued" }],
      relatedIdentifiers: [{
        identifier: "10.1234/paper",
        relatedIdentifierType: "DOI",
        relationType: "IsSupplementTo",
      }],
      descriptions: [{ description: "A test dataset", descriptionType: "Abstract" }],
      geoLocations: ["San Diego, CA"],
      language: "en",
      alternateIdentifiers: [{ identifier: "nm000103", type: "NEMAR" }],
      sizes: ["1.2 GB"],
      formats: ["application/x-edf"],
      version: "1.0.0",
      rights: [{
        rights: "CC BY 4.0",
        rightsURI: "https://creativecommons.org/licenses/by/4.0/",
        rightsIdentifier: "CC-BY-4.0",
        rightsIdentifierScheme: "SPDX",
      }],
      fundingReferences: [{
        funderName: "NIH",
        funderIdentifier: "https://doi.org/10.13039/100000002",
        funderIdentifierType: "Crossref Funder ID",
        awardNumber: "R01-NS12345",
      }],
    };

    const xml = buildDataCiteXml(metadata);

    // Check all sections present
    expect(xml).toContain("<identifier");
    expect(xml).toContain("<creators>");
    expect(xml).toContain("<titles>");
    expect(xml).toContain("<publisher>");
    expect(xml).toContain("<publicationYear>");
    expect(xml).toContain("<subjects>");
    expect(xml).toContain("<contributors>");
    expect(xml).toContain("<dates>");
    expect(xml).toContain("<language>en</language>");
    expect(xml).toContain("<resourceType");
    expect(xml).toContain("<alternateIdentifiers>");
    expect(xml).toContain("<relatedIdentifiers>");
    expect(xml).toContain("<sizes>");
    expect(xml).toContain("<formats>");
    expect(xml).toContain("<version>1.0.0</version>");
    expect(xml).toContain("<rightsList>");
    expect(xml).toContain("<descriptions>");
    expect(xml).toContain("<geoLocations>");
    expect(xml).toContain("<fundingReferences>");

    // Check specific values
    expect(xml).toContain('nameIdentifierScheme="ORCID"');
    expect(xml).toContain("0000-0001-2345-6789");
    expect(xml).toContain('affiliationIdentifierScheme="ROR"');
    expect(xml).toContain("EEG Dataset");
    expect(xml).toContain("nm000103");
    expect(xml).toContain("IsSupplementTo");
    expect(xml).toContain("R01-NS12345");
  });

  test("escapes XML entities", () => {
    const metadata: DataCiteMetadata = {
      identifier: "10.82901/NEMAR.ESC",
      creators: [{ name: "O'Brien & Associates" }],
      titles: ["Dataset with <special> characters"],
      publisher: "NEMAR",
      publicationYear: 2026,
      resourceTypeGeneral: "Dataset",
    };

    const xml = buildDataCiteXml(metadata);
    expect(xml).toContain("O&apos;Brien &amp; Associates");
    expect(xml).toContain("&lt;special&gt;");
  });
});

describe("bidsToDataCite", () => {
  test("maps basic BIDS fields", () => {
    const bids = {
      Name: "Healthy Brain Network EEG",
      Authors: ["Shirazi, Yahya", "Delorme, Arnaud"],
      License: "CC-BY-4.0",
      Version: "1.0.0",
      BIDSVersion: "1.9.0",
    };

    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids);

    expect(metadata.titles[0]).toBe("Healthy Brain Network EEG");
    expect(metadata.creators).toHaveLength(2);
    expect(metadata.creators[0].familyName).toBe("Shirazi");
    expect(metadata.creators[0].givenName).toBe("Yahya");
    expect(metadata.version).toBe("1.0.0");
    expect(metadata.rights?.[0]?.rightsIdentifier).toBe("CC-BY-4.0");
    expect(metadata.publisher).toContain("NEMAR");
    expect(metadata.language).toBe("en");
    expect(metadata.alternateIdentifiers?.[0]?.identifier).toBe("nm000103");
  });

  test("applies enrichment data", () => {
    const bids = {
      Name: "Test Dataset",
      Authors: ["Shirazi, Yahya"],
    };

    const enrichment = {
      orcids: { "Shirazi, Yahya": "0000-0001-2345-6789" },
      affiliations: { "Shirazi, Yahya": "UCSD" },
      keywords: ["EEG", "motor imagery"],
      relatedDois: [{ doi: "10.1234/paper" }],
      description: "A test EEG dataset",
    };

    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids, enrichment);

    expect(metadata.creators[0].orcid).toBe("0000-0001-2345-6789");
    expect(metadata.creators[0].affiliation).toBe("UCSD");
    expect(metadata.subjects).toContain("EEG");
    expect(metadata.subjects).toContain("motor imagery");
    expect(metadata.relatedIdentifiers?.[0]?.identifier).toBe("10.1234/paper");
    expect(metadata.descriptions?.[0]?.description).toBe("A test EEG dataset");
  });

  test("includes NEMAR as hosting institution", () => {
    const bids = { Name: "Test", Authors: ["Doe, John"] };
    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids);

    expect(metadata.contributors?.[0]?.contributorType).toBe("HostingInstitution");
    expect(metadata.contributors?.[0]?.name).toContain("NEMAR");
  });

  test("adds BIDS and neuroscience as default subjects", () => {
    const bids = { Name: "Test", Authors: ["Doe, John"] };
    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids);

    expect(metadata.subjects).toContain("BIDS");
    expect(metadata.subjects).toContain("neuroscience");
  });

  test("handles missing authors gracefully", () => {
    const bids = { Name: "Test" };
    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids);

    expect(metadata.creators).toHaveLength(1);
    expect(metadata.creators[0].name).toBe("(:unav)");
  });

  test("parses BIDS ReferencesAndLinks as DOIs", () => {
    const bids = {
      Name: "Test",
      Authors: ["Doe, John"],
      ReferencesAndLinks: [
        "10.1234/paper.2024.001",
        "https://example.com/docs",
      ],
    };

    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids);

    // Only DOI-like references should be included
    const doiRefs = metadata.relatedIdentifiers?.filter(
      (r) => r.relatedIdentifierType === "DOI",
    );
    expect(doiRefs).toHaveLength(1);
    expect(doiRefs?.[0]?.identifier).toBe("10.1234/paper.2024.001");
  });
});
