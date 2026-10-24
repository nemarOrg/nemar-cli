/**
 * What a concept DOI does to a dataset_description.json (#1386).
 *
 * The rule used to live inline in the publication orchestrator's update_metadata
 * step. It is shared now because the repair for the fourteen datasets whose DOI
 * update landed on the wrong branch has to make exactly the same edit, months later,
 * against content that has moved since -- and an approximation of it would quietly
 * differ from what publish does today.
 */

import { describe, expect, test } from "bun:test";
import { applyConceptDoiToDescription } from "../backend/src/services/doi";
import { sourceDatasetEntry } from "../src/lib/import-openneuro";
import { recordedUpstreamTag } from "../src/lib/import-upstream-tag";

const CONCEPT = "10.82901/nemar.on002720";
const UPSTREAM = "10.18112/openneuro.ds002720.v1.0.1";

describe("applyConceptDoiToDescription", () => {
  test("moves the upstream DOI into SourceDatasets and takes DatasetDOI", () => {
    // The imported-dataset case: OpenNeuro's DOI is provenance, not ours to erase.
    const result = applyConceptDoiToDescription(
      { Name: "ds", BIDSVersion: "1.8.0", DatasetDOI: UPSTREAM, Version: "1.0.1" },
      CONCEPT,
    );
    expect(result.changed).toBe(true);
    expect(result.preservedSourceDoi).toBe(UPSTREAM);
    expect(result.description.DatasetDOI).toBe(CONCEPT);
    expect(result.description.SourceDatasets).toEqual([{ DOI: UPSTREAM }]);
    expect(result.description.Name).toBe("ds");
  });

  test("is idempotent: a second application changes nothing", () => {
    // The repair may be re-run, and a dataset already published correctly must not
    // collect a second source entry or a pointless commit.
    const once = applyConceptDoiToDescription({ DatasetDOI: UPSTREAM, Version: "1.0.1" }, CONCEPT);
    const twice = applyConceptDoiToDescription(once.description, CONCEPT);
    expect(twice.changed).toBe(false);
    expect(twice.preservedSourceDoi).toBeUndefined();
    expect(twice.description.SourceDatasets).toEqual([{ DOI: UPSTREAM }]);
  });

  test("appends to an existing SourceDatasets rather than replacing it", () => {
    const result = applyConceptDoiToDescription(
      {
        DatasetDOI: UPSTREAM,
        Version: "1.0.1",
        SourceDatasets: [{ URL: "https://example.org/raw" }],
      },
      CONCEPT,
    );
    expect(result.description.SourceDatasets).toEqual([
      { URL: "https://example.org/raw" },
      { DOI: UPSTREAM },
    ]);
  });

  test("invents no source entry when there was no DOI to preserve", () => {
    const result = applyConceptDoiToDescription({ Name: "ds", Version: "1.0.0" }, CONCEPT);
    expect(result.description.DatasetDOI).toBe(CONCEPT);
    expect(result.description.SourceDatasets).toBeUndefined();
    expect(result.preservedSourceDoi).toBeUndefined();
  });

  test("defaults a missing Version, and leaves a present one alone", () => {
    expect(applyConceptDoiToDescription({ Name: "ds" }, CONCEPT).description.Version).toBe("1.0.0");
    expect(
      applyConceptDoiToDescription({ Name: "ds", Version: "2.3.4" }, CONCEPT).description.Version,
    ).toBe("2.3.4");
  });

  test("does not mutate the description it was given", () => {
    // The repair diffs before against after to decide whether to commit at all.
    const before = { DatasetDOI: UPSTREAM, Version: "1.0.1" };
    const snapshot = JSON.stringify(before);
    applyConceptDoiToDescription(before, CONCEPT);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  test("an import's entry is not joined by upstream's DOI spelled another way", () => {
    // What a tag-pinned import leaves for publication (ADR 0111 decision 10): its own entry, and
    // upstream's DatasetDOI for the same snapshot in a spelling of OpenNeuro's choosing. A string
    // comparison added a second entry for each of these.
    const entry = sourceDatasetEntry("ds002720", "1.0.1");
    for (const upstream of [
      UPSTREAM,
      `doi:${UPSTREAM}`,
      `https://doi.org/${UPSTREAM}`,
      "doi:10.18112/OpenNeuro.ds002720.V1.0.1",
    ]) {
      const result = applyConceptDoiToDescription(
        { DatasetDOI: upstream, Version: "1.0.0", SourceDatasets: [entry] },
        CONCEPT,
      );
      expect(result.description.SourceDatasets).toEqual([entry]);
      expect(result.preservedSourceDoi).toBeUndefined();
      expect(result.description.DatasetDOI).toBe(CONCEPT);
    }
  });

  test("a stale upstream DOI for another version of the same dataset does not unsettle the tag", () => {
    // Upstream's DatasetDOI naming an older snapshot than the one imported: a second entry for the
    // same ds would make the recorded tag disagree with itself, and an unknown tag never trips the
    // upstream-moved guard.
    const entry = sourceDatasetEntry("ds002720", "1.0.1");
    const result = applyConceptDoiToDescription(
      {
        DatasetDOI: "doi:10.18112/openneuro.ds002720.v1.0.0",
        Version: "1.0.0",
        SourceDatasets: [entry],
      },
      CONCEPT,
    );
    expect(result.description.SourceDatasets).toEqual([entry]);
    expect(recordedUpstreamTag(result.description, "ds002720")).toBe("1.0.1");
  });

  test("any DOI already a source is recognized in another spelling", () => {
    // Not only OpenNeuro's: a DOI is case-insensitive and its prefix is presentation.
    const result = applyConceptDoiToDescription(
      {
        DatasetDOI: "https://doi.org/10.5281/ZENODO.1234",
        Version: "1.0.0",
        SourceDatasets: [{ DOI: "doi:10.5281/zenodo.1234" }],
      },
      CONCEPT,
    );
    expect(result.description.SourceDatasets).toEqual([{ DOI: "doi:10.5281/zenodo.1234" }]);
    expect(result.preservedSourceDoi).toBeUndefined();
  });

  test("a DOI of another dataset is still kept as a source", () => {
    const entry = sourceDatasetEntry("ds002720", "1.0.1");
    const other = "10.18112/openneuro.ds002721.v2.0.0";
    const result = applyConceptDoiToDescription(
      { DatasetDOI: other, Version: "1.0.0", SourceDatasets: [entry] },
      CONCEPT,
    );
    expect(result.description.SourceDatasets).toEqual([entry, { DOI: other }]);
    expect(result.preservedSourceDoi).toBe(other);
  });

  test("an upstream DOI newer than the recorded entry is dropped too: the re-pull moves the entry", () => {
    const entry = sourceDatasetEntry("ds002720", "1.0.0");
    const result = applyConceptDoiToDescription(
      {
        DatasetDOI: "doi:10.18112/openneuro.ds002720.v1.0.1",
        Version: "1.0.0",
        SourceDatasets: [entry],
      },
      CONCEPT,
    );
    expect(result.description.SourceDatasets).toEqual([entry]);
    expect(recordedUpstreamTag(result.description, "ds002720")).toBe("1.0.0");
  });

  test("the live on004362 shape: a DOI-only entry, before publication and after it", () => {
    const sources = [{ DOI: "doi:10.18112/openneuro.ds004362.v1.0.0" }];
    const before = applyConceptDoiToDescription(
      { DatasetDOI: "doi:10.18112/openneuro.ds004362.v1.0.0", SourceDatasets: sources },
      "10.82901/nemar.on004362",
    );
    expect(before.description.SourceDatasets).toEqual(sources);
    expect(before.description.DatasetDOI).toBe("10.82901/nemar.on004362");
    // As nemarDatasets served it on 2026-10-24: publishing again changes nothing.
    const after = applyConceptDoiToDescription(
      { DatasetDOI: "10.82901/nemar.on004362", SourceDatasets: sources, Version: "1.0.0" },
      "10.82901/nemar.on004362",
    );
    expect(after.changed).toBe(false);
    expect(recordedUpstreamTag(after.description, "ds004362")).toBe("1.0.0");
  });

  test("an entry naming the dataset by its page only also stands for it", () => {
    const page = { URL: "https://openneuro.org/datasets/ds002720/versions/1.0.1" };
    const result = applyConceptDoiToDescription(
      { DatasetDOI: UPSTREAM, Version: "1.0.0", SourceDatasets: [page] },
      CONCEPT,
    );
    expect(result.description.SourceDatasets).toEqual([page]);
  });

  test("a null entry is kept and does not throw", () => {
    const result = applyConceptDoiToDescription(
      { DatasetDOI: UPSTREAM, Version: "1.0.0", SourceDatasets: [null] },
      CONCEPT,
    );
    expect(result.description.SourceDatasets).toEqual([null, { DOI: UPSTREAM }]);
  });
});
