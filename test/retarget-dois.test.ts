import { describe, expect, test } from "bun:test";
import { planRetarget } from "../scripts/retarget-dois";

describe("planRetarget (DOI re-target plan)", () => {
  test("builds concept + version identifiers with canonical targets", () => {
    const plan = planRetarget({
      concepts: [{ dataset_id: "nm000132", ezid_identifier: "doi:10.82901/NEMAR.NM000132" }],
      versions: [
        {
          dataset_id: "nm000132",
          version: "1.1.0",
          ezid_identifier: "doi:10.82901/NEMAR.NM000132",
        },
      ],
    });
    expect(plan).toEqual([
      {
        identifier: "doi:10.82901/NEMAR.NM000132",
        target: "https://nemar.org/dataset/nm000132",
        kind: "concept",
        datasetId: "nm000132",
      },
      {
        identifier: "doi:10.82901/NEMAR.NM000132.V1.1.0",
        target: "https://nemar.org/dataset/nm000132?v=v1.1.0",
        kind: "version",
        datasetId: "nm000132",
        version: "1.1.0",
      },
    ]);
  });

  test("version identifier upper-cases the version segment (mint parity)", () => {
    const [item] = planRetarget({
      concepts: [],
      versions: [
        {
          dataset_id: "on004350",
          version: "2.0.0-rc1",
          ezid_identifier: "doi:10.82901/NEMAR.ON004350",
        },
      ],
    });
    expect(item.identifier).toBe("doi:10.82901/NEMAR.ON004350.V2.0.0-RC1");
    expect(item.target).toBe("https://nemar.org/dataset/on004350?v=v2.0.0-rc1");
  });

  test("no targets point at the legacy dataexplorer URL", () => {
    const plan = planRetarget({
      concepts: [{ dataset_id: "nm000103", ezid_identifier: "doi:10.82901/NEMAR.NM000103" }],
      versions: [
        {
          dataset_id: "nm000103",
          version: "1.0.0",
          ezid_identifier: "doi:10.82901/NEMAR.NM000103",
        },
      ],
    });
    for (const it of plan) expect(it.target).not.toContain("dataexplorer");
  });
});
