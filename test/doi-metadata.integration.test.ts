import { describe, expect, test } from "bun:test";
import {
  parseCrossrefWork,
  resolveDoi,
  resolveDoisForEnrichment,
  titlesByDoi,
} from "../backend/src/services/doi-metadata.js";

// These tests hit the real DataCite and Crossref APIs (live outbound network),
// so they live in a `*.integration.test.ts` file that the CI classifier keeps
// out of the offline `unit-pure` tier (see doi-orcid-discovery.integration.test.ts).

describe("resolveDoi", () => {
  test("resolves a Crossref journal DOI through DataCite content negotiation", async () => {
    // nm000275's data descriptor, labeled `References` in its metadata (#1549).
    const r = await resolveDoi("https://doi.org/10.1038/S41597-019-0027-4");
    expect(r).not.toBeNull();
    expect(r!.doi).toBe("10.1038/s41597-019-0027-4");
    expect(r!.title).toBe("Multi-channel EEG recordings during a sustained-attention driving task");
    expect(r!.year).toBe(2019);
    expect(r!.container).toBe("Scientific Data");
    expect(r!.first_author).toBe("Cao");
  });

  test("resolves a DataCite repository deposit as a dataset", async () => {
    const r = await resolveDoi("10.6084/m9.figshare.6427334.v5");
    expect(r).not.toBeNull();
    expect(r!.title).toContain("sustained-attention driving task (raw dataset)");
    expect(r!.type).toBe("Dataset");
    expect(r!.container).toBe("figshare");
  });

  test("exposes a typo'd DOI's unrelated title so the LLM can reject it", async () => {
    // Cited as a dataset descriptor by on002721-on002724; it is not one.
    const r = await resolveDoi("10.1038/sdata.2018.203");
    expect(r!.title).toContain("National Electricity Market");
  });

  test("returns null for a DOI no registry knows", async () => {
    expect(await resolveDoi("10.1101/2022.08.12.503778v3.abstract")).toBeNull();
  });
});

describe("parseCrossrefWork", () => {
  test("parses a live Crossref /works response (the fallback path)", async () => {
    const resp = await fetch("https://api.crossref.org/works/10.1016/j.neuroimage.2014.01.015", {
      headers: { "User-Agent": "NEMAR/1.0 (https://nemar.org; mailto:nemar@ucsd.edu)" },
    });
    expect(resp.ok).toBe(true);
    const r = parseCrossrefWork("10.1016/j.neuroimage.2014.01.015", await resp.json());
    expect(r).toEqual({
      doi: "10.1016/j.neuroimage.2014.01.015",
      title: "Kinesthesia in a sustained-attention driving task",
      first_author: "Chuang",
      year: 2014,
      container: "NeuroImage",
      type: "journal-article",
    });
  });
});

describe("resolveDoisForEnrichment", () => {
  test("honors the cap and reports unresolved DOIs", async () => {
    const res = await resolveDoisForEnrichment(
      ["10.1038/sdata.2016.44", "10.1101/2022.08.12.503778v3.abstract", "10.21105/joss.01896"],
      2,
    );
    expect(res.resolved.map((r) => r.doi)).toEqual(["10.1038/sdata.2016.44"]);
    expect(res.unresolved).toEqual(["10.1101/2022.08.12.503778v3.abstract"]);
    expect(res.skipped).toEqual(["10.21105/joss.01896"]);
    expect(titlesByDoi(res).get("10.1038/sdata.2016.44")).toStartWith(
      "The brain imaging data structure",
    );
  });
});
