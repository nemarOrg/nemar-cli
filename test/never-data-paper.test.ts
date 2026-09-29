import { describe, expect, test } from "bun:test";
import {
  enforceNeverDataPaper,
  mergeWithExisting,
  seedFromBids,
} from "../backend/src/services/llm-enrich.js";
import type { RelatedIdentifierEntry } from "../shared/datacite-constants.js";
import {
  isNeverDataPaperDoi,
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
    expect(normalizeDoiKey("doi:10.21105/JOSS.01896 ")).toBe(MNE_BIDS);
    expect(isNeverDataPaperDoi("https://dx.doi.org/10.3389/FNINF.2015.00016")).toBe(true);
    expect(isNeverDataPaperDoi(NM000275_DATA_PAPER)).toBe(false);
  });
});

describe("isStandardSpecTitle", () => {
  test("matches BIDS specification titles", () => {
    for (const title of [
      "EEG-BIDS, an extension to the brain imaging data structure for electroencephalography",
      "MEG-BIDS, the brain imaging data structure extended to magnetoencephalography",
      "iEEG-BIDS, extending the Brain Imaging Data Structure specification to human intracranial electrophysiology",
      "Motion-BIDS: an extension to the brain imaging data structure to organize motion data for reproducible research",
      "BIDS apps: Improving ease of use, accessibility, and reproducibility of neuroimaging data analysis methods",
      "The brain imaging data structure, a format for organizing and describing outputs of neuroimaging experiments",
    ]) {
      expect(isStandardSpecTitle(title)).toBe(true);
    }
  });

  test("does not match data papers that mention BIDS formatting", () => {
    for (const title of [
      "Multi-channel EEG recordings during a sustained-attention driving task",
      "An open-access EEG dataset in BIDS format for motor imagery",
      "HBN-EEG: The FAIR implementation of the Healthy Brain Network (HBN) electroencephalography dataset",
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
    // NIRS-BIDS is not on the DOI list; its resolved title identifies it.
    const nirsBids = "10.1038/s41597-024-04136-9";
    const titles = new Map([
      [nirsBids, "NIRS-BIDS: Brain Imaging Data Structure Extended to Near-Infrared Spectroscopy"],
      [
        NM000275_DATA_PAPER,
        "Multi-channel EEG recordings during a sustained-attention driving task",
      ],
    ]);
    const { result } = enforceNeverDataPaper(
      {
        related_identifiers: [
          doi(nirsBids.toUpperCase(), "IsDescribedBy"),
          doi(NM000275_DATA_PAPER, "IsDescribedBy"),
        ],
      },
      titles,
    );
    expect(result.related_identifiers).toEqual([
      doi(nirsBids.toUpperCase(), "References"),
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
