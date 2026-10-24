/**
 * The concept-DOI edit at its shared home (`shared/standard-edits/description.ts`).
 *
 * `test/concept-doi-description.test.ts` still imports it from `backend/src/services/doi.ts`, the
 * path the orchestrator and the #1386 repair use, and passes unedited. This file proves the two
 * paths are one function, then pins the cases that suite does not: a `SourceDatasets` that is not
 * an array, an entry already naming the old DOI, and the falsy values the rule treats as absent.
 * The upstream re-pull's planner (ADR 0111) recognizes this edit by calling the function, so a
 * case it gets wrong here would be misread there as a contributor's change.
 */

import { describe, expect, test } from "bun:test";
import { applyConceptDoiToDescription as viaDoiService } from "../backend/src/services/doi";
import { applyConceptDoiToDescription } from "../shared/standard-edits/description";

const CONCEPT = "10.82901/nemar.on002720";
const UPSTREAM = "10.18112/openneuro.ds002720.v1.0.1";

describe("applyConceptDoiToDescription, at its shared path", () => {
  test("is the very function the DOI service exports", () => {
    expect(viaDoiService).toBe(applyConceptDoiToDescription);
  });

  test("keeps a SourceDatasets object as the first entry instead of discarding it", () => {
    const result = applyConceptDoiToDescription(
      {
        DatasetDOI: UPSTREAM,
        Version: "1.0.1",
        SourceDatasets: { URL: "https://example.org/raw" },
      },
      CONCEPT,
    );
    expect(result.description.SourceDatasets).toEqual([
      { URL: "https://example.org/raw" },
      { DOI: UPSTREAM },
    ]);
    expect(result.preservedSourceDoi).toBe(UPSTREAM);
  });

  test("keeps a SourceDatasets string as the first entry too", () => {
    const result = applyConceptDoiToDescription(
      { DatasetDOI: UPSTREAM, Version: "1.0.1", SourceDatasets: "ds002720" },
      CONCEPT,
    );
    expect(result.description.SourceDatasets).toEqual(["ds002720", { DOI: UPSTREAM }]);
  });

  test("a null SourceDatasets starts an empty list", () => {
    const result = applyConceptDoiToDescription(
      { DatasetDOI: UPSTREAM, Version: "1.0.1", SourceDatasets: null },
      CONCEPT,
    );
    expect(result.description.SourceDatasets).toEqual([{ DOI: UPSTREAM }]);
  });

  test("an entry already naming the old DOI is not added again, and DatasetDOI still moves", () => {
    const sources = [{ DOI: UPSTREAM, Version: "1.0.1" }];
    const result = applyConceptDoiToDescription(
      { DatasetDOI: UPSTREAM, Version: "1.0.1", SourceDatasets: sources },
      CONCEPT,
    );
    expect(result.changed).toBe(true);
    expect(result.preservedSourceDoi).toBeUndefined();
    expect(result.description.DatasetDOI).toBe(CONCEPT);
    expect(result.description.SourceDatasets).toEqual([{ DOI: UPSTREAM, Version: "1.0.1" }]);
  });

  test("an empty or non-string DatasetDOI is replaced and not preserved", () => {
    for (const value of ["", 42, null]) {
      const result = applyConceptDoiToDescription({ DatasetDOI: value, Version: "1.0.0" }, CONCEPT);
      expect(result.description.DatasetDOI).toBe(CONCEPT);
      expect(result.description.SourceDatasets).toBeUndefined();
      expect(result.preservedSourceDoi).toBeUndefined();
      expect(result.changed).toBe(true);
    }
  });

  test("an empty Version is defaulted like a missing one", () => {
    const result = applyConceptDoiToDescription({ DatasetDOI: CONCEPT, Version: "" }, CONCEPT);
    expect(result.description.Version).toBe("1.0.0");
    expect(result.changed).toBe(true);
  });

  test("a description already carrying the concept DOI and a Version is unchanged", () => {
    const before = { Name: "ds", DatasetDOI: CONCEPT, Version: "2.0.0" };
    const result = applyConceptDoiToDescription(before, CONCEPT);
    expect(result.changed).toBe(false);
    expect(result.description).toEqual(before);
    expect(result.description).not.toBe(before);
  });
});
