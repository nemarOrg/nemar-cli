import { describe, expect, test } from "bun:test";
import { datasetLandingUrl, datasetVersionLandingUrl } from "../shared/datacite-constants";

describe("dataset landing URLs (DOI _target)", () => {
  test("datasetLandingUrl returns the canonical /dataset/<id> URL", () => {
    expect(datasetLandingUrl("nm000132")).toBe("https://nemar.org/dataset/nm000132");
    expect(datasetLandingUrl("on004350")).toBe("https://nemar.org/dataset/on004350");
  });

  test("datasetVersionLandingUrl appends ?v=v<version> (ww2-honored form)", () => {
    expect(datasetVersionLandingUrl("nm000132", "1.1.0")).toBe(
      "https://nemar.org/dataset/nm000132?v=v1.1.0",
    );
    expect(datasetVersionLandingUrl("on004350", "2.0.0")).toBe(
      "https://nemar.org/dataset/on004350?v=v2.0.0",
    );
  });

  test("targets are on the canonical nemar.org domain, not the legacy dataexplorer path", () => {
    const concept = datasetLandingUrl("nm000132");
    const version = datasetVersionLandingUrl("nm000132", "1.0.0");
    expect(concept).not.toContain("dataexplorer");
    expect(version).not.toContain("dataexplorer");
    expect(concept.startsWith("https://nemar.org/dataset/")).toBe(true);
  });
});
