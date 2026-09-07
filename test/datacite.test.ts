/**
 * DataCite XML builder tests
 *
 * Tests XML generation, BIDS mapping, and utility functions.
 */

import { describe, expect, test } from "bun:test";
import {
  type DataCiteCreator,
  type DataCiteMetadata,
  bidsToDataCite,
  buildDataCiteXml,
  detectIdentifierType,
  detectModalitiesFromTree,
  mapLicense,
  mapModalityToResourceType,
  nemarMetadataToEnrichment,
  normalizeDoi,
  parseAuthorName,
  parseNemarMetadata,
} from "../backend/src/services/datacite";
import {
  mergeWithExisting,
  parseValidationResult,
  seedFromBids,
  validateLlmResultV2,
} from "../backend/src/services/llm-enrich";
import {
  type UploaderIdentity,
  resolveUploaderIdentity,
} from "../backend/src/services/uploader-identity";
import type { NemarMetadataV2 } from "../shared/datacite-constants";

/** Built the way production builds it (from the owner row), so these tests
 *  exercise the real given/family -> "Family, Given" derivation and its
 *  trimming rather than a hand-assembled object. */
function identity(given: string, family: string, orcid?: string): UploaderIdentity {
  const resolved = resolveUploaderIdentity({
    given_name: given,
    family_name: family,
    orcid: orcid ?? null,
  });
  if (!resolved) throw new Error("test setup: identity should resolve");
  return resolved;
}

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

describe("normalizeDoi", () => {
  test("strips doi: prefix", () => {
    expect(normalizeDoi("doi:10.1234/foo")).toBe("10.1234/foo");
  });

  test("strips https://doi.org/ prefix", () => {
    expect(normalizeDoi("https://doi.org/10.1234/foo")).toBe("10.1234/foo");
  });

  test("strips http://dx.doi.org/ prefix", () => {
    expect(normalizeDoi("http://dx.doi.org/10.1234/foo")).toBe("10.1234/foo");
  });

  test("passes through bare DOI unchanged", () => {
    expect(normalizeDoi("10.1234/foo")).toBe("10.1234/foo");
  });

  test("is case-insensitive for prefix", () => {
    expect(normalizeDoi("DOI:10.1234/foo")).toBe("10.1234/foo");
    expect(normalizeDoi("HTTPS://DOI.ORG/10.1234/foo")).toBe("10.1234/foo");
  });

  test("trims whitespace", () => {
    expect(normalizeDoi("  10.1234/foo  ")).toBe("10.1234/foo");
  });

  test("returns empty string for prefix-only input", () => {
    expect(normalizeDoi("doi:")).toBe("");
  });
});

describe("detectIdentifierType", () => {
  test("detects HTTPS URL", () => {
    expect(detectIdentifierType("https://example.com")).toBe("URL");
  });

  test("detects HTTP URL", () => {
    expect(detectIdentifierType("http://example.com")).toBe("URL");
  });

  test("detects DOI URL as URL type", () => {
    expect(detectIdentifierType("https://doi.org/10.1234/foo")).toBe("URL");
  });

  test("detects URN", () => {
    expect(detectIdentifierType("urn:nbn:de:0114-fqs0901272")).toBe("URN");
  });

  test("detects bare DOI", () => {
    expect(detectIdentifierType("10.1234/foo")).toBe("DOI");
  });

  test("detects doi: prefix as DOI", () => {
    expect(detectIdentifierType("doi:10.1234/foo")).toBe("DOI");
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

  test("maps PDDL", () => {
    const result = mapLicense("PDDL");
    expect(result?.rightsIdentifier).toBe("PDDL-1.0");
    expect(result?.rightsURI).toContain("opendatacommons.org");
  });

  test("maps PDDL-1.0", () => {
    const result = mapLicense("PDDL-1.0");
    expect(result?.rightsIdentifier).toBe("PDDL-1.0");
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
      creators: [
        {
          name: "Shirazi, Yahya",
          givenName: "Yahya",
          familyName: "Shirazi",
          orcid: "0000-0001-2345-6789",
          affiliation: "UCSD",
          ror: "https://ror.org/0168r3w48",
        },
      ],
      titles: ["Full Metadata Test"],
      publisher: "NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)",
      publicationYear: 2026,
      resourceTypeGeneral: "Dataset",
      resourceTypeSpecific: "EEG Dataset",
      subjects: [{ value: "EEG" }, { value: "BIDS" }],
      contributors: [
        {
          name: "NEMAR",
          contributorType: "HostingInstitution",
          nameType: "Organizational",
        },
      ],
      dates: [{ date: "2026-02-10", dateType: "Issued" }],
      relatedIdentifiers: [
        {
          identifier: "10.1234/paper",
          relatedIdentifierType: "DOI",
          relationType: "IsSupplementTo",
        },
      ],
      descriptions: [{ description: "A test dataset", descriptionType: "Abstract" }],
      geoLocations: [{ place: "San Diego, CA" }],
      language: "en",
      alternateIdentifiers: [{ identifier: "nm000103", type: "NEMAR" }],
      sizes: ["1.2 GB"],
      formats: ["application/x-edf"],
      version: "1.0.0",
      rights: [
        {
          rights: "CC BY 4.0",
          rightsURI: "https://creativecommons.org/licenses/by/4.0/",
          rightsIdentifier: "CC-BY-4.0",
          rightsIdentifierScheme: "SPDX",
        },
      ],
      fundingReferences: [
        {
          funderName: "NIH",
          funderIdentifier: "https://doi.org/10.13039/100000002",
          funderIdentifierType: "Crossref Funder ID",
          awardNumber: "R01-NS12345",
        },
      ],
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

  test("escapes double quotes in attribute values", () => {
    const metadata: DataCiteMetadata = {
      identifier: "10.82901/NEMAR.DQ",
      creators: [{ name: 'Test "Quoted" Name' }],
      titles: ["Test"],
      publisher: "NEMAR",
      publicationYear: 2026,
      resourceTypeGeneral: "Dataset",
    };

    const xml = buildDataCiteXml(metadata);
    expect(xml).toContain("Test &quot;Quoted&quot; Name");
  });

  // Phase 3 of epic #1225 (issue #1226): buildDataCiteXml now routes through
  // the shared escapeXml in backend/src/lib/escape.ts. A single creator name
  // carrying all five special characters exercises every branch of that
  // helper through this real entry point, with &apos; -- not &#39; -- for
  // the apostrophe, matching escapeXml's contract (escapeHtml is the one
  // that uses &#39;; the two are deliberately different functions).
  test("a creator name with all five special characters escapes each one, &apos; for the apostrophe", () => {
    const metadata: DataCiteMetadata = {
      identifier: "10.82901/NEMAR.ALLFIVE",
      creators: [{ name: `O'Brien & Sons <Ltd> "Data"` }],
      titles: ["Test"],
      publisher: "NEMAR",
      publicationYear: 2026,
      resourceTypeGeneral: "Dataset",
    };

    const xml = buildDataCiteXml(metadata);
    expect(xml).toContain(
      '<creatorName nameType="Personal">O&apos;Brien &amp; Sons &lt;Ltd&gt; &quot;Data&quot;</creatorName>',
    );
    expect(xml).not.toContain("&#39;");
  });

  test("throws on missing identifier", () => {
    expect(() =>
      buildDataCiteXml({
        identifier: "",
        creators: [{ name: "Test" }],
        titles: ["Test"],
        publisher: "NEMAR",
        publicationYear: 2026,
        resourceTypeGeneral: "Dataset",
      }),
    ).toThrow("identifier is required");
  });

  test("throws on empty creators", () => {
    expect(() =>
      buildDataCiteXml({
        identifier: "10.82901/NEMAR.X",
        creators: [],
        titles: ["Test"],
        publisher: "NEMAR",
        publicationYear: 2026,
        resourceTypeGeneral: "Dataset",
      }),
    ).toThrow("at least one creator");
  });

  test("throws on empty titles", () => {
    expect(() =>
      buildDataCiteXml({
        identifier: "10.82901/NEMAR.X",
        creators: [{ name: "Test" }],
        titles: [],
        publisher: "NEMAR",
        publicationYear: 2026,
        resourceTypeGeneral: "Dataset",
      }),
    ).toThrow("at least one title");
  });

  test("throws on invalid publicationYear", () => {
    expect(() =>
      buildDataCiteXml({
        identifier: "10.82901/NEMAR.X",
        creators: [{ name: "Test" }],
        titles: ["Test"],
        publisher: "NEMAR",
        publicationYear: Number.NaN,
        resourceTypeGeneral: "Dataset",
      }),
    ).toThrow("publicationYear must be a valid number");
  });

  // Issue #459: EZID validates against the DataCite kernel-4 XSD, which
  // requires `<funderName>`, `<creatorName>`, and `<contributorName>` to
  // each have at least one character. Whitespace-only or empty entries
  // used to slip through and trip EZID's minLength check, taking the
  // whole identifier down. The XML builder filters them out, and
  // `bidsToDataCite` filters at the source so neither path emits
  // schema-invalid output.

  test("skips empty and whitespace-only funder entries (issue #459)", () => {
    const metadata: DataCiteMetadata = {
      identifier: "10.82901/NEMAR.FUNDERS",
      creators: [{ name: "Test, Author" }],
      titles: ["Test"],
      publisher: "NEMAR",
      publicationYear: 2026,
      resourceTypeGeneral: "Dataset",
      fundingReferences: [{ funderName: "NIH" }, { funderName: "   " }, { funderName: "" }],
    };

    const xml = buildDataCiteXml(metadata);

    // Exactly one funderName element survived
    const funderMatches = xml.match(/<funderName>/g) ?? [];
    expect(funderMatches.length).toBe(1);
    expect(xml).toContain("<funderName>NIH</funderName>");
    // No empty/self-closing tag
    expect(xml).not.toContain("<funderName></funderName>");
    expect(xml).not.toContain("<funderName/>");
  });

  test("drops entire fundingReferences block when every entry is empty", () => {
    const metadata: DataCiteMetadata = {
      identifier: "10.82901/NEMAR.ALLEMPTY",
      creators: [{ name: "Test, Author" }],
      titles: ["Test"],
      publisher: "NEMAR",
      publicationYear: 2026,
      resourceTypeGeneral: "Dataset",
      fundingReferences: [{ funderName: "" }, { funderName: "  " }],
    };

    const xml = buildDataCiteXml(metadata);

    expect(xml).not.toContain("<fundingReferences>");
    expect(xml).not.toContain("<funderName");
  });

  test("skips contributors with empty or whitespace names (issue #459)", () => {
    const metadata: DataCiteMetadata = {
      identifier: "10.82901/NEMAR.CONTRIBS",
      creators: [{ name: "Test, Author" }],
      titles: ["Test"],
      publisher: "NEMAR",
      publicationYear: 2026,
      resourceTypeGeneral: "Dataset",
      contributors: [
        {
          name: "Real Curator",
          contributorType: "DataCurator",
          nameType: "Personal",
        },
        { name: "", contributorType: "Other", nameType: "Personal" },
        { name: "   ", contributorType: "Other", nameType: "Personal" },
      ],
    };

    const xml = buildDataCiteXml(metadata);

    const contributorMatches = xml.match(/<contributorName/g) ?? [];
    expect(contributorMatches.length).toBe(1);
    expect(xml).toContain("Real Curator");
    expect(xml).not.toContain("<contributorName></contributorName>");
  });

  test("throws when every creator name is empty (issue #459)", () => {
    expect(() =>
      buildDataCiteXml({
        identifier: "10.82901/NEMAR.NOCREATORS",
        creators: [{ name: "" }, { name: "   " }],
        titles: ["Test"],
        publisher: "NEMAR",
        publicationYear: 2026,
        resourceTypeGeneral: "Dataset",
      }),
    ).toThrow(/non-empty name/);
  });

  test("filters empty creator entries but keeps valid ones (issue #459)", () => {
    const metadata: DataCiteMetadata = {
      identifier: "10.82901/NEMAR.MIXEDCREATORS",
      creators: [{ name: "Real, Author" }, { name: "" }, { name: "   " }],
      titles: ["Test"],
      publisher: "NEMAR",
      publicationYear: 2026,
      resourceTypeGeneral: "Dataset",
    };

    const xml = buildDataCiteXml(metadata);
    const creatorMatches = xml.match(/<creatorName/g) ?? [];
    expect(creatorMatches.length).toBe(1);
    expect(xml).toContain("Real, Author");
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
      authors: {
        "Shirazi, Yahya": { orcid: "0000-0001-2345-6789", affiliation: "UCSD" },
      },
      keywords: [{ value: "EEG" }, { value: "motor imagery" }],
      relatedDois: [{ doi: "10.1234/paper" }],
      description: "A test EEG dataset",
    };

    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids, enrichment);

    expect(metadata.creators[0].orcid).toBe("0000-0001-2345-6789");
    expect(metadata.creators[0].affiliation).toBe("UCSD");
    expect(metadata.subjects?.map((s) => s.value)).toContain("EEG");
    expect(metadata.subjects?.map((s) => s.value)).toContain("motor imagery");
    expect(metadata.relatedIdentifiers?.[0]?.identifier).toBe("10.1234/paper");
    expect(metadata.descriptions?.[0]?.description).toBe("A test EEG dataset");
  });

  test("includes NEMAR as hosting institution", () => {
    const bids = { Name: "Test", Authors: ["Doe, John"] };
    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids);

    expect(metadata.contributors?.[0]?.contributorType).toBe("HostingInstitution");
    expect(metadata.contributors?.[0]?.name).toContain("NEMAR");
  });

  test("adds uploader as DataCurator, cited by real name", () => {
    const bids = { Name: "Test", Authors: ["Smith, John"] };
    const metadata = bidsToDataCite("nm000104", "10.82901/NEMAR.test", bids, {
      uploader: identity("Jane", "Doe"),
    });
    const curator = metadata.contributors?.find((c) => c.contributorType === "DataCurator");
    expect(curator).toBeDefined();
    expect(curator?.name).toBe("Doe, Jane");
    expect(curator?.nameType).toBe("Personal");
    expect(curator?.givenName).toBe("Jane");
    expect(curator?.familyName).toBe("Doe");
  });

  test("DataCurator XML carries contributorName plus given/family children", () => {
    const bids = { Name: "Test", Authors: ["Smith, John"] };
    const metadata = bidsToDataCite("nm000104", "10.82901/NEMAR.test", bids, {
      uploader: identity("Jane", "Doe"),
    });
    const xml = buildDataCiteXml(metadata);
    expect(xml).toContain('<contributor contributorType="DataCurator">');
    expect(xml).toContain('<contributorName nameType="Personal">Doe, Jane</contributorName>');
    expect(xml).toContain("<givenName>Jane</givenName>");
    expect(xml).toContain("<familyName>Doe</familyName>");
    // Kernel-4 sequence: contributorName, then givenName, then familyName.
    expect(xml.indexOf("<contributorName")).toBeLessThan(xml.indexOf("<givenName>Jane"));
    expect(xml.indexOf("<givenName>Jane")).toBeLessThan(xml.indexOf("<familyName>Doe"));
  });

  test("DataCurator name parts are XML-escaped", () => {
    // A DataCite document with a raw & or < in a name is not well-formed XML
    // and EZID rejects the whole identifier. Apostrophes are legal in text
    // content and must survive readably rather than being mangled.
    const bids = { Name: "Test", Authors: ["Smith, John"] };
    const metadata = bidsToDataCite("nm000104", "10.82901/NEMAR.test", bids, {
      uploader: identity("A<n & Co", "O'Brien"),
    });
    const xml = buildDataCiteXml(metadata);

    expect(xml).toContain("<givenName>A&lt;n &amp; Co</givenName>");
    expect(xml).toContain("<familyName>O&apos;Brien</familyName>");
    expect(xml).toContain(
      '<contributorName nameType="Personal">O&apos;Brien, A&lt;n &amp; Co</contributorName>',
    );
    // No raw markup-significant characters escaped into existence anywhere.
    expect(xml).not.toContain("A<n & Co");
  });

  test("does NOT add DataCurator when uploader IS a BIDS author", () => {
    const bids = { Name: "Test", Authors: ["Doe, Jane"] };
    const metadata = bidsToDataCite("nm000104", "10.82901/NEMAR.test", bids, {
      uploader: identity("Jane", "Doe"),
    });
    const curators = metadata.contributors?.filter((c) => c.contributorType === "DataCurator");
    expect(curators).toHaveLength(0);
  });

  test("does NOT add DataCurator when the author is spelled given-name-first", () => {
    const bids = { Name: "Test", Authors: ["Jane Doe"] };
    const metadata = bidsToDataCite("nm000104", "10.82901/NEMAR.test", bids, {
      uploader: identity("Jane", "Doe"),
    });
    const curators = metadata.contributors?.filter((c) => c.contributorType === "DataCurator");
    expect(curators).toHaveLength(0);
  });

  test("does NOT add DataCurator when the enrichment has no uploader", () => {
    const bids = { Name: "Test", Authors: ["Doe, Jane"] };
    const metadata = bidsToDataCite("nm000104", "10.82901/NEMAR.test", bids, {});
    const curators = metadata.contributors?.filter((c) => c.contributorType === "DataCurator");
    expect(curators).toHaveLength(0);
  });

  test("does NOT add DataCurator when the uploader is explicitly null", () => {
    // The shape an account with no citable name produces.
    const bids = { Name: "Test", Authors: ["Doe, Jane"] };
    const metadata = bidsToDataCite("nm000104", "10.82901/NEMAR.test", bids, { uploader: null });
    const curators = metadata.contributors?.filter((c) => c.contributorType === "DataCurator");
    expect(curators).toHaveLength(0);
  });

  test("DataCurator includes ORCID when the identity carries one", () => {
    const bids = { Name: "Test", Authors: ["Smith, John"] };
    const metadata = bidsToDataCite("nm000104", "10.82901/NEMAR.test", bids, {
      uploader: identity("Jane", "Doe", "0000-0002-1825-0097"),
    });
    const curator = metadata.contributors?.find((c) => c.contributorType === "DataCurator");
    expect(curator?.orcid).toBe("0000-0002-1825-0097");
    const xml = buildDataCiteXml(metadata);
    expect(xml).toContain("0000-0002-1825-0097");
    expect(xml).toContain('nameIdentifierScheme="ORCID"');
  });

  test("DataCurator without an ORCID emits no nameIdentifier", () => {
    const bids = { Name: "Test", Authors: ["Smith, John"] };
    const metadata = bidsToDataCite("nm000104", "10.82901/NEMAR.test", bids, {
      uploader: identity("Jane", "Doe"),
    });
    const curator = metadata.contributors?.find((c) => c.contributorType === "DataCurator");
    expect(curator?.orcid).toBeUndefined();
    expect(buildDataCiteXml(metadata)).not.toContain("nameIdentifier");
  });

  test("family-name overlap alone does not suppress the DataCurator", () => {
    // Both parts must match: a same-family-name colleague in the author list
    // is not the uploader, so the uploader is still credited as curator.
    const bids = { Name: "Test", Authors: ["Doe, John"] };
    const metadata = bidsToDataCite("nm000104", "10.82901/NEMAR.test", bids, {
      uploader: identity("Jane", "Doe"),
    });
    const curator = metadata.contributors?.find((c) => c.contributorType === "DataCurator");
    expect(curator?.name).toBe("Doe, Jane");
  });

  test("a short name part does not match inside a longer word", () => {
    // The word-boundary case that predates #1255 and survives the two-part
    // matcher: "Li" occurs inside "Elizabeth" and "Wang" inside "Wangler",
    // but neither is this person, so the curator is still added.
    const bids = { Name: "Test", Authors: ["Elizabeth Wangler"] };
    const metadata = bidsToDataCite("nm000104", "10.82901/NEMAR.test", bids, {
      uploader: identity("Li", "Wang"),
    });
    const curator = metadata.contributors?.find((c) => c.contributorType === "DataCurator");
    expect(curator?.name).toBe("Wang, Li");
  });

  test("a short name part DOES match when it stands as its own word", () => {
    // The other half of the boundary rule: the same identity against an
    // author who really is that person must suppress the curator.
    const bids = { Name: "Test", Authors: ["Wang, Li"] };
    const metadata = bidsToDataCite("nm000104", "10.82901/NEMAR.test", bids, {
      uploader: identity("Li", "Wang"),
    });
    const curators = metadata.contributors?.filter((c) => c.contributorType === "DataCurator");
    expect(curators).toHaveLength(0);
  });

  test("surrounding whitespace on the owner columns never reaches the XML", () => {
    // Trimming is resolveUploaderIdentity's job now, so this drives it from
    // the padded column values a D1 row could really hold.
    const bids = { Name: "Test", Authors: ["Smith, John"] };
    const metadata = bidsToDataCite("nm000104", "10.82901/NEMAR.test", bids, {
      uploader: identity("  Jane  ", "  Doe  "),
    });
    const curator = metadata.contributors?.find((c) => c.contributorType === "DataCurator");
    expect(curator?.name).toBe("Doe, Jane");
    const xml = buildDataCiteXml(metadata);
    expect(xml).not.toContain("  Jane  ");
    expect(xml).toContain("<givenName>Jane</givenName>");
  });

  test("adds BIDS and neuroscience as default subjects", () => {
    const bids = { Name: "Test", Authors: ["Doe, John"] };
    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids);

    expect(metadata.subjects?.map((s) => s.value)).toContain("BIDS");
    expect(metadata.subjects?.map((s) => s.value)).toContain("neuroscience");
  });

  test("handles missing authors gracefully", () => {
    const bids = { Name: "Test" };
    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids);

    expect(metadata.creators).toHaveLength(1);
    expect(metadata.creators[0].name).toBe("(:unav)");
  });

  test("maps BIDS Funding to fundingReferences without enrichment", () => {
    const bids = {
      Name: "Test",
      Authors: ["Doe, John"],
      Funding: ["NIH R01-NS12345", "NSF BCS-9876543"],
    };

    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids);

    expect(metadata.fundingReferences).toHaveLength(2);
    expect(metadata.fundingReferences?.[0]?.funderName).toBe("NIH R01-NS12345");
    expect(metadata.fundingReferences?.[1]?.funderName).toBe("NSF BCS-9876543");
  });

  test("filters empty BIDS Funding entries at the source (issue #459)", () => {
    const bids = {
      Name: "Test",
      Authors: ["Doe, John"],
      Funding: ["NIH", "", "   ", "NSF"],
    };

    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids);

    // Only the two real funders survive
    expect(metadata.fundingReferences).toHaveLength(2);
    expect(metadata.fundingReferences?.[0]?.funderName).toBe("NIH");
    expect(metadata.fundingReferences?.[1]?.funderName).toBe("NSF");

    // And the downstream XML stays schema-valid
    const xml = buildDataCiteXml(metadata);
    expect(xml).not.toContain("<funderName></funderName>");
    expect(xml).not.toContain("<funderName/>");
  });

  test("filters empty enrichment fundingInfo entries (issue #459)", () => {
    const bids = { Name: "Test", Authors: ["Doe, John"] };
    const enrichment = {
      fundingInfo: [{ funderName: "Real Funder" }, { funderName: "" }, { funderName: "   " }],
    };

    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids, enrichment);

    expect(metadata.fundingReferences).toHaveLength(1);
    expect(metadata.fundingReferences?.[0]?.funderName).toBe("Real Funder");
  });

  test("filters empty BIDS Authors entries at the source (issue #459)", () => {
    const bids = {
      Name: "Test",
      Authors: ["Doe, John", "", "  ", "Smith, Jane"],
    };

    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids);

    expect(metadata.creators).toHaveLength(2);
    expect(metadata.creators[0]?.name).toBe("Doe, John");
    expect(metadata.creators[1]?.name).toBe("Smith, Jane");
  });

  test("prefers enrichment fundingInfo over BIDS Funding", () => {
    const bids = {
      Name: "Test",
      Authors: ["Doe, John"],
      Funding: ["NIH R01-NS12345"],
    };

    const enrichment = {
      fundingInfo: [
        {
          funderName: "National Institutes of Health",
          awardNumber: "R01-NS12345",
        },
      ],
    };

    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids, enrichment);

    expect(metadata.fundingReferences).toHaveLength(1);
    expect(metadata.fundingReferences?.[0]?.funderName).toBe("National Institutes of Health");
    expect(metadata.fundingReferences?.[0]?.awardNumber).toBe("R01-NS12345");
  });

  test("omits awardNumber and awardTitle from XML when whitespace-only", () => {
    const metadata: DataCiteMetadata = {
      identifier: "10.82901/NEMAR.WS",
      creators: [{ name: "Doe, John" }],
      titles: ["Test"],
      publisher: "NEMAR",
      publicationYear: 2026,
      resourceTypeGeneral: "Dataset",
      fundingReferences: [
        {
          funderName: "NIH",
          awardNumber: "   ",
          awardTitle: "  \t  ",
        },
      ],
    };

    const xml = buildDataCiteXml(metadata);
    expect(xml).not.toContain("<awardNumber");
    expect(xml).not.toContain("<awardTitle");
    expect(xml).toContain("<funderName>NIH</funderName>");
  });

  test("trims awardNumber and awardTitle in XML output", () => {
    const metadata: DataCiteMetadata = {
      identifier: "10.82901/NEMAR.TRIM",
      creators: [{ name: "Doe, John" }],
      titles: ["Test"],
      publisher: "NEMAR",
      publicationYear: 2026,
      resourceTypeGeneral: "Dataset",
      fundingReferences: [
        {
          funderName: "NIH",
          awardNumber: "  R01-NS12345  ",
          awardTitle: "  Brain Study  ",
        },
      ],
    };

    const xml = buildDataCiteXml(metadata);
    expect(xml).toContain("<awardNumber>R01-NS12345</awardNumber>");
    expect(xml).toContain("<awardTitle>Brain Study</awardTitle>");
    expect(xml).not.toContain("  R01-NS12345  ");
    expect(xml).not.toContain("  Brain Study  ");
  });

  test("parses BIDS ReferencesAndLinks as DOIs", () => {
    const bids = {
      Name: "Test",
      Authors: ["Doe, John"],
      ReferencesAndLinks: ["10.1234/paper.2024.001", "https://example.com/docs"],
    };

    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids);

    // Only DOI-like references should be included
    const doiRefs = metadata.relatedIdentifiers?.filter((r) => r.relatedIdentifierType === "DOI");
    expect(doiRefs).toHaveLength(1);
    expect(doiRefs?.[0]?.identifier).toBe("10.1234/paper.2024.001");
  });

  test("deduplicates DOIs across enrichment and BIDS ReferencesAndLinks", () => {
    const bids = {
      Name: "Test",
      Authors: ["Doe, John"],
      ReferencesAndLinks: ["https://doi.org/10.1234/paper"],
    };
    const enrichment = {
      relatedDois: [{ doi: "10.1234/paper", relationType: "References" as const }],
    };

    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids, enrichment);

    const refs = metadata.relatedIdentifiers?.filter(
      (r) => r.identifier === "10.1234/paper" && r.relationType === "References",
    );
    expect(refs).toHaveLength(1);
  });

  test("deduplicates SourceDatasets DOI and URL forms", () => {
    const bids = {
      Name: "Test",
      Authors: ["Doe, John"],
      SourceDatasets: [
        { DOI: "doi:10.13026/ym7v-bh53", URL: "https://doi.org/10.13026/ym7v-bh53" },
      ],
    };

    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids);

    const derived = metadata.relatedIdentifiers?.filter(
      (r) => r.identifier === "10.13026/ym7v-bh53" && r.relationType === "IsDerivedFrom",
    );
    expect(derived).toHaveLength(1);
    expect(derived?.[0]?.relatedIdentifierType).toBe("DOI");
  });

  test("extracts bare DOI from doi.org URL in ReferencesAndLinks", () => {
    const bids = {
      Name: "Test",
      Authors: ["Doe, John"],
      ReferencesAndLinks: ["https://doi.org/10.1109/TNSRE.2021.3082551"],
    };

    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids);

    const refs = metadata.relatedIdentifiers?.filter((r) => r.relationType === "References");
    expect(refs).toHaveLength(1);
    expect(refs?.[0]?.identifier).toBe("10.1109/TNSRE.2021.3082551");
    expect(refs?.[0]?.relatedIdentifierType).toBe("DOI");
  });

  test("preserves MeSH scheme info through bidsToDataCite to XML", () => {
    const bids = { Name: "Test", Authors: ["Doe, John"] };
    const enrichment = {
      keywords: [
        {
          value: "Electroencephalography",
          subjectScheme: "MeSH",
          schemeURI: "https://meshb.nlm.nih.gov/",
          valueURI: "https://id.nlm.nih.gov/mesh/D004569",
        },
      ],
    };

    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids, enrichment);
    const xml = buildDataCiteXml(metadata);

    expect(xml).toContain('subjectScheme="MeSH"');
    expect(xml).toContain('schemeURI="https://meshb.nlm.nih.gov/"');
    expect(xml).toContain('valueURI="https://id.nlm.nih.gov/mesh/D004569"');
    expect(xml).toContain("Electroencephalography");
  });

  test("skips empty identifiers from malformed DOI entries", () => {
    const bids = {
      Name: "Test",
      Authors: ["Doe, John"],
    };
    const enrichment = {
      relatedDois: [
        { doi: "doi:", relationType: "References" as const },
        { doi: "10.1234/valid", relationType: "References" as const },
      ],
    };

    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids, enrichment);

    const refs = metadata.relatedIdentifiers?.filter((r) => r.relationType === "References");
    expect(refs).toHaveLength(1);
    expect(refs?.[0]?.identifier).toBe("10.1234/valid");
  });
});

describe("detectModalitiesFromTree", () => {
  test("detects EEG modality from BIDS paths", () => {
    const paths = [
      "dataset_description.json",
      "sub-01/eeg/sub-01_task-rest_eeg.bdf",
      "sub-01/eeg/sub-01_task-rest_channels.tsv",
    ];
    expect(detectModalitiesFromTree(paths)).toEqual(["eeg"]);
  });

  test("detects multiple modalities", () => {
    const paths = [
      "sub-01/eeg/sub-01_eeg.bdf",
      "sub-01/anat/sub-01_T1w.nii.gz",
      "sub-02/func/sub-02_task-rest_bold.nii.gz",
    ];
    const result = detectModalitiesFromTree(paths);
    expect(result).toContain("eeg");
    expect(result).toContain("anat");
    expect(result).toContain("func");
    expect(result).toHaveLength(3);
  });

  test("deduplicates modalities", () => {
    const paths = ["sub-01/emg/sub-01_emg.bdf", "sub-02/emg/sub-02_emg.bdf"];
    expect(detectModalitiesFromTree(paths)).toEqual(["emg"]);
  });

  test("returns empty array for no BIDS paths", () => {
    expect(detectModalitiesFromTree([])).toEqual([]);
    expect(detectModalitiesFromTree(["README.md", "CHANGES"])).toEqual([]);
  });

  test("detects session-level paths", () => {
    const paths = ["sub-01/ses-01/meg/sub-01_ses-01_meg.fif"];
    expect(detectModalitiesFromTree(paths)).toEqual(["meg"]);
  });
});

describe("mapModalityToResourceType", () => {
  test("maps func to fMRI Dataset", () => {
    expect(mapModalityToResourceType("func")).toBe("fMRI Dataset");
  });

  test("maps anat to Structural MRI Dataset", () => {
    expect(mapModalityToResourceType("anat")).toBe("Structural MRI Dataset");
  });

  test("maps array with first modality", () => {
    expect(mapModalityToResourceType(["emg", "eeg"])).toBe("EMG Dataset");
  });

  test("returns generic for unknown modality", () => {
    expect(mapModalityToResourceType("beh")).toBe("Neuroimaging Dataset");
  });

  test("returns Dataset for undefined", () => {
    expect(mapModalityToResourceType(undefined)).toBe("Dataset");
  });
});

describe("parseNemarMetadata v2", () => {
  test("parses v2 with all fields", () => {
    const raw = {
      version: "2.0",
      description: "Test dataset",
      methods_description: "EMG recording",
      keywords: [{ term: "EMG", subject_scheme: "MeSH" }, { term: "hand gestures" }],
      related_identifiers: [
        { identifier: "10.1234/test", identifier_type: "DOI", relation_type: "IsDescribedBy" },
      ],
      authors: {
        "Doe, John": {
          orcid: "https://orcid.org/0000-0001-2345-6789",
          affiliations: [{ name: "MIT" }],
        },
      },
      funding_references: [{ funder_name: "NIH", award_number: "R01-123" }],
      contributors: [{ name: "Smith, Jane", contributor_type: "DataCollector" }],
      dates: [{ date: "2024-01-15", date_type: "Collected" }],
      geo_locations: [{ place: "Boston, MA", point: { latitude: 42.36, longitude: -71.06 } }],
    };
    const result = parseNemarMetadata(raw);
    expect(result).not.toBeNull();
    expect(result?.version).toBe("2.0");
    const v2 = result as NemarMetadataV2;
    expect(v2.keywords).toHaveLength(2);
    expect(v2.related_identifiers).toHaveLength(1);
    expect(v2.authors).toBeDefined();
    expect(v2.funding_references).toHaveLength(1);
    expect(v2.contributors).toHaveLength(1);
    expect(v2.dates).toHaveLength(1);
    expect(v2.geo_locations).toHaveLength(1);
  });

  test("validates author entries instead of raw casting", () => {
    const raw = {
      version: "2.0",
      authors: {
        "Valid Author": { orcid: "https://orcid.org/0000-0001-2345-6789" },
        "Bad Author": "just a string",
        "Number Author": 42,
      },
    };
    const result = parseNemarMetadata(raw);
    expect(result).not.toBeNull();
    expect(result?.version).toBe("2.0");
    const v2 = result as NemarMetadataV2;
    expect(v2.authors).toBeDefined();
    expect(Object.keys(v2.authors!)).toHaveLength(1);
    expect(v2.authors?.["Valid Author"]).toBeDefined();
  });

  test("validates author affiliations array", () => {
    const raw = {
      version: "2.0",
      authors: {
        "Test Author": {
          affiliations: [
            { name: "MIT", identifier: "https://ror.org/042nb2s44" },
            "not an object",
            { noName: true },
          ],
        },
      },
    };
    const result = parseNemarMetadata(raw);
    expect(result).not.toBeNull();
    expect(result?.version).toBe("2.0");
    const v2 = result as NemarMetadataV2;
    expect(v2.authors?.["Test Author"].affiliations).toHaveLength(1);
    expect(v2.authors?.["Test Author"].affiliations?.[0].name).toBe("MIT");
  });

  test("rejects geo_locations without place or point", () => {
    const raw = {
      version: "2.0",
      geo_locations: [
        { place: "Boston" },
        {},
        { point: { latitude: "not a number", longitude: -71 } },
        { point: { latitude: 42.36, longitude: -71.06 } },
      ],
    };
    const result = parseNemarMetadata(raw);
    expect(result).not.toBeNull();
    expect(result?.version).toBe("2.0");
    const v2 = result as NemarMetadataV2;
    expect(v2.geo_locations).toHaveLength(2);
    expect(v2.geo_locations?.[0].place).toBe("Boston");
    expect(v2.geo_locations?.[1].point?.latitude).toBe(42.36);
  });

  test("returns null for unrecognized version", () => {
    expect(parseNemarMetadata({ version: "3.0" })).toBeNull();
  });
});

describe("nemarMetadataToEnrichment v2", () => {
  test("converts v2 authors to enrichment format", () => {
    const result = nemarMetadataToEnrichment({
      version: "2.0",
      authors: {
        "Doe, John": {
          orcid: "https://orcid.org/0000-0001-2345-6789",
          affiliations: [{ name: "MIT", identifier: "https://ror.org/042nb2s44", scheme: "ROR" }],
        },
      },
    });
    expect(result.authors).toBeDefined();
    expect(result.authors?.["Doe, John"].orcid).toBe("https://orcid.org/0000-0001-2345-6789");
    expect(result.authors?.["Doe, John"].affiliation).toBe("MIT");
    expect(result.authors?.["Doe, John"].ror).toBe("https://ror.org/042nb2s44");
  });

  test("preserves v2 keyword scheme info", () => {
    const result = nemarMetadataToEnrichment({
      version: "2.0",
      keywords: [{ term: "EMG", subject_scheme: "MeSH" }, { term: "neuroscience" }],
    });
    expect(result.keywords).toHaveLength(2);
    expect(result.keywords?.[0]).toMatchObject({ value: "EMG", subjectScheme: "MeSH" });
    expect(result.keywords?.[1]).toMatchObject({ value: "neuroscience" });
  });

  test("converts v2 related_identifiers to relatedDois", () => {
    const result = nemarMetadataToEnrichment({
      version: "2.0",
      related_identifiers: [
        { identifier: "10.1234/test", identifier_type: "DOI", relation_type: "IsDescribedBy" },
        {
          identifier: "10.5678/test2",
          identifier_type: "DOI",
          relation_type: "InvalidType" as any,
        },
      ],
    });
    expect(result.relatedDois).toHaveLength(1);
    expect(result.relatedDois?.[0].doi).toBe("10.1234/test");
  });

  test("normalizes doi: prefix in v2 related_identifiers", () => {
    const result = nemarMetadataToEnrichment({
      version: "2.0",
      related_identifiers: [
        { identifier: "doi:10.1234/test", identifier_type: "DOI", relation_type: "IsDerivedFrom" },
      ],
    });
    expect(result.relatedDois).toHaveLength(1);
    expect(result.relatedDois?.[0].doi).toBe("10.1234/test");
    expect(result.relatedDois?.[0].identifierType).toBe("DOI");
  });

  test("preserves URL identifier type in v2 related_identifiers", () => {
    const result = nemarMetadataToEnrichment({
      version: "2.0",
      related_identifiers: [
        {
          identifier: "https://physionet.org/content/chbmit",
          identifier_type: "URL",
          relation_type: "IsDerivedFrom",
        },
      ],
    });
    expect(result.relatedDois).toHaveLength(1);
    expect(result.relatedDois?.[0].doi).toBe("https://physionet.org/content/chbmit");
    expect(result.relatedDois?.[0].identifierType).toBe("URL");
  });

  test("deduplicates v2 related_identifiers across DOI formats", () => {
    const result = nemarMetadataToEnrichment({
      version: "2.0",
      related_identifiers: [
        { identifier: "10.1234/test", identifier_type: "DOI", relation_type: "References" },
        { identifier: "doi:10.1234/test", identifier_type: "DOI", relation_type: "References" },
      ],
    });
    expect(result.relatedDois).toHaveLength(1);
  });

  test("converts v2 funding to enrichment format", () => {
    const result = nemarMetadataToEnrichment({
      version: "2.0",
      funding_references: [
        { funder_name: "NIH", award_number: "R01-123", award_title: "Brain Study" },
      ],
    });
    expect(result.fundingInfo).toHaveLength(1);
    expect(result.fundingInfo?.[0].funderName).toBe("NIH");
    expect(result.fundingInfo?.[0].awardNumber).toBe("R01-123");
  });

  test("extracts collection date from v2 dates", () => {
    const result = nemarMetadataToEnrichment({
      version: "2.0",
      dates: [
        { date: "2024-01-15", date_type: "Collected" },
        { date: "2024-06-01", date_type: "Issued" },
      ],
    });
    expect(result.collectionDates).toBe("2024-01-15");
  });

  test("extracts geo_location place from v2", () => {
    const result = nemarMetadataToEnrichment({
      version: "2.0",
      geo_locations: [{ place: "Shanghai, China", point: { latitude: 31.23, longitude: 121.47 } }],
    });
    expect(result.geoLocation).toBe("Shanghai, China");
  });
});

describe("validateLlmResultV2 (backend)", () => {
  test("validates full v2 response", () => {
    const result = validateLlmResultV2({
      description: "An EEG dataset for motor imagery research",
      methods_description: "128-channel EEG recorded at 512Hz",
      keywords: [{ term: "EEG", subject_scheme: "MeSH" }, { term: "BCI" }],
      funding_references: [{ funder_name: "NIH", award_number: "R01-NS12345" }],
      related_identifiers: [
        { identifier: "10.1234/paper", identifier_type: "DOI", relation_type: "IsDescribedBy" },
      ],
    });
    expect(result.description).toBe("An EEG dataset for motor imagery research");
    expect(result.methods_description).toBe("128-channel EEG recorded at 512Hz");
    expect(result.keywords).toHaveLength(2);
    expect(result.keywords?.[0]).toEqual({ term: "EEG", subject_scheme: "MeSH" });
    expect(result.keywords?.[1]).toEqual({ term: "BCI" });
    expect(result.funding_references).toHaveLength(1);
    expect(result.funding_references?.[0].funder_name).toBe("NIH");
    expect(result.related_identifiers).toHaveLength(1);
    expect(result.related_identifiers?.[0].relation_type).toBe("IsDescribedBy");
  });

  test("accepts plain string keywords", () => {
    const result = validateLlmResultV2({
      keywords: ["EEG", "motor imagery", "BIDS"],
    });
    expect(result.keywords).toHaveLength(3);
    expect(result.keywords?.[0]).toEqual({ term: "EEG" });
  });

  test("filters invalid related identifiers", () => {
    const result = validateLlmResultV2({
      related_identifiers: [
        { identifier: "10.1234/valid", identifier_type: "DOI", relation_type: "Cites" },
        { identifier: "not-a-doi", identifier_type: "DOI", relation_type: "Cites" },
        { identifier: "10.1234/bad-type", identifier_type: "DOI", relation_type: "InvalidType" },
      ],
    });
    expect(result.related_identifiers).toHaveLength(1);
    expect(result.related_identifiers?.[0].identifier).toBe("10.1234/valid");
  });

  test("filters invalid funding references", () => {
    const result = validateLlmResultV2({
      funding_references: [
        { funder_name: "NIH", award_number: "R01" },
        { not_funder: "bad" },
        null,
      ],
    });
    expect(result.funding_references).toHaveLength(1);
  });

  test("empty object returns empty result", () => {
    expect(validateLlmResultV2({})).toEqual({});
  });
});

describe("mergeWithExisting", () => {
  test("preserves author ORCIDs from existing metadata", () => {
    const existing = {
      version: "2.0" as const,
      authors: {
        "Doe, John": {
          orcid: "https://orcid.org/0000-0001-2345-6789",
          affiliations: [{ name: "MIT" }],
        },
      },
      description: "Old description",
    };
    const llmResult = {
      description: "New LLM description",
      keywords: [{ term: "EEG" }],
    };

    const merged = mergeWithExisting(existing, llmResult);

    expect(merged.version).toBe("2.0");
    expect(merged.description).toBe("New LLM description");
    expect(merged.keywords).toHaveLength(1);
    expect(merged.authors).toBeDefined();
    expect(merged.authors?.["Doe, John"].orcid).toBe("https://orcid.org/0000-0001-2345-6789");
  });

  test("works with null existing metadata", () => {
    const llmResult = {
      description: "A new dataset",
      keywords: [{ term: "MEG" }],
    };

    const merged = mergeWithExisting(null, llmResult);

    expect(merged.version).toBe("2.0");
    expect(merged.description).toBe("A new dataset");
    expect(merged.authors).toBeUndefined();
  });

  test("LLM fields overwrite existing non-author fields", () => {
    const existing = {
      version: "2.0" as const,
      description: "Old description",
      keywords: [{ term: "old keyword" }],
    };
    const llmResult = {
      description: "Updated description",
      keywords: [{ term: "new keyword" }],
    };

    const merged = mergeWithExisting(existing, llmResult);

    expect(merged.description).toBe("Updated description");
    expect(merged.keywords).toHaveLength(1);
    expect(merged.keywords?.[0].term).toBe("new keyword");
  });

  test("BIDS-seeded related_identifiers take priority over LLM for same DOI", () => {
    const existing = {
      version: "2.0" as const,
      pipeline_stage: "seeded" as const,
      related_identifiers: [
        {
          identifier: "10.13026/ym7v-bh53",
          identifier_type: "DOI" as const,
          relation_type: "IsDerivedFrom",
        },
      ],
    };
    const llmResult = {
      related_identifiers: [
        {
          identifier: "10.1109/TNSRE.2021.3082551",
          identifier_type: "DOI" as const,
          relation_type: "IsDescribedBy",
        },
        // Duplicate of BIDS-seeded entry with different relation type (LLM might misclassify)
        {
          identifier: "10.13026/ym7v-bh53",
          identifier_type: "DOI" as const,
          relation_type: "IsVersionOf",
        },
      ],
    };

    const merged = mergeWithExisting(existing, llmResult);

    // Should have 2 entries: BIDS IsDerivedFrom preserved, LLM IsVersionOf dropped (same identifier), new IsDescribedBy added
    expect(merged.related_identifiers).toHaveLength(2);
    expect(merged.related_identifiers?.[0].relation_type).toBe("IsDerivedFrom");
    expect(merged.related_identifiers?.[1].relation_type).toBe("IsDescribedBy");
    expect(merged.pipeline_stage).toBe("enriched");
  });

  test("LLM upgrades a seeded References entry to IsDescribedBy (#826)", () => {
    // ReferencesAndLinks seeds every DOI as "References"; the LLM must be able
    // to promote the dataset's own data paper to IsDescribedBy on re-enrichment.
    const existing = {
      version: "2.0" as const,
      pipeline_stage: "seeded" as const,
      related_identifiers: [
        {
          identifier: "10.1038/sdata.2015.1",
          identifier_type: "DOI" as const,
          relation_type: "References",
        },
      ],
    };
    const llmResult = {
      related_identifiers: [
        {
          identifier: "10.1038/sdata.2015.1",
          identifier_type: "DOI" as const,
          relation_type: "IsDescribedBy",
        },
      ],
    };

    const merged = mergeWithExisting(existing, llmResult);

    expect(merged.related_identifiers).toHaveLength(1);
    expect(merged.related_identifiers?.[0].relation_type).toBe("IsDescribedBy");
  });

  test("LLM downgrades a wrongly-tagged IsDescribedBy DOI to References (#826)", () => {
    // A prior run tagged a standards paper (e.g. iEEG-BIDS) as the data paper;
    // re-enrichment must be able to correct it.
    const existing = {
      version: "2.0" as const,
      pipeline_stage: "enriched" as const,
      related_identifiers: [
        {
          identifier: "10.1038/s41597-019-0105-7",
          identifier_type: "DOI" as const,
          relation_type: "IsDescribedBy",
        },
      ],
    };
    const llmResult = {
      related_identifiers: [
        {
          identifier: "10.1038/s41597-019-0105-7",
          identifier_type: "DOI" as const,
          relation_type: "References",
        },
      ],
    };

    const merged = mergeWithExisting(existing, llmResult);

    expect(merged.related_identifiers).toHaveLength(1);
    expect(merged.related_identifiers?.[0].relation_type).toBe("References");
  });

  test("URL related_identifiers are locked against LLM reclassification", () => {
    const existing = {
      version: "2.0" as const,
      pipeline_stage: "seeded" as const,
      related_identifiers: [
        {
          identifier: "https://github.com/nemarDatasets/nm000001",
          identifier_type: "URL" as const,
          relation_type: "IsDescribedBy",
        },
      ],
    };
    const llmResult = {
      related_identifiers: [
        {
          identifier: "https://github.com/nemarDatasets/nm000001",
          identifier_type: "DOI" as const,
          relation_type: "References",
        },
      ],
    };

    const merged = mergeWithExisting(existing, llmResult);

    expect(merged.related_identifiers).toHaveLength(1);
    expect(merged.related_identifiers?.[0].relation_type).toBe("IsDescribedBy");
    expect(merged.related_identifiers?.[0].identifier_type).toBe("URL");
  });

  test("LLM-parsed funding replaces raw BIDS strings when award number matches", () => {
    const existing = {
      version: "2.0" as const,
      pipeline_stage: "seeded" as const,
      funding_references: [
        { funder_name: "Shanghai Municipal Science and Technology Major Project (2017SHZDZX01)" },
        { funder_name: "NIH (R01-NS99999)" },
      ],
    };
    const llmResult = {
      funding_references: [
        {
          funder_name: "Shanghai Municipal Science and Technology Commission",
          award_number: "2017SHZDZX01",
        },
        { funder_name: "NIH", award_number: "R01-NS99999" },
        { funder_name: "NSF", award_number: "BCS-12345" },
      ],
    };

    const merged = mergeWithExisting(existing, llmResult);

    // Raw BIDS strings replaced by LLM-parsed versions (2 replaced + 1 new = 3 total)
    expect(merged.funding_references).toHaveLength(3);
    expect(merged.funding_references?.some((f) => f.award_number === "2017SHZDZX01")).toBe(true);
    expect(merged.funding_references?.some((f) => f.award_number === "R01-NS99999")).toBe(true);
    expect(merged.funding_references?.some((f) => f.award_number === "BCS-12345")).toBe(true);
    // Raw BIDS strings should be gone
    expect(merged.funding_references?.some((f) => f.funder_name.includes("(2017SHZDZX01)"))).toBe(
      false,
    );
    expect(merged.pipeline_stage).toBe("enriched");
  });
});

describe("seedFromBids", () => {
  const fullBids = {
    Name: "HySER Dataset",
    BIDSVersion: "1.11.0",
    DatasetType: "raw",
    License: "ODC-By-1.0",
    Authors: ["Xinyu Jiang", "Chenyun Dai", "Xiangyu Liu", "Jiahao Fan"],
    ReferencesAndLinks: [
      "https://doi.org/10.1109/TNSRE.2021.3082551",
      "https://physionet.org/content/hd-semg/1.0.0/",
    ],
    DatasetDOI: "doi:10.13026/ym7v-bh53",
    Funding: [
      "Shanghai Municipal Science and Technology Major Project (2017SHZDZX01)",
      "Shanghai Pujiang Program (19PJ1401100)",
    ],
    SourceDatasets: [
      {
        URL: "https://physionet.org/content/hd-semg/1.0.0/",
        DOI: "doi:10.13026/ym7v-bh53",
        Version: "1.0.0",
      },
    ],
  };

  test("extracts all authors from BIDS", () => {
    const seeded = seedFromBids(fullBids, null);

    expect(seeded.pipeline_stage).toBe("seeded");
    expect(seeded.authors).toBeDefined();
    expect(Object.keys(seeded.authors!)).toHaveLength(4);
    expect(seeded.authors?.["Xinyu Jiang"]).toEqual({});
    expect(seeded.authors?.["Jiahao Fan"]).toEqual({});
  });

  test("preserves existing ORCIDs when seeding", () => {
    const existing = {
      version: "2.0" as const,
      authors: {
        "Xinyu Jiang": { orcid: "https://orcid.org/0000-0001-2345-6789" },
      },
    };

    const seeded = seedFromBids(fullBids, existing);

    expect(Object.keys(seeded.authors!)).toHaveLength(4);
    expect(seeded.authors?.["Xinyu Jiang"].orcid).toBe("https://orcid.org/0000-0001-2345-6789");
    expect(seeded.authors?.["Chenyun Dai"]).toEqual({});
  });

  test("SourceDatasets mapped to IsDerivedFrom", () => {
    const seeded = seedFromBids(fullBids, null);

    const isDerivedFrom = seeded.related_identifiers?.filter(
      (r) => r.relation_type === "IsDerivedFrom",
    );
    expect(isDerivedFrom).toHaveLength(1);
    expect(isDerivedFrom?.[0].identifier).toBe("10.13026/ym7v-bh53");
    expect(isDerivedFrom?.[0].identifier_type).toBe("DOI");
  });

  test("ReferencesAndLinks DOIs mapped to References", () => {
    const seeded = seedFromBids(fullBids, null);

    const references = seeded.related_identifiers?.filter((r) => r.relation_type === "References");
    expect(references).toHaveLength(1);
    expect(references?.[0].identifier).toBe("10.1109/TNSRE.2021.3082551");
  });

  test("Funding strings extracted as raw funding references", () => {
    const seeded = seedFromBids(fullBids, null);

    expect(seeded.funding_references).toHaveLength(2);
    expect(seeded.funding_references?.[0].funder_name).toContain("Shanghai");
  });

  test("DatasetType sets resource_type_general and dataset_type", () => {
    const seeded = seedFromBids(fullBids, null);
    expect(seeded.resource_type_general).toBe("Dataset");
    expect(seeded.dataset_type).toBe("raw");
  });

  test("title extracted from BIDS Name", () => {
    const seeded = seedFromBids(fullBids, null);
    expect(seeded.title).toBe("HySER Dataset");
  });

  test("license extracted from BIDS License", () => {
    const seeded = seedFromBids(fullBids, null);
    expect(seeded.license).toBe("ODC-By-1.0");
  });

  test("modalities detected from tree paths", () => {
    const treePaths = [
      "dataset_description.json",
      "sub-001/emg/sub-001_task-gesture_emg.edf",
      "sub-001/beh/sub-001_task-gesture_events.tsv",
    ];
    const seeded = seedFromBids(fullBids, null, "nm000108", treePaths);

    expect(seeded.modalities).toContain("emg");
    expect(seeded.modalities).toContain("beh");
    expect(seeded.resource_type_specific).toBe("EMG Dataset");
  });

  test("modalities not set when tree paths not provided", () => {
    const seeded = seedFromBids(fullBids, null);
    expect(seeded.modalities).toBeUndefined();
    expect(seeded.resource_type_specific).toBeUndefined();
  });

  test("empty BIDS returns minimal metadata", () => {
    const seeded = seedFromBids({}, null);

    expect(seeded.version).toBe("2.0");
    expect(seeded.pipeline_stage).toBe("seeded");
    expect(seeded.authors).toBeUndefined();
    expect(seeded.related_identifiers).toBeUndefined();
    expect(seeded.funding_references).toBeUndefined();
  });

  test("does not duplicate existing related_identifiers", () => {
    const existing = {
      version: "2.0" as const,
      related_identifiers: [
        {
          identifier: "10.13026/ym7v-bh53",
          identifier_type: "DOI" as const,
          relation_type: "IsDerivedFrom",
        },
      ],
    };

    const seeded = seedFromBids(fullBids, existing);

    const isDerivedFrom = seeded.related_identifiers?.filter(
      (r) => r.identifier === "10.13026/ym7v-bh53" && r.relation_type === "IsDerivedFrom",
    );
    expect(isDerivedFrom).toHaveLength(1);
  });

  test("adds GitHub repo and NEMAR landing page URLs when datasetId is provided", () => {
    const seeded = seedFromBids(fullBids, null, "nm000108");

    const githubEntry = seeded.related_identifiers?.find(
      (r) => r.identifier === "https://github.com/nemarDatasets/nm000108",
    );
    expect(githubEntry).toBeDefined();
    expect(githubEntry?.identifier_type).toBe("URL");
    expect(githubEntry?.relation_type).toBe("IsDescribedBy");

    const nemarEntry = seeded.related_identifiers?.find(
      (r) => r.identifier === "https://nemar.org/dataset/nm000108",
    );
    expect(nemarEntry).toBeDefined();
    expect(nemarEntry?.identifier_type).toBe("URL");
    expect(nemarEntry?.relation_type).toBe("IsDescribedBy");
  });

  test("re-enrichment replaces the legacy NEMAR landing URL with the canonical one (#837)", () => {
    const existing = {
      version: "2.0" as const,
      related_identifiers: [
        {
          identifier: "https://nemar.org/dataexplorer/detail?dataset_id=nm000108",
          identifier_type: "URL" as const,
          relation_type: "IsDescribedBy" as const,
        },
      ],
    };
    const seeded = seedFromBids(fullBids, existing, "nm000108");
    const nemarUrls = (seeded.related_identifiers || []).filter((r) =>
      r.identifier.includes("nemar.org"),
    );
    // exactly one NEMAR landing URL, and it's the canonical one (no accumulation)
    expect(nemarUrls).toHaveLength(1);
    expect(nemarUrls[0]?.identifier).toBe("https://nemar.org/dataset/nm000108");
    expect(seeded.related_identifiers?.some((r) => r.identifier.includes("dataexplorer"))).toBe(
      false,
    );
  });

  test("does not add URLs when datasetId is not provided", () => {
    const seeded = seedFromBids(fullBids, null);

    const githubEntries = seeded.related_identifiers?.filter((r) =>
      r.identifier.includes("github.com/nemarDatasets/"),
    );
    expect(githubEntries?.length ?? 0).toBe(0);
  });

  test("removes conflicting relation types for SourceDataset DOIs from prior runs", () => {
    const existing = {
      version: "2.0" as const,
      related_identifiers: [
        // Prior LLM run incorrectly classified as IsVersionOf
        {
          identifier: "10.13026/ym7v-bh53",
          identifier_type: "DOI" as const,
          relation_type: "IsVersionOf",
        },
        // Another unrelated entry that should be preserved
        {
          identifier: "10.1109/TNSRE.2021.3082551",
          identifier_type: "DOI" as const,
          relation_type: "IsDescribedBy",
        },
      ],
    };

    const seeded = seedFromBids(fullBids, existing);

    // IsVersionOf for SourceDataset DOI should be removed, replaced with IsDerivedFrom
    expect(
      seeded.related_identifiers?.some(
        (r) => r.identifier === "10.13026/ym7v-bh53" && r.relation_type === "IsVersionOf",
      ),
    ).toBe(false);
    expect(
      seeded.related_identifiers?.some(
        (r) => r.identifier === "10.13026/ym7v-bh53" && r.relation_type === "IsDerivedFrom",
      ),
    ).toBe(true);
    // Unrelated entry preserved
    expect(
      seeded.related_identifiers?.some(
        (r) => r.identifier === "10.1109/TNSRE.2021.3082551" && r.relation_type === "IsDescribedBy",
      ),
    ).toBe(true);
  });
});

describe("parseValidationResult", () => {
  test("parses valid full result", () => {
    const raw = {
      overall_pass: true,
      criteria: {
        author_completeness: { confidence: 95, pass: true, issues: [] },
        related_identifiers: {
          confidence: 90,
          pass: true,
          issues: [],
          suggestions: ["Add paper DOI"],
        },
        description_accuracy: { confidence: 85, pass: true, issues: [] },
        keyword_relevance: { confidence: 80, pass: true, issues: [] },
        funding_accuracy: { confidence: 70, pass: true, issues: [] },
        data_type: { confidence: 100, pass: true, issues: [] },
      },
      blocking_issues: [],
      warnings: ["Consider adding MeSH subject schemes"],
    };

    const result = parseValidationResult(raw);

    expect(result.valid).toBe(true);
    expect(result.blocking_issues).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.criteria.author_completeness.confidence).toBe(95);
    expect(result.criteria.related_identifiers.suggestions).toEqual(["Add paper DOI"]);
  });

  test("parses failing result with blocking issues", () => {
    const raw = {
      overall_pass: false,
      criteria: {
        author_completeness: {
          confidence: 30,
          pass: false,
          issues: ["Missing author: Jane Smith"],
        },
        related_identifiers: {
          confidence: 40,
          pass: false,
          issues: ["Wrong relation type for PhysioNet DOI"],
        },
        description_accuracy: { confidence: 80, pass: true, issues: [] },
        keyword_relevance: { confidence: 70, pass: true, issues: [] },
        funding_accuracy: { confidence: 60, pass: true, issues: [] },
        data_type: { confidence: 100, pass: true, issues: [] },
      },
      blocking_issues: ["Missing author: Jane Smith", "Incorrect relation type"],
      warnings: [],
    };

    const result = parseValidationResult(raw);

    expect(result.valid).toBe(false);
    expect(result.blocking_issues).toHaveLength(2);
    expect(result.criteria.author_completeness.pass).toBe(false);
  });

  test("handles missing criteria gracefully", () => {
    const raw = {
      overall_pass: true,
      criteria: {},
      blocking_issues: [],
      warnings: [],
    };

    const result = parseValidationResult(raw);

    expect(result.valid).toBe(true);
    expect(result.criteria.author_completeness.confidence).toBe(0);
    expect(result.criteria.author_completeness.pass).toBe(false);
    expect(result.criteria.author_completeness.issues).toEqual([]);
  });

  test("infers valid from populated criteria and empty blocking_issues when overall_pass missing", () => {
    const raw = {
      criteria: {
        author_completeness: { confidence: 90, pass: true, issues: [] },
      },
      blocking_issues: [],
      warnings: ["Some warning"],
    };

    const result = parseValidationResult(raw);
    expect(result.valid).toBe(true);
  });

  test("treats empty criteria with no overall_pass as invalid (malformed LLM response)", () => {
    const raw = {
      criteria: {},
      blocking_issues: [],
      warnings: ["Some warning"],
    };

    const result = parseValidationResult(raw);
    expect(result.valid).toBe(false);
  });

  test("infers invalid from blocking_issues when overall_pass missing", () => {
    const raw = {
      criteria: {
        description_accuracy: { confidence: 50, pass: false, issues: ["Inaccurate"] },
      },
      blocking_issues: ["A blocking issue"],
      warnings: [],
    };

    const result = parseValidationResult(raw);
    expect(result.valid).toBe(false);
  });
});

describe("parseNemarMetadata pipeline_stage", () => {
  test("parses valid pipeline_stage", () => {
    const meta = parseNemarMetadata({
      version: "2.0",
      pipeline_stage: "validated",
      description: "Test",
    });
    expect(meta?.version).toBe("2.0");
    expect((meta as NemarMetadataV2).pipeline_stage).toBe("validated");
  });

  test("ignores invalid pipeline_stage", () => {
    const meta = parseNemarMetadata({
      version: "2.0",
      pipeline_stage: "invalid_stage",
      description: "Test",
    });
    expect(meta?.version).toBe("2.0");
    expect((meta as NemarMetadataV2).pipeline_stage).toBeUndefined();
  });

  test("handles missing pipeline_stage", () => {
    const meta = parseNemarMetadata({
      version: "2.0",
      description: "Test",
    });
    expect(meta?.version).toBe("2.0");
    expect((meta as NemarMetadataV2).pipeline_stage).toBeUndefined();
  });
});

describe("seedFromBids SourceDatasets URL fallback", () => {
  test("extracts DOI from SourceDatasets URL when DOI field is absent", () => {
    const bids = {
      Name: "Test",
      SourceDatasets: [{ URL: "https://doi.org/10.13026/ym7v-bh53" }],
    };
    const result = seedFromBids(bids, null);
    const derived = result.related_identifiers?.find((r) => r.relation_type === "IsDerivedFrom");
    expect(derived).toBeDefined();
    expect(derived?.identifier).toBe("10.13026/ym7v-bh53");
  });

  test("extracts DOI from SourceDatasets URL with doi: prefix", () => {
    const bids = {
      Name: "Test",
      SourceDatasets: [{ URL: "doi:10.13026/ym7v-bh53" }],
    };
    const result = seedFromBids(bids, null);
    const derived = result.related_identifiers?.find((r) => r.relation_type === "IsDerivedFrom");
    expect(derived).toBeDefined();
    expect(derived?.identifier).toBe("10.13026/ym7v-bh53");
  });

  test("ignores SourceDatasets with non-DOI URL", () => {
    const bids = {
      Name: "Test",
      SourceDatasets: [{ URL: "https://example.com/dataset" }],
    };
    const result = seedFromBids(bids, null);
    const derived = (result.related_identifiers || []).filter(
      (r) => r.relation_type === "IsDerivedFrom",
    );
    expect(derived).toHaveLength(0);
  });
});

describe("buildDataCiteXml sizes (#1225 review)", () => {
  /**
   * `sizes` is seeded by enrich-dataset's Stage 1a from
   * `formatFileSize(s3Stats.totalSize)`, which returns null for a
   * non-positive total (a metadata-only dataset, or enrichment running
   * before the S3 objects land). The formatter it replaced returned a string
   * for every input, so an unguarded interpolation put the literal
   * "null (0 files)" into a MINTED DOI record. The call site now omits the
   * field instead. These rows pin the publishing layer's half: an absent
   * `sizes` produces no element at all, so omitting is safe. The other half
   * (`formatFileSize(0)` is null) is pinned in
   * test/catalog-sync-from-enrichment.unit.test.ts; the guard between them is
   * a one-line `if` with no S3-and-D1 harness to drive it end to end.
   */
  const base = (): DataCiteMetadata => ({
    identifier: "10.82901/NEMAR.SIZES",
    creators: [{ name: "Shirazi, Yahya" }],
    titles: ["Sizes fixture"],
    publisher: "NEMAR",
    publicationYear: 2026,
    resourceTypeGeneral: "Dataset",
  });

  test("a real size is emitted", () => {
    const xml = buildDataCiteXml({ ...base(), sizes: ["4.31 GB (12 files)"] });
    expect(xml).toContain("<sizes>");
    expect(xml).toContain("<size>4.31 GB (12 files)</size>");
  });

  test("an omitted size emits no sizes element, and never a stringified null", () => {
    const xml = buildDataCiteXml(base());
    expect(xml).not.toContain("<sizes>");
    expect(xml).not.toContain("null (");
  });
});
