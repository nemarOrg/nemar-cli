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
});
