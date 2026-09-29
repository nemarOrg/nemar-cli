import { describe, expect, test } from "bun:test";
import {
  EMPTY_DOI_RESOLUTION,
  collectCandidateDois,
  formatResolvedDoiBlock,
} from "../backend/src/services/doi-metadata.js";
import { buildSourcesPrompt } from "../backend/src/services/llm-enrich.js";

// Verbatim excerpts of nm000275's dataset_description.json and README.md
// (nemarDatasets/nm000275, 2026-09-29): the dataset whose own data paper was
// labeled `References` in its metadata (#1549).
const NM000275_BIDS = {
  Name: "Multi-channel EEG recordings during a sustained-attention driving task",
  Authors: ["Zehong Cao", "Chun-Hsiang Chuang", "Jung-Kai King", "Chin-Teng Lin"],
  HowToAcknowledge:
    "Please cite Cao, Z., Chuang, C.-H., King, J.-K. & Lin, C.-T. Multi-channel EEG recordings during a sustained-attention driving task. Sci. Data 6, 19 (2019). https://doi.org/10.1038/s41597-019-0027-4",
  ReferencesAndLinks: [
    "https://doi.org/10.1038/s41597-019-0027-4",
    "https://doi.org/10.6084/m9.figshare.6427334.v5",
    "https://doi.org/10.1016/j.neuroimage.2014.01.015",
  ],
  SourceDatasets: [{ URL: "https://doi.org/10.6084/m9.figshare.6427334.v5", Version: "5" }],
};
const NM000275_README = `[![DOI](https://img.shields.io/badge/DOI-10.82901%2Fnemar.nm000275-blue)](https://doi.org/10.82901/nemar.nm000275)

> *Scientific Data* 6, 19. https://doi.org/10.1038/s41597-019-0027-4

Original data (CC BY 4.0): figshare https://doi.org/10.6084/m9.figshare.6427334.v5 (raw),
https://doi.org/10.6084/m9.figshare.7666055.v3 (pre-processed). Open-access full text: PMC6472414.

- https://doi.org/10.1109/TBCAS.2014.2316224
- https://doi.org/10.1109/TNNLS.2013.2275003`;

describe("collectCandidateDois", () => {
  test("orders BIDS DOIs first, then related identifiers, then README", () => {
    const dois = collectCandidateDois(
      NM000275_README,
      NM000275_BIDS,
      [
        { identifier: "10.1038/srep21353", identifier_type: "DOI", relation_type: "References" },
        {
          identifier: "https://github.com/nemarDatasets/nm000275",
          identifier_type: "URL",
          relation_type: "IsDescribedBy",
        },
      ],
      "nm000275",
    );
    expect(dois).toEqual([
      "10.6084/m9.figshare.6427334.v5", // SourceDatasets
      "10.1038/s41597-019-0027-4", // ReferencesAndLinks (also HowToAcknowledge)
      "10.1016/j.neuroimage.2014.01.015",
      "10.1038/srep21353", // related_identifiers; the URL entry is skipped
      "10.6084/m9.figshare.7666055.v3", // README only
      "10.1109/tbcas.2014.2316224", // README, case-normalized
      "10.1109/tnnls.2013.2275003",
    ]);
  });

  test("skips the dataset's own NEMAR DOI only when the id is known", () => {
    const withId = collectCandidateDois(NM000275_README, {}, [], "nm000275");
    expect(withId).not.toContain("10.82901/nemar.nm000275");
    const withoutId = collectCandidateDois(NM000275_README, {});
    expect(withoutId).toContain("10.82901/nemar.nm000275");
  });

  test("strips trailing sentence punctuation from prose DOIs", () => {
    expect(
      collectCandidateDois(
        "See doi:10.1038/sdata.2016.44. Also https://doi.org/10.21105/joss.01896:",
        {},
      ),
    ).toEqual(["10.1038/sdata.2016.44", "10.21105/joss.01896"]);
  });
});

describe("formatResolvedDoiBlock / buildSourcesPrompt", () => {
  const resolution = {
    resolved: [
      {
        doi: "10.1038/s41597-019-0027-4",
        title: "Multi-channel EEG recordings during a sustained-attention driving task",
        first_author: "Cao",
        year: 2019,
        container: "Scientific Data",
        type: "JournalArticle",
      },
    ],
    unresolved: ["10.1101/2022.08.12.503778v3.abstract"],
    skipped: [],
  };

  test("lists resolved and unresolved DOIs", () => {
    expect(formatResolvedDoiBlock(resolution)).toBe(`## Resolved DOI metadata
What each DOI in the sources actually is, looked up in DataCite / Crossref. Compare titles,
authors, and years with the dataset's own name and authors when choosing relation types.
- 10.1038/s41597-019-0027-4 | title: "Multi-channel EEG recordings during a sustained-attention driving task" | first author: Cao | year: 2019 | venue: Scientific Data | type: JournalArticle
- 10.1101/2022.08.12.503778v3.abstract | unresolved (no registry record found)`);
  });

  test("places the block between the BIDS description and the README", () => {
    const prompt = buildSourcesPrompt(NM000275_README, NM000275_BIDS, resolution);
    const bidsAt = prompt.indexOf("## BIDS dataset_description.json");
    const resolvedAt = prompt.indexOf("## Resolved DOI metadata");
    const readmeAt = prompt.indexOf("## README.md");
    expect(bidsAt).toBe(0);
    expect(resolvedAt).toBeGreaterThan(bidsAt);
    expect(readmeAt).toBeGreaterThan(resolvedAt);
  });

  test("omits the block when nothing was resolved", () => {
    expect(formatResolvedDoiBlock(EMPTY_DOI_RESOLUTION)).toBe("");
    expect(buildSourcesPrompt(NM000275_README, NM000275_BIDS)).not.toContain(
      "Resolved DOI metadata",
    );
  });
});
