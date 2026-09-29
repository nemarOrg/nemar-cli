import { describe, expect, test } from "bun:test";
import {
  enforceNeverDataPaper,
  mergeWithExisting,
  seedFromBids,
} from "../backend/src/services/llm-enrich.js";
import type { RelatedIdentifierEntry } from "../shared/datacite-constants.js";
import {
  isNeverDataPaperDoi,
  isOwnNemarDoi,
  isStandardSpecTitle,
  normalizeDoiKey,
} from "../shared/never-data-paper.js";

// Every DOI and title below is real. The mislabels are ones observed in live
// `.nemar/metadata.json` files (#1549): MNE-BIDS and EEG-BIDS tagged
// IsDescribedBy on dozens of datasets, and nm000275's own Scientific Data
// descriptor, which must stay untouched by the guard.
const EEG_BIDS = "10.1038/s41597-019-0104-8";
const MNE_BIDS = "10.21105/joss.01896";
const NM000275_DATA_PAPER = "10.1038/s41597-019-0027-4";

const doi = (identifier: string, relation_type: string): RelatedIdentifierEntry => ({
  identifier,
  identifier_type: "DOI",
  relation_type,
});

describe("normalizeDoiKey / isNeverDataPaperDoi", () => {
  test("strips resolver prefixes and case so every spelling matches", () => {
    expect(normalizeDoiKey("https://doi.org/10.1038/S41597-019-0104-8")).toBe(EEG_BIDS);
    expect(normalizeDoiKey("http://doi.org/10.1038/S41597-019-0104-8")).toBe(EEG_BIDS);
    expect(normalizeDoiKey("http://dx.doi.org/10.1038/S41597-019-0104-8")).toBe(EEG_BIDS);
    expect(normalizeDoiKey("doi:10.21105/JOSS.01896 ")).toBe(MNE_BIDS);
    expect(isNeverDataPaperDoi("https://dx.doi.org/10.3389/FNINF.2015.00016")).toBe(true);
    expect(isNeverDataPaperDoi(NM000275_DATA_PAPER)).toBe(false);
  });

  test("trims prose punctuation and unmatched parentheses, keeping balanced ones", () => {
    // A real SICI-era Biological Psychiatry DOI shape: its parentheses are
    // part of the DOI and must survive.
    const sici = "10.1016/s0006-3223(99)00000-0";
    expect(normalizeDoiKey("10.1016/S0006-3223(99)00000-0")).toBe(sici);
    expect(normalizeDoiKey("10.1016/S0006-3223(99)00000-0)")).toBe(sici);
    expect(normalizeDoiKey("10.1016/S0006-3223(99)00000-0).")).toBe(sici);
    expect(normalizeDoiKey("https://doi.org/10.1038/sdata.2016.44);")).toBe(
      "10.1038/sdata.2016.44",
    );
    expect(normalizeDoiKey("doi:10.21105/joss.01896,")).toBe(MNE_BIDS);
  });

  test("lists NIRS-BIDS", () => {
    expect(isNeverDataPaperDoi("10.1038/s41597-024-04136-9")).toBe(true);
  });
});

describe("isOwnNemarDoi", () => {
  test("matches the concept and version DOIs of the same dataset only", () => {
    expect(isOwnNemarDoi("10.82901/nemar.on008862", "on008862")).toBe(true);
    expect(isOwnNemarDoi("10.82901/nemar.on008862.v1.0.0", "on008862")).toBe(true);
    expect(isOwnNemarDoi(normalizeDoiKey("doi:10.82901/NEMAR.ON008862"), "on008862")).toBe(true);
    // Another dataset's DOI, including one that shares a prefix, is a real relation.
    expect(isOwnNemarDoi("10.82901/nemar.on0088620", "on008862")).toBe(false);
    expect(isOwnNemarDoi("10.82901/nemar.on007655", "on008862")).toBe(false);
    expect(isOwnNemarDoi("10.82901/nemar.on008862", undefined)).toBe(false);
  });
});

describe("isStandardSpecTitle", () => {
  test("matches published BIDS specification titles (name form)", () => {
    for (const title of [
      "EEG-BIDS, an extension to the brain imaging data structure for electroencephalography",
      "MEG-BIDS, the brain imaging data structure extended to magnetoencephalography",
      "iEEG-BIDS, extending the Brain Imaging Data Structure specification to human intracranial electrophysiology",
      "Motion-BIDS: an extension to the brain imaging data structure to organize motion data for reproducible research",
      "NIRS-BIDS: Brain Imaging Data Structure Extended to Near-Infrared Spectroscopy",
      "ASL-BIDS, the brain imaging data structure extension for arterial spin labeling",
      "BIDS apps: Improving ease of use, accessibility, and reproducibility of neuroimaging data analysis methods",
      "  MNE-BIDS: Organizing electrophysiological data into the BIDS format and facilitating their analysis",
    ]) {
      expect(isStandardSpecTitle(title)).toBe(true);
    }
  });

  test("matches the phrase form only at the start of the title", () => {
    // The first title is the real BIDS paper. Every published extension uses
    // the name form, so the other two are constructed: they are the shapes
    // the phrase rule exists for, and nothing in the catalog can falsify it.
    for (const title of [
      "The brain imaging data structure, a format for organizing and describing outputs of neuroimaging experiments",
      "An extension to the Brain Imaging Data Structure for electromyography",
      "Extending the Brain Imaging Data Structure to eye tracking",
    ]) {
      expect(isStandardSpecTitle(title)).toBe(true);
    }
  });

  test("does not match data papers that mention BIDS or an extension", () => {
    for (const title of [
      "Multi-channel EEG recordings during a sustained-attention driving task",
      "An open-access EEG dataset in BIDS format for motor imagery",
      "HBN-EEG: The FAIR implementation of the Healthy Brain Network (HBN) electroencephalography dataset",
      "An extended EEG dataset of visual working memory, organized in the Brain Imaging Data Structure",
      "A dataset extending the Brain Imaging Data Structure with HED annotations",
      "A multi-subject EEG dataset organized following the Brain Imaging Data Structure extension for EEG",
      "BIDS-formatted EEG recordings during a visual oddball task",
      // Not a name-form title; PyBIDS is caught by its DOI instead.
      "PyBIDS: Python tools for BIDS datasets",
      undefined,
      "",
    ]) {
      expect(isStandardSpecTitle(title)).toBe(false);
    }
  });
});

describe("enforceNeverDataPaper", () => {
  test("demotes a standards paper the LLM merged in as IsDescribedBy", () => {
    const seeded = seedFromBids(
      { Name: "Test", ReferencesAndLinks: [`https://doi.org/${EEG_BIDS}`] },
      null,
    );
    // The LLM reclassifies the seeded References entry to IsDescribedBy (the
    // #826 triad allows it) and adds MNE-BIDS as a "data paper".
    const merged = mergeWithExisting(seeded, {
      related_identifiers: [doi(EEG_BIDS, "IsDescribedBy"), doi(MNE_BIDS, "IsSupplementTo")],
    });
    const { result, demoted } = enforceNeverDataPaper(merged);
    expect(result.related_identifiers).toEqual([
      doi(EEG_BIDS, "References"),
      doi(MNE_BIDS, "References"),
    ]);
    expect(demoted.map((d) => d.relation_type)).toEqual(["IsDescribedBy", "IsSupplementTo"]);
  });

  test("demotes a BIDS SourceDatasets entry and a carried-forward mislabel", () => {
    // SourceDatasets seeds IsDerivedFrom deterministically; an older
    // metadata.json carries MNE-BIDS forward as IsDescribedBy in upper case.
    const seeded = seedFromBids(
      { Name: "Test", SourceDatasets: [{ DOI: `doi:${EEG_BIDS}` }] },
      {
        version: "2.0",
        related_identifiers: [doi("10.21105/JOSS.01896", "IsDescribedBy")],
      },
    );
    const { result } = enforceNeverDataPaper(seeded);
    expect(result.related_identifiers).toEqual([
      doi("10.21105/JOSS.01896", "References"),
      doi(EEG_BIDS, "References"),
    ]);
  });

  test("leaves the data paper, URL landing pages, and other relations alone", () => {
    const seeded = seedFromBids({ Name: "Test" }, null, "nm000275");
    const withPaper = mergeWithExisting(seeded, {
      related_identifiers: [doi(NM000275_DATA_PAPER, "IsDescribedBy")],
    });
    const input = {
      ...withPaper,
      related_identifiers: [
        ...(withPaper.related_identifiers ?? []),
        // A never-data-paper DOI under a non-data relation is not touched.
        doi(MNE_BIDS, "IsCitedBy"),
      ],
    };
    const { result, demoted } = enforceNeverDataPaper(input);
    expect(demoted).toEqual([]);
    expect(result).toBe(input);
    expect(result.related_identifiers).toContainEqual({
      identifier: "https://github.com/nemarDatasets/nm000275",
      identifier_type: "URL",
      relation_type: "IsDescribedBy",
    });
    expect(result.related_identifiers).toContainEqual(doi(NM000275_DATA_PAPER, "IsDescribedBy"));
  });

  test("demotes by resolved title when the DOI is not on the list", () => {
    // ASL-BIDS is not on the DOI list; its resolved title identifies it.
    const aslBids = "10.1038/s41597-022-01615-9";
    expect(isNeverDataPaperDoi(aslBids)).toBe(false);
    const titles = new Map([
      [aslBids, "ASL-BIDS, the brain imaging data structure extension for arterial spin labeling"],
      [
        NM000275_DATA_PAPER,
        "Multi-channel EEG recordings during a sustained-attention driving task",
      ],
    ]);
    const { result } = enforceNeverDataPaper(
      {
        related_identifiers: [
          doi(aslBids.toUpperCase(), "IsDescribedBy"),
          doi(NM000275_DATA_PAPER, "IsDescribedBy"),
        ],
      },
      { resolvedTitles: titles },
    );
    expect(result.related_identifiers).toEqual([
      doi(aslBids.toUpperCase(), "References"),
      doi(NM000275_DATA_PAPER, "IsDescribedBy"),
    ]);
  });

  test("keeps a non-data relation on a listed DOI while demoting another", () => {
    const { result } = enforceNeverDataPaper({
      related_identifiers: [doi(MNE_BIDS, "IsCitedBy"), doi(EEG_BIDS, "IsDescribedBy")],
    });
    expect(result.related_identifiers).toEqual([
      doi(MNE_BIDS, "IsCitedBy"),
      doi(EEG_BIDS, "References"),
    ]);
  });

  test("keeps IsSupplementTo on a DOI that is not blocked", () => {
    // IsSupplementTo is a legitimate data-paper relation; nemar-citations'
    // judge decides it. Only a blocked DOI loses it.
    const input = {
      related_identifiers: [
        doi(NM000275_DATA_PAPER, "IsSupplementTo"),
        doi(MNE_BIDS, "IsSupplementTo"),
      ],
    };
    const { result } = enforceNeverDataPaper(input);
    expect(result.related_identifiers).toEqual([
      doi(NM000275_DATA_PAPER, "IsSupplementTo"),
      doi(MNE_BIDS, "References"),
    ]);
  });

  test("drops the dataset's own DOI under any relation (on008862's live metadata)", () => {
    // on008862's metadata.json, 2026-09-29: its own concept DOI as IsSupplementTo.
    const live = {
      related_identifiers: [
        doi("10.18112/openneuro.ds008862.v1.0.0", "IsDerivedFrom"),
        {
          identifier: "https://github.com/nemarDatasets/on008862",
          identifier_type: "URL" as const,
          relation_type: "IsDescribedBy",
        },
        doi("10.82901/nemar.on008862", "IsSupplementTo"),
        doi("10.82901/NEMAR.ON008862.V1.0.0", "IsDescribedBy"),
        doi("10.82901/nemar.on007655", "References"),
      ],
    };
    const { result, dropped, demoted } = enforceNeverDataPaper(live, { datasetId: "on008862" });
    expect(dropped.map((d) => d.identifier)).toEqual([
      "10.82901/nemar.on008862",
      "10.82901/NEMAR.ON008862.V1.0.0",
    ]);
    expect(demoted).toEqual([]);
    expect(result.related_identifiers?.map((r) => r.identifier)).toEqual([
      "10.18112/openneuro.ds008862.v1.0.0",
      "https://github.com/nemarDatasets/on008862",
      "10.82901/nemar.on007655",
    ]);
    // Without the dataset id, nothing is known to be "own".
    expect(enforceNeverDataPaper(live).dropped).toEqual([]);
  });

  test("collapses the duplicate a demotion creates", () => {
    const { result } = enforceNeverDataPaper({
      related_identifiers: [
        doi(EEG_BIDS, "References"),
        doi(`https://doi.org/${EEG_BIDS}`, "IsDescribedBy"),
        doi(NM000275_DATA_PAPER, "References"),
      ],
    });
    expect(result.related_identifiers).toEqual([
      doi(EEG_BIDS, "References"),
      doi(NM000275_DATA_PAPER, "References"),
    ]);
  });
});
