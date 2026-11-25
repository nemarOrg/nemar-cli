/**
 * The license lineage resolver against the LIVE registries (epic #2182 card D1).
 *
 * This file reads one real public DOI over the network, so its name keeps it out of the offline
 * unit-pure tier (scripts/ci/unit-pure-files.sh skips `*.integration.test.ts`) and in the live
 * tier. It proves the recorded fixtures still describe the real services: DataCite still holds
 * no rights for an OpenNeuro snapshot, and OpenNeuro's own record still says CC0.
 */

import { describe, expect, test } from "bun:test";
import { resolveLicenseLineage } from "../shared/license-lineage";

describe("license lineage, live", () => {
  test("an OpenNeuro snapshot DOI resolves to CC0 through DataCite and OpenNeuro", async () => {
    const r = await resolveLicenseLineage({
      datasetDescription: {
        License: "CC0",
        SourceDatasets: [{ DOI: "10.18112/openneuro.ds003645.v2.0.2" }],
      },
      relatedIdentifiers: null,
      attestationUpstreamSource: null,
      readme: null,
    });
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0]).toMatchObject({
      id: "10.18112/openneuro.ds003645.v2.0.2",
      resolver: "openneuro",
      resource_type: "Dataset",
      license: "cc0",
      status: "resolved",
    });
    expect(r.outcome).toBe("compatible");
  }, 30_000);
});
