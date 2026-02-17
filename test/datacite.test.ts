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
  detectModalitiesFromTree,
  parseNemarMetadata,
  nemarMetadataToEnrichment,
  type DataCiteMetadata,
  type DataCiteCreator,
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
      subjects: [{ value: "EEG" }, { value: "BIDS" }],
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
      geoLocations: [{ place: "San Diego, CA" }],
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
        publicationYear: NaN,
        resourceTypeGeneral: "Dataset",
      }),
    ).toThrow("publicationYear must be a valid number");
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
      keywords: ["EEG", "motor imagery"],
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

  test("prefers enrichment fundingInfo over BIDS Funding", () => {
    const bids = {
      Name: "Test",
      Authors: ["Doe, John"],
      Funding: ["NIH R01-NS12345"],
    };

    const enrichment = {
      fundingInfo: [{
        funderName: "National Institutes of Health",
        awardNumber: "R01-NS12345",
      }],
    };

    const metadata = bidsToDataCite("nm000103", "10.82901/NEMAR.ABC", bids, enrichment);

    expect(metadata.fundingReferences).toHaveLength(1);
    expect(metadata.fundingReferences?.[0]?.funderName).toBe("National Institutes of Health");
    expect(metadata.fundingReferences?.[0]?.awardNumber).toBe("R01-NS12345");
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
    const paths = [
      "sub-01/emg/sub-01_emg.bdf",
      "sub-02/emg/sub-02_emg.bdf",
    ];
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
      keywords: [
        { term: "EMG", subject_scheme: "MeSH" },
        { term: "hand gestures" },
      ],
      related_identifiers: [
        { identifier: "10.1234/test", identifier_type: "DOI", relation_type: "IsDescribedBy" },
      ],
      authors: {
        "Doe, John": { orcid: "https://orcid.org/0000-0001-2345-6789", affiliations: [{ name: "MIT" }] },
      },
      funding_references: [
        { funder_name: "NIH", award_number: "R01-123" },
      ],
      contributors: [
        { name: "Smith, Jane", contributor_type: "DataCollector" },
      ],
      dates: [
        { date: "2024-01-15", date_type: "Collected" },
      ],
      geo_locations: [
        { place: "Boston, MA", point: { latitude: 42.36, longitude: -71.06 } },
      ],
    };
    const result = parseNemarMetadata(raw);
    expect(result).not.toBeNull();
    expect(result!.version).toBe("2.0");
    if (result!.version === "2.0") {
      expect(result!.keywords).toHaveLength(2);
      expect(result!.related_identifiers).toHaveLength(1);
      expect(result!.authors).toBeDefined();
      expect(result!.funding_references).toHaveLength(1);
      expect(result!.contributors).toHaveLength(1);
      expect(result!.dates).toHaveLength(1);
      expect(result!.geo_locations).toHaveLength(1);
    }
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
    if (result!.version === "2.0") {
      expect(result!.authors).toBeDefined();
      expect(Object.keys(result!.authors!)).toHaveLength(1);
      expect(result!.authors!["Valid Author"]).toBeDefined();
    }
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
    if (result!.version === "2.0") {
      expect(result!.authors!["Test Author"].affiliations).toHaveLength(1);
      expect(result!.authors!["Test Author"].affiliations![0].name).toBe("MIT");
    }
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
    if (result!.version === "2.0") {
      expect(result!.geo_locations).toHaveLength(2);
      expect(result!.geo_locations![0].place).toBe("Boston");
      expect(result!.geo_locations![1].point!.latitude).toBe(42.36);
    }
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
    expect(result.authors!["Doe, John"].orcid).toBe("https://orcid.org/0000-0001-2345-6789");
    expect(result.authors!["Doe, John"].affiliation).toBe("MIT");
    expect(result.authors!["Doe, John"].ror).toBe("https://ror.org/042nb2s44");
  });

  test("converts v2 keywords to plain strings", () => {
    const result = nemarMetadataToEnrichment({
      version: "2.0",
      keywords: [
        { term: "EMG", subject_scheme: "MeSH" },
        { term: "neuroscience" },
      ],
    });
    expect(result.keywords).toEqual(["EMG", "neuroscience"]);
  });

  test("converts v2 related_identifiers to relatedDois", () => {
    const result = nemarMetadataToEnrichment({
      version: "2.0",
      related_identifiers: [
        { identifier: "10.1234/test", identifier_type: "DOI", relation_type: "IsDescribedBy" },
        { identifier: "10.5678/test2", identifier_type: "DOI", relation_type: "InvalidType" as any },
      ],
    });
    expect(result.relatedDois).toHaveLength(1);
    expect(result.relatedDois![0].doi).toBe("10.1234/test");
  });

  test("converts v2 funding to enrichment format", () => {
    const result = nemarMetadataToEnrichment({
      version: "2.0",
      funding_references: [
        { funder_name: "NIH", award_number: "R01-123", award_title: "Brain Study" },
      ],
    });
    expect(result.fundingInfo).toHaveLength(1);
    expect(result.fundingInfo![0].funderName).toBe("NIH");
    expect(result.fundingInfo![0].awardNumber).toBe("R01-123");
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
      geo_locations: [
        { place: "Shanghai, China", point: { latitude: 31.23, longitude: 121.47 } },
      ],
    });
    expect(result.geoLocation).toBe("Shanghai, China");
  });
});
